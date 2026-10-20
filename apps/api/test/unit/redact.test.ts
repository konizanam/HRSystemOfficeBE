import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { diff, REDACTED, REDACTION_POLICIES, redact } from '../../src/audit/redact';

/** Secret columns in the schema (PasswordHistory.hash is covered by its model policy). */
const SECRET_NAME = /^(passwordHash|tokenHash|csrfToken|mfaSecretEnc)$/;

/** A plausible sample value for a scalar field of the given Prisma type. */
function sample(field: Prisma.DMMF.Field): unknown {
  if (field.isList) return [];
  switch (field.type) {
    case 'String':
      return field.name.endsWith('Enc') ? 'k1:aXY=:dGFn:Y2lwaGVy' : `value-of-${field.name}`;
    case 'Int':
      return 42;
    case 'BigInt':
      return 42n;
    case 'Decimal':
      return new Prisma.Decimal('12.3456');
    case 'Boolean':
      return true;
    case 'DateTime':
      return new Date('2026-10-20T00:00:00Z');
    case 'Json':
      return { a: 1 };
    default:
      return field.kind === 'enum' ? 'X' : null;
  }
}

describe('redact() policies for every model', () => {
  const models = Prisma.dmmf.datamodel.models;

  it('covers the schema', () => {
    expect(models.length).toBeGreaterThan(60);
    for (const model of Object.keys(REDACTION_POLICIES)) {
      expect(models.map((m) => m.name)).toContain(model);
    }
  });

  for (const model of models) {
    it(`${model.name}: never leaks secrets or ciphertext`, () => {
      const data: Record<string, unknown> = {};
      for (const f of model.fields) if (f.kind !== 'object') data[f.name] = sample(f);
      const out = redact(model.name, data) as Record<string, unknown>;
      const policy = REDACTION_POLICIES[model.name];

      for (const f of model.fields) {
        if (f.kind === 'object') continue;
        if (policy?.pick && !policy.pick.includes(f.name)) {
          expect(out).not.toHaveProperty(f.name);
          continue;
        }
        const value = out[f.name];
        if (SECRET_NAME.test(f.name) || policy?.secret?.includes(f.name)) {
          expect(value).toBe(REDACTED);
        } else if (f.name.endsWith('Enc')) {
          expect(Object.keys(value as object).sort()).toEqual(['changed', 'last4']);
          expect((value as { changed: boolean }).changed).toBe(true);
          expect(JSON.stringify(value)).not.toContain('k1:');
        }
      }
      expect(JSON.stringify(out)).not.toContain('k1:aXY=');
    });
  }
});

describe('redact() rules', () => {
  it('replaces encrypted fields with last4 + changed', () => {
    const before = { id: 1, accountNumberEnc: 'k1:a:b:c', accountNumberLast4: '1234', holderName: 'A' };
    const after = { id: 1, accountNumberEnc: 'k1:d:e:f', accountNumberLast4: '9876', holderName: 'A' };
    expect(redact('BankAccount', after, before)).toEqual({
      id: 1,
      accountNumberEnc: { last4: '9876', changed: true },
      accountNumberLast4: '9876',
      holderName: 'A',
    });
    expect(redact('BankAccount', before, before)).toMatchObject({
      accountNumberEnc: { last4: '1234', changed: false },
    });
  });

  it('redacts secrets by name in any model and keeps nulls', () => {
    expect(redact('Whatever', { password: 'x', passwordHash: null, token: 't', name: 'n' })).toEqual({
      password: REDACTED,
      passwordHash: null,
      token: REDACTED,
      name: 'n',
    });
  });

  it('reduces attachments to id, file name, sha256 and size', () => {
    expect(
      redact('Attachment', {
        id: 'a',
        fileName: 'f.pdf',
        sha256: 'h',
        sizeBytes: 10,
        storageKey: '2026/10/a',
        uploadedByUserId: 'u',
      }),
    ).toEqual({ id: 'a', fileName: 'f.pdf', sha256: 'h', sizeBytes: 10 });
  });

  it('handles nested values, arrays and primitives', () => {
    expect(redact(null, null)).toBeNull();
    expect(redact(null, 5)).toBe(5);
    expect(redact('User', [{ passwordHash: 'h' }])).toEqual([{ passwordHash: REDACTED }]);
    expect(redact(null, { nested: { identityNumberEnc: 'k1:x', mfaSecretEnc: 'k1:y', ok: 1 } })).toEqual({
      nested: { identityNumberEnc: { last4: null, changed: true }, mfaSecretEnc: '[REDACTED]', ok: 1 },
    });
  });
});

describe('diff()', () => {
  it('lists changed paths, ignoring updatedAt/version', () => {
    expect(
      diff(
        { a: 1, b: { c: 2, d: 3 }, version: 1, updatedAt: 'x', gone: 1 },
        { a: 1, b: { c: 2, d: 4 }, version: 2, updatedAt: 'y', added: true },
      ),
    ).toEqual([
      { path: 'added', from: null, to: true },
      { path: 'b.d', from: 3, to: 4 },
      { path: 'gone', from: 1, to: null },
    ]);
  });

  it('treats encrypted markers as leaf values', () => {
    expect(diff({ x: { last4: '1', changed: false } }, { x: { last4: '2', changed: true } })).toEqual([
      { path: 'x', from: { last4: '1', changed: false }, to: { last4: '2', changed: true } },
    ]);
  });

  it('compares non-objects directly', () => {
    expect(diff(null, { a: 1 })).toEqual([{ path: '$', from: null, to: { a: 1 } }]);
    expect(diff(1, 1)).toEqual([]);
  });
});
