import { Injectable } from '@nestjs/common';
import type { CreditLeaveRequest, Prisma } from '@prisma/client';
import {
  addDays,
  type AllocatableEmployeesQuery,
  type AllocatableEmployeesResponse,
  businessFromDate,
  CREDIT_LEAVE_KIND_LABELS,
  type CreateCreditLeaveRequest,
  type CreditLeaveListResponse,
  type CreditLeaveQuery,
  type CreditLeaveRow,
  dateFromBusiness,
  daysBetween,
  dec,
  formatCardDate,
  formatCreditLeaveReference,
  formatGridDate,
  formatTimestampDate,
  PROCESS_STATUS_LABELS,
  sequenceKeys,
  todayBusinessDate,
  units4,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import { hasRole, isActingForOther, type SecurityContext } from '../../common/context/security-context';
import { type FieldError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { AttachmentService } from '../attachments/attachment.service';
import { ScopeService } from '../auth/scope.service';
import { WorkflowEngine } from '../workflow/workflow-engine.service';
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
} from '../workflow/workflow-subject';
import { EntitlementService } from './entitlement.service';
import { CREDIT_DEFINITION, CREDIT_LEAVE_ENTITY, LEAVE_EMPLOYEE_SELECT } from './leave-constants';
import { leaveTypeRef } from './leave-mapper';
import { LeavePolicyService } from './leave-policy.service';
import { clampDate } from './leave-rules';

/** Credit without an expiry stays in its bucket until this date. */
const NO_EXPIRY_END = '9999-12-31';

const ROW_INCLUDE = {
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
  leaveType: true,
  entitlement: { select: { expiresOn: true } },
} satisfies Prisma.CreditLeaveRequestInclude;

type RowSource = Prisma.CreditLeaveRequestGetPayload<{ include: typeof ROW_INCLUDE }>;

type CreditWorkflowType = 'CREDITLVEREQ' | 'CREDITLVEALLOC';

/**
 * Leave in lieu (section 5.2.4): REQUEST (CREDITLVEREQ, the employee asks for credit for days
 * worked) and ALLOCATION (CREDITLVEALLOC, a manager or HR grants credit to a report). Processing
 * opens a CREDIT bucket on the credit leave type and posts a CREDIT_ALLOCATION entry that expires
 * after `LeavePolicy.creditExpiryDays`.
 */
@Injectable()
export class CreditLeaveService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly policies: LeavePolicyService,
    private readonly entitlements: EntitlementService,
    private readonly engine: WorkflowEngine,
    private readonly attachments: AttachmentService,
  ) {}

  /** POST /leave/in-lieu. */
  async create(ctx: SecurityContext, input: CreateCreditLeaveRequest): Promise<CreditLeaveRow> {
    const employeeId = input.employeeId ?? ctx.actingAsEmployeeId;
    const id = await this.db.tx(ctx, async (tx) => {
      if (input.kind === 'REQUEST') {
        await this.scope.assertCanAccessEmployee(ctx, employeeId, 'SELF_SERVICE', tx);
      } else {
        await this.scope.assertCanAccessAny(ctx, employeeId, ['TEAM', 'HR_WRITE'], tx);
      }
      await this.entitlements.lockEmployee(tx, employeeId);
      const employee = await tx.employee.findFirst({
        where: { id: employeeId, deletedAt: null },
        select: LEAVE_EMPLOYEE_SELECT,
      });
      if (!employee) throw new NotFoundError('Employee');

      const errors: FieldError[] = [];
      if (input.kind === 'ALLOCATION' && employee.id === ctx.selfEmployeeId) {
        errors.push({ path: 'employeeId', message: 'You cannot allocate leave in lieu to yourself' });
      }
      if (employee.status !== 'ACTIVE')
        errors.push({ path: 'employeeId', message: 'The employee is not active' });
      const today = todayBusinessDate();
      if (input.workedTo > today)
        errors.push({ path: 'workedTo', message: 'The days worked must be in the past' });
      if (employee.dateEngaged && input.workedFrom < businessFromDate(employee.dateEngaged)) {
        errors.push({ path: 'workedFrom', message: 'The days worked are before the employee was engaged' });
      }
      if (employee.terminationDate && input.workedTo > businessFromDate(employee.terminationDate)) {
        errors.push({
          path: 'workedTo',
          message: "The days worked are after the employee's termination date",
        });
      }
      const calendarDays = daysBetween(input.workedFrom, input.workedTo) + 1;
      if (dec(input.units).gt(calendarDays)) {
        errors.push({
          path: 'units',
          message: `At most ${calendarDays} days can be credited for these dates`,
        });
      }
      const creditPolicy = (await this.policies.applicable(employee.companyRuleId, tx)).find(
        (p) => p.leaveType.isCreditLeave,
      );
      if (!creditPolicy)
        errors.push({ path: 'kind', message: 'Leave in lieu is not set up for this employee' });
      if (errors.length > 0 || !creditPolicy) throw new ValidationError(errors);

      const seq = await this.db.nextSequence(
        tx,
        sequenceKeys.creditLeave(employee.id, creditPolicy.leaveTypeId),
      );
      const referenceNumber = formatCreditLeaveReference(employee.entityCode, creditPolicy.leaveTypeId, seq);
      const created = await tx.creditLeaveRequest.create({
        data: {
          referenceNumber,
          kind: input.kind,
          employeeId: employee.id,
          leaveTypeId: creditPolicy.leaveTypeId,
          workedFrom: dateFromBusiness(input.workedFrom),
          workedTo: dateFromBusiness(input.workedTo),
          units: dec(input.units).toString(),
          reason: input.reason,
          status: 'IN_PROGRESS',
          submittedAt: new Date(),
        },
      });
      await this.attachments.bind(tx, ctx, input.attachmentIds, {
        entity: CREDIT_LEAVE_ENTITY,
        entityId: created.id,
        subjectEmployeeId: employee.id,
      });
      const process = await this.engine.start(ctx, {
        type: input.kind === 'REQUEST' ? 'CREDITLVEREQ' : 'CREDITLVEALLOC',
        subjectEntity: CREDIT_LEAVE_ENTITY,
        subjectEntityId: created.id,
        subjectEmployeeId: employee.id,
        summary: `${CREDIT_LEAVE_KIND_LABELS[input.kind]} ${formatGridDate(input.workedFrom)} to ${formatGridDate(input.workedTo)} (${units4(input.units)} days)`,
        comment: input.reason,
      });
      const after = await tx.creditLeaveRequest.update({
        where: { id: created.id },
        data: { processId: process.id },
      });
      this.audit.record(tx, ctx, {
        category: 'WORKFLOW',
        action: 'LEAVE_IN_LIEU.SUBMITTED',
        entityType: 'CreditLeaveRequest',
        entityId: after.id,
        subjectEmployeeId: after.employeeId,
        after,
        metadata: {
          referenceNumber,
          processId: process.id,
          kind: input.kind,
          attachmentIds: input.attachmentIds,
        },
      });
      return after.id;
    });
    return this.row(this.db.prisma, id);
  }

  /** GET /leave/in-lieu: requests about the acting-as employee, and allocations the caller made. */
  async list(ctx: SecurityContext, query: CreditLeaveQuery): Promise<CreditLeaveListResponse> {
    const or: Prisma.CreditLeaveRequestWhereInput[] = [{ employeeId: ctx.actingAsEmployeeId }];
    if (!isActingForOther(ctx)) or.push({ process: { submittedByUserId: ctx.userId } });
    const where: Prisma.CreditLeaveRequestWhereInput = {
      OR: or,
      ...(query.kind ? { kind: query.kind } : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.prisma.creditLeaveRequest.findMany({
        where,
        include: ROW_INCLUDE,
        orderBy: [{ workedFrom: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.prisma.creditLeaveRequest.count({ where }),
    ]);
    const items = await Promise.all(rows.map((r) => this.toRow(this.db.prisma, r)));
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  /**
   * GET /leave/in-lieu/allocatable-employees: who the signed-in user may allocate leave in lieu to
   * (the ALLOCATION rule of {@link create}): a manager's reports within `workingAs.maxDepth` and
   * an HR admin's companies; active employees whose company rule has a leave in lieu policy; never
   * the caller. Sorted by surname, first name; paginated, never truncated.
   */
  async allocatableEmployees(
    ctx: SecurityContext,
    query: AllocatableEmployeesQuery,
  ): Promise<AllocatableEmployeesResponse> {
    const prisma = this.db.prisma;
    const empty = { items: [], total: 0, page: query.page, pageSize: query.pageSize };
    const reportIds =
      hasRole(ctx, 'MANAGER') && ctx.selfEmployeeId !== null
        ? await this.scope.reportIdsWithinDepth(ctx.selfEmployeeId)
        : [];
    const scopes: Prisma.EmployeeWhereInput[] = [];
    if (reportIds.length > 0) scopes.push({ id: { in: reportIds } });
    if (hasRole(ctx, 'HR_ADMIN') && ctx.companyIds.length > 0) {
      scopes.push({ companyId: { in: ctx.companyIds } });
    }
    if (scopes.length === 0) return empty;
    const and: Prisma.EmployeeWhereInput[] = [{ OR: scopes }, { deletedAt: null, status: 'ACTIVE' }];
    if (ctx.selfEmployeeId !== null) and.push({ id: { not: ctx.selfEmployeeId } });
    if (query.search) {
      const contains = { contains: query.search, mode: 'insensitive' as const };
      and.push({
        OR: [
          { firstName: contains },
          { lastName: contains },
          { knownAs: contains },
          { employeeCode: contains },
        ],
      });
    }
    // Only company rules with a leave in lieu policy (anything else would answer 422 on create).
    const rules = await prisma.employee.groupBy({ by: ['companyRuleId'], where: { AND: and } });
    const allowedRules: number[] = [];
    for (const { companyRuleId } of rules) {
      const policies = await this.policies.applicable(companyRuleId);
      if (policies.some((p) => p.leaveType.isCreditLeave)) allowedRules.push(companyRuleId);
    }
    if (allowedRules.length === 0) return empty;
    const where: Prisma.EmployeeWhereInput = { AND: [...and, { companyRuleId: { in: allowedRules } }] };
    const [rows, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        select: {
          id: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          knownAs: true,
          companyRuleId: true,
          companyRule: { select: { description: true } },
        },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.employee.count({ where }),
    ]);
    const reports = new Set(reportIds);
    return {
      items: rows.map((e) => ({
        employeeId: e.id,
        employeeCode: e.employeeCode,
        firstName: e.firstName,
        lastName: e.lastName,
        knownAs: e.knownAs,
        displayName: `${e.firstName} ${e.lastName}`,
        companyRuleId: e.companyRuleId,
        companyRule: e.companyRule.description,
        relation: reports.has(e.id) ? ('REPORT' as const) : ('COMPANY' as const),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async row(client: Tx, id: number): Promise<CreditLeaveRow> {
    return this.toRow(
      client,
      await client.creditLeaveRequest.findUniqueOrThrow({ where: { id }, include: ROW_INCLUDE }),
    );
  }

  private async toRow(client: Tx, r: RowSource): Promise<CreditLeaveRow> {
    return {
      id: r.id,
      version: r.version,
      referenceNumber: r.referenceNumber,
      kind: r.kind,
      kindLabel: CREDIT_LEAVE_KIND_LABELS[r.kind],
      employee: r.employee,
      leaveType: leaveTypeRef(r.leaveType),
      workedFrom: businessFromDate(r.workedFrom),
      workedTo: businessFromDate(r.workedTo),
      units: units4(r.units),
      reason: r.reason,
      status: r.status,
      statusLabel: PROCESS_STATUS_LABELS[r.status],
      processId: r.processId,
      submittedAt: r.submittedAt?.toISOString() ?? null,
      processedAt: r.processedAt?.toISOString() ?? null,
      expiresOn: r.entitlement?.expiresOn ? businessFromDate(r.entitlement.expiresOn) : null,
      attachments: await this.attachments.listFor(client, CREDIT_LEAVE_ENTITY, r.id),
    };
  }

  // ───────────── Workflow hooks (CreditLeaveHandler) ─────────────

  async describe(client: Tx, process: WorkflowProcessSnapshot): Promise<SubjectDescription> {
    const r = await client.creditLeaveRequest.findUniqueOrThrow({
      where: { id: Number(process.subjectEntityId) },
      include: { leaveType: true },
    });
    const units = units4(r.units);
    const label = r.kind === 'REQUEST' ? 'Leave in Lieu' : 'Leave in Lieu Allocation';
    return {
      requestLabel: label,
      title: `${CREDIT_LEAVE_KIND_LABELS[r.kind]}`,
      fromDate: businessFromDate(r.workedFrom),
      toDate: businessFromDate(r.workedTo),
      unitsLine: `${units} Days to be credited`,
      headline: [{ label: 'Days to be credited', value: units }],
      fields: [
        { label: 'Leave type', value: r.leaveType.description },
        { label: 'Days worked from', value: formatCardDate(r.workedFrom) },
        { label: 'Days worked to', value: formatCardDate(r.workedTo) },
        { label: 'Days to be credited', value: `${units} Days` },
        { label: 'Reason', value: r.reason },
        { label: 'Date submitted', value: r.submittedAt ? formatTimestampDate(r.submittedAt) : '' },
        { label: 'Reference number', value: r.referenceNumber },
      ],
      kind: 'CREDIT_LEAVE',
      data: {
        creditLeaveRequestId: r.id,
        referenceNumber: r.referenceNumber,
        kind: r.kind,
        leaveTypeId: r.leaveTypeId,
        units,
      },
      viewLabel: 'View leave in lieu request',
    };
  }

  private async update(
    tx: Tx,
    ctx: SecurityContext,
    id: number,
    data: Prisma.CreditLeaveRequestUncheckedUpdateInput,
    action: string,
    extra: { reason?: string | null; metadata?: Record<string, unknown> } = {},
  ): Promise<CreditLeaveRequest> {
    const before = await tx.creditLeaveRequest.findUniqueOrThrow({ where: { id } });
    const after = await tx.creditLeaveRequest.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
    });
    this.audit.record(tx, ctx, {
      category: 'WORKFLOW',
      action,
      entityType: 'CreditLeaveRequest',
      entityId: id,
      subjectEmployeeId: after.employeeId,
      before,
      after,
      reason: extra.reason ?? null,
      metadata: { referenceNumber: after.referenceNumber, kind: after.kind, ...extra.metadata },
    });
    return after;
  }

  async onFinalApproval({ tx, ctx, process }: WorkflowHookContext): Promise<void> {
    await this.update(
      tx,
      ctx,
      Number(process.subjectEntityId),
      { status: process.status, approvedAt: new Date() },
      'LEAVE_IN_LIEU.APPROVED',
    );
  }

  /** Opens the CREDIT bucket and posts CREDIT_ALLOCATION into the pay period. */
  async onProcess({ tx, ctx, process, payPeriod, automatic }: WorkflowProcessHookContext): Promise<void> {
    const r = await tx.creditLeaveRequest.findUniqueOrThrow({
      where: { id: Number(process.subjectEntityId) },
      include: { employee: { select: LEAVE_EMPLOYEE_SELECT } },
    });
    const policy = await this.policies.policyFor(r.employee.companyRuleId, r.leaveTypeId, tx);
    const effectiveDate = clampDate(
      todayBusinessDate(),
      businessFromDate(payPeriod.startDate),
      businessFromDate(payPeriod.endDate),
    );
    const expiresOn = policy?.creditExpiryDays ? addDays(effectiveDate, policy.creditExpiryDays) : null;
    await this.entitlements.lockEmployee(tx, r.employeeId);
    const bucket = await this.entitlements.openBucket(
      tx,
      ctx,
      {
        employeeId: r.employeeId,
        leaveTypeId: r.leaveTypeId,
        policyId: policy?.id ?? null,
        kind: 'CREDIT',
        definitionName: CREDIT_DEFINITION,
        entitlement: r.units.toString(),
        cycleStartDate: effectiveDate,
        cycleEndDate: expiresOn ?? NO_EXPIRY_END,
        expiresOn,
      },
      { creditLeaveRequestId: r.id, referenceNumber: r.referenceNumber },
    );
    const entry = await this.entitlements.post(
      tx,
      ctx,
      {
        employeeId: r.employeeId,
        leaveTypeId: r.leaveTypeId,
        entitlementId: bucket.id,
        entryType: 'CREDIT_ALLOCATION',
        units: r.units.toString(),
        effectiveDate,
        payPeriodId: payPeriod.id,
        note: r.referenceNumber,
      },
      { action: 'LEAVE.CREDIT_ALLOCATED', metadata: { creditLeaveRequestId: r.id, expiresOn, automatic } },
    );
    await this.update(
      tx,
      ctx,
      r.id,
      {
        status: process.status,
        processedAt: new Date(),
        payPeriodId: payPeriod.id,
        entitlementId: bucket.id,
      },
      'LEAVE_IN_LIEU.PROCESSED',
      { metadata: { entitlementId: bucket.id, ledgerEntryId: entry?.id ?? null, expiresOn, automatic } },
    );
  }

  async onStatus(hook: WorkflowCommentHookContext, action: string): Promise<void> {
    await this.update(
      hook.tx,
      hook.ctx,
      Number(hook.process.subjectEntityId),
      { status: hook.process.status },
      action,
      {
        reason: hook.comment,
      },
    );
  }
}

/** CREDITLVEREQ and CREDITLVEALLOC (one instance each, registered by LeaveModule). */
export class CreditLeaveHandler implements WorkflowSubjectHandler {
  constructor(
    readonly type: CreditWorkflowType,
    private readonly credit: CreditLeaveService,
  ) {}

  describe(client: Tx, process: WorkflowProcessSnapshot): Promise<SubjectDescription> {
    return this.credit.describe(client, process);
  }

  async onFinalApproval(hook: WorkflowHookContext): Promise<FinalApprovalResult> {
    await this.credit.onFinalApproval(hook);
    return { outcome: 'APPLIED' };
  }

  onProcess(hook: WorkflowProcessHookContext): Promise<void> {
    return this.credit.onProcess(hook);
  }

  onDeclined(hook: WorkflowCommentHookContext): Promise<void> {
    return this.credit.onStatus(hook, 'LEAVE_IN_LIEU.DECLINED');
  }

  onCancelled(hook: WorkflowCancelHookContext): Promise<void> {
    return this.credit.onStatus(
      hook,
      hook.reason === 'WITHDRAWN' ? 'LEAVE_IN_LIEU.WITHDRAWN' : 'LEAVE_IN_LIEU.CANCELLED',
    );
  }

  onSentBack(hook: WorkflowCommentHookContext): Promise<void> {
    return this.credit.onStatus(hook, 'LEAVE_IN_LIEU.SENT_BACK');
  }

  async onResubmitted(hook: WorkflowResubmitHookContext): Promise<void> {
    if (hook.changes && Object.keys(hook.changes).length > 0) {
      throw ValidationError.field('changes', 'Withdraw this request and submit a new one to change it');
    }
    await this.credit.onStatus(hook, 'LEAVE_IN_LIEU.RESUBMITTED');
  }
}
