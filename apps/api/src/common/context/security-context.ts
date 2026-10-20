import type { Role } from '@peoplehub/shared';

/** Resolved per request (section 4.2). */
export interface SecurityContext {
  userId: string;
  username: string;
  roles: Role[];
  selfEmployeeId: number | null;
  /** = selfEmployeeId unless "Working as" someone else. */
  actingAsEmployeeId: number;
  /** Companies the user may administer (HR/Payroll scope). */
  companyIds: number[];
  sessionId: string;
  requestId: string;
  ip: string;
  userAgent: string;
  isSystem?: boolean;
}

/** Fields the audit trail needs. A full SecurityContext satisfies it; so does an anonymous request. */
export interface AuditActor {
  userId?: string | null;
  username?: string | null;
  actingAsEmployeeId?: number | null;
  sessionId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Request metadata available before authentication. */
export interface RequestMeta {
  requestId: string;
  ip: string;
  userAgent: string;
}

/** Fixed id of the built-in SYSTEM user (created by migration). Jobs act as this user. */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
export const SYSTEM_USERNAME = 'SYSTEM';

export function systemContext(requestId = `job-${Date.now()}`): SecurityContext {
  return {
    userId: SYSTEM_USER_ID,
    username: SYSTEM_USERNAME,
    roles: ['SYSTEM_ADMIN', 'HR_ADMIN', 'PAYROLL_ADMIN'],
    selfEmployeeId: null,
    actingAsEmployeeId: 0,
    companyIds: [],
    sessionId: 'system',
    requestId,
    ip: '127.0.0.1',
    userAgent: 'system',
    isSystem: true,
  };
}

export function hasRole(ctx: Pick<SecurityContext, 'roles'>, ...roles: Role[]): boolean {
  return roles.some((r) => ctx.roles.includes(r));
}

export function isActingForOther(ctx: SecurityContext): boolean {
  return ctx.selfEmployeeId !== ctx.actingAsEmployeeId;
}
