import {
  addDays,
  type BusinessDate,
  isWeekend,
  LEAVE_PROBLEM_TYPES,
  type LeaveApplicationDetail,
  todayBusinessDate,
} from '@peoplehub/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HolidayService } from '../../src/modules/holidays/holiday.service';
import { LeaveService } from '../../src/modules/leave/leave.service';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  auditSince,
  createPerson,
  createRoleFixtures,
  lastAuditId,
  login,
  type Person,
  type RoleFixtures,
} from '../support/fixtures';
import { LEAVE_TYPE, LeaveKit } from '../support/leave';
import { contextFor, WorkflowKit } from '../support/workflow';

describe('leave API (sections 5.2 and 12.3)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let leave: LeaveKit;
  let emp: Agent;
  let mgr: Agent;
  let hr: Agent;
  let reasons: Record<string, number>;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    leave = new LeaveKit(t, kit);
    await leave.setup(f.org);
    await leave.accrue([f.employee.employeeId, f.employee2.employeeId]);
    [emp, mgr, hr] = await Promise.all([login(t, f.employee), login(t, f.managerB), login(t, f.hrAdmin)]);
    const rows = await t.db.prisma.leaveReason.findMany();
    reasons = Object.fromEntries(rows.map((r) => [`${r.leaveTypeId}:${r.code}`, r.id]));
  });

  afterAll(async () => {
    kit.restore();
    await t.close();
  });

  /** A fresh employee reporting to manager B, with accrued balances. */
  async function freshEmployee(): Promise<{ person: Person; agent: Agent }> {
    const person = await createPerson(t.db, {
      org: f.org,
      label: 'leave-emp',
      reportsToId: f.managerB.employeeId,
    });
    await leave.accrue([person.employeeId]);
    return { person, agent: await login(t, person) };
  }

  async function approve(agent: Agent, processId: number): Promise<void> {
    const p = await kit.process(processId);
    const res = await agent.post(`/workflow/processes/${processId}/approve`).send({ version: p.version });
    expect(res.status, res.text).toBe(200);
  }

  it('lists the leave types with a policy and their reasons', async () => {
    const res = await emp.get('/leave/types').expect(200);
    const types = res.body.items as {
      id: number;
      code: string;
      colour: string | null;
      hasReasons: boolean;
    }[];
    expect(types.map((x) => [x.id, x.code])).toEqual(
      expect.arrayContaining([
        [1, 'ANN_LVE'],
        [2, 'SICK_LVE'],
        [6, 'STUDY'],
        [12, 'UN_SICK'],
        [13, 'LIEU_LVE'],
      ]),
    );
    expect(types.find((x) => x.id === 1)).toMatchObject({
      colour: '#C0FFC0',
      hasReasons: true,
      policy: {
        definitionName: 'Annual Leave',
        entitlementPerCycle: '20.0000',
        accrualMethod: 'MONTHLY_PRO_RATA',
      },
    });
    const sick = (await emp.get('/leave/types/2/reasons').expect(200)).body;
    expect(sick.mandatoryReason).toBe(true);
    expect(sick.items.map((r: { description: string }) => r.description)).toEqual(
      expect.arrayContaining(['Illness', 'Family Illness']),
    );
    await emp.get('/leave/types/9999/reasons').expect(404);
    // Another employee's types are only for those who may act for them.
    await (await login(t, f.employee2)).get(`/leave/types?employeeId=${f.employee.employeeId}`).expect(403);
    await mgr.get(`/leave/types?employeeId=${f.employee.employeeId}`).expect(200);
  });

  it('calculates units and the balance panel; a holiday-only range is 422', async () => {
    const start = await leave.monday(30, f.org.companyId);
    const res = await emp
      .post('/leave/calculate')
      .send({
        leaveTypeId: LEAVE_TYPE.annual,
        fromDate: start,
        toDate: addDays(start, 6),
        startPortion: 'PM',
      })
      .expect(200);
    expect(res.body).toMatchObject({
      units: '4.5000',
      available: '16.6670',
      toBeDeducted: '4.5000',
      remaining: '12.1670',
      unitLabel: 'Days',
      wouldGoNegative: false,
      attachmentRequired: false,
    });
    expect(res.body.days[0]).toEqual({ date: start, portion: 'PM', units: '0.5000' });
    expect(res.body.excludedDays.filter((d: { reason: string }) => d.reason === 'WEEKEND')).toHaveLength(2);
    // Good Friday to Easter Monday (next year): only a holiday, a weekend and a holiday.
    const holidays = await t.app.get(HolidayService).between(null, '2027-03-01', '2027-04-30');
    const goodFriday = holidays.find((h) => h.name === 'Good Friday')?.date ?? '';
    const zero = await emp
      .post('/leave/calculate')
      .send({ leaveTypeId: LEAVE_TYPE.annual, fromDate: goodFriday, toDate: addDays(goodFriday, 3) })
      .expect(422);
    expect(zero.body.type).toBe(LEAVE_PROBLEM_TYPES.noWorkingDays);
    await emp
      .post('/leave/calculate')
      .send({ leaveTypeId: LEAVE_TYPE.annual, fromDate: start, toDate: addDays(start, -1) })
      .expect(422);
  });

  it('rejects overlapping applications at half-day granularity', async () => {
    const { person, agent } = await freshEmployee();
    const start = await leave.monday(40, f.org.companyId);
    await leave.submit(agent, { leaveTypeId: LEAVE_TYPE.annual, fromDate: start, toDate: addDays(start, 2) });
    const clash = await agent
      .post('/leave/applications')
      .send({ leaveTypeId: LEAVE_TYPE.annual, fromDate: addDays(start, 2), toDate: addDays(start, 3) });
    expect(clash.status).toBe(422);
    expect(clash.body.type).toBe(LEAVE_PROBLEM_TYPES.overlap);
    expect(clash.body.errors[0].path).toBe('fromDate');
    // The morning and the afternoon of one day can be two applications (any type).
    const day = addDays(start, 7);
    await leave.submit(agent, {
      leaveTypeId: LEAVE_TYPE.annual,
      fromDate: day,
      toDate: day,
      startPortion: 'AM',
    });
    await leave.submit(agent, {
      leaveTypeId: LEAVE_TYPE.unpaid,
      fromDate: day,
      toDate: day,
      startPortion: 'PM',
      leaveReasonId: reasons['9:PERSONAL'],
    });
    const third = await agent
      .post('/leave/applications')
      .send({ leaveTypeId: LEAVE_TYPE.annual, fromDate: day, toDate: day, startPortion: 'PM' });
    expect(third.status).toBe(422);
    expect(person.employeeId).not.toBeNull();
  });

  it('enforces backdating except for HR_ADMIN, mandatory reasons, comments and the balance', async () => {
    const { person, agent } = await freshEmployee();
    let monday = addDays(todayBusinessDate(), -40);
    while (isWeekend(monday)) monday = addDays(monday, 1);
    const backdated = {
      leaveTypeId: LEAVE_TYPE.unpaid,
      fromDate: monday,
      toDate: monday,
      leaveReasonId: reasons['9:PERSONAL'],
    };
    const res = await agent.post('/leave/applications').send(backdated);
    expect(res.status).toBe(422);
    expect(res.body.errors.map((x: { path: string }) => x.path)).toEqual(['fromDate']);
    // HR_ADMIN may backdate (for an employee in their company).
    await leave.submit(hr, { ...backdated, employeeId: person.employeeId });

    const start = await leave.monday(60, f.org.companyId);
    const noReason = await agent
      .post('/leave/applications')
      .send({ leaveTypeId: LEAVE_TYPE.unpaid, fromDate: start, toDate: start });
    expect(noReason.status).toBe(422);
    expect(noReason.body.errors.map((x: { path: string }) => x.path)).toEqual(['leaveReasonId']);
    const longComment = await agent
      .post('/leave/applications')
      .send({ leaveTypeId: LEAVE_TYPE.annual, fromDate: start, toDate: start, comment: 'x'.repeat(1001) });
    expect(longComment.status).toBe(422);
    expect(longComment.body.errors[0].path).toBe('comment');
    const tooMuch = await leave.range(start, 18, f.org.companyId);
    const balance = await agent
      .post('/leave/applications')
      .send({ leaveTypeId: LEAVE_TYPE.annual, ...tooMuch });
    expect(balance.status).toBe(422);
    expect(balance.body.type).toBe(LEAVE_PROBLEM_TYPES.insufficientBalance);
    expect(balance.body.errors[0]).toMatchObject({ path: 'units' });
  });

  it('requires an attachment above the type threshold and binds it on submit', async () => {
    const { person, agent } = await freshEmployee();
    const range = await leave.range(await leave.monday(70, f.org.companyId), 3, f.org.companyId);
    const body = {
      leaveTypeId: LEAVE_TYPE.sick,
      ...range,
      leaveReasonId: reasons['2:ILLNESS'],
      noteSubmitted: true,
    };
    const missing = await agent.post('/leave/applications').send(body);
    expect(missing.status).toBe(422);
    expect(missing.body.errors.map((x: { path: string }) => x.path)).toEqual(['attachmentIds']);
    const attachmentId = await leave.upload(agent, 'sick-note.pdf');
    const app = await leave.submit(agent, { ...body, attachmentIds: [attachmentId] });
    expect(app.noteSubmitted).toBe(true);
    expect(app.attachments.map((a) => [a.id, a.isBound, a.ownerEntity])).toEqual([
      [attachmentId, true, 'LeaveApplication'],
    ]);
    // The same upload cannot be attached twice.
    const reuse = await agent.post('/leave/applications').send({
      ...body,
      ...(await leave.range(addDays(range.toDate, 10), 3, f.org.companyId)),
      attachmentIds: [attachmentId],
    });
    expect(reuse.status).toBe(422);
    expect(reuse.body.errors[0].path).toBe('attachmentIds.0');
    // Someone else's upload cannot be attached either.
    const other = await leave.upload(mgr);
    const foreign = await agent.post('/leave/applications').send({
      ...body,
      ...(await leave.range(addDays(range.toDate, 20), 3, f.org.companyId)),
      attachmentIds: [other],
    });
    expect(foreign.status).toBe(422);
    expect(person.employeeId).not.toBeNull();
  });

  it('replays a submit with the same Idempotency-Key', async () => {
    const { person, agent } = await freshEmployee();
    const start = await leave.monday(80, f.org.companyId);
    const key = randomUUID();
    const body = { leaveTypeId: LEAVE_TYPE.annual, fromDate: start, toDate: start };
    const first = await agent.post('/leave/applications').set('idempotency-key', key).send(body).expect(201);
    const replay = await agent.post('/leave/applications').set('idempotency-key', key).send(body).expect(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(await t.db.prisma.leaveApplication.count({ where: { employeeId: person.employeeId ?? 0 } })).toBe(
      1,
    );
  });

  it('withdraws an untouched application, releasing its reservation; 409 on a stale version', async () => {
    const { agent } = await freshEmployee();
    const start = await leave.monday(90, f.org.companyId);
    const app = await leave.submit(agent, {
      leaveTypeId: LEAVE_TYPE.annual,
      fromDate: start,
      toDate: addDays(start, 1),
    });
    await agent
      .post(`/leave/applications/${app.id}/cancel`)
      .send({ version: app.version + 5 })
      .expect(409);
    const since = await lastAuditId(t.db);
    const res = await agent
      .post(`/leave/applications/${app.id}/cancel`)
      .send({ version: app.version, comment: 'Not needed' });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({
      outcome: 'WITHDRAWN',
      application: { status: 'CANCELLED' },
      cancellation: null,
    });
    const actions = (await auditSince(t.db, since)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['LEAVE.WITHDRAWN', 'WORKFLOW.WITHDRAWN']));
    const allocations = await t.db.prisma.leaveApplicationAllocation.findMany({
      where: { applicationId: app.id },
    });
    expect(allocations.every((a) => a.releasedAt !== null)).toBe(true);
    const cards = (await agent.get('/leave/balances').expect(200)).body.items;
    expect(cards.find((c: { leaveTypeId: number }) => c.leaveTypeId === 1)).toMatchObject({
      pending: '0.0000',
    });
    // A withdrawn application cannot be cancelled again.
    await agent
      .post(`/leave/applications/${app.id}/cancel`)
      .send({ version: app.version + 1 })
      .expect(409);
  });

  it('cancels approved leave that was not processed by releasing it on approval', async () => {
    const { person, agent } = await freshEmployee();
    const start = await leave.monday(100, f.org.companyId);
    const app = await leave.submit(agent, {
      leaveTypeId: LEAVE_TYPE.annual,
      fromDate: start,
      toDate: addDays(start, 1),
    });
    await approve(mgr, app.processId ?? 0);
    // Once a step is actioned, cancelling needs a CANCELLEAVE request.
    const current = await t.db.prisma.leaveApplication.findUniqueOrThrow({ where: { id: app.id } });
    const res = await agent.post(`/leave/applications/${app.id}/cancel`).send({ version: current.version });
    expect(res.body.outcome).toBe('CANCELLATION_REQUESTED');
    const cancelProcess = res.body.cancellation.processId as number;
    await approve(mgr, cancelProcess);
    await approve(hr, cancelProcess);
    const original = await t.db.prisma.leaveApplication.findUniqueOrThrow({
      where: { id: app.id },
      include: { process: true },
    });
    expect(original.status).toBe('CANCELLED');
    expect(original.process?.status).toBe('CANCELLED');
    const taken = await t.db.prisma.leaveLedgerEntry.count({ where: { leaveApplicationId: app.id } });
    expect(taken).toBe(0);
    expect(person.employeeId).not.toBeNull();
  });

  it('scopes reads: an employee cannot read another employee’s leave; their manager and HR can', async () => {
    const start = await leave.monday(110, f.org.companyId);
    const app = await leave.submit(emp, { leaveTypeId: LEAVE_TYPE.annual, fromDate: start, toDate: start });
    const other = await login(t, f.employee2);
    const since = await lastAuditId(t.db);
    const denied = await other.get(`/leave/applications/${app.id}`);
    expect(denied.status).toBe(403);
    const rows = await auditSince(t.db, since, { requestId: denied.headers['x-request-id'] as string });
    expect(rows.some((r) => r.outcome === 'DENIED')).toBe(true);
    await other.get(`/leave/applications?employeeId=${f.employee.employeeId}`).expect(403);
    await other.get(`/leave/balances?employeeId=${f.employee.employeeId}`).expect(403);
    await (await login(t, f.unrelated)).get(`/leave/applications/${app.id}`).expect(403);
    await mgr.get(`/leave/applications/${app.id}`).expect(200);
    await mgr.get(`/leave/applications?employeeId=${f.employee.employeeId}`).expect(200);
    await mgr.get(`/leave/balances/1/definitions?employeeId=${f.employee.employeeId}`).expect(200);
    await hr.get(`/leave/applications/${app.id}`).expect(200);
    await (await login(t, f.auditor)).get(`/leave/applications/${app.id}`).expect(200);
    await (await login(t, f.otherCompany)).get(`/leave/applications/${app.id}`).expect(403);
    // Applying "for" someone needs the Working-as rule.
    await other
      .post('/leave/applications')
      .send({ employeeId: f.employee.employeeId, leaveTypeId: 1, fromDate: start, toDate: start })
      .expect(403);
  });

  it('lets HR override the units with a reason (audited) and nobody else', async () => {
    const { person, agent } = await freshEmployee();
    const start = await leave.monday(120, f.org.companyId);
    const body = {
      leaveTypeId: LEAVE_TYPE.annual,
      fromDate: start,
      toDate: addDays(start, 2),
      overrideUnits: true,
      units: '2.5',
      overrideReason: 'Agreed with the employee',
    };
    await agent.post('/leave/applications').send(body).expect(403);
    const since = await lastAuditId(t.db);
    const app = await leave.submit(hr, { ...body, employeeId: person.employeeId });
    expect(app).toMatchObject({
      unitsTaken: '2.5000',
      unitsOverridden: true,
      overrideReason: 'Agreed with the employee',
    });
    expect(app.days).toHaveLength(3);
    const override = await auditSince(t.db, since, { action: 'LEAVE.UNITS_OVERRIDDEN' });
    expect(override[0]).toMatchObject({ reason: 'Agreed with the employee' });
    expect(override[0]?.metadata).toMatchObject({ calculated: '3.0000', override: '2.5000' });
  });

  it('resubmits a sent-back request with new dates and recalculates it', async () => {
    const { agent } = await freshEmployee();
    const start = await leave.monday(130, f.org.companyId);
    const app = await leave.submit(agent, {
      leaveTypeId: LEAVE_TYPE.annual,
      fromDate: start,
      toDate: addDays(start, 2),
    });
    const p = await kit.process(app.processId ?? 0);
    await mgr
      .post(`/workflow/processes/${p.id}/send-back`)
      .send({ version: p.version, comment: 'Take one day less' })
      .expect(200);
    expect((await t.db.prisma.leaveApplication.findUniqueOrThrow({ where: { id: app.id } })).status).toBe(
      'RESUBMIT_REQUIRED',
    );
    const sent = await kit.process(p.id);
    const bad = await agent
      .post(`/workflow/processes/${p.id}/resubmit`)
      .send({ version: sent.version, changes: { units: '1' } });
    expect(bad.status).toBe(422);
    await agent
      .post(`/workflow/processes/${p.id}/resubmit`)
      .send({ version: sent.version, changes: { toDate: addDays(start, 1), comment: 'Two days' } })
      .expect(200);
    const after = (await agent.get(`/leave/applications/${app.id}`).expect(200))
      .body as LeaveApplicationDetail;
    expect(after).toMatchObject({
      status: 'IN_PROGRESS',
      unitsTaken: '2.0000',
      toDate: addDays(start, 1),
      comment: 'Two days',
    });
    expect(after.days).toHaveLength(2);
    expect(after.allocations.filter((a) => !a.released).map((a) => a.units)).toEqual(['2.0000']);
    expect(after.allocations.filter((a) => a.released).map((a) => a.units)).toEqual(['3.0000']);
  });

  it('warns the approver when approving takes the balance negative', async () => {
    const { agent } = await freshEmployee();
    const start = await leave.monday(140, f.org.companyId);
    const app = await leave.submit(agent, {
      leaveTypeId: LEAVE_TYPE.unpaid,
      fromDate: start,
      toDate: addDays(start, 1),
      leaveReasonId: reasons['9:PERSONAL'],
    });
    const detail = (await mgr.get(`/inbox/items/${app.processId}`).expect(200)).body;
    expect(detail.warnings).toEqual([expect.objectContaining({ code: 'NEGATIVE_BALANCE' })]);
    expect(detail.warnings[0].message).toContain('-2.0000 Days');
  });

  it('refuses leave for an employee who is not active', async () => {
    const { person, agent } = await freshEmployee();
    await t.db.tx(contextFor(f.hrAdmin), (tx) =>
      tx.employee.update({ where: { id: person.employeeId ?? 0 }, data: { status: 'SUSPENDED' } }),
    );
    const start = await leave.monday(150, f.org.companyId);
    const res = await agent
      .post('/leave/applications')
      .send({ leaveTypeId: LEAVE_TYPE.annual, fromDate: start, toDate: start });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((x: { path: string }) => x.path)).toContain('employeeId');
  });

  it('gives 100 parallel submits 100 unique reference numbers', async () => {
    const person = await createPerson(t.db, {
      org: f.org,
      label: 'parallel',
      reportsToId: f.managerB.employeeId,
    });
    const holidays = await t.app
      .get(HolidayService)
      .calendar(f.org.companyId, todayBusinessDate(), addDays(todayBusinessDate(), 400));
    const days: BusinessDate[] = [];
    for (let d = await leave.monday(7, f.org.companyId); days.length < 100; d = addDays(d, 1)) {
      if (!isWeekend(d) && !holidays.has(d)) days.push(d);
    }
    const ctx = contextFor(person);
    const service = t.app.get(LeaveService);
    const results = await Promise.all(
      days.map((day) =>
        service.submit(ctx, {
          leaveTypeId: LEAVE_TYPE.unpaid,
          fromDate: day,
          toDate: day,
          startPortion: 'FULL',
          endPortion: 'FULL',
          leaveReasonId: reasons['9:PERSONAL'],
          noteSubmitted: false,
          attachmentIds: [],
          overrideUnits: false,
        }),
      ),
    );
    const refs = results.map((r) => r.referenceNumber);
    expect(new Set(refs).size).toBe(100);
    const seqs = refs.map((r) => Number(r.slice(-5))).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(refs.every((r) => r.includes('-T0009-'))).toBe(true);
  }, 180_000);
});
