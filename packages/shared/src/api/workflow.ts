import { z } from 'zod';
import {
  ProcessStatusSchema,
  type Role,
  RoleSchema,
  StepStatusSchema,
  WorkflowActionTypeSchema,
  type WorkflowTypeCode,
  WorkflowTypeCodeSchema,
} from '../enums';
import { BusinessDateSchema, TimestampSchema } from './common';

// Contracts for the workflow engine endpoints (sections 7 and 12.7): approver actions, bulk
// approve, payroll processing and the approval history (section 1.5).

/** Longest comment an approver or applicant may write. */
export const WORKFLOW_COMMENT_MAX = 2000;

/** Most items in one bulk approve or process request. */
export const WORKFLOW_BULK_MAX = 100;

/** Delegation through out-of-office nominees stops after this many hops (section 5.11). */
export const DELEGATION_MAX_HOPS = 3;

/** Short noun for each workflow type, used in "This {label} Request …" and in notifications. */
export const WORKFLOW_REQUEST_LABELS: Record<WorkflowTypeCode, string> = {
  LEAVE: 'Leave',
  BASICINF: 'Personal Details',
  BANKDET: 'Bank Details',
  FREETEXT: 'Free Text',
  FREETEXTMANEMP: 'Free Text',
  CLAIMS: 'Claim',
  CANCELLEAVE: 'Cancel Leave',
  BENEFICIARY: 'Beneficiary',
  TRAINING: 'Training',
  QUALIFICATION: 'Qualification',
  JOBREQUISITION: 'Job Requisition',
  GROUPEDCLAIM: 'Grouped Claim',
  CHECKLISTITEM: 'Checklist Item',
  DRIVERSLICENSE: 'Drivers License',
  CREDITLVEALLOC: 'Leave in Lieu Allocation',
  CREDITLVEREQ: 'Leave in Lieu',
};

/** Role names as approvers see them ("Any HR Administrator"). */
export const ROLE_LABELS: Record<Role, string> = {
  EMPLOYEE: 'Employee',
  MANAGER: 'Manager',
  HR_ADMIN: 'HR Administrator',
  PAYROLL_ADMIN: 'Payroll Administrator',
  SYSTEM_ADMIN: 'System Administrator',
  AUDITOR: 'Auditor',
};

const CommentSchema = z.string().trim().max(WORKFLOW_COMMENT_MAX);
const RequiredCommentSchema = CommentSchema.min(1, 'A comment is required');
const ProcessVersionSchema = z.number().int().positive();

/** A person in a workflow (applicant, approver, actor). */
export const WorkflowPersonSchema = z.object({
  userId: z.string().nullable(),
  employeeId: z.number().int().nullable(),
  employeeCode: z.string().nullable(),
  /** "{Title} {Initials} {Surname}"; the username when the user has no employee record; "System" for jobs. */
  name: z.string(),
  /** "{First} {Last}" (or the same as `name` without an employee record). */
  displayName: z.string(),
});
export type WorkflowPerson = z.infer<typeof WorkflowPersonSchema>;

/** The state of a process after an action (the response of every action endpoint). */
export const WorkflowProcessSchema = z.object({
  id: z.number().int(),
  workflowType: WorkflowTypeCodeSchema,
  typeLabel: z.string(),
  status: ProcessStatusSchema,
  statusLabel: z.string(),
  /** Send this back with the next action (optimistic concurrency, section 0.8). */
  version: z.number().int(),
  round: z.number().int(),
  currentStepNo: z.number().int().nullable(),
  subjectEmployeeId: z.number().int(),
  subjectEntity: z.string(),
  subjectEntityId: z.string(),
  summary: z.string(),
  isEscalated: z.boolean(),
  submittedAt: TimestampSchema.nullable(),
  finalApprovedAt: TimestampSchema.nullable(),
  processedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
});
export type WorkflowProcessDto = z.infer<typeof WorkflowProcessSchema>;

// ───────────── Action requests ─────────────

/** POST /workflow/processes/:id/approve. */
export const ApproveRequestSchema = z.object({
  version: ProcessVersionSchema,
  comment: CommentSchema.optional(),
});
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;

/** POST /workflow/processes/:id/decline. The comment is required (section 5.10). */
export const DeclineRequestSchema = z.object({
  version: ProcessVersionSchema,
  comment: RequiredCommentSchema,
});
export type DeclineRequest = z.infer<typeof DeclineRequestSchema>;

/** POST /workflow/processes/:id/reassign. Needs `allowReassign` on the definition. */
export const ReassignRequestSchema = z.object({
  version: ProcessVersionSchema,
  toUserId: z.string().uuid(),
  comment: CommentSchema.optional(),
});
export type ReassignRequest = z.infer<typeof ReassignRequestSchema>;

/**
 * POST /workflow/processes/:id/park. The step leaves Action Required until the start of `until`
 * (Africa/Windhoek). Needs `canPark` on the definition.
 */
