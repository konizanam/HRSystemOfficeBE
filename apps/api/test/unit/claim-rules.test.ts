import type { ClaimCap } from '@prisma/client';
import { Decimal } from '@peoplehub/shared';
import { describe, expect, it } from 'vitest';
import { claimCancelAction, parseWarnings } from '../../src/modules/claims/claim-mapper';
import {
  available,
  type CapUsage,
  cycleFor,
  cycleLengthMonths,
  effectiveLimit,
  evaluateCap,
  monthsEmployed,
  proRataFactor,
  proRataLimit,
} from '../../src/modules/claims/claim-rules';
import { capsForRule } from '../../src/modules/claims/claim-setup.service';

const d = (v: string | number) => new Decimal(v);
const usage = (pending: string, claimed: string, adjustment = '0'): CapUsage => ({
  pending: d(pending),
  claimed: d(claimed),
  adjustment: d(adjustment),
});

describe('cap cycles (section 5.3.1)', () => {
  const periods = [
    { id: 7, startDate: '2026-09-26', endDate: '2026-10-25' },
    { id: 8, startDate: '2026-10-26', endDate: '2026-11-25' },
  ];

  it('ANNUAL is the calendar year, boundaries included', () => {
    expect(cycleFor('ANNUAL', '2026-01-01')).toEqual({
      cycle: 'ANNUAL',
      start: '2026-01-01',
      end: '2026-12-31',
      payPeriodId: null,
    });
    expect(cycleFor('ANNUAL', '2026-12-31').start).toBe('2026-01-01');
    expect(cycleFor('ANNUAL', '2027-01-01').start).toBe('2027-01-01');
  });

  it('MONTHLY is the calendar month (leap February included)', () => {
    expect(cycleFor('MONTHLY', '2028-02-29')).toMatchObject({ start: '2028-02-01', end: '2028-02-29' });
    expect(cycleFor('MONTHLY', '2026-10-31')).toMatchObject({ start: '2026-10-01', end: '2026-10-31' });
    expect(cycleFor('MONTHLY', '2026-11-01').start).toBe('2026-11-01');
  });

  it('PAY_PERIOD is the pay period containing the date, else the calendar month', () => {
    expect(cycleFor('PAY_PERIOD', '2026-10-25', periods)).toMatchObject({
      start: '2026-09-26',
      end: '2026-10-25',
      payPeriodId: 7,
    });
    expect(cycleFor('PAY_PERIOD', '2026-10-26', periods)).toMatchObject({
      start: '2026-10-26',
      payPeriodId: 8,
    });
    expect(cycleFor('PAY_PERIOD', '2026-12-10', periods)).toMatchObject({
      start: '2026-12-01',
      end: '2026-12-31',
      payPeriodId: null,
    });
  });

  it('the pro-rata denominator is 12 months for ANNUAL and 1 otherwise', () => {
    expect(cycleLengthMonths('ANNUAL')).toBe(12);
    expect(cycleLengthMonths('MONTHLY')).toBe(1);
    expect(cycleLengthMonths('PAY_PERIOD')).toBe(1);
  });
});

describe('pro-rata caps: months employed in the cycle / cycle length', () => {
  const year = cycleFor('ANNUAL', '2026-06-15');

  it('a full year employed is 12 months, factor 1', () => {
    expect(monthsEmployed(year, '2020-03-01', null).toFixed(4)).toBe('12.0000');
    expect(proRataFactor(year, null, null).toFixed(4)).toBe('1.0000');
  });

  it('engaged on 1 July: 6 months, half the limit', () => {
    expect(monthsEmployed(year, '2026-07-01', null).toFixed(4)).toBe('6.0000');
    const factor = proRataFactor(year, '2026-07-01', null);
    expect(factor.toFixed(4)).toBe('0.5000');
    expect(proRataLimit(d(1200), factor, 'AMOUNT').toFixed(2)).toBe('600.00');
    expect(proRataLimit(d('10'), factor, 'QUANTITY').toFixed(4)).toBe('5.0000');
  });

  it('a partial month counts by its days employed', () => {
    // 16 of 31 days of July, then August to December.
    expect(monthsEmployed(year, '2026-07-16', null).toFixed(4)).toBe('5.5161');
    // Terminated on 31 March: January to March.
    expect(monthsEmployed(year, '2020-01-01', '2026-03-31').toFixed(4)).toBe('3.0000');
    expect(proRataLimit(d(1000), proRataFactor(year, '2020-01-01', '2026-03-31'), 'AMOUNT').toFixed(2)).toBe(
      '250.00',
    );
  });

  it('monthly and pay period cycles count the share of their days', () => {
    const october = cycleFor('MONTHLY', '2026-10-10');
    expect(proRataFactor(october, '2026-10-17', null).toFixed(4)).toBe('0.4839');
    const period = { cycle: 'PAY_PERIOD' as const, start: '2026-09-26', end: '2026-10-25' };
    expect(proRataFactor(period, '2026-10-11', null).toFixed(4)).toBe('0.5000');
  });

  it('is 0 outside employment and never above 1', () => {
    expect(proRataFactor(year, '2027-02-01', null).toFixed(4)).toBe('0.0000');
    expect(proRataFactor(year, null, '2025-12-31').toFixed(4)).toBe('0.0000');
  });

  it('only a pro-rata cap is scaled; no limit stays no limit', () => {
    expect(effectiveLimit(d(1200), false, d('0.5'), 'AMOUNT')?.toFixed(2)).toBe('1200.00');
    expect(effectiveLimit(d(1200), true, d('0.5'), 'AMOUNT')?.toFixed(2)).toBe('600.00');
    expect(effectiveLimit(null, true, d('0.5'), 'AMOUNT')).toBeNull();
  });
});

