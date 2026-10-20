import { Injectable } from '@nestjs/common';
import type { CapCycle, ClaimCap } from '@prisma/client';
import {
  type BusinessDate,
  businessFromDate,
  CAP_CYCLE_LABELS,
  CAP_MODE_LABELS,
  CLAIM_BALANCE_COLUMNS,
  type ClaimBalanceRow,
  type ClaimBalancesQuery,
  type ClaimBalancesResponse,
  type ClaimCapCheck,
  type ClaimCapMeasure,
  type ClaimCapWarning,
  dateFromBusiness,
  Decimal,
  dec,
  money2,
  todayBusinessDate,
  units4,
} from '@peoplehub/shared';
import type { SecurityContext } from '../../common/context/security-context';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { ScopeService } from '../auth/scope.service';
import { assertCanReadClaims } from './claim-access';
import { CLAIMED_CLAIM_STATUSES, type ClaimEmployee, PENDING_CLAIM_STATUSES } from './claim-constants';
import {
  type CapUsage,
  type CycleWindow,
  cycleFor,
  effectiveLimit,
  evaluateCap,
  type PayPeriodWindow,
  proRataFactor,
} from './claim-rules';
import { type ApplicableType, ClaimSetupService } from './claim-setup.service';

/** Usage of one claim type in one cycle, both measures. */
export interface CycleUsage {
  amount: CapUsage;
  quantity: CapUsage;
}

/** A line as the cap check sees it. */
export interface CapCheckLine {
  /** Index in the request's `lines` (for the field path of a BLOCK error). */
  index: number;
  claimTypeId: number;
  date: BusinessDate;
  amount: Decimal;
  quantity: Decimal | null;
}

/** A cap check result with the line each finding points at. */
export interface CapCheckResult extends ClaimCapCheck {
  /** Field errors for the BLOCK findings (`lines.{i}.amount` or `.quantity`). */
  errors: { path: string; message: string }[];
}

function businessOrNull(value: Date | null): BusinessDate | null {
  return value ? businessFromDate(value) : null;
}

function measureLabel(measure: ClaimCapMeasure, value: Decimal): string {
  return measure === 'AMOUNT' ? money2(value) : units4(value);
}

/**
 * Claim caps and balances (sections 5.3.1 and 5.3.3): what an employee has claimed per type and
 * cycle (pending and processed), payroll adjustments, the pro-rata limits, the submit-time cap
 * check and the balances grid.
 */
