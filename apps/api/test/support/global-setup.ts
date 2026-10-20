import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import type { TestProject } from 'vitest/node';

config({ path: resolve(__dirname, '../../../../.env'), quiet: true });
config({ path: resolve(__dirname, '../../.env'), quiet: true });

const apiRoot = resolve(__dirname, '../..');

let stopContainer: (() => Promise<void>) | undefined;

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/**
 * Prepares a fully migrated test database. Uses TEST_DATABASE_URL /
 * TEST_MIGRATION_DATABASE_URL when set (local Postgres, CI service); otherwise starts a
 * Testcontainers Postgres 16 and creates the app_owner/app_user roles in it.
 */
export async function setup(project: TestProject): Promise<void> {
  let userUrl = process.env.TEST_DATABASE_URL;
  let ownerUrl = process.env.TEST_MIGRATION_DATABASE_URL;

  if (!userUrl || !ownerUrl) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    stopContainer = async () => {
      await container.stop();
    };
    const admin = container.getConnectionUri();
    const sql = [
      `CREATE ROLE app_owner LOGIN CREATEDB PASSWORD 'owner'`,
      `CREATE ROLE app_user LOGIN PASSWORD 'user'`,
      `CREATE DATABASE peoplehub_test OWNER app_owner`,
      `GRANT CONNECT, CREATE ON DATABASE peoplehub_test TO app_user`,
    ];
    for (const s of sql) {
      await container.exec(['psql', '-U', container.getUsername(), '-d', container.getDatabase(), '-c', s]);
    }
    const base = new URL(admin);
    base.username = 'app_owner';
    base.password = 'owner';
    ownerUrl = withDb(base.toString(), 'peoplehub_test');
    base.username = 'app_user';
    base.password = 'user';
    userUrl = withDb(base.toString(), 'peoplehub_test');
  }

  // Non-destructive: applies pending migrations only. Tests use unique keys and never assume an
  // empty database, so the same test DB can be reused between runs.
  execSync('pnpm exec prisma migrate deploy', {
    cwd: apiRoot,
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: ownerUrl },
  });

  process.env.DATABASE_URL = userUrl;
  process.env.MIGRATION_DATABASE_URL = ownerUrl;
  project.provide('databaseUrl', userUrl);
  project.provide('ownerDatabaseUrl', ownerUrl);
}

export async function teardown(): Promise<void> {
  await stopContainer?.();
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    ownerDatabaseUrl: string;
  }
}
