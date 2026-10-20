import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { EntitlementKind, Prisma } from '@prisma/client';
import {
  addDays,
  type BusinessDate,
  businessFromDate,
  dateFromBusiness,
  dec,
  minDate,
  todayBusinessDate,
  units4,
} from '@peoplehub/shared';
import { type SecurityContext, systemContext } from '../../common/context/security-context';
import { EventBus } from '../../events/event-bus';
import { type JobCounts, JobsService } from '../../jobs/jobs.service';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { EntitlementService } from './entitlement.service';
import { CARRY_FORWARD_DEFINITION, LEAVE_EMPLOYEE_SELECT, PAY_PERIOD_CLOSED_EVENT } from './leave-constants';
import { LeavePolicyService, type PolicyWithType } from './leave-policy.service';
import { carryForwardExpiry, monthlyAccrual, monthsBetween, nextCycle, rolloverAmounts } from './leave-rules';

export const LEAVE_JOBS = {
  accrue: 'leave.accrue',
  cycleRollover: 'leave.cycleRollover',
  creditExpiry: 'leave.creditExpiry',
  carryForwardExpiry: 'leave.carryForwardExpiry',
} as const;

/** Job data: `asOf` (default today) and an optional scope, for re-runs and tests. */
export interface LeaveJobData extends Record<string, unknown> {
  asOf?: BusinessDate;
  employeeIds?: number[];
  companyRuleId?: number;
}

function scopeWhere(data: LeaveJobData): Prisma.EmployeeLeaveEntitlementWhereInput {
  return {
    ...(data.employeeIds ? { employeeId: { in: data.employeeIds } } : {}),
    ...(data.companyRuleId ? { employee: { companyRuleId: data.companyRuleId } } : {}),
  };
}

/**
 * The leave jobs (section 5.2.5). Each is idempotent (re-running a period posts nothing twice:
 * accruals are keyed by bucket and date, rolled-over and expired buckets are closed), returns its
 * counts for the `SYSTEM.JOB_RUN` row, and audits every ledger entry and bucket it writes.
 */
@Injectable()
export class LeaveJobs implements OnModuleInit {
  private readonly logger = new Logger(LeaveJobs.name);

  constructor(
    private readonly db: DbService,
    private readonly jobs: JobsService,
    private readonly bus: EventBus,
    private readonly entitlements: EntitlementService,
    private readonly policies: LeavePolicyService,
  ) {}

  onModuleInit(): void {
    // Monthly on the 1st at 01:00 Africa/Windhoek (JobsService schedules in the business zone).
    this.jobs.register<LeaveJobData>(LEAVE_JOBS.accrue, (data) => this.accrue(data), { cron: '0 1 1 * *' });
    // Daily: buckets whose cycle ended yesterday roll over (before the 01:00 accrual).
    this.jobs.register<LeaveJobData>(LEAVE_JOBS.cycleRollover, (data) => this.rollover(data), {
      cron: '15 0 * * *',
    });
    this.jobs.register<LeaveJobData>(LEAVE_JOBS.creditExpiry, (data) => this.expire('CREDIT', data), {
      cron: '30 0 * * *',
    });
    this.jobs.register<LeaveJobData>(
      LEAVE_JOBS.carryForwardExpiry,
      (data) => this.expire('CARRY_FORWARD', data),
      {
        cron: '45 0 * * *',
      },
    );
    // A pay period close accrues for the start of the next period.
    this.bus.subscribe(PAY_PERIOD_CLOSED_EVENT, async (event, context) => {
      const payPeriodId = Number(event.payload.payPeriodId);
      const period = Number.isInteger(payPeriodId)
        ? await context.tx.payPeriod.findUnique({ where: { id: payPeriodId } })
        : null;
      if (!period) return;
      const data: LeaveJobData = {
        asOf: addDays(businessFromDate(period.endDate), 1),
        companyRuleId: period.companyRuleId,
      };
      context.afterCommit(() => {
        this.jobs.send(LEAVE_JOBS.accrue, data).catch((err: unknown) => {
          this.logger.error({ err, payPeriodId }, 'Could not queue the leave accrual');
        });
      });
    });
  }

  // ───────────── leave.accrue ─────────────

