import type { ClaimInputMode } from '@prisma/client';
import type { SeedDeps, SeedSummary } from './index';
import { SEED_PEOPLE } from './people';

interface SeedClaimGroup {
  id: number;
  code: string;
  description: string;
}

interface SeedClaimType {
  code: string;
  description: string;
  inputMode: ClaimInputMode;
  /** `ClaimType.rate` (rate per km for KILOMETRES); null for HOURS paid at the hourly rate. */
  rate: string | null;
  rateMultiplier: string | null;
  requiresAttachment: boolean;
}

/**
 * Section 5.3.1: the claim groups exactly as observed, with fixed ids. "Other Calims" keeps the
 * source's misspelling as seed data that HR can fix.
 */
export const SEED_CLAIM_GROUPS: SeedClaimGroup[] = [
  { id: 1, code: 'MSN_OT', description: 'Overtime Claims' },
  { id: 2, code: 'OT', description: 'Overtime Claims' },
  { id: 3, code: 'MSN_OTHER', description: 'Other Claims' },
  { id: 4, code: 'OTHER', description: 'Other Calims' },
  { id: 5, code: 'REBATECLMS', description: 'Rebate Claims' },
];

/**
 * The observed claim types with their input mode and rate (ASSUMPTION, see docs; HR edits them).
 * Overtime is paid at the employee's hourly rate times the multiplier from the code.
 */
const OVERTIME_TYPES: SeedClaimType[] = [
  {
    code: 'OT1_5',
    description: 'Overtime 1.5',
    inputMode: 'HOURS',
    rate: null,
    rateMultiplier: '1.5',
    requiresAttachment: false,
  },
  {
    code: 'OT2_0',
    description: 'Overtime 2.0',
    inputMode: 'HOURS',
    rate: null,
    rateMultiplier: '2.0',
    requiresAttachment: false,
  },
  {
    code: 'NSHIFT',
    description: 'Night Shift Allowance',
    inputMode: 'QUANTITY',
    rate: '150',
    rateMultiplier: null,
    requiresAttachment: false,
  },
  {
    code: 'STANDBY',
    description: 'Standby Allowance',
    inputMode: 'QUANTITY',
    rate: '200',
    rateMultiplier: null,
    requiresAttachment: false,
  },
  {
    code: 'STANDBY_WK',
    description: 'Standby Weekly (MHC only)',
    inputMode: 'QUANTITY',
    rate: '1000',
    rateMultiplier: null,
    requiresAttachment: false,
  },
];

const OTHER_TYPES: SeedClaimType[] = [
  {
    code: 'CALL_OUT',
    description: 'Call Out Fee',
    inputMode: 'QUANTITY',
    rate: '350',
    rateMultiplier: null,
    requiresAttachment: false,
  },
  {
    code: 'S&T',
    description: 'S&T Allowance',
    inputMode: 'AMOUNT',
    rate: null,
    rateMultiplier: null,
    requiresAttachment: true,
  },
  {
    code: 'KM_CLM',
    description: 'Kilometre Claims',
    inputMode: 'KILOMETRES',
    rate: '4.5',
    rateMultiplier: null,
    requiresAttachment: false,
  },
];

/**
 * ASSUMPTION (section 5.3.1, inferred from the balances page): the overtime types belong to both
 * overtime groups and the other types to both "other" groups. Rebate Claims has no observed
 * types. Type ids are fixed: 1–5 and 6–10 (overtime), 11–13 and 14–16 (other).
 */
export const SEED_CLAIM_TYPES: { id: number; groupId: number; type: SeedClaimType }[] = [
  ...OVERTIME_TYPES.map((type, i) => ({ id: 1 + i, groupId: 1, type })),
  ...OVERTIME_TYPES.map((type, i) => ({ id: 6 + i, groupId: 2, type })),
  ...OTHER_TYPES.map((type, i) => ({ id: 11 + i, groupId: 3, type })),
  ...OTHER_TYPES.map((type, i) => ({ id: 14 + i, groupId: 4, type })),
];

/** ASSUMPTION: the hourly rate (NAD) given to seeded employees without one, so overtime has a rate. */
export const SEED_HOURLY_RATE = '85.0000';

/**
 * The claim reference data (section 14): groups, types and one `NO_CAP` ANNUAL cap per type for
 * every company rule. Existing rows are left alone, so HR edits survive a re-seed.
 */
export async function seedClaimReferenceData({
  db,
  ctx,
}: Pick<SeedDeps, 'db' | 'ctx'>): Promise<SeedSummary> {
  return db.tx(ctx, async (tx) => {
    let groups = 0;
    let types = 0;
    let caps = 0;
    for (const g of SEED_CLAIM_GROUPS) {
      if (await tx.claimGroup.findUnique({ where: { id: g.id } })) continue;
      await tx.claimGroup.create({ data: { id: g.id, code: g.code, description: g.description } });
      groups += 1;
    }
    for (const { id, groupId, type } of SEED_CLAIM_TYPES) {
      if (!(await tx.claimType.findUnique({ where: { id } }))) {
        await tx.claimType.create({
          data: {
            id,
            groupId,
            code: type.code,
            description: type.description,
            inputMode: type.inputMode,
            rate: type.rate,
            rateMultiplier: type.rateMultiplier,
            payrollCode: type.code,
            requiresAttachment: type.requiresAttachment,
          },
        });
        types += 1;
      }
      if (await tx.claimCap.findFirst({ where: { claimTypeId: id, companyRuleId: null } })) continue;
      await tx.claimCap.create({
        data: { claimTypeId: id, companyRuleId: null, cycle: 'ANNUAL', mode: 'NO_CAP' },
      });
      caps += 1;
    }
    return { claimGroupsCreated: groups, claimTypesCreated: types, claimCapsCreated: caps };
  });
}

/** Claim reference data plus an hourly rate for the seeded employees that have none. */
export async function seedClaims(deps: SeedDeps): Promise<SeedSummary> {
  const summary = await seedClaimReferenceData(deps);
  const rated = await deps.db.tx(deps.ctx, async (tx) => {
    const employees = await tx.employee.findMany({
      where: { hourlyRate: null, user: { username: { in: SEED_PEOPLE.map((p) => p.username) } } },
      select: { id: true },
    });
    for (const e of employees) {
      const before = await tx.employee.findUniqueOrThrow({ where: { id: e.id } });
      const after = await tx.employee.update({
        where: { id: e.id },
        data: { hourlyRate: SEED_HOURLY_RATE, version: { increment: 1 } },
      });
      deps.audit.record(tx, deps.ctx, {
        category: 'DATA_CHANGE',
        action: 'EMPLOYEE.HOURLY_RATE_SEEDED',
        entityType: 'Employee',
        entityId: e.id,
        subjectEmployeeId: e.id,
        before,
        after,
      });
    }
    return employees.length;
  });
  return { ...summary, hourlyRatesSet: rated };
}
