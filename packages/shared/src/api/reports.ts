import { z } from 'zod';
import {
  AuditCategorySchema,
  AUDIT_CATEGORIES,
  AuditOutcomeSchema,
  AUDIT_OUTCOMES,
  CONTRACT_STATUSES,
  ContractStatusSchema,
  PROCESS_STATUS_LABELS,
  PROCESS_STATUSES,
  ProcessStatusSchema,
  REVIEW_STATUSES,
  ReviewStatusSchema,
  type Role,
  WORKFLOW_TYPES,
  WorkflowTypeCodeSchema,
} from '../enums';
import { BooleanQuerySchema } from './calendar';
import { BusinessDateSchema, TimestampSchema } from './common';

// Contracts for section 5.7 / 12.11: `GET /reports` (the catalogue for the caller's roles),
// `GET /reports/:code/employees` (the employee picker, limited to the caller's scope) and
// `POST /reports/:code/run {params, format}`. JSON answers one page of rows for the on-screen
// grid; CSV, XLSX and PDF stream a file. Every run is audited `EXPORT.REPORT` with its params.

export const REPORT_GROUPS = ['EMPLOYEE', 'LEAVE', 'PERFORMANCE', 'WORKFLOW', 'AUDIT'] as const;
export const ReportGroupSchema = z.enum(REPORT_GROUPS);
export type ReportGroup = z.infer<typeof ReportGroupSchema>;
export const REPORT_GROUP_LABELS: Record<ReportGroup, string> = {
  EMPLOYEE: 'Employee',
  LEAVE: 'Leave',
  PERFORMANCE: 'Performance',
  WORKFLOW: 'Workflow',
  AUDIT: 'Audit',
};

export const REPORT_FORMATS = ['json', 'pdf', 'xlsx', 'csv'] as const;
export const ReportFormatSchema = z.enum(REPORT_FORMATS);
export type ReportFormat = z.infer<typeof ReportFormatSchema>;

/** A PDF stops after this many rows and says so (use CSV or Excel for the full data). */
export const REPORT_PDF_ROW_LIMIT = 1000;
/** Rows per page of the on-screen grid (JSON). */
export const REPORT_DEFAULT_PAGE_SIZE = 100;
export const REPORT_MAX_PAGE_SIZE = 500;

export const REPORT_COLUMN_TYPES = [
  'string',
  'integer',
  'decimal',
  'money',
  'date',
  'datetime',
  'boolean',
] as const;
export const ReportColumnTypeSchema = z.enum(REPORT_COLUMN_TYPES);
export type ReportColumnType = z.infer<typeof ReportColumnTypeSchema>;

export const ReportColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: ReportColumnTypeSchema,
  /** Payslip amounts: blank for a system admin who is not also HR or Payroll (section 4.1). */
  payData: z.boolean(),
});
export type ReportColumn = z.infer<typeof ReportColumnSchema>;

/** How the web app renders a parameter. `dateRange` always maps to the `from` and `to` params. */
export const REPORT_PARAM_KINDS = [
  'dateRange',
  'companyRules',
  'employees',
  'includeTerminated',
  'statuses',
  'leaveTypes',
  'claimGroups',
  'workflowTypes',
  'auditCategories',
  'auditOutcomes',
  'text',
] as const;
export const ReportParamKindSchema = z.enum(REPORT_PARAM_KINDS);
export type ReportParamKind = z.infer<typeof ReportParamKindSchema>;

export const ReportOptionSchema = z.object({ value: z.string(), label: z.string() });
export type ReportOption = z.infer<typeof ReportOptionSchema>;

/** A serialisable description of one parameter for the parameter panel. */
export const ReportParamFieldSchema = z.object({
  /** The params key (`dateRange` stands for `from` + `to`). */
  name: z.string(),
  kind: ReportParamKindSchema,
  label: z.string(),
  required: z.boolean(),
  description: z.string().nullable(),
  /** Fixed choices (statuses, workflow types, audit categories); null when loaded elsewhere. */
  options: z.array(ReportOptionSchema).nullable(),
});
export type ReportParamField = z.infer<typeof ReportParamFieldSchema>;

// ───────────── Parameter schemas ─────────────

const IdListSchema = (max: number) => z.array(z.number().int().positive()).max(max);

const rangeShape = { from: BusinessDateSchema.optional(), to: BusinessDateSchema.optional() };
const peopleShape = {
  companyRuleIds: IdListSchema(100).optional(),
  /** Must be inside the caller's scope (403 otherwise). */
  employeeIds: IdListSchema(1000).optional(),
  includeTerminated: z.boolean().default(false),
};

function rangeCheck(value: { from?: string; to?: string }, ctx: z.RefinementCtx): void {
  if (value.from && value.to && value.to < value.from) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'To must be on or after From' });
  }
}

function peopleParams<T extends z.ZodRawShape>(shape: T) {
  return z
    .object({ ...rangeShape, ...peopleShape, ...shape })
    .strict()
    .superRefine(rangeCheck);
}

const processStatuses = z.array(ProcessStatusSchema).max(PROCESS_STATUSES.length);

