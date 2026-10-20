import {
  addDays,
  addMonths,
  type BusinessDate,
  daysBetween,
  daysInMonth,
  type DayPortion,
  Decimal,
  dec,
  type DecimalInput,
  eachBusinessDate,
  endOfMonth,
  type ExcludedDay,
  isWeekend,
  LEAVE_MAX_RANGE_DAYS,
  LEAVE_PROBLEM_TYPES,
  type LedgerEntryType,
  maxDate,
  minDate,
  round4,
  startOfMonth,
} from '@peoplehub/shared';
import { DomainError, type FieldError, ValidationError } from '../../common/errors/domain-errors';

// Pure leave domain rules (section 5.2): no database, no Nest. The services load the data and
// call these, and the unit tests pin them to the section 1.7 fixtures.

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const HALF = new Decimal('0.5');

// ───────────── Units (section 5.2.1) ─────────────

export interface UnitCalculationInput {
  fromDate: BusinessDate;
  toDate: BusinessDate;
  startPortion: DayPortion;
  endPortion: DayPortion;
  excludeWeekends: boolean;
  excludePublicHolidays: boolean;
  allowHalfDay: boolean;
  /** Public holidays of the employee's company in the range, by (observed) date. */
  holidays: ReadonlyMap<BusinessDate, string>;
}

export interface CountedDay {
  date: BusinessDate;
  portion: DayPortion;
  units: Decimal;
}

export interface UnitCalculation {
  units: Decimal;
  days: CountedDay[];
  excluded: ExcludedDay[];
}

/**
 * `calculateUnits` (section 5.2.1):
 * 1. Iterate the dates; skip weekends when `excludeWeekends`, and the company's public holidays
 *    when `excludePublicHolidays`.
 * 2. Each counted day is 1. The start day is 0.5 when its portion is AM or PM, and so is the end
 *    day. When start = end, the day is 0.5 or 1 by the start portion.
 * 3. Return the per-day breakdown and the total rounded to 4 dp.
 * A range with no working days fails with 422.
 */
export function calculateUnits(input: UnitCalculationInput): UnitCalculation {
  const { fromDate, toDate } = input;
  if (toDate < fromDate) throw ValidationError.field('toDate', 'End must be on or after Start');
  if (daysBetween(fromDate, toDate) >= LEAVE_MAX_RANGE_DAYS) {
    throw ValidationError.field(
      'toDate',
      `A leave application can cover at most ${LEAVE_MAX_RANGE_DAYS} days`,
    );
  }
  const singleDay = fromDate === toDate;
  if (!input.allowHalfDay) {
    const errors: FieldError[] = [];
    if (input.startPortion !== 'FULL')
      errors.push({ path: 'startPortion', message: 'This leave type is taken in full days' });
    if (!singleDay && input.endPortion !== 'FULL') {
      errors.push({ path: 'endPortion', message: 'This leave type is taken in full days' });
    }
    if (errors.length) throw new ValidationError(errors);
  }

  const days: CountedDay[] = [];
  const excluded: ExcludedDay[] = [];
  for (const date of eachBusinessDate(fromDate, toDate)) {
    if (input.excludeWeekends && isWeekend(date)) {
      excluded.push({ date, reason: 'WEEKEND', name: null });
      continue;
    }
    const holiday = input.holidays.get(date);
    if (input.excludePublicHolidays && holiday !== undefined) {
      excluded.push({ date, reason: 'PUBLIC_HOLIDAY', name: holiday });
      continue;
    }
    let portion: DayPortion = 'FULL';
    if (singleDay) portion = input.startPortion;
    else if (date === fromDate && input.startPortion !== 'FULL') portion = input.startPortion;
    else if (date === toDate && input.endPortion !== 'FULL') portion = input.endPortion;
    days.push({ date, portion, units: portion === 'FULL' ? ONE : HALF });
  }

  const units = round4(days.reduce((sum, d) => sum.plus(d.units), ZERO));
  if (units.lte(0)) {
    throw new DomainError(
      422,
      'Validation failed',
      'The selected dates contain no working days',
      [{ path: 'toDate', message: 'The selected dates contain no working days' }],
      LEAVE_PROBLEM_TYPES.noWorkingDays,
    );
  }
  return { units, days, excluded };
}

// ───────────── Overlap (half-day granularity) ─────────────

export interface DayClaim {
  date: BusinessDate;
  portion: DayPortion;
}

/** Two claims on the same date clash unless one is the morning and the other the afternoon. */
export function portionsClash(a: DayPortion, b: DayPortion): boolean {
  if (a === 'FULL' || b === 'FULL') return true;
  return a === b;
}

/** The dates on which `requested` clashes with `existing`. */
export function overlappingDates(
  requested: readonly DayClaim[],
  existing: readonly DayClaim[],
): BusinessDate[] {
  const byDate = new Map<BusinessDate, DayPortion[]>();
  for (const e of existing) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e.portion]);
  return requested
    .filter((r) => (byDate.get(r.date) ?? []).some((p) => portionsClash(r.portion, p)))
    .map((r) => r.date);
}