@Injectable()
export class ClaimBalanceService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly setup: ClaimSetupService,
  ) {}

  /** Pay periods of the company rule around the dates, for PAY_PERIOD cycles. */
  async payPeriods(client: Tx, companyRuleId: number, dates: BusinessDate[]): Promise<PayPeriodWindow[]> {
    if (dates.length === 0) return [];
    const sorted = [...dates].sort();
    const rows = await client.payPeriod.findMany({
      where: {
        companyRuleId,
        startDate: { lte: dateFromBusiness(sorted[sorted.length - 1] ?? sorted[0] ?? todayBusinessDate()) },
        endDate: { gte: dateFromBusiness(sorted[0] ?? todayBusinessDate()) },
      },
      orderBy: { startDate: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      startDate: businessFromDate(r.startDate),
      endDate: businessFromDate(r.endDate),
    }));
  }

  /**
   * What the employee has used of a claim type in a cycle: line amounts and quantities of pending
   * and processed claims dated in the cycle (`excludeClaimId` leaves the claim being checked out),
   * and the payroll adjustments of the cycle.
   */
  async usage(
    client: Tx,
    employeeId: number,
    claimTypeId: number,
    window: Pick<CycleWindow, 'start' | 'end'>,
    excludeClaimId?: number,
  ): Promise<CycleUsage> {
    const lineWhere = (statuses: typeof PENDING_CLAIM_STATUSES) => ({
      claimTypeId,
      deletedAt: null,
      date: { gte: dateFromBusiness(window.start), lte: dateFromBusiness(window.end) },
      claim: {
        employeeId,
        status: { in: statuses },
        ...(excludeClaimId !== undefined ? { id: { not: excludeClaimId } } : {}),
      },
    });
    const [pending, claimed, adjustments] = await Promise.all([
      client.claimLine.aggregate({
        where: lineWhere(PENDING_CLAIM_STATUSES),
        _sum: { amount: true, quantity: true },
      }),
      client.claimLine.aggregate({
        where: lineWhere(CLAIMED_CLAIM_STATUSES),
        _sum: { amount: true, quantity: true },
      }),
      client.claimBalanceAdjustment.aggregate({
        where: { employeeId, claimTypeId, cycleStartDate: dateFromBusiness(window.start) },
        _sum: { amount: true, quantity: true },
      }),
    ]);
    const d = (v: { toString(): string } | null) => dec(v?.toString() ?? '0');
    return {
      amount: {
        pending: d(pending._sum.amount),
        claimed: d(claimed._sum.amount),
        adjustment: d(adjustments._sum.amount),
      },
      quantity: {
        pending: d(pending._sum.quantity),
        claimed: d(claimed._sum.quantity),
        adjustment: d(adjustments._sum.quantity),
      },
    };
  }

  /**
   * The submit-time cap check (section 5.3.1): for every cap of every claimed type, and every
   * cycle the claim's lines fall in, compares what the claim requests with what is available
   * (pro-rated when the cap is). WARN findings are returned as warnings, BLOCK findings as blocks
   * with field errors on the first line of the type in that cycle.
   */
  async check(
    client: Tx,
    employee: ClaimEmployee,
    applicable: ApplicableType[],
    lines: CapCheckLine[],
    excludeClaimId?: number,
  ): Promise<CapCheckResult> {
    const result: CapCheckResult = { warnings: [], blocks: [], errors: [] };
    const byType = new Map(applicable.map((t) => [t.type.id, t]));
    const periods = await this.payPeriods(
      client,
      employee.companyRuleId,
      lines.map((l) => l.date),
    );
    const engaged = businessOrNull(employee.dateEngaged);
    const terminated = businessOrNull(employee.terminationDate);
    // Group the lines by type, cap and cycle.
    const groups = new Map<
      string,
      { type: ApplicableType; cap: ClaimCap; window: CycleWindow; lines: CapCheckLine[] }
    >();
    for (const line of lines) {
      const type = byType.get(line.claimTypeId);
      if (!type) continue;
      for (const cap of type.caps) {
        if (cap.mode === 'NO_CAP') continue;
        const window = cycleFor(cap.cycle, line.date, periods);
        const key = `${cap.id}:${window.start}`;
        const entry = groups.get(key) ?? { type, cap, window, lines: [] };
        entry.lines.push(line);
        groups.set(key, entry);
      }
    }
    for (const { type, cap, window, lines: inCycle } of groups.values()) {
      const usage = await this.usage(client, employee.id, type.type.id, window, excludeClaimId);
      const factor = proRataFactor(window, engaged, terminated);
      const firstIndex = Math.min(...inCycle.map((l) => l.index));
      const measures: {
        measure: ClaimCapMeasure;
        limit: Decimal | null;
        requested: Decimal;
        usage: CapUsage;
      }[] = [
        {
          measure: 'AMOUNT',
          limit: effectiveLimit(
            cap.amountLimit ? dec(cap.amountLimit.toString()) : null,
            cap.proRata,
            factor,
            'AMOUNT',
          ),
          requested: inCycle.reduce((sum, l) => sum.plus(l.amount), new Decimal(0)),
          usage: usage.amount,
        },
        {
          measure: 'QUANTITY',
          limit: effectiveLimit(
            cap.quantityLimit ? dec(cap.quantityLimit.toString()) : null,
            cap.proRata,
            factor,
            'QUANTITY',
          ),
          requested: inCycle.reduce((sum, l) => sum.plus(l.quantity ?? 0), new Decimal(0)),
          usage: usage.quantity,
        },
      ];
      for (const m of measures) {
        const evaluation = evaluateCap({
          mode: cap.mode,
          limit: m.limit,
          usage: m.usage,
          requested: m.requested,
        });
        if (evaluation.outcome === 'OK' || m.limit === null || evaluation.available === null) continue;
        const mode = evaluation.outcome;
        const cycleText = `${CAP_CYCLE_LABELS[cap.cycle].toLowerCase()} cycle ${window.start} to ${window.end}`;
        const noun = m.measure === 'AMOUNT' ? 'amount' : 'quantity';
        const message =
          `${type.type.description}: this claim's ${noun} of ${measureLabel(m.measure, m.requested)} exceeds ` +
          `the ${measureLabel(m.measure, evaluation.available)} available for the ${cycleText} ` +
          `(limit ${measureLabel(m.measure, m.limit)})`;
        const finding: ClaimCapWarning = {
          code: 'CAP_EXCEEDED',
          mode,
          capId: cap.id,
          claimTypeId: type.type.id,
          claimType: type.type.description,
          cycle: cap.cycle,
          cycleStartDate: window.start,
          cycleEndDate: window.end,
          measure: m.measure,
          limit: measureLabel(m.measure, m.limit),
          available: measureLabel(m.measure, evaluation.available),
          requested: measureLabel(m.measure, m.requested),
          message,
        };
        if (mode === 'WARN') {
          result.warnings.push(finding);
        } else {
          result.blocks.push(finding);
          result.errors.push({
            path: `lines.${firstIndex}.${m.measure === 'AMOUNT' ? 'amount' : 'quantity'}`,
            message,
          });
        }
      }
    }
    return result;
  }

  /** GET /claims/balances (section 5.3.3): one row per eligible claim type and cap. */
  async balances(ctx: SecurityContext, query: ClaimBalancesQuery): Promise<ClaimBalancesResponse> {
    const employeeId = query.employeeId ?? ctx.actingAsEmployeeId;
    await assertCanReadClaims(this.scope, ctx, employeeId);
    const prisma = this.db.prisma;
    const date = query.date ?? todayBusinessDate();
    const employee = await this.setup.loadEmployee(prisma, employeeId);
    const applicable = await this.setup.applicableTypes(prisma, employee.companyRuleId);
    const periods = await this.payPeriods(prisma, employee.companyRuleId, [date]);
    const engaged = businessOrNull(employee.dateEngaged);
    const terminated = businessOrNull(employee.terminationDate);
    const items: ClaimBalanceRow[] = [];
    for (const t of applicable) {
      for (const cap of t.caps) {
        const window = cycleFor(cap.cycle, date, periods);
        const usage = await this.usage(prisma, employee.id, t.type.id, window);
        items.push(this.row(t, cap, window, usage, proRataFactor(window, engaged, terminated)));
      }
    }
    return {
      employeeId,
      date,
      currency: employee.company.currency,
      columns: CLAIM_BALANCE_COLUMNS.map((c) => ({ key: c.key, label: c.label })),
      items,
    };
  }

  private row(
    t: ApplicableType,
    cap: ClaimCap,
    window: CycleWindow,
    usage: CycleUsage,
    factor: Decimal,
  ): ClaimBalanceRow {
    const amountLimit = cap.amountLimit ? dec(cap.amountLimit.toString()) : null;
    const quantityLimit = cap.quantityLimit ? dec(cap.quantityLimit.toString()) : null;
    const amountApplies = effectiveLimit(amountLimit, cap.proRata, factor, 'AMOUNT');
    const quantityApplies = effectiveLimit(quantityLimit, cap.proRata, factor, 'QUANTITY');
    const left = (limit: Decimal | null, u: CapUsage) =>
      limit === null ? null : limit.minus(u.pending).minus(u.claimed).plus(u.adjustment);
    const amountAvailable = left(amountApplies, usage.amount);
    const quantityAvailable = left(quantityApplies, usage.quantity);
    return {
      claimTypeId: t.type.id,
      claimType: t.type.description,
      group: { id: t.type.group.id, code: t.type.group.code, description: t.type.group.description },
      capId: cap.id,
      cycle: cap.cycle,
      cycleStartDate: window.start,
      cycleEndDate: window.end,
      amountCappingLimit: amountLimit === null ? null : money2(amountLimit),
      proRataCappingLimit: cap.proRata && amountApplies !== null ? money2(amountApplies) : null,
      pendingAmountClaimed: money2(usage.amount.pending),
      amountClaimed: money2(usage.amount.claimed),
      balanceAdjustmentAmount: money2(usage.amount.adjustment),
      amountAvailable: amountAvailable === null ? null : money2(amountAvailable),
      quantityCappingLimit: quantityLimit === null ? null : units4(quantityLimit),
      pendingQuantityClaimed: units4(usage.quantity.pending),
      quantityClaimed: units4(usage.quantity.claimed),
      balanceAdjustmentQuantity: units4(usage.quantity.adjustment),
      quantityAvailable: quantityAvailable === null ? null : units4(quantityAvailable),
      cappingApplied: CAP_MODE_LABELS[cap.mode] as ClaimBalanceRow['cappingApplied'],
      capMode: cap.mode,
      proRata: cap.proRata,
    };
  }

  /** The cycle of a cap for the employee on a date (balance adjustments). */
  async cycleOn(
    client: Tx,
    companyRuleId: number,
    cycle: CapCycle,
    date: BusinessDate,
  ): Promise<CycleWindow> {
    const periods = await this.payPeriods(client, companyRuleId, [date]);
    return cycleFor(cycle, date, periods);
  }
}
