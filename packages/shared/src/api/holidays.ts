import { z } from 'zod';
import { daysBetween, isBusinessDate } from '../dates';
import { BusinessDateSchema } from './common';

// Contracts for `GET /holidays?from=&to=` (section 12.2): the public holidays of the acting-as
// employee's company (company-specific plus those for every company), with the observed date.

/** Longest range one holidays request may cover (3 years). */
export const HOLIDAYS_MAX_RANGE_DAYS = 3 * 366;

/** A superRefine check: "to" on or after "from", and the range at most `maxDays` long. */
export function dateRangeCheck(maxDays: number) {
  return (value: { from: string; to: string }, ctx: z.RefinementCtx): void => {
    // Invalid dates already have their own issue; a refinement still runs on a dirty object.
    if (!isBusinessDate(value.from) || !isBusinessDate(value.to)) return;
    const span = daysBetween(value.from, value.to);
    if (span < 0)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'To must be on or after From' });
    else if (span >= maxDays) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: `Choose at most ${maxDays} days` });
    }
  };
}

export const HolidaysQuerySchema = z
  .object({ from: BusinessDateSchema, to: BusinessDateSchema })
  .superRefine(dateRangeCheck(HOLIDAYS_MAX_RANGE_DAYS));
export type HolidaysQuery = z.infer<typeof HolidaysQuerySchema>;

/** Where a holiday comes from: a stored PublicHoliday row, or computed from a holiday rule. */
export const HOLIDAY_SOURCES = ['TABLE', 'RULE'] as const;
export const HolidaySourceSchema = z.enum(HOLIDAY_SOURCES);
export type HolidaySource = z.infer<typeof HolidaySourceSchema>;

export const PublicHolidaySchema = z.object({
  /** The holiday's own date. */
  date: BusinessDateSchema,
  /** The day it is observed: the Monday when `date` is a Sunday. Leave units exclude this day. */
  observedDate: BusinessDateSchema,
  name: z.string(),
  /** Null for a holiday of every company. */
  companyId: z.number().int().nullable(),
  source: HolidaySourceSchema,
});
export type PublicHoliday = z.infer<typeof PublicHolidaySchema>;

/** Holidays whose date or observed date falls in the range, ordered by observed date. */
export const HolidaysResponseSchema = z.object({
  from: BusinessDateSchema,
  to: BusinessDateSchema,
  companyId: z.number().int().nullable(),
  items: z.array(PublicHolidaySchema),
});
export type HolidaysResponse = z.infer<typeof HolidaysResponseSchema>;
