import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Attachment as AttachmentRow } from '@prisma/client';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_PROBLEM_TYPES,
  type Attachment,
  attachmentDownloadPath,
  UNOWNED_ATTACHMENT_OWNER,
} from '@peoplehub/shared';
import { createHash, randomUUID } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import { DomainError, ForbiddenError, NotFoundError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { StorageService } from '../../storage/storage.service';
import { ScopeService } from '../auth/scope.service';
import { WorkflowAccessService } from '../workflow/workflow-access.service';
import { AttachmentOwnerRegistry } from './attachment-owners';
import { checkFile, safeFileName } from './file-sniffer';
import { ScannerUnavailableError, VIRUS_SCANNER, type VirusScanner } from './virus-scanner';

/** One file of an upload request. */
export interface IncomingFile {
  fileName: string;
  mimeType: string | undefined;
  bytes: Buffer;
}

/** A file ready to stream back to the client. */
export interface AttachmentDownload {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
}

function problem(status: number, title: string, detail: string, type: string, path = 'file'): DomainError {
  return new DomainError(status, title, detail, [{ path, message: detail }], type);
}

export function toAttachmentDto(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    uploadedAt: row.createdAt.toISOString(),
    ownerEntity: row.ownerEntity,
    isBound: row.ownerEntity !== UNOWNED_ATTACHMENT_OWNER,
    downloadUrl: attachmentDownloadPath(row.id),
  };
}

/**
 * Uploads, ownership and audited downloads (section 10.4). An upload is checked (extension,
 * declared type, magic bytes, size, virus scan), stored under `yyyy/mm/{uuid}` and recorded as
 * "unowned" by its uploader. Submitting a request binds the upload to its owner entity; from then
 * on the owner's rules decide who may download it.
 */
