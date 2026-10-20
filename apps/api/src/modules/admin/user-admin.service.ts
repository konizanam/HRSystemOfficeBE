import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, Role, User } from '@prisma/client';
import {
  ADMIN_USER_SORTS,
  type AdminUser,
  type AdminUsersQuery,
  type AdminUsersResponse,
  AUTH_POLICY,
  type CreateUserRequest,
  type DeactivateUserResponse,
  type UpdateUserRequest,
  type UpdateUserRolesRequest,
  USER_EMPLOYEE_OPTIONS_LIMIT,
  type UserActionRequest,
  type UserEmployeeOptionsQuery,
  type UserEmployeeOptionsResponse,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import { type SecurityContext, SYSTEM_USER_ID } from '../../common/context/security-context';
import {
  assertVersion,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { greetingName, webUrl } from '../auth/auth.service';
import { hashToken, isLocked, randomToken } from '../auth/auth-policy';
import { PasswordService } from '../auth/password.service';
import { SessionService } from '../auth/session.service';
import { MailService } from '../notifications/mail.service';
import { WorkflowEngine } from '../workflow/workflow-engine.service';

const MINUTE_MS = 60_000;

export const ADMIN_USER_INCLUDE = {
  employee: {
    select: { id: true, employeeCode: true, firstName: true, lastName: true, companyId: true, status: true },
  },
} satisfies Prisma.UserInclude;

type UserRow = Prisma.UserGetPayload<{ include: typeof ADMIN_USER_INCLUDE }>;

export function toAdminUser(u: UserRow, now = new Date()): AdminUser {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    authProvider: u.authProvider,
    externalSubject: u.externalSubject,
    roles: u.roles,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    hasPassword: !!u.passwordHash,
    isLocked: isLocked(u, now),
    lockedUntil: u.lockedUntil && isLocked(u, now) ? u.lockedUntil.toISOString() : null,
    failedLoginCount: u.failedLoginCount,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    passwordChangedAt: u.passwordChangedAt?.toISOString() ?? null,
    mfaEnabled: !!u.mfaEnabledAt,
    employee: u.employee
      ? {
          id: u.employee.id,
          employeeCode: u.employee.employeeCode,
          name: `${u.employee.firstName} ${u.employee.lastName}`,
          companyId: u.employee.companyId,
          status: u.employee.status,
        }
      : null,
    version: u.version,
    createdAt: u.createdAt.toISOString(),
  };
}

/** The user row without relations, for audit snapshots (secrets are redacted by the writer). */
function plain(u: UserRow | User): User {
  const { employee: _e, ...rest } = u as UserRow;
  return rest;
}

/**
 * User administration (section 12.10, SYSTEM_ADMIN): local or OAuth users, roles (each grant and
 * revoke audited SECURITY.ROLE_GRANTED / ROLE_REVOKED), activation, the employee link, unlock,
 * an emailed password reset that also forces a change, and MFA reset. A system admin cannot
 * change their own roles or deactivate themselves, and the last active system admin stays.
 */
@Injectable()
export class UserAdminService {
  private readonly logger = new Logger(UserAdminService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly mail: MailService,
    private readonly engine: WorkflowEngine,
  ) {}

  async list(query: AdminUsersQuery): Promise<AdminUsersResponse> {
    const now = new Date();
    const where: Prisma.UserWhereInput = {
      id: { not: SYSTEM_USER_ID },
      ...(query.role ? { roles: { has: query.role } } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.authProvider ? { authProvider: query.authProvider } : {}),
      ...(query.locked === true ? { lockedUntil: { gt: now } } : {}),
      ...(query.locked === false ? { OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] } : {}),
    };
    const search = query.search
      ? {
          OR: [
            { username: { contains: query.search, mode: 'insensitive' as const } },
            { email: { contains: query.search, mode: 'insensitive' as const } },
            { employee: { employeeCode: { contains: query.search, mode: 'insensitive' as const } } },
            { employee: { firstName: { contains: query.search, mode: 'insensitive' as const } } },
            { employee: { lastName: { contains: query.search, mode: 'insensitive' as const } } },
          ],
        }
      : {};
    const filter: Prisma.UserWhereInput = { AND: [where, search] };
    const [field, direction] = (query.sort ?? 'username:asc').split(':') as [string, 'asc' | 'desc'];
    if (!(ADMIN_USER_SORTS as readonly string[]).includes(field)) {
      throw ValidationError.field('sort', `Sort by one of ${ADMIN_USER_SORTS.join(', ')}`);
    }
    const [total, rows] = await Promise.all([
      this.db.prisma.user.count({ where: filter }),
      this.db.prisma.user.findMany({
        where: filter,
        include: ADMIN_USER_INCLUDE,
        orderBy: [{ [field]: direction }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: rows.map((u) => toAdminUser(u, now)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(id: string): Promise<AdminUser> {
    return toAdminUser(await this.load(this.db.prisma, id));
  }

  /** Employees without a login, for the link picker. */
  async employeeOptions(query: UserEmployeeOptionsQuery): Promise<UserEmployeeOptionsResponse> {
    const rows = await this.db.prisma.employee.findMany({
      where: {
        deletedAt: null,
        user: null,
        ...(query.search
          ? {
              OR: [
                { employeeCode: { contains: query.search, mode: 'insensitive' } },
                { firstName: { contains: query.search, mode: 'insensitive' } },
                { lastName: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        status: true,
        company: { select: { name: true } },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
      take: USER_EMPLOYEE_OPTIONS_LIMIT,
    });
    return {
      items: rows.map((e) => ({
        id: e.id,
        employeeCode: e.employeeCode,
        name: `${e.firstName} ${e.lastName}`,
        companyName: e.company.name,
        status: e.status,
      })),
    };
  }

  async create(ctx: SecurityContext, input: CreateUserRequest): Promise<AdminUser> {
    const passwordHash =
      input.authProvider === 'LOCAL' && input.initialPassword
        ? await this.checkedHash(input.username, input.initialPassword)
        : null;
    const { user, token } = await this.db.tx(ctx, async (tx) =>
      this.createInTx(tx, ctx, input, passwordHash),
    );
    if (token && user.email) this.sendResetLink(user, token);
    return toAdminUser(user);
  }

  /**
   * Shared by POST /admin/users and the employee import. A LOCAL user without an initial
   * password gets a set-password token (returned, so the caller emails it after commit).
   */
  async createInTx(
    tx: Tx,
    ctx: SecurityContext,
    input: CreateUserRequest,
    passwordHash: string | null,
    audit: { metadata?: Record<string, unknown> } = {},
  ): Promise<{ user: UserRow; token: string | null }> {
    await this.checkIdentityFree(tx, null, {
      username: input.username,
      email: input.email,
      externalSubject: input.authProvider === 'OAUTH' ? input.externalSubject : null,
    });
    if (input.employeeId !== null) await this.checkEmployeeLinkable(tx, null, input.employeeId);
    const now = new Date();
    const created = await tx.user.create({
      data: {
        username: input.username,
        email: input.email,
        authProvider: input.authProvider,
        externalSubject: input.authProvider === 'OAUTH' ? input.externalSubject : null,
        roles: input.roles,
        employeeId: input.employeeId,
        passwordHash,
        passwordChangedAt: passwordHash ? now : null,
        mustChangePassword: input.authProvider === 'LOCAL',
      },
      include: ADMIN_USER_INCLUDE,
    });
    if (passwordHash) await tx.passwordHistory.create({ data: { userId: created.id, hash: passwordHash } });
    this.audit.record(tx, ctx, {
      category: 'SECURITY',
      action: 'SECURITY.USER_CREATED',
      entityType: 'User',
      entityId: created.id,
      subjectEmployeeId: created.employeeId,
      after: plain(created),
      metadata: { roles: created.roles, authProvider: created.authProvider, ...audit.metadata },
    });
    for (const role of created.roles) {
      this.audit.record(tx, ctx, {
        category: 'SECURITY',
        action: 'SECURITY.ROLE_GRANTED',
        entityType: 'User',
        entityId: created.id,
        subjectEmployeeId: created.employeeId,
        metadata: { role, username: created.username },
      });
    }
    const token =
      input.authProvider === 'LOCAL' && !passwordHash && created.email
        ? await this.issueResetToken(tx, ctx, created, 'CREATED')
        : null;
    return { user: created, token };
  }

  async update(ctx: SecurityContext, id: string, input: UpdateUserRequest): Promise<AdminUser> {
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lock(tx, id);
      assertVersion(before, input.version);
      const data: Prisma.UserUncheckedUpdateInput = {};
      if (input.email !== undefined) data.email = input.email;
      if (input.externalSubject !== undefined) {
        if (before.authProvider !== 'OAUTH' && input.externalSubject !== null) {
          throw ValidationError.field(
            'externalSubject',
            'Only OAuth users have an identity provider subject',
          );
        }
        data.externalSubject = input.externalSubject;
      }
      await this.checkIdentityFree(tx, id, {
        email: input.email ?? null,
        externalSubject: input.externalSubject ?? null,
      });
      if (input.employeeId !== undefined && input.employeeId !== before.employeeId) {
        if (input.employeeId !== null) await this.checkEmployeeLinkable(tx, id, input.employeeId);
        data.employeeId = input.employeeId;
      }
      const after = await tx.user.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
        include: ADMIN_USER_INCLUDE,
      });
      const linkChanged = after.employeeId !== before.employeeId;
      this.audit.record(tx, ctx, {
        category: 'SECURITY',
        action: linkChanged
          ? after.employeeId === null
            ? 'SECURITY.USER_EMPLOYEE_UNLINKED'
            : 'SECURITY.USER_EMPLOYEE_LINKED'
          : 'SECURITY.USER_UPDATED',
        entityType: 'User',
        entityId: id,
        subjectEmployeeId: after.employeeId ?? before.employeeId,
        before: plain(before),
        after: plain(after),
        metadata: linkChanged
          ? { fromEmployeeId: before.employeeId, toEmployeeId: after.employeeId }
          : undefined,
      });
      return toAdminUser(after);
    });
  }

  /** PUT /admin/users/:id/roles: one ROLE_GRANTED / ROLE_REVOKED row per role that changed. */
  async setRoles(ctx: SecurityContext, id: string, input: UpdateUserRolesRequest): Promise<AdminUser> {
    if (id === ctx.userId) throw ValidationError.field('roles', 'You cannot change your own roles');
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lock(tx, id);
      assertVersion(before, input.version);
      const after = await this.applyRoles(tx, ctx, before, input.roles, input.reason ?? null);
      return toAdminUser(after);
    });
  }

  /** Writes the new role set and audits each change; shared with the employee import. */
  async applyRoles(
    tx: Tx,
    ctx: SecurityContext,
    before: UserRow,
    roles: Role[],
    reason: string | null,
    metadata: Record<string, unknown> = {},
  ): Promise<UserRow> {
    const granted = roles.filter((r) => !before.roles.includes(r));
    const revoked = before.roles.filter((r) => !roles.includes(r));
    if (granted.length === 0 && revoked.length === 0) return before;
    if (revoked.includes('SYSTEM_ADMIN')) await this.assertAnotherSystemAdmin(tx, before.id);
    const after = await tx.user.update({
      where: { id: before.id },
      data: { roles, version: { increment: 1 } },
      include: ADMIN_USER_INCLUDE,
    });
    for (const [action, list] of [
      ['SECURITY.ROLE_GRANTED', granted],
      ['SECURITY.ROLE_REVOKED', revoked],
    ] as const) {
      for (const role of list) {
        this.audit.record(tx, ctx, {
          category: 'SECURITY',
          action,
          entityType: 'User',
          entityId: before.id,
          subjectEmployeeId: before.employeeId,
          before: { roles: before.roles },
          after: { roles: after.roles },
          reason,
          metadata: { role, username: before.username, ...metadata },
        });
      }
    }
    return after;
  }

  async activate(ctx: SecurityContext, id: string, input: UserActionRequest): Promise<AdminUser> {
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lock(tx, id);
      assertVersion(before, input.version);
      if (before.isActive) throw ValidationError.field('', 'This user is already active');
      if (before.employee?.status === 'TERMINATED') {
        throw ValidationError.field('', 'The linked employee is terminated; reinstate the employee first');
      }
      const after = await tx.user.update({
        where: { id },
        data: { isActive: true, version: { increment: 1 } },
        include: ADMIN_USER_INCLUDE,
      });
      this.audit.record(tx, ctx, {
        category: 'SECURITY',
        action: 'SECURITY.USER_ACTIVATED',
        entityType: 'User',
        entityId: id,
        subjectEmployeeId: before.employeeId,
        before: plain(before),
        after: plain(after),
        reason: input.reason ?? null,
      });
      return toAdminUser(after);
    });
  }

  /** Deactivates the user, ends their sessions and moves their open approval steps (section 7.5). */
  async deactivate(
    ctx: SecurityContext,
    id: string,
    input: UserActionRequest,
  ): Promise<DeactivateUserResponse> {
    if (id === ctx.userId) throw ValidationError.field('', 'You cannot deactivate yourself');
    const done = await this.db.tx(ctx, async (tx) => {
      const before = await this.lock(tx, id);
      assertVersion(before, input.version);
      if (!before.isActive) throw ValidationError.field('', 'This user is already inactive');
      if (before.roles.includes('SYSTEM_ADMIN')) await this.assertAnotherSystemAdmin(tx, id);
      const after = await tx.user.update({
        where: { id },
        data: { isActive: false, version: { increment: 1 } },
        include: ADMIN_USER_INCLUDE,
      });
      const sessionsRevoked = await this.sessions.revokeAllForUser(tx, id);
      this.audit.record(tx, ctx, {
        category: 'SECURITY',
        action: 'SECURITY.USER_DEACTIVATED',
        entityType: 'User',
        entityId: id,
        subjectEmployeeId: before.employeeId,
        before: plain(before),
        after: plain(after),
        reason: input.reason ?? null,
        metadata: { sessionsRevoked },
      });
      return { after, sessionsRevoked };
    });
    let moved = { reassigned: 0, unresolved: 0 };
    try {
      moved = await this.engine.reresolveForUser(id);
    } catch (err) {
      this.logger.error({ err, userId: id }, 'Re-resolving approval steps failed');
    }
    return {
      user: toAdminUser(await this.load(this.db.prisma, id)),
      sessionsRevoked: done.sessionsRevoked,
      stepsReassigned: moved.reassigned,
      stepsUnresolved: moved.unresolved,
    };
  }

  /** POST /admin/users/:id/unlock: clears the lockout and the failure counter. */
  async unlock(ctx: SecurityContext, id: string, input: UserActionRequest): Promise<AdminUser> {
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lock(tx, id);
      assertVersion(before, input.version);
      const after = await tx.user.update({
        where: { id },
        data: { lockedUntil: null, failedLoginCount: 0, version: { increment: 1 } },
        include: ADMIN_USER_INCLUDE,
      });
      this.audit.record(tx, ctx, {
        category: 'AUTH',
        action: 'AUTH.ACCOUNT_UNLOCKED',
        entityType: 'User',
        entityId: id,
        subjectEmployeeId: before.employeeId,
        before: plain(before),
        after: plain(after),
        reason: input.reason ?? null,
        metadata: { wasLocked: isLocked(before, new Date()), failedLoginCount: before.failedLoginCount },
      });
      return toAdminUser(after);
    });
  }

  /**
   * POST /admin/users/:id/reset-password: emails a single-use reset link (30 minutes), forces a
   * password change at the next sign-in and ends the user's sessions. LOCAL users with an email
   * only.
   */
  async resetPassword(ctx: SecurityContext, id: string, input: UserActionRequest): Promise<AdminUser> {
    const { user, token } = await this.db.tx(ctx, async (tx) => {
      const before = await this.lock(tx, id);
      assertVersion(before, input.version);
      if (before.authProvider !== 'LOCAL') {
        throw ValidationError.field('', 'OAuth users reset their password with the identity provider');
      }
      if (!before.email) throw ValidationError.field('', 'The user has no email address for the reset link');
      if (!before.isActive) throw ValidationError.field('', 'Activate the user first');
      const after = await tx.user.update({
        where: { id },
        data: { mustChangePassword: true, version: { increment: 1 } },
        include: ADMIN_USER_INCLUDE,
      });
      const sessionsRevoked = await this.sessions.revokeAllForUser(tx, id);
      const issued = await this.issueResetToken(tx, ctx, after, 'ADMIN_RESET', input.reason ?? null, {
        sessionsRevoked,
      });
      return { user: after, token: issued };
    });
    this.sendResetLink(user, token);
    return toAdminUser(user);
  }

  /** POST /admin/users/:id/reset-mfa: turns MFA off so the user can enrol again. */
  async resetMfa(ctx: SecurityContext, id: string, input: UserActionRequest): Promise<AdminUser> {
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lock(tx, id);
      assertVersion(before, input.version);
      if (!before.mfaSecretEnc && !before.mfaEnabledAt) {
        throw ValidationError.field('', 'Multi-factor sign-in is not set up for this user');
      }
      const after = await tx.user.update({
        where: { id },
        data: { mfaSecretEnc: null, mfaEnabledAt: null, version: { increment: 1 } },
        include: ADMIN_USER_INCLUDE,
      });
      this.audit.record(tx, ctx, {
        category: 'AUTH',
        action: 'AUTH.MFA_RESET',
        entityType: 'User',
        entityId: id,
        subjectEmployeeId: before.employeeId,
        before: plain(before),
        after: plain(after),
        reason: input.reason ?? null,
        metadata: { via: 'ADMIN' },
      });
      return toAdminUser(after);
    });
  }

  // ───────────── Building blocks ─────────────

  /** Hashes an initial password after the policy check (outside the transaction: argon2 is slow). */
  async checkedHash(username: string, password: string): Promise<string> {
    await this.passwords.assertAcceptable(
      this.db.prisma,
      { id: '00000000-0000-0000-0000-00000000ffff', username, passwordHash: null },
      password,
      'initialPassword',
    );
    return this.passwords.hash(password);
  }

  private async issueResetToken(
    tx: Tx,
    ctx: SecurityContext,
    user: UserRow,
    via: 'CREATED' | 'ADMIN_RESET',
    reason: string | null = null,
    metadata: Record<string, unknown> = {},
  ): Promise<string> {
    const now = new Date();
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + AUTH_POLICY.resetTokenMinutes * MINUTE_MS);
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now },
    });
    const row = await tx.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt },
    });
    this.audit.record(tx, ctx, {
      category: 'AUTH',
      action: 'AUTH.PASSWORD_RESET_REQUESTED',
      entityType: 'PasswordResetToken',
      entityId: row.id,
      subjectEmployeeId: user.employeeId,
      reason,
      metadata: { userId: user.id, via, expiresAt: expiresAt.toISOString(), ...metadata },
    });
    return token;
  }

  private sendResetLink(
    user: { email: string | null; employee: { firstName: string } | null },
    token: string,
  ): void {
    if (!user.email) return;
    this.mail.sendInBackground({
      to: user.email,
      template: 'password-reset',
      data: {
        firstName: greetingName(user),
        link: `${webUrl()}/reset-password?token=${encodeURIComponent(token)}`,
        expiresMinutes: AUTH_POLICY.resetTokenMinutes,
      },
    });
  }

  private async load(client: Tx, id: string): Promise<UserRow> {
    if (id === SYSTEM_USER_ID) throw new NotFoundError('User');
    const row = await client.user.findUnique({ where: { id }, include: ADMIN_USER_INCLUDE });
    if (!row) throw new NotFoundError('User');
    return row;
  }

  async lock(tx: Tx, id: string): Promise<UserRow> {
    if (id === SYSTEM_USER_ID || !/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError('User');
    await this.db.lockRow(tx, 'User', id);
    return this.load(tx, id);
  }

  async checkIdentityFree(
    tx: Tx,
    userId: string | null,
    identity: { username?: string; email: string | null; externalSubject: string | null },
  ): Promise<void> {
    const others = { ...(userId ? { id: { not: userId } } : {}) };
    if (identity.username) {
      const clash = await tx.user.findFirst({
        where: { ...others, username: { equals: identity.username, mode: 'insensitive' } },
        select: { id: true },
      });
      if (clash) throw new ConflictError(`The username ${identity.username} is already in use`);
    }
    if (identity.email) {
      const clash = await tx.user.findFirst({
        where: { ...others, email: { equals: identity.email, mode: 'insensitive' } },
        select: { id: true },
      });
      if (clash) throw new ConflictError('This email address is already used by another user');
    }
    if (identity.externalSubject) {
      const clash = await tx.user.findFirst({
        where: { ...others, externalSubject: identity.externalSubject },
        select: { id: true },
      });
      if (clash) throw new ConflictError('This identity provider subject is already linked to another user');
    }
  }

  async checkEmployeeLinkable(tx: Tx, userId: string | null, employeeId: number): Promise<void> {
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: { id: true, user: { select: { id: true } } },
    });
    if (!employee) throw ValidationError.field('employeeId', 'Unknown employee');
    if (employee.user && employee.user.id !== userId) {
      throw new ConflictError('This employee is already linked to another user');
    }
  }

  private async assertAnotherSystemAdmin(tx: Tx, userId: string): Promise<void> {
    const others = await tx.user.count({
      where: { id: { notIn: [userId, SYSTEM_USER_ID] }, isActive: true, roles: { has: 'SYSTEM_ADMIN' } },
    });
    if (others === 0) throw ValidationError.field('roles', 'Keep at least one active system administrator');
  }
}
