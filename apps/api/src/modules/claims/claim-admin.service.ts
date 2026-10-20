import { Injectable } from '@nestjs/common';
import type { ClaimCap, ClaimGroup, ClaimType, Prisma } from '@prisma/client';
import {
  type AdminClaimCap,
  type AdminClaimCapsQuery,
  type AdminClaimGroup,
  type AdminClaimType,
  type AdminClaimTypesQuery,
  businessFromDate,
  type ClaimAdjustment,
  type ClaimAdjustmentRequest,
  type CreateClaimCapRequest,
  type CreateClaimGroupRequest,
  type CreateClaimTypeRequest,
  dateFromBusiness,
  dec,
  money2,
  todayBusinessDate,
  units4,
  type UpdateClaimCapRequest,
  type UpdateClaimGroupRequest,
  type UpdateClaimTypeRequest,
} from '@peoplehub/shared';
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
import { ClaimBalanceService } from './claim-balance.service';
import { capsForRule, ClaimSetupService } from './claim-setup.service';

function decimalOrNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : dec(value).toString();
}

export function toAdminClaimGroup(row: ClaimGroup): AdminClaimGroup {
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    attachmentMandatory: row.attachmentMandatory,
    isActive: row.isActive,
    version: row.version,
  };
}

export function toAdminClaimType(row: ClaimType): AdminClaimType {
  return {
    id: row.id,
    groupId: row.groupId,
    code: row.code,
    description: row.description,
    inputMode: row.inputMode,
    rate: row.rate === null ? null : units4(row.rate),
    rateMultiplier: row.rateMultiplier === null ? null : units4(row.rateMultiplier),
    payrollCode: row.payrollCode,
    requiresAttachment: row.requiresAttachment,
    isActive: row.isActive,
    version: row.version,
  };
}

export function toAdminClaimCap(row: ClaimCap): AdminClaimCap {
  return {
    id: row.id,
    claimTypeId: row.claimTypeId,
    companyRuleId: row.companyRuleId,
    cycle: row.cycle,
    mode: row.mode,
    amountLimit: row.amountLimit === null ? null : money2(row.amountLimit),
    quantityLimit: row.quantityLimit === null ? null : units4(row.quantityLimit),
    proRata: row.proRata,
    isActive: row.isActive,
    version: row.version,
  };
}

/**
 * Section 12.10 (HR_ADMIN and PAYROLL_ADMIN): claim groups, claim types and claim caps, and the
 * payroll balance adjustments. Deleting deactivates (no hard deletes); updates send the
 * `version`; every change is audited (`CLAIM_GROUP.*`, `CLAIM_TYPE.*`, `CLAIM_CAP.*`,
 * `CLAIM.BALANCE_ADJUSTED`).
 */
