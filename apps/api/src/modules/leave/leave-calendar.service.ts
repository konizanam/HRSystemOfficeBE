import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  type BusinessDate,
  businessFromDate,
  CALENDAR_EXPORT_COLUMNS,
  type CalendarDay,
  type CalendarExportFormat,
  type CalendarLeaveEntry,
  type CalendarLegendItem,
  dateFromBusiness,
  DAY_PORTION_LABELS,
  eachBusinessDate,
  formatGridDate,
  isoWeekday,
  isWeekend,
  type LeaveCalendarExportQuery,
  type LeaveCalendarQuery,
  type LeaveCalendarResponse,
  type OnLeaveTodayResponse,
  PROCESS_STATUS_LABELS,
  todayBusinessDate,
  units4,
} from '@peoplehub/shared';
import ExcelJS from 'exceljs';
import { AuditService } from '../../audit/audit.service';
import { hasRole, type SecurityContext } from '../../common/context/security-context';
import { ForbiddenError, NotFoundError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import { ScopeService } from '../auth/scope.service';
import { HolidayService } from '../holidays/holiday.service';
import { APPROVED_STATUSES, IN_APPROVAL_STATUSES } from './leave-constants';

const DAY_SELECT = {
  date: true,
  portion: true,
  units: true,
  application: {
    select: {
      id: true,
      referenceNumber: true,
      status: true,
      employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
      leaveType: { select: { id: true, code: true, description: true, colour: true } },
    },
  },
} satisfies Prisma.LeaveApplicationDaySelect;

export interface CalendarExportFile {
  fileName: string;
  contentType: string;
  body: Buffer;
}

/**
 * The dashboard leave calendar (section 5.1.4) and "Employees on Leave" (section 5.1.3).
 * `self` shows the acting-as employee; `reports` shows the signed-in manager's reports within
 * `workingAs.maxDepth`. Approved and processed leave is shown, and in-progress leave on request
 * (flagged). Cancellation requests repeat their original's days and are never shown.
 */
@Injectable()
export class LeaveCalendarService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly holidays: HolidayService,
  ) {}

  private async people(ctx: SecurityContext, scope: LeaveCalendarQuery['scope']) {
    let ids: number[];
    let companyEmployeeId: number;
    if (scope === 'reports') {
      if (!hasRole(ctx, 'MANAGER') || ctx.selfEmployeeId === null) {
        throw new ForbiddenError('Only managers can see the calendar of their reports', {
          metadata: { scope },
        });
      }
      ids = await this.scope.reportIdsWithinDepth(ctx.selfEmployeeId);
      companyEmployeeId = ctx.selfEmployeeId;
    } else {
      await this.scope.assertCanAccessEmployee(ctx, ctx.actingAsEmployeeId, 'SELF_SERVICE');
      ids = [ctx.actingAsEmployeeId];
      companyEmployeeId = ctx.actingAsEmployeeId;
    }
    const [employees, owner] = await Promise.all([
      this.db.prisma.employee.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: { id: true, employeeCode: true, firstName: true, lastName: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      }),
      this.db.prisma.employee.findFirst({ where: { id: companyEmployeeId }, select: { companyId: true } }),
    ]);
    if (!owner) throw new NotFoundError('Employee');
    return { employees, companyId: owner.companyId };
  }

  async calendar(ctx: SecurityContext, query: LeaveCalendarQuery): Promise<LeaveCalendarResponse> {
    const { employees, companyId } = await this.people(ctx, query.scope);
    const statuses = query.includeInProgress
      ? [...APPROVED_STATUSES, ...IN_APPROVAL_STATUSES]
      : APPROVED_STATUSES;
    const [days, holidays] = await Promise.all([
      this.db.prisma.leaveApplicationDay.findMany({
        where: {
          date: { gte: dateFromBusiness(query.from), lte: dateFromBusiness(query.to) },
          application: {
            employeeId: { in: employees.map((e) => e.id) },
            cancelsApplicationId: null,
            status: { in: statuses },
          },
        },
        select: DAY_SELECT,
        orderBy: [{ date: 'asc' }, { applicationId: 'asc' }],
      }),
      this.holidays.between(companyId, query.from, query.to),
    ]);
    const today = todayBusinessDate();
    const entriesByDate = new Map<BusinessDate, CalendarLeaveEntry[]>();
    const legend = new Map<number, CalendarLegendItem>();
    for (const d of days) {
      const a = d.application;
      const date = businessFromDate(d.date);
      const entry: CalendarLeaveEntry = {
        applicationId: a.id,
        referenceNumber: a.referenceNumber,
        employeeId: a.employee.id,
        employeeCode: a.employee.employeeCode,
        employeeName: `${a.employee.firstName} ${a.employee.lastName}`,
        leaveTypeId: a.leaveType.id,
        leaveTypeCode: a.leaveType.code,
        leaveTypeDescription: a.leaveType.description,
        colour: a.leaveType.colour,
        portion: d.portion,
        units: units4(d.units),
        status: a.status,
        statusLabel: PROCESS_STATUS_LABELS[a.status],
        inProgress: IN_APPROVAL_STATUSES.includes(a.status),
      };
      entriesByDate.set(date, [...(entriesByDate.get(date) ?? []), entry]);
      legend.set(a.leaveType.id, {
        leaveTypeId: a.leaveType.id,
        code: a.leaveType.code,
        description: a.leaveType.description,
        colour: a.leaveType.colour,
      });
    }
    const holidayByDate = new Map<BusinessDate, { name: string; observedFor: BusinessDate | null }>();
    for (const h of holidays) {
      holidayByDate.set(h.date, { name: h.name, observedFor: null });
      if (h.observedDate !== h.date) holidayByDate.set(h.observedDate, { name: h.name, observedFor: h.date });
    }
    const calendarDays: CalendarDay[] = eachBusinessDate(query.from, query.to).map((date) => ({
      date,
      weekday: isoWeekday(date),
      isWeekend: isWeekend(date),
      isToday: date === today,
      holiday: holidayByDate.get(date) ?? null,
      entries: entriesByDate.get(date) ?? [],
    }));
    return {
      from: query.from,
      to: query.to,
      scope: query.scope,
      today,
      employees: employees.map((e) => ({
        employeeId: e.id,
        employeeCode: e.employeeCode,
        name: `${e.firstName} ${e.lastName}`,
      })),
      days: calendarDays,
      legend: [...legend.values()].sort((a, b) => a.leaveTypeId - b.leaveTypeId),
      holidays,
    };
  }

  /** GET /calendar/leave/export: the visible range as CSV or Excel, audited `EXPORT.CALENDAR`. */
  async export(ctx: SecurityContext, query: LeaveCalendarExportQuery): Promise<CalendarExportFile> {
    const data = await this.calendar(ctx, query);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'PeopleHub';
    const sheet = workbook.addWorksheet('Leave calendar');
    sheet.columns = CALENDAR_EXPORT_COLUMNS.map((header) => ({
      header,
      key: header,
      width: header === 'Employee Name' ? 28 : 16,
    }));
    let rows = 0;
    for (const day of data.days) {
      const holiday = day.holiday?.name ?? '';
      if (day.entries.length === 0 && holiday) {
        sheet.addRow([formatGridDate(day.date), '', '', '', '', '', '', '', holiday]);
        rows += 1;
      }
      for (const e of day.entries) {
        sheet.addRow([
          formatGridDate(day.date),
          e.employeeCode,
          e.employeeName,
          e.leaveTypeDescription,
          DAY_PORTION_LABELS[e.portion],
          e.units,
          e.statusLabel,
          e.referenceNumber,
          holiday,
        ]);
        rows += 1;
      }
    }
    sheet.getRow(1).font = { bold: true };
    const format: CalendarExportFormat = query.format;
    const body =
      format === 'csv'
        ? Buffer.from(await workbook.csv.writeBuffer())
        : Buffer.from(await workbook.xlsx.writeBuffer());
    await this.audit.recordStandalone(ctx, {
      category: 'EXPORT',
      action: 'EXPORT.CALENDAR',
      entityType: 'LeaveCalendar',
      subjectEmployeeId: query.scope === 'self' ? ctx.actingAsEmployeeId : null,
      metadata: {
        from: query.from,
        to: query.to,
        scope: query.scope,
        includeInProgress: query.includeInProgress,
        format,
        rows,
        employeeIds: data.employees.map((e) => e.employeeId),
      },
    });
    return {
      fileName: `leave-calendar-${query.from}-to-${query.to}.${format}`,
      contentType:
        format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body,
    };
  }

  /**
   * Reports on approved or processed leave today ("On Leave Today", section 5.1.3). Phase 7's
   * dashboard summary calls {@link onLeaveTodayCount}.
   */
  async onLeaveToday(ctx: SecurityContext): Promise<OnLeaveTodayResponse> {
    const today = todayBusinessDate();
    if (!hasRole(ctx, 'MANAGER') || ctx.selfEmployeeId === null)
      return { date: today, count: 0, employees: [] };
    const ids = await this.scope.reportIdsWithinDepth(ctx.selfEmployeeId);
    const days = await this.db.prisma.leaveApplicationDay.findMany({
      where: {
        date: dateFromBusiness(today),
        application: {
          employeeId: { in: ids },
          cancelsApplicationId: null,
          status: { in: APPROVED_STATUSES },
        },
      },
      select: DAY_SELECT,
      orderBy: { applicationId: 'asc' },
    });
    const byEmployee = new Map<number, OnLeaveTodayResponse['employees'][number]>();
    for (const d of days) {
      const a = d.application;
      if (byEmployee.has(a.employee.id)) continue;
      byEmployee.set(a.employee.id, {
        employeeId: a.employee.id,
        employeeCode: a.employee.employeeCode,
        name: `${a.employee.firstName} ${a.employee.lastName}`,
        leaveTypeId: a.leaveType.id,
        leaveTypeDescription: a.leaveType.description,
        colour: a.leaveType.colour,
        portion: d.portion,
      });
    }
    const employees = [...byEmployee.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { date: today, count: employees.length, employees };
  }

  async onLeaveTodayCount(ctx: SecurityContext): Promise<number> {
    return (await this.onLeaveToday(ctx)).count;
  }
}
