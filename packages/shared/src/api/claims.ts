import { z } from 'zod';
import { dec } from '../decimal';
import {
  CAP_MODE_LABELS,
  CapCycleSchema,
  CapModeSchema,
  CLAIM_STATUS_FILTERS,
  ClaimInputModeSchema,
  type CapCycle,
  type ClaimStatusFilter,
  ProcessStatusSchema,
  WorkflowTypeCodeSchema,
} from '../enums';
import { CLAIM_TIME_PATTERN } from '../claims';
import { AttachmentIdsSchema, AttachmentSchema } from './attachments';
import { BusinessDateSchema, DecimalStringSchema, pageOf, ProblemSchema, TimestampSchema } from './common';
import { ApprovalHistorySchema } from './workflow';

// Contracts for Claims (sections 5.3 and 12.4): the Submit tiles, a group's setup (types, rates,
// caps), drafts ("Saved") with their lines grid, submit, cancel, My Expense Claims with its
// audited export, the claim detail with the approval history, the balances grid and the
// HR/Payroll admin API. Amounts are 2-dp decimal strings ("250.00"); quantities and rates are
// 4-dp strings ("7.5000"); dates are YYYY-MM-DD; the server computes every amount and total.

/** Longest claim and line description. */
export const CLAIM_DESCRIPTION_MAX = 500;

/** Most lines on one claim. */
export const CLAIM_MAX_LINES = 100;

/** Most rows in one My Expense Claims export. */
export const CLAIM_EXPORT_MAX_ROWS = 10_000;

/** Decimal string with at most 2 places, ≥ 0 (money). */
export const Money2Schema = DecimalStringSchema.refine(
  (v) => dec(v).decimalPlaces() <= 2,
  'Use at most 2 decimal places',
).refine((v) => dec(v).gte(0), 'Cannot be negative');

/** Decimal string with at most 4 places, ≥ 0 (quantities and rates). */
export const Quantity4Schema = DecimalStringSchema.refine(
  (v) => dec(v).decimalPlaces() <= 4,
  'Use at most 4 decimal places',
).refine((v) => dec(v).gte(0), 'Cannot be negative');

/** Signed 2-dp money (balance adjustments). */
const SignedMoney2Schema = DecimalStringSchema.refine(
  (v) => dec(v).decimalPlaces() <= 2,
  'Use at most 2 decimal places',
);
/** Signed 4-dp quantity (balance adjustments). */
const SignedQuantity4Schema = DecimalStringSchema.refine(
  (v) => dec(v).decimalPlaces() <= 4,
  'Use at most 4 decimal places',
);

export const ClaimTimeSchema = z.string().regex(CLAIM_TIME_PATTERN, 'Use a time such as 17:30');

export const CAP_CYCLE_LABELS: Record<CapCycle, string> = {
  PAY_PERIOD: 'Pay period',
  MONTHLY: 'Monthly',
  ANNUAL: 'Annual',
};

/** The "Capping Applied" values of the balances grid (section 5.3.3). */
export const CappingAppliedSchema = z.enum([
  CAP_MODE_LABELS.NO_CAP,
  CAP_MODE_LABELS.WARN,
  CAP_MODE_LABELS.BLOCK,
]);
export type CappingApplied = z.infer<typeof CappingAppliedSchema>;

// ───────────── References ─────────────

export const ClaimGroupRefSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  description: z.string(),
});
export type ClaimGroupRef = z.infer<typeof ClaimGroupRefSchema>;

export const ClaimTypeRefSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  description: z.string(),
  inputMode: ClaimInputModeSchema,
});
export type ClaimTypeRef = z.infer<typeof ClaimTypeRefSchema>;

export const ClaimEmployeeRefSchema = z.object({
  id: z.number().int(),
  employeeCode: z.string(),
  firstName: z.string(),
  lastName: z.string(),
});
export type ClaimEmployeeRef = z.infer<typeof ClaimEmployeeRefSchema>;

/** `?employeeId=` (default: the acting-as employee). */
export const ClaimEmployeeQuerySchema = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
});
export type ClaimEmployeeQuery = z.infer<typeof ClaimEmployeeQuerySchema>;

// ───────────── Submit tiles (section 5.3.1) ─────────────

/** One tile on the Submit page: "Submitted n", "Saved n" and Apply. */
export const ClaimGroupTileSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  description: z.string(),
  attachmentMandatory: z.boolean(),
  /** Claims in flight (In Progress, Resubmission Required, Pending Processing). */
  submittedCount: z.number().int(),
  /** Drafts ("Saved"). */
  savedCount: z.number().int(),
  /** Claim types of the group the employee's company rule may claim. */
  typeCount: z.number().int(),
  /** = employeeCanStartWorkflow(GROUPEDCLAIM, groupId); show the tile only when true. */
  canStart: z.boolean(),
});
export type ClaimGroupTile = z.infer<typeof ClaimGroupTileSchema>;

