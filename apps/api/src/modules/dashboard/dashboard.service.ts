import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  BIRTHDAY_WINDOW_DAYS,
  DASHBOARD_WIDGET_TITLES,
  DASHBOARD_WIDGETS,
  type DashboardLayoutResponse,
  type DashboardSummary,
  type DashboardWidgetId,
  type DashboardWidgetSetting,
  DEFAULT_DASHBOARD_LAYOUT,
  todayBusinessDate,
  type UpdateDashboardLayoutRequest,
} from '@peoplehub/shared';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { hasRole, isActingForOther, type SecurityContext } from '../../common/context/security-context';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { attachmentUrl } from '../auth/employee-summary';
import { ScopeService } from '../auth/scope.service';
import { LeaveCalendarService } from '../leave/leave-calendar.service';
import { PayslipService } from '../payslips/payslip.service';
import { TaxCertificateService } from '../payslips/tax-certificate.service';
import { SettingsService } from '../settings/settings.service';
import { BirthdayService } from './birthday.service';

/** Leave and claims in flight (My Submitted Items, section 5.1.5). */
const IN_FLIGHT: Prisma.EnumProcessStatusFilter = {
  in: ['IN_PROGRESS', 'RESUBMIT_REQUIRED', 'APPROVED_PENDING_PROCESS'],
};

const StoredLayoutSchema = z.array(z.object({ id: z.string(), visible: z.boolean() }));

function isWidgetId(id: string): id is DashboardWidgetId {
  return (DASHBOARD_WIDGETS as readonly string[]).includes(id);
}

