import { afterAll, beforeAll, describe, it } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import { startTestApp, type TestApp } from '../support/app';
import { all, type MatrixCase, only, ROLE_KEYS, runAnonymous, runMatrixCell } from '../support/authz';
import { DetailsKit } from '../support/details';
import { createRoleFixtures, nextUnique, type RoleFixtures } from '../support/fixtures';
import { WorkflowKit } from '../support/workflow';

/**
 * Authorisation matrix (section 16.2) for the Phase 6 endpoints: My Details (`/me` is each
 * caller's own record), the lookups and banks, and the HR/Payroll admin endpoints. Writes are sent
 * with a stale version or an invalid body, so a caller that passes authorisation gets 404/409/422
 * and nothing changes; a caller that does not gets 403 (audited DENIED).
 */
let accountId = 0;
let membershipId = 0;
let bankId = 0;
let branchId = 0;
let fundId = 0;
let lookupId = 0;
let codeId = 0;
const STALE = 999;
const MISSING = 999_999_999;

const HR_PAYROLL = (status: number) => only(['hrAdmin', 'payrollAdmin'], status);
const HR = (status: number) => only(['hrAdmin'], status);

const CASES: MatrixCase[] = [
  // ───── /me (every caller reads and changes their own record) ─────
  { name: 'GET /me/personal', method: 'get', path: '/me/personal', expect: all(200) },
  { name: 'GET /me/personal/id-numbers', method: 'get', path: '/me/personal/id-numbers', expect: all(200) },
  {
    name: 'PUT /me/personal (stale version)',
    method: 'put',
    path: '/me/personal',
    body: () => ({ version: STALE, identity: { knownAs: 'Matrix' } }),
    expect: all(409),
  },
  {
    name: 'GET /me/change-requests',
    method: 'get',
    path: '/me/change-requests?status=open',
    expect: all(200),
  },
  { name: 'GET /me/bank-accounts', method: 'get', path: '/me/bank-accounts', expect: all(200) },
  {
    name: 'POST /me/bank-accounts (no supporting document)',
    method: 'post',
    path: '/me/bank-accounts',
    body: () => ({
      accountType: 'SAVINGS',
      accountHolderName: 'Matrix',
      accountHolderRelationship: 'OWN',
      bankId,
      accountNumber: '1234567890',
      attachmentIds: [],
    }),
    expect: all(422),
  },
  {
    name: "PUT /me/bank-accounts/:id (the employee's account, stale)",
    method: 'put',
    path: () => `/me/bank-accounts/${accountId}`,
    body: () => ({
      version: STALE,
      accountHolderName: 'Matrix',
      attachmentIds: ['7c9e6679-7425-40de-944b-e07fc1f90ae7'],
    }),
    expect: only(['employee'], 409, 404),
  },
  {
    name: "GET /me/bank-accounts/:id/unmasked (the employee's account)",
    method: 'get',
    path: () => `/me/bank-accounts/${accountId}/unmasked?reason=Matrix%20check`,
    expect: only(['payrollAdmin'], 404),
  },
  { name: 'GET /me/drivers-licences', method: 'get', path: '/me/drivers-licences', expect: all(200) },
  {
    name: 'POST /me/drivers-licences (no copy)',
    method: 'post',
    path: '/me/drivers-licences',
    body: () => ({ licenceNumber: 'NA123456', code: 'B', expiryDate: '2030-01-01', attachmentIds: [] }),
    expect: all(422),
  },
  {
    name: 'PUT /me/drivers-licences/:id (missing)',
    method: 'put',
    path: `/me/drivers-licences/${MISSING}`,
    body: () => ({ version: 1, code: 'B', attachmentIds: ['7c9e6679-7425-40de-944b-e07fc1f90ae7'] }),
    expect: all(404),
  },
  {
    name: 'DELETE /me/drivers-licences/:id (missing)',
    method: 'delete',
    path: `/me/drivers-licences/${MISSING}`,
    body: () => ({ version: 1 }),
    expect: all(404),
  },
  { name: 'GET /me/family', method: 'get', path: '/me/family', expect: all(200) },
  {
    name: 'POST /me/family (unknown relationship)',
    method: 'post',
    path: '/me/family',
    body: () => ({ relationship: 'Neighbour', firstName: 'A', lastName: 'B' }),
    expect: all(422),
  },
  {
    name: 'PUT /me/family/:id (missing)',
    method: 'put',
    path: `/me/family/${MISSING}`,
    body: () => ({ version: 1, knownAs: 'X' }),
    expect: all(404),
  },
  {
    name: 'DELETE /me/family/:id (missing)',
    method: 'delete',
    path: `/me/family/${MISSING}`,
    body: () => ({ version: 1 }),
    expect: all(404),
  },
  { name: 'GET /me/funds', method: 'get', path: '/me/funds', expect: all(200) },
  {
    name: "PUT /me/funds/:membershipId/beneficiaries (the employee's fund, stale)",
    method: 'put',
    path: () => `/me/funds/${membershipId}/beneficiaries`,
    body: () => ({
      version: STALE,
      beneficiaries: [{ name: 'A', relationship: 'Sibling', percentage: '100' }],
    }),
    expect: only(['employee'], 409, 404),
  },
  { name: 'GET /me/transactions', method: 'get', path: '/me/transactions', expect: all(200) },
  {
    name: 'POST /me/transactions (no amount)',
    method: 'post',
    path: '/me/transactions',
    body: () => ({ transactionCodeId: codeId }),
    expect: all(422),
  },
  // ───── Reference data ─────
  { name: 'GET /lookups/:table', method: 'get', path: '/lookups/countries', expect: all(200) },
  { name: 'GET /banks', method: 'get', path: '/banks', expect: all(200) },
  {
    name: 'GET /banks/:id/branches',
    method: 'get',
    path: () => `/banks/${bankId}/branches`,
    expect: all(200),
  },
  // ───── Admin ─────
  {
    name: 'GET /admin/employees/:id/personal (in scope)',
    method: 'get',
    path: (f) => `/admin/employees/${f.employee.employeeId}/personal`,
    expect: HR_PAYROLL(200),
  },
  {
    name: 'GET /admin/employees/:id/personal (other company)',
    method: 'get',
    path: (f) => `/admin/employees/${f.otherCompany.employeeId}/personal`,
    expect: all(403),
  },
  {
    name: 'PUT /admin/employees/:id/personal (stale)',
    method: 'put',
    path: (f) => `/admin/employees/${f.employee.employeeId}/personal`,
    body: () => ({ version: STALE, identity: { knownAs: 'Matrix' } }),
    expect: HR(409),
  },
  {
    name: 'GET /admin/employees/:id/bank-accounts',
    method: 'get',
    path: (f) => `/admin/employees/${f.employee.employeeId}/bank-accounts`,
    expect: HR_PAYROLL(200),
  },
  {
    name: 'GET /admin/bank-accounts/:id/unmasked',
    method: 'get',
    path: () => `/admin/bank-accounts/${accountId}/unmasked?reason=Matrix%20check`,
    expect: only(['payrollAdmin'], 200),
  },
  { name: 'GET /admin/banks', method: 'get', path: '/admin/banks', expect: HR_PAYROLL(200) },
  {
    name: 'POST /admin/banks (invalid)',
    method: 'post',
    path: '/admin/banks',
    body: () => ({ name: '' }),
    expect: HR_PAYROLL(422),
  },
  {
    name: 'PUT /admin/banks/:id (stale)',
    method: 'put',
    path: () => `/admin/banks/${bankId}`,
    body: () => ({ version: STALE, name: 'Matrix' }),
    expect: HR_PAYROLL(409),
  },
  {
    name: 'DELETE /admin/banks/:id (stale)',
    method: 'delete',
    path: () => `/admin/banks/${bankId}`,
    body: () => ({ version: STALE }),
    expect: HR_PAYROLL(409),
  },
  {
    name: 'GET /admin/banks/:id/branches',
    method: 'get',
    path: () => `/admin/banks/${bankId}/branches`,
    expect: HR_PAYROLL(200),
  },
  {
    name: 'POST /admin/banks/:id/branches (invalid)',
    method: 'post',
    path: () => `/admin/banks/${bankId}/branches`,
    body: () => ({ name: '' }),
    expect: HR_PAYROLL(422),
  },
  {
    name: 'PUT /admin/banks/:id/branches/:branchId (stale)',
    method: 'put',
    path: () => `/admin/banks/${bankId}/branches/${branchId}`,
    body: () => ({ version: STALE, code: '000000' }),
    expect: HR_PAYROLL(409),
  },
  {
    name: 'DELETE /admin/banks/:id/branches/:branchId (stale)',
    method: 'delete',
    path: () => `/admin/banks/${bankId}/branches/${branchId}`,
    body: () => ({ version: STALE }),
    expect: HR_PAYROLL(409),
  },
  { name: 'GET /admin/retirement-funds', method: 'get', path: '/admin/retirement-funds', expect: HR(200) },
  {
    name: 'POST /admin/retirement-funds (invalid)',
    method: 'post',
    path: '/admin/retirement-funds',
    body: () => ({ code: '!', name: '' }),
    expect: HR(422),
  },
  {
    name: 'PUT /admin/retirement-funds/:id (stale)',
    method: 'put',
    path: () => `/admin/retirement-funds/${fundId}`,
    body: () => ({ version: STALE, name: 'Matrix' }),
    expect: HR(409),
  },
  {
    name: 'DELETE /admin/retirement-funds/:id (stale)',
    method: 'delete',
    path: () => `/admin/retirement-funds/${fundId}`,
    body: () => ({ version: STALE }),
    expect: HR(409),
  },
  {
    name: 'POST /admin/retirement-funds/:id/memberships (already a member)',
    method: 'post',
    path: () => `/admin/retirement-funds/${fundId}/memberships`,
    body: (f) => ({ employeeId: f.employee.employeeId }),
    expect: HR(409),
  },
  {
    name: 'POST /admin/retirement-funds/:id/memberships (other company)',
    method: 'post',
    path: () => `/admin/retirement-funds/${fundId}/memberships`,
    body: (f) => ({ employeeId: f.otherCompany.employeeId }),
    expect: all(403),
  },
  { name: 'GET /admin/lookups/:table', method: 'get', path: '/admin/lookups/titles', expect: HR(200) },
  {
    name: 'POST /admin/lookups/:table (invalid)',
    method: 'post',
    path: '/admin/lookups/titles',
    body: () => ({ code: '', description: '' }),
    expect: HR(422),
  },
  {
    name: 'PUT /admin/lookups/:table/:id (stale)',
    method: 'put',
    path: () => `/admin/lookups/titles/${lookupId}`,
    body: () => ({ version: STALE, description: 'Matrix' }),
    expect: HR(409),
  },
  { name: 'GET /admin/transaction-codes', method: 'get', path: '/admin/transaction-codes', expect: HR(200) },
  {
    name: 'POST /admin/transaction-codes (invalid)',
    method: 'post',
    path: '/admin/transaction-codes',
    body: () => ({ code: '!' }),
    expect: HR(422),
  },
  {
    name: 'PUT /admin/transaction-codes/:id (stale)',
    method: 'put',
    path: () => `/admin/transaction-codes/${codeId}`,
    body: () => ({ version: STALE, description: 'Matrix' }),
    expect: HR(409),
  },
];

describe('authorisation matrix: Phase 6 endpoints', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    const details = new DetailsKit(t, kit);
    await details.setup(f.org);
    accountId = await details.account(f.employee, '3300445566');
    ({ bankId, branchId } = await details.bank());
    const n = await nextUnique(t.db);
    const sys = systemContext('test-matrix');
    await t.db.tx(sys, async (tx) => {
      const fund = await tx.retirementFund.create({ data: { code: `MX${n}`, name: `Matrix Fund ${n}` } });
      fundId = fund.id;
      const membership = await tx.fundMembership.create({
        data: { employeeId: f.employee.employeeId as number, fundId: fund.id },
      });
      membershipId = membership.id;
      const code = await tx.payrollTransactionCode.create({
        data: { code: `MX${n}`, description: 'Matrix input', allowEmployeeInput: true },
      });
      codeId = code.id;
    });
    lookupId = (
      await t.db.prisma.parameterValue.findUniqueOrThrow({
        where: { tableName_code: { tableName: 'Title', code: 'Mr' } },
      })
    ).id;
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