/** GET /claims/groups?employeeId=. */
export const ClaimGroupsResponseSchema = z.object({
  employeeId: z.number().int(),
  items: z.array(ClaimGroupTileSchema),
});
export type ClaimGroupsResponse = z.infer<typeof ClaimGroupsResponseSchema>;

// ───────────── Group setup (the editor) ─────────────

export const ClaimCapSummarySchema = z.object({
  id: z.number().int(),
  cycle: CapCycleSchema,
  cycleLabel: z.string(),
  mode: CapModeSchema,
  /** "No Cap", "Warn" or "Block". */
  modeLabel: CappingAppliedSchema,
  /** Null = no amount limit. */
  amountLimit: DecimalStringSchema.nullable(),
  /** Null = no quantity limit. */
  quantityLimit: DecimalStringSchema.nullable(),
  /** The limit is scaled by the months employed in the cycle. */
  proRata: z.boolean(),
  /** Null = every company rule. */
  companyRuleId: z.number().int().nullable(),
});
export type ClaimCapSummary = z.infer<typeof ClaimCapSummarySchema>;

export const ClaimRateSourceSchema = z.enum(['TYPE', 'EMPLOYEE_HOURLY_RATE']);

/** A claim type the employee may claim, with how its lines are entered and paid. */
export const ClaimTypeSetupSchema = ClaimTypeRefSchema.extend({
  inputModeLabel: z.string(),
  /** Column label for the quantity ("Hours", "Kilometres", "Quantity"); null for AMOUNT. */
  quantityLabel: z.string().nullable(),
  /** HOURS: start and end time may be entered (the hours then come from them). */
  usesTimes: z.boolean(),
  /** `ClaimType.rate` (rate per km for KILOMETRES). */
  rate: DecimalStringSchema.nullable(),
  /** HOURS: multiplier on the employee's hourly rate (e.g. "1.5000"). */
  rateMultiplier: DecimalStringSchema.nullable(),
  /** The rate lines are paid at for this employee; null for AMOUNT or when no rate is set. */
  effectiveRate: DecimalStringSchema.nullable(),
  rateSource: ClaimRateSourceSchema.nullable(),
  /** Each line of this type needs an attachment. */
  requiresAttachment: z.boolean(),
  payrollCode: z.string().nullable(),
  caps: z.array(ClaimCapSummarySchema),
});
export type ClaimTypeSetup = z.infer<typeof ClaimTypeSetupSchema>;

/** GET /claims/groups/:id/setup?employeeId=. */
export const ClaimGroupSetupResponseSchema = z.object({
  employeeId: z.number().int(),
  currency: z.string(),
  group: ClaimGroupRefSchema.extend({
    /** The claim needs at least one attachment (on the claim or any line). */
    attachmentMandatory: z.boolean(),
  }),
  canStart: z.boolean(),
  types: z.array(ClaimTypeSetupSchema),
});
export type ClaimGroupSetupResponse = z.infer<typeof ClaimGroupSetupResponseSchema>;

// ───────────── Drafts (Save) ─────────────

/**
 * One row of the lines grid. Send `id` to keep an existing line of the draft (lines left out are
 * removed). The server computes `amount` from the input mode; `amount` is only read for AMOUNT
 * types. For HOURS, start and end time (both or neither) give the hours.
 */
export const ClaimLineInputSchema = z
  .object({
    id: z.number().int().positive().optional(),
    claimTypeId: z.number().int().positive(),
    date: BusinessDateSchema,
    startTime: ClaimTimeSchema.nullable().optional(),
    endTime: ClaimTimeSchema.nullable().optional(),
    quantity: Quantity4Schema.nullable().optional(),
    amount: Money2Schema.nullable().optional(),
    description: z.string().trim().max(CLAIM_DESCRIPTION_MAX).nullable().optional(),
    /** New uploads (POST /attachments) to attach to this line. */
    attachmentIds: AttachmentIdsSchema.default([]),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.startTime) !== Boolean(value.endTime)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [value.startTime ? 'endTime' : 'startTime'],
        message: 'Enter both the start and the end time',
      });
    }
  });
export type ClaimLineInput = z.infer<typeof ClaimLineInputSchema>;

const LinesSchema = z
  .array(ClaimLineInputSchema)
  .max(CLAIM_MAX_LINES, `Use at most ${CLAIM_MAX_LINES} lines`)
  .refine((lines) => {
    const ids = lines.map((l) => l.id).filter((id): id is number => id !== undefined);
    return new Set(ids).size === ids.length;
  }, 'The same line is listed twice');

