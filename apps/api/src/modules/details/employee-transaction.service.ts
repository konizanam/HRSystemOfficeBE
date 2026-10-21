import { Injectable } from '@nestjs/common';
import type { EmployeeTransaction, PayPeriod, PayrollTransactionCode, ProcessStatus } from '@prisma/client';
import {
  type AdminTransactionCode,
  type AdminTransactionCodesResponse,
  businessFromDate,
  type CreateTransactionCodeRequest,
  dateFromBusiness,
  dec,
  type EmployeeTransaction as EmployeeTransactionDto,
  type EmployeeTransactionsResponse,
  formatFreeTextReference,
  money2,
  PROCESS_STATUS_LABELS,
  sequenceKeys,
  type SubmitEmployeeTransactionRequest,
  todayBusinessDate,
  type TransactionInputMode,
  units4,
  type UpdateTransactionCodeRequest,
  WORKFLOW_REQUEST_LABELS,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import {
  assertVersion,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { AttachmentService } from '../attachments/attachment.service';
import { FREE_TEXT_ENTITY, type FreeTextService } from '../free-text/free-text.service';
import { GenericSubjectHandler } from '../workflow/subject-registry';
import { WorkflowEngine } from '../workflow/workflow-engine.service';
import type {
  FinalApprovalResult,
  SubjectDescription,
  SubjectViewer,
  WorkflowCancelHookContext,
  WorkflowCommentHookContext,
  WorkflowHookContext,
  WorkflowProcessHookContext,
  WorkflowProcessSnapshot,
  WorkflowResubmitHookContext,
  WorkflowSubjectHandler,
} from '../workflow/workflow-subject';
import { DetailsAccess } from './details-records';

/** Subject entity of an employee-initiated payroll input. */
export const EMPLOYEE_TRANSACTION_ENTITY = 'EmployeeTransaction';

/** Discriminator of the FREETEXTMANEMP definition for one code, so HR can route codes apart. */
export function transactionDiscriminator(code: string): string {
  return `TXN:${code}`;
}

type TransactionRow = EmployeeTransaction & { payPeriod: PayPeriod | null };

function inputMode(code: PayrollTransactionCode): TransactionInputMode {
  return code.inputMode === 'QUANTITY' ? 'QUANTITY' : 'AMOUNT';
}

function adminCodeDto(row: PayrollTransactionCode): AdminTransactionCode {
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    inputMode: inputMode(row),
    requiresAttachment: row.requiresAttachment,
    allowEmployeeInput: row.allowEmployeeInput,
    isActive: row.isActive,
    version: row.version,
  };
}

/**
 * Employee Transactions (section 5.4.6, ASSUMPTION A17): the read-only recurring payroll
 * transactions, and employee-initiated inputs for the codes HR opens for it, which go through the
 * FREETEXTMANEMP workflow (the employee is the mandatory subject) until a dedicated type exists.
 */
@Injectable()
export class EmployeeTransactionService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly access: DetailsAccess,
    private readonly engine: WorkflowEngine,
    private readonly attachments: AttachmentService,
  ) {}

  async listMine(ctx: SecurityContext): Promise<EmployeeTransactionsResponse> {
    const me = await this.access.me(ctx);
    const prisma = this.db.prisma;
    const [rows, codes] = await Promise.all([
      prisma.employeeTransaction.findMany({
        where: { employeeId: me.id },
        include: { payPeriod: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      prisma.payrollTransactionCode.findMany({
        where: { isActive: true, allowEmployeeInput: true },
        orderBy: { code: 'asc' },
      }),
    ]);
    return {
      employeeId: me.id,
      recurring: rows
        .filter((r) => r.isRecurring)
        .sort((a, b) => a.code.localeCompare(b.code))
        .map(dto),
      submitted: rows.filter((r) => !r.isRecurring).map(dto),
      codes: codes.map((c) => ({
        id: c.id,
        code: c.code,
        description: c.description,
        inputMode: inputMode(c),
        requiresAttachment: c.requiresAttachment,
      })),
    };
  }

  /** POST /me/transactions: an input for a code HR opened, through FREETEXTMANEMP. */
  async submit(
    ctx: SecurityContext,
    body: SubmitEmployeeTransactionRequest,
  ): Promise<EmployeeTransactionDto> {
    return this.db.tx(ctx, async (tx) => {
      const me = await this.access.me(ctx, tx);
      await this.db.lockRow(tx, 'Employee', me.id);
      const code = await tx.payrollTransactionCode.findUnique({ where: { id: body.transactionCodeId } });
      if (!code || !code.isActive || !code.allowEmployeeInput) {
        throw ValidationError.field('transactionCodeId', 'This transaction cannot be submitted by employees');
      }
      const mode = inputMode(code);
      if (mode === 'AMOUNT' && body.amount === undefined) {
        throw ValidationError.field('amount', 'Enter the amount');
      }
      if (mode === 'QUANTITY' && body.quantity === undefined) {
        throw ValidationError.field('quantity', 'Enter the quantity');
      }
      if (code.requiresAttachment && !body.attachmentIds?.length) {
        throw ValidationError.field('attachmentIds', 'Attach a supporting document');
      }
      const seq = await this.db.nextSequence(tx, sequenceKeys.freeText(me.id));
      const referenceNumber = formatFreeTextReference(me.entityCode, seq);
      const row = await tx.employeeTransaction.create({
        data: {
          employeeId: me.id,
          transactionCodeId: code.id,
          code: code.code,
          description: code.description,
          amount: mode === 'AMOUNT' ? body.amount : null,
          quantity: mode === 'QUANTITY' ? body.quantity : null,
          isRecurring: false,
          status: 'IN_PROGRESS',
          referenceNumber,
          comment: body.comment ?? null,
        },
      });
      this.audit.record(tx, ctx, {
        category: 'WORKFLOW',
        action: 'EMPLOYEE_TRANSACTION.SUBMITTED',
        entityType: 'EmployeeTransaction',
        entityId: row.id,
        subjectEmployeeId: me.id,
        after: row,
      });
      if (body.attachmentIds?.length) {
        await this.attachments.bind(tx, ctx, body.attachmentIds, {
          entity: EMPLOYEE_TRANSACTION_ENTITY,
          entityId: row.id,
          subjectEmployeeId: me.id,
        });
      }
      const value = mode === 'AMOUNT' ? money2(body.amount) : units4(body.quantity);
      const process = await this.engine.start(ctx, {
        type: 'FREETEXTMANEMP',
        subjectEntity: EMPLOYEE_TRANSACTION_ENTITY,
        subjectEntityId: row.id,
        subjectEmployeeId: me.id,
        summary: `${code.description} ${value} (${referenceNumber})`,
        discriminator: transactionDiscriminator(code.code),
        comment: body.comment ?? null,
      });
      await tx.employeeTransaction.update({ where: { id: row.id }, data: { processId: process.id } });
      const linked = await tx.employeeTransaction.findUniqueOrThrow({
        where: { id: row.id },
        include: { payPeriod: true },
      });
      return dto(linked);
    });
  }

  // ───────────── FREETEXTMANEMP hooks for employee inputs ─────────────

  async describe(client: Tx, process: WorkflowProcessSnapshot): Promise<SubjectDescription> {
    const row = await client.employeeTransaction.findUniqueOrThrow({
      where: { id: Number(process.subjectEntityId) },
      include: { payPeriod: true },
    });
    const value = row.amount !== null ? money2(row.amount) : units4(row.quantity);
    const label = row.amount !== null ? 'Amount' : 'Quantity';
    return {
      requestLabel: WORKFLOW_REQUEST_LABELS.FREETEXTMANEMP,
      title: 'Employee transaction',
      fromDate: null,
      toDate: null,
      unitsLine: null,
      headline: [{ label, value }],
      fields: [
        { label: 'Transaction', value: `${row.code} ${row.description}` },
        { label, value },
        { label: 'Comments', value: row.comment ?? '' },
        { label: 'Reference number', value: row.referenceNumber ?? '' },
      ],
      kind: 'EMPLOYEE_TRANSACTION',
      data: { employeeTransactionId: row.id, referenceNumber: row.referenceNumber, code: row.code },
      viewLabel: 'View employee transaction',
    };
  }

  /** Approved inputs are linked to the open pay period that contains today, else the next one. */
  async onFinalApproval({ tx, ctx, process }: WorkflowHookContext): Promise<FinalApprovalResult> {
    const id = Number(process.subjectEntityId);
    const row = await tx.employeeTransaction.findUniqueOrThrow({
      where: { id },
      include: { employee: { select: { companyRuleId: true } } },
    });
    const today = dateFromBusiness(todayBusinessDate());
    const period =
      (await tx.payPeriod.findFirst({
        where: {
          companyRuleId: row.employee.companyRuleId,
          isClosed: false,
          startDate: { lte: today },
          endDate: { gte: today },
        },
        select: { id: true },
      })) ??
      (await tx.payPeriod.findFirst({
        where: { companyRuleId: row.employee.companyRuleId, isClosed: false, startDate: { gt: today } },
        orderBy: { startDate: 'asc' },
        select: { id: true },
      }));
    await this.setStatus(tx, ctx, id, 'PROCESSED', 'EMPLOYEE_TRANSACTION.APPROVED', period?.id ?? null);
    return { outcome: 'APPLIED' };
  }

  async setStatus(
    tx: Tx,
    ctx: SecurityContext,
    id: number,
    status: ProcessStatus,
    action: string,
    payPeriodId?: number | null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const before = await tx.employeeTransaction.findUniqueOrThrow({ where: { id } });
    const after = await tx.employeeTransaction.update({
      where: { id },
      data: { status, payPeriodId, version: { increment: 1 } },
    });
    this.audit.record(tx, ctx, {
      category: 'WORKFLOW',
      action,
      entityType: 'EmployeeTransaction',
      entityId: id,
      subjectEmployeeId: before.employeeId,
      before,
      after,
      metadata: { referenceNumber: before.referenceNumber, ...metadata },
    });
  }

  // ───────────── Admin: transaction codes ─────────────

  async adminCodes(): Promise<AdminTransactionCodesResponse> {
    const rows = await this.db.prisma.payrollTransactionCode.findMany({ orderBy: { code: 'asc' } });
    return { items: rows.map(adminCodeDto) };
  }

  async createCode(ctx: SecurityContext, input: CreateTransactionCodeRequest): Promise<AdminTransactionCode> {
    return this.db.tx(ctx, async (tx) => {
      if (await tx.payrollTransactionCode.findUnique({ where: { code: input.code } })) {
        throw new ConflictError(`The transaction code ${input.code} already exists`);
      }
      const row = await tx.payrollTransactionCode.create({ data: input });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'TRANSACTION_CODE.CREATED',
        entityType: 'PayrollTransactionCode',
        entityId: row.id,
        after: row,
      });
      return adminCodeDto(row);
    });
  }

  /** DELETE /admin/transaction-codes/:id: deactivates the code (no hard deletes). */
  deactivateCode(ctx: SecurityContext, id: number, version: number): Promise<AdminTransactionCode> {
    return this.updateCode(ctx, id, { version, isActive: false }, true);
  }

  async updateCode(
    ctx: SecurityContext,
    id: number,
    input: UpdateTransactionCodeRequest,
    deactivating = false,
  ): Promise<AdminTransactionCode> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'PayrollTransactionCode', id);
      const before = await tx.payrollTransactionCode.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('Transaction code');
      assertVersion(before, input.version);
      const { version: _v, ...fields } = input;
      const after = await tx.payrollTransactionCode.update({
        where: { id },
        data: { ...fields, version: { increment: 1 } },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: deactivating ? 'TRANSACTION_CODE.DEACTIVATED' : 'TRANSACTION_CODE.UPDATED',
        entityType: 'PayrollTransactionCode',
        entityId: id,
        before,
        after,
      });
      return adminCodeDto(after);
    });
  }
}

