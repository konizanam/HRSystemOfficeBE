import { Injectable } from '@nestjs/common';
import type { HolidayRule, PublicHoliday } from '@prisma/client';
import {
  type AdminHolidayRule,
  type AdminHolidayRulesResponse,
  type AdminPublicHoliday,
  type AdminPublicHolidaysQuery,
  type AdminPublicHolidaysResponse,
  businessFromDate,
  type CreateHolidayRuleRequest,
  type CreatePublicHolidayRequest,
  dateFromBusiness,
  holidayObservedDate,
  holidayRuleDate,
  todayBusinessDate,
  type UpdateHolidayRuleRequest,
  type UpdatePublicHolidayRequest,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import {
  assertVersion,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { assertCompanyScope } from './admin-scope';

type HolidayRow = PublicHoliday & { rule: HolidayRule | null };

function holidayDto(h: HolidayRow): AdminPublicHoliday {
  const date = businessFromDate(h.date);
  return {
    id: h.id,
    companyId: h.companyId,
    date,
    observedDate: holidayObservedDate(date, h.rule?.observeSundayOnMonday ?? true),
    name: h.name,
    ruleId: h.ruleId,
    isDeleted: h.deletedAt !== null,
    version: h.version,
    updatedAt: h.updatedAt.toISOString(),
  };
}

function ruleDto(r: HolidayRule): AdminHolidayRule {
  return {
    id: r.id,
    companyId: r.companyId,
    name: r.name,
    kind: r.kind,
    month: r.month,
    day: r.day,
    easterOffsetDays: r.easterOffsetDays,
    observeSundayOnMonday: r.observeSundayOnMonday,
    validFromYear: r.validFromYear,
    validToYear: r.validToYear,
    isActive: r.isActive,
    thisYear: holidayRuleDate(r, Number(todayBusinessDate().slice(0, 4))),
    version: r.version,
  };
}

/** Fields of a rule that matter for its kind; the others are cleared. */
function ruleFields(input: Omit<CreateHolidayRuleRequest, 'companyId'>) {
  return {
    name: input.name,
    kind: input.kind,
    month: input.kind === 'FIXED' ? input.month : null,
    day: input.kind === 'FIXED' ? input.day : null,
    easterOffsetDays: input.kind === 'EASTER_RELATIVE' ? input.easterOffsetDays : null,
    observeSundayOnMonday: input.observeSundayOnMonday,
    validFromYear: input.validFromYear,
    validToYear: input.validToYear,
  };
}

/**
 * Public holidays and holiday rules (section 12.10, HR_ADMIN). A holiday or rule of every company
 * (`companyId` null, the national calendar) may be changed by any HR admin; a company's own
 * holidays only by HR of that company. Deleting a holiday soft-deletes it (it then stays off,
 * even for its rule's year); deleting a rule deactivates it.
 */
@Injectable()
export class HolidayAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async listHolidays(query: AdminPublicHolidaysQuery): Promise<AdminPublicHolidaysResponse> {
    const year = query.year ?? Number(todayBusinessDate().slice(0, 4));
    const rows = await this.db.prisma.publicHoliday.findMany({
      where: {
        OR: query.companyId ? [{ companyId: null }, { companyId: query.companyId }] : [{ companyId: null }],
        date: { gte: dateFromBusiness(`${year}-01-01`), lte: dateFromBusiness(`${year}-12-31`) },
        ...(query.includeDeleted ? {} : { deletedAt: null }),
      },
      include: { rule: true },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(holidayDto) };
  }

  async createHoliday(ctx: SecurityContext, input: CreatePublicHolidayRequest): Promise<AdminPublicHoliday> {
    return this.db.tx(ctx, async (tx) => {
      await this.checkCompany(tx, ctx, input.companyId);
      const date = dateFromBusiness(input.date);
      const existing = await tx.publicHoliday.findFirst({
        where: { companyId: input.companyId, date },
        include: { rule: true },
      });
      if (existing && existing.deletedAt === null) {
        throw new ConflictError(`${input.date} is already a public holiday (${existing.name})`);
      }
      if (existing) {
        // Bring back the removed row (its unique key is taken) with the new name.
        const after = await tx.publicHoliday.update({
          where: { id: existing.id },
          data: { name: input.name, deletedAt: null, version: { increment: 1 } },
          include: { rule: true },
        });
        this.audit.record(tx, ctx, {
          category: 'DATA_CHANGE',
          action: 'HOLIDAY.RESTORED',
          entityType: 'PublicHoliday',
          entityId: after.id,
          before: plainHoliday(existing),
          after: plainHoliday(after),
        });
        return holidayDto(after);
      }
      const row = await tx.publicHoliday.create({
        data: { companyId: input.companyId, date, name: input.name },
        include: { rule: true },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'HOLIDAY.CREATED',
        entityType: 'PublicHoliday',
        entityId: row.id,
        after: plainHoliday(row),
      });
      return holidayDto(row);
    });
  }

  async updateHoliday(
    ctx: SecurityContext,
    id: number,
    input: UpdatePublicHolidayRequest,
  ): Promise<AdminPublicHoliday> {
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lockHoliday(tx, ctx, id);
      assertVersion(before, input.version);
      if (before.deletedAt) throw ValidationError.field('', 'This holiday was deleted');
      if (input.date && input.date !== businessFromDate(before.date)) {
        const clash = await tx.publicHoliday.findFirst({
          where: { companyId: before.companyId, date: dateFromBusiness(input.date), id: { not: id } },
        });
        if (clash) throw new ConflictError(`${input.date} already has a public holiday row`);
      }
      const after = await tx.publicHoliday.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.date ? { date: dateFromBusiness(input.date) } : {}),
          version: { increment: 1 },
        },
        include: { rule: true },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'HOLIDAY.UPDATED',
        entityType: 'PublicHoliday',
        entityId: id,
        before: plainHoliday(before),
        after: plainHoliday(after),
      });
      return holidayDto(after);
    });
  }

  async deleteHoliday(ctx: SecurityContext, id: number, version: number): Promise<AdminPublicHoliday> {
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lockHoliday(tx, ctx, id);
      assertVersion(before, version);
      if (before.deletedAt) throw ValidationError.field('', 'This holiday was already deleted');
      const after = await tx.publicHoliday.update({
        where: { id },
        data: { deletedAt: new Date(), version: { increment: 1 } },
        include: { rule: true },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'HOLIDAY.DELETED',
        entityType: 'PublicHoliday',
        entityId: id,
        before: plainHoliday(before),
        after: plainHoliday(after),
      });
      return holidayDto(after);
    });
  }

  // ───────────── Rules ─────────────

  async listRules(companyId?: number): Promise<AdminHolidayRulesResponse> {
    const rows = await this.db.prisma.holidayRule.findMany({
      where: { OR: companyId ? [{ companyId: null }, { companyId }] : [{ companyId: null }] },
      orderBy: [{ companyId: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(ruleDto) };
  }

  async createRule(ctx: SecurityContext, input: CreateHolidayRuleRequest): Promise<AdminHolidayRule> {
    return this.db.tx(ctx, async (tx) => {
      await this.checkCompany(tx, ctx, input.companyId);
      const row = await tx.holidayRule.create({ data: { companyId: input.companyId, ...ruleFields(input) } });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'HOLIDAY_RULE.CREATED',
        entityType: 'HolidayRule',
        entityId: row.id,
        after: row,
      });
      return ruleDto(row);
    });
  }

  async updateRule(
    ctx: SecurityContext,
    id: number,
    input: UpdateHolidayRuleRequest,
  ): Promise<AdminHolidayRule> {
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lockRule(tx, ctx, id);
      assertVersion(before, input.version);
      const after = await tx.holidayRule.update({
        where: { id },
        data: { ...ruleFields(input), version: { increment: 1 } },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'HOLIDAY_RULE.UPDATED',
        entityType: 'HolidayRule',
        entityId: id,
        before,
        after,
      });
      return ruleDto(after);
    });
  }

  async setRuleActive(
    ctx: SecurityContext,
    id: number,
    isActive: boolean,
    version: number,
  ): Promise<AdminHolidayRule> {
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lockRule(tx, ctx, id);
      assertVersion(before, version);
      const after = await tx.holidayRule.update({
        where: { id },
        data: { isActive, version: { increment: 1 } },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: isActive ? 'HOLIDAY_RULE.ACTIVATED' : 'HOLIDAY_RULE.DEACTIVATED',
        entityType: 'HolidayRule',
        entityId: id,
        before,
        after,
      });
      return ruleDto(after);
    });
  }

  private async checkCompany(tx: Tx, ctx: SecurityContext, companyId: number | null): Promise<void> {
    if (companyId === null) return;
    const company = await tx.company.findUnique({ where: { id: companyId } });
    if (!company) throw ValidationError.field('companyId', 'Unknown company');
    assertCompanyScope(ctx, companyId);
  }

  private async lockHoliday(tx: Tx, ctx: SecurityContext, id: number): Promise<HolidayRow> {
    await this.db.lockRow(tx, 'PublicHoliday', id);
    const row = await tx.publicHoliday.findUnique({ where: { id }, include: { rule: true } });
    if (!row) throw new NotFoundError('Public holiday');
    if (row.companyId !== null) assertCompanyScope(ctx, row.companyId);
    return row;
  }

  private async lockRule(tx: Tx, ctx: SecurityContext, id: number): Promise<HolidayRule> {
    await this.db.lockRow(tx, 'HolidayRule', id);
    const row = await tx.holidayRule.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('Holiday rule');
    if (row.companyId !== null) assertCompanyScope(ctx, row.companyId);
    return row;
  }
}

function plainHoliday(h: HolidayRow): PublicHoliday {
  const { rule: _rule, ...rest } = h;
  return rest;
}
