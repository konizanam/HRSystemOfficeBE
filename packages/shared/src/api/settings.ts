import { z } from 'zod';
import { RESTRICTED_FEATURES, RestrictedFeatureSchema } from './auth';
import { TimestampSchema } from './common';

// Contracts for `GET/PUT /admin/settings` (section 10.5). Every key has a schema and a default;
// a missing SystemSetting row means "use the default".

const HexColourSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use a hex colour such as #0F766E');
const OptionalUrlSchema = z.string().url('Enter a valid URL').max(2000).nullable();

export const SETTING_DEFINITIONS = {
  'session.idleMinutes': {
    schema: z.number().int().min(1).max(480),
    default: 20,
    description: 'Minutes of inactivity before a session ends',
  },
  'session.warnSeconds': {
    schema: z.number().int().min(10).max(600),
    default: 60,
    description: 'Seconds before the idle timeout at which the countdown warning appears',
  },
  'leave.maxBackdateDays': {
    schema: z.number().int().min(0).max(3650),
    default: 30,
    description: 'How many days in the past a leave application may start (HR_ADMIN is exempt)',
  },
  'workingAs.maxDepth': {
    schema: z.number().int().min(0).max(10),
    default: 1,
    description: 'How many reporting levels below a manager "Working as" reaches (1 = direct reports)',
  },
  'workingAs.restrictedFeatures': {
    schema: z.array(RestrictedFeatureSchema).refine((v) => new Set(v).size === v.length, 'Duplicate feature'),
    default: [...RESTRICTED_FEATURES],
    description: 'Features that are blocked while working as someone else',
  },
  'workflow.autoProcess.LEAVE': {
    schema: z.boolean(),
    default: false,
    description: 'Process leave automatically on final approval',
  },
  'workflow.autoProcess.CANCELLEAVE': {
    schema: z.boolean(),
    default: false,
    description: 'Process leave cancellations automatically on final approval',
  },
  'workflow.autoProcess.CLAIMS': {
    schema: z.boolean(),
    default: false,
    description: 'Process claims automatically on final approval',
  },
  'workflow.autoProcess.GROUPEDCLAIM': {
    schema: z.boolean(),
    default: false,
    description: 'Process grouped claims automatically on final approval',
  },
  'workflow.autoProcess.CREDITLVEALLOC': {
    schema: z.boolean(),
    default: false,
    description: 'Process leave in lieu allocations automatically on final approval',
  },
  'workflow.autoProcess.CREDITLVEREQ': {
    schema: z.boolean(),
    default: false,
    description: 'Process leave in lieu requests automatically on final approval',
  },
  'workflow.escalation.autoReassign': {
    schema: z.boolean(),
    default: false,
    description: 'Reassign overdue steps to the second-level manager after twice the escalation time',
  },
  'birthdays.enabled': {
    schema: z.boolean(),
    default: true,
    description: 'Show the Upcoming Birthdays widget',
  },
  'mail.from': {
    schema: z.string().trim().min(3).max(320).nullable(),
    default: null,
    description: 'Sender address for email; empty uses the MAIL_FROM environment setting',
  },
  'company.logoAttachmentId': {
    schema: z.string().uuid().nullable(),
    default: null,
    description: 'Attachment id of the company logo',
  },
  'ui.dateFormat': {
    schema: z.string().trim().min(4).max(32),
    default: 'dd-MMM-yyyy',
    description: 'Date format used in grids',
  },
  'ui.accentColour': {
    schema: HexColourSchema,
    default: '#0F766E',
    description: 'The single accent colour of the web app',
  },
  'ui.helpUrl': {
    schema: OptionalUrlSchema,
    default: null,
    description: 'External help link in the profile menu',
  },
  'employees.deactivateUserOnTermination': {
    schema: z.boolean(),
    default: true,
    description: "Deactivate the employee's login when HR terminates the employee",
  },
} as const;

type Definitions = typeof SETTING_DEFINITIONS;
export type SettingKey = keyof Definitions;
export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[];

/** The resolved value of every setting. */
export type Settings = { [K in SettingKey]: z.infer<Definitions[K]['schema']> };

const settingShape = Object.fromEntries(SETTING_KEYS.map((k) => [k, SETTING_DEFINITIONS[k].schema])) as {
  [K in SettingKey]: Definitions[K]['schema'];
};

export const SettingsSchema = z.object(settingShape);

export function defaultSettings(): Settings {
  return Object.fromEntries(
    SETTING_KEYS.map((k) => {
      const value: unknown = SETTING_DEFINITIONS[k].default;
      return [k, Array.isArray(value) ? [...(value as unknown[])] : value];
    }),
  ) as Settings;
}

export const SettingItemSchema = z.object({
  key: z.string(),
  description: z.string(),
  isDefault: z.boolean(),
  updatedAt: TimestampSchema.nullable(),
  updatedByUserId: z.string().nullable(),
});
export type SettingItem = z.infer<typeof SettingItemSchema>;

/** GET /admin/settings (and the PUT response). */
export const AdminSettingsResponseSchema = z.object({
  values: SettingsSchema,
  items: z.array(SettingItemSchema),
  /**
   * Optimistic concurrency token over every stored setting (its key and last change). Send it
   * back with PUT; a stale one answers 409 with the current settings.
   */
  revision: z.string(),
});
export type AdminSettingsResponse = z.infer<typeof AdminSettingsResponseSchema>;

/** PUT /admin/settings: only the keys being changed, and the `revision` that was read. Unknown keys are rejected. */
export const UpdateSettingsRequestSchema = z.object({
  values: SettingsSchema.partial().strict(),
  revision: z.string().min(1, 'Reload the settings before saving'),
});
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;
