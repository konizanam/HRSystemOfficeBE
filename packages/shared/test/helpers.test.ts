import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  ageOn,
  businessDateOf,
  businessFromDate,
  CLAIM_STATUS_FILTER_MAP,
  dateFromBusiness,
  daysBetween,
  daysInMonth,
  dec,
  easterSunday,
  eachBusinessDate,
  endOfMonth,
  formatCardDate,
  formatChangeRequestReference,
  formatClaimReference,
  formatCreditLeaveReference,
  formatFreeTextReference,
  formatGridDate,
  formatLeaveReference,
  formatTimestamp,
  formatTimestampDate,
  isBusinessDate,
  isoWeekday,
  isWeekend,
  LEAVE_REFERENCE_PATTERN,
  maxDate,
  minDate,
  money2,
  observedDate,
  PROCESS_STATUS_LABELS,
  requiresPayrollProcessing,
  round2,
  round4,
  sequenceKeys,
  startOfMonth,
  sumDecimals,
  todayBusinessDate,
  units4,
  WORKFLOW_TYPE_CODES,
} from '../src';

describe('decimal helpers', () => {
  it('reproduces the observed balance arithmetic (section 1.7)', () => {
    const accrual = round4(dec(20).dividedBy(12));
    expect(accrual.toFixed(4)).toBe('1.6667');
    expect(units4(dec('2.1691').plus(accrual).minus(0))).toBe('3.8358');
    expect(units4(dec(12).minus(9))).toBe('3.0000');
  });

  it('rounds half away from zero', () => {
    expect(round4('0.00005').toFixed(4)).toBe('0.0001');
    expect(round2('2.345').toFixed(2)).toBe('2.35');
    expect(round2('-2.345').toFixed(2)).toBe('-2.35');
    expect(money2(null)).toBe('0.00');
    expect(money2('10')).toBe('10.00');
  });

  it('accepts all decimal inputs', () => {
    expect(dec(undefined).toNumber()).toBe(0);
    expect(dec('').toNumber()).toBe(0);
    expect(dec(dec(3)).toNumber()).toBe(3);
    expect(dec({ toString: () => '1.5' }).toNumber()).toBe(1.5);
    expect(sumDecimals(['0.1', '0.2', 0.3]).toString()).toBe('0.6');
  });
});

