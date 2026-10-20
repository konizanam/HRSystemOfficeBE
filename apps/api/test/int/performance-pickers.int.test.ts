import {
  type CompaniesResponse,
  type CompanyRulesResponse,
  type ContractInitiationRow,
  type EmployeePickerResponse,
  type InitiationsResponse,
  type PerformanceContract,
  type PositionsResponse,
  type ReviewsResponse,
} from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  auditSince,
  createPerson,
  createRoleFixtures,
  lastAuditId,
  login,
  nextUnique,
  type RoleFixtures,
} from '../support/fixtures';
import { bufferParser } from '../support/payroll';
import { PerformanceKit } from '../support/performance';

const sys = systemContext('test-pickers');

/**
 * Gap fixes for the performance screens: the scoped pickers (employees, companies, company rules,
 * positions), canEdit / allowedStatuses on review rows, canChangeAssignee on contracts, the wider
 * grid sorts and the audited CSV / Excel grid exports.
 */
describe('scoped pickers and performance grids', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: PerformanceKit;
  let hr: Agent;
  let mgr: Agent;
  let emp: Agent;
  let auditor: Agent;
  let position = '';

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new PerformanceKit(t);
    await kit.setup();
    [hr, mgr, emp, auditor] = await Promise.all([
      login(t, f.hrAdmin),
      login(t, f.managerB),
      login(t, f.employee),
      login(t, f.auditor),
    ]);
    position = `Picker Analyst ${await nextUnique(t.db)}`;
    await t.db.tx(sys, async (tx) => {
      await tx.employee.update({ where: { id: f.employee.employeeId ?? 0 }, data: { jobTitle: position } });
      await tx.employee.update({ where: { id: f.employee2.employeeId ?? 0 }, data: { jobTitle: position } });
    });
  });

  afterAll(async () => {
    await t.close();
  });

  const employees = async (agent: Agent, query = ''): Promise<EmployeePickerResponse> => {
    const res = await agent.get(`/lookups/employees?pageSize=100${query}`);
    expect(res.status, res.text).toBe(200);
    return res.body as EmployeePickerResponse;
  };
  const filtered = (query: string) => `&companyId=${f.org.companyId}${query}`;

  describe('pickers', () => {
    it('scopes employees to self, reports, company or everyone', async () => {
      expect((await employees(emp)).items.map((r) => r.id)).toEqual([f.employee.employeeId]);

      const team = (await employees(mgr)).items.map((r) => r.id);
      expect(team).toEqual(
        expect.arrayContaining([f.managerB.employeeId, f.employee.employeeId, f.employee2.employeeId]),
      );
      expect(team).not.toContain(f.unrelated.employeeId);

      const company = await employees(hr, filtered(''));
      const companyIds = company.items.map((r) => r.id);
      expect(companyIds).toEqual(expect.arrayContaining([f.unrelated.employeeId, f.hrAdmin.employeeId]));
      expect((await employees(hr, `&companyId=${f.otherOrg.companyId}`)).total).toBe(0);
      expect(company.items.find((r) => r.id === f.employee.employeeId)).toMatchObject({
        employeeCode: f.employee.employeeCode,
        name: expect.stringMatching(/^First\d+ Last\d+$/),
        companyId: f.org.companyId,
        companyRuleId: f.org.companyRuleId,
        jobTitle: position,
        status: 'ACTIVE',
        hasUser: true,
      });

      const everyone = await employees(auditor, `&companyId=${f.otherOrg.companyId}`);
      expect(everyone.items.map((r) => r.id)).toContain(f.otherCompany.employeeId);
    });

    it('filters by status, user account, company rule and search, paginated without a cap', async () => {
      const leaver = await createPerson(t.db, {
        org: f.org,
        label: 'leaver',
        employee: { status: 'TERMINATED' },
      });
      const n = await nextUnique(t.db);
      const noUser = await t.db.tx(sys, (tx) =>
        tx.employee.create({
          data: {
            entityCode: String(700_000 + n),
            employeeCode: `P${700_000 + n}`,
            companyId: f.org.companyId,
            companyRuleId: f.org.companyRuleId,
            firstName: `NoUser${n}`,
            lastName: `Picker${n}`,
          },
        }),
      );
      const terminated = await employees(hr, filtered('&status=TERMINATED'));
      expect(terminated.items.map((r) => r.id)).toEqual([leaver.employeeId]);
      const withoutUser = await employees(hr, filtered('&hasUser=false'));
      expect(withoutUser.items.map((r) => r.id)).toEqual([noUser.id]);
      expect(withoutUser.items[0]?.hasUser).toBe(false);
      expect((await employees(hr, filtered('&hasUser=true'))).items.map((r) => r.id)).not.toContain(
        noUser.id,
      );
      const searched = await employees(hr, `&search=${noUser.employeeCode.toLowerCase()}`);
      expect(searched.items.map((r) => r.id)).toEqual([noUser.id]);
      expect((await employees(hr, filtered(`&companyRuleId=${f.org.companyRuleId}`))).total).toBeGreaterThan(
        8,
      );

      const all = await employees(hr, filtered(''));
      const page = (await hr.get(`/lookups/employees?pageSize=2&page=2${filtered('')}`).expect(200))
        .body as EmployeePickerResponse;
      expect(page).toMatchObject({ total: all.total, page: 2, pageSize: 2 });
      expect(page.items.map((r) => r.id)).toEqual(all.items.slice(2, 4).map((r) => r.id));
      await hr.get('/lookups/employees?pageSize=101').expect(422);
    });

    it('lists the companies, company rules and positions in scope', async () => {
      const mine = (await hr.get('/lookups/companies').expect(200)).body as CompaniesResponse;
      expect(mine.items.map((c) => c.id)).toContain(f.org.companyId);
      expect(mine.items.map((c) => c.id)).not.toContain(f.otherOrg.companyId);
      const all = (await auditor.get('/lookups/companies').expect(200)).body as CompaniesResponse;
      expect(all.items.map((c) => c.id)).toEqual(
        expect.arrayContaining([f.org.companyId, f.otherOrg.companyId]),
      );
      const own = (await emp.get('/lookups/companies').expect(200)).body as CompaniesResponse;
      expect(own.items.map((c) => c.id)).toEqual([f.org.companyId]);

      const rules = (await hr.get(`/lookups/company-rules?companyId=${f.org.companyId}`).expect(200))
        .body as CompanyRulesResponse;
      expect(rules.items.map((r) => r.id)).toContain(f.org.companyRuleId);
      expect(rules.items.every((r) => r.companyId === f.org.companyId)).toBe(true);
      const foreign = (await hr.get(`/lookups/company-rules?companyId=${f.otherOrg.companyId}`).expect(200))
        .body as CompanyRulesResponse;
      expect(foreign.items).toEqual([]);

      const positions = (
        await hr.get(`/lookups/positions?search=${encodeURIComponent(position)}`).expect(200)
      ).body as PositionsResponse;
      expect(positions.items).toEqual([{ jobTitle: position, employeeCount: 2 }]);
      const own2 = (await emp.get(`/lookups/positions?search=${encodeURIComponent(position)}`).expect(200))
        .body as PositionsResponse;
      expect(own2.items).toEqual([{ jobTitle: position, employeeCount: 1 }]);
    });
  });

  describe('performance', () => {
    it('gives review rows canEdit and allowedStatuses for the caller', async () => {
      const template = await kit.template(hr);
      await kit.initiate(hr, template.id, [f.employee.employeeId ?? 0]);
      const review = await kit.sharedReview(hr, template.id, f.employee.employeeId ?? 0, [
        f.managerB.employeeId ?? 0,
      ]);
      const rowFor = async (agent: Agent) => {
        const res = await agent.get(`/performance/reviews?search=${encodeURIComponent(review.name)}`);
        expect(res.status, res.text).toBe(200);
        return (res.body as ReviewsResponse).items.find((r) => r.id === review.id);
      };
      expect(await rowFor(hr)).toMatchObject({ canEdit: true, allowedStatuses: ['OPEN', 'CANCELLED'] });
      await kit.move(hr, review.id, 'OPEN');
      const hrOpen = await rowFor(hr);
      const detail = (await hr.get(`/performance/reviews/${review.id}`).expect(200)).body as {
        canEdit: boolean;
        allowedStatuses: string[];
      };
      expect(hrOpen).toMatchObject({ canEdit: detail.canEdit, allowedStatuses: detail.allowedStatuses });
      const own = await rowFor(emp);
      const ownDetail = (await emp.get(`/performance/reviews/${review.id}`).expect(200)).body as {
        allowedStatuses: string[];
      };
      expect(own).toMatchObject({ canEdit: false, allowedStatuses: ownDetail.allowedStatuses });
    });

    it('says who may change a contract assignee', async () => {
      const template = await kit.template(hr);
      await kit.initiate(hr, template.id, [f.employee2.employeeId ?? 0]);
      const contract = await kit.contractOf(f.employee2.employeeId ?? 0, template.id);
      const get = async (agent: Agent) =>
        ((await agent.get(`/performance/contracts/${contract.id}`).expect(200)).body as PerformanceContract)
          .canChangeAssignee;
      expect(await get(hr)).toBe(true);
      expect(await get(mgr)).toBe(true);
      expect(await get(await login(t, f.employee2))).toBe(false);
      await t.db.tx(sys, (tx) =>
        tx.performanceContract.update({ where: { id: contract.id }, data: { status: 'ARCHIVED' } }),
      );
      expect(await get(hr)).toBe(false);
    });

    it('sorts initiations and the wider grid columns', async () => {
      const template = await kit.template(hr);
      const a = await kit.initiate(
        hr,
        template.id,
        [f.unrelated.employeeId ?? 0],
        await kit.unique('AAA Sort'),
      );
      const z = await kit.initiate(
        hr,
        template.id,
        [f.hrAdmin.employeeId ?? 0],
        await kit.unique('ZZZ Sort'),
      );
      const ids = async (sort: string) =>
        (
          (await hr.get(`/performance/contract-initiations?sort=${sort}&pageSize=100`).expect(200))
            .body as InitiationsResponse
        ).items
          .map((r: ContractInitiationRow) => r.id)
          .filter((id) => id === a.id || id === z.id);
      expect(await ids('name:asc')).toEqual([a.id, z.id]);
      expect(await ids('name:desc')).toEqual([z.id, a.id]);
      expect(await ids('createdAt:desc')).toEqual([z.id, a.id]);
      await hr.get('/performance/contract-initiations?sort=bogus:asc').expect(422);
      for (const sort of [
        'linkedContracts:desc',
        'ratingScale:asc',
        'createdFromTemplate:desc',
        'status:asc',
      ])
        await hr.get(`/performance/templates?sort=${sort}`).expect(200);
      for (const sort of [
        'templateName:asc',
        'reportsTo:desc',
        'employeeDateEngaged:asc',
        'contractStatus:desc',
      ])
        await hr.get(`/performance/contracts?sort=${sort}`).expect(200);
      for (const sort of [
        'employeeCompany:asc',
        'employeePosition:desc',
        'reviewStatus:asc',
        'contractName:asc',
      ])
        await hr.get(`/performance/contract-reviews?sort=${sort}`).expect(200);
    });

    it('exports the grids as CSV and Excel, audited', async () => {
      const template = await kit.template(hr);
      const since = await lastAuditId(t.db);
      const csv = await hr.get(`/performance/templates/export?search=${encodeURIComponent(template.name)}`);
      expect(csv.status, csv.text).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toMatch(
        /attachment; filename="performance-templates-.*\.csv"/,
      );
      expect(csv.text.split('\n')[0]).toContain('Template Name');
      expect(csv.text).toContain(template.name);

      const xlsx = await hr
        .get('/performance/contract-initiations/export?format=xlsx')
        .buffer(true)
        .parse(bufferParser);
      expect(xlsx.status).toBe(200);
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');
      expect((xlsx.body as { bytes: Buffer }).bytes.subarray(0, 2).toString()).toBe('PK');

      const contracts = await mgr.get('/performance/contracts/export');
      expect(contracts.status, contracts.text).toBe(200);
      expect(contracts.text).toContain(f.employee.employeeCode ?? '');
      expect(contracts.text).not.toContain(f.unrelated.employeeCode ?? 'x');

      const reviews = await hr.get('/performance/contract-reviews/export?sort=reviewName:asc');
      expect(reviews.status, reviews.text).toBe(200);
      expect(reviews.text.split('\n')[0]).toContain('Review Name');

      const actions = (await auditSince(t.db, since, { category: 'EXPORT' })).map((r) => r.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'EXPORT.PERFORMANCE_TEMPLATES',
          'EXPORT.CONTRACT_INITIATIONS',
          'EXPORT.PERFORMANCE_CONTRACTS',
          'EXPORT.CONTRACT_REVIEWS',
        ]),
      );
      await emp.get('/performance/templates/export').expect(403);
    });
  });
});
