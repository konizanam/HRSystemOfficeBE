// Runs a command with DATABASE_URL pointed at the migration owner role (app_owner).
// The application itself connects as app_user, which cannot alter or delete audit rows.
import { spawnSync } from 'node:child_process';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(import.meta.dirname, '../../../.env') });
const owner = process.env.MIGRATION_DATABASE_URL;
if (!owner) {
  console.error('MIGRATION_DATABASE_URL is not set');
  process.exit(1);
}
const [cmd, ...args] = process.argv.slice(2);
const result = spawnSync(cmd, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DATABASE_URL: owner },
});
process.exit(result.status ?? 1);
