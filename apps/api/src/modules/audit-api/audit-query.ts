import { Prisma } from '@prisma/client';
import {
  addDays,
  type AuditChange,
  type AuditFilters,
  type AuditRow,
  type AuditRowDetail,
  BUSINESS_TIMEZONE,
  isBusinessDate,
} from '@peoplehub/shared';
import { fromZonedTime } from 'date-fns-tz';
import { hasRole, type SecurityContext } from '../../common/context/security-context';

// Building blocks of the audit API: the explorer filters as SQL (the free-text filter searches the
// `metadata` JSON as text, which the Prisma query API cannot express), the row shapes, and the
// pay-data rule for system admins (section 4.1).

/** An `AuditLog` row as the raw queries return it. */
export interface RawAuditRow {
  id: bigint;
  occurredAt: Date;
  requestId: string | null;
  sessionId: string | null;
  actorUserId: string | null;
  actorUsername: string | null;
  actingAsEmployeeId: number | null;
  subjectEmployeeId: number | null;
  category: AuditRow['category'];
  action: string;
  entityType: string | null;
  entityId: string | null;
  outcome: AuditRow['outcome'];
  before: Prisma.JsonValue;
  after: Prisma.JsonValue;
  changes: Prisma.JsonValue;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Prisma.JsonValue;
  prevHash: string | null;
  hash: string;
}

/** Start (inclusive) of a date or timestamp `from`. */
export function instantFrom(value: string): Date {
  return isBusinessDate(value) ? fromZonedTime(`${value}T00:00:00`, BUSINESS_TIMEZONE) : new Date(value);
}

/**
 * End of a date or timestamp `to`: a date covers that whole day (exclusive bound = the next
 * midnight in Africa/Windhoek); a timestamp is inclusive.
 */
export function instantTo(value: string): { at: Date; inclusive: boolean } {
  return isBusinessDate(value)
    ? { at: fromZonedTime(`${addDays(value, 1)}T00:00:00`, BUSINESS_TIMEZONE), inclusive: false }
    : { at: new Date(value), inclusive: true };
}

/** `%`, `_` and `\` matched literally in LIKE / ILIKE. */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The explorer filters as SQL conditions (combined with AND). */
export function auditConditions(f: AuditFilters): Prisma.Sql[] {
  const c: Prisma.Sql[] = [];
  if (f.from) c.push(Prisma.sql`"occurredAt" >= ${instantFrom(f.from)}`);
  if (f.to) {
    const end = instantTo(f.to);
    c.push(end.inclusive ? Prisma.sql`"occurredAt" <= ${end.at}` : Prisma.sql`"occurredAt" < ${end.at}`);
  }
  if (f.actorUserId) c.push(Prisma.sql`"actorUserId" = ${f.actorUserId}`);
  if (f.actorUsername) c.push(Prisma.sql`"actorUsername" ILIKE ${`%${likeEscape(f.actorUsername)}%`}`);
  if (f.subjectEmployeeId) c.push(Prisma.sql`"subjectEmployeeId" = ${f.subjectEmployeeId}`);
  if (f.categories) c.push(Prisma.sql`category::text = ANY(${f.categories})`);
  if (f.action) c.push(Prisma.sql`action LIKE ${`${likeEscape(f.action)}%`}`);
  if (f.entityType) c.push(Prisma.sql`"entityType" = ${f.entityType}`);
  if (f.entityId) c.push(Prisma.sql`"entityId" = ${f.entityId}`);
  if (f.outcomes) c.push(Prisma.sql`outcome::text = ANY(${f.outcomes})`);
  if (f.q) {
    const pattern = `%${likeEscape(f.q)}%`;
    c.push(Prisma.sql`(metadata::text ILIKE ${pattern} OR reason ILIKE ${pattern})`);
  }
  return c;
}

export function whereSql(conditions: Prisma.Sql[]): Prisma.Sql {
  return conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
}

function isChange(value: unknown): value is AuditChange {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { path?: unknown }).path === 'string'
  );
}

export function changesOf(value: Prisma.JsonValue): AuditChange[] {
  if (!Array.isArray(value)) return [];
  const out: AuditChange[] = [];
  for (const item of value as unknown[]) {
    if (isChange(item)) out.push({ path: item.path, from: item.from ?? null, to: item.to ?? null });
  }
  return out;
}

