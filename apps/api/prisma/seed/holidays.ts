import {
  dateFromBusiness,
  GOVERNMENT_GAZETTE_REMINDER,
  NAMIBIAN_HOLIDAY_RULES,
  NAMIBIAN_HOLIDAYS_2026,
  todayBusinessDate,
} from '@peoplehub/shared';
import { HolidayService } from '../../src/modules/holidays/holiday.service';
import type { SeedDeps, SeedSummary } from './index';

/**
 * Section 14: the Namibian holiday rules table (fixed and Easter-relative dates) for every company,
 * the 2026 public holidays exactly as listed, and this year and next year generated from the rules. Existing
 * rules and rows are left alone, so HR corrections survive a re-seed. Prints the Government
 * Gazette reminder.
 */
export async function seedHolidays(deps: SeedDeps): Promise<SeedSummary> {
  const { db, ctx } = deps;
  const created = await db.tx(ctx, async (tx) => {
    let rules = 0;
    let holidays = 0;
    const ruleIds = new Map<string, number>();
    for (const rule of NAMIBIAN_HOLIDAY_RULES) {
      const existing = await tx.holidayRule.findFirst({ where: { companyId: null, name: rule.name } });
      if (existing) {
        ruleIds.set(rule.name, existing.id);
        continue;
      }
      const row = await tx.holidayRule.create({
        data: {
          companyId: null,
          name: rule.name,
          kind: rule.kind,
          month: rule.month ?? null,
          day: rule.day ?? null,
          easterOffsetDays: rule.easterOffsetDays ?? null,
          validFromYear: rule.validFromYear ?? null,
          validToYear: rule.validToYear ?? null,
        },
      });
      ruleIds.set(rule.name, row.id);
      rules += 1;
    }
    for (const h of NAMIBIAN_HOLIDAYS_2026) {
      const existing = await tx.publicHoliday.findFirst({
        where: { companyId: null, date: dateFromBusiness(h.date) },
      });
      if (existing) continue;
      await tx.publicHoliday.create({
        data: {
          companyId: null,
          date: dateFromBusiness(h.date),
          name: h.name,
          ruleId: ruleIds.get(h.name) ?? null,
        },
      });
      holidays += 1;
    }
    return { rules, holidays };
  });
  const year = Number(todayBusinessDate().slice(0, 4));
  const holidays = deps.app.get(HolidayService);
  let generated = 0;
  for (const y of [year, year + 1]) generated += (await holidays.generateYear(ctx, y)).created;
  console.warn(GOVERNMENT_GAZETTE_REMINDER);
  return {
    holidayRulesCreated: created.rules,
    publicHolidays2026Created: created.holidays,
    publicHolidaysGenerated: generated,
  };
}