const EmployeeParamsSchema = peopleParams({});
const TransactionParamsSchema = peopleParams({ statuses: processStatuses.optional() });
const LeaveParamsSchema = peopleParams({
  leaveTypeIds: IdListSchema(100).optional(),
  statuses: processStatuses.optional(),
});
const LeaveBalanceParamsSchema = peopleParams({ leaveTypeIds: IdListSchema(100).optional() });
const ClaimParamsSchema = peopleParams({
  claimGroupIds: IdListSchema(100).optional(),
  statuses: processStatuses.optional(),
});
const ProcessParamsSchema = peopleParams({
  workflowTypes: z.array(WorkflowTypeCodeSchema).max(20).optional(),
  statuses: processStatuses.optional(),
});
const ReviewParamsSchema = peopleParams({
  statuses: z.array(ReviewStatusSchema).max(REVIEW_STATUSES.length).optional(),
});
const ContractParamsSchema = peopleParams({
  statuses: z.array(ContractStatusSchema).max(CONTRACT_STATUSES.length).optional(),
});
/** Audit reports: `employeeIds` filters the subject employee. */
const AuditParamsSchema = z
  .object({
    ...rangeShape,
    employeeIds: IdListSchema(1000).optional(),
    categories: z.array(AuditCategorySchema).max(AUDIT_CATEGORIES.length).optional(),
    outcomes: z.array(AuditOutcomeSchema).max(AUDIT_OUTCOMES.length).optional(),
    /** Action prefix, e.g. `LEAVE.` or `DATA_VIEW.PAYSLIP`. */
    action: z.string().trim().max(100).optional(),
    /** Part of the actor's username. */
    actorUsername: z.string().trim().max(150).optional(),
  })
  .strict()
  .superRefine(rangeCheck);

export const REPORT_PARAM_SCHEMAS = {
  EMPLOYEE_PAY_PERIOD_BASIC: EmployeeParamsSchema,
  EMPLOYEE_BASIC: EmployeeParamsSchema,
  EMPLOYEE_DETAIL: EmployeeParamsSchema,
  BIRTHDAY_LIST: EmployeeParamsSchema,
  EMPLOYEE_TRANSACTION: TransactionParamsSchema,
  DEVELOPMENT_PLAN: ContractParamsSchema,
  LEAVE_DETAIL: LeaveParamsSchema,
  LEAVE_MAX_CREDIT: LeaveBalanceParamsSchema,
  LEAVE_BASIC: LeaveParamsSchema,
  LEAVE_SUMMARY: LeaveBalanceParamsSchema,
  LEAVE_HISTORY_PER_PERIOD: LeaveBalanceParamsSchema,
  LEAVE_IN_LIEU: LeaveParamsSchema,
  LEAVE_BY_MONTH: LeaveBalanceParamsSchema,
  PERFORMANCE_REVIEW_RESULTS: ReviewParamsSchema,
  CONTRACT_REVIEW_OVERVIEW: ContractParamsSchema,
  REVIEWER_DETAIL: ReviewParamsSchema,
  PROCESSED_CLAIMS: ClaimParamsSchema,
  EXPENSE_CLAIM_WORKFLOW_STATUS: ClaimParamsSchema,
  EXPENSE_CLAIM_REPORT: ClaimParamsSchema,
  CLAIM_LINE: ClaimParamsSchema,
  STEP_APPROVER_ACTIONS: ProcessParamsSchema,
  CLAIM_SUMMARY: ClaimParamsSchema,
  PROCESS_HISTORY: ProcessParamsSchema,
  ESCALATION_ITEMS: ProcessParamsSchema,
  AUDIT_TRAIL_EXTRACT: AuditParamsSchema,
  SENSITIVE_DATA_ACCESS: AuditParamsSchema,
  FAILED_LOGINS: AuditParamsSchema,
  CHANGES_BY_USER: AuditParamsSchema,
} as const;

export type ReportCode = keyof typeof REPORT_PARAM_SCHEMAS;
export const REPORT_CODES = Object.keys(REPORT_PARAM_SCHEMAS) as ReportCode[];
export const ReportCodeSchema = z.enum(REPORT_CODES as [ReportCode, ...ReportCode[]]);
export type ReportParams<C extends ReportCode> = z.infer<(typeof REPORT_PARAM_SCHEMAS)[C]>;

// ───────────── Catalogue metadata ─────────────

export interface ReportMeta {
  code: ReportCode;
  group: ReportGroup;
  title: string;
  description: string;
  /** Any of these roles may run it; the rows are limited to that role's scope. */
  requiredRoles: Role[];
  columns: ReportColumn[];
  paramFields: ReportParamField[];
}

type ColumnSpec = [key: string, label: string, type?: ReportColumnType, payData?: boolean];

function columns(...specs: ColumnSpec[]): ReportColumn[] {
  return specs.map(([key, label, type = 'string', payData = false]) => ({ key, label, type, payData }));
}

function field(
  name: string,
  kind: ReportParamKind,
  label: string,
  options: ReportOption[] | null = null,
  description: string | null = null,
): ReportParamField {
  return { name, kind, label, required: false, description, options };
}

const processStatusOptions = PROCESS_STATUSES.map((s) => ({ value: s, label: PROCESS_STATUS_LABELS[s] }));
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