/** POST /claims: saves a new draft ("Saved"). */
export const CreateClaimRequestSchema = z.object({
  /** The claim is for (default: the acting-as employee): self or a permitted report. */
  employeeId: z.number().int().positive().optional(),
  groupId: z.number().int().positive(),
  description: z.string().trim().max(CLAIM_DESCRIPTION_MAX).nullable().optional(),
  lines: LinesSchema.default([]),
  /** New uploads to attach to the claim itself. */
  attachmentIds: AttachmentIdsSchema.default([]),
});
export type CreateClaimRequest = z.infer<typeof CreateClaimRequestSchema>;

/** PUT /claims/:id: replaces the draft's header and lines (send the `version` read; 409 when stale). */
export const UpdateClaimRequestSchema = z.object({
  version: z.number().int().positive(),
  description: z.string().trim().max(CLAIM_DESCRIPTION_MAX).nullable().optional(),
  lines: LinesSchema,
  attachmentIds: AttachmentIdsSchema.default([]),
  /** Attachments of this claim or its lines to remove. */
  removeAttachmentIds: AttachmentIdsSchema.default([]),
});
export type UpdateClaimRequest = z.infer<typeof UpdateClaimRequestSchema>;

/**
 * The editable fields when a sent-back claim is resubmitted
 * (`POST /workflow/processes/:id/resubmit` with `changes`). Omitted fields keep their value;
 * `lines`, when given, replaces the lines as in PUT /claims/:id.
 *
 * A 422 of the resubmit points at lines by index, counted from 0 in the order of `changes.lines`
 * as sent: `changes.lines.{i}.…` for the edits themselves, `lines.{i}.…` for the submit checks and
 * the caps, and the cap findings' `lineIndex` / `lineIndexes` (ClaimCapProblem). When `lines` is
 * left out, the indexes count the saved lines in the order the claim detail lists them.
 */
export const ClaimResubmitChangesSchema = z
  .object({
    description: z.string().trim().max(CLAIM_DESCRIPTION_MAX).nullable(),
    lines: LinesSchema,
    attachmentIds: AttachmentIdsSchema,
    removeAttachmentIds: AttachmentIdsSchema,
  })
  .partial()
  .strict();
export type ClaimResubmitChanges = z.infer<typeof ClaimResubmitChangesSchema>;

/** POST /claims/:id/submit (send an `Idempotency-Key`). */
export const SubmitClaimRequestSchema = z.object({ version: z.number().int().positive() });
export type SubmitClaimRequest = z.infer<typeof SubmitClaimRequestSchema>;

/** POST /claims/:id/cancel (send an `Idempotency-Key`). */
export const CancelClaimRequestSchema = z.object({
  version: z.number().int().positive(),
  comment: z.string().trim().max(2000).optional(),
});
export type CancelClaimRequest = z.infer<typeof CancelClaimRequestSchema>;

/**
 * What Cancel does for a claim now: DISCARD a draft, WITHDRAW a request nobody has acted on (or
 * one sent back), or CANCEL it through the workflow (HR/Payroll only, once approval has started).
 */
export const CLAIM_CANCEL_ACTIONS = ['DISCARD', 'WITHDRAW', 'CANCEL'] as const;
export const ClaimCancelActionSchema = z.enum(CLAIM_CANCEL_ACTIONS);
export type ClaimCancelAction = z.infer<typeof ClaimCancelActionSchema>;

// ───────────── Cap warnings ─────────────

export const CLAIM_CAP_MEASURES = ['AMOUNT', 'QUANTITY'] as const;
export const ClaimCapMeasureSchema = z.enum(CLAIM_CAP_MEASURES);
export type ClaimCapMeasure = z.infer<typeof ClaimCapMeasureSchema>;

/**
 * A cap the claim exceeds in one cycle. WARN: the claim may still be submitted and the warning is
 * stored on it (`Claim.warnings`, shown to approvers); BLOCK: the submit fails with 422.
 */
export const ClaimCapWarningSchema = z.object({
  code: z.literal('CAP_EXCEEDED'),
  mode: z.enum(['WARN', 'BLOCK']),
  capId: z.number().int(),
  claimTypeId: z.number().int(),
  claimType: z.string(),
  cycle: CapCycleSchema,
  cycleStartDate: BusinessDateSchema,
  cycleEndDate: BusinessDateSchema,
  measure: ClaimCapMeasureSchema,
  /** The limit that applies (the pro-rata limit when the cap is pro-rata). */
  limit: DecimalStringSchema,
  /** Available before this claim. */
  available: DecimalStringSchema,
  /** This claim's lines of the type in the cycle. */
  requested: DecimalStringSchema,
  message: z.string(),
  /**
   * Index (in the claim's `lines`, 0-based) of the first line counted against the cap; a BLOCK
   * error's path is `lines.{lineIndex}.amount` or `.quantity`. The lines are those of the request
   * that was checked, in the order they were sent: the body of POST /claims or PUT /claims/:id, or
   * `changes.lines` of a resubmit (a resubmit without `changes.lines` checks the saved lines, in
   * the order the claim detail lists them). Null on warnings stored before this field existed.
   */
  lineIndex: z.number().int().nullable().default(null),
  /** The saved line's id (null for an unsaved line or an older stored warning). */
  lineId: z.number().int().nullable().default(null),
  /** Every line of the claim counted against the cap in this cycle (indexes in `lines`). */
  lineIndexes: z.array(z.number().int()).default([]),
});
export type ClaimCapWarning = z.infer<typeof ClaimCapWarningSchema>;

