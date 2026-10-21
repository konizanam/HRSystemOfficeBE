import { describe, expect, it } from 'vitest';
import {
  AdminFundMemberSchema,
  AdminFundMembershipsQuerySchema,
  AuditActorOptionsQuerySchema,
  AuditListResponseSchema,
  AuditListRowSchema,
  AuditRowDetailSchema,
  ClaimDetailSchema,
  EndFundMembershipRequestSchema,
  FundMembershipParamSchema,
  InboxCardSchema,
  InboxItemDetailSchema,
  RestorePublicHolidayRequestSchema,
  WORKFLOW_STEP_USER_OPTIONS_PATH,
} from '../src';

describe('final gap contracts', () => {
  it('carries the subject entity on the inbox card and detail', () => {
    expect(Object.keys(InboxCardSchema.shape)).toEqual(
      expect.arrayContaining(['subjectEntity', 'subjectEntityId']),
    );
    expect(InboxItemDetailSchema.shape.subjectEntity.parse('LeaveApplication')).toBe('LeaveApplication');
    expect(InboxItemDetailSchema.shape.subjectEntityId.safeParse(15).success).toBe(false);
  });

  it('reads the fund membership list query and the end request', () => {
    expect(AdminFundMembershipsQuerySchema.parse({})).toEqual({
      search: undefined,
      page: 1,
      pageSize: 25,
    });
    expect(AdminFundMembershipsQuerySchema.parse({ includeEnded: 'true', search: ' M-1 ' })).toMatchObject({
      includeEnded: true,
      search: 'M-1',
    });
    expect(AdminFundMembershipsQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(FundMembershipParamSchema.parse({ id: '3', membershipId: '9' })).toEqual({
      id: 3,
      membershipId: 9,
    });
    expect(EndFundMembershipRequestSchema.parse({ version: 2 })).toEqual({ version: 2 });
    expect(EndFundMembershipRequestSchema.safeParse({ version: 2, endDate: '21/10/2026' }).success).toBe(
      false,
    );
    const row = {
      membershipId: 1,
      fundId: 2,
      employeeId: 3,
      memberNumber: null,
      startDate: '2026-01-01',
      endDate: null,
      version: 1,
      employeeCode: 'E1',
      employeeName: 'Ada Lovelace',
      employeeStatus: 'ACTIVE',
      isActive: true,
      beneficiaryCount: 0,
    };
    expect(AdminFundMemberSchema.parse(row)).toEqual(row);
  });

  it('adds names to the audit grid rows only', () => {
    expect(Object.keys(AuditListRowSchema.shape)).toEqual(
      expect.arrayContaining(['actingAsEmployeeName', 'subjectEmployeeName']),
    );
    expect(AuditListResponseSchema.shape.items.element).toBe(AuditListRowSchema);
    expect(Object.keys(AuditRowDetailSchema.shape)).not.toContain('subjectEmployeeName');
    expect(AuditActorOptionsQuerySchema.parse({ search: '  ' })).toEqual({
      search: undefined,
      page: 1,
      pageSize: 25,
    });
  });

  it('requires canResubmit on the claim detail and documents the new endpoints', () => {
    expect(ClaimDetailSchema.shape.canResubmit.parse(true)).toBe(true);
    expect(RestorePublicHolidayRequestSchema.safeParse({}).success).toBe(false);
    expect(WORKFLOW_STEP_USER_OPTIONS_PATH).toBe('/admin/workflow-definitions/user-options');
  });
});