  /**
   * MONTHLY_PRO_RATA posts `round4(entitlement / cycleMonths)` for every month of the open cycle up
   * to `asOf` that has no accrual yet (pro-rated for the first and last month by days employed);
   * UPFRONT posts the full entitlement at cycle start. Opens the current cycle buckets first.
   */
  async accrue(data: LeaveJobData): Promise<JobCounts> {
    const asOf = data.asOf ?? todayBusinessDate();
    const ctx = systemContext(`leave-accrue-${asOf}`);
    const employees = await this.db.prisma.employee.findMany({
      where: {
        deletedAt: null,
        ...(data.employeeIds ? { id: { in: data.employeeIds } } : {}),
        ...(data.companyRuleId ? { companyRuleId: data.companyRuleId } : {}),
        OR: [
          { status: { in: ['ACTIVE', 'SUSPENDED'] } },
          { leaveEntitlements: { some: { kind: 'CYCLE', isClosed: false } } },
        ],
      },
      select: LEAVE_EMPLOYEE_SELECT,
      orderBy: { id: 'asc' },
    });
    const counts = {
      asOf,
      employees: employees.length,
      bucketsOpened: 0,
      accrualsPosted: 0,
      unitsPosted: '0.0000',
    };
    let units = dec(0);
    for (const employee of employees) {
      const result = await this.db.tx(ctx, async (tx) => {
        const opened =
          employee.status === 'TERMINATED'
            ? []
            : await this.entitlements.ensureCurrentBuckets(tx, ctx, employee, asOf);
        const buckets = await tx.employeeLeaveEntitlement.findMany({
          where: {
            employeeId: employee.id,
            kind: 'CYCLE',
            isClosed: false,
            cycleStartDate: { lte: dateFromBusiness(asOf) },
          },
          include: { policy: true },
          orderBy: { id: 'asc' },
        });
        let posted = 0;
        let postedUnits = dec(0);
        for (const bucket of buckets) {
          const policy = bucket.policy?.isActive
            ? bucket.policy
            : await this.policies.policyFor(employee.companyRuleId, bucket.leaveTypeId, tx);
          if (!policy || policy.accrualMethod === 'NONE') continue;
          const accrued = await tx.leaveLedgerEntry.findMany({
            where: { entitlementId: bucket.id, entryType: 'ACCRUAL', leaveApplicationId: null },
            select: { effectiveDate: true },
          });
          const done = new Set(accrued.map((a) => businessFromDate(a.effectiveDate)));
          const cycleStart = businessFromDate(bucket.cycleStartDate);
          const cycleEnd = businessFromDate(bucket.cycleEndDate);
          const postings: {
            effectiveDate: BusinessDate;
            units: string;
            metadata: Record<string, unknown>;
          }[] = [];
          if (policy.accrualMethod === 'UPFRONT') {
            postings.push({
              effectiveDate: cycleStart,
              units: bucket.entitlement.toString(),
              metadata: { method: 'UPFRONT' },
            });
          } else {
            for (const month of monthsBetween(cycleStart, minDate(asOf, cycleEnd))) {
              const a = monthlyAccrual({
                entitlementPerCycle: policy.entitlementPerCycle.toString(),
                cycleMonths: policy.cycleMonths,
                month,
                cycleStart,
                cycleEnd,
                dateEngaged: employee.dateEngaged ? businessFromDate(employee.dateEngaged) : null,
                terminationDate: employee.terminationDate ? businessFromDate(employee.terminationDate) : null,
              });
              if (!a) continue;
              postings.push({
                effectiveDate: a.effectiveDate,
                units: a.units.toString(),
                metadata: {
                  method: 'MONTHLY_PRO_RATA',
                  daysEmployed: a.daysEmployed,
                  daysInMonth: a.daysInMonth,
                },
              });
            }
          }
          for (const p of postings) {
            if (done.has(p.effectiveDate)) continue;
            const entry = await this.entitlements.post(
              tx,
              ctx,
              {
                employeeId: employee.id,
                leaveTypeId: bucket.leaveTypeId,
                entitlementId: bucket.id,
                entryType: 'ACCRUAL',
                units: p.units,
                effectiveDate: p.effectiveDate,
                note: `${bucket.definitionName} accrual`,
              },
              { action: 'LEAVE.ACCRUED', metadata: { ...p.metadata, policyId: policy.id, asOf } },
            );
            if (entry) {
              posted += 1;
              postedUnits = postedUnits.plus(dec(entry.units));
            }
          }
        }
        return { opened: opened.length, posted, postedUnits };
      });
      counts.bucketsOpened += result.opened;
      counts.accrualsPosted += result.posted;
      units = units.plus(result.postedUnits);
    }
    counts.unitsPosted = units4(units);
    return counts;
  }

