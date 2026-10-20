import { z } from 'zod';
import {
  ContractStatusSchema,
  EmployeeStatusSchema,
  InitiationStatusSchema,
  ParticipantRoleSchema,
  ReviewNotifyModeSchema,
  ReviewStatusSchema,
  TemplateItemKindSchema,
  TemplateStatusSchema,
} from '../enums';
import {
  PERFORMANCE_PARAMETER_TABLES,
  type PerformanceParameterTable,
  REVIEW_TEMPLATE_MODES,
  RatingScalePointSchema,
  type ReviewTemplateMode,
} from '../performance';
import { BooleanQuerySchema } from './calendar';
import { BusinessDateSchema, pageOf, TimestampSchema, VersionSchema } from './common';

// Contracts for the Performance module (sections 5.9 and 12.9): parameter lookups, rating scales,
// templates, contract initiation, contracts, reviews, scores, results and contract reviews.
// Decimals (weights, ratings, scores) travel as strings.

// ───────────── Shared pieces ─────────────

const name200 = z.string().trim().min(1).max(200);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** A weight in percent: 0–100 with up to 2 decimals. */
export const WeightSchema = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, { message: 'Enter a weight between 0 and 100 (2 decimals)' })
  .refine((v) => Number(v) <= 100, { message: 'A weight cannot be more than 100' });

/** A rating on the template's rating scale (checked by the server), up to 2 decimals. */
export const RatingSchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,4}(\.\d{1,2})?$/, { message: 'Enter a rating (up to 2 decimals)' });

/**
 * A multi-select query parameter: `?companies=1,2` or `?companies=1&companies=2`. Blank values
 * are ignored; an empty selection means "no filter".
 */
function listParam<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    const raw = Array.isArray(value) ? value : [value];
    const parts = raw
      .flatMap((v) => String(v).split(','))
      .map((v) => v.trim())
      .filter((v) => v !== '');
    return parts.length === 0 ? undefined : parts;
  }, z.array(item).max(200).optional());
}

const idList = listParam(z.coerce.number().int().positive());
const textList = listParam(z.string().max(200));

/** `field:asc` and `field:desc` for every field, as a z.enum tuple. */
function sortsOf<const F extends string>(fields: readonly F[]): [SortOf<F>, ...SortOf<F>[]] {
  return fields.flatMap((f) => [`${f}:asc`, `${f}:desc`]) as [SortOf<F>, ...SortOf<F>[]];
}
type SortOf<F extends string> = `${F}:asc` | `${F}:desc`;

/** Grid export formats (CSV or Excel); every export is audited as `EXPORT.*`. */
export const PERFORMANCE_EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export const PerformanceExportFormatSchema = z.enum(PERFORMANCE_EXPORT_FORMATS);
export type PerformanceExportFormat = z.infer<typeof PerformanceExportFormatSchema>;

/** Most rows one grid export writes (the audit row says when it was cut). */
export const PERFORMANCE_EXPORT_MAX_ROWS = 10_000;

/** A column of a grid export: the row field and its header. */
export interface PerformanceExportColumn<K extends string> {
  key: K;
  header: string;
}

function dateOrder(a: string | null | undefined, b: string | null | undefined): boolean {
  return !a || !b || b >= a;
}

export const SectionTotalSchema = z.object({
  section: TemplateItemKindSchema,
  total: z.string(),
  valid: z.boolean(),
});
export type SectionTotal = z.infer<typeof SectionTotalSchema>;

// ───────────── Parameter lookups (GET /lookups/parameters/:table, /admin/parameters/:table) ─────────────

export const PerformanceParameterTableSchema = z.enum(
  PERFORMANCE_PARAMETER_TABLES as unknown as [PerformanceParameterTable, ...PerformanceParameterTable[]],
);

export const ParameterTableParamSchema = z.object({ table: PerformanceParameterTableSchema });
export type ParameterTableParam = z.infer<typeof ParameterTableParamSchema>;

export const ParameterValueParamSchema = z.object({
  table: PerformanceParameterTableSchema,
  id: z.coerce.number().int().positive(),
});
export type ParameterValueParam = z.infer<typeof ParameterValueParamSchema>;

/** `?parentId=` lists the children of one row (KPIs of a KPA, competencies of an area). */
export const ParameterValuesQuerySchema = z.object({
  parentId: z.coerce.number().int().positive().optional(),
});
export type ParameterValuesQuery = z.infer<typeof ParameterValuesQuerySchema>;

export const ParameterValueSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  description: z.string(),
  parentId: z.number().int().nullable(),
  sortOrder: z.number().int(),
});
export type ParameterValue = z.infer<typeof ParameterValueSchema>;

export const ParameterValuesResponseSchema = z.object({
  table: PerformanceParameterTableSchema,
  /** The parent table of a hierarchical table (KPI → KPA), else null. */
  parentTable: PerformanceParameterTableSchema.nullable(),
  items: z.array(ParameterValueSchema),
});
export type ParameterValuesResponse = z.infer<typeof ParameterValuesResponseSchema>;