describe('date helpers', () => {
  it('converts between business dates and @db.Date values', () => {
    const d = dateFromBusiness('2026-09-24');
    expect(d.toISOString()).toBe('2026-09-24T00:00:00.000Z');
    expect(businessFromDate(d)).toBe('2026-09-24');
    expect(() => dateFromBusiness('2026-02-30')).toThrow(RangeError);
    expect(() => dateFromBusiness('24-09-2026')).toThrow(RangeError);
    expect(isBusinessDate('2028-02-29')).toBe(true);
    expect(isBusinessDate('2026-13-01')).toBe(false);
  });

  it('uses Africa/Windhoek for today', () => {
    // 22:30 UTC on 31 Dec is already 1 Jan in Windhoek (UTC+2).
    expect(todayBusinessDate(new Date('2026-12-31T22:30:00Z'))).toBe('2027-01-01');
    expect(businessDateOf(new Date('2026-06-01T21:59:00Z'))).toBe('2026-06-01');
  });

  it('formats like the source system', () => {
    expect(formatGridDate('2026-09-24')).toBe('24-Sep-2026');
    expect(formatGridDate(new Date('2026-01-05T00:00:00Z'))).toBe('05-Jan-2026');
    expect(formatGridDate(null)).toBe('');
    expect(formatCardDate('2026-09-30')).toBe('30 Sep 2026');
    expect(formatCardDate(undefined)).toBe('');
    expect(formatTimestampDate('2026-09-30T23:30:00Z')).toBe('01 Oct 2026');
    expect(formatTimestamp(new Date('2026-09-30T08:15:00Z'))).toBe('30 Sep 2026 10:15');
  });

  it('iterates and compares dates across months and years', () => {
    expect(eachBusinessDate('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
    expect(eachBusinessDate('2026-01-02', '2026-01-01')).toEqual([]);
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(daysBetween('2026-01-01', '2026-12-31')).toBe(364);
    expect(maxDate('2026-01-01', '2026-02-01')).toBe('2026-02-01');
    expect(minDate('2026-01-01', '2026-02-01')).toBe('2026-01-01');
  });

  it('knows weekdays', () => {
    expect(isoWeekday('2026-10-19')).toBe(1); // Monday
    expect(isoWeekday('2026-10-25')).toBe(7); // Sunday
    expect(isWeekend('2026-10-24')).toBe(true);
    expect(isWeekend('2026-10-23')).toBe(false);
  });

  it('handles months', () => {
    expect(startOfMonth('2026-02-17')).toBe('2026-02-01');
    expect(endOfMonth('2026-02-17')).toBe('2026-02-28');
    expect(endOfMonth('2028-02-01')).toBe('2028-02-29');
    expect(daysInMonth('2026-04-10')).toBe(30);
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
  });

  it('computes ages', () => {
    expect(ageOn('2000-10-20', '2026-10-20')).toBe(26);
    expect(ageOn('2000-10-21', '2026-10-20')).toBe(25);
    expect(ageOn('2000-11-01', '2026-10-20')).toBe(25);
  });

  it('computes Easter (Anonymous Gregorian computus)', () => {
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
    expect(easterSunday(2025)).toBe('2025-04-20');
    expect(easterSunday(2038)).toBe('2038-04-25');
  });

  it('moves Sunday holidays to Monday', () => {
    expect(observedDate('2027-03-21')).toBe('2027-03-22'); // Independence Day 2027 is a Sunday
    expect(observedDate('2026-03-21')).toBe('2026-03-21'); // Saturday stays
  });
});

describe('reference numbers', () => {
  it('formats the observed leave reference', () => {
    expect(formatLeaveReference('77', 6, 5)).toBe('E000077-T0006-N00005');
    expect(formatLeaveReference('E77', 6, 5)).toBe('E000077-T0006-N00005');
    expect(LEAVE_REFERENCE_PATTERN.test(formatLeaveReference('000077', 1, 99999))).toBe(true);
  });

  it('formats other references', () => {
    expect(formatClaimReference('77', 2, 1)).toBe('C000077-G0002-N00001');
    expect(formatChangeRequestReference('77', 'BANKDET', 3)).toBe('R000077-BANKDET-N00003');
    expect(formatFreeTextReference('77', 12)).toBe('F000077-N00012');
    expect(formatCreditLeaveReference('77', 13, 1)).toBe('L000077-T0013-N00001');
  });

  it('builds sequence keys', () => {
    expect(sequenceKeys.leave(1, 6)).toBe('LEAVE:1:6');
    expect(sequenceKeys.claim(1, 2)).toBe('CLAIM:1:2');
    expect(sequenceKeys.changeRequest(1, 'BASICINF')).toBe('CR:1:BASICINF');
    expect(sequenceKeys.freeText(1)).toBe('FREETEXT:1');
    expect(sequenceKeys.creditLeave(1, 13)).toBe('CREDIT:1:13');
  });
});

describe('enums', () => {
  it('lists the 16 observed workflow types', () => {
    expect(WORKFLOW_TYPE_CODES).toHaveLength(16);
    expect(requiresPayrollProcessing('LEAVE')).toBe(true);
    expect(requiresPayrollProcessing('BANKDET')).toBe(false);
  });

  it('labels statuses like the source', () => {
    expect(PROCESS_STATUS_LABELS.APPROVED_PENDING_PROCESS).toBe('Approved, Pending Process');
    expect(PROCESS_STATUS_LABELS.PROCESSED).toBe('Completed');
    expect(CLAIM_STATUS_FILTER_MAP['Cancelled / Declined']).toEqual(['CANCELLED', 'DECLINED']);
  });
});
