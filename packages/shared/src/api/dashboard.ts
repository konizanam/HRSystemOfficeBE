import { z } from 'zod';
import { BIRTHDAY_WINDOW_DAYS } from '../birthdays';
import { BusinessDateSchema, TimestampSchema } from './common';

// Contracts for section 5.1 / 12.2: `GET/PUT /dashboard/layout`, `GET /dashboard/summary` and
// `GET /birthdays/upcoming?days=30`.

/** The dashboard widgets (section 5.1), in their default order. */
export const DASHBOARD_WIDGETS = [
  'LATEST_PAYSLIP',
  'TAX_CERTIFICATES',
  'EMPLOYEES_ON_LEAVE',
  'LEAVE_CALENDAR',
  'SUBMITTED_ITEMS',
  'UPCOMING_BIRTHDAYS',
] as const;
export const DashboardWidgetIdSchema = z.enum(DASHBOARD_WIDGETS);
export type DashboardWidgetId = z.infer<typeof DashboardWidgetIdSchema>;

export const DASHBOARD_WIDGET_TITLES: Record<DashboardWidgetId, string> = {
  LATEST_PAYSLIP: 'Latest Payslip',
  TAX_CERTIFICATES: 'My Tax Certificates',
  EMPLOYEES_ON_LEAVE: 'Employees on Leave',
  LEAVE_CALENDAR: 'Leave Calendar',
  SUBMITTED_ITEMS: 'My Submitted Items',
  UPCOMING_BIRTHDAYS: 'Upcoming Birthdays',
};

export const DashboardWidgetSettingSchema = z.object({
  id: DashboardWidgetIdSchema,
  visible: z.boolean(),
});
export type DashboardWidgetSetting = z.infer<typeof DashboardWidgetSettingSchema>;

/** Every widget shown, in the default order. */
export const DEFAULT_DASHBOARD_LAYOUT: DashboardWidgetSetting[] = DASHBOARD_WIDGETS.map((id) => ({
  id,
  visible: true,
}));

/**
 * PUT /dashboard/layout: the widgets in display order with their visibility. Every known widget
 * appears exactly once (an unknown id or a missing or repeated one is 422).
 */
export const UpdateDashboardLayoutRequestSchema = z.object({
  widgets: z
    .array(z.object({ id: z.string(), visible: z.boolean() }))
    .superRefine((widgets, ctx) => {
      const seen = new Set<string>();
      widgets.forEach((w, index) => {
        if (!(DASHBOARD_WIDGETS as readonly string[]).includes(w.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'id'],
            message: `Unknown widget ${w.id}`,
          });
        } else if (seen.has(w.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'id'],
            message: `${w.id} is listed twice`,
          });
        }
        seen.add(w.id);
      });
      const missing = DASHBOARD_WIDGETS.filter((id) => !seen.has(id));
      if (missing.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Missing widgets: ${missing.join(', ')}` });
      }
    })
    .transform((widgets) => widgets as DashboardWidgetSetting[]),
});
export type UpdateDashboardLayoutRequest = z.infer<typeof UpdateDashboardLayoutRequestSchema>;

export const DashboardWidgetSchema = DashboardWidgetSettingSchema.extend({
  title: z.string(),
  /** False when the widget does not apply to this user (e.g. Employees on Leave for non-managers). */
  available: z.boolean(),
});
export type DashboardWidget = z.infer<typeof DashboardWidgetSchema>;

/** GET /dashboard/layout (and the PUT response). The layout belongs to the signed-in user. */
export const DashboardLayoutResponseSchema = z.object({
  widgets: z.array(DashboardWidgetSchema),
  /** No saved layout: the default is shown. */
  isDefault: z.boolean(),
  updatedAt: TimestampSchema.nullable(),
});
export type DashboardLayoutResponse = z.infer<typeof DashboardLayoutResponseSchema>;

/** The welcome banner (section 5.1): "Welcome back, {Title} {First} {Last}". */
export const DashboardEmployeeSchema = z.object({
  id: z.number().int(),
  employeeCode: z.string(),
  title: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string(),
  knownAs: z.string().nullable(),
  displayName: z.string(),
  photoUrl: z.string().nullable(),
  companyName: z.string(),
  companyLogoUrl: z.string().nullable(),
});
export type DashboardEmployee = z.infer<typeof DashboardEmployeeSchema>;

export const DashboardLatestPayslipSchema = z.object({
  id: z.number().int(),
  periodEndDate: BusinessDateSchema,
  /** "30 Sep 2026". */
  periodEndLabel: z.string(),
  payRunLabel: z.string(),
  runType: z.string(),
});

export const DashboardLatestTaxCertificateSchema = z.object({
  id: z.number().int(),
  taxYear: z.number().int(),
  taxYearLabel: z.string(),
  certificateType: z.string(),
});

/**
 * GET /dashboard/summary for the acting-as employee. While working as someone else, payslips and
 * tax certificates are restricted (section 4.2): their widgets get null and `restricted.*` = true
 * instead of a 403, so the rest of the dashboard still loads.
 */
export const DashboardSummarySchema = z.object({
  today: BusinessDateSchema,
  isActingForOther: z.boolean(),
  employee: DashboardEmployeeSchema.nullable(),
  latestPayslip: DashboardLatestPayslipSchema.nullable(),
  latestTaxCertificate: DashboardLatestTaxCertificateSchema.nullable(),
  restricted: z.object({ payslips: z.boolean(), taxCertificates: z.boolean() }),
  /** In-flight items of the acting-as employee (section 5.1.5). */
  submittedCounts: z.object({ leave: z.number().int(), claims: z.number().int() }),
  /** Reports on approved or processed leave today; null for users who are not managers. */
  onLeaveToday: z.object({ count: z.number().int() }).nullable(),
  upcomingBirthdays: z.object({ enabled: z.boolean(), days: z.number().int(), count: z.number().int() }),
});
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

/** GET /birthdays/upcoming?days=30. */
export const UpcomingBirthdaysQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(366).default(BIRTHDAY_WINDOW_DAYS),
});
export type UpcomingBirthdaysQuery = z.infer<typeof UpcomingBirthdaysQuerySchema>;

/** Name and day/month only: never the year (section 5.1.6). */
export const UpcomingBirthdaySchema = z.object({
  employeeId: z.number().int(),
  /** "{First} {Last}" (the known-as name when there is one). */
  name: z.string(),
  day: z.number().int().min(1).max(31),
  month: z.number().int().min(1).max(12),
  /** "05 Nov". */
  label: z.string(),
  /** Days from today (0 = today). */
  inDays: z.number().int(),
  isToday: z.boolean(),
});
export type UpcomingBirthday = z.infer<typeof UpcomingBirthdaySchema>;

export const UpcomingBirthdaysResponseSchema = z.object({
  /** `birthdays.enabled`; when false the list is empty. */
  enabled: z.boolean(),
  days: z.number().int(),
  from: BusinessDateSchema,
  to: BusinessDateSchema,
  count: z.number().int(),
  items: z.array(UpcomingBirthdaySchema),
});
export type UpcomingBirthdaysResponse = z.infer<typeof UpcomingBirthdaysResponseSchema>;