  // ───────────── leave.cycleRollover ─────────────

  /**
   * At a CYCLE bucket's end: `min(balance, maxCarryForward)` moves to a new "Carry Forward Leave"
   * bucket (CARRY_FORWARD_OUT / CARRY_FORWARD_IN) that expires `carryForwardExpiryMonths` later,
   * the excess is FORFEIT, the next cycle bucket opens and the old one closes. Units reserved by
   * in-flight applications stay behind for their TAKEN posting. Afterwards, units released onto a
   * closed bucket (a declined request) are forfeited.
   */
  async rollover(data: LeaveJobData): Promise<JobCounts> {
    const asOf = data.asOf ?? todayBusinessDate();
    const ctx = systemContext(`leave-rollover-${asOf}`);
    const due = await this.db.prisma.employeeLeaveEntitlement.findMany({
      where: {
        kind: 'CYCLE',
        isClosed: false,
        cycleEndDate: { lt: dateFromBusiness(asOf) },
        ...scopeWhere(data),
      },
      select: { id: true, employeeId: true },
      orderBy: [{ cycleEndDate: 'asc' }, { id: 'asc' }],
    });
    const counts = { asOf, bucketsRolled: 0, carriedForward: 0, forfeited: 0, nextCyclesOpened: 0, swept: 0 };
    for (const { id, employeeId } of due) {
      await this.db.tx(ctx, async (tx) => {
        await this.entitlements.lockEmployee(tx, employeeId);
        const outcome = await this.rollOne(tx, ctx, id);
        if (!outcome) return;
        counts.bucketsRolled += 1;
        if (outcome.carried) counts.carriedForward += 1;
        if (outcome.forfeited) counts.forfeited += 1;
        if (outcome.opened) counts.nextCyclesOpened += 1;
      });
    }
    counts.swept = await this.sweepClosed(ctx, data, asOf);
    return counts;
  }

