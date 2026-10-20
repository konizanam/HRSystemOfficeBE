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
  return counts;
}
