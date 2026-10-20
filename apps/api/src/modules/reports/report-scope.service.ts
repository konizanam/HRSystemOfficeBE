import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Role } from '@peoplehub/shared';
import type { SecurityContext } from '../../common/context/security-context';
import { ForbiddenError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import { ScopeService } from '../auth/scope.service';

/** Who a report may cover for this caller. */
export type ReportPopulation = { all: true } | { all: false; companyIds: number[]; employeeIds: number[] };

export interface PopulationFilters {
  companyRuleIds?: number[];
  employeeIds?: number[];
  includeTerminated?: boolean;
}

/**
 * Report scoping (section 5.7: "every report is scoped by the caller's security context"). The
 * caller's roles that the report accepts each add employees (ASSUMPTION, see docs):
 *
 * - AUDITOR, SYSTEM_ADMIN (audit reports only): everyone;
 * - HR_ADMIN, PAYROLL_ADMIN: the employees of their companies;
 * - MANAGER: themself and their reports within `workingAs.maxDepth`;
 * - EMPLOYEE: themself only.
 *
 * Reports use the signed-in user's own scope, not the "Working as" employee's.
 */
@Injectable()
export class ReportScopeService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
  ) {}

  async population(ctx: SecurityContext, requiredRoles: readonly Role[]): Promise<ReportPopulation> {
    const roles = requiredRoles.filter((r) => ctx.roles.includes(r));
    if (ctx.isSystem || roles.includes('AUDITOR') || roles.includes('SYSTEM_ADMIN')) return { all: true };
    const companyIds = roles.some((r) => r === 'HR_ADMIN' || r === 'PAYROLL_ADMIN')
      ? [...ctx.companyIds]
      : [];
    const employeeIds = new Set<number>();
    if (ctx.selfEmployeeId !== null && (roles.includes('EMPLOYEE') || roles.includes('MANAGER'))) {
      employeeIds.add(ctx.selfEmployeeId);
    }
    if (ctx.selfEmployeeId !== null && roles.includes('MANAGER')) {
      for (const id of await this.scope.reportIdsWithinDepth(ctx.selfEmployeeId)) employeeIds.add(id);
    }
    return { all: false, companyIds, employeeIds: [...employeeIds] };
  }

  /** The population as an Employee filter, without the params' narrowing. */
  scopeWhere(population: ReportPopulation): Prisma.EmployeeWhereInput {
    if (population.all) return { deletedAt: null };
    return {
      deletedAt: null,
      OR: [{ companyId: { in: population.companyIds } }, { id: { in: population.employeeIds } }],
    };
  }

  /** The population narrowed by the params' company rules, employees and "include terminated". */
  employeeWhere(population: ReportPopulation, filters: PopulationFilters): Prisma.EmployeeWhereInput {
    return {
      AND: [
        this.scopeWhere(population),
        filters.includeTerminated ? {} : { status: { not: 'TERMINATED' } },
        filters.companyRuleIds ? { companyRuleId: { in: filters.companyRuleIds } } : {},
        filters.employeeIds ? { id: { in: filters.employeeIds } } : {},
      ],
    };
  }

  /** 403 (audited DENIED) when a selected employee is outside the caller's scope. */
  async assertEmployeesInScope(
    population: ReportPopulation,
    employeeIds: readonly number[] | undefined,
    report: string,
  ): Promise<void> {
    if (!employeeIds || employeeIds.length === 0 || population.all) return;
    const unique = [...new Set(employeeIds)];
    const inScope = await this.db.prisma.employee.findMany({
      where: { AND: [this.scopeWhere(population), { id: { in: unique } }] },
      select: { id: true },
    });
    if (inScope.length === unique.length) return;
    const allowed = new Set(inScope.map((e) => e.id));
    const outside = unique.filter((id) => !allowed.has(id));
    throw new ForbiddenError('A selected employee is outside the employees you may report on', {
      subjectEmployeeId: outside.length === 1 ? (outside[0] ?? null) : null,
      metadata: { report, employeeIds: outside },
    });
  }
}
