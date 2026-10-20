import {
  type BusinessDate,
  Decimal,
  dec,
  formatLeaveReference,
  holidayObservedDate,
  holidayRuleDate,
  LEAVE_PROBLEM_TYPES,
  LEAVE_REFERENCE_PATTERN,
  NAMIBIAN_HOLIDAY_RULES,
  sequenceKeys,
} from '@peoplehub/shared';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/common/errors/domain-errors';
import {
  actualAvailable,
  allocateUnits,
  availableFor,
  type BucketBalance,
  calculateUnits,
  carryForwardExpiry,
  clampDate,
  cycleContaining,
  monthlyAccrual,
  monthsBetween,
  nextCycle,
  overlappingDates,
  periodFigures,
  portionsClash,
  rolloverAmounts,
  type UnitCalculationInput,
} from '../../src/modules/leave/leave-rules';

/** The Namibian holidays of the given years by observed date, as HolidayService builds them. */
function namibianHolidays(...years: number[]): Map<BusinessDate, string> {
  const map = new Map<BusinessDate, string>();
  for (const year of years) {
    for (const rule of NAMIBIAN_HOLIDAY_RULES) {
      const date = holidayRuleDate(rule, year);
      if (!date) continue;
      map.set(date, rule.name);
      map.set(holidayObservedDate(date), rule.name);
    }
  }
  return map;
}

function input(partial: Partial<UnitCalculationInput>): UnitCalculationInput {
  return {
    fromDate: '2026-09-21',
    toDate: '2026-09-25',
    startPortion: 'FULL',
    endPortion: 'FULL',
    excludeWeekends: true,
    excludePublicHolidays: true,
    allowHalfDay: true,
    holidays: namibianHolidays(2026, 2027),
    ...partial,
  };
}

function units(partial: Partial<UnitCalculationInput>): string {
  return calculateUnits(input(partial)).units.toFixed(4);
}

function expectProblem(fn: () => unknown, status: number, type?: string): DomainError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    const e = err as DomainError;
    expect(e.getStatus()).toBe(status);
    if (type) expect(e.type).toBe(type);
    return e;
  }
  throw new Error('Expected an error');
}

