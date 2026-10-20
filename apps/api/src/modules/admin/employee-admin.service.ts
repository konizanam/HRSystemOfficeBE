import { Injectable, Logger } from '@nestjs/common';
import type { Employee, Prisma } from '@prisma/client';
import {
  ADMIN_EMPLOYEE_SORTS,
  type AdminEmployee,
  type AdminEmployeeListItem,
  type AdminEmployeesQuery,
  type AdminEmployeesResponse,
  businessFromDate,
  type CreateEmployeeRequest,
  dateFromBusiness,
  dec,
  type SetEmployeePhotoRequest,
  type TerminateEmployeeRequest,
  type TerminateEmployeeResponse,
  type UpdateEmployeeRequest,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import { assertVersion, ConflictError, ValidationError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { AttachmentService } from '../attachments/attachment.service';
import { attachmentUrl } from '../auth/employee-summary';
import { ScopeService } from '../auth/scope.service';
import { SessionService } from '../auth/session.service';
import { SettingsService } from '../settings/settings.service';
import { WorkflowEngine } from '../workflow/workflow-engine.service';
import { assertCompanyScope } from './admin-scope';

/** Owner entity of an employee photo (its download follows the employee's read rules). */
export const EMPLOYEE_PHOTO_ENTITY = 'EmployeePhoto';

const PHOTO_MIME_TYPES = new Set(['image/png', 'image/jpeg']);

export const ADMIN_EMPLOYEE_INCLUDE = {
  company: { select: { name: true } },
  companyRule: { select: { description: true } },
  reportsTo: { select: { firstName: true, lastName: true } },
  user: { select: { id: true, username: true, isActive: true, roles: true } },
} satisfies Prisma.EmployeeInclude;

export type AdminEmployeeRow = Prisma.EmployeeGetPayload<{ include: typeof ADMIN_EMPLOYEE_INCLUDE }>;

function day(value: Date | null): string | null {
  return value ? businessFromDate(value) : null;
}

export function toAdminEmployeeListItem(e: AdminEmployeeRow): AdminEmployeeListItem {
  return {
    id: e.id,
    employeeCode: e.employeeCode,
    entityCode: e.entityCode,
    title: e.title,
    firstName: e.firstName,
    lastName: e.lastName,
    knownAs: e.knownAs,
    companyId: e.companyId,
    companyName: e.company.name,
    companyRuleId: e.companyRuleId,
    companyRule: e.companyRule.description,
    jobTitle: e.jobTitle,
    department: e.department,
    reportsToId: e.reportsToId,
    reportsToName: e.reportsTo ? `${e.reportsTo.firstName} ${e.reportsTo.lastName}` : null,
    status: e.status,
    dateEngaged: day(e.dateEngaged),
    terminationDate: day(e.terminationDate),
    user: e.user
      ? { id: e.user.id, username: e.user.username, isActive: e.user.isActive, roles: e.user.roles }
      : null,
    version: e.version,
  };
}

export function toAdminEmployee(e: AdminEmployeeRow): AdminEmployee {
  return {
    ...toAdminEmployeeListItem(e),
    initials: e.initials,
    jobGrade: e.jobGrade,
    hourlyRate: e.hourlyRate === null ? null : dec(e.hourlyRate).toFixed(4),
    photoUrl: attachmentUrl(e.photoAttachmentId),
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

/** The employee row without relations, for audit snapshots. */
export function employeeSnapshot(e: Employee | AdminEmployeeRow): Employee {
  const { company: _c, companyRule: _r, reportsTo: _t, user: _u, ...rest } = e as AdminEmployeeRow;
  return rest;
}

/** Prisma data for the HR fields that were sent (plain values, valid for create and update). */
export interface EmployeeHrData {
  companyId?: number;
  companyRuleId?: number;
  reportsToId?: number | null;
  jobTitle?: string | null;
  jobGrade?: string | null;
  department?: string | null;
  hourlyRate?: string | null;
  dateEngaged?: Date | null;
  terminationDate?: Date | null;
}

/** The HR fields an admin edit or the employee import may set (section 12.10). */
export interface EmployeeHrInput {
  companyId?: number;
  companyRuleId?: number;
  reportsToId?: number | null;
  jobTitle?: string | null;
  jobGrade?: string | null;
  department?: string | null;
  hourlyRate?: string | null;
  dateEngaged?: string | null;
  terminationDate?: string | null;
}

/**
 * HR's employee administration (section 12.10): the list and detail, create, the HR fields
 * (company, company rule, reports-to, job, grade, department, hourly rate, dates, status),
 * termination (section 7.5) and the photo. HR_ADMIN writes and HR/Payroll read within their
 * companies (ScopeService `HR_WRITE` / `HR_READ`); personal details keep their change-request
 * endpoints. Every write is audited with before/after.
 */
@Injectable()
export class EmployeeAdminService {
  private readonly logger = new Logger(EmployeeAdminService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly sessions: SessionService,
    private readonly settings: SettingsService,
    private readonly engine: WorkflowEngine,
    private readonly attachments: AttachmentService,
  ) {}

  async list(ctx: SecurityContext, query: AdminEmployeesQuery): Promise<AdminEmployeesResponse> {
    if (query.companyId) assertCompanyScope(ctx, query.companyId);
    const where: Prisma.EmployeeWhereInput = {
      deletedAt: null,
      companyId: query.companyId ?? { in: ctx.companyIds },
      ...(query.companyRuleId ? { companyRuleId: query.companyRuleId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.department ? { department: { contains: query.department, mode: 'insensitive' } } : {}),
      ...(query.reportsToId ? { reportsToId: query.reportsToId } : {}),
      ...(query.withoutUser ? { user: null } : {}),
      ...(query.search
        ? {
            OR: [
              { employeeCode: { contains: query.search, mode: 'insensitive' } },
              { entityCode: { contains: query.search, mode: 'insensitive' } },
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
              { knownAs: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [field, direction] = (query.sort ?? 'lastName:asc').split(':') as [string, 'asc' | 'desc'];
    if (!(ADMIN_EMPLOYEE_SORTS as readonly string[]).includes(field)) {
      throw ValidationError.field('sort', `Sort by one of ${ADMIN_EMPLOYEE_SORTS.join(', ')}`);
    }
    const orderBy: Prisma.EmployeeOrderByWithRelationInput[] =
      field === 'lastName'
        ? [{ lastName: direction }, { firstName: direction }, { id: 'asc' }]
        : [{ [field]: direction }, { id: 'asc' }];
    const [total, rows] = await Promise.all([
      this.db.prisma.employee.count({ where }),
      this.db.prisma.employee.findMany({
        where,
        include: ADMIN_EMPLOYEE_INCLUDE,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { items: rows.map(toAdminEmployeeListItem), total, page: query.page, pageSize: query.pageSize };
  }

  async get(ctx: SecurityContext, id: number): Promise<AdminEmployee> {
    await this.scope.assertCanAccessEmployee(ctx, id, 'HR_READ');
    const row = await this.db.prisma.employee.findUniqueOrThrow({
      where: { id },
      include: ADMIN_EMPLOYEE_INCLUDE,
    });
    return toAdminEmployee(row);
  }

  async create(ctx: SecurityContext, input: CreateEmployeeRequest): Promise<AdminEmployee> {
    return this.db.tx(ctx, async (tx) => {
      const row = await this.createInTx(tx, ctx, input, { action: 'EMPLOYEE.CREATED' });
      return toAdminEmployee(row);
    });
  }

  /** Shared by POST /admin/employees and the employee import. */
  async createInTx(
    tx: Tx,
    ctx: SecurityContext,
    input: CreateEmployeeRequest,
    audit: { action: string; metadata?: Record<string, unknown> },
  ): Promise<AdminEmployeeRow> {
    await this.checkUnique(tx, input.employeeCode, input.entityCode);
    const fields = await this.validateHr(tx, ctx, null, {
      companyId: input.companyId,
      companyRuleId: input.companyRuleId,
      reportsToId: input.reportsToId,
      jobTitle: input.jobTitle,
      jobGrade: input.jobGrade,
      department: input.department,
      hourlyRate: input.hourlyRate,
      dateEngaged: input.dateEngaged,
    });
    const row = await tx.employee.create({
      data: {
        employeeCode: input.employeeCode,
        entityCode: input.entityCode,
        title: input.title ?? null,
        initials: input.initials ?? null,
        firstName: input.firstName,
        lastName: input.lastName,
        knownAs: input.knownAs ?? null,
        companyId: input.companyId,
        companyRuleId: input.companyRuleId,
        ...fields,
        status: 'ACTIVE',
      },
      include: ADMIN_EMPLOYEE_INCLUDE,
    });
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: audit.action,
      entityType: 'Employee',
      entityId: row.id,
      subjectEmployeeId: row.id,
      after: employeeSnapshot(row),
      metadata: audit.metadata,
    });
    return row;
  }

  async update(ctx: SecurityContext, id: number, input: UpdateEmployeeRequest): Promise<AdminEmployee> {
    const result = await this.db.tx(ctx, async (tx) => {
      const before = await this.lockForWrite(tx, ctx, id);
      assertVersion(before, input.version);
      const { status, version: _v, ...hr } = input;
      const after = await this.updateInTx(tx, ctx, before, hr, status, { action: 'EMPLOYEE.UPDATED' });
      return { before, after };
    });
    if (result.after.status === 'SUSPENDED' && result.before.status !== 'SUSPENDED' && result.after.user) {
      // A suspended approver is unavailable (section 7.5): move their open steps now.
      await this.reresolve(result.after.user.id);
    }
    return toAdminEmployee(result.after);
  }

  /** Shared by PUT /admin/employees/:id and the employee import (the row is locked). */
  async updateInTx(
    tx: Tx,
    ctx: SecurityContext,
    before: AdminEmployeeRow,
    hr: EmployeeHrInput,
    status: 'ACTIVE' | 'SUSPENDED' | undefined,
    audit: { action: string; metadata?: Record<string, unknown> },
  ): Promise<AdminEmployeeRow> {
    const fields = await this.validateHr(tx, ctx, before, hr);
    const data: Prisma.EmployeeUncheckedUpdateInput = { ...fields };
    if (status !== undefined && status !== before.status) {
      data.status = status;
      // Reinstating a terminated employee clears the termination date.
      if (before.status === 'TERMINATED' && status === 'ACTIVE' && hr.terminationDate === undefined) {
        data.terminationDate = null;
      }
    }
    const after = await tx.employee.update({
      where: { id: before.id },
      data: { ...data, version: { increment: 1 } },
      include: ADMIN_EMPLOYEE_INCLUDE,
    });
    const statusChanged = after.status !== before.status;
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: statusChanged ? `EMPLOYEE.STATUS_${after.status}` : audit.action,
      entityType: 'Employee',
      entityId: before.id,
      subjectEmployeeId: before.id,
      before: employeeSnapshot(before),
      after: employeeSnapshot(after),
      metadata: { ...audit.metadata, ...(statusChanged ? { from: before.status, to: after.status } : {}) },
    });
    return after;
  }

  /**
   * POST /admin/employees/:id/terminate: status TERMINATED and the termination date, the user's
   * sessions ended, the user deactivated (when configured), then every open approval step of the
   * user re-resolved to a new approver (section 7.5, audited REASSIGN with actor SYSTEM).
   */
  async terminate(
    ctx: SecurityContext,
    id: number,
    input: TerminateEmployeeRequest,
  ): Promise<TerminateEmployeeResponse> {
    const deactivateDefault = await this.settings.get('employees.deactivateUserOnTermination');
    const done = await this.db.tx(ctx, async (tx) => {
      const before = await this.lockForWrite(tx, ctx, id);
      assertVersion(before, input.version);
      if (before.status === 'TERMINATED') {
        throw ValidationError.field('', 'This employee is already terminated');
      }
      if (before.dateEngaged && input.terminationDate < businessFromDate(before.dateEngaged)) {
        throw ValidationError.field('terminationDate', 'The termination date is before the engagement date');
      }
      const after = await tx.employee.update({
        where: { id },
        data: {
          status: 'TERMINATED',
          terminationDate: dateFromBusiness(input.terminationDate),
          version: { increment: 1 },
        },
        include: ADMIN_EMPLOYEE_INCLUDE,
      });
      let sessionsRevoked = 0;
      let userDeactivated = false;
      const user = before.user ? await tx.user.findUniqueOrThrow({ where: { id: before.user.id } }) : null;
      if (user) {
        sessionsRevoked = await this.sessions.revokeAllForUser(tx, user.id);
        if ((input.deactivateUser ?? deactivateDefault) && user.isActive) {
          const deactivated = await tx.user.update({
            where: { id: user.id },
            data: { isActive: false, version: { increment: 1 } },
          });
          userDeactivated = true;
          this.audit.record(tx, ctx, {
            category: 'SECURITY',
            action: 'SECURITY.USER_DEACTIVATED',
            entityType: 'User',
            entityId: user.id,
            subjectEmployeeId: id,
            before: user,
            after: deactivated,
            reason: 'Employee terminated',
          });
        }
      }
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'EMPLOYEE.TERMINATED',
        entityType: 'Employee',
        entityId: id,
        subjectEmployeeId: id,
        before: employeeSnapshot(before),
        after: employeeSnapshot(after),
        reason: input.reason,
        metadata: {
          terminationDate: input.terminationDate,
          userId: user?.id ?? null,
          sessionsRevoked,
          userDeactivated,
        },
      });
      return { after, sessionsRevoked, userDeactivated, userId: user?.id ?? null };
    });
    const moved = done.userId ? await this.reresolve(done.userId) : { reassigned: 0, unresolved: 0 };
    const fresh = await this.db.prisma.employee.findUniqueOrThrow({
      where: { id },
      include: ADMIN_EMPLOYEE_INCLUDE,
    });
    return {
      employee: toAdminEmployee(fresh),
      sessionsRevoked: done.sessionsRevoked,
      userDeactivated: done.userDeactivated,
      stepsReassigned: moved.reassigned,
      stepsUnresolved: moved.unresolved,
    };
  }

  /** PUT /admin/employees/:id/photo: binds an uploaded png/jpeg as the photo (or removes it). */
  async setPhoto(ctx: SecurityContext, id: number, input: SetEmployeePhotoRequest): Promise<AdminEmployee> {
    return this.db.tx(ctx, async (tx) => {
      const before = await this.lockForWrite(tx, ctx, id);
      assertVersion(before, input.version);
      if (input.attachmentId) {
        const upload = await tx.attachment.findUnique({ where: { id: input.attachmentId } });
        if (upload && !PHOTO_MIME_TYPES.has(upload.mimeType)) {
          throw ValidationError.field('attachmentId', 'A photo must be a PNG or JPEG image');
        }
        await this.attachments.bind(
          tx,
          ctx,
          [input.attachmentId],
          { entity: EMPLOYEE_PHOTO_ENTITY, entityId: id, subjectEmployeeId: id },
          'attachmentId',
        );
      }
      if (before.photoAttachmentId && before.photoAttachmentId !== input.attachmentId) {
        const old = await tx.attachment.findUnique({ where: { id: before.photoAttachmentId } });
        if (old && old.deletedAt === null && old.ownerEntity === EMPLOYEE_PHOTO_ENTITY) {
          await this.attachments.detach(
            tx,
            ctx,
            [old.id],
            [{ entity: EMPLOYEE_PHOTO_ENTITY, entityId: id }],
            id,
          );
        }
      }
      const after = await tx.employee.update({
        where: { id },
        data: { photoAttachmentId: input.attachmentId, version: { increment: 1 } },
        include: ADMIN_EMPLOYEE_INCLUDE,
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: input.attachmentId ? 'EMPLOYEE.PHOTO_CHANGED' : 'EMPLOYEE.PHOTO_REMOVED',
        entityType: 'Employee',
        entityId: id,
        subjectEmployeeId: id,
        before: employeeSnapshot(before),
        after: employeeSnapshot(after),
      });
      return toAdminEmployee(after);
    });
  }

  // ───────────── Building blocks ─────────────

  /** Locks the employee row and checks HR write scope (404 / 403 audited). */
  async lockForWrite(tx: Tx, ctx: SecurityContext, id: number): Promise<AdminEmployeeRow> {
    await this.scope.assertCanAccessEmployee(ctx, id, 'HR_WRITE', tx);
    await this.db.lockRow(tx, 'Employee', id);
    return tx.employee.findUniqueOrThrow({ where: { id }, include: ADMIN_EMPLOYEE_INCLUDE });
  }

  async checkUnique(client: Tx, employeeCode: string, entityCode: string): Promise<void> {
    const clash = await client.employee.findFirst({
      where: { OR: [{ employeeCode }, { entityCode }] },
      select: { employeeCode: true, entityCode: true },
    });
    if (clash?.employeeCode === employeeCode) {
      throw new ConflictError(`The employee code ${employeeCode} is already in use`);
    }
    if (clash) throw new ConflictError(`The entity code ${entityCode} is already in use`);
  }

  /**
   * Validates the HR fields against the current row (null for a new employee) and returns the
   * Prisma data for the fields that were sent. Company and company rule must be active and in
   * the caller's scope; reports-to must be an employee of the same company without a cycle.
   */
  async validateHr(
    tx: Tx,
    ctx: SecurityContext,
    current: Employee | null,
    hr: EmployeeHrInput,
  ): Promise<EmployeeHrData> {
    const data: EmployeeHrData = {};
    const companyId = hr.companyId ?? current?.companyId;
    const companyRuleId = hr.companyRuleId ?? current?.companyRuleId;
    if (companyId === undefined || companyRuleId === undefined) {
      throw ValidationError.field('companyId', 'Choose the company and company rule');
    }
    if (hr.companyId !== undefined && hr.companyId !== current?.companyId) {
      const company = await tx.company.findUnique({ where: { id: hr.companyId } });
      if (!company) throw ValidationError.field('companyId', 'Unknown company');
      assertCompanyScope(ctx, company.id, current?.id);
      if (!company.isActive) throw ValidationError.field('companyId', 'This company is deactivated');
      data.companyId = hr.companyId;
    }
    if (hr.companyRuleId !== undefined || hr.companyId !== undefined) {
      const rule = await tx.companyRule.findUnique({ where: { id: companyRuleId } });
      if (!rule || rule.companyId !== companyId) {
        throw ValidationError.field('companyRuleId', 'Choose a company rule of the employee’s company');
      }
      if (!rule.isActive && rule.id !== current?.companyRuleId) {
        throw ValidationError.field('companyRuleId', 'This company rule is deactivated');
      }
      if (hr.companyRuleId !== undefined) data.companyRuleId = hr.companyRuleId;
    }
    const reportsToId = hr.reportsToId !== undefined ? hr.reportsToId : (current?.reportsToId ?? null);
    if (hr.reportsToId !== undefined || hr.companyId !== undefined) {
      if (reportsToId !== null) await this.checkReportsTo(tx, current?.id ?? null, reportsToId, companyId);
      if (hr.reportsToId !== undefined) data.reportsToId = hr.reportsToId;
    }
    for (const key of ['jobTitle', 'jobGrade', 'department'] as const) {
      if (hr[key] !== undefined) data[key] = hr[key] || null;
    }
    if (hr.hourlyRate !== undefined)
      data.hourlyRate = hr.hourlyRate === null ? null : dec(hr.hourlyRate).toFixed(4);
    const engaged = hr.dateEngaged !== undefined ? hr.dateEngaged : day(current?.dateEngaged ?? null);
    const terminated =
      hr.terminationDate !== undefined ? hr.terminationDate : day(current?.terminationDate ?? null);
    if (engaged && terminated && terminated < engaged) {
      throw ValidationError.field('terminationDate', 'The termination date is before the engagement date');
    }
    if (hr.dateEngaged !== undefined)
      data.dateEngaged = hr.dateEngaged ? dateFromBusiness(hr.dateEngaged) : null;
    if (hr.terminationDate !== undefined) {
      data.terminationDate = hr.terminationDate ? dateFromBusiness(hr.terminationDate) : null;
    }
    return data;
  }

  private async checkReportsTo(
    tx: Tx,
    employeeId: number | null,
    reportsToId: number,
    companyId: number,
  ): Promise<void> {
    if (reportsToId === employeeId)
      throw ValidationError.field('reportsToId', 'An employee cannot report to themselves');
    const manager = await tx.employee.findFirst({
      where: { id: reportsToId, deletedAt: null },
      select: { id: true, companyId: true, status: true },
    });
    if (!manager) throw ValidationError.field('reportsToId', 'Unknown manager');
    if (manager.companyId !== companyId) {
      throw ValidationError.field('reportsToId', 'The manager must work for the same company');
    }
    if (manager.status === 'TERMINATED') {
      throw ValidationError.field('reportsToId', 'The manager is terminated');
    }
    if (employeeId === null) return;
    // Walk up from the new manager: reaching the employee would close a reporting cycle.
    let current: number | null = reportsToId;
    for (let hops = 0; current !== null && hops < 100; hops++) {
      if (current === employeeId) {
        throw ValidationError.field('reportsToId', 'This would make a reporting cycle');
      }
      const row: { reportsToId: number | null } | null = await tx.employee.findUnique({
        where: { id: current },
        select: { reportsToId: true },
      });
      current = row?.reportsToId ?? null;
    }
  }

  /** Re-resolves the open steps of a user who can no longer approve (outside any transaction). */
  async reresolve(userId: string): Promise<{ reassigned: number; unresolved: number }> {
    try {
      return await this.engine.reresolveForUser(userId);
    } catch (err) {
      // The change is committed; the nightly workflow.reresolve job retries anything left.
      this.logger.error({ err, userId }, 'Re-resolving approval steps failed');
      return { reassigned: 0, unresolved: 0 };
    }
  }
}