/** The live cap check of a draft or sent-back claim (what submit would do now). */
export const ClaimCapCheckSchema = z.object({
  warnings: z.array(ClaimCapWarningSchema),
  blocks: z.array(ClaimCapWarningSchema),
});
export type ClaimCapCheck = z.infer<typeof ClaimCapCheckSchema>;

// ───────────── Read models ─────────────

export const ClaimLineSchema = z.object({
  id: z.number().int(),
  sortOrder: z.number().int(),
  claimType: ClaimTypeRefSchema,
  date: BusinessDateSchema,
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  /** Hours, kilometres or a count (4 dp); null for AMOUNT lines. */
  quantity: DecimalStringSchema.nullable(),
  /**
   * Display form of `quantity` without trailing zeros ("2.5" for "2.5000"); null for AMOUNT lines.
   * Send `quantity` (4 dp) back when saving; this is for display only.
   */
  quantityDisplay: z.string().nullable(),
  /** 4 dp; null for AMOUNT lines. */
  rate: DecimalStringSchema.nullable(),
  /** 2 dp, computed by the server. */
  amount: DecimalStringSchema,
  description: z.string().nullable(),
  attachments: z.array(AttachmentSchema),
});
export type ClaimLine = z.infer<typeof ClaimLineSchema>;

/** One row of My Expense Claims and the Saved Claims list (section 5.3.2). */
export const ClaimRowSchema = z.object({
  id: z.number().int(),
  /** Send with update, submit and cancel (optimistic concurrency). */
  version: z.number().int(),
  /** Null while the claim is a draft. */
  referenceNumber: z.string().nullable(),
  employee: ClaimEmployeeRefSchema,
  group: ClaimGroupRefSchema,
  description: z.string().nullable(),
  status: ProcessStatusSchema,
  /** "Saved", "In Progress", "Pending Processing", "Processed", "Cancelled", "Declined", … */
  statusLabel: z.string(),
  /** The status filter bucket the claim falls in. */
  statusFilter: z.enum(CLAIM_STATUS_FILTERS).nullable(),
  totalAmount: DecimalStringSchema,
  currency: z.string(),
  lineCount: z.number().int(),
  createdAt: TimestampSchema,
  /** "dd-MMM-yyyy" of the creation date. */
  createdDate: z.string(),
  submittedAt: TimestampSchema.nullable(),
  /** "dd-MMM-yyyy"; empty while saved. */
  submittedDate: z.string(),
  approvedAt: TimestampSchema.nullable(),
  /** "{Title} {Initials} {Surname}" of the final approver. */
  finalApprover: z.string().nullable(),
  processedAt: TimestampSchema.nullable(),
  processId: z.number().int().nullable(),
  /** GROUPEDCLAIM or CLAIMS once submitted. */
  workflowType: WorkflowTypeCodeSchema.nullable(),
  /** Cap warnings were stored on submit. */
  hasWarnings: z.boolean(),
  /** "Resume if saved": the caller may edit this draft. */
  canResume: z.boolean(),
  /** What Cancel does now; null = not available to the caller. */
  cancelAction: ClaimCancelActionSchema.nullable(),
});
export type ClaimRow = z.infer<typeof ClaimRowSchema>;

/** GET /claims/:id (also the response of create, update, submit and cancel). */
export const ClaimDetailSchema = ClaimRowSchema.extend({
  attachmentMandatory: z.boolean(),
  lines: z.array(ClaimLineSchema),
  /** Attachments of the claim itself (line attachments are on each line). */
  attachments: z.array(AttachmentSchema),
  /** Cap warnings stored when the claim was submitted (WARN caps). */
  warnings: z.array(ClaimCapWarningSchema),
  /** Drafts and sent-back claims: what submitting now would warn about or block. */
  capCheck: ClaimCapCheckSchema.nullable(),
  /** Drafts and sent-back claims: what is still missing before it can be submitted. */
  submitProblems: z.array(z.object({ path: z.string(), message: z.string() })),
  payPeriod: z.object({ id: z.number().int(), description: z.string() }).nullable(),
  /** The caller may change this draft (PUT) and submit it. */
  canEdit: z.boolean(),
  /** Null for a draft (no workflow yet). */
  approvalHistory: ApprovalHistorySchema.nullable(),
  /**
   * The workflow process's `version`: send it with the workflow actions on this claim (resubmit,
   * withdraw), without reading the inbox first. Null for a draft.
   */
  processVersion: z.number().int().nullable(),
  /**
   * The caller may resubmit the claim now (`POST /workflow/processes/:id/resubmit` with
   * `changes`): true only for the applicant (or someone working as them) or the person who
   * submitted it, while the process is RESUBMIT_REQUIRED. Show the resubmit editor from this.
   */
  canResubmit: z.boolean(),
});
export type ClaimDetail = z.infer<typeof ClaimDetailSchema>;

