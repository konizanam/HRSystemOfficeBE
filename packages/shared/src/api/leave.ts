import { z } from 'zod';
import { dec } from '../decimal';
import {
  AccrualMethodSchema,
  CreditLeaveKindSchema,
  type CreditLeaveKind,
  DayPortionSchema,
  LedgerEntryTypeSchema,
  LeaveUnitSchema,
  type ProcessStatus,
  ProcessStatusSchema,
} from '../enums';
import { AttachmentIdsSchema, AttachmentSchema } from './attachments';
import { BusinessDateSchema, DecimalStringSchema, pageOf, TimestampSchema } from './common';
import { ApprovalHistorySchema } from './workflow';

// Contracts for Leave (sections 5.2 and 12.3): leave types and reasons, the unit calculation
// behind the Apply page's live balance panel, submit, history, cancel, balances, leave in lieu,
// and the HR admin endpoints (adjustments, opening balances, types/reasons/policies CRUD).
// Units are decimal strings with 4 places ("3.8358"); dates are YYYY-MM-DD.

/** Longest "Any comments?" text (section 5.2.1). */
export const LEAVE_COMMENT_MAX = 1000;

/** Units label shown next to every figure ("Days"). */
export const LEAVE_UNIT_LABEL = 'Days';

/** Longest range one application may cover. */
export const LEAVE_MAX_RANGE_DAYS = 366;

/** Decimal string with at most 4 places. */
export const Units4Schema = DecimalStringSchema.refine(
  (v) => dec(v).decimalPlaces() <= 4,
  'Use at most 4 decimal places',
);

const PositiveUnitsSchema = Units4Schema.refine((v) => dec(v).gt(0), 'Units must be greater than 0');

// ───────────── Leave types and reasons ─────────────

export const LeavePolicySummarySchema = z.object({
  id: z.number().int(),
  /** The bucket name, e.g. "Annual Leave". */
  definitionName: z.string(),
  entitlementPerCycle: DecimalStringSchema,
  accrualMethod: AccrualMethodSchema,
  cycleMonths: z.number().int(),
  maxNegative: DecimalStringSchema,
});
export type LeavePolicySummary = z.infer<typeof LeavePolicySummarySchema>;

/** A leave type the employee may apply for, with its ESS flags. */
export const LeaveTypeSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  description: z.string(),
  /** Hex colour for badges and the calendar; null when not set. */
  colour: z.string().nullable(),
  unit: LeaveUnitSchema,
  isPaid: z.boolean(),
  mandatoryReason: z.boolean(),
  /** An attachment is required when the units exceed this; null = never. */
  requiresAttachmentAfterDays: DecimalStringSchema.nullable(),
  allowHalfDay: z.boolean(),
  allowNegative: z.boolean(),
  excludeWeekends: z.boolean(),
  excludePublicHolidays: z.boolean(),
  /** ESS: show the card but not the number. */
  hideUnitsAvailableForESS: z.boolean(),
  /** ESS: hide the balance card when nothing is available. */
  hideZeroUnitsAvailableForESS: z.boolean(),
  isCreditLeave: z.boolean(),
  /** True when the type has active reasons to pick from. */
  hasReasons: z.boolean(),
  policy: LeavePolicySummarySchema,
});
export type LeaveType = z.infer<typeof LeaveTypeSchema>;

/** GET /leave/types?employeeId= (default: the acting-as employee). */
export const LeaveTypesQuerySchema = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
});
export type LeaveTypesQuery = z.infer<typeof LeaveTypesQuerySchema>;

export const LeaveTypesResponseSchema = z.object({
  employeeId: z.number().int(),
  items: z.array(LeaveTypeSchema),
});
export type LeaveTypesResponse = z.infer<typeof LeaveTypesResponseSchema>;

export const LeaveReasonSchema = z.object({
  id: z.number().int(),
  leaveTypeId: z.number().int(),
  code: z.string(),
  description: z.string(),
});
export type LeaveReason = z.infer<typeof LeaveReasonSchema>;

/** GET /leave/types/:id/reasons (active reasons only). */
export const LeaveReasonsResponseSchema = z.object({
  leaveTypeId: z.number().int(),
  mandatoryReason: z.boolean(),
  items: z.array(LeaveReasonSchema),
});
export type LeaveReasonsResponse = z.infer<typeof LeaveReasonsResponseSchema>;

// ───────────── Calculate (live balance panel) ─────────────