export const AdminParameterValueSchema = ParameterValueSchema.extend({
  parentCode: z.string().nullable(),
  isActive: z.boolean(),
  version: z.number().int(),
});
export type AdminParameterValue = z.infer<typeof AdminParameterValueSchema>;

export const AdminParameterValuesResponseSchema = z.object({
  table: PerformanceParameterTableSchema,
  parentTable: PerformanceParameterTableSchema.nullable(),
  items: z.array(AdminParameterValueSchema),
});
export type AdminParameterValuesResponse = z.infer<typeof AdminParameterValuesResponseSchema>;

export const CreateParameterValueRequestSchema = z.object({
  code: z.string().trim().min(1).max(50),
  description: name200,
  /** Required for KPI, Sub KPI, Competency and Sub Competency; not allowed elsewhere. */
  parentId: z.number().int().positive().nullable().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});
export type CreateParameterValueRequest = z.infer<typeof CreateParameterValueRequestSchema>;

/** The code never changes (templates, contracts and reviews refer to it). */
export const UpdateParameterValueRequestSchema = VersionSchema.extend({
  description: name200.optional(),
  parentId: z.number().int().positive().nullable().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateParameterValueRequest = z.infer<typeof UpdateParameterValueRequestSchema>;

// ───────────── Rating scales ─────────────

export const RatingScaleSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  points: z.array(RatingScalePointSchema),
  min: z.string(),
  max: z.string(),
});
export type RatingScale = z.infer<typeof RatingScaleSchema>;

export const RatingScalesResponseSchema = z.object({ items: z.array(RatingScaleSchema) });
export type RatingScalesResponse = z.infer<typeof RatingScalesResponseSchema>;

// ───────────── Templates (/performance/templates) ─────────────

export const TemplateItemInputSchema = z.object({
  /** Keep an existing item (PUT); new items have no id. */
  id: z.number().int().positive().optional(),
  kind: TemplateItemKindSchema,
  /** A KPA, KPI or competency row of the matching table (none for objectives). */
  parameterValueId: z.number().int().positive().nullable().optional(),
  /** Defaults to the parameter's description; required for objectives. */
  title: z.string().trim().min(1).max(300).optional(),
  weight: WeightSchema,
  target: optionalText(500),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});
export type TemplateItemInput = z.infer<typeof TemplateItemInputSchema>;

export const PerformanceItemSchema = z.object({
  id: z.number().int(),
  kind: TemplateItemKindSchema,
  parameterValueId: z.number().int().nullable(),
  parameterCode: z.string().nullable(),
  title: z.string(),
  weight: z.string(),
  target: z.string().nullable(),
  sortOrder: z.number().int(),
});
export type PerformanceItem = z.infer<typeof PerformanceItemSchema>;

/** One row of the Performance Templates grid (section 5.9). */
export const PerformanceTemplateRowSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  contractStartDate: BusinessDateSchema,
  contractEndDate: BusinessDateSchema,
  ratingScaleId: z.number().int().nullable(),
  /** "Overall Rating Scale". */
  ratingScale: z.string().nullable(),
  processDefinition: z.string().nullable(),
  /** "Linked Contracts": contracts created from the template (archived included). */
  linkedContracts: z.number().int(),
  ownerUserId: z.string(),
  /** "Template Owner". */
  templateOwner: z.string(),
  createdFromTemplateId: z.number().int().nullable(),
  /** "Created From Template". */
  createdFromTemplate: z.string().nullable(),
  status: TemplateStatusSchema,
  version: z.number().int(),
  createdAt: TimestampSchema,
});
export type PerformanceTemplateRow = z.infer<typeof PerformanceTemplateRowSchema>;

export const PerformanceTemplateSchema = PerformanceTemplateRowSchema.extend({
  items: z.array(PerformanceItemSchema),
  sectionTotals: z.array(SectionTotalSchema),
});
export type PerformanceTemplate = z.infer<typeof PerformanceTemplateSchema>;

/** Sortable columns of the templates grid (`?sort=field:asc|desc`). */
export const TEMPLATE_SORT_FIELDS = [
  'name',
  'contractStartDate',
  'contractEndDate',
  'ratingScale',
  'processDefinition',
  'linkedContracts',
  'createdFromTemplate',
  'status',
  'createdAt',
] as const;
export const TEMPLATE_SORTS = sortsOf(TEMPLATE_SORT_FIELDS);
export type TemplateSort = (typeof TEMPLATE_SORTS)[number];

const templateFilterShape = {
  status: TemplateStatusSchema.optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.enum(TEMPLATE_SORTS).default('name:asc'),
};

