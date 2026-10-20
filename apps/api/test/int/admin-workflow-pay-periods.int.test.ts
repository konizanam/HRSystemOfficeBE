import { addDays, endOfMonth, startOfMonth, todayBusinessDate } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_USER_ID } from '../../src/common/context/security-context';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  auditSince,
  createPerson,
  createRoleFixtures,
  lastAuditId,
  login,
  type RoleFixtures,
} from '../support/fixtures';
import { LEAVE_TYPE, LeaveKit } from '../support/leave';
import { contextFor, type FakeSubjectHandler, WorkflowKit } from '../support/workflow';

/** Phase 9: workflow definitions (+ steps, versioning) and pay periods (+ close). */
describe('admin: workflow definitions and pay periods', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let hr: Agent;
  let payroll: Agent;
  let kit: WorkflowKit;
  let training: FakeSubjectHandler;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    [hr, payroll] = await Promise.all([login(t, f.hrAdmin), login(t, f.payrollAdmin)]);
    kit = new WorkflowKit(t);
    training = kit.useFakeHandler('TRAINING');
  });

  afterAll(async () => {
    kit.restore();
    await t.close();
  });

  describe('workflow definitions', () => {
    const steps = [
      { stepNo: 1, name: 'Manager', resolution: 'REPORTS_TO' },
      { stepNo: 2, name: 'HR', resolution: 'ROLE', approverRole: 'HR_ADMIN' },
    ];

    it('validates the steps: contiguous numbers, a role for ROLE, an active user for SPECIFIC_USER', async () => {
      const base = { workflowType: 'TRAINING', companyRuleId: f.org.companyRuleId, name: 'Bad' };
      const gap = await hr
        .post('/admin/workflow-definitions')
        .send({ ...base, steps: [steps[0], { ...steps[1], stepNo: 3 }] })
        .expect(422);
      expect(gap.body.errors.map((e: { path: string }) => e.path)).toContain('steps.1.stepNo');
      const noRole = await hr
        .post('/admin/workflow-definitions')
        .send({ ...base, steps: [{ stepNo: 1, name: 'HR', resolution: 'ROLE' }] })
        .expect(422);
      expect(noRole.body.errors[0].path).toBe('steps.0.approverRole');
      const noUser = await hr
        .post('/admin/workflow-definitions')
        .send({ ...base, steps: [{ stepNo: 1, name: 'Boss', resolution: 'SPECIFIC_USER' }] })
        .expect(422);
      expect(noUser.body.errors[0].path).toBe('steps.0.approverUserId');
      await hr
        .post('/admin/workflow-definitions')
        .send({ ...base, steps: [] })
        .expect(422);
      const inactive = await createPerson(t.db, { org: f.org, roles: ['EMPLOYEE'] });
      await t.db.prisma.$executeRaw`UPDATE "User" SET "isActive" = false WHERE id = ${inactive.userId}`;
      await hr
        .post('/admin/workflow-definitions')
        .send({
          ...base,
          steps: [{ stepNo: 1, name: 'Boss', resolution: 'SPECIFIC_USER', approverUserId: inactive.userId }],
        })
        .expect(422);
      // Another company's rule is out of scope.
      await hr
        .post('/admin/workflow-definitions')
        .send({ ...base, companyRuleId: f.otherOrg.companyRuleId, steps })
        .expect(403);
    });

    it('a change creates a new version; running processes keep the version they started on', async () => {
      const since = await lastAuditId(t.db);
      const created = await hr
        .post('/admin/workflow-definitions')
        .send({
          workflowType: 'TRAINING',
          companyRuleId: f.org.companyRuleId,
          name: 'Training approval',
          steps,
        })
        .expect(201);
      const v1 = created.body as { id: number; versionNo: number; version: number };
      expect(created.body).toMatchObject({
        isActive: true,
        steps: [{ stepNo: 1 }, { stepNo: 2 }],
        processCount: 0,
      });

      const running = await kit.start(training, f.employee);
      expect((await kit.process(running.id)).definitionId).toBe(v1.id);

      const edited = await hr
        .put(`/admin/workflow-definitions/${v1.id}`)
        .send({
          name: 'Training approval (HR only)',
          steps: [{ stepNo: 1, name: 'HR only', resolution: 'ROLE', approverRole: 'HR_ADMIN' }],
          version: v1.version,
        })
        .expect(200);
      const v2 = edited.body as {
        id: number;
        versionNo: number;
        previousVersionId: number;
        isActive: boolean;
      };
      expect(v2.id).not.toBe(v1.id);
      expect(v2).toMatchObject({ versionNo: v1.versionNo + 1, previousVersionId: v1.id, isActive: true });
      const old = (await hr.get(`/admin/workflow-definitions/${v1.id}`).expect(200)).body;
      expect(old).toMatchObject({ isActive: false, processCount: 1, openProcessCount: 1, steps: [{}, {}] });

      // Editing the superseded version again is stale.
      await hr
        .put(`/admin/workflow-definitions/${v1.id}/steps`)
        .send({ steps, version: v1.version })
        .expect(409);

      // The running process still has two steps (manager, then HR) on version 1.
      await kit.engine.act(contextFor(f.managerB), running.id, {
        action: 'APPROVE',
        expectedVersion: (await kit.process(running.id)).version,
      });
      expect((await kit.process(running.id)).currentStepNo).toBe(2);
      // A new request starts on version 2: straight to HR.
      const fresh = await kit.start(training, f.employee2);
      const freshRow = await kit.process(fresh.id);
      expect(freshRow).toMatchObject({ definitionId: v2.id, currentStepNo: 1 });
      expect((await kit.instances(fresh.id)).map((i) => i.assigneeUserId)).toEqual([f.hrAdmin.userId]);

      // Steps only: version 3.
      const v2Row = (await hr.get(`/admin/workflow-definitions/${v2.id}`).expect(200)).body as {
        version: number;
      };
      const v3 = await hr
        .put(`/admin/workflow-definitions/${v2.id}/steps`)
        .send({ steps, version: v2Row.version })
        .expect(200);
      expect(v3.body).toMatchObject({
        versionNo: v1.versionNo + 2,
        previousVersionId: v2.id,
        name: 'Training approval (HR only)',
      });

      const actions = (await auditSince(t.db, since, { entityType: 'WorkflowDefinition' })).map(
        (r) => r.action,
      );
      expect(actions).toEqual([
        'WORKFLOW_DEFINITION.CREATED',
        'WORKFLOW_DEFINITION.SUPERSEDED',
        'WORKFLOW_DEFINITION.VERSION_CREATED',
        'WORKFLOW_DEFINITION.SUPERSEDED',
        'WORKFLOW_DEFINITION.VERSION_CREATED',
      ]);
      const superseded = (await auditSince(t.db, since, { action: 'WORKFLOW_DEFINITION.SUPERSEDED' }))[0];
      expect(superseded?.metadata).toMatchObject({ newDefinitionId: v2.id, openProcessesKeepThisVersion: 1 });

      // Deactivate and reactivate in place.
      const off = await hr
        .delete(`/admin/workflow-definitions/${v3.body.id}`)
        .send({ version: v3.body.version })
        .expect(200);
      expect(off.body.isActive).toBe(false);
      const list = (await hr.get('/admin/workflow-definitions?workflowType=TRAINING').expect(200)).body
        .items as {
        id: number;
      }[];
      expect(list.some((d) => d.id === v3.body.id)).toBe(false);
      const on = await hr
        .post(`/admin/workflow-definitions/${v3.body.id}/activate`)
        .send({ version: off.body.version })
        .expect(200);
      expect(on.body.isActive).toBe(true);
      await payroll.get('/admin/workflow-definitions').expect(403);
    });
  });

  describe('pay periods', () => {
    it('creates periods without overlaps, edits them with the version and is scoped to the company', async () => {
      const g = await createRoleFixtures(t.db);
      const pay = await login(t, g.payrollAdmin);
      const since = await lastAuditId(t.db);
      const created = await pay
        .post('/admin/pay-periods')
        .send({
          companyRuleId: g.org.companyRuleId,
          description: 'Jan 2027',
          startDate: '2027-01-01',
          endDate: '2027-01-31',
        })
        .expect(201);
      const id = created.body.id as number;
      expect(created.body).toMatchObject({ isClosed: false, linkedCount: 0, version: 1 });
      await pay
        .post('/admin/pay-periods')
        .send({
          companyRuleId: g.org.companyRuleId,
          description: 'Overlap',
          startDate: '2027-01-15',
          endDate: '2027-02-14',
        })
        .expect(409);
      await pay
        .post('/admin/pay-periods')
        .send({
          companyRuleId: g.org.companyRuleId,
          description: 'Backwards',
          startDate: '2027-03-31',
          endDate: '2027-03-01',
        })
        .expect(422);
      await pay
        .post('/admin/pay-periods')
        .send({
          companyRuleId: f.org.companyRuleId,
          description: 'Elsewhere',
          startDate: '2027-01-01',
          endDate: '2027-01-31',
        })
        .expect(403);
      const updated = await pay
        .put(`/admin/pay-periods/${id}`)
        .send({ description: 'January 2027', payDate: '2027-01-25', version: 1 })
        .expect(200);
      expect(updated.body).toMatchObject({ description: 'January 2027', payDate: '2027-01-25', version: 2 });
      await pay.put(`/admin/pay-periods/${id}`).send({ description: 'Stale', version: 1 }).expect(409);
      const list = (
        await pay.get(`/admin/pay-periods?companyRuleId=${g.org.companyRuleId}&year=2027`).expect(200)
      ).body.items as { id: number }[];
      expect(list.map((p) => p.id)).toEqual([id]);
      await pay.get(`/admin/pay-periods?companyRuleId=${f.org.companyRuleId}`).expect(403);
      await hr.get('/admin/pay-periods').expect(403);
      expect(
        (await auditSince(t.db, since, { entityType: 'PayPeriod', entityId: String(id) })).map(
          (r) => r.action,
        ),
      ).toEqual(['PAY_PERIOD.CREATED', 'PAY_PERIOD.UPDATED']);
    });

    it('closing emits payPeriod.closed through the outbox and the leave accrual runs', async () => {
      const g = await createRoleFixtures(t.db);
      const leave = new LeaveKit(t, kit);
      await leave.setup(g.org);
      const pay = await login(t, g.payrollAdmin);
      const start = startOfMonth(addDays(startOfMonth(todayBusinessDate()), -1));
      const existing = await t.db.prisma.payPeriod.findFirst({
        where: { companyRuleId: g.org.companyRuleId, startDate: new Date(`${start}T00:00:00Z`) },
      });
      const period =
        existing ??
        (await t.db.prisma.payPeriod.findUniqueOrThrow({
          where: {
            id: (
              await pay
                .post('/admin/pay-periods')
                .send({
                  companyRuleId: g.org.companyRuleId,
                  description: `Closing ${start}`,
                  startDate: start,
                  endDate: endOfMonth(start),
                })
                .expect(201)
            ).body.id as number,
          },
        }));
      const before = await t.db.prisma.leaveLedgerEntry.count({
        where: {
          employeeId: g.employee.employeeId as number,
          leaveTypeId: LEAVE_TYPE.annual,
          entryType: 'ACCRUAL',
        },
      });

      const since = await lastAuditId(t.db);
      const res = await pay
        .post(`/admin/pay-periods/${period.id}/close`)
        .send({ version: period.version })
        .expect(200);
      expect(res.body).toMatchObject({
        event: 'payPeriod.closed',
        payPeriod: { isClosed: true, closedByUserId: g.payrollAdmin.userId },
      });
      const event = await t.db.prisma.outboxEvent.findFirst({
        where: { type: 'payPeriod.closed', publishedAt: null },
        orderBy: { id: 'desc' },
      });
      expect(event?.payload).toMatchObject({ payPeriodId: period.id, companyRuleId: g.org.companyRuleId });
      expect((await auditSince(t.db, since, { action: 'PAY_PERIOD.CLOSED' }))[0]?.metadata).toMatchObject({
        event: 'payPeriod.closed',
      });

      // The outbox publisher delivers it; the listener queues the accrual for the next period.
      await kit.publish();
      // The accrual is queued after the listener commits (in-process without pg-boss): wait for it.
      let jobRun: Awaited<ReturnType<typeof auditSince>>[number] | undefined;
      for (let i = 0; i < 100 && !jobRun; i++) {
        jobRun = (await auditSince(t.db, since, { action: 'SYSTEM.JOB_RUN', entityId: 'leave.accrue' }))[0];
        if (!jobRun) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect((jobRun?.metadata as { data: { companyRuleId: number } }).data.companyRuleId).toBe(
        g.org.companyRuleId,
      );
      expect(jobRun?.actorUserId).toBe(SYSTEM_USER_ID);
      const after = await t.db.prisma.leaveLedgerEntry.count({
        where: {
          employeeId: g.employee.employeeId as number,
          leaveTypeId: LEAVE_TYPE.annual,
          entryType: 'ACCRUAL',
        },
      });
      expect(after).toBeGreaterThan(before);

      // A closed period is final.
      await pay
        .post(`/admin/pay-periods/${period.id}/close`)
        .send({ version: res.body.payPeriod.version })
        .expect(409);
      await pay
        .put(`/admin/pay-periods/${period.id}`)
        .send({ description: 'Changed', version: res.body.payPeriod.version })
        .expect(422);
    });
  });
});
