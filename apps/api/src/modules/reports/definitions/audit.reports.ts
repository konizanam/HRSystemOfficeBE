import type { AuditCategory, Prisma } from '@prisma/client';
import type { ReportParams } from '@peoplehub/shared';
import { defineReport, type ReportRunContext } from '../report-definition';
import { bigintBatches, fullName, timestampRange, ts } from '../report-helpers';

// Audit reports (new, section 5.7) for AUDITOR and SYSTEM_ADMIN. They never print before/after
// values: a system admin may not see payslip amounts or bank numbers (section 4.1), so the
// trail shows which fields changed and the audit explorer (Phase 9) shows values to auditors.

type AuditParams = ReportParams<'AUDIT_TRAIL_EXTRACT'>;

/** The categories a report covers, narrowed by the params (an empty list means no rows). */
function categories(params: AuditParams, only?: AuditCategory[]): AuditCategory[] | undefined {
  if (!only) return params.categories;
  return params.categories ? only.filter((c) => params.categories?.includes(c)) : only;
}

function auditWhere(params: AuditParams, extra: Prisma.AuditLogWhereInput, only?: AuditCategory[]) {
  const cats = categories(params, only);
  return {
    AND: [
      extra,
      params.from || params.to ? { occurredAt: timestampRange(params.from, params.to) } : {},
      cats ? { category: { in: cats } } : {},
      params.outcomes ? { outcome: { in: params.outcomes } } : {},
      params.action ? { action: { startsWith: params.action } } : {},
      params.actorUsername
        ? { actorUsername: { contains: params.actorUsername, mode: 'insensitive' as const } }
        : {},
      params.employeeIds ? { subjectEmployeeId: { in: params.employeeIds } } : {},
    ],
  } satisfies Prisma.AuditLogWhereInput;
}

/** Paths of the changed fields (`changes` holds `[{path, from, to}]`). */
function changedFields(changes: Prisma.JsonValue): string | null {
  if (!Array.isArray(changes)) return null;
  const paths = changes
    .map((c) =>
      c && typeof c === 'object' && !Array.isArray(c) && typeof c.path === 'string' ? c.path : null,
    )
    .filter((p): p is string => p !== null);
  return paths.length > 0 ? paths.join(', ') : null;
}

function rows(
  rc: ReportRunContext,
  where: Prisma.AuditLogWhereInput,
  orderBy: Prisma.AuditLogOrderByWithRelationInput[],
) {
  return bigintBatches((page) => rc.prisma.auditLog.findMany({ where, orderBy, ...page }), rc.batchSize);
}

/** Audit Trail Extract. */
export const auditTrailExtract = defineReport('AUDIT_TRAIL_EXTRACT', async function* (rc, params) {
  for await (const batch of rows(rc, auditWhere(params, {}), [{ id: 'asc' }])) {
    for (const a of batch) {
      yield {
        id: a.id.toString(),
        occurredAt: ts(a.occurredAt),
        category: a.category,
        action: a.action,
        outcome: a.outcome,
        actor: a.actorUsername,
        actingAsEmployeeId: a.actingAsEmployeeId,
        subjectEmployeeId: a.subjectEmployeeId,
        entityType: a.entityType,
        entityId: a.entityId,
        reason: a.reason,
        changedFields: changedFields(a.changes),
        ip: a.ip,
        requestId: a.requestId,
      };
    }
  }
});

/** Sensitive Data Access: the DATA_VIEW rows. */
export const sensitiveDataAccess = defineReport('SENSITIVE_DATA_ACCESS', async function* (rc, params) {
  for await (const batch of rows(rc, auditWhere(params, {}, ['DATA_VIEW']), [{ id: 'asc' }])) {
    const ids = [...new Set(batch.map((a) => a.subjectEmployeeId).filter((id): id is number => id !== null))];
    const subjects = new Map(
      (
        await rc.prisma.employee.findMany({
          where: { id: { in: ids } },
          select: { id: true, employeeCode: true, firstName: true, lastName: true },
        })
      ).map((e) => [e.id, `${e.employeeCode} ${fullName(e)}`]),
    );
    for (const a of batch) {
      yield {
        id: a.id.toString(),
        occurredAt: ts(a.occurredAt),
        action: a.action,
        outcome: a.outcome,
        actor: a.actorUsername,
        actingAsEmployeeId: a.actingAsEmployeeId,
        subjectEmployeeId: a.subjectEmployeeId,
        subjectEmployee: a.subjectEmployeeId !== null ? (subjects.get(a.subjectEmployeeId) ?? null) : null,
        entityType: a.entityType,
        entityId: a.entityId,
        ip: a.ip,
      };
    }
  }
});

/** Failed Logins: `AUTH.LOGIN_FAILURE` rows with the attempted username (never a password). */
export const failedLogins = defineReport('FAILED_LOGINS', async function* (rc, params) {
  for await (const batch of rows(rc, auditWhere(params, { action: 'AUTH.LOGIN_FAILURE' }), [{ id: 'asc' }])) {
    for (const a of batch) {
      const meta =
        a.metadata && typeof a.metadata === 'object' && !Array.isArray(a.metadata) ? a.metadata : {};
      yield {
        id: a.id.toString(),
        occurredAt: ts(a.occurredAt),
        usernameAttempted: typeof meta.username === 'string' ? meta.username : null,
        reason: a.reason,
        userId: a.entityType === 'User' ? a.entityId : null,
        ip: a.ip,
        userAgent: a.userAgent,
      };
    }
  }
});

/** Changes by User: data changes and workflow actions, ordered by the actor. */
export const changesByUser = defineReport('CHANGES_BY_USER', async function* (rc, params) {
  for await (const batch of rows(rc, auditWhere(params, {}, ['DATA_CHANGE', 'WORKFLOW']), [
    { actorUsername: { sort: 'asc', nulls: 'last' } },
    { id: 'asc' },
  ])) {
    for (const a of batch) {
      yield {
        actor: a.actorUsername,
        id: a.id.toString(),
        occurredAt: ts(a.occurredAt),
        category: a.category,
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        subjectEmployeeId: a.subjectEmployeeId,
        changedFields: changedFields(a.changes),
      };
    }
  }
});
