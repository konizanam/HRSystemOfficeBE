import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  computeAuditHash,
  isoMicros,
  sha256Hex,
  toJsonValue,
} from '../../src/audit/canonical-json';
import { type StoredAuditRow, verifyChain } from '../../src/audit/audit-verify';
import { addSafetyNetEntries } from '../../src/audit/audit-writer';
import type { AuditScope } from '../../src/audit/audit-scope';
import { delegateName, modelConstant } from '../../src/audit/audited-models';

function row(id: number, prevHash: string | null, extra: Partial<StoredAuditRow> = {}): StoredAuditRow {
  const base = {
    id: BigInt(id),
    occurredAt: new Date(Date.UTC(2026, 9, 20, 10, 0, id)),
    requestId: `req-${id}`,
    sessionId: 's1',
    actorUserId: 'u1',
    actorUsername: 'jdoe',
    actingAsEmployeeId: 7,
    subjectEmployeeId: 7,
    category: 'WORKFLOW',
    action: 'LEAVE.SUBMITTED',
    entityType: 'LeaveApplication',
    entityId: String(id),
    outcome: 'SUCCESS',
    before: null,
    after: { units: '1.5000', status: 'IN_PROGRESS' },
    changes: null,
    reason: null,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    metadata: { n: id },
    prevHash,
    ...extra,
  };
  return { ...base, hash: computeAuditHash(base) };
}

function chain(n: number): StoredAuditRow[] {
  const rows: StoredAuditRow[] = [];
  let prev: string | null = null;
  for (let i = 1; i <= n; i++) {
    const r = row(i, prev);
    rows.push(r);
    prev = r.hash;
  }
  return rows;
}

describe('canonical JSON', () => {
  it('sorts keys recursively and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('encodes decimals as strings, timestamps with µs and bigints as strings', () => {
    const d = new Date('2026-10-20T08:15:30.123Z');
    expect(isoMicros(d)).toBe('2026-10-20T08:15:30.123000Z');
    expect(canonicalJson({ amount: new Prisma.Decimal('3.8358'), at: d, id: 12n })).toBe(
      '{"amount":"3.8358","at":"2026-10-20T08:15:30.123000Z","id":"12"}',
    );
  });

  it('normalises awkward values', () => {
    expect(toJsonValue(undefined)).toBeUndefined();
    expect(toJsonValue(() => 1)).toBeUndefined();
    expect(toJsonValue(Number.NaN)).toBe('NaN');
    expect(toJsonValue('a\u0000b')).toBe('ab');
    expect(toJsonValue(Buffer.from('abc'))).toBe('[binary 3 bytes]');
    expect(toJsonValue({ a: undefined, b: [undefined, 1] })).toEqual({ b: [null, 1] });
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('hashes prevHash || canonical row', () => {
    const r = row(1, null);
    const { hash: _hash, ...rest } = r;
    expect(r.hash).toBe(sha256Hex(canonicalJson(rest)));
    const r2 = row(2, r.hash);
    const { hash: _h2, ...rest2 } = r2;
    expect(r2.hash).toBe(sha256Hex(r.hash + canonicalJson(rest2)));
  });
});

describe('verifyChain', () => {
  it('accepts an intact chain', async () => {
    const result = await verifyChain(chain(5), null);
    expect(result).toMatchObject({ ok: true, checked: 5, firstId: '1', lastId: '5', firstBrokenId: null });
  });

  it('accepts an empty chain', async () => {
    expect((await verifyChain([], null)).ok).toBe(true);
  });

  const tamperings: [string, (r: StoredAuditRow) => void][] = [
    ['action', (r) => (r.action = 'LEAVE.APPROVED')],
    ['after payload', (r) => (r.after = { units: '9.0000', status: 'IN_PROGRESS' })],
    ['actor', (r) => (r.actorUserId = 'someone-else')],
    ['timestamp', (r) => (r.occurredAt = new Date(r.occurredAt.getTime() + 1))],
    ['outcome', (r) => (r.outcome = 'FAILURE')],
    ['metadata', (r) => (r.metadata = { n: 99 })],
    ['hash', (r) => (r.hash = 'f'.repeat(64))],
  ];

  for (const [what, tamper] of tamperings) {
    it(`detects a tampered ${what}`, async () => {
      for (const target of [1, 3, 5]) {
        const rows = chain(5);
        tamper(rows[target - 1] as StoredAuditRow);
        const result = await verifyChain(rows, null);
        expect(result.ok).toBe(false);
        expect(result.firstBrokenId).toBe(String(target));
      }
    });
  }

  it('detects a deleted row', async () => {
    const rows = chain(5);
    rows.splice(2, 1);
    const result = await verifyChain(rows, null);
    expect(result).toMatchObject({ ok: false, firstBrokenId: '4' });
  });

  it('detects a re-hashed forgery through the next link', async () => {
    const rows = chain(4);
    const forged = row(2, rows[0]?.hash ?? null, { action: 'FORGED' });
    rows[1] = forged;
    const result = await verifyChain(rows, null);
    expect(result).toMatchObject({ ok: false, firstBrokenId: '3' });
  });

  it('checks the link to the row before a range', async () => {
    const rows = chain(4).slice(2);
    expect((await verifyChain(rows, 'wrong')).ok).toBe(false);
    expect((await verifyChain(rows, undefined)).ok).toBe(true);
  });
});

describe('safety net', () => {
  function scope(): AuditScope {
    return { tx: {}, actor: { userId: 'u1' }, entries: [], writes: [], allowBulk: false };
  }

  it('adds a generic DATA_CHANGE row for uncovered writes only', () => {
    const s = scope();
    s.writes.push(
      {
        model: 'BankAccount',
        operation: 'update',
        entityId: '5',
        before: { id: 5, employeeId: 9, holderName: 'A' },
        after: { id: 5, employeeId: 9, holderName: 'B' },
      },
      { model: 'Employee', operation: 'update', entityId: '9', before: { id: 9 }, after: { id: 9 } },
    );
    s.entries.push({
      actor: s.actor,
      occurredAt: new Date(),
      entry: { category: 'DATA_CHANGE', action: 'EMPLOYEE.UPDATED', entityType: 'Employee', entityId: 9 },
    });
    addSafetyNetEntries(s);
    expect(s.entries).toHaveLength(2);
    expect(s.entries[1]?.entry).toMatchObject({
      action: 'DATA_CHANGE.BANK_ACCOUNT.UPDATE',
      entityType: 'BankAccount',
      entityId: '5',
      subjectEmployeeId: 9,
    });
  });

  it('names models and delegates', () => {
    expect(modelConstant('EmployeeLeaveEntitlement')).toBe('EMPLOYEE_LEAVE_ENTITLEMENT');
    expect(modelConstant('createManyAndReturn')).toBe('CREATE_MANY_AND_RETURN');
    expect(delegateName('BankAccount')).toBe('bankAccount');
  });
});
