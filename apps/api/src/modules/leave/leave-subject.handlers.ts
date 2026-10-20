import { Injectable } from '@nestjs/common';
import {
  businessFromDate,
  type BusinessDate,
  DAY_PORTION_LABELS,
  type DayPortion,
  Decimal,
  dec,
  formatCardDate,
  formatTimestampDate,
  type InboxWarning,
  round4,
  todayBusinessDate,
  units4,
} from '@peoplehub/shared';
import type { SecurityContext } from '../../common/context/security-context';
import { ValidationError } from '../../common/errors/domain-errors';
import type { Tx } from '../../prisma/prisma-client';
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
import { LeaveApplicationWriter } from './leave-application.writer';
import { LEAVE_EMPLOYEE_SELECT, RESERVING_STATUSES } from './leave-constants';
import { leaveTypeLabel } from './leave-mapper';
import { availableFor, clampDate } from './leave-rules';
import { LeaveService } from './leave.service';

function applicationId(process: WorkflowProcessSnapshot): number {
  return Number(process.subjectEntityId);
}

function dateWithPortion(date: Date, portion: DayPortion): string {
  const text = formatCardDate(date);
  return portion === 'FULL' ? text : `${text} (${DAY_PORTION_LABELS[portion]})`;
}

/**
 * The inbox description of a leave application or a cancellation request (section 5.10): the
 * field list "Leave type, Reason for leave, Leave start date, Leave end date, I am taking, Date
 * submitted, Comments" and the "Days available" / "Days to be deducted" headline.
 */
async function describeApplication(
  client: Tx,
  process: WorkflowProcessSnapshot,
): Promise<SubjectDescription> {
  const app = await client.leaveApplication.findUniqueOrThrow({
    where: { id: applicationId(process) },
    include: {
      leaveType: true,
      leaveReason: { select: { description: true } },
      cancels: { select: { id: true, referenceNumber: true } },
    },
  });
  const units = units4(app.unitsTaken);
  const isCancellation = app.cancelsApplicationId !== null;
  const fields = [
    { label: 'Leave type', value: app.leaveType.description },
    ...(isCancellation && app.cancels
      ? [{ label: 'Leave to cancel', value: app.cancels.referenceNumber }]
      : []),
    { label: 'Reason for leave', value: app.leaveReason?.description ?? '' },
    { label: 'Leave start date', value: dateWithPortion(app.fromDate, app.startPortion) },
    { label: 'Leave end date', value: dateWithPortion(app.toDate, app.endPortion) },
    { label: isCancellation ? 'Days to be returned' : 'I am taking', value: `${units} Days` },
    { label: 'Date submitted', value: app.submittedAt ? formatTimestampDate(app.submittedAt) : '' },
    { label: 'Comments', value: app.comment ?? '' },
    { label: 'Reference number', value: app.referenceNumber },
  ];
  return {
    requestLabel: leaveTypeLabel(app),
    title: isCancellation ? 'Leave cancellation request' : 'Leave request',
    fromDate: businessFromDate(app.fromDate),
    toDate: businessFromDate(app.toDate),
    unitsLine: isCancellation ? `${units} Days to be returned` : `${units} Days to be deducted`,
    headline: isCancellation
      ? [{ label: 'Days to be returned', value: units }]
      : [
          { label: 'Days available', value: units4(app.availableAtSubmit ?? 0) },
          { label: 'Days to be deducted', value: units },
        ],
    fields,
    kind: 'LEAVE',
    data: {
      applicationId: app.id,
      referenceNumber: app.referenceNumber,
      leaveTypeId: app.leaveTypeId,
      leaveTypeCode: app.leaveType.code,
      colour: app.leaveType.colour,
      fromDate: businessFromDate(app.fromDate),
      toDate: businessFromDate(app.toDate),
      startPortion: app.startPortion,
      endPortion: app.endPortion,
      units,
      daysAvailable: app.availableAtSubmit === null ? null : units4(app.availableAtSubmit),
      noteSubmitted: app.noteSubmitted,
      isCancellation,
      cancelsApplicationId: app.cancels?.id ?? null,
      cancelsReferenceNumber: app.cancels?.referenceNumber ?? null,
    },
    viewLabel: isCancellation ? 'View leave cancellation' : 'View leave request',
  };
}

