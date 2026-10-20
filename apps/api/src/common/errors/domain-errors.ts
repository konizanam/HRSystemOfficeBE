import { HttpException, HttpStatus } from '@nestjs/common';

export interface FieldError {
  path: string;
  message: string;
}

/** Base for errors rendered as RFC 7807 problem+json by ProblemFilter. */
export class DomainError extends HttpException {
  constructor(
    status: number,
    readonly title: string,
    readonly detail?: string,
    readonly errors?: FieldError[],
    readonly type = 'about:blank',
  ) {
    super({ title, detail, errors }, status);
  }
}

export class NotFoundError extends DomainError {
  constructor(what = 'Resource', detail?: string) {
    super(HttpStatus.NOT_FOUND, `${what} not found`, detail);
  }
}

export class ForbiddenError extends DomainError {
  constructor(detail = 'You do not have permission to perform this action') {
    super(HttpStatus.FORBIDDEN, 'Forbidden', detail);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(detail = 'Authentication required') {
    super(HttpStatus.UNAUTHORIZED, 'Unauthorized', detail);
  }
}

/** 409: optimistic concurrency or a conflicting open request. */
export class ConflictError extends DomainError {
  constructor(
    detail = 'This record changed; reload',
    readonly current?: unknown,
  ) {
    super(HttpStatus.CONFLICT, 'Conflict', detail);
  }
}

/** 422: business validation with field-level messages. */
export class ValidationError extends DomainError {
  constructor(errors: FieldError[] | string, detail?: string) {
    const list = typeof errors === 'string' ? [{ path: '', message: errors }] : errors;
    super(HttpStatus.UNPROCESSABLE_ENTITY, 'Validation failed', detail ?? list[0]?.message, list);
  }

  static field(path: string, message: string): ValidationError {
    return new ValidationError([{ path, message }]);
  }
}

/** Throws ConflictError unless the client sent the version it read. */
export function assertVersion(entity: { version: number }, expected: number | undefined): void {
  if (expected === undefined || entity.version !== expected) {
    throw new ConflictError('This record changed; reload', { version: entity.version });
  }
}