// ───────────── Buckets and allocation ─────────────

export interface BucketBalance {
  id: number;
  cycleEndDate: BusinessDate;
  expiresOn: BusinessDate | null;
  /** Sum of the bucket's ledger. */
  balance: Decimal;
  /** Units reserved by in-flight applications. */
  reserved: Decimal;
}

/** Units free to allocate: balance − reserved. */
export function bucketAvailable(b: Pick<BucketBalance, 'balance' | 'reserved'>): Decimal {
  return b.balance.minus(b.reserved);
}

/** Buckets that can fund leave starting on `fromDate`, earliest cycle end first. */
export function eligibleBuckets<T extends BucketBalance>(buckets: readonly T[], fromDate: BusinessDate): T[] {
  return buckets
    .filter((b) => b.expiresOn === null || b.expiresOn >= fromDate)
    .sort((a, b) => a.cycleEndDate.localeCompare(b.cycleEndDate) || a.id - b.id);
}

/** Actual available for a request starting on `fromDate`: the free units of the eligible buckets. */
export function availableFor(buckets: readonly BucketBalance[], fromDate: BusinessDate): Decimal {
  return round4(eligibleBuckets(buckets, fromDate).reduce((sum, b) => sum.plus(bucketAvailable(b)), ZERO));
}

export interface Allocation {
  entitlementId: number;
  units: Decimal;
}

/**
 * Reserves `units` across the buckets (section 5.2.1): the bucket with the earliest
 * `cycleEndDate` first (Carry Forward before the current Annual bucket), each up to its free
 * units. What is left (a negative balance the policy allows) goes to the bucket with the latest
 * cycle end. Returns no allocation when no bucket is eligible.
 */
export function allocateUnits(
  units: DecimalInput,
  buckets: readonly BucketBalance[],
  fromDate: BusinessDate,
): Allocation[] {
  const eligible = eligibleBuckets(buckets, fromDate);
  const last = eligible[eligible.length - 1];
  if (!last) return [];
  let remaining = round4(units);
  const out = new Map<number, Decimal>();
  for (const b of eligible) {
    if (remaining.lte(0)) break;
    const free = Decimal.max(bucketAvailable(b), ZERO);
    const take = Decimal.min(free, remaining);
    if (take.gt(0)) {
      out.set(b.id, take);
      remaining = remaining.minus(take);
    }
  }
  if (remaining.gt(0)) out.set(last.id, (out.get(last.id) ?? ZERO).plus(remaining));
  return [...out.entries()].map(([entitlementId, u]) => ({ entitlementId, units: round4(u) }));
}

// ───────────── Balances (section 5.2.2) ─────────────

export interface LedgerMovement {
  entryType: LedgerEntryType;
  units: Decimal;
  effectiveDate: BusinessDate;
}

export interface PeriodFigures {
  /** Balance Brought Forward: the ledger before the period start. */
  broughtForward: Decimal;
  /** Accrued This Period: ACCRUAL from the period start. */
  accrued: Decimal;
  /** Taken This Period: −TAKEN from the period start. */
  taken: Decimal;
  /** Every other movement from the period start (adjustments, reversals, carry forward, …). */
  adjustments: Decimal;
  /** Balance Carried Forward = BF + accrued − taken + adjustments. */
  carriedForward: Decimal;
}

/**
 * The bucket grid figures for a period starting on `periodStart`. Movements dated on or after the
 * start count in the period, so CF always equals the ledger balance and Actual Available = CF −
 * Pending = ledger balance − pending (sections 1.7 and 5.2.2 agree).
 */
export function periodFigures(
  movements: readonly LedgerMovement[],
  periodStart: BusinessDate,
): PeriodFigures {
  let broughtForward = ZERO;
  let accrued = ZERO;
  let taken = ZERO;
  let adjustments = ZERO;
  for (const m of movements) {
    if (m.effectiveDate < periodStart) broughtForward = broughtForward.plus(m.units);
    else if (m.entryType === 'ACCRUAL') accrued = accrued.plus(m.units);
    else if (m.entryType === 'TAKEN') taken = taken.minus(m.units);
    else adjustments = adjustments.plus(m.units);
  }
  return {
    broughtForward: round4(broughtForward),
    accrued: round4(accrued),
    taken: round4(taken),
    adjustments: round4(adjustments),
    carriedForward: round4(broughtForward.plus(accrued).minus(taken).plus(adjustments)),
  };
}

/** Actual Available = CF − Pending. */
export function actualAvailable(carriedForward: DecimalInput, pending: DecimalInput): Decimal {
  return round4(dec(carriedForward).minus(dec(pending)));
}

// ───────────── Cycles ─────────────

