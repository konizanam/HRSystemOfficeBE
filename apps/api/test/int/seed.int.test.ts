import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import { runSeed } from '../../prisma/seed/index';
import { SEED_DEV_PASSWORD, SEED_PEOPLE } from '../../prisma/seed/people';
import { startTestApp, type TestApp } from '../support/app';
import { auditSince, lastAuditId, login } from '../support/fixtures';
import { AuditService } from '../../src/audit/audit.service';
import { DEFAULT_DEFINITION_NAME } from '../../prisma/seed/workflow';
import {
  addMonths,
  businessFromDate,
  startOfMonth,
  todayBusinessDate,
  units4,
  WORKFLOW_TYPE_CODES,
} from '@peoplehub/shared';

describe('seed (section 14)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('is idempotent and creates the section 14 people', async () => {
    const deps = { db: t.db, audit: t.app.get(AuditService), ctx: systemContext('seed-test'), app: t.app };
    await runSeed(deps);
    const since = await lastAuditId(t.db);
    const second = await runSeed(deps);
    expect(second.usersCreated).toBe(0);
    expect(await auditSince(t.db, since)).toHaveLength(0);

    const users = await t.db.prisma.user.findMany({
      where: { username: { in: SEED_PEOPLE.map((p) => p.username) } },
      include: { employee: { include: { reportsTo: { include: { user: true } } } } },
    });
    expect(users).toHaveLength(12);
    const by = new Map(users.map((u) => [u.username, u]));
    expect(by.get('employee1')?.employee).toMatchObject({ entityCode: '000077', employeeCode: 'E000077' });
    expect(by.get('manager.b')?.employee?.reportsTo?.user?.username).toBe('manager.a');
    for (let i = 1; i <= 6; i++) {
      expect(by.get(`employee${i}`)?.employee?.reportsTo?.user?.username).toBe('manager.b');
    }
    expect(by.get('hr.admin')?.roles).toContain('HR_ADMIN');
    expect(by.get('payroll.admin')?.roles).toContain('PAYROLL_ADMIN');
    expect(by.get('sys.admin')?.roles).toContain('SYSTEM_ADMIN');
    expect(by.get('auditor')?.roles).toContain('AUDITOR');
    expect(users.every((u) => /^\d{6}$/.test(u.employee?.entityCode ?? ''))).toBe(true);

    // Section 14: a default two-step definition per workflow type.
    const definitions = await t.db.prisma.workflowDefinition.findMany({
      where: { name: DEFAULT_DEFINITION_NAME, companyRuleId: null, discriminator: null },
      include: { workflowType: true, steps: { orderBy: { stepNo: 'asc' } } },
    });
    expect(definitions.map((d) => d.workflowType.code).sort()).toEqual([...WORKFLOW_TYPE_CODES].sort());
    for (const d of definitions) {
      const step2Role = ['BASICINF', 'BANKDET'].includes(d.workflowType.code) ? 'PAYROLL_ADMIN' : 'HR_ADMIN';
      expect(d.steps.map((s) => [s.stepNo, s.resolution, s.approverRole, s.isMandatory])).toEqual([
        [1, 'REPORTS_TO', null, true],
        [2, 'ROLE', step2Role, true],
      ]);
    }
    // One open pay period per month of the current year for STAFF.
    const year = todayBusinessDate().slice(0, 4);
    const periods = await t.db.prisma.payPeriod.findMany({
      where: {
        companyRule: { code: 'STAFF', company: { code: 'DEMO' } },
        startDate: { gte: new Date(`${year}-01-01T00:00:00Z`), lte: new Date(`${year}-12-31T00:00:00Z`) },
      },
      orderBy: { startDate: 'asc' },
    });
    expect(periods).toHaveLength(12);
    expect(periods.every((p) => !p.isClosed)).toBe(true);
    expect(second.workflowDefinitionsCreated).toBe(0);
    expect(second.payPeriodsCreated).toBe(0);

    const agent = await login(t, { username: 'employee1', password: SEED_DEV_PASSWORD });
    expect(agent.login.status).toBe('OK');
    expect((await agent.get('/session').expect(200)).body.selfEmployee.employeeCode).toBe('E000077');
    expect(second).toMatchObject({
      holidayRulesCreated: 0,
      publicHolidays2026Created: 0,
      leaveTypesCreated: 0,
      leavePoliciesCreated: 0,
      employee1AnnualFixture: 0,
      employee1StudyApplications: 0,
      leaveAccrualsPosted: 0,
    });

    // Section 14: the 12 observed leave types with their ids, codes and colours (+ leave in lieu).
    const types = await t.db.prisma.leaveType.findMany({
      where: { id: { lte: 13 } },
      orderBy: { id: 'asc' },
    });
    expect(types.map((x) => [x.id, x.code, x.colour])).toEqual([
      [1, 'ANN_LVE', '#C0FFC0'],
      [2, 'SICK_LVE', '#FFFFC0'],
      [3, 'DC_LVE', '#80FF80'],
      [4, 'COMP_LVE', '#C0C0FF'],
      [5, 'MAT_LVE', '#FFC0FF'],
      [6, 'STUDY', '#FFE0C0'],
      [7, 'PAT_LVE', '#C0FFFF'],
      [8, 'SPORT_LVE', '#FFC080'],
      [9, 'UNPD_LVE', null],
      [10, 'RESET_LVE', null],
      [11, 'LOST_LVE', '#FFC0C0'],
      [12, 'UN_SICK', '#8080FF'],
      [13, 'LIEU_LVE', '#E0C0FF'],
    ]);
    expect(types.find((x) => x.id === 13)?.isCreditLeave).toBe(true);
    const holidays2026 = await t.db.prisma.publicHoliday.findMany({
      where: {
        companyId: null,
        date: { gte: new Date('2026-01-01T00:00:00Z'), lte: new Date('2026-12-31T00:00:00Z') },
      },
    });
    expect(holidays2026).toHaveLength(13);
    expect(await t.db.prisma.holidayRule.count({ where: { companyId: null } })).toBeGreaterThanOrEqual(13);

    // Section 1.7 fixtures for employee1 (E000077).
    const buckets = await t.db.prisma.employeeLeaveEntitlement.findMany({
      where: { employee: { entityCode: '000077' }, leaveTypeId: 1 },
      orderBy: { cycleEndDate: 'asc' },
    });
    expect(buckets.map((b) => [b.kind, b.definitionName])).toEqual([
      ['CARRY_FORWARD', 'Carry Forward Leave'],
      ['CYCLE', 'Annual Leave'],
    ]);
    const cycleStart = businessFromDate(buckets[0]?.cycleStartDate ?? new Date());
    if (cycleStart === addMonths(startOfMonth(todayBusinessDate()), -1)) {
      // The seed first ran this month: the grid reproduces the observed figures exactly.
      const grid = (await agent.get('/leave/balances/1/definitions').expect(200)).body;
      expect(grid.rows.map((r: { leaveDefinition: string }) => r.leaveDefinition)).toEqual([
        'Carry Forward Leave',
        'Annual Leave',
      ]);
      expect(grid.total).toMatchObject({
        balanceBroughtForward: '2.1691',
        accruedThisPeriod: '1.6667',
        takenThisPeriod: '0.0000',
        balanceCarriedForward: '3.8358',
      });
    }
    const cards = (await agent.get('/leave/balances').expect(200)).body.items;
    expect(cards.find((c: { code: string }) => c.code === 'STUDY')).toMatchObject({
      actualAvailable: '3.0000',
      pending: '9.0000',
    });
    const study = await t.db.prisma.leaveApplication.findMany({
      where: { employee: { entityCode: '000077' }, leaveTypeId: 6 },
      orderBy: { id: 'asc' },
    });
    expect(study.map((a) => [units4(a.unitsTaken), units4(a.availableAtSubmit ?? 0)])).toEqual([
      ['4.0000', '12.0000'],
      ['5.0000', '8.0000'],
    ]);

    // Section 5.3.1: the observed claim groups (with the "Other Calims" misspelling) and types,
    // each with a NO_CAP cap for every company rule.
    expect(second).toMatchObject({
      claimGroupsCreated: 0,
      claimTypesCreated: 0,
      claimCapsCreated: 0,
      hourlyRatesSet: 0,
    });
    const groups = await t.db.prisma.claimGroup.findMany({
      where: { id: { lte: 5 } },
      orderBy: { id: 'asc' },
    });
    expect(groups.map((g) => [g.id, g.code, g.description])).toEqual([
      [1, 'MSN_OT', 'Overtime Claims'],
      [2, 'OT', 'Overtime Claims'],
      [3, 'MSN_OTHER', 'Other Claims'],
      [4, 'OTHER', 'Other Calims'],
      [5, 'REBATECLMS', 'Rebate Claims'],
    ]);
    const claimTypes = await t.db.prisma.claimType.findMany({
      where: { id: { lte: 16 } },
      include: { caps: { where: { companyRuleId: null } } },
      orderBy: { id: 'asc' },
    });
    const byGroup = (groupId: number) => claimTypes.filter((x) => x.groupId === groupId).map((x) => x.code);
    const overtime = ['OT1_5', 'OT2_0', 'NSHIFT', 'STANDBY', 'STANDBY_WK'];
    const other = ['CALL_OUT', 'S&T', 'KM_CLM'];
    expect([byGroup(1), byGroup(2), byGroup(3), byGroup(4), byGroup(5)]).toEqual([
      overtime,
      overtime,
      other,
      other,
      [],
    ]);
    expect(claimTypes.every((x) => x.caps.length === 1 && x.caps[0]?.mode === 'NO_CAP')).toBe(true);
    const tiles = (await agent.get('/claims/groups').expect(200)).body.items as {
      code: string;
      canStart: boolean;
    }[];
    expect(tiles.filter((g) => g.canStart).map((g) => g.code)).toEqual([
      'MSN_OT',
      'OT',
      'MSN_OTHER',
      'OTHER',
    ]);
    const setup = (await agent.get('/claims/groups/1/setup').expect(200)).body;
    expect(setup.types.find((x: { code: string }) => x.code === 'OT1_5')).toMatchObject({
      effectiveRate: '127.5000',
      rateSource: 'EMPLOYEE_HOURLY_RATE',
    });
  });

  it('seeds the performance parameters, the 1–5 rating scale and an active template', async () => {
    const deps = { db: t.db, audit: t.app.get(AuditService), ctx: systemContext('seed-test'), app: t.app };
    await runSeed(deps);
    const second = await runSeed(deps);
    expect(second).toMatchObject({
      performanceParametersCreated: 0,
      ratingScalesCreated: 0,
      templatesCreated: 0,
    });

    const codes = async (tableName: string) =>
      (
        await t.db.prisma.parameterValue.findMany({ where: { tableName }, orderBy: { sortOrder: 'asc' } })
      ).map((r) => r.code);
    expect(await codes('ReviewCategory')).toEqual(expect.arrayContaining(['ANNUAL', 'PROBATION', 'MIDYEAR']));
    expect(await codes('ReviewType')).toEqual(expect.arrayContaining(['SELF', 'MANAGER', '360']));
    for (const table of [
      'KeyPerformanceArea',
      'KeyPerformanceIndicator',
      'SubKeyPerformanceIndicator',
      'CompetencyArea',
      'Competency',
      'SubCompetency',
      'JobTitleType',
      'JobGrade',
      'LevelOfComplexity',
    ])
      expect((await codes(table)).length).toBeGreaterThan(0);
    const kpi = await t.db.prisma.parameterValue.findUniqueOrThrow({
      where: { tableName_code: { tableName: 'KeyPerformanceIndicator', code: 'FIN_BUDGET' } },
      include: { parent: true },
    });
    expect(kpi.parent).toMatchObject({ tableName: 'KeyPerformanceArea', code: 'FINANCIAL' });

    const scale = await t.db.prisma.ratingScale.findUniqueOrThrow({ where: { name: '1–5' } });
    expect(scale.points).toEqual([
      { value: 1, label: 'Unacceptable' },
      { value: 2, label: 'Needs Improvement' },
      { value: 3, label: 'Meets Expectations' },
      { value: 4, label: 'Exceeds Expectations' },
      { value: 5, label: 'Outstanding' },
    ]);
    const template = await t.db.prisma.performanceTemplate.findFirstOrThrow({
      where: { name: 'Annual Performance Contract 2026' },
      include: { items: true },
    });
    expect(template).toMatchObject({ status: 'ACTIVE', ratingScaleId: scale.id });
    const totals = new Map<string, number>();
    for (const i of template.items) totals.set(i.kind, (totals.get(i.kind) ?? 0) + Number(i.weight));
    expect([...totals.values()].every((v) => v === 100)).toBe(true);
  });
});
