import { todayBusinessDate } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import { all, type MatrixCase, only, ROLE_KEYS, runAnonymous, runMatrixCell } from '../support/authz';
import { createRoleFixtures, login, type RoleFixtures } from '../support/fixtures';
import { PayrollKit } from '../support/payroll';
import { WorkflowKit } from '../support/workflow';

/**
 * Authorisation matrix (section 16.2) for the Phase 7 endpoints: payslips, tax certificates, the
 * payroll imports (dry runs, so nothing changes), the dashboard, birthdays and reports.
 */
let payslipId = 0;
let certificateId = 0;
let periodEnd = '';

/** The employee's payroll documents: the employee and a payroll admin of the company only. */
const OWN_OR_PAYROLL = only(['employee', 'payrollAdmin'], 200);

const CASES: MatrixCase[] = [
  { name: 'GET /payslips', method: 'get', path: '/payslips', expect: all(200) },
  {
    name: 'GET /payslips?employeeId= (the employee)',
    method: 'get',
    path: (f) => `/payslips?employeeId=${f.employee.employeeId}`,
    expect: OWN_OR_PAYROLL,
  },
  { name: 'GET /payslips/:id', method: 'get', path: () => `/payslips/${payslipId}`, expect: OWN_OR_PAYROLL },
  {
    name: 'GET /payslips/:id/pdf',
    method: 'get',
    path: () => `/payslips/${payslipId}/pdf`,
    expect: OWN_OR_PAYROLL,
  },
  {
    name: 'GET /payslips/:id/pdf?download=1',
    method: 'get',
    path: () => `/payslips/${payslipId}/pdf?download=1`,
    expect: OWN_OR_PAYROLL,
  },
  { name: 'GET /payslips/:id (missing)', method: 'get', path: '/payslips/999999999', expect: all(404) },
  { name: 'GET /tax-certificates', method: 'get', path: '/tax-certificates', expect: all(200) },
  {
    name: 'GET /tax-certificates?employeeId= (the employee)',
    method: 'get',
    path: (f) => `/tax-certificates?employeeId=${f.employee.employeeId}`,
    expect: OWN_OR_PAYROLL,
  },
  {
    name: 'GET /tax-certificates/:id/pdf',
    method: 'get',
    path: () => `/tax-certificates/${certificateId}/pdf`,
    expect: OWN_OR_PAYROLL,
  },
  {
    name: 'POST /admin/payslips/import (dry run)',
    method: 'post',
    path: '/admin/payslips/import',
    body: (f) => ({
      mode: 'DRY_RUN',
      format: 'json',
      rows: [
        {
          employeeCode: f.employee2.employeeCode,
          periodEndDate: periodEnd,
          lines: [{ category: 'EARNING', code: 'BASIC', description: 'Basic', amount: '1.00' }],
        },
      ],
    }),
    expect: only(['payrollAdmin'], 200),
  },
  {
    name: 'POST /admin/tax-certificates/import (dry run)',
    method: 'post',
    path: '/admin/tax-certificates/import',
    body: (f) => ({
      mode: 'DRY_RUN',
      format: 'json',
      rows: [
        {
          employeeCode: f.employee2.employeeCode,
          taxYear: 2026,
          figures: [{ code: '3601', description: 'Gross', amount: '1.00' }],
        },
      ],
    }),
    expect: only(['payrollAdmin'], 200),
  },
  { name: 'GET /dashboard/layout', method: 'get', path: '/dashboard/layout', expect: all(200) },
  {
    name: 'PUT /dashboard/layout (invalid)',
    method: 'put',
    path: '/dashboard/layout',
    body: () => ({ widgets: [{ id: 'WEATHER', visible: true }] }),
    expect: all(422),
  },
  { name: 'GET /dashboard/summary', method: 'get', path: '/dashboard/summary', expect: all(200) },
  { name: 'GET /birthdays/upcoming', method: 'get', path: '/birthdays/upcoming?days=30', expect: all(200) },
  { name: 'GET /reports', method: 'get', path: '/reports', expect: all(200) },
  {
    name: 'GET /reports/:code/employees (Employee Basic)',
    method: 'get',
    path: '/reports/EMPLOYEE_BASIC/employees',
    expect: only(['managerB', 'hrAdmin', 'payrollAdmin', 'auditor'], 200),
  },
  {
    name: 'POST /reports/LEAVE_DETAIL/run (the employee)',
    method: 'post',
    path: '/reports/LEAVE_DETAIL/run',
    body: (f) => ({ params: { employeeIds: [f.employee.employeeId] }, format: 'json' }),
    expect: only(['employee', 'managerB', 'hrAdmin', 'payrollAdmin', 'auditor'], 200),
  },
  {
    name: 'POST /reports/EMPLOYEE_BASIC/run',
    method: 'post',
    path: '/reports/EMPLOYEE_BASIC/run',
    body: () => ({ params: {}, format: 'json', pageSize: 5 }),
    expect: only(['managerB', 'hrAdmin', 'payrollAdmin', 'auditor'], 200),
  },
  {
    name: 'POST /reports/EMPLOYEE_PAY_PERIOD_BASIC/run (csv)',
    method: 'post',
    path: '/reports/EMPLOYEE_PAY_PERIOD_BASIC/run',
    body: (f) => ({ params: { employeeIds: [f.employee.employeeId] }, format: 'csv' }),
    expect: only(['hrAdmin', 'payrollAdmin', 'auditor'], 200),
  },
  {
    name: 'POST /reports/AUDIT_TRAIL_EXTRACT/run',
    method: 'post',
    path: '/reports/AUDIT_TRAIL_EXTRACT/run',
    body: () => ({ params: { from: todayBusinessDate(), actorUsername: 'nobody-matches' }, format: 'json' }),
    expect: only(['sysAdmin', 'auditor'], 200),
  },
  {
    name: 'POST /reports/:code/run (unknown report)',
    method: 'post',
    path: '/reports/NO_SUCH_REPORT/run',
    body: () => ({ params: {} }),
    expect: all(404),
  },
];

describe('authorisation matrix: Phase 7 endpoints', () => {
  let t: TestApp;
  let f: RoleFixtures;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    const kit = new PayrollKit(t, new WorkflowKit(t));
    [periodEnd = ''] = await kit.periods(f.org, 1);
    const payroll = await login(t, f.payrollAdmin);
    const { commit } = await kit.importPayslips(payroll, [kit.row(f.employee.employeeCode ?? '', periodEnd)]);
    payslipId = commit.rows[0]?.payslipId ?? 0;
    const certificates = await kit.importCertificates(payroll, [
      {
        employeeCode: f.employee.employeeCode ?? '',
        taxYear: 2026,
        figures: [{ code: '3601', description: 'Gross', amount: '1.00' }],
      },
    ]);
    certificateId = certificates.rows[0]?.certificateId ?? 0;
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
