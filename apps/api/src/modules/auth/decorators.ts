import { applyDecorators, SetMetadata } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import { AUTH_POLICY, type Role } from '@peoplehub/shared';

export const IS_PUBLIC_KEY = 'auth:public';
export const ROLES_KEY = 'auth:roles';
export const ALLOW_PENDING_PASSWORD_CHANGE_KEY = 'auth:allowPendingPasswordChange';

/** The route needs no session (sign-in, password reset, health). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** The caller needs at least one of these roles. Checked by RolesGuard after SessionGuard. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Still reachable while the user must change their password: password change, session and
 * logout. Every other route answers 403 PASSWORD_CHANGE_REQUIRED until the password is changed.
 */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD_CHANGE_KEY, true);

/** @fastify/rate-limit route config for every /auth/* route: 10 requests per minute per IP. */
export const AUTH_RATE_LIMIT = {
  max: AUTH_POLICY.authRateLimitPerMinute,
  timeWindow: 60_000,
} as const;

export const AuthRateLimit = () => applyDecorators(RouteConfig({ rateLimit: AUTH_RATE_LIMIT }));
