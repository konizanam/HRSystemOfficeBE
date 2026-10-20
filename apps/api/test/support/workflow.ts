import type { ApproverResolution, Role } from '@prisma/client';
import {
  type BusinessDate,
  dateFromBusiness,
  endOfMonth,
  type InboxWarning,
  startOfMonth,
  todayBusinessDate,
  type WorkflowProcessDto,
  type WorkflowTypeCode,
} from '@peoplehub/shared';
import { type SecurityContext, systemContext } from '../../src/common/context/security-context';
import { OutboxService } from '../../src/events/outbox.service';
import { JobsService } from '../../src/jobs/jobs.service';
import type { Tx } from '../../src/prisma/prisma-client';
import { WorkflowSubjectRegistry } from '../../src/modules/workflow/subject-registry';
import { WorkflowEngine } from '../../src/modules/workflow/workflow-engine.service';
import type {
  FinalApprovalResult,
  SubjectDescription,
  WorkflowCancelHookContext,
  WorkflowCommentHookContext,
  WorkflowHookContext,
  WorkflowProcessHookContext,
  WorkflowProcessSnapshot,
  WorkflowResubmitHookContext,
  WorkflowSubjectHandler,
} from '../../src/modules/workflow/workflow-subject';
import type { TestApp } from './app';
import { nextUnique, type Org, type Person } from './fixtures';

// Workflow test kit: a fake subject handler (Phase 3 acceptance: "engine tests pass with a fake
// subject handler"), definitions per fixture company rule, and helpers to start processes and
// run the workflow jobs.

const sys = systemContext('test-workflow');

/** What the fake handler describes for a subject. */
export interface FakeSubject {
  label: string;
  fromDate: BusinessDate | null;
  toDate: BusinessDate | null;
  units: string | null;
  warn: boolean;
}

export interface HookCall {
  hook: string;
  processId: number;
  status: string;
  round: number;
  comment?: string | null;
  reason?: string;
  changes?: Record<string, unknown>;
  payPeriodId?: number;
  automatic?: boolean;
}

/**
 * A subject handler that records every hook call and describes subjects from memory. Register it
 * for a real workflow type with `kit.useFakeHandler(type)`; the original registration is restored
 * when the test file ends.
 */
export class FakeSubjectHandler implements WorkflowSubjectHandler {
  readonly calls: HookCall[] = [];
  readonly subjects = new Map<string, FakeSubject>();
  /** What the next final approvals return; set to CONFLICT to test that path. */
  finalResult: FinalApprovalResult = { outcome: 'APPLIED' };

  constructor(readonly type: WorkflowTypeCode) {}

  callsFor(processId: number, hook?: string): HookCall[] {
    return this.calls.filter((c) => c.processId === processId && (!hook || c.hook === hook));
  }

  private record(hook: string, ctx: WorkflowHookContext, extra: Partial<HookCall> = {}): void {
    this.calls.push({
      hook,
      processId: ctx.process.id,
      status: ctx.process.status,
      round: ctx.process.round,
      ...extra,
    });
  }

  async describe(_client: Tx, process: WorkflowProcessSnapshot): Promise<SubjectDescription> {
    const s = this.subjects.get(process.subjectEntityId);
    const label = s?.label ?? 'Fake Item';
    return {
      requestLabel: label,
      title: `${label} request`,
      fromDate: s?.fromDate ?? null,
      toDate: s?.toDate ?? null,
      unitsLine: s?.units ? `${s.units} Days to be deducted` : null,
      headline: s?.units ? [{ label: 'Days to be deducted', value: s.units }] : [],
      fields: [
        { label: 'Item', value: label },
        { label: 'Summary', value: process.summary },
      ],
      data: { subjectEntityId: process.subjectEntityId },
      viewLabel: 'View fake request',
    };
  }

  async warnings(_client: Tx, process: WorkflowProcessSnapshot): Promise<InboxWarning[]> {
    return this.subjects.get(process.subjectEntityId)?.warn
      ? [{ code: 'NEGATIVE_BALANCE', message: 'Approving this takes the balance negative' }]
      : [];
  }

