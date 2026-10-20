import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EncryptionService, last4, mask, parseKeyRing } from '../../src/crypto/encryption.service';

const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');

describe('EncryptionService', () => {
  const svc = EncryptionService.withRing(parseKeyRing(JSON.stringify({ k1 }), 'k1'));

  it('round-trips with the k1:iv:tag:ciphertext format', () => {
    const ct = svc.encrypt('62021500123');
    expect(ct.split(':')).toHaveLength(4);
    expect(ct.startsWith('k1:')).toBe(true);
    expect(ct).not.toContain('62021500123');
    expect(svc.decrypt(ct)).toBe('62021500123');
  });

  it('uses a fresh IV every time', () => {
    expect(svc.encrypt('same')).not.toBe(svc.encrypt('same'));
  });

  it('detects tampering (GCM tag)', () => {
    const [id, iv, tag, ct] = svc.encrypt('secret').split(':') as [string, string, string, string];
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => svc.decrypt([id, iv, tag, flipped.toString('base64')].join(':'))).toThrow();
    expect(() => svc.decrypt('garbage')).toThrow('Malformed ciphertext');
    expect(() => svc.decrypt('k9:a:b:c')).toThrow('Unknown encryption key k9');
  });

  it('handles nullable values', () => {
    expect(svc.encryptNullable('')).toBeNull();
    expect(svc.encryptNullable(null)).toBeNull();
    expect(svc.decryptNullable(null)).toBeNull();
    expect(svc.decryptNullable(svc.encryptNullable('x'))).toBe('x');
  });

  it('rotates to the active key', () => {
    const old = svc.encrypt('4111222233334444');
    const rotated = EncryptionService.withRing(parseKeyRing(JSON.stringify({ k1, k2 }), 'k2'));
    expect(rotated.needsRotation(old)).toBe(true);
    const fresh = rotated.rotate(old);
    expect(rotated.keyIdOf(fresh)).toBe('k2');
    expect(rotated.needsRotation(fresh)).toBe(false);
    expect(rotated.needsRotation(null)).toBe(false);
    expect(rotated.decrypt(fresh)).toBe('4111222233334444');
    expect(rotated.decrypt(old)).toBe('4111222233334444');
    expect(rotated.activeKeyId).toBe('k2');
  });
});

describe('key ring parsing', () => {
  it('validates keys', () => {
    expect(() => parseKeyRing('nope', 'k1')).toThrow('must be JSON');
    expect(() => parseKeyRing('1', 'k1')).toThrow('JSON object');
    expect(() => parseKeyRing(JSON.stringify({ k1: 'c2hvcnQ=' }), 'k1')).toThrow('32 bytes');
    expect(() => parseKeyRing(JSON.stringify({ k1: 5 }), 'k1')).toThrow('base64 string');
    expect(() => parseKeyRing(JSON.stringify({ 'bad id': k1 }), 'k1')).toThrow('Invalid encryption key id');
    expect(() => parseKeyRing(JSON.stringify({ k1 }), 'k2')).toThrow('not in ENCRYPTION_KEYS');
  });
});

describe('masking', () => {
  it('keeps the last four alphanumerics', () => {
    expect(last4('6202 1500 1234')).toBe('1234');
    expect(last4('AB-12')).toBe('AB12');
    expect(last4('')).toBeNull();
    expect(last4(null)).toBeNull();
    expect(mask('1234')).toBe('••••1234');
    expect(mask(null)).toBe('');
  });
});
