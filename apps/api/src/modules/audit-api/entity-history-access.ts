import { Injectable } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { hasRole, type SecurityContext } from '../../common/context/security-context';
import { ForbiddenError, NotFoundError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { type AccessPurpose, ScopeService } from '../auth/scope.service';
import { WorkflowAccessService } from '../workflow/workflow-access.service';

/** Who owns an entity, for the record history check. */
export type EntityOwner =
  /** A record of one employee, possibly running on workflow processes. */
  | { kind: 'employee'; employeeId: number; processIds: number[]; purposes: AccessPurpose[] }
  /** A workflow process. */
  | { kind: 'process'; processId: number }
  /** Configuration: the roles that manage it, and its company when it has one. */
  | { kind: 'config'; roles: Role[]; companyId: number | null }
  /** A login: the user themself. */
  | { kind: 'user'; userId: string };

type OwnerResolver = (client: Tx, id: string) => Promise<EntityOwner | null>;

const READ_PURPOSES: AccessPurpose[] = ['SELF_SERVICE', 'TEAM', 'HR_READ'];
/** Personal and bank records: the employee and HR/Payroll, not the manager. */
const PRIVATE_PURPOSES: AccessPurpose[] = ['HR_READ'];

function intId(id: string): number | null {
  return /^\d{1,9}$/.test(id) ? Number(id) : null;
}

function owned(
  employeeId: number | null | undefined,
  processId: number | null | undefined,
  purposes: AccessPurpose[] = READ_PURPOSES,
): EntityOwner | null {
  if (employeeId === null || employeeId === undefined) return null;
  return { kind: 'employee', employeeId, processIds: processId ? [processId] : [], purposes };
}

const config = (roles: Role[], companyId: number | null = null): EntityOwner => ({
  kind: 'config',
  roles,
  companyId,
});

/**
 * Owner resolvers by entity type (the Prisma model name the audit rows use). Types that are not
 * listed are visible to auditors and system admins only.
 */
const RESOLVERS: Record<string, OwnerResolver> = {
  Employee: async (c, id) => {
    const n = intId(id);
    const e = n === null ? null : await c.employee.findUnique({ where: { id: n }, select: { id: true } });
    return owned(e?.id, null, PRIVATE_PURPOSES);
  },
  LeaveApplication: async (c, id) => {
    const n = intId(id);
    const r =
      n === null
        ? null
        : await c.leaveApplication.findUnique({
            where: { id: n },
            select: { employeeId: true, processId: true },
          });
    return owned(r?.employeeId, r?.processId);
  },
  CreditLeaveRequest: async (c, id) => {
    const n = intId(id);
    const r =
      n === null
        ? null
        : await c.creditLeaveRequest.findUnique({
            where: { id: n },
            select: { employeeId: true, processId: true },
          });
    return owned(r?.employeeId, r?.processId);
  },
  Claim: async (c, id) => {
    const n = intId(id);
    const r =
      n === null
        ? null
        : await c.claim.findUnique({ where: { id: n }, select: { employeeId: true, processId: true } });
    return owned(r?.employeeId, r?.processId);
  },
  ChangeRequest: async (c, id) => {
    const n = intId(id);
    const r =
      n === null
        ? null
        : await c.changeRequest.findUnique({
            where: { id: n },
            select: { employeeId: true, processId: true },
          });
    return owned(r?.employeeId, r?.processId);
  },
  EmployeeTransaction: async (c, id) => {
    const n = intId(id);
    const r =
      n === null
        ? null
        : await c.employeeTransaction.findUnique({
            where: { id: n },
            select: { employeeId: true, processId: true },
          });
    return owned(r?.employeeId, r?.processId);
  },
  FreeTextRequest: async (c, id) => {
    const n = intId(id);
    const r =
      n === null
        ? null
        : await c.freeTextRequest.findUnique({
            where: { id: n },
            select: { applicantId: true, processId: true },
          });
    return owned(r?.applicantId, r?.processId);
  },
  BankAccount: async (c, id) => {
    const n = intId(id);
    const r =
      n === null ? null : await c.bankAccount.findUnique({ where: { id: n }, select: { employeeId: true } });
    return owned(r?.employeeId, null, PRIVATE_PURPOSES);
  },
  DriversLicence: async (c, id) => {
    const n = intId(id);
    const r =
      n === null
        ? null
        : await c.driversLicence.findUnique({ where: { id: n }, select: { employeeId: true } });
    return owned(r?.employeeId, null, PRIVATE_PURPOSES);
  },
  FamilyMember: async (c, id) => {
    const n = intId(id);
    const r =
      n === null ? null : await c.familyMember.findUnique({ where: { id: n }, select: { employeeId: true } });
    return owned(r?.employeeId, null, PRIVATE_PURPOSES);
  },
  FundMembership: async (c, id) => {
    const n = intId(id);
    const r =
      n === null
        ? null
        : await c.fundMembership.findUnique({ where: { id: n }, select: { employeeId: true } });
    return owned(r?.employeeId, null, PRIVATE_PURPOSES);
  },
  EmployeeLeaveEntitlement: async (c, id) => {
    const n = intId(id);
    const r =
      n === null
        ? null
        : await c.employeeLeaveEntitlement.findUnique({ where: { id: n }, select: { employeeId: true } });
    return owned(r?.employeeId, null);
  },
  PerformanceContract: async (c, id) => {
    const n = intId(id);
    const r =
      n === null
        ? null
        : await c.performanceContract.findUnique({ where: { id: n }, select: { employeeId: true } });
    return owned(r?.employeeId, null);
  },
  Review: async (c, id) => {
    const n = intId(id);
    const r =
      n === null ? null : await c.review.findUnique({ where: { id: n }, select: { employeeId: true } });
    return owned(r?.employeeId, null);
  },
  Payslip: async (c, id) => {
    const n = intId(id);
    const r =
      n === null ? null : await c.payslip.findUnique({ where: { id: n }, select: { employeeId: true } });
    return owned(r?.employeeId, null, ['PAYROLL']);
  },
  TaxCertificate: async (c, id) => {
    const n = intId(id);
    const r =
      n === null
        ? null
        : await c.taxCertificate.findUnique({ where: { id: n }, select: { employeeId: true } });
    return owned(r?.employeeId, null, ['PAYROLL']);
  },
  WorkflowProcess: async (c, id) => {
    const n = intId(id);
    const r =
      n === null ? null : await c.workflowProcess.findUnique({ where: { id: n }, select: { id: true } });
    return r ? { kind: 'process', processId: r.id } : null;
  },
  User: async (c, id) => {
    const r = /^[0-9a-f-]{36}$/i.test(id)
      ? await c.user.findUnique({ where: { id }, select: { id: true } })
      : null;
    return r ? { kind: 'user', userId: r.id } : null;
  },
  Company: async (c, id) => {
    const n = intId(id);
    const r = n === null ? null : await c.company.findUnique({ where: { id: n }, select: { id: true } });
    return r ? config(['HR_ADMIN', 'PAYROLL_ADMIN'], r.id) : null;
  },
  CompanyRule: async (c, id) => {
    const n = intId(id);
    const r =
      n === null ? null : await c.companyRule.findUnique({ where: { id: n }, select: { companyId: true } });
    return r ? config(['HR_ADMIN', 'PAYROLL_ADMIN'], r.companyId) : null;
  },
  PayPeriod: async (c, id) => {
    const n = intId(id);
    const r =
      n === null
        ? null
        : await c.payPeriod.findUnique({
            where: { id: n },
            select: { companyRule: { select: { companyId: true } } },
          });
    return r ? config(['PAYROLL_ADMIN'], r.companyRule.companyId) : null;
  },
};

/** Configuration tables HR manages (global, so no company check). */
for (const model of [
  'LeaveType',
  'LeaveReason',
  'LeavePolicy',
  'WorkflowDefinition',
  'WorkflowStep',
  'FreeTextType',
  'PublicHoliday',
  'HolidayRule',
  'ParameterValue',
  'RetirementFund',
  'PerformanceTemplate',
  'RatingScale',
  'PayrollTransactionCode',
]) {
  RESOLVERS[model] = async () => config(['HR_ADMIN']);
}
/** Configuration HR and Payroll both manage. */
for (const model of ['ClaimGroup', 'ClaimType', 'ClaimCap', 'Bank', 'BankBranch']) {
  RESOLVERS[model] = async () => config(['HR_ADMIN', 'PAYROLL_ADMIN']);
}

/**
 * Who may open the record history of an entity (section 9.7: "users who are allowed to see that
 * entity"), through the owning module's scoping rules:
 *
 * - auditors and system admins: every entity;
 * - an employee's record: the purposes of its type (ScopeService: self or "Working as",
 *   manager, HR/Payroll in scope; personal and bank records exclude the manager; payslips and
 *   tax certificates are the employee and Payroll only), or any reader of one of its workflow
 *   processes (WorkflowAccessService: applicant, approvers, HR/Payroll in scope, auditors);
 * - a workflow process: its readers;
 * - configuration: the roles that manage it (HR admins; HR and Payroll for claims and banks;
 *   Payroll for pay periods), within their companies when it belongs to one;
 * - a user: that user.
 *
 * Unknown entity types and missing entities answer 404 for everyone but auditors (who get an empty
 * history); a refusal answers 403 and is audited DENIED.
 */
@Injectable()
export class EntityHistoryAccess {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
    private readonly access: WorkflowAccessService,
  ) {}

  /** The owner (or null when the entity is unknown or gone) for the history's process ids. */
  async owner(entityType: string, entityId: string): Promise<EntityOwner | null> {
    const resolver = RESOLVERS[entityType];
    return resolver ? resolver(this.db.prisma, entityId) : null;
  }

  async assertCanRead(
    ctx: SecurityContext,
    entityType: string,
    entityId: string,
  ): Promise<EntityOwner | null> {
    const owner = await this.owner(entityType, entityId);
    if (hasRole(ctx, 'AUDITOR', 'SYSTEM_ADMIN')) return owner;
    if (!owner) throw new NotFoundError(entityType in RESOLVERS ? entityType : 'Entity');
    if (await this.allows(ctx, owner)) return owner;
    throw new ForbiddenError('You do not have access to the history of this record', {
      subjectEmployeeId: owner.kind === 'employee' ? owner.employeeId : null,
      metadata: { entityType, entityId },
    });
  }

  private async allows(ctx: SecurityContext, owner: EntityOwner): Promise<boolean> {
    switch (owner.kind) {
      case 'user':
        return owner.userId === ctx.userId;
      case 'config':
        return (
          hasRole(ctx, ...owner.roles) &&
          (owner.companyId === null || ctx.companyIds.includes(owner.companyId))
        );
      case 'process':
        return this.canReadProcess(ctx, owner.processId);
      case 'employee': {
        // The signed-in employee always sees their own records; "Working as" someone else
        // reaches only what the type's purposes allow (SELF_SERVICE for ordinary records).
        if (ctx.selfEmployeeId === owner.employeeId) return true;
        if (await this.scope.canAccessAny(ctx, owner.employeeId, owner.purposes)) return true;
        for (const processId of owner.processIds) {
          if (await this.canReadProcess(ctx, processId)) return true;
        }
        return false;
      }
    }
  }

  private async canReadProcess(ctx: SecurityContext, processId: number): Promise<boolean> {
    const p = await this.db.prisma.workflowProcess.findUnique({
      where: { id: processId },
      select: {
        id: true,
        subjectEmployeeId: true,
        submittedByUserId: true,
        subjectEmployee: { select: { companyId: true } },
      },
    });
    return (
      !!p &&
      this.access.canRead(this.db.prisma, ctx, {
        id: p.id,
        subjectEmployeeId: p.subjectEmployeeId,
        submittedByUserId: p.submittedByUserId,
        companyId: p.subjectEmployee.companyId,
      })
    );
  }
}