describe('calculateUnits (section 5.2.1)', () => {
  it('counts working days and skips weekends', () => {
    // Mon 21 Sep – Sun 27 Sep 2026.
    const calc = calculateUnits(input({ fromDate: '2026-09-21', toDate: '2026-09-27' }));
    expect(calc.units.toFixed(4)).toBe('5.0000');
    expect(calc.days.map((d) => d.date)).toEqual([
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
    ]);
    expect(calc.days.every((d) => d.portion === 'FULL' && d.units.eq(1))).toBe(true);
    expect(calc.excluded).toEqual([
      { date: '2026-09-26', reason: 'WEEKEND', name: null },
      { date: '2026-09-27', reason: 'WEEKEND', name: null },
    ]);
    // Counted when the type includes weekends.
    expect(units({ fromDate: '2026-09-21', toDate: '2026-09-27', excludeWeekends: false })).toBe('7.0000');
  });

  it('skips the company public holidays', () => {
    // Easter 2026: Good Friday 3 Apr and Easter Monday 6 Apr.
    const calc = calculateUnits(input({ fromDate: '2026-03-30', toDate: '2026-04-10' }));
    expect(calc.units.toFixed(4)).toBe('8.0000');
    expect(calc.excluded.filter((e) => e.reason === 'PUBLIC_HOLIDAY')).toEqual([
      { date: '2026-04-03', reason: 'PUBLIC_HOLIDAY', name: 'Good Friday' },
      { date: '2026-04-06', reason: 'PUBLIC_HOLIDAY', name: 'Easter Monday' },
    ]);
    // Counted when the type does not exclude holidays.
    expect(units({ fromDate: '2026-03-30', toDate: '2026-04-10', excludePublicHolidays: false })).toBe(
      '10.0000',
    );
  });

  it('skips the Monday a Sunday holiday is observed on', () => {
    // Family Day 26 Dec 2027 is a Sunday, observed on Monday 27 Dec 2027.
    expect(holidayObservedDate('2027-12-26')).toBe('2027-12-27');
    const calc = calculateUnits(input({ fromDate: '2027-12-27', toDate: '2027-12-31' }));
    expect(calc.units.toFixed(4)).toBe('4.0000');
    expect(calc.excluded).toEqual([{ date: '2027-12-27', reason: 'PUBLIC_HOLIDAY', name: 'Family Day' }]);
    // Independence Day 21 Mar 2027 (Sunday) is observed on Monday 22 Mar.
    expect(units({ fromDate: '2027-03-22', toDate: '2027-03-25' })).toBe('3.0000');
  });

  it('counts half days for AM/PM start and end portions', () => {
    const base = { fromDate: '2026-09-21', toDate: '2026-09-25' };
    expect(units({ ...base, startPortion: 'PM' })).toBe('4.5000');
    expect(units({ ...base, endPortion: 'AM' })).toBe('4.5000');
    const both = calculateUnits(input({ ...base, startPortion: 'PM', endPortion: 'AM' }));
    expect(both.units.toFixed(4)).toBe('4.0000');
    expect(both.days[0]).toMatchObject({ date: '2026-09-21', portion: 'PM' });
    expect(both.days[4]).toMatchObject({ date: '2026-09-25', portion: 'AM' });
    expect(both.days[0]?.units.toFixed(4)).toBe('0.5000');
  });

  it('uses the start portion for a single day', () => {
    expect(units({ fromDate: '2026-09-24', toDate: '2026-09-24', startPortion: 'AM' })).toBe('0.5000');
    expect(
      units({ fromDate: '2026-09-24', toDate: '2026-09-24', startPortion: 'PM', endPortion: 'FULL' }),
    ).toBe('0.5000');
    expect(
      units({ fromDate: '2026-09-24', toDate: '2026-09-24', startPortion: 'FULL', endPortion: 'AM' }),
    ).toBe('1.0000');
    const single = calculateUnits(
      input({ fromDate: '2026-09-24', toDate: '2026-09-24', startPortion: 'AM' }),
    );
    expect(single.days).toHaveLength(1);
    expect(single.days[0]?.portion).toBe('AM');
  });

  it('crosses months and years', () => {
    // Wed 28 Oct – Tue 3 Nov 2026.
    expect(units({ fromDate: '2026-10-28', toDate: '2026-11-03' })).toBe('5.0000');
    // Mon 21 Dec 2026 – Fri 8 Jan 2027: Christmas Day (Fri), Family Day (Sat) and New Year's Day (Fri).
    const calc = calculateUnits(input({ fromDate: '2026-12-21', toDate: '2027-01-08' }));
    expect(calc.units.toFixed(4)).toBe('13.0000');
    expect(calc.excluded.filter((e) => e.reason === 'PUBLIC_HOLIDAY').map((e) => e.date)).toEqual([
      '2026-12-25',
      '2027-01-01',
    ]);
  });

  it('rejects a range of only weekends and holidays with 422', () => {
    expectProblem(
      () => calculateUnits(input({ fromDate: '2026-04-03', toDate: '2026-04-06' })),
      422,
      LEAVE_PROBLEM_TYPES.noWorkingDays,
    );
    expectProblem(() => calculateUnits(input({ fromDate: '2026-09-26', toDate: '2026-09-27' })), 422);
  });

  it('validates the range and half days', () => {
    expectProblem(() => calculateUnits(input({ fromDate: '2026-09-25', toDate: '2026-09-21' })), 422);
    expectProblem(() => calculateUnits(input({ fromDate: '2026-01-01', toDate: '2027-01-02' })), 422);
    const e = expectProblem(
      () => calculateUnits(input({ allowHalfDay: false, startPortion: 'AM', endPortion: 'PM' })),
      422,
    );
    expect(e.errors?.map((x) => x.path)).toEqual(['startPortion', 'endPortion']);
    expect(units({ allowHalfDay: false })).toBe('5.0000');
  });
});

describe('overlap at half-day granularity', () => {
  it('lets a morning and an afternoon share a day', () => {
    expect(portionsClash('AM', 'PM')).toBe(false);
    expect(portionsClash('AM', 'AM')).toBe(true);
    expect(portionsClash('FULL', 'PM')).toBe(true);
    expect(
      overlappingDates(
        [
          { date: '2026-09-24', portion: 'PM' },
          { date: '2026-09-25', portion: 'FULL' },
        ],
        [
          { date: '2026-09-24', portion: 'AM' },
          { date: '2026-09-25', portion: 'AM' },
        ],
      ),
    ).toEqual(['2026-09-25']);
    expect(overlappingDates([{ date: '2026-09-24', portion: 'FULL' }], [])).toEqual([]);
  });
});

function bucket(
  id: number,
  cycleEndDate: BusinessDate,
  balance: string,
  reserved = '0',
  expiresOn: BusinessDate | null = null,
): BucketBalance {
  return { id, cycleEndDate, expiresOn, balance: dec(balance), reserved: dec(reserved) };
}

