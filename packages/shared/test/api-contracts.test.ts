import { describe, expect, it } from 'vitest';
import {
  AllocatableEmployeesQuerySchema,
  changeFieldLabelKey,
  ClaimCapProblemSchema,
  ClaimCapWarningSchema,
  COMMON_PROBLEM_TYPES,
  defaultSettings,
  IDEMPOTENCY_IN_PROGRESS_TITLE,
  InboxItemDetailSchema,
  isClearSensitiveValue,
  LEAVE_BALANCE_GRID_COLUMNS,
  LeaveApplicationsQuerySchema,
  leaveBalanceRowReconciles,
  RESTRICTED_FEATURES,
  SubjectDetailSchema,
  subjectDataOf,
  trimDecimal,
  UpdateBeneficiariesRequestSchema,
  UpdateFamilyMemberRequestSchema,
  UpdatePersonalDetailsRequestSchema,
} from '../src';

describe('problem types for 409s', () => {
  it('tells a version conflict from an idempotency replay in progress', () => {
    expect(COMMON_PROBLEM_TYPES.versionConflict).toBe('urn:peoplehub:problem:version-conflict');
    expect(COMMON_PROBLEM_TYPES.idempotencyInProgress).toBe('urn:peoplehub:problem:idempotency-in-progress');
    expect(IDEMPOTENCY_IN_PROGRESS_TITLE).toBe('Request is still being processed');
  });
});

