import { Injectable } from '@nestjs/common';
import { RESTRICTED_FEATURE_LABELS, AUTH_PROBLEM_TYPES, type RestrictedFeature } from '@peoplehub/shared';
import { hasRole, isActingForOther, type SecurityContext } from '../../common/context/security-context';
import { ForbiddenError, NotFoundError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { SettingsService } from '../settings/settings.service';

/**
 * Why the caller wants an employee's data. Each purpose has its own rule:
 *
 * | purpose        | allowed when                                                                 |
 * | -------------- | ---------------------------------------------------------------------------- |
 * | `SELF_SERVICE` | the employee is the caller, a report within `workingAs.maxDepth` (MANAGER),   |
 * |                | or in the caller's companies (HR_ADMIN): the "Working as" rule (section 4.2)  |
 * | `TEAM`         | the employee is a report within `workingAs.maxDepth` of the caller (MANAGER)  |
 * | `HR_READ`      | HR_ADMIN or PAYROLL_ADMIN, employee in the caller's companies                 |
 * | `HR_WRITE`     | HR_ADMIN, employee in the caller's companies                                  |
 * | `PAYROLL`      | PAYROLL_ADMIN, employee in the caller's companies                             |
 * | `AUDIT`        | AUDITOR or SYSTEM_ADMIN (all companies, read-only)                            |
 *
 * The SYSTEM context (jobs) passes every check.
 */
export type AccessPurpose = 'SELF_SERVICE' | 'TEAM' | 'HR_READ' | 'HR_WRITE' | 'PAYROLL' | 'AUDIT';

/** The employee fields every scope rule needs; returned by `assertCanAccessEmployee`. */
export interface ScopedEmployee {
  id: number;
  companyId: number;
  companyRuleId: number;
  reportsToId: number | null;
}

const SCOPED_SELECT = { id: true, companyId: true, companyRuleId: true, reportsToId: true } as const;

/**
 * Data-scoping helpers (section 4). Every module checks employee access through this service
 * instead of writing its own rules, and never trusts an employee id from the client unchecked.
 * Inside a transaction, pass its client as `client` so the check does not need a second pooled
 * connection while the transaction holds locks.
 */
@Injectable()
export class ScopeService {
  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Ids of the direct and indirect reports of `managerEmployeeId`, down to `depth` levels
   * (default `workingAs.maxDepth`). Soft-deleted employees are skipped, and a reporting cycle
   * cannot loop because the walk stops at `depth`.
   */
  async reportIdsWithinDepth(managerEmployeeId: number, depth?: number): Promise<number[]> {
    const maxDepth = depth ?? (await this.settings.get('workingAs.maxDepth'));
    if (maxDepth < 1) return [];
    const rows = await this.db.prisma.$queryRaw<{ id: number }[]>`
      WITH RECURSIVE reports AS (
        SELECT e.id, 1 AS depth FROM "Employee" e
        WHERE e."reportsToId" = ${managerEmployeeId} AND e."deletedAt" IS NULL
        UNION
        SELECT e.id, r.depth + 1 FROM "Employee" e
        JOIN reports r ON e."reportsToId" = r.id
        WHERE r.depth < ${maxDepth} AND e."deletedAt" IS NULL
      )
      SELECT DISTINCT id FROM reports WHERE id <> ${managerEmployeeId} ORDER BY id`;
    return rows.map((r) => r.id);
  }

  /**
   * True when `employeeId` reports to `managerEmployeeId` within `depth` levels. Walks up the
   * chain from the employee, which is cheaper than listing every report.
   */
  async isReportWithinDepth(
    managerEmployeeId: number,
    employeeId: number,
    depth?: number,
    client: Tx = this.db.prisma,
  ): Promise<boolean> {
    const maxDepth = depth ?? (await this.settings.get('workingAs.maxDepth'));
    if (maxDepth < 1 || managerEmployeeId === employeeId) return false;
    let current: number | null = employeeId;
    for (let level = 0; level < maxDepth && current !== null; level++) {
      const row: { reportsToId: number | null } | null = await client.employee.findFirst({
        where: { id: current, deletedAt: null },
        select: { reportsToId: true },
      });
      current = row?.reportsToId ?? null;
      if (current === managerEmployeeId) return true;
    }
    return false;
  }

  /**
   * The "Working as" rule (section 4.2): self, a report within `workingAs.maxDepth` (MANAGER), or
   * anyone in the caller's companies (HR_ADMIN).
   */
  async canActFor(ctx: SecurityContext, employeeId: number, client: Tx = this.db.prisma): Promise<boolean> {
    if (ctx.isSystem) return true;
    if (ctx.selfEmployeeId !== null && employeeId === ctx.selfEmployeeId) return true;
    const employee = await this.findEmployee(employeeId, client);
    if (!employee) return false;
    return this.allows(ctx, employee, 'SELF_SERVICE', client);
  }

  /**
   * Loads the employee and checks the caller may access it for `purpose`. Throws 404 when the
   * employee does not exist and 403 (audited as DENIED by ProblemFilter) when it is out of scope.
   */
  async assertCanAccessEmployee(
    ctx: SecurityContext,
    employeeId: number,
    purpose: AccessPurpose,
    client: Tx = this.db.prisma,
  ): Promise<ScopedEmployee> {
    const employee = await this.findEmployee(employeeId, client);
    if (!employee) throw new NotFoundError('Employee');
    if (!(await this.allows(ctx, employee, purpose, client))) {
      throw new ForbiddenError('You do not have access to this employee', {
        subjectEmployeeId: employee.id,
        metadata: { purpose, employeeId: employee.id },
      });
    }
    return employee;
  }

  /**
   * True when any of `purposes` allows the caller to access the employee (for example a leave
   * record that the employee, their manager, HR or an auditor may read). False when the employee
   * does not exist.
   */
  async canAccessAny(
    ctx: SecurityContext,
    employeeId: number,
    purposes: AccessPurpose[],
    client: Tx = this.db.prisma,
  ): Promise<boolean> {
    if (ctx.isSystem) return true;
    const employee = await this.findEmployee(employeeId, client);
    if (!employee) return false;
    for (const purpose of purposes) {
      if (await this.allows(ctx, employee, purpose, client)) return true;
    }
    return false;
  }

  /** Like {@link canAccessAny} but throws 404 for a missing employee and 403 (audited) otherwise. */
  async assertCanAccessAny(
    ctx: SecurityContext,
    employeeId: number,
    purposes: AccessPurpose[],
    client: Tx = this.db.prisma,
  ): Promise<ScopedEmployee> {
    const employee = await this.findEmployee(employeeId, client);
    if (!employee) throw new NotFoundError('Employee');
    for (const purpose of purposes) {
      if (await this.allows(ctx, employee, purpose, client)) return employee;
    }
    throw new ForbiddenError('You do not have access to this employee', {
      subjectEmployeeId: employee.id,
      metadata: { purposes, employeeId: employee.id },
    });
  }

  /** Features blocked right now: the configured list while acting for someone else, else none. */
  async restrictedFeatures(ctx: SecurityContext): Promise<RestrictedFeature[]> {
    if (!isActingForOther(ctx)) return [];
    return this.settings.get('workingAs.restrictedFeatures');
  }

  /**
   * Refuses a feature that is blocked while working as someone else (section 4.2), for example
   * payslips or password changes. Returns 403; ProblemFilter writes the DENIED audit row with the
   * feature in its metadata.
   */
  async assertNotRestricted(ctx: SecurityContext, feature: RestrictedFeature): Promise<void> {
    const restricted = await this.restrictedFeatures(ctx);
    if (!restricted.includes(feature)) return;
    throw new ForbiddenError(
      `${RESTRICTED_FEATURE_LABELS[feature]} is not available while working as someone else`,
      { subjectEmployeeId: ctx.actingAsEmployeeId, metadata: { feature, restricted: true } },
      AUTH_PROBLEM_TYPES.restrictedFeature,
    );
  }

  private findEmployee(id: number, client: Tx = this.db.prisma): Promise<ScopedEmployee | null> {
    return client.employee.findFirst({ where: { id, deletedAt: null }, select: SCOPED_SELECT });
  }

  private inCompanies(ctx: SecurityContext, employee: ScopedEmployee): boolean {
    return ctx.companyIds.includes(employee.companyId);
  }

  private async allows(
    ctx: SecurityContext,
    employee: ScopedEmployee,
    purpose: AccessPurpose,
    client: Tx = this.db.prisma,
  ): Promise<boolean> {
    if (ctx.isSystem) return true;
    const isSelf = ctx.selfEmployeeId !== null && employee.id === ctx.selfEmployeeId;
    const isReport = async () =>
      hasRole(ctx, 'MANAGER') &&
      ctx.selfEmployeeId !== null &&
      this.isReportWithinDepth(ctx.selfEmployeeId, employee.id, undefined, client);
    switch (purpose) {
      case 'SELF_SERVICE':
        return isSelf || (hasRole(ctx, 'HR_ADMIN') && this.inCompanies(ctx, employee)) || (await isReport());
      case 'TEAM':
        return isReport();
      case 'HR_READ':
        return hasRole(ctx, 'HR_ADMIN', 'PAYROLL_ADMIN') && this.inCompanies(ctx, employee);
      case 'HR_WRITE':
        return hasRole(ctx, 'HR_ADMIN') && this.inCompanies(ctx, employee);
      case 'PAYROLL':
        return hasRole(ctx, 'PAYROLL_ADMIN') && this.inCompanies(ctx, employee);
      case 'AUDIT':
        return hasRole(ctx, 'AUDITOR', 'SYSTEM_ADMIN');
    }
  }
}