describe('balance maths (section 1.7 fixtures)', () => {
  it('BF 2.1691 + accrued 1.6667 − taken 0 = CF 3.8358', () => {
    const carry = periodFigures(
      [{ entryType: 'CARRY_FORWARD_IN', units: dec('0.5024'), effectiveDate: '2026-09-01' }],
      '2026-10-01',
    );
    const annual = periodFigures(
      [
        { entryType: 'ACCRUAL', units: dec('1.6667'), effectiveDate: '2026-09-01' },
        { entryType: 'ACCRUAL', units: dec('1.6667'), effectiveDate: '2026-10-01' },
      ],
      '2026-10-01',
    );
    const bf = carry.broughtForward.plus(annual.broughtForward);
    const accrued = carry.accrued.plus(annual.accrued);
    const taken = carry.taken.plus(annual.taken);
    expect(bf.toFixed(4)).toBe('2.1691');
    expect(accrued.toFixed(4)).toBe('1.6667');
    expect(taken.toFixed(4)).toBe('0.0000');
    expect(carry.carriedForward.plus(annual.carriedForward).toFixed(4)).toBe('3.8358');
    expect(actualAvailable(carry.carriedForward.plus(annual.carriedForward), 0).toFixed(4)).toBe('3.8358');
  });

  it('CF = BF + accrued − taken + adjustments', () => {
    const f = periodFigures(
      [
        { entryType: 'OPENING', units: dec(5), effectiveDate: '2026-01-01' },
        { entryType: 'ACCRUAL', units: dec('1.6667'), effectiveDate: '2026-10-01' },
        { entryType: 'TAKEN', units: dec(-2), effectiveDate: '2026-10-15' },
        { entryType: 'ADJUSTMENT', units: dec('0.5'), effectiveDate: '2026-10-20' },
        { entryType: 'CANCELLATION_REVERSAL', units: dec(1), effectiveDate: '2026-10-21' },
      ],
      '2026-10-01',
    );
    expect(f.broughtForward.toFixed(4)).toBe('5.0000');
    expect(f.accrued.toFixed(4)).toBe('1.6667');
    expect(f.taken.toFixed(4)).toBe('2.0000');
    expect(f.adjustments.toFixed(4)).toBe('1.5000');
    expect(f.carriedForward.toFixed(4)).toBe('6.1667');
  });

  it('study: entitlement 12 − pending 9 = actual available 3; the 5-day request saw 8', () => {
    expect(actualAvailable(12, 9).toFixed(4)).toBe('3.0000');
    // When the 5-day request was submitted, 4 days were already pending.
    const study = [bucket(1, '2026-12-31', '12', '4')];
    expect(availableFor(study, '2026-11-30').toFixed(4)).toBe('8.0000');
    expect(availableFor([bucket(1, '2026-12-31', '12', '9')], '2026-11-30').toFixed(4)).toBe('3.0000');
  });
});

describe('bucket allocation (earliest cycle end first)', () => {
  const carry = bucket(10, '2027-02-28', '0.5024', '0', '2027-02-28');
  const annual = bucket(11, '2027-08-31', '3.3334');

  it('uses Carry Forward before the current Annual bucket', () => {
    expect(allocateUnits('2', [annual, carry], '2026-11-02')).toEqual([
      { entitlementId: 10, units: new Decimal('0.5024') },
      { entitlementId: 11, units: new Decimal('1.4976') },
    ]);
    expect(allocateUnits('0.5', [annual, carry], '2026-11-02')).toEqual([
      { entitlementId: 10, units: new Decimal('0.5') },
    ]);
  });

  it('leaves out expired buckets and reserved units', () => {
    expect(allocateUnits('1', [annual, carry], '2027-03-01')).toEqual([
      { entitlementId: 11, units: new Decimal(1) },
    ]);
    const reserved = bucket(10, '2027-02-28', '0.5024', '0.5024', '2027-02-28');
    expect(allocateUnits('1', [annual, reserved], '2026-11-02')).toEqual([
      { entitlementId: 11, units: new Decimal(1) },
    ]);
    expect(availableFor([annual, carry], '2027-03-01').toFixed(4)).toBe('3.3334');
  });

  it('puts a negative remainder on the bucket with the latest cycle end', () => {
    expect(allocateUnits('5', [annual, carry], '2026-11-02')).toEqual([
      { entitlementId: 10, units: new Decimal('0.5024') },
      { entitlementId: 11, units: new Decimal('4.4976') },
    ]);
    expect(allocateUnits('1', [], '2026-11-02')).toEqual([]);
  });
});

