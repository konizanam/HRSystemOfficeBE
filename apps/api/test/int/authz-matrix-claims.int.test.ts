import { todayBusinessDate } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import { all, type MatrixCase, only, ROLE_KEYS, runAnonymous, runMatrixCell } from '../support/authz';
import { ClaimKit } from '../support/claims';
import { createRoleFixtures, login, type RoleFixtures } from '../support/fixtures';
import { WorkflowKit } from '../support/workflow';

/**
 * Authorisation matrix (section 16.2) for the Phase 5 endpoints: claims, their balances and
 * export, the claim admin API and the pay periods filter. Writes are sent with a stale version or
 * an invalid body, so a caller that passes authorisation gets 409/422 and nothing changes; a
 * caller that does not gets 403 (audited DENIED).
 */
let groupId = 0;
let draftId = 0;
let submittedId = 0;
let capId = 0;
let companyRuleId = 0;
const STALE = 999;

/** Readers of the employee's claims: self, manager, HR/Payroll in scope, auditors (not system admins). */
const CLAIM_READERS = only(['employee', 'managerB', 'hrAdmin', 'payrollAdmin', 'auditor'], 200);
/** The "Working as" rule for the employee: self, their manager, HR. */
const ACT_FOR = (status: number) => only(['employee', 'managerB', 'hrAdmin'], status);
const CLAIM_ADMINS = (status: number) => only(['hrAdmin', 'payrollAdmin'], status);

