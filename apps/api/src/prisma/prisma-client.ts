import { Prisma, PrismaClient } from '@prisma/client';
import { currentAuditScope, type ReadableDelegate } from '../audit/audit-scope';
import { AUDITED_MODELS, BULK_OPERATIONS, delegateName, WRITE_OPERATIONS } from '../audit/audited-models';

function readDelegate(client: unknown, model: string): ReadableDelegate {
  const delegate = (client as Record<string, unknown>)[delegateName(model)];
  if (!delegate || typeof (delegate as ReadableDelegate).findUnique !== 'function') {
    throw new Error(`No Prisma delegate for model ${model}`);
  }
  return delegate as ReadableDelegate;
}

function idOf(value: unknown): string | null {
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number' || typeof id === 'bigint') return String(id);
  }
  if (value && typeof value === 'object' && 'key' in value) {
    const key = (value as { key: unknown }).key;
    if (typeof key === 'string') return key;
  }
  if (value && typeof value === 'object' && 'userId' in value) {
    const userId = (value as { userId: unknown }).userId;
    if (typeof userId === 'string') return userId;
  }
  return null;
}

/**
 * Safety net (section 9.4.2): writes to audited models must happen inside DbService.tx, bulk
 * updates/deletes are refused unless the scope allows them, and every write is tracked so that a
 * generic DATA_CHANGE row is written when no explicit domain audit covered it.
 */
export const auditSafetyNet = Prisma.defineExtension({
  name: 'audit-safety-net',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!AUDITED_MODELS.has(model) || !WRITE_OPERATIONS.has(operation)) return query(args);

        const scope = currentAuditScope();
        if (!scope) {
          throw new Error(`Write to audited model ${model}.${operation} outside an audited transaction`);
        }
        if (BULK_OPERATIONS.has(operation) && !scope.allowBulk) {
          throw new Error(`${model}.${operation} is forbidden on audited models; write and audit per row`);
        }

        const where = (args as { where?: unknown }).where;
        let before: unknown = null;
        if ((operation === 'update' || operation === 'delete' || operation === 'upsert') && where) {
          before = await readDelegate(scope.tx, model).findUnique({ where });
        }

        const result = await query(args);

        if (operation === 'createMany' || BULK_OPERATIONS.has(operation)) {
          scope.writes.push({
            model,
            operation,
            entityId: null,
            before: null,
            after: {
              args: (args as { data?: unknown; where?: unknown }).data ?? null,
              where: where ?? null,
              result,
            },
          });
        } else if (operation === 'createManyAndReturn' && Array.isArray(result)) {
          for (const row of result) {
            scope.writes.push({ model, operation: 'create', entityId: idOf(row), before: null, after: row });
          }
        } else {
          scope.writes.push({
            model,
            operation: operation === 'upsert' ? (before ? 'update' : 'create') : operation,
            entityId: idOf(result) ?? idOf(before),
            before,
            after: operation === 'delete' ? null : result,
          });
        }
        return result;
      },
    },
  },
});

export function createPrismaClient(datasourceUrl: string) {
  return new PrismaClient({ datasourceUrl }).$extends(auditSafetyNet);
}

export type AppPrismaClient = ReturnType<typeof createPrismaClient>;

/** The interactive transaction client handed to `DbService.tx` callbacks. */
export type Tx = Omit<AppPrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;
