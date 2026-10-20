// `pnpm db:seed`: idempotent demo data (section 14). Every write goes through DbService.tx so the
// seed is part of the audit chain like any other change. The leave fixture is submitted through
// the real services, so the seed runs inside a Nest application context (without job workers or
// real email).
import './seed/seed-env';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { AuditService } from '../src/audit/audit.service';
import { systemContext } from '../src/common/context/security-context';
import { env } from '../src/config/env';
import { DbService } from '../src/prisma/db.service';
import { runSeed } from './seed/index';
import { SEED_DEV_PASSWORD, SEED_PEOPLE } from './seed/people';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const db = app.get(DbService);
  const audit = app.get(AuditService);
  const ctx = systemContext('seed');
  try {
    const summary = await runSeed({ db, audit, ctx, app });
    await audit.recordStandalone(ctx, { category: 'SYSTEM', action: 'SYSTEM.SEED', metadata: summary });
    console.log('Seed complete', summary);
    // Section 14: the dev password is printed only in development.
    if (env().NODE_ENV === 'development') {
      console.log(`Seeded users: ${SEED_PEOPLE.map((p) => p.username).join(', ')}`);
      console.log(`Development password for every seeded user: ${SEED_DEV_PASSWORD}`);
    }
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
