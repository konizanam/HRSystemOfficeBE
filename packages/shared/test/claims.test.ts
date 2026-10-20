import { describe, expect, it } from 'vitest';
import {
  CLAIM_BALANCE_COLUMNS,
  CLAIM_STATUS_FILTERS,
  CLAIM_STATUS_LABELS,
  ClaimAdjustmentRequestSchema,
  ClaimLineInputSchema,
  ClaimsQuerySchema,
  claimStatusesFor,
  claimStatusFilterOf,
  claimTotal,
  computeClaimLineAmount,
  CreateClaimCapRequestSchema,
  CreateClaimRequestSchema,
  formatClaimReference,
  hoursBetween,
  Money2Schema,
  PROCESS_STATUSES,
  Quantity4Schema,
  resolveClaimRate,
  sequenceKeys,
  UpdateClaimRequestSchema,
} from '../src';

describe('claim line amounts per input mode (section 5.3.1)', () => {
  it('HOURS = hours × rate, rounded half up to 2 dp', () => {
    const r = computeClaimLineAmount({ inputMode: 'HOURS', quantity: '3.5', rate: '127.5' });
    expect(r.quantity?.toFixed(4)).toBe('3.5000');
    expect(r.rate?.toFixed(4)).toBe('127.5000');
    expect(r.amount.toFixed(2)).toBe('446.25');
    expect(r.problems).toEqual([]);
    expect(
      computeClaimLineAmount({ inputMode: 'HOURS', quantity: '1', rate: '0.005' }).amount.toFixed(2),
    ).toBe('0.01');
  });

  it('HOURS take the hours from the start and end time when both are given', () => {
    const r = computeClaimLineAmount({
      inputMode: 'HOURS',
      quantity: '99',
      rate: '100',
      startTime: '17:00',
      endTime: '19:30',
    });
    expect(r.quantity?.toFixed(4)).toBe('2.5000');
    expect(r.amount.toFixed(2)).toBe('250.00');
  });

  it('times that cross midnight count to the next day; 20 minutes is 0.3333 hours', () => {
    expect(hoursBetween('22:00', '02:00').toFixed(4)).toBe('4.0000');
    expect(hoursBetween('08:00', '08:20').toFixed(4)).toBe('0.3333');
    expect(hoursBetween('08:00', '08:00').toFixed(4)).toBe('24.0000');
    expect(() => hoursBetween('25:00', '01:00')).toThrow(RangeError);
  });

  it('KILOMETRES = km × rate per km and QUANTITY = quantity × rate', () => {
    expect(
      computeClaimLineAmount({ inputMode: 'KILOMETRES', quantity: '123.4', rate: '4.5' }).amount.toFixed(2),
    ).toBe('555.30');
    expect(
      computeClaimLineAmount({ inputMode: 'QUANTITY', quantity: '3', rate: '150' }).amount.toFixed(2),
    ).toBe('450.00');
  });

  it('AMOUNT is taken as entered and has no quantity or rate', () => {
    const r = computeClaimLineAmount({ inputMode: 'AMOUNT', amount: '812.40', quantity: '5', rate: '9' });
    expect(r).toMatchObject({ quantity: null, rate: null, problems: [] });
    expect(r.amount.toFixed(2)).toBe('812.40');
  });

  it('reports what is missing and computes 0 for an incomplete line', () => {
    expect(computeClaimLineAmount({ inputMode: 'HOURS', rate: '100' })).toMatchObject({
      problems: ['QUANTITY_REQUIRED'],
    });
    const noRate = computeClaimLineAmount({ inputMode: 'QUANTITY', quantity: '2', rate: null });
    expect(noRate.problems).toEqual(['RATE_MISSING']);
    expect(noRate.amount.toFixed(2)).toBe('0.00');
    expect(computeClaimLineAmount({ inputMode: 'KILOMETRES', quantity: '0', rate: '4' }).problems).toEqual([
      'QUANTITY_REQUIRED',
    ]);
    expect(computeClaimLineAmount({ inputMode: 'AMOUNT', amount: '' }).problems).toEqual(['AMOUNT_REQUIRED']);
    expect(computeClaimLineAmount({ inputMode: 'AMOUNT', amount: '0' }).amount.toFixed(2)).toBe('0.00');
  });

  it('the total is the sum of the line amounts', () => {
    expect(claimTotal(['446.25', '250.00', '0.01']).toFixed(2)).toBe('696.26');
    expect(claimTotal([]).toFixed(2)).toBe('0.00');
  });
});

describe('claim rates (section 5.3.1, ASSUMPTION A8)', () => {
  it('uses ClaimType.rate when it is set', () => {
    expect(
      resolveClaimRate({ inputMode: 'HOURS', rate: '200', rateMultiplier: '1.5', hourlyRate: '85' }),
    ).toMatchObject({ source: 'TYPE' });
    expect(
      resolveClaimRate({
        inputMode: 'KILOMETRES',
        rate: '4.5',
        rateMultiplier: null,
        hourlyRate: null,
      })?.rate.toFixed(4),
    ).toBe('4.5000');
  });

  it('HOURS without a type rate use Employee.hourlyRate × rateMultiplier', () => {
    const r = resolveClaimRate({ inputMode: 'HOURS', rate: null, rateMultiplier: '1.5', hourlyRate: '85' });
    expect(r?.rate.toFixed(4)).toBe('127.5000');
    expect(r?.source).toBe('EMPLOYEE_HOURLY_RATE');
    expect(
      resolveClaimRate({
        inputMode: 'HOURS',
        rate: null,
        rateMultiplier: null,
        hourlyRate: '85',
      })?.rate.toFixed(4),
    ).toBe('85.0000');
  });

  it('has no rate for AMOUNT, or without a type rate or hourly rate', () => {
    expect(
      resolveClaimRate({ inputMode: 'AMOUNT', rate: '5', rateMultiplier: null, hourlyRate: '85' }),
    ).toBeNull();
    expect(
      resolveClaimRate({ inputMode: 'HOURS', rate: null, rateMultiplier: '2', hourlyRate: null }),
    ).toBeNull();
    expect(
      resolveClaimRate({ inputMode: 'QUANTITY', rate: null, rateMultiplier: null, hourlyRate: '85' }),
    ).toBeNull();
  });
});

