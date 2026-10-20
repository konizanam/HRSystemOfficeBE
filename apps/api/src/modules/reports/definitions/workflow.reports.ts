import { Prisma, type ProcessStatus } from '@prisma/client';
import {
  daysBetween,
  money2,
  todayBusinessDate,
  businessDateOf,
  type WorkflowTypeCode,
} from '@peoplehub/shared';
import { defineReport, type ReportRunContext } from '../report-definition';
import {
  batches,
  dateRange,
  day,
  dec4,
  EMPLOYEE_REF_SELECT,
  employeeBatches,
  employeeCells,
  fullName,
  money,
  statusLabel,
  timestampRange,
  ts,
  userNames,
} from '../report-helpers';

const ZERO = new Prisma.Decimal(0);
const PENDING: ProcessStatus[] = ['IN_PROGRESS', 'RESUBMIT_REQUIRED', 'APPROVED_PENDING_PROCESS'];
const OPEN_STEPS = ['PENDING', 'PARKED'] as const;

interface ClaimParams {
  from?: string;
  to?: string;
  claimGroupIds?: number[];
  statuses?: ProcessStatus[];
}

function claimWhere(rc: ReportRunContext, p: ClaimParams): Prisma.ClaimWhereInput {
  return {
    employee: rc.employees,
    status: p.statuses ? { in: p.statuses } : { not: 'DRAFT' },
    ...(p.claimGroupIds ? { groupId: { in: p.claimGroupIds } } : {}),
    ...(p.from || p.to ? { submittedAt: timestampRange(p.from, p.to) } : {}),
  };
}

const CLAIM_INCLUDE = {
  employee: { select: EMPLOYEE_REF_SELECT },
  group: { select: { description: true } },
  payPeriod: { select: { description: true } },
} satisfies Prisma.ClaimInclude;

/** Processed Claims: processed in the range. */
export const processedClaims = defineReport('PROCESSED_CLAIMS', async function* (rc, params) {
  for await (const batch of batches(
    (page) =>
      rc.prisma.claim.findMany({
        where: {
          employee: rc.employees,
          status: 'PROCESSED',
          ...(params.claimGroupIds ? { groupId: { in: params.claimGroupIds } } : {}),
          ...(params.from || params.to ? { processedAt: timestampRange(params.from, params.to) } : {}),
        },
        include: CLAIM_INCLUDE,
        orderBy: [{ processedAt: 'desc' }, { id: 'desc' }],
        ...page,
      }),
    rc.batchSize,
  )) {
    const approvers = await userNames(
      rc.prisma,
      batch.map((c) => c.finalApproverUserId),
    );
    for (const c of batch) {
      yield {
        referenceNumber: c.referenceNumber,
        ...employeeCells(c.employee),
        companyRule: c.employee.companyRule.description,
        claimGroup: c.group.description,
        description: c.description,
        totalAmount: money(c.totalAmount),
        submittedAt: ts(c.submittedAt),
        approvedAt: ts(c.approvedAt),
        processedAt: ts(c.processedAt),
        payPeriod: c.payPeriod?.description ?? null,
        finalApprover: c.finalApproverUserId ? (approvers.get(c.finalApproverUserId) ?? null) : null,
      };
    }
  }
});

/** Expense Claim Workflow Status: where each submitted claim is in its workflow. */
export const expenseClaimWorkflowStatus = defineReport(
  'EXPENSE_CLAIM_WORKFLOW_STATUS',
  async function* (rc, params) {
    const today = todayBusinessDate();
    for await (const batch of batches(
      (page) =>
        rc.prisma.claim.findMany({
          where: claimWhere(rc, params),
          include: {
            ...CLAIM_INCLUDE,
            process: {
              select: {
                id: true,
                currentStepNo: true,
                isEscalated: true,
                completedAt: true,
                workflowType: { select: { code: true } },
                stepInstances: {
                  where: { status: { in: [...OPEN_STEPS] } },
                  select: { assigneeUserId: true },
                },
              },
            },
          },
          orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
          ...page,
        }),
      rc.batchSize,
    )) {
      const names = await userNames(
        rc.prisma,
        batch.flatMap((c) => c.process?.stepInstances.map((s) => s.assigneeUserId) ?? []),
      );
      for (const c of batch) {
        const end = c.processedAt ?? c.process?.completedAt ?? null;
        yield {
          referenceNumber: c.referenceNumber,
          ...employeeCells(c.employee),
          claimGroup: c.group.description,
          totalAmount: money(c.totalAmount),
          status: statusLabel(c.status),
          processId: c.process?.id ?? null,
          workflowType: c.process?.workflowType.code ?? null,
          currentStep: PENDING.includes(c.status) ? (c.process?.currentStepNo ?? null) : null,
          currentAssignees:
            [
              ...new Set(
                c.process?.stepInstances.map((s) => names.get(s.assigneeUserId) ?? s.assigneeUserId) ?? [],
              ),
            ].join(', ') || null,
          submittedAt: ts(c.submittedAt),
          daysInWorkflow: c.submittedAt
            ? daysBetween(businessDateOf(c.submittedAt), end ? businessDateOf(end) : today)
            : null,
          escalated: c.process?.isEscalated ?? false,
        };
      }
    }
  },
);

