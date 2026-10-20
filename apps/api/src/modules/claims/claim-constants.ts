import type { Prisma, ProcessStatus } from '@prisma/client';
import type { WorkflowTypeCode } from '@peoplehub/shared';

/** Owner entity names of claim attachments (`Attachment.ownerEntity`); also the Prisma models. */
export const CLAIM_ENTITY = 'Claim';
export const CLAIM_LINE_ENTITY = 'ClaimLine';

/** The two claim workflow types (section 5.3.1). */
export type ClaimWorkflowType = Extract<WorkflowTypeCode, 'GROUPEDCLAIM' | 'CLAIMS'>;
export const CLAIM_WORKFLOW_TYPES: readonly ClaimWorkflowType[] = ['GROUPEDCLAIM', 'CLAIMS'];

/** Submitted and not yet processed: "Pending Amount Claimed" (section 5.3.3). */
export const PENDING_CLAIM_STATUSES: ProcessStatus[] = [
  'IN_PROGRESS',
  'RESUBMIT_REQUIRED',
  'APPROVED_PENDING_PROCESS',
];

/** Processed: "Amount Claimed". */
export const CLAIMED_CLAIM_STATUSES: ProcessStatus[] = ['PROCESSED'];

/** "Submitted n" on a tile: claims in flight. */
export const SUBMITTED_CLAIM_STATUSES: ProcessStatus[] = PENDING_CLAIM_STATUSES;

/** Approver actions that count as "a step has been actioned" (cancel becomes HR/Payroll only). */
export const ACTIONED_WORKFLOW_ACTIONS = ['APPROVE', 'DECLINE', 'REASSIGN', 'PARK', 'SEND_BACK'] as const;

/** Employee fields the claim rules need. */
export const CLAIM_EMPLOYEE_SELECT = {
  id: true,
  entityCode: true,
  employeeCode: true,
  companyId: true,
  companyRuleId: true,
  firstName: true,
  lastName: true,
  status: true,
  dateEngaged: true,
  terminationDate: true,
  hourlyRate: true,
  company: { select: { currency: true } },
} satisfies Prisma.EmployeeSelect;

export type ClaimEmployee = Prisma.EmployeeGetPayload<{ select: typeof CLAIM_EMPLOYEE_SELECT }>;

/** Live lines of a claim, in grid order. */
export const LIVE_LINES = {
  where: { deletedAt: null },
  orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
} satisfies Prisma.ClaimLineFindManyArgs;

/** What a list row needs. */
export const CLAIM_ROW_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      companyId: true,
      company: { select: { currency: true } },
    },
  },
  group: { select: { id: true, code: true, description: true, attachmentMandatory: true } },
  process: {
    select: {
      id: true,
      version: true,
      status: true,
      subjectEmployeeId: true,
      submittedByUserId: true,
      workflowType: { select: { code: true } },
    },
  },
  _count: { select: { lines: { where: { deletedAt: null } } } },
} satisfies Prisma.ClaimInclude;

export type ClaimRowSource = Prisma.ClaimGetPayload<{ include: typeof CLAIM_ROW_INCLUDE }>;

/** What the detail needs on top of a row. */
export const CLAIM_DETAIL_INCLUDE = {
  ...CLAIM_ROW_INCLUDE,
  lines: { ...LIVE_LINES, include: { claimType: true } },
  payPeriod: { select: { id: true, description: true } },
} satisfies Prisma.ClaimInclude;

export type ClaimDetailSource = Prisma.ClaimGetPayload<{ include: typeof CLAIM_DETAIL_INCLUDE }>;

/** The claim cap types (`ClaimCap`) with their type, for cap checks and balances. */
export type ClaimTypeWithCaps = Prisma.ClaimTypeGetPayload<{
  include: { caps: true; group: true };
}>;
