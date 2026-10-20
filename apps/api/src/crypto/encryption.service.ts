import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export interface KeyRing {
  keys: Record<string, Buffer>;
  activeKeyId: string;
}

export function parseKeyRing(keysJson: string, activeKeyId: string): KeyRing {
  let parsed: unknown;
  try {
    parsed = JSON.parse(keysJson);
  } catch {
    throw new Error('ENCRYPTION_KEYS must be JSON: {"k1":"<base64 32 bytes>"}');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('ENCRYPTION_KEYS must be a JSON object');
  const keys: Record<string, Buffer> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid encryption key id ${id}`);
    if (typeof value !== 'string') throw new Error(`Encryption key ${id} must be a base64 string`);
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) throw new Error(`Encryption key ${id} must decode to 32 bytes`);
    keys[id] = key;
  }
  if (!keys[activeKeyId]) throw new Error(`ENCRYPTION_ACTIVE_KEY ${activeKeyId} is not in ENCRYPTION_KEYS`);
  return { keys, activeKeyId };
}

/** Last four characters of a value (digits and letters only), for masked display. */
export function last4(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = value.replace(/[^A-Za-z0-9]/g, '');
  return clean.slice(-4) || null;
}

export function mask(last4Value: string | null | undefined): string {
  return last4Value ? `••••${last4Value}` : '';
}

/**
 * AES-256-GCM field encryption (section 10.3). Ciphertext format: `keyId:iv:tag:ciphertext`, each
 * part base64. Old keys stay in the ring so rotation can re-encrypt in batches.
 */
@Injectable()
export class EncryptionService {
  private readonly ring: KeyRing;

  constructor() {
    this.ring = parseKeyRing(env().ENCRYPTION_KEYS, env().ENCRYPTION_ACTIVE_KEY);
  }

  /** Builds a service over an explicit key ring (tests, key rotation). */
  static withRing(ring: KeyRing): EncryptionService {
    const service = Object.create(EncryptionService.prototype) as EncryptionService;
    Object.assign(service, { ring });
    return service;
  }

  get activeKeyId(): string {
    return this.ring.activeKeyId;
  }

  encrypt(plaintext: string): string {
    const keyId = this.ring.activeKeyId;
    const key = this.ring.keys[keyId] as Buffer;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [keyId, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
  }

  encryptNullable(plaintext: string | null | undefined): string | null {
    return plaintext === null || plaintext === undefined || plaintext === '' ? null : this.encrypt(plaintext);
  }

  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 4) throw new Error('Malformed ciphertext');
    const [keyId, iv, tag, ct] = parts as [string, string, string, string];
    const key = this.ring.keys[keyId];
    if (!key) throw new Error(`Unknown encryption key ${keyId}`);
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  }

  decryptNullable(payload: string | null | undefined): string | null {
    return payload ? this.decrypt(payload) : null;
  }

  keyIdOf(payload: string): string {
    return payload.split(':', 1)[0] ?? '';
  }

  needsRotation(payload: string | null | undefined): boolean {
    return !!payload && this.keyIdOf(payload) !== this.ring.activeKeyId;
  }

  /** Re-encrypts with the active key. */
  rotate(payload: string): string {
    return this.encrypt(this.decrypt(payload));
  }
}