/** The ledger date of a posting into a pay period: the leave start, clamped into the period. */
function postingDate(fromDate: Date, period: { startDate: Date; endDate: Date }): BusinessDate {
  return clampDate(
    businessFromDate(fromDate),
    businessFromDate(period.startDate),
    businessFromDate(period.endDate),
  );
}

/**
 * LEAVE (section 7.3): keeps `LeaveApplication.status` in step with the process; final approval
 * records the approver; processing posts one TAKEN entry per allocation into the pay period;
 * decline, withdraw and cancel release the allocations.
 */
@Injectable()
export class LeaveSubjectHandler implements WorkflowSubjectHandler {
  readonly type = 'LEAVE' as const;

  constructor(
    private readonly writer: LeaveApplicationWriter,
    private readonly entitlements: EntitlementService,
    private readonly leave: LeaveService,
  ) {}

  describe(client: Tx, process: WorkflowProcessSnapshot): Promise<SubjectDescription> {
    return describeApplication(client, process);
  }

  /** "Approving takes the balance negative" (section 5.10); this request is already in Pending. */
  async warnings(client: Tx, process: WorkflowProcessSnapshot): Promise<InboxWarning[]> {
    const app = await client.leaveApplication.findUniqueOrThrow({
      where: { id: applicationId(process) },
      include: { leaveType: true, employee: { select: { firstName: true } } },
    });
    if (!RESERVING_STATUSES.includes(app.status)) return [];
    const buckets = await this.entitlements.buckets(app.employeeId, app.leaveTypeId, { client });
    const available = availableFor(buckets, businessFromDate(app.fromDate));
    if (available.gte(0)) return [];
    return [
      {
        code: 'NEGATIVE_BALANCE',
        message: `Approving this request takes ${app.employee.firstName}'s ${app.leaveType.description} balance to ${units4(available)} Days`,
      },
    ];
  }

  async onFinalApproval({ tx, ctx, process }: WorkflowHookContext): Promise<FinalApprovalResult> {
    await this.writer.update(
      tx,
      ctx,
      applicationId(process),
      { status: process.status, approvedAt: new Date(), finalApproverUserId: ctx.userId },
      { action: 'LEAVE.APPROVED' },
    );
    return { outcome: 'APPLIED' };
  }

  async onProcess({ tx, ctx, process, payPeriod, automatic }: WorkflowProcessHookContext): Promise<void> {
    const id = applicationId(process);
    const app = await tx.leaveApplication.findUniqueOrThrow({
      where: { id },
      include: { allocations: { where: { releasedAt: null }, orderBy: { id: 'asc' } } },
    });
    const effectiveDate = postingDate(app.fromDate, payPeriod);
    const posted: number[] = [];
    for (const allocation of app.allocations) {
      const entry = await this.entitlements.post(
        tx,
        ctx,
        {
          employeeId: app.employeeId,
          leaveTypeId: app.leaveTypeId,
          entitlementId: allocation.entitlementId,
          entryType: 'TAKEN',
          units: dec(allocation.units).negated(),
          effectiveDate,
          payPeriodId: payPeriod.id,
          leaveApplicationId: app.id,
          note: app.referenceNumber,
        },
        {
          action: 'LEAVE.TAKEN_POSTED',
          metadata: { referenceNumber: app.referenceNumber, payPeriodId: payPeriod.id, automatic },
        },
      );
      if (entry) posted.push(entry.id);
    }
    await this.writer.update(
      tx,
      ctx,
      id,
      { status: process.status, processedAt: new Date(), payPeriodId: payPeriod.id },
      {
        action: 'LEAVE.PROCESSED',
        metadata: { payPeriodId: payPeriod.id, ledgerEntryIds: posted, automatic },
      },
    );
  }

  async onDeclined({ tx, ctx, process, comment }: WorkflowCommentHookContext): Promise<void> {
    const id = applicationId(process);
    const released = await this.writer.releaseAllocations(tx, id);
    await this.writer.update(
      tx,
      ctx,
      id,
      { status: process.status },
      {
        action: 'LEAVE.DECLINED',
        reason: comment,
        metadata: { allocationsReleased: released },
      },
    );
  }

