import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  type AdminWorkflowDefinition,
  type AdminWorkflowDefinitionsQuery,
  type AdminWorkflowDefinitionsResponse,
  type CreateWorkflowDefinitionRequest,
  type UpdateWorkflowDefinitionRequest,
  type WorkflowStepInput,
  type WorkflowTypeCode,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import { assertVersion, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { assertCompanyScope } from './admin-scope';

const OPEN_PROCESS_STATUSES = ['IN_PROGRESS', 'RESUBMIT_REQUIRED', 'APPROVED_PENDING_PROCESS'] as const;

const DEFINITION_INCLUDE = {
  workflowType: true,
  companyRule: { select: { id: true, description: true, companyId: true } },
  steps: { orderBy: { stepNo: 'asc' }, include: { approverUser: { select: { username: true } } } },
  _count: { select: { processes: true } },
} satisfies Prisma.WorkflowDefinitionInclude;

type DefinitionRow = Prisma.WorkflowDefinitionGetPayload<{ include: typeof DEFINITION_INCLUDE }>;

function toDto(d: DefinitionRow, openProcessCount: number): AdminWorkflowDefinition {
  return {
    id: d.id,
    workflowType: d.workflowType.code as WorkflowTypeCode,
    workflowTypeDescription: d.workflowType.description,
    companyRuleId: d.companyRuleId,
    companyRule: d.companyRule?.description ?? null,
    discriminator: d.discriminator,
    name: d.name,
    versionNo: d.versionNo,
    previousVersionId: d.previousVersionId,
    isActive: d.isActive,
    allowReassign: d.allowReassign,
    allowResubmit: d.allowResubmit,
    canPark: d.canPark,
    processCount: d._count.processes,
    openProcessCount,
    steps: d.steps.map((s) => ({
      id: s.id,
      stepNo: s.stepNo,
      name: s.name,
      resolution: s.resolution,
      approverRole: s.approverRole,
      approverUserId: s.approverUserId,
      approverUsername: s.approverUser?.username ?? null,
      isMandatory: s.isMandatory,
      skipIfSameApprover: s.skipIfSameApprover,
      escalationHours: s.escalationHours,
    })),
    version: d.version,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/** The definition and its steps as plain data, for audit snapshots. */
function snapshot(d: DefinitionRow) {
  return {
    id: d.id,
    workflowType: d.workflowType.code,
    companyRuleId: d.companyRuleId,
    discriminator: d.discriminator,
    name: d.name,
    versionNo: d.versionNo,
    previousVersionId: d.previousVersionId,
    isActive: d.isActive,
    allowReassign: d.allowReassign,
    allowResubmit: d.allowResubmit,
    canPark: d.canPark,
    version: d.version,
    steps: d.steps.map((s) => ({
      stepNo: s.stepNo,
      name: s.name,
      resolution: s.resolution,
      approverRole: s.approverRole,
      approverUserId: s.approverUserId,
      isMandatory: s.isMandatory,
      skipIfSameApprover: s.skipIfSameApprover,
      escalationHours: s.escalationHours,
    })),
  };
}

/**
 * Workflow definitions and their steps (section 7.1, 12.10; HR_ADMIN). A definition applies to
 * `(workflowType, companyRule | null, discriminator?)`; a type-wide one (company rule null) may be
 * changed by any HR admin, a company rule's only by HR of that company.
 *
 * Definitions are versioned, never edited in place: a change creates a new row with
 * `versionNo + 1` and `previousVersionId`, copies nothing from the old steps, and deactivates the
 * old row. Running processes keep the definition (and steps) they started on, so a change only
 * affects new requests. Deleting deactivates; activating an old version brings it back without a
 * new version (the newest active version of the same key wins).
 */
@Injectable()
export class WorkflowDefinitionAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(
    ctx: SecurityContext,
    query: AdminWorkflowDefinitionsQuery,
  ): Promise<AdminWorkflowDefinitionsResponse> {
    const rows = await this.db.prisma.workflowDefinition.findMany({
      where: {
        ...(query.workflowType ? { workflowType: { code: query.workflowType } } : {}),
        ...(query.companyRuleId ? { companyRuleId: query.companyRuleId } : {}),
        ...(query.includeInactive ? {} : { isActive: true }),
        // Type-wide definitions plus those of the caller's company rules.
        OR: [{ companyRuleId: null }, { companyRule: { companyId: { in: ctx.companyIds } } }],
      },
      include: DEFINITION_INCLUDE,
      orderBy: [{ workflowTypeId: 'asc' }, { companyRuleId: 'asc' }, { versionNo: 'desc' }, { id: 'desc' }],
    });
    const open = await this.openCounts(rows.map((r) => r.id));
    return { items: rows.map((r) => toDto(r, open.get(r.id) ?? 0)) };
  }

  async get(ctx: SecurityContext, id: number): Promise<AdminWorkflowDefinition> {
    const row = await this.db.prisma.workflowDefinition.findUnique({
      where: { id },
      include: DEFINITION_INCLUDE,
    });
    if (!row) throw new NotFoundError('Workflow definition');
    if (row.companyRule) assertCompanyScope(ctx, row.companyRule.companyId);
    return toDto(row, (await this.openCounts([id])).get(id) ?? 0);
  }

  async create(
    ctx: SecurityContext,
    input: CreateWorkflowDefinitionRequest,
  ): Promise<AdminWorkflowDefinition> {
    return this.db.tx(ctx, async (tx) => {
      const type = await tx.workflowType.findUnique({ where: { code: input.workflowType } });
      if (!type) throw ValidationError.field('workflowType', 'Unknown workflow type');
      if (input.companyRuleId !== null) {
        const rule = await tx.companyRule.findUnique({ where: { id: input.companyRuleId } });
        if (!rule) throw ValidationError.field('companyRuleId', 'Unknown company rule');
        assertCompanyScope(ctx, rule.companyId);
        if (!rule.isActive) throw ValidationError.field('companyRuleId', 'This company rule is deactivated');
      }
      await this.checkStepUsers(tx, input.steps);
      const latest = await tx.workflowDefinition.findFirst({
        where: {
          workflowTypeId: type.id,
          companyRuleId: input.companyRuleId,
          discriminator: input.discriminator,
        },
        orderBy: { versionNo: 'desc' },
        select: { versionNo: true },
      });
      const created = await tx.workflowDefinition.create({
        data: {
          workflowTypeId: type.id,
          companyRuleId: input.companyRuleId,
          discriminator: input.discriminator,
          name: input.name,
          versionNo: (latest?.versionNo ?? 0) + 1,
          isActive: input.isActive,
          allowReassign: input.allowReassign,
          allowResubmit: input.allowResubmit,
          canPark: input.canPark,
          steps: { create: input.steps.map(stepData) },
        },
        include: DEFINITION_INCLUDE,
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'WORKFLOW_DEFINITION.CREATED',
        entityType: 'WorkflowDefinition',
        entityId: created.id,
        after: snapshot(created),
      });
      return toDto(created, 0);
    });
  }

  /** PUT: a new version with these settings and steps; the edited version is deactivated. */
  async update(
    ctx: SecurityContext,
    id: number,
    input: UpdateWorkflowDefinitionRequest,
  ): Promise<AdminWorkflowDefinition> {
    return this.newVersion(ctx, id, input.version, {
      name: input.name,
      allowReassign: input.allowReassign,
      allowResubmit: input.allowResubmit,
      canPark: input.canPark,
      steps: input.steps,
    });
  }

  /** PUT …/steps: a new version with only the steps changed. */
  async updateSteps(
    ctx: SecurityContext,
    id: number,
    steps: WorkflowStepInput[],
    version: number,
  ): Promise<AdminWorkflowDefinition> {
    return this.newVersion(ctx, id, version, { steps });
  }

  async setActive(
    ctx: SecurityContext,
    id: number,
    isActive: boolean,
    version: number,
  ): Promise<AdminWorkflowDefinition> {
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lock(tx, ctx, id);
      assertVersion(before, version);
      if (before.isActive === isActive) {
        throw ValidationError.field(
          '',
          isActive ? 'This definition is already active' : 'This definition is already inactive',
        );
      }
      const after = await tx.workflowDefinition.update({
        where: { id },
        data: { isActive, version: { increment: 1 } },
        include: DEFINITION_INCLUDE,
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: isActive ? 'WORKFLOW_DEFINITION.ACTIVATED' : 'WORKFLOW_DEFINITION.DEACTIVATED',
        entityType: 'WorkflowDefinition',
        entityId: id,
        before: snapshot(before),
        after: snapshot(after),
      });
      return toDto(after, (await this.openCounts([id], tx)).get(id) ?? 0);
    });
  }

  private async newVersion(
    ctx: SecurityContext,
    id: number,
    version: number,
    change: {
      name?: string;
      allowReassign?: boolean;
      allowResubmit?: boolean;
      canPark?: boolean;
      steps: WorkflowStepInput[];
    },
  ): Promise<AdminWorkflowDefinition> {
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lock(tx, ctx, id);
      assertVersion(before, version);
      await this.checkStepUsers(tx, change.steps);
      const latest = await tx.workflowDefinition.findFirst({
        where: {
          workflowTypeId: before.workflowTypeId,
          companyRuleId: before.companyRuleId,
          discriminator: before.discriminator,
        },
        orderBy: { versionNo: 'desc' },
        select: { versionNo: true },
      });
      const retired = await tx.workflowDefinition.update({
        where: { id },
        data: { isActive: false, version: { increment: 1 } },
        include: DEFINITION_INCLUDE,
      });
      const created = await tx.workflowDefinition.create({
        data: {
          workflowTypeId: before.workflowTypeId,
          companyRuleId: before.companyRuleId,
          discriminator: before.discriminator,
          name: change.name ?? before.name,
          versionNo: Math.max(latest?.versionNo ?? 0, before.versionNo) + 1,
          previousVersionId: before.id,
          isActive: before.isActive,
          allowReassign: change.allowReassign ?? before.allowReassign,
          allowResubmit: change.allowResubmit ?? before.allowResubmit,
          canPark: change.canPark ?? before.canPark,
          steps: { create: change.steps.map(stepData) },
        },
        include: DEFINITION_INCLUDE,
      });
      const openOnOld = (await this.openCounts([id], tx)).get(id) ?? 0;
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'WORKFLOW_DEFINITION.SUPERSEDED',
        entityType: 'WorkflowDefinition',
        entityId: id,
        before: snapshot(before),
        after: snapshot(retired),
        metadata: { newDefinitionId: created.id, openProcessesKeepThisVersion: openOnOld },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'WORKFLOW_DEFINITION.VERSION_CREATED',
        entityType: 'WorkflowDefinition',
        entityId: created.id,
        before: snapshot(before),
        after: snapshot(created),
        metadata: { previousVersionId: before.id, versionNo: created.versionNo },
      });
      return toDto(created, 0);
    });
  }

  private async lock(tx: Tx, ctx: SecurityContext, id: number): Promise<DefinitionRow> {
    await this.db.lockRow(tx, 'WorkflowDefinition', id);
    const row = await tx.workflowDefinition.findUnique({ where: { id }, include: DEFINITION_INCLUDE });
    if (!row) throw new NotFoundError('Workflow definition');
    if (row.companyRule) assertCompanyScope(ctx, row.companyRule.companyId);
    return row;
  }

  /** SPECIFIC_USER steps need an active user. */
  private async checkStepUsers(tx: Tx, steps: WorkflowStepInput[]): Promise<void> {
    for (const [index, step] of steps.entries()) {
      if (step.resolution !== 'SPECIFIC_USER' || !step.approverUserId) continue;
      const user = await tx.user.findUnique({
        where: { id: step.approverUserId },
        select: { isActive: true },
      });
      if (!user?.isActive) {
        throw ValidationError.field(`steps.${index}.approverUserId`, 'Choose an active user');
      }
    }
  }

  private async openCounts(ids: number[], client: Tx = this.db.prisma): Promise<Map<number, number>> {
    if (ids.length === 0) return new Map();
    const rows = await client.workflowProcess.groupBy({
      by: ['definitionId'],
      where: { definitionId: { in: ids }, status: { in: [...OPEN_PROCESS_STATUSES] } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.definitionId, r._count._all]));
  }
}

function stepData(s: WorkflowStepInput) {
  return {
    stepNo: s.stepNo,
    name: s.name,
    resolution: s.resolution,
    approverRole: s.approverRole,
    approverUserId: s.approverUserId,
    isMandatory: s.isMandatory,
    skipIfSameApprover: s.skipIfSameApprover,
    escalationHours: s.escalationHours,
  };
}
