import {
  addDays,
  businessFromDate,
  type CreditLeaveRow,
  dateFromBusiness,
  isoWeekday,
  startOfMonth,
  todayBusinessDate,
  units4,
} from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import { OutboxService } from '../../src/events/outbox.service';
import { LEAVE_JOBS } from '../../src/modules/leave/leave-jobs.service';
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
import { WorkflowKit } from '../support/workflow';

describe('leave jobs and leave in lieu (section 5.2.4–5.2.5)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let leave: LeaveKit;
  let payPeriodId: number;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    leave = new LeaveKit(t, kit);
    ({ payPeriodId } = await leave.setup(f.org));
  });

  afterAll(async () => {
    kit.restore();
    await t.close();
  });

  const ledger = (employeeId: number | null, leaveTypeId: number) =>
    t.db.prisma.leaveLedgerEntry.findMany({
      where: { employeeId: employeeId ?? 0, leaveTypeId },
      orderBy: { id: 'asc' },
      include: { entitlement: true },
    });

  it('accrues monthly with first- and last-month pro-rata and posts UPFRONT entitlements; a re-run posts nothing', async () => {
    const monthStart = startOfMonth(todayBusinessDate());
    const engaged = addDays(monthStart, 15);
    const joiner = await createPerson(t.db, {
      org: f.org,
      label: 'joiner',
      employee: { dateEngaged: dateFromBusiness(engaged) },
    });
    const since = await lastAuditId(t.db);
    const counts = await leave.accrue([joiner.employeeId], monthStart);
    expect(counts).toMatchObject({ employees: 1 });
    expect(Number(counts.bucketsOpened)).toBeGreaterThan(0);
    // Engaged on the 16th: no accrual before the engagement month is reached.
    expect((await ledger(joiner.employeeId, LEAVE_TYPE.annual)).length).toBe(0);
    await leave.accrue([joiner.employeeId], addDays(monthStart, 20));
    const annual = await ledger(joiner.employeeId, LEAVE_TYPE.annual);
    const days = Number(
      businessFromDate(
        new Date(Date.UTC(Number(monthStart.slice(0, 4)), Number(monthStart.slice(5, 7)), 0)),
      ).slice(8, 10),
    );
    const expected = units4((20 / 12) * ((days - 15) / days));
    expect(annual.map((e) => [e.entryType, businessFromDate(e.effectiveDate), units4(e.units)])).toEqual([
      ['ACCRUAL', engaged, expected],
    ]);
    expect(annual[0]?.entitlement.cycleStartDate.toISOString().slice(0, 10)).toBe(engaged);
    const study = await ledger(joiner.employeeId, LEAVE_TYPE.study);
    expect(study.map((e) => [e.entryType, units4(e.units)])).toEqual([['ACCRUAL', '12.0000']]);
    const audited = await auditSince(t.db, since, {
      action: 'LEAVE.ACCRUED',
      subjectEmployeeId: joiner.employeeId,
    });
    expect(audited.length).toBeGreaterThanOrEqual(2);

    // Idempotent: the same period again posts nothing.
    const again = await leave.accrue([joiner.employeeId], addDays(monthStart, 20));
    expect(again).toMatchObject({ accrualsPosted: 0, bucketsOpened: 0 });
    const runs = await auditSince(t.db, since, { action: 'SYSTEM.JOB_RUN', entityId: LEAVE_JOBS.accrue });
    expect(runs.at(-1)?.metadata).toMatchObject({ counts: { accrualsPosted: 0 } });
  });

  it('pro-rates the last month by the termination date', async () => {
    const leaver = await createPerson(t.db, {
      org: f.org,
      label: 'leaver',
      employee: { terminationDate: dateFromBusiness('2026-02-10') },
    });
    await leave.accrue([leaver.employeeId], '2026-02-01');
    const annual = await ledger(leaver.employeeId, LEAVE_TYPE.annual);
    expect(annual.map((e) => [businessFromDate(e.effectiveDate), units4(e.units)])).toEqual([
      ['2026-01-01', '1.6667'],
      ['2026-02-01', '0.5952'],
    ]);
    await leave.accrue([leaver.employeeId], '2026-03-01');
    expect(await ledger(leaver.employeeId, LEAVE_TYPE.annual)).toHaveLength(2);
  });

  it('rolls a cycle over: carries up to the cap, forfeits the excess, expires the carry forward', async () => {
    const person = await createPerson(t.db, { org: f.org, label: 'rollover' });
    await leave.accrue([person.employeeId], '2025-06-15');
    const before = await ledger(person.employeeId, LEAVE_TYPE.annual);
    expect(before.map((e) => units4(e.units))).toEqual(Array(6).fill('1.6667'));
    const old = before[0]?.entitlement;
    expect(old && businessFromDate(old.cycleEndDate)).toBe('2025-12-31');

    const since = await lastAuditId(t.db);
    const counts = await kit.jobs.runNow(LEAVE_JOBS.cycleRollover, { employeeIds: [person.employeeId] });
    expect(Number(counts.bucketsRolled)).toBeGreaterThanOrEqual(1);
    const after = await ledger(person.employeeId, LEAVE_TYPE.annual);
    const moves = after
      .filter((e) => e.entryType !== 'ACCRUAL')
      .map((e) => [e.entryType, units4(e.units), e.entitlement.kind, businessFromDate(e.effectiveDate)]);
    expect(moves).toEqual([
      ['CARRY_FORWARD_OUT', '-5.0000', 'CYCLE', '2025-12-31'],
      ['CARRY_FORWARD_IN', '5.0000', 'CARRY_FORWARD', '2026-01-01'],
      ['FORFEIT', '-5.0002', 'CYCLE', '2025-12-31'],
    ]);
    const buckets = await t.db.prisma.employeeLeaveEntitlement.findMany({
      where: { employeeId: person.employeeId ?? 0, leaveTypeId: LEAVE_TYPE.annual },
      orderBy: { id: 'asc' },
    });
    const carry = buckets.find((b) => b.kind === 'CARRY_FORWARD');
    expect(carry).toMatchObject({ definitionName: 'Carry Forward Leave', isClosed: false });
    expect(carry?.expiresOn && businessFromDate(carry.expiresOn)).toBe('2026-06-30');
    expect(buckets.find((b) => b.id === old?.id)?.isClosed).toBe(true);
    expect(
      buckets.some(
        (b) => b.kind === 'CYCLE' && !b.isClosed && businessFromDate(b.cycleStartDate) === '2026-01-01',
      ),
    ).toBe(true);
    const actions = (await auditSince(t.db, since, { subjectEmployeeId: person.employeeId })).map(
      (r) => r.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['LEAVE.CARRIED_FORWARD', 'LEAVE.FORFEITED', 'LEAVE.ENTITLEMENT_CLOSED']),
    );
    // Idempotent.
    const again = await kit.jobs.runNow(LEAVE_JOBS.cycleRollover, { employeeIds: [person.employeeId] });
    expect(again).toMatchObject({ bucketsRolled: 0 });

    // The carry forward expired on 30 Jun 2026.
    const expiry = await kit.jobs.runNow(LEAVE_JOBS.carryForwardExpiry, { employeeIds: [person.employeeId] });
    expect(expiry).toMatchObject({ expired: 1, forfeitedEntries: 1, unitsForfeited: '5.0000', closed: 1 });
    const forfeit = (await ledger(person.employeeId, LEAVE_TYPE.annual)).at(-1);
    expect([
      forfeit?.entryType,
      units4(forfeit?.units ?? 0),
      businessFromDate(forfeit?.effectiveDate ?? new Date()),
    ]).toEqual(['FORFEIT', '-5.0000', '2026-07-01']);
    expect(
      await kit.jobs.runNow(LEAVE_JOBS.carryForwardExpiry, { employeeIds: [person.employeeId] }),
    ).toMatchObject({ expired: 0 });
  });

  describe('leave in lieu', () => {
    let emp: Agent;
    let mgr: Agent;
    let hr: Agent;
    let payroll: Agent;

    beforeAll(async () => {
      [emp, mgr, hr, payroll] = await Promise.all([
        login(t, f.employee),
        login(t, f.managerB),
        login(t, f.hrAdmin),
        login(t, f.payrollAdmin),
      ]);
    });

    function lastSaturday(): string {
      let d = addDays(todayBusinessDate(), -1);
      while (isoWeekday(d) !== 6) d = addDays(d, -1);
      return d;
    }

    async function approveAll(processId: number, agents: Agent[]): Promise<void> {
      for (const agent of agents) {
        const p = await kit.process(processId);
        const res = await agent.post(`/workflow/processes/${processId}/approve`).send({ version: p.version });
        expect(res.status, res.text).toBe(200);
      }
    }

    it('credits a processed request with an expiry, and the nightly job forfeits expired credit', async () => {
      const worked = lastSaturday();
      const bad = await emp
        .post('/leave/in-lieu')
        .send({ kind: 'REQUEST', workedFrom: worked, workedTo: worked, units: '2', reason: 'Stock take' });
      expect(bad.status).toBe(422);
      expect(bad.body.errors[0].path).toBe('units');
      const future = addDays(todayBusinessDate(), 7);
      await emp
        .post('/leave/in-lieu')
        .send({ kind: 'REQUEST', workedFrom: future, workedTo: future, units: '1', reason: 'x' })
        .expect(422);
      const attachmentId = await leave.upload(emp, 'roster.pdf');
      const res = await emp.post('/leave/in-lieu').send({
        kind: 'REQUEST',
        workedFrom: worked,
        workedTo: worked,
        units: '1',
        reason: 'Stock take',
        attachmentIds: [attachmentId],
      });
      expect(res.status, res.text).toBe(201);
      const row = res.body as CreditLeaveRow;
      expect(row).toMatchObject({
        kind: 'REQUEST',
        status: 'IN_PROGRESS',
        units: '1.0000',
        leaveType: { id: LEAVE_TYPE.lieu },
      });
      expect(row.referenceNumber).toMatch(/^L\d{6}-T0013-N\d{5}$/);
      expect(row.attachments.map((a) => a.id)).toEqual([attachmentId]);
      const processId = row.processId ?? 0;
      expect((await kit.process(processId)).workflowTypeId).toBe(
        (await t.db.prisma.workflowType.findUniqueOrThrow({ where: { code: 'CREDITLVEREQ' } })).id,
      );
      await approveAll(processId, [mgr, hr]);
      const since = await lastAuditId(t.db);
      const processed = await payroll
        .post('/workflow/processes/process')
        .send({ ids: [processId], payPeriodId });
      expect(processed.body.results[0], processed.text).toMatchObject({ ok: true });
      expect((await auditSince(t.db, since)).map((r) => r.action)).toEqual(
        expect.arrayContaining([
          'LEAVE.CREDIT_ALLOCATED',
          'LEAVE_IN_LIEU.PROCESSED',
          'LEAVE.ENTITLEMENT_OPENED',
        ]),
      );
      const credit = await ledger(f.employee.employeeId, LEAVE_TYPE.lieu);
      expect(credit.map((e) => [e.entryType, units4(e.units), e.entitlement.kind])).toEqual([
        ['CREDIT_ALLOCATION', '1.0000', 'CREDIT'],
      ]);
      const bucket = credit[0]?.entitlement;
      const effective = businessFromDate(credit[0]?.effectiveDate ?? new Date());
      expect(bucket?.expiresOn && businessFromDate(bucket.expiresOn)).toBe(addDays(effective, 90));
      const listed = (await emp.get('/leave/in-lieu').expect(200)).body.items as CreditLeaveRow[];
      expect(listed.find((r) => r.id === row.id)).toMatchObject({
        status: 'PROCESSED',
        expiresOn: addDays(effective, 90),
      });
      const cards = (await emp.get('/leave/balances').expect(200)).body.items;
      expect(
        cards.find((c: { leaveTypeId: number }) => c.leaveTypeId === LEAVE_TYPE.lieu)?.actualAvailable,
      ).toBe('1.0000');

      // Expired credit is forfeited by the nightly job.
      const expiry = await kit.jobs.runNow(LEAVE_JOBS.creditExpiry, {
        employeeIds: [f.employee.employeeId],
        asOf: addDays(effective, 91),
      });
      expect(expiry).toMatchObject({ expired: 1, unitsForfeited: '1.0000', closed: 1 });
      const after = await ledger(f.employee.employeeId, LEAVE_TYPE.lieu);
      expect(after.map((e) => [e.entryType, units4(e.units)])).toEqual([
        ['CREDIT_ALLOCATION', '1.0000'],
        ['FORFEIT', '-1.0000'],
      ]);
    });

    it('lets a manager allocate credit to a report (CREDITLVEALLOC), but nobody to themselves', async () => {
      const worked = lastSaturday();
      const body = {
        kind: 'ALLOCATION',
        employeeId: f.employee2.employeeId,
        workedFrom: worked,
        workedTo: worked,
        units: '0.5',
        reason: 'Weekend support',
      };
      await emp.post('/leave/in-lieu').send(body).expect(403);
      await mgr
        .post('/leave/in-lieu')
        .send({ ...body, employeeId: f.managerB.employeeId })
        .expect(403);
      const res = await mgr.post('/leave/in-lieu').send(body);
      expect(res.status, res.text).toBe(201);
      expect(res.body).toMatchObject({
        kind: 'ALLOCATION',
        kindLabel: 'Leave in Lieu Allocation',
        employee: { id: f.employee2.employeeId },
      });
      const p = await kit.process(res.body.processId);
      expect(p.workflowTypeId).toBe(
        (await t.db.prisma.workflowType.findUniqueOrThrow({ where: { code: 'CREDITLVEALLOC' } })).id,
      );
      // The manager submitted it, so their own REPORTS_TO step is skipped: HR approves.
      expect(p.currentStepNo).toBe(2);
      const mine = (await mgr.get('/leave/in-lieu').expect(200)).body.items as CreditLeaveRow[];
      expect(mine.map((r) => r.id)).toContain(res.body.id);
      const theirs = (await (await login(t, f.employee2)).get('/leave/in-lieu?kind=ALLOCATION').expect(200))
        .body.items as CreditLeaveRow[];
      expect(theirs.map((r) => r.id)).toContain(res.body.id);
      expect(hr).toBeDefined();
    });
  });

  it('accrues for the next period when a pay period closes', async () => {
    const period = await t.db.prisma.payPeriod.findUniqueOrThrow({ where: { id: payPeriodId } });
    const since = await lastAuditId(t.db);
    await t.db.tx(systemContext('test-pay-period-close'), async (tx) => {
      await t.app.get(OutboxService).add(tx, 'payPeriod.closed', { payPeriodId: period.id });
    });
    await kit.publish();
    const asOf = addDays(businessFromDate(period.endDate), 1);
    let run;
    for (let i = 0; i < 100 && !run; i++) {
      run = (await auditSince(t.db, since, { action: 'SYSTEM.JOB_RUN', entityId: LEAVE_JOBS.accrue }))[0];
      if (!run) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(run?.metadata).toMatchObject({ data: { asOf, companyRuleId: f.org.companyRuleId } });
  });
});
