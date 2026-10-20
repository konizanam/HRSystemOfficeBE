import { COUNTRIES, LOOKUP_PARAMETER_TABLES, LOOKUP_TABLES, lookupSeedValues } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeed } from '../../prisma/seed/index';
import { SEED_FUNDS } from '../../prisma/seed/details';
import { AuditService } from '../../src/audit/audit.service';
import { systemContext } from '../../src/common/context/security-context';
import { SEED_BANKS } from '../../src/modules/details/bank-data';
import { startTestApp, type TestApp } from '../support/app';
import { auditSince, lastAuditId } from '../support/fixtures';

describe('seed: My Details reference and demo data (section 14)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('seeds lookups, banks, funds, transactions and accounts once', async () => {
    const deps = {
      db: t.db,
      audit: t.app.get(AuditService),
      ctx: systemContext('seed-details-test'),
      app: t.app,
    };
    await runSeed(deps);
    const since = await lastAuditId(t.db);
    const second = await runSeed(deps);
    expect(second).toMatchObject({
      lookupRowsCreated: 0,
      banksCreated: 0,
      bankBranchesCreated: 0,
      retirementFundsCreated: 0,
      fundMembershipsCreated: 0,
      transactionCodesCreated: 0,
      employeeTransactionsCreated: 0,
      bankAccountsCreated: 0,
    });
    expect(await auditSince(t.db, since)).toHaveLength(0);

    for (const table of LOOKUP_TABLES) {
      const codes = (
        await t.db.prisma.parameterValue.findMany({
          where: { tableName: LOOKUP_PARAMETER_TABLES[table] },
          select: { code: true },
        })
      ).map((r) => r.code);
      expect(codes, table).toEqual(expect.arrayContaining(lookupSeedValues(table).map((v) => v.code)));
    }
    expect(
      await t.db.prisma.parameterValue.count({ where: { tableName: 'Country' } }),
    ).toBeGreaterThanOrEqual(COUNTRIES.length);
    const banks = await t.db.prisma.bank.findMany({ where: { name: { in: SEED_BANKS.map((b) => b.name) } } });
    expect(banks).toHaveLength(40);

    const employee1 = await t.db.prisma.employee.findUniqueOrThrow({
      where: { entityCode: '000077' },
      include: {
        fundMemberships: { include: { fund: true } },
        employeeTransactions: { where: { isRecurring: true } },
        bankAccounts: { where: { isActive: true } },
      },
    });
    expect(employee1.fundMemberships.map((m) => m.fund.code).sort()).toEqual(
      SEED_FUNDS.map((f) => f.code).sort(),
    );
    expect(employee1.employeeTransactions.length).toBeGreaterThanOrEqual(3);
    expect(employee1.bankAccounts).toHaveLength(1);
    expect(employee1.bankAccounts[0]?.accountNumberEnc).not.toContain('8000077077');
  });
});
