import type {
  ApprovalHistory,
  ApprovalHistoryApplicant,
  ApprovalHistoryEvent,
  RemainingStep,
  WorkflowPerson,
} from './api/workflow';
import { formatTimestampDate } from './dates';
import type { ProcessStatus } from './enums';

// Renders the approval history modal in the exact format observed in the source system
// (section 1.5). Pure functions: the API fills `renderedText` with them, and the web app may use
// them to re-render a history it already holds.

/** "{Title} {Initials} {Surname}", skipping parts that are empty. */
export function formalName(person: {
  title?: string | null;
  initials?: string | null;
  lastName: string;
}): string {
  return [person.title, person.initials, person.lastName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' ');
}

/** The "Current Status Of Request" sentence. Only APPROVED_PENDING_PROCESS was observed verbatim. */
export function approvalStatusText(status: ProcessStatus, requestLabel: string): string {
  const subject = `This ${requestLabel} Request`;
  switch (status) {
    case 'DRAFT':
      return `${subject} has not been Submitted.`;
    case 'IN_PROGRESS':
      return `${subject} is In Progress and is waiting to be Approved.`;
    case 'RESUBMIT_REQUIRED':
      return `${subject} has been Sent Back and is waiting to be Resubmitted.`;
    case 'APPROVED_PENDING_PROCESS':
      return `${subject} has been Approved and is waiting to be Processed.`;
    case 'PROCESSED':
      return `${subject} has been Approved and Processed.`;
    case 'DECLINED':
      return `${subject} has been Declined.`;
    case 'CANCELLED':
      return `${subject} has been Cancelled.`;
    case 'CONFLICT':
      return `${subject} has been Approved but could not be Applied because the record had changed.`;
  }
}

function nameOf(person: WorkflowPerson | null): string {
  return person ? person.name : 'System';
}

/** What an event needs to render; `text` is not required (it is what this produces). */
export type HistoryEventInput = Omit<ApprovalHistoryEvent, 'text'>;

/**
 * One history line for an event. Returns null for events that have no line of their own (the
 * SUBMIT that follows CREATE).
 */
export function historyEventLine(
  event: HistoryEventInput,
  context: { requestLabel: string; applicant: ApprovalHistoryApplicant },
): string | null {
  const on = formatTimestampDate(event.at);
  const label = context.requestLabel;
  switch (event.action) {
    case 'CREATE':
      return `CREATED: New ${label} Request on ${on} by Applicant ${context.applicant.employeeCode} - ${formalName(context.applicant)}`;
    case 'SUBMIT':
      return null;
    case 'RESUBMIT':
      return `RESUBMITTED: ${label} Request resubmitted on ${on} by ${nameOf(event.actor)}`;
    case 'WITHDRAW':
      return `WITHDRAWN: ${label} Request withdrawn on ${on} by ${nameOf(event.actor)}`;
    case 'CANCEL':
      return `CANCELLED: ${label} Request cancelled on ${on} by ${nameOf(event.actor)}`;
    case 'PROCESS':
      return `PROCESSED: ${label} Request processed on ${on} by ${nameOf(event.actor)}`;
    case 'APPLY':
      return `COMPLETED: ${label} Request applied on ${on}`;
    case 'CONFLICT':
      return `CONFLICT: ${label} Request could not be applied on ${on} because the record had changed`;
    case 'APPROVE':
      return `Approved by ${nameOf(event.actor)} on ${on}`;
    case 'DECLINE':
      return `Declined by ${nameOf(event.actor)} on ${on}`;
    case 'REASSIGN':
      return event.to
        ? `Reassigned from ${nameOf(event.from)} to ${nameOf(event.to)} by ${nameOf(event.actor)} on ${on}`
        : `Reassigned from ${nameOf(event.from)} by ${nameOf(event.actor)} on ${on}`;
    case 'DELEGATE':
      return `Delegated from ${nameOf(event.from)} to ${nameOf(event.to)} (out of office) on ${on}`;
    case 'PARK':
      return `Parked by ${nameOf(event.actor)} until ${event.parkedUntil ? formatTimestampDate(event.parkedUntil) : ''} on ${on}`;
    case 'UNPARK':
      return `Returned from parking on ${on}`;
    case 'SEND_BACK':
      return `Sent back for resubmission by ${nameOf(event.actor)} on ${on}`;
    case 'ESCALATE':
      return event.to ? `Escalated to ${nameOf(event.to)} on ${on}` : `Escalated as overdue on ${on}`;
    case 'AUTO_SKIP':
      return `Skipped automatically on ${on}`;
    case 'COMMENT':
      return `Comment by ${nameOf(event.actor)} on ${on}`;
  }
}

/** The fields `renderApprovalHistory` reads. */
export type ApprovalHistoryInput = Pick<
  ApprovalHistory,
  'processId' | 'requestLabel' | 'status' | 'applicant'
> & {
  events: (HistoryEventInput & { text?: string })[];
  remaining: RemainingStep[];
};

function approverLine(step: RemainingStep, person: WorkflowPerson | null): string {
  const suffix = step.isMandatory ? 'Mandatory' : 'Optional';
  return `${person ? person.name : (step.roleLabel ?? 'Not yet assigned')} (${suffix})`;
}

/**
 * The approval history modal text (section 1.5). Step events are grouped under "Step n"
 * headers; a comment follows its event as "Comment: …"; "Remaining Approvers" is left out when
 * no step is outstanding.
 */
export function renderApprovalHistory(history: ApprovalHistoryInput): string {
  const { applicant, requestLabel } = history;
  const lines: string[] = [
    `Approval history - ${applicant.firstName} ${applicant.lastName} - ${applicant.employeeCode}`,
    'Current Status Of Request',
    approvalStatusText(history.status, requestLabel),
    'History Of Request',
  ];

  let currentGroup: string | null = null;
  for (const event of history.events) {
    const line = event.text ?? historyEventLine(event, { requestLabel, applicant });
    if (line === null || line === '') continue;
    if (event.stepNo === null) {
      currentGroup = null;
    } else {
      const group = `${event.round}:${event.stepNo}`;
      if (group !== currentGroup) {
        lines.push(`Step ${event.stepNo}`);
        currentGroup = group;
      }
    }
    lines.push(line);
    if (event.comment && event.action !== 'CREATE') lines.push(`Comment: ${event.comment}`);
  }

  if (history.remaining.length > 0) {
    lines.push('Remaining Approvers');
    for (const step of history.remaining) {
      lines.push(`Step ${step.stepNo}`);
      if (step.approvers.length === 0) lines.push(approverLine(step, null));
      for (const person of step.approvers) lines.push(approverLine(step, person));
    }
  }

  lines.push(`Workflow Process ID: ${history.processId}`);
  return lines.join('\n');
}
