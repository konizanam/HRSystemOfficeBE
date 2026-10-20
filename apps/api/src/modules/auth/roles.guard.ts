import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@peoplehub/shared';
import type { FastifyRequest } from 'fastify';
import { hasRole } from '../../common/context/security-context';
import { ForbiddenError, UnauthorizedError } from '../../common/errors/domain-errors';
import { IS_PUBLIC_KEY, ROLES_KEY } from './decorators';

/**
 * Global guard after SessionGuard: routes (or controllers) marked `@Roles(...)` need at least one
 * of the listed roles. A 403 is audited as DENIED by ProblemFilter.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (!roles?.length) return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    const ctx = context.switchToHttp().getRequest<FastifyRequest>().securityContext;
    if (!ctx) throw new UnauthorizedError();
    if (!hasRole(ctx, ...roles)) {
      throw new ForbiddenError('You do not have the role this action needs', {
        metadata: { requiredRoles: roles },
      });
    }
    return true;
  }
}
