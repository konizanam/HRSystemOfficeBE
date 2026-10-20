import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { RequestMeta, SecurityContext } from '../context/security-context';
import { UnauthorizedError } from '../errors/domain-errors';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the session guard once the caller is authenticated. */
    securityContext?: SecurityContext;
  }
}

export function requestMeta(req: FastifyRequest): RequestMeta {
  const ua = req.headers['user-agent'];
  return {
    requestId: String(req.id),
    ip: req.ip,
    userAgent: (Array.isArray(ua) ? ua[0] : ua) ?? '',
  };
}

/** Injects the caller's SecurityContext; throws 401 when the request is anonymous. */
export const Ctx = createParamDecorator((_data: unknown, ctx: ExecutionContext): SecurityContext => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  if (!req.securityContext) throw new UnauthorizedError();
  return req.securityContext;
});

/** Injects request id / ip / user agent (works for anonymous endpoints). */
export const Meta = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestMeta => {
  return requestMeta(ctx.switchToHttp().getRequest<FastifyRequest>());
});
