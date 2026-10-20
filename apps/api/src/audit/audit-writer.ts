import { type AuditCategory, type AuditOutcome, Prisma } from '@prisma/client';
import type { AuditActor } from '../common/context/security-context';
import type { Tx } from '../prisma/prisma-client';
import type { AuditScope, PendingAudit } from './audit-scope';
import { computeAuditHash, type HashableAuditRow, toJsonValue } from './canonical-json';
import { modelConstant } from './audited-models';
import { diff, redact } from './redact';
import { auditMetrics } from './audit-metrics';

/** Advisory lock key that serialises the single global chain (section 9.3). */
export const AUDIT_CHAIN_LOCK = 727274;

function subjectFrom(model: string, snapshot: unknown): number | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const s = snapshot as Record<string, unknown>;
  if (model === 'Employee' && typeof s.id === 'number') return s.id;
  for (const key of ['employeeId', 'subjectEmployeeId', 'applicantId']) {
    if (typeof s[key] === 'number') return s[key] as number;
  }
  return null;
}

/** Adds generic DATA_CHANGE rows for tracked writes that no explicit audit covered. */
export function addSafetyNetEntries(scope: AuditScope): void {
  const covered = new Set(
    scope.entries
      .filter((p) => p.entry.entityType)
      .map(
        (p) =>
          `${p.entry.entityType}:${p.entry.entityId === null || p.entry.entityId === undefined ? '' : String(p.entry.entityId)}`,
      ),
  );
  for (const w of scope.writes) {
    if (covered.has(`${w.model}:${w.entityId ?? ''}`)) continue;
    // An upsert that found the row unchanged (idempotent seeds, re-saves) is not a change.
    if (w.operation === 'update' && diff(redact(w.model, w.before), redact(w.model, w.after)).length === 0)
      continue;
    scope.entries.push({
      actor: scope.actor,
      occurredAt: new Date(),
      entry: {
        category: 'DATA_CHANGE',
        action: `DATA_CHANGE.${modelConstant(w.model)}.${modelConstant(w.operation)}`,
        entityType: w.model,
        entityId: w.entityId,
        subjectEmployeeId: subjectFrom(w.model, w.after ?? w.before),
        before: w.before,
        after: w.after,
      },
    });
  }
}

function buildRow(pending: PendingAudit, id: bigint, prevHash: string | null): HashableAuditRow {
  const { actor, entry } = pending;
  const model = entry.entityType ?? null;
  const before = entry.before === undefined ? null : redact(model, entry.before, entry.after);
  const after = entry.after === undefined ? null : redact(model, entry.after, entry.before);
  const changes =
    entry.changes ??
    (entry.before !== undefined && entry.after !== undefined && before && after ? diff(before, after) : null);
  return {
    id,
    occurredAt: pending.occurredAt,
    requestId: actor.requestId ?? null,
    sessionId: actor.sessionId ?? null,
    actorUserId: actor.userId ?? null,
    actorUsername: actor.username ?? null,
    actingAsEmployeeId: actor.actingAsEmployeeId || null,
    subjectEmployeeId: entry.subjectEmployeeId ?? null,
    category: entry.category,
    action: entry.action,
    entityType: model,
    entityId: entry.entityId === null || entry.entityId === undefined ? null : String(entry.entityId),
    outcome: entry.outcome ?? 'SUCCESS',
    before,
    after,
    changes: changes ? (toJsonValue(changes) ?? null) : null,
    reason: entry.reason ?? null,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    metadata: entry.metadata === undefined ? null : redact(null, entry.metadata),
    prevHash,
  };
}

function jsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

/**
 * Appends entries to the hash chain. Must be the last statement of the business transaction so the
 * advisory lock is held as briefly as possible.
 */
export async function writeAuditEntries(tx: Tx, entries: PendingAudit[]): Promise<void> {
  if (entries.length === 0) return;
  const started = performance.now();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`;
  const last = await tx.$queryRaw<{ hash: string }[]>`SELECT hash FROM "AuditLog" ORDER BY id DESC LIMIT 1`;
  let prevHash: string | null = last[0]?.hash ?? null;

  for (const pending of entries) {
    const [{ id }] = (await tx.$queryRaw<{ id: bigint }[]>`
      SELECT nextval(pg_get_serial_sequence('"AuditLog"', 'id')) AS id`) as [{ id: bigint }];
    const row = buildRow(pending, id, prevHash);
    const hash = computeAuditHash(row);
    await tx.auditLog.create({
      data: {
        ...row,
        category: row.category as AuditCategory,
        outcome: row.outcome as AuditOutcome,
        before: jsonInput(row.before),
        after: jsonInput(row.after),
        changes: jsonInput(row.changes),
        metadata: jsonInput(row.metadata),
        id: BigInt(id),
        hash,
      },
    });
    prevHash = hash;
  }
  auditMetrics.observeInsert((performance.now() - started) / 1000, entries.length);
}

export async function flushAuditScope(scope: AuditScope): Promise<void> {
  addSafetyNetEntries(scope);
  await writeAuditEntries(scope.tx as Tx, scope.entries);
  scope.entries = [];
  scope.writes = [];
}

export function pendingFor(actor: AuditActor, entry: PendingAudit['entry']): PendingAudit {
  return { actor, entry, occurredAt: new Date() };
}
