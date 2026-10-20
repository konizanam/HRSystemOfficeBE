import { ONBOARD_ARRIVAL_FREE_TEXT_TYPE } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedFreeText } from '../../prisma/seed/free-text';
import { seedOrganisation } from '../../prisma/seed/organisation';
import { AuditService } from '../../src/audit/audit.service';
import { systemContext } from '../../src/common/context/security-context';
import { WorkflowSubjectRegistry } from '../../src/modules/workflow/subject-registry';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  auditSince,
  createRoleFixtures,
  lastAuditId,
  login,
  nextUnique,
  type RoleFixtures,
} from '../support/fixtures';
import { PDF_BYTES } from '../support/leave';
import { TWO_STEP, WorkflowKit } from '../support/workflow';

interface FreeTextDto {
  id: number;
  referenceNumber: string;
  status: string;
  processId: number;
  workflowType: string;
  body: string;
  aboutEmployee: { id: number } | null;
  attachments: { id: string }[];
}

/** Free Text Workflow (section 5.8): FREETEXT and FREETEXTMANEMP, the types and the reads. */
describe('free text workflow', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let employee: Agent;
  let manager: Agent;
  let hr: Agent;
  let plainTypeId: number;
  let aboutTypeId: number;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    await seedOrganisation({
      db: t.db,
      audit: t.app.get(AuditService),
      ctx: systemContext('test'),
      app: t.app,
    });
    for (const type of ['FREETEXT', 'FREETEXTMANEMP'] as const) {
      await kit.definition({ type, companyRuleId: f.org.companyRuleId, steps: TWO_STEP });
    }
    [employee, manager, hr] = await Promise.all([
      login(t, f.employee),
      login(t, f.managerB),
      login(t, f.hrAdmin),
    ]);
    const n = await nextUnique(t.db);
    plainTypeId = (
      await hr
        .post('/admin/free-text-types')
        .send({ code: `FT_${n}`, description: `Arrival note ${n}` })
        .expect(201)
    ).body.id as number;
    aboutTypeId = (
      await hr
        .post('/admin/free-text-types')
        .send({ code: `FTM_${n}`, description: `Probation feedback ${n}`, requiresSubjectEmployee: true })
        .expect(201)
    ).body.id as number;
  });

  afterAll(async () => {
    await t.close();
  });

  async function upload(agent: Agent): Promise<string> {
    const res = await agent
      .post('/attachments')
      .attach('file', PDF_BYTES, { filename: 'note.pdf', contentType: 'application/pdf' });
    expect(res.status, res.text).toBe(201);
    return res.body.items[0].id as string;
  }

  async function approve(agent: Agent, processId: number): Promise<void> {
    const p = await kit.process(processId);
    const res = await agent.post(`/workflow/processes/${processId}/approve`).send({ version: p.version });
    expect(res.status, res.text).toBe(200);
  }

  it('lists the active types with their workflow type and whether they can start', async () => {
    const res = await employee.get('/free-text/types').expect(200);
    expect(res.body.employeeId).toBe(f.employee.employeeId);
    const items = res.body.items as { id: number; workflowType: string; canStart: boolean }[];
    expect(items.find((i) => i.id === plainTypeId)).toMatchObject({
      workflowType: 'FREETEXT',
      canStart: true,
    });
    expect(items.find((i) => i.id === aboutTypeId)).toMatchObject({
      workflowType: 'FREETEXTMANEMP',
      canStart: true,
    });
    // Only for someone the caller may act for; a manager sees what a report can start.
    await employee.get(`/free-text/types?employeeId=${f.unrelated.employeeId}`).expect(403);
    const forReport = await manager.get(`/free-text/types?employeeId=${f.employee.employeeId}`).expect(200);
    expect(forReport.body.employeeId).toBe(f.employee.employeeId);
  });

  it('submits a FREETEXT request with a document, approved by the manager then HR (audited)', async () => {
    const attachmentId = await upload(employee);
    const since = await lastAuditId(t.db);
    const res = await employee
      .post('/free-text')
      .set('idempotency-key', `ft-${await nextUnique(t.db)}`)
      .send({
        typeId: plainTypeId,
        body: 'I arrived on Monday and collected my laptop.',
        attachmentIds: [attachmentId],
      })
      .expect(201);
    const dto = res.body as FreeTextDto;
    expect(dto).toMatchObject({ status: 'IN_PROGRESS', workflowType: 'FREETEXT', aboutEmployee: null });
    expect(dto.referenceNumber).toMatch(/^F\d{6}-N\d{5}$/);
    expect(dto.attachments.map((a) => a.id)).toEqual([attachmentId]);
    const process = await kit.process(dto.processId);
    expect(process).toMatchObject({ subjectEntity: 'FreeTextRequest', subjectEntityId: String(dto.id) });

    // The inbox describes it by its type.
    const detail = await manager.get(`/inbox/items/${dto.processId}`).expect(200);
    expect(detail.body.subject).toMatchObject({
      title: 'Free text request',
      requestLabel: expect.stringContaining('Arrival note'),
    });
    expect(detail.body.subject.fields).toEqual(
      expect.arrayContaining([{ label: 'Details', value: 'I arrived on Monday and collected my laptop.' }]),
    );
    expect(detail.body.attachments.map((a: { id: string }) => a.id)).toEqual([attachmentId]);
    expect(detail.body.card.category).toBe('FREE_TEXT');

    await approve(manager, dto.processId);
    await approve(hr, dto.processId);
    const done = (await employee.get(`/free-text/${dto.id}`).expect(200)).body as FreeTextDto;
    expect(done.status).toBe('PROCESSED');
    expect((await kit.process(dto.processId)).status).toBe('PROCESSED');
    const actions = (
      await auditSince(t.db, since, { entityType: 'FreeTextRequest', entityId: String(dto.id) })
    ).map((r) => r.action);
    expect(actions).toEqual(['FREE_TEXT.SUBMITTED', 'FREE_TEXT.APPROVED']);
  });

  it('runs a type that needs an employee on FREETEXTMANEMP with a mandatory "About employee"', async () => {
    await employee.post('/free-text').send({ typeId: aboutTypeId, body: 'Feedback' }).expect(422);
    const elsewhere = await employee
      .post('/free-text')
      .send({ typeId: aboutTypeId, body: 'Feedback', aboutEmployeeId: f.otherCompany.employeeId })
      .expect(422);
    expect(elsewhere.body.errors[0].path).toBe('aboutEmployeeId');
    await employee
      .post('/free-text')
      .send({ typeId: plainTypeId, body: 'Feedback', aboutEmployeeId: f.employee2.employeeId })
      .expect(422);

    const options = await employee
      .get(`/free-text/about-options?search=${f.employee2.employeeCode}`)
      .expect(200);
    expect(options.body.items).toEqual([expect.objectContaining({ id: f.employee2.employeeId })]);

    const res = await employee
      .post('/free-text')
      .send({ typeId: aboutTypeId, body: 'Settled in well.', aboutEmployeeId: f.employee2.employeeId })
      .expect(201);
    const dto = res.body as FreeTextDto;
    expect(dto).toMatchObject({
      workflowType: 'FREETEXTMANEMP',
      aboutEmployee: { id: f.employee2.employeeId },
    });
    const process = await t.db.prisma.workflowProcess.findUniqueOrThrow({
      where: { id: dto.processId },
      include: { workflowType: true },
    });
    expect(process.workflowType.code).toBe('FREETEXTMANEMP');
    // One FREETEXTMANEMP handler serves both employee transactions and these requests.
    expect(t.app.get(WorkflowSubjectRegistry).get('FREETEXTMANEMP').constructor.name).toBe(
      'FreeTextManEmpHandler',
    );
    const detail = await manager.get(`/inbox/items/${dto.processId}`).expect(200);
    expect(detail.body.subject.headline[0]).toMatchObject({ label: 'About employee' });
    expect(detail.body.subject).toMatchObject({
      kind: 'FREE_TEXT',
      data: { aboutEmployee: { id: f.employee2.employeeId } },
    });

    await approve(manager, dto.processId);
    await approve(hr, dto.processId);
    expect(((await employee.get(`/free-text/${dto.id}`).expect(200)).body as FreeTextDto).status).toBe(
      'PROCESSED',
    );
  });

  it('can be sent back and resubmitted with an edited body, declined, or withdrawn', async () => {
    const sent = (
      await employee.post('/free-text').send({ typeId: plainTypeId, body: 'First draft' }).expect(201)
    ).body as FreeTextDto;
    let p = await kit.process(sent.processId);
    await manager
      .post(`/workflow/processes/${sent.processId}/send-back`)
      .send({ comment: 'Please add the date', version: p.version })
      .expect(200);
    expect(((await employee.get(`/free-text/${sent.id}`)).body as FreeTextDto).status).toBe(
      'RESUBMIT_REQUIRED',
    );
    p = await kit.process(sent.processId);
    await employee
      .post(`/workflow/processes/${sent.processId}/resubmit`)
      .send({ version: p.version, changes: { unknown: true } })
      .expect(422);
    await employee
      .post(`/workflow/processes/${sent.processId}/resubmit`)
      .send({ version: p.version, changes: { body: 'Arrived on 3 March' } })
      .expect(200);
    const resubmitted = (await employee.get(`/free-text/${sent.id}`)).body as FreeTextDto;
    expect(resubmitted).toMatchObject({ status: 'IN_PROGRESS', body: 'Arrived on 3 March' });

    p = await kit.process(sent.processId);
    await manager
      .post(`/workflow/processes/${sent.processId}/decline`)
      .send({ comment: 'Duplicate', version: p.version })
      .expect(200);
    expect(((await employee.get(`/free-text/${sent.id}`)).body as FreeTextDto).status).toBe('DECLINED');

    const other = (await employee.post('/free-text').send({ typeId: plainTypeId, body: 'Oops' }).expect(201))
      .body as FreeTextDto;
    p = await kit.process(other.processId);
    await employee
      .post(`/workflow/processes/${other.processId}/withdraw`)
      .send({ version: p.version })
      .expect(200);
    expect(((await employee.get(`/free-text/${other.id}`)).body as FreeTextDto).status).toBe('CANCELLED');
  });

  it('applies for a report (manager), never for someone out of scope, and scopes the reads', async () => {
    const forReport = await manager
      .post('/free-text')
      .send({ employeeId: f.employee.employeeId, typeId: plainTypeId, body: 'On behalf of my report' })
      .expect(201);
    expect(forReport.body.applicant.id).toBe(f.employee.employeeId);
    await manager
      .post('/free-text')
      .send({ employeeId: f.unrelated.employeeId, typeId: plainTypeId, body: 'Not my report' })
      .expect(403);

    const mine = await employee.get('/free-text?pageSize=100').expect(200);
    expect((mine.body.items as FreeTextDto[]).some((r) => r.id === forReport.body.id)).toBe(true);
    const unrelated = await login(t, f.unrelated);
    const since = await lastAuditId(t.db);
    const denied = await unrelated.get(`/free-text/${forReport.body.id as number}`).expect(403);
    const rows = await auditSince(t.db, since, { requestId: denied.headers['x-request-id'] as string });
    expect(rows.some((r) => r.outcome === 'DENIED')).toBe(true);
    await hr.get(`/free-text/${forReport.body.id as number}`).expect(200);
    const company = await hr.get('/free-text?scope=company&pageSize=100').expect(200);
    expect(company.body.total).toBeGreaterThan(0);
    await employee.get('/free-text?scope=company').expect(403);
    const auditor = await login(t, f.auditor);
    await auditor.get(`/free-text/${forReport.body.id as number}`).expect(200);
  });

  it('lets HR manage the types (versioned, no workflow change once used) and seeds ONBOARD_ARRIVAL', async () => {
    const n = await nextUnique(t.db);
    await hr
      .post('/admin/free-text-types')
      .send({ code: `FT_${n}`, description: 'A' })
      .expect(201);
    await hr
      .post('/admin/free-text-types')
      .send({ code: `FT_${n}`, description: 'B' })
      .expect(409);
    const list = (await hr.get('/admin/free-text-types').expect(200)).body.items as {
      id: number;
      version: number;
      requestCount: number;
    }[];
    const used = list.find((x) => x.id === plainTypeId);
    expect(used?.requestCount).toBeGreaterThan(0);
    await hr
      .put(`/admin/free-text-types/${plainTypeId}`)
      .send({ requiresSubjectEmployee: true, version: used?.version })
      .expect(422);
    const renamed = await hr
      .put(`/admin/free-text-types/${plainTypeId}`)
      .send({ description: 'Arrival update', version: used?.version })
      .expect(200);
    await hr
      .put(`/admin/free-text-types/${plainTypeId}`)
      .send({ description: 'Stale', version: used?.version })
      .expect(409);
    const since = await lastAuditId(t.db);
    const off = await hr
      .delete(`/admin/free-text-types/${plainTypeId}`)
      .send({ version: renamed.body.version })
      .expect(200);
    expect(off.body.isActive).toBe(false);
    expect((await auditSince(t.db, since, { entityType: 'FreeTextType' }))[0]?.action).toBe(
      'FREE_TEXT_TYPE.DEACTIVATED',
    );
    await employee.post('/free-text').send({ typeId: plainTypeId, body: 'Too late' }).expect(422);
    await employee.post('/admin/free-text-types').send({ code: 'NOPE', description: 'x' }).expect(403);

    const deps = { db: t.db, audit: t.app.get(AuditService), ctx: systemContext('test-seed'), app: t.app };
    await seedFreeText(deps);
    await seedFreeText(deps);
    const seeded = await t.db.prisma.freeTextType.findMany({
      where: { code: ONBOARD_ARRIVAL_FREE_TEXT_TYPE.code },
    });
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.description).toBe('Onboarding Arrival Update');
  });
});
