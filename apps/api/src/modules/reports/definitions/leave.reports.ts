import { Prisma, type ProcessStatus } from '@prisma/client';
import { dateFromBusiness, DAY_PORTION_LABELS, formatCardDate, units4 } from '@peoplehub/shared';
import { defineReport, type ReportRunContext } from '../report-definition';
import {
  batches,
  dateRange,
  day,
  dec4,
  EMPLOYEE_REF_SELECT,
  employeeBatches,
  employeeCells,
  statusLabel,
  thisYear,
  ts,
  userNames,
} from '../report-helpers';

const ZERO = new Prisma.Decimal(0);
const APPROVED: ProcessStatus[] = ['APPROVED_PENDING_PROCESS', 'PROCESSED'];
const RESERVING: ProcessStatus[] = ['IN_PROGRESS', 'RESUBMIT_REQUIRED', 'APPROVED_PENDING_PROCESS'];

interface ApplicationParams {
  from?: string;
  to?: string;
  leaveTypeIds?: number[];
  statuses?: ProcessStatus[];
}

/** Applications overlapping the range; drafts are left out unless asked for. */
function applicationWhere(rc: ReportRunContext, p: ApplicationParams): Prisma.LeaveApplicationWhereInput {
  return {
    employee: rc.employees,
    status: p.statuses ? { in: p.statuses } : { not: 'DRAFT' },
    ...(p.leaveTypeIds ? { leaveTypeId: { in: p.leaveTypeIds } } : {}),
    ...(p.from ? { toDate: { gte: dateFromBusiness(p.from) } } : {}),
    ...(p.to ? { fromDate: { lte: dateFromBusiness(p.to) } } : {}),
  };
}

const APPLICATION_INCLUDE = {
  employee: { select: EMPLOYEE_REF_SELECT },
  leaveType: { select: { description: true } },
  leaveReason: { select: { description: true } },
  payPeriod: { select: { description: true } },
} satisfies Prisma.LeaveApplicationInclude;

function applications(rc: ReportRunContext, p: ApplicationParams) {
  return batches(
    (page) =>
      rc.prisma.leaveApplication.findMany({
        where: applicationWhere(rc, p),
        include: APPLICATION_INCLUDE,
        orderBy: [{ fromDate: 'desc' }, { id: 'desc' }],
        ...page,
      }),
    rc.batchSize,
  );
}

/** Leave Detail: every application (cancellation requests flagged). */
export const leaveDetail = defineReport('LEAVE_DETAIL', async function* (rc, params) {
  for await (const batch of applications(rc, params)) {
    const approvers = await userNames(
      rc.prisma,
      batch.map((a) => a.finalApproverUserId),
    );
    for (const a of batch) {
      yield {
        referenceNumber: a.referenceNumber,
        ...employeeCells(a.employee),
        companyRule: a.employee.companyRule.description,
        leaveType: a.leaveType.description,
        fromDate: day(a.fromDate),
        toDate: day(a.toDate),
        startPortion: DAY_PORTION_LABELS[a.startPortion],
        endPortion: DAY_PORTION_LABELS[a.endPortion],
        units: dec4(a.unitsTaken),
        reason: a.leaveReason?.description ?? null,
        comment: a.comment,
        noteSubmitted: a.noteSubmitted,
        status: statusLabel(a.status),
        isCancellation: a.cancelsApplicationId !== null,
        submittedAt: ts(a.submittedAt),
        approvedAt: ts(a.approvedAt),
        finalApprover: a.finalApproverUserId ? (approvers.get(a.finalApproverUserId) ?? null) : null,
        processedAt: ts(a.processedAt),
        payPeriod: a.payPeriod?.description ?? null,
      };
    }
  }
});

/** Leave Basic: the short form of Leave Detail. */
export const leaveBasic = defineReport('LEAVE_BASIC', async function* (rc, params) {
  for await (const batch of applications(rc, params)) {
    for (const a of batch) {
      yield {
        ...employeeCells(a.employee),
        leaveType: a.leaveType.description,
        fromDate: day(a.fromDate),
        toDate: day(a.toDate),
        units: dec4(a.unitsTaken),
        status: statusLabel(a.status),
      };
    }
  }
});

