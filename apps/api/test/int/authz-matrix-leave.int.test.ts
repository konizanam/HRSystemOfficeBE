import { addDays, isoWeekday, todayBusinessDate } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import { all, type MatrixCase, only, ROLE_KEYS, runAnonymous, runMatrixCell } from '../support/authz';
import { createRoleFixtures, login, type RoleFixtures } from '../support/fixtures';
import { LEAVE_TYPE, LeaveKit } from '../support/leave';
import { WorkflowKit } from '../support/workflow';

/**
 * Authorisation matrix (section 16.2) for the Phase 4 endpoints: leave, leave in lieu, balances,
 * the calendar, holidays, attachments and the leave admin API. Writes are sent with a stale
 * version or an invalid body, so a caller that passes authorisation gets 409/422 and nothing
 * changes; a caller that does not gets 403 (audited DENIED).
 */
let applicationId = 0;
let applicationVersion = 0;
let attachmentId = '';
let reasonId = 0;
let policyId = 0;
let monday = '';
let saturday = '';
const STALE = 999;

/** Readers of the employee's leave: self, manager, HR/Payroll in scope, auditors (not system admins). */
const LEAVE_READERS = only(['employee', 'managerB', 'hrAdmin', 'payrollAdmin', 'auditor'], 200);
/** The "Working as" rule for the employee: self, their manager, HR. */
const ACT_FOR = (status: number) => only(['employee', 'managerB', 'hrAdmin'], status);
const HR = (status: number) => only(['hrAdmin'], status);

