import { afterAll, beforeAll, describe, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import { all, type MatrixCase, only, ROLE_KEYS, runAnonymous, runMatrixCell } from '../support/authz';
import { createRoleFixtures, type RoleFixtures } from '../support/fixtures';
import { TWO_STEP, WorkflowKit } from '../support/workflow';

/**
 * Authorisation matrix (section 16.2) for the Phase 9 endpoints: the admin API (HR_ADMIN for HR
 * data, PAYROLL_ADMIN for pay periods, SYSTEM_ADMIN for users), the free text workflow, the audit
 * API (AUDITOR and SYSTEM_ADMIN; record history by entity scope) and MFA disable. Writes use a
 * stale version or an invalid body, so an allowed role gets 409 or 422 and nothing changes.
 */
let definitionId = 0;
let payPeriodId = 0;
let auditId = '';

const HR = only(['hrAdmin'], 200);
const HR_STALE = only(['hrAdmin'], 409);
const HR_INVALID = only(['hrAdmin'], 422);
const HR_PAYROLL = only(['hrAdmin', 'payrollAdmin'], 200);
const ORG_READERS = only(['hrAdmin', 'payrollAdmin', 'sysAdmin'], 200);
const SYS = only(['sysAdmin'], 200);
const SYS_STALE = only(['sysAdmin'], 409);
const AUDITORS = only(['auditor', 'sysAdmin'], 200);
const STALE = 999_999;

const CASES: MatrixCase[] = [
  // Companies and company rules.
  { name: 'GET /admin/companies', method: 'get', path: '/admin/companies', expect: ORG_READERS },
  {
    name: 'GET /admin/companies/:id (own)',
    method: 'get',
    path: (f) => `/admin/companies/${f.org.companyId}`,
    expect: ORG_READERS,
  },
  {
    name: 'GET /admin/companies/:id (other company)',
    method: 'get',
    path: (f) => `/admin/companies/${f.otherOrg.companyId}`,
    expect: only(['sysAdmin'], 200),
  },
  {
    name: 'POST /admin/companies (invalid)',
    method: 'post',
    path: '/admin/companies',
    body: () => ({}),
    expect: HR_INVALID,
  },
  {
    name: 'PUT /admin/companies/:id (stale)',
    method: 'put',
    path: (f) => `/admin/companies/${f.org.companyId}`,
    body: () => ({ name: 'Stale', version: STALE }),
    expect: HR_STALE,
  },
  {
    name: 'DELETE /admin/companies/:id (other company)',
    method: 'delete',
    path: (f) => `/admin/companies/${f.otherOrg.companyId}`,
    body: () => ({ version: STALE }),
    expect: all(403),
  },
  { name: 'GET /admin/company-rules', method: 'get', path: '/admin/company-rules', expect: ORG_READERS },
  {
    name: 'POST /admin/company-rules (invalid)',
    method: 'post',
    path: '/admin/company-rules',
    body: () => ({ code: '' }),
    expect: HR_INVALID,
  },
  {
    name: 'PUT /admin/company-rules/:id (stale)',
    method: 'put',
    path: (f) => `/admin/company-rules/${f.org.companyRuleId}`,
    body: () => ({ description: 'Stale', version: STALE }),
    expect: HR_STALE,
  },
  // Holidays.
  { name: 'GET /admin/public-holidays', method: 'get', path: '/admin/public-holidays', expect: HR },
  {
    name: 'POST /admin/public-holidays (invalid)',
    method: 'post',
    path: '/admin/public-holidays',
    body: () => ({ date: 'tomorrow' }),
    expect: HR_INVALID,
  },
  { name: 'GET /admin/holiday-rules', method: 'get', path: '/admin/holiday-rules', expect: HR },
  {
    name: 'POST /admin/holiday-rules (invalid)',
    method: 'post',
    path: '/admin/holiday-rules',
    body: () => ({ name: 'x', kind: 'FIXED' }),
    expect: HR_INVALID,
  },
  // Employees and the import.
  { name: 'GET /admin/employees', method: 'get', path: '/admin/employees', expect: HR_PAYROLL },
  {
    name: 'GET /admin/employees/:id (in the company)',
    method: 'get',
    path: (f) => `/admin/employees/${f.employee.employeeId}`,
    expect: HR_PAYROLL,
  },
  {
    name: 'GET /admin/employees/:id (other company)',
    method: 'get',
    path: (f) => `/admin/employees/${f.otherCompany.employeeId}`,
    expect: all(403),
  },
  {
    name: 'POST /admin/employees (invalid)',
    method: 'post',
    path: '/admin/employees',
    body: () => ({}),
    expect: HR_INVALID,
  },
  {
    name: 'PUT /admin/employees/:id (stale)',
    method: 'put',
    path: (f) => `/admin/employees/${f.employee2.employeeId}`,
    body: () => ({ jobTitle: 'Stale', version: STALE }),
    expect: HR_STALE,
  },
  {
    name: 'PUT /admin/employees/:id (other company)',
    method: 'put',
    path: (f) => `/admin/employees/${f.otherCompany.employeeId}`,
    body: () => ({ jobTitle: 'Nope', version: STALE }),
    expect: all(403),
  },
  {
    name: 'POST /admin/employees/:id/terminate (stale)',
    method: 'post',
    path: (f) => `/admin/employees/${f.employee2.employeeId}/terminate`,
    body: () => ({ terminationDate: '2026-12-31', reason: 'Matrix', version: STALE }),
    expect: HR_STALE,
  },
  {
    name: 'PUT /admin/employees/:id/photo (stale)',
    method: 'put',
    path: (f) => `/admin/employees/${f.employee2.employeeId}/photo`,
    body: () => ({ attachmentId: null, version: STALE }),
    expect: HR_STALE,
  },
  {
    name: 'POST /admin/import/employees (dry run, bad header)',
    method: 'post',
    path: '/admin/import/employees',
    body: () => ({ csv: 'nothing,useful\n1,2', mode: 'DRY_RUN' }),
    expect: HR_INVALID,
  },
  // Users.
  { name: 'GET /admin/users', method: 'get', path: '/admin/users', expect: SYS },
  {
    name: 'GET /admin/users/employee-options',
    method: 'get',
    path: '/admin/users/employee-options',
    expect: SYS,
  },
  {
    name: 'GET /admin/users/:id',
    method: 'get',
    path: (f) => `/admin/users/${f.employee.userId}`,
    expect: SYS,
  },
  {
    name: 'POST /admin/users (invalid)',
    method: 'post',
    path: '/admin/users',
    body: () => ({ username: 'x' }),
    expect: only(['sysAdmin'], 422),
  },
  {
    name: 'PUT /admin/users/:id (stale)',
    method: 'put',
    path: (f) => `/admin/users/${f.employee.userId}`,
    body: () => ({ email: null, version: STALE }),
    expect: SYS_STALE,
  },
  {
    name: 'PUT /admin/users/:id/roles (stale)',
    method: 'put',
    path: (f) => `/admin/users/${f.employee.userId}/roles`,
    body: () => ({ roles: ['EMPLOYEE'], version: STALE }),
    expect: SYS_STALE,
  },
  ...(['activate', 'deactivate', 'unlock', 'reset-password', 'reset-mfa'] as const).map(
    (action): MatrixCase => ({
      name: `POST /admin/users/:id/${action} (stale)`,
      method: 'post',
      path: (f) => `/admin/users/${f.employee.userId}/${action}`,
      body: () => ({ version: STALE }),
      expect: SYS_STALE,
    }),
  ),
  // Workflow definitions, pay periods, free text types.
  { name: 'GET /admin/workflow-definitions', method: 'get', path: '/admin/workflow-definitions', expect: HR },
  {
    name: 'GET /admin/workflow-definitions/:id',
    method: 'get',
    path: () => `/admin/workflow-definitions/${definitionId}`,
    expect: HR,
  },
  {
    name: 'POST /admin/workflow-definitions (invalid steps)',
    method: 'post',
    path: '/admin/workflow-definitions',
    body: () => ({
      workflowType: 'TRAINING',
      name: 'x',
      steps: [{ stepNo: 2, name: 'x', resolution: 'REPORTS_TO' }],
    }),
    expect: HR_INVALID,
  },
  {
    name: 'PUT /admin/workflow-definitions/:id (stale)',
    method: 'put',
    path: () => `/admin/workflow-definitions/${definitionId}`,
    body: () => ({ name: 'x', steps: [{ stepNo: 1, name: 'x', resolution: 'REPORTS_TO' }], version: STALE }),
    expect: HR_STALE,
  },
  {
    name: 'DELETE /admin/workflow-definitions/:id (stale)',
    method: 'delete',
    path: () => `/admin/workflow-definitions/${definitionId}`,
    body: () => ({ version: STALE }),
    expect: HR_STALE,
  },
  {
    name: 'GET /admin/pay-periods',
    method: 'get',
    path: '/admin/pay-periods',
    expect: only(['payrollAdmin'], 200),
  },
  {
    name: 'POST /admin/pay-periods (invalid)',
    method: 'post',
    path: '/admin/pay-periods',
    body: () => ({ description: 'x' }),
    expect: only(['payrollAdmin'], 422),
  },
  {
    name: 'PUT /admin/pay-periods/:id (stale)',
    method: 'put',
    path: () => `/admin/pay-periods/${payPeriodId}`,
    body: () => ({ description: 'x', version: STALE }),
    expect: only(['payrollAdmin'], 409),
  },
  {
    name: 'POST /admin/pay-periods/:id/close (stale)',
    method: 'post',
    path: () => `/admin/pay-periods/${payPeriodId}/close`,
    body: () => ({ version: STALE }),
    expect: only(['payrollAdmin'], 409),
  },
  { name: 'GET /admin/free-text-types', method: 'get', path: '/admin/free-text-types', expect: HR },
  {
    name: 'POST /admin/free-text-types (invalid)',
    method: 'post',
    path: '/admin/free-text-types',
    body: () => ({ code: 'lower case' }),
    expect: HR_INVALID,
  },
  // Free text workflow.
  { name: 'GET /free-text/types', method: 'get', path: '/free-text/types', expect: all(200) },
  { name: 'GET /free-text/about-options', method: 'get', path: '/free-text/about-options', expect: all(200) },
  { name: 'GET /free-text', method: 'get', path: '/free-text', expect: all(200) },
  {
    name: 'GET /free-text?scope=company',
    method: 'get',
    path: '/free-text?scope=company',
    expect: only(['hrAdmin', 'auditor'], 200),
  },
  {
    name: 'POST /free-text (invalid)',
    method: 'post',
    path: '/free-text',
    body: () => ({ typeId: 1, body: '' }),
    expect: all(422),
  },
  {
    name: 'GET /free-text/types?employeeId= (the employee)',
    method: 'get',
    path: (f) => `/free-text/types?employeeId=${f.employee.employeeId}`,
    expect: only(['employee', 'managerB', 'hrAdmin'], 200),
  },
  // Audit API.
  { name: 'GET /audit', method: 'get', path: '/audit?pageSize=1', expect: AUDITORS },
  { name: 'GET /audit/:id', method: 'get', path: () => `/audit/${auditId}`, expect: AUDITORS },
  {
    name: 'GET /audit/verify (empty range)',
    method: 'get',
    path: '/audit/verify?from=2000-01-01&to=2000-01-02',
    expect: AUDITORS,
  },
  {
    name: 'POST /audit/export',
    method: 'post',
    path: '/audit/export',
    body: () => ({ filters: { entityType: 'Nothing', entityId: 'none' }, format: 'csv' }),
    expect: AUDITORS,
  },
  {
    name: 'GET /audit/entity/User/:id (the employee’s login)',
    method: 'get',
    path: (f) => `/audit/entity/User/${f.employee.userId}`,
    expect: only(['employee', 'auditor', 'sysAdmin'], 200),
  },
  {
    name: 'GET /audit/entity/Employee/:id (the employee)',
    method: 'get',
    path: (f) => `/audit/entity/Employee/${f.employee.employeeId}`,
    expect: only(['employee', 'hrAdmin', 'payrollAdmin', 'auditor', 'sysAdmin'], 200),
  },
  {
    name: 'GET /audit/entity/CompanyRule/:id',
    method: 'get',
    path: (f) => `/audit/entity/CompanyRule/${f.org.companyRuleId}`,
    expect: only(['hrAdmin', 'payrollAdmin', 'auditor', 'sysAdmin'], 200),
  },
  // MFA disable (nobody has MFA on: 409 after the checks).
  {
    name: 'POST /auth/mfa/disable (MFA off)',
    method: 'post',
    path: '/auth/mfa/disable',
    body: () => ({ currentPassword: 'whatever', code: '123456' }),
    expect: all(409),
  },
];

describe('authorisation matrix: Phase 9 endpoints', () => {
  let t: TestApp;
  let f: RoleFixtures;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    const kit = new WorkflowKit(t);
    definitionId = await kit.definition({
      type: 'TRAINING',
      companyRuleId: f.org.companyRuleId,
      steps: TWO_STEP,
    });
    payPeriodId = await kit.payPeriod(f.org);
    const row = await t.db.prisma.auditLog.findFirstOrThrow({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    auditId = row.id.toString();
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
