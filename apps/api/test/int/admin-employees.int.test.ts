import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_USER_ID } from '../../src/common/context/security-context';
import { hashToken } from '../../src/modules/auth/auth-policy';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  auditSince,
  createPerson,
  createRoleFixtures,
  lastAuditId,
  login,
  loginRequest,
  nextUnique,
  type RoleFixtures,
} from '../support/fixtures';
import { WorkflowKit } from '../support/workflow';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
  0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

/** Phase 9: employees (HR fields, terminate, photo) and the employee CSV import (section 12.10). */
describe('admin: employees', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let hr: Agent;
  let payroll: Agent;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    [hr, payroll] = await Promise.all([login(t, f.hrAdmin), login(t, f.payrollAdmin)]);
  });

  afterAll(async () => {
    await t.close();
  });

  async function newEmployee(agent: Agent, extra: Record<string, unknown> = {}) {
    const n = await nextUnique(t.db);
    const res = await agent.post('/admin/employees').send({
      employeeCode: `A${n}`,
      entityCode: String(700_000 + n),
      firstName: `New${n}`,
      lastName: `Hire${n}`,
      companyId: f.org.companyId,
      companyRuleId: f.org.companyRuleId,
      reportsToId: f.managerB.employeeId,
      jobTitle: 'Clerk',
      dateEngaged: '2026-01-15',
      ...extra,
    });
    return res;
  }

  it('creates an employee (audited), lists and filters by scope, and refuses other companies', async () => {
    const since = await lastAuditId(t.db);
    const created = await newEmployee(hr, { hourlyRate: '87.5', department: 'Finance' });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({
      status: 'ACTIVE',
      hourlyRate: '87.5000',
      department: 'Finance',
      reportsToId: f.managerB.employeeId,
      user: null,
      version: 1,
    });
    const id = created.body.id as number;
    const rows = await auditSince(t.db, since, { entityType: 'Employee', entityId: String(id) });
    expect(rows.map((r) => r.action)).toEqual(['EMPLOYEE.CREATED']);
    expect(rows[0]?.subjectEmployeeId).toBe(id);

    // Duplicate codes are 409.
    expect((await newEmployee(hr, { employeeCode: created.body.employeeCode })).status).toBe(409);
    // Another company's rule, a manager elsewhere, or another company: refused.
    expect((await newEmployee(hr, { companyRuleId: f.otherOrg.companyRuleId })).status).toBe(422);
    expect((await newEmployee(hr, { reportsToId: f.otherCompany.employeeId })).status).toBe(422);
    expect(
      (await newEmployee(hr, { companyId: f.otherOrg.companyId, companyRuleId: f.otherOrg.companyRuleId }))
        .status,
    ).toBe(403);

    const list = await hr.get(`/admin/employees?search=${created.body.employeeCode}`).expect(200);
    expect(list.body).toMatchObject({ total: 1, page: 1 });
    expect(list.body.items[0]).toMatchObject({ id, reportsToName: expect.any(String) });
    const reports = await payroll
      .get(`/admin/employees?reportsToId=${f.managerB.employeeId}&pageSize=100`)
      .expect(200);
    expect((reports.body.items as { id: number }[]).map((e) => e.id)).toEqual(
      expect.arrayContaining([f.employee.employeeId, f.employee2.employeeId, id]),
    );
    await hr.get(`/admin/employees?companyId=${f.otherOrg.companyId}`).expect(403);
    await hr.get(`/admin/employees/${f.otherCompany.employeeId}`).expect(403);
    await hr.get('/admin/employees?sort=salary:asc').expect(422);
  });

  it('updates HR fields with the version (409 when stale), blocks reporting cycles and audits the diff', async () => {
    const created = (await newEmployee(hr)).body as { id: number; version: number };
    const since = await lastAuditId(t.db);
    const updated = await hr
      .put(`/admin/employees/${created.id}`)
      .send({ jobTitle: 'Senior Clerk', jobGrade: 'B2', hourlyRate: '100', version: 1 })
      .expect(200);
    expect(updated.body).toMatchObject({
      jobTitle: 'Senior Clerk',
      jobGrade: 'B2',
      hourlyRate: '100.0000',
      version: 2,
    });
    const stale = await hr
      .put(`/admin/employees/${created.id}`)
      .send({ jobTitle: 'X', version: 1 })
      .expect(409);
    expect(stale.body.current).toEqual({ version: 2 });

    // Manager B may not report to their own report.
    const mgrB = (await hr.get(`/admin/employees/${f.managerB.employeeId}`).expect(200)).body as {
      version: number;
    };
    const cycle = await hr
      .put(`/admin/employees/${f.managerB.employeeId}`)
      .send({ reportsToId: created.id, version: mgrB.version })
      .expect(422);
    expect(cycle.body.errors[0]).toMatchObject({ path: 'reportsToId' });

    const suspended = await hr
      .put(`/admin/employees/${created.id}`)
      .send({ status: 'SUSPENDED', version: 2 })
      .expect(200);
    expect(suspended.body.status).toBe('SUSPENDED');

    const rows = await auditSince(t.db, since, { entityType: 'Employee', entityId: String(created.id) });
    expect(rows.map((r) => r.action)).toEqual(['EMPLOYEE.UPDATED', 'EMPLOYEE.STATUS_SUSPENDED']);
    expect((rows[0]?.changes as { path: string }[]).map((c) => c.path).sort()).toEqual(
      ['hourlyRate', 'jobGrade', 'jobTitle'].sort(),
    );
    // Only HR writes.
    await payroll.put(`/admin/employees/${created.id}`).send({ jobTitle: 'Y', version: 3 }).expect(403);
  });

  it('terminates: status and date, sessions ended, user deactivated, pending steps re-resolved (section 7.5)', async () => {
    const g = await createRoleFixtures(t.db);
    const kit = new WorkflowKit(t);
    const handler = kit.useFakeHandler('TRAINING');
    try {
      await kit.definition({
        type: 'TRAINING',
        companyRuleId: g.org.companyRuleId,
        steps: [{ resolution: 'REPORTS_TO', name: 'Manager approval' }],
      });
      const p = await kit.start(handler, g.employee);
      expect((await kit.instances(p.id)).map((i) => [i.assigneeUserId, i.status])).toEqual([
        [g.managerB.userId, 'PENDING'],
      ]);
      const managerSession = await login(t, g.managerB);
      const gHr = await login(t, g.hrAdmin);
      const before = (await gHr.get(`/admin/employees/${g.managerB.employeeId}`).expect(200)).body as {
        version: number;
      };

      const since = await lastAuditId(t.db);
      const res = await gHr
        .post(`/admin/employees/${g.managerB.employeeId}/terminate`)
        .send({ terminationDate: '2026-10-31', reason: 'Resigned', version: before.version })
        .expect(200);
      expect(res.body).toMatchObject({
        employee: { status: 'TERMINATED', terminationDate: '2026-10-31' },
        userDeactivated: true,
        stepsReassigned: 1,
        stepsUnresolved: 0,
      });
      expect(res.body.sessionsRevoked).toBeGreaterThanOrEqual(1);

      // The step moved to HR (the mandatory-step fallback), as SYSTEM, audited REASSIGN.
      const open = (await kit.instances(p.id)).filter((i) => i.status === 'PENDING');
      expect(open.map((i) => i.assigneeUserId)).toEqual([g.hrAdmin.userId]);
      expect((await kit.actions(p.id)).at(-1)).toMatchObject({
        action: 'REASSIGN',
        actorUserId: SYSTEM_USER_ID,
        metadata: expect.objectContaining({ reason: 'APPROVER_UNAVAILABLE', fromUserId: g.managerB.userId }),
      });
      const audit = await auditSince(t.db, since);
      expect(audit.map((r) => r.action)).toEqual(
        expect.arrayContaining(['EMPLOYEE.TERMINATED', 'SECURITY.USER_DEACTIVATED', 'WORKFLOW.REASSIGNED']),
      );
      expect(audit.find((r) => r.action === 'EMPLOYEE.TERMINATED')).toMatchObject({ reason: 'Resigned' });

      // The terminated manager's session is gone and they cannot sign in.
      await managerSession.get('/session').expect(401);
      expect(
        (
          await t.db.prisma.session.findUniqueOrThrow({
            where: { id: hashToken(managerSession.sessionToken) },
          })
        ).revokedAt,
      ).not.toBeNull();
      expect((await loginRequest(t, g.managerB)).status).toBe(401);

      // Terminating twice is refused; reinstating clears the termination date.
      await gHr
        .post(`/admin/employees/${g.managerB.employeeId}/terminate`)
        .send({ terminationDate: '2026-10-31', reason: 'Again', version: res.body.employee.version })
        .expect(422);
      const back = await gHr
        .put(`/admin/employees/${g.managerB.employeeId}`)
        .send({ status: 'ACTIVE', version: res.body.employee.version })
        .expect(200);
      expect(back.body).toMatchObject({ status: 'ACTIVE', terminationDate: null });
    } finally {
      kit.restore();
    }
  });

  it('sets a photo that the dashboard shows and the employee can download; others cannot', async () => {
    const upload = await hr
      .post('/attachments')
      .attach('file', PNG, { filename: 'face.png', contentType: 'image/png' });
    expect(upload.status, upload.text).toBe(201);
    const attachmentId = upload.body.items[0].id as string;
    const current = (await hr.get(`/admin/employees/${f.employee2.employeeId}`).expect(200)).body as {
      version: number;
    };
    const since = await lastAuditId(t.db);
    const set = await hr
      .put(`/admin/employees/${f.employee2.employeeId}/photo`)
      .send({ attachmentId, version: current.version })
      .expect(200);
    expect(set.body.photoUrl).toBe(`/api/v1/attachments/${attachmentId}`);
    expect((await auditSince(t.db, since)).map((r) => r.action)).toEqual(
      expect.arrayContaining(['ATTACHMENT.BOUND', 'EMPLOYEE.PHOTO_CHANGED']),
    );

    const me = await login(t, f.employee2);
    const summary = await me.get('/dashboard/summary').expect(200);
    expect(JSON.stringify(summary.body)).toContain(`/api/v1/attachments/${attachmentId}`);
    const file = await me.get(`/attachments/${attachmentId}`).expect(200);
    expect(file.headers['content-type']).toContain('image/png');
    await (await login(t, f.unrelated)).get(`/attachments/${attachmentId}`).expect(403);

    // A PDF is not a photo; removing the photo soft-deletes the old file.
    const pdf = await hr.post('/attachments').attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), {
      filename: 'x.pdf',
      contentType: 'application/pdf',
    });
    await hr
      .put(`/admin/employees/${f.employee2.employeeId}/photo`)
      .send({ attachmentId: pdf.body.items[0].id, version: set.body.version })
      .expect(422);
    const removed = await hr
      .put(`/admin/employees/${f.employee2.employeeId}/photo`)
      .send({ attachmentId: null, version: set.body.version })
      .expect(200);
    expect(removed.body.photoUrl).toBeNull();
    expect(
      (await t.db.prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } })).deletedAt,
    ).not.toBeNull();
  });

  describe('CSV import (dry run, then commit)', () => {
    it('previews every row, then creates and updates employees and logins, auditing each row', async () => {
      const n = await nextUnique(t.db);
      const company = (await hr.get(`/admin/companies/${f.org.companyId}`).expect(200)).body as {
        code: string;
      };
      const rule = (await hr.get(`/admin/company-rules/${f.org.companyRuleId}`).expect(200)).body as {
        code: string;
      };
      const header =
        'employeeCode,entityCode,firstName,lastName,companyCode,companyRuleCode,reportsToEmployeeCode,jobTitle,hourlyRate,dateEngaged,username,email,roles';
      const report = `I${n}A,${800_000 + n},Ina,Report,${company.code},${rule.code},I${n}M,Analyst,55.25,2026-02-01,imp${n}.report,imp${n}.report@example.test,EMPLOYEE`;
      const manager = `I${n}M,${810_000 + n},Max,Manager,${company.code},${rule.code},${f.managerA.employeeCode},Lead,,2025-06-01,imp${n}.mgr,imp${n}.mgr@example.test,EMPLOYEE|MANAGER`;
      const existing = `${f.employee.employeeCode},,,,${company.code},${rule.code},,Imported Title,,,,,`;
      const csv = [header, report, manager, existing].join('\n');

      const dry = await hr.post('/admin/import/employees').send({ csv, mode: 'DRY_RUN' }).expect(200);
      expect(dry.body).toMatchObject({
        totalRows: 3,
        validRows: 3,
        invalidRows: 0,
        created: 2,
        updated: 1,
        committed: false,
      });
      expect(dry.body.rows.map((r: { employeeAction: string }) => r.employeeAction)).toEqual([
        'CREATE',
        'CREATE',
        'UPDATE',
      ]);
      expect(dry.body.rows[2].changedFields).toEqual(['jobTitle']);
      expect(dry.body.rows[0].userAction).toBe('CREATE');
      // Nothing was written by the dry run.
      expect(await t.db.prisma.employee.findUnique({ where: { employeeCode: `I${n}A` } })).toBeNull();

      await hr
        .post('/admin/import/employees')
        .send({ csv, mode: 'COMMIT', confirmToken: 'other' })
        .expect(422);
      await hr
        .post('/admin/import/employees')
        .send({
          csv: `${csv}\n`.replace('Analyst', 'Changed'),
          mode: 'COMMIT',
          confirmToken: dry.body.confirmToken,
        })
        .expect(422);

      const since = await lastAuditId(t.db);
      const done = await hr
        .post('/admin/import/employees')
        .send({ csv, mode: 'COMMIT', confirmToken: dry.body.confirmToken })
        .expect(200);
      expect(done.body).toMatchObject({ committed: true, created: 2, updated: 1 });

      const reportRow = await t.db.prisma.employee.findUniqueOrThrow({
        where: { employeeCode: `I${n}A` },
        include: { user: true, reportsTo: true },
      });
      expect(reportRow.reportsTo?.employeeCode).toBe(`I${n}M`);
      expect(reportRow.hourlyRate?.toString()).toBe('55.25');
      expect(reportRow.user).toMatchObject({
        username: `imp${n}.report`,
        roles: ['EMPLOYEE'],
        mustChangePassword: true,
      });
      const mgrRow = await t.db.prisma.employee.findUniqueOrThrow({
        where: { employeeCode: `I${n}M` },
        include: { user: true },
      });
      expect(mgrRow.user?.roles.sort()).toEqual(['EMPLOYEE', 'MANAGER']);
      expect(
        (await t.db.prisma.employee.findUniqueOrThrow({ where: { id: f.employee.employeeId as number } }))
          .jobTitle,
      ).toBe('Imported Title');

      const actions = (await auditSince(t.db, since)).map((r) => r.action);
      expect(actions.filter((a) => a === 'EMPLOYEE.IMPORT_CREATED')).toHaveLength(2);
      expect(actions.filter((a) => a === 'EMPLOYEE.IMPORT_UPDATED').length).toBeGreaterThanOrEqual(1);
      expect(actions.filter((a) => a === 'SECURITY.USER_CREATED')).toHaveLength(2);
      expect(actions).toContain('EMPLOYEE.IMPORT_COMMITTED');
      const createdRows = await auditSince(t.db, since, { action: 'EMPLOYEE.IMPORT_CREATED' });
      expect(createdRows.map((r) => (r.metadata as { importRow: number }).importRow).sort()).toEqual([1, 2]);

      // New local logins get a set-password link.
      await t.mail.flush();
      expect(t.mail.sentTo(`imp${n}.report@example.test`).map((m) => m.template)).toContain('password-reset');

      // Importing the same file again changes nothing, but every row is still audited.
      const again = await hr.post('/admin/import/employees').send({ csv, mode: 'DRY_RUN' }).expect(200);
      expect(
        again.body.rows.map((r: { employeeAction: string; userAction: string | null }) => [
          r.employeeAction,
          r.userAction,
        ]),
      ).toEqual([
        ['UNCHANGED', 'UNCHANGED'],
        ['UNCHANGED', 'UNCHANGED'],
        ['UNCHANGED', null],
      ]);
      const sinceAgain = await lastAuditId(t.db);
      await hr
        .post('/admin/import/employees')
        .send({ csv, mode: 'COMMIT', confirmToken: again.body.confirmToken })
        .expect(200);
      expect(await auditSince(t.db, sinceAgain, { action: 'EMPLOYEE.IMPORT_UNCHANGED' })).toHaveLength(3);
      expect(await auditSince(t.db, sinceAgain, { action: 'EMPLOYEE.IMPORT_UPDATED' })).toHaveLength(0);
    });

    it('reports row errors and refuses to commit a file with errors', async () => {
      const header = 'employeeCode,entityCode,firstName,lastName,companyCode,companyRuleCode,roles,username';
      const otherCompany = (
        await t.db.prisma.company.findUniqueOrThrow({ where: { id: f.otherOrg.companyId } })
      ).code;
      const n = await nextUnique(t.db);
      const csv = [
        header,
        `E${n},x1,A,B,NOPE,STAFF,,`,
        `F${n},${900_000 + n},A,B,${otherCompany},STAFF,,`,
        `G${n},${910_000 + n},A,B,${(await t.db.prisma.company.findUniqueOrThrow({ where: { id: f.org.companyId } })).code},STAFF,SYSTEM_ADMIN,g${n}.user`,
      ].join('\n');
      const dry = await hr.post('/admin/import/employees').send({ csv, mode: 'DRY_RUN' }).expect(200);
      expect(dry.body.invalidRows).toBe(3);
      expect(dry.body.rows[0].errors.join(' ')).toContain('Unknown company NOPE');
      expect(dry.body.rows[1].errors.join(' ')).toContain('outside your administration scope');
      expect(dry.body.rows[2].errors.join(' ')).toContain('grants EMPLOYEE and MANAGER only');
      const commit = await hr
        .post('/admin/import/employees')
        .send({ csv, mode: 'COMMIT', confirmToken: dry.body.confirmToken })
        .expect(422);
      expect(commit.body.errors).toHaveLength(3);
      await hr.post('/admin/import/employees').send({ csv: 'nope,header\n1,2', mode: 'DRY_RUN' }).expect(422);
      await payroll.post('/admin/import/employees').send({ csv, mode: 'DRY_RUN' }).expect(403);
    });
  });

  it('suspending an approver moves their open steps too', async () => {
    const org = (await createRoleFixtures(t.db)).org;
    const boss = await createPerson(t.db, { org, roles: ['EMPLOYEE', 'MANAGER'], label: 'boss' });
    const worker = await createPerson(t.db, { org, reportsToId: boss.employeeId });
    const orgHr = await createPerson(t.db, { org, roles: ['EMPLOYEE', 'HR_ADMIN'] });
    const kit = new WorkflowKit(t);
    const handler = kit.useFakeHandler('QUALIFICATION');
    try {
      await kit.definition({
        type: 'QUALIFICATION',
        companyRuleId: org.companyRuleId,
        steps: [{ resolution: 'REPORTS_TO' }],
      });
      const p = await kit.start(handler, worker);
      const agent = await login(t, orgHr);
      const row = (await agent.get(`/admin/employees/${boss.employeeId}`).expect(200)).body as {
        version: number;
      };
      await agent
        .put(`/admin/employees/${boss.employeeId}`)
        .send({ status: 'SUSPENDED', version: row.version })
        .expect(200);
      const open = (await kit.instances(p.id)).filter((i) => i.status === 'PENDING');
      expect(open.map((i) => i.assigneeUserId)).not.toContain(boss.userId);
      expect(open.length).toBeGreaterThan(0);
    } finally {
      kit.restore();
    }
  });
});
