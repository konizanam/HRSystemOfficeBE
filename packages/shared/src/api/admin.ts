import { z } from 'zod';
import { dec } from '../decimal';
import {
  ApproverResolutionSchema,
  AuthProviderSchema,
  EmployeeStatusSchema,
  RoleSchema,
  WorkflowTypeCodeSchema,
} from '../enums';
import { HOLIDAY_RULE_KINDS } from '../holidays';
import { BusinessDateSchema, DecimalStringSchema, PageQuerySchema, pageOf, TimestampSchema } from './common';

// Contracts for the Phase 9 admin API (section 12.10): employees (+ terminate, photo), users
// (+ roles, activate, unlock, password reset, MFA reset), companies, company rules, public
// holidays and holiday rules, workflow definitions (+ steps), pay periods (+ close) and the
// employee CSV import. Every write is audited; updates send the `version` they read (409 when
// stale); "delete" deactivates or soft-deletes, never removes a row.

/** `?includeInactive=true` on admin lists. */
const BoolQuery = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const Code = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Required')
    .max(max)
    .regex(/^[A-Za-z0-9_.&-]+$/, 'Use letters, digits and _ . & - only');

const Text = (max: number) => z.string().trim().min(1, 'Required').max(max);
const OptionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** Body of the deactivate / activate / close actions: the version that was read. */
export const AdminVersionRequestSchema = z.object({ version: z.number().int().positive() });
export type AdminVersionRequest = z.infer<typeof AdminVersionRequestSchema>;

// ───────────── Companies and company rules ─────────────