const LeavePeriodShape = {
  /** The application is for (default: the acting-as employee). Self or a permitted report. */
  employeeId: z.number().int().positive().optional(),
  leaveTypeId: z.number().int().positive(),
  fromDate: BusinessDateSchema,
  toDate: BusinessDateSchema,
  /** Day portion of the start day; a single-day request uses only this one. */
  startPortion: DayPortionSchema.default('FULL'),
  endPortion: DayPortionSchema.default('FULL'),
};

function periodCheck(value: { fromDate: string; toDate: string }, ctx: z.RefinementCtx): void {
  if (value.toDate < value.fromDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toDate'], message: 'End must be on or after Start' });
  }
}

/** POST /leave/calculate. Read-only; the server is the source of truth for units (section 0.4). */
export const LeaveCalculateRequestSchema = z
  .object({
    ...LeavePeriodShape,
    /** When editing a sent-back request: leave its own reservation out of "available". */
    excludeApplicationId: z.number().int().positive().optional(),
  })
  .superRefine(periodCheck);
export type LeaveCalculateRequest = z.infer<typeof LeaveCalculateRequestSchema>;

/** A counted day of the request. */
export const LeaveDaySchema = z.object({
  date: BusinessDateSchema,
  portion: DayPortionSchema,
  /** "1.0000" or "0.5000". */
  units: DecimalStringSchema,
});
export type LeaveDay = z.infer<typeof LeaveDaySchema>;

export const EXCLUDED_DAY_REASONS = ['WEEKEND', 'PUBLIC_HOLIDAY'] as const;
export const ExcludedDayReasonSchema = z.enum(EXCLUDED_DAY_REASONS);
export type ExcludedDayReason = z.infer<typeof ExcludedDayReasonSchema>;

/** A day of the range that is not counted, and why. */
export const ExcludedDaySchema = z.object({
  date: BusinessDateSchema,
  reason: ExcludedDayReasonSchema,
  /** The holiday's name for PUBLIC_HOLIDAY. */
  name: z.string().nullable(),
});
export type ExcludedDay = z.infer<typeof ExcludedDaySchema>;

export const LeaveCalculateResponseSchema = z.object({
  employeeId: z.number().int(),
  leaveTypeId: z.number().int(),
  fromDate: BusinessDateSchema,
  toDate: BusinessDateSchema,
  startPortion: DayPortionSchema,
  endPortion: DayPortionSchema,
  /** "I am taking: {units} Days". */
  units: DecimalStringSchema,
  days: z.array(LeaveDaySchema),
  excludedDays: z.array(ExcludedDaySchema),
  /** Balance panel: Available (actual available for this type and start date). */
  available: DecimalStringSchema,
  /** Balance panel: To be Deducted (= units). */
  toBeDeducted: DecimalStringSchema,
  /** Balance panel: Remaining = Available − To be Deducted. */
  remaining: DecimalStringSchema,
  unitLabel: z.literal(LEAVE_UNIT_LABEL),
  /** The type hides balances in ESS; show the panel without the numbers. */
  hideUnitsAvailable: z.boolean(),
  /** True when the request would leave a negative balance (allowed only within the policy). */
  wouldGoNegative: z.boolean(),
  /** True when the units exceed the type's attachment threshold. */
  attachmentRequired: z.boolean(),
});
export type LeaveCalculateResponse = z.infer<typeof LeaveCalculateResponseSchema>;

// ───────────── Submit ─────────────

/**
 * POST /leave/applications (send an `Idempotency-Key`). HR_ADMIN may override the calculated
 * units with `overrideUnits: true`, `units` and an `overrideReason` (audited).
 */
export const SubmitLeaveRequestSchema = z
  .object({
    ...LeavePeriodShape,
    leaveReasonId: z.number().int().positive().nullable().optional(),
    comment: z
      .string()
      .trim()
      .max(LEAVE_COMMENT_MAX, `Use at most ${LEAVE_COMMENT_MAX} characters`)
      .optional(),
    /** "Note Submitted": a supporting note (for example a sick note) will be handed in. */
    noteSubmitted: z.boolean().default(false),
    /** Unsubmitted uploads of the caller (POST /attachments); bound to the application on submit. */
    attachmentIds: AttachmentIdsSchema.default([]),
    overrideUnits: z.boolean().default(false),
    units: PositiveUnitsSchema.optional(),
    overrideReason: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    periodCheck(value, ctx);
    if (!value.overrideUnits) return;
    if (!value.units)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['units'], message: 'Enter the units' });
    if (!value.overrideReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['overrideReason'],
        message: 'Give a reason for overriding the units',
      });
    }
  });
export type SubmitLeaveRequest = z.infer<typeof SubmitLeaveRequestSchema>;

/**
 * The editable fields when a sent-back leave request is resubmitted
 * (`POST /workflow/processes/:id/resubmit` with `changes`). Omitted fields keep their value.
 */