export const TemplatesQuerySchema = z.object({
  ...templateFilterShape,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type TemplatesQuery = z.infer<typeof TemplatesQuerySchema>;

/** GET /performance/templates/export?…&format=csv|xlsx (audited `EXPORT.PERFORMANCE_TEMPLATES`). */
export const TemplatesExportQuerySchema = z.object({
  ...templateFilterShape,
  format: PerformanceExportFormatSchema.default('csv'),
});
export type TemplatesExportQuery = z.infer<typeof TemplatesExportQuerySchema>;

export const TemplatesResponseSchema = pageOf(PerformanceTemplateRowSchema);
export type TemplatesResponse = z.infer<typeof TemplatesResponseSchema>;

export const CreateTemplateRequestSchema = z
  .object({
    name: name200,
    contractStartDate: BusinessDateSchema,
    contractEndDate: BusinessDateSchema,
    ratingScaleId: z.number().int().positive(),
    processDefinition: optionalText(200),
    /** A new template is a DRAFT unless created ACTIVE. */
    status: z.enum(['DRAFT', 'ACTIVE']).default('DRAFT'),
    items: z.array(TemplateItemInputSchema).max(200).default([]),
  })
  .refine((v) => dateOrder(v.contractStartDate, v.contractEndDate), {
    path: ['contractEndDate'],
    message: 'The end date cannot be before the start date',
  });
export type CreateTemplateRequest = z.infer<typeof CreateTemplateRequestSchema>;

/** Items can change only while the template is a DRAFT; `items` replaces the list. */
export const UpdateTemplateRequestSchema = VersionSchema.extend({
  name: name200.optional(),
  contractStartDate: BusinessDateSchema.optional(),
  contractEndDate: BusinessDateSchema.optional(),
  ratingScaleId: z.number().int().positive().optional(),
  processDefinition: optionalText(200),
  status: TemplateStatusSchema.optional(),
  items: z.array(TemplateItemInputSchema).max(200).optional(),
});
export type UpdateTemplateRequest = z.infer<typeof UpdateTemplateRequestSchema>;

export const CopyTemplateRequestSchema = z.object({ name: name200.optional() });
export type CopyTemplateRequest = z.infer<typeof CopyTemplateRequestSchema>;

// ───────────── Contract initiation (/performance/contract-initiations) ─────────────

/** Who gets a contract: active employees matching every given filter, within the HR scope. */
export const InitiationFiltersSchema = z.object({
  companyIds: z.array(z.number().int().positive()).max(200).optional(),
  companyRuleIds: z.array(z.number().int().positive()).max(200).optional(),
  employeeIds: z.array(z.number().int().positive()).max(5000).optional(),
  /** Job titles (Employee.jobTitle). */
  positions: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
});
export type InitiationFilters = z.infer<typeof InitiationFiltersSchema>;

export const CreateInitiationRequestSchema = z
  .object({
    /** "Contract Name": the name every created contract gets. */
    name: name200,
    templateId: z.number().int().positive(),
    /** Default to the template's contract dates. */
    contractStartDate: BusinessDateSchema.optional(),
    contractEndDate: BusinessDateSchema.optional(),
    contractType: optionalText(100),
    filters: InitiationFiltersSchema.default({}),
  })
  .refine((v) => dateOrder(v.contractStartDate, v.contractEndDate), {
    path: ['contractEndDate'],
    message: 'The end date cannot be before the start date',
  });
export type CreateInitiationRequest = z.infer<typeof CreateInitiationRequestSchema>;

export const InitiationErrorSchema = z.object({
  employeeId: z.number().int(),
  employeeCode: z.string(),
  employeeName: z.string(),
  message: z.string(),
});
export type InitiationError = z.infer<typeof InitiationErrorSchema>;

/** One row of the Contract Initiation grid (section 5.9). */
export const ContractInitiationRowSchema = z.object({
  id: z.number().int(),
  /** "Contract Name". */
  name: z.string(),
  templateId: z.number().int(),
  templateName: z.string(),
  contractStartDate: BusinessDateSchema,
  contractEndDate: BusinessDateSchema,
  status: InitiationStatusSchema,
  /** "Progress": processed contracts as a whole percentage. */
  progress: z.number().int(),
  contractCount: z.number().int(),
  /** "Created". */
  createdCount: z.number().int(),
  /** "Failed". */
  failedCount: z.number().int(),
  /** "Last Changed". */
  lastChanged: TimestampSchema,
  createdAt: TimestampSchema,
  createdBy: z.string(),
});
export type ContractInitiationRow = z.infer<typeof ContractInitiationRowSchema>;

export const ContractInitiationSchema = ContractInitiationRowSchema.extend({
  contractType: z.string().nullable(),
  filters: InitiationFiltersSchema,
  /** The employees selected when the initiation was created. */
  employeeIds: z.array(z.number().int()),
  errors: z.array(InitiationErrorSchema),
});
export type ContractInitiation = z.infer<typeof ContractInitiationSchema>;

/** Sortable columns of the Contract Initiation grid. */
export const INITIATION_SORT_FIELDS = [
  'name',
  'templateName',
  'contractStartDate',
  'contractEndDate',
  'status',
  'contractCount',
  'createdCount',
  'failedCount',
  'lastChanged',
  'createdAt',
] as const;
export const INITIATION_SORTS = sortsOf(INITIATION_SORT_FIELDS);
export type InitiationSort = (typeof INITIATION_SORTS)[number];

const initiationFilterShape = {
  status: InitiationStatusSchema.optional(),
  search: z.string().trim().max(100).optional(),
  /** Default: newest first (the order before sorting existed). */
  sort: z.enum(INITIATION_SORTS).default('createdAt:desc'),
};

export const InitiationsQuerySchema = z.object({
  ...initiationFilterShape,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type InitiationsQuery = z.infer<typeof InitiationsQuerySchema>;

/** GET /performance/contract-initiations/export (audited `EXPORT.CONTRACT_INITIATIONS`). */
export const InitiationsExportQuerySchema = z.object({
  ...initiationFilterShape,
  format: PerformanceExportFormatSchema.default('csv'),
});
export type InitiationsExportQuery = z.infer<typeof InitiationsExportQuerySchema>;

export const InitiationsResponseSchema = pageOf(ContractInitiationRowSchema);
export type InitiationsResponse = z.infer<typeof InitiationsResponseSchema>;

// ───────────── Contracts (/performance/contracts) ─────────────

/**
 * Sortable columns of the Contracts grids. `startDate` (kept from the first release) and
 * `contractStartDate` both sort by the contract start.
 */
export const CONTRACT_SORT_FIELDS = [
  'employeeCode',
  'lastName',
  'firstName',
  'startDate',
  'contractStartDate',
  'contractEndDate',
  'contractName',
  'templateName',
  'jobTitle',
  'jobGrade',
  'employeeCompanyRule',
  'reportsTo',
  'employeeDateEngaged',
  'employeeStatus',
  'contractType',
  'contractStatus',
  'archivedAt',
] as const;
export const CONTRACT_SORTS = sortsOf(CONTRACT_SORT_FIELDS);
export type ContractSort = (typeof CONTRACT_SORTS)[number];

const contractFilterShape = {
  /** false (default) = Contracts; true = Archived Contracts. */
  archived: BooleanQuerySchema.default(false),
  employeeId: z.coerce.number().int().positive().optional(),
  templateId: z.coerce.number().int().positive().optional(),
  initiationId: z.coerce.number().int().positive().optional(),
  status: ContractStatusSchema.optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.enum(CONTRACT_SORTS).default('employeeCode:asc'),
};

export const ContractsQuerySchema = z.object({
  ...contractFilterShape,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ContractsQuery = z.infer<typeof ContractsQuerySchema>;

/** GET /performance/contracts/export (audited `EXPORT.PERFORMANCE_CONTRACTS`). */
export const ContractsExportQuerySchema = z.object({
  ...contractFilterShape,
  format: PerformanceExportFormatSchema.default('csv'),
});
export type ContractsExportQuery = z.infer<typeof ContractsExportQuerySchema>;

/** One row of the Contracts / Archived Contracts grid (section 5.9). */
export const PerformanceContractRowSchema = z.object({
  id: z.number().int(),
  employeeId: z.number().int(),
  employeeCode: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  templateId: z.number().int(),
  templateName: z.string(),
  contractName: z.string(),
  contractStartDate: BusinessDateSchema,
  contractEndDate: BusinessDateSchema,
  jobTitle: z.string().nullable(),
  jobGrade: z.string().nullable(),
  employeeCompanyRule: z.string(),
  /** The employee's manager, "{First} {Last}". */
  reportsTo: z.string().nullable(),
  employeeDateEngaged: BusinessDateSchema.nullable(),
  employeeStatus: EmployeeStatusSchema,
  contractType: z.string().nullable(),
  contractStatus: ContractStatusSchema,
  currentlyAssignedUserId: z.string().nullable(),
  /** "Currently Assigned": who holds the contract now. */
  currentlyAssigned: z.string().nullable(),
  initiationId: z.number().int().nullable(),
  archivedAt: TimestampSchema.nullable(),
  version: z.number().int(),
});
export type PerformanceContractRow = z.infer<typeof PerformanceContractRowSchema>;

export const PerformanceContractSchema = PerformanceContractRowSchema.extend({
  ratingScale: RatingScaleSchema.nullable(),
  items: z.array(PerformanceItemSchema),
  sectionTotals: z.array(SectionTotalSchema),
  /** Statuses the caller may move the contract to (PUT `status`, or archive). */
  allowedStatuses: z.array(ContractStatusSchema),
  canEdit: z.boolean(),
  /**
   * The caller may change `currentlyAssignedUserId` (PUT): the employee's manager or HR in scope,
   * until the contract is archived (ASSUMPTION A95).
   */
  canChangeAssignee: z.boolean(),
});
export type PerformanceContract = z.infer<typeof PerformanceContractSchema>;

export const ContractsResponseSchema = pageOf(PerformanceContractRowSchema);
export type ContractsResponse = z.infer<typeof ContractsResponseSchema>;

/** PUT /performance/contracts/:id. Items and dates only while DRAFT; `status` moves it on. */
export const UpdateContractRequestSchema = VersionSchema.extend({
  name: name200.optional(),
  contractType: optionalText(100),
  startDate: BusinessDateSchema.optional(),
  endDate: BusinessDateSchema.optional(),
  currentlyAssignedUserId: z.string().uuid().nullable().optional(),
  status: z.enum(['AGREED', 'ACTIVE', 'CLOSED']).optional(),
  items: z.array(TemplateItemInputSchema).max(200).optional(),
});
export type UpdateContractRequest = z.infer<typeof UpdateContractRequestSchema>;

export const ArchiveContractRequestSchema = VersionSchema.extend({
  reason: z.string().trim().max(500).optional(),
});
export type ArchiveContractRequest = z.infer<typeof ArchiveContractRequestSchema>;

// ───────────── Reviews (/performance/reviews) ─────────────

export const ReviewTemplateModeSchema = z.enum(
  REVIEW_TEMPLATE_MODES as unknown as [ReviewTemplateMode, ...ReviewTemplateMode[]],
);

export const ReviewObjectiveInputSchema = z.object({
  /** Keep an existing objective (PUT); new objectives have no id. */
  id: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(300),
  description: optionalText(2000),
  weight: WeightSchema,
});
export type ReviewObjectiveInput = z.infer<typeof ReviewObjectiveInputSchema>;

export const ReviewerInputSchema = z.object({
  employeeId: z.number().int().positive(),
  /** Relative weight in Total Actual; default: reviewers share equally (ASSUMPTION A93). */
  weight: WeightSchema.nullable().optional(),
});
export type ReviewerInput = z.infer<typeof ReviewerInputSchema>;

export const RevieweeInputSchema = z.object({
  employeeId: z.number().int().positive(),
  /** Shared Template: the reviewee's contract (default: their contract from the template). */
  contractId: z.number().int().positive().optional(),
  /** Weight of the self-assessment in Total Actual (default 0). */
  selfWeight: WeightSchema.nullable().optional(),
  reviewers: z.array(ReviewerInputSchema).min(1).max(20),
});
export type RevieweeInput = z.infer<typeof RevieweeInputSchema>;

const reviewSharedShape = {
  /** Overview */
  name: name200,
  category: z.string().trim().min(1).max(50),
  type: z.string().trim().min(1).max(50),
  cycleStartDate: BusinessDateSchema,
  cycleEndDate: BusinessDateSchema,
  /** Shared Review Info: Notify Immediately | Never | Specific Date. */
  notifyMode: ReviewNotifyModeSchema.default('IMMEDIATELY'),
  notifyDate: BusinessDateSchema.nullable().optional(),
};

function notifyCheck(v: { notifyMode?: string; notifyDate?: string | null }, ctx: z.RefinementCtx): void {
  if (v.notifyMode === 'SPECIFIC_DATE' && !v.notifyDate)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['notifyDate'],
      message: 'Choose the date to notify on',
    });
  if (v.notifyMode !== undefined && v.notifyMode !== 'SPECIFIC_DATE' && v.notifyDate)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['notifyDate'],
      message: 'A notify date is only used with "Specific Date"',
    });
}

/**
 * POST /performance/reviews: the Create Review wizard (Overview → Shared Review Info → Complete).
 * One review is created per reviewee, sharing the overview, notify settings and objectives.
 */
export const CreateReviewRequestSchema = z
  .object({
    ...reviewSharedShape,
    /** Reviewees: "Shared Template" (their contract) or "Free Format Template" (objectives only). */
    templateMode: ReviewTemplateModeSchema,
    templateId: z.number().int().positive().nullable().optional(),
    /**
     * Free Format only: the scale Total Actual is normalised to (default: the first scale, the
     * seeded "1–5"). A shared-template review uses its template's scale.
     */
    ratingScaleId: z.number().int().positive().nullable().optional(),
    /** Modify / Add Objectives: weights add up to 100. Required for Free Format. */
    objectives: z
      .array(ReviewObjectiveInputSchema.omit({ id: true }))
      .max(50)
      .default([]),
    /** Add Employees, each with their reviewers. */
    reviewees: z.array(RevieweeInputSchema).min(1).max(500),
  })
  .superRefine((v, ctx) => {
    if (!dateOrder(v.cycleStartDate, v.cycleEndDate))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cycleEndDate'],
        message: 'The review cycle cannot end before it starts',
      });
    notifyCheck(v, ctx);
    if (v.templateMode === 'SHARED' && !v.templateId)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['templateId'],
        message: 'Choose the shared template',
      });
    if (v.templateMode === 'FREE_FORMAT' && v.templateId)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['templateId'],
        message: 'A free format review has no template',
      });
    if (v.templateMode === 'SHARED' && v.ratingScaleId)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ratingScaleId'],
        message: 'A shared template review uses the template rating scale',
      });
    if (v.templateMode === 'FREE_FORMAT' && v.objectives.length === 0)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['objectives'],
        message: 'Add the objectives of a free format review',
      });
  });
