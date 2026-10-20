import type { Prisma, ProcessStatus } from '@prisma/client';
import {
  type Attachment,
  businessDateOf,
  businessFromDate,
  CLAIM_STATUS_LABELS,
  type ClaimCancelAction,
  type ClaimCapWarning,
  ClaimCapWarningSchema,
  type ClaimLine,
  type ClaimRow,
  claimStatusFilterOf,
  formatGridDate,
  money2,
  units4,
  type WorkflowTypeCode,
} from '@peoplehub/shared';
import type { ClaimRowSource } from './claim-constants';

/** Stored cap warnings (`Claim.warnings`), ignoring anything that does not parse. */
export function parseWarnings(value: Prisma.JsonValue | null): ClaimCapWarning[] {
  if (!Array.isArray(value)) return [];
  const out: ClaimCapWarning[] = [];
  for (const item of value) {
    const parsed = ClaimCapWarningSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** The facts that decide what Cancel does for the caller. */
export interface CancelFacts {
  status: ProcessStatus;
  /** An approver has approved, declined, reassigned, parked or sent it back. */
  actioned: boolean;
  /** The caller may act for the employee ("Working as" rule). */
  canAct: boolean;
  /** The caller is HR (write) or Payroll of the employee's company. */
  isAdmin: boolean;
}

/**
 * What Cancel does (ASSUMPTION, see docs): a draft is discarded; a request nobody has acted on
 * yet (or one sent back) is withdrawn by whoever may act for the employee; once an approver has
 * acted, or while it waits for processing, only HR/Payroll can cancel it (with a reason).
 * Processed, declined and cancelled claims cannot be cancelled.
 */
export function claimCancelAction(f: CancelFacts): ClaimCancelAction | null {
  switch (f.status) {
    case 'DRAFT':
      return f.canAct ? 'DISCARD' : null;
    case 'RESUBMIT_REQUIRED':
      return f.canAct ? 'WITHDRAW' : f.isAdmin ? 'CANCEL' : null;
    case 'IN_PROGRESS':
      if (!f.actioned && f.canAct) return 'WITHDRAW';
      return f.isAdmin ? 'CANCEL' : null;
    case 'APPROVED_PENDING_PROCESS':
      return f.isAdmin ? 'CANCEL' : null;
    default:
      return null;
  }
}

export function toClaimRow(
  claim: ClaimRowSource,
  extra: { finalApprover: string | null; canResume: boolean; cancelAction: ClaimCancelAction | null },
): ClaimRow {
  return {
    id: claim.id,
    version: claim.version,
    referenceNumber: claim.referenceNumber,
    employee: {
      id: claim.employee.id,
      employeeCode: claim.employee.employeeCode,
      firstName: claim.employee.firstName,
      lastName: claim.employee.lastName,
    },
    group: { id: claim.group.id, code: claim.group.code, description: claim.group.description },
    description: claim.description,
    status: claim.status,
    statusLabel: CLAIM_STATUS_LABELS[claim.status],
    statusFilter: claimStatusFilterOf(claim.status),
    totalAmount: money2(claim.totalAmount),
    currency: claim.employee.company.currency,
    lineCount: claim._count.lines,
    createdAt: claim.createdAt.toISOString(),
    createdDate: formatGridDate(businessDateOf(claim.createdAt)),
    submittedAt: claim.submittedAt?.toISOString() ?? null,
    submittedDate: claim.submittedAt ? formatGridDate(businessDateOf(claim.submittedAt)) : '',
    approvedAt: claim.approvedAt?.toISOString() ?? null,
    finalApprover: extra.finalApprover,
    processedAt: claim.processedAt?.toISOString() ?? null,
    processId: claim.processId,
    workflowType: (claim.process?.workflowType.code as WorkflowTypeCode | undefined) ?? null,
    hasWarnings: parseWarnings(claim.warnings).length > 0,
    canResume: extra.canResume,
    cancelAction: extra.cancelAction,
  };
}

export function toClaimLine(
  line: Prisma.ClaimLineGetPayload<{ include: { claimType: true } }>,
  attachments: Attachment[],
): ClaimLine {
  return {
    id: line.id,
    sortOrder: line.sortOrder,
    claimType: {
      id: line.claimType.id,
      code: line.claimType.code,
      description: line.claimType.description,
      inputMode: line.claimType.inputMode,
    },
    date: businessFromDate(line.date),
    startTime: line.startTime,
    endTime: line.endTime,
    quantity: line.quantity === null ? null : units4(line.quantity),
    rate: line.rate === null ? null : units4(line.rate),
    amount: money2(line.amount),
    description: line.description,
    attachments,
  };
}
