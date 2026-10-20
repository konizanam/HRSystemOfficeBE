import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_USER_ID, systemContext } from '../../src/common/context/security-context';
import { EventBus } from '../../src/events/event-bus';
import { OUTBOX_MAX_ATTEMPTS } from '../../src/events/outbox.service';
import { startTestApp, type TestApp } from '../support/app';
import {
  auditSince,
  createOrg,
  createPerson,
  createRoleFixtures,
  lastAuditId,
  login,
  type Org,
  type Person,
  type RoleFixtures,
} from '../support/fixtures';
import { contextFor, type FakeSubjectHandler, TWO_STEP, WorkflowKit } from '../support/workflow';

const HOUR = 3_600_000;

describe('workflow jobs, outbox and notifications (sections 6, 7.4, 7.5)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let claims: FakeSubjectHandler;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    claims = kit.useFakeHandler('CLAIMS');
    await kit.definition({
      type: 'CLAIMS',
      companyRuleId: f.org.companyRuleId,
      steps: [
        { resolution: 'REPORTS_TO', escalationHours: 4 },
        { resolution: 'ROLE', role: 'HR_ADMIN' },
      ],
    });
  });

  afterAll(async () => {
    kit.restore();
    await t.close();
  });

  async function overdue(processId: number, byMs: number): Promise<void> {
    await t.db.prisma.workflowStepInstance.updateMany({
      where: { processId, status: 'PENDING' },
      data: { dueAt: new Date(Date.now() - byMs) },
    });
  }

  describe('escalation (every 15 minutes)', () => {
    it('sets dueAt from escalationHours and escalates overdue steps once', async () => {
      const p = await kit.start(claims, f.employee);
      const [inst] = await kit.instances(p.id);
      expect(inst?.dueAt?.getTime()).toBeGreaterThan(Date.now() + 3.9 * HOUR);
      await kit.jobs.runNow('workflow.escalate');
      expect((await kit.instances(p.id))[0]?.escalatedAt).toBeNull();

      // Overdue by five hours, but auto-reassign is off: only escalated.
      await overdue(p.id, 5 * HOUR);
      const since = await lastAuditId(t.db);
      const counts = await kit.jobs.runNow('workflow.escalate');
      expect(Number(counts.escalated)).toBeGreaterThanOrEqual(1);
      const after = await kit.instances(p.id);
      expect(after).toHaveLength(1);
      expect(after[0]?.escalatedAt).not.toBeNull();
      const row = await kit.process(p.id);
      expect(row).toMatchObject({ isEscalated: true, version: p.version });
      expect((await kit.actions(p.id)).at(-1)).toMatchObject({
        action: 'ESCALATE',
        actorUserId: SYSTEM_USER_ID,
        metadata: expect.objectContaining({ managerUserId: f.managerA.userId }),
      });
      const audits = await auditSince(t.db, since, { entityId: String(p.id) });
      expect(audits.map((a) => a.action)).toEqual(['WORKFLOW.ESCALATED']);
      expect(audits[0]?.actorUserId).toBe(SYSTEM_USER_ID);
      const jobRun = await auditSince(t.db, since, {
        action: 'SYSTEM.JOB_RUN',
        entityId: 'workflow.escalate',
      });
      expect(jobRun[0]?.metadata).toMatchObject({ counts: { escalated: expect.any(Number) } });

      await kit.jobs.runNow('workflow.escalate');
      expect((await kit.actions(p.id)).filter((a) => a.action === 'ESCALATE')).toHaveLength(1);

      await kit.publish();
      for (const person of [f.managerB, f.managerA]) {
        expect((await kit.notifications(person.userId, p.id)).map((n) => n.kind)).toContain(
          'WORKFLOW_ESCALATED',
        );
      }
      expect(t.mail.sentTo(f.managerA.email ?? '').some((m) => m.template === 'workflow-escalated')).toBe(
        true,
      );
      // The approver can still act with the version they hold.
      await (
        await login(t, f.managerB)
      )
        .post(`/workflow/processes/${p.id}/approve`)
        .send({ version: p.version })
        .expect(200);
    });

    it('reassigns to the second-level manager after twice the escalation time when enabled', async () => {
      const restore = await kit.setting('workflow.escalation.autoReassign', true);
      try {
        const p = await kit.start(claims, f.employee2);
        await overdue(p.id, 3 * HOUR);
        await kit.jobs.runNow('workflow.escalate');
        expect((await kit.instances(p.id)).map((i) => i.status)).toEqual(['PENDING']);

        await overdue(p.id, 5 * HOUR);
        const counts = await kit.jobs.runNow('workflow.escalate');
        expect(Number(counts.reassigned)).toBeGreaterThanOrEqual(1);
        expect((await kit.instances(p.id)).map((i) => [i.assigneeUserId, i.status])).toEqual([
          [f.managerB.userId, 'REASSIGNED'],
          [f.managerA.userId, 'PENDING'],
        ]);
        const escalations = (await kit.actions(p.id)).filter((a) => a.action === 'ESCALATE');
        expect(escalations.at(-1)?.metadata).toMatchObject({
          autoReassign: true,
          fromUserId: f.managerB.userId,
          toUserId: f.managerA.userId,
        });
        const row = await kit.process(p.id);
        expect(row.version).toBe(p.version + 1);
        const history = await (
          await login(t, f.employee2)
        )
          .get(`/workflow/processes/${p.id}/history`)
          .expect(200);
        expect(history.body.renderedText).toMatch(/Escalated to .+ on /);
        await kit.publish();
        expect((await kit.notifications(f.managerA.userId, p.id)).map((n) => n.kind)).toContain(
          'WORKFLOW_REASSIGNED',
        );
      } finally {
        await restore();
      }
    });
  });

  describe('approver re-resolution (nightly and on termination)', () => {
    let org: Org;
    let mgr: Person;
    let emp: Person;
    let hrA: Person;
    let hrB: Person;

    beforeAll(async () => {
      org = await createOrg(t.db, 'Reresolve Co');
      mgr = await createPerson(t.db, { org, roles: ['EMPLOYEE', 'MANAGER'], label: 'mgr' });
      emp = await createPerson(t.db, { org, reportsToId: mgr.employeeId });
      hrA = await createPerson(t.db, { org, roles: ['EMPLOYEE', 'HR_ADMIN'], label: 'hr-a' });
      hrB = await createPerson(t.db, { org, roles: ['EMPLOYEE', 'HR_ADMIN'], label: 'hr-b' });
      await kit.definition({ type: 'CLAIMS', companyRuleId: org.companyRuleId, steps: TWO_STEP });
    });

    async function setActive(person: Person, isActive: boolean): Promise<void> {
      await t.db.tx(systemContext('test-deactivate'), (tx) =>
        tx.user.update({ where: { id: person.userId }, data: { isActive } }),
      );
    }

    it('drops an unavailable ROLE candidate when others remain', async () => {
      const p = await kit.start(claims, emp);
      const approved = await kit.engine.act(contextFor(mgr), p.id, {
        action: 'APPROVE',
        expectedVersion: p.version,
      });
      expect(approved.currentStepNo).toBe(2);
      await setActive(hrB, false);
      try {
        const counts = await kit.jobs.runNow('workflow.reresolve');
        expect(Number(counts.removed)).toBeGreaterThanOrEqual(1);
        const step2 = (await kit.instances(p.id)).filter((i) => i.stepNo === 2);
        expect(step2.map((i) => [i.assigneeUserId, i.status]).sort()).toEqual(
          [
            [hrA.userId, 'PENDING'],
            [hrB.userId, 'SUPERSEDED'],
          ].sort(),
        );
        expect((await kit.actions(p.id)).at(-1)).toMatchObject({
          action: 'REASSIGN',
          actorUserId: SYSTEM_USER_ID,
          metadata: expect.objectContaining({ reason: 'APPROVER_UNAVAILABLE', fromUserId: hrB.userId }),
        });
      } finally {
        await setActive(hrB, true);
      }
    });

    it('re-resolves steps of a deactivated approver as SYSTEM (falls back to HR for a mandatory step)', async () => {
      const first = await kit.start(claims, emp);
      const second = await kit.start(claims, emp);
      await setActive(mgr, false);
      try {
        const since = await lastAuditId(t.db);
        const counts = await kit.engine.reresolveForUser(mgr.userId);
        expect(counts).toEqual({ reassigned: 2, unresolved: 0 });
        for (const p of [first, second]) {
          const open = (await kit.instances(p.id)).filter((i) => i.status === 'PENDING');
          expect(open.map((i) => i.assigneeUserId).sort()).toEqual([hrA.userId, hrB.userId].sort());
          const audit = await auditSince(t.db, since, {
            entityId: String(p.id),
            action: 'WORKFLOW.REASSIGNED',
          });
          expect(audit[0]).toMatchObject({ actorUserId: SYSTEM_USER_ID });
          expect(audit[0]?.metadata).toMatchObject({ usedFallback: true, fromUserId: mgr.userId });
        }
        // The nightly job finds nothing more for this approver.
        await kit.jobs.runNow('workflow.reresolve');
        expect((await kit.instances(first.id)).filter((i) => i.status === 'PENDING')).toHaveLength(2);
        await kit.publish();
        expect((await kit.notifications(hrA.userId, first.id)).map((n) => n.kind)).toContain(
          'WORKFLOW_REASSIGNED',
        );
      } finally {
        await setActive(mgr, true);
      }
    });
  });

  describe('transactional outbox', () => {
    it('publishes after commit, retries failures and records the error', async () => {
      const bus = t.app.get(EventBus);
      const type = `test.event.${Date.now()}`;
      let fail = true;
      const effects: string[] = [];
      const off = bus.subscribe(type, async (event, ctx) => {
        if (fail) throw new Error('listener failed');
        ctx.afterCommit(() => effects.push(String(event.payload.n)));
      });
      try {
        await t.db.tx(systemContext('test-outbox'), (tx) => kit.outbox.add(tx, type, { n: 1 }));
        const row = await t.db.prisma.outboxEvent.findFirstOrThrow({ where: { type } });
        const failed = await kit.outbox.publishPending();
        expect(failed.failed).toBeGreaterThanOrEqual(1);
        expect(await t.db.prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
          publishedAt: null,
          attempts: 1,
          lastError: 'listener failed',
        });
        expect(effects).toEqual([]);

        fail = false;
        await kit.outbox.publishPending();
        const done = await t.db.prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
        expect(done.publishedAt).not.toBeNull();
        expect(effects).toEqual(['1']);
        expect(OUTBOX_MAX_ATTEMPTS).toBeGreaterThan(1);
      } finally {
        off();
      }
    });

    it('writes no event when the business transaction rolls back', async () => {
      const type = `test.rollback.${Date.now()}`;
      await expect(
        t.db.tx(systemContext('test-outbox'), async (tx) => {
          await kit.outbox.add(tx, type, {});
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await t.db.prisma.outboxEvent.count({ where: { type } })).toBe(0);
    });
  });

  describe('notifications API', () => {
    it('lists, counts and marks notifications read for the signed-in user only', async () => {
      const person = await createPerson(t.db, { org: f.org, reportsToId: f.managerB.employeeId });
      const p = await kit.start(claims, person);
      await kit.engine.act(contextFor(f.managerB), p.id, { action: 'APPROVE', expectedVersion: p.version });
      await kit.publish();
      const me = await login(t, person);
      const list = await me.get('/notifications').expect(200);
      expect(list.body).toMatchObject({ total: 1, unreadCount: 1, page: 1 });
      expect(list.body.items[0]).toMatchObject({
        kind: 'WORKFLOW_STEP_APPROVED',
        isRead: false,
        link: `/inbox/items/${p.id}`,
      });

      const other = await login(t, f.managerB);
      const theirs = (await other.get('/notifications?pageSize=1').expect(200)).body;
      expect(theirs.items).toHaveLength(1);
      await me.post(`/notifications/${theirs.items[0].id}/read`).expect(404);
      await me.post('/notifications/not-a-uuid/read').expect(422);

      const read = await me.post(`/notifications/${list.body.items[0].id}/read`).expect(200);
      expect(read.body).toMatchObject({ unreadCount: 0, notification: { isRead: true } });
      expect((await me.get('/notifications?unreadOnly=true').expect(200)).body.total).toBe(0);
      expect((await me.get('/notifications?unreadOnly=false').expect(200)).body.total).toBe(1);

      expect((await other.post('/notifications/read-all').expect(200)).body.unreadCount).toBe(0);
      expect((await other.get('/notifications').expect(200)).body.unreadCount).toBe(0);
      expect((await me.get('/inbox/categories').expect(200)).body.unreadNotifications).toBe(0);
    });
  });
});