function dto(row: TransactionRow): EmployeeTransactionDto {
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    amount: row.amount === null ? null : dec(row.amount).toFixed(2),
    quantity: row.quantity === null ? null : dec(row.quantity).toFixed(4),
    isRecurring: row.isRecurring,
    startDate: row.startDate ? businessFromDate(row.startDate) : null,
    endDate: row.endDate ? businessFromDate(row.endDate) : null,
    payPeriod: row.payPeriod?.description ?? null,
    status: row.status,
    statusLabel: PROCESS_STATUS_LABELS[row.status],
    referenceNumber: row.referenceNumber,
    processId: row.processId,
    comment: row.comment,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The single FREETEXTMANEMP subject handler (ASSUMPTION B107, B200). It has two branches by
 * subject entity: employee transaction inputs (this module) and free text requests whose type
 * needs an "About employee" (FreeTextService, section 5.8). Any other subject entity gets the
 * generic behaviour.
 */
export class FreeTextManEmpHandler implements WorkflowSubjectHandler {
  readonly type = 'FREETEXTMANEMP' as const;
  private readonly generic = new GenericSubjectHandler('FREETEXTMANEMP');

  constructor(
    private readonly transactions: EmployeeTransactionService,
    private readonly freeText: FreeTextService,
  ) {}

  private mine(process: WorkflowProcessSnapshot): boolean {
    return process.subjectEntity === EMPLOYEE_TRANSACTION_ENTITY;
  }

  private isFreeText(process: WorkflowProcessSnapshot): boolean {
    return process.subjectEntity === FREE_TEXT_ENTITY;
  }

  describe(
    client: Tx,
    process: WorkflowProcessSnapshot,
    _viewer?: SubjectViewer,
  ): Promise<SubjectDescription> {
    if (this.isFreeText(process)) return this.freeText.describe(client, process);
    return this.mine(process)
      ? this.transactions.describe(client, process)
      : this.generic.describe(client, process);
  }

  onFinalApproval(hook: WorkflowHookContext): Promise<FinalApprovalResult> {
    if (this.isFreeText(hook.process)) return this.freeText.onFinalApproval(hook);
    return this.mine(hook.process) ? this.transactions.onFinalApproval(hook) : this.generic.onFinalApproval();
  }

  async onProcess(_hook: WorkflowProcessHookContext): Promise<void> {}

  async onDeclined(hook: WorkflowCommentHookContext): Promise<void> {
    if (this.isFreeText(hook.process)) return this.freeText.onDeclined(hook);
    const { tx, ctx, process, comment } = hook;
    if (!this.mine(process)) return;
    await this.transactions.setStatus(
      tx,
      ctx,
      Number(process.subjectEntityId),
      'DECLINED',
      'EMPLOYEE_TRANSACTION.DECLINED',
      undefined,
      { comment },
    );
  }

  async onCancelled(hook: WorkflowCancelHookContext): Promise<void> {
    if (this.isFreeText(hook.process)) return this.freeText.onCancelled(hook);
    const { tx, ctx, process, reason } = hook;
    if (!this.mine(process)) return;
    await this.transactions.setStatus(
      tx,
      ctx,
      Number(process.subjectEntityId),
      'CANCELLED',
      reason === 'WITHDRAWN' ? 'EMPLOYEE_TRANSACTION.WITHDRAWN' : 'EMPLOYEE_TRANSACTION.CANCELLED',
    );
  }

  async onSentBack(hook: WorkflowCommentHookContext): Promise<void> {
    if (this.isFreeText(hook.process)) return this.freeText.onSentBack(hook);
    const { tx, ctx, process, comment } = hook;
    if (!this.mine(process)) return;
    await this.transactions.setStatus(
      tx,
      ctx,
      Number(process.subjectEntityId),
      'RESUBMIT_REQUIRED',
      'EMPLOYEE_TRANSACTION.SENT_BACK',
      undefined,
      { comment },
    );
  }

  async onResubmitted(hook: WorkflowResubmitHookContext): Promise<void> {
    if (this.isFreeText(hook.process)) return this.freeText.onResubmitted(hook);
    const { tx, ctx, process, changes } = hook;
    if (!this.mine(process)) return;
    if (changes && Object.keys(changes).length > 0) {
      throw ValidationError.field('changes', 'Withdraw this input and submit a new one to change it');
    }
    await this.transactions.setStatus(
      tx,
      ctx,
      Number(process.subjectEntityId),
      'IN_PROGRESS',
      'EMPLOYEE_TRANSACTION.RESUBMITTED',
    );
  }
}