describe('accrual (section 5.2.5)', () => {
  const base = {
    entitlementPerCycle: '20',
    cycleMonths: 12,
    cycleStart: '2026-01-01',
    cycleEnd: '2026-12-31',
    dateEngaged: '2020-03-01',
    terminationDate: null,
  };

  it('posts round4(20 / 12) = 1.6667 for a full month on the 1st', () => {
    expect(monthlyAccrual({ ...base, month: '2026-10-01' })).toEqual({
      effectiveDate: '2026-10-01',
      units: new Decimal('1.6667'),
      daysEmployed: 31,
      daysInMonth: 31,
    });
  });

  it('pro-rates the first and last month by calendar days employed', () => {
    // Engaged 16 Oct: 16 of 31 days → 20/12 × 16/31 = 0.86021… → 0.8602.
    const first = monthlyAccrual({ ...base, month: '2026-10-01', dateEngaged: '2026-10-16' });
    expect(first).toMatchObject({ effectiveDate: '2026-10-16', daysEmployed: 16, daysInMonth: 31 });
    expect(first?.units.toFixed(4)).toBe('0.8602');
    // Terminated 10 Feb: 10 of 28 days → 0.59524… → 0.5952.
    const last = monthlyAccrual({ ...base, month: '2026-02-01', terminationDate: '2026-02-10' });
    expect(last).toMatchObject({ effectiveDate: '2026-02-01', daysEmployed: 10, daysInMonth: 28 });
    expect(last?.units.toFixed(4)).toBe('0.5952');
    expect(monthlyAccrual({ ...base, month: '2026-03-01', terminationDate: '2026-02-10' })).toBeNull();
    expect(monthlyAccrual({ ...base, month: '2025-12-01' })).toBeNull();
  });

  it('is deterministic per month, so a re-run finds the same ledger date', () => {
    const a = monthlyAccrual({ ...base, month: '2026-10-20' });
    const b = monthlyAccrual({ ...base, month: '2026-10-01' });
    expect(a).toEqual(b);
    expect(monthsBetween('2026-01-15', '2026-04-01')).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
    ]);
  });
});

describe('cycle rollover (section 5.2.5)', () => {
  it('carries min(balance, maxCarryForward) and forfeits the excess', () => {
    expect(rolloverAmounts('7.5', '0', '5')).toEqual({
      unreserved: new Decimal('7.5'),
      carry: new Decimal(5),
      forfeit: new Decimal('2.5'),
    });
    expect(rolloverAmounts('3', '0', '5')).toEqual({
      unreserved: new Decimal(3),
      carry: new Decimal(3),
      forfeit: new Decimal(0),
    });
    expect(rolloverAmounts('3', '0', '0')).toEqual({
      unreserved: new Decimal(3),
      carry: new Decimal(0),
      forfeit: new Decimal(3),
    });
    expect(rolloverAmounts('3', '0', null)).toEqual({
      unreserved: new Decimal(3),
      carry: new Decimal(3),
      forfeit: new Decimal(0),
    });
  });

  it('keeps reserved units behind and carries a negative balance', () => {
    expect(rolloverAmounts('7.5', '2', '5')).toEqual({
      unreserved: new Decimal('5.5'),
      carry: new Decimal(5),
      forfeit: new Decimal('0.5'),
    });
    expect(rolloverAmounts('-2', '0', '5')).toEqual({
      unreserved: new Decimal(-2),
      carry: new Decimal(-2),
      forfeit: new Decimal(0),
    });
  });

  it('sets the carry-forward expiry and the next cycle', () => {
    expect(carryForwardExpiry('2027-01-01', 6)).toBe('2027-06-30');
    expect(carryForwardExpiry('2027-01-01', null)).toBeNull();
    expect(nextCycle('2026-12-31', 12)).toEqual({ start: '2027-01-01', end: '2027-12-31' });
    expect(nextCycle('2026-08-31', 36)).toEqual({ start: '2026-09-01', end: '2029-08-31' });
  });

  it('anchors cycles on the calendar', () => {
    expect(cycleContaining('2026-10-20', 12)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(cycleContaining('2026-10-20', 36)).toEqual({ start: '2024-01-01', end: '2026-12-31' });
    expect(cycleContaining('2027-01-01', 36)).toEqual({ start: '2027-01-01', end: '2029-12-31' });
    expect(cycleContaining('2023-06-01', 12)).toEqual({ start: '2023-01-01', end: '2023-12-31' });
    expect(clampDate('2026-11-20', '2026-10-01', '2026-10-31')).toBe('2026-10-31');
    expect(clampDate('2026-09-20', '2026-10-01', '2026-10-31')).toBe('2026-10-01');
  });
});

describe('reference numbers (section 8.1)', () => {
  it('formats E{entity:6}-T{type:4}-N{seq:5}', () => {
    expect(formatLeaveReference('000077', 6, 5)).toBe('E000077-T0006-N00005');
    expect(formatLeaveReference('77', 1, 12345)).toBe('E000077-T0001-N12345');
    expect(LEAVE_REFERENCE_PATTERN.test(formatLeaveReference('500123', 13, 1))).toBe(true);
    expect(sequenceKeys.leave(7, 6)).toBe('LEAVE:7:6');
  });
});
