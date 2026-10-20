import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import {
  formalName,
  USER_OPTIONS_LIMIT,
  type UserOption,
  type UserOptionsResponse,
  type WorkflowPerson,
} from '@peoplehub/shared';
import { type SecurityContext, SYSTEM_USER_ID } from '../../common/context/security-context';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';

/** Prisma select for everything a WorkflowPerson shows. */
export const PERSON_USER_SELECT = {
  id: true,
  username: true,
  email: true,
  roles: true,
  isActive: true,
  employee: {
    select: {
      id: true,
      employeeCode: true,
      title: true,
      initials: true,
      firstName: true,
      lastName: true,
      companyId: true,
      reportsToId: true,
      status: true,
      deletedAt: true,
    },
  },
} satisfies Prisma.UserSelect;

export type PersonUserRow = Prisma.UserGetPayload<{ select: typeof PERSON_USER_SELECT }>;

export function toWorkflowPerson(user: PersonUserRow): WorkflowPerson {
  if (user.id === SYSTEM_USER_ID) {
    return { userId: user.id, employeeId: null, employeeCode: null, name: 'System', displayName: 'System' };
  }
  const e = user.employee;
  if (!e) {
    return {
      userId: user.id,
      employeeId: null,
      employeeCode: null,
      name: user.username,
      displayName: user.username,
    };
  }
  return {
    userId: user.id,
    employeeId: e.id,
    employeeCode: e.employeeCode,
    name: formalName(e) || `${e.firstName} ${e.lastName}`,
    displayName: `${e.firstName} ${e.lastName}`,
  };
}

/** A person known only by an id that no longer resolves (should not happen; keeps rendering safe). */
export function unknownPerson(userId: string): WorkflowPerson {
  return { userId, employeeId: null, employeeCode: null, name: 'Unknown user', displayName: 'Unknown user' };
}

/**
 * Whether a user can be given work: an active login whose employee record (if any) is ACTIVE
 * and not deleted (section 7.5: terminated or deactivated approvers are replaced).
 */
export function isAvailable(user: Pick<PersonUserRow, 'id' | 'isActive' | 'employee'>): boolean {
  if (user.id === SYSTEM_USER_ID || !user.isActive) return false;
  const e = user.employee;
  return !e || (e.status === 'ACTIVE' && e.deletedAt === null);
}

/** `where` for users who can be given work in a company (they need an employee record there). */
export function availableInCompany(companyId: number): Prisma.UserWhereInput {
  return {
    isActive: true,
    id: { not: SYSTEM_USER_ID },
    employee: { companyId, status: 'ACTIVE', deletedAt: null },
  };
}

/** Loads and formats people involved in workflows. */
@Injectable()
export class WorkflowPeopleService {
  constructor(private readonly db: DbService) {}

  async byIds(client: Tx, ids: Iterable<string | null | undefined>): Promise<Map<string, WorkflowPerson>> {
    const unique = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))];
    if (unique.length === 0) return new Map();
    const rows = await client.user.findMany({ where: { id: { in: unique } }, select: PERSON_USER_SELECT });
    return new Map(rows.map((r) => [r.id, toWorkflowPerson(r)]));
  }

  async rows(client: Tx, ids: Iterable<string>): Promise<Map<string, PersonUserRow>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await client.user.findMany({ where: { id: { in: unique } }, select: PERSON_USER_SELECT });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Active users with the role in the company (ROLE resolution, section 7.1). */
  async withRole(client: Tx, role: Role, companyId: number): Promise<string[]> {
    const rows = await client.user.findMany({
      where: { ...availableInCompany(companyId), roles: { has: role } },
      select: { id: true },
      orderBy: { username: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  /** The user of an employee, when that user can be given work. */
  async userOfEmployee(client: Tx, employeeId: number | null): Promise<string | null> {
    if (employeeId === null) return null;
    const user = await client.user.findFirst({
      where: { employeeId },
      select: PERSON_USER_SELECT,
    });
    return user && isAvailable(user) ? user.id : null;
  }

  /** Companies whose people the caller may pick (own company, or the admin's company scope). */
  private async pickerCompanies(ctx: SecurityContext): Promise<number[]> {
    if (ctx.selfEmployeeId !== null) {
      const self = await this.db.prisma.employee.findUnique({
        where: { id: ctx.selfEmployeeId },
        select: { companyId: true },
      });
      if (self) return [self.companyId];
    }
    return ctx.companyIds;
  }

  /**
   * People the caller may reassign a step to or nominate while out of office: active users with
   * an employee record in the caller's company, excluding the caller.
   */
  async userOptions(ctx: SecurityContext, search: string | undefined): Promise<UserOptionsResponse> {
    const companies = await this.pickerCompanies(ctx);
    if (companies.length === 0) return { items: [], truncated: false };
    const where: Prisma.UserWhereInput = {
      isActive: true,
      id: { notIn: [SYSTEM_USER_ID, ctx.userId] },
      employee: { companyId: { in: companies }, status: 'ACTIVE', deletedAt: null },
    };
    if (search) {
      where.OR = [
        { username: { contains: search, mode: 'insensitive' } },
        { employee: { firstName: { contains: search, mode: 'insensitive' } } },
        { employee: { lastName: { contains: search, mode: 'insensitive' } } },
        { employee: { employeeCode: { contains: search, mode: 'insensitive' } } },
      ];
    }
    const rows = await this.db.prisma.user.findMany({
      where,
      select: PERSON_USER_SELECT,
      orderBy: [{ employee: { lastName: 'asc' } }, { employee: { firstName: 'asc' } }, { username: 'asc' }],
      take: USER_OPTIONS_LIMIT + 1,
    });
    const items: UserOption[] = rows.slice(0, USER_OPTIONS_LIMIT).map((row) => {
      const p = toWorkflowPerson(row);
      return {
        userId: row.id,
        name: p.name,
        displayName: p.displayName,
        employeeCode: p.employeeCode,
        roles: row.roles,
      };
    });
    return { items, truncated: rows.length > USER_OPTIONS_LIMIT };
  }
}
