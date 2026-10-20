import {
  addDays,
  DASHBOARD_WIDGETS,
  type DashboardLayoutResponse,
  type DashboardSummary,
  dateFromBusiness,
  todayBusinessDate,
  type UpcomingBirthdaysResponse,
} from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import { startTestApp, type TestApp } from '../support/app';
import {
  auditSince,
  createOrg,
  createPerson,
  createRoleFixtures,
  lastAuditId,
  login,
  type RoleFixtures,
} from '../support/fixtures';
import { PayrollKit } from '../support/payroll';
import { WorkflowKit } from '../support/workflow';

/** A date of birth `inDays` from today, `age` years ago. */
function dob(inDays: number, age = 30): Date {
  const day = addDays(todayBusinessDate(), inDays);
  const shifted = `${Number(day.slice(0, 4)) - age}${day.slice(4)}`;
  // 29 February of a non-leap birth year does not exist; use the 28th.
  return dateFromBusiness(shifted.endsWith('-02-29') ? shifted.replace('-02-29', '-02-28') : shifted);
}

describe('dashboard (section 5.1)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: PayrollKit;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new PayrollKit(t, new WorkflowKit(t));
  });

  afterAll(async () => {
    await t.close();
  });

  describe('layout', () => {
    it('starts from the default and saves order and visibility (audited)', async () => {
      const emp = await login(t, f.employee);
      const initial = (await emp.get('/dashboard/layout').expect(200)).body as DashboardLayoutResponse;
      expect(initial.isDefault).toBe(true);
      expect(initial.widgets.map((w) => w.id)).toEqual([...DASHBOARD_WIDGETS]);
      expect(initial.widgets.find((w) => w.id === 'EMPLOYEES_ON_LEAVE')?.available).toBe(false);

      const widgets = [...DASHBOARD_WIDGETS]
        .reverse()
        .map((id) => ({ id, visible: id !== 'LEAVE_CALENDAR' }));
      const since = await lastAuditId(t.db);
      const saved = (await emp.put('/dashboard/layout').send({ widgets }).expect(200))
        .body as DashboardLayoutResponse;
      expect(saved.isDefault).toBe(false);
      expect(saved.widgets.map((w) => [w.id, w.visible])).toEqual(widgets.map((w) => [w.id, w.visible]));
      const audits = await auditSince(t.db, since, { entityType: 'DashboardLayout' });
      expect(audits.map((a) => a.action)).toEqual(['DASHBOARD.LAYOUT_CREATED']);
      expect((await emp.get('/dashboard/layout').expect(200)).body.widgets[0].id).toBe('UPCOMING_BIRTHDAYS');

      const manager = await login(t, f.managerB);
      const managerLayout = (await manager.get('/dashboard/layout').expect(200))
        .body as DashboardLayoutResponse;
      expect(managerLayout.isDefault).toBe(true);
      expect(managerLayout.widgets.find((w) => w.id === 'EMPLOYEES_ON_LEAVE')?.available).toBe(true);
    });

    it('rejects unknown, repeated or missing widgets', async () => {
      const emp = await login(t, f.employee2);
      const all = DASHBOARD_WIDGETS.map((id) => ({ id, visible: true }));
      for (const widgets of [[...all, { id: 'WEATHER', visible: true }], [...all, all[0]], all.slice(1)]) {
        const res = await emp.put('/dashboard/layout').send({ widgets });
        expect(res.status).toBe(422);
      }
    });
  });

  describe('summary', () => {
    it('shows the welcome banner, latest payslip and certificate, counts and birthdays', async () => {
      const [end] = await kit.periods(f.org, 1);
      const payroll = await login(t, f.payrollAdmin);
      await kit.importPayslips(payroll, [kit.row(f.employee.employeeCode ?? '', end ?? '')]);
      await kit.importCertificates(payroll, [
        {
          employeeCode: f.employee.employeeCode ?? '',
          taxYear: 2026,
          figures: [{ code: '3601', description: 'Gross', amount: '1.00' }],
        },
      ]);
      const emp = await login(t, f.employee);
      const s = (await emp.get('/dashboard/summary').expect(200)).body as DashboardSummary;
      expect(s.employee).toMatchObject({
        id: f.employee.employeeId,
        title: 'Mx',
        firstName: expect.any(String),
      });
      expect(s.latestPayslip).toMatchObject({ periodEndDate: end, payRunLabel: 'Main Payrun' });
      expect(s.latestTaxCertificate).toMatchObject({ taxYear: 2026, certificateType: 'PAYE5' });
      expect(s.restricted).toEqual({ payslips: false, taxCertificates: false });
      expect(s.submittedCounts).toEqual({ leave: 0, claims: 0 });
      expect(s.onLeaveToday).toBeNull();
      expect(s.upcomingBirthdays).toMatchObject({ enabled: true, days: 30 });
      expect(s.isActingForOther).toBe(false);
    });

    it('gives managers On Leave Today; while acting, restricted widgets are null with a flag (not 403)', async () => {
      const manager = await login(t, f.managerB);
      const own = (await manager.get('/dashboard/summary').expect(200)).body as DashboardSummary;
      expect(own.onLeaveToday).toEqual({ count: 0 });
      await kit.actAs(manager, f.employee.employeeId);
      const acting = (await manager.get('/dashboard/summary').expect(200)).body as DashboardSummary;
      expect(acting).toMatchObject({
        isActingForOther: true,
        latestPayslip: null,
        latestTaxCertificate: null,
        restricted: { payslips: true, taxCertificates: true },
      });
      expect(acting.employee?.id).toBe(f.employee.employeeId);
    });
  });

  describe('upcoming birthdays', () => {
    it('lists name and day/month only, same company rule, respecting opt-outs and the setting', async () => {
      const org = await createOrg(t.db, 'Birthday Co');
      const viewer = await createPerson(t.db, { org, employee: { dateOfBirth: dob(200) } });
      const soon = await createPerson(t.db, { org, employee: { dateOfBirth: dob(3, 41), knownAs: 'Sunny' } });
      const today = await createPerson(t.db, { org, employee: { dateOfBirth: dob(0, 25) } });
      const optedOut = await createPerson(t.db, {
        org,
        employee: { dateOfBirth: dob(5), birthdayVisible: false },
      });
      await createPerson(t.db, { org, employee: { dateOfBirth: dob(40) } });
      await createPerson(t.db, { org, employee: { dateOfBirth: dob(6), status: 'TERMINATED' } });
      const otherOrg = await createOrg(t.db, 'Birthday Other');
      await createPerson(t.db, { org: otherOrg, employee: { dateOfBirth: dob(2) } });

      const agent = await login(t, viewer);
      const res = await agent.get('/birthdays/upcoming?days=30').expect(200);
      const body = res.body as UpcomingBirthdaysResponse;
      expect(body.items.map((i) => i.employeeId)).toEqual([today.employeeId, soon.employeeId]);
      expect(body.items[0]).toMatchObject({ inDays: 0, isToday: true });
      const sunny = body.items[1];
      expect(sunny?.name).toMatch(/^Sunny /);
      expect(Object.keys(sunny ?? {}).sort()).toEqual([
        'day',
        'employeeId',
        'inDays',
        'isToday',
        'label',
        'month',
        'name',
      ]);
      const birthYear = String(Number(todayBusinessDate().slice(0, 4)) - 41);
      expect(JSON.stringify(sunny)).not.toContain(birthYear);
      expect(body.items.some((i) => i.employeeId === optedOut.employeeId)).toBe(false);
      expect(body.count).toBe(2);
      expect((await agent.get('/dashboard/summary').expect(200)).body.upcomingBirthdays.count).toBe(2);

      const admin = systemContext('test-birthdays');
      await t.settings.update(admin, { 'birthdays.enabled': false });
      try {
        const off = (await agent.get('/birthdays/upcoming').expect(200)).body as UpcomingBirthdaysResponse;
        expect(off).toMatchObject({ enabled: false, count: 0, items: [] });
        const layout = (await agent.get('/dashboard/layout').expect(200)).body as DashboardLayoutResponse;
        expect(layout.widgets.find((w) => w.id === 'UPCOMING_BIRTHDAYS')?.available).toBe(false);
      } finally {
        await t.settings.update(admin, { 'birthdays.enabled': true });
      }
      expect((await agent.get('/birthdays/upcoming?days=400')).status).toBe(422);
    });
  });
});
