import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { auditScopeStorage, currentAuditScope, type AuditScope } from '../audit/audit-scope';
import { flushAuditScope } from '../audit/audit-writer';
import type { AuditActor } from '../common/context/security-context';
import { env } from '../config/env';
import { type AppPrismaClient, createPrismaClient, type Tx } from './prisma-client';

export interface TxOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Allow updateMany/deleteMany on audited models (jobs that audit per row). */
  allowBulk?: boolean;
  timeoutMs?: number;
}

/**
 * Owns the Prisma client. Every state change goes through `tx()`, which opens an interactive
 * transaction with an audit scope and appends the audit rows as the transaction's last statement:
 * if the audit write fails, the business write fails (section 0.2).
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly prisma: AppPrismaClient;

  constructor() {
    this.prisma = createPrismaClient(env().DATABASE_URL);
  }

  /** Builds a DbService over an explicit URL (CLI scripts and tests). */
  static forUrl(url: string): DbService {
    const db = Object.create(DbService.prototype) as DbService;
    Object.assign(db, { prisma: createPrismaClient(url) });
    return db;
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }

  /**
   * Runs `fn` in a transaction. Calls made while a transaction is already open (a service calling
   * another service) join it, so the whole use case commits or rolls back as one unit.
   */
  async tx<T>(actor: AuditActor, fn: (tx: Tx) => Promise<T>, options: TxOptions = {}): Promise<T> {
    const outer = currentAuditScope();
    if (outer) {
      if (options.allowBulk && !outer.allowBulk) {
        outer.allowBulk = true;
        try {
          return await fn(outer.tx as Tx);
        } finally {
          outer.allowBulk = false;
        }
      }
      return fn(outer.tx as Tx);
    }
    return this.prisma.$transaction(
      async (tx) => {
        const scope: AuditScope = {
          tx,
          actor,
          entries: [],
          writes: [],
          allowBulk: options.allowBulk ?? false,
        };
        return auditScopeStorage.run(scope, async () => {
          const result = await fn(tx);
          await flushAuditScope(scope);
          return result;
        });
      },
      {
        isolationLevel: options.isolationLevel,
        timeout: options.timeoutMs ?? 30_000,
        maxWait: 10_000,
      },
    );
  }

  /** Locks a row for the rest of the transaction (`SELECT … FOR UPDATE`). */
  async lockRow(tx: Tx, table: string, id: number | string): Promise<void> {
    if (!/^[A-Za-z]+$/.test(table)) throw new Error(`Invalid table name ${table}`);
    await tx.$executeRawUnsafe(`SELECT 1 FROM "${table}" WHERE id = $1 FOR UPDATE`, id);
  }

  /** Allocates the next value of a reference sequence inside the current transaction (section 8.1). */
  async nextSequence(tx: Tx, key: string): Promise<number> {
    const rows = await tx.$queryRaw<{ lastValue: number }[]>`
      INSERT INTO "ReferenceSequence"(key, "lastValue") VALUES (${key}, 1)
      ON CONFLICT (key) DO UPDATE SET "lastValue" = "ReferenceSequence"."lastValue" + 1
      RETURNING "lastValue"`;
    const value = rows[0]?.lastValue;
    if (value === undefined) throw new Error(`Sequence ${key} did not return a value`);
    return value;
  }
}
