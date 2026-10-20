import { Injectable } from '@nestjs/common';
import type { Prisma, TemplateItemKind } from '@prisma/client';
import {
  allowedContractTransitions,
  type ArchiveContractRequest,
  businessFromDate,
  canTransitionContract,
  CONTRACT_STATUS_LABELS,
  type ContractsQuery,
  type ContractsResponse,
  dateFromBusiness,
  isContractEditable,
  type PerformanceContract,
  type PerformanceContractRow,
  type UpdateContractRequest,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import {
  assertVersion,
  type FieldError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { ScopeService } from '../auth/scope.service';
import { PerformanceAccess } from './performance-access';
import {
  dateOrNull,
  itemsSnapshot,
  LIVE_ITEMS,
  PERFORMANCE_CONTRACT_ENTITY,
  personName,
  type ResolvedItem,
  resolveItems,
  sectionTotalsOf,
  toItemDto,
  toRatingScaleDto,
  userDisplayNames,
} from './performance-common';

const ROW_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      companyId: true,
      jobTitle: true,
      jobGrade: true,
      dateEngaged: true,
      status: true,
      companyRule: { select: { description: true } },
      reportsTo: { select: { firstName: true, lastName: true } },
    },
  },
  template: { select: { name: true } },
} satisfies Prisma.PerformanceContractInclude;

type ContractRowData = Prisma.PerformanceContractGetPayload<{ include: typeof ROW_INCLUDE }>;

const SORTS: Record<ContractsQuery['sort'], Prisma.PerformanceContractOrderByWithRelationInput[]> = {
  'employeeCode:asc': [{ employee: { employeeCode: 'asc' } }, { id: 'asc' }],
  'employeeCode:desc': [{ employee: { employeeCode: 'desc' } }, { id: 'desc' }],
  'lastName:asc': [{ employee: { lastName: 'asc' } }, { employee: { firstName: 'asc' } }, { id: 'asc' }],
  'lastName:desc': [{ employee: { lastName: 'desc' } }, { employee: { firstName: 'desc' } }, { id: 'desc' }],
  'startDate:desc': [{ startDate: 'desc' }, { id: 'desc' }],
  'startDate:asc': [{ startDate: 'asc' }, { id: 'asc' }],
  'contractName:asc': [{ name: 'asc' }, { id: 'asc' }],
};

function toRow(c: ContractRowData, users: Map<string, string>): PerformanceContractRow {
  return {
    id: c.id,
    employeeId: c.employeeId,
    employeeCode: c.employee.employeeCode,
    firstName: c.employee.firstName,
    lastName: c.employee.lastName,
    templateId: c.templateId,
    templateName: c.template.name,
    contractName: c.name,
    contractStartDate: businessFromDate(c.startDate),
    contractEndDate: businessFromDate(c.endDate),
    jobTitle: c.employee.jobTitle,
    jobGrade: c.employee.jobGrade,
    employeeCompanyRule: c.employee.companyRule.description,
    reportsTo: personName(c.employee.reportsTo),
    employeeDateEngaged: dateOrNull(c.employee.dateEngaged),
    employeeStatus: c.employee.status,
    contractType: c.contractType,
    contractStatus: c.status,
    currentlyAssignedUserId: c.currentlyAssignedUserId,
    currentlyAssigned: c.currentlyAssignedUserId ? (users.get(c.currentlyAssignedUserId) ?? null) : null,
    initiationId: c.initiationId,
    archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null,
    version: c.version,
  };
}

/** A contract to create from a template (initiation job). */
export interface NewContract {
  employeeId: number;
  templateId: number;
  initiationId: number | null;
  name: string;
  contractType: string | null;
  startDate: string;
  endDate: string;
  currentlyAssignedUserId: string | null;
  items: {
    kind: TemplateItemKind;
    parameterValueId: number | null;
    title: string;
    weight: string;
    target: string | null;
    sortOrder: number;
  }[];
}

/**
 * Contracts and Archived Contracts (section 5.9). Status rules (ASSUMPTION A95):
 *
 * | to       | from   | who                                        |
 * | -------- | ------ | ------------------------------------------ |
 * | AGREED   | DRAFT  | the employee, their manager or HR in scope |
 * | ACTIVE   | AGREED | the manager or HR                          |
 * | CLOSED   | ACTIVE | the manager or HR                          |
 * | ARCHIVED | CLOSED or DRAFT | HR (POST …/archive)               |
 *
 * Items, dates, name and type change only while DRAFT (manager or HR); the assignee can be changed
 * by the manager or HR until the contract is archived.
 */