  async onCancelled({ tx, ctx, process, comment, reason }: WorkflowCancelHookContext): Promise<void> {
    const id = applicationId(process);
    const released = await this.writer.releaseAllocations(tx, id);
    await this.writer.update(
      tx,
      ctx,
      id,
      { status: process.status },
      {
        action: reason === 'WITHDRAWN' ? 'LEAVE.WITHDRAWN' : 'LEAVE.CANCELLED',
        reason: comment,
        metadata: { allocationsReleased: released },
      },
    );
  }

  async onSentBack({ tx, ctx, process, comment }: WorkflowCommentHookContext): Promise<void> {
    await this.writer.update(
      tx,
      ctx,
      applicationId(process),
      { status: process.status },
      {
        action: 'LEAVE.SENT_BACK',
        reason: comment,
      },
    );
  }

  async onResubmitted({ tx, ctx, process, changes }: WorkflowResubmitHookContext): Promise<void> {
    await this.leave.resubmit(tx, ctx, applicationId(process), changes);
  }
}

/**
 * CANCELLEAVE (section 5.2.3): a cancellation request for an application. On final approval an
 * original that was not processed yet is cancelled (its allocations are released); processing
 * a cancellation of a processed original posts CANCELLATION_REVERSAL entries that mirror its
 * TAKEN entries and sets the original to CANCELLED.
 */
@Injectable()
export class CancelLeaveHandler implements WorkflowSubjectHandler {
  readonly type = 'CANCELLEAVE' as const;

  constructor(
    private readonly writer: LeaveApplicationWriter,
    private readonly entitlements: EntitlementService,
    private readonly engine: WorkflowEngine,
  ) {}

  describe(client: Tx, process: WorkflowProcessSnapshot): Promise<SubjectDescription> {
    return describeApplication(client, process);
  }

  private async load(tx: Tx, process: WorkflowProcessSnapshot) {
    const cancellation = await tx.leaveApplication.findUniqueOrThrow({
      where: { id: applicationId(process) },
    });
    if (cancellation.cancelsApplicationId === null) {
      throw new Error(`Leave application ${cancellation.id} is not a cancellation request`);
    }
    return cancellation as typeof cancellation & { cancelsApplicationId: number };
  }

  async onFinalApproval({ tx, ctx, process }: WorkflowHookContext): Promise<FinalApprovalResult> {
    const cancellation = await this.load(tx, process);
    await this.writer.update(
      tx,
      ctx,
      cancellation.id,
      { status: process.status, approvedAt: new Date(), finalApproverUserId: ctx.userId },
      {
        action: 'LEAVE.CANCELLATION_APPROVED',
        metadata: { cancelsApplicationId: cancellation.cancelsApplicationId },
      },
    );
    const original = await tx.leaveApplication.findUniqueOrThrow({
      where: { id: cancellation.cancelsApplicationId },
    });
    if (RESERVING_STATUSES.includes(original.status) && original.processId !== null) {
      // Not processed yet: cancelling its workflow releases the reservation (LeaveSubjectHandler).
      await this.engine.cancel(ctx, original.processId, {
        comment: `Cancelled by leave cancellation ${cancellation.referenceNumber}`,
      });
    }
    return { outcome: 'APPLIED' };
  }

