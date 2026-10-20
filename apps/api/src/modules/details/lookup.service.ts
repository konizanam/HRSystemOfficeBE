import { Injectable } from '@nestjs/common';
import type { ParameterValue } from '@prisma/client';
import {
  type AdminLookupResponse,
  type AdminLookupValue,
  type CreateLookupValueRequest,
  LOOKUP_PARAMETER_TABLES,
  type LookupResponse,
  type LookupTable,
  lookupSeedValues,
  type UpdateLookupValueRequest,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import {
  assertVersion,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';

/** `ParameterValue.status` of an active row (the performance tables use the same convention). */
const ACTIVE = 'A';
const INACTIVE = 'I';

function toAdminDto(row: ParameterValue): AdminLookupValue {
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    sortOrder: row.sortOrder,
    isActive: row.status === ACTIVE,
    version: row.version,
  };
}

/**
 * The My Details pick lists (section 12.5 `GET /lookups/:table`), stored as `ParameterValue` rows
 * so HR can edit them. Services validate submitted values against the active rows, so a value HR
 * deactivates can no longer be chosen (records that already hold it keep it).
 */
@Injectable()
export class LookupService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(table: LookupTable): Promise<LookupResponse> {
    const rows = await this.db.prisma.parameterValue.findMany({
      where: { tableName: LOOKUP_PARAMETER_TABLES[table], status: ACTIVE },
      orderBy: [{ sortOrder: 'asc' }, { description: 'asc' }],
    });
    return {
      table,
      items: rows.map((r) => ({ code: r.code, description: r.description, sortOrder: r.sortOrder })),
    };
  }

  /** Display label of a stored code (country names); the code itself when unknown. */
  async describe(client: Tx, table: LookupTable, code: string | null): Promise<string | null> {
    if (!code) return null;
    const row = await client.parameterValue.findUnique({
      where: { tableName_code: { tableName: LOOKUP_PARAMETER_TABLES[table], code } },
      select: { description: true },
    });
    return row?.description ?? code;
  }

  /**
   * Checks values against the active rows of their tables. Each check is `[table, value, path]`;
   * null and undefined values are skipped. Throws one 422 listing every bad field.
   */
  async assertValid(
    client: Tx,
    checks: readonly [table: LookupTable, value: string | null | undefined, path: string][],
  ): Promise<void> {
    const wanted = checks.filter((c): c is [LookupTable, string, string] => typeof c[1] === 'string');
    if (wanted.length === 0) return;
    const rows = await client.parameterValue.findMany({
      where: {
        status: ACTIVE,
        OR: wanted.map(([table, value]) => ({ tableName: LOOKUP_PARAMETER_TABLES[table], code: value })),
      },
      select: { tableName: true, code: true },
    });
    const found = new Set(rows.map((r) => `${r.tableName}\u0000${r.code}`));
    const errors = wanted
      .filter(([table, value]) => !found.has(`${LOOKUP_PARAMETER_TABLES[table]}\u0000${value}`))
      .map(([, , path]) => ({ path, message: 'Pick a value from the list' }));
    if (errors.length > 0) throw new ValidationError(errors);
  }

  // ───────────── HR editing (ASSUMPTION B104) ─────────────

  async adminList(table: LookupTable): Promise<AdminLookupResponse> {
    const rows = await this.db.prisma.parameterValue.findMany({
      where: { tableName: LOOKUP_PARAMETER_TABLES[table] },
      orderBy: [{ sortOrder: 'asc' }, { description: 'asc' }],
    });
    return { table, items: rows.map(toAdminDto) };
  }

  async create(
    ctx: SecurityContext,
    table: LookupTable,
    input: CreateLookupValueRequest,
  ): Promise<AdminLookupValue> {
    return this.db.tx(ctx, async (tx) => {
      const tableName = LOOKUP_PARAMETER_TABLES[table];
      const existing = await tx.parameterValue.findUnique({
        where: { tableName_code: { tableName, code: input.code } },
      });
      if (existing) throw new ConflictError(`The ${table} list already has the code ${input.code}`);
      const last = await tx.parameterValue.findFirst({
        where: { tableName },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      const row = await tx.parameterValue.create({
        data: {
          tableName,
          code: input.code,
          description: input.description,
          sortOrder: input.sortOrder ?? (last?.sortOrder ?? 0) + 10,
          status: ACTIVE,
        },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'LOOKUP.CREATED',
        entityType: 'ParameterValue',
        entityId: row.id,
        after: row,
        metadata: { table },
      });
      return toAdminDto(row);
    });
  }

  async update(
    ctx: SecurityContext,
    table: LookupTable,
    id: number,
    input: UpdateLookupValueRequest,
  ): Promise<AdminLookupValue> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'ParameterValue', id);
      const before = await tx.parameterValue.findUnique({ where: { id } });
      if (!before || before.tableName !== LOOKUP_PARAMETER_TABLES[table])
        throw new NotFoundError('Lookup value');
      assertVersion(before, input.version);
      const after = await tx.parameterValue.update({
        where: { id },
        data: {
          description: input.description,
          sortOrder: input.sortOrder,
          status: input.isActive === undefined ? undefined : input.isActive ? ACTIVE : INACTIVE,
          version: { increment: 1 },
        },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'LOOKUP.UPDATED',
        entityType: 'ParameterValue',
        entityId: id,
        before,
        after,
        metadata: { table },
      });
      return toAdminDto(after);
    });
  }

  /**
   * Seeds every lookup table from the shared lists (section 14). Existing rows are never touched,
   * so HR edits survive a re-seed and a second run writes nothing.
   */
  async seed(ctx: SecurityContext, tables: readonly LookupTable[]): Promise<number> {
    let created = 0;
    for (const table of tables) {
      const tableName = LOOKUP_PARAMETER_TABLES[table];
      created += await this.db.tx(ctx, async (tx) => {
        const existing = new Set(
          (await tx.parameterValue.findMany({ where: { tableName }, select: { code: true } })).map(
            (r) => r.code,
          ),
        );
        let n = 0;
        for (const [index, value] of lookupSeedValues(table).entries()) {
          if (existing.has(value.code)) continue;
          const row = await tx.parameterValue.create({
            data: {
              tableName,
              code: value.code,
              description: value.description,
              sortOrder: (index + 1) * 10,
            },
          });
          this.audit.record(tx, ctx, {
            category: 'DATA_CHANGE',
            action: 'LOOKUP.SEEDED',
            entityType: 'ParameterValue',
            entityId: row.id,
            after: row,
            metadata: { table },
          });
          n += 1;
        }
        return n;
      });
    }
    return created;
  }
}