export const LeaveResubmitChangesSchema = z
  .object({
    fromDate: BusinessDateSchema,
    toDate: BusinessDateSchema,
    startPortion: DayPortionSchema,
    endPortion: DayPortionSchema,
    leaveReasonId: z.number().int().positive().nullable(),
    comment: z.string().trim().max(LEAVE_COMMENT_MAX),
    noteSubmitted: z.boolean(),
    attachmentIds: AttachmentIdsSchema,
  })
  .partial()
  .strict();
export type LeaveResubmitChanges = z.infer<typeof LeaveResubmitChangesSchema>;

// ───────────── History ─────────────

/** History grids (section 5.2.3): Completed Leave Items and Leave Items In Progress. */
export const LEAVE_HISTORY_FILTERS = ['completed', 'inProgress'] as const;
export const LeaveHistoryFilterSchema = z.enum(LEAVE_HISTORY_FILTERS);
export type LeaveHistoryFilter = z.infer<typeof LeaveHistoryFilterSchema>;

export const LEAVE_HISTORY_STATUSES: Record<LeaveHistoryFilter, ProcessStatus[]> = {
  completed: ['PROCESSED', 'DECLINED', 'CANCELLED', 'CONFLICT'],
  inProgress: ['DRAFT', 'IN_PROGRESS', 'RESUBMIT_REQUIRED', 'APPROVED_PENDING_PROCESS'],
};

/** GET /leave/applications?status=completed|inProgress&employeeId=. Sorted by From Date, newest first. */
export const LeaveApplicationsQuerySchema = z.object({
  status: LeaveHistoryFilterSchema.default('inProgress'),
  employeeId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type LeaveApplicationsQuery = z.infer<typeof LeaveApplicationsQuerySchema>;

export const LeaveTypeRefSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  description: z.string(),
  colour: z.string().nullable(),
});
export type LeaveTypeRef = z.infer<typeof LeaveTypeRefSchema>;

/**
 * What Cancel does for this row: withdraw at once (nothing actioned yet), request a cancellation
 * (CANCELLEAVE), or nothing (already final, or a cancellation is open).
 */
export const LEAVE_CANCEL_ACTIONS = ['WITHDRAW', 'REQUEST_CANCELLATION'] as const;
export const LeaveCancelActionSchema = z.enum(LEAVE_CANCEL_ACTIONS);
export type LeaveCancelAction = z.infer<typeof LeaveCancelActionSchema>;

export const LeaveCancellationRefSchema = z.object({
  id: z.number().int(),
  referenceNumber: z.string(),
  status: ProcessStatusSchema,
  statusLabel: z.string(),
  processId: z.number().int().nullable(),
});
export type LeaveCancellationRef = z.infer<typeof LeaveCancellationRefSchema>;

/** One row of the history grids, with the exact section 5.2.3 columns. */
export const LeaveApplicationRowSchema = z.object({
  id: z.number().int(),
  /** Send with cancel (optimistic concurrency). */
  version: z.number().int(),
  employeeId: z.number().int(),
  /** Leave Type ("Cancel Annual Leave" for a cancellation request). */
  leaveType: LeaveTypeRefSchema,
  leaveTypeLabel: z.string(),
  /** Reference Number, e.g. E000077-T0006-N00005. */
  referenceNumber: z.string(),
  fromDate: BusinessDateSchema,
  toDate: BusinessDateSchema,
  startPortion: DayPortionSchema,
  endPortion: DayPortionSchema,
  /** Units Taken. */
  unitsTaken: DecimalStringSchema,
  /** Leave reason. */
  leaveReason: z.string().nullable(),
  noteSubmitted: z.boolean(),
  /** Note Received. */
  noteReceived: z.boolean(),
  /** Takeon Transaction. */
  takeOnTransaction: z.boolean(),
  /** Date Submitted. */
  dateSubmitted: TimestampSchema.nullable(),
  /** Date Approved (final approval). */
  dateApproved: TimestampSchema.nullable(),
  /** Final Approver ("{Title} {Initials} {Surname}"). */
  finalApprover: z.string().nullable(),
  status: ProcessStatusSchema,
  statusLabel: z.string(),
  processId: z.number().int().nullable(),
  /** This row is a CANCELLEAVE request. */
  isCancellation: z.boolean(),
  /** For a cancellation: the application it cancels. */
  cancels: z.object({ id: z.number().int(), referenceNumber: z.string() }).nullable(),
  /** The latest cancellation request of this application, if any. */
  cancellation: LeaveCancellationRefSchema.nullable(),
  /** What the Cancel action does now; null = not available. */
  cancelAction: LeaveCancelActionSchema.nullable(),
});
export type LeaveApplicationRow = z.infer<typeof LeaveApplicationRowSchema>;