const CASES: MatrixCase[] = [
  { name: 'GET /leave/types', method: 'get', path: '/leave/types', expect: all(200) },
  {
    name: 'GET /leave/types?employeeId= (the employee)',
    method: 'get',
    path: (f) => `/leave/types?employeeId=${f.employee.employeeId}`,
    expect: ACT_FOR(200),
  },
  { name: 'GET /leave/types/:id/reasons', method: 'get', path: '/leave/types/2/reasons', expect: all(200) },
  { name: 'GET /leave/balances', method: 'get', path: '/leave/balances', expect: all(200) },
  {
    name: 'GET /leave/balances?employeeId= (the employee)',
    method: 'get',
    path: (f) => `/leave/balances?employeeId=${f.employee.employeeId}`,
    expect: LEAVE_READERS,
  },
  {
    name: 'GET /leave/balances/:leaveTypeId/definitions',
    method: 'get',
    path: '/leave/balances/1/definitions',
    expect: all(200),
  },
  {
    name: 'GET /leave/balances/:leaveTypeId/definitions (the employee)',
    method: 'get',
    path: (f) => `/leave/balances/1/definitions?employeeId=${f.employee.employeeId}`,
    expect: LEAVE_READERS,
  },
  {
    name: 'POST /leave/calculate (self)',
    method: 'post',
    path: '/leave/calculate',
    body: () => ({ leaveTypeId: LEAVE_TYPE.annual, fromDate: monday, toDate: addDays(monday, 2) }),
    expect: all(200),
  },
  {
    name: 'POST /leave/calculate (the employee)',
    method: 'post',
    path: '/leave/calculate',
    body: (f) => ({ employeeId: f.employee.employeeId, leaveTypeId: 1, fromDate: monday, toDate: monday }),
    expect: ACT_FOR(200),
  },
  {
    name: 'POST /leave/applications (for the employee, weekend only)',
    method: 'post',
    path: '/leave/applications',
    body: (f) => ({
      employeeId: f.employee.employeeId,
      leaveTypeId: 1,
      fromDate: saturday,
      toDate: addDays(saturday, 1),
    }),
    expect: ACT_FOR(422),
  },
  {
    name: 'GET /leave/applications',
    method: 'get',
    path: '/leave/applications?status=completed',
    expect: all(200),
  },
  {
    name: 'GET /leave/applications?employeeId= (the employee)',
    method: 'get',
    path: (f) => `/leave/applications?employeeId=${f.employee.employeeId}`,
    expect: LEAVE_READERS,
  },
  {
    name: 'GET /leave/applications/:id',
    method: 'get',
    path: () => `/leave/applications/${applicationId}`,
    expect: LEAVE_READERS,
  },
  {
    name: 'GET /leave/applications/:id (missing)',
    method: 'get',
    path: '/leave/applications/999999999',
    expect: all(404),
  },
  {
    name: 'POST /leave/applications/:id/cancel (stale version)',
    method: 'post',
    path: () => `/leave/applications/${applicationId}/cancel`,
    body: () => ({ version: applicationVersion + STALE }),
    expect: ACT_FOR(409),
  },
  {
    name: 'POST /leave/in-lieu (request, future dates)',
    method: 'post',
    path: '/leave/in-lieu',
    body: () => ({
      kind: 'REQUEST',
      workedFrom: addDays(monday, 7),
      workedTo: addDays(monday, 7),
      units: '1',
      reason: 'Matrix',
    }),
    expect: all(422),
  },
  {
    name: 'POST /leave/in-lieu (allocation to the employee, future dates)',
    method: 'post',
    path: '/leave/in-lieu',
    body: (f) => ({
      kind: 'ALLOCATION',
      employeeId: f.employee.employeeId,
      workedFrom: addDays(monday, 7),
      workedTo: addDays(monday, 7),
      units: '1',
      reason: 'Matrix',
    }),
    expect: only(['managerB', 'hrAdmin'], 422),
  },
  { name: 'GET /leave/in-lieu', method: 'get', path: '/leave/in-lieu', expect: all(200) },
  {
    name: 'GET /leave/team/on-leave-today',
    method: 'get',
    path: '/leave/team/on-leave-today',
    expect: only(['managerB'], 200),
  },
  {
    name: 'GET /calendar/leave (self)',
    method: 'get',
    path: () => `/calendar/leave?from=${monday}&to=${addDays(monday, 34)}`,
    expect: all(200),
  },
  {
    name: 'GET /calendar/leave (reports)',
    method: 'get',
    path: () => `/calendar/leave?from=${monday}&to=${addDays(monday, 34)}&scope=reports`,
    expect: only(['managerB'], 200),
  },
  {
    name: 'GET /calendar/leave/export',
    method: 'get',
    path: () => `/calendar/leave/export?from=${monday}&to=${addDays(monday, 6)}&format=csv`,
    expect: all(200),
  },
  {
    name: 'GET /calendar/leave/export (reports)',
    method: 'get',
    path: () => `/calendar/leave/export?from=${monday}&to=${addDays(monday, 6)}&scope=reports`,
    expect: only(['managerB'], 200),
  },
  { name: 'GET /holidays', method: 'get', path: '/holidays?from=2026-01-01&to=2026-12-31', expect: all(200) },
  {
    name: 'POST /attachments (not multipart)',
    method: 'post',
    path: '/attachments',
    body: () => ({ file: 'x' }),
    expect: all(415),
  },
  {
    name: 'GET /attachments/:id (bound to the employee’s leave)',
    method: 'get',
    path: () => `/attachments/${attachmentId}`,
    expect: LEAVE_READERS,
  },
  {
    name: 'DELETE /attachments/:id (already submitted)',
    method: 'delete',
    path: () => `/attachments/${attachmentId}`,
    expect: all(403),
  },
  {
    name: 'POST /admin/leave/adjustments (zero units)',
    method: 'post',
    path: '/admin/leave/adjustments',
    body: (f) => ({ employeeId: f.employee.employeeId, leaveTypeId: 1, units: '0', reason: 'Matrix' }),
    expect: HR(422),
  },
  {
    name: 'POST /admin/leave/opening-balances/import (bad header)',
    method: 'post',
    path: '/admin/leave/opening-balances/import',
    body: () => ({ csv: 'a,b\n1,2', mode: 'DRY_RUN' }),
    expect: HR(422),
  },
  { name: 'GET /admin/leave-types', method: 'get', path: '/admin/leave-types', expect: HR(200) },
  { name: 'GET /admin/leave-types/:id', method: 'get', path: '/admin/leave-types/1', expect: HR(200) },
  {
    name: 'POST /admin/leave-types (invalid)',
    method: 'post',
    path: '/admin/leave-types',
    body: () => ({ code: 'lower case' }),
    expect: HR(422),
  },
  {
    name: 'PUT /admin/leave-types/:id (stale version)',
    method: 'put',
    path: '/admin/leave-types/1',
    body: () => ({ version: STALE, description: 'Annual Leave' }),
    expect: HR(409),
  },
  {
    name: 'DELETE /admin/leave-types/:id (stale version)',
    method: 'delete',
    path: '/admin/leave-types/1',
    body: () => ({ version: STALE }),
    expect: HR(409),
  },
  {
    name: 'GET /admin/leave-reasons',
    method: 'get',
    path: '/admin/leave-reasons?leaveTypeId=2',
    expect: HR(200),
  },
  {
    name: 'POST /admin/leave-reasons (invalid)',
    method: 'post',
    path: '/admin/leave-reasons',
    body: () => ({ leaveTypeId: 1 }),
    expect: HR(422),
  },
  {
    name: 'PUT /admin/leave-reasons/:id (stale version)',
    method: 'put',
    path: () => `/admin/leave-reasons/${reasonId}`,
    body: () => ({ version: STALE }),
    expect: HR(409),
  },
  {
    name: 'DELETE /admin/leave-reasons/:id (stale version)',
    method: 'delete',
    path: () => `/admin/leave-reasons/${reasonId}`,
    body: () => ({ version: STALE }),
    expect: HR(409),
  },
  { name: 'GET /admin/leave-policies', method: 'get', path: '/admin/leave-policies', expect: HR(200) },
  {
    name: 'POST /admin/leave-policies (invalid)',
    method: 'post',
    path: '/admin/leave-policies',
    body: () => ({ leaveTypeId: 1 }),
    expect: HR(422),
  },
  {
    name: 'PUT /admin/leave-policies/:id (stale version)',
    method: 'put',
    path: () => `/admin/leave-policies/${policyId}`,
    body: () => ({ version: STALE }),
    expect: HR(409),
  },
  {
    name: 'DELETE /admin/leave-policies/:id (stale version)',
    method: 'delete',
    path: () => `/admin/leave-policies/${policyId}`,
    body: () => ({ version: STALE }),
    expect: HR(409),
  },
];

describe('authorisation matrix: Phase 4 endpoints', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    const leave = new LeaveKit(t, kit);
    await leave.setup(f.org);
    await leave.accrue([f.employee.employeeId]);
    monday = await leave.monday(21, f.org.companyId);
    saturday = addDays(todayBusinessDate(), 14);
    while (isoWeekday(saturday) !== 6) saturday = addDays(saturday, 1);
    const emp = await login(t, f.employee);
    attachmentId = await leave.upload(emp, 'matrix.pdf');
    const range = await leave.range(addDays(monday, 14), 3, f.org.companyId);
    const sickReason = await t.db.prisma.leaveReason.findUniqueOrThrow({
      where: { leaveTypeId_code: { leaveTypeId: LEAVE_TYPE.sick, code: 'ILLNESS' } },
    });
    const app = await leave.submit(emp, {
      leaveTypeId: LEAVE_TYPE.sick,
      ...range,
      leaveReasonId: sickReason.id,
      attachmentIds: [attachmentId],
    });
    applicationId = app.id;
    applicationVersion = app.version;
    reasonId = sickReason.id;
    policyId = (
      await t.db.prisma.leavePolicy.findFirstOrThrow({ where: { leaveTypeId: 1, companyRuleId: null } })
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
