import { dateFromBusiness } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import { startTestApp, type TestApp } from '../support/app';
import { all, type MatrixCase, only, ROLE_KEYS, runAnonymous, runMatrixCell } from '../support/authz';
import { createRoleFixtures, nextUnique, type RoleFixtures } from '../support/fixtures';

/**
 * Authorisation matrix (section 16.2) for the final gap endpoints: fund memberships (list, end),
 * the SPECIFIC_USER step picker, DELETE for lookups and transaction codes, the audit pickers and
 * holiday restore. Writes send a stale version, so an allowed role gets 409 and nothing changes.
 */
const sys = systemContext('test-authz-final-gaps');
const STALE = 999_999;
const HR = only(['hrAdmin'], 200);
const HR_STALE = only(['hrAdmin'], 409);
const AUDITORS = only(['auditor', 'sysAdmin'], 200);

const ids = { fund: 0, membership: 0, otherMembership: 0, title: 0, code: 0, holiday: 0 };

const CASES: MatrixCase[] = [
  {
    name: 'GET /admin/retirement-funds/:id/memberships',
    method: 'get',
    path: () => `/admin/retirement-funds/${ids.fund}/memberships`,
    expect: HR,
  },
  {
    name: 'POST /admin/retirement-funds/:id/memberships/:membershipId/end (stale)',
    method: 'post',
    path: () => `/admin/retirement-funds/${ids.fund}/memberships/${ids.membership}/end`,
    body: () => ({ version: STALE }),
    expect: HR_STALE,
  },
  {
    name: 'POST /admin/retirement-funds/:id/memberships/:membershipId/end (other company)',
    method: 'post',
    path: () => `/admin/retirement-funds/${ids.fund}/memberships/${ids.otherMembership}/end`,
    body: () => ({ version: STALE }),
    expect: all(403),
  },
  {
    name: 'GET /admin/workflow-definitions/user-options',
    method: 'get',
    path: '/admin/workflow-definitions/user-options?search=a',
    expect: HR,
  },
  {
    name: 'DELETE /admin/lookups/:table/:id (stale)',
    method: 'delete',
    path: () => `/admin/lookups/titles/${ids.title}`,
    body: () => ({ version: STALE }),
    expect: HR_STALE,
  },
  {
    name: 'DELETE /admin/transaction-codes/:id (stale)',
    method: 'delete',
    path: () => `/admin/transaction-codes/${ids.code}`,
    body: () => ({ version: STALE }),
    expect: HR_STALE,
  },
  { name: 'GET /audit/employee-options', method: 'get', path: '/audit/employee-options', expect: AUDITORS },
  { name: 'GET /audit/actor-options', method: 'get', path: '/audit/actor-options', expect: AUDITORS },
  {
    name: 'POST /admin/public-holidays/:id/restore (stale)',
    method: 'post',
    path: () => `/admin/public-holidays/${ids.holiday}/restore`,
    body: () => ({ version: STALE }),
    expect: HR_STALE,
  },
];

describe('authorisation matrix: final gap endpoints', () => {
  let t: TestApp;
  let f: RoleFixtures;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    const n = await nextUnique(t.db);
    await t.db.tx(sys, async (tx) => {
      const fund = await tx.retirementFund.create({ data: { code: `AZ${n}`, name: `Matrix Fund ${n}` } });
      ids.fund = fund.id;
      ids.membership = (
        await tx.fundMembership.create({ data: { fundId: fund.id, employeeId: f.employee.employeeId ?? 0 } })
      ).id;
      ids.otherMembership = (
        await tx.fundMembership.create({
          data: { fundId: fund.id, employeeId: f.otherCompany.employeeId ?? 0 },
        })
      ).id;
      ids.code = (
        await tx.payrollTransactionCode.create({ data: { code: `AZ${n}`, description: `Matrix ${n}` } })
      ).id;
      ids.holiday = (
        await tx.publicHoliday.create({
          data: {
            companyId: f.org.companyId,
            date: dateFromBusiness('2091-06-15'),
            name: `Matrix ${n}`,
            deletedAt: new Date(),
          },
        })
      ).id;
    });
    ids.title = (
      await t.db.prisma.parameterValue.findFirstOrThrow({
        where: { tableName: 'Title' },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await t.close();
  });

  describe.each(CASES)('$name', (c) => {
    it.each(ROLE_KEYS)('as %s', async (role) => {
      await runMatrixCell(t, f, role, c);
    });

    it('without a session', async () => {
      await runAnonymous(t, f, c);
    });
  });
});
