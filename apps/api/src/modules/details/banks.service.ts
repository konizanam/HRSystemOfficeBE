import { Injectable } from '@nestjs/common';
import type { Bank, BankBranch } from '@prisma/client';
import type {
  AdminBank,
  AdminBankBranch,
  AdminBankBranchesResponse,
  AdminBanksResponse,
  BankBranchesResponse,
  BanksResponse,
  CreateBankBranchRequest,
  CreateBankRequest,
  UpdateBankBranchRequest,
  UpdateBankRequest,
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
import { SEED_BANKS, SEED_BRANCHES } from './bank-data';
import { LookupService } from './lookup.service';

function bankDto(bank: Bank) {
  return {
    id: bank.id,
    name: bank.name,
    universalBranchCode: bank.universalBranchCode,
    country: bank.country,
  };
}

function adminBankDto(bank: Bank & { _count: { branches: number } }): AdminBank {
  return {
    ...bankDto(bank),
    isActive: bank.isActive,
    version: bank.version,
    branchCount: bank._count.branches,
  };
}

function adminBranchDto(branch: BankBranch): AdminBankBranch {
  return {
    id: branch.id,
    bankId: branch.bankId,
    name: branch.name,
    code: branch.code,
    isActive: branch.isActive,
    version: branch.version,
  };
}

/**
 * Banks and branches (section 5.4.2): the pick lists of the bank details form and the HR/Payroll
 * admin CRUD (`/admin/banks` + branches, ASSUMPTION A12: branch codes are edited here). Deleting
 * deactivates; existing accounts keep their bank.
 */
@Injectable()
export class BanksService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly lookups: LookupService,
  ) {}

  async list(): Promise<BanksResponse> {
    const rows = await this.db.prisma.bank.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
    return { items: rows.map(bankDto) };
  }

  async branches(bankId: number): Promise<BankBranchesResponse> {
    const bank = await this.db.prisma.bank.findFirst({ where: { id: bankId, isActive: true } });
    if (!bank) throw new NotFoundError('Bank');
    const rows = await this.db.prisma.bankBranch.findMany({
      where: { bankId, isActive: true },
      orderBy: { name: 'asc' },
    });
    return {
      bankId,
      items: rows.map((b) => ({ id: b.id, bankId: b.bankId, name: b.name, code: b.code })),
    };
  }

  /** 422 unless the bank is active and the branch (when given) is an active branch of it. */
  async assertBankAndBranch(
    client: Tx,
    bankId: number,
    branchId: number | null | undefined,
    paths = { bank: 'bankId', branch: 'branchId' },
  ): Promise<void> {
    const bank = await client.bank.findFirst({ where: { id: bankId, isActive: true }, select: { id: true } });
    if (!bank) throw ValidationError.field(paths.bank, 'Pick a bank from the list');
    if (branchId === null || branchId === undefined) return;
    const branch = await client.bankBranch.findFirst({
      where: { id: branchId, bankId, isActive: true },
      select: { id: true },
    });
    if (!branch) throw ValidationError.field(paths.branch, 'Pick a branch of the selected bank');
  }

  async bankName(client: Tx, bankId: number): Promise<string> {
    const bank = await client.bank.findUnique({ where: { id: bankId }, select: { name: true } });
    return bank?.name ?? `Bank ${bankId}`;
  }

  async branchLabel(client: Tx, branchId: number): Promise<string> {
    const branch = await client.bankBranch.findUnique({
      where: { id: branchId },
      select: { name: true, code: true },
    });
    if (!branch) return `Branch ${branchId}`;
    return branch.code ? `${branch.name} (${branch.code})` : branch.name;
  }

  // ───────────── Admin ─────────────

  async adminList(): Promise<AdminBanksResponse> {
    const rows = await this.db.prisma.bank.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { branches: true } } },
    });
    return { items: rows.map(adminBankDto) };
  }

  async create(ctx: SecurityContext, input: CreateBankRequest): Promise<AdminBank> {
    return this.db.tx(ctx, async (tx) => {
      if (await tx.bank.findUnique({ where: { name: input.name } })) {
        throw new ConflictError(`A bank named ${input.name} already exists`);
      }
      await this.lookups.assertValid(tx, [['countries', input.country, 'country']]);
      const row = await tx.bank.create({
        data: {
          name: input.name,
          universalBranchCode: input.universalBranchCode ?? null,
          country: input.country ?? null,
        },
        include: { _count: { select: { branches: true } } },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'BANK.CREATED',
        entityType: 'Bank',
        entityId: row.id,
        after: row,
      });
      return adminBankDto(row);
    });
  }

  async update(ctx: SecurityContext, id: number, input: UpdateBankRequest): Promise<AdminBank> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'Bank', id);
      const before = await tx.bank.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('Bank');
      assertVersion(before, input.version);
      if (
        input.name &&
        input.name !== before.name &&
        (await tx.bank.findUnique({ where: { name: input.name } }))
      ) {
        throw new ConflictError(`A bank named ${input.name} already exists`);
      }
      await this.lookups.assertValid(tx, [['countries', input.country, 'country']]);
      const after = await tx.bank.update({
        where: { id },
        data: {
          name: input.name,
          universalBranchCode: input.universalBranchCode,
          country: input.country,
          isActive: input.isActive,
          version: { increment: 1 },
        },
        include: { _count: { select: { branches: true } } },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: input.isActive === false && before.isActive ? 'BANK.DEACTIVATED' : 'BANK.UPDATED',
        entityType: 'Bank',
        entityId: id,
        before,
        after,
      });
      return adminBankDto(after);
    });
  }

  async adminBranches(bankId: number): Promise<AdminBankBranchesResponse> {
    const bank = await this.db.prisma.bank.findUnique({ where: { id: bankId } });
    if (!bank) throw new NotFoundError('Bank');
    const rows = await this.db.prisma.bankBranch.findMany({ where: { bankId }, orderBy: { name: 'asc' } });
    return { bankId, items: rows.map(adminBranchDto) };
  }

  async createBranch(
    ctx: SecurityContext,
    bankId: number,
    input: CreateBankBranchRequest,
  ): Promise<AdminBankBranch> {
    return this.db.tx(ctx, async (tx) => {
      const bank = await tx.bank.findUnique({ where: { id: bankId } });
      if (!bank) throw new NotFoundError('Bank');
      if (await tx.bankBranch.findUnique({ where: { bankId_name: { bankId, name: input.name } } })) {
        throw new ConflictError(`${bank.name} already has a branch named ${input.name}`);
      }
      const row = await tx.bankBranch.create({
        data: { bankId, name: input.name, code: input.code ?? null },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'BANK_BRANCH.CREATED',
        entityType: 'BankBranch',
        entityId: row.id,
        after: row,
      });
      return adminBranchDto(row);
    });
  }

  async updateBranch(
    ctx: SecurityContext,
    bankId: number,
    branchId: number,
    input: UpdateBankBranchRequest,
  ): Promise<AdminBankBranch> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'BankBranch', branchId);
      const before = await tx.bankBranch.findUnique({ where: { id: branchId } });
      if (!before || before.bankId !== bankId) throw new NotFoundError('Bank branch');
      assertVersion(before, input.version);
      if (
        input.name &&
        input.name !== before.name &&
        (await tx.bankBranch.findUnique({ where: { bankId_name: { bankId, name: input.name } } }))
      ) {
        throw new ConflictError(`This bank already has a branch named ${input.name}`);
      }
      const after = await tx.bankBranch.update({
        where: { id: branchId },
        data: { name: input.name, code: input.code, isActive: input.isActive, version: { increment: 1 } },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action:
          input.isActive === false && before.isActive ? 'BANK_BRANCH.DEACTIVATED' : 'BANK_BRANCH.UPDATED',
        entityType: 'BankBranch',
        entityId: branchId,
        before,
        after,
      });
      return adminBranchDto(after);
    });
  }

  /** Seeds the 40 banks and the observed branch lists; existing rows are left alone. */
  async seed(ctx: SecurityContext): Promise<{ banksCreated: number; branchesCreated: number }> {
    return this.db.tx(ctx, async (tx) => {
      let banksCreated = 0;
      let branchesCreated = 0;
      for (const seed of SEED_BANKS) {
        let bank = await tx.bank.findUnique({ where: { name: seed.name } });
        if (!bank) {
          bank = await tx.bank.create({ data: seed });
          this.audit.record(tx, ctx, {
            category: 'DATA_CHANGE',
            action: 'BANK.SEEDED',
            entityType: 'Bank',
            entityId: bank.id,
            after: bank,
          });
          banksCreated += 1;
        }
        for (const branch of SEED_BRANCHES[seed.name] ?? []) {
          const existing = await tx.bankBranch.findUnique({
            where: { bankId_name: { bankId: bank.id, name: branch.name } },
            select: { id: true },
          });
          if (existing) continue;
          const row = await tx.bankBranch.create({ data: { bankId: bank.id, ...branch } });
          this.audit.record(tx, ctx, {
            category: 'DATA_CHANGE',
            action: 'BANK_BRANCH.SEEDED',
            entityType: 'BankBranch',
            entityId: row.id,
            after: row,
            metadata: { assumption: 'A12: placeholder branch code' },
          });
          branchesCreated += 1;
        }
      }
      return { banksCreated, branchesCreated };
    });
  }
}