  async onProcess({ tx, ctx, process, payPeriod, automatic }: WorkflowProcessHookContext): Promise<void> {
    const cancellation = await this.load(tx, process);
    const original = await tx.leaveApplication.findUniqueOrThrow({
      where: { id: cancellation.cancelsApplicationId },
      include: {
        ledgerEntries: {
          where: { entryType: 'TAKEN' },
          include: { entitlement: true },
          orderBy: { id: 'asc' },
        },
        employee: { select: LEAVE_EMPLOYEE_SELECT },
      },
    });
    const reversed: number[] = [];
    if (original.status === 'PROCESSED') {
      // Mirror each TAKEN entry; a bucket closed since then is replaced by the current one.
      const byBucket = new Map<number, Decimal>();
      for (const taken of original.ledgerEntries) {
        const target = taken.entitlement.isClosed
          ? await this.currentBucket(tx, ctx, original.employee, original.leaveTypeId)
          : taken.entitlementId;
        byBucket.set(target, (byBucket.get(target) ?? new Decimal(0)).plus(dec(taken.units).negated()));
      }
      const effectiveDate = postingDate(cancellation.fromDate, payPeriod);
      for (const [entitlementId, units] of byBucket) {
        const entry = await this.entitlements.post(
          tx,
          ctx,
          {
            employeeId: original.employeeId,
            leaveTypeId: original.leaveTypeId,
            entitlementId,
            entryType: 'CANCELLATION_REVERSAL',
            units: round4(units),
            effectiveDate,
            payPeriodId: payPeriod.id,
            leaveApplicationId: original.id,
            note: `Cancelled by ${cancellation.referenceNumber}`,
          },
          {
            action: 'LEAVE.CANCELLATION_REVERSED',
            metadata: {
              cancellationId: cancellation.id,
              referenceNumber: original.referenceNumber,
              automatic,
            },
          },
        );
        if (entry) reversed.push(entry.id);
      }
      await this.writer.update(
        tx,
        ctx,
        original.id,
        { status: 'CANCELLED' },
        {
          action: 'LEAVE.CANCELLED',
          reason: `Cancelled by ${cancellation.referenceNumber}`,
          metadata: { cancellationId: cancellation.id, ledgerEntryIds: reversed },
        },
      );
    }
    await this.writer.update(
      tx,
      ctx,
      cancellation.id,
      { status: process.status, processedAt: new Date(), payPeriodId: payPeriod.id },
      {
        action: 'LEAVE.CANCELLATION_PROCESSED',
        metadata: {
          cancelsApplicationId: original.id,
          originalStatus: original.status,
          ledgerEntryIds: reversed,
          automatic,
        },
      },
    );
  }

  /** The open bucket of the type with the latest cycle end (opening the current cycle if needed). */
  private async currentBucket(
    tx: Tx,
    ctx: SecurityContext,
    employee: Parameters<EntitlementService['ensureCurrentBuckets']>[2],
    leaveTypeId: number,
  ): Promise<number> {
    await this.entitlements.ensureCurrentBuckets(tx, ctx, employee, todayBusinessDate(), leaveTypeId);
    const bucket = await tx.employeeLeaveEntitlement.findFirst({
      where: { employeeId: employee.id, leaveTypeId, isClosed: false },
      orderBy: [{ cycleEndDate: 'desc' }, { id: 'desc' }],
    });
    if (!bucket) throw new ValidationError('There is no open leave bucket to return the cancelled units to');
    return bucket.id;
  }

  async onDeclined({ tx, ctx, process, comment }: WorkflowCommentHookContext): Promise<void> {
    await this.writer.update(
      tx,
      ctx,
      applicationId(process),
      { status: process.status },
      {
        action: 'LEAVE.CANCELLATION_DECLINED',
        reason: comment,
      },
    );
  }

  async onCancelled({ tx, ctx, process, comment }: WorkflowCancelHookContext): Promise<void> {
    await this.writer.update(
      tx,
      ctx,
      applicationId(process),
      { status: process.status },
      {
        action: 'LEAVE.CANCELLATION_WITHDRAWN',
        reason: comment,
      },
    );
  }

  async onSentBack({ tx, ctx, process, comment }: WorkflowCommentHookContext): Promise<void> {
    await this.writer.update(
      tx,
      ctx,
      applicationId(process),
      { status: process.status },
      {
        action: 'LEAVE.SENT_BACK',
        reason: comment,
      },
    );
  }

  async onResubmitted({ tx, ctx, process, changes }: WorkflowResubmitHookContext): Promise<void> {
    if (changes && Object.keys(changes).length > 0) {
      throw ValidationError.field(
        'changes',
        'A leave cancellation request cannot be changed; withdraw it instead',
      );
    }
    await this.writer.update(
      tx,
      ctx,
      applicationId(process),
      { status: process.status },
      {
        action: 'LEAVE.RESUBMITTED',
      },
    );
  }
}
