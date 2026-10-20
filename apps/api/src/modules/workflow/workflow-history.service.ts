import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  type ApprovalHistory,
  type ApprovalHistoryEvent,
  approvalStatusText,
  historyEventLine,
  PROCESS_STATUS_LABELS,
  type RemainingStep,
  renderApprovalHistory,
  ROLE_LABELS,
  type WorkflowPerson,
} from '@peoplehub/shared';
import { type SecurityContext, SYSTEM_USER_ID } from '../../common/context/security-context';
import { NotFoundError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { ApproverResolver } from './approver-resolver.service';
import { unknownPerson, WorkflowPeopleService } from './people.service';
import {
  type LoadedProcess,
  OPEN_STEP_STATUSES,
  PROCESS_INCLUDE,
  resolutionSubject,
  toSnapshot,
  typeCode,
} from './process-shape';
import { WorkflowSubjectRegistry } from './subject-registry';
import { WorkflowAccessService } from './workflow-access.service';

type ActionRow = Prisma.WorkflowActionGetPayload<{
  include: { stepInstance: { select: { stepNo: true; round: true } } };
}>;

function metaOf(row: { metadata: Prisma.JsonValue }): Record<string, unknown> {
  const m = row.metadata;
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The single id of a one-element id list (a system reassignment to one person), else null. */
function onlyOne(value: unknown): string | null {
  return Array.isArray(value) && value.length === 1 ? str(value[0]) : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * Builds the approval history (section 1.5): structured events, the remaining approvers and the
 * rendered modal text. Readers are the applicant, the approvers, HR/Payroll in scope and auditors.
 */
@Injectable()
export class WorkflowHistoryService {
  constructor(
    private readonly db: DbService,
    private readonly people: WorkflowPeopleService,
    private readonly resolver: ApproverResolver,
    private readonly registry: WorkflowSubjectRegistry,
    private readonly access: WorkflowAccessService,
  ) {}

  /** Loads a process the caller may read (404 when missing, 403 audited when out of scope). */
  async loadReadable(ctx: SecurityContext, processId: number): Promise<LoadedProcess> {
    const p = await this.db.prisma.workflowProcess.findUnique({
      where: { id: processId },
      include: PROCESS_INCLUDE,
    });
    if (!p) throw new NotFoundError('Workflow process');
    await this.access.assertCanRead(this.db.prisma, ctx, {
      id: p.id,
      subjectEmployeeId: p.subjectEmployeeId,
      submittedByUserId: p.submittedByUserId,
      companyId: p.subjectEmployee.companyId,
    });
    return p;
  }

  async history(ctx: SecurityContext, processId: number): Promise<ApprovalHistory> {
    return this.build(this.db.prisma, await this.loadReadable(ctx, processId));
  }

  async actions(client: Tx, processId: number): Promise<ActionRow[]> {
    return client.workflowAction.findMany({
      where: { processId },
      orderBy: { id: 'asc' },
      include: { stepInstance: { select: { stepNo: true, round: true } } },
    });
  }

  /** The history events with names resolved (also used for the inbox comments). */
  async events(
    client: Tx,
    p: LoadedProcess,
    requestLabel: string,
    rows?: ActionRow[],
  ): Promise<{
    events: ApprovalHistoryEvent[];
    persons: Map<string, WorkflowPerson>;
  }> {
    const actions = rows ?? (await this.actions(client, p.id));
    const ids: string[] = [p.submittedByUserId];
    for (const a of actions) {
      ids.push(a.actorUserId);
      const m = metaOf(a);
      for (const key of ['fromUserId', 'toUserId']) {
        const id = str(m[key]);
        if (id) ids.push(id);
      }
      const single = onlyOne(m.toUserIds);
      if (single) ids.push(single);
    }
    const persons = await this.people.byIds(client, ids);
    const person = (id: string | null): WorkflowPerson | null =>
      id === null || id === SYSTEM_USER_ID ? null : (persons.get(id) ?? unknownPerson(id));
    const applicant = this.applicantOf(p);
    const events = actions.map((a): ApprovalHistoryEvent => {
      const m = metaOf(a);
      const base = {
        id: a.id,
        action: a.action,
        at: a.createdAt.toISOString(),
        round: a.stepInstance?.round ?? num(m.round) ?? 1,
        stepNo: a.stepInstance?.stepNo ?? num(m.stepNo),
        actor: person(a.actorUserId),
        from: person(str(m.fromUserId)),
        to: person(str(m.toUserId) ?? onlyOne(m.toUserIds)),
        comment: a.comment,
        parkedUntil: str(m.parkedUntil),
        fromStatus: a.fromStatus,
        toStatus: a.toStatus,
      };
      return { ...base, text: historyEventLine(base, { requestLabel, applicant }) ?? '' };
    });
    return { events, persons };
  }

  async build(client: Tx, p: LoadedProcess): Promise<ApprovalHistory> {
    const type = typeCode(p);
    const description = await this.registry.get(type).describe(client, toSnapshot(p, type));
    const { events, persons } = await this.events(client, p, description.requestLabel);
    const remaining = await this.remaining(client, p);
    const applicant = this.applicantOf(p);
    const submittedBy = persons.get(p.submittedByUserId) ?? unknownPerson(p.submittedByUserId);
    const history = {
      processId: p.id,
      workflowType: type,
      requestLabel: description.requestLabel,
      status: p.status,
      statusLabel: PROCESS_STATUS_LABELS[p.status],
      statusText: approvalStatusText(p.status, description.requestLabel),
      applicant,
      submittedBy,
      submittedOnBehalf: p.submittedOnBehalf,
      createdAt: p.createdAt.toISOString(),
      round: p.round,
      events,
      remaining,
    };
    return { ...history, renderedText: renderApprovalHistory(history) };
  }

  private applicantOf(p: LoadedProcess) {
    const e = p.subjectEmployee;
    return {
      employeeId: e.id,
      employeeCode: e.employeeCode,
      firstName: e.firstName,
      lastName: e.lastName,
      title: e.title,
      initials: e.initials,
    };
  }

  /**
   * Steps still to approve while the request is in progress: the current step with its open
   * assignees, then the later steps with the approvers they are expected to resolve to now
   * (a ROLE step shows "Any {role}"). Steps that would be skipped are left out.
   */
  async remaining(client: Tx, p: LoadedProcess): Promise<RemainingStep[]> {
    if (p.status !== 'IN_PROGRESS' || p.currentStepNo === null) return [];
    const open = await client.workflowStepInstance.findMany({
      where: {
        processId: p.id,
        round: p.round,
        stepNo: p.currentStepNo,
        status: { in: [...OPEN_STEP_STATUSES] },
      },
      orderBy: { id: 'asc' },
      select: { assigneeUserId: true },
    });
    const later = p.definition.steps.filter((s) => s.stepNo > (p.currentStepNo ?? 0));
    const subject = resolutionSubject(p);
    const applicantUserIds = await this.resolver.applicantUserIds(client, subject);
    const plans = await Promise.all(
      later.map((step) =>
        this.resolver.plan(client, step, subject, { applicantUserIds, previousApproverUserId: null }),
      ),
    );
    const ids = [
      ...open.map((i) => i.assigneeUserId),
      ...plans.flatMap((plan) => (plan.kind === 'ASSIGN' ? plan.userIds : [])),
    ];
    const persons = await this.people.byIds(client, ids);
    const person = (id: string) => persons.get(id) ?? unknownPerson(id);

    const result: RemainingStep[] = [];
    const current = p.definition.steps.find((s) => s.stepNo === p.currentStepNo);
    if (current) {
      result.push({
        stepNo: current.stepNo,
        name: current.name,
        isMandatory: current.isMandatory,
        approvers: open.map((i) => person(i.assigneeUserId)),
        roleLabel: null,
        isCurrent: true,
      });
    }
    later.forEach((step, index) => {
      const plan = plans[index];
      if (!plan || plan.kind === 'SKIP') return;
      const role = plan.kind === 'ASSIGN' && plan.usedFallback ? 'HR_ADMIN' : step.approverRole;
      const isRoleStep = step.resolution === 'ROLE' || (plan.kind === 'ASSIGN' && plan.usedFallback);
      result.push({
        stepNo: step.stepNo,
        name: step.name,
        isMandatory: step.isMandatory,
        approvers: plan.kind === 'ASSIGN' && !isRoleStep ? plan.userIds.map(person) : [],
        roleLabel:
          isRoleStep && role
            ? `Any ${ROLE_LABELS[role]}`
            : plan.kind === 'UNRESOLVABLE'
              ? 'No approver available'
              : null,
        isCurrent: false,
      });
    });
    return result;
  }
}