const P = {
  range: (description: string) => field('dateRange', 'dateRange', 'Date range', null, description),
  companyRules: field('companyRuleIds', 'companyRules', 'Company rule'),
  employees: field('employeeIds', 'employees', 'Employees', null, 'Limited to the employees you may see'),
  terminated: field('includeTerminated', 'includeTerminated', 'Include terminated'),
  processStatuses: field('statuses', 'statuses', 'Status', processStatusOptions),
  reviewStatuses: field(
    'statuses',
    'statuses',
    'Review status',
    REVIEW_STATUSES.map((s) => ({ value: s, label: titleCase(s) })),
  ),
  contractStatuses: field(
    'statuses',
    'statuses',
    'Contract status',
    CONTRACT_STATUSES.map((s) => ({ value: s, label: titleCase(s) })),
  ),
  leaveTypes: field('leaveTypeIds', 'leaveTypes', 'Leave type'),
  claimGroups: field('claimGroupIds', 'claimGroups', 'Claim group'),
  workflowTypes: field(
    'workflowTypes',
    'workflowTypes',
    'Workflow type',
    Object.entries(WORKFLOW_TYPES).map(([value, label]) => ({ value, label })),
  ),
  auditSubject: field('employeeIds', 'employees', 'Subject employee'),
  auditCategories: field(
    'categories',
    'auditCategories',
    'Category',
    AUDIT_CATEGORIES.map((c) => ({ value: c, label: c })),
  ),
  auditOutcomes: field(
    'outcomes',
    'auditOutcomes',
    'Outcome',
    AUDIT_OUTCOMES.map((o) => ({ value: o, label: titleCase(o) })),
  ),
  action: field('action', 'text', 'Action starts with', null, 'For example LEAVE. or DATA_VIEW.PAYSLIP'),
  actor: field('actorUsername', 'text', 'Actor username contains'),
};

const PEOPLE = [P.companyRules, P.employees, P.terminated];
const AUDIT_PARAMS = [
  P.range('Occurred between'),
  P.auditSubject,
  P.auditCategories,
  P.auditOutcomes,
  P.action,
  P.actor,
];

/** Self (employees), their reports (managers), their companies (HR/Payroll), everyone (auditors). */
const SELF_TEAM_ADMIN: Role[] = ['EMPLOYEE', 'MANAGER', 'HR_ADMIN', 'PAYROLL_ADMIN', 'AUDITOR'];
const TEAM_ADMIN: Role[] = ['MANAGER', 'HR_ADMIN', 'PAYROLL_ADMIN', 'AUDITOR'];
const ADMIN: Role[] = ['HR_ADMIN', 'PAYROLL_ADMIN', 'AUDITOR'];
const PERFORMANCE: Role[] = ['EMPLOYEE', 'MANAGER', 'HR_ADMIN', 'AUDITOR'];
const AUDIT: Role[] = ['AUDITOR', 'SYSTEM_ADMIN'];

const EMPLOYEE_COLS: ColumnSpec[] = [
  ['employeeCode', 'Employee Code'],
  ['employeeName', 'Employee Name'],
];

const AUDIT_ROW: ColumnSpec[] = [
  ['id', 'Audit ID'],
  ['occurredAt', 'Occurred At', 'datetime'],
];