  private async rollOne(
    tx: Tx,
    ctx: SecurityContext,
    bucketId: number,
  ): Promise<{ carried: boolean; forfeited: boolean; opened: boolean } | null> {
    const bucket = await tx.employeeLeaveEntitlement.findUniqueOrThrow({
      where: { id: bucketId },
      include: { employee: { select: LEAVE_EMPLOYEE_SELECT } },
    });
    if (bucket.isClosed) return null;
    const employee = bucket.employee;
    const policy: PolicyWithType | null =
      (bucket.policyId !== null
        ? await tx.leavePolicy.findUnique({ where: { id: bucket.policyId }, include: { leaveType: true } })
        : null) ?? (await this.policies.policyFor(employee.companyRuleId, bucket.leaveTypeId, tx));
    const [balances, reservations] = await Promise.all([
      this.entitlements.balances([bucket.id], tx),
      this.entitlements.reservations([bucket.id], tx),
    ]);
    const amounts = rolloverAmounts(
      balances.get(bucket.id) ?? 0,
      reservations.get(bucket.id) ?? 0,
      policy ? (policy.maxCarryForward?.toString() ?? null) : '0',
    );
    const cycleEnd = businessFromDate(bucket.cycleEndDate);
    const next = nextCycle(cycleEnd, policy?.cycleMonths ?? 12);
    const terminated = employee.terminationDate ? businessFromDate(employee.terminationDate) : null;
    const continues =
      policy !== null &&
      policy.isActive &&
      employee.deletedAt === null &&
      (terminated === null || terminated >= next.start);
    let opened = false;
    let nextBucketId: number | null = null;
    if (continues && policy) {
      const existed = await tx.employeeLeaveEntitlement.findFirst({
        where: {
          employeeId: employee.id,
          leaveTypeId: bucket.leaveTypeId,
          kind: 'CYCLE',
          cycleStartDate: dateFromBusiness(next.start),
        },
        select: { id: true },
      });
      nextBucketId = (await this.entitlements.openCycleBucket(tx, ctx, employee.id, policy, next)).id;
      opened = !existed;
    }
    const base = { employeeId: employee.id, leaveTypeId: bucket.leaveTypeId };
    const meta = { fromEntitlementId: bucket.id, cycleEndDate: cycleEnd };
    let carried = false;
    if (amounts.carry.gt(0) && continues && policy) {
      const expiry = carryForwardExpiry(next.start, policy.carryForwardExpiryMonths);
      const cf =
        (await tx.employeeLeaveEntitlement.findFirst({
          where: { ...base, kind: 'CARRY_FORWARD', cycleStartDate: dateFromBusiness(next.start) },
        })) ??
        (await this.entitlements.openBucket(
          tx,
          ctx,
          {
            ...base,
            policyId: policy.id,
            kind: 'CARRY_FORWARD',
            definitionName: CARRY_FORWARD_DEFINITION,
            entitlement: amounts.carry.toString(),
            cycleStartDate: next.start,
            cycleEndDate: expiry ?? next.end,
            expiresOn: expiry,
          },
          meta,
        ));
      await this.entitlements.post(
        tx,
        ctx,
        {
          ...base,
          entitlementId: bucket.id,
          entryType: 'CARRY_FORWARD_OUT',
          units: amounts.carry.negated(),
          effectiveDate: cycleEnd,
          note: CARRY_FORWARD_DEFINITION,
        },
        { action: 'LEAVE.CARRIED_FORWARD', metadata: { ...meta, toEntitlementId: cf.id } },
      );
      await this.entitlements.post(
        tx,
        ctx,
        {
          ...base,
          entitlementId: cf.id,
          entryType: 'CARRY_FORWARD_IN',
          units: amounts.carry,
          effectiveDate: next.start,
          note: CARRY_FORWARD_DEFINITION,
        },
        { action: 'LEAVE.CARRIED_FORWARD', metadata: { ...meta, toEntitlementId: cf.id, expiresOn: expiry } },
      );
      carried = true;
    } else if (amounts.carry.lt(0) && nextBucketId !== null) {
      // A negative balance follows the employee into the next cycle.
      await this.entitlements.post(
        tx,
        ctx,
        {
          ...base,
          entitlementId: bucket.id,
          entryType: 'CARRY_FORWARD_OUT',
          units: amounts.carry.negated(),
          effectiveDate: cycleEnd,
          note: 'Negative balance carried forward',
        },
        { action: 'LEAVE.CARRIED_FORWARD', metadata: { ...meta, toEntitlementId: nextBucketId } },
      );
      await this.entitlements.post(
        tx,
        ctx,
        {
          ...base,
          entitlementId: nextBucketId,
          entryType: 'CARRY_FORWARD_IN',
          units: amounts.carry,
          effectiveDate: next.start,
          note: 'Negative balance carried forward',
        },
        { action: 'LEAVE.CARRIED_FORWARD', metadata: { ...meta, toEntitlementId: nextBucketId } },
      );
      carried = true;
    }
    const forfeit = continues ? amounts.forfeit : amounts.carry.gt(0) ? amounts.unreserved : amounts.forfeit;
    let forfeited = false;
    if (forfeit.gt(0)) {
      await this.entitlements.post(
        tx,
        ctx,
        {
          ...base,
          entitlementId: bucket.id,
          entryType: 'FORFEIT',
          units: forfeit.negated(),
          effectiveDate: cycleEnd,
          note: continues ? 'Above the carry-forward limit' : 'Cycle ended without a next cycle',
        },
        {
          action: 'LEAVE.FORFEITED',
          metadata: { ...meta, maxCarryForward: policy?.maxCarryForward?.toString() ?? null },
        },
      );
      forfeited = true;
    }
    await this.entitlements.closeBucket(tx, ctx, bucket, 'Leave cycle ended');
    return { carried, forfeited, opened };
  }

