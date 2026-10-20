import type { AuditService } from '../../src/audit/audit.service';
import type { SecurityContext } from '../../src/common/context/security-context';
import type { DbService } from '../../src/prisma/db.service';
import { seedOrganisation } from './organisation';

export interface SeedDeps {
  db: DbService;
  audit: AuditService;
  ctx: SecurityContext;
}

export type SeedSummary = Record<string, number | string>;

/** Runs every seed step in order. Each step is idempotent (upserts on natural keys). */
export async function runSeed(deps: SeedDeps): Promise<SeedSummary> {
  const summary: SeedSummary = {};
  Object.assign(summary, await seedOrganisation(deps));
  return summary;
}