/**
 * `subject.data` of a claim in the inbox detail (GROUPEDCLAIM and CLAIMS): the group, description,
 * lines and total. Line attachments are listed with the request's attachments.
 */
export const ClaimSubjectDataSchema = z.object({
  claimId: z.number().int(),
  referenceNumber: z.string().nullable(),
  group: ClaimGroupRefSchema,
  description: z.string().nullable(),
  currency: z.string(),
  totalAmount: DecimalStringSchema,
  lines: z.array(ClaimLineSchema.omit({ attachments: true })),
  warnings: z.array(ClaimCapWarningSchema),
});
export type ClaimSubjectData = z.infer<typeof ClaimSubjectDataSchema>;

// ───────────── Saved claims ─────────────

/** "Sort by" of the Saved Claims list (section 5.3.1). */
export const SAVED_CLAIM_SORTS = ['applicant', 'type', 'dateCreated'] as const;
export const SavedClaimSortSchema = z.enum(SAVED_CLAIM_SORTS);
export type SavedClaimSort = z.infer<typeof SavedClaimSortSchema>;
export const SAVED_CLAIM_SORT_LABELS: Record<SavedClaimSort, string> = {
  applicant: 'Applicant',
  type: 'Type',
  dateCreated: 'Date Created',
};

/**
 * GET /claims/saved: drafts of the acting-as employee (and, when not working as someone else,
 * drafts the caller saved for others). `filter` matches the applicant, the group and the
 * description.
 */
export const SavedClaimsQuerySchema = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
  groupId: z.coerce.number().int().positive().optional(),
  filter: z.string().trim().max(100).optional(),
  sort: SavedClaimSortSchema.default('dateCreated'),
  order: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type SavedClaimsQuery = z.infer<typeof SavedClaimsQuerySchema>;

export const SavedClaimsResponseSchema = pageOf(ClaimRowSchema);
export type SavedClaimsResponse = z.infer<typeof SavedClaimsResponseSchema>;

// ───────────── My Expense Claims (section 5.3.2) ─────────────

/**
 * Whose claims: `self` = the acting-as employee (or `employeeId`); `reports` = the signed-in
 * manager's reports (MANAGER); `company` = everyone in the caller's companies (HR/Payroll).
 */
export const CLAIM_LIST_SCOPES = ['self', 'reports', 'company'] as const;
export const ClaimListScopeSchema = z.enum(CLAIM_LIST_SCOPES);
export type ClaimListScope = z.infer<typeof ClaimListScopeSchema>;

export const CLAIM_LIST_SORTS = [
  'submittedAt:desc',
  'submittedAt:asc',
  'createdAt:desc',
  'createdAt:asc',
  'total:desc',
  'total:asc',
  'reference:asc',
  'reference:desc',
  'applicant:asc',
  'applicant:desc',
] as const;
export const ClaimListSortSchema = z.enum(CLAIM_LIST_SORTS);
export type ClaimListSort = z.infer<typeof ClaimListSortSchema>;

const ClaimFilterShape = {
  /** Claim Type filter: a claim group id (omit for All). */
  type: z.coerce.number().int().positive().optional(),
  /** Description contains (case-insensitive). */
  description: z.string().trim().max(100).optional(),
  /** "All", "Saved", "In Progress", "Pending Processing", "Processed", "Cancelled / Declined". */
  status: z.enum(CLAIM_STATUS_FILTERS).default('All' satisfies ClaimStatusFilter),
  /** From/To Date: the submitted date (the created date for a draft), inclusive. */
  from: BusinessDateSchema.optional(),
  to: BusinessDateSchema.optional(),
  employeeId: z.coerce.number().int().positive().optional(),
  scope: ClaimListScopeSchema.default('self'),
  sort: ClaimListSortSchema.default('submittedAt:desc'),
};

function rangeCheck(value: { from?: string; to?: string }, ctx: z.RefinementCtx): void {
  if (value.from && value.to && value.to < value.from) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'To must be on or after From' });
  }
}

