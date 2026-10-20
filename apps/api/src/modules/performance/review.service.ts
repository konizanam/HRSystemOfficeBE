import { Injectable } from '@nestjs/common';
import type { Prisma, ReviewStatus } from '@prisma/client';
import {
  allowedReviewTransitions,
  businessFromDate,
  canTransitionReview,
  combineParticipantTotals,
  CONTRACT_REVIEW_EXPORT_COLUMNS,
  CONTRACT_REVIEW_SORT_FIELDS,
  type ContractReviewsExportQuery,
  type ContractReviewRow,
  type ContractReviewsQuery,
  type ContractReviewsResponse,
  type CopyReviewRequest,
  type CreateReviewRequest,
  type CreateReviewResponse,
  dateFromBusiness,
  dec,
  isRatingOnScale,
  isReviewEditable,
  itemScore,
  PERFORMANCE_EXPORT_MAX_ROWS,
  participantWeights,
  type RatingScalePoint,
  ratingLabel,
  REVIEW_STATUS_LABELS,
  type ReviewActor,
  type ReviewDetail,
  type ReviewerInput,
  type ReviewItem,
  type ReviewObjectiveInput,
  type ReviewRow,
  type ReviewsQuery,
  type ReviewsResponse,
  type ReviewStatusRequest,
  reviewerTotal,
  reviewTransitionActors,
  scoringRoleFor,
  sectionWeightIssues,
  type SubmitScoresRequest,
  todayBusinessDate,
  type UpdateReviewRequest,
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
import { PARAMETER_ACTIVE } from '../details/lookup.service';
import { PerformanceAccess } from './performance-access';
import { REVIEW_ENTITY, scalePoints, sectionTotalsOf, toRatingScaleDto } from './performance-common';
import { type ExportFile, gridExport, sortMap } from './performance-export';
import { ReviewNotifier } from './review-notifier.service';

const ROW_INCLUDE = {
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, companyId: true } },
  contract: { select: { name: true, template: { select: { name: true } } } },
  _count: { select: { participants: { where: { role: 'REVIEWER', deletedAt: null } } } },
} satisfies Prisma.ReviewInclude;

type ReviewRowData = Prisma.ReviewGetPayload<{ include: typeof ROW_INCLUDE }>;

