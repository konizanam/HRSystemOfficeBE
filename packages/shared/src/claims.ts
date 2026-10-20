import { Decimal, dec, type DecimalInput, round2, round4 } from './decimal';
import {
  CLAIM_STATUS_FILTER_MAP,
  type ClaimInputMode,
  type ClaimStatusFilter,
  type ProcessStatus,
} from './enums';

// Claim arithmetic shared by the API (the source of truth, section 0.4) and the web app (the live
// total in the claim editor, section 5.3.1). Amounts are money (2 dp), quantities and rates 4 dp.

/** `HH:mm`, 24-hour clock. */
export const CLAIM_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Status labels on the claim screens (section 5.3.2 uses "Saved" and "Pending Processing"). */
export const CLAIM_STATUS_LABELS: Record<ProcessStatus, string> = {
  DRAFT: 'Saved',
  IN_PROGRESS: 'In Progress',
  RESUBMIT_REQUIRED: 'Resubmission Required',
  APPROVED_PENDING_PROCESS: 'Pending Processing',
  PROCESSED: 'Processed',
  DECLINED: 'Declined',
  CANCELLED: 'Cancelled',
  CONFLICT: 'Conflict',
};

/** The My Expense Claims status bucket a claim falls in, or null (CONFLICT never occurs for claims). */
export function claimStatusFilterOf(status: ProcessStatus): Exclude<ClaimStatusFilter, 'All'> | null {
  for (const [bucket, statuses] of Object.entries(CLAIM_STATUS_FILTER_MAP)) {
    if (statuses.includes(status)) return bucket as Exclude<ClaimStatusFilter, 'All'>;
  }
  return null;
}

/** The statuses of a status filter; `All` = every status. */
export function claimStatusesFor(filter: ClaimStatusFilter): ProcessStatus[] | null {
  return filter === 'All' ? null : CLAIM_STATUS_FILTER_MAP[filter];
}

/** What the quantity column means for each input mode (null: AMOUNT has no quantity). */
export const CLAIM_QUANTITY_LABELS: Record<ClaimInputMode, string | null> = {
  HOURS: 'Hours',
  KILOMETRES: 'Kilometres',
  QUANTITY: 'Quantity',
  AMOUNT: null,
};

export const CLAIM_INPUT_MODE_LABELS: Record<ClaimInputMode, string> = {
  HOURS: 'Hours × rate',
  KILOMETRES: 'Kilometres × rate per km',
  QUANTITY: 'Quantity × rate',
  AMOUNT: 'Amount as entered',
};

