import { Injectable } from '@nestjs/common';
import type { Beneficiary, ChangeRequest, FundMembership, Prisma, RetirementFund } from '@prisma/client';
import {
  type AdminFundMember,
  type AdminFundMembership,
  type AdminFundMembershipsQuery,
  type AdminFundMembershipsResponse,
  type AdminRetirementFund,
  type AdminRetirementFundsResponse,
  beneficiaryPercentageIssues,
  beneficiaryTotal,
  businessFromDate,
  type ChangeRequestSubmitResponse,
  type CreateFundMembershipRequest,
  type CreateRetirementFundRequest,
  dateFromBusiness,
  dec,
  type EndFundMembershipRequest,
  type FundMembership as FundMembershipDto,
  type FundsResponse,
  FUNDS_EMPTY_TEXT,
  maskLast4,
  type PendingChange,
  stableJson,
  todayBusinessDate,
  type UpdateBeneficiariesRequest,
  type UpdateRetirementFundRequest,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import {
  assertVersion,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { EncryptionService } from '../../crypto/encryption.service';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { ScopeService } from '../auth/scope.service';
import { type ChangeApplier, ChangeRequestService } from './change-request.service';
import { DetailsAccess } from './details-records';
import { isSealed, seal, type SealedValue, sealStored } from './sealed';

/** One beneficiary as stored in a change request (ID number sealed). */
interface ProposedBeneficiary {
  id: number | null;
  familyMemberId: number | null;
  name: string;
  relationship: string;
  identityNumber: SealedValue | null;
  percentage: string;
}

type MembershipRow = FundMembership & { fund: RetirementFund; beneficiaries: Beneficiary[] };

/** Memberships the employee still holds on a day: open, or ending that day or later. */
function openOn(day: string): Prisma.FundMembershipWhereInput {
  return { OR: [{ endDate: null }, { endDate: { gte: dateFromBusiness(day) } }] };
}

/** True once the membership's last day is before `day`. */
function hasEnded(row: Pick<FundMembership, 'endDate'>, day: string): boolean {
  return row.endDate !== null && businessFromDate(row.endDate) < day;
}

function adminMembershipDto(row: FundMembership): AdminFundMembership {
  return {
    membershipId: row.id,
    fundId: row.fundId,
    employeeId: row.employeeId,
    memberNumber: row.memberNumber,
    startDate: row.startDate ? businessFromDate(row.startDate) : null,
    endDate: row.endDate ? businessFromDate(row.endDate) : null,
    version: row.version,
  };
}

const MEMBER_INCLUDE = {
  employee: { select: { employeeCode: true, firstName: true, lastName: true, status: true } },
  _count: { select: { beneficiaries: { where: { deletedAt: null } } } },
} satisfies Prisma.FundMembershipInclude;

type MemberRow = Prisma.FundMembershipGetPayload<{ include: typeof MEMBER_INCLUDE }>;

function memberDto(row: MemberRow, today: string): AdminFundMember {
  return {
    ...adminMembershipDto(row),
    employeeCode: row.employee.employeeCode,
    employeeName: `${row.employee.firstName} ${row.employee.lastName}`,
    employeeStatus: row.employee.status,
    isActive: !hasEnded(row, today),
    beneficiaryCount: row._count.beneficiaries,
  };
}

function proposedList(value: unknown): ProposedBeneficiary[] {
  const list = (value as { beneficiaries?: unknown } | null)?.beneficiaries;
  return Array.isArray(list) ? (list as ProposedBeneficiary[]) : [];
}

/**
 * Beneficiaries (section 5.4.5, workflow BENEFICIARY): the retirement funds the employee is a
 * member of and, per fund, the beneficiaries (a family member or a free person) whose percentages
 * total exactly 100.00. A change replaces the fund's whole list on approval; removed beneficiaries
 * are soft-deleted. Also the HR admin of funds and memberships (`/admin/retirement-funds`).
 */
@Injectable()
export class BeneficiaryService implements ChangeApplier {
  readonly entityType = 'FundMembership' as const;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly crypto: EncryptionService,
    private readonly scope: ScopeService,
    private readonly access: DetailsAccess,
    private readonly changes: ChangeRequestService,
  ) {}

  async listMine(ctx: SecurityContext): Promise<FundsResponse> {
    const me = await this.access.me(ctx);
    const prisma = this.db.prisma;
    const [rows, pending] = await Promise.all([
      prisma.fundMembership.findMany({
        where: { employeeId: me.id, fund: { isActive: true }, ...openOn(todayBusinessDate()) },
        include: { fund: true, beneficiaries: { where: { deletedAt: null }, orderBy: { id: 'asc' } } },
        orderBy: { fund: { name: 'asc' } },
      }),
      this.changes.pendingFor(prisma, me.id, 'FundMembership'),
    ]);
    return {
      employeeId: me.id,
      items: rows.map((r) => this.dto(r, pending.get(String(r.id)) ?? null)),
      emptyText: FUNDS_EMPTY_TEXT,
    };
  }

  private dto(row: MembershipRow, pendingChange: PendingChange | null): FundMembershipDto {
    return {
      membershipId: row.id,
      version: row.version,
      fundId: row.fundId,
      fundCode: row.fund.code,
      fundName: row.fund.name,
      memberNumber: row.memberNumber,
      startDate: row.startDate ? businessFromDate(row.startDate) : null,
      beneficiaries: row.beneficiaries.map((b) => ({
        id: b.id,
        familyMemberId: b.familyMemberId,
        name: b.name,
        relationship: b.relationship,
        identityNumberMasked: maskLast4(b.identityNumberLast4) || null,
        percentage: dec(b.percentage).toFixed(2),
      })),
      totalPercentage: beneficiaryTotal(row.beneficiaries.map((b) => dec(b.percentage).toFixed(2))).toFixed(
        2,
      ),
      pendingChange,
    };
  }

  /** PUT /me/funds/:membershipId/beneficiaries → BENEFICIARY change request (total 100.00). */
  async submit(
    ctx: SecurityContext,
    membershipId: number,
    body: UpdateBeneficiariesRequest,
  ): Promise<ChangeRequestSubmitResponse> {
    return this.db.tx(ctx, async (tx) => {
      const me = await this.access.me(ctx, tx);
      await this.db.lockRow(tx, 'Employee', me.id);
      const membership = await tx.fundMembership.findUnique({
        where: { id: membershipId },
        include: { fund: true, beneficiaries: { where: { deletedAt: null }, orderBy: { id: 'asc' } } },
      });
      if (
        !membership ||
        membership.employeeId !== me.id ||
        !membership.fund.isActive ||
        hasEnded(membership, todayBusinessDate())
      ) {
        throw new NotFoundError('Fund membership');
      }
      assertVersion(membership, body.version);
      await this.changes.assertNoOpen(tx, me.id, 'FundMembership', membershipId);
      const issues = beneficiaryPercentageIssues(body.beneficiaries);
      if (issues.length > 0) throw new ValidationError(issues);

      const existing = new Map(membership.beneficiaries.map((b) => [b.id, b]));
      const proposed: ProposedBeneficiary[] = [];
      const plainProposed: unknown[] = [];
      for (const [index, row] of body.beneficiaries.entries()) {
        const kept = row.id ? existing.get(row.id) : undefined;
        if (row.id && !kept) {
          throw ValidationError.field(`beneficiaries.${index}.id`, 'This beneficiary is not on the fund');
        }
        let name = row.name ?? '';
        let relationship = row.relationship ?? '';
        let identity: string | null = row.identityNumber === undefined ? null : row.identityNumber;
        let sealed: SealedValue | null = null;
        if (row.familyMemberId) {
          const member = await tx.familyMember.findFirst({
            where: { id: row.familyMemberId, employeeId: me.id, deletedAt: null },
          });
          if (!member) {
            throw ValidationError.field(
              `beneficiaries.${index}.familyMemberId`,
              'Pick one of your family members',
            );
          }
          name = `${member.firstName} ${member.lastName}`;
          relationship = member.relationship;
          if (row.identityNumber === undefined) {
            identity = this.crypto.decryptNullable(member.identityNumberEnc);
            sealed = sealStored(member.identityNumberEnc, member.identityNumberLast4);
          }
        } else if (row.identityNumber === undefined && kept) {
          identity = this.crypto.decryptNullable(kept.identityNumberEnc);
          sealed = sealStored(kept.identityNumberEnc, kept.identityNumberLast4);
        }
        if (row.identityNumber !== undefined) sealed = seal(this.crypto, row.identityNumber);
        const percentage = dec(row.percentage).toFixed(2);
        proposed.push({
          id: kept?.id ?? null,
          familyMemberId: row.familyMemberId ?? null,
          name,
          relationship,
          identityNumber: sealed,
          percentage,
        });
        plainProposed.push({
          familyMemberId: row.familyMemberId ?? null,
          name,
          relationship,
          identity,
          percentage,
        });
      }
      const plainCurrent = membership.beneficiaries.map((b) => ({
        familyMemberId: b.familyMemberId,
        name: b.name,
        relationship: b.relationship,
        identity: this.crypto.decryptNullable(b.identityNumberEnc),
        percentage: dec(b.percentage).toFixed(2),
      }));
      this.changes.assertHasChanges(
        stableJson(plainCurrent) === stableJson(plainProposed) ? [] : ['beneficiaries'],
      );

      const changeRequest = await this.changes.submit(ctx, {
        employeeId: me.id,
        entityType: 'FundMembership',
        entityId: membershipId,
        operation: 'UPDATE',
        patch: { beneficiaries: proposed },
        previous: {
          beneficiaries: membership.beneficiaries.map((b) => ({
            id: b.id,
            familyMemberId: b.familyMemberId,
            name: b.name,
            relationship: b.relationship,
            identityNumber: b.identityNumberEnc ? { last4: b.identityNumberLast4 } : null,
            percentage: dec(b.percentage).toFixed(2),
          })),
        },
        baseVersion: membership.version,
        summary: `Beneficiaries of ${membership.fund.name}: ${proposed.length} beneficiar${proposed.length === 1 ? 'y' : 'ies'}`,
        attachmentIds: body.attachmentIds,
        comment: body.comment,
      });
      return { changeRequest, warnings: [] };
    });
  }

  // ───────────── ChangeApplier ─────────────

  async conflict(tx: Tx, cr: ChangeRequest): Promise<string | null> {
    const membership = await tx.fundMembership.findUnique({
      where: { id: Number(cr.entityId) },
      include: { fund: { select: { isActive: true } } },
    });
    if (!membership || !membership.fund.isActive) return 'The fund membership no longer exists';
    if (hasEnded(membership, todayBusinessDate())) return 'The fund membership has ended';
    if (membership.version !== cr.baseVersion)
      return 'The beneficiaries changed after this request was submitted';
    return null;
  }

  async apply(tx: Tx, ctx: SecurityContext, cr: ChangeRequest): Promise<string> {
    const membershipId = Number(cr.entityId);
    const list = proposedList(cr.proposed);
    const issues = beneficiaryPercentageIssues(list);
    if (issues.length > 0) throw new ValidationError(issues);
    const before = await tx.beneficiary.findMany({
      where: { membershipId, deletedAt: null },
      orderBy: { id: 'asc' },
    });
    const keep = new Set(list.map((b) => b.id).filter((id): id is number => id !== null));
    const now = new Date();
    for (const old of before) {
      if (!keep.has(old.id)) await tx.beneficiary.update({ where: { id: old.id }, data: { deletedAt: now } });
    }
    for (const b of list) {
      if (b.familyMemberId) {
        const member = await tx.familyMember.findFirst({
          where: { id: b.familyMemberId, employeeId: cr.employeeId, deletedAt: null },
          select: { id: true },
        });
        if (!member) throw ValidationError.field('beneficiaries', 'A family member on the list was removed');
      }
      const sealed = isSealed(b.identityNumber) ? b.identityNumber : null;
      const data = {
        familyMemberId: b.familyMemberId,
        name: b.name,
        relationship: b.relationship,
        identityNumberEnc: sealed?.valueEnc ?? null,
        identityNumberLast4: sealed?.last4 ?? null,
        percentage: b.percentage,
      };
      if (b.id !== null && before.some((o) => o.id === b.id)) {
        await tx.beneficiary.update({ where: { id: b.id }, data });
      } else {
        await tx.beneficiary.create({ data: { ...data, membershipId } });
      }
    }
    const membershipBefore = await tx.fundMembership.findUniqueOrThrow({ where: { id: membershipId } });
    const membership = await tx.fundMembership.update({
      where: { id: membershipId },
      data: { version: { increment: 1 } },
    });
    const after = await tx.beneficiary.findMany({
      where: { membershipId, deletedAt: null },
      orderBy: { id: 'asc' },
    });
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: 'FUND_MEMBERSHIP.BENEFICIARIES_UPDATED',
      entityType: 'FundMembership',
      entityId: membershipId,
      subjectEmployeeId: cr.employeeId,
      before: {
        ...membershipBefore,
        beneficiaries: before.map((b) => ({ ...b, percentage: dec(b.percentage).toFixed(2) })),
      },
      after: {
        ...membership,
        beneficiaries: after.map((b) => ({ ...b, percentage: dec(b.percentage).toFixed(2) })),
      },
      metadata: { source: 'CHANGE_REQUEST', changeRequestId: cr.id, referenceNumber: cr.referenceNumber },
    });
    return String(membershipId);
  }

  // ───────────── Admin: retirement funds and memberships ─────────────

  async adminList(): Promise<AdminRetirementFundsResponse> {
    const rows = await this.db.prisma.retirementFund.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { memberships: true } } },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        isActive: r.isActive,
        version: r.version,
        memberCount: r._count.memberships,
      })),
    };
  }

  async createFund(ctx: SecurityContext, input: CreateRetirementFundRequest): Promise<AdminRetirementFund> {
    return this.db.tx(ctx, async (tx) => {
      if (await tx.retirementFund.findUnique({ where: { code: input.code } })) {
        throw new ConflictError(`A fund with code ${input.code} already exists`);
      }
      const row = await tx.retirementFund.create({ data: { code: input.code, name: input.name } });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'RETIREMENT_FUND.CREATED',
        entityType: 'RetirementFund',
        entityId: row.id,
        after: row,
      });
      return { ...row, memberCount: 0 };
    });
  }

  async updateFund(
    ctx: SecurityContext,
    id: number,
    input: UpdateRetirementFundRequest,
  ): Promise<AdminRetirementFund> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'RetirementFund', id);
      const before = await tx.retirementFund.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('Retirement fund');
      assertVersion(before, input.version);
      const after = await tx.retirementFund.update({
        where: { id },
        data: { name: input.name, isActive: input.isActive, version: { increment: 1 } },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action:
          input.isActive === false && before.isActive
            ? 'RETIREMENT_FUND.DEACTIVATED'
            : 'RETIREMENT_FUND.UPDATED',
        entityType: 'RetirementFund',
        entityId: id,
        before,
        after,
      });
      const memberCount = await tx.fundMembership.count({ where: { fundId: id } });
      return {
        id: after.id,
        code: after.code,
        name: after.name,
        isActive: after.isActive,
        version: after.version,
        memberCount,
      };
    });
  }

  /** POST /admin/retirement-funds/:id/memberships: HR enrols an employee in their companies. */
  async addMembership(
    ctx: SecurityContext,
    fundId: number,
    input: CreateFundMembershipRequest,
  ): Promise<AdminFundMembership> {
    return this.db.tx(ctx, async (tx) => {
      const fund = await tx.retirementFund.findUnique({ where: { id: fundId } });
      if (!fund) throw new NotFoundError('Retirement fund');
      await this.scope.assertCanAccessEmployee(ctx, input.employeeId, 'HR_WRITE', tx);
      const existing = await tx.fundMembership.findUnique({
        where: { employeeId_fundId: { employeeId: input.employeeId, fundId } },
      });
      if (existing && existing.endDate === null) {
        throw new ConflictError('The employee is already a member of this fund');
      }
      if (existing) {
        // An ended membership is reopened (its unique key is taken); its beneficiaries are kept.
        await this.db.lockRow(tx, 'FundMembership', existing.id);
        const after = await tx.fundMembership.update({
          where: { id: existing.id },
          data: {
            endDate: null,
            memberNumber: input.memberNumber ?? existing.memberNumber,
            startDate: input.startDate ? dateFromBusiness(input.startDate) : existing.startDate,
            version: { increment: 1 },
          },
        });
        this.audit.record(tx, ctx, {
          category: 'DATA_CHANGE',
          action: 'FUND_MEMBERSHIP.REOPENED',
          entityType: 'FundMembership',
          entityId: after.id,
          subjectEmployeeId: after.employeeId,
          before: existing,
          after,
        });
        return adminMembershipDto(after);
      }
      const row = await tx.fundMembership.create({
        data: {
          employeeId: input.employeeId,
          fundId,
          memberNumber: input.memberNumber ?? null,
          startDate: input.startDate ? dateFromBusiness(input.startDate) : null,
        },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'FUND_MEMBERSHIP.CREATED',
        entityType: 'FundMembership',
        entityId: row.id,
        subjectEmployeeId: row.employeeId,
        after: row,
      });
      return adminMembershipDto(row);
    });
  }

  /**
   * GET /admin/retirement-funds/:id/memberships: the fund's members in the caller's companies,
   * by surname; ended memberships only with `includeEnded`.
   */
  async listMemberships(
    ctx: SecurityContext,
    fundId: number,
    query: AdminFundMembershipsQuery,
  ): Promise<AdminFundMembershipsResponse> {
    const prisma = this.db.prisma;
    const fund = await prisma.retirementFund.findUnique({ where: { id: fundId }, select: { id: true } });
    if (!fund) throw new NotFoundError('Retirement fund');
    const today = todayBusinessDate();
    const and: Prisma.FundMembershipWhereInput[] = [
      { fundId },
      { employee: { deletedAt: null, ...(ctx.isSystem ? {} : { companyId: { in: ctx.companyIds } }) } },
    ];
    if (!query.includeEnded) and.push(openOn(today));
    if (query.search) {
      const contains = { contains: query.search, mode: 'insensitive' as const };
      and.push({
        OR: [
          { memberNumber: contains },
          { employee: { firstName: contains } },
          { employee: { lastName: contains } },
          { employee: { employeeCode: contains } },
        ],
      });
    }
    const where: Prisma.FundMembershipWhereInput = { AND: and };
    const [rows, total] = await Promise.all([
      prisma.fundMembership.findMany({
        where,
        include: MEMBER_INCLUDE,
        orderBy: [{ employee: { lastName: 'asc' } }, { employee: { firstName: 'asc' } }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.fundMembership.count({ where }),
    ]);
    return { items: rows.map((r) => memberDto(r, today)), total, page: query.page, pageSize: query.pageSize };
  }

  /**
   * POST /admin/retirement-funds/:id/memberships/:membershipId/end: sets the membership's last
   * day (default today, never before its start). The row and its beneficiaries are kept.
   */
  async endMembership(
    ctx: SecurityContext,
    fundId: number,
    membershipId: number,
    input: EndFundMembershipRequest,
  ): Promise<AdminFundMember> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'FundMembership', membershipId);
      const before = await tx.fundMembership.findUnique({ where: { id: membershipId } });
      if (!before || before.fundId !== fundId) throw new NotFoundError('Fund membership');
      await this.scope.assertCanAccessEmployee(ctx, before.employeeId, 'HR_WRITE', tx);
      assertVersion(before, input.version);
      if (before.endDate !== null) {
        throw new ConflictError(`This membership already ended on ${businessFromDate(before.endDate)}`);
      }
      const today = todayBusinessDate();
      const endDate = input.endDate ?? today;
      if (before.startDate && endDate < businessFromDate(before.startDate)) {
        throw ValidationError.field('endDate', 'The end date cannot be before the start date');
      }
      const updated = await tx.fundMembership.update({
        where: { id: membershipId },
        data: { endDate: dateFromBusiness(endDate), version: { increment: 1 } },
        include: MEMBER_INCLUDE,
      });
      const { employee: _employee, _count: _count, ...after } = updated;
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'FUND_MEMBERSHIP.ENDED',
        entityType: 'FundMembership',
        entityId: membershipId,
        subjectEmployeeId: before.employeeId,
        before,
        after,
      });
      return memberDto(updated, today);
    });
  }
}
