import { z } from 'zod';
import { EmployeeStatusSchema, RoleSchema } from '../enums';
import { TimestampSchema } from './common';

// Contracts for section 12.1 (auth and session).

export const APP_VERSION = '1.0.0';

/** Minimum policy (section 4.3): 10 characters, 3 of 4 character classes. */
export const PASSWORD_MIN_LENGTH = 10;

export function passwordPolicyIssues(password: string): string[] {
  const issues: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) issues.push(`Use at least ${PASSWORD_MIN_LENGTH} characters`);
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) issues.push('Use at least 3 of: lowercase, uppercase, digits, symbols');
  return issues;
}

export const NewPasswordSchema = z.string().superRefine((value, ctx) => {
  for (const message of passwordPolicyIssues(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
});

export const SIGN_IN_PROFILES = ['LOCAL', 'OAUTH'] as const;
export const SignInProfileSchema = z.enum(SIGN_IN_PROFILES);
export type SignInProfile = z.infer<typeof SignInProfileSchema>;

export const LoginRequestSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').max(150),
  password: z.string().min(1, 'Password is required').max(500),
  profile: z.literal('LOCAL').default('LOCAL'),
  /** Six-digit TOTP code, required when the account has MFA enabled. */
  totp: z
    .string()
    .regex(/^\d{6}$/, 'Enter the 6-digit code')
    .optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const EmployeeSummarySchema = z.object({
  id: z.number().int(),
  employeeCode: z.string(),
  entityCode: z.string(),
  title: z.string().nullable(),
  initials: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string(),
  knownAs: z.string().nullable(),
  /** "{First} {Last}". */
  displayName: z.string(),
  companyId: z.number().int(),
  companyName: z.string(),
  companyRuleId: z.number().int(),
  companyRule: z.string(),
  status: EmployeeStatusSchema,
  photoUrl: z.string().nullable(),
});
export type EmployeeSummary = z.infer<typeof EmployeeSummarySchema>;

export const SessionSettingsSchema = z.object({
  idleMinutes: z.number().int(),
  warnSeconds: z.number().int(),
  dateFormat: z.string(),
  accentColour: z.string().nullable(),
  companyLogoUrl: z.string().nullable(),
  helpUrl: z.string().nullable(),
});
export type SessionSettings = z.infer<typeof SessionSettingsSchema>;

/** Features blocked while "Working as" someone else (section 4.2). */
export const RESTRICTED_FEATURES = [
  'PAYSLIPS',
  'TAX_CERTIFICATES',
  'BANK_ACCOUNT_NUMBERS',
  'ID_NUMBERS',
  'PASSWORD',
  'OUT_OF_OFFICE',
] as const;
export const RestrictedFeatureSchema = z.enum(RESTRICTED_FEATURES);
export type RestrictedFeature = z.infer<typeof RestrictedFeatureSchema>;

export const SessionUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string().nullable(),
  roles: z.array(RoleSchema),
  authProvider: z.enum(['LOCAL', 'OAUTH']),
  mustChangePassword: z.boolean(),
  mfaEnabled: z.boolean(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

/** GET /session. */
export const SessionSchema = z.object({
  user: SessionUserSchema,
  selfEmployee: EmployeeSummarySchema.nullable(),
  actingAs: EmployeeSummarySchema.nullable(),
  isActingForOther: z.boolean(),
  /** Features the caller cannot use right now (non-empty only while acting for someone else). */
  restrictedFeatures: z.array(RestrictedFeatureSchema),
  /** Echo of the CSRF cookie, for clients that cannot read cookies. */
  csrfToken: z.string(),
  expiresAt: TimestampSchema,
  settings: SessionSettingsSchema,
  appVersion: z.string(),
});
export type Session = z.infer<typeof SessionSchema>;

/** POST /auth/login. A 200 either carries the session or asks for the TOTP code. */
export const LoginResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('OK'), session: SessionSchema }),
  z.object({ status: z.literal('MFA_REQUIRED') }),
  z.object({ status: z.literal('PASSWORD_CHANGE_REQUIRED'), session: SessionSchema }),
]);
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/** POST /session/activity. */
export const ActivityResponseSchema = z.object({ expiresAt: TimestampSchema, idleMinutes: z.number().int() });
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;

/** GET /session/acting-as/options: rows of the "Working as" grid. */
export const ActingAsOptionSchema = z.object({
  employeeId: z.number().int(),
  name: z.string(),
  knownAs: z.string().nullable(),
  employeeCode: z.string(),
  companyRule: z.string(),
  status: EmployeeStatusSchema,
  isSelf: z.boolean(),
});
export type ActingAsOption = z.infer<typeof ActingAsOptionSchema>;

export const SetActingAsRequestSchema = z.object({ employeeId: z.number().int().positive() });
export type SetActingAsRequest = z.infer<typeof SetActingAsRequestSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: NewPasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

export const ForgotPasswordRequestSchema = z.object({ usernameOrEmail: z.string().trim().min(1).max(254) });
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ResetPasswordRequestSchema = z.object({
  token: z.string().min(20),
  newPassword: NewPasswordSchema,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

export const MfaEnrollResponseSchema = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
  qrDataUrl: z.string(),
});
export type MfaEnrollResponse = z.infer<typeof MfaEnrollResponseSchema>;

export const MfaVerifyRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequestSchema>;

/** POST /profile/mobile/pairing: QR content for "Setup mobile" (ASSUMPTION A3). */
export const MobilePairingResponseSchema = z.object({
  serverUrl: z.string(),
  token: z.string(),
  expiresAt: TimestampSchema,
  qrDataUrl: z.string(),
});
export type MobilePairingResponse = z.infer<typeof MobilePairingResponseSchema>;