/**
 * Leave Max Credit: open buckets with the most they may hold (the entitlement, plus the policy's
 * maximum carry forward for a cycle bucket) and the room left.
 */
export const leaveMaxCredit = defineReport('LEAVE_MAX_CREDIT', async function* (rc, params) {
  for await (const batch of batches(
    (page) =>
      rc.prisma.employeeLeaveEntitlement.findMany({
        where: {
          employee: rc.employees,
          isClosed: false,
          ...(params.leaveTypeIds ? { leaveTypeId: { in: params.leaveTypeIds } } : {}),
          ...(params.to ? { cycleStartDate: { lte: dateFromBusiness(params.to) } } : {}),
          ...(params.from ? { cycleEndDate: { gte: dateFromBusiness(params.from) } } : {}),
        },
        include: {
          employee: { select: EMPLOYEE_REF_SELECT },
          leaveType: { select: { description: true, allowNegative: true } },
          policy: { select: { maxCarryForward: true, maxNegative: true } },
        },
        orderBy: [{ employeeId: 'asc' }, { leaveTypeId: 'asc' }, { cycleEndDate: 'asc' }, { id: 'asc' }],
        ...page,
      }),
    rc.batchSize,
  )) {
    const ids = batch.map((b) => b.id);
    const [ledger, reserved] = await Promise.all([
      rc.prisma.leaveLedgerEntry.groupBy({
        by: ['entitlementId'],
        where: { entitlementId: { in: ids } },
        _sum: { units: true },
      }),
      rc.prisma.leaveApplicationAllocation.groupBy({
        by: ['entitlementId'],
        where: { entitlementId: { in: ids }, releasedAt: null, application: { status: { in: RESERVING } } },
        _sum: { units: true },
      }),
    ]);
    const balanceOf = new Map(ledger.map((l) => [l.entitlementId, l._sum.units ?? ZERO]));
    const pendingOf = new Map(reserved.map((r) => [r.entitlementId, r._sum.units ?? ZERO]));
    for (const b of batch) {
      const balance = balanceOf.get(b.id) ?? ZERO;
      const pending = pendingOf.get(b.id) ?? ZERO;
      const carry = b.kind === 'CYCLE' ? (b.policy?.maxCarryForward ?? ZERO) : ZERO;
      const maxCredit = b.entitlement.plus(carry);
      yield {
        ...employeeCells(b.employee),
        companyRule: b.employee.companyRule.description,
        leaveType: b.leaveType.description,
        definition: b.definitionName,
        cycleStart: day(b.cycleStartDate),
        cycleEnd: day(b.cycleEndDate),
        expiresOn: day(b.expiresOn),
        entitlement: units4(b.entitlement),
        maxCarryForward: dec4(b.policy?.maxCarryForward ?? null),
        maxNegative: b.leaveType.allowNegative ? null : dec4(b.policy?.maxNegative ?? null),
        maxCredit: units4(maxCredit),
        balance: units4(balance),
        pending: units4(pending),
        actualAvailable: units4(balance.minus(pending)),
        creditRemaining: units4(maxCredit.minus(balance)),
      };
    }
  }
});

async function leaveTypeNames(rc: ReportRunContext): Promise<Map<number, string>> {
  const types = await rc.prisma.leaveType.findMany({ select: { id: true, description: true } });
  return new Map(types.map((t) => [t.id, t.description]));
}

/**
 * Leave Summary: per employee and leave type, the ledger before the range (opening), the
 * movements in it (accrued, taken net of reversals, everything else as adjustments) and the
 * closing balance; pending = units of applications still in flight.
 */
