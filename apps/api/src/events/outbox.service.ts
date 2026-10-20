import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { systemContext } from '../common/context/security-context';
import { env } from '../config/env';
import { JobsService } from '../jobs/jobs.service';
import { DbService } from '../prisma/db.service';
import type { Tx } from '../prisma/prisma-client';
import { type DomainEvent, EventBus } from './event-bus';

export const OUTBOX_PUBLISH_JOB = 'outbox.publish';

/** Delivery attempts before an event is left aside (it stays in the table with `lastError`). */
export const OUTBOX_MAX_ATTEMPTS = 10;

/** Most events one publisher run delivers. */
const BATCH_LIMIT = 500;

interface OutboxRow {
  id: bigint;
  type: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
}

export interface PublishCounts extends Record<string, number> {
  published: number;
  failed: number;
}

/**
 * Transactional outbox (section 7.3). `add` writes an event in the caller's business
 * transaction, so the event exists if and only if the change committed. The publisher (a pg-boss
 * job every minute, kicked right after each workflow change when jobs run) delivers each event in
 * its own transaction: it locks the row (`FOR UPDATE SKIP LOCKED`, so several API instances can
 * publish side by side), runs the listeners and sets `publishedAt`.
 */
@Injectable()
export class OutboxService implements OnModuleInit {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    // Plumbing, not a business job: a SYSTEM.JOB_RUN row every minute would only add noise.
    this.jobs.register(OUTBOX_PUBLISH_JOB, () => this.publishPending(), { cron: '* * * * *', audit: false });
  }

  /** Writes an event in the current business transaction. */
  async add(tx: Tx, type: string, payload: Record<string, unknown>): Promise<void> {
    await tx.outboxEvent.create({ data: { type, payload: payload as Prisma.InputJsonObject } });
  }

  /**
   * Asks for a publisher run soon after a commit. With jobs disabled (tests, CLIs) nothing
   * happens and the caller (or the test) runs `publishPending` itself.
   */
  kick(): void {
    if (!env().JOBS_ENABLED) return;
    this.jobs.send(OUTBOX_PUBLISH_JOB).catch((err: unknown) => {
      this.logger.warn({ err }, 'Could not queue the outbox publisher');
    });
  }

  /** Delivers pending events, oldest first. Returns the counts for the job log. */
  async publishPending(limit = BATCH_LIMIT): Promise<PublishCounts> {
    const counts: PublishCounts = { published: 0, failed: 0 };
    const ctx = systemContext('outbox-publisher');
    const skipped: bigint[] = [];
    for (let i = 0; i < limit; i++) {
      const effects: (() => void)[] = [];
      let current: OutboxRow | null = null;
      // Set inside the transaction callback; an object so the assignment is visible to the catch.
      const attempt: { id: bigint | null } = { id: null };
      try {
        current = await this.db.tx(ctx, async (tx) => {
          const rows = await tx.$queryRaw<OutboxRow[]>`
            SELECT id, type, payload, "createdAt" FROM "OutboxEvent"
            WHERE "publishedAt" IS NULL AND attempts < ${OUTBOX_MAX_ATTEMPTS}
              AND NOT (id = ANY(${skipped}::bigint[]))
            ORDER BY id
            LIMIT 1
            FOR UPDATE SKIP LOCKED`;
          const row = rows[0];
          if (!row) return null;
          attempt.id = row.id;
          const event: DomainEvent = {
            id: row.id,
            type: row.type,
            payload: (row.payload ?? {}) as Record<string, unknown>,
            createdAt: row.createdAt,
          };
          await this.bus.dispatch(event, { tx, afterCommit: (effect) => effects.push(effect) });
          await tx.outboxEvent.update({ where: { id: row.id }, data: { publishedAt: new Date() } });
          return row;
        });
      } catch (err) {
        counts.failed += 1;
        this.logger.error({ err }, 'Outbox delivery failed');
        if (attempt.id === null) break;
        await this.recordFailure(attempt.id, err);
        skipped.push(attempt.id);
        continue;
      }
      if (!current) break;
      counts.published += 1;
      for (const effect of effects) {
        try {
          effect();
        } catch (err) {
          this.logger.error({ err, type: current.type }, 'Outbox side effect failed');
        }
      }
    }
    return counts;
  }

  /** The failing transaction rolled back, so the attempt is recorded in a new one. */
  private async recordFailure(id: bigint, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    await this.db.prisma.outboxEvent.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastError: message.slice(0, 2000) },
    });
  }
}