export const ParkRequestSchema = z.object({
  version: ProcessVersionSchema,
  until: BusinessDateSchema,
  comment: CommentSchema.optional(),
});
export type ParkRequest = z.infer<typeof ParkRequestSchema>;

/** POST /workflow/processes/:id/send-back. Needs `allowResubmit`; the comment is required. */
export const SendBackRequestSchema = z.object({
  version: ProcessVersionSchema,
  comment: RequiredCommentSchema,
});
export type SendBackRequest = z.infer<typeof SendBackRequestSchema>;

/**
 * POST /workflow/processes/:id/resubmit (applicant or submitter). `changes` is passed to the
 * subject handler of the type, which validates it (for example the edited leave dates).
 */
export const ResubmitRequestSchema = z.object({
  version: ProcessVersionSchema,
  comment: CommentSchema.optional(),
  changes: z.record(z.unknown()).optional(),
});
export type ResubmitRequest = z.infer<typeof ResubmitRequestSchema>;

/** POST /workflow/processes/:id/withdraw (applicant or submitter). */
export const WithdrawRequestSchema = z.object({
  version: ProcessVersionSchema,
  comment: CommentSchema.optional(),
});
export type WithdrawRequest = z.infer<typeof WithdrawRequestSchema>;

/** POST /workflow/processes/:id/comment (current approvers, the applicant or the submitter). */
export const CommentRequestSchema = z.object({
  version: ProcessVersionSchema,
  comment: RequiredCommentSchema,
});
export type CommentRequest = z.infer<typeof CommentRequestSchema>;

/** POST /workflow/processes/bulk-approve. Each item is approved and audited on its own. */
export const BulkApproveRequestSchema = z.object({
  items: z
    .array(z.object({ id: z.number().int().positive(), version: ProcessVersionSchema }))
    .min(1, 'Select at least one item')
    .max(WORKFLOW_BULK_MAX)
    .refine((items) => new Set(items.map((i) => i.id)).size === items.length, 'Duplicate process id'),
  comment: CommentSchema.optional(),
});
export type BulkApproveRequest = z.infer<typeof BulkApproveRequestSchema>;

