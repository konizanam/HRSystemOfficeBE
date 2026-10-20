import { Injectable } from '@nestjs/common';
import {
  type BalancePeriod,
  type BusinessDate,
  businessFromDate,
  dateFromBusiness,
  Decimal,
  dec,
  endOfMonth,
  formatGridDate,
  LEAVE_UNIT_LABEL,
  type LeaveBalanceCard,
  type LeaveBalanceDefinitionRow,
  type LeaveBalanceDefinitionsResponse,
  type LeaveBalancesResponse,
  round4,
  startOfMonth,
  todayBusinessDate,
  units4,
} from '@peoplehub/shared';
import type { SecurityContext } from '../../common/context/security-context';
import { NotFoundError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { ScopeService } from '../auth/scope.service';
import { EntitlementService } from './entitlement.service';
import { assertCanReadLeave } from './leave-access';
import { APPROVED_STATUSES, LEAVE_EMPLOYEE_SELECT, type LeaveEmployee } from './leave-constants';
import { leaveTypeRef } from './leave-mapper';
import { LeavePolicyService } from './leave-policy.service';
import { actualAvailable, periodFigures } from './leave-rules';

const ZERO = new Decimal(0);

/**
 * Leave balances (section 5.2.2): the cards (Actual Available, Pending) and the
 * balance-by-definition grid. The period is the pay period of the employee's company rule that
 * contains today (the calendar month when there is none).
 */
@Injectable()
export class LeaveBalanceService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly policies: LeavePolicyService,
    private readonly entitlements: EntitlementService,
  ) {}

  async period(
    companyRuleId: number,
    today: BusinessDate = todayBusinessDate(),
    client: Tx = this.db.prisma,
  ): Promise<BalancePeriod> {
    const day = dateFromBusiness(today);
    const pp = await client.payPeriod.findFirst({
      where: { companyRuleId, startDate: { lte: day }, endDate: { gte: day } },
      orderBy: { startDate: 'desc' },
    });
    if (pp) {
      return {
        payPeriodId: pp.id,
        description: pp.description,
        startDate: businessFromDate(pp.startDate),
        endDate: businessFromDate(pp.endDate),
        periodEnding: formatGridDate(pp.endDate),
      };
    }
    const start = startOfMonth(today);
    const end = endOfMonth(today);
    return {
      payPeriodId: null,
      description: `Month ending ${formatGridDate(end)}`,
      startDate: start,
      endDate: end,
      periodEnding: formatGridDate(end),
    };
  }

  private async employee(ctx: SecurityContext, employeeId: number): Promise<LeaveEmployee> {
    await assertCanReadLeave(this.scope, ctx, employeeId);
    const employee = await this.db.prisma.employee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: LEAVE_EMPLOYEE_SELECT,
    });
    if (!employee) throw new NotFoundError('Employee');
    return employee;
  }

  /** GET /leave/balances: one card per leave type the employee has a policy for. */
  async cards(ctx: SecurityContext, employeeId = ctx.actingAsEmployeeId): Promise<LeaveBalancesResponse> {
    const employee = await this.employee(ctx, employeeId);
    const [policies, period] = await Promise.all([
      this.policies.applicable(employee.companyRuleId),
      this.period(employee.companyRuleId),
    ]);
    const items: LeaveBalanceCard[] = [];
    for (const policy of policies) {
      const t = policy.leaveType;
      const buckets = await this.entitlements.buckets(employee.id, t.id);
      const carriedForward = buckets.reduce((sum, b) => sum.plus(b.balance), ZERO);
      const pending = buckets.reduce((sum, b) => sum.plus(b.reserved), ZERO);
      const available = actualAvailable(carriedForward, pending);
      if (t.hideZeroUnitsAvailableForESS && available.isZero()) continue;
      items.push({
        leaveTypeId: t.id,
        code: t.code,
        description: t.description,
        colour: t.colour,
        actualAvailable: t.hideUnitsAvailableForESS ? null : units4(available),
        pending: units4(pending),
        hideUnitsAvailable: t.hideUnitsAvailableForESS,
        unitLabel: LEAVE_UNIT_LABEL,
      });
    }
    return { employeeId: employee.id, period, items };
  }

  /**
   * GET /leave/balances/:leaveTypeId/definitions: one row per bucket (open buckets, and buckets
   * closed during the period) with the section 1.7 columns, plus a Total row.
   */
  async definitions(
    ctx: SecurityContext,
    leaveTypeId: number,
    employeeId = ctx.actingAsEmployeeId,
  ): Promise<LeaveBalanceDefinitionsResponse> {
    const employee = await this.employee(ctx, employeeId);
    const prisma = this.db.prisma;
    const type = await prisma.leaveType.findUnique({ where: { id: leaveTypeId } });
    if (!type) throw new NotFoundError('Leave type');
    const period = await this.period(employee.companyRuleId);
    const today = todayBusinessDate();
    const buckets = await prisma.employeeLeaveEntitlement.findMany({
      where: {
        employeeId: employee.id,
        leaveTypeId,
        OR: [{ isClosed: false }, { closedAt: { gte: dateFromBusiness(period.startDate) } }],
      },
      orderBy: [{ cycleEndDate: 'asc' }, { id: 'asc' }],
    });
    const policy = await this.policies.policyFor(employee.companyRuleId, leaveTypeId);
    if (buckets.length === 0 && !policy) throw new NotFoundError('Leave balance');
    const ids = buckets.map((b) => b.id);
    const [movements, reserved, planned] = await Promise.all([
      prisma.leaveLedgerEntry.findMany({
        where: { entitlementId: { in: ids } },
        select: { entitlementId: true, entryType: true, units: true, effectiveDate: true },
      }),
      this.entitlements.reservations(ids),
      prisma.leaveApplicationAllocation.groupBy({
        by: ['entitlementId'],
        where: {
          entitlementId: { in: ids },
          releasedAt: null,
          application: { status: { in: APPROVED_STATUSES }, fromDate: { gt: dateFromBusiness(today) } },
        },
        _sum: { units: true },
      }),
    ]);
    const plannedBy = new Map(planned.map((p) => [p.entitlementId, round4(dec(p._sum.units))]));

    const rows: LeaveBalanceDefinitionRow[] = buckets.map((b) => {
      const figures = periodFigures(
        movements
          .filter((m) => m.entitlementId === b.id)
          .map((m) => ({
            entryType: m.entryType,
            units: dec(m.units),
            effectiveDate: businessFromDate(m.effectiveDate),
          })),
        period.startDate,
      );
      const pending = reserved.get(b.id) ?? ZERO;
      return {
        entitlementId: b.id,
        leaveDefinition: b.definitionName,
        entitlement: units4(b.entitlement),
        balanceBroughtForward: units4(figures.broughtForward),
        accruedThisPeriod: units4(figures.accrued),
        takenThisPeriod: units4(figures.taken),
        adjustmentsThisPeriod: units4(figures.adjustments),
        balanceCarriedForward: units4(figures.carriedForward),
        planned: units4(plannedBy.get(b.id) ?? ZERO),
        pending: units4(pending),
        actualAvailable: units4(actualAvailable(figures.carriedForward, pending)),
        leaveCycleEndDate: businessFromDate(b.cycleEndDate),
        isTotal: false,
      };
    });
    const sum = (key: keyof LeaveBalanceDefinitionRow) =>
      units4(rows.reduce((total, r) => total.plus(dec(r[key] as string)), ZERO));
    const total: LeaveBalanceDefinitionRow = {
      entitlementId: null,
      leaveDefinition: 'Total',
      entitlement: sum('entitlement'),
      balanceBroughtForward: sum('balanceBroughtForward'),
      accruedThisPeriod: sum('accruedThisPeriod'),
      takenThisPeriod: sum('takenThisPeriod'),
      adjustmentsThisPeriod: sum('adjustmentsThisPeriod'),
      balanceCarriedForward: sum('balanceCarriedForward'),
      planned: sum('planned'),
      pending: sum('pending'),
      actualAvailable: sum('actualAvailable'),
      leaveCycleEndDate: null,
      isTotal: true,
    };
    return {
      employeeId: employee.id,
      leaveType: leaveTypeRef(type),
      title: `${type.description}, Period Ending: ${period.periodEnding}`,
      period,
      hideUnitsAvailable: type.hideUnitsAvailableForESS,
      rows,
      total,
    };
  }
}
