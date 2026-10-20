import { type BusinessDate, daysBetween } from './dates';

// Upcoming birthdays (section 5.1.6): only the day and month are ever shown, never the year.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Default window of the dashboard widget and of `GET /birthdays/upcoming`. */
export const BIRTHDAY_WINDOW_DAYS = 30;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Day and month of a date of birth. */
export function birthdayDayMonth(dateOfBirth: BusinessDate): { day: number; month: number } {
  return { day: Number(dateOfBirth.slice(8, 10)), month: Number(dateOfBirth.slice(5, 7)) };
}

/** "05 Nov": the day and month only. */
export function birthdayLabel(dateOfBirth: BusinessDate): string {
  const { day, month } = birthdayDayMonth(dateOfBirth);
  return `${String(day).padStart(2, '0')} ${MONTHS[month - 1] ?? ''}`;
}

/**
 * The date the birthday is celebrated in `year`. A 29 February birthday falls on 28 February in a
 * year that is not a leap year (ASSUMPTION, see docs).
 */
export function birthdayInYear(dateOfBirth: BusinessDate, year: number): BusinessDate {
  const { day, month } = birthdayDayMonth(dateOfBirth);
  const d = month === 2 && day === 29 && !isLeapYear(year) ? 28 : day;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The next celebration on or after `today` (today itself when it is the birthday). */
export function nextBirthday(dateOfBirth: BusinessDate, today: BusinessDate): BusinessDate {
  const year = Number(today.slice(0, 4));
  const thisYear = birthdayInYear(dateOfBirth, year);
  return thisYear >= today ? thisYear : birthdayInYear(dateOfBirth, year + 1);
}

/** Days from `today` to the next birthday (0 = today). */
export function daysUntilBirthday(dateOfBirth: BusinessDate, today: BusinessDate): number {
  return daysBetween(today, nextBirthday(dateOfBirth, today));
}

/** True when the next birthday is today or within the following `days` days (inclusive). */
export function isBirthdayWithin(dateOfBirth: BusinessDate, today: BusinessDate, days: number): boolean {
  return daysUntilBirthday(dateOfBirth, today) <= days;
}

/**
 * True when a birthday is celebrated on some day between `from` and `to` (inclusive), in any of
 * the years the range touches. Used by the Birthday List report's date range.
 */
export function birthdayFallsBetween(
  dateOfBirth: BusinessDate,
  from: BusinessDate,
  to: BusinessDate,
): boolean {
  if (to < from) return false;
  const first = Number(from.slice(0, 4));
  const last = Number(to.slice(0, 4));
  for (let year = first; year <= last; year++) {
    const date = birthdayInYear(dateOfBirth, year);
    if (date >= from && date <= to) return true;
  }
  return false;
}