export const AdminCompanySchema = z.object({
  id: z.number().int(),
  code: z.string(),
  name: z.string(),
  currency: z.string(),
  country: z.string(),
  isActive: z.boolean(),
  ruleCount: z.number().int(),
  employeeCount: z.number().int(),
  version: z.number().int(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type AdminCompany = z.infer<typeof AdminCompanySchema>;

export const AdminCompaniesQuerySchema = z.object({ includeInactive: BoolQuery.optional() });
export type AdminCompaniesQuery = z.infer<typeof AdminCompaniesQuerySchema>;

export const AdminCompaniesResponseSchema = z.object({ items: z.array(AdminCompanySchema) });
export type AdminCompaniesResponse = z.infer<typeof AdminCompaniesResponseSchema>;

const CurrencySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 code');
const CountrySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{2}$/, 'Use a 2-letter ISO 3166 code');

export const CreateCompanyRequestSchema = z.object({
  code: Code(20),
  name: Text(200),
  currency: CurrencySchema.default('NAD'),
  country: CountrySchema.default('NA'),
});
export type CreateCompanyRequest = z.infer<typeof CreateCompanyRequestSchema>;

/** The code never changes (it is the natural key used by imports). */
export const UpdateCompanyRequestSchema = z.object({
  name: Text(200).optional(),
  currency: CurrencySchema.optional(),
  country: CountrySchema.optional(),
  version: z.number().int().positive(),
});
export type UpdateCompanyRequest = z.infer<typeof UpdateCompanyRequestSchema>;

export const AdminCompanyRuleSchema = z.object({
  id: z.number().int(),
  companyId: z.number().int(),
  companyCode: z.string(),
  companyName: z.string(),
  code: z.string(),
  description: z.string(),
  isActive: z.boolean(),
  employeeCount: z.number().int(),
  version: z.number().int(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type AdminCompanyRule = z.infer<typeof AdminCompanyRuleSchema>;

export const AdminCompanyRulesQuerySchema = z.object({
  companyId: z.coerce.number().int().positive().optional(),
  includeInactive: BoolQuery.optional(),
});
export type AdminCompanyRulesQuery = z.infer<typeof AdminCompanyRulesQuerySchema>;

export const AdminCompanyRulesResponseSchema = z.object({ items: z.array(AdminCompanyRuleSchema) });
export type AdminCompanyRulesResponse = z.infer<typeof AdminCompanyRulesResponseSchema>;

export const CreateCompanyRuleRequestSchema = z.object({
  companyId: z.number().int().positive(),
  code: Code(30),
  description: Text(200),
});
export type CreateCompanyRuleRequest = z.infer<typeof CreateCompanyRuleRequestSchema>;

export const UpdateCompanyRuleRequestSchema = z.object({
  description: Text(200).optional(),
  version: z.number().int().positive(),
});
export type UpdateCompanyRuleRequest = z.infer<typeof UpdateCompanyRuleRequestSchema>;

// ───────────── Public holidays and holiday rules ─────────────

export const AdminPublicHolidaySchema = z.object({
  id: z.number().int(),
  companyId: z.number().int().nullable(),
  date: BusinessDateSchema,
  /** The Monday after a Sunday holiday (per its rule; on by default). */
  observedDate: BusinessDateSchema,
  name: z.string(),
  ruleId: z.number().int().nullable(),
  isDeleted: z.boolean(),
  version: z.number().int(),
  updatedAt: TimestampSchema,
});
export type AdminPublicHoliday = z.infer<typeof AdminPublicHolidaySchema>;

export const AdminPublicHolidaysQuerySchema = z.object({
  year: z.coerce.number().int().min(1990).max(2200).optional(),
  /** A company's own holidays plus the national ones; omit for the national ones only. */
  companyId: z.coerce.number().int().positive().optional(),
  includeDeleted: BoolQuery.optional(),
});
export type AdminPublicHolidaysQuery = z.infer<typeof AdminPublicHolidaysQuerySchema>;

export const AdminPublicHolidaysResponseSchema = z.object({ items: z.array(AdminPublicHolidaySchema) });
export type AdminPublicHolidaysResponse = z.infer<typeof AdminPublicHolidaysResponseSchema>;

export const CreatePublicHolidayRequestSchema = z.object({
  /** Null: a holiday of every company (the national calendar). */
  companyId: z.number().int().positive().nullable().default(null),
  date: BusinessDateSchema,
  name: Text(120),
});
export type CreatePublicHolidayRequest = z.infer<typeof CreatePublicHolidayRequestSchema>;

export const UpdatePublicHolidayRequestSchema = z.object({
  date: BusinessDateSchema.optional(),
  name: Text(120).optional(),
  version: z.number().int().positive(),
});
export type UpdatePublicHolidayRequest = z.infer<typeof UpdatePublicHolidayRequestSchema>;

/**
 * `POST /admin/public-holidays/:id/restore` (body: the version read) brings a deleted holiday
 * back as it was (audited `HOLIDAY.RESTORED`); 422 when it is not deleted. Adding the same date
 * again still restores the row too, with the new name.
 */
export const RestorePublicHolidayRequestSchema = AdminVersionRequestSchema;
export type RestorePublicHolidayRequest = z.infer<typeof RestorePublicHolidayRequestSchema>;

export const HolidayRuleKindSchema = z.enum(HOLIDAY_RULE_KINDS);

export const AdminHolidayRuleSchema = z.object({
  id: z.number().int(),
  companyId: z.number().int().nullable(),
  name: z.string(),
  kind: HolidayRuleKindSchema,
  month: z.number().int().nullable(),
  day: z.number().int().nullable(),
  easterOffsetDays: z.number().int().nullable(),
  observeSundayOnMonday: z.boolean(),
  validFromYear: z.number().int().nullable(),
  validToYear: z.number().int().nullable(),
  isActive: z.boolean(),
  /** The rule's date in the current year (null when it does not apply this year). */
  thisYear: BusinessDateSchema.nullable(),
  version: z.number().int(),
});
export type AdminHolidayRule = z.infer<typeof AdminHolidayRuleSchema>;

export const AdminHolidayRulesResponseSchema = z.object({ items: z.array(AdminHolidayRuleSchema) });
export type AdminHolidayRulesResponse = z.infer<typeof AdminHolidayRulesResponseSchema>;

const HolidayRuleFields = z.object({
  companyId: z.number().int().positive().nullable().default(null),
  name: Text(120),
  kind: HolidayRuleKindSchema,
  month: z.number().int().min(1).max(12).nullable().default(null),
  day: z.number().int().min(1).max(31).nullable().default(null),
  easterOffsetDays: z.number().int().min(-100).max(100).nullable().default(null),
  observeSundayOnMonday: z.boolean().default(true),
  validFromYear: z.number().int().min(1990).max(2200).nullable().default(null),
  validToYear: z.number().int().min(1990).max(2200).nullable().default(null),
});

function holidayRuleCheck(
  value: {
    kind?: string;
    month?: number | null;
    day?: number | null;
    easterOffsetDays?: number | null;
    validFromYear?: number | null;
    validToYear?: number | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.kind === 'FIXED' && (value.month == null || value.day == null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['day'],
      message: 'A fixed date needs a month and day',
    });
  }
  if (value.kind === 'EASTER_RELATIVE' && value.easterOffsetDays == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['easterOffsetDays'],
      message: 'An Easter-relative date needs the days from Easter Sunday',
    });
  }
  if (value.validFromYear != null && value.validToYear != null && value.validToYear < value.validFromYear) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['validToYear'], message: 'Must be on or after From' });
  }
}