export type CreateReviewRequest = z.infer<typeof CreateReviewRequestSchema>;

/** PUT /performance/reviews/:id: only while DRAFT or OPEN. Lists replace the current ones. */
export const UpdateReviewRequestSchema = VersionSchema.extend({
  name: name200.optional(),
  category: z.string().trim().min(1).max(50).optional(),
  type: z.string().trim().min(1).max(50).optional(),
  cycleStartDate: BusinessDateSchema.optional(),
  cycleEndDate: BusinessDateSchema.optional(),
  notifyMode: ReviewNotifyModeSchema.optional(),
  notifyDate: BusinessDateSchema.nullable().optional(),
  objectives: z.array(ReviewObjectiveInputSchema).max(50).optional(),
  reviewers: z.array(ReviewerInputSchema).min(1).max(20).optional(),
  selfWeight: WeightSchema.nullable().optional(),
});
export type UpdateReviewRequest = z.infer<typeof UpdateReviewRequestSchema>;

export const CopyReviewRequestSchema = z
  .object({
    name: name200.optional(),
    cycleStartDate: BusinessDateSchema.optional(),
    cycleEndDate: BusinessDateSchema.optional(),
  })
  .refine((v) => dateOrder(v.cycleStartDate, v.cycleEndDate), {
    path: ['cycleEndDate'],
    message: 'The review cycle cannot end before it starts',
  });
