import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AUDIT_EXPORT_COLUMNS,
  AUDIT_EXPORT_MAX_ROWS,
  type AuditActorOptionsQuery,
  type AuditActorOptionsResponse,
  type AuditExportRequest,
  type AuditFilters,
  type AuditListQuery,
  type AuditListResponse,
  type AuditRowDetail,
  type AuditVerifyQuery,
  type AuditVerifyResponse,
  businessFromDate,
  ENTITY_HISTORY_LIMIT,
  type EntityHistoryResponse,
  type ReportColumn,
  type ReportRow,
  type WorkflowActionType,
} from '@peoplehub/shared';
import type { Readable } from 'node:stream';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import { NotFoundError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import { csvStream, xlsxStream } from '../reports/report-writers';
import { userNames } from '../reports/report-helpers';
import {
  auditConditions,
  instantFrom,
  instantTo,
  type RawAuditRow,
  toAuditDetail,
  toAuditRow,
  whereSql,
} from './audit-query';
import { EntityHistoryAccess } from './entity-history-access';

const EXPORT_BATCH = 1000;

const COLUMNS = Prisma.sql`id, "occurredAt", "requestId", "sessionId", "actorUserId", "actorUsername",
  "actingAsEmployeeId", "subjectEmployeeId", category, action, "entityType", "entityId", outcome,
  before, after, changes, reason, ip, "userAgent", metadata, "prevHash", hash`;

export interface AuditExport {
  stream: Readable;
  contentType: string;
  fileName: string;
}

/**
 * The audit API (sections 9.7 and 12.11): the explorer with its filters, one row with its
 * snapshots, the record history of an entity with its workflow actions, chain verification and
 * the export (itself audited `EXPORT.AUDIT`). Rows were redacted when written (section 9.5);
 * this service only blanks pay data for system admins who are not also HR, Payroll or auditors,
 * and hides the request plumbing (IP, session, user agent) from record-history viewers who are not
 * auditors or system admins.
 */
@Injectable()
export class AuditApiService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly access: EntityHistoryAccess,
  ) {}

  async list(ctx: SecurityContext, query: AuditListQuery): Promise<AuditListResponse> {
    const { page, pageSize, sort, ...filters } = query;
    const where = whereSql(auditConditions(filters));
    const order = sort === 'id:asc' ? Prisma.sql`ORDER BY id ASC` : Prisma.sql`ORDER BY id DESC`;
    const [rows, count] = await Promise.all([
      this.db.prisma.$queryRaw<RawAuditRow[]>`
        SELECT ${COLUMNS} FROM "AuditLog" ${where} ${order}
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      this.db.prisma.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total FROM "AuditLog" ${where}`,
    ]);
    const names = await this.employeeNames(rows.flatMap((r) => [r.actingAsEmployeeId, r.subjectEmployeeId]));
    const nameOf = (id: number | null) => (id === null ? null : (names.get(id) ?? null));
    return {
      items: rows.map((r) => ({
        ...toAuditRow(r, ctx),
        actingAsEmployeeName: nameOf(r.actingAsEmployeeId),
        subjectEmployeeName: nameOf(r.subjectEmployeeId),
      })),
      total: Number(count[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  /** "{First} {Last}" by employee id, read now (deleted employees included). */
  private async employeeNames(ids: (number | null)[]): Promise<Map<number, string>> {
    const unique = [...new Set(ids.filter((id): id is number => id !== null))];
    if (unique.length === 0) return new Map();
    const rows = await this.db.prisma.employee.findMany({
      where: { id: { in: unique } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(rows.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));
  }

  /** GET /audit/actor-options: every login for the actor filter, by username (paginated). */
  async actorOptions(query: AuditActorOptionsQuery): Promise<AuditActorOptionsResponse> {
    const where: Prisma.UserWhereInput = {};
    if (query.search) {
      const contains = { contains: query.search, mode: 'insensitive' as const };
      where.OR = [
        { username: contains },
        { employee: { firstName: contains } },
        { employee: { lastName: contains } },
        { employee: { employeeCode: contains } },
      ];
    }
    const prisma = this.db.prisma;
    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          username: true,
          isActive: true,
          employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
        },
        orderBy: [{ username: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.user.count({ where }),
    ]);
    return {
      items: rows.map((u) => ({
        userId: u.id,
        username: u.username,
        name: u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : u.username,
        employeeId: u.employee?.id ?? null,
        employeeCode: u.employee?.employeeCode ?? null,
        isActive: u.isActive,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(ctx: SecurityContext, id: string): Promise<AuditRowDetail> {
    const rows = await this.db.prisma.$queryRaw<RawAuditRow[]>`
      SELECT ${COLUMNS} FROM "AuditLog" WHERE id = ${BigInt(id)}`;
    const row = rows[0];
    if (!row) throw new NotFoundError('Audit row');
    return toAuditDetail(row, ctx);
  }

  /**
   * GET /audit/entity/:entityType/:entityId: the entity's audit rows, plus the audit rows and
   * workflow actions of its workflow processes, newest first.
   */
  async entityHistory(
    ctx: SecurityContext,
    entityType: string,
    entityId: string,
  ): Promise<EntityHistoryResponse> {
    const owner = await this.access.assertCanRead(ctx, entityType, entityId);
    const processIds =
      owner?.kind === 'employee' ? owner.processIds : owner?.kind === 'process' ? [owner.processId] : [];
    const processRows = processIds.filter(
      (id) => !(entityType === 'WorkflowProcess' && String(id) === entityId),
    );
    const match = processRows.length
      ? Prisma.sql`("entityType" = ${entityType} AND "entityId" = ${entityId})
          OR ("entityType" = 'WorkflowProcess' AND "entityId" = ANY(${processRows.map(String)}))`
      : Prisma.sql`"entityType" = ${entityType} AND "entityId" = ${entityId}`;
    const rows = await this.db.prisma.$queryRaw<RawAuditRow[]>`
      SELECT ${COLUMNS} FROM "AuditLog" WHERE ${match} ORDER BY id DESC LIMIT ${ENTITY_HISTORY_LIMIT + 1}`;
    const actions = processIds.length
      ? await this.db.prisma.workflowAction.findMany({
          where: { processId: { in: processIds } },
          include: { stepInstance: { select: { stepNo: true } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: ENTITY_HISTORY_LIMIT + 1,
        })
      : [];
    const names = await userNames(
      this.db.prisma,
      actions.map((a) => a.actorUserId),
    );
    return {
      entityType,
      entityId,
      processIds,
      audit: rows.slice(0, ENTITY_HISTORY_LIMIT).map((r) => toAuditDetail(r, ctx)),
      workflowActions: actions.slice(0, ENTITY_HISTORY_LIMIT).map((a) => ({
        id: a.id,
        processId: a.processId,
        action: a.action as WorkflowActionType,
        actorUserId: a.actorUserId,
        actorName: names.get(a.actorUserId) ?? 'Unknown user',
        stepNo: a.stepInstance?.stepNo ?? null,
        comment: a.comment,
        fromStatus: a.fromStatus,
        toStatus: a.toStatus,
        metadata: a.metadata ?? null,
        createdAt: a.createdAt.toISOString(),
      })),
      truncated: rows.length > ENTITY_HISTORY_LIMIT || actions.length > ENTITY_HISTORY_LIMIT,
    };
  }

  /** GET /audit/verify (section 9.3): recomputes the chain over the range. */
  async verify(query: AuditVerifyQuery): Promise<AuditVerifyResponse> {
    const from = query.from ? instantFrom(query.from) : undefined;
    const end = query.to ? instantTo(query.to) : undefined;
    // `verify` takes an inclusive end; a date's exclusive midnight becomes the millisecond before.
    const to = end ? (end.inclusive ? end.at : new Date(end.at.getTime() - 1)) : undefined;
    const result = await this.audit.verify({ from, to });
    const anchor = await this.db.prisma.auditAnchor.findFirst({
      where: to ? { day: { lte: to } } : {},
      orderBy: { day: 'desc' },
    });
    return {
      ...result,
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
      anchor: anchor
        ? {
            day: businessFromDate(anchor.day),
            lastAuditId: anchor.lastAuditId.toString(),
            lastHash: anchor.lastHash,
          }
        : null,
    };
  }

  /**
   * POST /audit/export: streams the filtered rows (oldest first, at most AUDIT_EXPORT_MAX_ROWS)
   * as CSV or Excel. `EXPORT.AUDIT` is written with the filters before the first row is read.
   */
  async export(ctx: SecurityContext, input: AuditExportRequest): Promise<AuditExport> {
    const filters = input.filters;
    await this.audit.recordStandalone(ctx, {
      category: 'EXPORT',
      action: 'EXPORT.AUDIT',
      entityType: 'AuditLog',
      metadata: { format: input.format, filters, maxRows: AUDIT_EXPORT_MAX_ROWS },
    });
    const columns: ReportColumn[] = AUDIT_EXPORT_COLUMNS.map(([key, label]) => ({
      key,
      label,
      type: key === 'occurredAt' ? 'datetime' : 'string',
      payData: false,
    }));
    const rows = this.exportRows(ctx, filters);
    const stamp = new Date().toISOString().slice(0, 10);
    return input.format === 'xlsx'
      ? {
          stream: xlsxStream('Audit trail', columns, rows),
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fileName: `audit-trail-${stamp}.xlsx`,
        }
      : {
          stream: csvStream(columns, rows),
          contentType: 'text/csv; charset=utf-8',
          fileName: `audit-trail-${stamp}.csv`,
        };
  }

  private async *exportRows(ctx: SecurityContext, filters: AuditFilters): AsyncGenerator<ReportRow> {
    const base = auditConditions(filters);
    let cursor: bigint | null = null;
    let emitted = 0;
    const json = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value));
    while (emitted < AUDIT_EXPORT_MAX_ROWS) {
      const conditions: Prisma.Sql[] = cursor === null ? base : [...base, Prisma.sql`id > ${cursor}`];
      const take = Math.min(EXPORT_BATCH, AUDIT_EXPORT_MAX_ROWS - emitted);
      const batch: RawAuditRow[] = await this.db.prisma.$queryRaw<RawAuditRow[]>`
        SELECT ${COLUMNS} FROM "AuditLog" ${whereSql(conditions)} ORDER BY id ASC LIMIT ${take}`;
      for (const raw of batch) {
        const r = toAuditDetail(raw, ctx);
        yield {
          id: r.id,
          occurredAt: r.occurredAt,
          category: r.category,
          action: r.action,
          outcome: r.outcome,
          actorUsername: r.actorUsername,
          actingAsEmployeeId: r.actingAsEmployeeId === null ? null : String(r.actingAsEmployeeId),
          subjectEmployeeId: r.subjectEmployeeId === null ? null : String(r.subjectEmployeeId),
          entityType: r.entityType,
          entityId: r.entityId,
          reason: r.reason,
          changes: r.changes.length ? json(r.changes) : null,
          before: json(r.before),
          after: json(r.after),
          metadata: json(r.metadata),
          ip: r.ip,
          requestId: r.requestId,
          hash: r.hash,
        };
      }
      emitted += batch.length;
      if (batch.length < take) return;
      cursor = batch[batch.length - 1]?.id ?? null;
    }
  }
}
