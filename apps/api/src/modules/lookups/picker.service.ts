import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  CompaniesResponse,
  CompanyRulesQuery,
  CompanyRulesResponse,
  EmployeePickerQuery,
  EmployeePickerResponse,
  PositionsQuery,
  PositionsResponse,
} from '@peoplehub/shared';
import { hasRole, type SecurityContext } from '../../common/context/security-context';
import { DbService } from '../../prisma/db.service';
import { ScopeService } from '../auth/scope.service';

const EMPLOYEE_SELECT = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  knownAs: true,
  companyId: true,
  companyRuleId: true,
  jobTitle: true,
  status: true,
  company: { select: { name: true } },
  companyRule: { select: { description: true } },
  user: { select: { id: true } },
} satisfies Prisma.EmployeeSelect;

/**
 * The scoped pickers of the performance filters, contract initiation and the report parameter
 * panels: employees, companies, company rules and positions (distinct job titles). Every list
 * follows the signed-in user (not "Working as"):
 *
 * - AUDITOR (and the SYSTEM context): everyone;
 * - HR_ADMIN, PAYROLL_ADMIN: the employees of their companies;
 * - MANAGER: themself and their reports within `workingAs.maxDepth`;
 * - anyone else: themself.
 *
 * Soft-deleted employees never show.
 */
@Injectable()
export class PickerService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
  ) {}

  /** The caller's employee scope as a Prisma filter. */
  async employeeScope(ctx: SecurityContext): Promise<Prisma.EmployeeWhereInput> {
    if (ctx.isSystem || hasRole(ctx, 'AUDITOR')) return { deletedAt: null };
    const or: Prisma.EmployeeWhereInput[] = [];
    if (hasRole(ctx, 'HR_ADMIN', 'PAYROLL_ADMIN') && ctx.companyIds.length > 0) {
      or.push({ companyId: { in: ctx.companyIds } });
    }
    const ids: number[] = [];
    if (ctx.selfEmployeeId !== null) {
      ids.push(ctx.selfEmployeeId);
      if (hasRole(ctx, 'MANAGER')) ids.push(...(await this.scope.reportIdsWithinDepth(ctx.selfEmployeeId)));
    }
    if (ids.length > 0) or.push({ id: { in: ids } });
    // Nobody in scope: match nothing.
    return { deletedAt: null, OR: or.length > 0 ? or : [{ id: -1 }] };
  }

  /** GET /lookups/employees: paginated, never truncated. */
  async employees(ctx: SecurityContext, query: EmployeePickerQuery): Promise<EmployeePickerResponse> {
    return this.employeePage(await this.employeeScope(ctx), query);
  }

  /**
   * GET /audit/employee-options (AUDITOR, SYSTEM_ADMIN): every employee, of every company and
   * status, soft-deleted ones included, because the audit trail still names them.
   */
  auditEmployees(query: EmployeePickerQuery): Promise<EmployeePickerResponse> {
    return this.employeePage({}, query);
  }

  private async employeePage(
    scope: Prisma.EmployeeWhereInput,
    query: EmployeePickerQuery,
  ): Promise<EmployeePickerResponse> {
    const and: Prisma.EmployeeWhereInput[] = [scope];
    if (query.companyId !== undefined) and.push({ companyId: query.companyId });
    if (query.companyRuleId !== undefined) and.push({ companyRuleId: query.companyRuleId });
    if (query.status !== undefined) and.push({ status: query.status });
    if (query.hasUser !== undefined) and.push({ user: query.hasUser ? { isNot: null } : { is: null } });
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
    const where: Prisma.EmployeeWhereInput = { AND: and };
    const prisma = this.db.prisma;
    const [rows, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        select: EMPLOYEE_SELECT,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.employee.count({ where }),
    ]);
    return {
      items: rows.map((e) => ({
        id: e.id,
        employeeCode: e.employeeCode,
        firstName: e.firstName,
        lastName: e.lastName,
        knownAs: e.knownAs,
        name: `${e.firstName} ${e.lastName}`,
        companyId: e.companyId,
        companyName: e.company.name,
        companyRuleId: e.companyRuleId,
        companyRule: e.companyRule.description,
        jobTitle: e.jobTitle,
        status: e.status,
        hasUser: e.user !== null,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** The ids of the companies in scope; null = every company. */
  private async companyIds(ctx: SecurityContext): Promise<number[] | null> {
    if (ctx.isSystem || hasRole(ctx, 'AUDITOR')) return null;
    const ids = new Set<number>(hasRole(ctx, 'HR_ADMIN', 'PAYROLL_ADMIN') ? ctx.companyIds : []);
    const scoped = await this.db.prisma.employee.groupBy({
      by: ['companyId'],
      where: await this.employeeScope(ctx),
    });
    for (const row of scoped) ids.add(row.companyId);
    return [...ids];
  }

  /** GET /lookups/companies. */
  async companies(ctx: SecurityContext): Promise<CompaniesResponse> {
    const ids = await this.companyIds(ctx);
    const rows = await this.db.prisma.company.findMany({
      where: ids === null ? {} : { id: { in: ids } },
      select: { id: true, code: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { items: rows };
  }

  /** GET /lookups/company-rules?companyId=. */
  async companyRules(ctx: SecurityContext, query: CompanyRulesQuery): Promise<CompanyRulesResponse> {
    const ids = await this.companyIds(ctx);
    const and: Prisma.CompanyRuleWhereInput[] = [];
    if (ids !== null) and.push({ companyId: { in: ids } });
    if (query.companyId !== undefined) and.push({ companyId: query.companyId });
    const rows = await this.db.prisma.companyRule.findMany({
      where: { AND: and },
      select: {
        id: true,
        companyId: true,
        code: true,
        description: true,
        company: { select: { name: true } },
      },
      orderBy: [{ company: { name: 'asc' } }, { description: 'asc' }, { id: 'asc' }],
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        companyId: r.companyId,
        companyName: r.company.name,
        code: r.code,
        description: r.description,
      })),
    };
  }

  /** GET /lookups/positions: the distinct job titles of the employees in scope. */
  async positions(ctx: SecurityContext, query: PositionsQuery): Promise<PositionsResponse> {
    const and: Prisma.EmployeeWhereInput[] = [await this.employeeScope(ctx), { jobTitle: { not: null } }];
    if (query.companyId !== undefined) and.push({ companyId: query.companyId });
    if (query.search) and.push({ jobTitle: { contains: query.search, mode: 'insensitive' } });
    const rows = await this.db.prisma.employee.groupBy({
      by: ['jobTitle'],
      where: { AND: and },
      _count: { _all: true },
      orderBy: { jobTitle: 'asc' },
    });
    return {
      items: rows
        .filter(
          (r): r is typeof r & { jobTitle: string } => typeof r.jobTitle === 'string' && r.jobTitle !== '',
        )
        .map((r) => ({ jobTitle: r.jobTitle, employeeCount: r._count._all })),
    };
  }
}