const DETAIL_INCLUDE = {
  ...ROW_INCLUDE,
  ratingScale: true,
  contract: {
    select: {
      name: true,
      template: { select: { name: true } },
      items: { where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
    },
  },
  participants: {
    where: { deletedAt: null },
    include: { employee: { select: { firstName: true, lastName: true, employeeCode: true } } },
    orderBy: [{ role: 'asc' }, { id: 'asc' }],
  },
  objectives: { where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
  scores: { orderBy: { id: 'asc' } },
} satisfies Prisma.ReviewInclude;

type ReviewDetailData = Prisma.ReviewGetPayload<{ include: typeof DETAIL_INCLUDE }>;

const REVIEW_SORTS: Record<ReviewsQuery['sort'], Prisma.ReviewOrderByWithRelationInput[]> = {
  'createdAt:desc': [{ createdAt: 'desc' }, { id: 'desc' }],
  'createdAt:asc': [{ createdAt: 'asc' }, { id: 'asc' }],
  'name:asc': [{ name: 'asc' }, { id: 'asc' }],
  'name:desc': [{ name: 'desc' }, { id: 'desc' }],
  'cycleStartDate:desc': [{ cycleStartDate: 'desc' }, { id: 'desc' }],
  'cycleStartDate:asc': [{ cycleStartDate: 'asc' }, { id: 'asc' }],
  'cycleEndDate:desc': [{ cycleEndDate: 'desc' }, { id: 'desc' }],
  'cycleEndDate:asc': [{ cycleEndDate: 'asc' }, { id: 'asc' }],
  'status:asc': [{ status: 'asc' }, { id: 'asc' }],
  'totalActual:desc': [{ totalActual: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
  'totalActual:asc': [{ totalActual: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
  'employee:asc': [{ employee: { lastName: 'asc' } }, { employee: { firstName: 'asc' } }, { id: 'asc' }],
  'employee:desc': [{ employee: { lastName: 'desc' } }, { employee: { firstName: 'desc' } }, { id: 'desc' }],
};

type ReviewOrder = Prisma.ReviewOrderByWithRelationInput;

/** Category and type sort by their code (the descriptions are looked up per row). */
const CONTRACT_REVIEW_SORTS: Record<ContractReviewsQuery['sort'], ReviewOrder[]> = sortMap<
  (typeof CONTRACT_REVIEW_SORT_FIELDS)[number],
  ReviewOrder
>({
  employeeSurname: (d) => [{ employee: { lastName: d } }, { employee: { firstName: d } }, { id: d }],
  employeeName: (d) => [{ employee: { firstName: d } }, { employee: { lastName: d } }, { id: d }],
  employeeCompany: (d) => [{ employee: { company: { name: d } } }, { id: d }],
  employeeCompanyRule: (d) => [{ employee: { companyRule: { description: d } } }, { id: d }],
  employeePosition: (d) => [{ employee: { jobTitle: { sort: d, nulls: 'last' } } }, { id: d }],
  contractName: (d) => [{ contract: { name: d } }, { id: d }],
  reviewName: (d) => [{ name: d }, { id: d }],
  reviewCategory: (d) => [{ category: d }, { id: d }],
  reviewType: (d) => [{ type: d }, { id: d }],
  reviewCycleStartDate: (d) => [{ cycleStartDate: d }, { id: d }],
  reviewCycleEndDate: (d) => [{ cycleEndDate: d }, { id: d }],
  reviewStatus: (d) => [{ status: d }, { id: d }],
  reviewTotalActual: (d) => [{ totalActual: { sort: d, nulls: 'last' } }, { id: d }],
});

interface Descriptions {
  categories: Map<string, string>;
  types: Map<string, string>;
}

/** A scorable item of a review, keyed `c:{contractItemId}` or `o:{objectiveId}`. */
interface ScoreTarget {
  key: string;
  item: ReviewItem;
}

function targetKey(score: { contractItemId: number | null; objectiveId: number | null }): string {
  return score.contractItemId !== null ? `c:${score.contractItemId}` : `o:${score.objectiveId ?? 0}`;
}

/**
 * Reviews (section 5.9): the Create Review wizard (one review per reviewee), Edit Review (only
 * while DRAFT or OPEN) with copy, the status flow, scoring with Total Actual, Review Results and the
 * contract reviews grid with every filter of the Filter Selection modal.
 *
 * Status flow (ASSUMPTION A94): DRAFT → OPEN → SELF_ASSESSMENT → REVIEWER_ASSESSMENT → MODERATION →
 * COMPLETED, or CANCELLED before completion. HR in scope moves every step; the reviewee may also
 * close their own self-assessment (SELF_ASSESSMENT → REVIEWER_ASSESSMENT). The reviewee scores in
 * SELF_ASSESSMENT and reviewers in REVIEWER_ASSESSMENT.
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly access: PerformanceAccess,
    private readonly scope: ScopeService,
    private readonly notifier: ReviewNotifier,
  ) {}

  // ───────────── Reads ─────────────

  async list(ctx: SecurityContext, query: ReviewsQuery, resultsOnly = false): Promise<ReviewsResponse> {
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
    const where: Prisma.ReviewWhereInput = {
      AND: [
        await this.access.reviewWhere(ctx),
        search,
        {
          status: query.statuses ? { in: query.statuses } : undefined,
          category: query.categories ? { in: query.categories } : undefined,
          type: query.types ? { in: query.types } : undefined,
          employeeId: query.employeeId,
          totalActual: resultsOnly ? { not: null } : undefined,
        },
      ],
    };
    const [rows, total, descriptions] = await Promise.all([
      this.db.prisma.review.findMany({
        where,
        include: {
          ...ROW_INCLUDE,
          // Only the caller's own reviewer rows: enough for the row's canEdit / allowedStatuses.
          participants: {
            where: { userId: ctx.userId, role: 'REVIEWER', deletedAt: null },
            select: { id: true },
          },
        },
        orderBy: REVIEW_SORTS[query.sort],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.prisma.review.count({ where }),
      this.descriptions(this.db.prisma),
    ]);
    return {
      items: rows.map((r) =>
        this.toRow(r, descriptions, this.rowActors(ctx, r.employee, r.participants.length > 0)),
      ),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * The caller's actor roles on a list row, without a query per row: HR in scope, the reviewee,
   * and a reviewer (from the caller's own participant rows).
   */
  private rowActors(
    ctx: SecurityContext,
    employee: { id: number; companyId: number } | null,
    isReviewer: boolean,
  ): ReviewActor[] {
    const actors: ReviewActor[] = [];
    if (this.access.isHrFor(ctx, employee)) actors.push('HR_ADMIN');
    if (this.access.isSelf(ctx, employee?.id ?? null)) actors.push('REVIEWEE');
    if (isReviewer) actors.push('REVIEWER');
    return actors;
  }

  /** GET /performance/contract-reviews/export: the filtered grid as CSV or Excel, audited. */
  async exportContractReviews(ctx: SecurityContext, query: ContractReviewsExportQuery): Promise<ExportFile> {
    const { format, ...filters } = query;
    const page = await this.contractReviews(ctx, {
      ...filters,
      page: 1,
      pageSize: PERFORMANCE_EXPORT_MAX_ROWS,
    });
    await this.audit.recordStandalone(ctx, {
      category: 'EXPORT',
      action: 'EXPORT.CONTRACT_REVIEWS',
      entityType: 'Review',
      metadata: { filters, format, rows: page.items.length, truncated: page.total > page.items.length },
    });
    return gridExport(page.items, CONTRACT_REVIEW_EXPORT_COLUMNS, {
      format,
      sheet: 'Reviews',
      fileBase: 'contract-reviews',
    });
  }

  /** GET /performance/contract-reviews: the Reviews grid with the Filter Selection modal. */
  async contractReviews(ctx: SecurityContext, query: ContractReviewsQuery): Promise<ContractReviewsResponse> {
    const employee: Prisma.EmployeeWhereInput = {
      companyId: query.companies ? { in: query.companies } : undefined,
      companyRuleId: query.companyRules ? { in: query.companyRules } : undefined,
      id: query.employees ? { in: query.employees } : undefined,
      jobTitle: query.positions ? { in: query.positions } : undefined,
    };
    const filterEmployees = !!(query.companies || query.companyRules || query.employees || query.positions);
    const where: Prisma.ReviewWhereInput = {
      AND: [
        await this.access.reviewWhere(ctx),
        {
          employee: filterEmployees ? employee : undefined,
          type: query.reviewTypes ? { in: query.reviewTypes } : undefined,
          category: query.reviewCategories ? { in: query.reviewCategories } : undefined,
          name: query.reviewName ? { contains: query.reviewName, mode: 'insensitive' } : undefined,
          status: query.statuses ? { in: query.statuses } : undefined,
          cycleStartDate:
            query.startFrom || query.startTo
              ? {
                  gte: query.startFrom ? dateFromBusiness(query.startFrom) : undefined,
                  lte: query.startTo ? dateFromBusiness(query.startTo) : undefined,
                }
              : undefined,
          cycleEndDate:
            query.endFrom || query.endTo
              ? {
                  gte: query.endFrom ? dateFromBusiness(query.endFrom) : undefined,
                  lte: query.endTo ? dateFromBusiness(query.endTo) : undefined,
                }
              : undefined,
        },
      ],
    };
    const include = {
      employee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          jobTitle: true,
          company: { select: { name: true } },
          companyRule: { select: { description: true } },
        },
      },
      contract: { select: { name: true } },
    } satisfies Prisma.ReviewInclude;
    const [rows, total, d] = await Promise.all([
      this.db.prisma.review.findMany({
        where,
        include,
        orderBy: CONTRACT_REVIEW_SORTS[query.sort],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.prisma.review.count({ where }),
      this.descriptions(this.db.prisma),
    ]);
    const items: ContractReviewRow[] = rows.map((r) => ({
      reviewId: r.id,
      contractId: r.contractId,
      employeeId: r.employeeId,
      employeeName: r.employee?.firstName ?? null,
      employeeSurname: r.employee?.lastName ?? null,
      employeeCompany: r.employee?.company.name ?? null,
      employeeCompanyRule: r.employee?.companyRule.description ?? null,
      employeePosition: r.employee?.jobTitle ?? null,
      contractName: r.contract?.name ?? null,
      reviewName: r.name,
      reviewCategory: d.categories.get(r.category) ?? r.category,
      reviewCategoryCode: r.category,
      reviewType: d.types.get(r.type) ?? r.type,
      reviewTypeCode: r.type,
      reviewCycleStartDate: businessFromDate(r.cycleStartDate),
      reviewCycleEndDate: businessFromDate(r.cycleEndDate),
      reviewStatus: r.status,
      reviewTotalActual: r.totalActual ? r.totalActual.toFixed(4) : null,
    }));
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async detail(ctx: SecurityContext, id: number, client: Tx = this.db.prisma): Promise<ReviewDetail> {
    const review = await client.review.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!review) throw new NotFoundError('Review');
    const roles = await this.access.reviewRoles(ctx, review, client);
    if (!this.access.canReadReview(ctx, review.status, roles))
      throw new ForbiddenError('You do not have access to this review', {
        subjectEmployeeId: review.employeeId,
        metadata: { reviewId: id },
      });
    return this.toDetail(ctx, review, roles, await this.descriptions(client));
  }

  // ───────────── Create, edit, copy ─────────────

  async create(ctx: SecurityContext, input: CreateReviewRequest): Promise<CreateReviewResponse> {
    return this.db.tx(ctx, async (tx) => {
      const errors: FieldError[] = [];
      for (const [index, r] of input.reviewees.entries())
        await this.scope.assertCanAccessEmployee(ctx, r.employeeId, 'HR_WRITE', tx).catch((err: unknown) => {
          if (err instanceof NotFoundError)
            errors.push({ path: `reviewees.${index}.employeeId`, message: 'Unknown employee' });
          else throw err;
        });
      errors.push(...(await this.codeErrors(tx, input.category, input.type)));
      errors.push(...this.objectiveErrors(input.objectives, 'objectives'));
      const seen = new Set<number>();
      input.reviewees.forEach((r, index) => {
        if (seen.has(r.employeeId))
          errors.push({
            path: `reviewees.${index}.employeeId`,
            message: 'This employee is already a reviewee',
          });
        seen.add(r.employeeId);
      });

      let ratingScaleId: number | null = null;
      if (input.templateMode === 'SHARED') {
        const template = await tx.performanceTemplate.findUnique({ where: { id: input.templateId ?? 0 } });
        if (!template) errors.push({ path: 'templateId', message: 'Choose a template' });
        else ratingScaleId = template.ratingScaleId;
      } else {
        const scale = input.ratingScaleId
          ? await tx.ratingScale.findUnique({ where: { id: input.ratingScaleId } })
          : await tx.ratingScale.findFirst({ orderBy: { id: 'asc' } });
        if (!scale) errors.push({ path: 'ratingScaleId', message: 'Choose a rating scale' });
        else ratingScaleId = scale.id;
      }
      if (errors.length > 0) throw new ValidationError(errors);

      const plans: {
        revieweeId: number;
        contractId: number | null;
        userId: string | null;
        selfWeight: string | null;
        reviewers: ResolvedReviewer[];
      }[] = [];
      for (const [index, r] of input.reviewees.entries()) {
        const contractId =
          input.templateMode === 'SHARED'
            ? await this.contractFor(
                tx,
                r.employeeId,
                input.templateId ?? 0,
                r.contractId,
                input,
                `reviewees.${index}.contractId`,
                errors,
              )
            : null;
        const reviewers = await this.resolveReviewers(
          tx,
          ctx,
          r.reviewers,
          r.employeeId,
          `reviewees.${index}.reviewers`,
          errors,
        );
        const user = await tx.user.findFirst({ where: { employeeId: r.employeeId }, select: { id: true } });
        plans.push({
          revieweeId: r.employeeId,
          contractId,
          userId: user?.id ?? null,
          selfWeight: r.selfWeight ?? null,
          reviewers,
        });
      }
      if (errors.length > 0) throw new ValidationError(errors);

      const ids: number[] = [];
      for (const plan of plans) {
        const review = await tx.review.create({
          data: {
            name: input.name,
            category: input.category,
            type: input.type,
            cycleStartDate: dateFromBusiness(input.cycleStartDate),
            cycleEndDate: dateFromBusiness(input.cycleEndDate),
            notifyMode: input.notifyMode,
            notifyDate: input.notifyDate ? dateFromBusiness(input.notifyDate) : null,
            isFreeFormat: input.templateMode === 'FREE_FORMAT',
            contractId: plan.contractId,
            employeeId: plan.revieweeId,
            ratingScaleId,
            createdByUserId: ctx.userId,
            status: 'DRAFT',
          },
        });
        await tx.reviewParticipant.create({
          data: {
            reviewId: review.id,
            role: 'REVIEWEE',
            employeeId: plan.revieweeId,
            userId: plan.userId,
            weight: plan.selfWeight,
          },
        });
        for (const reviewer of plan.reviewers)
          await tx.reviewParticipant.create({ data: { reviewId: review.id, role: 'REVIEWER', ...reviewer } });
        for (const [index, o] of input.objectives.entries())
          await tx.reviewObjective.create({
            data: {
              reviewId: review.id,
              title: o.title,
              description: o.description ?? null,
              weight: o.weight,
              sortOrder: (index + 1) * 10,
            },
          });
        this.audit.record(tx, ctx, {
          category: 'DATA_CHANGE',
          action: 'REVIEW.CREATED',
          entityType: REVIEW_ENTITY,
          entityId: review.id,
          subjectEmployeeId: plan.revieweeId,
          after: { ...review, reviewers: plan.reviewers, objectives: input.objectives },
          metadata: { templateMode: input.templateMode, templateId: input.templateId ?? null },
        });
        ids.push(review.id);
      }
      const items: ReviewDetail[] = [];
      for (const id of ids) items.push(await this.detail(ctx, id, tx));
      return { items };
    });
  }

  async update(ctx: SecurityContext, id: number, input: UpdateReviewRequest): Promise<ReviewDetail> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'Review', id);
      const before = await tx.review.findUnique({
        where: { id },
        include: { participants: { where: { deletedAt: null } }, objectives: { where: { deletedAt: null } } },
      });
      if (!before) throw new NotFoundError('Review');
      await this.assertHr(ctx, before.employeeId, id, tx);
      assertVersion(before, input.version);
      if (!isReviewEditable(before.status))
        throw new ValidationError(
          `A review can be edited only while Draft or Open; this one is ${REVIEW_STATUS_LABELS[before.status]}`,
        );

      const errors: FieldError[] = [];
      errors.push(...(await this.codeErrors(tx, input.category, input.type)));
      const start = input.cycleStartDate ?? businessFromDate(before.cycleStartDate);
      const end = input.cycleEndDate ?? businessFromDate(before.cycleEndDate);
      if (end < start)
        errors.push({ path: 'cycleEndDate', message: 'The review cycle cannot end before it starts' });
      const notifyMode = input.notifyMode ?? before.notifyMode;
      let notifyDate: string | null =
        input.notifyDate !== undefined
          ? input.notifyDate
          : before.notifyDate
            ? businessFromDate(before.notifyDate)
            : null;
      if (notifyMode !== 'SPECIFIC_DATE') {
        if (input.notifyDate)
          errors.push({ path: 'notifyDate', message: 'A notify date is only used with "Specific Date"' });
        notifyDate = null;
      } else if (!notifyDate) errors.push({ path: 'notifyDate', message: 'Choose the date to notify on' });
      if (input.objectives) {
        errors.push(...this.objectiveErrors(input.objectives, 'objectives'));
        const known = new Set(before.objectives.map((o) => o.id));
        input.objectives.forEach((o, index) => {
          if (o.id !== undefined && !known.has(o.id))
            errors.push({ path: `objectives.${index}.id`, message: 'Unknown objective' });
        });
        if (before.isFreeFormat && input.objectives.length === 0)
          errors.push({ path: 'objectives', message: 'Add the objectives of a free format review' });
      }
      const reviewers = input.reviewers
        ? await this.resolveReviewers(tx, ctx, input.reviewers, before.employeeId ?? 0, 'reviewers', errors)
        : null;
      if (errors.length > 0) throw new ValidationError(errors);

      if (input.objectives)
        await this.writeObjectives(
          tx,
          id,
          input.objectives,
          before.objectives.map((o) => o.id),
        );
      if (reviewers) await this.writeReviewers(tx, id, reviewers, before.participants);
      if (input.selfWeight !== undefined) {
        const self = before.participants.find((p) => p.role === 'REVIEWEE');
        if (self)
          await tx.reviewParticipant.update({ where: { id: self.id }, data: { weight: input.selfWeight } });
      }
      const after = await tx.review.update({
        where: { id },
        data: {
          name: input.name,
          category: input.category,
          type: input.type,
          cycleStartDate: input.cycleStartDate ? dateFromBusiness(input.cycleStartDate) : undefined,
          cycleEndDate: input.cycleEndDate ? dateFromBusiness(input.cycleEndDate) : undefined,
          notifyMode,
          notifyDate: notifyDate ? dateFromBusiness(notifyDate) : null,
          version: { increment: 1 },
        },
      });
      const { participants: beforeParticipants, objectives: beforeObjectives, ...beforeRow } = before;
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'REVIEW.UPDATED',
        entityType: REVIEW_ENTITY,
        entityId: id,
        subjectEmployeeId: before.employeeId,
        before: {
          ...beforeRow,
          reviewers: beforeParticipants
            .filter((p) => p.role === 'REVIEWER')
            .map((p) => ({ employeeId: p.employeeId, weight: p.weight })),
          objectives: beforeObjectives.map((o) => ({ id: o.id, title: o.title, weight: o.weight })),
        },
        after: {
          ...after,
          reviewers: reviewers ?? undefined,
          objectives: input.objectives ?? undefined,
        },
      });
      if (after.status === 'OPEN' && this.notifier.isDue(after, todayBusinessDate()))
        await this.notifier.notify(tx, ctx, id);
      return this.detail(ctx, id, tx);
    });
  }

  /** POST /performance/reviews/:id/copy: a DRAFT copy for the same reviewee, contract and reviewers. */
  async copy(ctx: SecurityContext, id: number, input: CopyReviewRequest): Promise<ReviewDetail> {
    return this.db.tx(ctx, async (tx) => {
      const source = await tx.review.findUnique({
        where: { id },
        include: { participants: { where: { deletedAt: null } }, objectives: { where: { deletedAt: null } } },
      });
      if (!source) throw new NotFoundError('Review');
      await this.assertHr(ctx, source.employeeId, id, tx);
      const start = input.cycleStartDate ?? businessFromDate(source.cycleStartDate);
      const end = input.cycleEndDate ?? businessFromDate(source.cycleEndDate);
      if (end < start)
        throw ValidationError.field('cycleEndDate', 'The review cycle cannot end before it starts');
      const copy = await tx.review.create({
        data: {
          name: input.name ?? `Copy of ${source.name}`.slice(0, 200),
          category: source.category,
          type: source.type,
          cycleStartDate: dateFromBusiness(start),
          cycleEndDate: dateFromBusiness(end),
          notifyMode: source.notifyMode === 'SPECIFIC_DATE' ? 'IMMEDIATELY' : source.notifyMode,
          notifyDate: null,
          isFreeFormat: source.isFreeFormat,
          contractId: source.contractId,
          employeeId: source.employeeId,
          ratingScaleId: source.ratingScaleId,
          createdByUserId: ctx.userId,
          status: 'DRAFT',
        },
      });
      for (const p of source.participants)
        await tx.reviewParticipant.create({
          data: {
            reviewId: copy.id,
            role: p.role,
            employeeId: p.employeeId,
            userId: p.userId,
            weight: p.weight,
          },
        });
      for (const o of source.objectives)
        await tx.reviewObjective.create({
          data: {
            reviewId: copy.id,
            title: o.title,
            description: o.description,
            weight: o.weight,
            sortOrder: o.sortOrder,
          },
        });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'REVIEW.COPIED',
        entityType: REVIEW_ENTITY,
        entityId: copy.id,
        subjectEmployeeId: copy.employeeId,
        after: copy,
        metadata: { sourceReviewId: source.id },
      });
      return this.detail(ctx, copy.id, tx);
    });
  }

  // ───────────── Status flow ─────────────

  async changeStatus(ctx: SecurityContext, id: number, input: ReviewStatusRequest): Promise<ReviewDetail> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'Review', id);
      const before = await tx.review.findUnique({ where: { id }, include: DETAIL_INCLUDE });
      if (!before) throw new NotFoundError('Review');
      const roles = await this.access.reviewRoles(ctx, before, tx);
      const readable = this.access.canReadReview(ctx, before.status, roles);
      const valid = canTransitionReview(before.status, input.status);
      // Only HR learns that a move is invalid (422) or that the version is stale (409); a reviewee
      // may only close their self-assessment, and everyone else gets 403.
      const mayAct = valid
        ? reviewTransitionActors(before.status, input.status).some((a) => roles.actors.includes(a))
        : roles.actors.includes('HR_ADMIN');
      if (!readable || !mayAct)
        throw new ForbiddenError('You cannot move this review', {
          subjectEmployeeId: before.employeeId,
          metadata: { reviewId: id, from: before.status, to: input.status },
        });
      assertVersion(before, input.version);
      if (!valid)
        throw ValidationError.field(
          'status',
          `A ${REVIEW_STATUS_LABELS[before.status]} review cannot move to ${REVIEW_STATUS_LABELS[input.status]}`,
        );
      this.assertReadyFor(before, input.status);

      const after = await tx.review.update({
        where: { id },
        data: { status: input.status, version: { increment: 1 } },
      });
      this.audit.record(tx, ctx, {
        category: 'WORKFLOW',
        action: 'REVIEW.STATUS_CHANGED',
        entityType: REVIEW_ENTITY,
        entityId: id,
        subjectEmployeeId: before.employeeId,
        before: { status: before.status, version: before.version },
        after: { status: after.status, version: after.version },
        reason: input.comment ?? null,
        metadata: { from: before.status, to: input.status, actors: roles.actors },
      });
      if (input.status === 'OPEN' && this.notifier.isDue(after, todayBusinessDate()))
        await this.notifier.notify(tx, ctx, id);
      return this.detail(ctx, id, tx);
    });
  }

  /** Business preconditions of a step (422 when not met). */
  private assertReadyFor(review: ReviewDetailData, to: ReviewStatus): void {
    const reviewers = review.participants.filter((p) => p.role === 'REVIEWER');
    if (to === 'OPEN') {
      const errors: FieldError[] = [];
      if (reviewers.length === 0)
        errors.push({ path: 'reviewers', message: 'Add a reviewer before opening the review' });
      if (this.targets(review).length === 0)
        errors.push({
          path: 'objectives',
          message: 'The review has nothing to rate: add objectives or use a contract',
        });
      if (errors.length > 0) throw new ValidationError(errors);
    }
    if (to === 'MODERATION') {
      const submitted = new Set(review.scores.filter((s) => s.submittedAt).map((s) => s.reviewerUserId));
      if (!reviewers.some((r) => r.userId && submitted.has(r.userId)))
        throw ValidationError.field('status', 'No reviewer has submitted scores yet');
    }
    if (to === 'COMPLETED' && review.totalActual === null)
      throw ValidationError.field('status', 'The review has no Total Actual yet');
  }

  // ───────────── Scores ─────────────

  /**
   * POST /performance/reviews/:id/scores: the caller rates contract items and objectives. The
   * reviewee scores during SELF_ASSESSMENT, reviewers during REVIEWER_ASSESSMENT. A submit needs a
   * rating for every item; Total Actual is recomputed and stored on each submit.
   */
  async submitScores(ctx: SecurityContext, id: number, input: SubmitScoresRequest): Promise<ReviewDetail> {
    return this.db.tx(ctx, async (tx) => {
      await this.db.lockRow(tx, 'Review', id);
      const review = await tx.review.findUnique({ where: { id }, include: DETAIL_INCLUDE });
      if (!review) throw new NotFoundError('Review');
      const participant = review.participants.find((p) => p.userId === ctx.userId);
      if (!participant)
        throw new ForbiddenError('Only the reviewee and the reviewers score a review', {
          subjectEmployeeId: review.employeeId,
          metadata: { reviewId: id },
        });
      const stage = scoringRoleFor(review.status);
      if (stage !== participant.role)
        throw ValidationError.field(
          'status',
          participant.role === 'REVIEWEE'
            ? 'The self-assessment can be scored only during Self Assessment'
            : 'Reviewers score only during Reviewer Assessment',
        );
      const points = review.ratingScale ? scalePoints(review.ratingScale) : [];
      if (points.length === 0) throw ValidationError.field('ratingScaleId', 'The review has no rating scale');

      const targets = new Map(this.targets(review).map((t) => [t.key, t]));
      const errors: FieldError[] = [];
      const seen = new Set<string>();
      input.scores.forEach((s, index) => {
        const key = s.contractItemId !== undefined ? `c:${s.contractItemId}` : `o:${s.objectiveId ?? 0}`;
        if (!targets.has(key))
          errors.push({
            path: `scores.${index}.${s.contractItemId !== undefined ? 'contractItemId' : 'objectiveId'}`,
            message: 'This is not an item of the review',
          });
        else if (seen.has(key)) errors.push({ path: `scores.${index}`, message: 'This item is rated twice' });
        seen.add(key);
        if (s.rating !== null && !isRatingOnScale(points, s.rating))
          errors.push({
            path: `scores.${index}.rating`,
            message: `Rate on the scale (${points[0]?.value} to ${points[points.length - 1]?.value})`,
          });
      });
      if (errors.length > 0) throw new ValidationError(errors);

      const now = new Date();
      const mine = new Map(
        review.scores.filter((s) => s.reviewerUserId === ctx.userId).map((s) => [targetKey(s), s]),
      );
      for (const s of input.scores) {
        const key = s.contractItemId !== undefined ? `c:${s.contractItemId}` : `o:${s.objectiveId ?? 0}`;
        const existing = mine.get(key);
        const data = { rating: s.rating, comment: s.comment ?? null };
        if (existing) {
          const updated = await tx.reviewScore.update({ where: { id: existing.id }, data });
          mine.set(key, updated);
        } else {
          const created = await tx.reviewScore.create({
            data: {
              ...data,
              reviewId: id,
              reviewerUserId: ctx.userId,
              contractItemId: s.contractItemId ?? null,
              objectiveId: s.objectiveId ?? null,
            },
          });
          mine.set(key, created);
        }
      }
      if (input.submit) {
        const missing = [...targets.values()].filter((t) => {
          const score = mine.get(t.key);
          return !score || score.rating === null;
        });
        if (missing.length > 0)
          throw ValidationError.field(
            'scores',
            `Rate every item before submitting (${missing.length} not rated)`,
          );
        for (const score of mine.values())
          await tx.reviewScore.update({ where: { id: score.id }, data: { submittedAt: now } });
      }

      const total = await this.recomputeTotal(tx, id);
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: input.submit ? 'REVIEW.SCORES_SUBMITTED' : 'REVIEW.SCORES_SAVED',
        entityType: REVIEW_ENTITY,
        entityId: id,
        subjectEmployeeId: review.employeeId,
        before: { totalActual: review.totalActual },
        after: { totalActual: total },
        metadata: {
          role: participant.role,
          scores: input.scores.map((s) => ({
            contractItemId: s.contractItemId ?? null,
            objectiveId: s.objectiveId ?? null,
            rating: s.rating,
          })),
        },
      });
      return this.detail(ctx, id, tx);
    });
  }

  /** Recomputes and stores Total Actual from the submitted scores (null when none count). */
  private async recomputeTotal(tx: Tx, id: number): Promise<string | null> {
    const review = await tx.review.findUniqueOrThrow({ where: { id }, include: DETAIL_INCLUDE });
    const points = review.ratingScale ? scalePoints(review.ratingScale) : [];
    const { overall } = this.totals(review, points);
    const value = overall === null ? null : overall.toFixed(4);
    await tx.review.update({ where: { id }, data: { totalActual: value } });
    return value;
  }

  // ───────────── Helpers ─────────────

  /** Every scorable item: the contract's items, then the review's objectives. */
  private targets(review: ReviewDetailData): ScoreTarget[] {
    const out: ScoreTarget[] = [];
    for (const i of review.contract?.items ?? [])
      out.push({
        key: `c:${i.id}`,
        item: {
          contractItemId: i.id,
          objectiveId: null,
          section: i.kind,
          title: i.title,
          weight: i.weight.toFixed(2),
          target: i.target,
        },
      });
    for (const o of review.objectives)
      out.push({
        key: `o:${o.id}`,
        item: {
          contractItemId: null,
          objectiveId: o.id,
          section: 'OBJECTIVE',
          title: o.title,
          weight: o.weight.toFixed(2),
          target: null,
        },
      });
    return out;
  }

  /** Each participant's normalised total and the review's Total Actual (ASSUMPTIONS A92, A93). */
  private totals(
    review: ReviewDetailData,
    points: RatingScalePoint[],
  ): {
    byParticipant: Map<number, string | null>;
    weights: Map<string, string>;
    overall: ReturnType<typeof combineParticipantTotals>;
  } {
    const targets = new Map(this.targets(review).map((t) => [t.key, t]));
    const weights = participantWeights(
      review.participants.map((p) => ({
        key: String(p.id),
        role: p.role,
        weight: p.weight ? p.weight.toString() : null,
      })),
    );
    const byParticipant = new Map<number, string | null>();
    const combined: { total: string | null; weight: string }[] = [];
    for (const p of review.participants) {
      const rated = review.scores
        .filter(
          (s) => p.userId !== null && s.reviewerUserId === p.userId && s.submittedAt && s.rating !== null,
        )
        .flatMap((s) => {
          const t = targets.get(targetKey(s));
          return t && s.rating ? [{ rating: s.rating.toString(), weight: t.item.weight }] : [];
        });
      const total = points.length > 0 ? reviewerTotal(rated, points) : null;
      const value = total ? total.toFixed(4) : null;
      byParticipant.set(p.id, value);
      combined.push({ total: value, weight: (weights.get(String(p.id)) ?? dec(0)).toString() });
    }
    return {
      byParticipant,
      weights: new Map([...weights.entries()].map(([k, v]) => [k, v.toString()])),
      overall: combineParticipantTotals(combined),
    };
  }

  private toRow(r: ReviewRowData, d: Descriptions, actors: ReviewActor[]): ReviewRow {
    return {
      id: r.id,
      name: r.name,
      category: r.category,
      categoryDescription: d.categories.get(r.category) ?? r.category,
      type: r.type,
      typeDescription: d.types.get(r.type) ?? r.type,
      cycleStartDate: businessFromDate(r.cycleStartDate),
      cycleEndDate: businessFromDate(r.cycleEndDate),
      notifyMode: r.notifyMode,
      notifyDate: r.notifyDate ? businessFromDate(r.notifyDate) : null,
      notifiedAt: r.notifiedAt ? r.notifiedAt.toISOString() : null,
      templateMode: r.isFreeFormat ? 'FREE_FORMAT' : 'SHARED',
      status: r.status,
      totalActual: r.totalActual ? r.totalActual.toFixed(4) : null,
      employeeId: r.employeeId,
      employeeCode: r.employee?.employeeCode ?? null,
      employeeName: r.employee?.firstName ?? null,
      employeeSurname: r.employee?.lastName ?? null,
      contractId: r.contractId,
      contractName: r.contract?.name ?? null,
      templateName: r.contract?.template.name ?? null,
      reviewerCount: r._count.participants,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      version: r.version,
      canEdit: isReviewEditable(r.status) && actors.includes('HR_ADMIN'),
      allowedStatuses: allowedReviewTransitions(r.status, actors),
    };
  }

  private toDetail(
    ctx: SecurityContext,
    review: ReviewDetailData,
    roles: { actors: ReviewActor[]; manager: boolean },
    d: Descriptions,
  ): ReviewDetail {
    const points = review.ratingScale ? scalePoints(review.ratingScale) : [];
    const privileged = this.access.isAuditor(ctx) || roles.actors.includes('HR_ADMIN') || roles.manager;
    const targets = new Map(this.targets(review).map((t) => [t.key, t]));
    const { byParticipant, weights } = this.totals(review, points);
    const me = review.participants.find((p) => p.userId === ctx.userId) ?? null;
    const roleOf = new Map(review.participants.filter((p) => p.userId).map((p) => [p.userId as string, p]));
    const submittedBy = new Map<string, Date>();
    for (const s of review.scores) if (s.submittedAt) submittedBy.set(s.reviewerUserId, s.submittedAt);
    const items = [...targets.values()].map((t) => t.item);
    return {
      ...this.toRow(review, d, roles.actors),
      ratingScale: review.ratingScale ? toRatingScaleDto(review.ratingScale) : null,
      objectives: review.objectives.map((o) => ({
        id: o.id,
        title: o.title,
        description: o.description,
        weight: o.weight.toFixed(2),
        sortOrder: o.sortOrder,
      })),
      participants: review.participants.map((p) => ({
        id: p.id,
        role: p.role,
        employeeId: p.employeeId,
        userId: p.userId,
        name: p.employee ? `${p.employee.firstName} ${p.employee.lastName}` : (p.userId ?? ''),
        employeeCode: p.employee?.employeeCode ?? null,
        weight: p.weight ? p.weight.toFixed(2) : null,
        effectiveWeight: dec(weights.get(String(p.id)) ?? 0).toFixed(2),
        submittedAt:
          p.userId && submittedBy.has(p.userId) ? (submittedBy.get(p.userId) as Date).toISOString() : null,
        total: privileged || p.id === me?.id ? (byParticipant.get(p.id) ?? null) : null,
      })),
      items,
      sectionTotals: sectionTotalsOf(items.map((i) => ({ kind: i.section, weight: i.weight }))),
      scores: review.scores
        .filter((s) => privileged || s.reviewerUserId === ctx.userId)
        .map((s) => {
          const t = targets.get(targetKey(s));
          const participant = roleOf.get(s.reviewerUserId);
          return {
            contractItemId: s.contractItemId,
            objectiveId: s.objectiveId,
            reviewerUserId: s.reviewerUserId,
            reviewerName: participant?.employee
              ? `${participant.employee.firstName} ${participant.employee.lastName}`
              : s.reviewerUserId,
            role: participant?.role ?? 'REVIEWER',
            rating: s.rating ? s.rating.toFixed(2) : null,
            ratingLabel: s.rating ? ratingLabel(points, s.rating.toString()) : null,
            itemScore: s.rating && t ? itemScore(s.rating.toString(), t.item.weight).toFixed(4) : null,
            comment: s.comment,
            submittedAt: s.submittedAt ? s.submittedAt.toISOString() : null,
          };
        }),
      myRole: me?.role ?? null,
      canEdit: isReviewEditable(review.status) && roles.actors.includes('HR_ADMIN'),
      canScore: me !== null && scoringRoleFor(review.status) === me.role,
      allowedStatuses: allowedReviewTransitions(review.status, roles.actors),
    };
  }

  private async descriptions(client: Tx): Promise<Descriptions> {
    const rows = await client.parameterValue.findMany({
      where: { tableName: { in: ['ReviewCategory', 'ReviewType'] } },
      select: { tableName: true, code: true, description: true },
    });
    const categories = new Map<string, string>();
    const types = new Map<string, string>();
    for (const r of rows) (r.tableName === 'ReviewCategory' ? categories : types).set(r.code, r.description);
    return { categories, types };
  }

  /** Review Category and Review Type must be active codes of their parameter tables. */
  private async codeErrors(
    tx: Tx,
    category: string | undefined,
    type: string | undefined,
  ): Promise<FieldError[]> {
    const checks: [string, string, string][] = [];
    if (category !== undefined) checks.push(['ReviewCategory', category, 'category']);
    if (type !== undefined) checks.push(['ReviewType', type, 'type']);
    if (checks.length === 0) return [];
    const rows = await tx.parameterValue.findMany({
      where: { status: PARAMETER_ACTIVE, OR: checks.map(([tableName, code]) => ({ tableName, code })) },
      select: { tableName: true, code: true },
    });
    return checks
      .filter(([tableName, code]) => !rows.some((r) => r.tableName === tableName && r.code === code))
      .map(([tableName, , path]) => ({
        path,
        message: `Pick a ${tableName === 'ReviewCategory' ? 'review category' : 'review type'} from the list`,
      }));
  }

  private objectiveErrors(
    objectives: readonly Pick<ReviewObjectiveInput, 'weight'>[],
    path: string,
  ): FieldError[] {
    return sectionWeightIssues(objectives.map((o) => ({ section: 'OBJECTIVE', weight: o.weight }))).map(
      (issue) => ({
        path,
        message: `The objective weights add up to ${issue.total}; they must add up to 100`,
      }),
    );
  }

  /** The reviewee's contract from the template: the given one, else the latest that overlaps the cycle. */
  private async contractFor(
    tx: Tx,
    employeeId: number,
    templateId: number,
    contractId: number | undefined,
    input: CreateReviewRequest,
    path: string,
    errors: FieldError[],
  ): Promise<number | null> {
    const contract = await tx.performanceContract.findFirst({
      where: {
        id: contractId,
        employeeId,
        templateId,
        status: { not: 'ARCHIVED' },
        startDate: contractId ? undefined : { lte: dateFromBusiness(input.cycleEndDate) },
        endDate: contractId ? undefined : { gte: dateFromBusiness(input.cycleStartDate) },
      },
      orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (!contract) {
      errors.push({
        path,
        message: contractId
          ? 'Choose a live contract of this employee from the template'
          : 'The employee has no contract from this template for the review cycle',
      });
      return null;
    }
    return contract.id;
  }

  /** Reviewers: active employees with an active account, in the caller's companies, not the reviewee. */
  private async resolveReviewers(
    tx: Tx,
    ctx: SecurityContext,
    inputs: readonly ReviewerInput[],
    revieweeId: number,
    path: string,
    errors: FieldError[],
  ): Promise<ResolvedReviewer[]> {
    const rows = await tx.employee.findMany({
      where: { id: { in: inputs.map((r) => r.employeeId) }, deletedAt: null },
      select: { id: true, companyId: true, status: true, user: { select: { id: true, isActive: true } } },
    });
    const out: ResolvedReviewer[] = [];
    const seen = new Set<number>();
    for (const [index, input] of inputs.entries()) {
      const at = `${path}.${index}.employeeId`;
      const e = rows.find((r) => r.id === input.employeeId);
      if (!e) errors.push({ path: at, message: 'Unknown employee' });
      else if (e.id === revieweeId)
        errors.push({ path: at, message: 'The reviewee cannot review themselves' });
      else if (seen.has(e.id)) errors.push({ path: at, message: 'This reviewer is listed twice' });
      else if (!ctx.isSystem && !ctx.companyIds.includes(e.companyId))
        throw new ForbiddenError('You do not have access to this employee', {
          subjectEmployeeId: e.id,
          metadata: { employeeId: e.id, purpose: 'REVIEWER' },
        });
      else if (e.status !== 'ACTIVE' || !e.user?.isActive)
        errors.push({ path: at, message: 'A reviewer needs to be active with a user account' });
      else out.push({ employeeId: e.id, userId: e.user.id, weight: input.weight ?? null });
      seen.add(input.employeeId);
    }
    return out;
  }

  private async writeObjectives(
    tx: Tx,
    reviewId: number,
    inputs: readonly ReviewObjectiveInput[],
    existing: number[],
  ): Promise<void> {
    const kept = new Set<number>();
    for (const [index, o] of inputs.entries()) {
      const data = {
        title: o.title,
        description: o.description ?? null,
        weight: o.weight,
        sortOrder: (index + 1) * 10,
      };
      if (o.id !== undefined) {
        kept.add(o.id);
        await tx.reviewObjective.update({ where: { id: o.id }, data });
      } else await tx.reviewObjective.create({ data: { ...data, reviewId } });
    }
    const now = new Date();
    for (const id of existing)
      if (!kept.has(id)) await tx.reviewObjective.update({ where: { id }, data: { deletedAt: now } });
  }

  private async writeReviewers(
    tx: Tx,
    reviewId: number,
    reviewers: ResolvedReviewer[],
    current: { id: number; role: string; employeeId: number | null }[],
  ): Promise<void> {
    const existing = new Map(current.filter((p) => p.role === 'REVIEWER').map((p) => [p.employeeId, p.id]));
    const kept = new Set<number>();
    for (const r of reviewers) {
      const id = existing.get(r.employeeId);
      if (id !== undefined) {
        kept.add(id);
        await tx.reviewParticipant.update({ where: { id }, data: { weight: r.weight, userId: r.userId } });
      } else await tx.reviewParticipant.create({ data: { reviewId, role: 'REVIEWER', ...r } });
    }
    const now = new Date();
    for (const id of existing.values())
      if (!kept.has(id)) await tx.reviewParticipant.update({ where: { id }, data: { deletedAt: now } });
  }

  private async assertHr(
    ctx: SecurityContext,
    employeeId: number | null,
    reviewId: number,
    tx: Tx,
  ): Promise<void> {
    if (employeeId !== null) {
      await this.scope.assertCanAccessEmployee(ctx, employeeId, 'HR_WRITE', tx);
      return;
    }
    throw new ForbiddenError('You cannot change this review', { metadata: { reviewId } });
  }
}

interface ResolvedReviewer {
  employeeId: number;
  userId: string;
  weight: string | null;
}
