import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_PREFIX,
  formatCardDate,
  formatTimestampDate,
  INBOX_CATEGORIES,
  INBOX_CATEGORY_LABELS,
  type InboxAction,
  type InboxCard,
  type InboxCategoriesResponse,
  type InboxCategory,
  type InboxCategoryCount,
  type InboxItemDetail,
  type InboxItemsQuery,
  type InboxItemsResponse,
  type InboxSort,
  PROCESS_STATUS_LABELS,
  type StepInstance,
  WORKFLOW_TYPE_CATEGORY,
  WORKFLOW_TYPES,
  type WorkflowTypeCode,
  workflowTypesInCategory,
} from '@peoplehub/shared';
import { hasRole, isActingForOther, type SecurityContext } from '../../common/context/security-context';
import { ForbiddenError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import { NotificationService } from '../notifications/notification.service';
import { ApproverResolver } from './approver-resolver.service';
import { unknownPerson, WorkflowPeopleService } from './people.service';
import {
  FINAL_STATUSES,
  IN_FLIGHT_STATUSES,
  OPEN_STEP_STATUSES,
  resolutionSubject,
  toSnapshot,
  typeCode,
} from './process-shape';
import { toSubjectDetail, WorkflowSubjectRegistry } from './subject-registry';
import { WorkflowAccessService } from './workflow-access.service';
import { WorkflowHistoryService } from './workflow-history.service';
import type { SubjectDescription, SubjectViewer } from './workflow-subject';

/** Actions that put a process in an approver's History tab. */
const APPROVER_ACTIONS = ['APPROVE', 'DECLINE', 'REASSIGN', 'SEND_BACK', 'PARK', 'COMMENT'] as const;

const CARD_INCLUDE = (userId: string) =>
  ({
    workflowType: { select: { code: true } },
    subjectEmployee: {
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        companyRuleId: true,
        companyRule: { select: { description: true } },
      },
    },
    stepInstances: {
      where: { assigneeUserId: userId, status: { in: [...OPEN_STEP_STATUSES] } },
      select: { id: true, status: true, parkedUntil: true, round: true, stepNo: true },
    },
  }) satisfies Prisma.WorkflowProcessInclude;

type CardRow = Prisma.WorkflowProcessGetPayload<{ include: ReturnType<typeof CARD_INCLUDE> }>;

const ORDER_BY: Record<InboxSort, Prisma.WorkflowProcessOrderByWithRelationInput[]> = {
  'submittedAt:desc': [{ submittedAt: 'desc' }, { id: 'desc' }],
  'submittedAt:asc': [{ submittedAt: 'asc' }, { id: 'asc' }],
  'applicant:asc': [
    { subjectEmployee: { lastName: 'asc' } },
    { subjectEmployee: { firstName: 'asc' } },
    { id: 'desc' },
  ],
  'applicant:desc': [
    { subjectEmployee: { lastName: 'desc' } },
    { subjectEmployee: { firstName: 'desc' } },
    { id: 'desc' },
  ],
  'type:asc': [{ workflowType: { code: 'asc' } }, { submittedAt: 'desc' }, { id: 'desc' }],
  'type:desc': [{ workflowType: { code: 'desc' } }, { submittedAt: 'desc' }, { id: 'desc' }],
};

/**
 * The inbox (section 5.10): category counts, the Action Required / Submitted / History tabs and
 * the detail panel. Approvals belong to the signed-in user; "My Submitted Items" follow the
 * "Working as" employee (plus, when not acting for someone else, what the user submitted for
 * others).
 */
@Injectable()
export class InboxService {
  constructor(
    private readonly db: DbService,
    private readonly registry: WorkflowSubjectRegistry,
    private readonly history: WorkflowHistoryService,
    private readonly access: WorkflowAccessService,
    private readonly resolver: ApproverResolver,
    private readonly people: WorkflowPeopleService,
    private readonly notifications: NotificationService,
  ) {}

  // ───────────── Filters ─────────────

  /** Open steps assigned to the caller; parked ones only once they are due. */
  private actionWhere(ctx: SecurityContext, now: Date): Prisma.WorkflowProcessWhereInput {
    return {
      status: 'IN_PROGRESS',
      stepInstances: {
        some: {
          assigneeUserId: ctx.userId,
          OR: [{ status: 'PENDING' }, { status: 'PARKED', parkedUntil: { lte: now } }],
        },
      },
    };
  }

  private mineWhere(ctx: SecurityContext): Prisma.WorkflowProcessWhereInput {
    const or: Prisma.WorkflowProcessWhereInput[] = [{ subjectEmployeeId: ctx.actingAsEmployeeId }];
    if (!isActingForOther(ctx)) or.push({ submittedByUserId: ctx.userId });
    return { OR: or };
  }

