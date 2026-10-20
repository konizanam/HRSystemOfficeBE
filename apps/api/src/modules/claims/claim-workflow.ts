import { Injectable } from '@nestjs/common';
import {
  businessFromDate,
  type ClaimSubjectData,
  formatTimestampDate,
  type InboxWarning,
  money2,
  units4,
} from '@peoplehub/shared';
import type { Tx } from '../../prisma/prisma-client';
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
import { CLAIM_LINE_ENTITY, type ClaimWorkflowType, LIVE_LINES } from './claim-constants';
import { parseWarnings } from './claim-mapper';
import { ClaimService } from './claim.service';
import { ClaimWriter } from './claim.writer';

function claimId(process: WorkflowProcessSnapshot): number {
  return Number(process.subjectEntityId);
}

/**
 * The workflow side of a claim (section 7.3), shared by GROUPEDCLAIM and CLAIMS: the inbox
 * description (group, description, lines and total), the stored cap warnings for approvers, and
 * the hooks that keep `Claim.status` in step with its process. Processing links the claim to the
 * pay period and sets it PROCESSED.
 */
@Injectable()
export class ClaimWorkflowService {
  constructor(
    private readonly writer: ClaimWriter,
    private readonly claims: ClaimService,
  ) {}

  async describe(client: Tx, process: WorkflowProcessSnapshot): Promise<SubjectDescription> {
    const claim = await client.claim.findUniqueOrThrow({
      where: { id: claimId(process) },
      include: {
        group: true,
        employee: { select: { company: { select: { currency: true } } } },
        lines: { ...LIVE_LINES, include: { claimType: true } },
      },
    });
    const currency = claim.employee.company.currency;
    const total = money2(claim.totalAmount);
    const dates = claim.lines.map((l) => businessFromDate(l.date)).sort();
    const warnings = parseWarnings(claim.warnings);
    const data: ClaimSubjectData = {
      claimId: claim.id,
      referenceNumber: claim.referenceNumber,
      group: { id: claim.group.id, code: claim.group.code, description: claim.group.description },
      description: claim.description,
      currency,
      totalAmount: total,
      lines: claim.lines.map((l) => ({
        id: l.id,
        sortOrder: l.sortOrder,
        claimType: {
          id: l.claimType.id,
          code: l.claimType.code,
          description: l.claimType.description,
          inputMode: l.claimType.inputMode,
        },
        date: businessFromDate(l.date),
        startTime: l.startTime,
        endTime: l.endTime,
        quantity: l.quantity === null ? null : units4(l.quantity),
        rate: l.rate === null ? null : units4(l.rate),
        amount: money2(l.amount),
        description: l.description,
      })),
      warnings,
    };
    return {
      requestLabel: claim.group.description,
      title: 'Expense claim',
      fromDate: dates[0] ?? null,
      toDate: dates[dates.length - 1] ?? null,
      unitsLine: `${currency} ${total} to be claimed`,
      headline: [{ label: 'Total', value: `${currency} ${total}` }],
      fields: [
        { label: 'Claim group', value: claim.group.description },
        { label: 'Description', value: claim.description ?? '' },
        { label: 'Reference number', value: claim.referenceNumber ?? '' },
        { label: 'Date submitted', value: claim.submittedAt ? formatTimestampDate(claim.submittedAt) : '' },
        { label: 'Lines', value: String(claim.lines.length) },
        { label: 'Total', value: `${currency} ${total}` },
      ],
      data,
      viewLabel: 'View claim',
      attachmentOwners: claim.lines.map((l) => ({ entity: CLAIM_LINE_ENTITY, entityId: String(l.id) })),
    };
  }

  /** The cap warnings stored on submit (WARN caps), shown above the approver buttons. */
  async warnings(client: Tx, process: WorkflowProcessSnapshot): Promise<InboxWarning[]> {
    const claim = await client.claim.findUniqueOrThrow({
      where: { id: claimId(process) },
      select: { warnings: true },
    });
    return parseWarnings(claim.warnings).map((w) => ({ code: 'CLAIM_CAP_EXCEEDED', message: w.message }));
  }

  async onFinalApproval({ tx, ctx, process }: WorkflowHookContext): Promise<void> {
    await this.writer.update(
      tx,
      ctx,
      claimId(process),
      { status: process.status, approvedAt: new Date(), finalApproverUserId: ctx.userId },
      { action: 'CLAIM.APPROVED', metadata: { workflowType: process.type } },
    );
  }

  async onProcess({ tx, ctx, process, payPeriod, automatic }: WorkflowProcessHookContext): Promise<void> {
    await this.writer.update(
      tx,
      ctx,
      claimId(process),
      { status: process.status, processedAt: new Date(), payPeriodId: payPeriod.id },
      {
        action: 'CLAIM.PROCESSED',
        metadata: { payPeriodId: payPeriod.id, payPeriod: payPeriod.description, automatic },
      },
    );
  }

  async onStatus(hook: WorkflowCommentHookContext, action: string): Promise<void> {
    await this.writer.update(
      hook.tx,
      hook.ctx,
      claimId(hook.process),
      { status: hook.process.status },
      { action, reason: hook.comment },
    );
  }

  async onResubmitted({ tx, ctx, process, changes }: WorkflowResubmitHookContext): Promise<void> {
    await this.claims.resubmit(tx, ctx, claimId(process), changes);
  }
}

/** The subject handler of GROUPEDCLAIM and of CLAIMS (one instance per type). */
export class ClaimSubjectHandler implements WorkflowSubjectHandler {
  constructor(
    readonly type: ClaimWorkflowType,
    private readonly claims: ClaimWorkflowService,
  ) {}

  describe(client: Tx, process: WorkflowProcessSnapshot): Promise<SubjectDescription> {
    return this.claims.describe(client, process);
  }

  warnings(client: Tx, process: WorkflowProcessSnapshot): Promise<InboxWarning[]> {
    return this.claims.warnings(client, process);
  }

  async onFinalApproval(hook: WorkflowHookContext): Promise<FinalApprovalResult> {
    await this.claims.onFinalApproval(hook);
    return { outcome: 'APPLIED' };
  }

  onProcess(hook: WorkflowProcessHookContext): Promise<void> {
    return this.claims.onProcess(hook);
  }

  onDeclined(hook: WorkflowCommentHookContext): Promise<void> {
    return this.claims.onStatus(hook, 'CLAIM.DECLINED');
  }

  onCancelled(hook: WorkflowCancelHookContext): Promise<void> {
    return this.claims.onStatus(hook, hook.reason === 'WITHDRAWN' ? 'CLAIM.WITHDRAWN' : 'CLAIM.CANCELLED');
  }

  onSentBack(hook: WorkflowCommentHookContext): Promise<void> {
    return this.claims.onStatus(hook, 'CLAIM.SENT_BACK');
  }

  onResubmitted(hook: WorkflowResubmitHookContext): Promise<void> {
    return this.claims.onResubmitted(hook);
  }
}
