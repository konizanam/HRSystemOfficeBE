import type { Prisma, ProcessStatus } from '@prisma/client';

/** Applications whose allocations reserve units ("Pending", section 5.2.2). */
export const RESERVING_STATUSES: ProcessStatus[] = [
  'IN_PROGRESS',
  'RESUBMIT_REQUIRED',
  'APPROVED_PENDING_PROCESS',
];

/** Approved leave ("Planned" when in the future; shown on the calendar). */
export const APPROVED_STATUSES: ProcessStatus[] = ['APPROVED_PENDING_PROCESS', 'PROCESSED'];

/** Leave still being approved (optionally shown on the calendar, flagged). */
export const IN_APPROVAL_STATUSES: ProcessStatus[] = ['IN_PROGRESS', 'RESUBMIT_REQUIRED'];

/** Applications that block the same days for another application (overlap check). */
export const OVERLAP_EXCLUDED_STATUSES: ProcessStatus[] = ['CANCELLED', 'DECLINED'];

/** Bucket names used by the jobs and the opening balances (section 1.7). */
export const CARRY_FORWARD_DEFINITION = 'Carry Forward Leave';
export const CREDIT_DEFINITION = 'Leave in Lieu';

/** Owner entity names of leave attachments (`Attachment.ownerEntity`). */
export const LEAVE_APPLICATION_ENTITY = 'LeaveApplication';
export const CREDIT_LEAVE_ENTITY = 'CreditLeaveRequest';

/**
 * Event a pay period close emits (Phase 9 admin `POST /admin/pay-periods/:id/close`); the leave
 * module runs `leave.accrue` for the next period's start when it arrives.
 */
export const PAY_PERIOD_CLOSED_EVENT = 'payPeriod.closed';

/** Employee fields the leave rules need. */
export const LEAVE_EMPLOYEE_SELECT = {
  id: true,
  entityCode: true,
  employeeCode: true,
  companyId: true,
  companyRuleId: true,
  firstName: true,
  lastName: true,
  title: true,
  initials: true,
  status: true,
  dateEngaged: true,
  terminationDate: true,
  deletedAt: true,
} satisfies Prisma.EmployeeSelect;

export type LeaveEmployee = Prisma.EmployeeGetPayload<{ select: typeof LEAVE_EMPLOYEE_SELECT }>;
