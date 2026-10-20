import { z } from 'zod';
import { LOOKUP_TABLES, type LookupTable } from '../lookups';
import { EmployeeStatusSchema } from '../enums';
import { BooleanQuerySchema } from './calendar';
import { pageOf, SearchTextSchema, VersionSchema } from './common';

// Contracts for `GET /lookups/:table` (section 12.5) and the HR editing endpoints
// `/admin/lookups/:table` (ASSUMPTION B104). The rows live in `ParameterValue`, one table per list.

export const LookupTableSchema = z.enum(LOOKUP_TABLES as unknown as [LookupTable, ...LookupTable[]]);

export const LookupTableParamSchema = z.object({ table: LookupTableSchema });
export type LookupTableParam = z.infer<typeof LookupTableParamSchema>;

export const LookupValueSchema = z.object({
  /** What the API stores (an ISO 3166-1 alpha-2 code for countries, the label otherwise). */
  code: z.string(),
  description: z.string(),
  sortOrder: z.number().int(),
});
export type LookupValue = z.infer<typeof LookupValueSchema>;

/** GET /lookups/:table: the active rows in display order. */
export const LookupResponseSchema = z.object({
  table: LookupTableSchema,
  items: z.array(LookupValueSchema),
});
export type LookupResponse = z.infer<typeof LookupResponseSchema>;

export const AdminLookupValueSchema = LookupValueSchema.extend({
  id: z.number().int(),
  isActive: z.boolean(),
  version: z.number().int(),
});
export type AdminLookupValue = z.infer<typeof AdminLookupValueSchema>;

/** GET /admin/lookups/:table: every row, inactive ones included. */
export const AdminLookupResponseSchema = z.object({
  table: LookupTableSchema,
  items: z.array(AdminLookupValueSchema),
});
export type AdminLookupResponse = z.infer<typeof AdminLookupResponseSchema>;

export const CreateLookupValueRequestSchema = z.object({
  code: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(200),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});
export type CreateLookupValueRequest = z.infer<typeof CreateLookupValueRequestSchema>;

/** PUT /admin/lookups/:table/:id. The code never changes (stored values refer to it). */
export const UpdateLookupValueRequestSchema = VersionSchema.extend({
  description: z.string().trim().min(1).max(200).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateLookupValueRequest = z.infer<typeof UpdateLookupValueRequestSchema>;

export const LookupValueParamSchema = z.object({
  table: LookupTableSchema,
  id: z.coerce.number().int().positive(),
});
export type LookupValueParam = z.infer<typeof LookupValueParamSchema>;

// ───────────── Scoped pickers (GET /lookups/employees, companies, company-rules, positions) ─────────────

// Who the pickers show (the signed-in user's scope, not "Working as"): themself; a manager's
// reports within `workingAs.maxDepth`; HR and Payroll admins their companies; auditors everyone.

/** GET /lookups/employees?search=&companyId=&companyRuleId=&status=&hasUser=&page=&pageSize=. */
export const EmployeePickerQuerySchema = z.object({
  /** First name, last name, known-as name or employee code contains (case-insensitive). */
  search: SearchTextSchema,
  companyId: z.coerce.number().int().positive().optional(),
  companyRuleId: z.coerce.number().int().positive().optional(),
  /** Default: every status. */
  status: EmployeeStatusSchema.optional(),
  /** true = only employees with a user account; false = only those without one. */
  hasUser: BooleanQuerySchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type EmployeePickerQuery = z.infer<typeof EmployeePickerQuerySchema>;

export const EmployeePickerRowSchema = z.object({
  id: z.number().int(),
  employeeCode: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  knownAs: z.string().nullable(),
  /** "{First} {Last}". */
  name: z.string(),
  companyId: z.number().int(),
  companyName: z.string(),
  companyRuleId: z.number().int(),
  /** The company rule's label, e.g. "Staff". */
  companyRule: z.string(),
  /** Employee.jobTitle (the "position"). */
  jobTitle: z.string().nullable(),
  status: EmployeeStatusSchema,
  /** The employee has a user account. */
  hasUser: z.boolean(),
});
export type EmployeePickerRow = z.infer<typeof EmployeePickerRowSchema>;

/** Paginated, never truncated. */
export const EmployeePickerResponseSchema = pageOf(EmployeePickerRowSchema);
export type EmployeePickerResponse = z.infer<typeof EmployeePickerResponseSchema>;

export const CompanyOptionSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  name: z.string(),
});
export type CompanyOption = z.infer<typeof CompanyOptionSchema>;

/** GET /lookups/companies: the companies in the caller's scope, by name. */
export const CompaniesResponseSchema = z.object({ items: z.array(CompanyOptionSchema) });
export type CompaniesResponse = z.infer<typeof CompaniesResponseSchema>;

/** GET /lookups/company-rules?companyId=. */
export const CompanyRulesQuerySchema = z.object({
  companyId: z.coerce.number().int().positive().optional(),
});
export type CompanyRulesQuery = z.infer<typeof CompanyRulesQuerySchema>;

export const CompanyRuleOptionSchema = z.object({
  id: z.number().int(),
  companyId: z.number().int(),
  companyName: z.string(),
  code: z.string(),
  /** e.g. "Staff". */
  description: z.string(),
});
export type CompanyRuleOption = z.infer<typeof CompanyRuleOptionSchema>;

/** The company rules of the companies in the caller's scope, by company then description. */
export const CompanyRulesResponseSchema = z.object({ items: z.array(CompanyRuleOptionSchema) });
export type CompanyRulesResponse = z.infer<typeof CompanyRulesResponseSchema>;

/** GET /lookups/positions?companyId=&search=: distinct Employee.jobTitle values in scope. */
export const PositionsQuerySchema = z.object({
  companyId: z.coerce.number().int().positive().optional(),
  search: SearchTextSchema,
});
export type PositionsQuery = z.infer<typeof PositionsQuerySchema>;

export const PositionOptionSchema = z.object({
  /** The job title, as stored (the value the performance filters send back). */
  jobTitle: z.string(),
  /** Employees in scope with this title. */
  employeeCount: z.number().int(),
});
export type PositionOption = z.infer<typeof PositionOptionSchema>;

export const PositionsResponseSchema = z.object({ items: z.array(PositionOptionSchema) });
export type PositionsResponse = z.infer<typeof PositionsResponseSchema>;
