import { hasRole, type SecurityContext } from '../../common/context/security-context';
import { NotFoundError } from '../../common/errors/domain-errors';
import type { Tx } from '../../prisma/prisma-client';
import type { AccessPurpose, ScopeService } from '../auth/scope.service';

/**
 * Who may read an employee's claims (lists, details, balances): the employee or someone
 * "Working as" them, their manager, HR/Payroll of their company, and auditors (read only).
 * System admins are not claim readers (section 4.1).
 */
export const CLAIM_READ_PURPOSES: AccessPurpose[] = ['SELF_SERVICE', 'TEAM', 'HR_READ'];

export async function canReadClaims(
  scope: ScopeService,
  ctx: SecurityContext,
  employeeId: number,
  client?: Tx,
): Promise<boolean> {
  if (hasRole(ctx, 'AUDITOR')) return true;
  return scope.canAccessAny(ctx, employeeId, CLAIM_READ_PURPOSES, client);
}

/** 404 for a missing employee, 403 (audited DENIED) when the caller may not read their claims. */
export async function assertCanReadClaims(
  scope: ScopeService,
  ctx: SecurityContext,
  employeeId: number,
  client?: Tx,
): Promise<void> {
  if (hasRole(ctx, 'AUDITOR')) {
    if (!(await scope.canAccessAny(ctx, employeeId, ['AUDIT'], client))) throw new NotFoundError('Employee');
    return;
  }
  await scope.assertCanAccessAny(ctx, employeeId, CLAIM_READ_PURPOSES, client);
}
