import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditCategory, AuditOutcome } from '@peoplehub/shared';
import type { AuditActor } from '../common/context/security-context';
import type { FieldChange } from './redact';

/** What a service passes to `audit.record` (section 9.2). */
export interface AuditEntry {
  category: AuditCategory;
  /** `DOMAIN.VERB`, e.g. `LEAVE.SUBMITTED`. */
  action: string;
  /** The Prisma model name, so the safety net can match explicit audits to writes. */
  entityType?: string | null;
  entityId?: string | number | bigint | null;
  subjectEmployeeId?: number | null;
  outcome?: AuditOutcome;
  before?: unknown;
  after?: unknown;
  changes?: FieldChange[];
  reason?: string | null;
  metadata?: unknown;
}

export interface PendingAudit {
  actor: AuditActor;
  entry: AuditEntry;
  occurredAt: Date;
}

/** A write to an audited model observed by the Prisma extension. */
export interface TrackedWrite {
  model: string;
  operation: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
}

/** Minimal shape of a Prisma model delegate, used for dynamic before-state reads. */
export interface ReadableDelegate {
  findUnique(args: { where: unknown }): Promise<unknown>;
}

export interface AuditScope {
  /** The interactive transaction client. */
  tx: unknown;
  actor: AuditActor;
  entries: PendingAudit[];
  writes: TrackedWrite[];
  /** Jobs that audit per row may use updateMany/deleteMany/createMany on audited models. */
  allowBulk: boolean;
}

export const auditScopeStorage = new AsyncLocalStorage<AuditScope>();

export function currentAuditScope(): AuditScope | undefined {
  return auditScopeStorage.getStore();
}