export const leaveSummary = defineReport('LEAVE_SUMMARY', async function* (rc, params) {
  const from = params.from ?? thisYear(rc.today).from;
  const to = params.to ?? rc.today;
  const types = await leaveTypeNames(rc);
  const typeFilter = params.leaveTypeIds ? { leaveTypeId: { in: params.leaveTypeIds } } : {};
  for await (const batch of employeeBatches(rc.prisma, rc.employees, rc.batchSize)) {
    const employeeId = { in: batch.map((e) => e.id) };
    const [opening, movements, pending] = await Promise.all([
      rc.prisma.leaveLedgerEntry.groupBy({
        by: ['employeeId', 'leaveTypeId'],
        where: { employeeId, ...typeFilter, effectiveDate: { lt: dateFromBusiness(from) } },
        _sum: { units: true },
      }),
      rc.prisma.leaveLedgerEntry.groupBy({
        by: ['employeeId', 'leaveTypeId', 'entryType'],
        where: { employeeId, ...typeFilter, effectiveDate: dateRange(from, to) },
        _sum: { units: true },
      }),
      rc.prisma.leaveApplication.groupBy({
        by: ['employeeId', 'leaveTypeId'],
        where: { employeeId, ...typeFilter, status: { in: RESERVING }, cancelsApplicationId: null },
        _sum: { unitsTaken: true },
      }),
    ]);
    for (const e of batch) {
      const keys = new Set<number>();
      for (const r of [...opening, ...movements, ...pending])
        if (r.employeeId === e.id) keys.add(r.leaveTypeId);
      for (const leaveTypeId of [...keys].sort((a, b) => a - b)) {
        const open =
          opening.find((r) => r.employeeId === e.id && r.leaveTypeId === leaveTypeId)?._sum.units ?? ZERO;
        const own = movements.filter((r) => r.employeeId === e.id && r.leaveTypeId === leaveTypeId);
        const of = (kinds: string[]) =>
          own.filter((r) => kinds.includes(r.entryType)).reduce((t, r) => t.plus(r._sum.units ?? ZERO), ZERO);
        const accrued = of(['ACCRUAL']);
        const taken = of(['TAKEN', 'CANCELLATION_REVERSAL']).negated();
        const all = own.reduce((t, r) => t.plus(r._sum.units ?? ZERO), ZERO);
        const adjustments = all.minus(accrued).plus(taken);
        const inFlight =
          pending.find((r) => r.employeeId === e.id && r.leaveTypeId === leaveTypeId)?._sum.unitsTaken ??
          ZERO;
        yield {
          ...employeeCells(e),
          companyRule: e.companyRule.description,
          leaveType: types.get(leaveTypeId) ?? String(leaveTypeId),
          openingBalance: units4(open),
          accrued: units4(accrued),
          taken: units4(taken),
          adjustments: units4(adjustments),
          closingBalance: units4(open.plus(all)),
          pending: units4(inFlight),
        };
      }
    }
  }
});

/** Leave History Per Period: TAKEN and reversals processed into each pay period. */
export const leaveHistoryPerPeriod = defineReport('LEAVE_HISTORY_PER_PERIOD', async function* (rc, params) {
  const types = await leaveTypeNames(rc);
  for await (const batch of employeeBatches(rc.prisma, rc.employees, rc.batchSize)) {
    const rows = await rc.prisma.leaveLedgerEntry.groupBy({
      by: ['payPeriodId', 'employeeId', 'leaveTypeId', 'entryType'],
      where: {
        employeeId: { in: batch.map((e) => e.id) },
        entryType: { in: ['TAKEN', 'CANCELLATION_REVERSAL'] },
        payPeriodId: { not: null },
        ...(params.leaveTypeIds ? { leaveTypeId: { in: params.leaveTypeIds } } : {}),
        ...(params.from || params.to ? { payPeriod: { endDate: dateRange(params.from, params.to) } } : {}),
      },
      _sum: { units: true },
    });
    const periodIds = [...new Set(rows.map((r) => r.payPeriodId).filter((id): id is number => id !== null))];
    const periods = new Map(
      (await rc.prisma.payPeriod.findMany({ where: { id: { in: periodIds } } })).map((p) => [p.id, p]),
    );
    for (const e of batch) {
      const own = rows.filter((r) => r.employeeId === e.id);
      const keys = [...new Set(own.map((r) => `${r.payPeriodId}|${r.leaveTypeId}`))]
        .map((k) => k.split('|').map(Number) as [number, number])
        .sort(
          ([pa, ta], [pb, tb]) =>
            (periods.get(pb)?.endDate.getTime() ?? 0) - (periods.get(pa)?.endDate.getTime() ?? 0) || ta - tb,
        );
      for (const [payPeriodId, leaveTypeId] of keys) {
        const p = periods.get(payPeriodId);
        const sum = (type: string) =>
          own
            .filter(
              (r) => r.payPeriodId === payPeriodId && r.leaveTypeId === leaveTypeId && r.entryType === type,
            )
            .reduce((t, r) => t.plus(r._sum.units ?? ZERO), ZERO);
        const taken = sum('TAKEN').negated();
        const reversed = sum('CANCELLATION_REVERSAL');
        yield {
          payPeriod: p?.description ?? null,
          periodStart: day(p?.startDate),
          periodEnd: day(p?.endDate),
          ...employeeCells(e),
          leaveType: types.get(leaveTypeId) ?? String(leaveTypeId),
          unitsTaken: units4(taken),
          unitsReversed: units4(reversed),
          netUnits: units4(taken.minus(reversed)),
        };
      }
    }
  }
});

