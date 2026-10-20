import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type NotificationKind, WORKFLOW_REQUEST_LABELS, type WorkflowTypeCode } from '@peoplehub/shared';
import { SYSTEM_USER_ID } from '../../common/context/security-context';
import { env } from '../../config/env';
import { type DomainEvent, type EventContext, EventBus } from '../../events/event-bus';
import type { Tx } from '../../prisma/prisma-client';
import type { MailTemplateName } from '../notifications/mail-templates';
import { MailService } from '../notifications/mail.service';
import { NotificationService } from '../notifications/notification.service';
import { availableInCompany } from './people.service';
import { WORKFLOW_EVENTS, type WorkflowEventType } from './workflow-events';

type Audience = 'assignees' | 'applicant' | 'escalation' | 'cancelled' | 'hr';

interface Rule {
  kind: NotificationKind;
  template: MailTemplateName;
  audience: Audience;
  title: (label: string, stepNo: number | null) => string;
  body: (facts: {
    applicant: string;
    label: string;
    stepNo: number | null;
    comment: string | null;
  }) => string;
}

const RULES: Record<WorkflowEventType, Rule> = {
  [WORKFLOW_EVENTS.submitted]: {
    kind: 'WORKFLOW_SUBMITTED',
    template: 'workflow-approval-required',
    audience: 'assignees',
    title: (label) => `New ${label} request for approval`,
    body: (f) => `${f.applicant} submitted a ${f.label} request that is waiting for your approval.`,
  },
  [WORKFLOW_EVENTS.resubmitted]: {
    kind: 'WORKFLOW_SUBMITTED',
    template: 'workflow-approval-required',
    audience: 'assignees',
    title: (label) => `Resubmitted ${label} request for approval`,
    body: (f) => `${f.applicant} resubmitted a ${f.label} request that is waiting for your approval.`,
  },
  [WORKFLOW_EVENTS.stepAssigned]: {
    kind: 'WORKFLOW_APPROVAL_REQUIRED',
    template: 'workflow-approval-required',
    audience: 'assignees',
    title: (label) => `${label} request waiting for your approval`,
    body: (f) =>
      `A ${f.label} request from ${f.applicant} is waiting for your approval at step ${f.stepNo ?? ''}.`,
  },
  [WORKFLOW_EVENTS.stepApproved]: {
    kind: 'WORKFLOW_STEP_APPROVED',
    template: 'workflow-step-approved',
    audience: 'applicant',
    title: (label, stepNo) => `${label} request approved at step ${stepNo ?? ''}`,
    body: (f) =>
      `Your ${f.label} request was approved at step ${f.stepNo ?? ''} and moved to the next approver.`,
  },
  [WORKFLOW_EVENTS.approved]: {
    kind: 'WORKFLOW_APPROVED',
    template: 'workflow-approved',
    audience: 'applicant',
    title: (label) => `${label} request approved`,
    body: (f) => `Your ${f.label} request has been approved.`,
  },
  [WORKFLOW_EVENTS.declined]: {
    kind: 'WORKFLOW_DECLINED',
    template: 'workflow-declined',
    audience: 'applicant',
    title: (label) => `${label} request declined`,
    body: (f) => `Your ${f.label} request was declined.${f.comment ? ` Comment: ${f.comment}` : ''}`,
  },
  [WORKFLOW_EVENTS.sentBack]: {
    kind: 'WORKFLOW_SENT_BACK',
    template: 'workflow-sent-back',
    audience: 'applicant',
    title: (label) => `${label} request sent back to you`,
    body: (f) =>
      `Your ${f.label} request was sent back for changes.${f.comment ? ` Comment: ${f.comment}` : ''}`,
  },
  [WORKFLOW_EVENTS.cancelled]: {
    kind: 'WORKFLOW_CANCELLED',
    template: 'workflow-cancelled',
    audience: 'cancelled',
    title: (label) => `${label} request cancelled`,
    body: (f) => `The ${f.label} request from ${f.applicant} was cancelled.`,
  },
  [WORKFLOW_EVENTS.processed]: {
    kind: 'WORKFLOW_PROCESSED',
    template: 'workflow-processed',
    audience: 'applicant',
    title: (label) => `${label} request processed`,
    body: (f) => `Your ${f.label} request has been processed.`,
  },
  [WORKFLOW_EVENTS.escalated]: {
    kind: 'WORKFLOW_ESCALATED',
    template: 'workflow-escalated',
    audience: 'escalation',
    title: (label) => `${label} request overdue for approval`,
    body: (f) =>
      `A ${f.label} request from ${f.applicant} is overdue for approval at step ${f.stepNo ?? ''}.`,
  },
  [WORKFLOW_EVENTS.reassigned]: {
    kind: 'WORKFLOW_REASSIGNED',
    template: 'workflow-reassigned',
    audience: 'assignees',
    title: (label) => `${label} request reassigned to you`,
    body: (f) => `A ${f.label} request from ${f.applicant} has been reassigned to you for approval.`,
  },
  [WORKFLOW_EVENTS.delegated]: {
    kind: 'WORKFLOW_DELEGATED',
    template: 'workflow-delegated',
    audience: 'assignees',
    title: (label) => `${label} request delegated to you`,
    body: (f) =>
      `A ${f.label} request from ${f.applicant} was sent to you because the approver is out of office.`,
  },
  [WORKFLOW_EVENTS.parkedDue]: {
    kind: 'WORKFLOW_PARKED_DUE',
    template: 'workflow-parked-due',
    audience: 'assignees',
    title: (label) => `Parked ${label} request is back`,
    body: (f) => `The ${f.label} request from ${f.applicant} that you parked is back in Action Required.`,
  },
  [WORKFLOW_EVENTS.delegationCycle]: {
    kind: 'WORKFLOW_DELEGATION_CYCLE',
    template: 'workflow-delegation-cycle',
    audience: 'hr',
    title: () => 'Out-of-office delegation cycle',
    body: (f) =>
      `The out-of-office nominees for a ${f.label} request from ${f.applicant} point at each other. The request stayed with the original approver.`,
  },
  [WORKFLOW_EVENTS.conflict]: {
    kind: 'WORKFLOW_CONFLICT',
    template: 'workflow-conflict',
    audience: 'hr',
    title: (label) => `${label} change could not be applied`,
    body: (f) =>
      `An approved ${f.label} request from ${f.applicant} could not be applied because the record changed. Apply it manually.`,
  },
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Turns workflow events into in-app notifications and email (section 6). Runs inside the outbox
 * delivery transaction; email is sent after that commits. Emails carry only the first name, the
 * request type and a link; the in-app text may name the applicant and quote the comment.
 */
@Injectable()
export class WorkflowNotifier implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly notifications: NotificationService,
    private readonly mail: MailService,
  ) {}

  onModuleInit(): void {
    for (const type of Object.values(WORKFLOW_EVENTS)) {
      this.bus.subscribe(type, (event, context) => this.handle(event, context));
    }
  }

  private async handle(event: DomainEvent, { tx, afterCommit }: EventContext): Promise<void> {
    const rule = RULES[event.type as WorkflowEventType];
    const processId = typeof event.payload.processId === 'number' ? event.payload.processId : null;
    if (!rule || processId === null) return;
    const p = await tx.workflowProcess.findUnique({
      where: { id: processId },
      select: {
        id: true,
        submittedByUserId: true,
        workflowType: { select: { code: true } },
        subjectEmployee: {
          select: {
            firstName: true,
            lastName: true,
            employeeCode: true,
            companyId: true,
            user: { select: { id: true } },
          },
        },
      },
    });
    if (!p) return;
    const label = WORKFLOW_REQUEST_LABELS[p.workflowType.code as WorkflowTypeCode];
    const stepNo = typeof event.payload.stepNo === 'number' ? event.payload.stepNo : null;
    const actor = str(event.payload.actorUserId);
    const applicantIds = [p.subjectEmployee.user?.id, p.submittedByUserId].filter(
      (id): id is string => typeof id === 'string' && id !== SYSTEM_USER_ID,
    );

    let recipients: string[];
    switch (rule.audience) {
      case 'assignees': {
        // A delegated nominee hears about the item once, through the delegation notice.
        const delegated =
          event.type === WORKFLOW_EVENTS.delegated ? [] : strings(event.payload.delegatedUserIds);
        recipients = [
          ...strings(event.payload.assigneeUserIds),
          ...strings([event.payload.assigneeUserId]),
        ].filter((id) => !delegated.includes(id));
        break;
      }
      case 'applicant':
        recipients = applicantIds;
        break;
      case 'escalation':
        recipients = strings([event.payload.assigneeUserId, event.payload.managerUserId]);
        break;
      case 'cancelled':
        recipients = [...strings(event.payload.notifyUserIds), ...applicantIds];
        break;
      case 'hr':
        recipients = await this.hrAdmins(tx, p.subjectEmployee.companyId);
        break;
    }
    const unique = [...new Set(recipients)].filter((id) => id !== actor && id !== SYSTEM_USER_ID);
    if (unique.length === 0) return;

    const users = await tx.user.findMany({
      where: { id: { in: unique }, isActive: true },
      select: { id: true, email: true, username: true, employee: { select: { firstName: true } } },
    });
    const link = `/inbox/items/${p.id}`;
    const facts = {
      applicant: `${p.subjectEmployee.firstName} ${p.subjectEmployee.lastName} - ${p.subjectEmployee.employeeCode}`,
      label,
      stepNo,
      comment: str(event.payload.comment),
    };
    for (const user of users) {
      await this.notifications.create(tx, {
        userId: user.id,
        kind: rule.kind,
        title: rule.title(label, stepNo),
        body: rule.body(facts),
        link,
      });
      const email = user.email;
      if (!email) continue;
      const firstName = user.employee?.firstName ?? user.username;
      afterCommit(() =>
        this.mail.sendInBackground({
          to: email,
          template: rule.template,
          data: { firstName, requestType: label, link: `${env().PUBLIC_URL}${link}` },
        }),
      );
    }
  }

  private async hrAdmins(tx: Tx, companyId: number): Promise<string[]> {
    const rows = await tx.user.findMany({
      where: { ...availableInCompany(companyId), roles: { has: 'HR_ADMIN' } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
