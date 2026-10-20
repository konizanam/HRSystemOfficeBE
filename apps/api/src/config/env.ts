import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

// The repo-root .env is shared by the API and scripts; apps/api/.env (if present) wins.
loadDotenv({ path: resolve(__dirname, '../../.env'), quiet: true });
loadDotenv({ path: resolve(__dirname, '../../../../.env'), quiet: true });

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes'].includes(v.toLowerCase())));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  PUBLIC_URL: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.string().default('info'),
  ENCRYPTION_KEYS: z.string().min(2),
  ENCRYPTION_ACTIVE_KEY: z.string().min(1),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('PeopleHub <noreply@example.com>'),
  /** `memory` keeps sent mail in-process (tests); `smtp` uses the SMTP_* settings. */
  MAIL_TRANSPORT: z.enum(['smtp', 'memory']).default('smtp'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('./storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('peoplehub'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(true),
  AUDIT_ANCHOR_BUCKET: z.string().optional(),
  OIDC_ISSUER: z.string().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().optional(),
  OIDC_AUTO_PROVISION: bool.default(false),
  JOBS_ENABLED: bool.default(true),
  COOKIE_SECURE: bool.optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Invalid environment: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Test hook: forget the cached env after process.env changes. */
export function resetEnvCache(): void {
  cached = undefined;
}