export type CopyReviewRequest = z.infer<typeof CopyReviewRequestSchema>;

/** POST /performance/reviews/:id/status: moves the review along its flow. */
export const ReviewStatusRequestSchema = VersionSchema.extend({
  status: ReviewStatusSchema,
  comment: z.string().trim().max(1000).optional(),
});
export type ReviewStatusRequest = z.infer<typeof ReviewStatusRequestSchema>;

export const ScoreInputSchema = z
  .object({
    contractItemId: z.number().int().positive().optional(),
    objectiveId: z.number().int().positive().optional(),
    /** Null clears the rating. */
    rating: RatingSchema.nullable(),
    comment: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => (v.contractItemId === undefined) !== (v.objectiveId === undefined), {
    message: 'Rate either a contract item or an objective',
    path: ['contractItemId'],
  });
export type ScoreInput = z.infer<typeof ScoreInputSchema>;

/** POST /performance/reviews/:id/scores: the caller's ratings and comments. */
export const SubmitScoresRequestSchema = z.object({
  scores: z.array(ScoreInputSchema).min(1).max(300),
  /** false saves a draft that does not count towards Total Actual yet. */
  submit: z.boolean().default(true),
});
export type SubmitScoresRequest = z.infer<typeof SubmitScoresRequestSchema>;

export const ReviewParticipantSchema = z.object({
  id: z.number().int(),
  role: ParticipantRoleSchema,
  employeeId: z.number().int().nullable(),
  userId: z.string().nullable(),
  name: z.string(),
  employeeCode: z.string().nullable(),
  /** The weight as stored (null = the default, ASSUMPTION A93). */
  weight: z.string().nullable(),
  /** The weight used in Total Actual. */
  effectiveWeight: z.string(),
  submittedAt: TimestampSchema.nullable(),
  /** This participant's normalised total (shown to HR, auditors and the participant). */
  total: z.string().nullable(),
});
export type ReviewParticipant = z.infer<typeof ReviewParticipantSchema>;

export const ReviewObjectiveSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  weight: z.string(),
  sortOrder: z.number().int(),
});
export type ReviewObjective = z.infer<typeof ReviewObjectiveSchema>;