  private submittedWhere(ctx: SecurityContext): Prisma.WorkflowProcessWhereInput {
    return { AND: [this.mineWhere(ctx), { status: { in: [...IN_FLIGHT_STATUSES] } }] };
  }

  private historyWhere(ctx: SecurityContext): Prisma.WorkflowProcessWhereInput {
    return {
      OR: [
        { AND: [this.mineWhere(ctx), { status: { in: [...FINAL_STATUSES] } }] },
        { actions: { some: { actorUserId: ctx.userId, action: { in: [...APPROVER_ACTIONS] } } } },
      ],
    };
  }

  private processWhere(ctx: SecurityContext): Prisma.WorkflowProcessWhereInput {
    return { status: 'APPROVED_PENDING_PROCESS', subjectEmployee: { companyId: { in: ctx.companyIds } } };
  }

  private boxWhere(
    ctx: SecurityContext,
    box: InboxItemsQuery['box'],
    now: Date,
  ): Prisma.WorkflowProcessWhereInput {
    switch (box) {
      case 'action':
        return this.actionWhere(ctx, now);
      case 'submitted':
        return this.submittedWhere(ctx);
      case 'history':
        return this.historyWhere(ctx);
      case 'process':
        if (!hasRole(ctx, 'PAYROLL_ADMIN')) {
          throw new ForbiddenError('Only payroll administrators can see items waiting to be processed', {
            metadata: { box },
          });
        }
        return this.processWhere(ctx);
    }
  }

  // ───────────── Categories ─────────────

