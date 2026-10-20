import { z } from 'zod';
import { EmployeeStatusSchema, ProcessStatusSchema } from '../enums';
import { AttachmentSchema } from './attachments';
import { PageQuerySchema, pageOf, TimestampSchema } from './common';

// Contracts for the Free Text Workflow (section 5.8, section 12.8): "The application is for
// {employee}", "who is applying for {FreeTextType}", a required body and attachments. A type with
// `requiresSubjectEmployee` runs on FREETEXTMANEMP and needs the "About employee"; the others run
// on FREETEXT. HR manages the types at /admin/free-text-types.

export const FREE_TEXT_BODY_MAX = 4000;

export const FreeTextTypeSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  description: z.string(),
  requiresSubjectEmployee: z.boolean(),
  /** FREETEXTMANEMP when the type needs an "About employee", else FREETEXT. */
  workflowType: z.enum(['FREETEXT', 'FREETEXTMANEMP']),
  /** False when no active workflow definition applies to the acting-as employee. */
  canStart: z.boolean(),
});
export type FreeTextType = z.infer<typeof FreeTextTypeSchema>;

export const FreeTextTypesResponseSchema = z.object({
  employeeId: z.number().int(),
  items: z.array(FreeTextTypeSchema),
});
export type FreeTextTypesResponse = z.infer<typeof FreeTextTypesResponseSchema>;

export const SubmitFreeTextRequestSchema = z.object({
  /** "The application is for": defaults to the acting-as employee; self or a permitted report. */
  employeeId: z.number().int().positive().optional(),
  typeId: z.number().int().positive(),
  /** "About employee": required (and only allowed) when the type requires a subject employee. */
  aboutEmployeeId: z.number().int().positive().nullable().optional(),
  body: z.string().trim().min(1, 'Enter the details of your request').max(FREE_TEXT_BODY_MAX),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
});
export type SubmitFreeTextRequest = z.infer<typeof SubmitFreeTextRequestSchema>;

export const FreeTextPersonSchema = z.object({
  id: z.number().int(),
  employeeCode: z.string(),
  name: z.string(),
});
export type FreeTextPerson = z.infer<typeof FreeTextPersonSchema>;

export const FreeTextRequestDtoSchema = z.object({
  id: z.number().int(),
  referenceNumber: z.string(),
  type: z.object({ id: z.number().int(), code: z.string(), description: z.string() }),
  workflowType: z.enum(['FREETEXT', 'FREETEXTMANEMP']),
  applicant: FreeTextPersonSchema,
  aboutEmployee: FreeTextPersonSchema.nullable(),
  body: z.string(),
  status: ProcessStatusSchema,
  statusLabel: z.string(),
  processId: z.number().int().nullable(),
  submittedByUserId: z.string().nullable(),
  submittedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  attachments: z.array(AttachmentSchema),
  version: z.number().int(),
});
export type FreeTextRequestDto = z.infer<typeof FreeTextRequestDtoSchema>;

export const FREE_TEXT_LIST_SCOPES = ['self', 'company'] as const;

export const FreeTextListQuerySchema = PageQuerySchema.extend({
  /** `self`: the acting-as employee's requests; `company`: HR and auditors (their companies). */
  scope: z.enum(FREE_TEXT_LIST_SCOPES).default('self'),
  status: ProcessStatusSchema.optional(),
  typeId: z.coerce.number().int().positive().optional(),
});
export type FreeTextListQuery = z.infer<typeof FreeTextListQuerySchema>;

export const FreeTextListResponseSchema = pageOf(FreeTextRequestDtoSchema);
export type FreeTextListResponse = z.infer<typeof FreeTextListResponseSchema>;

/** The "About employee" picker: active employees of the applicant's company. */
export const FreeTextAboutOptionsQuerySchema = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(100).optional(),
});
export type FreeTextAboutOptionsQuery = z.infer<typeof FreeTextAboutOptionsQuerySchema>;

export const FreeTextAboutOptionSchema = FreeTextPersonSchema.extend({ status: EmployeeStatusSchema });
export const FreeTextAboutOptionsResponseSchema = z.object({ items: z.array(FreeTextAboutOptionSchema) });
export type FreeTextAboutOptionsResponse = z.infer<typeof FreeTextAboutOptionsResponseSchema>;
export const FREE_TEXT_ABOUT_OPTIONS_LIMIT = 50;

/** The `subject.data` of a free text request in the inbox detail (kind FREE_TEXT). */
export const FreeTextSubjectDataSchema = z.object({
  freeTextRequestId: z.number().int(),
  referenceNumber: z.string(),
  typeCode: z.string(),
  typeDescription: z.string(),
  body: z.string(),
  aboutEmployee: FreeTextPersonSchema.nullable(),
});
export type FreeTextSubjectData = z.infer<typeof FreeTextSubjectDataSchema>;

/** What a resubmission (after "send back") may change. */
export const FreeTextResubmitChangesSchema = z
  .object({ body: z.string().trim().min(1).max(FREE_TEXT_BODY_MAX).optional() })
  .strict();
export type FreeTextResubmitChanges = z.infer<typeof FreeTextResubmitChangesSchema>;

// ───────────── Admin: free text types ─────────────

export const AdminFreeTextTypeSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  description: z.string(),
  requiresSubjectEmployee: z.boolean(),
  workflowType: z.enum(['FREETEXT', 'FREETEXTMANEMP']),
  isActive: z.boolean(),
  requestCount: z.number().int(),
  version: z.number().int(),
});
export type AdminFreeTextType = z.infer<typeof AdminFreeTextTypeSchema>;

export const AdminFreeTextTypesResponseSchema = z.object({ items: z.array(AdminFreeTextTypeSchema) });
export type AdminFreeTextTypesResponse = z.infer<typeof AdminFreeTextTypesResponseSchema>;

export const CreateFreeTextTypeRequestSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[A-Z0-9_]+$/, 'Use capitals, digits and _ only'),
  description: z.string().trim().min(1).max(120),
  requiresSubjectEmployee: z.boolean().default(false),
});
export type CreateFreeTextTypeRequest = z.infer<typeof CreateFreeTextTypeRequestSchema>;

/**
 * The code never changes. `requiresSubjectEmployee` (and with it the workflow type) can change
 * only while the type has no requests.
 */
export const UpdateFreeTextTypeRequestSchema = z.object({
  description: z.string().trim().min(1).max(120).optional(),
  requiresSubjectEmployee: z.boolean().optional(),
  isActive: z.boolean().optional(),
  version: z.number().int().positive(),
});
export type UpdateFreeTextTypeRequest = z.infer<typeof UpdateFreeTextTypeRequestSchema>;

/** The seeded type (section 14). */
export const ONBOARD_ARRIVAL_FREE_TEXT_TYPE = {
  code: 'ONBOARD_ARRIVAL',
  description: 'Onboarding Arrival Update',
  requiresSubjectEmployee: false,
} as const;

export function freeTextWorkflowType(type: {
  requiresSubjectEmployee: boolean;
}): 'FREETEXT' | 'FREETEXTMANEMP' {
  return type.requiresSubjectEmployee ? 'FREETEXTMANEMP' : 'FREETEXT';
}