/** Expense Claim Report: claim headers. */
export const expenseClaimReport = defineReport('EXPENSE_CLAIM_REPORT', async function* (rc, params) {
  for await (const batch of batches(
    (page) =>
      rc.prisma.claim.findMany({
        where: claimWhere(rc, params),
        include: { ...CLAIM_INCLUDE, _count: { select: { lines: { where: { deletedAt: null } } } } },
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        ...page,
      }),
    rc.batchSize,
  )) {
    const approvers = await userNames(
      rc.prisma,
      batch.map((c) => c.finalApproverUserId),
    );
    for (const c of batch) {
      yield {
        referenceNumber: c.referenceNumber,
        ...employeeCells(c.employee),
        companyRule: c.employee.companyRule.description,
        claimGroup: c.group.description,
        description: c.description,
        lines: c._count.lines,
        totalAmount: money(c.totalAmount),
        status: statusLabel(c.status),
        submittedAt: ts(c.submittedAt),
        finalApprover: c.finalApproverUserId ? (approvers.get(c.finalApproverUserId) ?? null) : null,
        processedAt: ts(c.processedAt),
      };
    }
  }
});

function lineWhere(rc: ReportRunContext, p: ClaimParams, employeeIds?: number[]): Prisma.ClaimLineWhereInput {
  return {
    deletedAt: null,
    claim: {
      employee: rc.employees,
      ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
      status: p.statuses ? { in: p.statuses } : { not: 'DRAFT' },
      ...(p.claimGroupIds ? { groupId: { in: p.claimGroupIds } } : {}),
    },
    ...(p.from || p.to ? { date: dateRange(p.from, p.to) } : {}),
  };
}

/** Claim Line: every line of submitted claims. */
export const claimLine = defineReport('CLAIM_LINE', async function* (rc, params) {
  for await (const batch of batches(
    (page) =>
      rc.prisma.claimLine.findMany({
        where: lineWhere(rc, params),
        include: {
          claimType: { select: { description: true } },
          claim: {
            select: {
              referenceNumber: true,
              status: true,
              group: { select: { description: true } },
              employee: { select: EMPLOYEE_REF_SELECT },
            },
          },
        },
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        ...page,
      }),
    rc.batchSize,
  )) {
    for (const l of batch) {
      yield {
        referenceNumber: l.claim.referenceNumber,
        ...employeeCells(l.claim.employee),
        claimGroup: l.claim.group.description,
        claimType: l.claimType.description,
        date: day(l.date),
        startTime: l.startTime,
        endTime: l.endTime,
        quantity: dec4(l.quantity),
        rate: dec4(l.rate),
        amount: money(l.amount),
        description: l.description,
        claimStatus: statusLabel(l.claim.status),
      };
    }
  }
});

/** Claim Summary: per employee and claim type, the line counts and amounts by state. */
export const claimSummary = defineReport('CLAIM_SUMMARY', async function* (rc, params) {
  for await (const batch of employeeBatches(rc.prisma, rc.employees, rc.batchSize)) {
    const lines = await rc.prisma.claimLine.findMany({
      where: lineWhere(
        rc,
        params,
        batch.map((e) => e.id),
      ),
      select: {
        quantity: true,
        amount: true,
        claimType: { select: { id: true, description: true, group: { select: { description: true } } } },
        claim: { select: { employeeId: true, status: true } },
      },
    });
    for (const e of batch) {
      const own = lines.filter((l) => l.claim.employeeId === e.id);
      const typeIds = [...new Set(own.map((l) => l.claimType.id))].sort((a, b) => a - b);
      for (const typeId of typeIds) {
        const ofType = own.filter((l) => l.claimType.id === typeId);
        const first = ofType[0];
        if (!first) continue;
        const sum = (filter: (l: (typeof ofType)[number]) => boolean) =>
          ofType.filter(filter).reduce((t, l) => t.plus(l.amount), ZERO);
        const pending = sum((l) => PENDING.includes(l.claim.status));
        const processed = sum((l) => l.claim.status === 'PROCESSED');
        yield {
          ...employeeCells(e),
          companyRule: e.companyRule.description,
          claimGroup: first.claimType.group.description,
          claimType: first.claimType.description,
          lines: ofType.length,
          quantity: dec4(ofType.reduce((t, l) => t.plus(l.quantity ?? ZERO), ZERO)),
          pendingAmount: money2(pending),
          processedAmount: money2(processed),
          totalAmount: money2(sum(() => true)),
        };
      }
    }
  }
});

interface ProcessParams {
  from?: string;
  to?: string;
  workflowTypes?: WorkflowTypeCode[];
  statuses?: ProcessStatus[];
}

