import { z } from 'zod';
import { DayPortionSchema, ProcessStatusSchema } from '../enums';
import { BusinessDateSchema, DecimalStringSchema } from './common';
import { dateRangeCheck, PublicHolidaySchema } from './holidays';

// Contracts for the dashboard leave calendar (section 5.1.4) and the "Employees on Leave" widget
// (section 5.1.3): `GET /calendar/leave`, `GET /calendar/leave/export` and
// `GET /leave/team/on-leave-today`.

/** `self` = the acting-as employee; `reports` = the signed-in manager's reports ("Reports To"). */
export const CALENDAR_SCOPES = ['self', 'reports'] as const;
export const CalendarScopeSchema = z.enum(CALENDAR_SCOPES);
export type CalendarScope = z.infer<typeof CalendarScopeSchema>;

export const CALENDAR_SCOPE_LABELS: Record<CalendarScope, string> = { self: 'Self', reports: 'Reports To' };

/** Longest range one calendar request (or export) may cover. */
export const CALENDAR_MAX_RANGE_DAYS = 366;

/** `true`/`false` in a query string (z.coerce.boolean would read "false" as true). */
export const BooleanQuerySchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const CalendarQueryBase = z.object({
  from: BusinessDateSchema,
  to: BusinessDateSchema,
  scope: CalendarScopeSchema.default('self'),
  /** Also show requests still in progress (flagged `inProgress`). */
  includeInProgress: BooleanQuerySchema.default(false),
});

export const LeaveCalendarQuerySchema = CalendarQueryBase.superRefine(
  dateRangeCheck(CALENDAR_MAX_RANGE_DAYS),
);
export type LeaveCalendarQuery = z.infer<typeof LeaveCalendarQuerySchema>;

export const CALENDAR_EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export const CalendarExportFormatSchema = z.enum(CALENDAR_EXPORT_FORMATS);
export type CalendarExportFormat = z.infer<typeof CalendarExportFormatSchema>;

/** GET /calendar/leave/export: the visible range as CSV or Excel (audited `EXPORT.CALENDAR`). */
export const LeaveCalendarExportQuerySchema = CalendarQueryBase.extend({
  format: CalendarExportFormatSchema.default('xlsx'),
}).superRefine(dateRangeCheck(CALENDAR_MAX_RANGE_DAYS));
export type LeaveCalendarExportQuery = z.infer<typeof LeaveCalendarExportQuerySchema>;

/** Columns of the calendar export, in order. */
export const CALENDAR_EXPORT_COLUMNS = [
  'Date',
  'Employee Code',
  'Employee Name',
  'Leave Type',
  'Day Portion',
  'Units',
  'Status',
  'Reference Number',
  'Public Holiday',
] as const;

/** One person's leave on one day. */
export const CalendarLeaveEntrySchema = z.object({
  applicationId: z.number().int(),
  referenceNumber: z.string(),
  employeeId: z.number().int(),
  employeeCode: z.string(),
  /** "{First} {Last}". */
  employeeName: z.string(),
  leaveTypeId: z.number().int(),
  leaveTypeCode: z.string(),
  leaveTypeDescription: z.string(),
  /** `LeaveType.colour` (hex) for the day swatch; null when the type has none. */
  colour: z.string().nullable(),
  portion: DayPortionSchema,
  units: DecimalStringSchema,
  status: ProcessStatusSchema,
  statusLabel: z.string(),
  /** Still being approved (only present with `includeInProgress=true`). */
  inProgress: z.boolean(),
});
export type CalendarLeaveEntry = z.infer<typeof CalendarLeaveEntrySchema>;

export const CalendarHolidayMarkSchema = z.object({
  name: z.string(),
  /** Set when this day is the Monday a Sunday holiday is observed on. */
  observedFor: BusinessDateSchema.nullable(),
});

export const CalendarDaySchema = z.object({
  date: BusinessDateSchema,
  /** ISO weekday, 1 = Monday … 7 = Sunday (the grid is Monday-first). */
  weekday: z.number().int().min(1).max(7),
  isWeekend: z.boolean(),
  /** Underlined in the grid. */
  isToday: z.boolean(),
  holiday: CalendarHolidayMarkSchema.nullable(),
  entries: z.array(CalendarLeaveEntrySchema),
});
export type CalendarDay = z.infer<typeof CalendarDaySchema>;

/** The legend below the calendar: the leave types that appear in the range. */
export const CalendarLegendItemSchema = z.object({
  leaveTypeId: z.number().int(),
  code: z.string(),
  description: z.string(),
  colour: z.string().nullable(),
});
export type CalendarLegendItem = z.infer<typeof CalendarLegendItemSchema>;

export const CalendarEmployeeSchema = z.object({
  employeeId: z.number().int(),
  employeeCode: z.string(),
  name: z.string(),
});

export const LeaveCalendarResponseSchema = z.object({
  from: BusinessDateSchema,
  to: BusinessDateSchema,
  scope: CalendarScopeSchema,
  today: BusinessDateSchema,
  /** The people the calendar covers (self, or the manager's reports). */
  employees: z.array(CalendarEmployeeSchema),
  /** Every date of the range, in order. */
  days: z.array(CalendarDaySchema),
  legend: z.array(CalendarLegendItemSchema),
  holidays: z.array(PublicHolidaySchema),
});
export type LeaveCalendarResponse = z.infer<typeof LeaveCalendarResponseSchema>;

/** GET /leave/team/on-leave-today (MANAGER): reports on approved or processed leave today. */
export const OnLeaveTodayEmployeeSchema = z.object({
  employeeId: z.number().int(),
  employeeCode: z.string(),
  name: z.string(),
  leaveTypeId: z.number().int(),
  leaveTypeDescription: z.string(),
  colour: z.string().nullable(),
  portion: DayPortionSchema,
});
export type OnLeaveTodayEmployee = z.infer<typeof OnLeaveTodayEmployeeSchema>;

export const OnLeaveTodayResponseSchema = z.object({
  date: BusinessDateSchema,
  /** The "On Leave Today" count. */
  count: z.number().int(),
  employees: z.array(OnLeaveTodayEmployeeSchema),
});
export type OnLeaveTodayResponse = z.infer<typeof OnLeaveTodayResponseSchema>;
