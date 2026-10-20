import { hasRole, type SecurityContext } from '../../common/context/security-context';
import { ForbiddenError } from '../../common/errors/domain-errors';

/**
 * Company scope of the admin API (section 4.2, ASSUMPTION B14): HR and Payroll admins administer
 * the companies in `ctx.companyIds`; system admins read every company; the SYSTEM context passes.
 */
export function inCompanyScope(ctx: SecurityContext, companyId: number): boolean {
  return !!ctx.isSystem || ctx.companyIds.includes(companyId);
}

/** Reads: HR/Payroll in scope, or a system admin (organisation structure only, no pay data). */
export function canReadCompany(ctx: SecurityContext, companyId: number): boolean {
  return inCompanyScope(ctx, companyId) || hasRole(ctx, 'SYSTEM_ADMIN');
}

/** 403 (audited DENIED by ProblemFilter) unless the company is in the caller's admin scope. */
export function assertCompanyScope(
  ctx: SecurityContext,
  companyId: number,
  subjectEmployeeId?: number,
): void {
  if (inCompanyScope(ctx, companyId)) return;
  throw new ForbiddenError('This company is outside your administration scope', {
    subjectEmployeeId: subjectEmployeeId ?? null,
    metadata: { companyId },
  });
}

/** The companies a list may show: all for the SYSTEM context and system admins, else the scope. */
export function companyFilter(ctx: SecurityContext): number[] | undefined {
  if (ctx.isSystem || hasRole(ctx, 'SYSTEM_ADMIN')) return undefined;
  return ctx.companyIds;
}
