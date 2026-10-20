import { z } from 'zod';
import { LOOKUP_TABLES, type LookupTable } from '../lookups';
import { VersionSchema } from './common';

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
