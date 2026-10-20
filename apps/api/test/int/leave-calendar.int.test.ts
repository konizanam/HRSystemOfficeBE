import { addDays, dateFromBusiness, type LeaveCalendarResponse, todayBusinessDate } from '@peoplehub/shared';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  auditSince,
  createRoleFixtures,
  lastAuditId,
  login,
  type RoleFixtures,
} from '../support/fixtures';
import { LEAVE_TYPE, LeaveKit } from '../support/leave';
import { WorkflowKit } from '../support/workflow';

describe('holidays, leave calendar and on leave today (sections 5.1 and 12.2)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let leave: LeaveKit;
  let emp: Agent;
  let mgr: Agent;
  let hr: Agent;
  let approvedFrom: string;
  let approvedTo: string;
  let pendingDay: string;

  async function approve(agent: Agent, processId: number): Promise<void> {
    const p = await kit.process(processId);
    const res = await agent.post(`/workflow/processes/${processId}/approve`).send({ version: p.version });
    expect(res.status, res.text).toBe(200);
  }

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    leave = new LeaveKit(t, kit);
    await leave.setup(f.org);
    await leave.accrue([f.employee2.employeeId]);
    [emp, mgr, hr] = await Promise.all([login(t, f.employee2), login(t, f.managerB), login(t, f.hrAdmin)]);
    // Approved leave today (and the next working days), and a request still in progress.
    ({ fromDate: approvedFrom, toDate: approvedTo } = await leave.range(
      todayBusinessDate(),
      2,
      f.org.companyId,
    ));
    const approved = await leave.submit(emp, {
      leaveTypeId: LEAVE_TYPE.annual,
      fromDate: approvedFrom,
      toDate: approvedTo,
    });
    await approve(mgr, approved.processId ?? 0);
    await approve(hr, approved.processId ?? 0);
    pendingDay = (await leave.range(addDays(approvedTo, 7), 1, f.org.companyId)).fromDate;
    const reason = await t.db.prisma.leaveReason.findUniqueOrThrow({
      where: { leaveTypeId_code: { leaveTypeId: LEAVE_TYPE.unpaid, code: 'PERSONAL' } },
    });
    await leave.submit(emp, {
      leaveTypeId: LEAVE_TYPE.unpaid,
      fromDate: pendingDay,
      toDate: pendingDay,
      leaveReasonId: reason.id,
    });
  });

  afterAll(async () => {
    kit.restore();
    await t.close();
  });

  it('lists public holidays with the Sunday→Monday observed date', async () => {
    const res = await emp.get('/holidays?from=2027-03-01&to=2027-03-31').expect(200);
    const items = res.body.items as {
      date: string;
      observedDate: string;
      name: string;
      companyId: number | null;
    }[];
    expect(items.find((h) => h.name === 'Independence Day')).toMatchObject({
      date: '2027-03-21',
      observedDate: '2027-03-22',
      companyId: null,
    });
    expect(items.find((h) => h.name === 'Good Friday')?.date).toBe('2027-03-26');
    // Years without stored rows come from the rules table.
    const later = (await emp.get('/holidays?from=2029-12-01&to=2029-12-31').expect(200)).body.items;
    expect(later.map((h: { date: string; source: string }) => [h.date, h.source])).toEqual([
      ['2029-12-10', 'RULE'],
      ['2029-12-25', 'RULE'],
      ['2029-12-26', 'RULE'],
    ]);
    await emp.get('/holidays?from=2026-01-01&to=2030-01-01').expect(422);
    await emp.get('/holidays?from=2026-02-01&to=2026-01-01').expect(422);
  });

  it('shows approved leave per day with type colours and holidays; in-progress only on request', async () => {
    const from = addDays(approvedFrom, -3);
    const to = addDays(pendingDay, 1);
    const res = await emp.get(`/calendar/leave?from=${from}&to=${to}`).expect(200);
    const body = res.body as LeaveCalendarResponse;
    expect(body.scope).toBe('self');
    expect(body.days[0]?.date).toBe(from);
    const approvedDay = body.days.find((d) => d.date === approvedFrom);
    expect(approvedDay?.entries).toEqual([
      expect.objectContaining({
        employeeId: f.employee2.employeeId,
        leaveTypeId: LEAVE_TYPE.annual,
        colour: '#C0FFC0',
        status: 'APPROVED_PENDING_PROCESS',
        inProgress: false,
        portion: 'FULL',
      }),
    ]);
    expect(body.days.find((d) => d.date === pendingDay)?.entries).toEqual([]);
    expect(body.legend).toEqual([
      { leaveTypeId: 1, code: 'ANN_LVE', description: 'Annual Leave', colour: '#C0FFC0' },
    ]);
    expect(body.days.find((d) => d.date === todayBusinessDate())?.isToday).toBe(true);

    const withPending = (
      await emp.get(`/calendar/leave?from=${from}&to=${to}&includeInProgress=true`).expect(200)
    ).body as LeaveCalendarResponse;
    expect(withPending.days.find((d) => d.date === pendingDay)?.entries[0]).toMatchObject({
      inProgress: true,
      leaveTypeId: LEAVE_TYPE.unpaid,
    });

    const holidays = (await emp.get('/calendar/leave?from=2026-12-21&to=2027-01-03').expect(200))
      .body as LeaveCalendarResponse;
    expect(holidays.days.find((d) => d.date === '2026-12-25')?.holiday).toEqual({
      name: 'Christmas Day',
      observedFor: null,
    });
    expect(holidays.days.find((d) => d.date === '2026-12-26')).toMatchObject({ isWeekend: true, weekday: 6 });
  });

  it('shows a manager the reports calendar; others get 403', async () => {
    const res = await mgr
      .get(`/calendar/leave?from=${approvedFrom}&to=${approvedTo}&scope=reports`)
      .expect(200);
    const body = res.body as LeaveCalendarResponse;
    expect(body.employees.map((e) => e.employeeId)).toEqual(
      expect.arrayContaining([f.employee.employeeId, f.employee2.employeeId]),
    );
    expect(body.days[0]?.entries.map((e) => e.employeeId)).toContain(f.employee2.employeeId);
    await emp.get(`/calendar/leave?from=${approvedFrom}&to=${approvedTo}&scope=reports`).expect(403);
  });

  it('exports the visible range as CSV or Excel (audited EXPORT.CALENDAR)', async () => {
    const from = addDays(approvedFrom, -1);
    const to = approvedTo;
    let since = await lastAuditId(t.db);
    const csv = await emp.get(`/calendar/leave/export?from=${from}&to=${to}&format=csv`).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain(`leave-calendar-${from}-to-${to}.csv`);
    const lines = csv.text.trim().split('\n');
    expect(lines[0]).toBe(
      'Date,Employee Code,Employee Name,Leave Type,Day Portion,Units,Status,Reference Number,Public Holiday',
    );
    expect(lines.filter((l) => l.includes('Annual Leave'))).toHaveLength(2);
    let audit = await auditSince(t.db, since, { action: 'EXPORT.CALENDAR' });
    expect(audit[0]).toMatchObject({ category: 'EXPORT', subjectEmployeeId: f.employee2.employeeId });
    expect(audit[0]?.metadata).toMatchObject({ from, to, scope: 'self', format: 'csv', rows: 2 });

    since = await lastAuditId(t.db);
    const xlsx = await emp
      .get(`/calendar/leave/export?from=${from}&to=${to}&format=xlsx`)
      .responseType('arraybuffer')
      .expect(200);
    expect(xlsx.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const workbook = new ExcelJS.Workbook();
    const body = xlsx.body as Buffer;
    await workbook.xlsx.load(
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    );
    const sheet = workbook.getWorksheet('Leave calendar');
    expect(sheet?.getRow(1).getCell(1).value).toBe('Date');
    expect(sheet?.rowCount).toBe(3);
    audit = await auditSince(t.db, since, { action: 'EXPORT.CALENDAR' });
    expect(audit[0]?.metadata).toMatchObject({ format: 'xlsx' });
  });

  it('counts reports on approved leave today for managers', async () => {
    const res = await mgr.get('/leave/team/on-leave-today').expect(200);
    expect(res.body.date).toBe(todayBusinessDate());
    // Today is a leave day unless the tests run on a weekend or a public holiday.
    const onLeave =
      (await t.db.prisma.leaveApplicationDay.count({
        where: {
          date: dateFromBusiness(todayBusinessDate()),
          application: { employeeId: f.employee2.employeeId ?? 0 },
        },
      })) > 0;
    const ids = res.body.employees.map((e: { employeeId: number }) => e.employeeId);
    if (onLeave) expect(ids).toContain(f.employee2.employeeId);
    else expect(ids).not.toContain(f.employee2.employeeId);
    expect(res.body.count).toBe(res.body.employees.length);
    await emp.get('/leave/team/on-leave-today').expect(403);
    // Manager A's reports (depth 1) are manager B and the admins, none on leave.
    expect(
      (await (await login(t, f.managerA)).get('/leave/team/on-leave-today').expect(200)).body.count,
    ).toBe(0);
  });
});