describe('claim reference numbers (section 8.2)', () => {
  it('formats C{entityCode}-G{groupId:4}-N{seq:5}', () => {
    expect(formatClaimReference('000077', 1, 5)).toBe('C000077-G0001-N00005');
    expect(formatClaimReference('E77', 12, 12345)).toBe('C000077-G0012-N12345');
    expect(sequenceKeys.claim(7, 2)).toBe('CLAIM:7:2');
  });
});

describe('claim status labels and filter buckets (section 5.3.2)', () => {
  it('maps every status to its label and bucket', () => {
    expect(CLAIM_STATUS_LABELS.DRAFT).toBe('Saved');
    expect(CLAIM_STATUS_LABELS.APPROVED_PENDING_PROCESS).toBe('Pending Processing');
    expect(claimStatusFilterOf('DRAFT')).toBe('Saved');
    expect(claimStatusFilterOf('RESUBMIT_REQUIRED')).toBe('In Progress');
    expect(claimStatusFilterOf('APPROVED_PENDING_PROCESS')).toBe('Pending Processing');
    expect(claimStatusFilterOf('PROCESSED')).toBe('Processed');
    expect(claimStatusFilterOf('DECLINED')).toBe('Cancelled / Declined');
    expect(claimStatusFilterOf('CANCELLED')).toBe('Cancelled / Declined');
    expect(claimStatusFilterOf('CONFLICT')).toBeNull();
    for (const s of PROCESS_STATUSES) expect(CLAIM_STATUS_LABELS[s]).toBeTruthy();
  });

  it('expands a filter to its statuses', () => {
    expect(claimStatusesFor('All')).toBeNull();
    expect(claimStatusesFor('Cancelled / Declined')).toEqual(['CANCELLED', 'DECLINED']);
    expect(CLAIM_STATUS_FILTERS).toHaveLength(6);
  });
});

describe('claim contracts', () => {
  it('money has at most 2 dp and quantities 4 dp, never negative', () => {
    expect(Money2Schema.safeParse('10.25').success).toBe(true);
    expect(Money2Schema.safeParse('10.255').success).toBe(false);
    expect(Money2Schema.safeParse('-1').success).toBe(false);
    expect(Quantity4Schema.safeParse('1.2345').success).toBe(true);
    expect(Quantity4Schema.safeParse('1.23456').success).toBe(false);
  });

  it('a line needs both times or neither', () => {
    const base = { claimTypeId: 1, date: '2026-10-01' };
    expect(ClaimLineInputSchema.safeParse({ ...base, startTime: '17:00', endTime: '19:00' }).success).toBe(
      true,
    );
    const half = ClaimLineInputSchema.safeParse({ ...base, startTime: '17:00' });
    expect(half.success).toBe(false);
    expect(half.error?.issues[0]?.path).toEqual(['endTime']);
    expect(ClaimLineInputSchema.safeParse({ ...base, startTime: '7pm', endTime: '9pm' }).success).toBe(false);
  });

  it('defaults a draft to no lines and refuses a line listed twice', () => {
    expect(CreateClaimRequestSchema.parse({ groupId: 1 })).toMatchObject({ lines: [], attachmentIds: [] });
    const line = { id: 3, claimTypeId: 1, date: '2026-10-01' };
    expect(UpdateClaimRequestSchema.safeParse({ version: 1, lines: [line, line] }).success).toBe(false);
  });

  it('list filters default to All and refuse an inverted range', () => {
    expect(ClaimsQuerySchema.parse({})).toMatchObject({ status: 'All', scope: 'self', page: 1 });
    expect(ClaimsQuerySchema.safeParse({ status: 'Pending Processing' }).success).toBe(true);
    expect(ClaimsQuerySchema.safeParse({ status: 'pending' }).success).toBe(false);
    expect(ClaimsQuerySchema.safeParse({ from: '2026-10-02', to: '2026-10-01' }).success).toBe(false);
  });

  it('an adjustment needs an amount or a quantity; caps default to NO_CAP', () => {
    const base = { employeeId: 1, claimTypeId: 1, reason: 'Correction' };
    expect(ClaimAdjustmentRequestSchema.safeParse(base).success).toBe(false);
    expect(ClaimAdjustmentRequestSchema.parse({ ...base, amount: '-25.50' })).toMatchObject({
      quantity: '0',
    });
    expect(CreateClaimCapRequestSchema.parse({ claimTypeId: 1, cycle: 'ANNUAL' })).toMatchObject({
      mode: 'NO_CAP',
      companyRuleId: null,
      proRata: false,
    });
  });

  it('lists the exact balances columns (section 5.3.3)', () => {
    expect(CLAIM_BALANCE_COLUMNS.map((c) => c.label)).toEqual([
      'Claim Type',
      'Cycle Start Date',
      'Cycle End Date',
      'Amount Capping Limit',
      'Pro Rata Capping Limit',
      'Pending Amount Claimed',
      'Amount Claimed',
      'Balance Adjustment Amount',
      'Amount Available',
      'Quantity Capping Limit',
      'Pending Quantity Claimed',
      'Quantity Claimed',
      'Balance Adjustment Quantity',
      'Quantity Available',
      'Capping Applied',
    ]);
  });
});
