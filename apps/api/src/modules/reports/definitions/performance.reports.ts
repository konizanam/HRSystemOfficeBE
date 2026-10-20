import type { Prisma } from '@prisma/client';
import { dateFromBusiness } from '@peoplehub/shared';
import { defineReport } from '../report-definition';
import {
  batches,
  day,
  dec4,
  EMPLOYEE_REF_SELECT,
  employeeCells,
  fullName,
  ts,
  userNames,
} from '../report-helpers';

// Phase 8 builds the performance screens; these reports read the existing tables and are empty
// until reviews and contracts exist.

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

function cycleOverlap(from?: string, to?: string): Prisma.ReviewWhereInput {
  return {
    ...(from ? { cycleEndDate: { gte: dateFromBusiness(from) } } : {}),
    ...(to ? { cycleStartDate: { lte: dateFromBusiness(to) } } : {}),
  };
}

/** Individual Performance Review Results: one row per review, for its reviewee (`Review.employeeId`). */
export const performanceReviewResults = defineReport(
  'PERFORMANCE_REVIEW_RESULTS',
  async function* (rc, params) {
    for await (const batch of batches(
      (page) =>
        rc.prisma.review.findMany({
          where: {
            employee: rc.employees,
            ...(params.statuses ? { status: { in: params.statuses } } : {}),
            ...cycleOverlap(params.from, params.to),
          },
          include: {
            employee: { select: EMPLOYEE_REF_SELECT },
            contract: { select: { name: true } },
            _count: {
              select: {
                participants: { where: { role: 'REVIEWER', deletedAt: null } },
                scores: { where: { submittedAt: { not: null } } },
              },
            },
          },
          orderBy: [{ cycleEndDate: 'desc' }, { id: 'desc' }],
          ...page,
        }),
      rc.batchSize,
    )) {
      for (const r of batch) {
        if (!r.employee) continue;
        yield {
          reviewName: r.name,
          category: r.category,
          type: r.type,
          cycleStart: day(r.cycleStartDate),
          cycleEnd: day(r.cycleEndDate),
          ...employeeCells(r.employee),
          contractName: r.contract?.name ?? null,
          status: titleCase(r.status),
          totalActual: dec4(r.totalActual),
          reviewers: r._count.participants,
          scoresSubmitted: r._count.scores,
        };
      }
    }
  },
);

/** Contract And Review Overview: each contract with its reviews' count and latest outcome. */
export const contractReviewOverview = defineReport('CONTRACT_REVIEW_OVERVIEW', async function* (rc, params) {
  for await (const batch of batches(
    (page) =>
      rc.prisma.performanceContract.findMany({
        where: {
          employee: rc.employees,
          ...(params.statuses ? { status: { in: params.statuses } } : {}),
          ...(params.to ? { startDate: { lte: dateFromBusiness(params.to) } } : {}),
          ...(params.from ? { endDate: { gte: dateFromBusiness(params.from) } } : {}),
        },
        include: {
          employee: { select: EMPLOYEE_REF_SELECT },
          template: { select: { name: true } },
          reviews: {
            select: { name: true, status: true, totalActual: true },
            orderBy: [{ cycleEndDate: 'desc' }, { id: 'desc' }],
          },
        },
        orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
        ...page,
      }),
    rc.batchSize,
  )) {
    for (const c of batch) {
      const latest = c.reviews[0];
      yield {
        ...employeeCells(c.employee),
        companyRule: c.employee.companyRule.description,
        contractName: c.name,
        templateName: c.template.name,
        startDate: day(c.startDate),
        endDate: day(c.endDate),
        contractType: c.contractType,
        contractStatus: titleCase(c.status),
        archived: c.archivedAt !== null,
        reviews: c.reviews.length,
        completedReviews: c.reviews.filter((r) => r.status === 'COMPLETED').length,
        latestReview: latest?.name ?? null,
        latestReviewStatus: latest ? titleCase(latest.status) : null,
        latestTotalActual: dec4(latest?.totalActual ?? null),
      };
    }
  }
});

/** Reviewer Detail: each reviewer of a review with the scores they submitted. */
export const reviewerDetail = defineReport('REVIEWER_DETAIL', async function* (rc, params) {
  for await (const batch of batches(
    (page) =>
      rc.prisma.reviewParticipant.findMany({
        where: {
          role: 'REVIEWER',
          deletedAt: null,
          review: {
            employee: rc.employees,
            ...(params.statuses ? { status: { in: params.statuses } } : {}),
            ...cycleOverlap(params.from, params.to),
          },
        },
        include: {
          employee: { select: { firstName: true, lastName: true, user: { select: { id: true } } } },
          review: {
            select: {
              id: true,
              name: true,
              status: true,
              employee: { select: { employeeCode: true, firstName: true, lastName: true } },
            },
          },
        },
        orderBy: [{ reviewId: 'desc' }, { id: 'asc' }],
        ...page,
      }),
    rc.batchSize,
  )) {
    const reviewerIds = batch.map((p) => p.userId ?? p.employee?.user?.id ?? null);
    const [names, scores] = await Promise.all([
      userNames(rc.prisma, reviewerIds),
      rc.prisma.reviewScore.groupBy({
        by: ['reviewId', 'reviewerUserId'],
        where: {
          reviewId: { in: batch.map((p) => p.reviewId) },
          reviewerUserId: { in: reviewerIds.filter((id): id is string => id !== null) },
          submittedAt: { not: null },
        },
        _avg: { rating: true },
        _count: { _all: true },
        _max: { submittedAt: true },
      }),
    ]);
    for (const [i, p] of batch.entries()) {
      const reviewerId = reviewerIds[i] ?? null;
      const s = scores.find((x) => x.reviewId === p.reviewId && x.reviewerUserId === reviewerId);
      const reviewee = p.review.employee;
      yield {
        reviewName: p.review.name,
        reviewStatus: titleCase(p.review.status),
        revieweeCode: reviewee?.employeeCode ?? null,
        revieweeName: reviewee ? fullName(reviewee) : null,
        reviewer: p.employee ? fullName(p.employee) : reviewerId ? (names.get(reviewerId) ?? null) : null,
        reviewerWeight: dec4(p.weight),
        scoresSubmitted: s?._count._all ?? 0,
        averageRating: dec4(s?._avg.rating ?? null),
        lastSubmittedAt: ts(s?._max.submittedAt ?? null),
      };
    }
  }
});