describe('cap modes NO_CAP, WARN and BLOCK', () => {
  it('available = limit − pending − claimed + adjustment', () => {
    expect(available(d(1000), usage('200', '300', '50')).toFixed(2)).toBe('550.00');
    expect(available(d(1000), usage('0', '1100', '0')).toFixed(2)).toBe('-100.00');
  });

  it('NO_CAP never stops a claim, even over the limit', () => {
    expect(
      evaluateCap({ mode: 'NO_CAP', limit: d(100), usage: usage('0', '0'), requested: d(500) }),
    ).toMatchObject({
      outcome: 'OK',
      exceeded: true,
    });
  });

  it('WARN lets an exceeding claim through with a warning', () => {
    const r = evaluateCap({
      mode: 'WARN',
      limit: d(1000),
      usage: usage('400', '400'),
      requested: d('200.01'),
    });
    expect(r.outcome).toBe('WARN');
    expect(r.available?.toFixed(2)).toBe('200.00');
  });

  it('BLOCK refuses an exceeding claim; exactly the available amount is allowed', () => {
    expect(
      evaluateCap({ mode: 'BLOCK', limit: d(1000), usage: usage('400', '400'), requested: d('200.01') })
        .outcome,
    ).toBe('BLOCK');
    expect(
      evaluateCap({ mode: 'BLOCK', limit: d(1000), usage: usage('400', '400'), requested: d('200.00') })
        .outcome,
    ).toBe('OK');
  });

  it('an adjustment adds headroom', () => {
    expect(
      evaluateCap({ mode: 'BLOCK', limit: d(1000), usage: usage('400', '400', '100'), requested: d(300) })
        .outcome,
    ).toBe('OK');
  });

  it('no limit, or nothing requested, is never exceeded', () => {
    expect(evaluateCap({ mode: 'BLOCK', limit: null, usage: usage('0', '0'), requested: d(1e6) })).toEqual({
      outcome: 'OK',
      available: null,
      exceeded: false,
    });
    expect(
      evaluateCap({ mode: 'BLOCK', limit: d(10), usage: usage('0', '20'), requested: d(0) }).outcome,
    ).toBe('OK');
  });
});

describe('caps that apply to a company rule (ASSUMPTION)', () => {
  const cap = (id: number, companyRuleId: number | null, extra: Partial<ClaimCap> = {}): ClaimCap =>
    ({
      id,
      claimTypeId: 1,
      companyRuleId,
      cycle: 'ANNUAL',
      mode: 'NO_CAP',
      amountLimit: null,
      quantityLimit: null,
      proRata: false,
      isActive: true,
      version: 1,
      ...extra,
    }) as ClaimCap;

  it("the rule's own caps win over the global ones", () => {
    expect(capsForRule([cap(1, null), cap(2, 7)], 7).map((c) => c.id)).toEqual([2]);
    expect(capsForRule([cap(1, null), cap(2, 7)], 8).map((c) => c.id)).toEqual([1]);
  });

  it('inactive caps are ignored; no cap means the type does not apply', () => {
    expect(capsForRule([cap(1, null, { isActive: false })], 7)).toEqual([]);
    expect(capsForRule([cap(2, 7, { isActive: false }), cap(1, null)], 7).map((c) => c.id)).toEqual([1]);
  });
});

describe('claim cancel action (ASSUMPTION)', () => {
  const base = { actioned: false, canAct: true, isAdmin: false };

  it('discards a draft and withdraws an untouched or sent-back request', () => {
    expect(claimCancelAction({ ...base, status: 'DRAFT' })).toBe('DISCARD');
    expect(claimCancelAction({ ...base, status: 'IN_PROGRESS' })).toBe('WITHDRAW');
    expect(claimCancelAction({ ...base, status: 'RESUBMIT_REQUIRED', actioned: true })).toBe('WITHDRAW');
  });

  it('once approval has started only HR or Payroll can cancel', () => {
    expect(claimCancelAction({ ...base, status: 'IN_PROGRESS', actioned: true })).toBeNull();
    expect(claimCancelAction({ ...base, status: 'IN_PROGRESS', actioned: true, isAdmin: true })).toBe(
      'CANCEL',
    );
    expect(claimCancelAction({ ...base, status: 'APPROVED_PENDING_PROCESS' })).toBeNull();
    expect(claimCancelAction({ ...base, status: 'APPROVED_PENDING_PROCESS', isAdmin: true })).toBe('CANCEL');
    expect(claimCancelAction({ ...base, status: 'RESUBMIT_REQUIRED', canAct: false, isAdmin: true })).toBe(
      'CANCEL',
    );
  });

  it('final claims cannot be cancelled', () => {
    for (const status of ['PROCESSED', 'DECLINED', 'CANCELLED'] as const) {
      expect(claimCancelAction({ ...base, status, isAdmin: true })).toBeNull();
    }
    expect(claimCancelAction({ ...base, status: 'DRAFT', canAct: false })).toBeNull();
  });
});

describe('stored cap warnings', () => {
  it('keeps the warnings that parse and drops anything else', () => {
    const warning = {
      code: 'CAP_EXCEEDED',
      mode: 'WARN',
      capId: 1,
      claimTypeId: 2,
      claimType: 'Overtime 1.5',
      cycle: 'ANNUAL',
      cycleStartDate: '2026-01-01',
      cycleEndDate: '2026-12-31',
      measure: 'AMOUNT',
      limit: '100.00',
      available: '50.00',
      requested: '80.00',
      message: 'Over',
    };
    expect(parseWarnings([warning, { code: 'OTHER' }, 'x'])).toEqual([warning]);
    expect(parseWarnings(null)).toEqual([]);
    expect(parseWarnings({ a: 1 })).toEqual([]);
  });
});
