import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { HolidayRule } from '@prisma/client';
import {
  addDays,
  type BusinessDate,
  businessFromDate,
  dateFromBusiness,
  GOVERNMENT_GAZETTE_REMINDER,
  holidayObservedDate,
  holidayRuleDate,
  type PublicHoliday,
  todayBusinessDate,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import { type SecurityContext, systemContext } from '../../common/context/security-context';
import { JobsService } from '../../jobs/jobs.service';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';

export const HOLIDAYS_GENERATE_JOB = 'holidays.generate';

/** Holidays by observed date, for the leave unit calculation. */
export type HolidayCalendar = Map<BusinessDate, string>;

function yearOf(date: BusinessDate): number {
  return Number(date.slice(0, 4));
}

/**
 * Public holidays (sections 12.2 and 14). Stored `PublicHoliday` rows (company-specific plus those
 * with `companyId = null`) are the source of truth; years without stored rows are filled from the
 * holiday rules table (fixed dates and Easter-relative dates). A holiday on a Sunday is observed on
 * the Monday (`observedDate`). The `holidays.generate` job stores next year's rule dates each
 * December so HR can check them against the Government Gazette.
 */
@Injectable()
export class HolidayService implements OnModuleInit {
  private readonly logger = new Logger(HolidayService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register<{ year?: number }>(
      HOLIDAYS_GENERATE_JOB,
      async (data) => {
        const year = data.year ?? yearOf(todayBusinessDate()) + 1;
        const counts = await this.generateYear(systemContext(`holidays-generate-${year}`), year);
        this.logger.warn(GOVERNMENT_GAZETTE_REMINDER);
        return { year, ...counts };
      },
      { cron: '0 2 1 12 *' },
    );
  }

  /**
   * Holidays whose date or observed date lies in [from, to] for a company (null = only those of
   * every company), ordered by observed date.
   */
  async between(
    companyId: number | null,
    from: BusinessDate,
    to: BusinessDate,
    client: Tx = this.db.prisma,
  ): Promise<PublicHoliday[]> {
    // A Sunday holiday the day before `from` is observed on `from`.
    const lookFrom = addDays(from, -1);
    const companyFilter = companyId === null ? [{ companyId: null }] : [{ companyId: null }, { companyId }];
    const [rows, rules] = await Promise.all([
      client.publicHoliday.findMany({
        where: {
          OR: companyFilter,
          date: {
            gte: dateFromBusiness(`${yearOf(lookFrom)}-01-01`),
            lte: dateFromBusiness(`${yearOf(to)}-12-31`),
          },
        },
        orderBy: { date: 'asc' },
      }),
      client.holidayRule.findMany({ where: { isActive: true, OR: companyFilter }, orderBy: { id: 'asc' } }),
    ]);

    const items: PublicHoliday[] = [];
    const storedKeys = new Set<string>();
    const storedRuleYears = new Set<string>();
    const ruleById = new Map(rules.map((r) => [r.id, r]));
    for (const row of rows) {
      const date = businessFromDate(row.date);
      const rule = row.ruleId !== null ? ruleById.get(row.ruleId) : undefined;
      if (row.ruleId !== null) storedRuleYears.add(`${row.ruleId}:${yearOf(date)}`);
      storedKeys.add(`${row.companyId ?? ''}:${date}`);
      // A deleted row is not a holiday, but it still stops its rule from filling that year in.
      if (row.deletedAt !== null) continue;
      items.push({
        date,
        observedDate: holidayObservedDate(date, rule?.observeSundayOnMonday ?? true),
        name: row.name,
        companyId: row.companyId,
        source: 'TABLE',
      });
    }
    for (let year = yearOf(lookFrom); year <= yearOf(to); year++) {
      for (const rule of rules) {
        if (storedRuleYears.has(`${rule.id}:${year}`)) continue;
        const date = holidayRuleDate(rule, year);
        if (!date || storedKeys.has(`${rule.companyId ?? ''}:${date}`)) continue;
        items.push({
          date,
          observedDate: holidayObservedDate(date, rule.observeSundayOnMonday),
          name: rule.name,
          companyId: rule.companyId,
          source: 'RULE',
        });
      }
    }
    return items
      .filter((h) => (h.date >= from && h.date <= to) || (h.observedDate >= from && h.observedDate <= to))
      .sort((a, b) => a.observedDate.localeCompare(b.observedDate) || a.name.localeCompare(b.name));
  }

  /**
   * The days in [from, to] that are public holidays for the leave calculation: the observed date,
   * and the holiday's own date as well (it matters only when weekends are counted).
   */
  async calendar(
    companyId: number | null,
    from: BusinessDate,
    to: BusinessDate,
    client: Tx = this.db.prisma,
  ): Promise<HolidayCalendar> {
    const map: HolidayCalendar = new Map();
    for (const h of await this.between(companyId, from, to, client)) {
      for (const day of new Set([h.date, h.observedDate])) {
        if (day < from || day > to) continue;
        const existing = map.get(day);
        map.set(day, existing && existing !== h.name ? `${existing} / ${h.name}` : h.name);
      }
    }
    return map;
  }

  /**
   * Stores the rule dates of `year` as PublicHoliday rows (idempotent: a rule that already has a
   * row that year, or a date that already has a holiday, is skipped; a row HR deleted counts, so
   * a removed holiday is not brought back). Every row is audited.
   */
  async generateYear(ctx: SecurityContext, year: number): Promise<{ created: number; skipped: number }> {
    return this.db.tx(ctx, async (tx) => {
      const rules = await tx.holidayRule.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } });
      let created = 0;
      let skipped = 0;
      for (const rule of rules) {
        const created1 = await this.generateRule(tx, ctx, rule, year);
        if (created1) created += 1;
        else skipped += 1;
      }
      return { created, skipped };
    });
  }

  private async generateRule(
    tx: Tx,
    ctx: SecurityContext,
    rule: HolidayRule,
    year: number,
  ): Promise<boolean> {
    const date = holidayRuleDate(rule, year);
    if (!date) return false;
    const existing = await tx.publicHoliday.findFirst({
      where: {
        OR: [
          {
            ruleId: rule.id,
            date: { gte: dateFromBusiness(`${year}-01-01`), lte: dateFromBusiness(`${year}-12-31`) },
          },
          { companyId: rule.companyId, date: dateFromBusiness(date) },
        ],
      },
      select: { id: true },
    });
    if (existing) return false;
    const row = await tx.publicHoliday.create({
      data: { companyId: rule.companyId, date: dateFromBusiness(date), name: rule.name, ruleId: rule.id },
    });
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: 'HOLIDAY.GENERATED',
      entityType: 'PublicHoliday',
      entityId: row.id,
      after: row,
      metadata: {
        ruleId: rule.id,
        year,
        observedDate: holidayObservedDate(date, rule.observeSundayOnMonday),
      },
    });
    return true;
  }
}
