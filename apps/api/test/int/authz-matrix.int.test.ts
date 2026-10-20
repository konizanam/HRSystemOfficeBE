import { afterAll, beforeAll, describe, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import { all, type MatrixCase, only, ROLE_KEYS, runAnonymous, runMatrixCell } from '../support/authz';
import { createRoleFixtures, type RoleFixtures } from '../support/fixtures';

/**
 * Authorisation matrix skeleton (section 16.2) for the Phase 2 endpoints. Roles: employee (reports
 * to manager B), manager B, HR admin, payroll admin, system admin and auditor. "Working as"
 * targets cover self, a report, a non-report and another company. Later phases add their
 * endpoints to `CASES`.
 */
const CASES: MatrixCase[] = [
  { name: 'GET /session', method: 'get', path: '/session', expect: all(200) },
  { name: 'POST /session/activity', method: 'post', path: '/session/activity', expect: all(200) },
  {
    name: 'GET /session/acting-as/options',
    method: 'get',
    path: '/session/acting-as/options',
    expect: all(200),
  },
  {
    name: 'PUT /session/acting-as (self)',
    method: 'put',
    path: '/session/acting-as',
    body: (f, role) => ({ employeeId: f[role].employeeId }),
    expect: all(200),
  },
  {
    name: 'PUT /session/acting-as (report of manager B)',
    method: 'put',
    path: '/session/acting-as',
    body: (f) => ({ employeeId: f.employee.employeeId }),
    // For the employee fixture this target is themself.
    expect: { ...only(['managerB', 'hrAdmin'], 200), employee: 200 },
  },
  {
    name: 'PUT /session/acting-as (non-report, same company)',
    method: 'put',
    path: '/session/acting-as',
    body: (f) => ({ employeeId: f.unrelated.employeeId }),
    expect: only(['hrAdmin'], 200),
  },
  {
    name: 'PUT /session/acting-as (other company)',
    method: 'put',
    path: '/session/acting-as',
    body: (f) => ({ employeeId: f.otherCompany.employeeId }),
    expect: all(403),
  },
  { name: 'GET /admin/settings', method: 'get', path: '/admin/settings', expect: only(['sysAdmin'], 200) },
  {
    name: 'PUT /admin/settings (stale revision)',
    method: 'put',
    path: '/admin/settings',
    body: () => ({ values: {}, revision: 'stale-revision' }),
    expect: only(['sysAdmin'], 409),
  },
  { name: 'POST /profile/mobile/pairing', method: 'post', path: '/profile/mobile/pairing', expect: all(201) },
  { name: 'POST /auth/mfa/enroll', method: 'post', path: '/auth/mfa/enroll', expect: all(200) },
  {
    name: 'POST /auth/mfa/verify (wrong code)',
    method: 'post',
    path: '/auth/mfa/verify',
    body: () => ({ code: '000000' }),
    expect: all(422),
  },
  {
    name: 'POST /auth/password/change (wrong current password)',
    method: 'post',
    path: '/auth/password/change',
    body: () => ({ currentPassword: 'Not-The-Password-1', newPassword: 'Matrix-Password-1' }),
    expect: all(422),
  },
  { name: 'POST /auth/logout', method: 'post', path: '/auth/logout', expect: all(204) },
];

describe('authorisation matrix: Phase 2 endpoints', () => {
  let t: TestApp;
  let f: RoleFixtures;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
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