/** Leave In Lieu: requests and allocations with the credit's expiry. */
export const leaveInLieu = defineReport('LEAVE_IN_LIEU', async function* (rc, params) {
  for await (const batch of batches(
    (page) =>
      rc.prisma.creditLeaveRequest.findMany({
        where: {
          employee: rc.employees,
          status: params.statuses ? { in: params.statuses } : { not: 'DRAFT' },
          ...(params.from ? { workedTo: { gte: dateFromBusiness(params.from) } } : {}),
          ...(params.to ? { workedFrom: { lte: dateFromBusiness(params.to) } } : {}),
        },
        include: { employee: { select: EMPLOYEE_REF_SELECT }, entitlement: { select: { expiresOn: true } } },
        orderBy: [{ workedFrom: 'desc' }, { id: 'desc' }],
        ...page,
      }),
    rc.batchSize,
  )) {
    for (const r of batch) {
      yield {
        referenceNumber: r.referenceNumber,
        kind: r.kind === 'REQUEST' ? 'Request' : 'Allocation',
        ...employeeCells(r.employee),
        workedFrom: day(r.workedFrom),
        workedTo: day(r.workedTo),
        units: dec4(r.units),
        reason: r.reason,
        status: statusLabel(r.status),
        submittedAt: ts(r.submittedAt),
        approvedAt: ts(r.approvedAt),
        processedAt: ts(r.processedAt),
        expiresOn: day(r.entitlement?.expiresOn),
      };
    }
  }
});

/** Leave By Month: approved and processed leave days per month, employee and type. */
export const leaveByMonth = defineReport('LEAVE_BY_MONTH', async function* (rc, params) {
  const year = thisYear(rc.today);
  const range = dateRange(params.from ?? year.from, params.to ?? year.to);
  const types = await leaveTypeNames(rc);
  for await (const batch of employeeBatches(rc.prisma, rc.employees, rc.batchSize)) {
    const days = await rc.prisma.leaveApplicationDay.findMany({
      where: {
        date: range,
        application: {
          employeeId: { in: batch.map((e) => e.id) },
          status: { in: APPROVED },
          cancelsApplicationId: null,
          ...(params.leaveTypeIds ? { leaveTypeId: { in: params.leaveTypeIds } } : {}),
        },
      },
      select: { date: true, units: true, application: { select: { employeeId: true, leaveTypeId: true } } },
    });
    const totals = new Map<string, Prisma.Decimal>();
    for (const d of days) {
      const key = `${d.date.toISOString().slice(0, 7)}|${d.application.employeeId}|${d.application.leaveTypeId}`;
      totals.set(key, (totals.get(key) ?? ZERO).plus(d.units));
    }
    const keys = [...totals.keys()].sort();
    for (const e of batch) {
      for (const key of keys) {
        const [month = '', employeeId, leaveTypeId] = key.split('|');
        if (Number(employeeId) !== e.id) continue;
        yield {
          month: formatCardDate(`${month}-01`).slice(3),
          ...employeeCells(e),
          leaveType: types.get(Number(leaveTypeId)) ?? String(leaveTypeId),
          days: units4(totals.get(key) ?? ZERO),
        };
      }
    }
  }
});
