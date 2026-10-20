import { createHash } from 'node:crypto';

/** A JSON value after normalisation: what is stored in jsonb and what is hashed. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isDecimalLike(value: object): value is { toFixed(): string; isFinite(): boolean } {
  return (
    typeof (value as { toFixed?: unknown }).toFixed === 'function' &&
    typeof (value as { isFinite?: unknown }).isFinite === 'function' &&
    typeof (value as { d?: unknown }).d !== 'undefined'
  );
}

/** ISO-8601 with microsecond precision (section 9.3). JS dates carry ms, so µs are always 000. */
export function isoMicros(date: Date): string {
  return date.toISOString().replace(/Z$/, '000Z');
}

/**
 * Converts arbitrary values (Dates, Prisma Decimals, bigints, Buffers) into plain JSON so that what
 * is stored in jsonb reads back identically. Decimals become strings, dates ISO strings with µs.
 */
export function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  // jsonb cannot store NUL characters.
  if (typeof value === 'string') return value.replaceAll(String.fromCharCode(0), '');
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return isoMicros(value);
  if (Buffer.isBuffer(value)) return `[binary ${value.length} bytes]`;
  if (Array.isArray(value)) return value.map((v) => toJsonValue(v) ?? null);
  if (typeof value === 'object') {
    if (isDecimalLike(value)) return value.toFixed();
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value)) {
      const j = toJsonValue(v);
      if (j !== undefined) out[k] = j;
    }
    return out;
  }
  return undefined;
}

/** Canonical JSON: recursively sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  const v = toJsonValue(value);
  return serialise(v === undefined ? null : v);
}

function serialise(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialise).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialise(value[k] as JsonValue)}`).join(',')}}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** The columns of an AuditLog row that are covered by the hash (everything except `hash`). */
export interface HashableAuditRow {
  id: bigint | string;
  occurredAt: Date;
  requestId: string | null;
  sessionId: string | null;
  actorUserId: string | null;
  actorUsername: string | null;
  actingAsEmployeeId: number | null;
  subjectEmployeeId: number | null;
  category: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  outcome: string;
  before: unknown;
  after: unknown;
  changes: unknown;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: unknown;
  prevHash: string | null;
}

const HASHED_COLUMNS: (keyof HashableAuditRow)[] = [
  'id',
  'occurredAt',
  'requestId',
  'sessionId',
  'actorUserId',
  'actorUsername',
  'actingAsEmployeeId',
  'subjectEmployeeId',
  'category',
  'action',
  'entityType',
  'entityId',
  'outcome',
  'before',
  'after',
  'changes',
  'reason',
  'ip',
  'userAgent',
  'metadata',
  'prevHash',
];

/** hash = sha256(prevHash || canonicalJson(row without hash)). */
export function computeAuditHash(row: HashableAuditRow): string {
  const subset: Record<string, unknown> = {};
  for (const col of HASHED_COLUMNS) subset[col] = row[col] ?? null;
  return sha256Hex((row.prevHash ?? '') + canonicalJson(subset));
}