export const CreateHolidayRuleRequestSchema = HolidayRuleFields.superRefine(holidayRuleCheck);
export type CreateHolidayRuleRequest = z.infer<typeof CreateHolidayRuleRequestSchema>;

/** A full replacement of the rule's fields (the company never changes). */
export const UpdateHolidayRuleRequestSchema = HolidayRuleFields.omit({ companyId: true })
  .extend({ version: z.number().int().positive() })
  .superRefine(holidayRuleCheck);
export type UpdateHolidayRuleRequest = z.infer<typeof UpdateHolidayRuleRequestSchema>;

// ───────────── Employees ─────────────

export const ADMIN_EMPLOYEE_SORTS = ['employeeCode', 'lastName', 'dateEngaged', 'status'] as const;

export const AdminEmployeesQuerySchema = PageQuerySchema.extend({
  /** Matches employee code, entity code, first, last or known-as name. */
  search: z.string().trim().max(100).optional(),
  companyId: z.coerce.number().int().positive().optional(),
  companyRuleId: z.coerce.number().int().positive().optional(),
  status: EmployeeStatusSchema.optional(),
  department: z.string().trim().max(100).optional(),
  reportsToId: z.coerce.number().int().positive().optional(),
  /** Only employees without a login. */
  withoutUser: BoolQuery.optional(),
});
export type AdminEmployeesQuery = z.infer<typeof AdminEmployeesQuerySchema>;

export const AdminEmployeeUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  isActive: z.boolean(),
  roles: z.array(RoleSchema),
});

export const AdminEmployeeListItemSchema = z.object({
  id: z.number().int(),
  employeeCode: z.string(),
  entityCode: z.string(),
  title: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string(),
  knownAs: z.string().nullable(),
  companyId: z.number().int(),
  companyName: z.string(),
  companyRuleId: z.number().int(),
  companyRule: z.string(),
  jobTitle: z.string().nullable(),
  department: z.string().nullable(),
  reportsToId: z.number().int().nullable(),
  reportsToName: z.string().nullable(),
  status: EmployeeStatusSchema,
  dateEngaged: BusinessDateSchema.nullable(),
  terminationDate: BusinessDateSchema.nullable(),
  user: AdminEmployeeUserSchema.nullable(),
  version: z.number().int(),
});
export type AdminEmployeeListItem = z.infer<typeof AdminEmployeeListItemSchema>;

export const AdminEmployeesResponseSchema = pageOf(AdminEmployeeListItemSchema);
export type AdminEmployeesResponse = z.infer<typeof AdminEmployeesResponseSchema>;