export const LeaveApplicationsResponseSchema = pageOf(LeaveApplicationRowSchema).extend({
  status: LeaveHistoryFilterSchema,
  employeeId: z.number().int(),
});
export type LeaveApplicationsResponse = z.infer<typeof LeaveApplicationsResponseSchema>;

export const LeaveAllocationSchema = z.object({
  entitlementId: z.number().int(),
  /** The bucket ("Carry Forward Leave", "Annual Leave"). */
  definitionName: z.string(),
  cycleEndDate: BusinessDateSchema,
  units: DecimalStringSchema,
  /** The reservation ended without being taken (declined, withdrawn, cancelled). */
  released: z.boolean(),
});
export type LeaveAllocation = z.infer<typeof LeaveAllocationSchema>;

export const LeaveEmployeeRefSchema = z.object({
  id: z.number().int(),
  employeeCode: z.string(),
  firstName: z.string(),
  lastName: z.string(),
});
export type LeaveEmployeeRef = z.infer<typeof LeaveEmployeeRefSchema>;

/** GET /leave/applications/:id: the leave detail modal, with the approval history. */
export const LeaveApplicationDetailSchema = LeaveApplicationRowSchema.extend({
  employee: LeaveEmployeeRefSchema,
  comment: z.string().nullable(),
  unitsOverridden: z.boolean(),
  overrideReason: z.string().nullable(),
  /** "Days available" when it was submitted (before its own units). */
  availableAtSubmit: DecimalStringSchema.nullable(),
  days: z.array(LeaveDaySchema),
  allocations: z.array(LeaveAllocationSchema),
  attachments: z.array(AttachmentSchema),
  payPeriod: z.object({ id: z.number().int(), description: z.string() }).nullable(),
  processedAt: TimestampSchema.nullable(),
  /** Null only for an application without a workflow (an imported take-on). */
  approvalHistory: ApprovalHistorySchema.nullable(),
});
export type LeaveApplicationDetail = z.infer<typeof LeaveApplicationDetailSchema>;

/** POST /leave/applications/:id/cancel (send an `Idempotency-Key`). */
export const CancelLeaveRequestSchema = z.object({
  /** The application's `version`. */
  version: z.number().int().positive(),
  comment: z.string().trim().max(LEAVE_COMMENT_MAX).optional(),
});
export type CancelLeaveRequest = z.infer<typeof CancelLeaveRequestSchema>;

export const CANCEL_LEAVE_OUTCOMES = ['WITHDRAWN', 'CANCELLATION_REQUESTED'] as const;
export const CancelLeaveOutcomeSchema = z.enum(CANCEL_LEAVE_OUTCOMES);
export type CancelLeaveOutcome = z.infer<typeof CancelLeaveOutcomeSchema>;

export const CancelLeaveResponseSchema = z.object({
  outcome: CancelLeaveOutcomeSchema,
  /** The original application after the action. */
  application: LeaveApplicationRowSchema,
  /** The new CANCELLEAVE request (CANCELLATION_REQUESTED only). */
  cancellation: LeaveApplicationRowSchema.nullable(),
});
export type CancelLeaveResponse = z.infer<typeof CancelLeaveResponseSchema>;

// ───────────── Balances ─────────────

export const LeaveBalancesQuerySchema = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
});
export type LeaveBalancesQuery = z.infer<typeof LeaveBalancesQuerySchema>;

/** The pay period the balances are reported for ("Period Ending"). */
export const BalancePeriodSchema = z.object({
  /** Null when the company rule has no pay period for today (the calendar month is used). */
  payPeriodId: z.number().int().nullable(),
  description: z.string(),
  startDate: BusinessDateSchema,
  endDate: BusinessDateSchema,
  /** "dd-MMM-yyyy". */
  periodEnding: z.string(),
});
export type BalancePeriod = z.infer<typeof BalancePeriodSchema>;

/** One card on the Balances page (section 5.2.2). */
export const LeaveBalanceCardSchema = z.object({
  leaveTypeId: z.number().int(),
  code: z.string(),
  description: z.string(),
  colour: z.string().nullable(),
  /** Actual Available = CF − Pending; null when the type hides units in ESS. */
  actualAvailable: DecimalStringSchema.nullable(),
  /** Pending (submitted, not yet processed). */
  pending: DecimalStringSchema,
  hideUnitsAvailable: z.boolean(),
  unitLabel: z.literal(LEAVE_UNIT_LABEL),
});
export type LeaveBalanceCard = z.infer<typeof LeaveBalanceCardSchema>;