/**
 * The dashboard (section 5.1): the per-user widget layout (`DashboardLayout`) and the summary
 * behind the welcome banner and the widgets.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly settings: SettingsService,
    private readonly payslips: PayslipService,
    private readonly certificates: TaxCertificateService,
    private readonly calendar: LeaveCalendarService,
    private readonly birthdays: BirthdayService,
  ) {}

  /**
   * The stored order and visibility, normalised: unknown ids (a widget that no longer exists) are
   * dropped and widgets added since are appended, visible.
   */
  static normalise(stored: unknown): DashboardWidgetSetting[] {
    const parsed = StoredLayoutSchema.safeParse(stored);
    const seen = new Set<DashboardWidgetId>();
    const out: DashboardWidgetSetting[] = [];
    for (const w of parsed.success ? parsed.data : []) {
      if (!isWidgetId(w.id) || seen.has(w.id)) continue;
      seen.add(w.id);
      out.push({ id: w.id, visible: w.visible });
    }
    for (const id of DASHBOARD_WIDGETS) if (!seen.has(id)) out.push({ id, visible: true });
    return out;
  }

  private async available(ctx: SecurityContext): Promise<Record<DashboardWidgetId, boolean>> {
    const birthdays = await this.settings.get('birthdays.enabled');
    return {
      LATEST_PAYSLIP: true,
      TAX_CERTIFICATES: true,
      EMPLOYEES_ON_LEAVE: hasRole(ctx, 'MANAGER'),
      LEAVE_CALENDAR: true,
      SUBMITTED_ITEMS: true,
      UPCOMING_BIRTHDAYS: birthdays,
    };
  }

  private async respond(
    ctx: SecurityContext,
    row: { widgets: Prisma.JsonValue; updatedAt: Date } | null,
  ): Promise<DashboardLayoutResponse> {
    const available = await this.available(ctx);
    const widgets = row ? DashboardService.normalise(row.widgets) : DEFAULT_DASHBOARD_LAYOUT;
    return {
      widgets: widgets.map((w) => ({
        ...w,
        title: DASHBOARD_WIDGET_TITLES[w.id],
        available: available[w.id],
      })),
      isDefault: row === null,
      updatedAt: row ? row.updatedAt.toISOString() : null,
    };
  }

  /** GET /dashboard/layout: the signed-in user's layout (not the acting-as employee's). */
  async layout(ctx: SecurityContext): Promise<DashboardLayoutResponse> {
    const row = await this.db.prisma.dashboardLayout.findUnique({ where: { userId: ctx.userId } });
    return this.respond(ctx, row);
  }

  /** PUT /dashboard/layout: saves order and visibility (audited). */
  async updateLayout(
    ctx: SecurityContext,
    input: UpdateDashboardLayoutRequest,
  ): Promise<DashboardLayoutResponse> {
    const row = await this.db.tx(ctx, (tx) => this.saveLayout(tx, ctx, ctx.userId, input.widgets));
    return this.respond(ctx, row);
  }

  /** Writes a layout for `userId` in the caller's transaction (also used by the seed). */
  async saveLayout(
    tx: Tx,
    ctx: SecurityContext,
    userId: string,
    widgets: readonly DashboardWidgetSetting[],
  ): Promise<{ widgets: Prisma.JsonValue; updatedAt: Date }> {
    const before = await tx.dashboardLayout.findUnique({ where: { userId } });
    const value = widgets.map((w) => ({ id: w.id, visible: w.visible }));
    const after = await tx.dashboardLayout.upsert({
      where: { userId },
      create: { userId, widgets: value },
      update: { widgets: value },
    });
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: before ? 'DASHBOARD.LAYOUT_UPDATED' : 'DASHBOARD.LAYOUT_CREATED',
      entityType: 'DashboardLayout',
      entityId: userId,
      before,
      after,
    });
    return after;
  }

  /**
   * GET /dashboard/summary for the acting-as employee. While working as someone else the
   * restricted features (payslips, tax certificates) come back as null with `restricted.*` set
   * instead of a 403, so the dashboard still loads (ASSUMPTION, see docs). Nothing here is
   * audited: the latest payslip and certificate entries carry no amounts.
   */
  async summary(ctx: SecurityContext): Promise<DashboardSummary> {
    const today = todayBusinessDate();
    const restrictedList = await this.scope.restrictedFeatures(ctx);
    const restricted = {
      payslips: restrictedList.includes('PAYSLIPS'),
      taxCertificates: restrictedList.includes('TAX_CERTIFICATES'),
    };
    const employee = ctx.actingAsEmployeeId
      ? await this.db.prisma.employee.findFirst({
          where: { id: ctx.actingAsEmployeeId, deletedAt: null },
          select: {
            id: true,
            employeeCode: true,
            title: true,
            firstName: true,
            lastName: true,
            knownAs: true,
            photoAttachmentId: true,
            company: { select: { name: true, logoAttachmentId: true } },
          },
        })
      : null;
    const settingsLogo = await this.settings.get('company.logoAttachmentId');
    const id = employee?.id;
    const [payslip, certificate, leave, credit, claims, onLeave, birthdays] = await Promise.all([
      id && !restricted.payslips ? this.payslips.latest(id) : null,
      id && !restricted.taxCertificates ? this.certificates.latest(id) : null,
      id ? this.db.prisma.leaveApplication.count({ where: { employeeId: id, status: IN_FLIGHT } }) : 0,
      id ? this.db.prisma.creditLeaveRequest.count({ where: { employeeId: id, status: IN_FLIGHT } }) : 0,
      id ? this.db.prisma.claim.count({ where: { employeeId: id, status: IN_FLIGHT } }) : 0,
      hasRole(ctx, 'MANAGER') ? this.calendar.onLeaveTodayCount(ctx) : null,
      this.birthdays.upcoming(ctx, BIRTHDAY_WINDOW_DAYS, today),
    ]);
    return {
      today,
      isActingForOther: isActingForOther(ctx),
      employee: employee
        ? {
            id: employee.id,
            employeeCode: employee.employeeCode,
            title: employee.title,
            firstName: employee.firstName,
            lastName: employee.lastName,
            knownAs: employee.knownAs,
            displayName: [employee.title, employee.firstName, employee.lastName].filter(Boolean).join(' '),
            photoUrl: attachmentUrl(employee.photoAttachmentId),
            companyName: employee.company.name,
            companyLogoUrl: attachmentUrl(employee.company.logoAttachmentId ?? settingsLogo),
          }
        : null,
      latestPayslip: payslip
        ? {
            id: payslip.id,
            periodEndDate: payslip.periodEndDate,
            periodEndLabel: payslip.periodEndLabel,
            payRunLabel: payslip.payRunLabel,
            runType: payslip.runType,
          }
        : null,
      latestTaxCertificate: certificate
        ? {
            id: certificate.id,
            taxYear: certificate.taxYear,
            taxYearLabel: certificate.taxYearLabel,
            certificateType: certificate.certificateType,
          }
        : null,
      restricted,
      submittedCounts: { leave: leave + credit, claims },
      onLeaveToday: onLeave === null ? null : { count: onLeave },
      upcomingBirthdays: { enabled: birthdays.enabled, days: birthdays.days, count: birthdays.count },
    };
  }
}