@Injectable()
export class ContractService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly access: PerformanceAccess,
    private readonly scope: ScopeService,
  ) {}

  async list(ctx: SecurityContext, query: ContractsQuery): Promise<ContractsResponse> {
    const search = query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { employee: { employeeCode: { contains: query.search, mode: 'insensitive' as const } } },
            { employee: { firstName: { contains: query.search, mode: 'insensitive' as const } } },
            { employee: { lastName: { contains: query.search, mode: 'insensitive' as const } } },
          ],
        }
      : {};
    const where: Prisma.PerformanceContractWhereInput = {
      AND: [
        await this.access.contractWhere(ctx),
        query.archived ? { status: 'ARCHIVED' } : { status: { not: 'ARCHIVED' } },
        query.status ? { status: query.status } : {},
        {
          employeeId: query.employeeId,
          templateId: query.templateId,
          initiationId: query.initiationId,
        },
        search,
      ],
    };
    const [rows, total] = await Promise.all([
      this.db.prisma.performanceContract.findMany({
        where,
        include: ROW_INCLUDE,
        orderBy: SORTS[query.sort],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.prisma.performanceContract.count({ where }),
    ]);
    const users = await userDisplayNames(
      this.db.prisma,
      rows.map((r) => r.currentlyAssignedUserId),
    );
    return { items: rows.map((r) => toRow(r, users)), total, page: query.page, pageSize: query.pageSize };
  }

  async get(ctx: SecurityContext, id: number, client: Tx = this.db.prisma): Promise<PerformanceContract> {
    const c = await client.performanceContract.findUnique({
      where: { id },
      include: { ...ROW_INCLUDE, items: LIVE_ITEMS, template: { select: { name: true, ratingScale: true } } },
    });
    if (!c) throw new NotFoundError('Performance contract');
    await this.access.assertCanReadContract(ctx, c, client);
    const actors = await this.access.contractActors(ctx, c.employee, client);
    const users = await userDisplayNames(client, [c.currentlyAssignedUserId]);
    return {
      ...toRow(c, users),
      ratingScale: c.template.ratingScale ? toRatingScaleDto(c.template.ratingScale) : null,
      items: c.items.map(toItemDto),
      sectionTotals: sectionTotalsOf(c.items),
      allowedStatuses: allowedContractTransitions(c.status, actors),
      canEdit: isContractEditable(c.status) && (actors.includes('HR_ADMIN') || actors.includes('MANAGER')),
    };
  }

  /** Creates a contract and its items (the caller audits). Used by the initiation job. */
  async createFromTemplate(tx: Tx, input: NewContract): Promise<{ id: number }> {
    const contract = await tx.performanceContract.create({
      data: {
        employeeId: input.employeeId,
        templateId: input.templateId,
        initiationId: input.initiationId,
        name: input.name,
        contractType: input.contractType,
        startDate: dateFromBusiness(input.startDate),
        endDate: dateFromBusiness(input.endDate),
        currentlyAssignedUserId: input.currentlyAssignedUserId,
        status: 'DRAFT',
      },
    });
    for (const item of input.items) {
      await tx.performanceContractItem.create({ data: { ...item, contractId: contract.id } });
    }
    return contract;
  }

  async update(ctx: SecurityContext, id: number, input: UpdateContractRequest): Promise<PerformanceContract> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'PerformanceContract', id);
      const before = await tx.performanceContract.findUnique({
        where: { id },
        include: {
          employee: { select: { id: true, companyId: true } },
          items: { where: { deletedAt: null } },
        },
      });
      if (!before) throw new NotFoundError('Performance contract');
      const actors = await this.access.contractActors(ctx, before.employee, tx);
      const editor = actors.includes('HR_ADMIN') || actors.includes('MANAGER');
      const changesFields =
        input.name !== undefined ||
        input.contractType !== undefined ||
        input.startDate !== undefined ||
        input.endDate !== undefined ||
        input.items !== undefined ||
        input.currentlyAssignedUserId !== undefined;
      if (actors.length === 0 || (changesFields && !editor)) throw this.denied(before.id, before.employeeId);
      assertVersion(before, input.version);
      if (before.status === 'ARCHIVED') throw new ValidationError('An archived contract cannot change');

      const errors: FieldError[] = [];
      const draftOnly = (['name', 'contractType', 'startDate', 'endDate', 'items'] as const).filter(
        (k) => input[k] !== undefined,
      );
      if (!isContractEditable(before.status))
        for (const k of draftOnly)
          errors.push({ path: k, message: 'This can change only while the contract is a draft' });
      const start = input.startDate ?? businessFromDate(before.startDate);
      const end = input.endDate ?? businessFromDate(before.endDate);
      if (end < start)
        errors.push({ path: 'endDate', message: 'The end date cannot be before the start date' });
      if (input.status !== undefined && !canTransitionContract(before.status, input.status))
        errors.push({
          path: 'status',
          message: `A ${CONTRACT_STATUS_LABELS[before.status]} contract cannot become ${CONTRACT_STATUS_LABELS[input.status]}`,
        });
      if (input.currentlyAssignedUserId) {
        const user = await tx.user.findUnique({
          where: { id: input.currentlyAssignedUserId },
          select: { isActive: true },
        });
        if (!user?.isActive)
          errors.push({ path: 'currentlyAssignedUserId', message: 'Choose an active user' });
      }
      if (errors.length > 0) throw new ValidationError(errors);
      if (
        input.status !== undefined &&
        !allowedContractTransitions(before.status, actors).includes(input.status)
      )
        throw this.denied(before.id, before.employeeId);

      const existing = new Map(before.items.map((i) => [i.id, i]));
      const items = input.items === undefined ? null : await resolveItems(tx, input.items, existing);
      const after = await tx.performanceContract.update({
        where: { id },
        data: {
          name: input.name,
          contractType: input.contractType,
          startDate: input.startDate ? dateFromBusiness(input.startDate) : undefined,
          endDate: input.endDate ? dateFromBusiness(input.endDate) : undefined,
          currentlyAssignedUserId: input.currentlyAssignedUserId,
          status: input.status,
          version: { increment: 1 },
        },
      });
      if (items) await this.writeItems(tx, id, items, new Set(existing.keys()));
      const { items: beforeItems, employee: _employee, ...beforeRow } = before;
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action:
          input.status !== undefined ? 'PERFORMANCE_CONTRACT.STATUS_CHANGED' : 'PERFORMANCE_CONTRACT.UPDATED',
        entityType: PERFORMANCE_CONTRACT_ENTITY,
        entityId: id,
        subjectEmployeeId: before.employeeId,
        before: { ...beforeRow, items: itemsSnapshot(beforeItems) },
        after: { ...after, items: itemsSnapshot(items ?? beforeItems) },
        metadata: { actors },
      });
      return this.get(ctx, id, tx);
    });
  }

  /** POST /performance/contracts/:id/archive: HR in scope; from CLOSED or DRAFT. */
  async archive(
    ctx: SecurityContext,
    id: number,
    input: ArchiveContractRequest,
  ): Promise<PerformanceContract> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'PerformanceContract', id);
      const before = await tx.performanceContract.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('Performance contract');
      await this.scope.assertCanAccessEmployee(ctx, before.employeeId, 'HR_WRITE', tx);
      assertVersion(before, input.version);
      if (!canTransitionContract(before.status, 'ARCHIVED'))
        throw ValidationError.field(
          'status',
          `A ${CONTRACT_STATUS_LABELS[before.status]} contract cannot be archived; close it first`,
        );
      const after = await tx.performanceContract.update({
        where: { id },
        data: { status: 'ARCHIVED', archivedAt: new Date(), version: { increment: 1 } },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'PERFORMANCE_CONTRACT.ARCHIVED',
        entityType: PERFORMANCE_CONTRACT_ENTITY,
        entityId: id,
        subjectEmployeeId: before.employeeId,
        before,
        after,
        reason: input.reason ?? null,
      });
      return this.get(ctx, id, tx);
    });
  }

  private denied(contractId: number, employeeId: number): ForbiddenError {
    return new ForbiddenError('You cannot change this contract', {
      subjectEmployeeId: employeeId,
      metadata: { contractId },
    });
  }

  private async writeItems(
    tx: Tx,
    contractId: number,
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
        await tx.performanceContractItem.update({ where: { id: item.id }, data });
      } else {
        await tx.performanceContractItem.create({ data: { ...data, contractId } });
      }
    }
    const now = new Date();
    for (const id of existingIds) {
      if (!kept.has(id)) await tx.performanceContractItem.update({ where: { id }, data: { deletedAt: now } });
    }
  }
}