const CASES: MatrixCase[] = [
  { name: 'GET /claims/groups', method: 'get', path: '/claims/groups', expect: all(200) },
  {
    name: 'GET /claims/groups?employeeId= (the employee)',
    method: 'get',
    path: (f) => `/claims/groups?employeeId=${f.employee.employeeId}`,
    expect: ACT_FOR(200),
  },
  {
    name: 'GET /claims/groups/:id/setup',
    method: 'get',
    path: () => `/claims/groups/${groupId}/setup`,
    expect: all(200),
  },
  {
    name: 'GET /claims/groups/:id/setup?employeeId= (the employee)',
    method: 'get',
    path: (f) => `/claims/groups/${groupId}/setup?employeeId=${f.employee.employeeId}`,
    expect: ACT_FOR(200),
  },
  { name: 'GET /claims/saved', method: 'get', path: '/claims/saved', expect: all(200) },
  {
    name: 'GET /claims/saved?employeeId= (the employee)',
    method: 'get',
    path: (f) => `/claims/saved?employeeId=${f.employee.employeeId}`,
    expect: ACT_FOR(200),
  },
  { name: 'GET /claims/balances', method: 'get', path: '/claims/balances', expect: all(200) },
  {
    name: 'GET /claims/balances?employeeId= (the employee)',
    method: 'get',
    path: (f) => `/claims/balances?employeeId=${f.employee.employeeId}`,
    expect: CLAIM_READERS,
  },
  { name: 'GET /claims', method: 'get', path: '/claims', expect: all(200) },
  {
    name: 'GET /claims?employeeId= (the employee)',
    method: 'get',
    path: (f) => `/claims?employeeId=${f.employee.employeeId}`,
    expect: CLAIM_READERS,
  },
  {
    name: 'GET /claims?scope=reports',
    method: 'get',
    path: '/claims?scope=reports',
    expect: only(['managerB'], 200),
  },
  {
    name: 'GET /claims?scope=company',
    method: 'get',
    path: '/claims?scope=company',
    expect: only(['hrAdmin', 'payrollAdmin', 'auditor'], 200),
  },
  { name: 'GET /claims/export', method: 'get', path: '/claims/export?format=csv', expect: all(200) },
  {
    name: 'GET /claims/export?employeeId= (the employee)',
    method: 'get',
    path: (f) => `/claims/export?format=xlsx&employeeId=${f.employee.employeeId}`,
    expect: CLAIM_READERS,
  },
  {
    name: 'POST /claims (for the employee, unknown group)',
    method: 'post',
    path: '/claims',
    body: (f) => ({ employeeId: f.employee.employeeId, groupId: 999_999 }),
    expect: ACT_FOR(422),
  },
  {
    name: 'GET /claims/:id (submitted)',
    method: 'get',
    path: () => `/claims/${submittedId}`,
    expect: CLAIM_READERS,
  },
  {
    name: 'GET /claims/:id (draft)',
    method: 'get',
    path: () => `/claims/${draftId}`,
    expect: CLAIM_READERS,
  },
  { name: 'GET /claims/:id (missing)', method: 'get', path: '/claims/999999999', expect: all(404) },
  {
    name: 'PUT /claims/:id (stale version)',
    method: 'put',
    path: () => `/claims/${draftId}`,
    body: () => ({ version: STALE, lines: [] }),
    expect: ACT_FOR(409),
  },
  {
    name: 'POST /claims/:id/submit (stale version)',
    method: 'post',
    path: () => `/claims/${draftId}/submit`,
    body: () => ({ version: STALE }),
    expect: ACT_FOR(409),
  },
  {
    name: 'POST /claims/:id/cancel (stale version)',
    method: 'post',
    path: () => `/claims/${submittedId}/cancel`,
    body: () => ({ version: STALE }),
    expect: only(['employee', 'managerB', 'hrAdmin', 'payrollAdmin'], 409),
  },
  {
    name: 'POST /admin/claims/adjustments (nothing to adjust)',
    method: 'post',
    path: '/admin/claims/adjustments',
    body: (f) => ({ employeeId: f.employee.employeeId, claimTypeId: 1, reason: 'Matrix' }),
    expect: only(['payrollAdmin'], 422),
  },
  { name: 'GET /admin/claim-groups', method: 'get', path: '/admin/claim-groups', expect: CLAIM_ADMINS(200) },
  {
    name: 'GET /admin/claim-groups/:id',
    method: 'get',
    path: '/admin/claim-groups/1',
    expect: CLAIM_ADMINS(200),
  },
  {
    name: 'POST /admin/claim-groups (invalid)',
    method: 'post',
    path: '/admin/claim-groups',
    body: () => ({ code: 'lower case' }),
    expect: CLAIM_ADMINS(422),
  },
  {
    name: 'PUT /admin/claim-groups/:id (stale version)',
    method: 'put',
    path: '/admin/claim-groups/4',
    body: () => ({ version: STALE, description: 'Other Claims' }),
    expect: CLAIM_ADMINS(409),
  },
  {
    name: 'DELETE /admin/claim-groups/:id (stale version)',
    method: 'delete',
    path: '/admin/claim-groups/4',
    body: () => ({ version: STALE }),
    expect: CLAIM_ADMINS(409),
  },
  {
    name: 'GET /admin/claim-types',
    method: 'get',
    path: '/admin/claim-types?groupId=1',
    expect: CLAIM_ADMINS(200),
  },
  {
    name: 'GET /admin/claim-types/:id',
    method: 'get',
    path: '/admin/claim-types/1',
    expect: CLAIM_ADMINS(200),
  },
  {
    name: 'POST /admin/claim-types (invalid)',
    method: 'post',
    path: '/admin/claim-types',
    body: () => ({ groupId: 1 }),
    expect: CLAIM_ADMINS(422),
  },
  {
    name: 'PUT /admin/claim-types/:id (stale version)',
    method: 'put',
    path: '/admin/claim-types/1',
    body: () => ({ version: STALE }),
    expect: CLAIM_ADMINS(409),
  },
  {
    name: 'DELETE /admin/claim-types/:id (stale version)',
    method: 'delete',
    path: '/admin/claim-types/1',
    body: () => ({ version: STALE }),
    expect: CLAIM_ADMINS(409),
  },
  {
    name: 'GET /admin/claim-caps',
    method: 'get',
    path: '/admin/claim-caps?claimTypeId=1',
    expect: CLAIM_ADMINS(200),
  },
  {
    name: 'POST /admin/claim-caps (invalid)',
    method: 'post',
    path: '/admin/claim-caps',
    body: () => ({ claimTypeId: 1 }),
    expect: CLAIM_ADMINS(422),
  },
  {
    name: 'PUT /admin/claim-caps/:id (stale version)',
    method: 'put',
    path: () => `/admin/claim-caps/${capId}`,
    body: () => ({ version: STALE }),
    expect: CLAIM_ADMINS(409),
  },
  {
    name: 'DELETE /admin/claim-caps/:id (stale version)',
    method: 'delete',
    path: () => `/admin/claim-caps/${capId}`,
    body: () => ({ version: STALE }),
    expect: CLAIM_ADMINS(409),
  },
  {
    name: 'GET /workflow/pay-periods?companyRuleId=',
    method: 'get',
    path: () => `/workflow/pay-periods?companyRuleId=${companyRuleId}`,
    expect: only(['payrollAdmin'], 200),
  },
];

describe('authorisation matrix: Phase 5 endpoints', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    const claims = new ClaimKit(t, kit);
    await claims.setup(f.org);
    companyRuleId = f.org.companyRuleId;
    groupId = await claims.group();
    const typeId = await claims.type(groupId, f.org.companyRuleId, { inputMode: 'AMOUNT' });
    const emp = await login(t, f.employee);
    const line = { claimTypeId: typeId, date: todayBusinessDate(), amount: '12.50' };
    draftId = (await claims.create(emp, { groupId, lines: [line] })).id;
    submittedId = (await claims.submit(emp, await claims.create(emp, { groupId, lines: [line] }))).id;
    capId = (await t.db.prisma.claimCap.findFirstOrThrow({ where: { claimTypeId: 1, companyRuleId: null } }))
      .id;
  });

  afterAll(async () => {
    kit.restore();
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
