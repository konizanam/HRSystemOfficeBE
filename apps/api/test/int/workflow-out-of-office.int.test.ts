import {
  addDays,
  dateFromBusiness,
  todayBusinessDate,
  type UpdateOutOfOfficeRequest,
} from '@peoplehub/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import { OutOfOfficeService } from '../../src/modules/workflow/out-of-office.service';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  auditSince,
  createPerson,
  createRoleFixtures,
  lastAuditId,
  login,
  nextUnique,
  type Person,
  type RoleFixtures,
} from '../support/fixtures';
import { contextFor, type FakeSubjectHandler, TWO_STEP, WorkflowKit } from '../support/workflow';

/** A leave type only these tests use (ids 1–12 belong to the seed). Inactive, so it is never offered. */
const TEST_LEAVE_TYPE_ID = 900_001;

describe('out of office (section 5.11)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let ooo: OutOfOfficeService;
  let claims: FakeSubjectHandler;
  let free: FakeSubjectHandler;
  let n: Person[];
  const today = todayBusinessDate();
  const touched = new Set<Person>();

  async function setAway(person: Person, input: Partial<UpdateOutOfOfficeRequest> = {}): Promise<void> {
    const ctx = contextFor(person);
    const current = await ooo.get(ctx);
    await ooo.update(ctx, {
      mode: 'DATE_RANGE',
      fromDate: today,
      toDate: addDays(today, 5),
      mainNomineeUserId: null,
      rules: [],
      ...input,
      version: current.version,
    });
    touched.add(person);
  }

  async function off(person: Person): Promise<void> {
    const ctx = contextFor(person);
    const current = await ooo.get(ctx);
    if (current.mode === 'OFF' && current.rules.length === 0) return;
    await ooo.update(ctx, { mode: 'OFF', mainNomineeUserId: null, rules: [], version: current.version });
  }

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    n = [];
    for (let i = 0; i < 4; i++) n.push(await createPerson(t.db, { org: f.org, label: `nominee-${i + 1}` }));
    kit = new WorkflowKit(t);
    ooo = t.app.get(OutOfOfficeService);
    claims = kit.useFakeHandler('CLAIMS');
    free = kit.useFakeHandler('FREETEXT');
    await kit.definition({ type: 'CLAIMS', companyRuleId: f.org.companyRuleId, steps: TWO_STEP });
    await kit.definition({ type: 'FREETEXT', companyRuleId: f.org.companyRuleId, steps: TWO_STEP });
  });

  afterEach(async () => {
    for (const person of touched) await off(person);
    touched.clear();
  });

  afterAll(async () => {
    kit.restore();
    await t.close();
  });

  async function firstStep(processId: number) {
    const [inst] = await kit.instances(processId);
    return inst;
  }

  it('saves the settings with per-type rules, versions and audit rows', async () => {
    const me = await login(t, f.unrelated);
    touched.add(f.unrelated);
    const empty = await me.get('/profile/out-of-office').expect(200);
    expect(empty.body).toMatchObject({
      mode: 'OFF',
      version: 0,
      rules: [],
      mainNominee: null,
      isOutOfOfficeNow: false,
    });

    const since = await lastAuditId(t.db);
    const saved = await me
      .put('/profile/out-of-office')
      .send({
        mode: 'DATE_RANGE',
        fromDate: today,
        toDate: addDays(today, 2),
        mainNomineeUserId: f.managerA.userId,
        rules: [{ workflowType: 'CLAIMS', nomineeUserId: n[0]?.userId }],
        version: 0,
      })
      .expect(200);
    expect(saved.body).toMatchObject({
      mode: 'DATE_RANGE',
      fromDate: today,
      version: 1,
      isOutOfOfficeNow: true,
      mainNominee: { userId: f.managerA.userId },
      rules: [{ workflowType: 'CLAIMS', nominee: { userId: n[0]?.userId } }],
    });
    const rows = await auditSince(t.db, since);
    expect(rows.map((r) => r.action).sort()).toEqual(['OUT_OF_OFFICE.RULE_SET', 'OUT_OF_OFFICE.UPDATED']);
    expect(rows.every((r) => r.category === 'DATA_CHANGE' && r.actorUserId === f.unrelated.userId)).toBe(
      true,
    );

    // Stale version, invalid nominees and missing dates are refused.
    await me
      .put('/profile/out-of-office')
      .send({ mode: 'OFF', mainNomineeUserId: null, version: 0 })
      .expect(409);
    const self = await me
      .put('/profile/out-of-office')
      .send({
        mode: 'DATE_RANGE',
        fromDate: today,
        toDate: today,
        mainNomineeUserId: f.unrelated.userId,
        version: 1,
      })
      .expect(422);
    expect(self.body.errors).toEqual([
      { path: 'mainNomineeUserId', message: 'You cannot nominate yourself' },
    ]);
    const other = await me
      .put('/profile/out-of-office')
      .send({
        mode: 'DATE_RANGE',
        fromDate: today,
        toDate: today,
        mainNomineeUserId: f.otherCompany.userId,
        version: 1,
      })
      .expect(422);
    expect(other.body.errors[0].message).toBe('Choose someone in your company');
    await me
      .put('/profile/out-of-office')
      .send({ mode: 'DATE_RANGE', mainNomineeUserId: f.managerA.userId, version: 1 })
      .expect(422);

    // Removing a rule soft-deletes it; adding it back revives the same row.
    const since2 = await lastAuditId(t.db);
    const removed = await me
      .put('/profile/out-of-office')
      .send({ mode: 'OFF', mainNomineeUserId: null, rules: [], version: 1 })
      .expect(200);
    expect(removed.body).toMatchObject({ mode: 'OFF', fromDate: null, rules: [], isOutOfOfficeNow: false });
    expect((await auditSince(t.db, since2)).map((r) => r.action).sort()).toEqual([
      'OUT_OF_OFFICE.RULE_REMOVED',
      'OUT_OF_OFFICE.UPDATED',
    ]);
    const rule = await t.db.prisma.outOfOfficeRule.findFirstOrThrow({
      where: { outOfOffice: { userId: f.unrelated.userId } },
    });
    expect(rule.deletedAt).not.toBeNull();
    await me
      .put('/profile/out-of-office')
      .send({
        mode: 'OFF',
        mainNomineeUserId: null,
        rules: [{ workflowType: 'CLAIMS', nomineeUserId: n[1]?.userId }],
        version: 2,
      })
      .expect(200);
    const revived = await t.db.prisma.outOfOfficeRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(revived).toMatchObject({ deletedAt: null, nomineeUserId: n[1]?.userId });
  });

  it('lists nominees from the same company, without the user', async () => {
    const res = await (await login(t, f.employee)).get('/profile/out-of-office/nominees').expect(200);
    const ids = res.body.items.map((i: { userId: string }) => i.userId);
    expect(ids).toContain(f.managerB.userId);
    expect(ids).not.toContain(f.employee.userId);
    expect(ids).not.toContain(f.otherCompany.userId);
  });

  it('is a restricted feature while working as someone else', async () => {
    const mb: Agent = await login(t, f.managerB);
    await mb.put('/session/acting-as').send({ employeeId: f.employee.employeeId }).expect(200);
    for (const res of [
      await mb.get('/profile/out-of-office'),
      await mb.put('/profile/out-of-office').send({ mode: 'OFF', mainNomineeUserId: null, version: 0 }),
      await mb.get('/profile/out-of-office/nominees'),
    ]) {
      expect(res.status).toBe(403);
      const rows = await auditSince(t.db, 0n, { requestId: res.headers['x-request-id'] as string });
      expect(rows[0]).toMatchObject({ outcome: 'DENIED' });
      expect(rows[0]?.metadata).toMatchObject({ feature: 'OUT_OF_OFFICE' });
    }
    await mb.put('/session/acting-as').send({ employeeId: f.managerB.employeeId }).expect(200);
  });

  it('delegates a new step to the nominee and audits WORKFLOW.DELEGATED', async () => {
    await setAway(f.managerB, { mainNomineeUserId: f.managerA.userId });
    const p = await kit.start(claims, f.employee);
    expect(await firstStep(p.id)).toMatchObject({
      assigneeUserId: f.managerA.userId,
      delegatedFromUserId: f.managerB.userId,
      status: 'PENDING',
    });
    const delegate = (await kit.actions(p.id)).find((a) => a.action === 'DELEGATE');
    expect(delegate?.metadata).toMatchObject({
      fromUserId: f.managerB.userId,
      toUserId: f.managerA.userId,
      outcome: 'DELEGATED',
    });
    const audit = await auditSince(t.db, 0n, { entityId: String(p.id), action: 'WORKFLOW.DELEGATED' });
    expect(audit).toHaveLength(1);

    await (
      await login(t, f.managerB)
    )
      .post(`/workflow/processes/${p.id}/approve`)
      .send({ version: p.version })
      .expect(403);
    const history = await (await login(t, f.managerB)).get(`/workflow/processes/${p.id}/history`).expect(200);
    expect(history.body.renderedText).toContain('(out of office)');
    await (
      await login(t, f.managerA)
    )
      .post(`/workflow/processes/${p.id}/approve`)
      .send({ version: p.version })
      .expect(200);
    await kit.publish();
    expect((await kit.notifications(f.managerA.userId, p.id)).map((x) => x.kind)).toEqual([
      'WORKFLOW_DELEGATED',
    ]);
    expect(await kit.notifications(f.managerB.userId, p.id)).toEqual([]);
  });

  it('uses the per-type rule over the main nominee', async () => {
    await setAway(f.managerB, {
      mainNomineeUserId: f.managerA.userId,
      rules: [{ workflowType: 'CLAIMS', nomineeUserId: n[0]?.userId ?? '' }],
    });
    const claim = await kit.start(claims, f.employee);
    const text = await kit.start(free, f.employee);
    expect((await firstStep(claim.id))?.assigneeUserId).toBe(n[0]?.userId);
    expect((await firstStep(text.id))?.assigneeUserId).toBe(f.managerA.userId);
  });

  it('stops delegating after three hops', async () => {
    const [a, b, c, d] = n as [Person, Person, Person, Person];
    await setAway(f.managerB, { mainNomineeUserId: a.userId });
    await setAway(a, { mainNomineeUserId: b.userId });
    await setAway(b, { mainNomineeUserId: c.userId });
    await setAway(c, { mainNomineeUserId: d.userId });
    const p = await kit.start(claims, f.employee);
    expect(await firstStep(p.id)).toMatchObject({
      assigneeUserId: c.userId,
      delegatedFromUserId: f.managerB.userId,
    });
    const delegate = (await kit.actions(p.id)).find((x) => x.action === 'DELEGATE');
    expect(delegate?.metadata).toMatchObject({
      outcome: 'HOP_LIMIT',
      chain: [f.managerB.userId, a.userId, b.userId, c.userId],
    });
  });

  it('falls back to the original assignee on a cycle and alerts HR', async () => {
    const [a] = n as [Person];
    await setAway(f.managerB, { mainNomineeUserId: a.userId });
    await setAway(a, { mainNomineeUserId: f.managerB.userId });
    const p = await kit.start(claims, f.employee);
    expect(await firstStep(p.id)).toMatchObject({
      assigneeUserId: f.managerB.userId,
      delegatedFromUserId: null,
    });
    expect((await kit.actions(p.id)).some((x) => x.action === 'DELEGATE')).toBe(false);
    const [cycle] = await auditSince(t.db, 0n, {
      entityId: String(p.id),
      action: 'WORKFLOW.DELEGATION_CYCLE',
    });
    expect(cycle?.metadata).toMatchObject({ chain: [f.managerB.userId, a.userId, f.managerB.userId] });
    await kit.publish();
    expect((await kit.notifications(f.hrAdmin.userId, p.id)).map((x) => x.kind)).toContain(
      'WORKFLOW_DELEGATION_CYCLE',
    );
  });

  it('never delegates to the applicant', async () => {
    await setAway(f.managerB, { mainNomineeUserId: f.employee.userId });
    const p = await kit.start(claims, f.employee);
    expect(await firstStep(p.id)).toMatchObject({
      assigneeUserId: f.managerB.userId,
      delegatedFromUserId: null,
    });
  });

  it('follows approved leave in WHILE_ON_LEAVE mode', async () => {
    await t.db.tx(systemContext('test-leave-type'), (tx) =>
      tx.leaveType.upsert({
        where: { id: TEST_LEAVE_TYPE_ID },
        update: {},
        create: {
          id: TEST_LEAVE_TYPE_ID,
          code: 'TEST_OOO',
          description: 'Test leave (out of office)',
          isActive: false,
        },
      }),
    );
    const leave = await t.db.tx(systemContext('test-leave'), async (tx) =>
      tx.leaveApplication.create({
        data: {
          referenceNumber: `TEST-OOO-${await nextUnique(t.db)}`,
          employeeId: f.managerB.employeeId ?? 0,
          leaveTypeId: TEST_LEAVE_TYPE_ID,
          fromDate: dateFromBusiness(addDays(today, -1)),
          toDate: dateFromBusiness(addDays(today, 1)),
          unitsTaken: '3',
          status: 'APPROVED_PENDING_PROCESS',
        },
      }),
    );
    await setAway(f.managerB, {
      mode: 'WHILE_ON_LEAVE',
      fromDate: null,
      toDate: null,
      mainNomineeUserId: f.managerA.userId,
    });
    expect((await ooo.get(contextFor(f.managerB))).isOutOfOfficeNow).toBe(true);
    const away = await kit.start(claims, f.employee);
    expect((await firstStep(away.id))?.assigneeUserId).toBe(f.managerA.userId);

    await t.db.tx(systemContext('test-leave'), (tx) =>
      tx.leaveApplication.update({ where: { id: leave.id }, data: { status: 'CANCELLED' } }),
    );
    expect((await ooo.get(contextFor(f.managerB))).isOutOfOfficeNow).toBe(false);
    const back = await kit.start(claims, f.employee);
    expect((await firstStep(back.id))?.assigneeUserId).toBe(f.managerB.userId);
  });

  it('delegates a reassigned step when the new approver is away', async () => {
    const [a, b] = n as [Person, Person];
    const p = await kit.start(claims, f.employee);
    await setAway(a, { mainNomineeUserId: b.userId });
    await (
      await login(t, f.managerB)
    )
      .post(`/workflow/processes/${p.id}/reassign`)
      .send({ version: p.version, toUserId: a.userId })
      .expect(200);
    const open = (await kit.instances(p.id)).filter((i) => i.status === 'PENDING');
    expect(open).toMatchObject([{ assigneeUserId: b.userId, delegatedFromUserId: a.userId }]);
    expect((await kit.actions(p.id)).map((x) => x.action).slice(-2)).toEqual(['REASSIGN', 'DELEGATE']);
  });
});
