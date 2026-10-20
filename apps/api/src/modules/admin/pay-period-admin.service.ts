import { Injectable } from '@nestjs/common';
import type { PayPeriod, Prisma } from '@prisma/client';
import {
  type AdminPayPeriod,
  type AdminPayPeriodsQuery,
  type AdminPayPeriodsResponse,
  businessFromDate,
  type ClosePayPeriodResponse,
  type CreatePayPeriodRequest,
  dateFromBusiness,
  type UpdatePayPeriodRequest,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import {
  assertVersion,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { OutboxService } from '../../events/outbox.service';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { PAY_PERIOD_CLOSED_EVENT } from '../leave/leave-constants';
import { assertCompanyScope } from './admin-scope';

const PERIOD_INCLUDE = {
  companyRule: { select: { description: true, companyId: true, isActive: true } },
  _count: {
    select: {
      payslips: true,
      leaveApplications: true,
      ledgerEntries: true,
      claims: true,
      employeeTransactions: true,
    },
  },
} satisfies Prisma.PayPeriodInclude;

type PeriodRow = Prisma.PayPeriodGetPayload<{ include: typeof PERIOD_INCLUDE }>;

function linked(p: PeriodRow): number {
  const c = p._count;
  return c.payslips + c.leaveApplications + c.ledgerEntries + c.claims + c.employeeTransactions;
}

function toDto(p: PeriodRow): AdminPayPeriod {
  return {
    id: p.id,
    companyRuleId: p.companyRuleId,
    companyRule: p.companyRule.description,
    companyId: p.companyRule.companyId,
    description: p.description,
    startDate: businessFromDate(p.startDate),
    endDate: businessFromDate(p.endDate),
    payDate: p.payDate ? businessFromDate(p.payDate) : null,
    isClosed: p.isClosed,
    closedAt: p.closedAt?.toISOString() ?? null,
    closedByUserId: p.closedByUserId,
    linkedCount: linked(p),
    version: p.version,
  };
}

function plain(p: PeriodRow): PayPeriod {
  const { companyRule: _r, _count: _c, ...rest } = p;
  return rest;
}

/**
 * Pay periods (section 12.10, PAYROLL_ADMIN of the company rule's company). Periods of one
 * company rule never overlap. An open period's dates can change only while nothing is linked to
 * it (payslips, processed leave or claims, ledger entries). Closing is final: it is audited and
 * writes the `payPeriod.closed` outbox event, whose listener runs the leave accrual for the start
 * of the next period (section 5.2.5). There is no delete: a period is closed, never removed.
 */
@Injectable()
export class PayPeriodAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async list(ctx: SecurityContext, query: AdminPayPeriodsQuery): Promise<AdminPayPeriodsResponse> {
    if (query.companyRuleId) await this.ruleInScope(this.db.prisma, ctx, query.companyRuleId);
    const rows = await this.db.prisma.payPeriod.findMany({
      where: {
        companyRule: { companyId: { in: ctx.companyIds } },
        ...(query.companyRuleId ? { companyRuleId: query.companyRuleId } : {}),
        ...(query.isClosed !== undefined ? { isClosed: query.isClosed } : {}),
        ...(query.year
          ? {
              startDate: {
                gte: dateFromBusiness(`${query.year}-01-01`),
                lte: dateFromBusiness(`${query.year}-12-31`),
              },
            }
          : {}),
      },
      include: PERIOD_INCLUDE,
      orderBy: [{ companyRuleId: 'asc' }, { startDate: 'asc' }],
    });
    return { items: rows.map(toDto) };
  }

  async get(ctx: SecurityContext, id: number): Promise<AdminPayPeriod> {
    const row = await this.db.prisma.payPeriod.findUnique({ where: { id }, include: PERIOD_INCLUDE });
    if (!row) throw new NotFoundError('Pay period');
    assertCompanyScope(ctx, row.companyRule.companyId);
    return toDto(row);
  }

  async create(ctx: SecurityContext, input: CreatePayPeriodRequest): Promise<AdminPayPeriod> {
    return this.db.tx(ctx, async (tx) => {
      const rule = await this.ruleInScope(tx, ctx, input.companyRuleId);
      if (!rule.isActive) throw ValidationError.field('companyRuleId', 'This company rule is deactivated');
      await this.checkOverlap(tx, input.companyRuleId, input.startDate, input.endDate, null);
      const row = await tx.payPeriod.create({
        data: {
          companyRuleId: input.companyRuleId,
          description: input.description,
          startDate: dateFromBusiness(input.startDate),
          endDate: dateFromBusiness(input.endDate),
          payDate: input.payDate ? dateFromBusiness(input.payDate) : null,
        },
        include: PERIOD_INCLUDE,
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'PAY_PERIOD.CREATED',
        entityType: 'PayPeriod',
        entityId: row.id,
        after: plain(row),
      });
      return toDto(row);
    });
  }

  async update(ctx: SecurityContext, id: number, input: UpdatePayPeriodRequest): Promise<AdminPayPeriod> {
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lock(tx, ctx, id);
      assertVersion(before, input.version);
      if (before.isClosed) throw ValidationError.field('', 'A closed pay period cannot change');
      const startDate = input.startDate ?? businessFromDate(before.startDate);
      const endDate = input.endDate ?? businessFromDate(before.endDate);
      const datesChange =
        startDate !== businessFromDate(before.startDate) || endDate !== businessFromDate(before.endDate);
      if (endDate < startDate) throw ValidationError.field('endDate', 'End must be on or after start');
      if (datesChange) {
        if (linked(before) > 0) {
          throw ValidationError.field(
            'startDate',
            'Items are already linked to this period; its dates are fixed',
          );
        }
        await this.checkOverlap(tx, before.companyRuleId, startDate, endDate, id);
      }
      const after = await tx.payPeriod.update({
        where: { id },
        data: {
          ...(input.description ? { description: input.description } : {}),
          startDate: dateFromBusiness(startDate),
          endDate: dateFromBusiness(endDate),
          ...(input.payDate !== undefined
            ? { payDate: input.payDate ? dateFromBusiness(input.payDate) : null }
            : {}),
          version: { increment: 1 },
        },
        include: PERIOD_INCLUDE,
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'PAY_PERIOD.UPDATED',
        entityType: 'PayPeriod',
        entityId: id,
        before: plain(before),
        after: plain(after),
      });
      return toDto(after);
    });
  }

  /** POST /admin/pay-periods/:id/close: final; emits `payPeriod.closed` (leave accrual). */
  async close(ctx: SecurityContext, id: number, version: number): Promise<ClosePayPeriodResponse> {
    const result = await this.db.tx(ctx, async (tx) => {
      const before = await this.lock(tx, ctx, id);
      assertVersion(before, version);
      if (before.isClosed) throw new ConflictError('This pay period is already closed');
      const after = await tx.payPeriod.update({
        where: { id },
        data: { isClosed: true, closedAt: new Date(), closedByUserId: ctx.userId, version: { increment: 1 } },
        include: PERIOD_INCLUDE,
      });
      const pendingProcessCount = await tx.workflowProcess.count({
        where: {
          status: 'APPROVED_PENDING_PROCESS',
          subjectEmployee: { companyRuleId: before.companyRuleId },
        },
      });
      await this.outbox.add(tx, PAY_PERIOD_CLOSED_EVENT, {
        payPeriodId: id,
        companyRuleId: before.companyRuleId,
        endDate: businessFromDate(before.endDate),
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'PAY_PERIOD.CLOSED',
        entityType: 'PayPeriod',
        entityId: id,
        before: plain(before),
        after: plain(after),
        metadata: { event: PAY_PERIOD_CLOSED_EVENT, pendingProcessCount },
      });
      return { after, pendingProcessCount };
    });
    this.db.afterCommit(() => this.outbox.kick());
    return {
      payPeriod: toDto(result.after),
      event: 'payPeriod.closed',
      pendingProcessCount: result.pendingProcessCount,
    };
  }

  private async ruleInScope(client: Tx, ctx: SecurityContext, companyRuleId: number) {
    const rule = await client.companyRule.findUnique({ where: { id: companyRuleId } });
    if (!rule) throw ValidationError.field('companyRuleId', 'Unknown company rule');
    assertCompanyScope(ctx, rule.companyId);
    return rule;
  }

  private async lock(tx: Tx, ctx: SecurityContext, id: number): Promise<PeriodRow> {
    await this.db.lockRow(tx, 'PayPeriod', id);
    const row = await tx.payPeriod.findUnique({ where: { id }, include: PERIOD_INCLUDE });
    if (!row) throw new NotFoundError('Pay period');
    assertCompanyScope(ctx, row.companyRule.companyId);
    return row;
  }

  private async checkOverlap(
    tx: Tx,
    companyRuleId: number,
    startDate: string,
    endDate: string,
    exceptId: number | null,
  ): Promise<void> {
    // Lock the company rule so two concurrent creates cannot both pass the overlap check.
    await this.db.lockRow(tx, 'CompanyRule', companyRuleId);
    const clash = await tx.payPeriod.findFirst({
      where: {
        companyRuleId,
        ...(exceptId ? { id: { not: exceptId } } : {}),
        startDate: { lte: dateFromBusiness(endDate) },
        endDate: { gte: dateFromBusiness(startDate) },
      },
      select: { description: true },
    });
    if (clash) throw new ConflictError(`The dates overlap the pay period "${clash.description}"`);
  }
}
