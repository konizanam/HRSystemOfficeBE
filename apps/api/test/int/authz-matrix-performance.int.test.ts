import { afterAll, beforeAll, describe, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import { all, type MatrixCase, only, ROLE_KEYS, runAnonymous, runMatrixCell } from '../support/authz';
import { createRoleFixtures, login, type RoleFixtures } from '../support/fixtures';
import { PerformanceKit } from '../support/performance';

/**
 * Authorisation matrix (section 16.2) for the Phase 8 endpoints: parameter lookups and their admin
 * API, rating scales, templates, contract initiation, contracts, reviews, scores, results and
 * contract reviews. Writes are sent with a stale version, an invalid body or a missing id, so a
 * caller that passes authorisation gets 404/409/422 and nothing changes; a caller that does not
 * gets 403 (audited DENIED).
 */
let parameterId = 0;
let templateId = 0;
let initiationId = 0;
let contractId = 0;
let reviewId = 0;
const STALE = 999;
const MISSING = 999_999_999;

const HR = (status: number) => only(['hrAdmin'], status);
const HR_AND_AUDITOR = only(['hrAdmin', 'auditor'], 200);
/** Readers of the employee's contract and opened review: self, manager (and reviewer), HR, auditors. */
const EMPLOYEE_READERS = only(['employee', 'managerB', 'hrAdmin', 'auditor'], 200);

const CASES: MatrixCase[] = [
  {
    name: 'GET /lookups/parameters/:table',
    method: 'get',
    path: '/lookups/parameters/ReviewCategory',
    expect: all(200),
  },
  {
    name: 'GET /admin/parameters/:table',
    method: 'get',
    path: '/admin/parameters/KeyPerformanceArea',
    expect: HR(200),
  },
  {
    name: 'POST /admin/parameters/:table (invalid)',
    method: 'post',
    path: '/admin/parameters/KeyPerformanceArea',
    body: () => ({ code: '' }),
    expect: HR(422),
  },
  {
    name: 'PUT /admin/parameters/:table/:id (stale version)',
    method: 'put',
    path: () => `/admin/parameters/KeyPerformanceArea/${parameterId}`,
    body: () => ({ version: STALE, description: 'Matrix' }),
    expect: HR(409),
  },
  {
    name: 'DELETE /admin/parameters/:table/:id (stale version)',
    method: 'delete',
    path: () => `/admin/parameters/KeyPerformanceArea/${parameterId}`,
    body: () => ({ version: STALE }),
    expect: HR(409),
  },
  {
    name: 'GET /performance/rating-scales',
    method: 'get',
    path: '/performance/rating-scales',
    expect: all(200),
  },
  {
    name: 'GET /performance/templates',
    method: 'get',
    path: '/performance/templates',
    expect: HR_AND_AUDITOR,
  },
  {
    name: 'GET /performance/templates/:id',
    method: 'get',
    path: () => `/performance/templates/${templateId}`,
    expect: HR_AND_AUDITOR,
  },
  {
    name: 'POST /performance/templates (invalid)',
    method: 'post',
    path: '/performance/templates',
    body: () => ({ name: '' }),
    expect: HR(422),
  },
  {
    name: 'PUT /performance/templates/:id (stale version)',
    method: 'put',
    path: () => `/performance/templates/${templateId}`,
    body: () => ({ version: STALE }),
    expect: HR(409),
  },
  {
    name: 'POST /performance/templates/:id/copy (missing)',
    method: 'post',
    path: `/performance/templates/${MISSING}/copy`,
    body: () => ({}),
    expect: HR(404),
  },
  {
    name: 'GET /performance/contract-initiations',
    method: 'get',
    path: '/performance/contract-initiations',
    expect: HR_AND_AUDITOR,
  },
  {
    name: 'GET /performance/contract-initiations/:id',
    method: 'get',
    path: () => `/performance/contract-initiations/${initiationId}`,
    expect: HR_AND_AUDITOR,
  },
  {
    name: 'POST /performance/contract-initiations (unknown template)',
    method: 'post',
    path: '/performance/contract-initiations',
    body: (f) => ({ name: 'Matrix', templateId: MISSING, filters: { employeeIds: [f.employee.employeeId] } }),
    expect: HR(422),
  },
  { name: 'GET /performance/contracts', method: 'get', path: '/performance/contracts', expect: all(200) },
  {
    name: 'GET /performance/contracts?archived=true',
    method: 'get',
    path: '/performance/contracts?archived=true',
    expect: all(200),
  },
  {
    name: 'GET /performance/contracts/:id (the employee)',
    method: 'get',
    path: () => `/performance/contracts/${contractId}`,
    expect: EMPLOYEE_READERS,
  },
  {
    name: 'PUT /performance/contracts/:id (stale version)',
    method: 'put',
    path: () => `/performance/contracts/${contractId}`,
    body: () => ({ version: STALE }),
    expect: only(['employee', 'managerB', 'hrAdmin'], 409),
  },
  {
    name: 'POST /performance/contracts/:id/archive (stale version)',
    method: 'post',
    path: () => `/performance/contracts/${contractId}/archive`,
    body: () => ({ version: STALE }),
    expect: HR(409),
  },
  { name: 'GET /performance/reviews', method: 'get', path: '/performance/reviews', expect: all(200) },
  {
    name: 'GET /performance/reviews/:id (opened, the employee)',
    method: 'get',
    path: () => `/performance/reviews/${reviewId}`,
    expect: EMPLOYEE_READERS,
  },
  {
    name: 'POST /performance/reviews (invalid)',
    method: 'post',
    path: '/performance/reviews',
    body: () => ({ name: '' }),
    expect: HR(422),
  },
  {
    name: 'PUT /performance/reviews/:id (stale version)',
    method: 'put',
    path: () => `/performance/reviews/${reviewId}`,
    body: () => ({ version: STALE }),
    expect: HR(409),
  },
  {
    name: 'POST /performance/reviews/:id/copy (missing)',
    method: 'post',
    path: `/performance/reviews/${MISSING}/copy`,
    body: () => ({}),
    expect: HR(404),
  },
  {
    name: 'POST /performance/reviews/:id/status (stale version)',
    method: 'post',
    path: () => `/performance/reviews/${reviewId}/status`,
    body: () => ({ status: 'SELF_ASSESSMENT', version: STALE }),
    expect: HR(409),
  },
  {
    name: 'POST /performance/reviews/:id/scores (not a scoring step)',
    method: 'post',
    path: () => `/performance/reviews/${reviewId}/scores`,
    body: () => ({ scores: [{ objectiveId: 1, rating: '3' }] }),
    expect: only(['employee', 'managerB'], 422),
  },
  { name: 'GET /performance/results', method: 'get', path: '/performance/results', expect: all(200) },
  {
    name: 'GET /performance/contract-reviews',
    method: 'get',
    path: '/performance/contract-reviews?statuses=OPEN&reviewName=Matrix',
    expect: all(200),
  },
];

describe('authorisation matrix: Phase 8 endpoints', () => {
  let t: TestApp;
  let f: RoleFixtures;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    const kit = new PerformanceKit(t);
    await kit.setup();
    parameterId = await kit.param('KeyPerformanceArea', 'FINANCIAL');
    const hr = await login(t, f.hrAdmin);
    const template = await kit.template(hr);
    templateId = template.id;
    initiationId = (await kit.initiate(hr, templateId, [f.employee.employeeId ?? 0])).id;
    contractId = (await kit.contractOf(f.employee.employeeId ?? 0, templateId)).id;
    const review = await kit.sharedReview(
      hr,
      templateId,
      f.employee.employeeId ?? 0,
      [f.managerB.employeeId ?? 0],
      {
        name: 'Matrix review',
      },
    );
    reviewId = review.id;
    await kit.move(hr, reviewId, 'OPEN');
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