/** GET /leave/balances?employeeId=. */
export const LeaveBalancesResponseSchema = z.object({
  employeeId: z.number().int(),
  period: BalancePeriodSchema,
  items: z.array(LeaveBalanceCardSchema),
});
export type LeaveBalancesResponse = z.infer<typeof LeaveBalancesResponseSchema>;

/**
 * A row of the balance-by-definition grid, with the exact section 1.7 columns: Leave Definition,
 * Entitlement, Balance Brought Forward, Accrued This Period, Taken This Period, Balance Carried
 * Forward, Planned, Pending, Leave Cycle End Date.
 */
export const LeaveBalanceDefinitionRowSchema = z.object({
  /** Null on the Total row. */
  entitlementId: z.number().int().nullable(),
  leaveDefinition: z.string(),
  entitlement: DecimalStringSchema,
  balanceBroughtForward: DecimalStringSchema,
  accruedThisPeriod: DecimalStringSchema,
  takenThisPeriod: DecimalStringSchema,
  /** Every other movement in the period (adjustments, reversals, carry forward, forfeits, credits). */
  adjustmentsThisPeriod: DecimalStringSchema,
  /** CF = BF + accrued − taken + adjustments. */
  balanceCarriedForward: DecimalStringSchema,
  planned: DecimalStringSchema,
  pending: DecimalStringSchema,
  /** CF − Pending. */
  actualAvailable: DecimalStringSchema,
  /** Null on the Total row. */
  leaveCycleEndDate: BusinessDateSchema.nullable(),
  isTotal: z.boolean(),
});
export type LeaveBalanceDefinitionRow = z.infer<typeof LeaveBalanceDefinitionRowSchema>;

/** GET /leave/balances/:leaveTypeId/definitions?employeeId=. */
export const LeaveBalanceDefinitionsResponseSchema = z.object({
  employeeId: z.number().int(),
  leaveType: LeaveTypeRefSchema,
  /** "{Type}, Period Ending: {dd-MMM-yyyy}". */
  title: z.string(),
  period: BalancePeriodSchema,
  hideUnitsAvailable: z.boolean(),
  rows: z.array(LeaveBalanceDefinitionRowSchema),
  total: LeaveBalanceDefinitionRowSchema,
});
export type LeaveBalanceDefinitionsResponse = z.infer<typeof LeaveBalanceDefinitionsResponseSchema>;

export const LeaveTypeIdParamSchema = z.object({ leaveTypeId: z.coerce.number().int().positive() });

// ───────────── Leave in lieu (section 5.2.4) ─────────────

export const CREDIT_LEAVE_KIND_LABELS: Record<CreditLeaveKind, string> = {
  REQUEST: 'Leave in Lieu Request',
  ALLOCATION: 'Leave in Lieu Allocation',
};

/**
 * POST /leave/in-lieu (send an `Idempotency-Key`). REQUEST: the employee asks for credit for
 * days worked (CREDITLVEREQ). ALLOCATION: a manager or HR grants credit to a report
 * (CREDITLVEALLOC). The worked dates are in the past.
 */
export const CreateCreditLeaveRequestSchema = z
  .object({
    kind: CreditLeaveKindSchema,
    /** Default: the acting-as employee (REQUEST); required in practice for ALLOCATION. */
    employeeId: z.number().int().positive().optional(),
    workedFrom: BusinessDateSchema,
    workedTo: BusinessDateSchema,
    units: PositiveUnitsSchema,
    reason: z.string().trim().min(1, 'A reason is required').max(500),
    attachmentIds: AttachmentIdsSchema.default([]),
  })
  .superRefine((value, ctx) => {
    if (value.workedTo < value.workedFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workedTo'],
        message: 'To must be on or after From',
      });
    }
  });
export type CreateCreditLeaveRequest = z.infer<typeof CreateCreditLeaveRequestSchema>;

