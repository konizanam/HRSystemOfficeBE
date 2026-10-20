import { Injectable } from '@nestjs/common';
import type {
  EntitlementKind,
  LeavePolicy,
  LeaveReason,
  LeaveType as LeaveTypeRow,
  Prisma,
} from '@prisma/client';
import {
  type AdminLeavePoliciesQuery,
  type AdminLeavePolicy,
  type AdminLeaveReason,
  type AdminLeaveReasonsQuery,
  type AdminLeaveType,
  BUSINESS_DATE_PATTERN,
  businessFromDate,
  type CreateLeavePolicyRequest,
  type CreateLeaveReasonRequest,
  type CreateLeaveTypeRequest,
  dateFromBusiness,
  dec,
  DECIMAL_STRING_PATTERN,
  isBusinessDate,
  type LeaveAdjustmentRequest,
  type LeaveAdjustmentResponse,
  OPENING_BALANCE_CSV_COLUMNS,
  OPENING_BALANCE_KINDS,
  type OpeningBalanceImportRequest,
  type OpeningBalanceImportResponse,
  type OpeningBalanceRowResult,
  todayBusinessDate,
  type UpdateLeavePolicyRequest,
  type UpdateLeaveReasonRequest,
  type UpdateLeaveTypeRequest,
  units4,
} from '@peoplehub/shared';
import { createHash } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import {
  assertVersion,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { ScopeService } from '../auth/scope.service';
import { EntitlementService, toLedgerDto } from './entitlement.service';
import { LEAVE_EMPLOYEE_SELECT } from './leave-constants';
import { parseCsv } from './csv';

function toAdminLeaveType(t: LeaveTypeRow): AdminLeaveType {
  return {
    id: t.id,
    code: t.code,
    description: t.description,
    colour: t.colour,
    unit: t.unit,
    isPaid: t.isPaid,
    mandatoryReason: t.mandatoryReason,
    requiresAttachmentAfterDays:
      t.requiresAttachmentAfterDays === null ? null : units4(t.requiresAttachmentAfterDays),
    allowHalfDay: t.allowHalfDay,
    allowNegative: t.allowNegative,
    excludeWeekends: t.excludeWeekends,
    excludePublicHolidays: t.excludePublicHolidays,
    hideUnitsAvailableForESS: t.hideUnitsAvailableForESS,
    hideZeroUnitsAvailableForESS: t.hideZeroUnitsAvailableForESS,
    isCreditLeave: t.isCreditLeave,
    isActive: t.isActive,
    version: t.version,
  };
}

function toAdminLeaveReason(r: LeaveReason): AdminLeaveReason {
  return {
    id: r.id,
    leaveTypeId: r.leaveTypeId,
    code: r.code,
    description: r.description,
    isActive: r.isActive,
    version: r.version,
  };
}

function toAdminLeavePolicy(p: LeavePolicy): AdminLeavePolicy {
  return {
    id: p.id,
    leaveTypeId: p.leaveTypeId,
    companyRuleId: p.companyRuleId,
    definitionName: p.definitionName,
    entitlementPerCycle: units4(p.entitlementPerCycle),
    accrualMethod: p.accrualMethod,
    cycleMonths: p.cycleMonths,
    maxCarryForward: p.maxCarryForward === null ? null : units4(p.maxCarryForward),
    carryForwardExpiryMonths: p.carryForwardExpiryMonths,
    maxNegative: units4(p.maxNegative),
    creditExpiryDays: p.creditExpiryDays,
    isActive: p.isActive,
    version: p.version,
  };
}

/** Decimal fields of the CRUD requests become strings for Prisma; nulls stay null. */
function decimalOrNull(value: string | null | undefined): string | null | undefined {
  return value === undefined ? undefined : value === null ? null : dec(value).toString();
}

interface ParsedOpeningRow {
  result: OpeningBalanceRowResult;
  employeeId?: number;
  leaveTypeId?: number;
  policyId?: number | null;
  kind?: EntitlementKind;
  cycleStartDate?: string;
  cycleEndDate?: string;
  entitlement?: string;
  openingBalance?: string;
  effectiveDate?: string;
  expiresOn?: string | null;
  existingBucketId?: number | null;
}

/**
 * HR admin for leave (section 12.10): ledger adjustments, the opening balances import (dry run,
 * then commit), and the leave types, reasons and policies API (the admin UI arrives in Phase 9).
 * Every change is audited.
 */
@Injectable()
export class LeaveAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly entitlements: EntitlementService,
  ) {}

  // ───────────── Adjustments ─────────────

  /** POST /admin/leave/adjustments: an ADJUSTMENT ledger entry with a reason. */
  async adjust(ctx: SecurityContext, input: LeaveAdjustmentRequest): Promise<LeaveAdjustmentResponse> {
    const effectiveDate = input.effectiveDate ?? todayBusinessDate();
    return this.db.tx(ctx, async (tx) => {
      await this.scope.assertCanAccessEmployee(ctx, input.employeeId, 'HR_WRITE', tx);
      await this.entitlements.lockEmployee(tx, input.employeeId);
      const employee = await tx.employee.findUniqueOrThrow({
        where: { id: input.employeeId },
        select: LEAVE_EMPLOYEE_SELECT,
      });
      const type = await tx.leaveType.findUnique({ where: { id: input.leaveTypeId } });
      if (!type) throw ValidationError.field('leaveTypeId', 'Unknown leave type');
      let bucketId = input.entitlementId;
      if (bucketId !== undefined) {
        const bucket = await tx.employeeLeaveEntitlement.findUnique({ where: { id: bucketId } });
        if (!bucket || bucket.employeeId !== employee.id || bucket.leaveTypeId !== type.id) {
          throw ValidationError.field(
            'entitlementId',
            "Choose one of the employee's buckets of this leave type",
          );
        }
        if (bucket.isClosed) throw ValidationError.field('entitlementId', 'This bucket is closed');
      } else {
        await this.entitlements.ensureCurrentBuckets(tx, ctx, employee, effectiveDate, type.id);
        const day = dateFromBusiness(effectiveDate);
        const bucket =
          (await tx.employeeLeaveEntitlement.findFirst({
            where: {
              employeeId: employee.id,
              leaveTypeId: type.id,
              isClosed: false,
              cycleStartDate: { lte: day },
              cycleEndDate: { gte: day },
            },
            orderBy: [{ kind: 'asc' }, { cycleEndDate: 'desc' }],
          })) ??
          (await tx.employeeLeaveEntitlement.findFirst({
            where: { employeeId: employee.id, leaveTypeId: type.id, isClosed: false },
            orderBy: { cycleEndDate: 'desc' },
          }));
        if (!bucket)
          throw ValidationError.field('entitlementId', 'The employee has no open bucket of this leave type');
        bucketId = bucket.id;
      }
      const entry = await this.entitlements.post(
        tx,
        ctx,
        {
          employeeId: employee.id,
          leaveTypeId: type.id,
          entitlementId: bucketId,
          entryType: 'ADJUSTMENT',
          units: input.units,
          effectiveDate,
          note: input.reason,
        },
        { action: 'LEAVE.ADJUSTED', reason: input.reason },
      );
      if (!entry) throw ValidationError.field('units', 'Units cannot be 0');
      return { entry: toLedgerDto(entry) };
    });
  }

  // ───────────── Opening balances import ─────────────

  /**
   * POST /admin/leave/opening-balances/import. DRY_RUN validates every row and returns a
   * `confirmToken` bound to the CSV; COMMIT (with that token) writes all rows in one transaction:
   * the bucket is found or opened and an OPENING entry posted. Every row is audited.
   */
  async importOpeningBalances(
    ctx: SecurityContext,
    input: OpeningBalanceImportRequest,
  ): Promise<OpeningBalanceImportResponse> {
    const confirmToken = createHash('sha256').update(input.csv).digest('hex');
    const parsed = await this.parseOpeningCsv(ctx, input.csv, this.db.prisma);
    const summary = (committed: boolean, rows: ParsedOpeningRow[]): OpeningBalanceImportResponse => ({
      mode: input.mode,
      confirmToken,
      totalRows: rows.length,
      validRows: rows.filter((r) => r.result.ok).length,
      invalidRows: rows.filter((r) => !r.result.ok).length,
      committed,
      rows: rows.map((r) => r.result),
    });
    if (input.mode === 'DRY_RUN') return summary(false, parsed);
    if (input.confirmToken !== confirmToken) {
      throw ValidationError.field('confirmToken', 'Run a dry run of this exact file before committing it');
    }
    if (parsed.length === 0 || parsed.some((r) => !r.result.ok)) {
      throw new ValidationError(
        parsed.length === 0
          ? [{ path: 'csv', message: 'The file has no data rows' }]
          : parsed
              .filter((r) => !r.result.ok)
              .map((r) => ({ path: `rows.${r.result.row}`, message: r.result.errors.join('; ') })),
        'Fix the rows with errors and run the dry run again',
      );
    }
    await this.db.tx(
      ctx,
      async (tx) => {
        // Re-validate inside the transaction so nothing changed since the dry run.
        const rows = await this.parseOpeningCsv(ctx, input.csv, tx);
        const invalid = rows.filter((r) => !r.result.ok);
        if (invalid.length > 0) {
          throw new ValidationError(
            invalid.map((r) => ({ path: `rows.${r.result.row}`, message: r.result.errors.join('; ') })),
          );
        }
        for (const r of rows) await this.commitOpeningRow(tx, ctx, r);
      },
      { timeoutMs: 120_000 },
    );
    return summary(true, parsed);
  }

  private async parseOpeningCsv(ctx: SecurityContext, csv: string, client: Tx): Promise<ParsedOpeningRow[]> {
    const table = parseCsv(csv);
    const header = (table[0] ?? []).map((h) => h.trim());
    const missing = OPENING_BALANCE_CSV_COLUMNS.filter((c) => c !== 'expiresOn' && !header.includes(c));
    if (missing.length > 0) {
      throw ValidationError.field('csv', `The header row is missing: ${missing.join(', ')}`);
    }
    const col = (row: string[], name: (typeof OPENING_BALANCE_CSV_COLUMNS)[number]) =>
      (header.indexOf(name) >= 0 ? (row[header.indexOf(name)] ?? '') : '').trim();
    const out: ParsedOpeningRow[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of table.slice(1).entries()) {
      const errors: string[] = [];
      const employeeCode = col(raw, 'employeeCode');
      const leaveTypeCode = col(raw, 'leaveTypeCode');
      const kindText = col(raw, 'kind').toUpperCase();
      const definitionName = col(raw, 'definitionName');
      const cycleStartDate = col(raw, 'cycleStartDate');
      const cycleEndDate = col(raw, 'cycleEndDate');
      const entitlement = col(raw, 'entitlement') || '0';
      const openingBalance = col(raw, 'openingBalance');
      const effectiveDate = col(raw, 'effectiveDate') || cycleStartDate;
      const expiresOn = col(raw, 'expiresOn') || null;
      const parsed: ParsedOpeningRow = {
        result: {
          row: index + 1,
          employeeCode,
          leaveTypeCode,
          definitionName,
          ok: false,
          errors,
          bucket: null,
        },
      };
      out.push(parsed);

      const kind = (OPENING_BALANCE_KINDS as readonly string[]).includes(kindText)
        ? (kindText as EntitlementKind)
        : null;
      if (!kind) errors.push(`kind must be one of ${OPENING_BALANCE_KINDS.join(', ')}`);
      if (!definitionName) errors.push('definitionName is required');
      for (const [name, value] of [
        ['cycleStartDate', cycleStartDate],
        ['cycleEndDate', cycleEndDate],
        ['effectiveDate', effectiveDate],
      ] as const) {
        if (!BUSINESS_DATE_PATTERN.test(value) || !isBusinessDate(value))
          errors.push(`${name} must be a date (YYYY-MM-DD)`);
      }
      if (expiresOn !== null && !isBusinessDate(expiresOn))
        errors.push('expiresOn must be a date (YYYY-MM-DD)');
      if (isBusinessDate(cycleStartDate) && isBusinessDate(cycleEndDate) && cycleEndDate < cycleStartDate) {
        errors.push('cycleEndDate must be on or after cycleStartDate');
      }
      for (const [name, value] of [
        ['entitlement', entitlement],
        ['openingBalance', openingBalance],
      ] as const) {
        if (!DECIMAL_STRING_PATTERN.test(value) || dec(value).decimalPlaces() > 4)
          errors.push(`${name} must be a number with at most 4 decimals`);
      }
      const employee = employeeCode
        ? await client.employee.findFirst({
            where: { employeeCode, deletedAt: null },
            select: { id: true, companyRuleId: true },
          })
        : null;
      if (!employee) errors.push(`Unknown employee ${employeeCode}`);
      else if (!(await this.scope.canAccessAny(ctx, employee.id, ['HR_WRITE'], client))) {
        errors.push('The employee is not in your companies');
      }
      const type = leaveTypeCode
        ? await client.leaveType.findUnique({ where: { code: leaveTypeCode } })
        : null;
      if (!type) errors.push(`Unknown leave type ${leaveTypeCode}`);
      const key = `${employeeCode}|${leaveTypeCode}|${kindText}|${cycleStartDate}`;
      if (seen.has(key)) errors.push('The same bucket appears twice in the file');
      seen.add(key);

      if (errors.length === 0 && employee && type && kind) {
        const policy = await client.leavePolicy.findFirst({
          where: {
            leaveTypeId: type.id,
            isActive: true,
            OR: [{ companyRuleId: employee.companyRuleId }, { companyRuleId: null }],
          },
          orderBy: [{ companyRuleId: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
        });
        const existing = await client.employeeLeaveEntitlement.findFirst({
          where: {
            employeeId: employee.id,
            leaveTypeId: type.id,
            kind,
            cycleStartDate: dateFromBusiness(cycleStartDate),
          },
        });
        if (existing) {
          const already = await client.leaveLedgerEntry.findFirst({
            where: {
              entitlementId: existing.id,
              entryType: 'OPENING',
              effectiveDate: dateFromBusiness(effectiveDate),
            },
            select: { id: true },
          });
          if (already) errors.push('An opening balance was already imported for this bucket and date');
          if (businessFromDate(existing.cycleEndDate) !== cycleEndDate)
            errors.push('cycleEndDate differs from the existing bucket');
        }
        Object.assign(parsed, {
          employeeId: employee.id,
          leaveTypeId: type.id,
          policyId: policy?.id ?? null,
          kind,
          cycleStartDate,
          cycleEndDate,
          entitlement,
          openingBalance,
          effectiveDate,
          expiresOn,
          existingBucketId: existing?.id ?? null,
        });
        parsed.result.bucket = existing ? 'EXISTING' : 'NEW';
      }
      parsed.result.ok = errors.length === 0;
    }
    return out;
  }

  private async commitOpeningRow(tx: Tx, ctx: SecurityContext, r: ParsedOpeningRow): Promise<void> {
    if (
      r.employeeId === undefined ||
      r.leaveTypeId === undefined ||
      !r.kind ||
      !r.cycleStartDate ||
      !r.cycleEndDate ||
      !r.effectiveDate ||
      r.openingBalance === undefined
    ) {
      throw new Error(`Opening balance row ${r.result.row} was not validated`);
    }
    await this.entitlements.lockEmployee(tx, r.employeeId);
    const bucketId =
      r.existingBucketId ??
      (
        await this.entitlements.openBucket(
          tx,
          ctx,
          {
            employeeId: r.employeeId,
            leaveTypeId: r.leaveTypeId,
            policyId: r.policyId ?? null,
            kind: r.kind,
            definitionName: r.result.definitionName,
            entitlement: r.entitlement ?? '0',
            cycleStartDate: r.cycleStartDate,
            cycleEndDate: r.cycleEndDate,
            expiresOn: r.expiresOn ?? null,
          },
          { import: 'OPENING_BALANCE', row: r.result.row },
        )
      ).id;
    const entry = await this.entitlements.post(
      tx,
      ctx,
      {
        employeeId: r.employeeId,
        leaveTypeId: r.leaveTypeId,
        entitlementId: bucketId,
        entryType: 'OPENING',
        units: r.openingBalance,
        effectiveDate: r.effectiveDate,
        note: 'Opening balance import',
      },
      { action: 'LEAVE.OPENING_BALANCE_POSTED', metadata: { row: r.result.row } },
    );
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: 'LEAVE.OPENING_BALANCE_IMPORTED',
      entityType: 'EmployeeLeaveEntitlement',
      entityId: bucketId,
      subjectEmployeeId: r.employeeId,
      metadata: { ...r.result, openingBalance: units4(r.openingBalance), ledgerEntryId: entry?.id ?? null },
    });
  }

  // ───────────── Leave types ─────────────

  async listTypes(): Promise<{ items: AdminLeaveType[] }> {
    const rows = await this.db.prisma.leaveType.findMany({ orderBy: { id: 'asc' } });
    return { items: rows.map(toAdminLeaveType) };
  }

  async getType(id: number): Promise<AdminLeaveType> {
    const row = await this.db.prisma.leaveType.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('Leave type');
    return toAdminLeaveType(row);
  }

  async createType(ctx: SecurityContext, input: CreateLeaveTypeRequest): Promise<AdminLeaveType> {
    return this.db.tx(ctx, async (tx) => {
      if (await tx.leaveType.findUnique({ where: { code: input.code } })) {
        throw new ConflictError('A leave type with this code already exists');
      }
      let id = input.id;
      if (id === undefined) {
        const max = await tx.leaveType.aggregate({ _max: { id: true } });
        id = (max._max.id ?? 0) + 1;
      } else if (await tx.leaveType.findUnique({ where: { id } })) {
        throw new ConflictError('A leave type with this id already exists');
      }
      const { requiresAttachmentAfterDays, ...rest } = input;
      const row = await tx.leaveType.create({
        data: {
          ...rest,
          id,
          requiresAttachmentAfterDays: decimalOrNull(requiresAttachmentAfterDays) ?? null,
        },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'LEAVE_TYPE.CREATED',
        entityType: 'LeaveType',
        entityId: row.id,
        after: row,
      });
      return toAdminLeaveType(row);
    });
  }

  async updateType(
    ctx: SecurityContext,
    id: number,
    input: UpdateLeaveTypeRequest,
    action = 'LEAVE_TYPE.UPDATED',
  ): Promise<AdminLeaveType> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'LeaveType', id);
      const before = await tx.leaveType.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('Leave type');
      assertVersion(before, input.version);
      const { version: _version, requiresAttachmentAfterDays, ...fields } = input;
      if (
        fields.code &&
        fields.code !== before.code &&
        (await tx.leaveType.findUnique({ where: { code: fields.code } }))
      ) {
        throw new ConflictError('A leave type with this code already exists');
      }
      const data: Prisma.LeaveTypeUpdateInput = { ...fields, version: { increment: 1 } };
      if (requiresAttachmentAfterDays !== undefined)
        data.requiresAttachmentAfterDays = decimalOrNull(requiresAttachmentAfterDays);
      const after = await tx.leaveType.update({ where: { id }, data });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action,
        entityType: 'LeaveType',
        entityId: id,
        before,
        after,
      });
      return toAdminLeaveType(after);
    });
  }

  deactivateType(ctx: SecurityContext, id: number, version: number): Promise<AdminLeaveType> {
    return this.updateType(ctx, id, { version, isActive: false }, 'LEAVE_TYPE.DEACTIVATED');
  }

  // ───────────── Leave reasons ─────────────

  async listReasons(query: AdminLeaveReasonsQuery): Promise<{ items: AdminLeaveReason[] }> {
    const rows = await this.db.prisma.leaveReason.findMany({
      where: query.leaveTypeId ? { leaveTypeId: query.leaveTypeId } : {},
      orderBy: [{ leaveTypeId: 'asc' }, { description: 'asc' }],
    });
    return { items: rows.map(toAdminLeaveReason) };
  }

  async createReason(ctx: SecurityContext, input: CreateLeaveReasonRequest): Promise<AdminLeaveReason> {
    return this.db.tx(ctx, async (tx) => {
      if (!(await tx.leaveType.findUnique({ where: { id: input.leaveTypeId } }))) {
        throw ValidationError.field('leaveTypeId', 'Unknown leave type');
      }
      if (
        await tx.leaveReason.findUnique({
          where: { leaveTypeId_code: { leaveTypeId: input.leaveTypeId, code: input.code } },
        })
      ) {
        throw new ConflictError('This leave type already has a reason with this code');
      }
      const row = await tx.leaveReason.create({ data: input });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'LEAVE_REASON.CREATED',
        entityType: 'LeaveReason',
        entityId: row.id,
        after: row,
      });
      return toAdminLeaveReason(row);
    });
  }

  async updateReason(
    ctx: SecurityContext,
    id: number,
    input: UpdateLeaveReasonRequest,
    action = 'LEAVE_REASON.UPDATED',
  ): Promise<AdminLeaveReason> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'LeaveReason', id);
      const before = await tx.leaveReason.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('Leave reason');
      assertVersion(before, input.version);
      const { version: _version, ...fields } = input;
      if (
        fields.code &&
        fields.code !== before.code &&
        (await tx.leaveReason.findUnique({
          where: { leaveTypeId_code: { leaveTypeId: before.leaveTypeId, code: fields.code } },
        }))
      ) {
        throw new ConflictError('This leave type already has a reason with this code');
      }
      const after = await tx.leaveReason.update({
        where: { id },
        data: { ...fields, version: { increment: 1 } },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action,
        entityType: 'LeaveReason',
        entityId: id,
        before,
        after,
      });
      return toAdminLeaveReason(after);
    });
  }

  deactivateReason(ctx: SecurityContext, id: number, version: number): Promise<AdminLeaveReason> {
    return this.updateReason(ctx, id, { version, isActive: false }, 'LEAVE_REASON.DEACTIVATED');
  }

  // ───────────── Leave policies ─────────────

  async listPolicies(query: AdminLeavePoliciesQuery): Promise<{ items: AdminLeavePolicy[] }> {
    const rows = await this.db.prisma.leavePolicy.findMany({
      where: query.leaveTypeId ? { leaveTypeId: query.leaveTypeId } : {},
      orderBy: [{ leaveTypeId: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(toAdminLeavePolicy) };
  }

  /** A company-rule policy must be in the HR admin's companies. */
  private async assertRuleInScope(tx: Tx, ctx: SecurityContext, companyRuleId: number | null): Promise<void> {
    if (companyRuleId === null) return;
    const rule = await tx.companyRule.findUnique({ where: { id: companyRuleId } });
    if (!rule) throw ValidationError.field('companyRuleId', 'Unknown company rule');
    if (!ctx.isSystem && !ctx.companyIds.includes(rule.companyId)) {
      throw new ForbiddenError('This company rule is not in your companies', { metadata: { companyRuleId } });
    }
  }

  async createPolicy(ctx: SecurityContext, input: CreateLeavePolicyRequest): Promise<AdminLeavePolicy> {
    return this.db.tx(ctx, async (tx) => {
      if (!(await tx.leaveType.findUnique({ where: { id: input.leaveTypeId } }))) {
        throw ValidationError.field('leaveTypeId', 'Unknown leave type');
      }
      await this.assertRuleInScope(tx, ctx, input.companyRuleId);
      if (
        input.isActive &&
        (await tx.leavePolicy.findFirst({
          where: { leaveTypeId: input.leaveTypeId, companyRuleId: input.companyRuleId, isActive: true },
        }))
      ) {
        throw new ConflictError('An active policy for this leave type and company rule already exists');
      }
      const row = await tx.leavePolicy.create({
        data: {
          ...input,
          entitlementPerCycle: dec(input.entitlementPerCycle).toString(),
          maxCarryForward: decimalOrNull(input.maxCarryForward) ?? null,
          maxNegative: dec(input.maxNegative).toString(),
        },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'LEAVE_POLICY.CREATED',
        entityType: 'LeavePolicy',
        entityId: row.id,
        after: row,
      });
      return toAdminLeavePolicy(row);
    });
  }

  async updatePolicy(
    ctx: SecurityContext,
    id: number,
    input: UpdateLeavePolicyRequest,
    action = 'LEAVE_POLICY.UPDATED',
  ): Promise<AdminLeavePolicy> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'LeavePolicy', id);
      const before = await tx.leavePolicy.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('Leave policy');
      await this.assertRuleInScope(tx, ctx, before.companyRuleId);
      assertVersion(before, input.version);
      const { version: _version, entitlementPerCycle, maxCarryForward, maxNegative, ...fields } = input;
      if (
        fields.isActive === true &&
        !before.isActive &&
        (await tx.leavePolicy.findFirst({
          where: {
            leaveTypeId: before.leaveTypeId,
            companyRuleId: before.companyRuleId,
            isActive: true,
            id: { not: id },
          },
        }))
      ) {
        throw new ConflictError('An active policy for this leave type and company rule already exists');
      }
      const data: Prisma.LeavePolicyUpdateInput = { ...fields, version: { increment: 1 } };
      if (entitlementPerCycle !== undefined) data.entitlementPerCycle = dec(entitlementPerCycle).toString();
      if (maxCarryForward !== undefined) data.maxCarryForward = decimalOrNull(maxCarryForward);
      if (maxNegative !== undefined) data.maxNegative = dec(maxNegative).toString();
      const after = await tx.leavePolicy.update({ where: { id }, data });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action,
        entityType: 'LeavePolicy',
        entityId: id,
        before,
        after,
      });
      return toAdminLeavePolicy(after);
    });
  }

  deactivatePolicy(ctx: SecurityContext, id: number, version: number): Promise<AdminLeavePolicy> {
    return this.updatePolicy(ctx, id, { version, isActive: false }, 'LEAVE_POLICY.DEACTIVATED');
  }
}
