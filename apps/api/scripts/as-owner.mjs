// Runs a command with DATABASE_URL pointed at the migration owner role (app_owner).
// The application itself connects as app_user, which cannot alter or delete audit rows.
// The owner URL is MIGRATION_DATABASE_URL, or is built from DB_HOST/DB_PORT/DB_NAME and
// DB_OWNER_USER/DB_OWNER_PASSWORD (same rules as src/config/database-url.ts).
import { spawnSync } from 'node:child_process';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(import.meta.dirname, '../.env'), quiet: true });
config({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });

function ownerUrl(vars) {
  if (vars.MIGRATION_DATABASE_URL) return vars.MIGRATION_DATABASE_URL;
  const { DB_HOST, DB_NAME, DB_OWNER_USER, DB_OWNER_PASSWORD } = vars;
  if (!DB_HOST || !DB_NAME || !DB_OWNER_USER) return undefined;
  const auth = DB_OWNER_PASSWORD
    ? `${encodeURIComponent(DB_OWNER_USER)}:${encodeURIComponent(DB_OWNER_PASSWORD)}`
    : encodeURIComponent(DB_OWNER_USER);
  return `postgresql://${auth}@${DB_HOST}:${vars.DB_PORT || '5432'}/${encodeURIComponent(DB_NAME)}?schema=${vars.DB_SCHEMA || 'public'}`;
}

const owner = ownerUrl(process.env);
if (!owner) {
  console.error('Set DB_HOST, DB_NAME, DB_OWNER_USER and DB_OWNER_PASSWORD (or MIGRATION_DATABASE_URL)');
  process.exit(1);
}
const [cmd, ...args] = process.argv.slice(2);
const result = spawnSync(cmd, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DATABASE_URL: owner },
});
process.exit(result.status ?? 1);
