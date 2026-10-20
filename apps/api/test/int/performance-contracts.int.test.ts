import type {
  ContractInitiation,
  ContractsResponse,
  InitiationsResponse,
  PerformanceContract,
} from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import { JobsService } from '../../src/jobs/jobs.service';
import { PERFORMANCE_INITIATE_JOB } from '../../src/modules/performance/performance-common';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  auditSince,
  createRoleFixtures,
  lastAuditId,
  login,
  type RoleFixtures,
} from '../support/fixtures';
import { PerformanceKit } from '../support/performance';

const sys = systemContext('test-performance-contracts');

describe('performance: contract initiation and contracts', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: PerformanceKit;
  let hr: Agent;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new PerformanceKit(t);
    await kit.setup();
    hr = await login(t, f.hrAdmin);
    // Grid fields come from the employee record.
    await t.db.tx(sys, (tx) =>
      tx.employee.update({
        where: { id: f.employee.employeeId ?? 0 },
        data: { jobTitle: 'Payroll Clerk', jobGrade: 'C' },
      }),
    );
  });

  afterAll(async () => {
    await t.close();
  });

  it('creates one contract per employee in a job, with progress and per-employee failures', async () => {
    const template = await kit.template(hr);
    const emp = f.employee.employeeId ?? 0;
    const emp2 = f.employee2.employeeId ?? 0;
    const unrelated = f.unrelated.employeeId ?? 0;
    // employee2 already has a contract from this template for the same period: that one fails.
    const first = await kit.initiate(hr, template.id, [emp2]);
    expect(first).toMatchObject({
      status: 'COMPLETED',
      contractCount: 1,
      createdCount: 1,
      failedCount: 0,
      progress: 100,
    });

    const since = await lastAuditId(t.db);
    const init = await kit.initiate(hr, template.id, [emp, emp2, unrelated], 'FY2026 Contract');
    expect(init).toMatchObject({
      name: 'FY2026 Contract',
      templateId: template.id,
      templateName: template.name,
      contractStartDate: '2026-01-01',
      contractEndDate: '2026-12-31',
      status: 'COMPLETED',
      progress: 100,
      contractCount: 3,
      createdCount: 2,
      failedCount: 1,
      employeeIds: [emp, emp2, unrelated].sort((a, b) => a - b),
    });
    expect(init.errors).toEqual([
      expect.objectContaining({
        employeeId: emp2,
        employeeCode: f.employee2.employeeCode,
        message: expect.stringContaining('overlapping period') as unknown as string,
      }),
    ]);
    expect(Date.parse(init.lastChanged)).not.toBeNaN();

    // The contracts copy the template items; the assignee is the manager.
    const contract = await t.db.prisma.performanceContract.findFirstOrThrow({
      where: { initiationId: init.id, employeeId: emp },
      include: { items: true },
    });
    expect(contract).toMatchObject({ name: 'FY2026 Contract', status: 'DRAFT', templateId: template.id });
    expect(contract.items.map((i) => [i.kind, i.title, i.weight.toFixed(2)])).toEqual(
      template.items.map((i) => [i.kind, i.title, i.weight]),
    );
    expect(contract.currentlyAssignedUserId).toBe(f.managerB.userId);

    const audit = await auditSince(t.db, since);
    expect(audit.filter((r) => r.action === 'PERFORMANCE_INITIATION.CREATED')).toHaveLength(1);
    expect(audit.filter((r) => r.action === 'PERFORMANCE_INITIATION.STARTED')).toHaveLength(1);
    expect(audit.filter((r) => r.action === 'PERFORMANCE_CONTRACT.CREATED')).toHaveLength(2);
    const completed = audit.find((r) => r.action === 'PERFORMANCE_INITIATION.COMPLETED');
    expect(completed?.entityId).toBe(String(init.id));
    const jobRun = audit.find(
      (r) => r.action === 'SYSTEM.JOB_RUN' && r.entityId === PERFORMANCE_INITIATE_JOB,
    );
    expect(jobRun?.metadata).toMatchObject({ counts: { created: 2, failed: 1 } });

    // Idempotent per (initiation, employee): a re-run creates nothing new.
    const counts = await t.app.get(JobsService).runNow(PERFORMANCE_INITIATE_JOB, { initiationId: init.id });
    expect(counts).toMatchObject({ created: 2, alreadyCreated: 2, failed: 1 });
    expect(await t.db.prisma.performanceContract.count({ where: { initiationId: init.id } })).toBe(2);

    const detail = await hr.get(`/performance/contract-initiations/${init.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body as ContractInitiation).toMatchObject({ createdCount: 2, failedCount: 1 });
    const grid = await hr.get(`/performance/contract-initiations?search=FY2026`);
    expect((grid.body as InitiationsResponse).items.some((i) => i.id === init.id)).toBe(true);

    // The template grid counts its linked contracts.
    const tpl = await hr.get(`/performance/templates/${template.id}`);
    expect((tpl.body as { linkedContracts: number }).linkedContracts).toBe(3);
  });

  it('refuses a template that is not active, nobody to select, and employees outside the HR scope', async () => {
    const draft = await kit.template(hr, { status: 'DRAFT' });
    const notActive = await hr
      .post('/performance/contract-initiations')
      .send({ name: 'x', templateId: draft.id, filters: { employeeIds: [f.employee.employeeId] } });
    expect(notActive.status).toBe(422);
    const template = await kit.template(hr);
    const nobody = await hr
      .post('/performance/contract-initiations')
      .send({ name: 'x', templateId: template.id, filters: { positions: ['No Such Position 42'] } });
    expect(nobody.status).toBe(422);
    const foreign = await hr
      .post('/performance/contract-initiations')
      .send({ name: 'x', templateId: template.id, filters: { employeeIds: [f.otherCompany.employeeId] } });
    expect(foreign.status).toBe(403);
    const foreignCompany = await hr
      .post('/performance/contract-initiations')
      .send({ name: 'x', templateId: template.id, filters: { companyIds: [f.otherOrg.companyId] } });
    expect(foreignCompany.status).toBe(403);
  });

  it('selects by company rule and position', async () => {
    const template = await kit.template(hr);
    const res = await hr.post('/performance/contract-initiations').send({
      name: await kit.unique('By position'),
      templateId: template.id,
      contractStartDate: '2026-03-01',
      contractEndDate: '2026-08-31',
      contractType: 'Mid-year',
      filters: { companyRuleIds: [f.org.companyRuleId], positions: ['Payroll Clerk'] },
    });
    expect(res.status, res.text).toBe(201);
    const init = res.body as ContractInitiation;
    expect(init.employeeIds).toContain(f.employee.employeeId);
    expect(init.employeeIds).not.toContain(f.employee2.employeeId);
    const c = await t.db.prisma.performanceContract.findFirstOrThrow({ where: { initiationId: init.id } });
    expect(c.contractType).toBe('Mid-year');
  });

  it('lists contracts with the grid fields, scoped to the caller', async () => {
    const template = await kit.template(hr);
    const init = await kit.initiate(hr, template.id, [
      f.employee.employeeId ?? 0,
      f.employee2.employeeId ?? 0,
      f.unrelated.employeeId ?? 0,
    ]);
    const path = `/performance/contracts?initiationId=${init.id}&sort=employeeCode:asc`;
    const ids = async (agent: Agent) =>
      ((await agent.get(path)).body as ContractsResponse).items
        .map((i) => i.employeeId)
        .sort((a, b) => a - b);

    const asHr = (await hr.get(path)).body as ContractsResponse;
    expect(asHr.total).toBe(3);
    const row = asHr.items.find((i) => i.employeeId === f.employee.employeeId);
    expect(row).toMatchObject({
      employeeCode: f.employee.employeeCode,
      templateName: template.name,
      contractName: init.name,
      contractStartDate: '2026-01-01',
      contractEndDate: '2026-12-31',
      jobTitle: 'Payroll Clerk',
      jobGrade: 'C',
      employeeCompanyRule: 'Staff',
      employeeDateEngaged: '2024-01-01',
      employeeStatus: 'ACTIVE',
      contractType: null,
      contractStatus: 'DRAFT',
      currentlyAssignedUserId: f.managerB.userId,
    });
    expect(row?.reportsTo).toMatch(/^First\d+ Last\d+$/);
    expect(row?.currentlyAssigned).toBe(row?.reportsTo);

    expect(await ids(await login(t, f.employee))).toEqual([f.employee.employeeId]);
    expect(await ids(await login(t, f.managerB))).toEqual(
      [f.employee.employeeId ?? 0, f.employee2.employeeId ?? 0].sort((a, b) => a - b),
    );
    expect(await ids(await login(t, f.unrelated))).toEqual([f.unrelated.employeeId]);
    expect(await ids(await login(t, f.auditor))).toHaveLength(3);
    expect(await ids(await login(t, f.otherCompany))).toEqual([]);
    expect(await ids(await login(t, f.sysAdmin))).toEqual([]);

    const theirs = asHr.items.find((i) => i.employeeId === f.employee2.employeeId);
    expect((await (await login(t, f.employee)).get(`/performance/contracts/${theirs?.id}`)).status).toBe(403);
    expect((await (await login(t, f.managerB)).get(`/performance/contracts/${theirs?.id}`)).status).toBe(200);
  });

  it('moves a contract DRAFT → AGREED → ACTIVE → CLOSED → ARCHIVED by the rules', async () => {
    const template = await kit.template(hr);
    await kit.initiate(hr, template.id, [f.employee.employeeId ?? 0]);
    const { id } = await kit.contractOf(f.employee.employeeId ?? 0, template.id);
    const emp = await login(t, f.employee);
    const mgr = await login(t, f.managerB);
    const since = await lastAuditId(t.db);

    const draft = (await emp.get(`/performance/contracts/${id}`)).body as PerformanceContract;
    expect(draft).toMatchObject({ contractStatus: 'DRAFT', allowedStatuses: ['AGREED'], canEdit: false });
    expect(draft.sectionTotals.every((s) => s.valid)).toBe(true);
    expect(draft.ratingScale?.name).toBe('1–5');

    // The employee cannot edit items; the manager can while DRAFT, with weights checked.
    expect((await emp.put(`/performance/contracts/${id}`).send({ version: 1, name: 'Mine' })).status).toBe(
      403,
    );
    const items = draft.items.map((i) => ({
      id: i.id,
      kind: i.kind,
      parameterValueId: i.parameterValueId,
      weight: i.weight,
    }));
    const bad = await mgr
      .put(`/performance/contracts/${id}`)
      .send({ version: 1, items: items.map((i) => (i.kind === 'KPA' ? { ...i, weight: '10' } : i)) });
    expect(bad.status).toBe(422);
    const edited = await mgr.put(`/performance/contracts/${id}`).send({
      version: 1,
      contractType: 'Annual',
      items: [...items, { kind: 'OBJECTIVE', title: 'Mentor a colleague', weight: '100' }],
    });
    expect(edited.status, edited.text).toBe(200);
    expect((edited.body as PerformanceContract).items).toHaveLength(items.length + 1);

    // The employee agrees; they cannot activate.
    expect(
      (await emp.put(`/performance/contracts/${id}`).send({ version: 2, status: 'ACTIVE' })).status,
    ).toBe(422);
    const agreed = await emp.put(`/performance/contracts/${id}`).send({ version: 2, status: 'AGREED' });
    expect(agreed.status, agreed.text).toBe(200);
    expect((agreed.body as PerformanceContract).allowedStatuses).toEqual([]);
    expect(
      (await emp.put(`/performance/contracts/${id}`).send({ version: 3, status: 'ACTIVE' })).status,
    ).toBe(403);
    // Items are locked after DRAFT.
    expect((await mgr.put(`/performance/contracts/${id}`).send({ version: 3, name: 'Renamed' })).status).toBe(
      422,
    );
    // Stale version.
    expect(
      (await mgr.put(`/performance/contracts/${id}`).send({ version: 2, status: 'ACTIVE' })).status,
    ).toBe(409);
    expect(
      (await mgr.put(`/performance/contracts/${id}`).send({ version: 3, status: 'ACTIVE' })).status,
    ).toBe(200);
    // Archive needs CLOSED (or DRAFT) and HR.
    expect((await hr.post(`/performance/contracts/${id}/archive`).send({ version: 4 })).status).toBe(422);
    expect((await mgr.post(`/performance/contracts/${id}/archive`).send({ version: 4 })).status).toBe(403);
    // Reassign while active, then close.
    const reassigned = await mgr
      .put(`/performance/contracts/${id}`)
      .send({ version: 4, currentlyAssignedUserId: f.employee.userId });
    expect(reassigned.status, reassigned.text).toBe(200);
    expect((reassigned.body as PerformanceContract).currentlyAssignedUserId).toBe(f.employee.userId);
    expect(
      (await mgr.put(`/performance/contracts/${id}`).send({ version: 5, status: 'CLOSED' })).status,
    ).toBe(200);
    const archived = await hr
      .post(`/performance/contracts/${id}/archive`)
      .send({ version: 6, reason: 'Cycle finished' });
    expect(archived.status, archived.text).toBe(200);
    expect((archived.body as PerformanceContract).contractStatus).toBe('ARCHIVED');
    expect((archived.body as PerformanceContract).archivedAt).not.toBeNull();
    expect((await hr.put(`/performance/contracts/${id}`).send({ version: 7, name: 'x' })).status).toBe(422);

    // Archived contracts move to the other grid.
    const live = (await hr.get(`/performance/contracts?templateId=${template.id}`)).body as ContractsResponse;
    const gone = (await hr.get(`/performance/contracts?templateId=${template.id}&archived=true`))
      .body as ContractsResponse;
    expect(live.items.some((i) => i.id === id)).toBe(false);
    expect(gone.items.map((i) => i.id)).toEqual([id]);

    const actions = (
      await auditSince(t.db, since, { entityType: 'PerformanceContract', entityId: String(id) })
    ).map((r) => r.action);
    expect(actions).toEqual([
      'PERFORMANCE_CONTRACT.UPDATED',
      'PERFORMANCE_CONTRACT.STATUS_CHANGED',
      'PERFORMANCE_CONTRACT.STATUS_CHANGED',
      'PERFORMANCE_CONTRACT.UPDATED',
      'PERFORMANCE_CONTRACT.STATUS_CHANGED',
      'PERFORMANCE_CONTRACT.ARCHIVED',
    ]);
    const archiveRow = (
      await auditSince(t.db, since, { action: 'PERFORMANCE_CONTRACT.ARCHIVED', entityId: String(id) })
    )[0];
    expect(archiveRow?.reason).toBe('Cycle finished');
    expect(archiveRow?.subjectEmployeeId).toBe(f.employee.employeeId);
  });

  it('archives a draft contract', async () => {
    const template = await kit.template(hr);
    await kit.initiate(hr, template.id, [f.employee2.employeeId ?? 0]);
    const { id, version } = await kit.contractOf(f.employee2.employeeId ?? 0, template.id);
    const res = await hr.post(`/performance/contracts/${id}/archive`).send({ version });
    expect(res.status, res.text).toBe(200);
  });
});