/** Something to rate: a contract item or a review objective. */
export const ReviewItemSchema = z.object({
  contractItemId: z.number().int().nullable(),
  objectiveId: z.number().int().nullable(),
  section: TemplateItemKindSchema,
  title: z.string(),
  weight: z.string(),
  target: z.string().nullable(),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;

export const ReviewScoreSchema = z.object({
  contractItemId: z.number().int().nullable(),
  objectiveId: z.number().int().nullable(),
  reviewerUserId: z.string(),
  reviewerName: z.string(),
  role: ParticipantRoleSchema,
  rating: z.string().nullable(),
  ratingLabel: z.string().nullable(),
  /** rating × weight / 100. */
  itemScore: z.string().nullable(),
  comment: z.string().nullable(),
  submittedAt: TimestampSchema.nullable(),
});
export type ReviewScore = z.infer<typeof ReviewScoreSchema>;

/** One row of the Edit Review and Review Results lists. */
export const ReviewRowSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  category: z.string(),
  categoryDescription: z.string(),
  type: z.string(),
  typeDescription: z.string(),
  cycleStartDate: BusinessDateSchema,
  cycleEndDate: BusinessDateSchema,
  notifyMode: ReviewNotifyModeSchema,
  notifyDate: BusinessDateSchema.nullable(),
  notifiedAt: TimestampSchema.nullable(),
  templateMode: ReviewTemplateModeSchema,
  status: ReviewStatusSchema,
  /** Review Total Actual on the rating scale (4 dp), null until scored. */
  totalActual: z.string().nullable(),
  employeeId: z.number().int().nullable(),
  employeeCode: z.string().nullable(),
  employeeName: z.string().nullable(),
  employeeSurname: z.string().nullable(),
  contractId: z.number().int().nullable(),
  contractName: z.string().nullable(),
  templateName: z.string().nullable(),
  reviewerCount: z.number().int(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  version: z.number().int(),
  /** The caller may change the review (PUT): HR in scope while it is DRAFT or OPEN. */
  canEdit: z.boolean(),
  /** Statuses the caller may move the review to (POST …/status). */
  allowedStatuses: z.array(ReviewStatusSchema),
});
export type ReviewRow = z.infer<typeof ReviewRowSchema>;

export const ReviewDetailSchema = ReviewRowSchema.extend({
  ratingScale: RatingScaleSchema.nullable(),
  objectives: z.array(ReviewObjectiveSchema),
  participants: z.array(ReviewParticipantSchema),
  items: z.array(ReviewItemSchema),
  sectionTotals: z.array(SectionTotalSchema),
  /** The scores the caller may see: all for HR and auditors, else their own. */
  scores: z.array(ReviewScoreSchema),
  /** The caller's part in the review. */
  myRole: ParticipantRoleSchema.nullable(),
  canEdit: z.boolean(),
  /** True when the caller may submit scores now. */
  canScore: z.boolean(),
  allowedStatuses: z.array(ReviewStatusSchema),
});
export type ReviewDetail = z.infer<typeof ReviewDetailSchema>;

export const CreateReviewResponseSchema = z.object({ items: z.array(ReviewDetailSchema) });
export type CreateReviewResponse = z.infer<typeof CreateReviewResponseSchema>;

export const REVIEW_SORTS = [
  'createdAt:desc',
  'createdAt:asc',
  'name:asc',
  'name:desc',
  'cycleStartDate:desc',
  'cycleStartDate:asc',
  'cycleEndDate:desc',
  'cycleEndDate:asc',
  'status:asc',
  'totalActual:desc',
  'totalActual:asc',
  'employee:asc',
  'employee:desc',
] as const;
export const ReviewSortSchema = z.enum(REVIEW_SORTS);
export type ReviewSort = z.infer<typeof ReviewSortSchema>;

const reviewListShape = {
  /** Filter: review name, employee name or code contains. */
  search: z.string().trim().max(100).optional(),
  statuses: listParam(ReviewStatusSchema),
  categories: textList,
  types: textList,
  employeeId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

/** GET /performance/reviews (Edit Review): Filter and Sort by. */
export const ReviewsQuerySchema = z.object({
  ...reviewListShape,
  sort: ReviewSortSchema.default('createdAt:desc'),
});
export type ReviewsQuery = z.infer<typeof ReviewsQuerySchema>;

export const ReviewsResponseSchema = pageOf(ReviewRowSchema);
export type ReviewsResponse = z.infer<typeof ReviewsResponseSchema>;

/** GET /performance/results (Review Results): scored reviews only. */
export const ResultsQuerySchema = z.object({
  ...reviewListShape,
  sort: ReviewSortSchema.default('totalActual:desc'),
});
export type ResultsQuery = z.infer<typeof ResultsQuerySchema>;

export const ResultsResponseSchema = pageOf(ReviewRowSchema);
export type ResultsResponse = z.infer<typeof ResultsResponseSchema>;

// ───────────── Contract reviews (GET /performance/contract-reviews) ─────────────

/** Sortable columns of the Reviews (contract reviews) grid. */
export const CONTRACT_REVIEW_SORT_FIELDS = [
  'employeeSurname',
  'employeeName',
  'employeeCompany',
  'employeeCompanyRule',
  'employeePosition',
  'contractName',
  'reviewName',
  'reviewCategory',
  'reviewType',
  'reviewCycleStartDate',
  'reviewCycleEndDate',
  'reviewStatus',
  'reviewTotalActual',
] as const;
export const CONTRACT_REVIEW_SORTS = sortsOf(CONTRACT_REVIEW_SORT_FIELDS);
export type ContractReviewSort = (typeof CONTRACT_REVIEW_SORTS)[number];

function contractReviewRanges(
  v: { startFrom?: string; startTo?: string; endFrom?: string; endTo?: string },
  ctx: z.RefinementCtx,
): void {
  if (!dateOrder(v.startFrom, v.startTo))
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['startTo'],
      message: 'The range ends before it starts',
    });
  if (!dateOrder(v.endFrom, v.endTo))
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endTo'],
      message: 'The range ends before it starts',
    });
}

