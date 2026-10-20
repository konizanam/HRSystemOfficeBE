// `pnpm db:seed`: idempotent demo data (section 14). Every write goes through DbService.tx so the
// seed is part of the audit chain like any other change.
import 'reflect-metadata';
import { AuditService } from '../src/audit/audit.service';
import { systemContext } from '../src/common/context/security-context';
import { env } from '../src/config/env';
import { DbService } from '../src/prisma/db.service';
import { runSeed } from './seed/index';
import { SEED_DEV_PASSWORD, SEED_PEOPLE } from './seed/people';

async function main(): Promise<void> {
  const db = DbService.forUrl(env().DATABASE_URL);
  const audit = new AuditService(db);
  const ctx = systemContext('seed');
  try {
    const summary = await runSeed({ db, audit, ctx });
    await audit.recordStandalone(ctx, { category: 'SYSTEM', action: 'SYSTEM.SEED', metadata: summary });
    console.log('Seed complete', summary);
    // Section 14: the dev password is printed only in development.
    if (env().NODE_ENV === 'development') {
      console.log(`Seeded users: ${SEED_PEOPLE.map((p) => p.username).join(', ')}`);
      console.log(`Development password for every seeded user: ${SEED_DEV_PASSWORD}`);
    }
  } finally {
    await db.prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
