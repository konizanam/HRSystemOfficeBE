import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Prisma, ProcessStatus, WorkflowProcess, WorkflowStep } from '@prisma/client';
import {
  addDays,
  type ApprovalHistory,
  type BulkActionResponse,
  type BulkItemResult,
  type BusinessDate,
  dateFromBusiness,
  requiresPayrollProcessing,
  type SettingKey,
  todayBusinessDate,
  WORKFLOW_PROBLEM_TYPES,
  type WorkflowActionType,
  type WorkflowProcessDto,
  type WorkflowTypeCode,
} from '@peoplehub/shared';
import { fromZonedTime } from 'date-fns-tz';
import type { AuditEntry } from '../../audit/audit-scope';
import { AuditService } from '../../audit/audit.service';
import {
  isActingForOther,
  type SecurityContext,
  SYSTEM_USER_ID,
  systemContext,
} from '../../common/context/security-context';
import {
  assertVersion,
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { OutboxService } from '../../events/outbox.service';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { ScopeService } from '../auth/scope.service';
import { SettingsService } from '../settings/settings.service';
import { ApproverResolver } from './approver-resolver.service';
import { resolveDelegation, selectDefinition, type StepPlan } from './engine-rules';
import { OutOfOfficeService } from './out-of-office.service';
import { isAvailable, WorkflowPeopleService } from './people.service';
import {
  type LoadedProcess,
  OPEN_STEP_STATUSES,
  PROCESS_INCLUDE,
  processRow,
  resolutionSubject,
  toProcessDto,
  toSnapshot,
  typeCode,
  WORKFLOW_AUDIT_ACTIONS,
} from './process-shape';
import { WorkflowSubjectRegistry } from './subject-registry';
import { WorkflowAccessService } from './workflow-access.service';
import { WorkflowHistoryService } from './workflow-history.service';
import type { PayPeriodRef, WorkflowProcessSnapshot } from './workflow-subject';
import { WORKFLOW_EVENTS } from './workflow-events';

const HOUR_MS = 3_600_000;

/** Longest a step may be parked. */
const MAX_PARK_DAYS = 365;

/** `workflow.autoProcess.{TYPE}` setting of each payroll-processed type (section 7.2). */
const AUTO_PROCESS_SETTING: Partial<Record<WorkflowTypeCode, SettingKey>> = {
  LEAVE: 'workflow.autoProcess.LEAVE',
  CANCELLEAVE: 'workflow.autoProcess.CANCELLEAVE',
  CLAIMS: 'workflow.autoProcess.CLAIMS',
  GROUPEDCLAIM: 'workflow.autoProcess.GROUPEDCLAIM',
  CREDITLVEALLOC: 'workflow.autoProcess.CREDITLVEALLOC',
  CREDITLVEREQ: 'workflow.autoProcess.CREDITLVEREQ',
};

export interface StartWorkflowInput {
  type: WorkflowTypeCode;
  /** Prisma model of the subject, e.g. `LeaveApplication`. */
  subjectEntity: string;
  subjectEntityId: string | number;
  subjectEmployeeId: number;
  /** One line for cards and lists, e.g. "Annual Leave 24-Sep-2026 to 26-Sep-2026 (3 days)". */
  summary: string;
  /** Selects a narrower definition, e.g. a claim group id. */
  discriminator?: string | null;
  /** The applicant's comment, kept on the CREATE action. */
  comment?: string | null;
}

export type ActAction = 'APPROVE' | 'DECLINE' | 'REASSIGN' | 'PARK' | 'SEND_BACK' | 'COMMENT';

export interface ActInput {
  action: ActAction;
  expectedVersion: number;
  comment?: string | null;
  reassignToUserId?: string;
  /** PARK: the business date the step comes back (start of day, Africa/Windhoek). */
  parkUntil?: BusinessDate;
}

type AssignedEvent = (typeof WORKFLOW_EVENTS)[keyof typeof WORKFLOW_EVENTS];

interface Plan {
  skips: { step: WorkflowStep; plan: Extract<StepPlan, { kind: 'SKIP' }> }[];
  assign: { step: WorkflowStep; plan: Extract<StepPlan, { kind: 'ASSIGN' }> } | null;
}

interface ActionRecord {
  action: WorkflowActionType;
  stepInstanceId?: number | null;
  stepNo?: number | null;
  comment?: string | null;
  fromStatus?: ProcessStatus | null;
  toStatus?: ProcessStatus | null;
  metadata?: Record<string, unknown>;
  /** Defaults to the caller; automatic actions (skip, delegation, jobs) use SYSTEM. */
  actorUserId?: string;
}

/**
 * One engine call on one process: the row was locked and loaded; changes, audit rows and events
 * are collected and written by `commit` in the same transaction.
 */
class Operation {
  readonly now = new Date();
  readonly data: Prisma.WorkflowProcessUncheckedUpdateInput = {};
  readonly audits: AuditEntry[] = [];
  readonly events: { type: string; payload: Record<string, unknown> }[] = [];
  status: ProcessStatus;
  round: number;
  currentStepNo: number | null;
  applicants: Set<string> | null = null;
  /** Assignees who got their step through out-of-office delegation (they get the delegation notice). */
  readonly delegatedTo = new Set<string>();

  constructor(
    readonly p: LoadedProcess,
    readonly ctx: SecurityContext,
    readonly before: WorkflowProcess | null = processRow(p),
  ) {
    this.status = p.status;
    this.round = p.round;
    this.currentStepNo = p.currentStepNo;
  }

  get type(): WorkflowTypeCode {
    return typeCode(this.p);
  }

  set(fields: {
    status?: ProcessStatus;
    round?: number;
    currentStepNo?: number | null;
    isEscalated?: boolean;
    submittedAt?: Date;
    finalApprovedAt?: Date | null;
    processedAt?: Date | null;
    completedAt?: Date | null;
  }): void {
    Object.assign(this.data, fields);
    if (fields.status !== undefined) this.status = fields.status;
    if (fields.round !== undefined) this.round = fields.round;
    if (fields.currentStepNo !== undefined) this.currentStepNo = fields.currentStepNo;
  }

  snapshot(): WorkflowProcessSnapshot {
    return { ...toSnapshot(this.p, this.type), status: this.status, round: this.round };
  }

  event(type: string, payload: Record<string, unknown> = {}): void {
    this.events.push({
      type,
      payload: { processId: this.p.id, workflowType: this.type, round: this.round, ...payload },
    });
  }
}

function problem(status: number, detail: string, type: string): DomainError {
  return new DomainError(
    status,
    status === 422 ? 'Validation failed' : 'Conflict',
    detail,
    status === 422 ? [{ path: '', message: detail }] : undefined,
    type,
  );
}

/**
 * The workflow engine (section 7). Every public call runs in one transaction: it locks the
 * process row, checks the caller and the version (409 on mismatch), writes WorkflowAction rows,
 * `WORKFLOW.*` audit rows and outbox events, and calls the subject handler of the type.
 */
@Injectable()
export class WorkflowEngine {
  private readonly logger = new Logger(WorkflowEngine.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly scope: ScopeService,
    private readonly registry: WorkflowSubjectRegistry,
    private readonly resolver: ApproverResolver,
    private readonly people: WorkflowPeopleService,
    private readonly outOfOffice: OutOfOfficeService,
    private readonly outbox: OutboxService,
    private readonly access: WorkflowAccessService,
    private readonly historyService: WorkflowHistoryService,
  ) {}

  // ───────────── Public API (section 7.3) ─────────────

  /**
   * Starts (submits) a process for a subject. Call it inside the subject's submit transaction;
   * the nested `db.tx` joins it. Fails with 422 when no definition applies or a mandatory step
   * has no approver.
   */
  async start(ctx: SecurityContext, input: StartWorkflowInput): Promise<WorkflowProcessDto> {
    return this.db.tx(ctx, async (tx) => {
      if (!ctx.isSystem && !(await this.scope.canActFor(ctx, input.subjectEmployeeId))) {
        throw new ForbiddenError('You cannot submit requests for this employee', {
          subjectEmployeeId: input.subjectEmployeeId,
          metadata: { workflowType: input.type },
        });
      }
      const employee = await tx.employee.findFirst({
        where: { id: input.subjectEmployeeId, deletedAt: null },
        select: { id: true, status: true, companyRuleId: true },
      });
      if (!employee) throw new NotFoundError('Employee');
      if (employee.status !== 'ACTIVE') {
        throw ValidationError.field(
          'subjectEmployeeId',
          'Requests can only be submitted for active employees',
        );
      }
      const type = await tx.workflowType.findUnique({ where: { code: input.type } });
      if (!type?.isActive) throw ValidationError.field('type', 'This request type is not available');
      const definition = await this.findDefinition(
        tx,
        type.id,
        employee.companyRuleId,
        input.discriminator ?? null,
      );
      if (!definition || definition.steps.length === 0) {
        throw problem(
          422,
          'No approval workflow is set up for this request type',
          WORKFLOW_PROBLEM_TYPES.noApprover,
        );
      }

      const created = await tx.workflowProcess.create({
        data: {
          workflowTypeId: type.id,
          definitionId: definition.id,
          subjectEmployeeId: employee.id,
          submittedByUserId: ctx.userId,
          submittedOnBehalf: ctx.selfEmployeeId !== employee.id,
          subjectEntity: input.subjectEntity,
          subjectEntityId: String(input.subjectEntityId),
          summary: input.summary.slice(0, 500),
          status: 'DRAFT',
        },
      });
      const p = await tx.workflowProcess.findUniqueOrThrow({
        where: { id: created.id },
        include: PROCESS_INCLUDE,
      });
      const op = new Operation(p, ctx, null);
      await this.recordAction(tx, op, {
        action: 'CREATE',
        toStatus: 'DRAFT',
        comment: input.comment ?? null,
        metadata: { definitionId: definition.id, discriminator: input.discriminator ?? null },
      });
      op.set({ status: 'IN_PROGRESS', submittedAt: op.now });
      const plan = await this.planFrom(tx, op, 1, null);
      await this.recordAction(tx, op, {
        action: 'SUBMIT',
        fromStatus: 'DRAFT',
        toStatus: plan.assign ? 'IN_PROGRESS' : 'APPROVED_PENDING_PROCESS',
      });
      await this.applyPlan(tx, op, plan, WORKFLOW_EVENTS.submitted);
      return toProcessDto(await this.commit(tx, op), op.type);
    });
  }

  /** Approver actions (section 5.10). Only a current assignee may act; COMMENT also the applicant. */
  async act(ctx: SecurityContext, processId: number, input: ActInput): Promise<WorkflowProcessDto> {
    if (input.action === 'COMMENT') return this.comment(ctx, processId, input);
    return this.db.tx(ctx, async (tx) => {
      const op = await this.open(tx, ctx, processId);
      const mine = await this.assertCanAct(tx, op, input.expectedVersion);
      const step = this.stepOf(op, mine.stepId);
      const comment = input.comment?.trim() || null;
      switch (input.action) {
        case 'APPROVE':
          await this.approve(tx, op, mine, step, comment);
          break;
        case 'DECLINE':
          await this.decline(tx, op, mine, comment);
          break;
        case 'REASSIGN':
          await this.reassign(tx, op, mine, step, input.reassignToUserId, comment);
          break;
        case 'PARK':
          await this.park(tx, op, mine, input.parkUntil, comment);
          break;
        case 'SEND_BACK':
          await this.sendBack(tx, op, mine, comment);
          break;
      }
      return toProcessDto(await this.commit(tx, op), op.type);
    });
  }

  /** The applicant (or submitter) withdraws an in-flight request (CANCELLED). */
  async withdraw(
    ctx: SecurityContext,
    processId: number,
    expectedVersion: number,
    comment?: string | null,
  ): Promise<WorkflowProcessDto> {
    return this.db.tx(ctx, async (tx) => {
      const op = await this.open(tx, ctx, processId);
      this.assertApplicant(op);
      assertVersion(op.p, expectedVersion);
      if (!['DRAFT', 'IN_PROGRESS', 'RESUBMIT_REQUIRED'].includes(op.status)) {
        throw new ConflictError('This request can no longer be withdrawn');
      }
      await this.terminate(tx, op, 'WITHDRAW', comment?.trim() || null);
      return toProcessDto(await this.commit(tx, op), op.type);
    });
  }

  /**
   * Cancels a process on behalf of a domain service (for example an approved leave cancellation,
   * or HR). The caller has already decided the actor may do this; the engine only checks state.
   */
  async cancel(
    ctx: SecurityContext,
    processId: number,
    options: { comment?: string | null; expectedVersion?: number } = {},
  ): Promise<WorkflowProcessDto> {
    return this.db.tx(ctx, async (tx) => {
      const op = await this.open(tx, ctx, processId);
      if (options.expectedVersion !== undefined) assertVersion(op.p, options.expectedVersion);
      if (!['DRAFT', 'IN_PROGRESS', 'RESUBMIT_REQUIRED', 'APPROVED_PENDING_PROCESS'].includes(op.status)) {
        throw new ConflictError('This request can no longer be cancelled');
      }
      await this.terminate(tx, op, 'CANCEL', options.comment?.trim() || null);
      return toProcessDto(await this.commit(tx, op), op.type);
    });
  }

  /** The applicant resubmits a sent-back request; a new round starts at step 1. */
  async resubmit(
    ctx: SecurityContext,
    processId: number,
    expectedVersion: number,
    options: { comment?: string | null; changes?: Record<string, unknown> } = {},
  ): Promise<WorkflowProcessDto> {
    return this.db.tx(ctx, async (tx) => {
      const op = await this.open(tx, ctx, processId);
      this.assertApplicant(op);
      assertVersion(op.p, expectedVersion);
      if (op.status !== 'RESUBMIT_REQUIRED')
        throw new ConflictError('This request is not waiting to be resubmitted');
      const comment = options.comment?.trim() || null;
      op.set({ status: 'IN_PROGRESS', round: op.round + 1, currentStepNo: null });
      const plan = await this.planFrom(tx, op, 1, null);
      await this.recordAction(tx, op, {
        action: 'RESUBMIT',
        comment,
        fromStatus: 'RESUBMIT_REQUIRED',
        toStatus: plan.assign ? 'IN_PROGRESS' : 'APPROVED_PENDING_PROCESS',
        metadata: { hasChanges: options.changes !== undefined },
      });
      const handler = this.registry.get(op.type);
      await handler.onResubmitted?.({ tx, ctx, process: op.snapshot(), comment, changes: options.changes });
      await this.applyPlan(tx, op, plan, WORKFLOW_EVENTS.resubmitted);
      return toProcessDto(await this.commit(tx, op), op.type);
    });
  }

  /**
   * Payroll processing (section 7.2): posts approved items into an open pay period of the
   * subject's company rule. Each item runs in its own transaction and is audited on its own.
   */
  async process(
    ctx: SecurityContext,
    processIds: number[],
    payPeriodId: number,
  ): Promise<BulkActionResponse> {
    const period = await this.db.prisma.payPeriod.findUnique({ where: { id: payPeriodId } });
    if (!period) throw ValidationError.field('payPeriodId', 'Pay period not found');
    if (period.isClosed) throw ValidationError.field('payPeriodId', 'This pay period is closed');
    return this.bulk(ctx, processIds, (id) =>
      this.db.tx(ctx, async (tx) => {
        const op = await this.open(tx, ctx, id);
        if (
          !ctx.isSystem &&
          !this.access.isAdminInScope(ctx, { companyId: op.p.subjectEmployee.companyId })
        ) {
          throw new ForbiddenError('You cannot process requests for this employee', {
            subjectEmployeeId: op.p.subjectEmployeeId,
            metadata: { processId: id },
          });
        }
        if (op.status !== 'APPROVED_PENDING_PROCESS') {
          throw new ConflictError('This request is not waiting to be processed');
        }
        if (period.companyRuleId !== op.p.subjectEmployee.companyRuleId) {
          throw ValidationError.field('payPeriodId', "The pay period is not in the employee's company rule");
        }
        await this.applyProcess(tx, op, period, false);
        return toProcessDto(await this.commit(tx, op), op.type);
      }),
    );
  }

  /** Approves several items; each is approved, audited and reported on its own (section 5.10). */
  async bulkApprove(
    ctx: SecurityContext,
    items: { id: number; version: number }[],
    comment?: string | null,
  ): Promise<BulkActionResponse> {
    const versions = new Map(items.map((i) => [i.id, i.version]));
    return this.bulk(
      ctx,
      items.map((i) => i.id),
      (id) => this.act(ctx, id, { action: 'APPROVE', expectedVersion: versions.get(id) ?? 0, comment }),
    );
  }

  /** The approval history (section 1.5) for a caller who may read the process. */
  history(ctx: SecurityContext, processId: number): Promise<ApprovalHistory> {
    return this.historyService.history(ctx, processId);
  }

  /** = employeeCanStartWorkflow (section 7.3): an active type with a definition for the acting-as employee. */
  async canStart(
    ctx: SecurityContext,
    type: WorkflowTypeCode,
    discriminator?: string | null,
  ): Promise<boolean> {
    const employee = await this.db.prisma.employee.findFirst({
      where: { id: ctx.actingAsEmployeeId, deletedAt: null, status: 'ACTIVE' },
      select: { companyRuleId: true },
    });
    if (!employee) return false;
    const workflowType = await this.db.prisma.workflowType.findUnique({ where: { code: type } });
    if (!workflowType?.isActive) return false;
    const definition = await this.findDefinition(
      this.db.prisma,
      workflowType.id,
      employee.companyRuleId,
      discriminator ?? null,
    );
    return definition !== null && definition.steps.length > 0;
  }

  // ───────────── Jobs (sections 7.4 and 7.5) ─────────────

  /**
   * Escalates one overdue PENDING step: notifies the assignee and their manager and marks the
   * process escalated. After twice the escalation time, with `workflow.escalation.autoReassign`,
   * reassigns the step to the applicant's second-level manager.
   */
  async escalateStep(
    instanceId: number,
    autoReassign: boolean,
    now = new Date(),
  ): Promise<'escalated' | 'reassigned' | 'skipped'> {
    const ctx = systemContext(`workflow-escalate-${instanceId}`);
    return this.db.tx(ctx, async (tx) => {
      const located = await tx.workflowStepInstance.findUnique({
        where: { id: instanceId },
        select: { processId: true },
      });
      if (!located) return 'skipped';
      const op = await this.open(tx, ctx, located.processId);
      const inst = await tx.workflowStepInstance.findUniqueOrThrow({ where: { id: instanceId } });
      if (inst.status !== 'PENDING' || op.status !== 'IN_PROGRESS' || !inst.dueAt || inst.dueAt > now) {
        return 'skipped';
      }
      const step = this.stepOf(op, inst.stepId);
      let outcome: 'escalated' | 'reassigned' | 'skipped' = 'skipped';

      if (!inst.escalatedAt) {
        await tx.workflowStepInstance.update({ where: { id: inst.id }, data: { escalatedAt: now } });
        op.set({ isEscalated: true });
        const assignee = await tx.user.findUnique({
          where: { id: inst.assigneeUserId },
          select: { employee: { select: { reportsToId: true } } },
        });
        const managerUserId = await this.people.userOfEmployee(tx, assignee?.employee?.reportsToId ?? null);
        await this.recordAction(tx, op, {
          action: 'ESCALATE',
          stepInstanceId: inst.id,
          stepNo: inst.stepNo,
          actorUserId: SYSTEM_USER_ID,
          metadata: { dueAt: inst.dueAt.toISOString(), assigneeUserId: inst.assigneeUserId, managerUserId },
        });
        op.event(WORKFLOW_EVENTS.escalated, {
          stepNo: inst.stepNo,
          assigneeUserId: inst.assigneeUserId,
          managerUserId,
        });
        outcome = 'escalated';
      }

      const hours = step.escalationHours;
      if (autoReassign && hours && inst.dueAt.getTime() + hours * HOUR_MS <= now.getTime()) {
        const subject = resolutionSubject(op.p);
        const target = await this.resolver.levelTwoManager(tx, subject);
        const applicants = await this.applicantsOf(tx, op);
        const open = await this.openInstances(tx, op);
        if (
          target &&
          target !== inst.assigneeUserId &&
          !applicants.has(target) &&
          !open.some((i) => i.assigneeUserId === target)
        ) {
          await this.closeGroup(tx, op, inst.id, 'REASSIGNED', null, SYSTEM_USER_ID);
          await this.recordAction(tx, op, {
            action: 'ESCALATE',
            stepInstanceId: inst.id,
            stepNo: inst.stepNo,
            actorUserId: SYSTEM_USER_ID,
            metadata: { autoReassign: true, fromUserId: inst.assigneeUserId, toUserId: target },
          });
          const assigned = await this.assign(tx, op, step, [target]);
          op.event(WORKFLOW_EVENTS.reassigned, {
            stepNo: step.stepNo,
            fromUserId: inst.assigneeUserId,
            ...this.assignedPayload(op, assigned),
            reason: 'ESCALATION',
          });
          outcome = 'reassigned';
        }
      }

      if (outcome === 'skipped') return outcome;
      await this.commit(tx, op, { bumpVersion: outcome === 'reassigned' });
      return outcome;
    });
  }

  /** Returns a parked step to Action Required once `parkedUntil` has passed (section 7.4). */
  async unparkStep(instanceId: number, now = new Date()): Promise<boolean> {
    const ctx = systemContext(`workflow-unpark-${instanceId}`);
    return this.db.tx(ctx, async (tx) => {
      const located = await tx.workflowStepInstance.findUnique({
        where: { id: instanceId },
        select: { processId: true },
      });
      if (!located) return false;
      const op = await this.open(tx, ctx, located.processId);
      const inst = await tx.workflowStepInstance.findUniqueOrThrow({ where: { id: instanceId } });
      if (inst.status !== 'PARKED' || !inst.parkedUntil || inst.parkedUntil > now) return false;
      const step = this.stepOf(op, inst.stepId);
      // Parking deliberately defers the work, so the escalation clock restarts on return.
      await tx.workflowStepInstance.update({
        where: { id: inst.id },
        data: {
          status: 'PENDING',
          dueAt: step.escalationHours ? new Date(now.getTime() + step.escalationHours * HOUR_MS) : inst.dueAt,
          escalatedAt: null,
        },
      });
      await this.recordAction(tx, op, {
        action: 'UNPARK',
        stepInstanceId: inst.id,
        stepNo: inst.stepNo,
        actorUserId: SYSTEM_USER_ID,
        metadata: { parkedUntil: inst.parkedUntil.toISOString() },
      });
      op.event(WORKFLOW_EVENTS.parkedDue, { stepNo: inst.stepNo, assigneeUserId: inst.assigneeUserId });
      await this.commit(tx, op, { bumpVersion: false });
      return true;
    });
  }

  /**
   * Re-resolves an open step whose assignee can no longer be given work (inactive user,
   * terminated employee), as SYSTEM (section 7.5). A ROLE step that still has other candidates
   * just loses this one; otherwise the step's rule is applied again (with the HR fallback for
   * mandatory steps, and skipping an optional step that no longer resolves).
   */
  async reresolveStep(
    instanceId: number,
  ): Promise<'reassigned' | 'removed' | 'skipped' | 'unresolved' | 'unchanged'> {
    const ctx = systemContext(`workflow-reresolve-${instanceId}`);
    try {
      return await this.db.tx(ctx, async (tx) => {
        const located = await tx.workflowStepInstance.findUnique({
          where: { id: instanceId },
          select: { processId: true },
        });
        if (!located) return 'unchanged';
        const op = await this.open(tx, ctx, located.processId);
        const inst = await tx.workflowStepInstance.findUniqueOrThrow({ where: { id: instanceId } });
        if (!(OPEN_STEP_STATUSES as readonly string[]).includes(inst.status) || op.status !== 'IN_PROGRESS') {
          return 'unchanged';
        }
        const rows = await this.people.rows(tx, [inst.assigneeUserId]);
        const assignee = rows.get(inst.assigneeUserId);
        if (assignee && isAvailable(assignee)) return 'unchanged';
        const step = this.stepOf(op, inst.stepId);

        const open = (await this.openInstances(tx, op)).filter((i) => i.id !== inst.id);
        const others = await this.people.rows(
          tx,
          open.map((i) => i.assigneeUserId),
        );
        if ([...others.values()].some(isAvailable)) {
          await tx.workflowStepInstance.update({
            where: { id: inst.id },
            data: { status: 'SUPERSEDED', actedAt: op.now, actedByUserId: SYSTEM_USER_ID },
          });
          await this.recordAction(tx, op, {
            action: 'REASSIGN',
            stepInstanceId: inst.id,
            stepNo: inst.stepNo,
            actorUserId: SYSTEM_USER_ID,
            metadata: { reason: 'APPROVER_UNAVAILABLE', fromUserId: inst.assigneeUserId, toUserIds: [] },
          });
          await this.commit(tx, op);
          return 'removed';
        }

        const plan = await this.resolver.plan(tx, step, resolutionSubject(op.p), {
          applicantUserIds: await this.applicantsOf(tx, op),
        });
        if (plan.kind === 'UNRESOLVABLE') {
          this.logger.warn(
            { processId: op.p.id, stepNo: step.stepNo },
            'No replacement approver could be found',
          );
          return 'unresolved';
        }
        await this.closeGroup(
          tx,
          op,
          inst.id,
          plan.kind === 'SKIP' ? 'SKIPPED' : 'REASSIGNED',
          null,
          SYSTEM_USER_ID,
        );
        if (plan.kind === 'SKIP') {
          await this.recordAction(tx, op, {
            action: 'AUTO_SKIP',
            stepInstanceId: inst.id,
            stepNo: inst.stepNo,
            actorUserId: SYSTEM_USER_ID,
            metadata: { reason: plan.reason, replacedUserId: inst.assigneeUserId },
          });
          const next = await this.planFrom(
            tx,
            op,
            step.stepNo + 1,
            await this.resolver.previousApprover(tx, resolutionSubject(op.p), step.stepNo),
          );
          await this.applyPlan(tx, op, next, WORKFLOW_EVENTS.stepAssigned);
          await this.commit(tx, op);
          return 'skipped';
        }
        await this.recordAction(tx, op, {
          action: 'REASSIGN',
          stepInstanceId: inst.id,
          stepNo: inst.stepNo,
          actorUserId: SYSTEM_USER_ID,
          metadata: {
            reason: 'APPROVER_UNAVAILABLE',
            fromUserId: inst.assigneeUserId,
            toUserIds: plan.userIds,
            usedFallback: plan.usedFallback,
          },
        });
        const assigned = await this.assign(tx, op, step, plan.userIds);
        op.event(WORKFLOW_EVENTS.reassigned, {
          stepNo: step.stepNo,
          fromUserId: inst.assigneeUserId,
          ...this.assignedPayload(op, assigned),
          reason: 'APPROVER_UNAVAILABLE',
        });
        await this.commit(tx, op);
        return 'reassigned';
      });
    } catch (err) {
      if (err instanceof DomainError) {
        this.logger.warn({ instanceId, err: err.message }, 'Could not re-resolve a step');
        return 'unresolved';
      }
      throw err;
    }
  }

  /**
   * Re-resolves every open step assigned to a user, for example when an employee is terminated
   * (section 7.5). Returns how many steps moved.
   */
  async reresolveForUser(userId: string): Promise<{ reassigned: number; unresolved: number }> {
    const open = await this.db.prisma.workflowStepInstance.findMany({
      where: { assigneeUserId: userId, status: { in: [...OPEN_STEP_STATUSES] } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const counts = { reassigned: 0, unresolved: 0 };
    for (const { id } of open) {
      const outcome = await this.reresolveStep(id);
      if (outcome === 'unresolved') counts.unresolved += 1;
      else if (outcome !== 'unchanged') counts.reassigned += 1;
    }
    return counts;
  }

  // ───────────── Actions ─────────────

  private async comment(
    ctx: SecurityContext,
    processId: number,
    input: ActInput,
  ): Promise<WorkflowProcessDto> {
    return this.db.tx(ctx, async (tx) => {
      const op = await this.open(tx, ctx, processId);
      const comment = input.comment?.trim();
      const mine = await this.actionableInstance(tx, op, ctx.userId);
      const isApplicant = this.access.isApplicant(ctx, op.p);
      if (!mine && !isApplicant && !(await this.access.isApprover(tx, ctx, op.p.id))) {
        throw new ForbiddenError(
          'Only the applicant and the approvers can comment on this request',
          { subjectEmployeeId: op.p.subjectEmployeeId, metadata: { processId } },
          WORKFLOW_PROBLEM_TYPES.notAssignee,
        );
      }
      assertVersion(op.p, input.expectedVersion);
      if (!comment) throw ValidationError.field('comment', 'A comment is required');
      if (!['IN_PROGRESS', 'RESUBMIT_REQUIRED', 'APPROVED_PENDING_PROCESS'].includes(op.status)) {
        throw new ConflictError('This request is closed for comments');
      }
      await this.recordAction(tx, op, {
        action: 'COMMENT',
        stepInstanceId: mine?.id ?? null,
        stepNo: mine?.stepNo ?? null,
        comment,
      });
      return toProcessDto(await this.commit(tx, op), op.type);
    });
  }

  private async approve(
    tx: Tx,
    op: Operation,
    mine: { id: number; stepNo: number },
    step: WorkflowStep,
    comment: string | null,
  ): Promise<void> {
    const superseded = await this.closeGroup(tx, op, mine.id, 'APPROVED', comment, op.ctx.userId);
    const next = await this.planFrom(tx, op, step.stepNo + 1, op.ctx.userId);
    const final = next.assign === null;
    await this.recordAction(tx, op, {
      action: 'APPROVE',
      stepInstanceId: mine.id,
      stepNo: mine.stepNo,
      comment,
      fromStatus: 'IN_PROGRESS',
      toStatus: final ? 'APPROVED_PENDING_PROCESS' : 'IN_PROGRESS',
      metadata: { final, superseded },
    });
    if (!final) op.event(WORKFLOW_EVENTS.stepApproved, { stepNo: mine.stepNo, actorUserId: op.ctx.userId });
    await this.applyPlan(tx, op, next, WORKFLOW_EVENTS.stepAssigned);
  }

  private async decline(
    tx: Tx,
    op: Operation,
    mine: { id: number; stepNo: number },
    comment: string | null,
  ): Promise<void> {
    if (!comment) throw ValidationError.field('comment', 'Give a reason for declining');
    await this.closeGroup(tx, op, mine.id, 'DECLINED', comment, op.ctx.userId);
    op.set({ status: 'DECLINED', currentStepNo: null, completedAt: op.now });
    await this.recordAction(tx, op, {
      action: 'DECLINE',
      stepInstanceId: mine.id,
      stepNo: mine.stepNo,
      comment,
      fromStatus: 'IN_PROGRESS',
      toStatus: 'DECLINED',
    });
    await this.registry.get(op.type).onDeclined({ tx, ctx: op.ctx, process: op.snapshot(), comment });
    op.event(WORKFLOW_EVENTS.declined, { stepNo: mine.stepNo, actorUserId: op.ctx.userId, comment });
  }

  private async reassign(
    tx: Tx,
    op: Operation,
    mine: { id: number; stepNo: number; assigneeUserId: string },
    step: WorkflowStep,
    toUserId: string | undefined,
    comment: string | null,
  ): Promise<void> {
    if (!op.p.definition.allowReassign) {
      throw problem(422, 'This workflow does not allow reassignment', WORKFLOW_PROBLEM_TYPES.notAllowed);
    }
    if (!toUserId) throw ValidationError.field('toUserId', 'Choose who to reassign to');
    const target = (await this.people.rows(tx, [toUserId])).get(toUserId);
    if (!target || !isAvailable(target)) throw ValidationError.field('toUserId', 'Choose an active user');
    if (toUserId === op.ctx.userId)
      throw ValidationError.field('toUserId', 'The step is already assigned to you');
    if ((await this.applicantsOf(tx, op)).has(toUserId)) {
      throw ValidationError.field('toUserId', 'The applicant cannot approve their own request');
    }
    if (target.employee?.companyId !== op.p.subjectEmployee.companyId) {
      throw ValidationError.field('toUserId', "Choose someone in the applicant's company");
    }
    const open = await this.openInstances(tx, op);
    if (open.some((i) => i.assigneeUserId === toUserId)) {
      throw ValidationError.field('toUserId', 'This person is already an approver of this step');
    }
    await this.closeGroup(tx, op, mine.id, 'REASSIGNED', comment, op.ctx.userId);
    await this.recordAction(tx, op, {
      action: 'REASSIGN',
      stepInstanceId: mine.id,
      stepNo: mine.stepNo,
      comment,
      metadata: { fromUserId: mine.assigneeUserId, toUserId },
    });
    const assigned = await this.assign(tx, op, step, [toUserId]);
    op.event(WORKFLOW_EVENTS.reassigned, {
      stepNo: step.stepNo,
      fromUserId: mine.assigneeUserId,
      ...this.assignedPayload(op, assigned),
      reason: 'MANUAL',
    });
  }

  private async park(
    tx: Tx,
    op: Operation,
    mine: { id: number; stepNo: number },
    until: BusinessDate | undefined,
    comment: string | null,
  ): Promise<void> {
    if (!op.p.definition.canPark) {
      throw problem(422, 'This workflow does not allow parking', WORKFLOW_PROBLEM_TYPES.notAllowed);
    }
    const today = todayBusinessDate(op.now);
    if (!until) throw ValidationError.field('until', 'Choose the date the item comes back');
    if (until <= today) throw ValidationError.field('until', 'Choose a date after today');
    if (until > addDays(today, MAX_PARK_DAYS)) {
      throw ValidationError.field('until', `Park for at most ${MAX_PARK_DAYS} days`);
    }
    const parkedUntil = fromZonedTime(`${until}T00:00:00`, 'Africa/Windhoek');
    await tx.workflowStepInstance.update({
      where: { id: mine.id },
      data: { status: 'PARKED', parkedUntil, comment },
    });
    await this.recordAction(tx, op, {
      action: 'PARK',
      stepInstanceId: mine.id,
      stepNo: mine.stepNo,
      comment,
      metadata: { parkedUntil: parkedUntil.toISOString(), until },
    });
  }

  private async sendBack(
    tx: Tx,
    op: Operation,
    mine: { id: number; stepNo: number },
    comment: string | null,
  ): Promise<void> {
    if (!op.p.definition.allowResubmit) {
      throw problem(
        422,
        'This workflow does not allow sending back for resubmission',
        WORKFLOW_PROBLEM_TYPES.notAllowed,
      );
    }
    if (!comment) throw ValidationError.field('comment', 'Tell the applicant what to change');
    await this.closeGroup(tx, op, mine.id, 'SENT_BACK', comment, op.ctx.userId);
    op.set({ status: 'RESUBMIT_REQUIRED', currentStepNo: null });
    await this.recordAction(tx, op, {
      action: 'SEND_BACK',
      stepInstanceId: mine.id,
      stepNo: mine.stepNo,
      comment,
      fromStatus: 'IN_PROGRESS',
      toStatus: 'RESUBMIT_REQUIRED',
    });
    await this.registry.get(op.type).onSentBack?.({ tx, ctx: op.ctx, process: op.snapshot(), comment });
    op.event(WORKFLOW_EVENTS.sentBack, { stepNo: mine.stepNo, actorUserId: op.ctx.userId, comment });
  }

  /** Withdraw or cancel: closes open steps and ends the process as CANCELLED. */
  private async terminate(
    tx: Tx,
    op: Operation,
    action: 'WITHDRAW' | 'CANCEL',
    comment: string | null,
  ): Promise<void> {
    const open = await tx.workflowStepInstance.findMany({
      where: { processId: op.p.id, status: { in: [...OPEN_STEP_STATUSES] } },
      select: { id: true, assigneeUserId: true },
    });
    for (const inst of open) {
      await tx.workflowStepInstance.update({ where: { id: inst.id }, data: { status: 'CANCELLED' } });
    }
    const from = op.status;
    op.set({ status: 'CANCELLED', currentStepNo: null, completedAt: op.now });
    await this.recordAction(tx, op, { action, comment, fromStatus: from, toStatus: 'CANCELLED' });
    await this.registry.get(op.type).onCancelled({
      tx,
      ctx: op.ctx,
      process: op.snapshot(),
      comment,
      reason: action === 'WITHDRAW' ? 'WITHDRAWN' : 'CANCELLED',
    });
    op.event(WORKFLOW_EVENTS.cancelled, {
      actorUserId: op.ctx.userId,
      notifyUserIds: [...new Set(open.map((i) => i.assigneeUserId))],
      reason: action,
    });
  }

  // ───────────── Steps ─────────────

  /**
   * Plans steps from `fromStepNo` without writing anything: steps that will be auto-skipped and
   * the first step that gets assignees (null when the process is complete). A mandatory step
   * nobody can approve fails the whole action with 422 before any write.
   */
  private async planFrom(
    tx: Tx,
    op: Operation,
    fromStepNo: number,
    previousApprover: string | null,
  ): Promise<Plan> {
    const subject = resolutionSubject(op.p, op.round);
    const applicantUserIds = await this.applicantsOf(tx, op);
    const plan: Plan = { skips: [], assign: null };
    for (const step of op.p.definition.steps) {
      if (step.stepNo < fromStepNo) continue;
      const result = await this.resolver.plan(tx, step, subject, {
        applicantUserIds,
        previousApproverUserId: previousApprover,
      });
      if (result.kind === 'UNRESOLVABLE') {
        throw problem(
          422,
          `No approver could be found for step ${step.stepNo} (${step.name}). Ask HR to check the approval setup.`,
          WORKFLOW_PROBLEM_TYPES.noApprover,
        );
      }
      if (result.kind === 'SKIP') {
        plan.skips.push({ step, plan: result });
        continue;
      }
      plan.assign = { step, plan: result };
      break;
    }
    return plan;
  }

  /** Writes a plan: skipped steps, then the assigned step, or completes the process. */
  private async applyPlan(tx: Tx, op: Operation, plan: Plan, assignedEvent: AssignedEvent): Promise<void> {
    for (const { step, plan: skip } of plan.skips) {
      const inst = await tx.workflowStepInstance.create({
        data: {
          processId: op.p.id,
          stepId: step.id,
          stepNo: step.stepNo,
          round: op.round,
          assigneeUserId: skip.resolvedUserId ?? SYSTEM_USER_ID,
          status: 'SKIPPED',
          isMandatory: step.isMandatory,
          actedAt: op.now,
          actedByUserId: SYSTEM_USER_ID,
        },
      });
      await this.recordAction(tx, op, {
        action: 'AUTO_SKIP',
        stepInstanceId: inst.id,
        stepNo: step.stepNo,
        actorUserId: SYSTEM_USER_ID,
        metadata: { reason: skip.reason, resolvedUserId: skip.resolvedUserId },
      });
    }
    if (!plan.assign) {
      await this.complete(tx, op);
      return;
    }
    const { step, plan: assign } = plan.assign;
    op.set({ currentStepNo: step.stepNo });
    const assigned = await this.assign(tx, op, step, assign.userIds);
    op.event(assignedEvent, {
      stepNo: step.stepNo,
      ...this.assignedPayload(op, assigned),
      usedFallback: assign.usedFallback,
    });
  }

  /**
   * Creates PENDING instances for the users, applying out-of-office delegation (section 5.11).
   * A ROLE step gets one instance per user (each sees it in Action Required; the first to act
   * wins). Returns the final assignees.
   */
  private async assign(tx: Tx, op: Operation, step: WorkflowStep, userIds: string[]): Promise<string[]> {
    const excluded = await this.applicantsOf(tx, op);
    const assigned: string[] = [];
    const dueAt = step.escalationHours ? new Date(op.now.getTime() + step.escalationHours * HOUR_MS) : null;
    for (const userId of userIds) {
      const delegation = await resolveDelegation(
        userId,
        (u) => this.outOfOffice.awayState(tx, u, op.p.workflowTypeId, todayBusinessDate(op.now)),
        { excluded },
      );
      if (delegation.outcome === 'CYCLE') {
        op.audits.push({
          category: 'WORKFLOW',
          action: 'WORKFLOW.DELEGATION_CYCLE',
          entityType: 'WorkflowProcess',
          entityId: op.p.id,
          subjectEmployeeId: op.p.subjectEmployeeId,
          reason: 'Out-of-office nominees form a cycle; the step stays with the original approver',
          metadata: { stepNo: step.stepNo, round: op.round, chain: delegation.chain },
        });
        op.event(WORKFLOW_EVENTS.delegationCycle, { stepNo: step.stepNo, chain: delegation.chain });
      }
      const assignee = delegation.assigneeUserId;
      if (assigned.includes(assignee)) continue;
      const delegated = assignee !== userId;
      const inst = await tx.workflowStepInstance.create({
        data: {
          processId: op.p.id,
          stepId: step.id,
          stepNo: step.stepNo,
          round: op.round,
          assigneeUserId: assignee,
          delegatedFromUserId: delegated ? userId : null,
          status: 'PENDING',
          isMandatory: step.isMandatory,
          dueAt,
        },
      });
      assigned.push(assignee);
      if (delegated) op.delegatedTo.add(assignee);
      if (delegated) {
        await this.recordAction(tx, op, {
          action: 'DELEGATE',
          stepInstanceId: inst.id,
          stepNo: step.stepNo,
          actorUserId: SYSTEM_USER_ID,
          metadata: {
            fromUserId: userId,
            toUserId: assignee,
            chain: delegation.chain,
            outcome: delegation.outcome,
          },
        });
        op.event(WORKFLOW_EVENTS.delegated, {
          stepNo: step.stepNo,
          fromUserId: userId,
          assigneeUserIds: [assignee],
        });
      }
    }
    return assigned;
  }

  /** Event fields for newly assigned users; delegated ones are notified by the delegation event. */
  private assignedPayload(op: Operation, assigned: string[]): Record<string, string[]> {
    return {
      assigneeUserIds: assigned,
      delegatedUserIds: assigned.filter((u) => op.delegatedTo.has(u)),
    };
  }

  /** All approvals done: apply or wait for payroll (section 7.2). */
  private async complete(tx: Tx, op: Operation): Promise<void> {
    const handler = this.registry.get(op.type);
    op.set({ status: 'APPROVED_PENDING_PROCESS', currentStepNo: null, finalApprovedAt: op.now });
    const result = await handler.onFinalApproval({ tx, ctx: op.ctx, process: op.snapshot() });
    if (result.outcome === 'CONFLICT') {
      op.set({ status: 'CONFLICT', completedAt: op.now });
      await this.recordAction(tx, op, {
        action: 'CONFLICT',
        fromStatus: 'APPROVED_PENDING_PROCESS',
        toStatus: 'CONFLICT',
        actorUserId: SYSTEM_USER_ID,
        metadata: { reason: result.reason },
      });
      op.event(WORKFLOW_EVENTS.conflict, { reason: result.reason });
      return;
    }
    op.event(WORKFLOW_EVENTS.approved);
    if (!requiresPayrollProcessing(op.type)) {
      op.set({ status: 'PROCESSED', processedAt: op.now, completedAt: op.now });
      await this.recordAction(tx, op, {
        action: 'APPLY',
        fromStatus: 'APPROVED_PENDING_PROCESS',
        toStatus: 'PROCESSED',
        actorUserId: SYSTEM_USER_ID,
      });
      return;
    }
    const key = AUTO_PROCESS_SETTING[op.type];
    if (!key || (await this.settings.get(key)) !== true) return;
    const period = await this.openPeriodFor(
      tx,
      op.p.subjectEmployee.companyRuleId,
      todayBusinessDate(op.now),
    );
    if (!period) {
      op.audits.push({
        category: 'WORKFLOW',
        action: 'WORKFLOW.AUTO_PROCESS_SKIPPED',
        entityType: 'WorkflowProcess',
        entityId: op.p.id,
        subjectEmployeeId: op.p.subjectEmployeeId,
        reason: 'No open pay period for the employee’s company rule',
        metadata: { setting: key },
      });
      return;
    }
    await this.applyProcess(tx, op, period, true);
  }

  private async applyProcess(tx: Tx, op: Operation, period: PayPeriodRef, automatic: boolean): Promise<void> {
    op.set({ status: 'PROCESSED', processedAt: op.now, completedAt: op.now });
    await this.registry.get(op.type).onProcess({
      tx,
      ctx: op.ctx,
      process: op.snapshot(),
      payPeriod: {
        id: period.id,
        companyRuleId: period.companyRuleId,
        description: period.description,
        startDate: period.startDate,
        endDate: period.endDate,
      },
      automatic,
    });
    await this.recordAction(tx, op, {
      action: 'PROCESS',
      fromStatus: 'APPROVED_PENDING_PROCESS',
      toStatus: 'PROCESSED',
      actorUserId: automatic ? SYSTEM_USER_ID : op.ctx.userId,
      metadata: { payPeriodId: period.id, payPeriod: period.description, automatic },
    });
    op.event(WORKFLOW_EVENTS.processed, { payPeriodId: period.id });
  }

  /** The open period of the company rule that contains `today`, else the next open one. */
  private async openPeriodFor(
    tx: Tx,
    companyRuleId: number,
    today: BusinessDate,
  ): Promise<PayPeriodRef | null> {
    const day = dateFromBusiness(today);
    return (
      (await tx.payPeriod.findFirst({
        where: { companyRuleId, isClosed: false, startDate: { lte: day }, endDate: { gte: day } },
        orderBy: { startDate: 'asc' },
      })) ??
      (await tx.payPeriod.findFirst({
        where: { companyRuleId, isClosed: false, endDate: { gte: day } },
        orderBy: { startDate: 'asc' },
      }))
    );
  }

  // ───────────── Building blocks ─────────────

  private async findDefinition(
    client: Tx,
    workflowTypeId: number,
    companyRuleId: number,
    discriminator: string | null,
  ) {
    const candidates = await client.workflowDefinition.findMany({
      where: {
        workflowTypeId,
        isActive: true,
        OR: [{ companyRuleId: null }, { companyRuleId }],
      },
      include: { steps: { orderBy: { stepNo: 'asc' } } },
    });
    return selectDefinition(candidates, companyRuleId, discriminator);
  }

  /** Locks and loads the process. */
  private async open(tx: Tx, ctx: SecurityContext, processId: number): Promise<Operation> {
    await this.db.lockRow(tx, 'WorkflowProcess', processId);
    const p = await tx.workflowProcess.findUnique({ where: { id: processId }, include: PROCESS_INCLUDE });
    if (!p) throw new NotFoundError('Workflow process');
    return new Operation(p, ctx);
  }

  private stepOf(op: Operation, stepId: number): WorkflowStep {
    const step = op.p.definition.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Step ${stepId} is not part of definition ${op.p.definitionId}`);
    return step;
  }

  private async applicantsOf(tx: Tx, op: Operation): Promise<Set<string>> {
    op.applicants ??= await this.resolver.applicantUserIds(tx, resolutionSubject(op.p));
    return op.applicants;
  }

  /** Open instances of the current step group (same round and step). */
  private async openInstances(tx: Tx, op: Operation) {
    if (op.currentStepNo === null) return [];
    return tx.workflowStepInstance.findMany({
      where: {
        processId: op.p.id,
        round: op.round,
        stepNo: op.currentStepNo,
        status: { in: [...OPEN_STEP_STATUSES] },
      },
      orderBy: { id: 'asc' },
    });
  }

  /** The caller's open instance of the current step, if any. */
  private async actionableInstance(tx: Tx, op: Operation, userId: string) {
    if (op.status !== 'IN_PROGRESS') return null;
    const open = await this.openInstances(tx, op);
    return open.find((i) => i.assigneeUserId === userId) ?? null;
  }

  /**
   * Authorisation before the version check, so a stale version never reveals more than a 403:
   * the applicant can never act on their own request, and only someone involved in the process
   * learns that the version is stale. Then only a current assignee may act.
   */
  private async assertCanAct(tx: Tx, op: Operation, expectedVersion: number) {
    const ctx = op.ctx;
    if ((await this.applicantsOf(tx, op)).has(ctx.userId)) {
      throw new ForbiddenError(
        'You cannot approve or act on your own request',
        { subjectEmployeeId: op.p.subjectEmployeeId, metadata: { processId: op.p.id } },
        WORKFLOW_PROBLEM_TYPES.ownRequest,
      );
    }
    const notAssignee = () =>
      new ForbiddenError(
        'This request is not waiting for your action',
        { subjectEmployeeId: op.p.subjectEmployeeId, metadata: { processId: op.p.id } },
        WORKFLOW_PROBLEM_TYPES.notAssignee,
      );
    const involved = await tx.workflowStepInstance.count({
      where: { processId: op.p.id, assigneeUserId: ctx.userId },
    });
    if (involved === 0) throw notAssignee();
    assertVersion(op.p, expectedVersion);
    const mine = await this.actionableInstance(tx, op, ctx.userId);
    if (!mine) throw notAssignee();
    return mine;
  }

  private assertApplicant(op: Operation): void {
    if (this.access.isApplicant(op.ctx, op.p)) return;
    throw new ForbiddenError(
      'Only the applicant or the person who submitted the request can do this',
      { subjectEmployeeId: op.p.subjectEmployeeId, metadata: { processId: op.p.id } },
      WORKFLOW_PROBLEM_TYPES.notAllowed,
    );
  }

  /**
   * Closes the caller's instance with `status` and supersedes the other open instances of the
   * same step (the other ROLE candidates). Returns how many were superseded.
   */
  private async closeGroup(
    tx: Tx,
    op: Operation,
    instanceId: number,
    status: 'APPROVED' | 'DECLINED' | 'REASSIGNED' | 'SENT_BACK' | 'SKIPPED',
    comment: string | null,
    actorUserId: string,
  ): Promise<number> {
    await tx.workflowStepInstance.update({
      where: { id: instanceId },
      data: { status, actedAt: op.now, actedByUserId: actorUserId, comment, parkedUntil: null },
    });
    const others = (await this.openInstances(tx, op)).filter((i) => i.id !== instanceId);
    for (const other of others) {
      await tx.workflowStepInstance.update({ where: { id: other.id }, data: { status: 'SUPERSEDED' } });
    }
    return others.length;
  }

  /** Inserts the WorkflowAction row and queues its `WORKFLOW.*` audit row. */
  private async recordAction(tx: Tx, op: Operation, record: ActionRecord): Promise<void> {
    const ctx = op.ctx;
    const actorUserId = record.actorUserId ?? ctx.userId;
    const metadata = { round: op.round, stepNo: record.stepNo ?? null, ...record.metadata };
    const row = await tx.workflowAction.create({
      data: {
        processId: op.p.id,
        stepInstanceId: record.stepInstanceId ?? null,
        action: record.action,
        actorUserId,
        onBehalfOfEmployeeId: isActingForOther(ctx) ? ctx.actingAsEmployeeId : null,
        comment: record.comment ?? null,
        fromStatus: record.fromStatus ?? null,
        toStatus: record.toStatus ?? null,
        metadata: metadata as Prisma.InputJsonObject,
      },
    });
    op.audits.push({
      category: 'WORKFLOW',
      action: WORKFLOW_AUDIT_ACTIONS[record.action],
      entityType: 'WorkflowProcess',
      entityId: op.p.id,
      subjectEmployeeId: op.p.subjectEmployeeId,
      reason: record.comment ?? null,
      metadata: {
        workflowActionId: row.id,
        workflowType: op.type,
        actorUserId,
        fromStatus: record.fromStatus ?? null,
        toStatus: record.toStatus ?? null,
        ...metadata,
      },
    });
  }

  /** Writes the process changes, the audit rows (the first carries before/after) and the events. */
  private async commit(
    tx: Tx,
    op: Operation,
    options: { bumpVersion?: boolean } = {},
  ): Promise<WorkflowProcess> {
    const after = await tx.workflowProcess.update({
      where: { id: op.p.id },
      data: { ...op.data, ...(options.bumpVersion === false ? {} : { version: { increment: 1 } }) },
    });
    op.audits.forEach((entry, index) => {
      this.audit.record(
        tx,
        op.ctx,
        index === 0 ? { ...entry, before: op.before, after: processRow(after) } : entry,
      );
    });
    for (const event of op.events) await this.outbox.add(tx, event.type, event.payload);
    if (op.events.length) this.db.afterCommit(() => this.outbox.kick());
    return after;
  }

  /** Runs one item at a time; a failure is reported for that item and audited when it is a denial. */
  private async bulk(
    ctx: SecurityContext,
    ids: number[],
    run: (id: number) => Promise<WorkflowProcessDto>,
  ): Promise<BulkActionResponse> {
    const results: BulkItemResult[] = [];
    for (const id of ids) {
      try {
        results.push({ processId: id, ok: true, process: await run(id) });
      } catch (err) {
        if (!(err instanceof DomainError)) {
          this.logger.error({ err, processId: id }, 'Bulk workflow item failed');
          results.push({
            processId: id,
            ok: false,
            error: { status: HttpStatus.INTERNAL_SERVER_ERROR, title: 'Internal Server Error' },
          });
          continue;
        }
        if (err.getStatus() === HttpStatus.FORBIDDEN) await this.auditBulkDenial(ctx, id, err);
        results.push({
          processId: id,
          ok: false,
          error: { status: err.getStatus(), title: err.title, detail: err.detail },
        });
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    return { results, succeeded, failed: results.length - succeeded };
  }

  /** Every 403 is audited, also inside a bulk request that itself succeeds (section 16.2). */
  private async auditBulkDenial(ctx: SecurityContext, processId: number, err: DomainError): Promise<void> {
    await this.audit.recordStandalone(ctx, {
      category: 'SECURITY',
      action: 'SECURITY.ACCESS_DENIED',
      outcome: 'DENIED',
      entityType: 'WorkflowProcess',
      entityId: processId,
      subjectEmployeeId: err.denial?.subjectEmployeeId ?? null,
      reason: err.detail ?? err.title,
      metadata: { ...err.denial?.metadata, bulk: true, status: HttpStatus.FORBIDDEN },
    });
  }
}
