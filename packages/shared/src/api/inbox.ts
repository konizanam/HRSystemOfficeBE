import { z } from 'zod';
import { ProcessStatusSchema, type WorkflowTypeCode, WorkflowTypeCodeSchema } from '../enums';
import { BusinessDateSchema, pageOf, TimestampSchema } from './common';
import { StepInstanceSchema, WorkflowPersonSchema } from './workflow';

// Contracts for the inbox (sections 5.10 and 12.7): the category panel, the three tabs, the
// item cards and the detail panel.

/** Left-panel categories, in the order the source shows them (section 5.10), plus "Other". */
export const INBOX_CATEGORIES = [
  'LEAVE',
  'PERSONAL_DETAILS',
  'BANK_DETAILS',
  'FREE_TEXT',
  'CLAIMS',
  'BENEFICIARIES',
  'JOB_REQUISITION',
  'CHECKLIST',
  'OTHER',
] as const;
export const InboxCategorySchema = z.enum(INBOX_CATEGORIES);
export type InboxCategory = z.infer<typeof InboxCategorySchema>;

export const INBOX_CATEGORY_LABELS: Record<InboxCategory, string> = {
  LEAVE: 'Leave',
  PERSONAL_DETAILS: 'Personal Details',
  BANK_DETAILS: 'Bank Details',
  FREE_TEXT: 'Free Text',
  CLAIMS: 'Claims',
  BENEFICIARIES: 'Beneficiaries',
  JOB_REQUISITION: 'Job Requisition',
  CHECKLIST: 'Checklist',
  OTHER: 'Other',
};

/** Which category each workflow type is counted under (ASSUMPTION, see docs/ASSUMPTIONS.md). */
export const WORKFLOW_TYPE_CATEGORY: Record<WorkflowTypeCode, InboxCategory> = {
  LEAVE: 'LEAVE',
  CANCELLEAVE: 'LEAVE',
  CREDITLVEALLOC: 'LEAVE',
  CREDITLVEREQ: 'LEAVE',
  BASICINF: 'PERSONAL_DETAILS',
  DRIVERSLICENSE: 'PERSONAL_DETAILS',
  BANKDET: 'BANK_DETAILS',
  FREETEXT: 'FREE_TEXT',
  FREETEXTMANEMP: 'FREE_TEXT',
  CLAIMS: 'CLAIMS',
  GROUPEDCLAIM: 'CLAIMS',
  BENEFICIARY: 'BENEFICIARIES',
  JOBREQUISITION: 'JOB_REQUISITION',
  CHECKLISTITEM: 'CHECKLIST',
  TRAINING: 'OTHER',
  QUALIFICATION: 'OTHER',
};

export function workflowTypesInCategory(category: InboxCategory): WorkflowTypeCode[] {
  return (Object.keys(WORKFLOW_TYPE_CATEGORY) as WorkflowTypeCode[]).filter(
    (type) => WORKFLOW_TYPE_CATEGORY[type] === category,
  );
}

/**
 * Inbox tabs (section 5.10): `action` = Action Required, `submitted` = my in-flight items,
 * `history` = finished items and items I acted on. `process` lists items waiting for payroll
 * processing (PAYROLL_ADMIN only).
 */
export const INBOX_BOXES = ['action', 'submitted', 'history', 'process'] as const;
export const InboxBoxSchema = z.enum(INBOX_BOXES);
export type InboxBox = z.infer<typeof InboxBoxSchema>;

export const INBOX_SORTS = [
  'submittedAt:desc',
  'submittedAt:asc',
  'applicant:asc',
  'applicant:desc',
  'type:asc',
  'type:desc',
] as const;
export const InboxSortSchema = z.enum(INBOX_SORTS);
export type InboxSort = z.infer<typeof InboxSortSchema>;

