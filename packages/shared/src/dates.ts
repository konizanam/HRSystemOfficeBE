import { formatInTimeZone } from 'date-fns-tz';

/** All business dates are in this zone (section 2). */
export const BUSINESS_TIMEZONE = 'Africa/Windhoek';

/** `YYYY-MM-DD` business date string. */
export type BusinessDate = string;

export const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 86_400_000;

/** Today's date in Africa/Windhoek as `YYYY-MM-DD`. */
export function todayBusinessDate(now: Date = new Date()): BusinessDate {
  return formatInTimeZone(now, BUSINESS_TIMEZONE, 'yyyy-MM-dd');
}

/** The business date (Windhoek) on which a timestamp falls. */
export function businessDateOf(value: Date): BusinessDate {
  return formatInTimeZone(value, BUSINESS_TIMEZONE, 'yyyy-MM-dd');
}

export function isBusinessDate(value: string): boolean {
  if (!BUSINESS_DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Converts a `YYYY-MM-DD` string to a Date at UTC midnight. This is how Prisma reads and writes
 * `@db.Date` columns, so the same representation is used everywhere on the server.
 */
export function dateFromBusiness(value: BusinessDate): Date {
  if (!isBusinessDate(value)) throw new RangeError(`Invalid business date: ${value}`);
  return new Date(`${value}T00:00:00.000Z`);
}

/** Inverse of {@link dateFromBusiness}: reads the UTC calendar date of a `@db.Date` value. */
export function businessFromDate(value: Date): BusinessDate {
  return value.toISOString().slice(0, 10);
}

export function addDays(value: BusinessDate, days: number): BusinessDate {
  return businessFromDate(new Date(dateFromBusiness(value).getTime() + days * DAY_MS));
}

/** Inclusive list of calendar dates from `from` to `to`. */
export function eachBusinessDate(from: BusinessDate, to: BusinessDate): BusinessDate[] {
  const end = dateFromBusiness(to).getTime();
  const out: BusinessDate[] = [];
  for (let t = dateFromBusiness(from).getTime(); t <= end; t += DAY_MS) {
    out.push(businessFromDate(new Date(t)));
  }
  return out;
}

/** Calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: BusinessDate, to: BusinessDate): number {
  return Math.round((dateFromBusiness(to).getTime() - dateFromBusiness(from).getTime()) / DAY_MS);
}

/** ISO weekday of a business date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(value: BusinessDate): number {
  const day = dateFromBusiness(value).getUTCDay();
  return day === 0 ? 7 : day;
}

export function isWeekend(value: BusinessDate): boolean {
  return isoWeekday(value) >= 6;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function toBusiness(value: BusinessDate | Date): BusinessDate {
  return typeof value === 'string' ? value.slice(0, 10) : businessFromDate(value);
}

function split(value: BusinessDate): [string, string, string] {
  const [y = '', m = '', d = ''] = value.split('-');
  return [y, m, d];
}

/** Grid format `dd-MMM-yyyy`, e.g. `24-Sep-2026`. */
export function formatGridDate(value: BusinessDate | Date | null | undefined): string {
  if (!value) return '';
  const [y, m, d] = split(toBusiness(value));
  return `${d}-${MONTHS[Number(m) - 1] ?? ''}-${y}`;
}

/** Inbox card format `dd MMM yyyy`, e.g. `24 Sep 2026`. */
export function formatCardDate(value: BusinessDate | Date | null | undefined): string {
  if (!value) return '';
  const [y, m, d] = split(toBusiness(value));
  return `${d} ${MONTHS[Number(m) - 1] ?? ''} ${y}`;
}

/** Formats a timestamp in the business zone as `dd MMM yyyy`. */
export function formatTimestampDate(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return formatCardDate(businessDateOf(d));
}

/** Formats a timestamp in the business zone as `dd MMM yyyy HH:mm`. */
export function formatTimestamp(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return `${formatCardDate(businessDateOf(d))} ${formatInTimeZone(d, BUSINESS_TIMEZONE, 'HH:mm')}`;
}

/** Age in whole years on `onDate`. */
export function ageOn(dateOfBirth: BusinessDate, onDate: BusinessDate): number {
  const [by, bm, bd] = split(dateOfBirth).map(Number) as [number, number, number];
  const [y, m, d] = split(onDate).map(Number) as [number, number, number];
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

export function startOfMonth(value: BusinessDate): BusinessDate {
  return `${value.slice(0, 7)}-01`;
}

export function endOfMonth(value: BusinessDate): BusinessDate {
  const [y, m] = split(value).map(Number) as [number, number];
  return businessFromDate(new Date(Date.UTC(y, m, 0)));
}

export function daysInMonth(value: BusinessDate): number {
  return Number(endOfMonth(value).slice(8, 10));
}

/** Adds whole calendar months, clamping to the month end (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(value: BusinessDate, months: number): BusinessDate {
  const [y, m, d] = split(value).map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return businessFromDate(first);
}

export function maxDate(a: BusinessDate, b: BusinessDate): BusinessDate {
  return a > b ? a : b;
}

export function minDate(a: BusinessDate, b: BusinessDate): BusinessDate {
  return a < b ? a : b;
}

/** Easter Sunday for a Gregorian year (Anonymous Gregorian computus, Meeus/Jones/Butcher). */
export function easterSunday(year: number): BusinessDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** A public holiday that falls on a Sunday is observed on the Monday (Namibian rule). */
export function observedDate(value: BusinessDate): BusinessDate {
  return isoWeekday(value) === 7 ? addDays(value, 1) : value;
}