export const AdminEmployeeSchema = AdminEmployeeListItemSchema.extend({
  initials: z.string().nullable(),
  jobGrade: z.string().nullable(),
  /** 4 dp; null for an employee without an hourly rate. */
  hourlyRate: z.string().nullable(),
  photoUrl: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type AdminEmployee = z.infer<typeof AdminEmployeeSchema>;

const HourlyRateSchema = DecimalStringSchema.refine((v) => dec(v).gte(0), 'Cannot be negative').nullable();

/** HR fields (section 12.10). Personal details keep their own endpoint (`/admin/employees/:id/personal`). */
const EmployeeHrFields = z.object({
  companyId: z.number().int().positive(),
  companyRuleId: z.number().int().positive(),
  reportsToId: z.number().int().positive().nullable(),
  jobTitle: OptionalText(120),
  jobGrade: OptionalText(60),
  department: OptionalText(120),
  hourlyRate: HourlyRateSchema.optional(),
  dateEngaged: BusinessDateSchema.nullable().optional(),
});

export const CreateEmployeeRequestSchema = EmployeeHrFields.extend({
  employeeCode: Code(30),
  /** Digits (it is padded to 6 in reference numbers); a leading letter prefix is allowed. */
  entityCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{0,3}\d{1,9}$/, 'Use up to 9 digits, optionally after a letter prefix'),
  title: OptionalText(40),
  initials: OptionalText(20),
  firstName: Text(100),
  lastName: Text(100),
  knownAs: OptionalText(100),
  dateEngaged: BusinessDateSchema,
});
export type CreateEmployeeRequest = z.infer<typeof CreateEmployeeRequestSchema>;

/**
 * Only the fields sent change. `status` moves between ACTIVE and SUSPENDED here; TERMINATED goes
 * through `POST /admin/employees/:id/terminate` (and a terminated employee is reinstated by
 * setting ACTIVE, which clears the termination date).
 */
export const UpdateEmployeeRequestSchema = EmployeeHrFields.partial().extend({
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  terminationDate: BusinessDateSchema.nullable().optional(),
  version: z.number().int().positive(),
});
export type UpdateEmployeeRequest = z.infer<typeof UpdateEmployeeRequestSchema>;

export const TerminateEmployeeRequestSchema = z.object({
  terminationDate: BusinessDateSchema,
  reason: Text(500),
  /** Deactivate the employee's login too; default from `employees.deactivateUserOnTermination`. */
  deactivateUser: z.boolean().optional(),
  version: z.number().int().positive(),
});
export type TerminateEmployeeRequest = z.infer<typeof TerminateEmployeeRequestSchema>;

export const TerminateEmployeeResponseSchema = z.object({
  employee: AdminEmployeeSchema,
  sessionsRevoked: z.number().int(),
  userDeactivated: z.boolean(),
  /** Open approval steps moved to another approver (section 7.5). */
  stepsReassigned: z.number().int(),
  stepsUnresolved: z.number().int(),
});
export type TerminateEmployeeResponse = z.infer<typeof TerminateEmployeeResponseSchema>;

/** PUT /admin/employees/:id/photo: an uploaded png/jpeg (or null to remove the photo). */
export const SetEmployeePhotoRequestSchema = z.object({
  attachmentId: z.string().uuid().nullable(),
  version: z.number().int().positive(),
});
export type SetEmployeePhotoRequest = z.infer<typeof SetEmployeePhotoRequestSchema>;

// ───────────── Users ─────────────

export const ADMIN_USER_SORTS = ['username', 'createdAt', 'lastLoginAt'] as const;

export const AdminUsersQuerySchema = PageQuerySchema.extend({
  /** Matches username, email or the linked employee's code or name. */
  search: z.string().trim().max(100).optional(),
  role: RoleSchema.optional(),
  isActive: BoolQuery.optional(),
  authProvider: AuthProviderSchema.optional(),
  locked: BoolQuery.optional(),
});
export type AdminUsersQuery = z.infer<typeof AdminUsersQuerySchema>;

export const AdminUserEmployeeSchema = z.object({
  id: z.number().int(),
  employeeCode: z.string(),
  name: z.string(),
  companyId: z.number().int(),
  status: EmployeeStatusSchema,
});

export const AdminUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string().nullable(),
  authProvider: AuthProviderSchema,
  externalSubject: z.string().nullable(),
  roles: z.array(RoleSchema),
  isActive: z.boolean(),
  mustChangePassword: z.boolean(),
  hasPassword: z.boolean(),
  isLocked: z.boolean(),
  lockedUntil: TimestampSchema.nullable(),
  failedLoginCount: z.number().int(),
  lastLoginAt: TimestampSchema.nullable(),
  passwordChangedAt: TimestampSchema.nullable(),
  mfaEnabled: z.boolean(),
  employee: AdminUserEmployeeSchema.nullable(),
  version: z.number().int(),
  createdAt: TimestampSchema,
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const AdminUsersResponseSchema = pageOf(AdminUserSchema);
export type AdminUsersResponse = z.infer<typeof AdminUsersResponseSchema>;

const UsernameSchema = z
  .string()
  .trim()
  .min(3, 'Use at least 3 characters')
  .max(150)
  .regex(/^[A-Za-z0-9._@-]+$/, 'Use letters, digits and . _ @ - only');
const EmailSchema = z.string().trim().email('Enter a valid email address').max(254);
const RolesSchema = z
  .array(RoleSchema)
  .min(1, 'Choose at least one role')
  .refine((v) => new Set(v).size === v.length, 'Duplicate role');

export const CreateUserRequestSchema = z
  .object({
    username: UsernameSchema,
    email: EmailSchema.nullable().default(null),
    authProvider: AuthProviderSchema.default('LOCAL'),
    /** OAUTH: the identity provider's `sub`. */
    externalSubject: z.string().trim().min(1).max(255).nullable().default(null),
    roles: RolesSchema,
    employeeId: z.number().int().positive().nullable().default(null),
    /**
     * LOCAL only. Without it the user gets an emailed link to choose a password (needs an email).
     * Either way the password must be changed at the first sign-in.
     */
    initialPassword: z.string().min(1).max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.authProvider === 'OAUTH') {
      if (!v.externalSubject) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['externalSubject'],
          message: 'OAuth users need the subject (sub) from the identity provider',
        });
      }
      if (v.initialPassword) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['initialPassword'],
          message: 'OAuth users sign in with the identity provider',
        });
      }
    } else if (!v.initialPassword && !v.email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['email'],
        message: 'Give an email address for the set-password link, or an initial password',
      });
    }
  });
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

