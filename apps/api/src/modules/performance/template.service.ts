import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  businessFromDate,
  canTransitionTemplate,
  type CopyTemplateRequest,
  type CreateTemplateRequest,
  dateFromBusiness,
  type PerformanceTemplate,
  type PerformanceTemplateRow,
  type RatingScalesResponse,
  type TemplatesQuery,
  type TemplatesResponse,
  TEMPLATE_STATUS_LABELS,
  type UpdateTemplateRequest,
  PERFORMANCE_EXPORT_MAX_ROWS,
  TEMPLATE_EXPORT_COLUMNS,
  TEMPLATE_SORT_FIELDS,
  type TemplatesExportQuery,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import { type ExportFile, gridExport, sortMap } from './performance-export';
import type { SecurityContext } from '../../common/context/security-context';
import {
  assertVersion,
  type FieldError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import {
  itemsSnapshot,
  LIVE_ITEMS,
  PERFORMANCE_TEMPLATE_ENTITY,
  type ResolvedItem,
  resolveItems,
  sectionTotalsOf,
  toItemDto,
  toRatingScaleDto,
  userDisplayNames,
} from './performance-common';

const ROW_INCLUDE = {
  ratingScale: { select: { name: true } },
  createdFrom: { select: { name: true } },
  _count: { select: { contracts: true } },
} satisfies Prisma.PerformanceTemplateInclude;

type TemplateRowData = Prisma.PerformanceTemplateGetPayload<{ include: typeof ROW_INCLUDE }>;

const DETAIL_INCLUDE = { ...ROW_INCLUDE, items: LIVE_ITEMS } satisfies Prisma.PerformanceTemplateInclude;

type TemplateOrder = Prisma.PerformanceTemplateOrderByWithRelationInput;
type TemplateSortField = (typeof TEMPLATE_SORT_FIELDS)[number];

const SORTS: Record<TemplatesQuery['sort'], TemplateOrder[]> = sortMap<TemplateSortField, TemplateOrder>({
  name: (d) => [{ name: d }, { id: d }],
  contractStartDate: (d) => [{ contractStartDate: d }, { id: d }],
  contractEndDate: (d) => [{ contractEndDate: d }, { id: d }],
  ratingScale: (d) => [{ ratingScale: { name: d } }, { id: d }],
  processDefinition: (d) => [{ processDefinition: { sort: d, nulls: 'last' } }, { id: d }],
  linkedContracts: (d) => [{ contracts: { _count: d } }, { id: d }],
  createdFromTemplate: (d) => [{ createdFrom: { name: d } }, { id: d }],
  status: (d) => [{ status: d }, { name: 'asc' }, { id: d }],
  createdAt: (d) => [{ createdAt: d }, { id: d }],
});

function toRow(t: TemplateRowData, owners: Map<string, string>): PerformanceTemplateRow {
  return {
    id: t.id,
    name: t.name,
    contractStartDate: businessFromDate(t.contractStartDate),
    contractEndDate: businessFromDate(t.contractEndDate),
    ratingScaleId: t.ratingScaleId,
    ratingScale: t.ratingScale?.name ?? null,
    processDefinition: t.processDefinition,
    linkedContracts: t._count.contracts,
    ownerUserId: t.ownerUserId,
    templateOwner: owners.get(t.ownerUserId) ?? t.ownerUserId,
    createdFromTemplateId: t.createdFromTemplateId,
    createdFromTemplate: t.createdFrom?.name ?? null,
    status: t.status,
    version: t.version,
    createdAt: t.createdAt.toISOString(),
  };
}

/**
 * Performance Templates (section 5.9): the grid, create, edit and copy. Items are KPAs, KPIs,
 * competencies and objectives, each linked to a parameter (not objectives) with a weight and a
 * target; the weights of each section (item kind) add up to 100. Items change only while the
 * template is a DRAFT; contracts copy the items, so later template edits never touch them.
 */
@Injectable()
export class TemplateService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async ratingScales(): Promise<RatingScalesResponse> {
    const rows = await this.db.prisma.ratingScale.findMany({ orderBy: { id: 'asc' } });
    return { items: rows.map(toRatingScaleDto) };
  }

  /** GET /performance/templates/export: the filtered grid as CSV or Excel, audited. */
  async export(ctx: SecurityContext, query: TemplatesExportQuery): Promise<ExportFile> {
    const { format, ...filters } = query;
    const page = await this.list({ ...filters, page: 1, pageSize: PERFORMANCE_EXPORT_MAX_ROWS });
    await this.audit.recordStandalone(ctx, {
      category: 'EXPORT',
      action: 'EXPORT.PERFORMANCE_TEMPLATES',
      entityType: 'PerformanceTemplate',
      metadata: { filters, format, rows: page.items.length, truncated: page.total > page.items.length },
    });
    return gridExport(page.items, TEMPLATE_EXPORT_COLUMNS, {
      format,
      sheet: 'Performance templates',
      fileBase: 'performance-templates',
    });
  }

  async list(query: TemplatesQuery): Promise<TemplatesResponse> {
    const where: Prisma.PerformanceTemplateWhereInput = {
      status: query.status,
      name: query.search ? { contains: query.search, mode: 'insensitive' } : undefined,
    };
    const [rows, total] = await Promise.all([
      this.db.prisma.performanceTemplate.findMany({
        where,
        include: ROW_INCLUDE,
        orderBy: SORTS[query.sort],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.prisma.performanceTemplate.count({ where }),
    ]);
    const owners = await userDisplayNames(
      this.db.prisma,
      rows.map((r) => r.ownerUserId),
    );
    return { items: rows.map((r) => toRow(r, owners)), total, page: query.page, pageSize: query.pageSize };
  }

  async get(id: number, client: Tx = this.db.prisma): Promise<PerformanceTemplate> {
    const t = await client.performanceTemplate.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!t) throw new NotFoundError('Performance template');
    const owners = await userDisplayNames(client, [t.ownerUserId]);
    return { ...toRow(t, owners), items: t.items.map(toItemDto), sectionTotals: sectionTotalsOf(t.items) };
  }

  async create(ctx: SecurityContext, input: CreateTemplateRequest): Promise<PerformanceTemplate> {
    return this.db.tx(ctx, async (tx) => {
      await this.assertRatingScale(tx, input.ratingScaleId);
      const items = await resolveItems(tx, input.items, new Map());
      if (input.status === 'ACTIVE') this.assertActivatable(items.length, input.ratingScaleId);
      const template = await tx.performanceTemplate.create({
        data: {
          name: input.name,
          contractStartDate: dateFromBusiness(input.contractStartDate),
          contractEndDate: dateFromBusiness(input.contractEndDate),
          ratingScaleId: input.ratingScaleId,
          processDefinition: input.processDefinition ?? null,
          ownerUserId: ctx.userId,
          status: input.status,
        },
      });
      await this.writeItems(tx, template.id, items, new Set());
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'PERFORMANCE_TEMPLATE.CREATED',
        entityType: PERFORMANCE_TEMPLATE_ENTITY,
        entityId: template.id,
        after: { ...template, items: itemsSnapshot(items) },
      });
      return this.get(template.id, tx);
    });
  }

  async update(ctx: SecurityContext, id: number, input: UpdateTemplateRequest): Promise<PerformanceTemplate> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'PerformanceTemplate', id);
      const before = await tx.performanceTemplate.findUnique({
        where: { id },
        include: { items: { where: { deletedAt: null } } },
      });
      if (!before) throw new NotFoundError('Performance template');
      assertVersion(before, input.version);

      const errors: FieldError[] = [];
      if (before.status === 'ARCHIVED') throw new ValidationError('An archived template cannot change');
      const draftOnly = (['contractStartDate', 'contractEndDate', 'ratingScaleId', 'items'] as const).filter(
        (k) => input[k] !== undefined,
      );
      if (before.status !== 'DRAFT')
        for (const k of draftOnly)
          errors.push({ path: k, message: 'This can change only while the template is a draft' });
      if (
        input.status !== undefined &&
        input.status !== before.status &&
        !canTransitionTemplate(before.status, input.status)
      )
        errors.push({
          path: 'status',
          message: `A ${TEMPLATE_STATUS_LABELS[before.status]} template cannot become ${TEMPLATE_STATUS_LABELS[input.status]}`,
        });
      const start = input.contractStartDate ?? businessFromDate(before.contractStartDate);
      const end = input.contractEndDate ?? businessFromDate(before.contractEndDate);
      if (end < start)
        errors.push({ path: 'contractEndDate', message: 'The end date cannot be before the start date' });
      if (errors.length > 0) throw new ValidationError(errors);

      const ratingScaleId = input.ratingScaleId ?? before.ratingScaleId;
      if (input.ratingScaleId !== undefined) await this.assertRatingScale(tx, input.ratingScaleId);
      const existing = new Map(before.items.map((i) => [i.id, i]));
      const items = input.items === undefined ? null : await resolveItems(tx, input.items, existing);
      if (input.status === 'ACTIVE' && before.status !== 'ACTIVE')
        this.assertActivatable(items ? items.length : before.items.length, ratingScaleId);

      const after = await tx.performanceTemplate.update({
        where: { id },
        data: {
          name: input.name,
          contractStartDate: input.contractStartDate ? dateFromBusiness(input.contractStartDate) : undefined,
          contractEndDate: input.contractEndDate ? dateFromBusiness(input.contractEndDate) : undefined,
          ratingScaleId: input.ratingScaleId,
          processDefinition: input.processDefinition,
          status: input.status,
          version: { increment: 1 },
        },
      });
      if (items) await this.writeItems(tx, id, items, new Set(existing.keys()));
      const { items: beforeItems, ...beforeRow } = before;
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action:
          input.status !== undefined && input.status !== before.status
            ? 'PERFORMANCE_TEMPLATE.STATUS_CHANGED'
            : 'PERFORMANCE_TEMPLATE.UPDATED',
        entityType: PERFORMANCE_TEMPLATE_ENTITY,
        entityId: id,
        before: { ...beforeRow, items: itemsSnapshot(beforeItems) },
        after: { ...after, items: itemsSnapshot(items ?? beforeItems) },
      });
      return this.get(id, tx);
    });
  }

  /** POST /performance/templates/:id/copy: a DRAFT copy owned by the caller, with the same items. */
  async copy(ctx: SecurityContext, id: number, input: CopyTemplateRequest): Promise<PerformanceTemplate> {
    return this.db.tx(ctx, async (tx) => {
      const source = await tx.performanceTemplate.findUnique({
        where: { id },
        include: { items: { where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
      });
      if (!source) throw new NotFoundError('Performance template');
      const copy = await tx.performanceTemplate.create({
        data: {
          name: input.name ?? `Copy of ${source.name}`.slice(0, 200),
          contractStartDate: source.contractStartDate,
          contractEndDate: source.contractEndDate,
          ratingScaleId: source.ratingScaleId,
          processDefinition: source.processDefinition,
          ownerUserId: ctx.userId,
          createdFromTemplateId: source.id,
          status: 'DRAFT',
        },
      });
      const items: ResolvedItem[] = source.items.map((i) => ({
        kind: i.kind,
        parameterValueId: i.parameterValueId,
        title: i.title,
        weight: i.weight.toString(),
        target: i.target,
        sortOrder: i.sortOrder,
      }));
      await this.writeItems(tx, copy.id, items, new Set());
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'PERFORMANCE_TEMPLATE.COPIED',
        entityType: PERFORMANCE_TEMPLATE_ENTITY,
        entityId: copy.id,
        after: { ...copy, items: itemsSnapshot(items) },
        metadata: { sourceTemplateId: source.id },
      });
      return this.get(copy.id, tx);
    });
  }

  /** Writes the resolved list: kept items are updated, new ones created, the rest soft-deleted. */
  private async writeItems(
    tx: Tx,
    templateId: number,
    items: ResolvedItem[],
    existingIds: Set<number>,
  ): Promise<void> {
    const kept = new Set<number>();
    for (const item of items) {
      const data = {
        kind: item.kind,
        parameterValueId: item.parameterValueId,
        title: item.title,
        weight: item.weight,
        target: item.target,
        sortOrder: item.sortOrder,
      };
      if (item.id !== undefined) {
        kept.add(item.id);
        await tx.performanceTemplateItem.update({ where: { id: item.id }, data });
      } else {
        await tx.performanceTemplateItem.create({ data: { ...data, templateId } });
      }
    }
    const now = new Date();
    for (const id of existingIds) {
      if (!kept.has(id)) await tx.performanceTemplateItem.update({ where: { id }, data: { deletedAt: now } });
    }
  }

  private async assertRatingScale(tx: Tx, id: number): Promise<void> {
    const scale = await tx.ratingScale.findUnique({ where: { id }, select: { id: true } });
    if (!scale) throw ValidationError.field('ratingScaleId', 'Choose a rating scale');
  }

  private assertActivatable(itemCount: number, ratingScaleId: number | null): void {
    const errors: FieldError[] = [];
    if (itemCount === 0)
      errors.push({ path: 'items', message: 'Add the items before activating the template' });
    if (ratingScaleId === null) errors.push({ path: 'ratingScaleId', message: 'Choose a rating scale' });
    if (errors.length > 0) throw new ValidationError(errors);
  }
}
