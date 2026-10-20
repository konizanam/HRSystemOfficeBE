import { addDays, todayBusinessDate } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import { all, type MatrixCase, only, ROLE_KEYS, runAnonymous, runMatrixCell } from '../support/authz';
import { createRoleFixtures, type RoleFixtures } from '../support/fixtures';
import { TWO_STEP, WorkflowKit } from '../support/workflow';

/**
 * Authorisation matrix (section 16.2) for the Phase 3 endpoints: inbox, workflow actions,
 * notifications and out of office. The process under test was submitted by the employee and
 * waits at step 1 for manager B. Action cells send a stale version, so the one person allowed to
 * act gets 409 (proving they passed authorisation) and the process never changes.
 */
let processId = 0;
let payPeriodId = 0;
const STALE = 999;

const at = (suffix: string) => () => `/workflow/processes/${processId}/${suffix}`;

/** Readers of the process: the applicant, the approver, HR/Payroll in scope and the auditor. */
const READERS = only(['employee', 'managerB', 'hrAdmin', 'payrollAdmin', 'auditor'], 200);

const CASES: MatrixCase[] = [
  { name: 'GET /inbox/categories', method: 'get', path: '/inbox/categories', expect: all(200) },
  { name: 'GET /inbox/items (action)', method: 'get', path: '/inbox/items?box=action', expect: all(200) },
  {
    name: 'GET /inbox/items (submitted)',
    method: 'get',
    path: '/inbox/items?box=submitted',
    expect: all(200),
  },
  { name: 'GET /inbox/items (history)', method: 'get', path: '/inbox/items?box=history', expect: all(200) },
  {
    name: 'GET /inbox/items (process)',
    method: 'get',
    path: '/inbox/items?box=process',
    expect: only(['payrollAdmin'], 200),
  },
  {
    name: 'GET /inbox/items/:processId',
    method: 'get',
    path: () => `/inbox/items/${processId}`,
    expect: READERS,
  },
  {
    name: 'GET /inbox/items/:processId (missing)',
    method: 'get',
    path: '/inbox/items/999999999',
    expect: all(404),
  },
  {
    name: 'GET /workflow/processes/:id/history',
    method: 'get',
    path: () => `/workflow/processes/${processId}/history`,
    expect: READERS,
  },
  {
    name: 'POST /workflow/processes/:id/approve (stale version)',
    method: 'post',
    path: at('approve'),
    body: () => ({ version: STALE }),
    expect: { otherwise: 403, managerB: 409 },
  },
  {
    name: 'POST /workflow/processes/:id/decline (stale version)',
    method: 'post',
    path: at('decline'),
    body: () => ({ version: STALE, comment: 'No' }),
    expect: { otherwise: 403, managerB: 409 },
  },
  {
    name: 'POST /workflow/processes/:id/reassign (stale version)',
    method: 'post',
    path: at('reassign'),
    body: (f) => ({ version: STALE, toUserId: f.managerA.userId }),
    expect: { otherwise: 403, managerB: 409 },
  },
  {
    name: 'POST /workflow/processes/:id/park (stale version)',
    method: 'post',
    path: at('park'),
    body: () => ({ version: STALE, until: addDays(todayBusinessDate(), 2) }),
    expect: { otherwise: 403, managerB: 409 },
  },
  {
    name: 'POST /workflow/processes/:id/send-back (stale version)',
    method: 'post',
    path: at('send-back'),
    body: () => ({ version: STALE, comment: 'Fix it' }),
    expect: { otherwise: 403, managerB: 409 },
  },
  {
    name: 'POST /workflow/processes/:id/comment (stale version)',
    method: 'post',
    path: at('comment'),
    body: () => ({ version: STALE, comment: 'Note' }),
    expect: { otherwise: 403, managerB: 409, employee: 409 },
  },
  {
    name: 'POST /workflow/processes/:id/resubmit (stale version)',
    method: 'post',
    path: at('resubmit'),
    body: () => ({ version: STALE }),
    expect: { otherwise: 403, employee: 409 },
  },
  {
    name: 'POST /workflow/processes/:id/withdraw (stale version)',
    method: 'post',
    path: at('withdraw'),
    body: () => ({ version: STALE }),
    expect: { otherwise: 403, employee: 409 },
  },
  {
    name: 'POST /workflow/processes/bulk-approve (per-item results)',
    method: 'post',
    path: '/workflow/processes/bulk-approve',
    body: () => ({ items: [{ id: processId, version: STALE }] }),
    expect: all(200),
  },
  {
    name: 'POST /workflow/processes/process',
    method: 'post',
    path: '/workflow/processes/process',
    body: () => ({ ids: [processId], payPeriodId }),
    expect: only(['payrollAdmin'], 200),
  },
  {
    name: 'GET /workflow/can-start',
    method: 'get',
    path: '/workflow/can-start?type=CLAIMS',
    expect: all(200),
  },
  {
    name: 'GET /workflow/pay-periods',
    method: 'get',
    path: '/workflow/pay-periods',
    expect: only(['payrollAdmin'], 200),
  },
  { name: 'GET /workflow/user-options', method: 'get', path: '/workflow/user-options', expect: all(200) },
  { name: 'GET /notifications', method: 'get', path: '/notifications', expect: all(200) },
  { name: 'POST /notifications/read-all', method: 'post', path: '/notifications/read-all', expect: all(200) },
  {
    name: 'POST /notifications/:id/read (not the caller’s)',
    method: 'post',
    path: '/notifications/5f7c2b8e-3c1a-4c55-9d7e-0a1b2c3d4e5f/read',
    expect: all(404),
  },
  { name: 'GET /profile/out-of-office', method: 'get', path: '/profile/out-of-office', expect: all(200) },
  {
    name: 'PUT /profile/out-of-office',
    method: 'put',
    path: '/profile/out-of-office',
    body: () => ({ mode: 'OFF', mainNomineeUserId: null, rules: [], version: 0 }),
    expect: all(200),
  },
  {
    name: 'GET /profile/out-of-office/nominees',
    method: 'get',
    path: '/profile/out-of-office/nominees',
    expect: all(200),
  },
];

describe('authorisation matrix: Phase 3 endpoints', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    const claims = kit.useFakeHandler('CLAIMS');
    await kit.definition({ type: 'CLAIMS', companyRuleId: f.org.companyRuleId, steps: TWO_STEP });
    processId = (await kit.start(claims, f.employee)).id;
    payPeriodId = await kit.payPeriod(f.org);
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
