import { hasRole, type SecurityContext } from '../../common/context/security-context';
import { NotFoundError } from '../../common/errors/domain-errors';
import type { Tx } from '../../prisma/prisma-client';
import type { AccessPurpose, ScopeService } from '../auth/scope.service';

/**
 * Who may read an employee's leave (applications, balances): the employee or someone "Working as"
 * them, their manager, HR/Payroll of their company, and auditors (read only). System admins are
 * not leave readers (section 4.1).
 */
export const LEAVE_READ_PURPOSES: AccessPurpose[] = ['SELF_SERVICE', 'TEAM', 'HR_READ'];

export async function canReadLeave(
  scope: ScopeService,
  ctx: SecurityContext,
  employeeId: number,
  client?: Tx,
): Promise<boolean> {
  if (hasRole(ctx, 'AUDITOR')) return true;
  return scope.canAccessAny(ctx, employeeId, LEAVE_READ_PURPOSES, client);
}

/** 404 for a missing employee, 403 (audited DENIED) when the caller may not read their leave. */
export async function assertCanReadLeave(
  scope: ScopeService,
  ctx: SecurityContext,
  employeeId: number,
  client?: Tx,
): Promise<void> {
  if (hasRole(ctx, 'AUDITOR')) {
    if (!(await scope.canAccessAny(ctx, employeeId, ['AUDIT'], client))) throw new NotFoundError('Employee');
    return;
  }
  await scope.assertCanAccessAny(ctx, employeeId, LEAVE_READ_PURPOSES, client);
}