  async onFinalApproval(hook: WorkflowHookContext): Promise<FinalApprovalResult> {
    this.record('onFinalApproval', hook);
    return this.finalResult;
  }

  async onProcess(hook: WorkflowProcessHookContext): Promise<void> {
    this.record('onProcess', hook, { payPeriodId: hook.payPeriod.id, automatic: hook.automatic });
  }

  async onDeclined(hook: WorkflowCommentHookContext): Promise<void> {
    this.record('onDeclined', hook, { comment: hook.comment });
  }

  async onCancelled(hook: WorkflowCancelHookContext): Promise<void> {
    this.record('onCancelled', hook, { comment: hook.comment, reason: hook.reason });
  }

  async onSentBack(hook: WorkflowCommentHookContext): Promise<void> {
    this.record('onSentBack', hook, { comment: hook.comment });
  }

  async onResubmitted(hook: WorkflowResubmitHookContext): Promise<void> {
    this.record('onResubmitted', hook, { comment: hook.comment, changes: hook.changes });
  }
}

/** The SecurityContext a person's session would have (no "Working as"). */
export function contextFor(person: Person, overrides: Partial<SecurityContext> = {}): SecurityContext {
  const admin = person.roles.some((r) => r === 'HR_ADMIN' || r === 'PAYROLL_ADMIN');
  return {
    userId: person.userId,
    username: person.username,
    roles: [...person.roles],
    selfEmployeeId: person.employeeId,
    actingAsEmployeeId: person.employeeId ?? 0,
    companyIds: admin && person.companyId !== null ? [person.companyId] : [],
    sessionId: 'test-session',
    requestId: `test-${Date.now()}`,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    ...overrides,
  };
}

export interface StepSpec {
  resolution: ApproverResolution;
  role?: Role;
  userId?: string;
  isMandatory?: boolean;
  skipIfSameApprover?: boolean;
  escalationHours?: number;
  name?: string;
}

export interface DefinitionSpec {
  type: WorkflowTypeCode;
  companyRuleId: number | null;
  discriminator?: string | null;
  steps: StepSpec[];
  allowReassign?: boolean;
  allowResubmit?: boolean;
  canPark?: boolean;
  versionNo?: number;
  name?: string;
}

/** The section 14 default shape: REPORTS_TO, then ROLE HR_ADMIN. */
export const TWO_STEP: StepSpec[] = [
  { resolution: 'REPORTS_TO', name: 'Manager approval' },
  { resolution: 'ROLE', role: 'HR_ADMIN', name: 'HR approval' },
];

export class WorkflowKit {
  readonly engine: WorkflowEngine;
  readonly registry: WorkflowSubjectRegistry;
  readonly jobs: JobsService;
  readonly outbox: OutboxService;
  private readonly restores: (() => void)[] = [];

  constructor(readonly t: TestApp) {
    this.engine = t.app.get(WorkflowEngine);
    this.registry = t.app.get(WorkflowSubjectRegistry);
    this.jobs = t.app.get(JobsService);
    this.outbox = t.app.get(OutboxService);
  }

  useFakeHandler(type: WorkflowTypeCode): FakeSubjectHandler {
    const handler = new FakeSubjectHandler(type);
    this.restores.push(this.registry.register(handler, { replace: true }));
    return handler;
  }

  restore(): void {
    while (this.restores.length) this.restores.pop()?.();
  }

