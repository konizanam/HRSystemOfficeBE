import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuditActor } from '../common/context/security-context';
import { DbService } from '../prisma/db.service';
import type { Tx } from '../prisma/prisma-client';
import { type AuditEntry, currentAuditScope } from './audit-scope';
import { pendingFor } from './audit-writer';
import { type StoredAuditRow, verifyChain, type VerifyResult } from './audit-verify';

const VERIFY_BATCH = 1000;

@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  /**
   * Records an audit row in the current business transaction (section 9.4.1). The row is appended
   * to the chain when the transaction's callback finishes, as its last statement.
   */
  record(tx: Tx, actor: AuditActor, entry: AuditEntry): void {
    const scope = currentAuditScope();
    if (!scope || scope.tx !== tx) {
      throw new Error('audit.record must be called with the transaction opened by DbService.tx');
    }
    scope.entries.push(pendingFor(actor, entry));
  }

  /** For events with no business write (login failure, data views, exports, denials). */
  async recordStandalone(actor: AuditActor, entry: AuditEntry): Promise<void> {
    await this.db.tx(actor, async (tx) => {
      this.record(tx, actor, entry);
    });
  }

  /** Recomputes the chain between two timestamps (inclusive) or over the whole log. */
  async verify(range: { from?: Date; to?: Date } = {}): Promise<VerifyResult> {
    const prisma = this.db.prisma;
    const where: Prisma.AuditLogWhereInput = {};
    if (range.from || range.to) where.occurredAt = { gte: range.from, lte: range.to };

    const first = await prisma.auditLog.findFirst({ where, orderBy: { id: 'asc' }, select: { id: true } });
    let expectedPrev: string | null | undefined;
    if (!first) {
      expectedPrev = undefined;
    } else {
      const previous = await prisma.auditLog.findFirst({
        where: { id: { lt: first.id } },
        orderBy: { id: 'desc' },
        select: { hash: true },
      });
      expectedPrev = previous ? previous.hash : null;
    }

    async function* rows(): AsyncGenerator<StoredAuditRow> {
      let cursor: bigint | undefined;
      for (;;) {
        const batch = await prisma.auditLog.findMany({
          where: cursor === undefined ? where : { AND: [where, { id: { gt: cursor } }] },
          orderBy: { id: 'asc' },
          take: VERIFY_BATCH,
        });
        if (batch.length === 0) return;
        for (const row of batch) yield row as unknown as StoredAuditRow;
        cursor = batch[batch.length - 1]?.id;
        if (batch.length < VERIFY_BATCH) return;
      }
    }

    return verifyChain(rows(), expectedPrev);
  }
}
