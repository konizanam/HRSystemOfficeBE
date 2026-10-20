import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { type ContractActor, REVIEW_LIVE_STATUSES, type ReviewActor } from '@peoplehub/shared';
import { hasRole, type SecurityContext } from '../../common/context/security-context';
import { ForbiddenError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { ScopeService } from '../auth/scope.service';

/** The employee fields the performance scoping rules need. */
export interface ScopedSubject {
  id: number;
  companyId: number;
}

/**
 * Data scoping of the performance module (section 4, ASSUMPTION A96):
 *
 * - HR_ADMIN manages templates, initiations, contracts and reviews of employees in their companies.
 * - AUDITOR reads everything and changes nothing.
 * - An employee sees their own contracts and their reviews once opened (not DRAFT).
 * - A reviewer sees the reviews they take part in once opened.
 * - A MANAGER sees the contracts and opened reviews of their reports (within `workingAs.maxDepth`).
 * - The user a contract is currently assigned to sees that contract.
 *
 * Scoping follows the signed-in user (not "Working as"): performance data belongs to people, and a
 * manager already sees their reports' records.
 */
@Injectable()
export class PerformanceAccess {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
  ) {}

  isAuditor(ctx: SecurityContext): boolean {
    return !!ctx.isSystem || hasRole(ctx, 'AUDITOR');
  }

  isHrFor(ctx: SecurityContext, employee: ScopedSubject | null): boolean {
    if (ctx.isSystem) return true;
    return !!employee && hasRole(ctx, 'HR_ADMIN') && ctx.companyIds.includes(employee.companyId);
  }

  isSelf(ctx: SecurityContext, employeeId: number | null): boolean {
    return employeeId !== null && ctx.selfEmployeeId !== null && employeeId === ctx.selfEmployeeId;
  }

  async isManagerOf(
    ctx: SecurityContext,
    employeeId: number | null,
    client: Tx = this.db.prisma,
  ): Promise<boolean> {
    if (employeeId === null || ctx.selfEmployeeId === null || !hasRole(ctx, 'MANAGER')) return false;
    return this.scope.isReportWithinDepth(ctx.selfEmployeeId, employeeId, undefined, client);
  }

  /** Report ids of a manager (within depth); empty for everyone else. */
  async reportIds(ctx: SecurityContext): Promise<number[]> {
    if (ctx.selfEmployeeId === null || !hasRole(ctx, 'MANAGER')) return [];
    return this.scope.reportIdsWithinDepth(ctx.selfEmployeeId);
  }

  // ───────────── Contracts ─────────────

  /** Prisma filter for the contracts the caller may read. */
  async contractWhere(ctx: SecurityContext): Promise<Prisma.PerformanceContractWhereInput> {
    if (this.isAuditor(ctx)) return {};
    const or: Prisma.PerformanceContractWhereInput[] = [{ currentlyAssignedUserId: ctx.userId }];
    if (hasRole(ctx, 'HR_ADMIN')) or.push({ employee: { companyId: { in: ctx.companyIds } } });
    if (ctx.selfEmployeeId !== null) or.push({ employeeId: ctx.selfEmployeeId });
    const reports = await this.reportIds(ctx);
    if (reports.length > 0) or.push({ employeeId: { in: reports } });
    return { OR: or };
  }

  /** The caller's roles on one contract (empty when they have none). */
  async contractActors(
    ctx: SecurityContext,
    employee: ScopedSubject,
    client: Tx = this.db.prisma,
  ): Promise<ContractActor[]> {
    const actors: ContractActor[] = [];
    if (this.isSelf(ctx, employee.id)) actors.push('EMPLOYEE');
    if (await this.isManagerOf(ctx, employee.id, client)) actors.push('MANAGER');
    if (this.isHrFor(ctx, employee)) actors.push('HR_ADMIN');
    return actors;
  }

  async canReadContract(
    ctx: SecurityContext,
    contract: { employee: ScopedSubject; currentlyAssignedUserId: string | null },
    client: Tx = this.db.prisma,
  ): Promise<boolean> {
    if (this.isAuditor(ctx) || contract.currentlyAssignedUserId === ctx.userId) return true;
    return (await this.contractActors(ctx, contract.employee, client)).length > 0;
  }

  async assertCanReadContract(
    ctx: SecurityContext,
    contract: { id: number; employee: ScopedSubject; currentlyAssignedUserId: string | null },
    client: Tx = this.db.prisma,
  ): Promise<void> {
    if (await this.canReadContract(ctx, contract, client)) return;
    throw new ForbiddenError('You do not have access to this contract', {
      subjectEmployeeId: contract.employee.id,
      metadata: { contractId: contract.id },
    });
  }

  // ───────────── Reviews ─────────────

  /** Prisma filter for the reviews the caller may read. */
  async reviewWhere(ctx: SecurityContext): Promise<Prisma.ReviewWhereInput> {
    if (this.isAuditor(ctx)) return {};
    const live: Prisma.ReviewWhereInput = { status: { in: [...REVIEW_LIVE_STATUSES] } };
    const or: Prisma.ReviewWhereInput[] = [
      { AND: [live, { participants: { some: { userId: ctx.userId, deletedAt: null } } }] },
    ];
    if (hasRole(ctx, 'HR_ADMIN')) or.push({ employee: { companyId: { in: ctx.companyIds } } });
    if (ctx.selfEmployeeId !== null) or.push({ AND: [live, { employeeId: ctx.selfEmployeeId }] });
    const reports = await this.reportIds(ctx);
    if (reports.length > 0) or.push({ AND: [live, { employeeId: { in: reports } }] });
    return { OR: or };
  }

  /**
   * The caller's roles on one review: HR_ADMIN (reviewee in their companies), REVIEWEE, REVIEWER.
   * `manager` says whether the caller manages the reviewee (a reader, never an actor).
   */
  async reviewRoles(
    ctx: SecurityContext,
    review: {
      employee: ScopedSubject | null;
      participants: { role: 'REVIEWEE' | 'REVIEWER'; userId: string | null; deletedAt: Date | null }[];
    },
    client: Tx = this.db.prisma,
  ): Promise<{ actors: ReviewActor[]; manager: boolean }> {
    const actors: ReviewActor[] = [];
    if (this.isHrFor(ctx, review.employee)) actors.push('HR_ADMIN');
    if (this.isSelf(ctx, review.employee?.id ?? null)) actors.push('REVIEWEE');
    if (
      review.participants.some(
        (p) => p.role === 'REVIEWER' && p.deletedAt === null && p.userId === ctx.userId,
      )
    )
      actors.push('REVIEWER');
    const manager = await this.isManagerOf(ctx, review.employee?.id ?? null, client);
    return { actors, manager };
  }

  /** Readers: HR in scope and auditors always; participants and managers once the review is opened. */
  canReadReview(
    ctx: SecurityContext,
    status: string,
    roles: { actors: ReviewActor[]; manager: boolean },
  ): boolean {
    if (this.isAuditor(ctx) || roles.actors.includes('HR_ADMIN')) return true;
    const live = (REVIEW_LIVE_STATUSES as readonly string[]).includes(status);
    return live && (roles.manager || roles.actors.length > 0);
  }
}
