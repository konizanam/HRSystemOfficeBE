import { Injectable } from '@nestjs/common';
import type { LeaveApplication, Prisma } from '@prisma/client';
import {
  businessFromDate,
  type CancelLeaveRequest,
  type CancelLeaveResponse,
  dateFromBusiness,
  dec,
  formatGridDate,
  formatLeaveReference,
  LEAVE_HISTORY_STATUSES,
  LEAVE_PROBLEM_TYPES,
  LEAVE_UNIT_LABEL,
  type LeaveApplicationDetail,
  type LeaveApplicationRow,
  type LeaveApplicationSort,
  type LeaveApplicationsQuery,
  type LeaveApplicationsResponse,
  type LeaveCalculateRequest,
  type LeaveCalculateResponse,
  type LeaveReasonsResponse,
  LeaveResubmitChangesSchema,
  type LeaveTypesResponse,
  round4,
  sequenceKeys,
  type SubmitLeaveRequest,
  todayBusinessDate,
  units4,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import { hasRole, type SecurityContext, SYSTEM_USER_ID } from '../../common/context/security-context';
import {
  assertVersion,
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { AttachmentService } from '../attachments/attachment.service';
import { ScopeService } from '../auth/scope.service';
import { HolidayService } from '../holidays/holiday.service';
import { SettingsService } from '../settings/settings.service';
import { WorkflowPeopleService } from '../workflow/people.service';
import { PROCESS_INCLUDE } from '../workflow/process-shape';
import { WorkflowAccessService } from '../workflow/workflow-access.service';
import { WorkflowEngine } from '../workflow/workflow-engine.service';
import { WorkflowHistoryService } from '../workflow/workflow-history.service';
import { EntitlementService } from './entitlement.service';
import { assertCanReadLeave, canReadLeave } from './leave-access';
import { LEAVE_APPLICATION_ENTITY, LEAVE_EMPLOYEE_SELECT, type LeaveEmployee } from './leave-constants';
import { APPLICATION_ROW_INCLUDE, type ApplicationRowSource, toApplicationRow } from './leave-mapper';
import { LeavePolicyService } from './leave-policy.service';
import { LeaveRequestValidator } from './leave-request.validator';
import { availableFor, calculateUnits } from './leave-rules';

/** Approver actions that count as "a step has been actioned" (section 5.2.3). */
const ACTIONED = ['APPROVE', 'DECLINE', 'REASSIGN', 'PARK', 'SEND_BACK'] as const;

const DETAIL_INCLUDE = {
  ...APPLICATION_ROW_INCLUDE,
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
  days: { orderBy: { date: 'asc' } },
  allocations: { orderBy: { id: 'asc' }, include: { entitlement: true } },
  payPeriod: { select: { id: true, description: true } },
  process: {
    select: {
      id: true,
      subjectEmployeeId: true,
      submittedByUserId: true,
      subjectEmployee: { select: { companyId: true } },
    },
  },
} satisfies Prisma.LeaveApplicationInclude;

/** The history grids' sorts (`?sort=`); ties go to the newest application. */
const HISTORY_ORDER: Record<LeaveApplicationSort, Prisma.LeaveApplicationOrderByWithRelationInput[]> = {
  'fromDate:desc': [{ fromDate: 'desc' }, { id: 'desc' }],
  'fromDate:asc': [{ fromDate: 'asc' }, { id: 'desc' }],
  'toDate:desc': [{ toDate: 'desc' }, { id: 'desc' }],
  'toDate:asc': [{ toDate: 'asc' }, { id: 'desc' }],
  'referenceNumber:asc': [{ referenceNumber: 'asc' }],
  'referenceNumber:desc': [{ referenceNumber: 'desc' }],
  'submittedAt:desc': [{ submittedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
  'submittedAt:asc': [{ submittedAt: { sort: 'asc', nulls: 'last' } }, { id: 'desc' }],
};

/** Long-running bursts of submits queue for a connection rather than fail (see ASSUMPTIONS). */
const SUBMIT_TX = { maxWaitMs: 60_000, timeoutMs: 60_000 };

/**
 * Leave applications (section 5.2): the unit calculation, submit, history, detail, cancel and the
 * resubmission of a sent-back request. Workflow hooks live in the subject handlers.
 */
@Injectable()
export class LeaveService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly scope: ScopeService,
    private readonly policies: LeavePolicyService,
    private readonly entitlements: EntitlementService,
    private readonly validator: LeaveRequestValidator,
    private readonly holidays: HolidayService,
    private readonly engine: WorkflowEngine,
    private readonly history: WorkflowHistoryService,
    private readonly access: WorkflowAccessService,
    private readonly people: WorkflowPeopleService,
    private readonly attachments: AttachmentService,
  ) {}

  // ───────────── Reference data ─────────────

  /** GET /leave/types: active types with a policy for the employee's company rule. */
  async types(ctx: SecurityContext, employeeId = ctx.actingAsEmployeeId): Promise<LeaveTypesResponse> {
    await this.scope.assertCanAccessEmployee(ctx, employeeId, 'SELF_SERVICE');
    const employee = await this.loadEmployee(this.db.prisma, employeeId);
    const policies = await this.policies.applicable(employee.companyRuleId);
    const reasons = await this.db.prisma.leaveReason.groupBy({
      by: ['leaveTypeId'],
      where: { isActive: true, leaveTypeId: { in: policies.map((p) => p.leaveTypeId) } },
      _count: true,
    });
    const withReasons = new Set(reasons.map((r) => r.leaveTypeId));
    return {
      employeeId,
      items: policies.map((p) => this.policies.toLeaveTypeDto(p, withReasons.has(p.leaveTypeId))),
    };
  }

  /** GET /leave/types/:id/reasons. */
  async reasons(leaveTypeId: number): Promise<LeaveReasonsResponse> {
    const type = await this.db.prisma.leaveType.findUnique({ where: { id: leaveTypeId } });
    if (!type || !type.isActive) throw new NotFoundError('Leave type');
    const rows = await this.db.prisma.leaveReason.findMany({
      where: { leaveTypeId, isActive: true },
      orderBy: [{ description: 'asc' }, { id: 'asc' }],
    });
    return {
      leaveTypeId,
      mandatoryReason: type.mandatoryReason,
      items: rows.map((r) => ({
        id: r.id,
        leaveTypeId: r.leaveTypeId,
        code: r.code,
        description: r.description,
      })),
    };
  }

  // ───────────── Calculate (live balance panel) ─────────────

  /** POST /leave/calculate: units, the per-day breakdown and the balance panel figures. */
  async calculate(ctx: SecurityContext, input: LeaveCalculateRequest): Promise<LeaveCalculateResponse> {
    const employeeId = input.employeeId ?? ctx.actingAsEmployeeId;
    await this.scope.assertCanAccessEmployee(ctx, employeeId, 'SELF_SERVICE');
    const prisma = this.db.prisma;
    const employee = await this.loadEmployee(prisma, employeeId);
    const type = await prisma.leaveType.findUnique({ where: { id: input.leaveTypeId } });
    if (!type || !type.isActive) throw ValidationError.field('leaveTypeId', 'Choose a leave type');
    await this.policies.requirePolicy(employee.companyRuleId, type.id);
    const holidays = await this.holidays.calendar(employee.companyId, input.fromDate, input.toDate);
    const calc = calculateUnits({
      fromDate: input.fromDate,
      toDate: input.toDate,
      startPortion: input.startPortion,
      endPortion: input.endPortion,
      excludeWeekends: type.excludeWeekends,
      excludePublicHolidays: type.excludePublicHolidays,
      allowHalfDay: type.allowHalfDay,
      holidays,
    });
    if (input.excludeApplicationId !== undefined) {
      const own = await prisma.leaveApplication.findUnique({
        where: { id: input.excludeApplicationId },
        select: { employeeId: true },
      });
      if (own?.employeeId !== employeeId)
        throw ValidationError.field('excludeApplicationId', 'Unknown application');
    }
    const buckets = await this.entitlements.buckets(employeeId, type.id, {
      excludeApplicationId: input.excludeApplicationId,
    });
    const available = availableFor(buckets, input.fromDate);
    const remaining = round4(available.minus(calc.units));
    return {
      employeeId,
      leaveTypeId: type.id,
      fromDate: input.fromDate,
      toDate: input.toDate,
      startPortion: input.startPortion,
      endPortion: input.endPortion,
      units: units4(calc.units),
      days: calc.days.map((d) => ({ date: d.date, portion: d.portion, units: units4(d.units) })),
      excludedDays: calc.excluded,
      available: units4(available),
      toBeDeducted: units4(calc.units),
      remaining: units4(remaining),
      unitLabel: LEAVE_UNIT_LABEL,
      hideUnitsAvailable: type.hideUnitsAvailableForESS,
      wouldGoNegative: remaining.lt(0),
      attachmentRequired:
        type.requiresAttachmentAfterDays !== null && calc.units.gt(dec(type.requiresAttachmentAfterDays)),
    };
  }

  // ───────────── Submit ─────────────

  /**
   * POST /leave/applications (section 5.2.1), one transaction: reference number, application with
   * its days and bucket allocations (reservations), the LEAVE workflow, attachments bound, and the
   * `LEAVE.SUBMITTED` audit row (the engine adds `WORKFLOW.CREATED`).
   */
  async submit(ctx: SecurityContext, input: SubmitLeaveRequest): Promise<LeaveApplicationDetail> {
    const maxBackdateDays = await this.settings.get('leave.maxBackdateDays');
    const employeeId = input.employeeId ?? ctx.actingAsEmployeeId;
    const id = await this.db.tx(
      ctx,
      async (tx) => {
        await this.scope.assertCanAccessEmployee(ctx, employeeId, 'SELF_SERVICE', tx);
        if (input.overrideUnits) {
          if (!hasRole(ctx, 'HR_ADMIN')) {
            throw new ForbiddenError('Only HR administrators can override the calculated units', {
              subjectEmployeeId: employeeId,
              metadata: { overrideUnits: true },
            });
          }
          await this.scope.assertCanAccessEmployee(ctx, employeeId, 'HR_WRITE', tx);
        }
        await this.entitlements.lockEmployee(tx, employeeId);
        const employee = await this.loadEmployee(tx, employeeId);
        const leaveType = await tx.leaveType.findUnique({ where: { id: input.leaveTypeId } });
        if (!leaveType || !leaveType.isActive)
          throw ValidationError.field('leaveTypeId', 'Choose a leave type');
        const policy = await this.policies.requirePolicy(employee.companyRuleId, leaveType.id, tx);
        await this.entitlements.ensureCurrentBuckets(tx, ctx, employee, todayBusinessDate(), leaveType.id);
        const evaluated = await this.validator.evaluate(
          tx,
          ctx,
          {
            employee,
            leaveType,
            policy,
            fromDate: input.fromDate,
            toDate: input.toDate,
            startPortion: input.startPortion,
            endPortion: input.endPortion,
            leaveReasonId: input.leaveReasonId ?? null,
            attachmentCount: input.attachmentIds.length,
            overrideUnits: input.overrideUnits && input.units ? dec(input.units) : null,
          },
          { maxBackdateDays },
        );

        const seq = await this.db.nextSequence(tx, sequenceKeys.leave(employee.id, leaveType.id));
        const referenceNumber = formatLeaveReference(employee.entityCode, leaveType.id, seq);
        const created = await tx.leaveApplication.create({
          data: {
            referenceNumber,
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            leaveReasonId: input.leaveReasonId ?? null,
            fromDate: dateFromBusiness(input.fromDate),
            toDate: dateFromBusiness(input.toDate),
            startPortion: input.startPortion,
            endPortion: input.fromDate === input.toDate ? input.startPortion : input.endPortion,
            unitsTaken: evaluated.units.toString(),
            unitsOverridden: Boolean(input.overrideUnits),
            overrideReason: input.overrideUnits ? (input.overrideReason ?? null) : null,
            noteSubmitted: input.noteSubmitted,
            comment: input.comment || null,
            status: 'IN_PROGRESS',
            submittedAt: new Date(),
            availableAtSubmit: evaluated.available.toString(),
            days: {
              create: evaluated.calculation.days.map((d) => ({
                date: dateFromBusiness(d.date),
                portion: d.portion,
                units: d.units.toString(),
              })),
            },
            allocations: {
              create: evaluated.allocations.map((a) => ({
                entitlementId: a.entitlementId,
                units: a.units.toString(),
              })),
            },
          },
        });
        await this.attachments.bind(tx, ctx, input.attachmentIds, {
          entity: LEAVE_APPLICATION_ENTITY,
          entityId: created.id,
          subjectEmployeeId: employee.id,
        });
        const process = await this.engine.start(ctx, {
          type: 'LEAVE',
          subjectEntity: LEAVE_APPLICATION_ENTITY,
          subjectEntityId: created.id,
          subjectEmployeeId: employee.id,
          summary: `${leaveType.description} ${formatGridDate(input.fromDate)} to ${formatGridDate(input.toDate)} (${units4(evaluated.units)} days)`,
          comment: input.comment || null,
        });
        const app = await tx.leaveApplication.update({
          where: { id: created.id },
          data: { processId: process.id },
        });
        this.audit.record(tx, ctx, {
          category: 'WORKFLOW',
          action: 'LEAVE.SUBMITTED',
          entityType: 'LeaveApplication',
          entityId: app.id,
          subjectEmployeeId: app.employeeId,
          after: app,
          metadata: {
            referenceNumber,
            processId: process.id,
            units: units4(evaluated.units),
            available: units4(evaluated.available),
            days: evaluated.calculation.days.map((d) => ({
              date: d.date,
              portion: d.portion,
              units: units4(d.units),
            })),
            allocations: evaluated.allocations.map((a) => ({
              entitlementId: a.entitlementId,
              units: units4(a.units),
            })),
            attachmentIds: input.attachmentIds,
            onBehalf: ctx.selfEmployeeId !== employee.id,
          },
        });
        if (input.overrideUnits) {
          this.audit.record(tx, ctx, {
            category: 'DATA_CHANGE',
            action: 'LEAVE.UNITS_OVERRIDDEN',
            entityType: 'LeaveApplication',
            entityId: app.id,
            subjectEmployeeId: app.employeeId,
            reason: input.overrideReason ?? null,
            metadata: { calculated: units4(evaluated.calculation.units), override: units4(evaluated.units) },
          });
        }
        return app.id;
      },
      SUBMIT_TX,
    );
    return this.detail(ctx, id);
  }

  // ───────────── History and detail ─────────────

  /**
   * GET /leave/applications?status=completed|inProgress (section 5.2.3): filtered by leave type,
   * a date range (overlapping applications) and part of the reference number, sorted on the
   * server (From Date newest first by default), paginated.
   */
  async list(ctx: SecurityContext, query: LeaveApplicationsQuery): Promise<LeaveApplicationsResponse> {
    const employeeId = query.employeeId ?? ctx.actingAsEmployeeId;
    await assertCanReadLeave(this.scope, ctx, employeeId);
    const where: Prisma.LeaveApplicationWhereInput = {
      employeeId,
      status: { in: LEAVE_HISTORY_STATUSES[query.status] },
      ...(query.leaveTypeId !== undefined ? { leaveTypeId: query.leaveTypeId } : {}),
      ...(query.from ? { toDate: { gte: dateFromBusiness(query.from) } } : {}),
      ...(query.to ? { fromDate: { lte: dateFromBusiness(query.to) } } : {}),
      ...(query.reference ? { referenceNumber: { contains: query.reference, mode: 'insensitive' } } : {}),
    };
    const [apps, total] = await Promise.all([
      this.db.prisma.leaveApplication.findMany({
        where,
        include: APPLICATION_ROW_INCLUDE,
        orderBy: HISTORY_ORDER[query.sort],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.prisma.leaveApplication.count({ where }),
    ]);
    return {
      items: await this.toRows(this.db.prisma, apps),
      total,
      page: query.page,
      pageSize: query.pageSize,
      status: query.status,
      employeeId,
      sort: query.sort,
    };
  }

  /** GET /leave/applications/:id: the detail modal with the approval history. */
  async detail(ctx: SecurityContext, id: number): Promise<LeaveApplicationDetail> {
    const prisma = this.db.prisma;
    const app = await prisma.leaveApplication.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!app) throw new NotFoundError('Leave application');
    const allowed =
      (await canReadLeave(this.scope, ctx, app.employeeId)) ||
      (app.process !== null &&
        (await this.access.canRead(prisma, ctx, {
          id: app.process.id,
          subjectEmployeeId: app.process.subjectEmployeeId,
          submittedByUserId: app.process.submittedByUserId,
          companyId: app.process.subjectEmployee.companyId,
        })));
    if (!allowed) {
      throw new ForbiddenError('You do not have access to this leave application', {
        subjectEmployeeId: app.employeeId,
        metadata: { leaveApplicationId: id },
      });
    }
    const [row] = await this.toRows(prisma, [app]);
    if (!row) throw new NotFoundError('Leave application');
    const [attachments, approvalHistory] = await Promise.all([
      this.attachments.listFor(prisma, LEAVE_APPLICATION_ENTITY, app.id),
      app.processId !== null ? this.historyOf(app.processId) : Promise.resolve(null),
    ]);
    return {
      ...row,
      employee: app.employee,
      comment: app.comment,
      unitsOverridden: app.unitsOverridden,
      overrideReason: app.overrideReason,
      availableAtSubmit: app.availableAtSubmit === null ? null : units4(app.availableAtSubmit),
      days: app.days.map((d) => ({
        date: businessFromDate(d.date),
        portion: d.portion,
        units: units4(d.units),
      })),
      allocations: app.allocations.map((a) => ({
        entitlementId: a.entitlementId,
        definitionName: a.entitlement.definitionName,
        cycleEndDate: businessFromDate(a.entitlement.cycleEndDate),
        units: units4(a.units),
        released: a.releasedAt !== null,
      })),
      attachments,
      payPeriod: app.payPeriod,
      processedAt: app.processedAt?.toISOString() ?? null,
      approvalHistory,
    };
  }

  private async historyOf(processId: number) {
    const p = await this.db.prisma.workflowProcess.findUniqueOrThrow({
      where: { id: processId },
      include: PROCESS_INCLUDE,
    });
    return this.history.build(this.db.prisma, p);
  }

  /** Processes with an approver action (approve, decline, reassign, park, send back). */
  async actionedProcessIds(client: Tx, processIds: number[]): Promise<Set<number>> {
    if (processIds.length === 0) return new Set();
    const rows = await client.workflowAction.groupBy({
      by: ['processId'],
      where: {
        processId: { in: processIds },
        action: { in: [...ACTIONED] },
        actorUserId: { not: SYSTEM_USER_ID },
      },
      _count: true,
    });
    return new Set(rows.map((r) => r.processId));
  }

  async toRows(client: Tx, apps: ApplicationRowSource[]): Promise<LeaveApplicationRow[]> {
    const approverIds = apps.map((a) => a.finalApproverUserId).filter((u): u is string => u !== null);
    const [persons, actioned] = await Promise.all([
      this.people.byIds(client, approverIds),
      this.actionedProcessIds(
        client,
        apps.map((a) => a.processId).filter((p): p is number => p !== null),
      ),
    ]);
    return apps.map((app) =>
      toApplicationRow(app, {
        finalApprover: app.finalApproverUserId ? (persons.get(app.finalApproverUserId)?.name ?? null) : null,
        actioned: app.processId !== null && actioned.has(app.processId),
      }),
    );
  }

  private async row(client: Tx, id: number): Promise<LeaveApplicationRow> {
    const app = await client.leaveApplication.findUniqueOrThrow({
      where: { id },
      include: APPLICATION_ROW_INCLUDE,
    });
    const [row] = await this.toRows(client, [app]);
    if (!row) throw new NotFoundError('Leave application');
    return row;
  }

  // ───────────── Cancel (section 5.2.3) ─────────────

  /**
   * Withdraws an application nothing has been done with yet (or that was sent back), releasing
   * its allocations; otherwise starts a CANCELLEAVE request with its own reference and workflow.
   * Only one open cancellation per application.
   */
  async cancel(ctx: SecurityContext, id: number, input: CancelLeaveRequest): Promise<CancelLeaveResponse> {
    const comment = input.comment?.trim() || null;
    const result = await this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'LeaveApplication', id);
      const app = await tx.leaveApplication.findUnique({
        where: { id },
        include: {
          leaveType: true,
          days: { orderBy: { date: 'asc' } },
          process: true,
          employee: { select: LEAVE_EMPLOYEE_SELECT },
          cancellations: {
            where: {
              status: { in: ['DRAFT', 'IN_PROGRESS', 'RESUBMIT_REQUIRED', 'APPROVED_PENDING_PROCESS'] },
            },
          },
        },
      });
      if (!app) throw new NotFoundError('Leave application');
      await this.scope.assertCanAccessEmployee(ctx, app.employeeId, 'SELF_SERVICE', tx);
      assertVersion(app, input.version);

      const actioned =
        app.processId !== null && (await this.actionedProcessIds(tx, [app.processId])).has(app.processId);
      const withdrawable = app.status === 'RESUBMIT_REQUIRED' || (app.status === 'IN_PROGRESS' && !actioned);
      if (withdrawable) {
        if (!app.process) throw new ConflictError('This application has no workflow to withdraw');
        if (this.access.isApplicant(ctx, app.process)) {
          await this.engine.withdraw(ctx, app.process.id, app.process.version, comment);
        } else {
          await this.engine.cancel(ctx, app.process.id, { comment, expectedVersion: app.process.version });
        }
        return { outcome: 'WITHDRAWN' as const, cancellationId: null };
      }
      if (app.cancelsApplicationId !== null) {
        throw new ConflictError('This cancellation request can no longer be withdrawn');
      }
      if (!['IN_PROGRESS', 'APPROVED_PENDING_PROCESS', 'PROCESSED'].includes(app.status)) {
        throw new ConflictError('This leave can no longer be cancelled');
      }
      if (app.cancellations.length > 0) {
        throw new DomainError(
          409,
          'Conflict',
          'A cancellation of this leave is already waiting for approval',
          undefined,
          LEAVE_PROBLEM_TYPES.cancellationOpen,
        );
      }
      const cancellation = await this.createCancellation(tx, ctx, app, comment);
      return { outcome: 'CANCELLATION_REQUESTED' as const, cancellationId: cancellation.id };
    });
    return {
      outcome: result.outcome,
      application: await this.row(this.db.prisma, id),
      cancellation:
        result.cancellationId === null ? null : await this.row(this.db.prisma, result.cancellationId),
    };
  }

  private async createCancellation(
    tx: Tx,
    ctx: SecurityContext,
    app: LeaveApplication & {
      leaveType: { id: number; description: string };
      days: { date: Date; portion: 'FULL' | 'AM' | 'PM'; units: Prisma.Decimal }[];
      employee: LeaveEmployee;
    },
    comment: string | null,
  ): Promise<LeaveApplication> {
    await this.entitlements.lockEmployee(tx, app.employeeId);
    const seq = await this.db.nextSequence(tx, sequenceKeys.leave(app.employeeId, app.leaveTypeId));
    const referenceNumber = formatLeaveReference(app.employee.entityCode, app.leaveTypeId, seq);
    const created = await tx.leaveApplication.create({
      data: {
        referenceNumber,
        employeeId: app.employeeId,
        leaveTypeId: app.leaveTypeId,
        leaveReasonId: app.leaveReasonId,
        fromDate: app.fromDate,
        toDate: app.toDate,
        startPortion: app.startPortion,
        endPortion: app.endPortion,
        unitsTaken: app.unitsTaken,
        comment,
        status: 'IN_PROGRESS',
        submittedAt: new Date(),
        cancelsApplicationId: app.id,
        days: { create: app.days.map((d) => ({ date: d.date, portion: d.portion, units: d.units })) },
      },
    });
    const process = await this.engine.start(ctx, {
      type: 'CANCELLEAVE',
      subjectEntity: LEAVE_APPLICATION_ENTITY,
      subjectEntityId: created.id,
      subjectEmployeeId: app.employeeId,
      summary: `Cancel ${app.leaveType.description} ${formatGridDate(app.fromDate)} to ${formatGridDate(app.toDate)} (${app.referenceNumber})`,
      comment,
    });
    const after = await tx.leaveApplication.update({
      where: { id: created.id },
      data: { processId: process.id },
    });
    this.audit.record(tx, ctx, {
      category: 'WORKFLOW',
      action: 'LEAVE.CANCELLATION_REQUESTED',
      entityType: 'LeaveApplication',
      entityId: after.id,
      subjectEmployeeId: after.employeeId,
      after,
      reason: comment,
      metadata: {
        referenceNumber,
        processId: process.id,
        cancelsApplicationId: app.id,
        cancelsReferenceNumber: app.referenceNumber,
        originalStatus: app.status,
      },
    });
    return after;
  }

  // ───────────── Resubmission (sent back, then edited) ─────────────

  /**
   * Applies the applicant's edits when a sent-back request is resubmitted (LeaveSubjectHandler).
   * The request is validated again as on submit, leaving its own days and reservation out; its
   * allocations are released and reserved again for the new units.
   */
  async resubmit(
    tx: Tx,
    ctx: SecurityContext,
    applicationId: number,
    rawChanges: Record<string, unknown> | undefined,
  ): Promise<void> {
    const before = await tx.leaveApplication.findUniqueOrThrow({ where: { id: applicationId } });
    const parsed = LeaveResubmitChangesSchema.safeParse(rawChanges ?? {});
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => ({ path: ['changes', ...i.path].join('.'), message: i.message })),
      );
    }
    const changes = parsed.data;
    const data: Prisma.LeaveApplicationUncheckedUpdateInput = {
      status: 'IN_PROGRESS',
      version: { increment: 1 },
    };
    const metadata: Record<string, unknown> = { changes: Object.keys(changes) };

    if (Object.keys(changes).length > 0) {
      await this.entitlements.lockEmployee(tx, before.employeeId);
      const employee = await this.loadEmployee(tx, before.employeeId);
      const leaveType = await tx.leaveType.findUniqueOrThrow({ where: { id: before.leaveTypeId } });
      const policy = await this.policies.requirePolicy(employee.companyRuleId, leaveType.id, tx);
      const fromDate = changes.fromDate ?? businessFromDate(before.fromDate);
      const toDate = changes.toDate ?? businessFromDate(before.toDate);
      const startPortion = changes.startPortion ?? before.startPortion;
      const endPortion = changes.endPortion ?? before.endPortion;
      if (toDate < fromDate) throw ValidationError.field('changes.toDate', 'End must be on or after Start');
      const datesChanged =
        fromDate !== businessFromDate(before.fromDate) ||
        toDate !== businessFromDate(before.toDate) ||
        startPortion !== before.startPortion ||
        endPortion !== before.endPortion;
      const leaveReasonId =
        changes.leaveReasonId === undefined ? before.leaveReasonId : changes.leaveReasonId;
      const newAttachments = changes.attachmentIds ?? [];
      const boundCount = await tx.attachment.count({
        where: { ownerEntity: LEAVE_APPLICATION_ENTITY, ownerEntityId: String(before.id), deletedAt: null },
      });
      const evaluated = await this.validator.evaluate(
        tx,
        ctx,
        {
          employee,
          leaveType,
          policy,
          fromDate,
          toDate,
          startPortion,
          endPortion,
          leaveReasonId,
          attachmentCount: boundCount + newAttachments.length,
          overrideUnits: before.unitsOverridden && !datesChanged ? dec(before.unitsTaken) : null,
          excludeApplicationId: before.id,
        },
        { maxBackdateDays: await this.settings.get('leave.maxBackdateDays') },
      );
      const now = new Date();
      await tx.leaveApplicationAllocation.updateMany({
        where: { applicationId: before.id, releasedAt: null },
        data: { releasedAt: now },
      });
      await tx.leaveApplicationAllocation.createMany({
        data: evaluated.allocations.map((a) => ({
          applicationId: before.id,
          entitlementId: a.entitlementId,
          units: a.units.toString(),
        })),
      });
      // The days are derived from the dates; the before/after audit snapshot keeps the old ones.
      const oldDays = await tx.leaveApplicationDay.findMany({ where: { applicationId: before.id } });
      await tx.leaveApplicationDay.deleteMany({ where: { applicationId: before.id } });
      await tx.leaveApplicationDay.createMany({
        data: evaluated.calculation.days.map((d) => ({
          applicationId: before.id,
          date: dateFromBusiness(d.date),
          portion: d.portion,
          units: d.units.toString(),
        })),
      });
      await this.attachments.bind(
        tx,
        ctx,
        newAttachments,
        {
          entity: LEAVE_APPLICATION_ENTITY,
          entityId: before.id,
          subjectEmployeeId: before.employeeId,
        },
        'changes.attachmentIds',
      );
      Object.assign(data, {
        fromDate: dateFromBusiness(fromDate),
        toDate: dateFromBusiness(toDate),
        startPortion,
        endPortion: fromDate === toDate ? startPortion : endPortion,
        leaveReasonId,
        unitsTaken: evaluated.units.toString(),
        unitsOverridden: before.unitsOverridden && !datesChanged,
        overrideReason: before.unitsOverridden && !datesChanged ? before.overrideReason : null,
        availableAtSubmit: evaluated.available.toString(),
        ...(changes.comment !== undefined ? { comment: changes.comment || null } : {}),
        ...(changes.noteSubmitted !== undefined ? { noteSubmitted: changes.noteSubmitted } : {}),
      });
      metadata.previousDays = oldDays.map((d) => ({
        date: businessFromDate(d.date),
        portion: d.portion,
        units: units4(d.units),
      }));
      metadata.allocations = evaluated.allocations.map((a) => ({
        entitlementId: a.entitlementId,
        units: units4(a.units),
      }));
    }
    const after = await tx.leaveApplication.update({ where: { id: before.id }, data });
    this.audit.record(tx, ctx, {
      category: 'WORKFLOW',
      action: 'LEAVE.RESUBMITTED',
      entityType: 'LeaveApplication',
      entityId: after.id,
      subjectEmployeeId: after.employeeId,
      before,
      after,
      metadata,
    });
  }

  // ───────────── Helpers ─────────────

  async loadEmployee(client: Tx, employeeId: number): Promise<LeaveEmployee> {
    const employee = await client.employee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: LEAVE_EMPLOYEE_SELECT,
    });
    if (!employee) throw new NotFoundError('Employee');
    return employee;
  }
}