export const REPORT_CATALOGUE: Record<ReportCode, ReportMeta> = {
  // ───── Employee ─────
  EMPLOYEE_PAY_PERIOD_BASIC: {
    code: 'EMPLOYEE_PAY_PERIOD_BASIC',
    group: 'EMPLOYEE',
    title: 'Employee Pay Period Basic',
    description: 'Each employee per pay period of their company rule, with the published payslip totals.',
    requiredRoles: ADMIN,
    paramFields: [P.range('Pay periods ending between (default: this year)'), ...PEOPLE],
    columns: columns(
      ['payPeriod', 'Pay Period'],
      ['periodStart', 'Period Start', 'date'],
      ['periodEnd', 'Period End', 'date'],
      ...EMPLOYEE_COLS,
      ['companyRule', 'Company Rule'],
      ['jobTitle', 'Job Title'],
      ['department', 'Department'],
      ['status', 'Status'],
      ['dateEngaged', 'Date Engaged', 'date'],
      ['payslips', 'Payslips', 'integer'],
      ['payRuns', 'Pay Runs'],
      ['grossPay', 'Gross Pay', 'money', true],
      ['totalDeductions', 'Total Deductions', 'money', true],
      ['netPay', 'Net Pay', 'money', true],
    ),
  },
  EMPLOYEE_BASIC: {
    code: 'EMPLOYEE_BASIC',
    group: 'EMPLOYEE',
    title: 'Employee Basic',
    description: 'Basic employee information: names, company rule, position and reporting line.',
    requiredRoles: TEAM_ADMIN,
    paramFields: [P.range('Engaged between'), ...PEOPLE],
    columns: columns(
      ['employeeCode', 'Employee Code'],
      ['title', 'Title'],
      ['initials', 'Initials'],
      ['firstName', 'First Name'],
      ['lastName', 'Last Name'],
      ['knownAs', 'Known As'],
      ['company', 'Company'],
      ['companyRule', 'Company Rule'],
      ['jobTitle', 'Job Title'],
      ['department', 'Department'],
      ['status', 'Status'],
      ['dateEngaged', 'Date Engaged', 'date'],
      ['terminationDate', 'Termination Date', 'date'],
      ['reportsTo', 'Reports To'],
    ),
  },
  EMPLOYEE_DETAIL: {
    code: 'EMPLOYEE_DETAIL',
    group: 'EMPLOYEE',
    title: 'Employee Detail',
    description: 'Personal and position details; identity and tax numbers are masked.',
    requiredRoles: ADMIN,
    paramFields: [P.range('Engaged between'), ...PEOPLE],
    columns: columns(
      ['employeeCode', 'Employee Code'],
      ['firstName', 'First Name'],
      ['lastName', 'Last Name'],
      ['knownAs', 'Known As'],
      ['gender', 'Gender'],
      ['dateOfBirth', 'Date of Birth', 'date'],
      ['age', 'Age', 'integer'],
      ['nationality', 'Nationality'],
      ['homeLanguage', 'Home Language'],
      ['maritalStatus', 'Marital Status'],
      ['identityType', 'Identity Type'],
      ['identityNumber', 'Identity Number'],
      ['taxNumber', 'Tax Number'],
      ['cellNumber', 'Cell Number'],
      ['email', 'E-Mail Address'],
      ['jobTitle', 'Job Title'],
      ['jobGrade', 'Job Grade'],
      ['department', 'Department'],
      ['companyRule', 'Company Rule'],
      ['dateEngaged', 'Date Engaged', 'date'],
      ['status', 'Status'],
    ),
  },
  BIRTHDAY_LIST: {
    code: 'BIRTHDAY_LIST',
    group: 'EMPLOYEE',
    title: 'Birthday List',
    description: 'Birthdays by day and month (never the year), in calendar order. Opt-outs are left out.',
    requiredRoles: TEAM_ADMIN,
    paramFields: [P.range('Birthdays falling between'), ...PEOPLE],
    columns: columns(
      ...EMPLOYEE_COLS,
      ['companyRule', 'Company Rule'],
      ['department', 'Department'],
      ['birthday', 'Birthday'],
      ['nextBirthday', 'Next Birthday', 'date'],
      ['daysUntil', 'Days Until', 'integer'],
    ),
  },
  EMPLOYEE_TRANSACTION: {
    code: 'EMPLOYEE_TRANSACTION',
    group: 'EMPLOYEE',
    title: 'EmployeeTransaction',
    description: 'Recurring and once-off payroll transactions of employees.',
    requiredRoles: ADMIN,
    paramFields: [P.range('Created between'), ...PEOPLE, P.processStatuses],
    columns: columns(
      ...EMPLOYEE_COLS,
      ['companyRule', 'Company Rule'],
      ['code', 'Transaction Code'],
      ['description', 'Description'],
      ['amount', 'Amount', 'money', true],
      ['quantity', 'Quantity', 'decimal'],
      ['payPeriod', 'Pay Period'],
      ['recurring', 'Recurring', 'boolean'],
      ['status', 'Status'],
      ['createdAt', 'Created', 'datetime'],
    ),
  },
  DEVELOPMENT_PLAN: {
    code: 'DEVELOPMENT_PLAN',
    group: 'EMPLOYEE',
    title: 'Development Plan Report',
    description: 'Competencies and objectives of performance contracts with their latest rating.',
    requiredRoles: PERFORMANCE,
    paramFields: [P.range('Contracts active between'), ...PEOPLE, P.contractStatuses],
    columns: columns(
      ...EMPLOYEE_COLS,
      ['contractName', 'Contract Name'],
      ['contractStart', 'Contract Start Date', 'date'],
      ['contractEnd', 'Contract End Date', 'date'],
      ['contractStatus', 'Contract Status'],
      ['itemKind', 'Item Type'],
      ['developmentArea', 'Development Area'],
      ['target', 'Target'],
      ['weight', 'Weight', 'decimal'],
      ['latestRating', 'Latest Rating', 'decimal'],
      ['latestComment', 'Latest Comment'],
      ['lastReviewed', 'Last Reviewed', 'datetime'],
    ),
  },

  // ───── Leave ─────
  LEAVE_DETAIL: {
    code: 'LEAVE_DETAIL',
    group: 'LEAVE',
    title: 'Leave Detail',
    description: 'Every leave application with its dates, units, reason, status and approval.',
    requiredRoles: SELF_TEAM_ADMIN,
    paramFields: [P.range('Leave overlapping'), ...PEOPLE, P.leaveTypes, P.processStatuses],
    columns: columns(
      ['referenceNumber', 'Reference Number'],
      ...EMPLOYEE_COLS,
      ['companyRule', 'Company Rule'],
      ['leaveType', 'Leave Type'],
      ['fromDate', 'From Date', 'date'],
      ['toDate', 'To Date', 'date'],
      ['startPortion', 'Start Portion'],
      ['endPortion', 'End Portion'],
      ['units', 'Units', 'decimal'],
      ['reason', 'Leave Reason'],
      ['comment', 'Comments'],
      ['noteSubmitted', 'Note Submitted', 'boolean'],
      ['status', 'Status'],
      ['isCancellation', 'Cancellation Request', 'boolean'],
      ['submittedAt', 'Date Submitted', 'datetime'],
      ['approvedAt', 'Date Approved', 'datetime'],
      ['finalApprover', 'Final Approver'],
      ['processedAt', 'Processed', 'datetime'],
      ['payPeriod', 'Pay Period'],
    ),
  },
  LEAVE_MAX_CREDIT: {
    code: 'LEAVE_MAX_CREDIT',
    group: 'LEAVE',
    title: 'Leave Max Credit',
    description:
      'Open leave buckets with the most they may hold (entitlement plus allowed carry forward) and the room left.',
    requiredRoles: SELF_TEAM_ADMIN,
    paramFields: [P.range('Buckets open during'), ...PEOPLE, P.leaveTypes],
    columns: columns(
      ...EMPLOYEE_COLS,
      ['companyRule', 'Company Rule'],
      ['leaveType', 'Leave Type'],
      ['definition', 'Leave Definition'],
      ['cycleStart', 'Cycle Start Date', 'date'],
      ['cycleEnd', 'Cycle End Date', 'date'],
      ['expiresOn', 'Expires On', 'date'],
      ['entitlement', 'Entitlement', 'decimal'],
      ['maxCarryForward', 'Max Carry Forward', 'decimal'],
      ['maxNegative', 'Max Negative', 'decimal'],
      ['maxCredit', 'Max Credit', 'decimal'],
      ['balance', 'Balance', 'decimal'],
      ['pending', 'Pending', 'decimal'],
      ['actualAvailable', 'Actual Available', 'decimal'],
      ['creditRemaining', 'Credit Remaining', 'decimal'],
    ),
  },
  LEAVE_BASIC: {
    code: 'LEAVE_BASIC',
    group: 'LEAVE',
    title: 'Leave Basic',
    description: 'A short list of leave applications: who, which type, when and how many days.',
    requiredRoles: SELF_TEAM_ADMIN,
    paramFields: [P.range('Leave overlapping'), ...PEOPLE, P.leaveTypes, P.processStatuses],
    columns: columns(
      ...EMPLOYEE_COLS,
      ['leaveType', 'Leave Type'],
      ['fromDate', 'From Date', 'date'],
      ['toDate', 'To Date', 'date'],
      ['units', 'Units', 'decimal'],
      ['status', 'Status'],
    ),
  },
  LEAVE_SUMMARY: {
    code: 'LEAVE_SUMMARY',
    group: 'LEAVE',
    title: 'Leave Summary',
    description:
      'Per employee and leave type: opening balance, accrued, taken, adjustments and closing balance.',
    requiredRoles: SELF_TEAM_ADMIN,
    paramFields: [P.range('Ledger movements between (default: this year to today)'), ...PEOPLE, P.leaveTypes],
    columns: columns(
      ...EMPLOYEE_COLS,
      ['companyRule', 'Company Rule'],
      ['leaveType', 'Leave Type'],
      ['openingBalance', 'Opening Balance', 'decimal'],
      ['accrued', 'Accrued', 'decimal'],
      ['taken', 'Taken', 'decimal'],
      ['adjustments', 'Adjustments', 'decimal'],
      ['closingBalance', 'Closing Balance', 'decimal'],
      ['pending', 'Pending', 'decimal'],
    ),
  },
  LEAVE_HISTORY_PER_PERIOD: {
    code: 'LEAVE_HISTORY_PER_PERIOD',
    group: 'LEAVE',
    title: 'Leave History Per Period',
    description: 'Leave processed into each pay period, per employee and leave type.',
    requiredRoles: SELF_TEAM_ADMIN,
    paramFields: [P.range('Pay periods ending between'), ...PEOPLE, P.leaveTypes],
    columns: columns(
      ['payPeriod', 'Pay Period'],
      ['periodStart', 'Period Start', 'date'],
      ['periodEnd', 'Period End', 'date'],
      ...EMPLOYEE_COLS,
      ['leaveType', 'Leave Type'],
      ['unitsTaken', 'Units Taken', 'decimal'],
      ['unitsReversed', 'Units Reversed', 'decimal'],
      ['netUnits', 'Net Units', 'decimal'],
    ),
  },
  LEAVE_IN_LIEU: {
    code: 'LEAVE_IN_LIEU',
    group: 'LEAVE',
    title: 'Leave In Lieu',
    description: 'Leave in lieu requests and allocations with their credit and expiry.',
    requiredRoles: SELF_TEAM_ADMIN,
    paramFields: [P.range('Worked between'), ...PEOPLE, P.processStatuses],
    columns: columns(
      ['referenceNumber', 'Reference Number'],
      ['kind', 'Kind'],
      ...EMPLOYEE_COLS,
      ['workedFrom', 'Worked From', 'date'],
      ['workedTo', 'Worked To', 'date'],
      ['units', 'Units', 'decimal'],
      ['reason', 'Reason'],
      ['status', 'Status'],
      ['submittedAt', 'Date Submitted', 'datetime'],
      ['approvedAt', 'Date Approved', 'datetime'],
      ['processedAt', 'Processed', 'datetime'],
      ['expiresOn', 'Credit Expires On', 'date'],
    ),
  },
  LEAVE_BY_MONTH: {
    code: 'LEAVE_BY_MONTH',
    group: 'LEAVE',
    title: 'Leave By Month',
    description: 'Approved and processed leave days per calendar month, employee and leave type.',
    requiredRoles: SELF_TEAM_ADMIN,
    paramFields: [P.range('Leave days between (default: this year)'), ...PEOPLE, P.leaveTypes],
    columns: columns(
      ['month', 'Month'],
      ...EMPLOYEE_COLS,
      ['leaveType', 'Leave Type'],
      ['days', 'Days', 'decimal'],
    ),
  },

  // ───── Performance ─────
  PERFORMANCE_REVIEW_RESULTS: {
    code: 'PERFORMANCE_REVIEW_RESULTS',
    group: 'PERFORMANCE',
    title: 'Individual Performance Review Results',
    description: 'Each reviewee of each review with the review total.',
    requiredRoles: PERFORMANCE,
    paramFields: [P.range('Review cycle overlapping'), ...PEOPLE, P.reviewStatuses],
    columns: columns(
      ['reviewName', 'Review Name'],
      ['category', 'Review Category'],
      ['type', 'Review Type'],
      ['cycleStart', 'Review Cycle Start Date', 'date'],
      ['cycleEnd', 'Review Cycle End Date', 'date'],
      ...EMPLOYEE_COLS,
      ['contractName', 'Contract Name'],
      ['status', 'Review Status'],
      ['totalActual', 'Review Total Actual', 'decimal'],
      ['reviewers', 'Reviewers', 'integer'],
      ['scoresSubmitted', 'Scores Submitted', 'integer'],
    ),
  },
  CONTRACT_REVIEW_OVERVIEW: {
    code: 'CONTRACT_REVIEW_OVERVIEW',
    group: 'PERFORMANCE',
    title: 'Contract And Review Overview',
    description: 'Performance contracts with the number and outcome of their reviews.',
    requiredRoles: PERFORMANCE,
    paramFields: [P.range('Contracts active between'), ...PEOPLE, P.contractStatuses],
    columns: columns(
      ...EMPLOYEE_COLS,
      ['companyRule', 'Company Rule'],
      ['contractName', 'Contract Name'],
      ['templateName', 'Template Name'],
      ['startDate', 'Contract Start Date', 'date'],
      ['endDate', 'Contract End Date', 'date'],
      ['contractType', 'Contract Type'],
      ['contractStatus', 'Contract Status'],
      ['archived', 'Archived', 'boolean'],
      ['reviews', 'Reviews', 'integer'],
      ['completedReviews', 'Completed Reviews', 'integer'],
      ['latestReview', 'Latest Review'],
      ['latestReviewStatus', 'Latest Review Status'],
      ['latestTotalActual', 'Latest Review Total Actual', 'decimal'],
    ),
  },
  REVIEWER_DETAIL: {
    code: 'REVIEWER_DETAIL',
    group: 'PERFORMANCE',
    title: 'Reviewer Detail',
    description: 'Reviewers of each review with the scores they submitted.',
    requiredRoles: PERFORMANCE,
    paramFields: [P.range('Review cycle overlapping'), ...PEOPLE, P.reviewStatuses],
    columns: columns(
      ['reviewName', 'Review Name'],
      ['reviewStatus', 'Review Status'],
      ['revieweeCode', 'Reviewee Code'],
      ['revieweeName', 'Reviewee Name'],
      ['reviewer', 'Reviewer'],
      ['reviewerWeight', 'Reviewer Weight', 'decimal'],
      ['scoresSubmitted', 'Scores Submitted', 'integer'],
      ['averageRating', 'Average Rating', 'decimal'],
      ['lastSubmittedAt', 'Last Submitted', 'datetime'],
    ),
  },

  // ───── Workflow ─────
  PROCESSED_CLAIMS: {
    code: 'PROCESSED_CLAIMS',
    group: 'WORKFLOW',
    title: 'Processed Claims',
    description: 'Claims processed by payroll, with the pay period they were paid in.',
    requiredRoles: SELF_TEAM_ADMIN,
    paramFields: [P.range('Processed between'), ...PEOPLE, P.claimGroups],
    columns: columns(
      ['referenceNumber', 'Reference Number'],
      ...EMPLOYEE_COLS,
      ['companyRule', 'Company Rule'],
      ['claimGroup', 'Claim Group'],
      ['description', 'Description'],
      ['totalAmount', 'Total', 'money'],
      ['submittedAt', 'Date Submitted', 'datetime'],
      ['approvedAt', 'Date Approved', 'datetime'],
      ['processedAt', 'Processed', 'datetime'],
      ['payPeriod', 'Pay Period'],
      ['finalApprover', 'Final Approver'],
    ),
  },
  EXPENSE_CLAIM_WORKFLOW_STATUS: {
    code: 'EXPENSE_CLAIM_WORKFLOW_STATUS',
    group: 'WORKFLOW',
    title: 'Expense Claim Workflow Status',
    description: 'Submitted claims with their workflow status, current step and who it waits for.',
    requiredRoles: SELF_TEAM_ADMIN,
    paramFields: [P.range('Submitted between'), ...PEOPLE, P.claimGroups, P.processStatuses],
    columns: columns(
      ['referenceNumber', 'Reference Number'],
      ...EMPLOYEE_COLS,
      ['claimGroup', 'Claim Group'],
      ['totalAmount', 'Total', 'money'],
      ['status', 'Status'],
      ['processId', 'Workflow Process ID', 'integer'],
      ['workflowType', 'Workflow Type'],
      ['currentStep', 'Current Step', 'integer'],
      ['currentAssignees', 'Waiting For'],
      ['submittedAt', 'Date Submitted', 'datetime'],
      ['daysInWorkflow', 'Days In Workflow', 'integer'],
      ['escalated', 'Escalated', 'boolean'],
    ),
  },
  EXPENSE_CLAIM_REPORT: {
    code: 'EXPENSE_CLAIM_REPORT',
    group: 'WORKFLOW',
    title: 'Expense Claim Report',
    description: 'Claims with their totals and status (drafts excluded).',
    requiredRoles: SELF_TEAM_ADMIN,
    paramFields: [P.range('Submitted between'), ...PEOPLE, P.claimGroups, P.processStatuses],
    columns: columns(
      ['referenceNumber', 'Reference Number'],
      ...EMPLOYEE_COLS,
      ['companyRule', 'Company Rule'],
      ['claimGroup', 'Claim Group'],
      ['description', 'Description'],
      ['lines', 'Lines', 'integer'],
      ['totalAmount', 'Total', 'money'],
      ['status', 'Status'],
      ['submittedAt', 'Date Submitted', 'datetime'],
      ['finalApprover', 'Final Approver'],
      ['processedAt', 'Processed', 'datetime'],
    ),
  },
  CLAIM_LINE: {
    code: 'CLAIM_LINE',
    group: 'WORKFLOW',
    title: 'Claim Line',
    description: 'Every line of the submitted claims.',
    requiredRoles: SELF_TEAM_ADMIN,
    paramFields: [P.range('Line dates between'), ...PEOPLE, P.claimGroups, P.processStatuses],
    columns: columns(
      ['referenceNumber', 'Reference Number'],
      ...EMPLOYEE_COLS,
      ['claimGroup', 'Claim Group'],
      ['claimType', 'Claim Type'],
      ['date', 'Date', 'date'],
      ['startTime', 'Start Time'],
      ['endTime', 'End Time'],
      ['quantity', 'Quantity', 'decimal'],
      ['rate', 'Rate', 'decimal'],
      ['amount', 'Amount', 'money'],
      ['description', 'Description'],
      ['claimStatus', 'Claim Status'],
    ),
  },
  STEP_APPROVER_ACTIONS: {
    code: 'STEP_APPROVER_ACTIONS',
    group: 'WORKFLOW',
    title: 'Step Approver Actions',
    description:
      'Every action taken on a workflow step: approvals, declines, reassignments, parking and more.',
    requiredRoles: TEAM_ADMIN,
    paramFields: [P.range('Actions between'), ...PEOPLE, P.workflowTypes],
    columns: columns(
      ['actionDate', 'Action Date', 'datetime'],
      ['processId', 'Workflow Process ID', 'integer'],
      ['workflowType', 'Workflow Type'],
      ['subjectCode', 'Employee Code'],
      ['subjectName', 'Employee Name'],
      ['stepNo', 'Step', 'integer'],
      ['action', 'Action'],
      ['actor', 'Actor'],
      ['comment', 'Comment'],
      ['fromStatus', 'From Status'],
      ['toStatus', 'To Status'],
    ),
  },
  CLAIM_SUMMARY: {
    code: 'CLAIM_SUMMARY',
    group: 'WORKFLOW',
    title: 'Claim Summary',
    description: 'Per employee and claim type: lines, quantity, pending and processed amounts.',
    requiredRoles: SELF_TEAM_ADMIN,
    paramFields: [P.range('Line dates between'), ...PEOPLE, P.claimGroups, P.processStatuses],
    columns: columns(
      ...EMPLOYEE_COLS,
      ['companyRule', 'Company Rule'],
      ['claimGroup', 'Claim Group'],
      ['claimType', 'Claim Type'],
      ['lines', 'Lines', 'integer'],
      ['quantity', 'Quantity', 'decimal'],
      ['pendingAmount', 'Pending Amount', 'money'],
      ['processedAmount', 'Processed Amount', 'money'],
      ['totalAmount', 'Total Amount', 'money'],
    ),
  },
  PROCESS_HISTORY: {
    code: 'PROCESS_HISTORY',
    group: 'WORKFLOW',
    title: 'Process History',
    description: 'Workflow processes of every type with their status and key dates.',
    requiredRoles: TEAM_ADMIN,
    paramFields: [P.range('Submitted between'), ...PEOPLE, P.workflowTypes, P.processStatuses],
    columns: columns(
      ['processId', 'Workflow Process ID', 'integer'],
      ['workflowType', 'Workflow Type'],
      ['subjectCode', 'Employee Code'],
      ['subjectName', 'Employee Name'],
      ['submittedBy', 'Submitted By'],
      ['summary', 'Summary'],
      ['status', 'Status'],
      ['round', 'Round', 'integer'],
      ['submittedAt', 'Submitted', 'datetime'],
      ['finalApprovedAt', 'Final Approval', 'datetime'],
      ['processedAt', 'Processed', 'datetime'],
      ['completedAt', 'Completed', 'datetime'],
      ['escalated', 'Escalated', 'boolean'],
    ),
  },
  ESCALATION_ITEMS: {
    code: 'ESCALATION_ITEMS',
    group: 'WORKFLOW',
    title: 'Escalation Items',
    description: 'Workflow steps that went past their escalation time.',
    requiredRoles: TEAM_ADMIN,
    paramFields: [P.range('Escalated between'), ...PEOPLE, P.workflowTypes, P.processStatuses],
    columns: columns(
      ['processId', 'Workflow Process ID', 'integer'],
      ['workflowType', 'Workflow Type'],
      ['subjectCode', 'Employee Code'],
      ['subjectName', 'Employee Name'],
      ['summary', 'Summary'],
      ['stepNo', 'Step', 'integer'],
      ['assignee', 'Assignee'],
      ['assignedAt', 'Assigned', 'datetime'],
      ['dueAt', 'Due', 'datetime'],
      ['escalatedAt', 'Escalated', 'datetime'],
      ['stepStatus', 'Step Status'],
      ['processStatus', 'Process Status'],
    ),
  },

  // ───── Audit (new) ─────
  AUDIT_TRAIL_EXTRACT: {
    code: 'AUDIT_TRAIL_EXTRACT',
    group: 'AUDIT',
    title: 'Audit Trail Extract',
    description: 'Audit rows with the names of the fields that changed (values are in the audit explorer).',
    requiredRoles: AUDIT,
    paramFields: AUDIT_PARAMS,
    columns: columns(
      ...AUDIT_ROW,
      ['category', 'Category'],
      ['action', 'Action'],
      ['outcome', 'Outcome'],
      ['actor', 'Actor'],
      ['actingAsEmployeeId', 'Acting As Employee', 'integer'],
      ['subjectEmployeeId', 'Subject Employee', 'integer'],
      ['entityType', 'Entity Type'],
      ['entityId', 'Entity ID'],
      ['reason', 'Reason'],
      ['changedFields', 'Changed Fields'],
      ['ip', 'IP Address'],
      ['requestId', 'Request ID'],
    ),
  },
  SENSITIVE_DATA_ACCESS: {
    code: 'SENSITIVE_DATA_ACCESS',
    group: 'AUDIT',
    title: 'Sensitive Data Access',
    description: 'Views of sensitive data: payslips, tax certificates, unmasked numbers and downloads.',
    requiredRoles: AUDIT,
    paramFields: AUDIT_PARAMS,
    columns: columns(
      ...AUDIT_ROW,
      ['action', 'Action'],
      ['outcome', 'Outcome'],
      ['actor', 'Actor'],
      ['actingAsEmployeeId', 'Acting As Employee', 'integer'],
      ['subjectEmployeeId', 'Subject Employee', 'integer'],
      ['subjectEmployee', 'Subject Employee Name'],
      ['entityType', 'Entity Type'],
      ['entityId', 'Entity ID'],
      ['ip', 'IP Address'],
    ),
  },
  FAILED_LOGINS: {
    code: 'FAILED_LOGINS',
    group: 'AUDIT',
    title: 'Failed Logins',
    description: 'Failed sign-in attempts with the username that was tried (never the password).',
    requiredRoles: AUDIT,
    paramFields: AUDIT_PARAMS,
    columns: columns(
      ...AUDIT_ROW,
      ['usernameAttempted', 'Username Attempted'],
      ['reason', 'Reason'],
      ['userId', 'User ID'],
      ['ip', 'IP Address'],
      ['userAgent', 'User Agent'],
    ),
  },
  CHANGES_BY_USER: {
    code: 'CHANGES_BY_USER',
    group: 'AUDIT',
    title: 'Changes by User',
    description: 'Data changes and workflow actions, by the user who made them.',
    requiredRoles: AUDIT,
    paramFields: AUDIT_PARAMS,
    columns: columns(
      ['actor', 'Actor'],
      ...AUDIT_ROW,
      ['category', 'Category'],
      ['action', 'Action'],
      ['entityType', 'Entity Type'],
      ['entityId', 'Entity ID'],
      ['subjectEmployeeId', 'Subject Employee', 'integer'],
      ['changedFields', 'Changed Fields'],
    ),
  },
};

