import { Injectable } from '@nestjs/common';
import type { ChangeRequest, DriversLicence, Prisma } from '@prisma/client';
import {
  addDays,
  buildChangeDiff,
  businessFromDate,
  type ChangeRequestSubmitResponse,
  type CreateDriversLicenceRequest,
  dateFromBusiness,
  daysBetween,
  type DeleteDetailRequest,
  type DriversLicence as DriversLicenceDto,
  type DriversLicencesResponse,
  formatCardDate,
  LICENCE_EXPIRY_NOTICE_DAYS,
  LICENCES_EMPTY_TEXT,
  maskLast4,
  type PendingChange,
  todayBusinessDate,
  type UpdateDriversLicenceRequest,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import { systemContext, type SecurityContext } from '../../common/context/security-context';
import { assertVersion, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { env } from '../../config/env';
import { EncryptionService } from '../../crypto/encryption.service';
import type { JobCounts } from '../../jobs/jobs.service';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { AttachmentService } from '../attachments/attachment.service';
import { MailService } from '../notifications/mail.service';
import { NotificationService } from '../notifications/notification.service';
import { availableInCompany } from '../workflow/people.service';
import { CHANGE_REQUEST_ENTITY, type ChangeApplier, ChangeRequestService } from './change-request.service';
import { DetailsAccess } from './details-records';
import { LookupService } from './lookup.service';
import { isSealed, masked, maskedText, seal } from './sealed';

export const LICENCE_EXPIRY_JOB = 'details.licenceExpiry';

/** A licence in the shape of the form, number in plaintext. */
interface LicenceState extends Record<string, unknown> {
  licenceNumber: string;
  code: string;
  issueDate: string | null;
  expiryDate: string;
  countryOfIssue: string | null;
  restrictions: string | null;
  hasPdp: boolean;
  pdpExpiryDate: string | null;
}

const DATE_FIELDS = ['issueDate', 'expiryDate', 'pdpExpiryDate'] as const;

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function dateOrNull(value: Date | null): string | null {
  return value ? businessFromDate(value) : null;
}

/**
 * Drivers Licences (section 5.4.3, workflow DRIVERSLICENSE; fields per ASSUMPTION A14). Add, edit
 * and delete are change requests with a required copy of the licence; a delete is a soft delete
 * applied on approval. `details.licenceExpiry` tells the employee and HR 60 days before expiry.
 */
@Injectable()
export class DriversLicenceService implements ChangeApplier {
  readonly entityType = 'DriversLicence' as const;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly crypto: EncryptionService,
    private readonly access: DetailsAccess,
    private readonly changes: ChangeRequestService,
    private readonly lookups: LookupService,
    private readonly attachments: AttachmentService,
    private readonly notifications: NotificationService,
    private readonly mail: MailService,
  ) {}

  async listMine(ctx: SecurityContext): Promise<DriversLicencesResponse> {
    const me = await this.access.me(ctx);
    const prisma = this.db.prisma;
    const [rows, pending] = await Promise.all([
      prisma.driversLicence.findMany({
        where: { employeeId: me.id, deletedAt: null },
        orderBy: [{ expiryDate: 'desc' }, { id: 'desc' }],
      }),
      this.changes.pendingFor(prisma, me.id, 'DriversLicence'),
    ]);
    const items: DriversLicenceDto[] = [];
    for (const row of rows) items.push(await this.dto(prisma, row, pending.get(String(row.id)) ?? null));
    return {
      employeeId: me.id,
      items,
      emptyText: LICENCES_EMPTY_TEXT,
      pendingCreate: pending.get('') ?? null,
    };
  }

  private async dto(
    client: Tx,
    row: DriversLicence,
    pendingChange: PendingChange | null,
  ): Promise<DriversLicenceDto> {
    const applied = await client.changeRequest.findMany({
      where: { entityType: 'DriversLicence', entityId: String(row.id), status: 'PROCESSED' },
      select: { id: true },
    });
    const attachments = [];
    for (const cr of applied)
      attachments.push(...(await this.attachments.listFor(client, CHANGE_REQUEST_ENTITY, cr.id)));
    const expiry = businessFromDate(row.expiryDate);
    const days = daysBetween(todayBusinessDate(), expiry);
    return {
      id: row.id,
      version: row.version,
      licenceNumberMasked: maskLast4(row.licenceLast4),
      code: row.code,
      issueDate: dateOrNull(row.issueDate),
      expiryDate: expiry,
      countryOfIssue: row.countryOfIssue,
      restrictions: row.restrictions,
      hasPdp: row.hasPdp,
      pdpExpiryDate: dateOrNull(row.pdpExpiryDate),
      isExpired: days < 0,
      expiresInDays: days,
      attachments,
      pendingChange,
    };
  }

  private state(row: DriversLicence): LicenceState {
    return {
      licenceNumber: this.crypto.decrypt(row.licenceNumberEnc),
      code: row.code,
      issueDate: dateOrNull(row.issueDate),
      expiryDate: businessFromDate(row.expiryDate),
      countryOfIssue: row.countryOfIssue,
      restrictions: row.restrictions,
      hasPdp: row.hasPdp,
      pdpExpiryDate: dateOrNull(row.pdpExpiryDate),
    };
  }

  private async validate(client: Tx, patch: Record<string, unknown>, merged: LicenceState): Promise<void> {
    await this.lookups.assertValid(client, [
      ['licenceCodes', patch.code as string | undefined, 'code'],
      ['countries', patch.countryOfIssue as string | null | undefined, 'countryOfIssue'],
    ]);
    const errors = [];
    if (merged.issueDate && merged.expiryDate < merged.issueDate) {
      errors.push({ path: 'expiryDate', message: 'Expiry is before issue' });
    }
    if (merged.hasPdp && !merged.pdpExpiryDate) {
      errors.push({ path: 'pdpExpiryDate', message: 'Enter the PDP expiry date' });
    }
    if (errors.length > 0) throw new ValidationError(errors);
  }

  private async mine(tx: Tx, ctx: SecurityContext, id: number) {
    const me = await this.access.me(ctx, tx);
    await this.db.lockRow(tx, 'Employee', me.id);
    const row = await tx.driversLicence.findUnique({ where: { id } });
    if (!row || row.employeeId !== me.id || row.deletedAt) throw new NotFoundError('Drivers licence');
    return { me, row };
  }

  async submitCreate(
    ctx: SecurityContext,
    body: CreateDriversLicenceRequest,
  ): Promise<ChangeRequestSubmitResponse> {
    return this.db.tx(ctx, async (tx) => {
      const me = await this.access.me(ctx, tx);
      await this.db.lockRow(tx, 'Employee', me.id);
      await this.changes.assertNoOpen(tx, me.id, 'DriversLicence', null);
      const { attachmentIds, comment, ...fields } = body;
      const state: LicenceState = {
        licenceNumber: fields.licenceNumber,
        code: fields.code,
        issueDate: fields.issueDate ?? null,
        expiryDate: fields.expiryDate,
        countryOfIssue: fields.countryOfIssue ?? null,
        restrictions: fields.restrictions ?? null,
        hasPdp: fields.hasPdp,
        pdpExpiryDate: fields.hasPdp ? (fields.pdpExpiryDate ?? null) : null,
      };
      const diff = buildChangeDiff(null, state);
      await this.validate(tx, diff.patch, state);
      diff.patch.licenceNumber = seal(this.crypto, state.licenceNumber);
      const changeRequest = await this.changes.submit(ctx, {
        employeeId: me.id,
        entityType: 'DriversLicence',
        entityId: null,
        operation: 'CREATE',
        patch: diff.patch,
        previous: null,
        baseVersion: null,
        summary: `New drivers licence ${maskedText(state.licenceNumber) ?? ''} (code ${state.code}, expires ${formatCardDate(state.expiryDate)})`,
        attachmentIds,
        comment,
      });
      return { changeRequest, warnings: [] };
    });
  }

  async submitUpdate(
    ctx: SecurityContext,
    id: number,
    body: UpdateDriversLicenceRequest,
  ): Promise<ChangeRequestSubmitResponse> {
    return this.db.tx(ctx, async (tx) => {
      const { me, row } = await this.mine(tx, ctx, id);
      assertVersion(row, body.version);
      await this.changes.assertNoOpen(tx, me.id, 'DriversLicence', id);
      const { version: _v, attachmentIds, comment, ...input } = body;
      const current = this.state(row);
      const proposed: Record<string, unknown> = { ...input };
      if (input.hasPdp === false) proposed.pdpExpiryDate = null;
      const diff = buildChangeDiff(current, proposed);
      this.changes.assertHasChanges(diff.paths);
      const merged = { ...current, ...diff.patch } as LicenceState;
      await this.validate(tx, diff.patch, merged);
      if ('licenceNumber' in diff.patch) {
        diff.patch.licenceNumber = seal(this.crypto, merged.licenceNumber);
        diff.previous.licenceNumber = masked(current.licenceNumber);
      }
      const changeRequest = await this.changes.submit(ctx, {
        employeeId: me.id,
        entityType: 'DriversLicence',
        entityId: id,
        operation: 'UPDATE',
        patch: diff.patch,
        previous: diff.previous,
        baseVersion: row.version,
        summary: `Change drivers licence ${maskLast4(row.licenceLast4)}`,
        attachmentIds,
        comment,
      });
      return { changeRequest, warnings: [] };
    });
  }

  async submitDelete(
    ctx: SecurityContext,
    id: number,
    body: DeleteDetailRequest,
  ): Promise<ChangeRequestSubmitResponse> {
    return this.db.tx(ctx, async (tx) => {
      const { me, row } = await this.mine(tx, ctx, id);
      assertVersion(row, body.version);
      await this.changes.assertNoOpen(tx, me.id, 'DriversLicence', id);
      const current = this.state(row);
      const before: Record<string, unknown> = { ...current, licenceNumber: masked(current.licenceNumber) };
      const changeRequest = await this.changes.submit(ctx, {
        employeeId: me.id,
        entityType: 'DriversLicence',
        entityId: id,
        operation: 'DELETE',
        patch: {},
        previous: before,
        baseVersion: row.version,
        summary: `Remove drivers licence ${maskLast4(row.licenceLast4)}`,
        comment: body.comment,
      });
      return { changeRequest, warnings: [] };
    });
  }

  // ───────────── ChangeApplier ─────────────

  async conflict(tx: Tx, cr: ChangeRequest): Promise<string | null> {
    if (cr.operation === 'CREATE') return null;
    const row = await tx.driversLicence.findUnique({ where: { id: Number(cr.entityId) } });
    if (!row || row.deletedAt) return 'The drivers licence was removed after this request was submitted';
    if (row.version !== cr.baseVersion) return 'The drivers licence changed after this request was submitted';
    return null;
  }

  async apply(tx: Tx, ctx: SecurityContext, cr: ChangeRequest): Promise<string> {
    const patch = rec(cr.proposed);
    const meta = { source: 'CHANGE_REQUEST', changeRequestId: cr.id, referenceNumber: cr.referenceNumber };
    const data: Prisma.DriversLicenceUncheckedUpdateInput = {};
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'licenceNumber' && isSealed(value)) {
        data.licenceNumberEnc = value.valueEnc;
        data.licenceLast4 = value.last4 ?? '';
      } else if ((DATE_FIELDS as readonly string[]).includes(key)) {
        (data as Record<string, unknown>)[key] = typeof value === 'string' ? dateFromBusiness(value) : null;
      } else if (['code', 'countryOfIssue', 'restrictions', 'hasPdp'].includes(key)) {
        (data as Record<string, unknown>)[key] = value;
      }
    }
    if (cr.operation === 'CREATE') {
      const row = await tx.driversLicence.create({
        data: { ...(data as Prisma.DriversLicenceUncheckedCreateInput), employeeId: cr.employeeId },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'DRIVERS_LICENCE.CREATED',
        entityType: 'DriversLicence',
        entityId: row.id,
        subjectEmployeeId: cr.employeeId,
        after: row,
        metadata: meta,
      });
      return String(row.id);
    }
    const id = Number(cr.entityId);
    const before = await tx.driversLicence.findUniqueOrThrow({ where: { id } });
    if (cr.operation === 'UPDATE') {
      const merged = { ...this.state(before), ...patch, licenceNumber: '' } as LicenceState;
      await this.validate(tx, patch, merged);
    }
    const after = await tx.driversLicence.update({
      where: { id },
      data:
        cr.operation === 'DELETE'
          ? { deletedAt: new Date(), version: { increment: 1 } }
          : { ...data, version: { increment: 1 } },
    });
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: cr.operation === 'DELETE' ? 'DRIVERS_LICENCE.DELETED' : 'DRIVERS_LICENCE.UPDATED',
      entityType: 'DriversLicence',
      entityId: id,
      subjectEmployeeId: cr.employeeId,
      before,
      after,
      metadata: meta,
    });
    return String(id);
  }

  // ───────────── details.licenceExpiry (nightly) ─────────────

  /**
   * Tells the employee and the HR admins of their company about every live licence that expires
   * within 60 days. Each (licence, expiry date) is notified once: the `LicenceExpiryNotice` row is
   * written in the same transaction as the notifications, so re-runs send nothing new.
   */
  async notifyExpiring(data: { asOf?: string } = {}): Promise<JobCounts> {
    const today = data.asOf ?? todayBusinessDate();
    const until = addDays(today, LICENCE_EXPIRY_NOTICE_DAYS);
    const ctx = systemContext(`job-${LICENCE_EXPIRY_JOB}`);
    const due = await this.db.prisma.driversLicence.findMany({
      where: {
        deletedAt: null,
        expiryDate: { gte: dateFromBusiness(today), lte: dateFromBusiness(until) },
        employee: { deletedAt: null, status: 'ACTIVE' },
      },
      include: {
        employee: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            employeeCode: true,
            companyId: true,
            user: { select: { id: true, email: true, isActive: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
    });
    const counts = { due: due.length, notified: 0, alreadyNotified: 0, messages: 0 };
    for (const licence of due) {
      const notified = await this.db.tx(ctx, async (tx) => {
        const existing = await tx.licenceExpiryNotice.findUnique({
          where: { licenceId_expiryDate: { licenceId: licence.id, expiryDate: licence.expiryDate } },
          select: { id: true },
        });
        if (existing) return null;
        const notice = await tx.licenceExpiryNotice.create({
          data: { licenceId: licence.id, employeeId: licence.employeeId, expiryDate: licence.expiryDate },
        });
        const e = licence.employee;
        const expiry = businessFromDate(licence.expiryDate);
        const hr = await tx.user.findMany({
          where: { ...availableInCompany(e.companyId), roles: { has: 'HR_ADMIN' } },
          select: { id: true, email: true, employee: { select: { firstName: true } }, username: true },
        });
        const recipients: { userId: string; email: string | null; firstName: string; self: boolean }[] = [];
        if (e.user?.isActive)
          recipients.push({ userId: e.user.id, email: e.user.email, firstName: e.firstName, self: true });
        for (const u of hr) {
          if (u.id === e.user?.id) continue;
          recipients.push({
            userId: u.id,
            email: u.email,
            firstName: u.employee?.firstName ?? u.username,
            self: false,
          });
        }
        for (const r of recipients) {
          await this.notifications.create(tx, {
            userId: r.userId,
            kind: 'LICENCE_EXPIRING',
            title: r.self ? 'Your drivers licence expires soon' : 'A drivers licence expires soon',
            body: r.self
              ? `Your drivers licence ${maskLast4(licence.licenceLast4)} expires on ${formatCardDate(expiry)}. Renew it and update My Details.`
              : `The drivers licence of ${e.firstName} ${e.lastName} - ${e.employeeCode} expires on ${formatCardDate(expiry)}.`,
            link: r.self ? '/details/drivers-licences' : null,
          });
          const email = r.email;
          if (email) {
            this.db.afterCommit(() =>
              this.mail.sendInBackground({
                to: email,
                template: 'licence-expiring',
                data: {
                  firstName: r.firstName,
                  expiryDate: formatCardDate(expiry),
                  link: `${env().PUBLIC_URL}${r.self ? '/details/drivers-licences' : '/inbox/notifications'}`,
                },
              }),
            );
          }
        }
        this.audit.record(tx, ctx, {
          category: 'SYSTEM',
          action: 'DRIVERS_LICENCE.EXPIRY_NOTIFIED',
          entityType: 'LicenceExpiryNotice',
          entityId: notice.id,
          subjectEmployeeId: e.id,
          after: notice,
          metadata: { licenceId: licence.id, expiryDate: expiry, recipients: recipients.length },
        });
        return recipients.length;
      });
      if (notified === null) counts.alreadyNotified += 1;
      else {
        counts.notified += 1;
        counts.messages += notified;
      }
    }
    return counts;
  }
}
