import { z } from 'zod';
import {
  AuditCategorySchema,
  AuditOutcomeSchema,
  ProcessStatusSchema,
  WorkflowActionTypeSchema,
} from '../enums';
import { BusinessDateSchema, pageOf, SearchTextSchema, TimestampSchema } from './common';

// Contracts for the audit API (sections 9.7 and 12.11): the explorer (`GET /audit`, AUDITOR and
// SYSTEM_ADMIN), one row with its before/after/changes, the record history of an entity (any user
// allowed to see that entity), chain verification and the audited export.

/** A date (`YYYY-MM-DD`, whole day in Africa/Windhoek) or an ISO-8601 timestamp. */
export const AuditInstantSchema = z.union([BusinessDateSchema, TimestampSchema]);

const CsvList = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').filter((s) => s.trim() !== '') : v),
    z.array(item).min(1).max(20),
  );

/** The explorer filters (section 9.7). Every filter is optional; they combine with AND. */
export const AuditFiltersSchema = z
  .object({
    from: AuditInstantSchema.optional(),
    to: AuditInstantSchema.optional(),
    actorUserId: z.string().trim().max(64).optional(),
    /** Contains, case-insensitive. */
    actorUsername: z.string().trim().max(150).optional(),
    subjectEmployeeId: z.coerce.number().int().positive().optional(),
    categories: CsvList(AuditCategorySchema).optional(),
    /** Prefix match, e.g. `LEAVE.` or `AUTH.LOGIN_FAILURE`. */
    action: z.string().trim().max(120).optional(),
    entityType: z.string().trim().max(80).optional(),
    entityId: z.string().trim().max(80).optional(),
    outcomes: CsvList(AuditOutcomeSchema).optional(),
    /** Free text searched in `metadata` and `reason` (contains, case-insensitive). */
    q: z.string().trim().min(2).max(200).optional(),
  })
  .strict();
export type AuditFilters = z.infer<typeof AuditFiltersSchema>;

export const AUDIT_SORTS = ['id:desc', 'id:asc'] as const;

export const AuditListQuerySchema = AuditFiltersSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(AUDIT_SORTS).default('id:desc'),
}).strict();
export type AuditListQuery = z.infer<typeof AuditListQuerySchema>;

export const AuditChangeSchema = z.object({
  path: z.string(),
  from: z.unknown(),
  to: z.unknown(),
});
export type AuditChange = z.infer<typeof AuditChangeSchema>;

/** A row as the grid shows it (no snapshots). */
export const AuditRowSchema = z.object({
  /** bigint as a string. */
  id: z.string(),
  occurredAt: TimestampSchema,
  category: AuditCategorySchema,
  action: z.string(),
  outcome: AuditOutcomeSchema,
  actorUserId: z.string().nullable(),
  actorUsername: z.string().nullable(),
  actingAsEmployeeId: z.number().int().nullable(),
  subjectEmployeeId: z.number().int().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  reason: z.string().nullable(),
  /** Paths of the changed fields. */
  changedFields: z.array(z.string()),
  /** Null for viewers who are not auditors or system admins (record history). */
  ip: z.string().nullable(),
  requestId: z.string().nullable(),
});
export type AuditRow = z.infer<typeof AuditRowSchema>;

/**
 * A row of the explorer grid (`GET /audit`): the row plus the display names of the acting-as and
 * subject employees, looked up when the page is read (the audit row itself stores only the ids).
 * Null when the id is null or no longer resolves.
 */
export const AuditListRowSchema = AuditRowSchema.extend({
  /** "{First} {Last}" of `actingAsEmployeeId`. */
  actingAsEmployeeName: z.string().nullable(),
  /** "{First} {Last}" of `subjectEmployeeId`. */
  subjectEmployeeName: z.string().nullable(),
});
export type AuditListRow = z.infer<typeof AuditListRowSchema>;

export const AuditListResponseSchema = pageOf(AuditListRowSchema);
export type AuditListResponse = z.infer<typeof AuditListResponseSchema>;

/**
 * The explorer's pickers (AUDITOR and SYSTEM_ADMIN): `GET /audit/employee-options` lists every
 * employee for the subject filter (all companies and statuses, deleted ones included), in the
 * `/lookups/employees` row format; `GET /audit/actor-options` lists every login (the system user
 * included) for the actor filter (`actorUserId`). Both search on the server and are paginated.
 */