/** GET /claims?type=&description=&status=&from=&to=. */
export const ClaimsQuerySchema = z
  .object({
    ...ClaimFilterShape,
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .superRefine(rangeCheck);
export type ClaimsQuery = z.infer<typeof ClaimsQuerySchema>;

export const ClaimsResponseSchema = pageOf(ClaimRowSchema);
export type ClaimsResponse = z.infer<typeof ClaimsResponseSchema>;

export const CLAIM_EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export const ClaimExportFormatSchema = z.enum(CLAIM_EXPORT_FORMATS);
export type ClaimExportFormat = z.infer<typeof ClaimExportFormatSchema>;

/** GET /claims/export?…&format=csv|xlsx: the filtered grid, audited `EXPORT.CLAIMS`. */
export const ClaimsExportQuerySchema = z
  .object({ ...ClaimFilterShape, format: ClaimExportFormatSchema.default('csv') })
  .superRefine(rangeCheck);
export type ClaimsExportQuery = z.infer<typeof ClaimsExportQuerySchema>;

/** Columns of the export, in order. */
export const CLAIM_EXPORT_COLUMNS = [
  'Reference Number',
  'Employee Code',
  'Employee Name',
  'Claim Group',
  'Description',
  'Date Created',
  'Date Submitted',
  'Total',
  'Currency',
  'Status',
  'Final Approver',
  'Date Processed',
] as const;

// ───────────── Balances (section 5.3.3) ─────────────

/** GET /claims/balances?employeeId=&date= (date: the day whose cycles are shown; default today). */
export const ClaimBalancesQuerySchema = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
  date: BusinessDateSchema.optional(),
});
export type ClaimBalancesQuery = z.infer<typeof ClaimBalancesQuerySchema>;

/** One row per claim type and cap, with the exact section 5.3.3 columns. */
export const ClaimBalanceRowSchema = z.object({
  claimTypeId: z.number().int(),
  /** Claim Type. */
  claimType: z.string(),
  group: ClaimGroupRefSchema,
  capId: z.number().int(),
  cycle: CapCycleSchema,
  /** Cycle Start Date. */
  cycleStartDate: BusinessDateSchema,
  /** Cycle End Date. */
  cycleEndDate: BusinessDateSchema,
  /** Amount Capping Limit (null = no amount limit). */
  amountCappingLimit: DecimalStringSchema.nullable(),
  /** Pro Rata Capping Limit (null unless the cap is pro-rata and has an amount limit). */
  proRataCappingLimit: DecimalStringSchema.nullable(),
  /** Pending Amount Claimed: submitted, not yet processed. */
  pendingAmountClaimed: DecimalStringSchema,
  /** Amount Claimed: processed. */
  amountClaimed: DecimalStringSchema,
  /** Balance Adjustment Amount (payroll adjustments; positive adds to what is available). */
  balanceAdjustmentAmount: DecimalStringSchema,
  /** Amount Available = (pro-rata) limit − pending − claimed + adjustment; null without a limit. */
  amountAvailable: DecimalStringSchema.nullable(),
  /** Quantity Capping Limit (null = no quantity limit). Quantity Available uses the pro-rata limit when the cap is pro-rata. */
  quantityCappingLimit: DecimalStringSchema.nullable(),
  pendingQuantityClaimed: DecimalStringSchema,
  quantityClaimed: DecimalStringSchema,
  balanceAdjustmentQuantity: DecimalStringSchema,
  /** Null without a quantity limit. */
  quantityAvailable: DecimalStringSchema.nullable(),
  /** Capping Applied: "No Cap", "Warn" or "Block". */
  cappingApplied: CappingAppliedSchema,
  capMode: CapModeSchema,
  proRata: z.boolean(),
});
export type ClaimBalanceRow = z.infer<typeof ClaimBalanceRowSchema>;

/** The grid columns exactly as observed (section 5.3.3), keyed by row field. */
export const CLAIM_BALANCE_COLUMNS = [
  { key: 'claimType', label: 'Claim Type' },
  { key: 'cycleStartDate', label: 'Cycle Start Date' },
  { key: 'cycleEndDate', label: 'Cycle End Date' },
  { key: 'amountCappingLimit', label: 'Amount Capping Limit' },
  { key: 'proRataCappingLimit', label: 'Pro Rata Capping Limit' },
  { key: 'pendingAmountClaimed', label: 'Pending Amount Claimed' },
  { key: 'amountClaimed', label: 'Amount Claimed' },
  { key: 'balanceAdjustmentAmount', label: 'Balance Adjustment Amount' },
  { key: 'amountAvailable', label: 'Amount Available' },
  { key: 'quantityCappingLimit', label: 'Quantity Capping Limit' },
  { key: 'pendingQuantityClaimed', label: 'Pending Quantity Claimed' },
  { key: 'quantityClaimed', label: 'Quantity Claimed' },
  { key: 'balanceAdjustmentQuantity', label: 'Balance Adjustment Quantity' },
  { key: 'quantityAvailable', label: 'Quantity Available' },
  { key: 'cappingApplied', label: 'Capping Applied' },
] as const satisfies readonly { key: keyof ClaimBalanceRow; label: string }[];

