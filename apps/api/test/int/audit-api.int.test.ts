import { todayBusinessDate } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedOrganisation } from '../../prisma/seed/organisation';
import { AuditService } from '../../src/audit/audit.service';
import { systemContext } from '../../src/common/context/security-context';
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
import { bufferParser } from '../support/payroll';
import { TWO_STEP, WorkflowKit } from '../support/workflow';

/** The audit API (sections 9.7, 12.11): explorer, detail, record history, verify and export. */
describe('audit API', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let auditor: Agent;
  let sysAdmin: Agent;
  let hr: Agent;
  let employee: Agent;
  let marker: string;
  let ruleId: number;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    [auditor, sysAdmin, hr, employee] = await Promise.all([
      login(t, f.auditor),
      login(t, f.sysAdmin),
      login(t, f.hrAdmin),
      login(t, f.employee),
    ]);
    marker = `marker-${await nextUnique(t.db)}`;
    ruleId = (
      await hr
        .post('/admin/company-rules')
        .send({ companyId: f.org.companyId, code: marker.toUpperCase(), description: `Rule ${marker}` })
        .expect(201)
    ).body.id as number;
    await hr
      .put(`/admin/company-rules/${ruleId}`)
      .send({ description: `Renamed ${marker}`, version: 1 })
      .expect(200);
  });

  afterAll(async () => {
    await t.close();
  });

  describe('explorer (GET /audit)', () => {
    it('filters by entity, action, actor, category, outcome, subject, dates and free text', async () => {
      const byEntity = await auditor
        .get(`/audit?entityType=CompanyRule&entityId=${ruleId}&sort=id:asc`)
        .expect(200);
      expect(byEntity.body).toMatchObject({ total: 2, page: 1, pageSize: 25 });
      expect(byEntity.body.items.map((r: { action: string }) => r.action)).toEqual([
        'COMPANY_RULE.CREATED',
        'COMPANY_RULE.UPDATED',
      ]);
      expect(byEntity.body.items[1]).toMatchObject({
        actorUsername: f.hrAdmin.username,
        changedFields: ['description'],
        ip: expect.any(String),
      });

      const byAction = await auditor
        .get(`/audit?action=COMPANY_RULE.&actorUsername=${f.hrAdmin.username}`)
        .expect(200);
      expect(byAction.body.total).toBeGreaterThanOrEqual(2);
      expect(byAction.body.items.every((r: { action: string }) => r.action.startsWith('COMPANY_RULE.'))).toBe(
        true,
      );

      const byActorId = await auditor
        .get(`/audit?actorUserId=${f.hrAdmin.userId}&categories=DATA_CHANGE`)
        .expect(200);
      expect(byActorId.body.items.every((r: { category: string }) => r.category === 'DATA_CHANGE')).toBe(
        true,
      );

      // Free text in metadata.
      await t.app.get(AuditService).recordStandalone(systemContext('test-audit'), {
        category: 'SYSTEM',
        action: 'SYSTEM.TEST_MARKER',
        subjectEmployeeId: f.employee.employeeId,
        metadata: { note: `look for ${marker}_50% here` },
      });
      const text = await auditor.get(`/audit?q=${encodeURIComponent(`${marker}_50%`)}`).expect(200);
      expect(text.body.items.map((r: { action: string }) => r.action)).toEqual(['SYSTEM.TEST_MARKER']);
      const wildcard = await auditor.get(`/audit?q=${encodeURIComponent(`${marker}x50`)}`).expect(200);
      expect(wildcard.body.total).toBe(0);

      const bySubject = await auditor
        .get(
          `/audit?subjectEmployeeId=${f.employee.employeeId}&categories=SYSTEM&from=${todayBusinessDate()}&to=${todayBusinessDate()}`,
        )
        .expect(200);
      expect(bySubject.body.items.map((r: { action: string }) => r.action)).toContain('SYSTEM.TEST_MARKER');
      const yesterday = await auditor.get(`/audit?q=${marker}&to=2000-01-01`).expect(200);
      expect(yesterday.body.total).toBe(0);

      // Outcomes: a denial shows up as DENIED.
      const denied = await employee.get('/audit').expect(403);
      const deniedRows = await auditor
        .get(`/audit?outcomes=DENIED&actorUserId=${f.employee.userId}&action=SECURITY.ACCESS_DENIED`)
        .expect(200);
      expect(deniedRows.body.items.map((r: { requestId: string }) => r.requestId)).toContain(
        denied.headers['x-request-id'],
      );

      // Paging.
      const page = await auditor.get('/audit?pageSize=2&page=2').expect(200);
      expect(page.body.items).toHaveLength(2);
      await auditor.get('/audit?pageSize=500').expect(422);
      await auditor.get('/audit?categories=NOPE').expect(422);
      await auditor.get('/audit?unknown=1').expect(422);
    });

    it('is for auditors and system admins only (DENIED rows for the others)', async () => {
      for (const agent of [hr, employee, await login(t, f.payrollAdmin), await login(t, f.managerB)]) {
        const since = await lastAuditId(t.db);
        const res = await agent.get('/audit').expect(403);
        const rows = await auditSince(t.db, since, { requestId: res.headers['x-request-id'] as string });
        expect(rows.some((r) => r.outcome === 'DENIED')).toBe(true);
      }
      await sysAdmin.get('/audit?pageSize=1').expect(200);
    });
  });

  describe('one row (GET /audit/:id)', () => {
    it('returns before, after and changes for the diff; secrets stay redacted', async () => {
      const list = await auditor
        .get(`/audit?entityType=CompanyRule&entityId=${ruleId}&action=COMPANY_RULE.UPDATED`)
        .expect(200);
      const id = list.body.items[0].id as string;
      const row = await auditor.get(`/audit/${id}`).expect(200);
      expect(row.body).toMatchObject({
        id,
        before: { description: `Rule ${marker}` },
        after: { description: `Renamed ${marker}` },
        changes: [{ path: 'description', from: `Rule ${marker}`, to: `Renamed ${marker}` }],
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        payDataHidden: false,
      });
      await auditor.get('/audit/999999999999').expect(404);
      await auditor.get('/audit/abc').expect(422);

      // A user created with an initial password: the hash is redacted in the trail.
      const n = await nextUnique(t.db);
      const user = await sysAdmin
        .post('/admin/users')
        .send({ username: `audit${n}`, roles: ['EMPLOYEE'], initialPassword: 'Audit-Secret-2026!' })
        .expect(201);
      const created = await auditor
        .get(`/audit?entityType=User&entityId=${user.body.id as string}&action=SECURITY.USER_CREATED`)
        .expect(200);
      const detail = await auditor.get(`/audit/${created.body.items[0].id as string}`).expect(200);
      expect(detail.body.after.passwordHash).toBe('[REDACTED]');
      expect(JSON.stringify(detail.body)).not.toContain('Audit-Secret-2026!');
    });

    it('hides pay data from a system admin who is not HR, Payroll or an auditor (section 4.1)', async () => {
      const since = await lastAuditId(t.db);
      await t.app.get(AuditService).recordStandalone(systemContext('test-pay'), {
        category: 'DATA_CHANGE',
        action: 'PAYSLIP.TEST_ROW',
        entityType: 'Payslip',
        entityId: '1',
        after: {
          payRun: 'MAIN',
          grossPay: '1000.00',
          netPay: '800.00',
          lines: [{ code: 'BASIC', amount: '1000.00' }],
        },
      });
      const [row] = await auditSince(t.db, since, { action: 'PAYSLIP.TEST_ROW' });
      const asSys = await sysAdmin.get(`/audit/${String(row?.id)}`).expect(200);
      expect(asSys.body).toMatchObject({
        payDataHidden: true,
        after: { payRun: 'MAIN', grossPay: '[HIDDEN]', netPay: '[HIDDEN]', lines: '[HIDDEN]' },
      });
      const asAuditor = await auditor.get(`/audit/${String(row?.id)}`).expect(200);
      expect(asAuditor.body).toMatchObject({ payDataHidden: false, after: { grossPay: '1000.00' } });
    });
  });

  describe('record history (GET /audit/entity/:entityType/:entityId)', () => {
    let kit: WorkflowKit;
    let requestId: number;
    let processId: number;

    beforeAll(async () => {
      kit = new WorkflowKit(t);
      await seedOrganisation({
        db: t.db,
        audit: t.app.get(AuditService),
        ctx: systemContext('test'),
        app: t.app,
      });
      await kit.definition({ type: 'FREETEXT', companyRuleId: f.org.companyRuleId, steps: TWO_STEP });
      const n = await nextUnique(t.db);
      const type = await hr
        .post('/admin/free-text-types')
        .send({ code: `AUD_${n}`, description: `Audit note ${n}` })
        .expect(201);
      const submitted = await employee
        .post('/free-text')
        .send({ typeId: type.body.id, body: 'History please' })
        .expect(201);
      requestId = submitted.body.id as number;
      processId = submitted.body.processId as number;
      const manager = await login(t, f.managerB);
      const p = await kit.process(processId);
      await manager
        .post(`/workflow/processes/${processId}/approve`)
        .send({ comment: 'Fine', version: p.version })
        .expect(200);
    });

    it('shows the entity audit rows plus its workflow actions to the applicant (without IPs)', async () => {
      const res = await employee.get(`/audit/entity/FreeTextRequest/${requestId}`).expect(200);
      expect(res.body.processIds).toEqual([processId]);
      expect(res.body.audit.map((r: { action: string }) => r.action)).toEqual(
        expect.arrayContaining(['FREE_TEXT.SUBMITTED', 'WORKFLOW.CREATED', 'WORKFLOW.APPROVED']),
      );
      expect(
        res.body.audit.every(
          (r: { ip: string | null; sessionId: string | null }) => r.ip === null && r.sessionId === null,
        ),
      ).toBe(true);
      const actions = (
        res.body.workflowActions as { action: string; comment: string | null; actorName: string }[]
      ).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['CREATE', 'SUBMIT', 'APPROVE']));
      const approval = (
        res.body.workflowActions as {
          action: string;
          comment: string | null;
          actorName: string;
          stepNo: number | null;
        }[]
      ).find((a) => a.action === 'APPROVE');
      expect(approval).toMatchObject({ comment: 'Fine', stepNo: 1 });
      expect(res.body.truncated).toBe(false);

      // Auditors see the plumbing.
      const asAuditor = await auditor.get(`/audit/entity/FreeTextRequest/${requestId}`).expect(200);
      expect(asAuditor.body.audit.some((r: { ip: string | null }) => r.ip !== null)).toBe(true);
    });

    it('follows the owning module’s scoping: approvers and HR yes, others 403 (audited), unknown 404', async () => {
      await (await login(t, f.managerB)).get(`/audit/entity/FreeTextRequest/${requestId}`).expect(200);
      await hr.get(`/audit/entity/FreeTextRequest/${requestId}`).expect(200);
      await (await login(t, f.managerB)).get(`/audit/entity/WorkflowProcess/${processId}`).expect(200);
      const unrelated = await login(t, f.unrelated);
      const since = await lastAuditId(t.db);
      const denied = await unrelated.get(`/audit/entity/FreeTextRequest/${requestId}`).expect(403);
      const rows = await auditSince(t.db, since, { requestId: denied.headers['x-request-id'] as string });
      expect(rows.some((r) => r.outcome === 'DENIED')).toBe(true);
      await unrelated.get(`/audit/entity/WorkflowProcess/${processId}`).expect(403);
      await employee.get('/audit/entity/FreeTextRequest/999999999').expect(404);
      await employee.get('/audit/entity/Session/abc').expect(404);
      // Configuration: the roles that manage it.
      const ruleHistory = await hr.get(`/audit/entity/CompanyRule/${ruleId}`).expect(200);
      expect(ruleHistory.body.audit).toHaveLength(2);
      await employee.get(`/audit/entity/CompanyRule/${ruleId}`).expect(403);
      // A user sees their own login's history; the employee record is personal (not the manager's).
      await employee.get(`/audit/entity/User/${f.employee.userId}`).expect(200);
      await employee.get(`/audit/entity/User/${f.employee2.userId}`).expect(403);
      await employee.get(`/audit/entity/Employee/${f.employee.employeeId}`).expect(200);
      await (await login(t, f.managerB)).get(`/audit/entity/Employee/${f.employee.employeeId}`).expect(403);
      await hr.get(`/audit/entity/Employee/${f.employee.employeeId}`).expect(200);
      // Auditors read any entity type, known or not.
      await auditor.get('/audit/entity/Session/abc').expect(200);
    });
  });

  describe('verify and export', () => {
    it('verifies the chain over a range and reports the latest anchor', async () => {
      const res = await auditor
        .get(`/audit/verify?from=${todayBusinessDate()}&to=${todayBusinessDate()}`)
        .expect(200);
      expect(res.body).toMatchObject({ ok: true, firstBrokenId: null, reason: null });
      expect(res.body.checked).toBeGreaterThan(0);
      expect(res.body.from).toEqual(expect.any(String));
      await sysAdmin.get('/audit/verify?from=2000-01-01&to=2000-01-02').expect(200);
      await hr.get('/audit/verify').expect(403);
    });

    it('streams CSV and Excel exports and audits each one (EXPORT.AUDIT); others are denied', async () => {
      const since = await lastAuditId(t.db);
      const csv = await auditor
        .post('/audit/export')
        .send({ filters: { entityType: 'CompanyRule', entityId: String(ruleId) }, format: 'csv' })
        .buffer(true)
        .parse(bufferParser)
        .expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toContain('audit-trail-');
      const text = (csv.body as { bytes: Buffer }).bytes.toString('utf8');
      expect(text).toContain('Occurred At');
      expect(text).toContain('COMPANY_RULE.CREATED');
      expect(text).toContain('COMPANY_RULE.UPDATED');
      expect(text.trim().split('\r\n')).toHaveLength(3);

      const xlsx = await sysAdmin
        .post('/audit/export')
        .send({ filters: { entityType: 'CompanyRule', entityId: String(ruleId) }, format: 'xlsx' })
        .buffer(true)
        .parse(bufferParser)
        .expect(200);
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');
      expect((xlsx.body as { bytes: Buffer }).bytes.subarray(0, 2).toString('latin1')).toBe('PK');

      const exports = await auditSince(t.db, since, { action: 'EXPORT.AUDIT' });
      expect(exports).toHaveLength(2);
      expect(exports[0]).toMatchObject({ category: 'EXPORT', actorUserId: f.auditor.userId });
      expect(exports[0]?.metadata).toMatchObject({
        format: 'csv',
        filters: { entityType: 'CompanyRule', entityId: String(ruleId) },
      });

      for (const agent of [employee, hr]) {
        const before = await lastAuditId(t.db);
        const res = await agent.post('/audit/export').send({ filters: {}, format: 'csv' }).expect(403);
        const rows = await auditSince(t.db, before, { requestId: res.headers['x-request-id'] as string });
        expect(rows.some((r) => r.outcome === 'DENIED')).toBe(true);
        expect(await auditSince(t.db, before, { action: 'EXPORT.AUDIT' })).toHaveLength(0);
      }
    });
  });
});