function minutesOf(time: string): number {
  if (!CLAIM_TIME_PATTERN.test(time)) throw new RangeError(`Invalid time: ${time}`);
  const [h = '0', m = '0'] = time.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Hours worked from a start and end time (section 5.3.1, overtime). An end at or before the start
 * crosses midnight (22:00 to 02:00 = 4 hours). Rounded to 4 dp.
 */
export function hoursBetween(startTime: string, endTime: string): Decimal {
  let minutes = minutesOf(endTime) - minutesOf(startTime);
  if (minutes <= 0) minutes += 24 * 60;
  return round4(new Decimal(minutes).div(60));
}

/** Where a claim type's effective rate comes from. */
export type ClaimRateSource = 'TYPE' | 'EMPLOYEE_HOURLY_RATE';

export interface ClaimRateInput {
  inputMode: ClaimInputMode;
  /** `ClaimType.rate`. */
  rate: DecimalInput | null;
  /** `ClaimType.rateMultiplier` (HOURS only), e.g. 1.5 for OT1_5. */
  rateMultiplier: DecimalInput | null;
  /** `Employee.hourlyRate`. */
  hourlyRate: DecimalInput | null;
}

/**
 * The rate a line is paid at (section 5.3.1): `ClaimType.rate` when set; for HOURS without a type
 * rate, `Employee.hourlyRate × rateMultiplier` (multiplier 1 when not set). AMOUNT has no rate.
 * Null when no rate can be found (the line cannot be submitted).
 */
export function resolveClaimRate(input: ClaimRateInput): { rate: Decimal; source: ClaimRateSource } | null {
  if (input.inputMode === 'AMOUNT') return null;
  if (input.rate !== null && input.rate !== undefined && input.rate !== '') {
    return { rate: round4(dec(input.rate)), source: 'TYPE' };
  }
  if (input.inputMode !== 'HOURS') return null;
  if (input.hourlyRate === null || input.hourlyRate === undefined || input.hourlyRate === '') return null;
  const multiplier =
    input.rateMultiplier === null || input.rateMultiplier === undefined || input.rateMultiplier === ''
      ? new Decimal(1)
      : dec(input.rateMultiplier);
  return { rate: round4(dec(input.hourlyRate).times(multiplier)), source: 'EMPLOYEE_HOURLY_RATE' };
}

export interface ClaimLineAmountInput {
  inputMode: ClaimInputMode;
  /** Hours, kilometres or a count; ignored for AMOUNT. */
  quantity?: DecimalInput | null;
  /** The entered amount; used only for AMOUNT. */
  amount?: DecimalInput | null;
  /** The effective rate (see {@link resolveClaimRate}); ignored for AMOUNT. */
  rate?: DecimalInput | null;
  /** HOURS: when both times are given, the hours come from them. */
  startTime?: string | null;
  endTime?: string | null;
}

/** Why a line is not complete enough to submit. */
export type ClaimLineProblem = 'QUANTITY_REQUIRED' | 'RATE_MISSING' | 'AMOUNT_REQUIRED';

export interface ClaimLineAmount {
  /** The quantity stored on the line (hours from the times for HOURS); null for AMOUNT. */
  quantity: Decimal | null;
  /** The rate stored on the line; null for AMOUNT or when no rate is known. */
  rate: Decimal | null;
  /** 2 dp; 0 when the line is incomplete. */
  amount: Decimal;
  problems: ClaimLineProblem[];
}

function present(value: DecimalInput | null | undefined): value is DecimalInput {
  return value !== null && value !== undefined && value !== '';
}

/**
 * The server-side line amount per input mode (section 5.3.1): HOURS = hours × rate (hours from
 * the start and end time when both are given), KILOMETRES = km × rate per km, QUANTITY =
 * quantity × rate, AMOUNT = as entered. Money is rounded half up to 2 dp.
 */
export function computeClaimLineAmount(input: ClaimLineAmountInput): ClaimLineAmount {
  const problems: ClaimLineProblem[] = [];
  if (input.inputMode === 'AMOUNT') {
    const amount = present(input.amount) ? round2(dec(input.amount)) : new Decimal(0);
    if (!amount.gt(0)) problems.push('AMOUNT_REQUIRED');
    return { quantity: null, rate: null, amount: amount.gt(0) ? amount : new Decimal(0), problems };
  }
  let quantity: Decimal | null = null;
  if (input.inputMode === 'HOURS' && input.startTime && input.endTime) {
    quantity = hoursBetween(input.startTime, input.endTime);
  } else if (present(input.quantity)) {
    quantity = round4(dec(input.quantity));
  }
  if (quantity === null || !quantity.gt(0)) problems.push('QUANTITY_REQUIRED');
  const rate = present(input.rate) ? round4(dec(input.rate)) : null;
  if (rate === null) problems.push('RATE_MISSING');
  const amount = quantity !== null && rate !== null && quantity.gt(0) ? round2(quantity.times(rate)) : null;
  return { quantity, rate, amount: amount ?? new Decimal(0), problems };
}

/** The claim total: the sum of its line amounts, 2 dp. */
export function claimTotal(amounts: Iterable<DecimalInput>): Decimal {
  let total = new Decimal(0);
  for (const a of amounts) total = total.plus(dec(a));
  return round2(total);
}
