import { Injectable } from '@nestjs/common';
import type { ParameterValue } from '@prisma/client';
import {
  type AdminParameterValue,
  type AdminParameterValuesResponse,
  type CreateParameterValueRequest,
  PERFORMANCE_PARAMETER_TABLE_LABELS,
  parameterParentTable,
  type ParameterValuesQuery,
  type ParameterValuesResponse,
  type PerformanceParameterTable,
  type UpdateParameterValueRequest,
} from '@peoplehub/shared';
import type { SecurityContext } from '../../common/context/security-context';
import { ValidationError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { LookupService, PARAMETER_ACTIVE } from '../details/lookup.service';

type ParameterWithParent = ParameterValue & { parent: { code: string } | null };

function toAdminDto(row: ParameterWithParent): AdminParameterValue {
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    parentId: row.parentId,
    parentCode: row.parent?.code ?? null,
    sortOrder: row.sortOrder,
    isActive: row.status === PARAMETER_ACTIVE,
    version: row.version,
  };
}

/**
 * The performance parameter tables (section 5.9) on `ParameterValue`, one `tableName` per table.
 * Writes go through the My Details `LookupService` (same row format, audit and conflict rules);
 * this service adds the KPA → KPI → Sub KPI and Competency Area → Competency → Sub Competency
 * hierarchy: a child table needs a parent from its parent table, a flat table has none.
 */
@Injectable()
export class PerformanceParameterService {
  constructor(
    private readonly db: DbService,
    private readonly lookups: LookupService,
  ) {}

  /** GET /lookups/parameters/:table: the active rows (optionally the children of one parent). */
  async list(
    table: PerformanceParameterTable,
    query: ParameterValuesQuery,
  ): Promise<ParameterValuesResponse> {
    const rows = await this.db.prisma.parameterValue.findMany({
      where: { tableName: table, status: PARAMETER_ACTIVE, parentId: query.parentId },
      orderBy: [{ sortOrder: 'asc' }, { description: 'asc' }],
    });
    return {
      table,
      parentTable: parameterParentTable(table),
      items: rows.map((r) => ({
        id: r.id,
        code: r.code,
        description: r.description,
        parentId: r.parentId,
        sortOrder: r.sortOrder,
      })),
    };
  }

  /** GET /admin/parameters/:table: every row, inactive ones included. */
  async adminList(table: PerformanceParameterTable): Promise<AdminParameterValuesResponse> {
    const rows = await this.db.prisma.parameterValue.findMany({
      where: { tableName: table },
      include: { parent: { select: { code: true } } },
      orderBy: [{ sortOrder: 'asc' }, { description: 'asc' }],
    });
    return { table, parentTable: parameterParentTable(table), items: rows.map(toAdminDto) };
  }

  async create(
    ctx: SecurityContext,
    table: PerformanceParameterTable,
    input: CreateParameterValueRequest,
  ): Promise<AdminParameterValue> {
    const row = await this.lookups.createParameterRow(
      ctx,
      {
        tableName: table,
        code: input.code,
        description: input.description,
        sortOrder: input.sortOrder,
        parentId: input.parentId ?? null,
      },
      {
        action: 'PERFORMANCE_PARAMETER.CREATED',
        metadata: { table },
        listLabel: `The ${PERFORMANCE_PARAMETER_TABLE_LABELS[table]} table`,
        check: (tx) => this.checkParent(tx, table, input.parentId ?? null, true),
      },
    );
    return this.adminRow(row.id);
  }

  async update(
    ctx: SecurityContext,
    table: PerformanceParameterTable,
    id: number,
    input: UpdateParameterValueRequest,
  ): Promise<AdminParameterValue> {
    const action =
      input.isActive === false
        ? 'PERFORMANCE_PARAMETER.DEACTIVATED'
        : input.isActive === true
          ? 'PERFORMANCE_PARAMETER.REACTIVATED'
          : 'PERFORMANCE_PARAMETER.UPDATED';
    await this.lookups.updateParameterRow(ctx, table, id, input, {
      action,
      metadata: { table },
      listLabel: `The ${PERFORMANCE_PARAMETER_TABLE_LABELS[table]} table`,
      check:
        input.parentId === undefined
          ? undefined
          : (tx) => this.checkParent(tx, table, input.parentId ?? null, false, id),
    });
    return this.adminRow(id);
  }

  /** DELETE /admin/parameters/:table/:id: deactivates the row (no hard deletes). */
  deactivate(
    ctx: SecurityContext,
    table: PerformanceParameterTable,
    id: number,
    version: number,
  ): Promise<AdminParameterValue> {
    return this.update(ctx, table, id, { version, isActive: false });
  }

  private async adminRow(id: number): Promise<AdminParameterValue> {
    const row = await this.db.prisma.parameterValue.findUniqueOrThrow({
      where: { id },
      include: { parent: { select: { code: true } } },
    });
    return toAdminDto(row);
  }

  /**
   * A child table needs an active parent from its parent table (on create; on update when the
   * parent changes); a flat table takes none.
   */
  private async checkParent(
    tx: Tx,
    table: PerformanceParameterTable,
    parentId: number | null,
    creating: boolean,
    selfId?: number,
  ): Promise<void> {
    const parentTable = parameterParentTable(table);
    if (parentTable === null) {
      if (parentId !== null)
        throw ValidationError.field('parentId', `${PERFORMANCE_PARAMETER_TABLE_LABELS[table]} has no parent`);
      return;
    }
    const label = PERFORMANCE_PARAMETER_TABLE_LABELS[parentTable];
    if (parentId === null) {
      if (creating || selfId !== undefined) throw ValidationError.field('parentId', `Choose the ${label}`);
      return;
    }
    const parent = await tx.parameterValue.findUnique({ where: { id: parentId } });
    if (!parent || parent.tableName !== parentTable)
      throw ValidationError.field('parentId', `Choose a ${label}`);
    if (parent.status !== PARAMETER_ACTIVE)
      throw ValidationError.field('parentId', `This ${label} is no longer active`);
  }
}
