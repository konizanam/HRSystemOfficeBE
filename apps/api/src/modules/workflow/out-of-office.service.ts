import { Injectable } from '@nestjs/common';
import type { OutOfOffice, OutOfOfficeRule, Prisma } from '@prisma/client';
import {
  type BusinessDate,
  businessFromDate,
  dateFromBusiness,
  type Nominee,
  type NomineeOptionsResponse,
  type OutOfOfficeResponse,
  todayBusinessDate,
  type UpdateOutOfOfficeRequest,
  type WorkflowTypeCode,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import { type FieldError, ValidationError, VersionConflictError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { ScopeService } from '../auth/scope.service';
import type { AwayState } from './engine-rules';
import {
  isAvailable,
  PERSON_USER_SELECT,
  type PersonUserRow,
  toWorkflowPerson,
  WorkflowPeopleService,
} from './people.service';

/** Leave statuses that make a WHILE_ON_LEAVE user away: approved or processed (section 5.11). */
const AWAY_LEAVE_STATUSES = ['APPROVED_PENDING_PROCESS', 'PROCESSED'] as const;

const OOO_INCLUDE = {
  mainNominee: { select: PERSON_USER_SELECT },
  rules: {
    where: { deletedAt: null },
    include: { nominee: { select: PERSON_USER_SELECT }, workflowType: { select: { code: true } } },
    orderBy: { workflowTypeId: 'asc' },
  },
} satisfies Prisma.OutOfOfficeInclude;

type OutOfOfficeFull = Prisma.OutOfOfficeGetPayload<{ include: typeof OOO_INCLUDE }>;

function toNominee(user: PersonUserRow): Nominee {
  const p = toWorkflowPerson(user);
  return { userId: user.id, name: p.name, displayName: p.displayName, employeeCode: p.employeeCode };
}

function snapshot(ooo: OutOfOffice, rules: Pick<OutOfOfficeRule, 'workflowTypeId' | 'nomineeUserId'>[]) {
  return {
    mode: ooo.mode,
    fromDate: ooo.fromDate ? businessFromDate(ooo.fromDate) : null,
    toDate: ooo.toDate ? businessFromDate(ooo.toDate) : null,
    mainNomineeUserId: ooo.mainNomineeUserId,
    rules: rules.map((r) => ({ workflowTypeId: r.workflowTypeId, nomineeUserId: r.nomineeUserId })),
    version: ooo.version,
  };
}

/**
 * Out of office (section 5.11): the profile settings and the engine's "is this approver away and
 * who is their nominee" lookup. The settings belong to the signed-in user and are a restricted
 * feature while working as someone else.
 */
@Injectable()
export class OutOfOfficeService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly people: WorkflowPeopleService,
  ) {}

  async get(ctx: SecurityContext): Promise<OutOfOfficeResponse> {
    await this.scope.assertNotRestricted(ctx, 'OUT_OF_OFFICE');
    return this.view(ctx.userId);
  }

  async nominees(ctx: SecurityContext, search: string | undefined): Promise<NomineeOptionsResponse> {
    await this.scope.assertNotRestricted(ctx, 'OUT_OF_OFFICE');
    return this.people.userOptions(ctx, search);
  }

  async update(ctx: SecurityContext, input: UpdateOutOfOfficeRequest): Promise<OutOfOfficeResponse> {
    await this.scope.assertNotRestricted(ctx, 'OUT_OF_OFFICE');
    await this.db.tx(ctx, async (tx) => {
      const existing = await tx.outOfOffice.findUnique({
        where: { userId: ctx.userId },
        include: { rules: { where: { deletedAt: null } } },
      });
      if ((existing?.version ?? 0) !== input.version) {
        throw new VersionConflictError('Your out-of-office settings changed; reload', {
          version: existing?.version ?? 0,
        });
      }
      const types = await this.validate(tx, ctx, input);

      const data = {
        mode: input.mode,
        fromDate: input.mode === 'DATE_RANGE' && input.fromDate ? dateFromBusiness(input.fromDate) : null,
        toDate: input.mode === 'DATE_RANGE' && input.toDate ? dateFromBusiness(input.toDate) : null,
        mainNomineeUserId: input.mainNomineeUserId,
      };
      const saved = existing
        ? await tx.outOfOffice.update({
            where: { id: existing.id },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.outOfOffice.create({ data: { ...data, userId: ctx.userId } });

      const wanted = new Map(input.rules.map((r) => [types.get(r.workflowType) as number, r.nomineeUserId]));
      const current = new Map((existing?.rules ?? []).map((r) => [r.workflowTypeId, r]));
      for (const [workflowTypeId, rule] of current) {
        if (wanted.has(workflowTypeId)) continue;
        const removed = await tx.outOfOfficeRule.update({
          where: { id: rule.id },
          data: { deletedAt: new Date() },
        });
        this.audit.record(tx, ctx, {
          category: 'DATA_CHANGE',
          action: 'OUT_OF_OFFICE.RULE_REMOVED',
          entityType: 'OutOfOfficeRule',
          entityId: removed.id,
          before: rule,
          after: removed,
        });
      }
      for (const [workflowTypeId, nomineeUserId] of wanted) {
        const before = current.get(workflowTypeId) ?? null;
        if (before && before.nomineeUserId === nomineeUserId) continue;
        const rule = await tx.outOfOfficeRule.upsert({
          where: { outOfOfficeId_workflowTypeId: { outOfOfficeId: saved.id, workflowTypeId } },
          create: { outOfOfficeId: saved.id, workflowTypeId, nomineeUserId },
          update: { nomineeUserId, deletedAt: null },
        });
        this.audit.record(tx, ctx, {
          category: 'DATA_CHANGE',
          action: 'OUT_OF_OFFICE.RULE_SET',
          entityType: 'OutOfOfficeRule',
          entityId: rule.id,
          before,
          after: rule,
        });
      }

      const rulesAfter = [...wanted].map(([workflowTypeId, nomineeUserId]) => ({
        workflowTypeId,
        nomineeUserId,
      }));
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'OUT_OF_OFFICE.UPDATED',
        entityType: 'OutOfOffice',
        entityId: saved.id,
        subjectEmployeeId: ctx.selfEmployeeId,
        before: existing ? snapshot(existing, existing.rules) : null,
        after: snapshot(saved, rulesAfter),
      });
    });
    return this.view(ctx.userId);
  }

  /**
   * Whether the user is away today and, if so, their nominee for the workflow type: the rule for
   * the type when there is one, else the main nominee. A nominee who cannot be given work
   * (inactive, terminated) counts as no nominee.
   */
  async awayState(
    client: Tx,
    userId: string,
    workflowTypeId: number,
    today: BusinessDate = todayBusinessDate(),
  ): Promise<AwayState | null> {
    const ooo = await client.outOfOffice.findUnique({
      where: { userId },
      include: OOO_INCLUDE,
    });
    if (!ooo || !(await this.isAway(client, ooo, today))) return null;
    const rule = ooo.rules.find((r) => r.workflowTypeId === workflowTypeId && isAvailable(r.nominee));
    if (rule) return { nomineeUserId: rule.nomineeUserId };
    if (ooo.mainNominee && isAvailable(ooo.mainNominee)) return { nomineeUserId: ooo.mainNominee.id };
    return { nomineeUserId: null };
  }

  private async isAway(client: Tx, ooo: OutOfOffice, today: BusinessDate): Promise<boolean> {
    switch (ooo.mode) {
      case 'OFF':
        return false;
      case 'DATE_RANGE':
        return (
          ooo.fromDate !== null &&
          ooo.toDate !== null &&
          businessFromDate(ooo.fromDate) <= today &&
          today <= businessFromDate(ooo.toDate)
        );
      case 'WHILE_ON_LEAVE': {
        const user = await client.user.findUnique({
          where: { id: ooo.userId },
          select: { employeeId: true },
        });
        if (!user?.employeeId) return false;
        const day = dateFromBusiness(today);
        const onLeave = await client.leaveApplication.count({
          where: {
            employeeId: user.employeeId,
            status: { in: [...AWAY_LEAVE_STATUSES] },
            // A CANCELLEAVE application repeats the dates of the leave it cancels; it is not leave.
            cancelsApplicationId: null,
            fromDate: { lte: day },
            toDate: { gte: day },
          },
        });
        return onLeave > 0;
      }
    }
  }

  private async view(userId: string): Promise<OutOfOfficeResponse> {
    const ooo: OutOfOfficeFull | null = await this.db.prisma.outOfOffice.findUnique({
      where: { userId },
      include: OOO_INCLUDE,
    });
    if (!ooo) {
      return {
        mode: 'OFF',
        fromDate: null,
        toDate: null,
        mainNominee: null,
        rules: [],
        version: 0,
        isOutOfOfficeNow: false,
        updatedAt: null,
      };
    }
    return {
      mode: ooo.mode,
      fromDate: ooo.fromDate ? businessFromDate(ooo.fromDate) : null,
      toDate: ooo.toDate ? businessFromDate(ooo.toDate) : null,
      mainNominee: ooo.mainNominee ? toNominee(ooo.mainNominee) : null,
      rules: ooo.rules.map((r) => ({
        workflowType: r.workflowType.code as WorkflowTypeCode,
        nominee: toNominee(r.nominee),
      })),
      version: ooo.version,
      isOutOfOfficeNow: await this.isAway(this.db.prisma, ooo, todayBusinessDate()),
      updatedAt: ooo.updatedAt.toISOString(),
    };
  }

  /**
   * Nominees must be active people in the user's company, never the user themselves. Returns the
   * workflow type ids of the rules.
   */
  private async validate(
    tx: Tx,
    ctx: SecurityContext,
    input: UpdateOutOfOfficeRequest,
  ): Promise<Map<WorkflowTypeCode, number>> {
    const errors: FieldError[] = [];
    if (input.mode === 'WHILE_ON_LEAVE' && ctx.selfEmployeeId === null) {
      errors.push({ path: 'mode', message: 'You have no employee record, so there is no leave to follow' });
    }
    const self = ctx.selfEmployeeId
      ? await tx.employee.findUnique({ where: { id: ctx.selfEmployeeId }, select: { companyId: true } })
      : null;
    const nomineeIds = [input.mainNomineeUserId, ...input.rules.map((r) => r.nomineeUserId)].filter(
      (id): id is string => id !== null,
    );
    const users = await this.people.rows(tx, nomineeIds);
    const check = (path: string, id: string) => {
      const user = users.get(id);
      if (id === ctx.userId) errors.push({ path, message: 'You cannot nominate yourself' });
      else if (!user || !isAvailable(user)) errors.push({ path, message: 'Choose an active user' });
      else if (self && user.employee?.companyId !== self.companyId) {
        errors.push({ path, message: 'Choose someone in your company' });
      }
    };
    if (input.mainNomineeUserId) check('mainNomineeUserId', input.mainNomineeUserId);
    input.rules.forEach((rule, index) => check(`rules.${index}.nomineeUserId`, rule.nomineeUserId));

    const types = await tx.workflowType.findMany({
      where: { code: { in: input.rules.map((r) => r.workflowType) } },
      select: { id: true, code: true },
    });
    const byCode = new Map(types.map((t) => [t.code as WorkflowTypeCode, t.id]));
    input.rules.forEach((rule, index) => {
      if (!byCode.has(rule.workflowType)) {
        errors.push({ path: `rules.${index}.workflowType`, message: 'Unknown workflow type' });
      }
    });
    if (errors.length) throw new ValidationError(errors);
    return byCode;
  }
}
