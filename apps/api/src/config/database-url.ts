// Database connection settings use the same `.env` format as the other Koniza apps:
// DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD (runtime role app_user) plus DB_OWNER_USER and
// DB_OWNER_PASSWORD (migration role app_owner). A full DATABASE_URL / MIGRATION_DATABASE_URL still
// wins when set (CI, Docker, the test harness).

type EnvVars = Record<string, string | undefined>;

export type DatabaseRole = 'app' | 'owner';

/** Builds a postgres URL for the role from the DB_* variables, or undefined when they are incomplete. */
export function databaseUrlFrom(
  vars: EnvVars,
  role: DatabaseRole,
  dbName = vars.DB_NAME,
): string | undefined {
  const user = role === 'owner' ? vars.DB_OWNER_USER : vars.DB_USER;
  const password = role === 'owner' ? vars.DB_OWNER_PASSWORD : vars.DB_PASSWORD;
  if (!vars.DB_HOST || !dbName || !user) return undefined;
  const auth = password
    ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
    : encodeURIComponent(user);
  const schema = vars.DB_SCHEMA || 'public';
  return `postgresql://${auth}@${vars.DB_HOST}:${vars.DB_PORT || '5432'}/${encodeURIComponent(dbName)}?schema=${schema}`;
}

/** Fills DATABASE_URL and MIGRATION_DATABASE_URL from the DB_* variables unless they are already set. */
export function applyDatabaseUrls(vars: EnvVars = process.env): void {
  const app = databaseUrlFrom(vars, 'app');
  const owner = databaseUrlFrom(vars, 'owner');
  if (!vars.DATABASE_URL && app) vars.DATABASE_URL = app;
  if (!vars.MIGRATION_DATABASE_URL && owner) vars.MIGRATION_DATABASE_URL = owner;
}
