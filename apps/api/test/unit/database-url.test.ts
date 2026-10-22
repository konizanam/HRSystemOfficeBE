import { describe, expect, it } from 'vitest';
import { applyDatabaseUrls, databaseUrlFrom } from '../../src/config/database-url';

const vars = {
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_NAME: 'peoplehub',
  DB_USER: 'app_user',
  DB_PASSWORD: 'p@ss:w/rd',
  DB_OWNER_USER: 'app_owner',
  DB_OWNER_PASSWORD: 'owner',
};

describe('database URL from DB_* settings', () => {
  it('builds runtime and owner URLs, encoding credentials', () => {
    expect(databaseUrlFrom(vars, 'app')).toBe(
      'postgresql://app_user:p%40ss%3Aw%2Frd@localhost:5432/peoplehub?schema=public',
    );
    expect(databaseUrlFrom(vars, 'owner')).toBe(
      'postgresql://app_owner:owner@localhost:5432/peoplehub?schema=public',
    );
    expect(databaseUrlFrom(vars, 'app', 'peoplehub_test')).toContain('/peoplehub_test?');
  });

  it('defaults the port and schema, and returns undefined when incomplete', () => {
    expect(databaseUrlFrom({ DB_HOST: 'db', DB_NAME: 'x', DB_USER: 'u' }, 'app')).toBe(
      'postgresql://u@db:5432/x?schema=public',
    );
    expect(databaseUrlFrom({ DB_HOST: 'db', DB_NAME: 'x' }, 'app')).toBeUndefined();
  });

  it('fills missing URLs but never overrides explicit ones', () => {
    const env: Record<string, string | undefined> = { ...vars, DATABASE_URL: 'postgresql://explicit/db' };
    applyDatabaseUrls(env);
    expect(env.DATABASE_URL).toBe('postgresql://explicit/db');
    expect(env.MIGRATION_DATABASE_URL).toBe(
      'postgresql://app_owner:owner@localhost:5432/peoplehub?schema=public',
    );
    const empty: Record<string, string | undefined> = {};
    applyDatabaseUrls(empty);
    expect(empty).toEqual({});
  });
});