export const AuditActorOptionsQuerySchema = z.object({
  /** Username, first name, last name or employee code contains (case-insensitive). */
  search: SearchTextSchema,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type AuditActorOptionsQuery = z.infer<typeof AuditActorOptionsQuerySchema>;

export const AuditActorOptionSchema = z.object({
  userId: z.string(),
  username: z.string(),
  /** "{First} {Last}" of the login's employee, or the username for a login without one. */
  name: z.string(),
  employeeId: z.number().int().nullable(),
  employeeCode: z.string().nullable(),
  isActive: z.boolean(),
});
export type AuditActorOption = z.infer<typeof AuditActorOptionSchema>;

export const AuditActorOptionsResponseSchema = pageOf(AuditActorOptionSchema);
export type AuditActorOptionsResponse = z.infer<typeof AuditActorOptionsResponseSchema>;

/** The full row for the side-by-side diff (values were redacted when the row was written). */
export const AuditRowDetailSchema = AuditRowSchema.extend({
  sessionId: z.string().nullable(),
  userAgent: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  changes: z.array(AuditChangeSchema),
  metadata: z.unknown().nullable(),
  prevHash: z.string().nullable(),
  hash: z.string(),
  /** True when pay data was blanked for a system admin who is not also HR or Payroll (section 4.1). */
  payDataHidden: z.boolean(),
});
export type AuditRowDetail = z.infer<typeof AuditRowDetailSchema>;

export const AuditIdParamSchema = z.object({ id: z.string().regex(/^\d{1,19}$/, 'Expected a numeric id') });

export const AuditEntityParamSchema = z.object({
  entityType: z.string().regex(/^[A-Za-z]{2,60}$/, 'Expected a Prisma model name'),
  entityId: z.string().min(1).max(80),
});
export type AuditEntityParam = z.infer<typeof AuditEntityParamSchema>;

/** One workflow action of a process the entity runs on. */
export const AuditWorkflowActionSchema = z.object({
  id: z.number().int(),
  processId: z.number().int(),
  action: WorkflowActionTypeSchema,
  actorUserId: z.string(),
  actorName: z.string(),
  stepNo: z.number().int().nullable(),
  comment: z.string().nullable(),
  fromStatus: ProcessStatusSchema.nullable(),
  toStatus: ProcessStatusSchema.nullable(),
  metadata: z.unknown().nullable(),
  createdAt: TimestampSchema,
});
export type AuditWorkflowAction = z.infer<typeof AuditWorkflowActionSchema>;

/** Most rows of each kind one record history returns (newest first). */
export const ENTITY_HISTORY_LIMIT = 500;

/** `GET /audit/entity/:entityType/:entityId`: the record history tab. */
export const EntityHistoryResponseSchema = z.object({
  entityType: z.string(),
  entityId: z.string(),
  /** Workflow processes of the entity (their actions and WorkflowProcess audit rows are included). */
  processIds: z.array(z.number().int()),
  audit: z.array(AuditRowDetailSchema),
  workflowActions: z.array(AuditWorkflowActionSchema),
  /** True when a list was cut at ENTITY_HISTORY_LIMIT. */
  truncated: z.boolean(),
});
export type EntityHistoryResponse = z.infer<typeof EntityHistoryResponseSchema>;

export const AuditVerifyQuerySchema = z
  .object({ from: AuditInstantSchema.optional(), to: AuditInstantSchema.optional() })
  .strict();
export type AuditVerifyQuery = z.infer<typeof AuditVerifyQuerySchema>;

export const AuditVerifyResponseSchema = z.object({
  ok: z.boolean(),
  checked: z.number().int(),
  firstId: z.string().nullable(),
  lastId: z.string().nullable(),
  lastHash: z.string().nullable(),
  firstBrokenId: z.string().nullable(),
  reason: z.string().nullable(),
  from: TimestampSchema.nullable(),
  to: TimestampSchema.nullable(),
  /** The latest daily anchor on or before the range end, for comparison with external copies. */
  anchor: z.object({ day: BusinessDateSchema, lastAuditId: z.string(), lastHash: z.string() }).nullable(),
});
export type AuditVerifyResponse = z.infer<typeof AuditVerifyResponseSchema>;

export const AUDIT_EXPORT_FORMATS = ['csv', 'xlsx'] as const;
/** Largest export (rows); narrow the filters for more. */
export const AUDIT_EXPORT_MAX_ROWS = 100_000;

export const AuditExportRequestSchema = z.object({
  filters: AuditFiltersSchema.default({}),
  format: z.enum(AUDIT_EXPORT_FORMATS).default('csv'),
});
export type AuditExportRequest = z.infer<typeof AuditExportRequestSchema>;

/** Columns of the audit export, in order. */
export const AUDIT_EXPORT_COLUMNS = [
  ['id', 'Id'],
  ['occurredAt', 'Occurred At'],
  ['category', 'Category'],
  ['action', 'Action'],
  ['outcome', 'Outcome'],
  ['actorUsername', 'Actor'],
  ['actingAsEmployeeId', 'Acting As Employee'],
  ['subjectEmployeeId', 'Subject Employee'],
  ['entityType', 'Entity Type'],
  ['entityId', 'Entity Id'],
  ['reason', 'Reason'],
  ['changes', 'Changes'],
  ['before', 'Before'],
  ['after', 'After'],
  ['metadata', 'Metadata'],
  ['ip', 'IP'],
  ['requestId', 'Request Id'],
  ['hash', 'Hash'],
] as const;