/** POST /workflow/processes/process (PAYROLL_ADMIN): posts approved items to a pay period. */
export const ProcessRequestSchema = z.object({
  ids: z
    .array(z.number().int().positive())
    .min(1, 'Select at least one item')
    .max(WORKFLOW_BULK_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate process id'),
  payPeriodId: z.number().int().positive(),
});
export type ProcessRequest = z.infer<typeof ProcessRequestSchema>;

/** Why one item of a bulk request failed (an RFC 7807 problem, without the envelope). */
export const BulkItemErrorSchema = z.object({
  status: z.number().int(),
  title: z.string(),
  detail: z.string().optional(),
});

export const BulkItemResultSchema = z.object({
  processId: z.number().int(),
  ok: z.boolean(),
  /** The process state after a successful action. */
  process: WorkflowProcessSchema.optional(),
  error: BulkItemErrorSchema.optional(),
});
export type BulkItemResult = z.infer<typeof BulkItemResultSchema>;

/** Response of bulk approve and process: one result per requested item, in request order. */
export const BulkActionResponseSchema = z.object({
  results: z.array(BulkItemResultSchema),
  succeeded: z.number().int(),
  failed: z.number().int(),
});
export type BulkActionResponse = z.infer<typeof BulkActionResponseSchema>;

// ───────────── Approval history (section 1.5) ─────────────

/** One WorkflowAction as shown in the approval history. */
export const ApprovalHistoryEventSchema = z.object({
  id: z.number().int(),
  action: WorkflowActionTypeSchema,
  at: TimestampSchema,
  round: z.number().int(),
  /** Null for process-level events (created, resubmitted, withdrawn, processed, …). */
  stepNo: z.number().int().nullable(),
  /** Null when the system acted (auto-skip, escalation, delegation, unpark). */
  actor: WorkflowPersonSchema.nullable(),
  /** Who a step moved away from (reassign, delegation). */
  from: WorkflowPersonSchema.nullable(),
  /** Who a step moved to (reassign, delegation, escalation). */
  to: WorkflowPersonSchema.nullable(),
  comment: z.string().nullable(),
  parkedUntil: TimestampSchema.nullable(),
  fromStatus: ProcessStatusSchema.nullable(),
  toStatus: ProcessStatusSchema.nullable(),
  /** The event rendered as one history line. */
  text: z.string(),
});
export type ApprovalHistoryEvent = z.infer<typeof ApprovalHistoryEventSchema>;

/** A step still to be approved, with the people who can approve it. */
export const RemainingStepSchema = z.object({
  stepNo: z.number().int(),
  name: z.string(),
  isMandatory: z.boolean(),
  /** People who can act now (current step) or are expected to (later steps). */
  approvers: z.array(WorkflowPersonSchema),
  /** Set for a ROLE step that is not yet assigned, e.g. "Any HR Administrator". */
  roleLabel: z.string().nullable(),
  isCurrent: z.boolean(),
});
export type RemainingStep = z.infer<typeof RemainingStepSchema>;

export const ApprovalHistoryApplicantSchema = z.object({
  employeeId: z.number().int(),
  employeeCode: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  title: z.string().nullable(),
  initials: z.string().nullable(),
});
export type ApprovalHistoryApplicant = z.infer<typeof ApprovalHistoryApplicantSchema>;

/** GET /workflow/processes/:id/history: structured fields plus the exact section 1.5 text. */
export const ApprovalHistorySchema = z.object({
  processId: z.number().int(),
  workflowType: WorkflowTypeCodeSchema,
  /** The noun in "New {label} Request", e.g. "Annual Leave". */
  requestLabel: z.string(),
  status: ProcessStatusSchema,
  statusLabel: z.string(),
  /** "This {label} Request has been Approved and is waiting to be Processed." */
  statusText: z.string(),
  applicant: ApprovalHistoryApplicantSchema,
  submittedBy: WorkflowPersonSchema,
  submittedOnBehalf: z.boolean(),
  createdAt: TimestampSchema,
  round: z.number().int(),
  events: z.array(ApprovalHistoryEventSchema),
  remaining: z.array(RemainingStepSchema),
  /** The modal text, lines separated by "\n" (section 1.5). */
  renderedText: z.string(),
});
export type ApprovalHistory = z.infer<typeof ApprovalHistorySchema>;

// ───────────── Step and definition views ─────────────

export const StepInstanceSchema = z.object({
  id: z.number().int(),
  stepNo: z.number().int(),
  round: z.number().int(),
  name: z.string(),
  status: StepStatusSchema,
  isMandatory: z.boolean(),
  assignee: WorkflowPersonSchema,
  delegatedFrom: WorkflowPersonSchema.nullable(),
  dueAt: TimestampSchema.nullable(),
  parkedUntil: TimestampSchema.nullable(),
  actedAt: TimestampSchema.nullable(),
});
export type StepInstance = z.infer<typeof StepInstanceSchema>;

/** GET /workflow/can-start?type=&discriminator= (= employeeCanStartWorkflow, section 7.3). */
export const CanStartQuerySchema = z.object({
  type: WorkflowTypeCodeSchema,
  discriminator: z.string().trim().min(1).max(100).optional(),
});
export type CanStartQuery = z.infer<typeof CanStartQuerySchema>;

export const CanStartResponseSchema = z.object({
  type: WorkflowTypeCodeSchema,
  employeeId: z.number().int(),
  canStart: z.boolean(),
});
export type CanStartResponse = z.infer<typeof CanStartResponseSchema>;

/**
 * GET /workflow/pay-periods?companyRuleId= (PAYROLL_ADMIN): open periods to process approved items
 * into. Pass the applicant's `companyRuleId` (on the inbox card) to list only the periods the item
 * can be processed into.
 */
export const PayPeriodsQuerySchema = z.object({
  companyRuleId: z.coerce.number().int().positive().optional(),
});
export type PayPeriodsQuery = z.infer<typeof PayPeriodsQuerySchema>;

/** An open pay period of a company rule. */
export const PayPeriodSchema = z.object({
  id: z.number().int(),
  companyRuleId: z.number().int(),
  companyRule: z.string(),
  description: z.string(),
  startDate: BusinessDateSchema,
  endDate: BusinessDateSchema,
  payDate: BusinessDateSchema.nullable(),
  isClosed: z.boolean(),
});
export type PayPeriod = z.infer<typeof PayPeriodSchema>;

export const PayPeriodsResponseSchema = z.object({ items: z.array(PayPeriodSchema) });
export type PayPeriodsResponse = z.infer<typeof PayPeriodsResponseSchema>;

/** GET /workflow/user-options?search=: people a step can be reassigned to (same company). */
export const UserOptionsQuerySchema = z.object({ search: z.string().trim().max(100).optional() });
export type UserOptionsQuery = z.infer<typeof UserOptionsQuerySchema>;

export const UserOptionSchema = z.object({
  userId: z.string(),
  name: z.string(),
  displayName: z.string(),
  employeeCode: z.string().nullable(),
  roles: z.array(RoleSchema),
});
export type UserOption = z.infer<typeof UserOptionSchema>;

export const USER_OPTIONS_LIMIT = 50;

export const UserOptionsResponseSchema = z.object({
  items: z.array(UserOptionSchema),
  truncated: z.boolean(),
});
export type UserOptionsResponse = z.infer<typeof UserOptionsResponseSchema>;

/** Problem `type` values of workflow errors the web app branches on. */
export const WORKFLOW_PROBLEM_TYPES = {
  notAssignee: 'urn:peoplehub:problem:workflow-not-assignee',
  ownRequest: 'urn:peoplehub:problem:workflow-own-request',
  noApprover: 'urn:peoplehub:problem:workflow-no-approver',
  notAllowed: 'urn:peoplehub:problem:workflow-action-not-allowed',
} as const;
