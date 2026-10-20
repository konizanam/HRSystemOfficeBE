import { Injectable } from '@nestjs/common';
import type {
  EmployeeLeaveEntitlement,
  EntitlementKind,
  LeaveLedgerEntry,
  LedgerEntryType,
  Prisma,
} from '@prisma/client';
import {
  type BusinessDate,
  businessFromDate,
  dateFromBusiness,
  Decimal,
  type DecimalInput,
  dec,
  type LeaveLedgerEntry as LeaveLedgerEntryDto,
  maxDate,
  round4,
  units4,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { type LeaveEmployee, RESERVING_STATUSES } from './leave-constants';
import { LeavePolicyService, type PolicyWithType } from './leave-policy.service';
import { type BucketBalance, type Cycle, cycleContaining, nextCycle } from './leave-rules';

/** A bucket with its ledger balance and reservations. */
export interface BucketView extends BucketBalance {
  row: EmployeeLeaveEntitlement;
  kind: EntitlementKind;
  definitionName: string;
  entitlement: Decimal;
  cycleStartDate: BusinessDate;
  isClosed: boolean;
}

export interface LedgerPosting {
  employeeId: number;
  leaveTypeId: number;
  entitlementId: number;
  entryType: LedgerEntryType;
  units: DecimalInput;
  effectiveDate: BusinessDate;
  payPeriodId?: number | null;
  leaveApplicationId?: number | null;
  note?: string | null;
}

export interface PostingAudit {
  /** e.g. `LEAVE.ACCRUED`. */
  action: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export function toLedgerDto(row: LeaveLedgerEntry): LeaveLedgerEntryDto {
  return {
    id: row.id,
    employeeId: row.employeeId,
    leaveTypeId: row.leaveTypeId,
    entitlementId: row.entitlementId,
    entryType: row.entryType,
    units: units4(row.units),
    effectiveDate: businessFromDate(row.effectiveDate),
    payPeriodId: row.payPeriodId,
    leaveApplicationId: row.leaveApplicationId,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Entitlement buckets (`EmployeeLeaveEntitlement`) and the append-only ledger
 * (`LeaveLedgerEntry`, section 5.2.2). Every ledger posting and every bucket change is audited
 * here. Writes for one employee are serialised by locking the employee row first.
 */
@Injectable()
export class EntitlementService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly policies: LeavePolicyService,
  ) {}

  /** Serialises leave writes for one employee (buckets, allocations, postings) in this transaction. */
  lockEmployee(tx: Tx, employeeId: number): Promise<void> {
    return this.db.lockRow(tx, 'Employee', employeeId);
  }

  /**
   * Makes sure the employee has a CYCLE bucket containing `asOf` for every applicable policy (credit
   * leave types use CREDIT buckets and are skipped). A first cycle follows the calendar anchor
   * (ASSUMPTION) and starts no earlier than the engagement date; a later one continues the chain
   * from the employee's last bucket. Returns the buckets opened.
   */
  async ensureCurrentBuckets(
    tx: Tx,
    ctx: SecurityContext,
    employee: LeaveEmployee,
    asOf: BusinessDate,
    onlyLeaveTypeId?: number,
  ): Promise<EmployeeLeaveEntitlement[]> {
    await this.lockEmployee(tx, employee.id);
    const engaged = employee.dateEngaged ? businessFromDate(employee.dateEngaged) : null;
    const date = engaged ? maxDate(asOf, engaged) : asOf;
    const terminated = employee.terminationDate ? businessFromDate(employee.terminationDate) : null;
    if (terminated !== null && terminated < date) return [];
    const policies = (await this.policies.applicable(employee.companyRuleId, tx)).filter(
      (p) =>
        !p.leaveType.isCreditLeave && (onlyLeaveTypeId === undefined || p.leaveTypeId === onlyLeaveTypeId),
    );
    const opened: EmployeeLeaveEntitlement[] = [];
    for (const policy of policies) {
      const cycles = await tx.employeeLeaveEntitlement.findMany({
        where: { employeeId: employee.id, leaveTypeId: policy.leaveTypeId, kind: 'CYCLE' },
        orderBy: { cycleEndDate: 'desc' },
      });
      const day = dateFromBusiness(date);
      if (cycles.some((c) => c.cycleStartDate <= day && c.cycleEndDate >= day)) continue;
      const latest = cycles[0];
      let cycle: Cycle;
      if (latest && businessFromDate(latest.cycleEndDate) < date) {
        cycle = nextCycle(businessFromDate(latest.cycleEndDate), policy.cycleMonths);
        while (cycle.end < date) cycle = nextCycle(cycle.end, policy.cycleMonths);
      } else if (latest) {
        // Only future cycles exist (an imported opening balance); nothing to open now.
        continue;
      } else {
        cycle = cycleContaining(date, policy.cycleMonths);
        if (engaged && engaged > cycle.start) cycle = { start: engaged, end: cycle.end };
      }
      opened.push(await this.openCycleBucket(tx, ctx, employee.id, policy, cycle));
    }
    return opened;
  }

  /** Opens (or returns the existing) CYCLE bucket of a policy for `cycle`. */
  async openCycleBucket(
    tx: Tx,
    ctx: SecurityContext,
    employeeId: number,
    policy: PolicyWithType,
    cycle: Cycle,
  ): Promise<EmployeeLeaveEntitlement> {
    const existing = await tx.employeeLeaveEntitlement.findFirst({
      where: {
        employeeId,
        leaveTypeId: policy.leaveTypeId,
        kind: 'CYCLE',
        cycleStartDate: dateFromBusiness(cycle.start),
      },
    });
    if (existing) return existing;
    return this.openBucket(tx, ctx, {
      employeeId,
      leaveTypeId: policy.leaveTypeId,
      policyId: policy.id,
      kind: 'CYCLE',
      definitionName: policy.definitionName,
      entitlement: policy.entitlementPerCycle.toString(),
      cycleStartDate: cycle.start,
      cycleEndDate: cycle.end,
      expiresOn: null,
    });
  }

  /** Creates a bucket and audits `LEAVE.ENTITLEMENT_OPENED`. */
  async openBucket(
    tx: Tx,
    ctx: SecurityContext,
    data: {
      employeeId: number;
      leaveTypeId: number;
      policyId: number | null;
      kind: EntitlementKind;
      definitionName: string;
      entitlement: DecimalInput;
      cycleStartDate: BusinessDate;
      cycleEndDate: BusinessDate;
      expiresOn: BusinessDate | null;
    },
    metadata: Record<string, unknown> = {},
  ): Promise<EmployeeLeaveEntitlement> {
    const row = await tx.employeeLeaveEntitlement.create({
      data: {
        employeeId: data.employeeId,
        leaveTypeId: data.leaveTypeId,
        policyId: data.policyId,
        kind: data.kind,
        definitionName: data.definitionName,
        entitlement: round4(dec(data.entitlement)).toString(),
        cycleStartDate: dateFromBusiness(data.cycleStartDate),
        cycleEndDate: dateFromBusiness(data.cycleEndDate),
        expiresOn: data.expiresOn ? dateFromBusiness(data.expiresOn) : null,
      },
    });
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: 'LEAVE.ENTITLEMENT_OPENED',
      entityType: 'EmployeeLeaveEntitlement',
      entityId: row.id,
      subjectEmployeeId: row.employeeId,
      after: row,
      metadata,
    });
    return row;
  }

  /** Closes a bucket (rollover, expiry) and audits `LEAVE.ENTITLEMENT_CLOSED`. */
  async closeBucket(
    tx: Tx,
    ctx: SecurityContext,
    bucket: EmployeeLeaveEntitlement,
    reason: string,
  ): Promise<void> {
    const after = await tx.employeeLeaveEntitlement.update({
      where: { id: bucket.id },
      data: { isClosed: true, closedAt: new Date(), version: { increment: 1 } },
    });
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: 'LEAVE.ENTITLEMENT_CLOSED',
      entityType: 'EmployeeLeaveEntitlement',
      entityId: bucket.id,
      subjectEmployeeId: bucket.employeeId,
      before: bucket,
      after,
      reason,
    });
  }

  /** Inserts one ledger entry (append-only) and audits it. Zero units post nothing. */
  async post(
    tx: Tx,
    ctx: SecurityContext,
    entry: LedgerPosting,
    audit: PostingAudit,
  ): Promise<LeaveLedgerEntry | null> {
    const units = round4(dec(entry.units));
    if (units.isZero()) return null;
    const row = await tx.leaveLedgerEntry.create({
      data: {
        employeeId: entry.employeeId,
        leaveTypeId: entry.leaveTypeId,
        entitlementId: entry.entitlementId,
        entryType: entry.entryType,
        units: units.toString(),
        effectiveDate: dateFromBusiness(entry.effectiveDate),
        payPeriodId: entry.payPeriodId ?? null,
        leaveApplicationId: entry.leaveApplicationId ?? null,
        note: entry.note ?? null,
        createdByUserId: ctx.userId,
      },
    });
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: audit.action,
      entityType: 'LeaveLedgerEntry',
      entityId: row.id,
      subjectEmployeeId: row.employeeId,
      after: row,
      reason: audit.reason ?? null,
      metadata: { entryType: row.entryType, units: units4(row.units), ...audit.metadata },
    });
    return row;
  }

  /** Ledger balance per bucket. */
  async balances(bucketIds: number[], client: Tx = this.db.prisma): Promise<Map<number, Decimal>> {
    if (bucketIds.length === 0) return new Map();
    const rows = await client.leaveLedgerEntry.groupBy({
      by: ['entitlementId'],
      where: { entitlementId: { in: bucketIds } },
      _sum: { units: true },
    });
    return new Map(rows.map((r) => [r.entitlementId, round4(dec(r._sum.units))]));
  }

  /** Units reserved per bucket by in-flight applications (optionally leaving one application out). */
  async reservations(
    bucketIds: number[],
    client: Tx = this.db.prisma,
    excludeApplicationId?: number,
  ): Promise<Map<number, Decimal>> {
    if (bucketIds.length === 0) return new Map();
    const where: Prisma.LeaveApplicationAllocationWhereInput = {
      entitlementId: { in: bucketIds },
      releasedAt: null,
      application: {
        status: { in: RESERVING_STATUSES },
        ...(excludeApplicationId !== undefined ? { id: { not: excludeApplicationId } } : {}),
      },
    };
    const rows = await client.leaveApplicationAllocation.groupBy({
      by: ['entitlementId'],
      where,
      _sum: { units: true },
    });
    return new Map(rows.map((r) => [r.entitlementId, round4(dec(r._sum.units))]));
  }

  /** The employee's buckets of a type with balances and reservations, earliest cycle end first. */
  async buckets(
    employeeId: number,
    leaveTypeId: number,
    options: { client?: Tx; includeClosed?: boolean; excludeApplicationId?: number } = {},
  ): Promise<BucketView[]> {
    const client = options.client ?? this.db.prisma;
    const rows = await client.employeeLeaveEntitlement.findMany({
      where: { employeeId, leaveTypeId, ...(options.includeClosed ? {} : { isClosed: false }) },
      orderBy: [{ cycleEndDate: 'asc' }, { id: 'asc' }],
    });
    const ids = rows.map((r) => r.id);
    const [balances, reserved] = await Promise.all([
      this.balances(ids, client),
      this.reservations(ids, client, options.excludeApplicationId),
    ]);
    return rows.map((row) => ({
      row,
      id: row.id,
      kind: row.kind,
      definitionName: row.definitionName,
      entitlement: dec(row.entitlement),
      cycleStartDate: businessFromDate(row.cycleStartDate),
      cycleEndDate: businessFromDate(row.cycleEndDate),
      expiresOn: row.expiresOn ? businessFromDate(row.expiresOn) : null,
      isClosed: row.isClosed,
      balance: balances.get(row.id) ?? new Decimal(0),
      reserved: reserved.get(row.id) ?? new Decimal(0),
    }));
  }
}
