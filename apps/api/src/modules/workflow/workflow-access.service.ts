import { Injectable } from '@nestjs/common';
import { hasRole, type SecurityContext } from '../../common/context/security-context';
import { ForbiddenError } from '../../common/errors/domain-errors';
import type { Tx } from '../../prisma/prisma-client';

/** The process fields the read rules need. */
export interface AccessTarget {
  id: number;
  subjectEmployeeId: number;
  submittedByUserId: string;
  companyId: number;
}

/**
 * Who may see and act on a workflow process (section 12.7):
 *
 * - the applicant: the subject employee, the submitter, or someone currently "Working as" the
 *   subject (the session re-validates that choice on every request);
 * - approvers: anyone a step was assigned to, delegated from, or acted on by;
 * - HR and Payroll admins of the subject's company, and auditors (read only).
 *
 * Acting on a step is decided by the engine (only a current assignee can act).
 */
@Injectable()
export class WorkflowAccessService {
  isApplicant(
    ctx: SecurityContext,
    p: Pick<AccessTarget, 'subjectEmployeeId' | 'submittedByUserId'>,
  ): boolean {
    return (
      ctx.userId === p.submittedByUserId ||
      (ctx.selfEmployeeId !== null && ctx.selfEmployeeId === p.subjectEmployeeId) ||
      ctx.actingAsEmployeeId === p.subjectEmployeeId
    );
  }

  async isApprover(client: Tx, ctx: SecurityContext, processId: number): Promise<boolean> {
    const count = await client.workflowStepInstance.count({
      where: {
        processId,
        OR: [
          { assigneeUserId: ctx.userId },
          { delegatedFromUserId: ctx.userId },
          { actedByUserId: ctx.userId },
        ],
      },
    });
    return count > 0;
  }

  isAdminInScope(ctx: SecurityContext, p: Pick<AccessTarget, 'companyId'>): boolean {
    return hasRole(ctx, 'HR_ADMIN', 'PAYROLL_ADMIN') && ctx.companyIds.includes(p.companyId);
  }

  async canRead(client: Tx, ctx: SecurityContext, p: AccessTarget): Promise<boolean> {
    if (ctx.isSystem || this.isApplicant(ctx, p)) return true;
    if (hasRole(ctx, 'AUDITOR') || this.isAdminInScope(ctx, p)) return true;
    return this.isApprover(client, ctx, p.id);
  }

  /** 403 (audited DENIED by ProblemFilter) unless the caller may read the process. */
  async assertCanRead(client: Tx, ctx: SecurityContext, p: AccessTarget): Promise<void> {
    if (await this.canRead(client, ctx, p)) return;
    throw new ForbiddenError('You do not have access to this request', {
      subjectEmployeeId: p.subjectEmployeeId,
      metadata: { processId: p.id },
    });
  }
}
