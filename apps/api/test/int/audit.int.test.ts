import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { systemContext } from '../../src/common/context/security-context';
import { DbService } from '../../src/prisma/db.service';

const ctx = { ...systemContext('int-audit'), username: 'int-test' };

describe('audit trail (Phase 1 acceptance)', () => {
  let db: DbService;
  let audit: AuditService;
  let owner: PrismaClient;

  beforeAll(() => {
    db = DbService.forUrl(inject('databaseUrl'));
    audit = new AuditService(db);
    owner = new PrismaClient({ datasourceUrl: inject('ownerDatabaseUrl') });
  });

  afterAll(async () => {
    await db.prisma.$disconnect();
    await owner.$disconnect();
  });

  it('writes explicit audit rows in the business transaction and keeps the chain valid', async () => {
    const company = await db.tx(ctx, async (tx) => {
      const c = await tx.company.create({ data: { code: `AUD${Date.now()}`, name: 'Audit Co' } });
      audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'COMPANY.CREATED',
        entityType: 'Company',
        entityId: c.id,
        after: c,
      });
      return c;
    });
    const rows = await db.prisma.auditLog.findMany({
      where: { entityType: 'Company', entityId: String(company.id) },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('COMPANY.CREATED');
    expect((await audit.verify()).ok).toBe(true);
  });

  it('adds a generic DATA_CHANGE row when no explicit audit covers a write', async () => {
    const company = await db.tx(ctx, (tx) =>
      tx.company.create({ data: { code: `GEN${Date.now()}`, name: 'Generic' } }),
    );
    await db.tx(ctx, (tx) => tx.company.update({ where: { id: company.id }, data: { name: 'Generic 2' } }));
    const rows = await db.prisma.auditLog.findMany({
      where: { entityType: 'Company', entityId: String(company.id) },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual(['DATA_CHANGE.COMPANY.CREATE', 'DATA_CHANGE.COMPANY.UPDATE']);
    expect(rows[1]?.changes).toEqual([{ path: 'name', from: 'Generic', to: 'Generic 2' }]);
    expect((rows[1]?.before as { name: string }).name).toBe('Generic');
  });

  it('refuses audited writes outside a transaction and bulk writes', async () => {
    await expect(db.prisma.company.create({ data: { code: 'NOPE', name: 'x' } })).rejects.toThrow(
      /outside an audited transaction/,
    );
    await expect(
      db.tx(ctx, (tx) => tx.company.updateMany({ where: { code: 'NOPE' }, data: { name: 'y' } })),
    ).rejects.toThrow(/forbidden on audited models/);
    // Allowed for jobs that audit per row.
    await expect(
      db.tx(ctx, (tx) => tx.company.updateMany({ where: { code: 'NOPE' }, data: { name: 'y' } }), {
        allowBulk: true,
      }),
    ).resolves.toEqual({ count: 0 });
  });

  it('rolls back the business write when the audit write fails', async () => {
    const code = `RB${Date.now()}`;
    await expect(
      db.tx(ctx, async (tx) => {
        await tx.company.create({ data: { code, name: 'Rollback' } });
        audit.record(tx, ctx, { category: 'NOT_A_CATEGORY' as 'SYSTEM', action: 'BROKEN' });
      }),
    ).rejects.toThrow();
    expect(await db.prisma.company.findUnique({ where: { code } })).toBeNull();
  });

  it('redacts secrets and encrypted values in stored rows', async () => {
    const user = await db.tx(ctx, (tx) =>
      tx.user.create({
        data: { username: `audit-${Date.now()}`, passwordHash: 'argon-hash', mfaSecretEnc: 'k1:a:b:c' },
      }),
    );
    const row = await db.prisma.auditLog.findFirst({ where: { entityType: 'User', entityId: user.id } });
    const after = row?.after as Record<string, unknown>;
    expect(after.passwordHash).toBe('[REDACTED]');
    expect(after.mfaSecretEnc).toBe('[REDACTED]');
    expect(JSON.stringify(row, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(
      'argon-hash',
    );
  });

  it('cannot be updated, deleted or truncated by the app role', async () => {
    await expect(db.prisma.$executeRawUnsafe('UPDATE "AuditLog" SET action = action')).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.prisma.$executeRawUnsafe('DELETE FROM "AuditLog"')).rejects.toThrow(/permission denied/);
    await expect(db.prisma.$executeRawUnsafe('TRUNCATE "AuditLog"')).rejects.toThrow(/permission denied/);
  });

  it('cannot be modified even by the owner while the trigger is in place', async () => {
    await expect(owner.$executeRawUnsafe('UPDATE "AuditLog" SET action = action')).rejects.toThrow(
      /append-only/,
    );
    await expect(owner.$executeRawUnsafe('DELETE FROM "AuditLog"')).rejects.toThrow(/append-only/);
  });

  it('keeps the leave ledger and workflow actions append-only', async () => {
    await expect(db.prisma.$executeRawUnsafe('DELETE FROM "LeaveLedgerEntry"')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      db.prisma.$executeRawUnsafe('UPDATE "WorkflowAction" SET comment = comment'),
    ).rejects.toThrow(/permission denied/);
    await expect(owner.$executeRawUnsafe('DELETE FROM "WorkflowAction"')).rejects.toThrow(/append-only/);
  });

  it('serialises concurrent writers into one valid chain', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        audit.recordStandalone(ctx, { category: 'SYSTEM', action: `SYSTEM.TEST_${i}` }),
      ),
    );
    const result = await audit.verify();
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(20);
  });

  it('allocates unique reference numbers under concurrency', async () => {
    const key = `TEST:${Date.now()}`;
    const values = await Promise.all(
      Array.from({ length: 100 }, () => db.tx(ctx, (tx) => db.nextSequence(tx, key))),
    );
    expect(new Set(values).size).toBe(100);
    expect(Math.max(...values)).toBe(100);
  });
});
