import { Injectable } from '@nestjs/common';
import type { Role } from '@prisma/client';
import {
  type ActivityResponse,
  APP_VERSION,
  AUTH_POLICY,
  AUTH_PROBLEM_TYPES,
  CSRF_COOKIE,
  type Session as SessionDto,
  SESSION_COOKIE,
} from '@peoplehub/shared';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply } from 'fastify';
import { AuditService } from '../../audit/audit.service';
import {
  type AuditActor,
  hasRole,
  isActingForOther,
  type RequestMeta,
  type SecurityContext,
} from '../../common/context/security-context';
import { UnauthorizedError } from '../../common/errors/domain-errors';
import { env } from '../../config/env';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { SettingsService } from '../settings/settings.service';
import { hashToken, randomToken, sessionDeadline } from './auth-policy';
import { attachmentUrl, EMPLOYEE_SUMMARY_SELECT, toEmployeeSummary } from './employee-summary';
import { ScopeService } from './scope.service';

const HOUR_MS = 3_600_000;

/** What the guard needs besides the SecurityContext. */
export interface AuthenticatedSession {
  ctx: SecurityContext;
  csrfToken: string;
  mustChangePassword: boolean;
}

export interface NewSession {
  /** The cookie value. Only its sha256 is stored (as Session.id). */
  token: string;
  sessionId: string;
  csrfToken: string;
}

