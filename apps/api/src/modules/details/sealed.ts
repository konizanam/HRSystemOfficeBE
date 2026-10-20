import { last4Of, maskLast4 } from '@peoplehub/shared';
import type { EncryptionService } from '../../crypto/encryption.service';

/**
 * A sensitive value inside a ChangeRequest's `proposed` JSON (ID, passport, tax, birth
 * certificate, bank account and licence numbers). The plaintext never reaches the JSON column:
 * it is stored encrypted (AES-256-GCM, section 10.3) with its masked last4 copy. The key ends in
 * `Enc`, so the audit redaction never writes the ciphertext to the audit trail either.
 */
export interface SealedValue {
  valueEnc: string;
  last4: string | null;
}

/** The previous value of a sensitive field, as kept in `ChangeRequest.before`: masked only. */
export interface MaskedValue {
  last4: string | null;
}

export function isSealed(value: unknown): value is SealedValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { valueEnc?: unknown }).valueEnc === 'string' &&
    'last4' in value
  );
}

export function isMasked(value: unknown): value is MaskedValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'last4' in value &&
    Object.keys(value).length === 1
  );
}

/** A sealed or masked value counts as one leaf of a patch. */
export function isSensitiveLeaf(value: Record<string, unknown>): boolean {
  return isSealed(value) || isMasked(value);
}

export function seal(crypto: EncryptionService, plaintext: string | null | undefined): SealedValue | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  return { valueEnc: crypto.encrypt(plaintext), last4: last4Of(plaintext) };
}

/** Re-wraps a stored ciphertext column (an unchanged value carried into a new row). */
export function sealStored(valueEnc: string | null, last4: string | null): SealedValue | null {
  return valueEnc ? { valueEnc, last4 } : null;
}

export function masked(plaintext: string | null | undefined): MaskedValue | null {
  return plaintext ? { last4: last4Of(plaintext) } : null;
}

/** `••••1234` of a sealed, masked or plain value; null when empty. */
export function maskedText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (isSealed(value) || isMasked(value)) return maskLast4(value.last4) || null;
  return typeof value === 'string' ? maskLast4(last4Of(value)) || null : null;
}

/** The ciphertext and last4 columns for a sealed value (null clears both). */
export function columnsOf(value: SealedValue | null): { enc: string | null; last4: string | null } {
  return value ? { enc: value.valueEnc, last4: value.last4 } : { enc: null, last4: null };
}
