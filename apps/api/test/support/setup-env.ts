import { inject } from 'vitest';
import { resetEnvCache } from '../../src/config/env';

// Point every test file at the migrated test database prepared by global-setup.
process.env.DATABASE_URL = inject('databaseUrl');
process.env.MIGRATION_DATABASE_URL = inject('ownerDatabaseUrl');
process.env.NODE_ENV = 'test';
process.env.JOBS_ENABLED = 'false';
process.env.STORAGE_LOCAL_ROOT = process.env.STORAGE_LOCAL_ROOT_TEST ?? './storage-test';
process.env.SMTP_HOST = 'localhost';
process.env.SMTP_PORT = '1025';
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
process.env.MAIL_TRANSPORT = 'memory';
process.env.COOKIE_SECURE = 'true';
process.env.PUBLIC_URL = 'http://localhost:5173';
// OIDC stays unconfigured unless a test file sets it up (oidc.int.test.ts runs a fake provider).
process.env.OIDC_ISSUER = '';
process.env.OIDC_CLIENT_ID = '';
process.env.OIDC_CLIENT_SECRET = '';
process.env.OIDC_AUTO_PROVISION = 'false';
resetEnvCache();