/** Whether the viewer sees the request plumbing (IP, request and session ids, user agent). */
export function seesPlumbing(ctx: SecurityContext): boolean {
  return hasRole(ctx, 'AUDITOR', 'SYSTEM_ADMIN');
}

/**
 * Section 4.1: a system admin who is not also HR, Payroll or an auditor never sees payslip
 * amounts or bank numbers. Bank numbers are never in the trail (only `last4`); payslip and tax
 * certificate figures and pay rates are blanked here for that viewer.
 */
export function hidesPayData(ctx: SecurityContext): boolean {
  return hasRole(ctx, 'SYSTEM_ADMIN') && !hasRole(ctx, 'AUDITOR', 'HR_ADMIN', 'PAYROLL_ADMIN');
}

/** Keys that hold pay data wherever they appear. */
const PAY_KEYS = new Set([
  'grossPay',
  'totalDeductions',
  'netPay',
  'ytdAmount',
  'figures',
  'hourlyRate',
  'lines',
]);
/** Entities whose amounts are pay data. */
const PAY_ENTITIES = new Set(['Payslip', 'PayslipLine', 'TaxCertificate']);
const PAY_ENTITY_KEYS = new Set(['amount', 'quantity', 'rate']);
export const PAY_DATA_HIDDEN = '[HIDDEN]';

function scrub(value: unknown, payEntity: boolean): { value: unknown; hidden: boolean } {
  if (Array.isArray(value)) {
    let hidden = false;
    const out = value.map((v) => {
      const r = scrub(v, payEntity);
      hidden ||= r.hidden;
      return r.value;
    });
    return { value: out, hidden };
  }
  if (!value || typeof value !== 'object') return { value, hidden: false };
  let hidden = false;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== null && (PAY_KEYS.has(key) || (payEntity && PAY_ENTITY_KEYS.has(key)))) {
      out[key] = PAY_DATA_HIDDEN;
      hidden = true;
      continue;
    }
    const r = scrub(v, payEntity);
    hidden ||= r.hidden;
    out[key] = r.value;
  }
  return { value: out, hidden };
}

/** Field paths of a change that are pay data. */
function payPath(path: string, payEntity: boolean): boolean {
  return path.split('.').some((part) => PAY_KEYS.has(part) || (payEntity && PAY_ENTITY_KEYS.has(part)));
}

export function toAuditRow(r: RawAuditRow, ctx: SecurityContext): AuditRow {
  const plumbing = seesPlumbing(ctx);
  return {
    id: r.id.toString(),
    occurredAt: r.occurredAt.toISOString(),
    category: r.category,
    action: r.action,
    outcome: r.outcome,
    actorUserId: r.actorUserId,
    actorUsername: r.actorUsername,
    actingAsEmployeeId: r.actingAsEmployeeId,
    subjectEmployeeId: r.subjectEmployeeId,
    entityType: r.entityType,
    entityId: r.entityId,
    reason: r.reason,
    changedFields: changesOf(r.changes).map((c) => c.path),
    ip: plumbing ? r.ip : null,
    requestId: plumbing ? r.requestId : null,
  };
}

/** The full row; values were redacted when written (section 9.5) and pay data is blanked per viewer. */
export function toAuditDetail(r: RawAuditRow, ctx: SecurityContext): AuditRowDetail {
  const plumbing = seesPlumbing(ctx);
  const hide = hidesPayData(ctx);
  const payEntity = PAY_ENTITIES.has(r.entityType ?? '');
  let hidden = false;
  const view = (value: Prisma.JsonValue): unknown => {
    if (!hide) return value;
    const s = scrub(value, payEntity);
    hidden ||= s.hidden;
    return s.value;
  };
  const changes = changesOf(r.changes).map((c) => {
    if (hide && payPath(c.path, payEntity)) {
      hidden = true;
      return { path: c.path, from: PAY_DATA_HIDDEN, to: PAY_DATA_HIDDEN };
    }
    return { path: c.path, from: view(c.from as Prisma.JsonValue), to: view(c.to as Prisma.JsonValue) };
  });
  const before = view(r.before);
  const after = view(r.after);
  const metadata = view(r.metadata);
  return {
    ...toAuditRow(r, ctx),
    sessionId: plumbing ? r.sessionId : null,
    userAgent: plumbing ? r.userAgent : null,
    before: before ?? null,
    after: after ?? null,
    changes,
    metadata: metadata ?? null,
    prevHash: r.prevHash,
    hash: r.hash,
    payDataHidden: hidden,
  };
}
