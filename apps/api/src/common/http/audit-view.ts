import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
  UseInterceptors,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { from, type Observable, switchMap } from 'rxjs';
import { AuditService } from '../../audit/audit.service';

export interface AuditViewOptions {
  /** Suffix of the action: `DATA_VIEW.{what}`. */
  what: string;
  /** Prisma model of the viewed entity. */
  entityType?: string;
  /** Route param holding the entity id (default `id`). */
  idParam?: string;
  category?: 'DATA_VIEW' | 'EXPORT';
  /** Reads the subject employee id from the handler result. */
  subjectFrom?: (result: unknown) => number | null | undefined;
}

export const AUDIT_VIEW_KEY = 'audit:view';

/** Records a DATA_VIEW (or EXPORT) audit row after a sensitive read succeeds (section 9.4.4). */
@Injectable()
export class AuditViewInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<AuditViewOptions | undefined>(AUDIT_VIEW_KEY, context.getHandler());
    if (!options) return next.handle();
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    return next.handle().pipe(
      switchMap((result: unknown) =>
        from(
          (async () => {
            const ctx = req.securityContext;
            const params = (req.params ?? {}) as Record<string, string>;
            const category = options.category ?? 'DATA_VIEW';
            await this.audit.recordStandalone(
              {
                userId: ctx?.userId,
                username: ctx?.username,
                sessionId: ctx?.sessionId,
                actingAsEmployeeId: ctx?.actingAsEmployeeId,
                requestId: String(req.id),
                ip: req.ip,
                userAgent: req.headers['user-agent'] ?? '',
              },
              {
                category,
                action: `${category}.${options.what}`,
                entityType: options.entityType ?? null,
                entityId: params[options.idParam ?? 'id'] ?? null,
                subjectEmployeeId: options.subjectFrom?.(result) ?? null,
                metadata: { method: req.method, url: req.url.split('?')[0] },
              },
            );
            return result;
          })(),
        ),
      ),
    );
  }
}

export function AuditView(options: AuditViewOptions) {
  return applyDecorators(SetMetadata(AUDIT_VIEW_KEY, options), UseInterceptors(AuditViewInterceptor));
}