/** The Filter Selection modal (section 5.9): every multi-select plus name, statuses and dates. */
const contractReviewFilterShape = {
  companies: idList,
  companyRules: idList,
  employees: idList,
  /** Job titles (Employee.jobTitle). */
  positions: textList,
  reviewTypes: textList,
  reviewCategories: textList,
  /** Review Name contains. */
  reviewName: z.string().trim().max(200).optional(),
  statuses: listParam(ReviewStatusSchema),
  /** Start Date Between / And (review cycle start). */
  startFrom: BusinessDateSchema.optional(),
  startTo: BusinessDateSchema.optional(),
  /** End Date Between / And (review cycle end). */
  endFrom: BusinessDateSchema.optional(),
  endTo: BusinessDateSchema.optional(),
  sort: z.enum(CONTRACT_REVIEW_SORTS).default('employeeSurname:asc'),
};

export const ContractReviewsQuerySchema = z
  .object({
    ...contractReviewFilterShape,
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .superRefine(contractReviewRanges);
export type ContractReviewsQuery = z.infer<typeof ContractReviewsQuerySchema>;

/** GET /performance/contract-reviews/export: the same filters (audited `EXPORT.CONTRACT_REVIEWS`). */
export const ContractReviewsExportQuerySchema = z
  .object({ ...contractReviewFilterShape, format: PerformanceExportFormatSchema.default('csv') })
  .superRefine(contractReviewRanges);
export type ContractReviewsExportQuery = z.infer<typeof ContractReviewsExportQuerySchema>;

/** One row of the Reviews (contract reviews) grid (section 5.9). */
export const ContractReviewRowSchema = z.object({
  reviewId: z.number().int(),
  contractId: z.number().int().nullable(),
  employeeId: z.number().int().nullable(),
  employeeName: z.string().nullable(),
  employeeSurname: z.string().nullable(),
  employeeCompany: z.string().nullable(),
  employeeCompanyRule: z.string().nullable(),
  employeePosition: z.string().nullable(),
  contractName: z.string().nullable(),
  reviewName: z.string(),
  reviewCategory: z.string(),
  reviewCategoryCode: z.string(),
  reviewType: z.string(),
  reviewTypeCode: z.string(),
  reviewCycleStartDate: BusinessDateSchema,
  reviewCycleEndDate: BusinessDateSchema,
  reviewStatus: ReviewStatusSchema,
  reviewTotalActual: z.string().nullable(),
});
export type ContractReviewRow = z.infer<typeof ContractReviewRowSchema>;

export const ContractReviewsResponseSchema = pageOf(ContractReviewRowSchema);
export type ContractReviewsResponse = z.infer<typeof ContractReviewsResponseSchema>;

// ───────────── Grid exports (CSV / Excel) ─────────────

export const TEMPLATE_EXPORT_COLUMNS: readonly PerformanceExportColumn<keyof PerformanceTemplateRow>[] = [
  { key: 'name', header: 'Template Name' },
  { key: 'contractStartDate', header: 'Contract Start Date' },
  { key: 'contractEndDate', header: 'Contract End Date' },
  { key: 'ratingScale', header: 'Overall Rating Scale' },
  { key: 'processDefinition', header: 'Process Definition' },
  { key: 'linkedContracts', header: 'Linked Contracts' },
  { key: 'templateOwner', header: 'Template Owner' },
  { key: 'createdFromTemplate', header: 'Created From Template' },
  { key: 'status', header: 'Status' },
];

export const INITIATION_EXPORT_COLUMNS: readonly PerformanceExportColumn<keyof ContractInitiationRow>[] = [
  { key: 'name', header: 'Contract Name' },
  { key: 'templateName', header: 'Template' },
  { key: 'contractStartDate', header: 'Contract Start Date' },
  { key: 'contractEndDate', header: 'Contract End Date' },
  { key: 'status', header: 'Status' },
  { key: 'progress', header: 'Progress (%)' },
  { key: 'contractCount', header: 'Contract Count' },
  { key: 'createdCount', header: 'Created' },
  { key: 'failedCount', header: 'Failed' },
  { key: 'lastChanged', header: 'Last Changed' },
  { key: 'createdBy', header: 'Created By' },
];

export const CONTRACT_EXPORT_COLUMNS: readonly PerformanceExportColumn<keyof PerformanceContractRow>[] = [
  { key: 'employeeCode', header: 'Employee Code' },
  { key: 'firstName', header: 'First Name' },
  { key: 'lastName', header: 'Last Name' },
  { key: 'contractName', header: 'Contract Name' },
  { key: 'templateName', header: 'Template' },
  { key: 'contractStartDate', header: 'Contract Start Date' },
  { key: 'contractEndDate', header: 'Contract End Date' },
  { key: 'jobTitle', header: 'Job Title' },
  { key: 'jobGrade', header: 'Job Grade' },
  { key: 'employeeCompanyRule', header: 'Company Rule' },
  { key: 'reportsTo', header: 'Reports To' },
  { key: 'employeeDateEngaged', header: 'Date Engaged' },
  { key: 'employeeStatus', header: 'Employee Status' },
  { key: 'contractType', header: 'Contract Type' },
  { key: 'contractStatus', header: 'Contract Status' },
  { key: 'currentlyAssigned', header: 'Currently Assigned' },
];

export const CONTRACT_REVIEW_EXPORT_COLUMNS: readonly PerformanceExportColumn<keyof ContractReviewRow>[] = [
  { key: 'employeeName', header: 'Employee Name' },
  { key: 'employeeSurname', header: 'Employee Surname' },
  { key: 'employeeCompany', header: 'Company' },
  { key: 'employeeCompanyRule', header: 'Company Rule' },
  { key: 'employeePosition', header: 'Position' },
  { key: 'contractName', header: 'Contract Name' },
  { key: 'reviewName', header: 'Review Name' },
  { key: 'reviewCategory', header: 'Review Category' },
  { key: 'reviewType', header: 'Review Type' },
  { key: 'reviewCycleStartDate', header: 'Review Cycle Start Date' },
  { key: 'reviewCycleEndDate', header: 'Review Cycle End Date' },
  { key: 'reviewStatus', header: 'Review Status' },
  { key: 'reviewTotalActual', header: 'Review Total Actual' },
];
