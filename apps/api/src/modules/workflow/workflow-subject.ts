import type {
  BusinessDate,
  InboxWarning,
  ProcessStatus,
  SubjectDataByKind,
  SubjectDataKind,
  SubjectField,
  WorkflowTypeCode,
} from '@peoplehub/shared';
import type { SecurityContext } from '../../common/context/security-context';
import type { Tx } from '../../prisma/prisma-client';

/** The process as a subject handler sees it. */
export interface WorkflowProcessSnapshot {
  id: number;
  type: WorkflowTypeCode;
  status: ProcessStatus;
  round: number;
  version: number;
  subjectEntity: string;
  subjectEntityId: string;
  subjectEmployeeId: number;
  submittedByUserId: string;
  summary: string;
}

/**
 * `kind` and `data` of a subject description: a typed kind with its shared data schema
 * (packages/shared/src/api/subjects.ts), or GENERIC (the default when `kind` is left out) with
 * an open object.
 */
export type SubjectData =
  | { [K in Exclude<SubjectDataKind, 'GENERIC'>]: { kind: K; data: SubjectDataByKind[K] } }[Exclude<
      SubjectDataKind,
      'GENERIC'
    >]
  | { kind?: 'GENERIC'; data: Record<string, unknown> };

/**
 * What the inbox shows about the subject of a process (cards and the detail panel). Each
 * workflow type describes its own subject: a leave application, a claim, a change request, …
 */
export type SubjectDescription = SubjectDescriptionBase & SubjectData;

export interface SubjectDescriptionBase {
  /** The noun in "This {label} Request" and "New {label} Request", e.g. "Annual Leave". */
  requestLabel: string;
  /** Detail panel heading, e.g. "Leave request". */
  title: string;
  /** Card "from … to …" dates; null when the subject has no period. */
  fromDate: BusinessDate | null;
  toDate: BusinessDate | null;
  /** Card units line, e.g. "3.0000 Days to be deducted"; null when not applicable. */
  unitsLine: string | null;
  /** Highlighted figures, e.g. "Days available", "Days to be deducted". */
  headline: SubjectField[];
  /** The field list in display order. */
  fields: SubjectField[];
  /** Card link text, e.g. "View leave request". */
  viewLabel: string;
  /**
   * Other owner entities whose attachments belong to this request (for example the lines of a
   * claim). The detail panel lists them with the subject's own attachments.
   */
  attachmentOwners?: { entity: string; entityId: string }[];
}

/**
 * Who is looking at a subject description. Handlers that show more to some viewers (for example
 * an unmasked bank account number to a payroll administrator) use it; without a viewer (approval
 * history, notifications) everything sensitive stays masked.
 */
export interface SubjectViewer {
  ctx: SecurityContext;
  /** `detail`: the inbox detail panel of one item; `card`: inbox lists. */
  mode: 'card' | 'detail';
}

/** Passed to every lifecycle hook. Writes go through `tx` so they commit with the workflow change. */
export interface WorkflowHookContext {
  tx: Tx;
  /** Who acted; the SYSTEM context for jobs and automatic processing. */
  ctx: SecurityContext;
  /** The process after the transition (its new status is already set). */
  process: WorkflowProcessSnapshot;
}

export interface WorkflowCommentHookContext extends WorkflowHookContext {
  comment: string | null;
}

export interface WorkflowCancelHookContext extends WorkflowCommentHookContext {
  /** WITHDRAWN: the applicant pulled it back; CANCELLED: a service or admin cancelled it. */
  reason: 'WITHDRAWN' | 'CANCELLED';
}

export interface WorkflowResubmitHookContext extends WorkflowCommentHookContext {
  /** The `changes` the applicant sent with the resubmission; validate before use. */
  changes: Record<string, unknown> | undefined;
}

export interface PayPeriodRef {
  id: number;
  companyRuleId: number;
  description: string;
  startDate: Date;
  endDate: Date;
}

export interface WorkflowProcessHookContext extends WorkflowHookContext {
  payPeriod: PayPeriodRef;
  /** True when `workflow.autoProcess.{TYPE}` processed it on final approval. */
  automatic: boolean;
}

/**
 * The result of `onFinalApproval`. `CONFLICT` (for example a ChangeRequest whose entity changed
 * since it was submitted) ends the process in status CONFLICT and notifies HR.
 */
export type FinalApprovalResult = { outcome: 'APPLIED' } | { outcome: 'CONFLICT'; reason: string };

/**
 * Connects a workflow type to its domain (section 7.3). Later phases implement one per type
 * (LeaveHandler, ClaimHandler, ChangeRequestHandler, FreeTextHandler, …) and register it with
 * `WorkflowSubjectRegistry` in `onModuleInit`.
 *
 * Hooks run inside the engine's transaction, after the process row is locked and the transition
 * is decided; throwing rolls the whole action back. Hooks write their own domain audit rows.
 */
export interface WorkflowSubjectHandler {
  readonly type: WorkflowTypeCode;

  /** Subject DTO for inbox cards and the detail panel. Read-only; `client` may be a transaction. */
  describe(client: Tx, process: WorkflowProcessSnapshot, viewer?: SubjectViewer): Promise<SubjectDescription>;

  /**
   * The last step was approved. Non-payroll types apply the change here (same transaction) and
   * go straight to PROCESSED; payroll types usually only mark the subject approved.
   */
  onFinalApproval(hook: WorkflowHookContext): Promise<FinalApprovalResult>;

  /** Payroll processed the approved item into a pay period (payroll types only). */
  onProcess(hook: WorkflowProcessHookContext): Promise<void>;

  onDeclined(hook: WorkflowCommentHookContext): Promise<void>;

  onCancelled(hook: WorkflowCancelHookContext): Promise<void>;

  /** Optional: the request went back to the applicant (status RESUBMIT_REQUIRED). */
  onSentBack?(hook: WorkflowCommentHookContext): Promise<void>;

  /** Optional: the applicant resubmitted, possibly with edited `changes` (a new round starts). */
  onResubmitted?(hook: WorkflowResubmitHookContext): Promise<void>;

  /**
   * Optional: warnings for the approver's detail panel, for example "approving takes the balance
   * negative" (section 5.10).
   */
  warnings?(client: Tx, process: WorkflowProcessSnapshot, viewer: SecurityContext): Promise<InboxWarning[]>;
}
