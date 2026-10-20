import type { Prisma, WorkflowProcess } from '@prisma/client';
import {
  PROCESS_STATUS_LABELS,
  WORKFLOW_ACTION_TYPES,
  WORKFLOW_TYPES,
  type WorkflowActionType,
  type WorkflowProcessDto,
  type WorkflowTypeCode,
} from '@peoplehub/shared';
import type { ResolutionSubject } from './approver-resolver.service';
import type { WorkflowProcessSnapshot } from './workflow-subject';

/** Everything the engine needs about a process, loaded after the row lock. */
export const PROCESS_INCLUDE = {
  workflowType: { select: { id: true, code: true } },
  definition: { include: { steps: { orderBy: { stepNo: 'asc' } } } },
  subjectEmployee: {
    select: {
      id: true,
      companyId: true,
      companyRuleId: true,
      reportsToId: true,
      employeeCode: true,
      title: true,
      initials: true,
      firstName: true,
      lastName: true,
    },
  },
} satisfies Prisma.WorkflowProcessInclude;

export type LoadedProcess = Prisma.WorkflowProcessGetPayload<{ include: typeof PROCESS_INCLUDE }>;

/** Step instance statuses that still need someone to act. */
export const OPEN_STEP_STATUSES = ['PENDING', 'PARKED'] as const;

/** Process statuses in which the request is still moving. */
export const IN_FLIGHT_STATUSES = ['IN_PROGRESS', 'RESUBMIT_REQUIRED', 'APPROVED_PENDING_PROCESS'] as const;

/** Process statuses that end a request. */
export const FINAL_STATUSES = ['PROCESSED', 'DECLINED', 'CANCELLED', 'CONFLICT'] as const;

/** `WORKFLOW.*` audit action for each WorkflowAction type (section 9.1). */
export const WORKFLOW_AUDIT_ACTIONS: Record<WorkflowActionType, string> = {
  CREATE: 'WORKFLOW.CREATED',
  SUBMIT: 'WORKFLOW.SUBMITTED',
  APPROVE: 'WORKFLOW.APPROVED',
  DECLINE: 'WORKFLOW.DECLINED',
  REASSIGN: 'WORKFLOW.REASSIGNED',
  DELEGATE: 'WORKFLOW.DELEGATED',
  PARK: 'WORKFLOW.PARKED',
  UNPARK: 'WORKFLOW.UNPARKED',
  SEND_BACK: 'WORKFLOW.SENT_BACK',
  RESUBMIT: 'WORKFLOW.RESUBMITTED',
  WITHDRAW: 'WORKFLOW.WITHDRAWN',
  CANCEL: 'WORKFLOW.CANCELLED',
  ESCALATE: 'WORKFLOW.ESCALATED',
  COMMENT: 'WORKFLOW.COMMENTED',
  AUTO_SKIP: 'WORKFLOW.AUTO_SKIPPED',
  PROCESS: 'WORKFLOW.PROCESSED',
  APPLY: 'WORKFLOW.APPLIED',
  CONFLICT: 'WORKFLOW.CONFLICT',
};

export function isWorkflowActionType(value: string): value is WorkflowActionType {
  return (WORKFLOW_ACTION_TYPES as readonly string[]).includes(value);
}

export function typeCode(p: { workflowType: { code: string } }): WorkflowTypeCode {
  return p.workflowType.code as WorkflowTypeCode;
}

export function toProcessDto(p: WorkflowProcess, type: WorkflowTypeCode): WorkflowProcessDto {
  return {
    id: p.id,
    workflowType: type,
    typeLabel: WORKFLOW_TYPES[type],
    status: p.status,
    statusLabel: PROCESS_STATUS_LABELS[p.status],
    version: p.version,
    round: p.round,
    currentStepNo: p.currentStepNo,
    subjectEmployeeId: p.subjectEmployeeId,
    subjectEntity: p.subjectEntity,
    subjectEntityId: p.subjectEntityId,
    summary: p.summary,
    isEscalated: p.isEscalated,
    submittedAt: p.submittedAt?.toISOString() ?? null,
    finalApprovedAt: p.finalApprovedAt?.toISOString() ?? null,
    processedAt: p.processedAt?.toISOString() ?? null,
    completedAt: p.completedAt?.toISOString() ?? null,
  };
}

export function toSnapshot(p: WorkflowProcess, type: WorkflowTypeCode): WorkflowProcessSnapshot {
  return {
    id: p.id,
    type,
    status: p.status,
    round: p.round,
    version: p.version,
    subjectEntity: p.subjectEntity,
    subjectEntityId: p.subjectEntityId,
    subjectEmployeeId: p.subjectEmployeeId,
    submittedByUserId: p.submittedByUserId,
    summary: p.summary,
  };
}

/** The process row without its relations, for audit before/after. */
export function processRow(p: LoadedProcess | WorkflowProcess): WorkflowProcess {
  const { id, workflowTypeId, definitionId, subjectEmployeeId, submittedByUserId, submittedOnBehalf } = p;
  return {
    id,
    workflowTypeId,
    definitionId,
    subjectEmployeeId,
    submittedByUserId,
    submittedOnBehalf,
    subjectEntity: p.subjectEntity,
    subjectEntityId: p.subjectEntityId,
    summary: p.summary,
    status: p.status,
    currentStepNo: p.currentStepNo,
    round: p.round,
    isEscalated: p.isEscalated,
    submittedAt: p.submittedAt,
    finalApprovedAt: p.finalApprovedAt,
    processedAt: p.processedAt,
    completedAt: p.completedAt,
    version: p.version,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function resolutionSubject(p: LoadedProcess, round = p.round): ResolutionSubject {
  return {
    processId: p.id,
    round,
    subjectEmployeeId: p.subjectEmployeeId,
    companyId: p.subjectEmployee.companyId,
    reportsToId: p.subjectEmployee.reportsToId,
    submittedByUserId: p.submittedByUserId,
  };
}
