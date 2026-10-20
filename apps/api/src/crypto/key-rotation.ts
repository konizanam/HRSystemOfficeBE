import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { SecurityContext } from '../common/context/security-context';
import { DbService } from '../prisma/db.service';
import type { Tx } from '../prisma/prisma-client';
import { EncryptionService } from './encryption.service';

/** Every encrypted column (section 10.3). */
export const ENCRYPTED_COLUMNS: Record<string, string[]> = {
  employee: ['identityNumberEnc', 'birthCertificateNumberEnc', 'passportNumberEnc', 'taxNumberEnc'],
  user: ['mfaSecretEnc'],
  bankAccount: ['accountNumberEnc'],
  driversLicence: ['licenceNumberEnc'],
  familyMember: ['identityNumberEnc'],
  beneficiary: ['identityNumberEnc'],
};

const MODEL_NAMES: Record<string, string> = {
  employee: 'Employee',
  user: 'User',
  bankAccount: 'BankAccount',
  driversLicence: 'DriversLicence',
  familyMember: 'FamilyMember',
  beneficiary: 'Beneficiary',
};

interface RotatableDelegate {
  findMany(args: {
    where: unknown;
    select: Record<string, boolean>;
    take: number;
    orderBy: { id: 'asc' };
    cursor?: { id: unknown };
    skip?: number;
  }): Promise<Record<string, unknown>[]>;
  update(args: { where: { id: unknown }; data: Record<string, unknown> }): Promise<unknown>;
}

function delegate(client: unknown, name: string): RotatableDelegate {
  return (client as Record<string, RotatableDelegate>)[name] as RotatableDelegate;
}

/** Re-encrypts every encrypted value to the active key, in batches, auditing each row. */
export async function rotateKeys(
  db: DbService,
  audit: AuditService,
  crypto: EncryptionService,
  ctx: SecurityContext,
  batchSize = 200,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [name, columns] of Object.entries(ENCRYPTED_COLUMNS)) {
    counts[name] = 0;
    const select: Record<string, boolean> = { id: true };
    for (const c of columns) select[c] = true;
    let cursor: unknown;
    for (;;) {
      const rows = await delegate(db.prisma, name).findMany({
        where: { OR: columns.map((c) => ({ [c]: { not: null } })) },
        select,
        take: batchSize,
        orderBy: { id: 'asc' },
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      });
      if (rows.length === 0) break;
      await db.tx(ctx, async (tx: Tx) => {
        for (const row of rows) {
          const data: Record<string, unknown> = {};
          for (const c of columns) {
            const value = row[c];
            if (typeof value === 'string' && crypto.needsRotation(value)) data[c] = crypto.rotate(value);
          }
          if (Object.keys(data).length === 0) continue;
          await delegate(tx, name).update({ where: { id: row.id }, data });
          audit.record(tx, ctx, {
            category: 'SYSTEM',
            action: 'SYSTEM.KEY_ROTATION',
            entityType: MODEL_NAMES[name],
            entityId: String(row.id),
            metadata: { columns: Object.keys(data), toKey: crypto.activeKeyId },
          });
          counts[name] = (counts[name] ?? 0) + 1;
        }
      });
      cursor = rows[rows.length - 1]?.id;
      if (rows.length < batchSize) break;
    }
  }
  counts.changeRequest = await rotateChangeRequests(db, audit, crypto, ctx, batchSize);
  return counts;
}

/**
 * Re-encrypts the sealed values (`{ valueEnc, last4 }`) inside a change request's JSON. Returns the
 * new value and whether anything changed.
 */
export function resealJson(value: unknown, crypto: EncryptionService): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const r = resealJson(item, crypto);
      changed ||= r.changed;
      return r.value;
    });
    return { value: out, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'valueEnc' && typeof item === 'string' && crypto.needsRotation(item)) {
        out[key] = crypto.rotate(item);
        changed = true;
      } else {
        const r = resealJson(item, crypto);
        out[key] = r.value;
        changed ||= r.changed;
      }
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

/** Change requests keep sensitive values sealed inside `proposed` and `before` (Phase 6). */
async function rotateChangeRequests(
  db: DbService,
  audit: AuditService,
  crypto: EncryptionService,
  ctx: SecurityContext,
  batchSize: number,
): Promise<number> {
  let count = 0;
  let cursor: number | undefined;
  for (;;) {
    const rows = await db.prisma.changeRequest.findMany({
      select: { id: true, employeeId: true, proposed: true, before: true },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    if (rows.length === 0) break;
    await db.tx(ctx, async (tx: Tx) => {
      for (const row of rows) {
        const proposed = resealJson(row.proposed, crypto);
        const before = resealJson(row.before, crypto);
        if (!proposed.changed && !before.changed) continue;
        await tx.changeRequest.update({
          where: { id: row.id },
          data: {
            proposed: proposed.value as Prisma.InputJsonValue,
            ...(before.changed ? { before: before.value as Prisma.InputJsonValue } : {}),
          },
        });
        audit.record(tx, ctx, {
          category: 'SYSTEM',
          action: 'SYSTEM.KEY_ROTATION',
          entityType: 'ChangeRequest',
          entityId: String(row.id),
          subjectEmployeeId: row.employeeId,
          metadata: {
            columns: ['proposed', 'before'].filter((_, i) => [proposed, before][i]?.changed),
            toKey: crypto.activeKeyId,
          },
        });
        count += 1;
      }
    });
    cursor = rows[rows.length - 1]?.id;
    if (rows.length < batchSize) break;
  }
  return count;
}
