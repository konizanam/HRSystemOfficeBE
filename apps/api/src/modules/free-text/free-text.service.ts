import { Injectable } from '@nestjs/common';
import type { Prisma, ProcessStatus } from '@prisma/client';
import {
  type AdminFreeTextType,
  type AdminFreeTextTypesResponse,
  type CreateFreeTextTypeRequest,
  FREE_TEXT_ABOUT_OPTIONS_LIMIT,
  type FreeTextAboutOptionsQuery,
  type FreeTextAboutOptionsResponse,
  type FreeTextListQuery,
  type FreeTextListResponse,
  type FreeTextRequestDto,
  FreeTextResubmitChangesSchema,
  type FreeTextTypesResponse,
  formatFreeTextReference,
  freeTextWorkflowType,
  PROCESS_STATUS_LABELS,
  sequenceKeys,
  type SubmitFreeTextRequest,
  type UpdateFreeTextTypeRequest,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import { hasRole, type SecurityContext } from '../../common/context/security-context';
import {
  assertVersion,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { AttachmentService } from '../attachments/attachment.service';
import { ScopeService } from '../auth/scope.service';
import { WorkflowAccessService } from '../workflow/workflow-access.service';
import { WorkflowEngine } from '../workflow/workflow-engine.service';
import type {
  FinalApprovalResult,
  SubjectDescription,
  WorkflowCancelHookContext,
  WorkflowCommentHookContext,
  WorkflowHookContext,
  WorkflowProcessSnapshot,
  WorkflowResubmitHookContext,
} from '../workflow/workflow-subject';

/** Subject entity (and attachment owner) of a free text request. */
export const FREE_TEXT_ENTITY = 'FreeTextRequest';

/** Discriminator of the FREETEXT / FREETEXTMANEMP definition for one free text type. */
export function freeTextDiscriminator(code: string): string {
  return `FT:${code}`;
}

const PERSON_SELECT = { id: true, employeeCode: true, firstName: true, lastName: true } as const;

const REQUEST_INCLUDE = {
  type: true,
  applicant: { select: { ...PERSON_SELECT, companyId: true } },
  aboutEmployee: { select: PERSON_SELECT },
} satisfies Prisma.FreeTextRequestInclude;

type RequestRow = Prisma.FreeTextRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

function person(p: { id: number; employeeCode: string; firstName: string; lastName: string }) {
  return { id: p.id, employeeCode: p.employeeCode, name: `${p.firstName} ${p.lastName}` };
}

/** The request row without relations, for audit snapshots. */
function plain(r: RequestRow) {
  const { type: _t, applicant: _a, aboutEmployee: _b, ...rest } = r;
  return rest;
}

/**
 * The Free Text Workflow (section 5.8): "The application is for {employee}" (self or someone the
 * caller may act for), "who is applying for {FreeTextType}", a required body and attachments.
 * A type with `requiresSubjectEmployee` runs on FREETEXTMANEMP with a mandatory "About employee"
 * (an employee of the applicant's company); the others on FREETEXT. The reference is
 * `F{entityCode}-N{seq:5}` from the applicant's free text sequence (shared with employee
 * transaction inputs, which also use FREETEXTMANEMP). Approval completes the request (these
 * types need no payroll processing). This service also holds the subject hooks: the FREETEXT
 * handler delegates here, and so does the FreeTextRequest branch of the FREETEXTMANEMP handler.
 */
@Injectable()
export class FreeTextService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly engine: WorkflowEngine,
    private readonly access: WorkflowAccessService,
    private readonly attachments: AttachmentService,
  ) {}

  // ───────────── Employee API ─────────────

  /** GET /free-text/types: active types, with whether the acting-as employee can start each. */
  async types(ctx: SecurityContext, employeeId?: number): Promise<FreeTextTypesResponse> {
    const subjectId = employeeId ?? ctx.actingAsEmployeeId;
    if (!(await this.scope.canActFor(ctx, subjectId))) {
      throw new ForbiddenError('You cannot submit requests for this employee', {
        subjectEmployeeId: subjectId,
      });
    }
    const rows = await this.db.prisma.freeTextType.findMany({
      where: { isActive: true },
      orderBy: { description: 'asc' },
    });
    const items = await Promise.all(
      rows.map(async (t) => ({
        id: t.id,
        code: t.code,
        description: t.description,
        requiresSubjectEmployee: t.requiresSubjectEmployee,
        workflowType: freeTextWorkflowType(t),
        canStart: await this.engine.canStartFor(
          subjectId,
          freeTextWorkflowType(t),
          freeTextDiscriminator(t.code),
        ),
      })),
    );
    return { employeeId: subjectId, items };
  }

  /** The "About employee" picker: employees of the applicant's company (not terminated). */
  async aboutOptions(
    ctx: SecurityContext,
    query: FreeTextAboutOptionsQuery,
  ): Promise<FreeTextAboutOptionsResponse> {
    const applicantId = query.employeeId ?? ctx.actingAsEmployeeId;
    if (!(await this.scope.canActFor(ctx, applicantId))) {
      throw new ForbiddenError('You cannot submit requests for this employee', {
        subjectEmployeeId: applicantId,
      });
    }
    const applicant = await this.db.prisma.employee.findFirst({
      where: { id: applicantId, deletedAt: null },
      select: { companyId: true },
    });
    if (!applicant) throw new NotFoundError('Employee');
    const rows = await this.db.prisma.employee.findMany({
      where: {
        companyId: applicant.companyId,
        deletedAt: null,
        status: { not: 'TERMINATED' },
        ...(query.search
          ? {
              OR: [
                { employeeCode: { contains: query.search, mode: 'insensitive' } },
                { firstName: { contains: query.search, mode: 'insensitive' } },
                { lastName: { contains: query.search, mode: 'insensitive' } },
                { knownAs: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: { ...PERSON_SELECT, status: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
      take: FREE_TEXT_ABOUT_OPTIONS_LIMIT,
    });
    return { items: rows.map((e) => ({ ...person(e), status: e.status })) };
  }

  /** POST /free-text: creates the request and starts FREETEXT or FREETEXTMANEMP. */
  async submit(ctx: SecurityContext, input: SubmitFreeTextRequest): Promise<FreeTextRequestDto> {
    return this.db.tx(ctx, async (tx) => {
      const applicantId = input.employeeId ?? ctx.actingAsEmployeeId;
      if (!(await this.scope.canActFor(ctx, applicantId, tx))) {
        throw new ForbiddenError('You cannot submit requests for this employee', {
          subjectEmployeeId: applicantId,
          metadata: { workflowType: 'FREETEXT' },
        });
      }
      await this.db.lockRow(tx, 'Employee', applicantId);
      const applicant = await tx.employee.findFirst({
        where: { id: applicantId, deletedAt: null },
        select: { id: true, entityCode: true, companyId: true, status: true },
      });
      if (!applicant) throw new NotFoundError('Employee');
      if (applicant.status !== 'ACTIVE') {
        throw ValidationError.field('employeeId', 'Requests can only be submitted for active employees');
      }
      const type = await tx.freeTextType.findUnique({ where: { id: input.typeId } });
      if (!type?.isActive) throw ValidationError.field('typeId', 'This request type is not available');
      const workflowType = freeTextWorkflowType(type);
      let aboutEmployeeId: number | null = null;
      if (type.requiresSubjectEmployee) {
        if (!input.aboutEmployeeId) {
          throw ValidationError.field('aboutEmployeeId', 'Choose the employee this request is about');
        }
        const about = await tx.employee.findFirst({
          where: { id: input.aboutEmployeeId, deletedAt: null },
          select: { id: true, companyId: true, status: true },
        });
        if (!about || about.companyId !== applicant.companyId || about.status === 'TERMINATED') {
          throw ValidationError.field('aboutEmployeeId', 'Choose an employee of your company');
        }
        aboutEmployeeId = about.id;
      } else if (input.aboutEmployeeId) {
        throw ValidationError.field('aboutEmployeeId', 'This request type is not about another employee');
      }

      const seq = await this.db.nextSequence(tx, sequenceKeys.freeText(applicant.id));
      const referenceNumber = formatFreeTextReference(applicant.entityCode, seq);
      const created = await tx.freeTextRequest.create({
        data: {
          referenceNumber,
          typeId: type.id,
          applicantId: applicant.id,
          aboutEmployeeId,
          body: input.body,
          status: 'IN_PROGRESS',
          submittedByUserId: ctx.userId,
          submittedAt: new Date(),
        },
        include: REQUEST_INCLUDE,
      });
      this.audit.record(tx, ctx, {
        category: 'WORKFLOW',
        action: 'FREE_TEXT.SUBMITTED',
        entityType: FREE_TEXT_ENTITY,
        entityId: created.id,
        subjectEmployeeId: applicant.id,
        after: plain(created),
        metadata: { referenceNumber, type: type.code, workflowType, aboutEmployeeId },
      });
      if (input.attachmentIds.length) {
        await this.attachments.bind(tx, ctx, input.attachmentIds, {
          entity: FREE_TEXT_ENTITY,
          entityId: created.id,
          subjectEmployeeId: applicant.id,
        });
      }
      const process = await this.engine.start(ctx, {
        type: workflowType,
        subjectEntity: FREE_TEXT_ENTITY,
        subjectEntityId: created.id,
        subjectEmployeeId: applicant.id,
        summary: `${type.description} (${referenceNumber})`,
        discriminator: freeTextDiscriminator(type.code),
      });
      const linked = await tx.freeTextRequest.update({
        where: { id: created.id },
        data: { processId: process.id },
        include: REQUEST_INCLUDE,
      });
      return this.dto(tx, linked);
    });
  }

  /** GET /free-text: the acting-as employee's requests, or (HR, auditors) their companies'. */
  async list(ctx: SecurityContext, query: FreeTextListQuery): Promise<FreeTextListResponse> {
    let scopeWhere: Prisma.FreeTextRequestWhereInput;
    if (query.scope === 'company') {
      if (hasRole(ctx, 'AUDITOR')) scopeWhere = {};
      else if (hasRole(ctx, 'HR_ADMIN')) scopeWhere = { applicant: { companyId: { in: ctx.companyIds } } };
      else {
        throw new ForbiddenError('Only HR administrators and auditors can list every request', {
          metadata: { scope: query.scope },
        });
      }
    } else {
      scopeWhere = { applicantId: ctx.actingAsEmployeeId };
    }
    const where: Prisma.FreeTextRequestWhereInput = {
      ...scopeWhere,
      ...(query.status ? { status: query.status } : {}),
      ...(query.typeId ? { typeId: query.typeId } : {}),
    };
    const [total, rows] = await Promise.all([
      this.db.prisma.freeTextRequest.count({ where }),
      this.db.prisma.freeTextRequest.findMany({
        where,
        include: REQUEST_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: await Promise.all(rows.map((r) => this.dto(this.db.prisma, r))),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** GET /free-text/:id for anyone who may read the request (see `canRead`). */
  async get(ctx: SecurityContext, id: number): Promise<FreeTextRequestDto> {
    const row = await this.db.prisma.freeTextRequest.findUnique({ where: { id }, include: REQUEST_INCLUDE });
    if (!row) throw new NotFoundError('Free text request');
    if (!(await this.canRead(ctx, row))) {
      throw new ForbiddenError('You do not have access to this request', {
        subjectEmployeeId: row.applicantId,
        metadata: { freeTextRequestId: id },
      });
    }
    return this.dto(this.db.prisma, row);
  }

  /**
   * Readers: the applicant (or someone "Working as" them), their manager, HR/Payroll of their
   * company, auditors, and every reader of the process (its approvers).
   */
  async canRead(
    ctx: SecurityContext,
    row: { applicantId: number; processId: number | null },
  ): Promise<boolean> {
    if (hasRole(ctx, 'AUDITOR')) return true;
    if (await this.scope.canAccessAny(ctx, row.applicantId, ['SELF_SERVICE', 'TEAM', 'HR_READ'])) return true;
    if (row.processId === null) return false;
    const p = await this.db.prisma.workflowProcess.findUnique({
      where: { id: row.processId },
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

  private async dto(client: Tx, r: RequestRow): Promise<FreeTextRequestDto> {
    return {
      id: r.id,
      referenceNumber: r.referenceNumber,
      type: { id: r.type.id, code: r.type.code, description: r.type.description },
      workflowType: freeTextWorkflowType(r.type),
      applicant: person(r.applicant),
      aboutEmployee: r.aboutEmployee ? person(r.aboutEmployee) : null,
      body: r.body,
      status: r.status,
      statusLabel: PROCESS_STATUS_LABELS[r.status],
      processId: r.processId,
      submittedByUserId: r.submittedByUserId,
      submittedAt: r.submittedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      attachments: await this.attachments.listFor(client, FREE_TEXT_ENTITY, r.id),
      version: r.version,
    };
  }

  // ───────────── Workflow hooks (FREETEXT, and the FreeTextRequest branch of FREETEXTMANEMP) ─────────────

  async describe(client: Tx, process: WorkflowProcessSnapshot): Promise<SubjectDescription> {
    const r = await client.freeTextRequest.findUniqueOrThrow({
      where: { id: Number(process.subjectEntityId) },
      include: REQUEST_INCLUDE,
    });
    const about = r.aboutEmployee
      ? `${r.aboutEmployee.firstName} ${r.aboutEmployee.lastName} - ${r.aboutEmployee.employeeCode}`
      : null;
    return {
      requestLabel: r.type.description,
      title: 'Free text request',
      fromDate: null,
      toDate: null,
      unitsLine: null,
      headline: about ? [{ label: 'About employee', value: about }] : [],
      fields: [
        { label: 'Applying for', value: r.type.description },
        ...(about ? [{ label: 'About employee', value: about }] : []),
        { label: 'Details', value: r.body },
        { label: 'Reference number', value: r.referenceNumber },
      ],
      kind: 'FREE_TEXT',
      data: {
        freeTextRequestId: r.id,
        referenceNumber: r.referenceNumber,
        typeCode: r.type.code,
        typeDescription: r.type.description,
        body: r.body,
        aboutEmployee: r.aboutEmployee ? person(r.aboutEmployee) : null,
      },
      viewLabel: 'View free text request',
    };
  }

  async onFinalApproval({ tx, ctx, process }: WorkflowHookContext): Promise<FinalApprovalResult> {
    await this.setStatus(tx, ctx, process, 'PROCESSED', 'FREE_TEXT.APPROVED');
    return { outcome: 'APPLIED' };
  }

  async onDeclined({ tx, ctx, process, comment }: WorkflowCommentHookContext): Promise<void> {
    await this.setStatus(tx, ctx, process, 'DECLINED', 'FREE_TEXT.DECLINED', { comment });
  }

  async onCancelled({ tx, ctx, process, reason }: WorkflowCancelHookContext): Promise<void> {
    await this.setStatus(
      tx,
      ctx,
      process,
      'CANCELLED',
      reason === 'WITHDRAWN' ? 'FREE_TEXT.WITHDRAWN' : 'FREE_TEXT.CANCELLED',
    );
  }

  async onSentBack({ tx, ctx, process, comment }: WorkflowCommentHookContext): Promise<void> {
    await this.setStatus(tx, ctx, process, 'RESUBMIT_REQUIRED', 'FREE_TEXT.SENT_BACK', { comment });
  }

  /** A resubmission may carry an edited body (`changes: { body }`). */
  async onResubmitted({ tx, ctx, process, changes }: WorkflowResubmitHookContext): Promise<void> {
    const parsed = FreeTextResubmitChangesSchema.safeParse(changes ?? {});
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => ({ path: ['changes', ...i.path].join('.'), message: i.message })),
      );
    }
    await this.setStatus(tx, ctx, process, 'IN_PROGRESS', 'FREE_TEXT.RESUBMITTED', {}, parsed.data.body);
  }

  private async setStatus(
    tx: Tx,
    ctx: SecurityContext,
    process: WorkflowProcessSnapshot,
    status: ProcessStatus,
    action: string,
    metadata: Record<string, unknown> = {},
    body?: string,
  ): Promise<void> {
    const id = Number(process.subjectEntityId);
    const before = await tx.freeTextRequest.findUniqueOrThrow({ where: { id }, include: REQUEST_INCLUDE });
    const after = await tx.freeTextRequest.update({
      where: { id },
      data: { status, ...(body !== undefined ? { body } : {}), version: { increment: 1 } },
      include: REQUEST_INCLUDE,
    });
    this.audit.record(tx, ctx, {
      category: 'WORKFLOW',
      action,
      entityType: FREE_TEXT_ENTITY,
      entityId: id,
      subjectEmployeeId: before.applicantId,
      before: plain(before),
      after: plain(after),
      metadata: { referenceNumber: before.referenceNumber, processId: process.id, ...metadata },
    });
  }

  // ───────────── Admin: free text types (HR_ADMIN) ─────────────

  async adminTypes(): Promise<AdminFreeTextTypesResponse> {
    const rows = await this.db.prisma.freeTextType.findMany({
      include: { _count: { select: { requests: true } } },
      orderBy: { code: 'asc' },
    });
    return { items: rows.map(adminTypeDto) };
  }

  async createType(ctx: SecurityContext, input: CreateFreeTextTypeRequest): Promise<AdminFreeTextType> {
    return this.db.tx(ctx, async (tx) => {
      if (await tx.freeTextType.findUnique({ where: { code: input.code } })) {
        throw new ConflictError(`The free text type ${input.code} already exists`);
      }
      const row = await tx.freeTextType.create({
        data: input,
        include: { _count: { select: { requests: true } } },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'FREE_TEXT_TYPE.CREATED',
        entityType: 'FreeTextType',
        entityId: row.id,
        after: typeSnapshot(row),
      });
      return adminTypeDto(row);
    });
  }

  async updateType(
    ctx: SecurityContext,
    id: number,
    input: UpdateFreeTextTypeRequest,
  ): Promise<AdminFreeTextType> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'FreeTextType', id);
      const before = await tx.freeTextType.findUnique({
        where: { id },
        include: { _count: { select: { requests: true } } },
      });
      if (!before) throw new NotFoundError('Free text type');
      assertVersion(before, input.version);
      if (
        input.requiresSubjectEmployee !== undefined &&
        input.requiresSubjectEmployee !== before.requiresSubjectEmployee &&
        before._count.requests > 0
      ) {
        throw ValidationError.field(
          'requiresSubjectEmployee',
          'This type already has requests; create a new type to change its workflow',
        );
      }
      const { version: _v, ...fields } = input;
      const after = await tx.freeTextType.update({
        where: { id },
        data: { ...fields, version: { increment: 1 } },
        include: { _count: { select: { requests: true } } },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action:
          input.isActive === false && before.isActive
            ? 'FREE_TEXT_TYPE.DEACTIVATED'
            : input.isActive === true && !before.isActive
              ? 'FREE_TEXT_TYPE.ACTIVATED'
              : 'FREE_TEXT_TYPE.UPDATED',
        entityType: 'FreeTextType',
        entityId: id,
        before: typeSnapshot(before),
        after: typeSnapshot(after),
      });
      return adminTypeDto(after);
    });
  }

  async deactivateType(ctx: SecurityContext, id: number, version: number): Promise<AdminFreeTextType> {
    return this.updateType(ctx, id, { isActive: false, version });
  }
}

type TypeRow = Prisma.FreeTextTypeGetPayload<{ include: { _count: { select: { requests: true } } } }>;

function adminTypeDto(t: TypeRow): AdminFreeTextType {
  return {
    id: t.id,
    code: t.code,
    description: t.description,
    requiresSubjectEmployee: t.requiresSubjectEmployee,
    workflowType: freeTextWorkflowType(t),
    isActive: t.isActive,
    requestCount: t._count.requests,
    version: t.version,
  };
}

function typeSnapshot(t: TypeRow) {
  const { _count: _c, ...rest } = t;
  return rest;
}