  /** Forfeits units left on closed buckets once nothing is reserved there any more. */
  private async sweepClosed(ctx: SecurityContext, data: LeaveJobData, asOf: BusinessDate): Promise<number> {
    const closed = await this.db.prisma.employeeLeaveEntitlement.findMany({
      where: { isClosed: true, ...scopeWhere(data) },
      select: { id: true },
    });
    if (closed.length === 0) return 0;
    const ids = closed.map((c) => c.id);
    const [balances, reservations] = await Promise.all([
      this.entitlements.balances(ids),
      this.entitlements.reservations(ids),
    ]);
    const candidates = ids.filter(
      (id) => (balances.get(id)?.gt(0) ?? false) && !(reservations.get(id)?.gt(0) ?? false),
    );
    let swept = 0;
    for (const id of candidates) {
      await this.db.tx(ctx, async (tx) => {
        const bucket = await tx.employeeLeaveEntitlement.findUniqueOrThrow({ where: { id } });
        await this.entitlements.lockEmployee(tx, bucket.employeeId);
        const [balance, reserved] = await Promise.all([
          this.entitlements.balances([id], tx),
          this.entitlements.reservations([id], tx),
        ]);
        const left = balance.get(id) ?? dec(0);
        if (left.lte(0) || (reserved.get(id)?.gt(0) ?? false)) return;
        await this.entitlements.post(
          tx,
          ctx,
          {
            employeeId: bucket.employeeId,
            leaveTypeId: bucket.leaveTypeId,
            entitlementId: id,
            entryType: 'FORFEIT',
            units: left.negated(),
            effectiveDate: asOf,
            note: 'Released after the bucket closed',
          },
          { action: 'LEAVE.FORFEITED', metadata: { sweep: true } },
        );
        swept += 1;
      });
    }
    return swept;
  }

  // ───────────── leave.creditExpiry / leave.carryForwardExpiry ─────────────

  /**
   * Forfeits the unreserved units of CREDIT (leave in lieu) or CARRY_FORWARD buckets whose
   * `expiresOn` has passed, and closes them once nothing is reserved there.
   */
  async expire(
    kind: Extract<EntitlementKind, 'CREDIT' | 'CARRY_FORWARD'>,
    data: LeaveJobData,
  ): Promise<JobCounts> {
    const asOf = data.asOf ?? todayBusinessDate();
    const ctx = systemContext(`leave-expiry-${kind}-${asOf}`);
    const due = await this.db.prisma.employeeLeaveEntitlement.findMany({
      where: { kind, isClosed: false, expiresOn: { lt: dateFromBusiness(asOf) }, ...scopeWhere(data) },
      select: { id: true, employeeId: true },
      orderBy: { id: 'asc' },
    });
    const counts = {
      asOf,
      kind,
      expired: due.length,
      forfeitedEntries: 0,
      unitsForfeited: '0.0000',
      closed: 0,
    };
    let units = dec(0);
    for (const { id, employeeId } of due) {
      await this.db.tx(ctx, async (tx) => {
        await this.entitlements.lockEmployee(tx, employeeId);
        const bucket = await tx.employeeLeaveEntitlement.findUniqueOrThrow({ where: { id } });
        if (bucket.isClosed || !bucket.expiresOn) return;
        const [balance, reserved] = await Promise.all([
          this.entitlements.balances([id], tx),
          this.entitlements.reservations([id], tx),
        ]);
        const unreserved = (balance.get(id) ?? dec(0)).minus(reserved.get(id) ?? dec(0));
        if (unreserved.gt(0)) {
          const entry = await this.entitlements.post(
            tx,
            ctx,
            {
              employeeId,
              leaveTypeId: bucket.leaveTypeId,
              entitlementId: id,
              entryType: 'FORFEIT',
              units: unreserved.negated(),
              effectiveDate: addDays(businessFromDate(bucket.expiresOn), 1),
              note: kind === 'CREDIT' ? 'Leave in lieu expired' : 'Carry forward leave expired',
            },
            { action: 'LEAVE.FORFEITED', metadata: { expiresOn: businessFromDate(bucket.expiresOn), kind } },
          );
          if (entry) {
            counts.forfeitedEntries += 1;
            units = units.plus(unreserved);
          }
        }
        if (!(reserved.get(id)?.gt(0) ?? false)) {
          await this.entitlements.closeBucket(
            tx,
            ctx,
            bucket,
            kind === 'CREDIT' ? 'Leave in lieu expired' : 'Carry forward leave expired',
          );
          counts.closed += 1;
        }
      });
    }
    counts.unitsForfeited = units4(units);
    return counts;
  }
}
