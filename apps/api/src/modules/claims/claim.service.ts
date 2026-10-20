import { Injectable } from '@nestjs/common';
import type { ClaimLine as ClaimLineRow, Prisma } from '@prisma/client';
import {
  addDays,
  BUSINESS_TIMEZONE,
  businessFromDate,
  CLAIM_EXPORT_COLUMNS,
  CLAIM_EXPORT_MAX_ROWS,
  CLAIM_PROBLEM_TYPES,
  type CancelClaimRequest,
  type ClaimDetail,
  type ClaimExportFormat,
  type ClaimLineAmount,
  type ClaimLineInput,
  type ClaimListSort,
  ClaimResubmitChangesSchema,
  type ClaimRow,
  type ClaimsExportQuery,
  type ClaimsQuery,
  type ClaimsResponse,
  claimStatusesFor,
  claimTotal,
  computeClaimLineAmount,
  type CreateClaimRequest,
  dateFromBusiness,
  dec,
  formatClaimReference,
  formatGridDate,
  money2,
  resolveClaimRate,
  type SavedClaimsQuery,
  type SavedClaimsResponse,
  sequenceKeys,
  type SubmitClaimRequest,
  todayBusinessDate,
  type UpdateClaimRequest,
  units4,
} from '@peoplehub/shared';
import { fromZonedTime } from 'date-fns-tz';
import ExcelJS from 'exceljs';
import { AuditService } from '../../audit/audit.service';
import {
  hasRole,
  isActingForOther,
  type SecurityContext,
  SYSTEM_USER_ID,
} from '../../common/context/security-context';
import {
  assertVersion,
  ConflictError,
  DomainError,
  type FieldError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { AttachmentService, toAttachmentDto } from '../attachments/attachment.service';
import { ScopeService } from '../auth/scope.service';
import { WorkflowPeopleService } from '../workflow/people.service';
import { PROCESS_INCLUDE } from '../workflow/process-shape';
import { WorkflowAccessService } from '../workflow/workflow-access.service';
import { WorkflowEngine } from '../workflow/workflow-engine.service';
import { WorkflowHistoryService } from '../workflow/workflow-history.service';
import { assertCanReadClaims, canReadClaims } from './claim-access';
import { type CapCheckResult, ClaimBalanceService } from './claim-balance.service';
import {
  ACTIONED_WORKFLOW_ACTIONS,
  CLAIM_DETAIL_INCLUDE,
  CLAIM_ENTITY,
  CLAIM_LINE_ENTITY,
  CLAIM_ROW_INCLUDE,
  type ClaimEmployee,
  type ClaimRowSource,
  type ClaimWorkflowType,
  LIVE_LINES,
} from './claim-constants';
import { claimCancelAction, parseWarnings, toClaimLine, toClaimRow } from './claim-mapper';
import { type ApplicableType, ClaimSetupService } from './claim-setup.service';
import { ClaimWriter } from './claim.writer';

/** Bursts of submits queue for a connection rather than fail (as leave, see ASSUMPTIONS). */
const SUBMIT_TX = { maxWaitMs: 60_000, timeoutMs: 60_000 };

type LineWithType = Prisma.ClaimLineGetPayload<{ include: { claimType: true } }>;

/** What submitting would do now: field problems, attachment problems and the cap check. */
interface Readiness {
  problems: FieldError[];
  attachmentProblems: FieldError[];
  caps: CapCheckResult;
  /** The amount each line gets with today's rates, by line id. */
  computed: Map<number, ClaimLineAmount>;
}

const ORDER_BY: Record<ClaimListSort, Prisma.ClaimOrderByWithRelationInput[]> = {
  'submittedAt:desc': [
    { submittedAt: { sort: 'desc', nulls: 'first' } },
    { createdAt: 'desc' },
    { id: 'desc' },
  ],
  'submittedAt:asc': [{ submittedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
  'createdAt:desc': [{ createdAt: 'desc' }, { id: 'desc' }],
  'createdAt:asc': [{ createdAt: 'asc' }, { id: 'asc' }],
  'total:desc': [{ totalAmount: 'desc' }, { id: 'desc' }],
  'total:asc': [{ totalAmount: 'asc' }, { id: 'asc' }],
  'reference:asc': [{ referenceNumber: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
  'reference:desc': [{ referenceNumber: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
  'applicant:asc': [{ employee: { lastName: 'asc' } }, { employee: { firstName: 'asc' } }, { id: 'desc' }],
  'applicant:desc': [{ employee: { lastName: 'desc' } }, { employee: { firstName: 'desc' } }, { id: 'desc' }],
};

function notEditable(detail: string): DomainError {
  return new DomainError(409, 'Conflict', detail, undefined, CLAIM_PROBLEM_TYPES.notEditable);
}

function notEligible(detail: string): DomainError {
  return new DomainError(
    422,
    'Validation failed',
    detail,
    [{ path: 'groupId', message: detail }],
    CLAIM_PROBLEM_TYPES.notEligible,
  );
}

function startOfBusinessDay(date: string): Date {
  return fromZonedTime(`${date}T00:00:00`, BUSINESS_TIMEZONE);
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * Claims (section 5.3): drafts ("Saved") with their lines, submit (reference number, caps,
 * mandatory attachments, the GROUPEDCLAIM or CLAIMS workflow), cancel, My Expense Claims and its
 * export, the Saved Claims list and the claim detail. The server computes every line amount and
 * the total. Workflow hooks live in ClaimWorkflowService.
 */
@Injectable()
export class ClaimService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly setup: ClaimSetupService,
    private readonly balances: ClaimBalanceService,
    private readonly engine: WorkflowEngine,
    private readonly history: WorkflowHistoryService,
    private readonly access: WorkflowAccessService,
    private readonly people: WorkflowPeopleService,
    private readonly attachments: AttachmentService,
    private readonly writer: ClaimWriter,
  ) {}

  // ───────────── Drafts ─────────────

  /** POST /claims: a new draft for the employee (self or someone the caller may act for). */
  async create(ctx: SecurityContext, input: CreateClaimRequest): Promise<ClaimDetail> {
    const employeeId = input.employeeId ?? ctx.actingAsEmployeeId;
    const id = await this.db.tx(ctx, async (tx) => {
      await this.scope.assertCanAccessEmployee(ctx, employeeId, 'SELF_SERVICE', tx);
      const employee = await this.setup.loadEmployee(tx, employeeId);
      if (employee.status !== 'ACTIVE') {
        throw ValidationError.field('employeeId', 'Claims can only be saved for active employees');
      }
      const group = await tx.claimGroup.findUnique({ where: { id: input.groupId } });
      if (!group || !group.isActive) throw ValidationError.field('groupId', 'Choose a claim group');
      const applicable = await this.setup.applicableTypes(tx, employee.companyRuleId, group.id);
      if (!(await this.setup.canStartGroup(tx, employee, group.id, applicable))) {
        throw notEligible(`${group.description} cannot be claimed for this employee`);
      }
      const created = await tx.claim.create({
        data: {
          employeeId: employee.id,
          groupId: group.id,
          description: input.description || null,
          status: 'DRAFT',
          createdByUserId: ctx.userId,
        },
      });
      const lines = await this.writeLines(tx, ctx, created, employee, applicable, input.lines, 'lines');
      await this.attachments.bind(tx, ctx, input.attachmentIds, {
        entity: CLAIM_ENTITY,
        entityId: created.id,
        subjectEmployeeId: employee.id,
      });
      const after = await tx.claim.update({
        where: { id: created.id },
        data: { totalAmount: claimTotal(lines.written.map((l) => l.amount.toString())).toString() },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'CLAIM.SAVED',
        entityType: 'Claim',
        entityId: after.id,
        subjectEmployeeId: after.employeeId,
        after,
        metadata: {
          lines: lines.written.map((l) => this.lineAudit(l)),
          attachmentIds: [...input.attachmentIds, ...input.lines.flatMap((l) => l.attachmentIds)],
          onBehalf: ctx.selfEmployeeId !== employee.id,
        },
      });
      return after.id;
    });
    return this.detail(ctx, id);
  }

  /** PUT /claims/:id: replaces the draft's description and lines (version checked, 409). */
  async update(ctx: SecurityContext, id: number, input: UpdateClaimRequest): Promise<ClaimDetail> {
    await this.db.tx(ctx, async (tx) => {
      const claim = await this.lockDraft(tx, ctx, id);
      assertVersion(claim, input.version);
      const employee = await this.setup.loadEmployee(tx, claim.employeeId);
      const applicable = await this.setup.applicableTypes(tx, employee.companyRuleId, claim.groupId);
      const before = await tx.claimLine.findMany({ where: { claimId: id, ...LIVE_LINES.where } });
      await this.removeAttachments(tx, ctx, claim, input.removeAttachmentIds, 'removeAttachmentIds');
      const lines = await this.writeLines(tx, ctx, claim, employee, applicable, input.lines, 'lines');
      await this.attachments.bind(tx, ctx, input.attachmentIds, {
        entity: CLAIM_ENTITY,
        entityId: claim.id,
        subjectEmployeeId: claim.employeeId,
      });
      await this.writer.update(
        tx,
        ctx,
        id,
        {
          ...(input.description !== undefined ? { description: input.description || null } : {}),
          totalAmount: claimTotal(lines.written.map((l) => l.amount.toString())).toString(),
        },
        {
          category: 'DATA_CHANGE',
          action: 'CLAIM.UPDATED',
          metadata: {
            previousLines: before.map((l) => this.lineAudit(l)),
            lines: lines.written.map((l) => this.lineAudit(l)),
            removedLineIds: lines.removedLineIds,
            attachmentIds: [...input.attachmentIds, ...input.lines.flatMap((l) => l.attachmentIds)],
            removedAttachmentIds: input.removeAttachmentIds,
          },
        },
      );
    });
    return this.detail(ctx, id);
  }

  /**
   * POST /claims/:id/submit (section 5.3.1), one transaction: every line is recomputed with
   * today's rates, the mandatory attachments and the caps are checked (BLOCK = 422, WARN =
   * stored on the claim), the reference number is allocated and the GROUPEDCLAIM workflow (or
   * CLAIMS for a claim of a single claim type) starts.
   */
  async submit(ctx: SecurityContext, id: number, input: SubmitClaimRequest): Promise<ClaimDetail> {
    await this.db.tx(
      ctx,
      async (tx) => {
        const claim = await this.lockDraft(tx, ctx, id);
        assertVersion(claim, input.version);
        // Serialise one employee's submits, so two claims cannot both use the same cap headroom.
        await this.db.lockRow(tx, 'Employee', claim.employeeId);
        const employee = await this.setup.loadEmployee(tx, claim.employeeId);
        if (employee.status !== 'ACTIVE') {
          throw ValidationError.field('employeeId', 'Claims can only be submitted for active employees');
        }
        const group = await tx.claimGroup.findUniqueOrThrow({ where: { id: claim.groupId } });
        const applicable = await this.setup.applicableTypes(tx, employee.companyRuleId, claim.groupId);
        const lines = await tx.claimLine.findMany({
          where: { claimId: id, ...LIVE_LINES.where },
          orderBy: LIVE_LINES.orderBy,
          include: { claimType: true },
        });
        const ready = await this.readiness(tx, claim, group, employee, applicable, lines);
        this.assertReady(ready);

        const discriminator = String(claim.groupId);
        const workflowType = await this.workflowTypeFor(tx, employee, lines, discriminator);
        await this.applyComputed(tx, lines, ready.computed);
        const total = claimTotal([...ready.computed.values()].map((c) => c.amount));
        const seq = await this.db.nextSequence(tx, sequenceKeys.claim(employee.id, claim.groupId));
        const referenceNumber = formatClaimReference(employee.entityCode, claim.groupId, seq);
        const now = new Date();
        await tx.claim.update({
          where: { id },
          data: {
            referenceNumber,
            totalAmount: total.toString(),
            warnings: asJson(ready.caps.warnings),
            status: 'IN_PROGRESS',
            submittedAt: now,
            version: { increment: 1 },
          },
        });
        const process = await this.engine.start(ctx, {
          type: workflowType,
          subjectEntity: CLAIM_ENTITY,
          subjectEntityId: id,
          subjectEmployeeId: employee.id,
          summary: `${group.description} ${referenceNumber} (${employee.company.currency} ${money2(total)})`,
          discriminator,
          comment: null,
        });
        const after = await tx.claim.update({ where: { id }, data: { processId: process.id } });
        this.audit.record(tx, ctx, {
          category: 'WORKFLOW',
          action: 'CLAIM.SUBMITTED',
          entityType: 'Claim',
          entityId: id,
          subjectEmployeeId: employee.id,
          before: claim,
          after,
          metadata: {
            referenceNumber,
            processId: process.id,
            workflowType,
            total: money2(total),
            lines: lines.map((l) => ({
              ...this.lineAudit(l),
              amount: money2(ready.computed.get(l.id)?.amount ?? 0),
            })),
            warnings: ready.caps.warnings,
            onBehalf: ctx.selfEmployeeId !== employee.id,
          },
        });
      },
      SUBMIT_TX,
    );
    return this.detail(ctx, id);
  }

  /**
   * POST /claims/:id/cancel (ASSUMPTION, see docs): discards a draft; withdraws a request nobody
   * has acted on yet (or one sent back); once an approver has acted, or while it waits for
   * processing, HR (write) or Payroll of the employee's company cancel it with a reason.
   */
  async cancel(ctx: SecurityContext, id: number, input: CancelClaimRequest): Promise<ClaimDetail> {
    const comment = input.comment?.trim() || null;
    await this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'Claim', id);
      const claim = await tx.claim.findUnique({ where: { id }, include: { process: true } });
      if (!claim) throw new NotFoundError('Claim');
      const canAct = await this.scope.canActFor(ctx, claim.employeeId, tx);
      const isAdmin = await this.scope.canAccessAny(ctx, claim.employeeId, ['HR_WRITE', 'PAYROLL'], tx);
      if (!canAct && !isAdmin) {
        throw new ForbiddenError('You cannot cancel this claim', {
          subjectEmployeeId: claim.employeeId,
          metadata: { claimId: id },
        });
      }
      assertVersion(claim, input.version);
      const actioned =
        claim.processId !== null &&
        (await this.actionedProcessIds(tx, [claim.processId])).has(claim.processId);
      const action = claimCancelAction({ status: claim.status, actioned, canAct, isAdmin });
      if (action === null) {
        throw new ConflictError(
          claim.status === 'IN_PROGRESS' || claim.status === 'APPROVED_PENDING_PROCESS'
            ? 'An approver has already acted on this claim; only HR or Payroll can cancel it now'
            : 'This claim can no longer be cancelled',
        );
      }
      if (action === 'DISCARD') {
        await this.writer.update(
          tx,
          ctx,
          id,
          { status: 'CANCELLED' },
          { category: 'DATA_CHANGE', action: 'CLAIM.DISCARDED', reason: comment },
        );
        return;
      }
      if (!claim.process) throw new ConflictError('This claim has no workflow to cancel');
      if (action === 'WITHDRAW' && this.access.isApplicant(ctx, claim.process)) {
        await this.engine.withdraw(ctx, claim.process.id, claim.process.version, comment);
        return;
      }
      if (action === 'CANCEL' && !comment) {
        throw ValidationError.field('comment', 'Give a reason for cancelling this claim');
      }
      await this.engine.cancel(ctx, claim.process.id, { comment, expectedVersion: claim.process.version });
    });
    return this.detail(ctx, id);
  }

  /**
   * Applies the applicant's edits when a sent-back claim is resubmitted (ClaimWorkflowService):
   * the lines and attachments as in PUT, then the submit checks again (BLOCK = 422; WARN
   * warnings replace the stored ones). The workflow type stays the one chosen on first submit.
   */
  async resubmit(
    tx: Tx,
    ctx: SecurityContext,
    claimId: number,
    rawChanges: Record<string, unknown> | undefined,
  ): Promise<void> {
    const parsed = ClaimResubmitChangesSchema.safeParse(rawChanges ?? {});
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => ({ path: ['changes', ...i.path].join('.'), message: i.message })),
      );
    }
    const changes = parsed.data;
    const claim = await tx.claim.findUniqueOrThrow({ where: { id: claimId } });
    await this.db.lockRow(tx, 'Employee', claim.employeeId);
    const employee = await this.setup.loadEmployee(tx, claim.employeeId);
    const group = await tx.claimGroup.findUniqueOrThrow({ where: { id: claim.groupId } });
    const applicable = await this.setup.applicableTypes(tx, employee.companyRuleId, claim.groupId);
    const metadata: Record<string, unknown> = { changes: Object.keys(changes) };
    if (changes.removeAttachmentIds?.length) {
      await this.removeAttachments(
        tx,
        ctx,
        claim,
        changes.removeAttachmentIds,
        'changes.removeAttachmentIds',
      );
    }
    if (changes.lines) {
      const before = await tx.claimLine.findMany({ where: { claimId, ...LIVE_LINES.where } });
      const result = await this.writeLines(
        tx,
        ctx,
        claim,
        employee,
        applicable,
        changes.lines,
        'changes.lines',
      );
      metadata.previousLines = before.map((l) => this.lineAudit(l));
      metadata.removedLineIds = result.removedLineIds;
    }
    if (changes.attachmentIds?.length) {
      await this.attachments.bind(
        tx,
        ctx,
        changes.attachmentIds,
        { entity: CLAIM_ENTITY, entityId: claimId, subjectEmployeeId: claim.employeeId },
        'changes.attachmentIds',
      );
    }
    const lines = await tx.claimLine.findMany({
      where: { claimId, ...LIVE_LINES.where },
      orderBy: LIVE_LINES.orderBy,
      include: { claimType: true },
    });
    const ready = await this.readiness(tx, claim, group, employee, applicable, lines);
    this.assertReady(ready);
    await this.applyComputed(tx, lines, ready.computed);
    const total = claimTotal([...ready.computed.values()].map((c) => c.amount));
    metadata.lines = lines.map((l) => ({
      ...this.lineAudit(l),
      amount: money2(ready.computed.get(l.id)?.amount ?? 0),
    }));
    metadata.warnings = ready.caps.warnings;
    await this.writer.update(
      tx,
      ctx,
      claimId,
      {
        status: 'IN_PROGRESS',
        totalAmount: total.toString(),
        warnings: asJson(ready.caps.warnings),
        ...(changes.description !== undefined ? { description: changes.description || null } : {}),
      },
      { action: 'CLAIM.RESUBMITTED', metadata },
    );
  }

  // ───────────── Lines ─────────────

  /** The line amount with the type's current rate for the employee (section 5.3.1). */
  private compute(
    type: ApplicableType['type'],
    employee: ClaimEmployee,
    input: {
      quantity?: string | null;
      amount?: string | null;
      startTime?: string | null;
      endTime?: string | null;
    },
  ): ClaimLineAmount {
    const rate = resolveClaimRate({
      inputMode: type.inputMode,
      rate: type.rate?.toString() ?? null,
      rateMultiplier: type.rateMultiplier?.toString() ?? null,
      hourlyRate: employee.hourlyRate?.toString() ?? null,
    });
    return computeClaimLineAmount({
      inputMode: type.inputMode,
      quantity: input.quantity ?? null,
      amount: input.amount ?? null,
      rate: rate?.rate ?? null,
      startTime: type.inputMode === 'HOURS' ? (input.startTime ?? null) : null,
      endTime: type.inputMode === 'HOURS' ? (input.endTime ?? null) : null,
    });
  }

  /**
   * Writes the lines grid of a draft: lines with an `id` are updated, new ones created, and lines
   * left out are removed (soft delete, with their attachments). Every amount is computed here.
   * A draft may hold incomplete lines (amount 0); submit refuses them.
   */
  private async writeLines(
    tx: Tx,
    ctx: SecurityContext,
    claim: { id: number; employeeId: number },
    employee: ClaimEmployee,
    applicable: ApplicableType[],
    inputs: ClaimLineInput[],
    path: string,
  ): Promise<{ written: ClaimLineRow[]; removedLineIds: number[] }> {
    const existing = await tx.claimLine.findMany({ where: { claimId: claim.id, ...LIVE_LINES.where } });
    const byId = new Map(existing.map((l) => [l.id, l]));
    const types = new Map(applicable.map((t) => [t.type.id, t.type]));
    const errors: FieldError[] = [];
    inputs.forEach((input, i) => {
      if (input.id !== undefined && !byId.has(input.id)) {
        errors.push({ path: `${path}.${i}.id`, message: 'This line is not part of the claim' });
      }
      const type = types.get(input.claimTypeId);
      if (!type) {
        errors.push({ path: `${path}.${i}.claimTypeId`, message: 'Choose a claim type of this group' });
      } else if (type.inputMode !== 'HOURS' && (input.startTime || input.endTime)) {
        errors.push({
          path: `${path}.${i}.startTime`,
          message: 'Start and end times are only entered for hours',
        });
      }
    });
    if (errors.length > 0) throw new ValidationError(errors);

    const written: ClaimLineRow[] = [];
    const kept = new Set<number>();
    for (const [i, input] of inputs.entries()) {
      const type = types.get(input.claimTypeId);
      if (!type) continue;
      const computed = this.compute(type, employee, input);
      const usesTimes = type.inputMode === 'HOURS' && Boolean(input.startTime && input.endTime);
      const data = {
        claimTypeId: type.id,
        date: dateFromBusiness(input.date),
        startTime: usesTimes ? (input.startTime ?? null) : null,
        endTime: usesTimes ? (input.endTime ?? null) : null,
        quantity: computed.quantity?.toString() ?? null,
        rate: computed.rate?.toString() ?? null,
        amount: computed.amount.toString(),
        description: input.description || null,
        sortOrder: i,
      };
      const line =
        input.id !== undefined
          ? await tx.claimLine.update({ where: { id: input.id }, data })
          : await tx.claimLine.create({ data: { ...data, claimId: claim.id } });
      kept.add(line.id);
      await this.attachments.bind(
        tx,
        ctx,
        input.attachmentIds,
        { entity: CLAIM_LINE_ENTITY, entityId: line.id, subjectEmployeeId: claim.employeeId },
        `${path}.${i}.attachmentIds`,
      );
      written.push(line);
    }
    const removed = existing.filter((l) => !kept.has(l.id));
    if (removed.length > 0) {
      const now = new Date();
      for (const line of removed) {
        await tx.claimLine.update({ where: { id: line.id }, data: { deletedAt: now } });
      }
      const orphaned = await tx.attachment.findMany({
        where: {
          ownerEntity: CLAIM_LINE_ENTITY,
          ownerEntityId: { in: removed.map((l) => String(l.id)) },
          deletedAt: null,
        },
        select: { id: true },
      });
      await this.attachments.detach(
        tx,
        ctx,
        orphaned.map((a) => a.id),
        removed.map((l) => ({ entity: CLAIM_LINE_ENTITY, entityId: l.id })),
        claim.employeeId,
        `${path}.removed`,
      );
    }
    return { written, removedLineIds: removed.map((l) => l.id) };
  }

  /** Removes attachments of the claim or its live lines. */
  private async removeAttachments(
    tx: Tx,
    ctx: SecurityContext,
    claim: { id: number; employeeId: number },
    ids: string[],
    path: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    const lines = await tx.claimLine.findMany({
      where: { claimId: claim.id, ...LIVE_LINES.where },
      select: { id: true },
    });
    await this.attachments.detach(
      tx,
      ctx,
      ids,
      [
        { entity: CLAIM_ENTITY, entityId: claim.id },
        ...lines.map((l) => ({ entity: CLAIM_LINE_ENTITY, entityId: l.id })),
      ],
      claim.employeeId,
      path,
    );
  }

  /** Stores the recomputed amounts and rates of lines whose figures changed. */
  private async applyComputed(tx: Tx, lines: ClaimLineRow[], computed: Map<number, ClaimLineAmount>) {
    for (const line of lines) {
      const c = computed.get(line.id);
      if (!c) continue;
      const rate = c.rate?.toString() ?? null;
      const quantity = c.quantity?.toString() ?? null;
      const same =
        dec(line.amount.toString()).eq(c.amount) &&
        (line.rate === null ? rate === null : rate !== null && dec(line.rate.toString()).eq(rate)) &&
        (line.quantity === null
          ? quantity === null
          : quantity !== null && dec(line.quantity.toString()).eq(quantity));
      if (same) continue;
      await tx.claimLine.update({
        where: { id: line.id },
        data: { amount: c.amount.toString(), rate, quantity },
      });
    }
  }

  private lineAudit(line: ClaimLineRow): Record<string, unknown> {
    return {
      id: line.id,
      claimTypeId: line.claimTypeId,
      date: businessFromDate(line.date),
      startTime: line.startTime,
      endTime: line.endTime,
      quantity: line.quantity === null ? null : units4(line.quantity),
      rate: line.rate === null ? null : units4(line.rate),
      amount: money2(line.amount),
      description: line.description,
    };
  }

  // ───────────── Submit checks ─────────────

  /**
   * Everything submit checks, without writing: at least one line; each line's type still
   * applies, its date is not in the future and within employment, and it is complete with
   * today's rate; the group's and the types' mandatory attachments; the caps.
   */
  private async readiness(
    client: Tx,
    claim: { id: number },
    group: { description: string; attachmentMandatory: boolean },
    employee: ClaimEmployee,
    applicable: ApplicableType[],
    lines: LineWithType[],
  ): Promise<Readiness> {
    const problems: FieldError[] = [];
    const attachmentProblems: FieldError[] = [];
    const computed = new Map<number, ClaimLineAmount>();
    const types = new Map(applicable.map((t) => [t.type.id, t.type]));
    const today = todayBusinessDate();
    const engaged = employee.dateEngaged ? businessFromDate(employee.dateEngaged) : null;
    const terminated = employee.terminationDate ? businessFromDate(employee.terminationDate) : null;
    if (lines.length === 0) problems.push({ path: 'lines', message: 'Add at least one claim line' });

    const attachmentCounts = await client.attachment.groupBy({
      by: ['ownerEntity', 'ownerEntityId'],
      where: {
        deletedAt: null,
        OR: [
          { ownerEntity: CLAIM_ENTITY, ownerEntityId: String(claim.id) },
          { ownerEntity: CLAIM_LINE_ENTITY, ownerEntityId: { in: lines.map((l) => String(l.id)) } },
        ],
      },
      _count: true,
    });
    const countFor = (entity: string, id: number) =>
      attachmentCounts.find((a) => a.ownerEntity === entity && a.ownerEntityId === String(id))?._count ?? 0;

    lines.forEach((line, i) => {
      const at = `lines.${i}`;
      const date = businessFromDate(line.date);
      const type = types.get(line.claimTypeId);
      if (!type) {
        problems.push({
          path: `${at}.claimTypeId`,
          message: `${line.claimType.description} can no longer be claimed`,
        });
        return;
      }
      if (date > today)
        problems.push({ path: `${at}.date`, message: 'A claim line cannot be dated in the future' });
      else if ((engaged && date < engaged) || (terminated && date > terminated)) {
        problems.push({ path: `${at}.date`, message: 'The date is outside the period of employment' });
      }
      const c = this.compute(type, employee, {
        quantity: line.quantity?.toString() ?? null,
        amount: line.amount.toString(),
        startTime: line.startTime,
        endTime: line.endTime,
      });
      computed.set(line.id, c);
      for (const p of c.problems) {
        if (p === 'QUANTITY_REQUIRED') {
          problems.push({
            path: `${at}.quantity`,
            message: `Enter the ${type.inputMode === 'HOURS' ? 'hours' : type.inputMode === 'KILOMETRES' ? 'kilometres' : 'quantity'}`,
          });
        } else if (p === 'RATE_MISSING') {
          problems.push({ path: `${at}.claimTypeId`, message: `No rate is set up for ${type.description}` });
        } else {
          problems.push({ path: `${at}.amount`, message: 'Enter an amount greater than 0' });
        }
      }
      if (type.requiresAttachment && countFor(CLAIM_LINE_ENTITY, line.id) === 0) {
        attachmentProblems.push({
          path: `${at}.attachmentIds`,
          message: `${type.description} needs a supporting document on the line`,
        });
      }
    });
    if (group.attachmentMandatory) {
      const total = attachmentCounts.reduce((sum, a) => sum + a._count, 0);
      if (total === 0) {
        attachmentProblems.push({
          path: 'attachmentIds',
          message: `${group.description} need a supporting document`,
        });
      }
    }
    const caps = await this.balances.check(
      client,
      employee,
      applicable,
      lines
        .filter((l) => types.has(l.claimTypeId))
        .map((l) => {
          const c = computed.get(l.id);
          return {
            index: lines.indexOf(l),
            lineId: l.id,
            claimTypeId: l.claimTypeId,
            date: businessFromDate(l.date),
            amount: c?.amount ?? dec(l.amount.toString()),
            quantity: c?.quantity ?? null,
          };
        }),
      claim.id,
    );
    return { problems, attachmentProblems, caps, computed };
  }

  private assertReady(ready: Readiness): void {
    if (ready.problems.length > 0) throw new ValidationError(ready.problems);
    if (ready.attachmentProblems.length > 0) {
      throw new DomainError(
        422,
        'Validation failed',
        ready.attachmentProblems[0]?.message,
        ready.attachmentProblems,
        CLAIM_PROBLEM_TYPES.attachmentRequired,
      );
    }
    if (ready.caps.errors.length > 0) {
      const error = new DomainError(
        422,
        'Validation failed',
        ready.caps.errors[0]?.message,
        ready.caps.errors,
        CLAIM_PROBLEM_TYPES.capExceeded,
      );
      // ClaimCapProblem: the BLOCK findings with their lineIndex / lineId.
      error.extensions = { findings: ready.caps.blocks };
      throw error;
    }
  }

  /**
   * GROUPEDCLAIM, or CLAIMS for a claim whose lines are all of one claim type when a CLAIMS
   * definition applies (ASSUMPTION, see docs). The group id is the discriminator of both.
   */
  private async workflowTypeFor(
    tx: Tx,
    employee: ClaimEmployee,
    lines: { claimTypeId: number }[],
    discriminator: string,
  ): Promise<ClaimWorkflowType> {
    const single = new Set(lines.map((l) => l.claimTypeId)).size === 1;
    if (single && (await this.engine.canStartFor(employee.id, 'CLAIMS', discriminator, tx))) return 'CLAIMS';
    if (!(await this.engine.canStartFor(employee.id, 'GROUPEDCLAIM', discriminator, tx))) {
      throw notEligible('No approval workflow is set up for this claim group');
    }
    return 'GROUPEDCLAIM';
  }

  /** Locks a draft the caller may edit (404, 403 audited, 409 when it is not a draft any more). */
  private async lockDraft(tx: Tx, ctx: SecurityContext, id: number) {
    await this.db.lockRow(tx, 'Claim', id);
    const claim = await tx.claim.findUnique({ where: { id } });
    if (!claim) throw new NotFoundError('Claim');
    if (!(await this.scope.canActFor(ctx, claim.employeeId, tx))) {
      throw new ForbiddenError('You cannot change this claim', {
        subjectEmployeeId: claim.employeeId,
        metadata: { claimId: id },
      });
    }
    if (claim.status !== 'DRAFT') throw notEditable('Only a saved claim can be changed or submitted');
    return claim;
  }

  // ───────────── Reads ─────────────

  /** GET /claims (section 5.3.2) with the status buckets, paginated. */
  async list(ctx: SecurityContext, query: ClaimsQuery): Promise<ClaimsResponse> {
    const where = await this.listWhere(ctx, query);
    const prisma = this.db.prisma;
    const [rows, total] = await Promise.all([
      prisma.claim.findMany({
        where,
        include: CLAIM_ROW_INCLUDE,
        orderBy: ORDER_BY[query.sort],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.claim.count({ where }),
    ]);
    return { items: await this.toRows(ctx, prisma, rows), total, page: query.page, pageSize: query.pageSize };
  }

  /** GET /claims/saved: drafts to resume, with Filter and Sort by (Applicant, Type, Date Created). */
  async saved(ctx: SecurityContext, query: SavedClaimsQuery): Promise<SavedClaimsResponse> {
    const target = query.employeeId ?? ctx.actingAsEmployeeId;
    if (query.employeeId !== undefined) {
      await this.scope.assertCanAccessEmployee(ctx, query.employeeId, 'SELF_SERVICE');
    }
    const mine: Prisma.ClaimWhereInput[] = [{ employeeId: target }];
    if (query.employeeId === undefined && !isActingForOther(ctx)) mine.push({ createdByUserId: ctx.userId });
    const and: Prisma.ClaimWhereInput[] = [{ status: 'DRAFT' }, { OR: mine }];
    if (query.groupId !== undefined) and.push({ groupId: query.groupId });
    if (query.filter) {
      const contains = { contains: query.filter, mode: 'insensitive' as const };
      and.push({
        OR: [
          { employee: { firstName: contains } },
          { employee: { lastName: contains } },
          { employee: { employeeCode: contains } },
          { group: { description: contains } },
          { description: contains },
        ],
      });
    }
    const order = query.order ?? (query.sort === 'dateCreated' ? 'desc' : 'asc');
    const orderBy: Prisma.ClaimOrderByWithRelationInput[] =
      query.sort === 'applicant'
        ? [{ employee: { lastName: order } }, { employee: { firstName: order } }, { createdAt: 'desc' }]
        : query.sort === 'type'
          ? [{ group: { description: order } }, { createdAt: 'desc' }]
          : [{ createdAt: order }];
    orderBy.push({ id: order });
    const where: Prisma.ClaimWhereInput = { AND: and };
    const prisma = this.db.prisma;
    const [rows, total] = await Promise.all([
      prisma.claim.findMany({
        where,
        include: CLAIM_ROW_INCLUDE,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.claim.count({ where }),
    ]);
    return { items: await this.toRows(ctx, prisma, rows), total, page: query.page, pageSize: query.pageSize };
  }

  /** GET /claims/:id: the claim with its lines, attachments and approval history. */
  async detail(ctx: SecurityContext, id: number): Promise<ClaimDetail> {
    const prisma = this.db.prisma;
    const claim = await prisma.claim.findUnique({ where: { id }, include: CLAIM_DETAIL_INCLUDE });
    if (!claim) throw new NotFoundError('Claim');
    const allowed =
      (await canReadClaims(this.scope, ctx, claim.employeeId)) ||
      (claim.process !== null &&
        (await this.access.canRead(prisma, ctx, {
          id: claim.process.id,
          subjectEmployeeId: claim.process.subjectEmployeeId,
          submittedByUserId: claim.process.submittedByUserId,
          companyId: claim.employee.companyId,
        })));
    if (!allowed) {
      throw new ForbiddenError('You do not have access to this claim', {
        subjectEmployeeId: claim.employeeId,
        metadata: { claimId: id },
      });
    }
    const [row] = await this.toRows(ctx, prisma, [claim]);
    if (!row) throw new NotFoundError('Claim');
    const attachments = await prisma.attachment.findMany({
      where: {
        deletedAt: null,
        OR: [
          { ownerEntity: CLAIM_ENTITY, ownerEntityId: String(id) },
          { ownerEntity: CLAIM_LINE_ENTITY, ownerEntityId: { in: claim.lines.map((l) => String(l.id)) } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    const dto = toAttachmentDto;
    let capCheck: ClaimDetail['capCheck'] = null;
    let submitProblems: ClaimDetail['submitProblems'] = [];
    if (claim.status === 'DRAFT' || claim.status === 'RESUBMIT_REQUIRED') {
      const employee = await this.setup.loadEmployee(prisma, claim.employeeId);
      const applicable = await this.setup.applicableTypes(prisma, employee.companyRuleId, claim.groupId);
      const ready = await this.readiness(prisma, claim, claim.group, employee, applicable, claim.lines);
      capCheck = { warnings: ready.caps.warnings, blocks: ready.caps.blocks };
      submitProblems = [...ready.problems, ...ready.attachmentProblems];
    }
    return {
      ...row,
      attachmentMandatory: claim.group.attachmentMandatory,
      lines: claim.lines.map((l) =>
        toClaimLine(
          l,
          attachments
            .filter((a) => a.ownerEntity === CLAIM_LINE_ENTITY && a.ownerEntityId === String(l.id))
            .map(dto),
        ),
      ),
      attachments: attachments.filter((a) => a.ownerEntity === CLAIM_ENTITY).map(dto),
      warnings: parseWarnings(claim.warnings),
      capCheck,
      submitProblems,
      payPeriod: claim.payPeriod,
      canEdit: row.canResume,
      approvalHistory: claim.processId !== null ? await this.historyOf(claim.processId) : null,
      processVersion: claim.process?.version ?? null,
    };
  }

  /** GET /claims/export: the filtered My Expense Claims grid as CSV or Excel, audited. */
  async export(
    ctx: SecurityContext,
    query: ClaimsExportQuery,
  ): Promise<{ fileName: string; contentType: string; body: Buffer }> {
    const where = await this.listWhere(ctx, query);
    const prisma = this.db.prisma;
    const rows = await prisma.claim.findMany({
      where,
      include: CLAIM_ROW_INCLUDE,
      orderBy: ORDER_BY[query.sort],
      take: CLAIM_EXPORT_MAX_ROWS,
    });
    const items = await this.toRows(ctx, prisma, rows);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'PeopleHub';
    const sheet = workbook.addWorksheet('Expense claims');
    sheet.columns = CLAIM_EXPORT_COLUMNS.map((header) => ({
      header,
      key: header,
      width: header === 'Employee Name' || header === 'Description' ? 28 : 18,
    }));
    for (const r of items) {
      sheet.addRow([
        r.referenceNumber ?? '',
        r.employee.employeeCode,
        `${r.employee.firstName} ${r.employee.lastName}`,
        r.group.description,
        r.description ?? '',
        r.createdDate,
        r.submittedDate,
        r.totalAmount,
        r.currency,
        r.statusLabel,
        r.finalApprover ?? '',
        r.processedAt ? formatGridDate(r.processedAt.slice(0, 10)) : '',
      ]);
    }
    sheet.getRow(1).font = { bold: true };
    const format: ClaimExportFormat = query.format;
    const body =
      format === 'csv'
        ? Buffer.from(await workbook.csv.writeBuffer())
        : Buffer.from(await workbook.xlsx.writeBuffer());
    const { format: _format, ...filters } = query;
    await this.audit.recordStandalone(ctx, {
      category: 'EXPORT',
      action: 'EXPORT.CLAIMS',
      entityType: 'Claim',
      subjectEmployeeId: query.scope === 'self' ? (query.employeeId ?? ctx.actingAsEmployeeId) : null,
      metadata: {
        filters,
        format,
        rows: items.length,
        truncated: rows.length >= CLAIM_EXPORT_MAX_ROWS,
        claimIds: items.map((r) => r.id),
      },
    });
    const today = todayBusinessDate();
    return {
      fileName: `expense-claims-${today}.${format}`,
      contentType:
        format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body,
    };
  }

  /** The where clause of My Expense Claims for the caller's scope and filters. */
  private async listWhere(
    ctx: SecurityContext,
    query: Omit<ClaimsQuery, 'page' | 'pageSize'>,
  ): Promise<Prisma.ClaimWhereInput> {
    const and: Prisma.ClaimWhereInput[] = [
      // A discarded draft was never submitted; it does not appear in the list.
      { NOT: { status: 'CANCELLED', submittedAt: null } },
    ];
    switch (query.scope) {
      case 'self': {
        const employeeId = query.employeeId ?? ctx.actingAsEmployeeId;
        await assertCanReadClaims(this.scope, ctx, employeeId);
        and.push({ employeeId });
        break;
      }
      case 'reports': {
        if (!hasRole(ctx, 'MANAGER') || ctx.selfEmployeeId === null) {
          throw new ForbiddenError("Only managers can list their reports' claims", {
            metadata: { scope: 'reports' },
          });
        }
        const ids = await this.scope.reportIdsWithinDepth(ctx.selfEmployeeId);
        if (query.employeeId !== undefined && !ids.includes(query.employeeId)) {
          throw new ForbiddenError('This employee is not one of your reports', {
            subjectEmployeeId: query.employeeId,
            metadata: { scope: 'reports' },
          });
        }
        and.push({ employeeId: { in: query.employeeId !== undefined ? [query.employeeId] : ids } });
        break;
      }
      case 'company': {
        if (hasRole(ctx, 'AUDITOR')) {
          // Auditors read across all companies (read only).
        } else if (hasRole(ctx, 'HR_ADMIN', 'PAYROLL_ADMIN')) {
          and.push({ employee: { companyId: { in: ctx.companyIds } } });
        } else {
          throw new ForbiddenError('Only HR, Payroll and auditors can list claims by company', {
            metadata: { scope: 'company' },
          });
        }
        if (query.employeeId !== undefined) {
          await assertCanReadClaims(this.scope, ctx, query.employeeId);
          and.push({ employeeId: query.employeeId });
        }
        break;
      }
    }
    if (query.type !== undefined) and.push({ groupId: query.type });
    if (query.description) and.push({ description: { contains: query.description, mode: 'insensitive' } });
    const statuses = claimStatusesFor(query.status);
    if (statuses) and.push({ status: { in: statuses } });
    if (query.from || query.to) {
      const range: Prisma.DateTimeFilter = {};
      if (query.from) range.gte = startOfBusinessDay(query.from);
      if (query.to) range.lt = startOfBusinessDay(addDays(query.to, 1));
      and.push({ OR: [{ submittedAt: range }, { submittedAt: null, createdAt: range }] });
    }
    return { AND: and };
  }

  /** Rows with the final approver, Resume and Cancel worked out for the caller. */
  private async toRows(ctx: SecurityContext, client: Tx, claims: ClaimRowSource[]): Promise<ClaimRow[]> {
    const employeeIds = [...new Set(claims.map((c) => c.employeeId))];
    const rights = new Map<number, { canAct: boolean; isAdmin: boolean }>();
    for (const employeeId of employeeIds) {
      rights.set(employeeId, {
        canAct: await this.scope.canActFor(ctx, employeeId, client),
        isAdmin: await this.scope.canAccessAny(ctx, employeeId, ['HR_WRITE', 'PAYROLL'], client),
      });
    }
    const [persons, actioned] = await Promise.all([
      this.people.byIds(
        client,
        claims.map((c) => c.finalApproverUserId),
      ),
      this.actionedProcessIds(
        client,
        claims.map((c) => c.processId).filter((p): p is number => p !== null),
      ),
    ]);
    return claims.map((c) => {
      const r = rights.get(c.employeeId) ?? { canAct: false, isAdmin: false };
      return toClaimRow(c, {
        finalApprover: c.finalApproverUserId ? (persons.get(c.finalApproverUserId)?.name ?? null) : null,
        canResume: c.status === 'DRAFT' && r.canAct,
        cancelAction: claimCancelAction({
          status: c.status,
          actioned: c.processId !== null && actioned.has(c.processId),
          ...r,
        }),
      });
    });
  }

  /** Processes with an approver action (approve, decline, reassign, park, send back). */
  private async actionedProcessIds(client: Tx, processIds: number[]): Promise<Set<number>> {
    if (processIds.length === 0) return new Set();
    const rows = await client.workflowAction.groupBy({
      by: ['processId'],
      where: {
        processId: { in: processIds },
        action: { in: [...ACTIONED_WORKFLOW_ACTIONS] },
        actorUserId: { not: SYSTEM_USER_ID },
      },
      _count: true,
    });
    return new Set(rows.map((r) => r.processId));
  }

  private async historyOf(processId: number) {
    const p = await this.db.prisma.workflowProcess.findUniqueOrThrow({
      where: { id: processId },
      include: PROCESS_INCLUDE,
    });
    return this.history.build(this.db.prisma, p);
  }
}