/** Profile fields of a user; roles and the active flag have their own audited actions. */
export const UpdateUserRequestSchema = z.object({
  email: EmailSchema.nullable().optional(),
  externalSubject: z.string().trim().min(1).max(255).nullable().optional(),
  /** Link (or with null unlink) the user's employee record. */
  employeeId: z.number().int().positive().nullable().optional(),
  version: z.number().int().positive(),
});
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

export const UpdateUserRolesRequestSchema = z.object({
  roles: RolesSchema,
  reason: z.string().trim().max(500).optional(),
  version: z.number().int().positive(),
});
export type UpdateUserRolesRequest = z.infer<typeof UpdateUserRolesRequestSchema>;

export const UserActionRequestSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().max(500).optional(),
});
export type UserActionRequest = z.infer<typeof UserActionRequestSchema>;

export const DeactivateUserResponseSchema = z.object({
  user: AdminUserSchema,
  sessionsRevoked: z.number().int(),
  stepsReassigned: z.number().int(),
  stepsUnresolved: z.number().int(),
});
export type DeactivateUserResponse = z.infer<typeof DeactivateUserResponseSchema>;

/** Employees a user can be linked to (no login yet), for the SYSTEM_ADMIN picker. */
export const UserEmployeeOptionsQuerySchema = z.object({ search: z.string().trim().max(100).optional() });
export type UserEmployeeOptionsQuery = z.infer<typeof UserEmployeeOptionsQuerySchema>;

export const UserEmployeeOptionSchema = z.object({
  id: z.number().int(),
  employeeCode: z.string(),
  name: z.string(),
  companyName: z.string(),
  status: EmployeeStatusSchema,
});
export const UserEmployeeOptionsResponseSchema = z.object({ items: z.array(UserEmployeeOptionSchema) });
export type UserEmployeeOptionsResponse = z.infer<typeof UserEmployeeOptionsResponseSchema>;
export const USER_EMPLOYEE_OPTIONS_LIMIT = 50;

// ───────────── Workflow definitions ─────────────

export const AdminWorkflowStepSchema = z.object({
  id: z.number().int(),
  stepNo: z.number().int(),
  name: z.string(),
  resolution: ApproverResolutionSchema,
  approverRole: RoleSchema.nullable(),
  approverUserId: z.string().nullable(),
  approverUsername: z.string().nullable(),
  isMandatory: z.boolean(),
  skipIfSameApprover: z.boolean(),
  escalationHours: z.number().int().nullable(),
});
export type AdminWorkflowStep = z.infer<typeof AdminWorkflowStepSchema>;

