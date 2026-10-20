import { z } from 'zod';
import { isBusinessDate } from '../dates';
import { DECIMAL_STRING_PATTERN } from '../decimal';

/** `YYYY-MM-DD` business date. */
export const BusinessDateSchema = z
  .string()
  .refine(isBusinessDate, { message: 'Expected a date in YYYY-MM-DD format' });

/** ISO-8601 UTC timestamp. */
export const TimestampSchema = z.string().datetime({ offset: true });

/** Decimals travel as strings to avoid float errors (section 10.1). */
export const DecimalStringSchema = z
  .string()
  .regex(DECIMAL_STRING_PATTERN, { message: 'Expected a decimal number' });

export const IdParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z
    .string()
    .regex(/^[A-Za-z0-9_.]+:(asc|desc)$/, { message: 'Use field:asc or field:desc' })
    .optional(),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export function pageOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  });
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Optimistic concurrency token (section 0.8). */
export const VersionSchema = z.object({ version: z.number().int().positive() });

/** RFC 7807 problem+json (section 10.1). */
export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  requestId: z.string().optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const CSRF_HEADER = 'x-csrf-token';
export const CSRF_COOKIE = 'ph_csrf';
export const SESSION_COOKIE = 'ph_session';
export const API_PREFIX = '/api/v1';
