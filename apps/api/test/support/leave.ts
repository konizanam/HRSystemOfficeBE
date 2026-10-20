import {
  addDays,
  type BusinessDate,
  isoWeekday,
  type LeaveApplicationDetail,
  todayBusinessDate,
  type WorkflowTypeCode,
} from '@peoplehub/shared';
import { expect } from 'vitest';
import { seedHolidays } from '../../prisma/seed/holidays';
import { seedLeaveReferenceData } from '../../prisma/seed/leave';
import { AuditService } from '../../src/audit/audit.service';
import { systemContext } from '../../src/common/context/security-context';
import { HolidayService } from '../../src/modules/holidays/holiday.service';
import { LEAVE_JOBS } from '../../src/modules/leave/leave-jobs.service';
import { calculateUnits } from '../../src/modules/leave/leave-rules';
import type { TestApp } from './app';
import type { Agent, Org } from './fixtures';
import { TWO_STEP, type WorkflowKit } from './workflow';

// Leave test kit: the seeded leave reference data (types 1–13, global policies, holidays), the
// two-step definitions for the leave workflow types on a fixture company rule, accruals, future
// working-day ranges and uploads.

export const LEAVE_TYPE = {
  annual: 1,
  sick: 2,
  study: 6,
  unpaid: 9,
  lieu: 13,
} as const;

/** A one-page PDF. */
export const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

export const LEAVE_WORKFLOW_TYPES: WorkflowTypeCode[] = [
  'LEAVE',
  'CANCELLEAVE',
  'CREDITLVEREQ',
  'CREDITLVEALLOC',
];

export class LeaveKit {
  constructor(
    readonly t: TestApp,
    readonly kit: WorkflowKit,
  ) {}

  /** Seeds the leave reference data and holidays (idempotent) and the org's definitions. */
  async setup(org: Org): Promise<{ payPeriodId: number }> {
    const deps = {
      db: this.t.db,
      audit: this.t.app.get(AuditService),
      ctx: systemContext('test-leave'),
      app: this.t.app,
    };
    await seedLeaveReferenceData(deps);
    await seedHolidays(deps);
    for (const type of LEAVE_WORKFLOW_TYPES) {
      await this.kit.definition({ type, companyRuleId: org.companyRuleId, steps: TWO_STEP });
    }
    return { payPeriodId: await this.kit.payPeriod(org) };
  }

  /** Runs `leave.accrue` for the employees (opens their buckets and posts accruals). */
  accrue(employeeIds: (number | null)[], asOf?: BusinessDate) {
    return this.kit.jobs.runNow(LEAVE_JOBS.accrue, {
      employeeIds: employeeIds.filter((id): id is number => id !== null),
      ...(asOf ? { asOf } : {}),
    });
  }

  /** The first Monday at least `days` from today that is not a public holiday. */
  async monday(days: number, companyId: number | null = null): Promise<BusinessDate> {
    let day = addDays(todayBusinessDate(), days);
    day = addDays(day, (8 - isoWeekday(day)) % 7);
    const holidays = await this.t.app.get(HolidayService).calendar(companyId, day, addDays(day, 400));
    while (holidays.has(day)) day = addDays(day, 7);
    return day;
  }

  /** The shortest range from `from` with exactly `units` working days (full days). */
  async range(
    from: BusinessDate,
    units: number,
    companyId: number | null = null,
  ): Promise<{ fromDate: BusinessDate; toDate: BusinessDate }> {
    const holidays = await this.t.app.get(HolidayService).calendar(companyId, from, addDays(from, 90));
    // Start on a working day, so the first day of the range is a leave day.
    while (isoWeekday(from) >= 6 || holidays.has(from)) from = addDays(from, 1);
    for (let to = from; to <= addDays(from, 90); to = addDays(to, 1)) {
      try {
        const calc = calculateUnits({
          fromDate: from,
          toDate: to,
          startPortion: 'FULL',
          endPortion: 'FULL',
          excludeWeekends: true,
          excludePublicHolidays: true,
          allowHalfDay: true,
          holidays,
        });
        if (calc.units.eq(units)) return { fromDate: from, toDate: to };
      } catch {
        // Not yet a working day in the range.
      }
    }
    throw new Error(`No ${units}-day range from ${from}`);
  }

  /** Uploads a PDF as the agent and returns its id. */
  async upload(
    agent: Agent,
    fileName = 'note.pdf',
    bytes: Buffer = PDF_BYTES,
    contentType = 'application/pdf',
  ): Promise<string> {
    const res = await agent.post('/attachments').attach('file', bytes, { filename: fileName, contentType });
    expect(res.status, res.text).toBe(201);
    return (res.body as { items: { id: string }[] }).items[0]?.id ?? '';
  }

  /** Submits through the API and returns the created application. */
  async submit(agent: Agent, body: Record<string, unknown>, key?: string): Promise<LeaveApplicationDetail> {
    const req = agent.post('/leave/applications');
    if (key) req.set('idempotency-key', key);
    const res = await req.send(body);
    expect(res.status, res.text).toBe(201);
    return res.body as LeaveApplicationDetail;
  }
}