export const AdminWorkflowDefinitionSchema = z.object({
  id: z.number().int(),
  workflowType: WorkflowTypeCodeSchema,
  workflowTypeDescription: z.string(),
  companyRuleId: z.number().int().nullable(),
  companyRule: z.string().nullable(),
  discriminator: z.string().nullable(),
  name: z.string(),
  versionNo: z.number().int(),
  previousVersionId: z.number().int().nullable(),
  isActive: z.boolean(),
  allowReassign: z.boolean(),
  allowResubmit: z.boolean(),
  canPark: z.boolean(),
  /** Processes started on this definition (they keep it when it is edited). */
  processCount: z.number().int(),
  openProcessCount: z.number().int(),
  steps: z.array(AdminWorkflowStepSchema),
  version: z.number().int(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type AdminWorkflowDefinition = z.infer<typeof AdminWorkflowDefinitionSchema>;

export const AdminWorkflowDefinitionsQuerySchema = z.object({
  workflowType: WorkflowTypeCodeSchema.optional(),
  companyRuleId: z.coerce.number().int().positive().optional(),
  includeInactive: BoolQuery.optional(),
});
export type AdminWorkflowDefinitionsQuery = z.infer<typeof AdminWorkflowDefinitionsQuerySchema>;

export const AdminWorkflowDefinitionsResponseSchema = z.object({
  items: z.array(AdminWorkflowDefinitionSchema),
});
export type AdminWorkflowDefinitionsResponse = z.infer<typeof AdminWorkflowDefinitionsResponseSchema>;

export const WORKFLOW_DEFINITION_MAX_STEPS = 10;

export const WorkflowStepInputSchema = z.object({
  stepNo: z.number().int().min(1),
  name: Text(120),
  resolution: ApproverResolutionSchema,
  approverRole: RoleSchema.nullable().default(null),
  approverUserId: z.string().uuid().nullable().default(null),
  isMandatory: z.boolean().default(true),
  skipIfSameApprover: z.boolean().default(true),
  escalationHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .nullable()
    .default(null),
});
export type WorkflowStepInput = z.infer<typeof WorkflowStepInputSchema>;

/** Step numbers run 1..n without gaps; ROLE steps need a role and SPECIFIC_USER steps a user. */
export function workflowStepIssues(steps: readonly WorkflowStepInput[]): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (steps.length === 0) issues.push({ path: 'steps', message: 'Add at least one step' });
  if (steps.length > WORKFLOW_DEFINITION_MAX_STEPS) {
    issues.push({ path: 'steps', message: `Use at most ${WORKFLOW_DEFINITION_MAX_STEPS} steps` });
  }
  const sorted = [...steps].map((s, i) => ({ s, i })).sort((a, b) => a.s.stepNo - b.s.stepNo);
  sorted.forEach(({ s, i }, position) => {
    if (s.stepNo !== position + 1) {
      issues.push({ path: `steps.${i}.stepNo`, message: 'Step numbers must run 1, 2, 3 … without gaps' });
    }
  });
  steps.forEach((s, i) => {
    if (s.resolution === 'ROLE' && !s.approverRole) {
      issues.push({ path: `steps.${i}.approverRole`, message: 'A role step needs the role' });
    }
    if (s.resolution === 'SPECIFIC_USER' && !s.approverUserId) {
      issues.push({ path: `steps.${i}.approverUserId`, message: 'A specific-user step needs the user' });
    }
    if (s.resolution !== 'ROLE' && s.approverRole) {
      issues.push({ path: `steps.${i}.approverRole`, message: 'Only a role step has a role' });
    }
    if (s.resolution !== 'SPECIFIC_USER' && s.approverUserId) {
      issues.push({ path: `steps.${i}.approverUserId`, message: 'Only a specific-user step has a user' });
    }
  });
  return issues;
}

function stepsCheck(value: { steps?: WorkflowStepInput[] }, ctx: z.RefinementCtx): void {
  if (!value.steps) return;
  for (const issue of workflowStepIssues(value.steps)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path.split('.'), message: issue.message });
  }
}

