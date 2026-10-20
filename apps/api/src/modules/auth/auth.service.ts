import { Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import {
  AUTH_POLICY,
  AUTH_PROBLEM_TYPES,
  type ChangePasswordRequest,
  type LoginRequest,
  type LoginResponse,
  type ResetPasswordRequest,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { AuditActor, RequestMeta, SecurityContext } from '../../common/context/security-context';
import { UnauthorizedError, ValidationError } from '../../common/errors/domain-errors';
import { env } from '../../config/env';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { MailService } from '../notifications/mail.service';
import {
  hashToken,
  isLocked,
  lockMinutesRemaining,
  randomToken,
  registerFailure,
  registerSuccess,
} from './auth-policy';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { ScopeService } from './scope.service';
import { type NewSession, SessionService } from './session.service';

const MINUTE_MS = 60_000;
const INVALID_CREDENTIALS = 'The username or password is incorrect';

export interface LoginResult {
  response: LoginResponse;
  /** Set when a session was opened; the controller writes the cookies. */
  session: NewSession | null;
}

type UserWithEmployee = User & { employee: { firstName: string; knownAs: string | null } | null };

/** Greeting name for email: the employee's first name only (section 6: no other PII). */
export function greetingName(user: { employee: { firstName: string } | null }): string {
  return user.employee?.firstName ?? 'there';
}

/**
 * Local sign-in, lockout and password lifecycle (section 4.3). Failures are audited with the
 * attempted username only, never the password, and with no actor (the caller is not
 * authenticated); the targeted account is the audit entity.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly scope: ScopeService,
    private readonly mail: MailService,
  ) {}

  async login(input: LoginRequest, meta: RequestMeta, now = new Date()): Promise<LoginResult> {
    const anonymous: AuditActor = { ...meta };
    const user = await this.findByUsername(input.username);

    if (!user || user.authProvider !== 'LOCAL' || !user.passwordHash || !user.isActive) {
      await this.passwords.verifyDummy(input.password);
      await this.audit.recordStandalone(anonymous, {
        category: 'AUTH',
        action: 'AUTH.LOGIN_FAILURE',
        outcome: 'FAILURE',
        entityType: user ? 'User' : null,
        entityId: user?.id ?? null,
        subjectEmployeeId: user?.employeeId ?? null,
        reason: !user ? 'UNKNOWN_USER' : !user.isActive ? 'INACTIVE' : 'NOT_A_LOCAL_ACCOUNT',
        metadata: { username: input.username, provider: 'LOCAL' },
      });
      throw this.invalidCredentials();
    }

    if (isLocked(user, now)) {
      await this.audit.recordStandalone(anonymous, {
        category: 'AUTH',
        action: 'AUTH.LOGIN_FAILURE',
        outcome: 'FAILURE',
        entityType: 'User',
        entityId: user.id,
        subjectEmployeeId: user.employeeId,
        reason: 'LOCKED',
        metadata: { username: input.username, provider: 'LOCAL' },
      });
      throw this.locked(lockMinutesRemaining(user, now));
    }

    const passwordOk = await this.passwords.verify(user.passwordHash, input.password);
    if (!passwordOk) {
      await this.recordFailure(user, input.username, 'BAD_PASSWORD', meta, now);
    }

    if (this.mfa.isEnabled(user)) {
      if (!input.totp) return { response: { status: 'MFA_REQUIRED' }, session: null };
      if (!this.mfa.checkCode(user, input.totp)) {
        await this.recordFailure(user, input.username, 'BAD_MFA_CODE', meta, now);
      }
    }

    const rehash = this.passwords.needsRehash(user.passwordHash)
      ? await this.passwords.hash(input.password)
      : null;
    const session = await this.openSession(
      user,
      meta,
      { provider: 'LOCAL', mfa: this.mfa.isEnabled(user) },
      now,
      (tx) =>
        tx.user.update({
          where: { id: user.id },
          data: { ...registerSuccess(), lastLoginAt: now, ...(rehash ? { passwordHash: rehash } : {}) },
        }),
    );
    const auth = await this.sessions.authenticate(session.token, meta, now);
    const described = await this.sessions.describe(auth.ctx);
    return {
      response: user.mustChangePassword
        ? { status: 'PASSWORD_CHANGE_REQUIRED', session: described }
        : { status: 'OK', session: described },
      session,
    };
  }

  /**
   * Opens a session for an authenticated user and audits AUTH.LOGIN_SUCCESS in one transaction.
   * Shared by local and OIDC sign-in.
   */
  async openSession(
    user: { id: string; username: string; employeeId: number | null },
    meta: RequestMeta,
    metadata: Record<string, unknown>,
    now: Date,
    updateUser: (tx: Tx) => Promise<unknown>,
  ): Promise<NewSession> {
    return this.db.tx({ ...meta, userId: user.id, username: user.username }, async (tx) => {
      await updateUser(tx);
      const session = await this.sessions.create(tx, user, meta, now);
      const actor: AuditActor = {
        ...meta,
        userId: user.id,
        username: user.username,
        sessionId: session.sessionId,
        actingAsEmployeeId: user.employeeId,
      };
      this.audit.record(tx, actor, {
        category: 'AUTH',
        action: 'AUTH.LOGIN_SUCCESS',
        entityType: 'User',
        entityId: user.id,
        subjectEmployeeId: user.employeeId,
        metadata,
      });
      return session;
    });
  }

  async logout(ctx: SecurityContext): Promise<void> {
    await this.sessions.logout(ctx);
  }

  /** POST /auth/password/change. Blocked while working as someone else (PASSWORD feature). */
  async changePassword(ctx: SecurityContext, input: ChangePasswordRequest): Promise<void> {
    await this.scope.assertNotRestricted(ctx, 'PASSWORD');
    const user = await this.db.prisma.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      include: { employee: { select: { firstName: true, knownAs: true } } },
    });
    if (user.authProvider !== 'LOCAL' || !user.passwordHash) {
      throw ValidationError.field('', 'Passwords for OAuth accounts are managed by your identity provider');
    }
    if (!(await this.passwords.verify(user.passwordHash, input.currentPassword))) {
      await this.audit.recordStandalone(ctx, {
        category: 'AUTH',
        action: 'AUTH.PASSWORD_CHANGE_FAILED',
        outcome: 'FAILURE',
        entityType: 'User',
        entityId: user.id,
        subjectEmployeeId: user.employeeId,
        reason: 'Current password is incorrect',
      });
      throw ValidationError.field('currentPassword', 'Your current password is incorrect');
    }
    // The history check runs argon2 several times, so it stays outside the transaction.
    await this.passwords.assertAcceptable(this.db.prisma, user, input.newPassword);
    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.db.tx(ctx, async (tx) => {
      const revoked = await this.setPassword(tx, user, passwordHash, ctx.sessionId);
      this.audit.record(tx, ctx, {
        category: 'AUTH',
        action: 'AUTH.PASSWORD_CHANGED',
        entityType: 'User',
        entityId: user.id,
        subjectEmployeeId: user.employeeId,
        metadata: { via: 'CHANGE', otherSessionsRevoked: revoked, wasRequired: user.mustChangePassword },
      });
    });
    this.notifyPasswordChanged(user);
  }

  /**
   * POST /auth/password/forgot. The answer never says whether the account exists: unknown,
   * inactive and OAuth accounts are audited and otherwise ignored, and the email is sent in the
   * background so the response time does not differ.
   */
  async forgotPassword(usernameOrEmail: string, meta: RequestMeta, now = new Date()): Promise<void> {
    const identifier = usernameOrEmail.trim();
    const user = await this.db.prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: identifier, mode: 'insensitive' } },
          { email: { equals: identifier, mode: 'insensitive' } },
        ],
      },
      include: { employee: { select: { firstName: true, knownAs: true } } },
    });
    const eligible = !!user && user.isActive && user.authProvider === 'LOCAL' && !!user.email;
    if (!user || !eligible) {
      await this.audit.recordStandalone(meta, {
        category: 'AUTH',
        action: 'AUTH.PASSWORD_RESET_REQUESTED',
        outcome: 'FAILURE',
        entityType: user ? 'User' : null,
        entityId: user?.id ?? null,
        subjectEmployeeId: user?.employeeId ?? null,
        reason: !user ? 'UNKNOWN_ACCOUNT' : 'NOT_ELIGIBLE',
        metadata: { usernameOrEmail: identifier },
      });
      return;
    }
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + AUTH_POLICY.resetTokenMinutes * MINUTE_MS);
    await this.db.tx({ ...meta }, async (tx) => {
      // Only the newest link works.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null, expiresAt: { gt: now } },
        data: { expiresAt: now },
      });
      const row = await tx.passwordResetToken.create({
        data: { userId: user.id, tokenHash: hashToken(token), expiresAt },
      });
      this.audit.record(tx, meta, {
        category: 'AUTH',
        action: 'AUTH.PASSWORD_RESET_REQUESTED',
        entityType: 'PasswordResetToken',
        entityId: row.id,
        subjectEmployeeId: user.employeeId,
        metadata: { userId: user.id, expiresAt: expiresAt.toISOString() },
      });
    });
    this.mail.sendInBackground({
      to: user.email as string,
      template: 'password-reset',
      data: {
        firstName: greetingName(user),
        link: `${webUrl()}/reset-password?token=${encodeURIComponent(token)}`,
        expiresMinutes: AUTH_POLICY.resetTokenMinutes,
      },
    });
  }

  /** POST /auth/password/reset. Single use; signs out every session and clears any lock. */
  async resetPassword(input: ResetPasswordRequest, meta: RequestMeta, now = new Date()): Promise<void> {
    const invalid = () => ValidationError.field('token', 'This reset link is invalid or has expired');
    const tokenHash = hashToken(input.token);
    const found = await this.db.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: { include: { employee: { select: { firstName: true, knownAs: true } } } } },
    });
    if (!found || found.usedAt || found.expiresAt <= now || !found.user.isActive) throw invalid();
    const user = found.user;
    await this.passwords.assertAcceptable(this.db.prisma, user, input.newPassword);
    const passwordHash = await this.passwords.hash(input.newPassword);
    const actor: AuditActor = { ...meta, userId: user.id, username: user.username };
    await this.db.tx(actor, async (tx) => {
      // Claim the token first so two concurrent resets cannot both succeed.
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: found.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count === 0) throw invalid();
      const revoked = await this.setPassword(tx, user, passwordHash);
      this.audit.record(tx, actor, {
        category: 'AUTH',
        action: 'AUTH.PASSWORD_CHANGED',
        entityType: 'User',
        entityId: user.id,
        subjectEmployeeId: user.employeeId,
        metadata: { via: 'RESET', resetTokenId: found.id, sessionsRevoked: revoked },
      });
    });
    this.notifyPasswordChanged(user);
  }

  private async setPassword(
    tx: Tx,
    user: User,
    passwordHash: string,
    keepSessionId?: string,
  ): Promise<number> {
    const now = new Date();
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordChangedAt: now,
        mustChangePassword: false,
        ...registerSuccess(),
        version: { increment: 1 },
      },
    });
    await tx.passwordHistory.create({ data: { userId: user.id, hash: passwordHash } });
    return this.sessions.revokeAllForUser(tx, user.id, keepSessionId, now);
  }

  /** Counts a failure (and locks on the fifth), audits it, emails on lock, then throws 401. */
  private async recordFailure(
    user: UserWithEmployee,
    attemptedUsername: string,
    reason: 'BAD_PASSWORD' | 'BAD_MFA_CODE',
    meta: RequestMeta,
    now: Date,
  ): Promise<never> {
    const outcome = await this.db.tx({ ...meta }, async (tx) => {
      // Re-read under a row lock so concurrent failures are all counted.
      await this.db.lockRow(tx, 'User', user.id);
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      const next = registerFailure(current, now);
      const after = await tx.user.update({
        where: { id: user.id },
        data: { failedLoginCount: next.failedLoginCount, lockedUntil: next.lockedUntil },
      });
      const base = {
        entityType: 'User',
        entityId: user.id,
        subjectEmployeeId: user.employeeId,
        metadata: { username: attemptedUsername, provider: 'LOCAL', failedLoginCount: next.failedLoginCount },
      } as const;
      this.audit.record(tx, meta, {
        ...base,
        category: 'AUTH',
        action: 'AUTH.LOGIN_FAILURE',
        outcome: 'FAILURE',
        reason,
        before: current,
        after,
      });
      if (next.lockedNow) {
        this.audit.record(tx, meta, {
          ...base,
          category: 'AUTH',
          action: 'AUTH.ACCOUNT_LOCKED',
          outcome: 'SUCCESS',
          reason: `${AUTH_POLICY.lockoutThreshold} consecutive failed sign-ins`,
          metadata: { ...base.metadata, lockedUntil: next.lockedUntil?.toISOString() },
        });
      }
      return next;
    });
    if (outcome.lockedNow) {
      if (user.email) {
        this.mail.sendInBackground({
          to: user.email,
          template: 'account-locked',
          data: {
            firstName: greetingName(user),
            minutes: AUTH_POLICY.lockoutMinutes,
            link: `${webUrl()}/forgot-password`,
          },
        });
      }
      throw this.locked(AUTH_POLICY.lockoutMinutes);
    }
    throw this.invalidCredentials();
  }

  private notifyPasswordChanged(user: UserWithEmployee): void {
    if (!user.email) return;
    this.mail.sendInBackground({
      to: user.email,
      template: 'password-changed',
      data: { firstName: greetingName(user), link: `${webUrl()}/login` },
    });
  }

  private findByUsername(username: string): Promise<UserWithEmployee | null> {
    return this.db.prisma.user.findFirst({
      where: { username: { equals: username.trim(), mode: 'insensitive' } },
      include: { employee: { select: { firstName: true, knownAs: true } } },
    });
  }

  private invalidCredentials(): UnauthorizedError {
    return new UnauthorizedError(
      INVALID_CREDENTIALS,
      { alreadyAudited: true },
      AUTH_PROBLEM_TYPES.invalidCredentials,
    );
  }

  private locked(minutes: number): UnauthorizedError {
    return new UnauthorizedError(
      `Your account is locked after too many failed sign-ins. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      { alreadyAudited: true },
      AUTH_PROBLEM_TYPES.accountLocked,
    );
  }
}

/** Base URL of the web app for links in email. */
export function webUrl(): string {
  return env().PUBLIC_URL.replace(/\/+$/, '');
}
