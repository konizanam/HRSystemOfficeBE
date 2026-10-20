import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  businessFromDate,
  type ContractInitiation,
  type ContractInitiationRow,
  type CreateInitiationRequest,
  type InitiationError,
  InitiationErrorSchema,
  type InitiationFilters,
  InitiationFiltersSchema,
  INITIATION_EXPORT_COLUMNS,
  INITIATION_SORT_FIELDS,
  initiationProgress,
  type InitiationsExportQuery,
  type InitiationsQuery,
  type InitiationsResponse,
  PERFORMANCE_EXPORT_MAX_ROWS,
} from '@peoplehub/shared';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { type SecurityContext, systemContext } from '../../common/context/security-context';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import type { JobCounts } from '../../jobs/jobs.service';
import { JobsService } from '../../jobs/jobs.service';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { ContractService } from './contract.service';
import { PerformanceAccess } from './performance-access';
import { type ExportFile, gridExport, sortMap } from './performance-export';
import {
  CONTRACT_INITIATION_ENTITY,
  PERFORMANCE_CONTRACT_ENTITY,
  PERFORMANCE_INITIATE_JOB,
  userDisplayNames,
} from './performance-common';

/** What `ContractInitiation.filters` holds: the request filters plus the resolved selection. */
const StoredFiltersSchema = InitiationFiltersSchema.extend({
  selectedEmployeeIds: z.array(z.number().int()).default([]),
  contractType: z.string().nullable().default(null),
});
type StoredFilters = z.infer<typeof StoredFiltersSchema>;

const ErrorsSchema = z.array(InitiationErrorSchema);

/** Progress is written every this many employees (and at the end). */
const PROGRESS_EVERY = 25;

/** An expected per-employee failure: recorded in `errors`, never fails the job. */
class InitiationFailure extends Error {}

const ROW_INCLUDE = { template: { select: { name: true } } } satisfies Prisma.ContractInitiationInclude;

type InitiationOrder = Prisma.ContractInitiationOrderByWithRelationInput;

const SORTS: Record<InitiationsQuery['sort'], InitiationOrder[]> = sortMap<
  (typeof INITIATION_SORT_FIELDS)[number],
  InitiationOrder
>({
  name: (d) => [{ name: d }, { id: d }],
  templateName: (d) => [{ template: { name: d } }, { id: d }],
  contractStartDate: (d) => [{ contractStartDate: d }, { id: d }],
  contractEndDate: (d) => [{ contractEndDate: d }, { id: d }],
  status: (d) => [{ status: d }, { createdAt: 'desc' }, { id: 'desc' }],
  contractCount: (d) => [{ contractCount: d }, { id: d }],
  createdCount: (d) => [{ createdCount: d }, { id: d }],
  failedCount: (d) => [{ failedCount: d }, { id: d }],
  lastChanged: (d) => [{ updatedAt: d }, { id: d }],
  createdAt: (d) => [{ createdAt: d }, { id: d }],
});
type InitiationRowData = Prisma.ContractInitiationGetPayload<{ include: typeof ROW_INCLUDE }>;

function storedFilters(value: Prisma.JsonValue): StoredFilters {
  const parsed = StoredFiltersSchema.safeParse(value);
  return parsed.success ? parsed.data : { selectedEmployeeIds: [], contractType: null };
}