const DefinitionFields = z.object({
  name: Text(120),
  allowReassign: z.boolean().default(true),
  allowResubmit: z.boolean().default(true),
  canPark: z.boolean().default(true),
  steps: z.array(WorkflowStepInputSchema),
});

export const CreateWorkflowDefinitionRequestSchema = DefinitionFields.extend({
  workflowType: WorkflowTypeCodeSchema,
  /** Null: the type-wide default (every company rule). */
  companyRuleId: z.number().int().positive().nullable().default(null),
  /** Narrows the definition further, e.g. a claim group id or `TXN:<code>`. */
  discriminator: z.string().trim().min(1).max(100).nullable().default(null),
  isActive: z.boolean().default(true),
}).superRefine(stepsCheck);
export type CreateWorkflowDefinitionRequest = z.infer<typeof CreateWorkflowDefinitionRequestSchema>;

/**
 * Editing a definition always creates a new version (`versionNo + 1`, `previousVersionId`) with
 * the new steps; the edited one is deactivated and kept for the processes that run on it.
 */
export const UpdateWorkflowDefinitionRequestSchema = DefinitionFields.extend({
  version: z.number().int().positive(),
}).superRefine(stepsCheck);
export type UpdateWorkflowDefinitionRequest = z.infer<typeof UpdateWorkflowDefinitionRequestSchema>;

/** `PUT /admin/workflow-definitions/:id/steps`: only the steps (also a new version). */
export const UpdateWorkflowStepsRequestSchema = z
  .object({ steps: z.array(WorkflowStepInputSchema), version: z.number().int().positive() })
  .superRefine(stepsCheck);
export type UpdateWorkflowStepsRequest = z.infer<typeof UpdateWorkflowStepsRequestSchema>;

/**
 * `GET /admin/workflow-definitions/user-options?search=` (HR_ADMIN): who a SPECIFIC_USER step
 * may name. Active logins whose employee is ACTIVE in one of the caller's companies, plus active
 * logins without an employee record (for example a shared approvals mailbox); never the system
 * user. The caller is included. Same query and response as `GET /workflow/user-options`
 * (`UserOptionsQuerySchema`, `UserOptionsResponseSchema`: at most `USER_OPTIONS_LIMIT` rows,
 * `truncated` when more match, so narrow the search).
 */
export const WORKFLOW_STEP_USER_OPTIONS_PATH = '/admin/workflow-definitions/user-options';

// ───────────── Pay periods ─────────────

export const AdminPayPeriodSchema = z.object({
  id: z.number().int(),
  companyRuleId: z.number().int(),
  companyRule: z.string(),
  companyId: z.number().int(),
  description: z.string(),
  startDate: BusinessDateSchema,
  endDate: BusinessDateSchema,
  payDate: BusinessDateSchema.nullable(),
  isClosed: z.boolean(),
  closedAt: TimestampSchema.nullable(),
  closedByUserId: z.string().nullable(),
  /** Payslips, processed leave and claims linked to the period (its dates are then fixed). */
  linkedCount: z.number().int(),
  version: z.number().int(),
});
export type AdminPayPeriod = z.infer<typeof AdminPayPeriodSchema>;

export const AdminPayPeriodsQuerySchema = z.object({
  companyRuleId: z.coerce.number().int().positive().optional(),
  year: z.coerce.number().int().min(1990).max(2200).optional(),
  isClosed: BoolQuery.optional(),
});
export type AdminPayPeriodsQuery = z.infer<typeof AdminPayPeriodsQuerySchema>;

export const AdminPayPeriodsResponseSchema = z.object({ items: z.array(AdminPayPeriodSchema) });
export type AdminPayPeriodsResponse = z.infer<typeof AdminPayPeriodsResponseSchema>;

function periodRangeCheck(value: { startDate?: string; endDate?: string }, ctx: z.RefinementCtx): void {
  if (value.startDate && value.endDate && value.endDate < value.startDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endDate'],
      message: 'End must be on or after start',
    });
  }
}