export const CreditLeaveQuerySchema = z.object({
  kind: CreditLeaveKindSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type CreditLeaveQuery = z.infer<typeof CreditLeaveQuerySchema>;

export const CreditLeaveRowSchema = z.object({
  id: z.number().int(),
  version: z.number().int(),
  referenceNumber: z.string(),
  kind: CreditLeaveKindSchema,
  kindLabel: z.string(),
  employee: LeaveEmployeeRefSchema,
  leaveType: LeaveTypeRefSchema,
  workedFrom: BusinessDateSchema,
  workedTo: BusinessDateSchema,
  units: DecimalStringSchema,
  reason: z.string(),
  status: ProcessStatusSchema,
  statusLabel: z.string(),
  processId: z.number().int().nullable(),
  submittedAt: TimestampSchema.nullable(),
  processedAt: TimestampSchema.nullable(),
  /** When the credited units expire (set once processed). */
  expiresOn: BusinessDateSchema.nullable(),
  attachments: z.array(AttachmentSchema),
});
export type CreditLeaveRow = z.infer<typeof CreditLeaveRowSchema>;

/** GET /leave/in-lieu: requests about the acting-as employee and allocations the caller made. */
export const CreditLeaveListResponseSchema = pageOf(CreditLeaveRowSchema);
export type CreditLeaveListResponse = z.infer<typeof CreditLeaveListResponseSchema>;

// ───────────── Admin (HR_ADMIN) ─────────────

export const LeaveLedgerEntrySchema = z.object({
  id: z.number().int(),
  employeeId: z.number().int(),
  leaveTypeId: z.number().int(),
  entitlementId: z.number().int(),
  entryType: LedgerEntryTypeSchema,
  units: DecimalStringSchema,
  effectiveDate: BusinessDateSchema,
  payPeriodId: z.number().int().nullable(),
  leaveApplicationId: z.number().int().nullable(),
  note: z.string().nullable(),
  createdAt: TimestampSchema,
});
export type LeaveLedgerEntry = z.infer<typeof LeaveLedgerEntrySchema>;

/**
 * POST /admin/leave/adjustments: an ADJUSTMENT ledger entry (signed units) with a reason. Without
 * `entitlementId` it goes to the employee's current bucket of the type.
 */
export const LeaveAdjustmentRequestSchema = z.object({
  employeeId: z.number().int().positive(),
  leaveTypeId: z.number().int().positive(),
  entitlementId: z.number().int().positive().optional(),
  units: Units4Schema.refine((v) => !dec(v).isZero(), 'Units cannot be 0'),
  effectiveDate: BusinessDateSchema.optional(),
  reason: z.string().trim().min(3, 'Give a reason').max(500),
});
export type LeaveAdjustmentRequest = z.infer<typeof LeaveAdjustmentRequestSchema>;

export const LeaveAdjustmentResponseSchema = z.object({ entry: LeaveLedgerEntrySchema });
export type LeaveAdjustmentResponse = z.infer<typeof LeaveAdjustmentResponseSchema>;

/** Columns of the opening balances CSV (header row required, in any order). */
export const OPENING_BALANCE_CSV_COLUMNS = [
  'employeeCode',
  'leaveTypeCode',
  'kind',
  'definitionName',
  'cycleStartDate',
  'cycleEndDate',
  'entitlement',
  'openingBalance',
  'effectiveDate',
  'expiresOn',
] as const;

/** Bucket kinds an opening balance may open. */
export const OPENING_BALANCE_KINDS = ['CYCLE', 'CARRY_FORWARD'] as const;

export const OPENING_BALANCE_MODES = ['DRY_RUN', 'COMMIT'] as const;

/**
 * POST /admin/leave/opening-balances/import. Run DRY_RUN first; COMMIT needs the `confirmToken`
 * the dry run returned for exactly the same CSV. Every committed row is audited.
 */
export const OpeningBalanceImportRequestSchema = z
  .object({
    csv: z.string().min(1, 'The file is empty').max(2_000_000),
    mode: z.enum(OPENING_BALANCE_MODES),
    confirmToken: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'COMMIT' && !value.confirmToken) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmToken'], message: 'Run a dry run first' });
    }
  });
export type OpeningBalanceImportRequest = z.infer<typeof OpeningBalanceImportRequestSchema>;

export const OpeningBalanceRowResultSchema = z.object({
  /** 1-based data row number (the header is row 0). */
  row: z.number().int(),
  employeeCode: z.string(),
  leaveTypeCode: z.string(),
  definitionName: z.string(),
  ok: z.boolean(),
  errors: z.array(z.string()),
  /** What the row does: open a new bucket or post to an existing one. */
  bucket: z.enum(['NEW', 'EXISTING']).nullable(),
});
export type OpeningBalanceRowResult = z.infer<typeof OpeningBalanceRowResultSchema>;

export const OpeningBalanceImportResponseSchema = z.object({
  mode: z.enum(OPENING_BALANCE_MODES),
  /** Send with COMMIT; it is bound to the CSV content. */
  confirmToken: z.string(),
  totalRows: z.number().int(),
  validRows: z.number().int(),
  invalidRows: z.number().int(),
  committed: z.boolean(),
  rows: z.array(OpeningBalanceRowResultSchema),
});
export type OpeningBalanceImportResponse = z.infer<typeof OpeningBalanceImportResponseSchema>;

const HexColourSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use a hex colour such as #C0FFC0');
const NonNegativeUnitsSchema = Units4Schema.refine((v) => dec(v).gte(0), 'Cannot be negative');

/** A leave type as HR sees it (CRUD /admin/leave-types). */
export const AdminLeaveTypeSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  description: z.string(),
  colour: z.string().nullable(),
  unit: LeaveUnitSchema,
  isPaid: z.boolean(),
  mandatoryReason: z.boolean(),
  requiresAttachmentAfterDays: DecimalStringSchema.nullable(),
  allowHalfDay: z.boolean(),
  allowNegative: z.boolean(),
  excludeWeekends: z.boolean(),
  excludePublicHolidays: z.boolean(),
  hideUnitsAvailableForESS: z.boolean(),
  hideZeroUnitsAvailableForESS: z.boolean(),
  isCreditLeave: z.boolean(),
  isActive: z.boolean(),
  version: z.number().int(),
});
export type AdminLeaveType = z.infer<typeof AdminLeaveTypeSchema>;

const LeaveTypeFields = {
  code: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Z0-9_]+$/, 'Use capitals, digits and _'),
  description: z.string().trim().min(1).max(100),
  colour: HexColourSchema.nullable(),
  unit: LeaveUnitSchema,
  isPaid: z.boolean(),
  mandatoryReason: z.boolean(),
  requiresAttachmentAfterDays: NonNegativeUnitsSchema.nullable(),
  allowHalfDay: z.boolean(),
  allowNegative: z.boolean(),
  excludeWeekends: z.boolean(),
  excludePublicHolidays: z.boolean(),
  hideUnitsAvailableForESS: z.boolean(),
  hideZeroUnitsAvailableForESS: z.boolean(),
  isCreditLeave: z.boolean(),
  isActive: z.boolean(),
};

/** POST /admin/leave-types. `id` is optional (the next free id is used). */
export const CreateLeaveTypeRequestSchema = z.object({
  id: z.number().int().positive().max(9999).optional(),
  ...LeaveTypeFields,
  colour: LeaveTypeFields.colour.default(null),
  unit: LeaveTypeFields.unit.default('DAYS'),
  isPaid: LeaveTypeFields.isPaid.default(true),
  mandatoryReason: LeaveTypeFields.mandatoryReason.default(false),
  requiresAttachmentAfterDays: LeaveTypeFields.requiresAttachmentAfterDays.default(null),
  allowHalfDay: LeaveTypeFields.allowHalfDay.default(true),
  allowNegative: LeaveTypeFields.allowNegative.default(false),
  excludeWeekends: LeaveTypeFields.excludeWeekends.default(true),
  excludePublicHolidays: LeaveTypeFields.excludePublicHolidays.default(true),
  hideUnitsAvailableForESS: LeaveTypeFields.hideUnitsAvailableForESS.default(false),
  hideZeroUnitsAvailableForESS: LeaveTypeFields.hideZeroUnitsAvailableForESS.default(false),
  isCreditLeave: LeaveTypeFields.isCreditLeave.default(false),
  isActive: LeaveTypeFields.isActive.default(true),
});
export type CreateLeaveTypeRequest = z.infer<typeof CreateLeaveTypeRequestSchema>;

/** PUT /admin/leave-types/:id: the fields to change plus the `version` read. */
export const UpdateLeaveTypeRequestSchema = z
  .object(LeaveTypeFields)
  .partial()
  .extend({ version: z.number().int().positive() })
  .strict();
export type UpdateLeaveTypeRequest = z.infer<typeof UpdateLeaveTypeRequestSchema>;

/** DELETE bodies: deactivation (no hard deletes) needs the `version` read. */
export const DeactivateRequestSchema = z.object({ version: z.number().int().positive() });
export type DeactivateRequest = z.infer<typeof DeactivateRequestSchema>;

export const AdminLeaveTypesResponseSchema = z.object({ items: z.array(AdminLeaveTypeSchema) });
export type AdminLeaveTypesResponse = z.infer<typeof AdminLeaveTypesResponseSchema>;

export const AdminLeaveReasonSchema = LeaveReasonSchema.extend({
  isActive: z.boolean(),
  version: z.number().int(),
});
export type AdminLeaveReason = z.infer<typeof AdminLeaveReasonSchema>;

export const AdminLeaveReasonsQuerySchema = z.object({
  leaveTypeId: z.coerce.number().int().positive().optional(),
});
export type AdminLeaveReasonsQuery = z.infer<typeof AdminLeaveReasonsQuerySchema>;

