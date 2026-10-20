import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_PROBLEM_TYPES, CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@peoplehub/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError, UnauthorizedError } from '../../common/errors/domain-errors';
import { requestMeta } from '../../common/http/request';
import { safeEqual } from './auth-policy';
import { ALLOW_PENDING_PASSWORD_CHANGE_KEY, IS_PUBLIC_KEY } from './decorators';
import { type AuthenticatedSession, SessionService } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Global guard (APP_GUARD). Every route needs a valid session unless it is marked `@Public()`.
 * It resolves `request.securityContext`, enforces CSRF double-submit on unsafe methods (the
 * `x-csrf-token` header must equal the `ph_csrf` cookie and the session's token), blocks
 * everything but password change, session and logout while a password change is required, and
 * records activity for state-changing requests.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedError();

    let auth: AuthenticatedSession;
    try {
      auth = await this.sessions.authenticate(token, requestMeta(req));
    } catch (err) {
      if (err instanceof UnauthorizedError) this.sessions.clearCookies(reply);
      throw err;
    }
    req.securityContext = auth.ctx;

    const unsafe = isUnsafeMethod(req.method);
    if (unsafe) {
      const sent = header(req, CSRF_HEADER);
      const cookie = req.cookies?.[CSRF_COOKIE];
      if (!safeEqual(sent, cookie) || !safeEqual(sent, auth.csrfToken)) {
        throw new ForbiddenError(
          'The request is missing a valid CSRF token',
          { metadata: { reason: 'CSRF' } },
          AUTH_PROBLEM_TYPES.csrf,
        );
      }
    }

    if (
      auth.mustChangePassword &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD_CHANGE_KEY, targets)
    ) {
      throw new ForbiddenError(
        'You must change your password before continuing',
        { metadata: { reason: 'PASSWORD_CHANGE_REQUIRED' } },
        AUTH_PROBLEM_TYPES.passwordChangeRequired,
      );
    }

    if (unsafe) await this.sessions.touch(auth.ctx.sessionId);
    return true;
  }
}
