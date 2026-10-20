import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Problem } from '@peoplehub/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { requestMeta } from '../http/request';
import { ConflictError, DomainError } from './domain-errors';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Validation failed',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
};

function zodErrors(error: ZodError): Problem['errors'] {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Renders every error as RFC 7807 problem+json and audits 401/403 (section 9.4.3, 10.1). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  constructor(private readonly audit: AuditService) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const http = host.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const problem = this.toProblem(exception);
    problem.requestId = String(req.id);

    if (problem.status >= 500) {
      this.logger.error({ err: exception, requestId: req.id }, 'Unhandled error');
    }

    if (problem.status === 401 || problem.status === 403) {
      await this.auditDenied(req, problem).catch((err: unknown) =>
        this.logger.error({ err, requestId: req.id }, 'Failed to audit access denial'),
      );
    }

    const body: Record<string, unknown> = { ...problem };
    if (exception instanceof ConflictError && exception.current !== undefined)
      body.current = exception.current;

    await reply.status(problem.status).header('content-type', 'application/problem+json').send(body);
  }

  private toProblem(exception: unknown): Problem {
    if (exception instanceof DomainError) {
      return {
        type: exception.type,
        title: exception.title,
        status: exception.getStatus(),
        detail: exception.detail,
        errors: exception.errors,
      };
    }
    if (exception instanceof ZodValidationException) {
      const zod = exception.getZodError() as { issues?: { path: PropertyKey[]; message: string }[] };
      return {
        type: 'about:blank',
        title: 'Validation failed',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail: 'The request is not valid',
        errors: zod.issues?.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
      };
    }
    if (exception instanceof ZodError) {
      return {
        type: 'about:blank',
        title: 'Validation failed',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail: 'The request is not valid',
        errors: zodErrors(exception),
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2025') return { type: 'about:blank', title: 'Not Found', status: 404 };
      if (exception.code === 'P2002') {
        return {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'A record with these values already exists',
        };
      }
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const detail =
        typeof response === 'string'
          ? response
          : typeof (response as { message?: unknown }).message === 'string'
            ? (response as { message: string }).message
            : undefined;
      return { type: 'about:blank', title: TITLES[status] ?? 'Error', status, detail };
    }
    const status = (exception as { statusCode?: unknown })?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return {
        type: 'about:blank',
        title: TITLES[status] ?? 'Error',
        status,
        detail: (exception as { message?: string }).message,
      };
    }
    return {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred',
    };
  }

  private async auditDenied(req: FastifyRequest, problem: Problem): Promise<void> {
    const ctx = req.securityContext;
    const meta = requestMeta(req);
    await this.audit.recordStandalone(
      {
        ...meta,
        userId: ctx?.userId ?? null,
        username: ctx?.username ?? null,
        sessionId: ctx?.sessionId ?? null,
        actingAsEmployeeId: ctx?.actingAsEmployeeId ?? null,
      },
      {
        category: 'SECURITY',
        action: 'SECURITY.ACCESS_DENIED',
        outcome: 'DENIED',
        reason: problem.detail ?? problem.title,
        metadata: { method: req.method, url: req.url.split('?')[0], status: problem.status },
      },
    );
  }
}