/** GET /inbox/items. `filter` matches the applicant's name or code and the summary. */
export const InboxItemsQuerySchema = z.object({
  box: InboxBoxSchema.default('action'),
  type: WorkflowTypeCodeSchema.optional(),
  category: InboxCategorySchema.optional(),
  filter: z.string().trim().max(100).optional(),
  sort: InboxSortSchema.default('submittedAt:desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type InboxItemsQuery = z.infer<typeof InboxItemsQuerySchema>;

export const InboxApplicantSchema = z.object({
  employeeId: z.number().int(),
  employeeCode: z.string(),
  firstName: z.string(),
  lastName: z.string(),
});
export type InboxApplicant = z.infer<typeof InboxApplicantSchema>;

/** A card in the middle panel (section 5.10). */
export const InboxCardSchema = z.object({
  processId: z.number().int(),
  /** Send with the next action (optimistic concurrency). */
  version: z.number().int(),
  workflowType: WorkflowTypeCodeSchema,
  /** e.g. "Leave Workflow Process". */
  typeLabel: z.string(),
  /** e.g. "Annual Leave" (from the subject handler). */
  requestLabel: z.string(),
  category: InboxCategorySchema,
  /** "{First} {Last} - {EmpCode}". */
  title: z.string(),
  applicant: InboxApplicantSchema,
  fromDate: BusinessDateSchema.nullable(),
  toDate: BusinessDateSchema.nullable(),
  /** "from 24 Sep 2026 to 26 Sep 2026", or null when the subject has no dates. */
  periodText: z.string().nullable(),
  status: ProcessStatusSchema,
  statusLabel: z.string(),
  /** "Status: In Progress". */
  statusText: z.string(),
  /** e.g. "3.0000 Days to be deducted"; null when the type has no units. */
  unitsLine: z.string().nullable(),
  summary: z.string(),
  submittedAt: TimestampSchema.nullable(),
  /** "dd MMM yyyy". */
  submittedDate: z.string(),
  currentStepNo: z.number().int().nullable(),
  isEscalated: z.boolean(),
  /** The caller's step is parked (only possible in the history tab or once it is due). */
  parkedUntil: TimestampSchema.nullable(),
  /** The caller can approve or decline it now. */
  canAct: z.boolean(),
  /** Link text, e.g. "View leave request". */
  viewLabel: z.string(),
});
export type InboxCard = z.infer<typeof InboxCardSchema>;

export const InboxItemsResponseSchema = pageOf(InboxCardSchema);
export type InboxItemsResponse = z.infer<typeof InboxItemsResponseSchema>;

export const InboxCategoryCountSchema = z.object({
  category: InboxCategorySchema,
  label: z.string(),
  count: z.number().int(),
  workflowTypes: z.array(WorkflowTypeCodeSchema),
});
export type InboxCategoryCount = z.infer<typeof InboxCategoryCountSchema>;

/**
 * GET /inbox/categories. Each list holds only categories that have items or that the acting-as
 * employee can start (section 5.10: "Show only types that have items or are enabled").
 */
export const InboxCategoriesResponseSchema = z.object({
  submitted: z.array(InboxCategoryCountSchema),
  /** Empty unless `isApprover`. */
  approvals: z.array(InboxCategoryCountSchema),
  /** Show the "Approvals" panel: the user approves (by role or because something was assigned). */
  isApprover: z.boolean(),
  /** Tab counts: Action Required (n) / Submitted (n) / History (n). */
  tabs: z.object({
    action: z.number().int(),
    submitted: z.number().int(),
    history: z.number().int(),
  }),
  /** Items awaiting payroll processing; null unless PAYROLL_ADMIN. */
  pendingProcess: z.number().int().nullable(),
  /** "My Notifications" badge. */
  unreadNotifications: z.number().int(),
});
export type InboxCategoriesResponse = z.infer<typeof InboxCategoriesResponseSchema>;

/** A label/value pair in the detail panel ("Leave type: Annual Leave"). */
export const SubjectFieldSchema = z.object({
  label: z.string(),
  value: z.string(),
});
export type SubjectField = z.infer<typeof SubjectFieldSchema>;

/** The subject DTO a workflow type's handler returns for the detail panel. */
export const SubjectDetailSchema = z.object({
  /** Panel heading, e.g. "Leave request". */
  title: z.string(),
  requestLabel: z.string(),
  /** The highlighted figures, e.g. "Days available", "Days to be deducted". */
  headline: z.array(SubjectFieldSchema),
  /** The field list in display order. */
  fields: z.array(SubjectFieldSchema),
  /** Type-specific data for richer UIs (shape defined by each type's contract). */
  data: z.record(z.unknown()),
});
export type SubjectDetail = z.infer<typeof SubjectDetailSchema>;

export const InboxAttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  uploadedAt: TimestampSchema,
  /** Download goes through the audited attachment endpoint. */
  downloadUrl: z.string(),
});
export type InboxAttachment = z.infer<typeof InboxAttachmentSchema>;

export const InboxCommentSchema = z.object({
  actionId: z.number().int(),
  at: TimestampSchema,
  author: WorkflowPersonSchema.nullable(),
  action: z.string(),
  stepNo: z.number().int().nullable(),
  comment: z.string(),
});
export type InboxComment = z.infer<typeof InboxCommentSchema>;

export const INBOX_ACTIONS = [
  'APPROVE',
  'DECLINE',
  'REASSIGN',
  'PARK',
  'SEND_BACK',
  'COMMENT',
  'WITHDRAW',
  'RESUBMIT',
  'PROCESS',
] as const;
export const InboxActionSchema = z.enum(INBOX_ACTIONS);
export type InboxAction = z.infer<typeof InboxActionSchema>;

/** A warning shown above the approver buttons, e.g. a negative leave balance (section 5.10). */
export const InboxWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type InboxWarning = z.infer<typeof InboxWarningSchema>;

/** GET /inbox/items/:processId: the right-hand detail panel. */
export const InboxItemDetailSchema = z.object({
  card: InboxCardSchema,
  subject: SubjectDetailSchema,
  submittedBy: WorkflowPersonSchema,
  submittedOnBehalf: z.boolean(),
  attachments: z.array(InboxAttachmentSchema),
  /** Comments from the applicant and every approver, oldest first. */
  comments: z.array(InboxCommentSchema),
  /** What the caller may do now; drive the buttons from this list. */
  allowedActions: z.array(InboxActionSchema),
  warnings: z.array(InboxWarningSchema),
  /** Step instances of the current round. */
  steps: z.array(StepInstanceSchema),
});
export type InboxItemDetail = z.infer<typeof InboxItemDetailSchema>;
