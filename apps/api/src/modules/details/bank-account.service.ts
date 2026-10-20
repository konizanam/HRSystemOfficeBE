import { Injectable } from '@nestjs/common';
import type { Bank, BankAccount, BankBranch, ChangeRequest } from '@prisma/client';
import {
  ACCOUNT_HOLDER_RELATIONSHIP_LABELS,
  type AccountHolderRelationship,
  BANK_ACCOUNT_TYPE_LABELS,
  type BankAccount as BankAccountDto,
  type BankAccountsResponse,
  type BankAccountType,
  type BankAccountUnmasked,
  buildChangeDiff,
  businessFromDate,
  type ChangeRequestSubmitResponse,
  type CreateBankAccountRequest,
  dateFromBusiness,
  maskLast4,
  type PendingChange,
  type UpdateBankAccountRequest,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import { assertVersion, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { EncryptionService } from '../../crypto/encryption.service';
import { OutboxService } from '../../events/outbox.service';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { ScopeService } from '../auth/scope.service';
import { BanksService } from './banks.service';
import type { ChangeApplier } from './change-request.service';
import { ChangeRequestService } from './change-request.service';
import { dayBefore, DetailsAccess, nextOpenPeriodStart } from './details-records';
import { isSealed, masked, maskedText, seal, sealStored, type SealedValue } from './sealed';

/** Outbox event of an applied bank change; the details notifier emails the employee. */
export const BANK_DETAILS_CHANGED_EVENT = 'details.bankDetailsChanged';

type AccountRow = BankAccount & { bank: Bank; branch: BankBranch | null };

/** A bank account in the shape of the form, account number in plaintext. */
interface AccountState extends Record<string, unknown> {
  accountType: BankAccountType;
  accountHolderName: string;
  accountHolderRelationship: AccountHolderRelationship;
  bankId: number;
  branchId: number | null;
  accountNumber: string;
  currency: string;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Bank Details (section 5.4.2, workflow BANKDET). An employee has one active salary account
 * (ASSUMPTION B102): a new account (POST) replaces the active one and a change (PUT) replaces
 * that account, in both cases with a new row active from the next open pay period; the old row
 * gets `isActive=false` and `effectiveTo`. Numbers are encrypted and shown as `••••1234`; only a
 * payroll administrator sees one in full, with a reason, audited.
 */
@Injectable()
export class BankAccountService implements ChangeApplier {
  readonly entityType = 'BankAccount' as const;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly crypto: EncryptionService,
    private readonly scope: ScopeService,
    private readonly access: DetailsAccess,
    private readonly changes: ChangeRequestService,
    private readonly banks: BanksService,
    private readonly outbox: OutboxService,
  ) {}

  // ───────────── Reads ─────────────

  async listMine(ctx: SecurityContext): Promise<BankAccountsResponse> {
    const me = await this.access.me(ctx);
    return this.list(me.id, `${me.firstName} ${me.lastName}`);
  }

  /** GET /admin/employees/:id/bank-accounts (HR and Payroll in scope): masked. */
  async listForAdmin(ctx: SecurityContext, employeeId: number): Promise<BankAccountsResponse> {
    const e = await this.access.employee(ctx, employeeId, 'HR_READ');
    return this.list(e.id, `${e.firstName} ${e.lastName}`);
  }

  private async list(employeeId: number, name: string): Promise<BankAccountsResponse> {
    const prisma = this.db.prisma;
    const [rows, pending] = await Promise.all([
      prisma.bankAccount.findMany({
        where: { employeeId },
        include: { bank: true, branch: true },
        orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
      }),
      this.changes.pendingFor(prisma, employeeId, 'BankAccount'),
    ]);
    const dtos = rows.map((r) => this.dto(r, pending.get(String(r.id)) ?? null));
    return {
      employeeId,
      heading: `Bank Details for: ${name}`,
      items: dtos.filter((d) => d.isActive),
      history: dtos.filter((d) => !d.isActive),
      pendingCreate: pending.get('') ?? null,
    };
  }

  private dto(row: AccountRow, pendingChange: PendingChange | null): BankAccountDto {
    return {
      id: row.id,
      version: row.version,
      accountNumberMasked: maskLast4(row.accountNumberLast4),
      accountHolderName: row.holderName,
      accountHolderRelationship: row.holderRelationship,
      accountHolderRelationshipLabel: ACCOUNT_HOLDER_RELATIONSHIP_LABELS[row.holderRelationship],
      accountType: row.accountType,
      accountTypeLabel: BANK_ACCOUNT_TYPE_LABELS[row.accountType],
      bankId: row.bankId,
      bankName: row.bank.name,
      branchId: row.branchId,
      branchName: row.branch?.name ?? null,
      branchCode: row.branch?.code ?? null,
      currency: row.currency,
      isActive: row.isActive,
      effectiveFrom: businessFromDate(row.effectiveFrom),
      effectiveTo: row.effectiveTo ? businessFromDate(row.effectiveTo) : null,
      pendingChange,
    };
  }

  /**
   * The full account number: PAYROLL_ADMIN only (the route's role), with a reason, never while
   * working as someone else, and only for employees in the caller's companies. Audited
   * `DATA_VIEW.BANK_ACCOUNT_UNMASKED` with the reason.
   */
  async unmask(
    ctx: SecurityContext,
    accountId: number,
    reason: string,
    via: 'ME' | 'ADMIN',
  ): Promise<BankAccountUnmasked> {
    const account = await this.db.prisma.bankAccount.findUnique({ where: { id: accountId } });
    if (via === 'ME') {
      const me = await this.access.me(ctx);
      if (!account || account.employeeId !== me.id) throw new NotFoundError('Bank account');
    } else if (!account) {
      throw new NotFoundError('Bank account');
    }
    await this.scope.assertNotRestricted(ctx, 'BANK_ACCOUNT_NUMBERS');
    await this.scope.assertCanAccessEmployee(ctx, account.employeeId, 'PAYROLL');
    const accountNumber = this.crypto.decrypt(account.accountNumberEnc);
    await this.audit.recordStandalone(ctx, {
      category: 'DATA_VIEW',
      action: 'DATA_VIEW.BANK_ACCOUNT_UNMASKED',
      entityType: 'BankAccount',
      entityId: account.id,
      subjectEmployeeId: account.employeeId,
      reason,
      metadata: { via, last4: account.accountNumberLast4 },
    });
    return { id: account.id, employeeId: account.employeeId, accountNumber };
  }

  // ───────────── Submits ─────────────

  /** POST /me/bank-accounts → BANKDET change request for a new account. */
  async submitCreate(
    ctx: SecurityContext,
    body: CreateBankAccountRequest,
  ): Promise<ChangeRequestSubmitResponse> {
    return this.db.tx(ctx, async (tx) => {
      const me = await this.access.me(ctx, tx);
      await this.db.lockRow(tx, 'Employee', me.id);
      await this.changes.assertNoOpen(tx, me.id, 'BankAccount', null);
      await this.banks.assertBankAndBranch(tx, body.bankId, body.branchId);
      const state: AccountState = {
        accountType: body.accountType,
        accountHolderName: body.accountHolderName,
        accountHolderRelationship: body.accountHolderRelationship,
        bankId: body.bankId,
        branchId: body.branchId ?? null,
        accountNumber: body.accountNumber,
        currency: body.currency,
      };
      const diff = buildChangeDiff(null, state);
      diff.patch.accountNumber = seal(this.crypto, body.accountNumber);
      const bankName = await this.banks.bankName(tx, body.bankId);
      const changeRequest = await this.changes.submit(ctx, {
        employeeId: me.id,
        entityType: 'BankAccount',
        entityId: null,
        operation: 'CREATE',
        patch: diff.patch,
        previous: null,
        baseVersion: null,
        summary: `New bank account ${maskedText(body.accountNumber) ?? ''} at ${bankName}`,
        attachmentIds: body.attachmentIds,
        comment: body.comment,
      });
      return { changeRequest, warnings: [] };
    });
  }

  /** PUT /me/bank-accounts/:id → BANKDET change request with the changed fields. */
  async submitUpdate(
    ctx: SecurityContext,
    accountId: number,
    body: UpdateBankAccountRequest,
  ): Promise<ChangeRequestSubmitResponse> {
    return this.db.tx(ctx, async (tx) => {
      const me = await this.access.me(ctx, tx);
      await this.db.lockRow(tx, 'Employee', me.id);
      const account = await tx.bankAccount.findUnique({
        where: { id: accountId },
        include: { bank: true, branch: true },
      });
      if (!account || account.employeeId !== me.id) throw new NotFoundError('Bank account');
      if (!account.isActive) throw ValidationError.field('id', 'Only an active account can be changed');
      assertVersion(account, body.version);
      await this.changes.assertNoOpen(tx, me.id, 'BankAccount', accountId);
      const current = this.state(account);
      const { version: _v, attachmentIds, comment, ...input } = body;
      const diff = buildChangeDiff(current, input);
      this.changes.assertHasChanges(diff.paths);
      const merged = { ...current, ...diff.patch } as AccountState;
      if ('bankId' in diff.patch && !('branchId' in diff.patch) && merged.branchId !== null) {
        merged.branchId = null;
        diff.patch.branchId = null;
        diff.previous.branchId = current.branchId;
      }
      await this.banks.assertBankAndBranch(tx, merged.bankId, merged.branchId);
      if ('accountNumber' in diff.patch) {
        diff.patch.accountNumber = seal(this.crypto, merged.accountNumber);
        diff.previous.accountNumber = masked(current.accountNumber);
      }
      const changeRequest = await this.changes.submit(ctx, {
        employeeId: me.id,
        entityType: 'BankAccount',
        entityId: accountId,
        operation: 'UPDATE',
        patch: diff.patch,
        previous: diff.previous,
        baseVersion: account.version,
        summary: `Change bank account ${maskLast4(account.accountNumberLast4)} at ${account.bank.name}`,
        attachmentIds,
        comment,
      });
      return { changeRequest, warnings: [] };
    });
  }

  private state(account: BankAccount): AccountState {
    return {
      accountType: account.accountType,
      accountHolderName: account.holderName,
      accountHolderRelationship: account.holderRelationship,
      bankId: account.bankId,
      branchId: account.branchId,
      accountNumber: this.crypto.decrypt(account.accountNumberEnc),
      currency: account.currency,
    };
  }

  // ───────────── ChangeApplier ─────────────

  async conflict(tx: Tx, cr: ChangeRequest): Promise<string | null> {
    if (cr.operation === 'CREATE') return null;
    const account = await tx.bankAccount.findUnique({ where: { id: Number(cr.entityId) } });
    if (!account || !account.isActive)
      return 'The bank account was replaced after this request was submitted';
    if (account.version !== cr.baseVersion)
      return 'The bank account changed after this request was submitted';
    return null;
  }

  /**
   * Writes a new active account (from the next open pay period), deactivates the account(s) it
   * replaces, and queues the "Your bank details were changed" email to the employee (anti-fraud:
   * also when someone else submitted the change).
   */
  async apply(tx: Tx, ctx: SecurityContext, cr: ChangeRequest): Promise<string> {
    const patch = rec(cr.proposed);
    const employee = await tx.employee.findUniqueOrThrow({
      where: { id: cr.employeeId },
      select: { id: true, companyRuleId: true },
    });
    const replaced =
      cr.operation === 'CREATE'
        ? await tx.bankAccount.findMany({ where: { employeeId: employee.id, isActive: true } })
        : [await tx.bankAccount.findUniqueOrThrow({ where: { id: Number(cr.entityId) } })];
    const base = cr.operation === 'UPDATE' ? replaced[0] : undefined;
    const number: SealedValue | null = isSealed(patch.accountNumber)
      ? patch.accountNumber
      : base
        ? sealStored(base.accountNumberEnc, base.accountNumberLast4)
        : null;
    if (!number) throw ValidationError.field('accountNumber', 'The account number is required');
    const pick = <K extends keyof AccountState>(
      key: K,
      fallback: AccountState[K] | undefined,
    ): AccountState[K] => (key in patch ? patch[key as string] : fallback) as AccountState[K];
    const bankId = pick('bankId', base?.bankId);
    const branchId = pick('branchId', base?.branchId ?? null) ?? null;
    await this.banks.assertBankAndBranch(tx, bankId, branchId);

    const effectiveFrom = await nextOpenPeriodStart(tx, employee.companyRuleId);
    const created = await tx.bankAccount.create({
      data: {
        employeeId: employee.id,
        accountType: pick('accountType', base?.accountType),
        holderName: pick('accountHolderName', base?.holderName),
        holderRelationship: pick('accountHolderRelationship', base?.holderRelationship),
        bankId,
        branchId,
        accountNumberEnc: number.valueEnc,
        accountNumberLast4: number.last4 ?? '',
        currency: pick('currency', base?.currency ?? 'NAD'),
        isActive: true,
        effectiveFrom: dateFromBusiness(effectiveFrom),
      },
    });
    const meta = { source: 'CHANGE_REQUEST', changeRequestId: cr.id, referenceNumber: cr.referenceNumber };
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: 'BANK_ACCOUNT.CREATED',
      entityType: 'BankAccount',
      entityId: created.id,
      subjectEmployeeId: employee.id,
      after: created,
      metadata: { ...meta, replaces: replaced.map((r) => r.id), effectiveFrom },
    });
    for (const old of replaced) {
      const end = dayBefore(effectiveFrom);
      const from = businessFromDate(old.effectiveFrom);
      const after = await tx.bankAccount.update({
        where: { id: old.id },
        data: {
          isActive: false,
          effectiveTo: dateFromBusiness(end < from ? from : end),
          version: { increment: 1 },
        },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'BANK_ACCOUNT.DEACTIVATED',
        entityType: 'BankAccount',
        entityId: old.id,
        subjectEmployeeId: employee.id,
        before: old,
        after,
        metadata: { ...meta, replacedBy: created.id },
      });
    }
    await this.outbox.add(tx, BANK_DETAILS_CHANGED_EVENT, {
      employeeId: employee.id,
      bankAccountId: created.id,
      changeRequestId: cr.id,
      processId: cr.processId,
      effectiveFrom,
    });
    this.db.afterCommit(() => this.outbox.kick());
    return String(created.id);
  }

  async formatValue(client: Tx, path: string, value: unknown): Promise<string | null | undefined> {
    if (path === 'bankId' && typeof value === 'number') return this.banks.bankName(client, value);
    if (path === 'branchId' && typeof value === 'number') return this.banks.branchLabel(client, value);
    if (path === 'accountType' && typeof value === 'string') {
      return BANK_ACCOUNT_TYPE_LABELS[value as BankAccountType] ?? value;
    }
    if (path === 'accountHolderRelationship' && typeof value === 'string') {
      return ACCOUNT_HOLDER_RELATIONSHIP_LABELS[value as AccountHolderRelationship] ?? value;
    }
    return undefined;
  }
}