/**
 * Database-backed sessions (section 4.3). The `ph_session` cookie holds a random token whose
 * sha256 is the Session id, so neither the database nor the audit trail holds a usable cookie.
 * Sessions end after `session.idleMinutes` without activity or 12 hours after sign-in.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly scope: ScopeService,
  ) {}

  /** Opens a session inside the sign-in transaction. */
  async create(
    tx: Tx,
    user: { id: string; employeeId: number | null },
    meta: RequestMeta,
    now = new Date(),
  ): Promise<NewSession> {
    const token = randomToken();
    const csrfToken = randomToken();
    const sessionId = hashToken(token);
    await tx.session.create({
      data: {
        id: sessionId,
        userId: user.id,
        csrfToken,
        actingAsEmployeeId: user.employeeId,
        ip: meta.ip,
        userAgent: meta.userAgent.slice(0, 500),
        createdAt: now,
        lastActivityAt: now,
        expiresAt: new Date(now.getTime() + AUTH_POLICY.sessionAbsoluteHours * HOUR_MS),
      },
    });
    return { token, sessionId, csrfToken };
  }

  /**
   * Resolves the session cookie into a SecurityContext. Throws 401 when the session is unknown,
   * revoked, timed out (audited AUTH.SESSION_TIMEOUT) or belongs to a deactivated user. A stored
   * "Working as" choice that is no longer permitted falls back to self.
   */
  async authenticate(token: string, meta: RequestMeta, now = new Date()): Promise<AuthenticatedSession> {
    const sessionId = hashToken(token);
    const session = await this.db.prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            roles: true,
            isActive: true,
            mustChangePassword: true,
            employee: { select: { id: true, companyId: true, deletedAt: true } },
          },
        },
      },
    });
    if (!session || session.revokedAt) throw new UnauthorizedError('Your session has ended. Sign in again.');

    const idleMinutes = await this.settings.get('session.idleMinutes');
    const deadline = sessionDeadline(session, idleMinutes);
    if (deadline.at.getTime() <= now.getTime()) {
      await this.endSession(
        session.id,
        {
          ...meta,
          userId: session.user.id,
          username: session.user.username,
          sessionId: session.id,
          actingAsEmployeeId: session.actingAsEmployeeId,
        },
        {
          action: 'AUTH.SESSION_TIMEOUT',
          reason: deadline.reason === 'IDLE' ? 'Idle timeout' : 'Absolute session lifetime reached',
          metadata: {
            reason: deadline.reason,
            idleMinutes,
            lastActivityAt: session.lastActivityAt.toISOString(),
            expiresAt: session.expiresAt.toISOString(),
          },
        },
        now,
      );
      throw new UnauthorizedError(
        'Your session has expired. Sign in again.',
        { alreadyAudited: true },
        AUTH_PROBLEM_TYPES.sessionExpired,
      );
    }

    const user = session.user;
    if (!user.isActive) {
      await this.db.prisma.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now },
      });
      throw new UnauthorizedError('Your account is not active');
    }

    const employee = user.employee && !user.employee.deletedAt ? user.employee : null;
    const selfEmployeeId = employee?.id ?? null;
    const ctx: SecurityContext = {
      userId: user.id,
      username: user.username,
      roles: user.roles,
      selfEmployeeId,
      actingAsEmployeeId: session.actingAsEmployeeId ?? selfEmployeeId ?? 0,
      companyIds: await this.companyScope(user.roles, employee),
      sessionId: session.id,
      requestId: meta.requestId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    };

    if (isActingForOther(ctx) && !(await this.scope.canActFor(ctx, ctx.actingAsEmployeeId))) {
      const from = ctx.actingAsEmployeeId;
      ctx.actingAsEmployeeId = selfEmployeeId ?? 0;
      await this.db.tx(ctx, async (tx) => {
        await tx.session.update({ where: { id: session.id }, data: { actingAsEmployeeId: selfEmployeeId } });
        this.audit.record(tx, ctx, {
          category: 'SECURITY',
          action: 'SECURITY.ACTING_AS_CHANGED',
          entityType: 'Session',
          entityId: session.id,
          subjectEmployeeId: selfEmployeeId,
          reason: 'No longer permitted to work as this employee',
          metadata: { from, to: selfEmployeeId, automatic: true },
        });
      });
    }

    return { ctx, csrfToken: session.csrfToken, mustChangePassword: user.mustChangePassword };
  }

  /** Records activity (heartbeat and every state-changing request). */
  async touch(sessionId: string, now = new Date()): Promise<void> {
    await this.db.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { lastActivityAt: now },
    });
  }

  /** POST /session/activity: the new idle deadline. */
  async activity(ctx: SecurityContext): Promise<ActivityResponse> {
    const session = await this.db.prisma.session.findUniqueOrThrow({ where: { id: ctx.sessionId } });
    const idleMinutes = await this.settings.get('session.idleMinutes');
    return { expiresAt: sessionDeadline(session, idleMinutes).at.toISOString(), idleMinutes };
  }

  /** Logout: revokes the session and audits AUTH.LOGOUT. */
  async logout(ctx: SecurityContext): Promise<void> {
    await this.endSession(ctx.sessionId, ctx, { action: 'AUTH.LOGOUT' });
  }

  /** Revokes every other session of a user (after a password change or reset). Returns the count. */
  async revokeAllForUser(
    tx: Tx,
    userId: string,
    exceptSessionId?: string,
    now = new Date(),
  ): Promise<number> {
    const result = await tx.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: now },
    });
    return result.count;
  }

  /** Revokes the session presented with a sign-in request, so a new sign-in never reuses one. */
  async revokeToken(token: string | undefined, now = new Date()): Promise<void> {
    if (!token) return;
    await this.db.prisma.session.updateMany({
      where: { id: hashToken(token), revokedAt: null },
      data: { revokedAt: now },
    });
  }

  /** GET /session. */
  async describe(ctx: SecurityContext): Promise<SessionDto> {
    const session = await this.db.prisma.session.findUniqueOrThrow({
      where: { id: ctx.sessionId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            roles: true,
            authProvider: true,
            mustChangePassword: true,
            mfaEnabledAt: true,
          },
        },
      },
    });
    const ids = [ctx.selfEmployeeId, ctx.actingAsEmployeeId].filter((id): id is number => !!id);
    const employees = ids.length
      ? await this.db.prisma.employee.findMany({
          where: { id: { in: ids } },
          select: EMPLOYEE_SUMMARY_SELECT,
        })
      : [];
    const byId = new Map(employees.map((e) => [e.id, toEmployeeSummary(e)]));
    const settings = await this.settings.getAll();
    const user = session.user;
    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        roles: user.roles,
        authProvider: user.authProvider,
        mustChangePassword: user.mustChangePassword,
        mfaEnabled: !!user.mfaEnabledAt,
      },
      selfEmployee: (ctx.selfEmployeeId && byId.get(ctx.selfEmployeeId)) || null,
      actingAs: byId.get(ctx.actingAsEmployeeId) ?? null,
      isActingForOther: isActingForOther(ctx),
      restrictedFeatures: await this.scope.restrictedFeatures(ctx),
      csrfToken: session.csrfToken,
      expiresAt: sessionDeadline(session, settings['session.idleMinutes']).at.toISOString(),
      settings: {
        idleMinutes: settings['session.idleMinutes'],
        warnSeconds: settings['session.warnSeconds'],
        dateFormat: settings['ui.dateFormat'],
        accentColour: settings['ui.accentColour'],
        companyLogoUrl: attachmentUrl(settings['company.logoAttachmentId']),
        helpUrl: settings['ui.helpUrl'],
      },
      appVersion: APP_VERSION,
    };
  }

  setCookies(reply: FastifyReply, session: Pick<NewSession, 'token' | 'csrfToken'>): void {
    void reply.setCookie(SESSION_COOKIE, session.token, { ...cookieBase(), httpOnly: true });
    void reply.setCookie(CSRF_COOKIE, session.csrfToken, { ...cookieBase(), httpOnly: false });
  }

  clearCookies(reply: FastifyReply): void {
    const { maxAge: _maxAge, ...base } = cookieBase();
    void reply.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true });
    void reply.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false });
  }

  /**
   * Company scope (section 4.2) for HR and Payroll admins: the company of their own employee
   * record. ASSUMPTION B14: an admin without an employee record administers every company.
   */
  private async companyScope(roles: Role[], employee: { companyId: number } | null): Promise<number[]> {
    if (!hasRole({ roles }, 'HR_ADMIN', 'PAYROLL_ADMIN')) return [];
    if (employee) return [employee.companyId];
    const companies = await this.db.prisma.company.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    return companies.map((c) => c.id);
  }

  private async endSession(
    sessionId: string,
    actor: AuditActor,
    entry: { action: string; reason?: string; metadata?: Record<string, unknown> },
    now = new Date(),
  ): Promise<void> {
    await this.db.tx(actor, async (tx) => {
      const ended = await tx.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: now },
      });
      // Two requests racing on the same expired session audit it once.
      if (ended.count === 0) return;
      const session = await tx.session.findUniqueOrThrow({ where: { id: sessionId } });
      this.audit.record(tx, actor, {
        category: 'AUTH',
        action: entry.action,
        entityType: 'Session',
        entityId: sessionId,
        subjectEmployeeId: session.actingAsEmployeeId,
        reason: entry.reason ?? null,
        metadata: entry.metadata,
      });
    });
  }
}

function cookieBase(): CookieSerializeOptions & { maxAge: number } {
  return {
    path: '/',
    sameSite: 'lax',
    secure: env().COOKIE_SECURE,
    maxAge: AUTH_POLICY.sessionAbsoluteHours * 3600,
  };
}