export const ClaimBalancesResponseSchema = z.object({
  employeeId: z.number().int(),
  date: BusinessDateSchema,
  currency: z.string(),
  columns: z.array(z.object({ key: z.string(), label: z.string() })),
  items: z.array(ClaimBalanceRowSchema),
});
export type ClaimBalancesResponse = z.infer<typeof ClaimBalancesResponseSchema>;

// ───────────── Admin (HR_ADMIN / PAYROLL_ADMIN) ─────────────

const ClaimCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Z0-9_&]+$/, 'Use capitals, digits, _ and &');

export const AdminClaimGroupSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  description: z.string(),
  attachmentMandatory: z.boolean(),
  isActive: z.boolean(),
  version: z.number().int(),
});
export type AdminClaimGroup = z.infer<typeof AdminClaimGroupSchema>;

const ClaimGroupFields = {
  code: ClaimCodeSchema,
  description: z.string().trim().min(1).max(100),
  attachmentMandatory: z.boolean(),
  isActive: z.boolean(),
};

/** POST /admin/claim-groups. `id` is optional (the next free id is used). */
export const CreateClaimGroupRequestSchema = z.object({
  id: z.number().int().positive().max(9999).optional(),
  ...ClaimGroupFields,
  attachmentMandatory: ClaimGroupFields.attachmentMandatory.default(false),
  isActive: ClaimGroupFields.isActive.default(true),
});
export type CreateClaimGroupRequest = z.infer<typeof CreateClaimGroupRequestSchema>;

/** PUT /admin/claim-groups/:id. */
export const UpdateClaimGroupRequestSchema = z
  .object(ClaimGroupFields)
  .partial()
  .extend({ version: z.number().int().positive() })
  .strict();
export type UpdateClaimGroupRequest = z.infer<typeof UpdateClaimGroupRequestSchema>;

export const AdminClaimGroupsResponseSchema = z.object({ items: z.array(AdminClaimGroupSchema) });
export type AdminClaimGroupsResponse = z.infer<typeof AdminClaimGroupsResponseSchema>;

export const AdminClaimTypeSchema = z.object({
  id: z.number().int(),
  groupId: z.number().int(),
  code: z.string(),
  description: z.string(),
  inputMode: ClaimInputModeSchema,
  rate: DecimalStringSchema.nullable(),
  rateMultiplier: DecimalStringSchema.nullable(),
  payrollCode: z.string().nullable(),
  requiresAttachment: z.boolean(),
  isActive: z.boolean(),
  version: z.number().int(),
});
export type AdminClaimType = z.infer<typeof AdminClaimTypeSchema>;

const ClaimTypeFields = {
  code: ClaimCodeSchema,
  description: z.string().trim().min(1).max(100),
  inputMode: ClaimInputModeSchema,
  rate: Quantity4Schema.nullable(),
  rateMultiplier: Quantity4Schema.refine((v) => dec(v).lte(99), 'At most 99').nullable(),
  payrollCode: z.string().trim().min(1).max(30).nullable(),
  requiresAttachment: z.boolean(),
  isActive: z.boolean(),
};

/** POST /admin/claim-types. `id` is optional (the next free id is used). */
export const CreateClaimTypeRequestSchema = z.object({
  id: z.number().int().positive().max(9999).optional(),
  groupId: z.number().int().positive(),
  ...ClaimTypeFields,
  rate: ClaimTypeFields.rate.default(null),
  rateMultiplier: ClaimTypeFields.rateMultiplier.default(null),
  payrollCode: ClaimTypeFields.payrollCode.default(null),
  requiresAttachment: ClaimTypeFields.requiresAttachment.default(false),
  isActive: ClaimTypeFields.isActive.default(true),
});
export type CreateClaimTypeRequest = z.infer<typeof CreateClaimTypeRequestSchema>;

/** PUT /admin/claim-types/:id (the group cannot change). */
export const UpdateClaimTypeRequestSchema = z
  .object(ClaimTypeFields)
  .partial()
  .extend({ version: z.number().int().positive() })
  .strict();
export type UpdateClaimTypeRequest = z.infer<typeof UpdateClaimTypeRequestSchema>;

export const AdminClaimTypesQuerySchema = z.object({
  groupId: z.coerce.number().int().positive().optional(),
});
export type AdminClaimTypesQuery = z.infer<typeof AdminClaimTypesQuerySchema>;

export const AdminClaimTypesResponseSchema = z.object({ items: z.array(AdminClaimTypeSchema) });
export type AdminClaimTypesResponse = z.infer<typeof AdminClaimTypesResponseSchema>;