/** True when one of the caller's roles may run the report. */
export function canRunReport(meta: Pick<ReportMeta, 'requiredRoles'>, roles: readonly Role[]): boolean {
  return meta.requiredRoles.some((r) => roles.includes(r));
}

// ───────────── Endpoints ─────────────

export const ReportSummarySchema = z.object({
  code: ReportCodeSchema,
  group: ReportGroupSchema,
  title: z.string(),
  description: z.string(),
  formats: z.array(ReportFormatSchema),
  columns: z.array(ReportColumnSchema),
  params: z.array(ReportParamFieldSchema),
  pdfRowLimit: z.number().int(),
});
export type ReportSummary = z.infer<typeof ReportSummarySchema>;

const IdOption = z.object({ id: z.number().int(), code: z.string(), description: z.string() });

/** GET /reports: the groups and reports the caller may run, plus the small option lists. */
export const ReportCatalogueSchema = z.object({
  groups: z.array(
    z.object({ group: ReportGroupSchema, label: z.string(), reports: z.array(ReportSummarySchema) }),
  ),
  options: z.object({
    /** Company rules in the caller's scope. */
    companyRules: z.array(IdOption.extend({ companyName: z.string() })),
    leaveTypes: z.array(IdOption),
    claimGroups: z.array(IdOption),
  }),
});
export type ReportCatalogue = z.infer<typeof ReportCatalogueSchema>;

