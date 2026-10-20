import type { CapCycle, CapMode } from '@prisma/client';
import {
  addDays,
  type BusinessDate,
  type ClaimCapMeasure,
  Decimal,
  daysBetween,
  daysInMonth,
  endOfMonth,
  maxDate,
  minDate,
  round2,
  round4,
  startOfMonth,
} from '@peoplehub/shared';

// Pure claim cap rules (section 5.3.1 and 16.1): cap cycles, pro-rata limits and the NO_CAP /
// WARN / BLOCK decision. No database access; the services gather the facts.

/** A pay period of the employee's company rule, for PAY_PERIOD cycles. */
export interface PayPeriodWindow {
  id: number;
  startDate: BusinessDate;
  endDate: BusinessDate;
}

/** The cycle of a cap that contains a date. */
export interface CycleWindow {
  cycle: CapCycle;
  start: BusinessDate;
  end: BusinessDate;
  /** PAY_PERIOD cycles: the pay period, or null when the calendar month stood in for it. */
  payPeriodId: number | null;
}

/**
 * The cycle containing `date` (ASSUMPTION, see docs): ANNUAL = the calendar year, MONTHLY = the
 * calendar month, PAY_PERIOD = the pay period of the employee's company rule that contains the
 * date, or the calendar month when there is none.
 */
export function cycleFor(
  cycle: CapCycle,
  date: BusinessDate,
  payPeriods: readonly PayPeriodWindow[] = [],
): CycleWindow {
  switch (cycle) {
    case 'ANNUAL': {
      const year = date.slice(0, 4);
      return { cycle, start: `${year}-01-01`, end: `${year}-12-31`, payPeriodId: null };
    }
    case 'MONTHLY':
      return { cycle, start: startOfMonth(date), end: endOfMonth(date), payPeriodId: null };
    case 'PAY_PERIOD': {
      const period = payPeriods.find((p) => p.startDate <= date && p.endDate >= date);
      return period
        ? { cycle, start: period.startDate, end: period.endDate, payPeriodId: period.id }
        : { cycle, start: startOfMonth(date), end: endOfMonth(date), payPeriodId: null };
    }
  }
}

/** The cycle length in months used as the pro-rata denominator: 12 for ANNUAL, else 1. */
export function cycleLengthMonths(cycle: CapCycle): number {
  return cycle === 'ANNUAL' ? 12 : 1;
}

function overlapDays(
  start: BusinessDate,
  end: BusinessDate,
  engaged: BusinessDate | null,
  terminated: BusinessDate | null,
): number {
  const from = engaged ? maxDate(start, engaged) : start;
  const to = terminated ? minDate(end, terminated) : end;
  return to < from ? 0 : daysBetween(from, to) + 1;
}

/**
 * Months employed in the cycle (section 5.3.1). An ANNUAL cycle counts each calendar month by
 * the share of its days the employee is employed (engagement to termination); a MONTHLY or
 * PAY_PERIOD cycle is one month, counted by the share of its days employed. A cycle that is not
 * over yet counts the rest of it as employed unless a termination date is set.
 */
export function monthsEmployed(
  window: Pick<CycleWindow, 'cycle' | 'start' | 'end'>,
  engaged: BusinessDate | null,
  terminated: BusinessDate | null,
): Decimal {
  if (window.cycle !== 'ANNUAL') {
    const total = daysBetween(window.start, window.end) + 1;
    return new Decimal(overlapDays(window.start, window.end, engaged, terminated)).div(total);
  }
  let months = new Decimal(0);
  for (let month = startOfMonth(window.start); month <= window.end; month = addDays(endOfMonth(month), 1)) {
    const from = maxDate(month, window.start);
    const to = minDate(endOfMonth(month), window.end);
    months = months.plus(new Decimal(overlapDays(from, to, engaged, terminated)).div(daysInMonth(month)));
  }
  return months;
}

/** Months employed in the cycle divided by the cycle length, between 0 and 1. */
export function proRataFactor(
  window: Pick<CycleWindow, 'cycle' | 'start' | 'end'>,
  engaged: BusinessDate | null,
  terminated: BusinessDate | null,
): Decimal {
  const factor = monthsEmployed(window, engaged, terminated).div(cycleLengthMonths(window.cycle));
  return Decimal.min(Decimal.max(factor, 0), 1);
}

/** A limit scaled by the pro-rata factor: money to 2 dp, quantities to 4 dp. */
export function proRataLimit(limit: Decimal, factor: Decimal, measure: ClaimCapMeasure): Decimal {
  const scaled = limit.times(factor);
  return measure === 'AMOUNT' ? round2(scaled) : round4(scaled);
}

/** What has been used of a cap in one cycle. */
export interface CapUsage {
  /** Submitted and not yet processed (In Progress, Resubmission Required, Pending Processing). */
  pending: Decimal;
  /** Processed. */
  claimed: Decimal;
  /** Payroll balance adjustments; positive adds to what is available. */
  adjustment: Decimal;
}

/** Available = limit − pending − claimed + adjustment (section 5.3.3). */
export function available(limit: Decimal, usage: CapUsage): Decimal {
  return limit.minus(usage.pending).minus(usage.claimed).plus(usage.adjustment);
}

export type CapOutcome = 'OK' | 'WARN' | 'BLOCK';

export interface CapEvaluation {
  outcome: CapOutcome;
  /** Null when the cap has no limit for the measure. */
  available: Decimal | null;
  exceeded: boolean;
}

/**
 * The cap decision for one measure of one cycle (section 5.3.1): NO_CAP never stops a claim;
 * WARN lets it through with a warning; BLOCK refuses it (422). A cap without a limit for the
 * measure, or a claim that requests nothing of it, is never exceeded.
 */
export function evaluateCap(input: {
  mode: CapMode;
  /** The limit that applies (already pro-rated); null = no limit. */
  limit: Decimal | null;
  usage: CapUsage;
  requested: Decimal;
}): CapEvaluation {
  if (input.limit === null) return { outcome: 'OK', available: null, exceeded: false };
  const left = available(input.limit, input.usage);
  const exceeded = input.requested.gt(0) && input.requested.gt(left);
  if (!exceeded || input.mode === 'NO_CAP') return { outcome: 'OK', available: left, exceeded };
  return { outcome: input.mode, available: left, exceeded };
}

/** The limit that applies to a cap in a cycle: pro-rated when the cap says so. */
export function effectiveLimit(
  limit: Decimal | null,
  proRata: boolean,
  factor: Decimal,
  measure: ClaimCapMeasure,
): Decimal | null {
  if (limit === null) return null;
  return proRata ? proRataLimit(limit, factor, measure) : limit;
}
