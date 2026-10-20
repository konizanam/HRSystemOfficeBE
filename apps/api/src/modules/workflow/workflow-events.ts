/**
 * Domain events the engine writes to the outbox (section 7.3). Every payload carries
 * `processId`, `workflowType` and `round`; the extra fields are listed per event.
 */
export const WORKFLOW_EVENTS = {
  /** First step assigned on submit. `stepNo`, `assigneeUserIds`, `usedFallback`. */
  submitted: 'workflow.submitted',
  /** A new round's first step assigned on resubmit. Same fields as `submitted`. */
  resubmitted: 'workflow.resubmitted',
  /** A later step assigned after an approval (or a skip). Same fields as `submitted`. */
  stepAssigned: 'workflow.step.assigned',
  /** A step was approved and the request moved on. `stepNo`, `actorUserId`. */
  stepApproved: 'workflow.step.approved',
  /** The last step was approved. */
  approved: 'workflow.approved',
  /** `stepNo`, `actorUserId`, `comment`. */
  declined: 'workflow.declined',
  /** `stepNo`, `actorUserId`, `comment`. */
  sentBack: 'workflow.sent_back',
  /** Withdrawn or cancelled. `actorUserId`, `notifyUserIds` (assignees of open steps), `reason`. */
  cancelled: 'workflow.cancelled',
  /** `payPeriodId`. */
  processed: 'workflow.processed',
  /** `stepNo`, `assigneeUserId`, `managerUserId`. */
  escalated: 'workflow.escalated',
  /** `stepNo`, `fromUserId`, `assigneeUserIds`, `reason` (MANUAL, ESCALATION, APPROVER_UNAVAILABLE). */
  reassigned: 'workflow.reassigned',
  /** Out-of-office delegation. `stepNo`, `fromUserId`, `assigneeUserIds`. */
  delegated: 'workflow.delegated',
  /** Delegation cycle detected; HR is alerted. `stepNo`, `chain`. */
  delegationCycle: 'workflow.delegation_cycle',
  /** A parked step is back. `stepNo`, `assigneeUserId`. */
  parkedDue: 'workflow.parked_due',
  /** Final approval could not be applied. `reason`. */
  conflict: 'workflow.conflict',
} as const;

export type WorkflowEventType = (typeof WORKFLOW_EVENTS)[keyof typeof WORKFLOW_EVENTS];