@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly scope: ScopeService,
    private readonly access: WorkflowAccessService,
    private readonly owners: AttachmentOwnerRegistry,
    @Inject(VIRUS_SCANNER) private readonly scanner: VirusScanner,
  ) {}

  /** Validates and stores the files; all or nothing. */
  async upload(ctx: SecurityContext, files: IncomingFile[]): Promise<Attachment[]> {
    if (files.length === 0) {
      throw problem(422, 'Validation failed', 'Choose a file to upload', ATTACHMENT_PROBLEM_TYPES.empty);
    }
    const prepared: {
      id: string;
      key: string;
      fileName: string;
      mimeType: string;
      bytes: Buffer;
      sha256: string;
    }[] = [];
    for (const [index, file] of files.entries()) {
      const path = files.length > 1 ? `file.${index}` : 'file';
      const fileName = safeFileName(file.fileName);
      if (file.bytes.length === 0) {
        throw problem(422, 'Validation failed', `${fileName} is empty`, ATTACHMENT_PROBLEM_TYPES.empty, path);
      }
      if (file.bytes.length > ATTACHMENT_MAX_BYTES) {
        throw problem(
          413,
          'Payload Too Large',
          `${fileName} is larger than 10 MB`,
          ATTACHMENT_PROBLEM_TYPES.tooLarge,
          path,
        );
      }
      const check = checkFile(fileName, file.mimeType, file.bytes);
      if (!check.ok) {
        throw problem(
          422,
          'Validation failed',
          `${fileName}: ${check.reason}`,
          ATTACHMENT_PROBLEM_TYPES.invalidType,
          path,
        );
      }
      await this.scan(ctx, fileName, file.bytes, path);
      const id = randomUUID();
      prepared.push({
        id,
        key: StorageService.keyFor(id),
        fileName,
        mimeType: check.mimeType,
        bytes: file.bytes,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
      });
    }

    const stored: string[] = [];
    try {
      for (const p of prepared) {
        await this.storage.put(p.key, p.bytes, p.mimeType);
        stored.push(p.key);
      }
      const rows = await this.db.tx(ctx, async (tx) => {
        const created: AttachmentRow[] = [];
        for (const p of prepared) {
          const row = await tx.attachment.create({
            data: {
              id: p.id,
              ownerEntity: UNOWNED_ATTACHMENT_OWNER,
              ownerEntityId: ctx.userId,
              fileName: p.fileName,
              mimeType: p.mimeType,
              sizeBytes: p.bytes.length,
              sha256: p.sha256,
              storageKey: p.key,
              uploadedByUserId: ctx.userId,
            },
          });
          this.audit.record(tx, ctx, {
            category: 'DATA_CHANGE',
            action: 'ATTACHMENT.UPLOADED',
            entityType: 'Attachment',
            entityId: row.id,
            subjectEmployeeId: ctx.actingAsEmployeeId || null,
            after: row,
            metadata: { scanner: this.scanner.name },
          });
          created.push(row);
        }
        return created;
      });
      return rows.map(toAttachmentDto);
    } catch (err) {
      for (const key of stored) {
        await this.storage
          .remove(key)
          .catch((removeErr: unknown) =>
            this.logger.error({ err: removeErr }, 'Could not remove an orphaned upload'),
          );
      }
      throw err;
    }
  }

  private async scan(ctx: SecurityContext, fileName: string, bytes: Buffer, path: string): Promise<void> {
    let verdict;
    try {
      verdict = await this.scanner.scan(bytes);
    } catch (err) {
      if (err instanceof ScannerUnavailableError) {
        throw problem(
          503,
          'Service Unavailable',
          'Files cannot be checked for viruses right now; try again later',
          ATTACHMENT_PROBLEM_TYPES.scanUnavailable,
          path,
        );
      }
      throw err;
    }
    if (verdict.clean) return;
    await this.audit.recordStandalone(ctx, {
      category: 'SECURITY',
      action: 'ATTACHMENT.REJECTED_INFECTED',
      outcome: 'FAILURE',
      entityType: 'Attachment',
      subjectEmployeeId: ctx.actingAsEmployeeId || null,
      reason: verdict.signature,
      metadata: { fileName, sizeBytes: bytes.length, scanner: this.scanner.name },
    });
    throw problem(
      422,
      'Validation failed',
      `${fileName} contains a virus and was rejected`,
      ATTACHMENT_PROBLEM_TYPES.infected,
      path,
    );
  }

  /**
   * Binds unsubmitted uploads of the caller to their owner (inside the submit transaction).
   * Every id must be an unowned, undeleted upload of the caller; otherwise 422 on `path`.
   */
  async bind(
    tx: Tx,
    ctx: SecurityContext,
    ids: readonly string[],
    owner: { entity: string; entityId: string | number; subjectEmployeeId: number },
    path = 'attachmentIds',
  ): Promise<AttachmentRow[]> {
    const bound: AttachmentRow[] = [];
    for (const [index, id] of ids.entries()) {
      await this.db.lockRow(tx, 'Attachment', id);
      const row = await tx.attachment.findUnique({ where: { id } });
      if (
        !row ||
        row.deletedAt !== null ||
        row.ownerEntity !== UNOWNED_ATTACHMENT_OWNER ||
        row.uploadedByUserId !== ctx.userId
      ) {
        throw new DomainError(
          422,
          'Validation failed',
          'An attached file is not available; upload it again',
          [{ path: `${path}.${index}`, message: 'This file is not available; upload it again' }],
          ATTACHMENT_PROBLEM_TYPES.notAvailable,
        );
      }
      const after = await tx.attachment.update({
        where: { id },
        data: { ownerEntity: owner.entity, ownerEntityId: String(owner.entityId) },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'ATTACHMENT.BOUND',
        entityType: 'Attachment',
        entityId: id,
        subjectEmployeeId: owner.subjectEmployeeId,
        before: row,
        after,
      });
      bound.push(after);
    }
    return bound;
  }

  /** Attachments bound to an owner entity, oldest first. */
  async listFor(client: Tx, ownerEntity: string, ownerEntityId: string | number): Promise<Attachment[]> {
    const rows = await client.attachment.findMany({
      where: { ownerEntity, ownerEntityId: String(ownerEntityId), deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toAttachmentDto);
  }

  /** Soft-deletes an upload that has not been submitted yet (only by its uploader). */
  async remove(ctx: SecurityContext, id: string): Promise<void> {
    await this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'Attachment', id);
      const row = await tx.attachment.findUnique({ where: { id } });
      if (!row || row.deletedAt) throw new NotFoundError('Attachment');
      if (row.uploadedByUserId !== ctx.userId || row.ownerEntity !== UNOWNED_ATTACHMENT_OWNER) {
        throw new ForbiddenError(
          'Only an upload that has not been submitted can be removed, by its uploader',
          {
            metadata: { attachmentId: id },
          },
        );
      }
      const after = await tx.attachment.update({ where: { id }, data: { deletedAt: new Date() } });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'ATTACHMENT.DELETED',
        entityType: 'Attachment',
        entityId: id,
        subjectEmployeeId: ctx.actingAsEmployeeId || null,
        before: row,
        after,
      });
    });
  }

  /**
   * The download check (section 10.4) and its `DATA_VIEW.ATTACHMENT_DOWNLOAD` audit row. Allowed:
   * the uploader of an unsubmitted file; for a bound file, the owning employee (or someone
   * "Working as" them), their manager, HR/Payroll of their company, and every reader of the owning
   * workflow process (its approvers and auditors included).
   */
  async download(ctx: SecurityContext, id: string): Promise<AttachmentDownload> {
    const prisma = this.db.prisma;
    const row = await prisma.attachment.findUnique({ where: { id } });
    if (!row || row.deletedAt) throw new NotFoundError('Attachment');
    const subjectEmployeeId = await this.authorise(ctx, row);
    const bytes = await this.storage.get(row.storageKey);
    await this.audit.recordStandalone(ctx, {
      category: 'DATA_VIEW',
      action: 'DATA_VIEW.ATTACHMENT_DOWNLOAD',
      entityType: 'Attachment',
      entityId: row.id,
      subjectEmployeeId,
      metadata: {
        fileName: row.fileName,
        sha256: row.sha256,
        sizeBytes: row.sizeBytes,
        ownerEntity: row.ownerEntity,
        ownerEntityId: row.ownerEntity === UNOWNED_ATTACHMENT_OWNER ? null : row.ownerEntityId,
      },
    });
    return { fileName: row.fileName, mimeType: row.mimeType, bytes };
  }

  /** Returns the subject employee for the audit row; throws 403 (audited DENIED) when not allowed. */
  private async authorise(ctx: SecurityContext, row: AttachmentRow): Promise<number | null> {
    const prisma = this.db.prisma;
    const deny = (subjectEmployeeId: number | null) =>
      new ForbiddenError('You do not have access to this file', {
        subjectEmployeeId,
        metadata: { attachmentId: row.id, ownerEntity: row.ownerEntity },
      });

    if (row.ownerEntity === UNOWNED_ATTACHMENT_OWNER) {
      if (row.uploadedByUserId === ctx.userId) return ctx.actingAsEmployeeId || null;
      throw deny(null);
    }

    let owner: { employeeId: number; processId: number | null } | null;
    if (row.ownerEntity === 'WorkflowProcess') {
      const p = await prisma.workflowProcess.findUnique({
        where: { id: Number(row.ownerEntityId) },
        select: { id: true, subjectEmployeeId: true },
      });
      owner = p ? { employeeId: p.subjectEmployeeId, processId: p.id } : null;
    } else {
      const resolver = this.owners.get(row.ownerEntity);
      owner = resolver ? await resolver(prisma, row.ownerEntityId) : null;
    }
    if (!owner) {
      this.logger.warn({ attachmentId: row.id, ownerEntity: row.ownerEntity }, 'Attachment owner not found');
      throw deny(null);
    }

    // Auditors read through the owning process (approval histories); system admins never do.
    if (await this.scope.canAccessAny(ctx, owner.employeeId, ['SELF_SERVICE', 'TEAM', 'HR_READ'])) {
      return owner.employeeId;
    }
    if (owner.processId !== null) {
      const p = await prisma.workflowProcess.findUnique({
        where: { id: owner.processId },
        select: {
          id: true,
          subjectEmployeeId: true,
          submittedByUserId: true,
          subjectEmployee: { select: { companyId: true } },
        },
      });
      if (
        p &&
        (await this.access.canRead(prisma, ctx, {
          id: p.id,
          subjectEmployeeId: p.subjectEmployeeId,
          submittedByUserId: p.submittedByUserId,
          companyId: p.subjectEmployee.companyId,
        }))
      ) {
        return owner.employeeId;
      }
    }
    throw deny(owner.employeeId);
  }
}
