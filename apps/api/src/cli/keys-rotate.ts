// `pnpm keys:rotate`: re-encrypts all encrypted fields to ENCRYPTION_ACTIVE_KEY (section 10.3).
import 'reflect-metadata';
import { AuditService } from '../audit/audit.service';
import { systemContext } from '../common/context/security-context';
import { env } from '../config/env';
import { EncryptionService } from '../crypto/encryption.service';
import { rotateKeys } from '../crypto/key-rotation';
import { DbService } from '../prisma/db.service';

async function main(): Promise<void> {
  const db = DbService.forUrl(env().DATABASE_URL);
  const audit = new AuditService(db);
  const crypto = new EncryptionService();
  const ctx = systemContext('cli-keys-rotate');
  try {
    const counts = await rotateKeys(db, audit, crypto, ctx);
    await audit.recordStandalone(ctx, {
      category: 'SYSTEM',
      action: 'SYSTEM.KEY_ROTATION',
      metadata: { activeKey: crypto.activeKeyId, counts, completed: true },
    });
    console.log(`Key rotation to ${crypto.activeKeyId} complete`, counts);
  } finally {
    await db.prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