function storedErrors(value: Prisma.JsonValue | null): InitiationError[] {
  const parsed = ErrorsSchema.safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

function toRow(i: InitiationRowData, users: Map<string, string>): ContractInitiationRow {
  return {
    id: i.id,
    name: i.name,
    templateId: i.templateId,
    templateName: i.template.name,
    contractStartDate: businessFromDate(i.contractStartDate),
    contractEndDate: businessFromDate(i.contractEndDate),
    status: i.status,
    progress: initiationProgress(i.contractCount, i.createdCount, i.failedCount),
    contractCount: i.contractCount,
    createdCount: i.createdCount,
    failedCount: i.failedCount,
    lastChanged: i.updatedAt.toISOString(),
    createdAt: i.createdAt.toISOString(),
    createdBy: users.get(i.createdByUserId) ?? i.createdByUserId,
  };
}

/**
 * Contract Initiation (section 5.9): HR picks an active template and the employees (company,
 * company rule, employees, positions); POST stores the selection and queues the
 * `performance.initiateContracts` job, which creates one DRAFT contract per employee from the
 * template and reports progress (Contract Count, Created, Failed, Last Changed) and per-employee
 * failures. The job is idempotent per (initiation, employee): a unique key stops duplicates and a
 * re-run counts existing contracts as created and retries the failures.
 */
@Injectable()
export class InitiationService {
  private readonly logger = new Logger(InitiationService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    private readonly contracts: ContractService,
    private readonly access: PerformanceAccess,
  ) {}

  /** GET /performance/contract-initiations/export: the filtered grid as CSV or Excel, audited. */
  async export(ctx: SecurityContext, query: InitiationsExportQuery): Promise<ExportFile> {
    const { format, ...filters } = query;
    const page = await this.list({ ...filters, page: 1, pageSize: PERFORMANCE_EXPORT_MAX_ROWS });
    await this.audit.recordStandalone(ctx, {
      category: 'EXPORT',
      action: 'EXPORT.CONTRACT_INITIATIONS',
      entityType: 'ContractInitiation',
      metadata: { filters, format, rows: page.items.length, truncated: page.total > page.items.length },
    });
    return gridExport(page.items, INITIATION_EXPORT_COLUMNS, {
      format,
      sheet: 'Contract initiations',
      fileBase: 'contract-initiations',
    });
  }

  async list(query: InitiationsQuery): Promise<InitiationsResponse> {
    const where: Prisma.ContractInitiationWhereInput = {
      status: query.status,
      name: query.search ? { contains: query.search, mode: 'insensitive' } : undefined,
    };
    const [rows, total] = await Promise.all([
      this.db.prisma.contractInitiation.findMany({
        where,
        include: ROW_INCLUDE,
        orderBy: SORTS[query.sort],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.prisma.contractInitiation.count({ where }),
    ]);
    const users = await userDisplayNames(
      this.db.prisma,
      rows.map((r) => r.createdByUserId),
    );
    return { items: rows.map((r) => toRow(r, users)), total, page: query.page, pageSize: query.pageSize };
  }

  /** The initiation with its failures; HR sees the failures of employees in their companies. */
  async get(ctx: SecurityContext, id: number): Promise<ContractInitiation> {
    const i = await this.db.prisma.contractInitiation.findUnique({ where: { id }, include: ROW_INCLUDE });
    if (!i) throw new NotFoundError('Contract initiation');
    const users = await userDisplayNames(this.db.prisma, [i.createdByUserId]);
    const filters = storedFilters(i.filters);
    let errors = storedErrors(i.errors);
    if (!this.access.isAuditor(ctx)) {
      const visible = new Set(
        (
          await this.db.prisma.employee.findMany({
            where: { id: { in: errors.map((e) => e.employeeId) }, companyId: { in: ctx.companyIds } },
            select: { id: true },
          })
        ).map((e) => e.id),
      );
      errors = errors.filter((e) => visible.has(e.employeeId));
    }
    const { selectedEmployeeIds, contractType, ...requestFilters } = filters;
    return {
      ...toRow(i, users),
      contractType,
      filters: requestFilters,
      employeeIds: selectedEmployeeIds,
      errors,
    };
  }

  async create(ctx: SecurityContext, input: CreateInitiationRequest): Promise<ContractInitiation> {
    const id = await this.db.tx(ctx, async (tx) => {
      const template = await tx.performanceTemplate.findUnique({
        where: { id: input.templateId },
        include: { _count: { select: { items: { where: { deletedAt: null } } } } },
      });
      if (!template) throw ValidationError.field('templateId', 'Choose a template');
      if (template.status !== 'ACTIVE')
        throw ValidationError.field('templateId', 'Only an active template can initiate contracts');
      const start = input.contractStartDate ?? businessFromDate(template.contractStartDate);
      const end = input.contractEndDate ?? businessFromDate(template.contractEndDate);
      if (end < start)
        throw ValidationError.field('contractEndDate', 'The end date cannot be before the start date');

      const selected = await this.selectEmployees(tx, ctx, input.filters);
      if (selected.length === 0)
        throw ValidationError.field('filters', 'No active employees match the filters');
      const filters: StoredFilters = {
        ...input.filters,
        selectedEmployeeIds: selected,
        contractType: input.contractType ?? null,
      };
      const initiation = await tx.contractInitiation.create({
        data: {
          name: input.name,
          templateId: template.id,
          contractStartDate: new Date(`${start}T00:00:00.000Z`),
          contractEndDate: new Date(`${end}T00:00:00.000Z`),
          filters: filters as unknown as Prisma.InputJsonValue,
          status: 'QUEUED',
          contractCount: selected.length,
          createdByUserId: ctx.userId,
        },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'PERFORMANCE_INITIATION.CREATED',
        entityType: CONTRACT_INITIATION_ENTITY,
        entityId: initiation.id,
        after: initiation,
      });
      return initiation.id;
    });
    try {
      await this.jobs.send(PERFORMANCE_INITIATE_JOB, { initiationId: id });
    } catch (err) {
      // The initiation stays visible with its status; HR can see it did not complete.
      this.logger.error({ err, initiationId: id }, 'Contract initiation job failed');
    }
    return this.get(ctx, id);
  }

  /**
   * Active employees matching every filter, limited to the caller's companies. An explicit company
   * or employee outside them is refused (403).
   */
  private async selectEmployees(tx: Tx, ctx: SecurityContext, filters: InitiationFilters): Promise<number[]> {
    const outside = (filters.companyIds ?? []).filter((c) => !ctx.companyIds.includes(c));
    if (outside.length > 0)
      throw new ForbiddenError('You cannot initiate contracts in that company', {
        metadata: { companyIds: outside },
      });
    if (filters.employeeIds && filters.employeeIds.length > 0) {
      const found = await tx.employee.findMany({
        where: { id: { in: filters.employeeIds }, deletedAt: null },
        select: { id: true, companyId: true },
      });
      const missing = filters.employeeIds.filter((id) => !found.some((e) => e.id === id));
      if (missing.length > 0)
        throw ValidationError.field('filters.employeeIds', `Unknown employee ${missing[0]}`);
      const foreign = found.find((e) => !ctx.companyIds.includes(e.companyId));
      if (foreign)
        throw new ForbiddenError('You do not have access to this employee', {
          subjectEmployeeId: foreign.id,
          metadata: { employeeId: foreign.id },
        });
    }
    const rows = await tx.employee.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        companyId: {
          in: filters.companyIds && filters.companyIds.length > 0 ? filters.companyIds : ctx.companyIds,
        },
        companyRuleId:
          filters.companyRuleIds && filters.companyRuleIds.length > 0
            ? { in: filters.companyRuleIds }
            : undefined,
        id: filters.employeeIds && filters.employeeIds.length > 0 ? { in: filters.employeeIds } : undefined,
        jobTitle: filters.positions && filters.positions.length > 0 ? { in: filters.positions } : undefined,
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  /** The `performance.initiateContracts` job. */
  async run(data: { initiationId?: number }): Promise<JobCounts> {
    const initiationId = Number(data.initiationId);
    const ctx = systemContext(`job-${PERFORMANCE_INITIATE_JOB}-${initiationId}`);
    const initiation = await this.db.prisma.contractInitiation.findUnique({
      where: { id: initiationId },
      include: {
        template: {
          include: { items: { where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
        },
      },
    });
    if (!initiation) return { initiationId, missing: 1 };
    const filters = storedFilters(initiation.filters);
    await this.writeProgress(ctx, initiationId, { status: 'RUNNING' }, 'PERFORMANCE_INITIATION.STARTED');

    const start = businessFromDate(initiation.contractStartDate);
    const end = businessFromDate(initiation.contractEndDate);
    const items = initiation.template.items.map((i) => ({
      kind: i.kind,
      parameterValueId: i.parameterValueId,
      title: i.title,
      weight: i.weight.toString(),
      target: i.target,
      sortOrder: i.sortOrder,
    }));
    let created = 0;
    let skipped = 0;
    const errors: InitiationError[] = [];
    let processed = 0;
    for (const employeeId of filters.selectedEmployeeIds) {
      const outcome = await this.createOne(ctx, initiation.id, employeeId, {
        templateId: initiation.templateId,
        name: initiation.name,
        contractType: filters.contractType,
        start,
        end,
        items,
      });
      if (outcome === 'created') created += 1;
      else if (outcome === 'existing') {
        created += 1;
        skipped += 1;
      } else errors.push(outcome);
      processed += 1;
      if (processed % PROGRESS_EVERY === 0 && processed < filters.selectedEmployeeIds.length)
        await this.writeProgress(
          ctx,
          initiationId,
          { createdCount: created, failedCount: errors.length, errors },
          'PERFORMANCE_INITIATION.PROGRESS',
        );
    }
    const status = errors.length > 0 && created === 0 ? 'FAILED' : 'COMPLETED';
    await this.writeProgress(
      ctx,
      initiationId,
      {
        status,
        contractCount: filters.selectedEmployeeIds.length,
        createdCount: created,
        failedCount: errors.length,
        errors,
      },
      'PERFORMANCE_INITIATION.COMPLETED',
    );
    return {
      initiationId,
      contracts: filters.selectedEmployeeIds.length,
      created,
      alreadyCreated: skipped,
      failed: errors.length,
    };
  }

  private async createOne(
    ctx: SecurityContext,
    initiationId: number,
    employeeId: number,
    spec: {
      templateId: number;
      name: string;
      contractType: string | null;
      start: string;
      end: string;
      items: {
        kind: Prisma.PerformanceContractItemCreateManyInput['kind'];
        parameterValueId: number | null;
        title: string;
        weight: string;
        target: string | null;
        sortOrder: number;
      }[];
    },
  ): Promise<'created' | 'existing' | InitiationError> {
    const employee = await this.db.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        status: true,
        deletedAt: true,
        user: { select: { id: true, isActive: true } },
        reportsTo: { select: { user: { select: { id: true, isActive: true } } } },
      },
    });
    const failure = (message: string): InitiationError => ({
      employeeId,
      employeeCode: employee?.employeeCode ?? String(employeeId),
      employeeName: employee ? `${employee.firstName} ${employee.lastName}` : 'Unknown employee',
      message,
    });
    try {
      return await this.db.tx(ctx, async (tx) => {
        await this.db.lockRow(tx, 'Employee', employeeId);
        const existing = await tx.performanceContract.findUnique({
          where: { initiationId_employeeId: { initiationId, employeeId } },
          select: { id: true },
        });
        if (existing) return 'existing' as const;
        if (!employee || employee.deletedAt) throw new InitiationFailure('The employee no longer exists');
        if (employee.status !== 'ACTIVE') throw new InitiationFailure('The employee is not active');
        const overlapping = await tx.performanceContract.findFirst({
          where: {
            employeeId,
            templateId: spec.templateId,
            status: { not: 'ARCHIVED' },
            startDate: { lte: new Date(`${spec.end}T00:00:00.000Z`) },
            endDate: { gte: new Date(`${spec.start}T00:00:00.000Z`) },
          },
          select: { id: true, name: true },
        });
        if (overlapping)
          throw new InitiationFailure(
            `The employee already has a contract from this template for an overlapping period ("${overlapping.name}")`,
          );
        const manager = employee.reportsTo?.user?.isActive ? employee.reportsTo.user.id : null;
        const assignee = manager ?? (employee.user?.isActive ? employee.user.id : null);
        const contract = await this.contracts.createFromTemplate(tx, {
          employeeId,
          templateId: spec.templateId,
          initiationId,
          name: spec.name,
          contractType: spec.contractType,
          startDate: spec.start,
          endDate: spec.end,
          currentlyAssignedUserId: assignee,
          items: spec.items,
        });
        this.audit.record(tx, ctx, {
          category: 'DATA_CHANGE',
          action: 'PERFORMANCE_CONTRACT.CREATED',
          entityType: PERFORMANCE_CONTRACT_ENTITY,
          entityId: contract.id,
          subjectEmployeeId: employeeId,
          after: contract,
          metadata: { initiationId, templateId: spec.templateId, items: spec.items.length },
        });
        return 'created' as const;
      });
    } catch (err) {
      if (err instanceof InitiationFailure) return failure(err.message);
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return 'existing';
      this.logger.error({ err, initiationId, employeeId }, 'Could not create a performance contract');
      return failure('The contract could not be created');
    }
  }

  private async writeProgress(
    ctx: SecurityContext,
    id: number,
    data: {
      status?: 'RUNNING' | 'COMPLETED' | 'FAILED';
      contractCount?: number;
      createdCount?: number;
      failedCount?: number;
      errors?: InitiationError[];
    },
    action: string,
  ): Promise<void> {
    await this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'ContractInitiation', id);
      const before = await tx.contractInitiation.findUniqueOrThrow({ where: { id } });
      const after = await tx.contractInitiation.update({
        where: { id },
        data: {
          status: data.status,
          contractCount: data.contractCount,
          createdCount: data.createdCount,
          failedCount: data.failedCount,
          errors: data.errors === undefined ? undefined : (data.errors as unknown as Prisma.InputJsonValue),
        },
      });
      this.audit.record(tx, ctx, {
        category: 'SYSTEM',
        action,
        entityType: CONTRACT_INITIATION_ENTITY,
        entityId: id,
        before,
        after,
      });
    });
  }
}