export const CreatePayPeriodRequestSchema = z
  .object({
    companyRuleId: z.number().int().positive(),
    description: Text(120),
    startDate: BusinessDateSchema,
    endDate: BusinessDateSchema,
    payDate: BusinessDateSchema.nullable().default(null),
  })
  .superRefine(periodRangeCheck);
export type CreatePayPeriodRequest = z.infer<typeof CreatePayPeriodRequestSchema>;

export const UpdatePayPeriodRequestSchema = z
  .object({
    description: Text(120).optional(),
    startDate: BusinessDateSchema.optional(),
    endDate: BusinessDateSchema.optional(),
    payDate: BusinessDateSchema.nullable().optional(),
    version: z.number().int().positive(),
  })
  .superRefine(periodRangeCheck);
export type UpdatePayPeriodRequest = z.infer<typeof UpdatePayPeriodRequestSchema>;

export const ClosePayPeriodResponseSchema = z.object({
  payPeriod: AdminPayPeriodSchema,
  /** The outbox event that starts the leave accrual for the next period. */
  event: z.literal('payPeriod.closed'),
  /** Approved items of the company rule still waiting to be processed (a warning, not a block). */
  pendingProcessCount: z.number().int(),
});
export type ClosePayPeriodResponse = z.infer<typeof ClosePayPeriodResponseSchema>;

// ───────────── Employee CSV import ─────────────

export const EMPLOYEE_IMPORT_MODES = ['DRY_RUN', 'COMMIT'] as const;

/** Columns of the employee CSV (`*` = required for a new employee). */
export const EMPLOYEE_IMPORT_COLUMNS = [
  'employeeCode',
  'entityCode',
  'firstName',
  'lastName',
  'companyCode',
  'companyRuleCode',
  'title',
  'initials',
  'knownAs',
  'reportsToEmployeeCode',
  'jobTitle',
  'jobGrade',
  'department',
  'hourlyRate',
  'dateEngaged',
  'username',
  'email',
  'roles',
  'authProvider',
  'externalSubject',
] as const;
export type EmployeeImportColumn = (typeof EMPLOYEE_IMPORT_COLUMNS)[number];

/** The header must contain these; the rest are optional. */
export const EMPLOYEE_IMPORT_REQUIRED_COLUMNS: readonly EmployeeImportColumn[] = [
  'employeeCode',
  'firstName',
  'lastName',
  'companyCode',
  'companyRuleCode',
];

export const EMPLOYEE_IMPORT_MAX_ROWS = 5000;

export const EmployeeImportRequestSchema = z
  .object({
    csv: z.string().min(1, 'The file is empty').max(5_000_000),
    mode: z.enum(EMPLOYEE_IMPORT_MODES),
    confirmToken: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'COMMIT' && !value.confirmToken) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmToken'], message: 'Run a dry run first' });
    }
  });
export type EmployeeImportRequest = z.infer<typeof EmployeeImportRequestSchema>;

export const EMPLOYEE_IMPORT_ACTIONS = ['CREATE', 'UPDATE', 'UNCHANGED'] as const;

export const EmployeeImportRowResultSchema = z.object({
  /** 1-based data row number (the header is row 0). */
  row: z.number().int(),
  employeeCode: z.string(),
  ok: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  employeeAction: z.enum(EMPLOYEE_IMPORT_ACTIONS).nullable(),
  userAction: z.enum(EMPLOYEE_IMPORT_ACTIONS).nullable(),
  /** HR fields that change on an existing employee. */
  changedFields: z.array(z.string()),
  employeeId: z.number().int().nullable(),
  userId: z.string().nullable(),
});
export type EmployeeImportRowResult = z.infer<typeof EmployeeImportRowResultSchema>;

export const EmployeeImportResponseSchema = z.object({
  mode: z.enum(EMPLOYEE_IMPORT_MODES),
  /** Send with COMMIT; it is bound to the CSV content. */
  confirmToken: z.string(),
  totalRows: z.number().int(),
  validRows: z.number().int(),
  invalidRows: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  committed: z.boolean(),
  rows: z.array(EmployeeImportRowResultSchema),
});
export type EmployeeImportResponse = z.infer<typeof EmployeeImportResponseSchema>;
