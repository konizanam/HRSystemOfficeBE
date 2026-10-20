import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ACTING_AS_OPTIONS_LIMIT, type ActingAsOptionsResponse, type Session } from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import { hasRole, type SecurityContext } from '../../common/context/security-context';
import { ForbiddenError, NotFoundError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import { EMPLOYEE_SUMMARY_SELECT, toActingAsOption } from './employee-summary';
import { ScopeService } from './scope.service';
import { SessionService } from './session.service';

const ORDER: Prisma.EmployeeOrderByWithRelationInput[] = [
  { lastName: 'asc' },
  { firstName: 'asc' },
  { id: 'asc' },
];

/** The "Working as" picker (sections 1.1 and 4.2). */
@Injectable()
export class ActingAsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Grid rows: the user first, then reports within `workingAs.maxDepth` (MANAGER), then, for
   * HR_ADMIN, everyone else in their companies (capped at ACTING_AS_OPTIONS_LIMIT; narrow it with
   * `search`). Soft-deleted employees never appear.
   */
  async options(ctx: SecurityContext, search?: string): Promise<ActingAsOptionsResponse> {
    const reportIds =
      hasRole(ctx, 'MANAGER') && ctx.selfEmployeeId !== null
        ? await this.scope.reportIdsWithinDepth(ctx.selfEmployeeId)
        : [];
    const term = search?.trim();
    const matches: Prisma.EmployeeWhereInput = term
      ? {
          OR: [
            { firstName: { contains: term, mode: 'insensitive' } },
            { lastName: { contains: term, mode: 'insensitive' } },
            { knownAs: { contains: term, mode: 'insensitive' } },
            { employeeCode: { contains: term, mode: 'insensitive' } },
          ],
        }
      : {};

    const personal = [ctx.selfEmployeeId, ...reportIds].filter((id): id is number => id !== null);
    const rows = personal.length
      ? await this.db.prisma.employee.findMany({
          where: { id: { in: personal }, deletedAt: null, ...matches },
          select: EMPLOYEE_SUMMARY_SELECT,
          orderBy: ORDER,
        })
      : [];
    const self = rows.filter((r) => r.id === ctx.selfEmployeeId);
    const reports = rows.filter((r) => r.id !== ctx.selfEmployeeId);

    let company: typeof rows = [];
    let truncated = false;
    if (hasRole(ctx, 'HR_ADMIN') && ctx.companyIds.length) {
      company = await this.db.prisma.employee.findMany({
        where: {
          companyId: { in: ctx.companyIds },
          deletedAt: null,
          id: { notIn: personal },
          ...matches,
        },
        select: EMPLOYEE_SUMMARY_SELECT,
        orderBy: ORDER,
        take: ACTING_AS_OPTIONS_LIMIT + 1,
      });
      truncated = company.length > ACTING_AS_OPTIONS_LIMIT;
      company = company.slice(0, ACTING_AS_OPTIONS_LIMIT);
    }

    return {
      items: [...self, ...reports, ...company].map((e) => toActingAsOption(e, ctx.selfEmployeeId)),
      truncated,
    };
  }

  /**
   * PUT /session/acting-as: validates the target with ScopeService.canActFor, stores it on the
   * Session row and audits SECURITY.ACTING_AS_CHANGED. Returns the refreshed session.
   */
  async set(ctx: SecurityContext, employeeId: number): Promise<Session> {
    const exists = await this.db.prisma.employee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: { id: true },
    });
    if (!exists) throw new NotFoundError('Employee');
    if (!(await this.scope.canActFor(ctx, employeeId))) {
      throw new ForbiddenError('You cannot work as this employee', {
        subjectEmployeeId: employeeId,
        metadata: { requestedEmployeeId: employeeId, action: 'SECURITY.ACTING_AS_CHANGED' },
      });
    }
    const from = ctx.actingAsEmployeeId || null;
    if (from !== employeeId) {
      await this.db.tx(ctx, async (tx) => {
        await tx.session.update({ where: { id: ctx.sessionId }, data: { actingAsEmployeeId: employeeId } });
        this.audit.record(tx, ctx, {
          category: 'SECURITY',
          action: 'SECURITY.ACTING_AS_CHANGED',
          entityType: 'Session',
          entityId: ctx.sessionId,
          subjectEmployeeId: employeeId,
          metadata: { from, to: employeeId, self: ctx.selfEmployeeId },
        });
      });
    }
    return this.sessions.describe({ ...ctx, actingAsEmployeeId: employeeId });
  }
}
