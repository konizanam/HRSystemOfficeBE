import { Injectable } from '@nestjs/common';
import type { Company, CompanyRule } from '@prisma/client';
import type {
  AdminCompaniesQuery,
  AdminCompaniesResponse,
  AdminCompany,
  AdminCompanyRule,
  AdminCompanyRulesQuery,
  AdminCompanyRulesResponse,
  CreateCompanyRequest,
  CreateCompanyRuleRequest,
  UpdateCompanyRequest,
  UpdateCompanyRuleRequest,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import {
  assertVersion,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { assertCompanyScope, canReadCompany, companyFilter } from './admin-scope';

type CompanyRow = Company & { _count: { rules: number; employees: number } };
type RuleRow = CompanyRule & { company: Company; _count: { employees: number } };

function companyDto(c: CompanyRow): AdminCompany {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    currency: c.currency,
    country: c.country,
    isActive: c.isActive,
    ruleCount: c._count.rules,
    employeeCount: c._count.employees,
    version: c.version,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function ruleDto(r: RuleRow): AdminCompanyRule {
  return {
    id: r.id,
    companyId: r.companyId,
    companyCode: r.company.code,
    companyName: r.company.name,
    code: r.code,
    description: r.description,
    isActive: r.isActive,
    employeeCount: r._count.employees,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The row without the relation counts, for audit snapshots. */
function snapshot<T extends { _count?: unknown; company?: unknown }>(row: T): Omit<T, '_count' | 'company'> {
  const { _count: _c, company: _co, ...rest } = row;
  return rest;
}

const COMPANY_INCLUDE = { _count: { select: { rules: true, employees: true } } } as const;
const RULE_INCLUDE = { company: true, _count: { select: { employees: true } } } as const;

/**
 * Companies and company rules (section 12.10). HR admins manage the companies in their scope
 * (and may create companies); payroll admins and system admins read them. Deleting deactivates:
 * a deactivated company or rule takes no new employees, rules, pay periods or definitions.
 */
@Injectable()
export class OrganisationAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── Companies ─────────────

  async listCompanies(ctx: SecurityContext, query: AdminCompaniesQuery): Promise<AdminCompaniesResponse> {
    const ids = companyFilter(ctx);
    const rows = await this.db.prisma.company.findMany({
      where: {
        ...(ids ? { id: { in: ids } } : {}),
        ...(query.includeInactive ? {} : { isActive: true }),
      },
      include: COMPANY_INCLUDE,
      orderBy: { code: 'asc' },
    });
    return { items: rows.map(companyDto) };
  }

  async getCompany(ctx: SecurityContext, id: number): Promise<AdminCompany> {
    const row = await this.db.prisma.company.findUnique({ where: { id }, include: COMPANY_INCLUDE });
    if (!row) throw new NotFoundError('Company');
    if (!canReadCompany(ctx, id)) {
      throw new ForbiddenError('This company is outside your administration scope', {
        metadata: { companyId: id },
      });
    }
    return companyDto(row);
  }

  async createCompany(ctx: SecurityContext, input: CreateCompanyRequest): Promise<AdminCompany> {
    return this.db.tx(ctx, async (tx) => {
      if (await tx.company.findUnique({ where: { code: input.code } })) {
        throw new ConflictError(`The company code ${input.code} already exists`);
      }
      const row = await tx.company.create({ data: input, include: COMPANY_INCLUDE });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'COMPANY.CREATED',
        entityType: 'Company',
        entityId: row.id,
        after: snapshot(row),
      });
      return companyDto(row);
    });
  }

  async updateCompany(ctx: SecurityContext, id: number, input: UpdateCompanyRequest): Promise<AdminCompany> {
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lockCompany(tx, ctx, id);
      assertVersion(before, input.version);
      const { version: _v, ...fields } = input;
      const after = await tx.company.update({
        where: { id },
        data: { ...fields, version: { increment: 1 } },
        include: COMPANY_INCLUDE,
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'COMPANY.UPDATED',
        entityType: 'Company',
        entityId: id,
        before,
        after: snapshot(after),
      });
      return companyDto(after);
    });
  }

  async setCompanyActive(
    ctx: SecurityContext,
    id: number,
    isActive: boolean,
    version: number,
  ): Promise<AdminCompany> {
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lockCompany(tx, ctx, id);
      assertVersion(before, version);
      if (!isActive) {
        const active = await tx.employee.count({
          where: { companyId: id, deletedAt: null, status: { not: 'TERMINATED' } },
        });
        if (active > 0) {
          throw ValidationError.field(
            '',
            `The company still has ${active} active or suspended employee${active === 1 ? '' : 's'}; move or terminate them first`,
          );
        }
      }
      const after = await tx.company.update({
        where: { id },
        data: { isActive, version: { increment: 1 } },
        include: COMPANY_INCLUDE,
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: isActive ? 'COMPANY.ACTIVATED' : 'COMPANY.DEACTIVATED',
        entityType: 'Company',
        entityId: id,
        before,
        after: snapshot(after),
      });
      return companyDto(after);
    });
  }

  // ───────────── Company rules ─────────────

  async listRules(ctx: SecurityContext, query: AdminCompanyRulesQuery): Promise<AdminCompanyRulesResponse> {
    const ids = companyFilter(ctx);
    const rows = await this.db.prisma.companyRule.findMany({
      where: {
        ...(ids ? { companyId: { in: ids } } : {}),
        ...(query.companyId ? { companyId: query.companyId } : {}),
        ...(query.includeInactive ? {} : { isActive: true }),
      },
      include: RULE_INCLUDE,
      orderBy: [{ companyId: 'asc' }, { code: 'asc' }],
    });
    return { items: rows.map(ruleDto) };
  }

  async getRule(ctx: SecurityContext, id: number): Promise<AdminCompanyRule> {
    const row = await this.db.prisma.companyRule.findUnique({ where: { id }, include: RULE_INCLUDE });
    if (!row) throw new NotFoundError('Company rule');
    if (!canReadCompany(ctx, row.companyId)) {
      throw new ForbiddenError('This company rule is outside your administration scope', {
        metadata: { companyRuleId: id, companyId: row.companyId },
      });
    }
    return ruleDto(row);
  }

  async createRule(ctx: SecurityContext, input: CreateCompanyRuleRequest): Promise<AdminCompanyRule> {
    return this.db.tx(ctx, async (tx) => {
      const company = await tx.company.findUnique({ where: { id: input.companyId } });
      if (!company) throw ValidationError.field('companyId', 'Unknown company');
      assertCompanyScope(ctx, company.id);
      if (!company.isActive) throw ValidationError.field('companyId', 'This company is deactivated');
      const existing = await tx.companyRule.findUnique({
        where: { companyId_code: { companyId: company.id, code: input.code } },
      });
      if (existing) throw new ConflictError(`The company rule ${input.code} already exists in this company`);
      const row = await tx.companyRule.create({ data: input, include: RULE_INCLUDE });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'COMPANY_RULE.CREATED',
        entityType: 'CompanyRule',
        entityId: row.id,
        after: snapshot(row),
      });
      return ruleDto(row);
    });
  }

  async updateRule(
    ctx: SecurityContext,
    id: number,
    input: UpdateCompanyRuleRequest,
  ): Promise<AdminCompanyRule> {
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lockRule(tx, ctx, id);
      assertVersion(before, input.version);
      const after = await tx.companyRule.update({
        where: { id },
        data: { description: input.description, version: { increment: 1 } },
        include: RULE_INCLUDE,
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'COMPANY_RULE.UPDATED',
        entityType: 'CompanyRule',
        entityId: id,
        before,
        after: snapshot(after),
      });
      return ruleDto(after);
    });
  }

  async setRuleActive(
    ctx: SecurityContext,
    id: number,
    isActive: boolean,
    version: number,
  ): Promise<AdminCompanyRule> {
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lockRule(tx, ctx, id);
      assertVersion(before, version);
      if (!isActive) {
        const active = await tx.employee.count({
          where: { companyRuleId: id, deletedAt: null, status: { not: 'TERMINATED' } },
        });
        if (active > 0) {
          throw ValidationError.field(
            '',
            `The company rule still has ${active} active or suspended employee${active === 1 ? '' : 's'}; move or terminate them first`,
          );
        }
      } else {
        const company = await tx.company.findUniqueOrThrow({ where: { id: before.companyId } });
        if (!company.isActive) throw ValidationError.field('', 'Activate the company first');
      }
      const after = await tx.companyRule.update({
        where: { id },
        data: { isActive, version: { increment: 1 } },
        include: RULE_INCLUDE,
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: isActive ? 'COMPANY_RULE.ACTIVATED' : 'COMPANY_RULE.DEACTIVATED',
        entityType: 'CompanyRule',
        entityId: id,
        before,
        after: snapshot(after),
      });
      return ruleDto(after);
    });
  }

  private async lockCompany(tx: Tx, ctx: SecurityContext, id: number): Promise<Company> {
    await this.db.lockRow(tx, 'Company', id);
    const row = await tx.company.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('Company');
    assertCompanyScope(ctx, id);
    return row;
  }

  private async lockRule(tx: Tx, ctx: SecurityContext, id: number): Promise<CompanyRule> {
    await this.db.lockRow(tx, 'CompanyRule', id);
    const row = await tx.companyRule.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('Company rule');
    assertCompanyScope(ctx, row.companyId);
    return row;
  }
}
