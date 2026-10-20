import { addDays, type BusinessDate, daysInMonth, easterSunday, observedDate } from './dates';

// Public holiday rules (section 14): fixed dates and Easter-relative dates, with the Namibian rule
// that a holiday falling on a Sunday is observed on the Monday.

export const HOLIDAY_RULE_KINDS = ['FIXED', 'EASTER_RELATIVE'] as const;
export type HolidayRuleKind = (typeof HOLIDAY_RULE_KINDS)[number];

/** The fields that decide a rule's date. */
export interface HolidayRuleShape {
  kind: HolidayRuleKind;
  month?: number | null;
  day?: number | null;
  easterOffsetDays?: number | null;
  validFromYear?: number | null;
  validToYear?: number | null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Whether the rule applies in `year` (its validity window). */
export function holidayRuleAppliesIn(rule: HolidayRuleShape, year: number): boolean {
  if (rule.validFromYear !== null && rule.validFromYear !== undefined && year < rule.validFromYear)
    return false;
  if (rule.validToYear !== null && rule.validToYear !== undefined && year > rule.validToYear) return false;
  return true;
}

/**
 * The calendar date of a rule in `year` (before the Sunday→Monday shift), or null when the rule
 * does not apply that year or describes an impossible date (29 February in a common year).
 */
export function holidayRuleDate(rule: HolidayRuleShape, year: number): BusinessDate | null {
  if (!holidayRuleAppliesIn(rule, year)) return null;
  if (rule.kind === 'EASTER_RELATIVE') {
    return addDays(easterSunday(year), rule.easterOffsetDays ?? 0);
  }
  const month = rule.month ?? 0;
  const day = rule.day ?? 0;
  if (month < 1 || month > 12 || day < 1) return null;
  const first = `${year}-${pad2(month)}-01`;
  if (day > daysInMonth(first)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** The day a holiday is observed: the Monday after a Sunday, unless the rule opts out. */
export function holidayObservedDate(date: BusinessDate, observeSundayOnMonday = true): BusinessDate {
  return observeSundayOnMonday ? observedDate(date) : date;
}

/**
 * Reminder printed by the seed and the yearly generation job: generated dates are a starting point
 * and HR must check them against the Government Gazette (section 14).
 */
export const GOVERNMENT_GAZETTE_REMINDER =
  'Public holidays: HR must verify the generated dates against the official Namibian Government Gazette each year ' +
  '(proclaimed once-off holidays are not covered by the rules table).';

/** The Namibian public holidays the rules table is seeded with (section 14, ASSUMPTION for validity years). */
export const NAMIBIAN_HOLIDAY_RULES: readonly (HolidayRuleShape & { name: string })[] = [
  { name: "New Year's Day", kind: 'FIXED', month: 1, day: 1 },
  { name: 'Independence Day', kind: 'FIXED', month: 3, day: 21 },
  { name: 'Good Friday', kind: 'EASTER_RELATIVE', easterOffsetDays: -2 },
  { name: 'Easter Monday', kind: 'EASTER_RELATIVE', easterOffsetDays: 1 },
  { name: "Workers' Day", kind: 'FIXED', month: 5, day: 1 },
  { name: 'Cassinga Day', kind: 'FIXED', month: 5, day: 4 },
  { name: 'Ascension Day', kind: 'EASTER_RELATIVE', easterOffsetDays: 39 },
  { name: 'Africa Day', kind: 'FIXED', month: 5, day: 25 },
  { name: 'Genocide Remembrance Day', kind: 'FIXED', month: 5, day: 28, validFromYear: 2025 },
  { name: "Heroes' Day", kind: 'FIXED', month: 8, day: 26 },
  { name: 'Human Rights Day', kind: 'FIXED', month: 12, day: 10 },
  { name: 'Christmas Day', kind: 'FIXED', month: 12, day: 25 },
  { name: 'Family Day', kind: 'FIXED', month: 12, day: 26 },
];

/** The 2026 list exactly as section 14 gives it. */
export const NAMIBIAN_HOLIDAYS_2026: readonly { date: BusinessDate; name: string }[] = [
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-03-21', name: 'Independence Day' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-04-06', name: 'Easter Monday' },
  { date: '2026-05-01', name: "Workers' Day" },
  { date: '2026-05-04', name: 'Cassinga Day' },
  { date: '2026-05-14', name: 'Ascension Day' },
  { date: '2026-05-25', name: 'Africa Day' },
  { date: '2026-05-28', name: 'Genocide Remembrance Day' },
  { date: '2026-08-26', name: "Heroes' Day" },
  { date: '2026-12-10', name: 'Human Rights Day' },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2026-12-26', name: 'Family Day' },
];
