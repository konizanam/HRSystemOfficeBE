import { Injectable } from '@nestjs/common';
import type { ClaimCap } from '@prisma/client';
import {
  CAP_CYCLE_LABELS,
  CAP_MODE_LABELS,
  CLAIM_INPUT_MODE_LABELS,
  CLAIM_QUANTITY_LABELS,
  type ClaimCapSummary,
  type ClaimGroupSetupResponse,
  type ClaimGroupsResponse,
  type ClaimTypeSetup,
  money2,
  resolveClaimRate,
  units4,
} from '@peoplehub/shared';
import type { SecurityContext } from '../../common/context/security-context';
import { NotFoundError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { ScopeService } from '../auth/scope.service';
import { WorkflowEngine } from '../workflow/workflow-engine.service';
import {
  CLAIM_EMPLOYEE_SELECT,
  type ClaimEmployee,
  type ClaimTypeWithCaps,
  SUBMITTED_CLAIM_STATUSES,
} from './claim-constants';

/** A claim type the employee's company rule may claim, with the caps that apply to that rule. */
export interface ApplicableType {
  type: ClaimTypeWithCaps;
  /** The active caps of the most specific level: the company rule's own, else the global ones. */
  caps: ClaimCap[];
}

/**
 * The caps of a type that apply to a company rule (ASSUMPTION, see docs): the type's active caps
 * for that rule when it has any, otherwise its active caps for every rule (`companyRuleId` null).
 * A type with neither does not apply to the rule.
 */
export function capsForRule(caps: readonly ClaimCap[], companyRuleId: number): ClaimCap[] {
  const active = caps.filter((c) => c.isActive);
  const own = active.filter((c) => c.companyRuleId === companyRuleId);
  const chosen = own.length > 0 ? own : active.filter((c) => c.companyRuleId === null);
  return [...chosen].sort((a, b) => a.cycle.localeCompare(b.cycle) || a.id - b.id);
}

export function capSummary(cap: ClaimCap): ClaimCapSummary {
  return {
    id: cap.id,
    cycle: cap.cycle,
    cycleLabel: CAP_CYCLE_LABELS[cap.cycle],
    mode: cap.mode,
    modeLabel: CAP_MODE_LABELS[cap.mode] as ClaimCapSummary['modeLabel'],
    amountLimit: cap.amountLimit === null ? null : money2(cap.amountLimit),
    quantityLimit: cap.quantityLimit === null ? null : units4(cap.quantityLimit),
    proRata: cap.proRata,
    companyRuleId: cap.companyRuleId,
  };
}

/**
 * Claim eligibility (section 5.3.1): which groups and types an employee may claim, at what rate,
 * under which caps, and whether a group's workflow can start (`employeeCanStartWorkflow`).
 */
@Injectable()
export class ClaimSetupService {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly engine: WorkflowEngine,
  ) {}

  async loadEmployee(client: Tx, employeeId: number): Promise<ClaimEmployee> {
    const employee = await client.employee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: CLAIM_EMPLOYEE_SELECT,
    });
    if (!employee) throw new NotFoundError('Employee');
    return employee;
  }

  /** Active types of active groups (optionally one group) that apply to the company rule. */
  async applicableTypes(client: Tx, companyRuleId: number, groupId?: number): Promise<ApplicableType[]> {
    const types = await client.claimType.findMany({
      where: { isActive: true, group: { isActive: true }, ...(groupId !== undefined ? { groupId } : {}) },
      include: {
        group: true,
        caps: { where: { isActive: true, OR: [{ companyRuleId: null }, { companyRuleId }] } },
      },
      orderBy: [{ groupId: 'asc' }, { id: 'asc' }],
    });
    return types
      .map((type) => ({ type, caps: capsForRule(type.caps, companyRuleId) }))
      .filter((t) => t.caps.length > 0);
  }

  /**
   * employeeCanStartWorkflow(GROUPEDCLAIM, groupId): the group is active, at least one of its
   * types applies to the employee's company rule, and a GROUPEDCLAIM definition applies (the
   * group id is the discriminator).
   */
  async canStartGroup(client: Tx, employee: ClaimEmployee, groupId: number, applicable?: ApplicableType[]) {
    const types = applicable ?? (await this.applicableTypes(client, employee.companyRuleId, groupId));
    if (!types.some((t) => t.type.groupId === groupId)) return false;
    return this.engine.canStartFor(employee.id, 'GROUPEDCLAIM', String(groupId), client);
  }

  /** GET /claims/groups: one tile per active group with eligible types. */
  async groups(ctx: SecurityContext, employeeId = ctx.actingAsEmployeeId): Promise<ClaimGroupsResponse> {
    await this.scope.assertCanAccessEmployee(ctx, employeeId, 'SELF_SERVICE');
    const prisma = this.db.prisma;
    const employee = await this.loadEmployee(prisma, employeeId);
    const [applicable, counts] = await Promise.all([
      this.applicableTypes(prisma, employee.companyRuleId),
      prisma.claim.groupBy({
        by: ['groupId', 'status'],
        where: { employeeId, status: { in: ['DRAFT', ...SUBMITTED_CLAIM_STATUSES] } },
        _count: true,
      }),
    ]);
    const groups = new Map<number, { group: ClaimTypeWithCaps['group']; types: number }>();
    for (const t of applicable) {
      const entry = groups.get(t.type.groupId) ?? { group: t.type.group, types: 0 };
      entry.types += 1;
      groups.set(t.type.groupId, entry);
    }
    const count = (groupId: number, saved: boolean) =>
      counts
        .filter((c) => c.groupId === groupId && (c.status === 'DRAFT') === saved)
        .reduce((sum, c) => sum + c._count, 0);
    const items = [];
    for (const [groupId, { group, types }] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      items.push({
        id: group.id,
        code: group.code,
        description: group.description,
        attachmentMandatory: group.attachmentMandatory,
        submittedCount: count(groupId, false),
        savedCount: count(groupId, true),
        typeCount: types,
        canStart: await this.engine.canStartFor(employee.id, 'GROUPEDCLAIM', String(groupId)),
      });
    }
    return { employeeId, items };
  }

  /** The editor setup of a type for an employee: input mode, rates and caps. */
  typeSetup(t: ApplicableType, employee: ClaimEmployee): ClaimTypeSetup {
    const { type } = t;
    const resolved = resolveClaimRate({
      inputMode: type.inputMode,
      rate: type.rate?.toString() ?? null,
      rateMultiplier: type.rateMultiplier?.toString() ?? null,
      hourlyRate: employee.hourlyRate?.toString() ?? null,
    });
    return {
      id: type.id,
      code: type.code,
      description: type.description,
      inputMode: type.inputMode,
      inputModeLabel: CLAIM_INPUT_MODE_LABELS[type.inputMode],
      quantityLabel: CLAIM_QUANTITY_LABELS[type.inputMode],
      usesTimes: type.inputMode === 'HOURS',
      rate: type.rate === null ? null : units4(type.rate),
      rateMultiplier: type.rateMultiplier === null ? null : units4(type.rateMultiplier),
      effectiveRate: resolved ? units4(resolved.rate) : null,
      rateSource: resolved?.source ?? null,
      requiresAttachment: type.requiresAttachment,
      payrollCode: type.payrollCode,
      caps: t.caps.map(capSummary),
    };
  }

  /** GET /claims/groups/:id/setup. */
  async setup(
    ctx: SecurityContext,
    groupId: number,
    employeeId = ctx.actingAsEmployeeId,
  ): Promise<ClaimGroupSetupResponse> {
    await this.scope.assertCanAccessEmployee(ctx, employeeId, 'SELF_SERVICE');
    const prisma = this.db.prisma;
    const group = await prisma.claimGroup.findUnique({ where: { id: groupId } });
    if (!group || !group.isActive) throw new NotFoundError('Claim group');
    const employee = await this.loadEmployee(prisma, employeeId);
    const applicable = await this.applicableTypes(prisma, employee.companyRuleId, groupId);
    return {
      employeeId,
      currency: employee.company.currency,
      group: {
        id: group.id,
        code: group.code,
        description: group.description,
        attachmentMandatory: group.attachmentMandatory,
      },
      canStart: await this.canStartGroup(prisma, employee, groupId, applicable),
      types: applicable.map((t) => this.typeSetup(t, employee)),
    };
  }
}