export const ReportCodeParamSchema = z.object({ code: ReportCodeSchema });

/** GET /reports/:code/employees?search=&page=&pageSize=: the picker, limited to the caller's scope. */
export const ReportEmployeesQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  includeTerminated: BooleanQuerySchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type ReportEmployeesQuery = z.infer<typeof ReportEmployeesQuerySchema>;

export const ReportEmployeeOptionSchema = z.object({
  employeeId: z.number().int(),
  employeeCode: z.string(),
  name: z.string(),
  companyRule: z.string(),
  status: z.string(),
});
export type ReportEmployeeOption = z.infer<typeof ReportEmployeeOptionSchema>;

export const ReportEmployeesResponseSchema = z.object({
  items: z.array(ReportEmployeeOptionSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type ReportEmployeesResponse = z.infer<typeof ReportEmployeesResponseSchema>;

/**
 * POST /reports/:code/run. `params` is validated against the report's own schema
 * ({@link REPORT_PARAM_SCHEMAS}); errors come back on `params.<name>`. `page` and `pageSize` apply
 * to `format: 'json'` only.
 */
export const RunReportRequestSchema = z.object({
  params: z.record(z.unknown()).default({}),
  format: ReportFormatSchema.default('json'),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(REPORT_MAX_PAGE_SIZE).default(REPORT_DEFAULT_PAGE_SIZE),
});
export type RunReportRequest = z.infer<typeof RunReportRequestSchema>;

export const ReportCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type ReportCell = z.infer<typeof ReportCellSchema>;
export type ReportRow = Record<string, ReportCell>;

/**
 * `format: 'json'`: one page of rows for the on-screen grid. Dates are `YYYY-MM-DD`, timestamps
 * ISO-8601, decimals strings. There is no total (the rows are streamed from the database);
 * `hasMore` drives the pager.
 */
export const ReportPageSchema = z.object({
  code: ReportCodeSchema,
  title: z.string(),
  columns: z.array(ReportColumnSchema),
  rows: z.array(z.record(ReportCellSchema)),
  page: z.number().int(),
  pageSize: z.number().int(),
  hasMore: z.boolean(),
  generatedAt: TimestampSchema,
});
export type ReportPage = z.infer<typeof ReportPageSchema>;