  async categories(ctx: SecurityContext): Promise<InboxCategoriesResponse> {
    const now = new Date();
    const prisma = this.db.prisma;
    const isPayroll = hasRole(ctx, 'PAYROLL_ADMIN');
    const [
      types,
      actionGroups,
      submittedGroups,
      historyCount,
      unread,
      pendingProcess,
      assignedEver,
      enabled,
    ] = await Promise.all([
      prisma.workflowType.findMany({ select: { id: true, code: true } }),
      prisma.workflowProcess.groupBy({
        by: ['workflowTypeId'],
        where: this.actionWhere(ctx, now),
        _count: true,
      }),
      prisma.workflowProcess.groupBy({
        by: ['workflowTypeId'],
        where: this.submittedWhere(ctx),
        _count: true,
      }),
      prisma.workflowProcess.count({ where: this.historyWhere(ctx) }),
      this.notifications.unreadCount(ctx.userId),
      isPayroll ? prisma.workflowProcess.count({ where: this.processWhere(ctx) }) : Promise.resolve(null),
      prisma.workflowStepInstance.count({ where: { assigneeUserId: ctx.userId } }),
      this.enabledTypes(ctx),
    ]);
    const codeOf = new Map(types.map((t) => [t.id, t.code as WorkflowTypeCode]));
    const tally = (groups: { workflowTypeId: number; _count: number }[]) => {
      const counts = new Map<InboxCategory, number>();
      for (const g of groups) {
        const code = codeOf.get(g.workflowTypeId);
        if (!code) continue;
        const category = WORKFLOW_TYPE_CATEGORY[code];
        counts.set(category, (counts.get(category) ?? 0) + g._count);
      }
      return counts;
    };
    const enabledCategories = new Set([...enabled].map((code) => WORKFLOW_TYPE_CATEGORY[code]));
    const list = (counts: Map<InboxCategory, number>): InboxCategoryCount[] =>
      INBOX_CATEGORIES.filter((c) => (counts.get(c) ?? 0) > 0 || enabledCategories.has(c)).map(
        (category) => ({
          category,
          label: INBOX_CATEGORY_LABELS[category],
          count: counts.get(category) ?? 0,
          workflowTypes: workflowTypesInCategory(category),
        }),
      );
    const actionCounts = tally(actionGroups);
    const submittedCounts = tally(submittedGroups);
    const isApprover = hasRole(ctx, 'MANAGER', 'HR_ADMIN', 'PAYROLL_ADMIN') || assignedEver > 0;
    const sum = (m: Map<InboxCategory, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    return {
      submitted: list(submittedCounts),
      approvals: isApprover ? list(actionCounts) : [],
      isApprover,
      tabs: { action: sum(actionCounts), submitted: sum(submittedCounts), history: historyCount },
      pendingProcess,
      unreadNotifications: unread,
    };
  }

  /** Types the acting-as employee can start: active, with an active definition for their company rule. */
  private async enabledTypes(ctx: SecurityContext): Promise<Set<WorkflowTypeCode>> {
    const employee = await this.db.prisma.employee.findFirst({
      where: { id: ctx.actingAsEmployeeId, deletedAt: null },
      select: { companyRuleId: true },
    });
    if (!employee) return new Set();
    const definitions = await this.db.prisma.workflowDefinition.findMany({
      where: {
        isActive: true,
        workflowType: { isActive: true },
        OR: [{ companyRuleId: null }, { companyRuleId: employee.companyRuleId }],
        steps: { some: {} },
      },
      select: { workflowType: { select: { code: true } } },
    });
    return new Set(definitions.map((d) => d.workflowType.code as WorkflowTypeCode));
  }

  // ───────────── Items ─────────────

  async items(ctx: SecurityContext, query: InboxItemsQuery): Promise<InboxItemsResponse> {
    const now = new Date();
    const and: Prisma.WorkflowProcessWhereInput[] = [this.boxWhere(ctx, query.box, now)];
    if (query.type) and.push({ workflowType: { code: query.type } });
    if (query.category) and.push({ workflowType: { code: { in: workflowTypesInCategory(query.category) } } });
    if (query.filter) {
      const contains = { contains: query.filter, mode: 'insensitive' as const };
      and.push({
        OR: [
          { subjectEmployee: { firstName: contains } },
          { subjectEmployee: { lastName: contains } },
          { subjectEmployee: { employeeCode: contains } },
          { summary: contains },
        ],
      });
    }
    const where: Prisma.WorkflowProcessWhereInput = { AND: and };
    const [rows, total] = await Promise.all([
      this.db.prisma.workflowProcess.findMany({
        where,
        orderBy: ORDER_BY[query.sort],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: CARD_INCLUDE(ctx.userId),
      }),
      this.db.prisma.workflowProcess.count({ where }),
    ]);
    const items = await Promise.all(rows.map((row) => this.card(row, now, { ctx, mode: 'card' })));
    return { items: items.map((c) => c.card), total, page: query.page, pageSize: query.pageSize };
  }

  private async card(
    row: CardRow,
    now: Date,
    viewer: SubjectViewer,
  ): Promise<{ card: InboxCard; description: SubjectDescription }> {
    const type = typeCode(row);
    const description = await this.registry.get(type).describe(this.db.prisma, toSnapshot(row, type), viewer);
    const mine = row.stepInstances.find((i) => i.round === row.round && i.stepNo === row.currentStepNo);
    const due = mine && (mine.status === 'PENDING' || (mine.parkedUntil !== null && mine.parkedUntil <= now));
    const e = row.subjectEmployee;
    const { fromDate, toDate } = description;
    return {
      description,
      card: {
        processId: row.id,
        version: row.version,
        workflowType: type,
        typeLabel: WORKFLOW_TYPES[type],
        requestLabel: description.requestLabel,
        category: WORKFLOW_TYPE_CATEGORY[type],
        title: `${e.firstName} ${e.lastName} - ${e.employeeCode}`,
        applicant: {
          employeeId: e.id,
          employeeCode: e.employeeCode,
          firstName: e.firstName,
          lastName: e.lastName,
          companyRuleId: e.companyRuleId,
          companyRule: e.companyRule.description,
        },
        fromDate,
        toDate,
        periodText:
          fromDate && toDate ? `from ${formatCardDate(fromDate)} to ${formatCardDate(toDate)}` : null,
        status: row.status,
        statusLabel: PROCESS_STATUS_LABELS[row.status],
        statusText: `Status: ${PROCESS_STATUS_LABELS[row.status]}`,
        unitsLine: description.unitsLine,
        summary: row.summary,
        submittedAt: row.submittedAt?.toISOString() ?? null,
        submittedDate: row.submittedAt ? formatTimestampDate(row.submittedAt) : '',
        currentStepNo: row.currentStepNo,
        isEscalated: row.isEscalated,
        parkedUntil: mine?.status === 'PARKED' && mine.parkedUntil ? mine.parkedUntil.toISOString() : null,
        canAct: row.status === 'IN_PROGRESS' && Boolean(due),
        viewLabel: description.viewLabel,
        subjectEntity: row.subjectEntity,
        subjectEntityId: row.subjectEntityId,
      },
    };
  }

  // ───────────── Detail ─────────────

  async detail(ctx: SecurityContext, processId: number): Promise<InboxItemDetail> {
    const prisma = this.db.prisma;
    const p = await this.history.loadReadable(ctx, processId);
    const row = await prisma.workflowProcess.findUniqueOrThrow({
      where: { id: processId },
      include: CARD_INCLUDE(ctx.userId),
    });
    const now = new Date();
    const { card, description } = await this.card(row, now, { ctx, mode: 'detail' });
    const type = typeCode(p);
    const handler = this.registry.get(type);
    const { events, persons } = await this.history.events(prisma, p, description.requestLabel);
    const mine = row.stepInstances.find((i) => i.round === p.round && i.stepNo === p.currentStepNo);
    const applicantUserIds = await this.resolver.applicantUserIds(prisma, resolutionSubject(p));
    const canApprove = p.status === 'IN_PROGRESS' && mine !== undefined && !applicantUserIds.has(ctx.userId);
    const isApplicant = this.access.isApplicant(ctx, p);
    const isApprover = await this.access.isApprover(prisma, ctx, p.id);
    const inFlight = (IN_FLIGHT_STATUSES as readonly string[]).includes(p.status);

    const allowed = new Set<InboxAction>();
    if (canApprove) {
      allowed.add('APPROVE');
      allowed.add('DECLINE');
      if (p.definition.allowReassign) allowed.add('REASSIGN');
      if (p.definition.canPark) allowed.add('PARK');
      if (p.definition.allowResubmit) allowed.add('SEND_BACK');
    }
    if (inFlight && (isApplicant || isApprover)) allowed.add('COMMENT');
    if (isApplicant && (p.status === 'IN_PROGRESS' || p.status === 'RESUBMIT_REQUIRED'))
      allowed.add('WITHDRAW');
    if (isApplicant && p.status === 'RESUBMIT_REQUIRED') allowed.add('RESUBMIT');
    if (
      p.status === 'APPROVED_PENDING_PROCESS' &&
      hasRole(ctx, 'PAYROLL_ADMIN') &&
      this.access.isAdminInScope(ctx, { companyId: p.subjectEmployee.companyId })
    ) {
      allowed.add('PROCESS');
    }

    const [attachments, instances, warnings] = await Promise.all([
      prisma.attachment.findMany({
        where: {
          deletedAt: null,
          OR: [
            { ownerEntity: p.subjectEntity, ownerEntityId: p.subjectEntityId },
            { ownerEntity: 'WorkflowProcess', ownerEntityId: String(p.id) },
            ...(description.attachmentOwners ?? []).map((o) => ({
              ownerEntity: o.entity,
              ownerEntityId: o.entityId,
            })),
          ],
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.workflowStepInstance.findMany({
        where: { processId: p.id, round: p.round },
        orderBy: [{ stepNo: 'asc' }, { id: 'asc' }],
      }),
      canApprove && handler.warnings
        ? handler.warnings(prisma, toSnapshot(p, type), ctx)
        : Promise.resolve([]),
    ]);
    const instancePeople = await this.people.byIds(
      prisma,
      instances.flatMap((i) => [i.assigneeUserId, i.delegatedFromUserId]),
    );
    const stepName = new Map(p.definition.steps.map((s) => [s.id, s.name]));
    const steps: StepInstance[] = instances.map((i) => ({
      id: i.id,
      stepNo: i.stepNo,
      round: i.round,
      name: stepName.get(i.stepId) ?? `Step ${i.stepNo}`,
      status: i.status,
      isMandatory: i.isMandatory,
      assignee: instancePeople.get(i.assigneeUserId) ?? unknownPerson(i.assigneeUserId),
      delegatedFrom: i.delegatedFromUserId
        ? (instancePeople.get(i.delegatedFromUserId) ?? unknownPerson(i.delegatedFromUserId))
        : null,
      dueAt: i.dueAt?.toISOString() ?? null,
      parkedUntil: i.parkedUntil?.toISOString() ?? null,
      actedAt: i.actedAt?.toISOString() ?? null,
    }));

    return {
      card,
      subjectEntity: p.subjectEntity,
      subjectEntityId: p.subjectEntityId,
      subject: toSubjectDetail(description),
      submittedBy: persons.get(p.submittedByUserId) ?? unknownPerson(p.submittedByUserId),
      submittedOnBehalf: p.submittedOnBehalf,
      attachments: attachments.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        uploadedAt: a.createdAt.toISOString(),
        downloadUrl: `${API_PREFIX}/attachments/${a.id}`,
      })),
      comments: events
        .filter((e) => e.comment)
        .map((e) => ({
          actionId: e.id,
          at: e.at,
          author: e.actor,
          action: e.action,
          stepNo: e.stepNo,
          comment: e.comment ?? '',
        })),
      allowedActions: [...allowed],
      warnings,
      steps,
    };
  }
}