const LeaveReasonFields = {
  code: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[A-Z0-9_]+$/, 'Use capitals, digits and _'),
  description: z.string().trim().min(1).max(100),
  isActive: z.boolean(),
};

export const CreateLeaveReasonRequestSchema = z.object({
  leaveTypeId: z.number().int().positive(),
  ...LeaveReasonFields,
  isActive: LeaveReasonFields.isActive.default(true),
});
export type CreateLeaveReasonRequest = z.infer<typeof CreateLeaveReasonRequestSchema>;

export const UpdateLeaveReasonRequestSchema = z
  .object(LeaveReasonFields)
  .partial()
  .extend({ version: z.number().int().positive() })
  .strict();
export type UpdateLeaveReasonRequest = z.infer<typeof UpdateLeaveReasonRequestSchema>;

export const AdminLeaveReasonsResponseSchema = z.object({ items: z.array(AdminLeaveReasonSchema) });
export type AdminLeaveReasonsResponse = z.infer<typeof AdminLeaveReasonsResponseSchema>;

export const AdminLeavePolicySchema = z.object({
  id: z.number().int(),
  leaveTypeId: z.number().int(),
  /** Null = every company rule (a company rule's own policy wins). */
  companyRuleId: z.number().int().nullable(),
  definitionName: z.string(),
  entitlementPerCycle: DecimalStringSchema,
  accrualMethod: AccrualMethodSchema,
  cycleMonths: z.number().int(),
  maxCarryForward: DecimalStringSchema.nullable(),
  carryForwardExpiryMonths: z.number().int().nullable(),
  maxNegative: DecimalStringSchema,
  creditExpiryDays: z.number().int().nullable(),
  isActive: z.boolean(),
  version: z.number().int(),
});
export type AdminLeavePolicy = z.infer<typeof AdminLeavePolicySchema>;

export const AdminLeavePoliciesQuerySchema = z.object({
  leaveTypeId: z.coerce.number().int().positive().optional(),
});
export type AdminLeavePoliciesQuery = z.infer<typeof AdminLeavePoliciesQuerySchema>;

const LeavePolicyFields = {
  companyRuleId: z.number().int().positive().nullable(),
  definitionName: z.string().trim().min(1).max(100),
  entitlementPerCycle: NonNegativeUnitsSchema,
  accrualMethod: AccrualMethodSchema,
  cycleMonths: z.number().int().min(1).max(120),
  /** Null = no cap on carry forward. */
  maxCarryForward: NonNegativeUnitsSchema.nullable(),
  carryForwardExpiryMonths: z.number().int().min(1).max(120).nullable(),
  maxNegative: NonNegativeUnitsSchema,
  creditExpiryDays: z.number().int().min(1).max(3650).nullable(),
  isActive: z.boolean(),
};

export const CreateLeavePolicyRequestSchema = z.object({
  leaveTypeId: z.number().int().positive(),
  ...LeavePolicyFields,
  companyRuleId: LeavePolicyFields.companyRuleId.default(null),
  cycleMonths: LeavePolicyFields.cycleMonths.default(12),
  maxCarryForward: LeavePolicyFields.maxCarryForward.default(null),
  carryForwardExpiryMonths: LeavePolicyFields.carryForwardExpiryMonths.default(null),
  maxNegative: LeavePolicyFields.maxNegative.default('0'),
  creditExpiryDays: LeavePolicyFields.creditExpiryDays.default(null),
  isActive: LeavePolicyFields.isActive.default(true),
});
export type CreateLeavePolicyRequest = z.infer<typeof CreateLeavePolicyRequestSchema>;

export const UpdateLeavePolicyRequestSchema = z
  .object(LeavePolicyFields)
  .omit({ companyRuleId: true })
  .partial()
  .extend({ version: z.number().int().positive() })
  .strict();
export type UpdateLeavePolicyRequest = z.infer<typeof UpdateLeavePolicyRequestSchema>;

export const AdminLeavePoliciesResponseSchema = z.object({ items: z.array(AdminLeavePolicySchema) });
export type AdminLeavePoliciesResponse = z.infer<typeof AdminLeavePoliciesResponseSchema>;

/** Problem `type` values of leave errors the web app branches on. */
export const LEAVE_PROBLEM_TYPES = {
  noWorkingDays: 'urn:peoplehub:problem:leave-no-working-days',
  overlap: 'urn:peoplehub:problem:leave-overlap',
  insufficientBalance: 'urn:peoplehub:problem:leave-insufficient-balance',
  noPolicy: 'urn:peoplehub:problem:leave-no-policy',
  cancellationOpen: 'urn:peoplehub:problem:leave-cancellation-open',
} as const;
