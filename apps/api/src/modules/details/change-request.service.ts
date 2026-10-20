import { Injectable } from '@nestjs/common';
import { type ChangeRequest, Prisma, type ProcessStatus } from '@prisma/client';
import {
  CHANGE_ENTITY_LABELS,
  CHANGE_PENDING_MESSAGE,
  type ChangeEntityType,
  type ChangeField,
  changeFieldLabel,
  type ChangeOperation,
  type ChangeRequestDto,
  type ChangeRequestsQuery,
  type ChangeRequestsResponse,
  CONTACT_TYPE_LABELS,
  type ContactType,
  DETAILS_PROBLEM_TYPES,
  formatChangeRequestReference,
  NO_CHANGES_MESSAGE,
  type PendingChange,
  pendingChangeBanner,
  PROCESS_STATUS_LABELS,
  patchPaths,
  sequenceKeys,
  WORKFLOW_REQUEST_LABELS,
  type WorkflowTypeCode,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import { hasRole, isActingForOther, type SecurityContext } from '../../common/context/security-context';
import { DomainError } from '../../common/errors/domain-errors';
import { EncryptionService } from '../../crypto/encryption.service';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { AttachmentService } from '../attachments/attachment.service';
import { WorkflowEngine } from '../workflow/workflow-engine.service';
import type {
  FinalApprovalResult,
  SubjectDescription,
  WorkflowCancelHookContext,
  WorkflowCommentHookContext,
  WorkflowHookContext,
  WorkflowProcessSnapshot,
  WorkflowResubmitHookContext,
  SubjectViewer,
} from '../workflow/workflow-subject';
import { isMasked, isSealed, isSensitiveLeaf, maskedText } from './sealed';

/** Owner entity of the supporting documents of a change request. */
export const CHANGE_REQUEST_ENTITY = 'ChangeRequest';

/** A change request in one of these statuses blocks a second one for the same record (§7.6). */
export const OPEN_CHANGE_STATUSES: ProcessStatus[] = [
  'DRAFT',
  'IN_PROGRESS',
  'RESUBMIT_REQUIRED',
  'APPROVED_PENDING_PROCESS',
];

const CLOSED_CHANGE_STATUSES: ProcessStatus[] = ['PROCESSED', 'DECLINED', 'CANCELLED', 'CONFLICT'];

/** Workflow of each record type (family goes through BASICINF, ASSUMPTION A16). */
export const CHANGE_WORKFLOW: Record<ChangeEntityType, WorkflowTypeCode> = {
  Employee: 'BASICINF',
  FamilyMember: 'BASICINF',
  BankAccount: 'BANKDET',
  DriversLicence: 'DRIVERSLICENSE',
  FundMembership: 'BENEFICIARY',
};

const OPERATION_LABELS: Record<ChangeOperation, string> = {
  CREATE: 'Add',
  UPDATE: 'Change',
  DELETE: 'Remove',
};

/**
 * Applies an approved change through the same domain service HR edits use, so validation and
 * audit are identical (section 7.6). One applier per record type.
 */
export interface ChangeApplier {
  readonly entityType: ChangeEntityType;
  /** Re-reads the record; returns why it can no longer take the change, or null. */
  conflict(tx: Tx, cr: ChangeRequest): Promise<string | null>;
  /** Applies the change and returns the record id (the new id for a create). */
  apply(tx: Tx, ctx: SecurityContext, cr: ChangeRequest): Promise<string>;
  /** Display text of a field value for approvers (ids → names); undefined = default formatting. */
  formatValue?(client: Tx, path: string, value: unknown): Promise<string | null | undefined>;
}

export interface SubmitChangeInput {
  employeeId: number;
  entityType: ChangeEntityType;
  entityId: string | number | null;
  operation: ChangeOperation;
  /** The changed leaves; sensitive values sealed. */
  patch: Record<string, unknown>;
  /** The current values of the same leaves; sensitive values masked. */
  previous: Record<string, unknown> | null;
  baseVersion: number | null;
  summary: string;
  attachmentIds?: readonly string[];
  comment?: string | null;
}

function record(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function valueAt(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function noChanges(): DomainError {
  return new DomainError(
    422,
    'Validation failed',
    NO_CHANGES_MESSAGE,
    [{ path: '', message: NO_CHANGES_MESSAGE }],
    DETAILS_PROBLEM_TYPES.noChanges,
  );
}

function changePending(): DomainError {
  return new DomainError(
    409,
    'Conflict',
    CHANGE_PENDING_MESSAGE,
    undefined,
    DETAILS_PROBLEM_TYPES.changePending,
  );
}

/**
 * The ChangeRequest pattern (section 7.6): employees never change master data directly. A submit
 * stores only the changed fields (sensitive values encrypted), allocates the reference number
 * `R{entityCode}-{typeCode}-N{seq:5}`, binds the supporting documents and starts the workflow.
 * On final approval the record is re-read: a version drift ends in CONFLICT (HR is alerted by the
 * engine), otherwise the applier writes it in the same transaction.
 */
@Injectable()
export class ChangeRequestService {
  private readonly appliers = new Map<ChangeEntityType, ChangeApplier>();

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly crypto: EncryptionService,
    private readonly engine: WorkflowEngine,
    private readonly attachments: AttachmentService,
  ) {}

  registerApplier(applier: ChangeApplier): void {
    if (this.appliers.has(applier.entityType)) {
      throw new Error(`A change applier for ${applier.entityType} is already registered`);
    }
    this.appliers.set(applier.entityType, applier);
  }

  private applier(entityType: string): ChangeApplier {
    const applier = this.appliers.get(entityType as ChangeEntityType);
    if (!applier) throw new Error(`No change applier for ${entityType}`);
    return applier;
  }

  /** 409 "A change is already awaiting approval" while one is open for the same record. */
  async assertNoOpen(
    tx: Tx,
    employeeId: number,
    entityType: ChangeEntityType,
    entityId: string | number | null,
  ): Promise<void> {
    const open = await tx.changeRequest.findFirst({
      where: {
        employeeId,
        entityType,
        entityId: entityId === null ? null : String(entityId),
        status: { in: OPEN_CHANGE_STATUSES },
      },
      select: { id: true },
    });
    if (open) throw changePending();
  }

  /** 422 "No changes to submit". */
  assertHasChanges(paths: readonly string[]): void {
    if (paths.length === 0) throw noChanges();
  }

  /**
   * Creates the change request and starts its workflow. Call it inside the domain service's
   * transaction after `assertNoOpen` and the diff; the employee row must already be locked.
   */
  async submit(ctx: SecurityContext, input: SubmitChangeInput): Promise<ChangeRequestDto> {
    return this.db.tx(ctx, async (tx) => {
      const employee = await tx.employee.findUniqueOrThrow({
        where: { id: input.employeeId },
        select: { entityCode: true },
      });
      await this.assertNoOpen(tx, input.employeeId, input.entityType, input.entityId);
      const type = CHANGE_WORKFLOW[input.entityType];
      const seq = await this.db.nextSequence(tx, sequenceKeys.changeRequest(input.employeeId, type));
      let cr: ChangeRequest;
      try {
        cr = await tx.changeRequest.create({
          data: {
            referenceNumber: formatChangeRequestReference(employee.entityCode, type, seq),
            employeeId: input.employeeId,
            entityType: input.entityType,
            entityId: input.entityId === null ? null : String(input.entityId),
            operation: input.operation,
            proposed: input.patch as Prisma.InputJsonObject,
            before: input.previous === null ? Prisma.DbNull : (input.previous as Prisma.InputJsonObject),
            baseVersion: input.baseVersion,
            status: 'IN_PROGRESS',
          },
        });
      } catch (err) {
        // The partial unique index is the backstop for two concurrent submits.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
          throw changePending();
        throw err;
      }
      const fieldPaths = patchPaths(record(cr.proposed), isSensitiveLeaf);
      this.audit.record(tx, ctx, {
        category: 'WORKFLOW',
        action: 'CHANGE_REQUEST.SUBMITTED',
        entityType: 'ChangeRequest',
        entityId: cr.id,
        subjectEmployeeId: input.employeeId,
        after: cr,
        metadata: {
          workflowType: type,
          entityType: input.entityType,
          operation: input.operation,
          fieldPaths,
        },
      });
      if (input.attachmentIds?.length) {
        await this.attachments.bind(tx, ctx, input.attachmentIds, {
          entity: CHANGE_REQUEST_ENTITY,
          entityId: cr.id,
          subjectEmployeeId: input.employeeId,
        });
      }
      const process = await this.engine.start(ctx, {
        type,
        subjectEntity: CHANGE_REQUEST_ENTITY,
        subjectEntityId: cr.id,
        subjectEmployeeId: input.employeeId,
        summary: `${input.summary} (${cr.referenceNumber})`,
        comment: input.comment ?? null,
      });
      // The handler may already have applied it (every step auto-skipped); keep its status.
      const linked = await tx.changeRequest.update({ where: { id: cr.id }, data: { processId: process.id } });
      return this.toDto(tx, linked);
    });
  }

  // ───────────── Reads ─────────────

  /** GET /me/change-requests?status=. */
  async list(employeeId: number, query: ChangeRequestsQuery): Promise<ChangeRequestsResponse> {
    const where: Prisma.ChangeRequestWhereInput = { employeeId };
    if (query.status === 'open') where.status = { in: OPEN_CHANGE_STATUSES };
    else if (query.status === 'closed') where.status = { in: CLOSED_CHANGE_STATUSES };
    else if (query.status) where.status = query.status;
    const rows = await this.db.prisma.changeRequest.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    const items = [];
    for (const row of rows) items.push(await this.toDto(this.db.prisma, row));
    return { employeeId, items };
  }

  /**
   * The open change requests of an employee for one record type, keyed by entity id ('' for a
   * pending create): the data behind "Changes pending approval (Process #821)".
   */
  async pendingFor(
    client: Tx,
    employeeId: number,
    entityType: ChangeEntityType,
  ): Promise<Map<string, PendingChange>> {
    const rows = await client.changeRequest.findMany({
      where: { employeeId, entityType, status: { in: OPEN_CHANGE_STATUSES } },
      orderBy: { id: 'asc' },
    });
    const out = new Map<string, PendingChange>();
    for (const row of rows) out.set(row.entityId ?? '', this.pending(row));
    return out;
  }

  pending(row: ChangeRequest): PendingChange {
    const fieldPaths =
      row.operation === 'DELETE'
        ? patchPaths(record(row.before), isSensitiveLeaf)
        : patchPaths(record(row.proposed), isSensitiveLeaf);
    return {
      changeRequestId: row.id,
      referenceNumber: row.referenceNumber,
      processId: row.processId,
      status: row.status,
      statusLabel: PROCESS_STATUS_LABELS[row.status],
      operation: row.operation,
      fieldPaths,
      banner: pendingChangeBanner(row.processId),
    };
  }

  async toDto(client: Tx, row: ChangeRequest, reveal = false): Promise<ChangeRequestDto> {
    const entityType = row.entityType as ChangeEntityType;
    const changes = await this.changes(client, row, reveal);
    const process = row.processId
      ? await client.workflowProcess.findUnique({ where: { id: row.processId }, select: { summary: true } })
      : null;
    return {
      id: row.id,
      referenceNumber: row.referenceNumber,
      workflowType: CHANGE_WORKFLOW[entityType],
      entityType,
      entityLabel: CHANGE_ENTITY_LABELS[entityType],
      entityId: row.entityId,
      operation: row.operation,
      status: row.status,
      statusLabel: PROCESS_STATUS_LABELS[row.status],
      processId: row.processId,
      baseVersion: row.baseVersion,
      summary: process?.summary ?? `${OPERATION_LABELS[row.operation]} ${CHANGE_ENTITY_LABELS[entityType]}`,
      fieldPaths: changes.map((c) => c.path),
      changes,
      createdAt: row.createdAt.toISOString(),
      appliedAt: row.appliedAt?.toISOString() ?? null,
    };
  }

  /** The before/after field list; sensitive values masked unless `reveal`. */
  async changes(client: Tx, row: ChangeRequest, reveal: boolean): Promise<ChangeField[]> {
    const proposed = record(row.proposed);
    const before = record(row.before);
    const paths =
      row.operation === 'DELETE'
        ? patchPaths(before, isSensitiveLeaf)
        : patchPaths(proposed, isSensitiveLeaf);
    const applier = this.appliers.get(row.entityType as ChangeEntityType);
    const out: ChangeField[] = [];
    for (const path of paths) {
      const to = row.operation === 'DELETE' ? null : valueAt(proposed, path);
      const from = row.operation === 'CREATE' ? null : valueAt(before, path);
      out.push({
        path,
        label: changeFieldLabel(path),
        from: await this.format(client, applier, path, from, false),
        to: await this.format(client, applier, path, to, reveal),
      });
    }
    return out;
  }

  private async format(
    client: Tx,
    applier: ChangeApplier | undefined,
    path: string,
    value: unknown,
    reveal: boolean,
  ): Promise<string | null> {
    if (value === null || value === undefined || value === '') return null;
    if (isSealed(value)) return reveal ? this.crypto.decrypt(value.valueEnc) : maskedText(value);
    if (isMasked(value)) return maskedText(value);
    const custom = applier?.formatValue ? await applier.formatValue(client, path, value) : undefined;
    if (custom !== undefined) return custom;
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (Array.isArray(value)) return value.map((item) => this.formatItem(item)).join('; ') || null;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  private formatItem(item: unknown): string {
    if (!item || typeof item !== 'object') return String(item);
    const row = item as Record<string, unknown>;
    if (typeof row.type === 'string' && typeof row.value === 'string') {
      return `${CONTACT_TYPE_LABELS[row.type as ContactType] ?? row.type}: ${row.value}`;
    }
    if (typeof row.percentage === 'string') {
      const id =
        isSealed(row.identityNumber) || isMasked(row.identityNumber)
          ? ` ${maskedText(row.identityNumber)}`
          : '';
      return `${String(row.name ?? '')} (${String(row.relationship ?? '')})${id} ${row.percentage}%`;
    }
    return JSON.stringify(item);
  }

  // ───────────── Workflow hooks (ChangeRequestHandler) ─────────────

  async describe(
    client: Tx,
    process: WorkflowProcessSnapshot,
    viewer: SubjectViewer | undefined,
  ): Promise<SubjectDescription> {
    const cr = await client.changeRequest.findUniqueOrThrow({
      where: { id: Number(process.subjectEntityId) },
      include: { employee: { select: { companyId: true } } },
    });
    const entityType = cr.entityType as ChangeEntityType;
    // Only a payroll administrator in scope, not working as someone else, sees a new bank
    // account number in full, and only in the detail panel (the view is audited).
    const reveal =
      viewer?.mode === 'detail' &&
      entityType === 'BankAccount' &&
      hasRole(viewer.ctx, 'PAYROLL_ADMIN') &&
      !isActingForOther(viewer.ctx) &&
      viewer.ctx.companyIds.includes(cr.employee.companyId);
    const changes = await this.changes(client, cr, reveal);
    if (reveal && viewer && Object.values(record(cr.proposed)).some(isSealed)) {
      await this.audit.recordStandalone(viewer.ctx, {
        category: 'DATA_VIEW',
        action: 'DATA_VIEW.BANK_ACCOUNT_UNMASKED',
        entityType: 'ChangeRequest',
        entityId: cr.id,
        subjectEmployeeId: cr.employeeId,
        reason: 'Approval review',
        metadata: { processId: process.id, referenceNumber: cr.referenceNumber },
      });
    }
    const label = WORKFLOW_REQUEST_LABELS[process.type];
    const operation = `${OPERATION_LABELS[cr.operation]} ${CHANGE_ENTITY_LABELS[entityType].toLowerCase()}`;
    return {
      requestLabel: label,
      title: `${CHANGE_ENTITY_LABELS[entityType]} change`,
      fromDate: null,
      toDate: null,
      unitsLine: null,
      headline: [
        { label: 'Reference number', value: cr.referenceNumber },
        { label: 'Change', value: operation },
      ],
      fields: [
        { label: 'Reference number', value: cr.referenceNumber },
        { label: 'Change', value: operation },
        ...changes.map((c) => ({ label: c.label, value: `${c.from ?? '(empty)'} → ${c.to ?? '(empty)'}` })),
      ],
      data: {
        changeRequestId: cr.id,
        referenceNumber: cr.referenceNumber,
        entityType,
        entityId: cr.entityId,
        operation: cr.operation,
        status: cr.status,
        changes,
        revealed: reveal,
      },
      viewLabel: 'View change request',
    };
  }

  /** Re-reads the record: CONFLICT on drift, otherwise apply and mark PROCESSED (§7.6). */
  async onFinalApproval({ tx, ctx, process }: WorkflowHookContext): Promise<FinalApprovalResult> {
    const id = Number(process.subjectEntityId);
    await this.db.lockRow(tx, 'ChangeRequest', id);
    const cr = await tx.changeRequest.findUniqueOrThrow({ where: { id } });
    await this.db.lockRow(tx, 'Employee', cr.employeeId);
    const applier = this.applier(cr.entityType);
    const reason = await applier.conflict(tx, cr);
    if (reason) {
      await this.update(tx, ctx, cr, { status: 'CONFLICT' }, 'CHANGE_REQUEST.CONFLICT', { reason });
      return { outcome: 'CONFLICT', reason };
    }
    const entityId = await applier.apply(tx, ctx, cr);
    await this.update(
      tx,
      ctx,
      cr,
      { status: 'PROCESSED', appliedAt: new Date(), entityId },
      'CHANGE_REQUEST.APPLIED',
    );
    return { outcome: 'APPLIED' };
  }

  async onDeclined({ tx, ctx, process, comment }: WorkflowCommentHookContext): Promise<void> {
    await this.sync(tx, ctx, process, 'CHANGE_REQUEST.DECLINED', { comment });
  }

  async onCancelled({ tx, ctx, process, reason, comment }: WorkflowCancelHookContext): Promise<void> {
    await this.sync(
      tx,
      ctx,
      process,
      reason === 'WITHDRAWN' ? 'CHANGE_REQUEST.WITHDRAWN' : 'CHANGE_REQUEST.CANCELLED',
      {
        comment,
      },
    );
  }

  async onSentBack({ tx, ctx, process, comment }: WorkflowCommentHookContext): Promise<void> {
    await this.sync(tx, ctx, process, 'CHANGE_REQUEST.SENT_BACK', { comment });
  }

  /** A sent-back change is resubmitted as it was; edits need a new change (ASSUMPTION B106). */
  async onResubmitted({ tx, ctx, process, changes }: WorkflowResubmitHookContext): Promise<void> {
    if (changes && Object.keys(changes).length > 0) {
      throw new DomainError(
        422,
        'Validation failed',
        'A change request is resubmitted as it is; withdraw it and submit a new change to edit it',
        [{ path: 'changes', message: 'Withdraw this request and submit a new change instead' }],
      );
    }
    await this.sync(tx, ctx, process, 'CHANGE_REQUEST.RESUBMITTED');
  }

  private async sync(
    tx: Tx,
    ctx: SecurityContext,
    process: WorkflowProcessSnapshot,
    action: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const cr = await tx.changeRequest.findUniqueOrThrow({ where: { id: Number(process.subjectEntityId) } });
    await this.update(tx, ctx, cr, { status: process.status }, action, metadata);
  }

  private async update(
    tx: Tx,
    ctx: SecurityContext,
    cr: ChangeRequest,
    data: { status: ProcessStatus; appliedAt?: Date; entityId?: string },
    action: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const after = await tx.changeRequest.update({
      where: { id: cr.id },
      data: { ...data, version: { increment: 1 } },
    });
    this.audit.record(tx, ctx, {
      category: 'WORKFLOW',
      action,
      entityType: 'ChangeRequest',
      entityId: cr.id,
      subjectEmployeeId: cr.employeeId,
      before: cr,
      after,
      metadata: { referenceNumber: cr.referenceNumber, processId: cr.processId, ...metadata },
    });
  }
}
