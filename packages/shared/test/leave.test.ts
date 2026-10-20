import { describe, expect, it } from 'vitest';
import {
  AttachmentIdsSchema,
  attachmentDownloadPath,
  CreateCreditLeaveRequestSchema,
  HolidaysQuerySchema,
  holidayObservedDate,
  holidayRuleAppliesIn,
  holidayRuleDate,
  LeaveCalendarExportQuerySchema,
  LeaveCalendarQuerySchema,
  LeaveCalculateRequestSchema,
  LeaveResubmitChangesSchema,
  NAMIBIAN_HOLIDAY_RULES,
  NAMIBIAN_HOLIDAYS_2026,
  OpeningBalanceImportRequestSchema,
  SubmitLeaveRequestSchema,
  UpdateLeaveTypeRequestSchema,
} from '../src';

describe('holiday rules (section 14)', () => {
  it('reproduces the 2026 Namibian list from the rules table', () => {
    const generated = NAMIBIAN_HOLIDAY_RULES.map((r) => ({ date: holidayRuleDate(r, 2026), name: r.name }));
    expect(generated.sort((a, b) => String(a.date).localeCompare(String(b.date)))).toEqual(
      [...NAMIBIAN_HOLIDAYS_2026].sort((a, b) => a.date.localeCompare(b.date)),
    );
  });

  it('computes Easter-relative dates with the Anonymous Gregorian computus', () => {
    const goodFriday = { kind: 'EASTER_RELATIVE' as const, easterOffsetDays: -2 };
    const ascension = { kind: 'EASTER_RELATIVE' as const, easterOffsetDays: 39 };
    expect(holidayRuleDate(goodFriday, 2027)).toBe('2027-03-26');
    expect(holidayRuleDate(ascension, 2027)).toBe('2027-05-06');
    expect(holidayRuleDate({ kind: 'EASTER_RELATIVE' }, 2026)).toBe('2026-04-05');
  });

  it('observes a Sunday holiday on the Monday', () => {
    expect(holidayObservedDate('2027-03-21')).toBe('2027-03-22');
    expect(holidayObservedDate('2027-03-21', false)).toBe('2027-03-21');
    expect(holidayObservedDate('2026-03-21')).toBe('2026-03-21');
  });

  it('respects validity years and impossible dates', () => {
    const genocide = NAMIBIAN_HOLIDAY_RULES.find((r) => r.name === 'Genocide Remembrance Day');
    expect(genocide && holidayRuleDate(genocide, 2024)).toBeNull();
    expect(genocide && holidayRuleDate(genocide, 2025)).toBe('2025-05-28');
    expect(holidayRuleAppliesIn({ kind: 'FIXED', month: 1, day: 1, validToYear: 2020 }, 2021)).toBe(false);
    expect(holidayRuleDate({ kind: 'FIXED', month: 2, day: 29 }, 2027)).toBeNull();
    expect(holidayRuleDate({ kind: 'FIXED', month: 2, day: 29 }, 2028)).toBe('2028-02-29');
    expect(holidayRuleDate({ kind: 'FIXED', month: 13, day: 1 }, 2028)).toBeNull();
  });
});

describe('leave contracts', () => {
  it('defaults portions and validates the period', () => {
    expect(
      LeaveCalculateRequestSchema.parse({ leaveTypeId: 1, fromDate: '2026-09-24', toDate: '2026-09-25' }),
    ).toMatchObject({
      startPortion: 'FULL',
      endPortion: 'FULL',
    });
    const bad = LeaveCalculateRequestSchema.safeParse({
      leaveTypeId: 1,
      fromDate: '2026-09-25',
      toDate: '2026-09-24',
    });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['toDate']);
  });

  it('requires units and a reason for an HR override, and limits the comment', () => {
    const base = { leaveTypeId: 1, fromDate: '2026-09-24', toDate: '2026-09-25' };
    expect(SubmitLeaveRequestSchema.parse(base)).toMatchObject({
      noteSubmitted: false,
      attachmentIds: [],
      overrideUnits: false,
    });
    const override = SubmitLeaveRequestSchema.safeParse({ ...base, overrideUnits: true });
    expect(override.error?.issues.map((i) => i.path.join('.'))).toEqual(['units', 'overrideReason']);
    expect(
      SubmitLeaveRequestSchema.safeParse({ ...base, overrideUnits: true, units: '1.5', overrideReason: 'x' })
        .success,
    ).toBe(true);
    expect(SubmitLeaveRequestSchema.safeParse({ ...base, units: '1.23456' }).success).toBe(false);
    expect(SubmitLeaveRequestSchema.safeParse({ ...base, comment: 'x'.repeat(1001) }).success).toBe(false);
  });

  it('rejects duplicate attachment ids and unknown resubmit fields', () => {
    const id = '5f7c2b8e-3c1a-4c55-9d7e-0a1b2c3d4e5f';
    expect(AttachmentIdsSchema.safeParse([id, id]).success).toBe(false);
    expect(attachmentDownloadPath(id)).toBe(`/api/v1/attachments/${id}`);
    expect(LeaveResubmitChangesSchema.safeParse({ fromDate: '2026-09-24' }).success).toBe(true);
    expect(LeaveResubmitChangesSchema.safeParse({ units: '3' }).success).toBe(false);
  });

  it('parses calendar and holiday ranges', () => {
    expect(
      LeaveCalendarQuerySchema.parse({ from: '2026-09-01', to: '2026-10-11', includeInProgress: 'false' }),
    ).toEqual({
      from: '2026-09-01',
      to: '2026-10-11',
      scope: 'self',
      includeInProgress: false,
    });
    expect(
      LeaveCalendarExportQuerySchema.parse({
        from: '2026-09-01',
        to: '2026-09-30',
        format: 'csv',
        includeInProgress: 'true',
      }),
    ).toMatchObject({
      format: 'csv',
      includeInProgress: true,
    });
    expect(LeaveCalendarQuerySchema.safeParse({ from: '2026-01-01', to: '2027-06-01' }).success).toBe(false);
    expect(HolidaysQuerySchema.safeParse({ from: '2026-02-01', to: '2026-01-01' }).success).toBe(false);
    expect(HolidaysQuerySchema.safeParse({ from: '2026-02-31', to: '2026-03-01' }).success).toBe(false);
  });

  it('validates leave in lieu, imports and admin updates', () => {
    expect(
      CreateCreditLeaveRequestSchema.safeParse({
        kind: 'REQUEST',
        workedFrom: '2026-09-20',
        workedTo: '2026-09-19',
        units: '1',
        reason: 'Weekend',
      }).success,
    ).toBe(false);
    expect(OpeningBalanceImportRequestSchema.safeParse({ csv: 'a', mode: 'COMMIT' }).success).toBe(false);
    expect(OpeningBalanceImportRequestSchema.safeParse({ csv: 'a', mode: 'DRY_RUN' }).success).toBe(true);
    expect(UpdateLeaveTypeRequestSchema.safeParse({ version: 1, colour: '#ABCDEF' }).success).toBe(true);
    expect(UpdateLeaveTypeRequestSchema.safeParse({ version: 1, id: 4 }).success).toBe(false);
  });
});
