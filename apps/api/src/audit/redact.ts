import type { JsonValue } from './canonical-json';
import { toJsonValue } from './canonical-json';

// Section 9.5: one central, unit-tested redaction policy per model.

export const REDACTED = '[REDACTED]';

interface ModelPolicy {
  /** Replaced with "[REDACTED]". */
  secret?: string[];
  /** Encrypted columns -> the column holding the masked last4 copy (null when there is none). */
  encrypted?: Record<string, string | null>;
  /** When set, only these keys are kept (e.g. attachments). */
  pick?: string[];
}

export const REDACTION_POLICIES: Record<string, ModelPolicy> = {
  User: { secret: ['passwordHash', 'mfaSecretEnc'] },
  Session: { secret: ['csrfToken'] },
  PasswordHistory: { secret: ['hash'] },
  PasswordResetToken: { secret: ['tokenHash'] },
  IdempotencyRecord: { secret: ['responseBody'] },
  Employee: {
    encrypted: {
      identityNumberEnc: 'identityNumberLast4',
      taxNumberEnc: 'taxNumberLast4',
      passportNumberEnc: null,
      birthCertificateNumberEnc: null,
    },
  },
  BankAccount: { encrypted: { accountNumberEnc: 'accountNumberLast4' } },
  DriversLicence: { encrypted: { licenceNumberEnc: 'licenceLast4' } },
  FamilyMember: { encrypted: { identityNumberEnc: 'identityNumberLast4' } },
  Beneficiary: { encrypted: { identityNumberEnc: null } },
  Attachment: {
    pick: ['id', 'fileName', 'sha256', 'sizeBytes', 'size', 'mimeType', 'ownerEntity', 'ownerEntityId'],
  },
};

/** Keys redacted in every model, as defence in depth. */
const ALWAYS_SECRET =
  /^(password|passwordHash|newPassword|currentPassword|token|tokenHash|secret|clientSecret|mfaSecret|mfaSecretEnc|csrfToken|apiKey|encryptionKey|privateKey)$/i;
/** Any key ending in `Enc` holds ciphertext and must never be stored as-is. */
const ENCRYPTED_KEY = /Enc$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * Redacts one entity snapshot. `compareTo` is the other side of a before/after pair and decides the
 * `changed` flag of encrypted fields; without it `changed` means "has a value".
 */
export function redact(
  model: string | null | undefined,
  data: unknown,
  compareTo?: unknown,
): JsonValue | null {
  if (data === null || data === undefined) return null;
  if (Array.isArray(data)) return data.map((d) => redact(model, d)) as JsonValue;
  if (!isRecord(data)) return toJsonValue(data) ?? null;

  const policy = (model && REDACTION_POLICIES[model]) || {};
  const other = isRecord(compareTo) ? compareTo : undefined;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (policy.pick && !policy.pick.includes(key)) continue;
    if (policy.secret?.includes(key) || ALWAYS_SECRET.test(key)) {
      out[key] = value === null || value === undefined ? null : REDACTED;
      continue;
    }
    if ((policy.encrypted && key in policy.encrypted) || ENCRYPTED_KEY.test(key)) {
      const last4Key = policy.encrypted?.[key] ?? null;
      const last4 = last4Key ? (data[last4Key] ?? null) : null;
      const changed = other ? other[key] !== value : value !== null && value !== undefined;
      out[key] = value === null || value === undefined ? null : { last4, changed };
      continue;
    }
    // Nested relation snapshots: redact with the generic rules.
    out[key] = isRecord(value) || Array.isArray(value) ? redact(null, value) : value;
  }
  return toJsonValue(out) ?? null;
}

export interface FieldChange {
  path: string;
  from: JsonValue | null;
  to: JsonValue | null;
}

const IGNORED_DIFF_KEYS = new Set(['updatedAt', 'version']);

/** Field-level diff of two (already redacted) snapshots, as `[{path, from, to}]`. */
export function diff(before: JsonValue | null, after: JsonValue | null, prefix = ''): FieldChange[] {
  const changes: FieldChange[] = [];
  const b = isRecord(before) ? (before as Record<string, JsonValue>) : null;
  const a = isRecord(after) ? (after as Record<string, JsonValue>) : null;
  if (!b || !a) {
    if (JSON.stringify(before) !== JSON.stringify(after))
      changes.push({ path: prefix || '$', from: before, to: after });
    return changes;
  }
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const key of [...keys].sort()) {
    if (!prefix && IGNORED_DIFF_KEYS.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const from = b[key] ?? null;
    const to = a[key] ?? null;
    if (isRecord(from) && isRecord(to) && !('last4' in to)) {
      changes.push(...diff(from, to, path));
    } else if (JSON.stringify(from) !== JSON.stringify(to)) {
      changes.push({ path, from, to });
    }
  }
  return changes;
}
