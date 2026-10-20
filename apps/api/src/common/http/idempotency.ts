import {
  applyDecorators,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';
import { IDEMPOTENCY_HEADER } from '@peoplehub/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { catchError, from, type Observable, of, switchMap } from 'rxjs';
import { canonicalJson, sha256Hex } from '../../audit/canonical-json';
import { DbService } from '../../prisma/db.service';
import { ConflictError, ValidationError } from '../errors/domain-errors';

const PENDING_STATUS = 0;

/**
 * `Idempotency-Key` support for submit endpoints (section 0.9). The first request reserves the key;
 * a replay with the same payload returns the original status and body; a concurrent replay gets 409.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly db: DbService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const header = req.headers[IDEMPOTENCY_HEADER];
    const rawKey = Array.isArray(header) ? header[0] : header;
    if (!rawKey) return next.handle();
    if (rawKey.length > 200) throw ValidationError.field('Idempotency-Key', 'Idempotency-Key is too long');

    const userId = req.securityContext?.userId ?? 'anonymous';
    const key = sha256Hex(`${userId}:${req.method}:${req.routeOptions.url ?? req.url}:${rawKey}`);
    const requestHash = sha256Hex(canonicalJson({ params: req.params ?? null, body: req.body ?? null }));
    const prisma = this.db.prisma;
    const declared = Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler()) as number | undefined;
    const successStatus = declared ?? (req.method === 'POST' ? 201 : 200);

    return from(
      (async () => {
        try {
          await prisma.idempotencyRecord.create({
            data: {
              key,
              userId,
              method: req.method,
              path: req.url.split('?')[0] ?? req.url,
              requestHash,
              responseStatus: PENDING_STATUS,
              responseBody: Prisma.JsonNull,
            },
          });
          return null;
        } catch (err) {
          if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
          const existing = await prisma.idempotencyRecord.findUnique({ where: { key } });
          if (!existing) throw new ConflictError('Request is being processed; retry shortly');
          if (existing.requestHash !== requestHash) {
            throw ValidationError.field(
              'Idempotency-Key',
              'Idempotency-Key was already used with a different request',
            );
          }
          if (existing.responseStatus === PENDING_STATUS) {
            throw new ConflictError('A request with this Idempotency-Key is still being processed');
          }
          return existing;
        }
      })(),
    ).pipe(
      switchMap((existing) => {
        if (existing) {
          void reply.status(existing.responseStatus).header('idempotent-replay', 'true');
          return of(existing.responseBody);
        }
        return next.handle().pipe(
          switchMap((body: unknown) =>
            from(
              prisma.idempotencyRecord
                .update({
                  where: { key },
                  data: {
                    responseStatus: successStatus,
                    responseBody: (JSON.parse(JSON.stringify(body ?? null)) ??
                      Prisma.JsonNull) as Prisma.InputJsonValue,
                  },
                })
                .then(() => body),
            ),
          ),
          catchError((err: unknown) =>
            from(
              prisma.idempotencyRecord.delete({ where: { key } }).then(
                () => {
                  throw err;
                },
                () => {
                  throw err;
                },
              ),
            ),
          ),
        );
      }),
    );
  }
}

export function Idempotent() {
  return applyDecorators(UseInterceptors(IdempotencyInterceptor));
}
