import type { INestApplicationContext } from '@nestjs/common';
import type { AuditService } from '../../src/audit/audit.service';
import type { SecurityContext } from '../../src/common/context/security-context';
import type { DbService } from '../../src/prisma/db.service';
import { seedClaims } from './claims';
import { seedDetails } from './details';
import { seedHolidays } from './holidays';
import { seedLeave } from './leave';
import { seedOrganisation } from './organisation';
import { seedPeople } from './people';
import { seedPayPeriods, seedWorkflowDefinitions } from './workflow';

export interface SeedDeps {
  db: DbService;
  audit: AuditService;
  ctx: SecurityContext;
  /** The application context: steps that go through domain services (leave submit) use it. */
  app: INestApplicationContext;
}

export type SeedSummary = Record<string, number | string>;

/** Runs every seed step in order. Each step is idempotent (upserts on natural keys). */
export async function runSeed(deps: SeedDeps): Promise<SeedSummary> {
  const summary: SeedSummary = {};
  Object.assign(summary, await seedOrganisation(deps));
  Object.assign(summary, await seedPeople(deps));
  Object.assign(summary, await seedWorkflowDefinitions(deps));
  Object.assign(summary, await seedPayPeriods(deps));
  Object.assign(summary, await seedHolidays(deps));
  Object.assign(summary, await seedLeave(deps));
  Object.assign(summary, await seedClaims(deps));
  Object.assign(summary, await seedDetails(deps));
  return summary;
}