describe('leave history query', () => {
  it('defaults to From Date newest first and accepts the filters', () => {
    expect(LeaveApplicationsQuerySchema.parse({})).toMatchObject({
      status: 'inProgress',
      sort: 'fromDate:desc',
      page: 1,
      pageSize: 50,
    });
    const q = LeaveApplicationsQuerySchema.parse({
      status: 'completed',
      leaveTypeId: '6',
      from: '2026-01-01',
      to: '2026-03-31',
      reference: '  t0006 ',
      sort: 'referenceNumber:asc',
    });
    expect(q).toMatchObject({ leaveTypeId: 6, reference: 't0006', sort: 'referenceNumber:asc' });
    expect(LeaveApplicationsQuerySchema.parse({ reference: '   ' }).reference).toBeUndefined();
  });

  it('refuses an unknown sort and an inverted range', () => {
    expect(LeaveApplicationsQuerySchema.safeParse({ sort: 'units:asc' }).success).toBe(false);
    const inverted = LeaveApplicationsQuerySchema.safeParse({ from: '2026-02-01', to: '2026-01-01' });
    expect(inverted.success).toBe(false);
    expect(inverted.error?.issues[0]?.path).toEqual(['to']);
  });

  it('pages the allocatable employees (max 100, no truncation)', () => {
    expect(AllocatableEmployeesQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
    expect(AllocatableEmployeesQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
  });
});

describe('leave balance grid', () => {
  const row = {
    balanceBroughtForward: '2.1691',
    accruedThisPeriod: '1.6667',
    takenThisPeriod: '0.0000',
    adjustmentsThisPeriod: '0.0000',
    balanceCarriedForward: '3.8358',
    pending: '1.0000',
    actualAvailable: '2.8358',
  };

  it('reconciles the section 1.7 fixture and an adjusted row', () => {
    expect(leaveBalanceRowReconciles(row)).toBe(true);
    expect(
      leaveBalanceRowReconciles({
        ...row,
        takenThisPeriod: '1.5000',
        adjustmentsThisPeriod: '-0.2500',
        balanceCarriedForward: '2.0858',
        actualAvailable: '1.0858',
      }),
    ).toBe(true);
  });

  it('detects a row that does not add up', () => {
    expect(leaveBalanceRowReconciles({ ...row, adjustmentsThisPeriod: '1.0000' })).toBe(false);
    expect(leaveBalanceRowReconciles({ ...row, actualAvailable: '3.8358' })).toBe(false);
  });

  it('keeps the section 1.7 columns in order and marks the extra ones', () => {
    const spec = LEAVE_BALANCE_GRID_COLUMNS.filter((c) => !c.extra).map((c) => c.label);
    expect(spec).toEqual([
      'Leave Definition',
      'Entitlement',
      'Balance Brought Forward',
      'Accrued This Period',
      'Taken This Period',
      'Balance Carried Forward',
      'Planned',
      'Pending',
      'Leave Cycle End Date',
    ]);
    const keys = LEAVE_BALANCE_GRID_COLUMNS.map((c) => c.key);
    expect(keys.indexOf('adjustmentsThisPeriod')).toBe(keys.indexOf('balanceCarriedForward') - 1);
  });
});

describe('claims', () => {
  const finding = {
    code: 'CAP_EXCEEDED',
    mode: 'BLOCK',
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

  it('gives cap findings line references (null for older stored ones)', () => {
    expect(ClaimCapWarningSchema.parse(finding)).toMatchObject({
      lineIndex: null,
      lineId: null,
      lineIndexes: [],
    });
    const withLine = { ...finding, lineIndex: 2, lineId: 41, lineIndexes: [2] };
    expect(ClaimCapWarningSchema.parse(withLine)).toEqual(withLine);
    const problem = ClaimCapProblemSchema.parse({
      type: 'urn:peoplehub:problem:claim-cap-exceeded',
      title: 'Validation failed',
      status: 422,
      errors: [{ path: 'lines.2.amount', message: 'Over' }],
      findings: [withLine],
    });
    expect(problem.findings[0]?.lineIndex).toBe(2);
  });

  it('trims quantities for display only', () => {
    expect(trimDecimal('2.5000')).toBe('2.5');
    expect(trimDecimal('3.0000')).toBe('3');
    expect(trimDecimal('0.00004')).toBe('0');
    expect(trimDecimal('12.34567')).toBe('12.3457');
    expect(trimDecimal(null)).toBe('0');
  });
});

describe('masked numbers: the explicit clear action', () => {
  it('turns { clear: true } into null and keeps blank and missing as before', () => {
    const body = UpdatePersonalDetailsRequestSchema.parse({
      version: 3,
      identity: { identityNumber: { clear: true }, passportNumber: 'P1234567', taxNumber: '' },
    });
    expect(body.identity).toEqual({ identityNumber: null, passportNumber: 'P1234567', taxNumber: null });
    expect('birthCertificateNumber' in (body.identity ?? {})).toBe(false);
    expect(isClearSensitiveValue({ clear: true })).toBe(true);
    expect(isClearSensitiveValue({ clear: false })).toBe(false);
  });

  it('refuses anything else that is not a number', () => {
    for (const value of [{ clear: false }, { clear: true, value: '1' }, { keep: true }]) {
      const r = UpdatePersonalDetailsRequestSchema.safeParse({ version: 1, identity: { taxNumber: value } });
      expect(r.success).toBe(false);
    }
  });

  it('applies to family members and beneficiaries', () => {
    expect(
      UpdateFamilyMemberRequestSchema.parse({ version: 1, identityNumber: { clear: true } }).identityNumber,
    ).toBeNull();
    const ben = UpdateBeneficiariesRequestSchema.parse({
      version: 1,
      beneficiaries: [
        { id: 4, name: 'A', relationship: 'Other', identityNumber: { clear: true }, percentage: '100' },
      ],
    });
    expect(ben.beneficiaries[0]?.identityNumber).toBeNull();
  });
});

describe('change field label keys', () => {
  it('builds stable i18n keys per record', () => {
    expect(changeFieldLabelKey('Employee', 'identity.firstName')).toBe('details.personal.firstName');
    expect(changeFieldLabelKey('Employee', 'physicalAddress.city')).toBe(
      'details.personal.physicalAddress.city',
    );
    expect(changeFieldLabelKey('Employee', 'contacts.cell')).toBe('details.personal.contacts.cell');
    expect(changeFieldLabelKey('BankAccount', 'accountNumber')).toBe('details.bank.accountNumber');
    expect(changeFieldLabelKey('DriversLicence', 'expiryDate')).toBe('details.licence.expiryDate');
    expect(changeFieldLabelKey('FamilyMember', 'identityNumber')).toBe('details.family.identityNumber');
    expect(changeFieldLabelKey('FundMembership', 'beneficiaries.0.percentage')).toBe(
      'details.beneficiaries.beneficiaries.percentage',
    );
  });
});

describe('typed inbox subject data', () => {
  const base = { title: 'T', requestLabel: 'R', headline: [], fields: [] };

  it('parses each kind and narrows its data', () => {
    const leave = SubjectDetailSchema.parse({
      ...base,
      kind: 'LEAVE',
      data: {
        applicationId: 1,
        referenceNumber: 'E000077-T0006-N00005',
        leaveTypeId: 6,
        leaveTypeCode: 'STUDY',
        colour: null,
        fromDate: '2026-10-05',
        toDate: '2026-10-09',
        startPortion: 'FULL',
        endPortion: 'FULL',
        units: '5.0000',
        daysAvailable: '8.0000',
        noteSubmitted: false,
        isCancellation: false,
        cancelsApplicationId: null,
        cancelsReferenceNumber: null,
      },
    });
    expect(subjectDataOf(leave, 'LEAVE')?.units).toBe('5.0000');
    expect(subjectDataOf(leave, 'CLAIM')).toBeNull();

    const change = SubjectDetailSchema.parse({
      ...base,
      kind: 'CHANGE_REQUEST',
      data: {
        changeRequestId: 3,
        referenceNumber: 'R000077-BASICINF-N00001',
        entityType: 'Employee',
        entityLabel: 'Personal details',
        entityId: '77',
        operation: 'UPDATE',
        status: 'IN_PROGRESS',
        changes: [
          {
            path: 'identity.firstName',
            label: 'First Name',
            labelKey: 'details.personal.firstName',
            from: 'A',
            to: 'B',
          },
        ],
        revealed: false,
      },
    });
    expect(subjectDataOf(change, 'CHANGE_REQUEST')?.changes[0]?.labelKey).toBe('details.personal.firstName');

    const generic = SubjectDetailSchema.parse({ ...base, kind: 'GENERIC', data: { anything: 1 } });
    expect(subjectDataOf(generic, 'GENERIC')).toEqual({ anything: 1 });
  });

  it('refuses data that does not match its kind, and a missing kind', () => {
    expect(SubjectDetailSchema.safeParse({ ...base, kind: 'LEAVE', data: { anything: 1 } }).success).toBe(
      false,
    );
    expect(SubjectDetailSchema.safeParse({ ...base, data: {} }).success).toBe(false);
    expect(InboxItemDetailSchema.shape.subject).toBe(SubjectDetailSchema);
  });
});

describe('session restrictions while working as someone else (section 4.2)', () => {
  it('restricts ID and bank account numbers by default', () => {
    const restricted = defaultSettings()['workingAs.restrictedFeatures'];
    expect(restricted).toEqual([...RESTRICTED_FEATURES]);
    expect(restricted).toEqual(expect.arrayContaining(['ID_NUMBERS', 'BANK_ACCOUNT_NUMBERS']));
  });
});