@Injectable()
export class ClaimAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly setup: ClaimSetupService,
    private readonly balances: ClaimBalanceService,
  ) {}

  // ───────────── Groups ─────────────

  async listGroups(): Promise<{ items: AdminClaimGroup[] }> {
    const rows = await this.db.prisma.claimGroup.findMany({ orderBy: { id: 'asc' } });
    return { items: rows.map(toAdminClaimGroup) };
  }

  async getGroup(id: number): Promise<AdminClaimGroup> {
    const row = await this.db.prisma.claimGroup.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('Claim group');
    return toAdminClaimGroup(row);
  }

  async createGroup(ctx: SecurityContext, input: CreateClaimGroupRequest): Promise<AdminClaimGroup> {
    return this.db.tx(ctx, async (tx) => {
      if (await tx.claimGroup.findUnique({ where: { code: input.code } })) {
        throw new ConflictError('A claim group with this code already exists');
      }
      let id = input.id;
      if (id === undefined) {
        const max = await tx.claimGroup.aggregate({ _max: { id: true } });
        id = (max._max.id ?? 0) + 1;
      } else if (await tx.claimGroup.findUnique({ where: { id } })) {
        throw new ConflictError('A claim group with this id already exists');
      }
      const row = await tx.claimGroup.create({ data: { ...input, id } });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'CLAIM_GROUP.CREATED',
        entityType: 'ClaimGroup',
        entityId: row.id,
        after: row,
      });
      return toAdminClaimGroup(row);
    });
  }

  async updateGroup(
    ctx: SecurityContext,
    id: number,
    input: UpdateClaimGroupRequest,
    action = 'CLAIM_GROUP.UPDATED',
  ): Promise<AdminClaimGroup> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'ClaimGroup', id);
      const before = await tx.claimGroup.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('Claim group');
      assertVersion(before, input.version);
      const { version: _version, ...fields } = input;
      if (
        fields.code &&
        fields.code !== before.code &&
        (await tx.claimGroup.findUnique({ where: { code: fields.code } }))
      ) {
        throw new ConflictError('A claim group with this code already exists');
      }
      const after = await tx.claimGroup.update({
        where: { id },
        data: { ...fields, version: { increment: 1 } },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action,
        entityType: 'ClaimGroup',
        entityId: id,
        before,
        after,
      });
      return toAdminClaimGroup(after);
    });
  }

  deactivateGroup(ctx: SecurityContext, id: number, version: number): Promise<AdminClaimGroup> {
    return this.updateGroup(ctx, id, { version, isActive: false }, 'CLAIM_GROUP.DEACTIVATED');
  }

  // ───────────── Types ─────────────

  async listTypes(query: AdminClaimTypesQuery): Promise<{ items: AdminClaimType[] }> {
    const rows = await this.db.prisma.claimType.findMany({
      where: query.groupId ? { groupId: query.groupId } : {},
      orderBy: [{ groupId: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(toAdminClaimType) };
  }

  async getType(id: number): Promise<AdminClaimType> {
    const row = await this.db.prisma.claimType.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('Claim type');
    return toAdminClaimType(row);
  }

  private assertModeFields(
    inputMode: ClaimType['inputMode'],
    rate: string | null,
    rateMultiplier: string | null,
  ): void {
    if (rateMultiplier !== null && inputMode !== 'HOURS') {
      throw ValidationError.field('rateMultiplier', 'A rate multiplier is only used for hours');
    }
    if (inputMode === 'AMOUNT' && rate !== null) {
      throw ValidationError.field('rate', 'An amount claim type has no rate');
    }
  }

  async createType(ctx: SecurityContext, input: CreateClaimTypeRequest): Promise<AdminClaimType> {
    return this.db.tx(ctx, async (tx) => {
      if (!(await tx.claimGroup.findUnique({ where: { id: input.groupId } }))) {
        throw ValidationError.field('groupId', 'Unknown claim group');
      }
      if (
        await tx.claimType.findUnique({
          where: { groupId_code: { groupId: input.groupId, code: input.code } },
        })
      ) {
        throw new ConflictError('This group already has a claim type with this code');
      }
      this.assertModeFields(input.inputMode, input.rate, input.rateMultiplier);
      let id = input.id;
      if (id === undefined) {
        const max = await tx.claimType.aggregate({ _max: { id: true } });
        id = (max._max.id ?? 0) + 1;
      } else if (await tx.claimType.findUnique({ where: { id } })) {
        throw new ConflictError('A claim type with this id already exists');
      }
      const row = await tx.claimType.create({
        data: {
          ...input,
          id,
          rate: decimalOrNull(input.rate) ?? null,
          rateMultiplier: decimalOrNull(input.rateMultiplier) ?? null,
        },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'CLAIM_TYPE.CREATED',
        entityType: 'ClaimType',
        entityId: row.id,
        after: row,
      });
      return toAdminClaimType(row);
    });
  }

  async updateType(
    ctx: SecurityContext,
    id: number,
    input: UpdateClaimTypeRequest,
    action = 'CLAIM_TYPE.UPDATED',
  ): Promise<AdminClaimType> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'ClaimType', id);
      const before = await tx.claimType.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('Claim type');
      assertVersion(before, input.version);
      const { version: _version, rate, rateMultiplier, ...fields } = input;
      if (
        fields.code &&
        fields.code !== before.code &&
        (await tx.claimType.findUnique({
          where: { groupId_code: { groupId: before.groupId, code: fields.code } },
        }))
      ) {
        throw new ConflictError('This group already has a claim type with this code');
      }
      const nextRate = rate === undefined ? (before.rate?.toString() ?? null) : rate;
      const nextMultiplier =
        rateMultiplier === undefined ? (before.rateMultiplier?.toString() ?? null) : rateMultiplier;
      this.assertModeFields(fields.inputMode ?? before.inputMode, nextRate, nextMultiplier);
      const data: Prisma.ClaimTypeUpdateInput = { ...fields, version: { increment: 1 } };
      if (rate !== undefined) data.rate = decimalOrNull(rate);
      if (rateMultiplier !== undefined) data.rateMultiplier = decimalOrNull(rateMultiplier);
      const after = await tx.claimType.update({ where: { id }, data });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action,
        entityType: 'ClaimType',
        entityId: id,
        before,
        after,
      });
      return toAdminClaimType(after);
    });
  }

  deactivateType(ctx: SecurityContext, id: number, version: number): Promise<AdminClaimType> {
    return this.updateType(ctx, id, { version, isActive: false }, 'CLAIM_TYPE.DEACTIVATED');
  }

  // ───────────── Caps ─────────────

  async listCaps(query: AdminClaimCapsQuery): Promise<{ items: AdminClaimCap[] }> {
    const rows = await this.db.prisma.claimCap.findMany({
      where: query.claimTypeId ? { claimTypeId: query.claimTypeId } : {},
      orderBy: [{ claimTypeId: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(toAdminClaimCap) };
  }

  /** A company-rule cap must be in the admin's companies. */
  private async assertRuleInScope(tx: Tx, ctx: SecurityContext, companyRuleId: number | null): Promise<void> {
    if (companyRuleId === null) return;
    const rule = await tx.companyRule.findUnique({ where: { id: companyRuleId } });
    if (!rule) throw ValidationError.field('companyRuleId', 'Unknown company rule');
    if (!ctx.isSystem && !ctx.companyIds.includes(rule.companyId)) {
      throw new ForbiddenError('This company rule is not in your companies', { metadata: { companyRuleId } });
    }
  }

  /** One active cap per claim type, company rule and cycle. */
  private async assertNoActiveTwin(
    tx: Tx,
    cap: { claimTypeId: number; companyRuleId: number | null; cycle: ClaimCap['cycle'] },
    exceptId?: number,
  ): Promise<void> {
    const twin = await tx.claimCap.findFirst({
      where: {
        claimTypeId: cap.claimTypeId,
        companyRuleId: cap.companyRuleId,
        cycle: cap.cycle,
        isActive: true,
        ...(exceptId !== undefined ? { id: { not: exceptId } } : {}),
      },
    });
    if (twin) {
      throw new ConflictError('An active cap for this claim type, company rule and cycle already exists');
    }
  }

  private assertLimits(
    mode: ClaimCap['mode'],
    amountLimit: string | null,
    quantityLimit: string | null,
  ): void {
    if (mode !== 'NO_CAP' && amountLimit === null && quantityLimit === null) {
      throw ValidationError.field('amountLimit', 'A Warn or Block cap needs an amount or a quantity limit');
    }
  }

  async createCap(ctx: SecurityContext, input: CreateClaimCapRequest): Promise<AdminClaimCap> {
    return this.db.tx(ctx, async (tx) => {
      if (!(await tx.claimType.findUnique({ where: { id: input.claimTypeId } }))) {
        throw ValidationError.field('claimTypeId', 'Unknown claim type');
      }
      await this.assertRuleInScope(tx, ctx, input.companyRuleId);
      this.assertLimits(input.mode, input.amountLimit, input.quantityLimit);
      if (input.isActive) await this.assertNoActiveTwin(tx, input);
      const row = await tx.claimCap.create({
        data: {
          ...input,
          amountLimit: decimalOrNull(input.amountLimit) ?? null,
          quantityLimit: decimalOrNull(input.quantityLimit) ?? null,
        },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'CLAIM_CAP.CREATED',
        entityType: 'ClaimCap',
        entityId: row.id,
        after: row,
      });
      return toAdminClaimCap(row);
    });
  }

  async updateCap(
    ctx: SecurityContext,
    id: number,
    input: UpdateClaimCapRequest,
    action = 'CLAIM_CAP.UPDATED',
  ): Promise<AdminClaimCap> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'ClaimCap', id);
      const before = await tx.claimCap.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('Claim cap');
      await this.assertRuleInScope(tx, ctx, before.companyRuleId);
      assertVersion(before, input.version);
      const { version: _version, amountLimit, quantityLimit, ...fields } = input;
      const next = {
        mode: fields.mode ?? before.mode,
        cycle: fields.cycle ?? before.cycle,
        isActive: fields.isActive ?? before.isActive,
        amountLimit: amountLimit === undefined ? (before.amountLimit?.toString() ?? null) : amountLimit,
        quantityLimit:
          quantityLimit === undefined ? (before.quantityLimit?.toString() ?? null) : quantityLimit,
      };
      this.assertLimits(next.mode, next.amountLimit, next.quantityLimit);
      if (next.isActive && (!before.isActive || next.cycle !== before.cycle)) {
        await this.assertNoActiveTwin(
          tx,
          { claimTypeId: before.claimTypeId, companyRuleId: before.companyRuleId, cycle: next.cycle },
          id,
        );
      }
      const data: Prisma.ClaimCapUpdateInput = { ...fields, version: { increment: 1 } };
      if (amountLimit !== undefined) data.amountLimit = decimalOrNull(amountLimit);
      if (quantityLimit !== undefined) data.quantityLimit = decimalOrNull(quantityLimit);
      const after = await tx.claimCap.update({ where: { id }, data });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action,
        entityType: 'ClaimCap',
        entityId: id,
        before,
        after,
      });
      return toAdminClaimCap(after);
    });
  }

  deactivateCap(ctx: SecurityContext, id: number, version: number): Promise<AdminClaimCap> {
    return this.updateCap(ctx, id, { version, isActive: false }, 'CLAIM_CAP.DEACTIVATED');
  }

  // ───────────── Balance adjustments ─────────────

  /**
   * POST /admin/claims/adjustments (PAYROLL_ADMIN of the employee's company): a balance
   * adjustment for the cycle of the type's cap that contains `date`.
   */
  async adjust(ctx: SecurityContext, input: ClaimAdjustmentRequest): Promise<ClaimAdjustment> {
    return this.db.tx(ctx, async (tx) => {
      await this.scope.assertCanAccessEmployee(ctx, input.employeeId, 'PAYROLL', tx);
      const employee = await this.setup.loadEmployee(tx, input.employeeId);
      const type = await tx.claimType.findUnique({
        where: { id: input.claimTypeId },
        include: { caps: true },
      });
      if (!type) throw ValidationError.field('claimTypeId', 'Unknown claim type');
      const caps = capsForRule(type.caps, employee.companyRuleId).filter(
        (c) => input.cycle === undefined || c.cycle === input.cycle,
      );
      if (caps.length === 0) {
        throw ValidationError.field(
          input.cycle ? 'cycle' : 'claimTypeId',
          "This claim type has no cap for the employee's company rule",
        );
      }
      const cycles = new Set(caps.map((c) => c.cycle));
      if (cycles.size > 1) throw ValidationError.field('cycle', 'Choose the cap cycle to adjust');
      const cap = caps[0];
      if (!cap) throw ValidationError.field('claimTypeId', 'No cap to adjust');
      const date = input.date ?? todayBusinessDate();
      const window = await this.balances.cycleOn(tx, employee.companyRuleId, cap.cycle, date);
      const row = await tx.claimBalanceAdjustment.create({
        data: {
          employeeId: employee.id,
          claimTypeId: type.id,
          cycleStartDate: dateFromBusiness(window.start),
          amount: dec(input.amount).toString(),
          quantity: dec(input.quantity).toString(),
          reason: input.reason,
          createdByUserId: ctx.userId,
        },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'CLAIM.BALANCE_ADJUSTED',
        entityType: 'ClaimBalanceAdjustment',
        entityId: row.id,
        subjectEmployeeId: employee.id,
        after: row,
        reason: input.reason,
        metadata: {
          claimTypeId: type.id,
          capId: cap.id,
          cycle: cap.cycle,
          cycleStartDate: window.start,
          cycleEndDate: window.end,
        },
      });
      return {
        id: row.id,
        employeeId: row.employeeId,
        claimTypeId: row.claimTypeId,
        cycle: cap.cycle,
        cycleStartDate: businessFromDate(row.cycleStartDate),
        cycleEndDate: window.end,
        amount: money2(row.amount),
        quantity: units4(row.quantity),
        reason: row.reason,
        createdByUserId: row.createdByUserId,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }
}