export const AdminClaimCapSchema = z.object({
  id: z.number().int(),
  claimTypeId: z.number().int(),
  /** Null = every company rule (a company rule's own caps win). */
  companyRuleId: z.number().int().nullable(),
  cycle: CapCycleSchema,
  mode: CapModeSchema,
  amountLimit: DecimalStringSchema.nullable(),
  quantityLimit: DecimalStringSchema.nullable(),
  proRata: z.boolean(),
  isActive: z.boolean(),
  version: z.number().int(),
});
export type AdminClaimCap = z.infer<typeof AdminClaimCapSchema>;

const ClaimCapFields = {
  cycle: CapCycleSchema,
  mode: CapModeSchema,
  amountLimit: Money2Schema.nullable(),
  quantityLimit: Quantity4Schema.nullable(),
  proRata: z.boolean(),
  isActive: z.boolean(),
};

/** POST /admin/claim-caps. */
export const CreateClaimCapRequestSchema = z.object({
  claimTypeId: z.number().int().positive(),
  companyRuleId: z.number().int().positive().nullable().default(null),
  ...ClaimCapFields,
  mode: ClaimCapFields.mode.default('NO_CAP'),
  amountLimit: ClaimCapFields.amountLimit.default(null),
  quantityLimit: ClaimCapFields.quantityLimit.default(null),
  proRata: ClaimCapFields.proRata.default(false),
  isActive: ClaimCapFields.isActive.default(true),
});
export type CreateClaimCapRequest = z.infer<typeof CreateClaimCapRequestSchema>;

/** PUT /admin/claim-caps/:id (the type and company rule cannot change). */
export const UpdateClaimCapRequestSchema = z
  .object(ClaimCapFields)
  .partial()
  .extend({ version: z.number().int().positive() })
  .strict();
export type UpdateClaimCapRequest = z.infer<typeof UpdateClaimCapRequestSchema>;

export const AdminClaimCapsQuerySchema = z.object({
  claimTypeId: z.coerce.number().int().positive().optional(),
});
export type AdminClaimCapsQuery = z.infer<typeof AdminClaimCapsQuerySchema>;

export const AdminClaimCapsResponseSchema = z.object({ items: z.array(AdminClaimCapSchema) });
export type AdminClaimCapsResponse = z.infer<typeof AdminClaimCapsResponseSchema>;

/**
 * POST /admin/claims/adjustments (PAYROLL_ADMIN): a ClaimBalanceAdjustment with a reason, for the
 * cycle of the type's cap that contains `date` (default today). `cycle` picks the cap when the
 * type has caps for several cycles. Positive values add to what is available.
 */
export const ClaimAdjustmentRequestSchema = z
  .object({
    employeeId: z.number().int().positive(),
    claimTypeId: z.number().int().positive(),
    cycle: CapCycleSchema.optional(),
    date: BusinessDateSchema.optional(),
    amount: SignedMoney2Schema.default('0'),
    quantity: SignedQuantity4Schema.default('0'),
    reason: z.string().trim().min(3, 'Give a reason').max(500),
  })
  .superRefine((value, ctx) => {
    if (dec(value.amount).isZero() && dec(value.quantity).isZero()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: 'Enter an amount or a quantity',
      });
    }
  });
export type ClaimAdjustmentRequest = z.infer<typeof ClaimAdjustmentRequestSchema>;

export const ClaimAdjustmentSchema = z.object({
  id: z.number().int(),
  employeeId: z.number().int(),
  claimTypeId: z.number().int(),
  cycle: CapCycleSchema,
  cycleStartDate: BusinessDateSchema,
  cycleEndDate: BusinessDateSchema,
  amount: DecimalStringSchema,
  quantity: DecimalStringSchema,
  reason: z.string(),
  createdByUserId: z.string(),
  createdAt: TimestampSchema,
});
export type ClaimAdjustment = z.infer<typeof ClaimAdjustmentSchema>;

/** Problem `type` values of claim errors the web app branches on. */
export const CLAIM_PROBLEM_TYPES = {
  /** A BLOCK cap would be exceeded (422; `errors` point at the lines). */
  capExceeded: 'urn:peoplehub:problem:claim-cap-exceeded',
  /** A mandatory attachment is missing (group or claim type). */
  attachmentRequired: 'urn:peoplehub:problem:claim-attachment-required',
  /** The claim is not a draft any more (or the caller may not edit it). */
  notEditable: 'urn:peoplehub:problem:claim-not-editable',
  /** The group cannot be claimed by this employee (no eligible type or no workflow). */
  notEligible: 'urn:peoplehub:problem:claim-not-eligible',
} as const;

/**
 * The 422 body of a submit (or resubmit) that a BLOCK cap stops (type `capExceeded`): the usual
 * `errors` (`lines.{i}.amount` / `.quantity`) plus the full findings, each with its
 * `lineIndex` and `lineId`.
 */
export const ClaimCapProblemSchema = ProblemSchema.extend({
  findings: z.array(ClaimCapWarningSchema),
});
export type ClaimCapProblem = z.infer<typeof ClaimCapProblemSchema>;
