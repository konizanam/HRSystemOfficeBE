import type { ContractReviewsResponse, ReviewDetail, ReviewsResponse } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  createPerson,
  createRoleFixtures,
  login,
  nextUnique,
  type Person,
  type RoleFixtures,
} from '../support/fixtures';
import { PerformanceKit } from '../support/performance';

const sys = systemContext('test-contract-reviews');

/**
 * GET /performance/contract-reviews: every filter of the Filter Selection modal, the grid fields
 * and the read scope (employee, reviewer, manager, HR, auditor). Each review name carries a token
 * unique to this run, so other data in the shared database never matches.
 */
describe('performance: contract reviews filters and scoping', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: PerformanceKit;
  let globalHr: Person;
  let hrAll: Agent;
  let token: string;
  let rule2: number;
  const ids: Record<'r1' | 'r2' | 'r3' | 'r4', number> = { r1: 0, r2: 0, r3: 0, r4: 0 };
  let r1: ReviewDetail;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new PerformanceKit(t);
    await kit.setup();
    token = `CRF${await nextUnique(t.db)}`;
    // An HR admin without an employee record administers every company (B14).
    globalHr = await createPerson(t.db, {
      org: f.org,
      roles: ['HR_ADMIN'],
      withEmployee: false,
      label: 'hr-global',
    });
    hrAll = await login(t, globalHr);
    rule2 = await t.db.tx(sys, async (tx) => {
      const rule = await tx.companyRule.create({
        data: { companyId: f.org.companyId, code: `R${token}`, description: 'Contractors' },
      });
      await tx.employee.update({ where: { id: f.employee.employeeId ?? 0 }, data: { jobTitle: 'Clerk' } });
      await tx.employee.update({
        where: { id: f.employee2.employeeId ?? 0 },
        data: { jobTitle: 'Analyst', companyRuleId: rule.id },
      });
      await tx.employee.update({
        where: { id: f.unrelated.employeeId ?? 0 },
        data: { jobTitle: 'Supervisor' },
      });
      await tx.employee.update({
        where: { id: f.otherCompany.employeeId ?? 0 },
        data: { jobTitle: 'Clerk' },
      });
      return rule.id;
    });
    const template = await kit.template(hrAll);
    await kit.initiate(hrAll, template.id, [f.employee.employeeId ?? 0]);
    const reviewer = [f.managerB.employeeId ?? 0];

    // R1: employee, ANNUAL / MANAGER, Jan–Jun 2026, OPEN, on their contract.
    r1 = await kit.sharedReview(hrAll, template.id, f.employee.employeeId ?? 0, reviewer, {
      name: `${token} Alpha`,
      cycleStartDate: '2026-01-01',
      cycleEndDate: '2026-06-30',
    });
    ids.r1 = r1.id;
    await kit.move(hrAll, ids.r1, 'OPEN');
    // R2: employee2 (company rule 2, Analyst), PROBATION / SELF, Mar–Sep 2026, DRAFT.
    ids.r2 = (
      await kit.freeReview(hrAll, f.employee2.employeeId ?? 0, reviewer, {
        name: `${token} Beta`,
        category: 'PROBATION',
        type: 'SELF',
        cycleStartDate: '2026-03-01',
        cycleEndDate: '2026-09-30',
      })
    ).id;
    // R3: the other company's employee, MIDYEAR / 360, Jul–Dec 2026, CANCELLED.
    ids.r3 = (
      await kit.freeReview(hrAll, f.otherCompany.employeeId ?? 0, reviewer, {
        name: `${token} Gamma`,
        category: 'MIDYEAR',
        type: '360',
        cycleStartDate: '2026-07-01',
        cycleEndDate: '2026-12-31',
      })
    ).id;
    await kit.move(hrAll, ids.r3, 'CANCELLED');
    // R4: the unrelated colleague, ANNUAL / 360, 2025, SELF_ASSESSMENT.
    ids.r4 = (
      await kit.freeReview(hrAll, f.unrelated.employeeId ?? 0, reviewer, {
        name: `${token} Delta`,
        category: 'ANNUAL',
        type: '360',
        cycleStartDate: '2025-01-01',
        cycleEndDate: '2025-12-31',
      })
    ).id;
    await kit.moveAll(hrAll, ids.r4, ['OPEN', 'SELF_ASSESSMENT']);
  });

  afterAll(async () => {
    await t.close();
  });

  async function found(agent: Agent, query: string): Promise<string[]> {
    const res = await agent.get(
      `/performance/contract-reviews?reviewName=${token}${query ? `&${query}` : ''}`,
    );
    expect(res.status, res.text).toBe(200);
    const byId = new Map(Object.entries(ids).map(([k, v]) => [v, k]));
    return (res.body as ContractReviewsResponse).items
      .map((i) => byId.get(i.reviewId) ?? `?${i.reviewId}`)
      .sort();
  }

  it('filters by review name', async () => {
    expect(await found(hrAll, '')).toEqual(['r1', 'r2', 'r3', 'r4']);
    const res = await hrAll.get(
      `/performance/contract-reviews?reviewName=${encodeURIComponent(`${token} beta`)}`,
    );
    expect((res.body as ContractReviewsResponse).items.map((i) => i.reviewId)).toEqual([ids.r2]);
  });

  it('filters by companies', async () => {
    expect(await found(hrAll, `companies=${f.org.companyId}`)).toEqual(['r1', 'r2', 'r4']);
    expect(await found(hrAll, `companies=${f.otherOrg.companyId}`)).toEqual(['r3']);
    expect(await found(hrAll, `companies=${f.org.companyId},${f.otherOrg.companyId}`)).toEqual([
      'r1',
      'r2',
      'r3',
      'r4',
    ]);
  });

  it('filters by company rules (comma list or repeated)', async () => {
    expect(await found(hrAll, `companyRules=${rule2}`)).toEqual(['r2']);
    expect(await found(hrAll, `companyRules=${f.org.companyRuleId}&companyRules=${rule2}`)).toEqual([
      'r1',
      'r2',
      'r4',
    ]);
  });

  it('filters by employees', async () => {
    expect(await found(hrAll, `employees=${f.employee.employeeId},${f.employee2.employeeId}`)).toEqual([
      'r1',
      'r2',
    ]);
  });

  it('filters by positions', async () => {
    expect(await found(hrAll, 'positions=Clerk')).toEqual(['r1', 'r3']);
    expect(await found(hrAll, 'positions=Analyst,Supervisor')).toEqual(['r2', 'r4']);
  });

  it('filters by review types and review categories', async () => {
    expect(await found(hrAll, 'reviewTypes=360')).toEqual(['r3', 'r4']);
    expect(await found(hrAll, 'reviewTypes=MANAGER,SELF')).toEqual(['r1', 'r2']);
    expect(await found(hrAll, 'reviewCategories=ANNUAL')).toEqual(['r1', 'r4']);
    expect(await found(hrAll, 'reviewCategories=PROBATION&reviewCategories=MIDYEAR')).toEqual(['r2', 'r3']);
  });

  it('filters by review statuses', async () => {
    expect(await found(hrAll, 'statuses=OPEN,CANCELLED')).toEqual(['r1', 'r3']);
    expect(await found(hrAll, 'statuses=DRAFT')).toEqual(['r2']);
    expect((await hrAll.get('/performance/contract-reviews?statuses=NOPE')).status).toBe(422);
  });

  it('filters by start and end date ranges', async () => {
    expect(await found(hrAll, 'startFrom=2026-02-01&startTo=2026-07-01')).toEqual(['r2', 'r3']);
    expect(await found(hrAll, 'startFrom=2026-01-01')).toEqual(['r1', 'r2', 'r3']);
    expect(await found(hrAll, 'startTo=2025-12-31')).toEqual(['r4']);
    expect(await found(hrAll, 'endFrom=2026-07-01&endTo=2026-12-31')).toEqual(['r2', 'r3']);
    expect(await found(hrAll, 'endTo=2026-06-30')).toEqual(['r1', 'r4']);
    expect(
      (await hrAll.get('/performance/contract-reviews?startFrom=2026-02-01&startTo=2026-01-01')).status,
    ).toBe(422);
  });

  it('combines filters', async () => {
    expect(
      await found(hrAll, `companies=${f.org.companyId}&reviewCategories=ANNUAL&statuses=SELF_ASSESSMENT`),
    ).toEqual(['r4']);
    expect(await found(hrAll, `positions=Clerk&companies=${f.otherOrg.companyId}&reviewTypes=360`)).toEqual([
      'r3',
    ]);
  });

  it('returns the grid fields', async () => {
    const res = await hrAll.get(
      `/performance/contract-reviews?reviewName=${token}&employees=${f.employee.employeeId}`,
    );
    const [row] = (res.body as ContractReviewsResponse).items;
    expect(row).toMatchObject({
      reviewId: ids.r1,
      contractId: r1.contractId,
      employeeId: f.employee.employeeId,
      employeeCompanyRule: 'Staff',
      employeePosition: 'Clerk',
      contractName: r1.contractName,
      reviewName: `${token} Alpha`,
      reviewCategory: 'Annual Review',
      reviewCategoryCode: 'ANNUAL',
      reviewType: 'Manager Review',
      reviewTypeCode: 'MANAGER',
      reviewCycleStartDate: '2026-01-01',
      reviewCycleEndDate: '2026-06-30',
      reviewStatus: 'OPEN',
      reviewTotalActual: null,
    });
    expect(row?.employeeName).toMatch(/^First\d+$/);
    expect(row?.employeeSurname).toMatch(/^Last\d+$/);
    expect(row?.employeeCompany).toMatch(/^Fixture Company /);
    expect(row?.contractName).not.toBeNull();
  });

  it('scopes reads: own opened reviews, participations, reports, HR companies, auditors', async () => {
    const as = async (p: Person) => found(await login(t, p), '');
    expect(await as(f.employee)).toEqual(['r1']);
    // R2 is still a draft: the reviewee does not see it yet.
    expect(await as(f.employee2)).toEqual([]);
    // Manager B reviews every one; R2 is a draft and R3 is cancelled.
    expect(await as(f.managerB)).toEqual(['r1', 'r4']);
    expect(await as(f.unrelated)).toEqual(['r4']);
    expect(await as(f.otherCompany)).toEqual([]);
    expect(await as(f.hrAdmin)).toEqual(['r1', 'r2', 'r4']);
    expect(await as(f.auditor)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(await as(f.sysAdmin)).toEqual([]);
    expect(await as(f.payrollAdmin)).toEqual([]);

    // The same scope applies to Edit Review and to the detail.
    const emp = await login(t, f.employee);
    const list = (await emp.get(`/performance/reviews?search=${token}`)).body as ReviewsResponse;
    expect(list.items.map((r) => r.id)).toEqual([ids.r1]);
    expect((await emp.get(`/performance/reviews/${ids.r4}`)).status).toBe(403);
    expect((await (await login(t, f.hrAdmin)).get(`/performance/reviews/${ids.r3}`)).status).toBe(403);
    expect((await (await login(t, f.auditor)).get(`/performance/reviews/${ids.r3}`)).status).toBe(200);
    // Results only list scored reviews.
    const results = (await hrAll.get(`/performance/results?search=${token}`)).body as ReviewsResponse;
    expect(results.items).toEqual([]);
  });

  it('lists Edit Review with filters and sort', async () => {
    const res = await hrAll.get(
      `/performance/reviews?search=${token}&statuses=OPEN,SELF_ASSESSMENT&sort=name:asc`,
    );
    expect((res.body as ReviewsResponse).items.map((r) => r.id)).toEqual([ids.r1, ids.r4]);
    const byCategory = await hrAll.get(
      `/performance/reviews?search=${token}&categories=PROBATION&types=SELF`,
    );
    expect((byCategory.body as ReviewsResponse).items.map((r) => r.id)).toEqual([ids.r2]);
    const byEmployee = await hrAll.get(
      `/performance/reviews?search=${token}&employeeId=${f.unrelated.employeeId}`,
    );
    expect((byEmployee.body as ReviewsResponse).items.map((r) => r.id)).toEqual([ids.r4]);
  });
});