function processWhere(rc: ReportRunContext, p: ProcessParams): Prisma.WorkflowProcessWhereInput {
  return {
    subjectEmployee: rc.employees,
    ...(p.workflowTypes ? { workflowType: { code: { in: p.workflowTypes } } } : {}),
  };
}

const SUBJECT_SELECT = {
  employeeCode: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.EmployeeSelect;

/** Step Approver Actions: every action taken on a step. */
export const stepApproverActions = defineReport('STEP_APPROVER_ACTIONS', async function* (rc, params) {
  for await (const batch of batches(
    (page) =>
      rc.prisma.workflowAction.findMany({
        where: {
          stepInstanceId: { not: null },
          process: processWhere(rc, params),
          ...(params.from || params.to ? { createdAt: timestampRange(params.from, params.to) } : {}),
        },
        include: {
          process: {
            select: {
              id: true,
              workflowType: { select: { code: true } },
              subjectEmployee: { select: SUBJECT_SELECT },
            },
          },
          stepInstance: { select: { stepNo: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...page,
      }),
    rc.batchSize,
  )) {
    const actors = await userNames(
      rc.prisma,
      batch.map((a) => a.actorUserId),
    );
    for (const a of batch) {
      yield {
        actionDate: ts(a.createdAt),
        processId: a.process.id,
        workflowType: a.process.workflowType.code,
        subjectCode: a.process.subjectEmployee.employeeCode,
        subjectName: fullName(a.process.subjectEmployee),
        stepNo: a.stepInstance?.stepNo ?? null,
        action: a.action,
        actor: actors.get(a.actorUserId) ?? a.actorUserId,
        comment: a.comment,
        fromStatus: a.fromStatus ? statusLabel(a.fromStatus) : null,
        toStatus: a.toStatus ? statusLabel(a.toStatus) : null,
      };
    }
  }
});

/** Process History: workflow processes of every type. */
export const processHistory = defineReport('PROCESS_HISTORY', async function* (rc, params) {
  for await (const batch of batches(
    (page) =>
      rc.prisma.workflowProcess.findMany({
        where: {
          ...processWhere(rc, params),
          status: params.statuses ? { in: params.statuses } : { not: 'DRAFT' },
          ...(params.from || params.to ? { submittedAt: timestampRange(params.from, params.to) } : {}),
        },
        include: {
          workflowType: { select: { code: true } },
          subjectEmployee: { select: SUBJECT_SELECT },
        },
        orderBy: [{ id: 'desc' }],
        ...page,
      }),
    rc.batchSize,
  )) {
    const submitters = await userNames(
      rc.prisma,
      batch.map((p) => p.submittedByUserId),
    );
    for (const p of batch) {
      yield {
        processId: p.id,
        workflowType: p.workflowType.code,
        subjectCode: p.subjectEmployee.employeeCode,
        subjectName: fullName(p.subjectEmployee),
        submittedBy: submitters.get(p.submittedByUserId) ?? p.submittedByUserId,
        summary: p.summary,
        status: statusLabel(p.status),
        round: p.round,
        submittedAt: ts(p.submittedAt),
        finalApprovedAt: ts(p.finalApprovedAt),
        processedAt: ts(p.processedAt),
        completedAt: ts(p.completedAt),
        escalated: p.isEscalated,
      };
    }
  }
});

/** Escalation Items: steps the escalation job flagged (`escalatedAt`, the `isEscalated` source). */
export const escalationItems = defineReport('ESCALATION_ITEMS', async function* (rc, params) {
  for await (const batch of batches(
    (page) =>
      rc.prisma.workflowStepInstance.findMany({
        where: {
          escalatedAt: params.from || params.to ? timestampRange(params.from, params.to) : { not: null },
          process: {
            ...processWhere(rc, params),
            ...(params.statuses ? { status: { in: params.statuses } } : {}),
          },
        },
        include: {
          process: {
            select: {
              id: true,
              summary: true,
              status: true,
              workflowType: { select: { code: true } },
              subjectEmployee: { select: SUBJECT_SELECT },
            },
          },
        },
        orderBy: [{ escalatedAt: 'desc' }, { id: 'desc' }],
        ...page,
      }),
    rc.batchSize,
  )) {
    const assignees = await userNames(
      rc.prisma,
      batch.map((s) => s.assigneeUserId),
    );
    for (const s of batch) {
      yield {
        processId: s.process.id,
        workflowType: s.process.workflowType.code,
        subjectCode: s.process.subjectEmployee.employeeCode,
        subjectName: fullName(s.process.subjectEmployee),
        summary: s.process.summary,
        stepNo: s.stepNo,
        assignee: assignees.get(s.assigneeUserId) ?? s.assigneeUserId,
        assignedAt: ts(s.createdAt),
        dueAt: ts(s.dueAt),
        escalatedAt: ts(s.escalatedAt),
        stepStatus: s.status.charAt(0) + s.status.slice(1).toLowerCase().replace(/_/g, ' '),
        processStatus: statusLabel(s.process.status),
      };
    }
  }
});