  async definition(spec: DefinitionSpec): Promise<number> {
    const type = await this.t.db.prisma.workflowType.findUniqueOrThrow({ where: { code: spec.type } });
    return this.t.db.tx(sys, async (tx) => {
      const def = await tx.workflowDefinition.create({
        data: {
          workflowTypeId: type.id,
          companyRuleId: spec.companyRuleId,
          discriminator: spec.discriminator ?? null,
          name: spec.name ?? `Test ${spec.type}`,
          versionNo: spec.versionNo ?? 1,
          allowReassign: spec.allowReassign ?? true,
          allowResubmit: spec.allowResubmit ?? true,
          canPark: spec.canPark ?? true,
          steps: {
            create: spec.steps.map((s, i) => ({
              stepNo: i + 1,
              name: s.name ?? `Step ${i + 1}`,
              resolution: s.resolution,
              approverRole: s.role ?? null,
              approverUserId: s.userId ?? null,
              isMandatory: s.isMandatory ?? true,
              skipIfSameApprover: s.skipIfSameApprover ?? true,
              escalationHours: s.escalationHours ?? null,
            })),
          },
        },
      });
      return def.id;
    });
  }

  /** Starts a process for `subject` (default: the submitter) with a fresh fake subject. */
  async start(
    handler: FakeSubjectHandler,
    submitter: Person,
    options: {
      subject?: Person;
      fake?: Partial<FakeSubject>;
      discriminator?: string;
      ctx?: SecurityContext;
      comment?: string;
    } = {},
  ): Promise<WorkflowProcessDto> {
    const n = await nextUnique(this.t.db);
    const subjectEntityId = `fake-${n}`;
    handler.subjects.set(subjectEntityId, {
      label: 'Fake Item',
      fromDate: '2026-09-24',
      toDate: '2026-09-26',
      units: '3.0000',
      warn: false,
      ...options.fake,
    });
    const subject = options.subject ?? submitter;
    if (subject.employeeId === null) throw new Error('The subject needs an employee record');
    return this.engine.start(options.ctx ?? contextFor(submitter), {
      type: handler.type,
      subjectEntity: 'FakeSubject',
      subjectEntityId,
      subjectEmployeeId: subject.employeeId,
      summary: `Fake request ${n}`,
      discriminator: options.discriminator ?? null,
      comment: options.comment ?? null,
    });
  }

  instances(processId: number) {
    return this.t.db.prisma.workflowStepInstance.findMany({
      where: { processId },
      orderBy: { id: 'asc' },
    });
  }

  actions(processId: number) {
    return this.t.db.prisma.workflowAction.findMany({ where: { processId }, orderBy: { id: 'asc' } });
  }

  process(processId: number) {
    return this.t.db.prisma.workflowProcess.findUniqueOrThrow({ where: { id: processId } });
  }

  /** Delivers every pending outbox event (notifications) and waits for background email. */
  async publish(): Promise<void> {
    await this.jobs.runNow('outbox.publish');
    await this.t.mail.flush();
  }

  notifications(userId: string, processId?: number) {
    return this.t.db.prisma.notification.findMany({
      where: { userId, ...(processId ? { link: `/inbox/items/${processId}` } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** An open pay period covering this month for the org's company rule. */
  async payPeriod(org: Org, options: { closed?: boolean; month?: BusinessDate } = {}): Promise<number> {
    const start = startOfMonth(options.month ?? todayBusinessDate());
    return this.t.db.tx(sys, async (tx) => {
      const existing = await tx.payPeriod.findUnique({
        where: {
          companyRuleId_startDate: { companyRuleId: org.companyRuleId, startDate: dateFromBusiness(start) },
        },
      });
      if (existing) return existing.id;
      const row = await tx.payPeriod.create({
        data: {
          companyRuleId: org.companyRuleId,
          description: `Test ${start}`,
          startDate: dateFromBusiness(start),
          endDate: dateFromBusiness(endOfMonth(start)),
          isClosed: options.closed ?? false,
        },
      });
      return row.id;
    });
  }

  /** Sets a setting through the audited service and returns a function that restores it. */
  async setting<K extends 'workflow.escalation.autoReassign' | 'workflow.autoProcess.CLAIMS'>(
    key: K,
    value: boolean,
  ): Promise<() => Promise<void>> {
    const previous = await this.t.settings.get(key);
    const admin = systemContext('test-settings');
    await this.t.settings.update(admin, { [key]: value });
    return async () => {
      await this.t.settings.update(admin, { [key]: previous });
    };
  }
}