/** Calendar cycles are anchored on this date (ASSUMPTION: 12-month cycles follow the calendar year). */
export const CYCLE_ANCHOR: BusinessDate = '2024-01-01';

export interface Cycle {
  start: BusinessDate;
  end: BusinessDate;
}

function monthIndex(date: BusinessDate): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

/** The anchored cycle of `cycleMonths` months that contains `date`. */
export function cycleContaining(
  date: BusinessDate,
  cycleMonths: number,
  anchor: BusinessDate = CYCLE_ANCHOR,
): Cycle {
  const months = monthIndex(date) - monthIndex(anchor);
  const k = Math.floor(months / cycleMonths);
  const start = addMonths(anchor, k * cycleMonths);
  return { start, end: addDays(addMonths(start, cycleMonths), -1) };
}

/** The cycle that follows one ending on `previousEnd`. */
export function nextCycle(previousEnd: BusinessDate, cycleMonths: number): Cycle {
  const start = addDays(previousEnd, 1);
  return { start, end: addDays(addMonths(start, cycleMonths), -1) };
}

// ───────────── Accrual (section 5.2.5) ─────────────

export interface MonthlyAccrualInput {
  entitlementPerCycle: DecimalInput;
  cycleMonths: number;
  /** Any date in the month to accrue. */
  month: BusinessDate;
  cycleStart: BusinessDate;
  cycleEnd: BusinessDate;
  dateEngaged: BusinessDate | null;
  terminationDate: BusinessDate | null;
}

export interface MonthlyAccrual {
  /** The first day of the month the employee was employed in the cycle (the ledger date). */
  effectiveDate: BusinessDate;
  units: Decimal;
  daysEmployed: number;
  daysInMonth: number;
}

/**
 * MONTHLY_PRO_RATA: `round4(entitlementPerCycle / cycleMonths)` a month (20 / 12 = 1.6667),
 * pro-rated by the calendar days employed (and inside the cycle) in the first and last month.
 * Null when the employee was not employed in the cycle that month.
 */
export function monthlyAccrual(input: MonthlyAccrualInput): MonthlyAccrual | null {
  const monthStart = startOfMonth(input.month);
  const monthEnd = endOfMonth(input.month);
  let from = maxDate(monthStart, input.cycleStart);
  if (input.dateEngaged) from = maxDate(from, input.dateEngaged);
  let to = minDate(monthEnd, input.cycleEnd);
  if (input.terminationDate) to = minDate(to, input.terminationDate);
  if (to < from) return null;
  const employed = daysBetween(from, to) + 1;
  const dim = daysInMonth(monthStart);
  const monthly = dec(input.entitlementPerCycle).div(input.cycleMonths);
  const units = employed === dim ? round4(monthly) : round4(monthly.times(employed).div(dim));
  return { effectiveDate: from, units, daysEmployed: employed, daysInMonth: dim };
}

/** The first day of every month from `from` to `to` (inclusive). */
export function monthsBetween(from: BusinessDate, to: BusinessDate): BusinessDate[] {
  const out: BusinessDate[] = [];
  for (let m = startOfMonth(from); m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

// ───────────── Cycle rollover (section 5.2.5) ─────────────

export interface RolloverAmounts {
  /** Balance minus the units still reserved by in-flight applications (they stay in the bucket). */
  unreserved: Decimal;
  /** Moved to the next cycle: positive into a Carry Forward bucket, negative (a debt) into the next cycle bucket. */
  carry: Decimal;
  /** Positive units above the carry-forward cap. */
  forfeit: Decimal;
}

/**
 * `min(balance, maxCarryForward)` carries forward and the excess is forfeited. Units reserved by
 * in-flight applications stay in the closed bucket so their TAKEN posting nets to zero. A null cap
 * carries everything; a negative balance moves to the next cycle as it is.
 */
export function rolloverAmounts(
  balance: DecimalInput,
  reserved: DecimalInput,
  maxCarryForward: DecimalInput | null,
): RolloverAmounts {
  const unreserved = round4(dec(balance).minus(dec(reserved)));
  if (unreserved.lte(0)) return { unreserved, carry: unreserved, forfeit: ZERO };
  const cap = maxCarryForward === null ? unreserved : Decimal.max(dec(maxCarryForward), ZERO);
  const carry = round4(Decimal.min(unreserved, cap));
  return { unreserved, carry, forfeit: round4(unreserved.minus(carry)) };
}

/** The last day carried-forward units may be used: `carryForwardExpiryMonths` after the new cycle starts. */
export function carryForwardExpiry(
  newCycleStart: BusinessDate,
  expiryMonths: number | null,
): BusinessDate | null {
  return expiryMonths === null ? null : addDays(addMonths(newCycleStart, expiryMonths), -1);
}

/** `date` clamped into [start, end]. */
export function clampDate(date: BusinessDate, start: BusinessDate, end: BusinessDate): BusinessDate {
  return minDate(maxDate(date, start), end);
}
