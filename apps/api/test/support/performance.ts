import type { ReviewStatus } from '@prisma/client';
import type {
  ContractInitiation,
  CreateReviewResponse,
  PerformanceTemplate,
  ReviewDetail,
  TemplateItemInput,
} from '@peoplehub/shared';
import { expect } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import {
  PerformanceSeedService,
  SEED_RATING_SCALE_NAME,
} from '../../src/modules/performance/performance-seed.service';
import type { TestApp } from './app';
import { type Agent, nextUnique } from './fixtures';

// Performance test kit: the seeded parameter tables and rating scale (idempotent), templates with
// unique names, initiations, reviews and status moves.

const sys = systemContext('test-performance');

export class PerformanceKit {
  constructor(readonly t: TestApp) {}

  /** Parameter tables, the "1–5" scale and the seed template (idempotent). */
  async setup(): Promise<void> {
    await this.t.app.get(PerformanceSeedService).seed(sys);
  }

  async scaleId(): Promise<number> {
    return (await this.t.db.prisma.ratingScale.findUniqueOrThrow({ where: { name: SEED_RATING_SCALE_NAME } }))
      .id;
  }

  async param(tableName: string, code: string): Promise<number> {
    return (
      await this.t.db.prisma.parameterValue.findUniqueOrThrow({
        where: { tableName_code: { tableName, code } },
      })
    ).id;
  }

  async unique(prefix: string): Promise<string> {
    return `${prefix} ${await nextUnique(this.t.db)}`;
  }

  /** KPA FINANCIAL 60 + CUSTOMER 40, and COMPETENCY COMMUNICATION 100. */
  async items(): Promise<TemplateItemInput[]> {
    return [
      {
        kind: 'KPA',
        parameterValueId: await this.param('KeyPerformanceArea', 'FINANCIAL'),
        weight: '60',
        target: 'On budget',
      },
      { kind: 'KPA', parameterValueId: await this.param('KeyPerformanceArea', 'CUSTOMER'), weight: '40' },
      {
        kind: 'COMPETENCY',
        parameterValueId: await this.param('Competency', 'COMMUNICATION'),
        weight: '100',
      },
    ];
  }

  /** Creates a template through the API (ACTIVE unless told otherwise). */
  async template(
    hr: Agent,
    overrides: Partial<{
      status: 'DRAFT' | 'ACTIVE';
      contractStartDate: string;
      contractEndDate: string;
      items: TemplateItemInput[];
    }> = {},
  ): Promise<PerformanceTemplate> {
    const res = await hr.post('/performance/templates').send({
      name: await this.unique('Template'),
      contractStartDate: '2026-01-01',
      contractEndDate: '2026-12-31',
      ratingScaleId: await this.scaleId(),
      processDefinition: 'Annual cycle',
      status: 'ACTIVE',
      items: await this.items(),
      ...overrides,
    });
    expect(res.status, res.text).toBe(201);
    return res.body as PerformanceTemplate;
  }

  /** Initiates contracts for the employees and returns the finished initiation. */
  async initiate(
    hr: Agent,
    templateId: number,
    employeeIds: number[],
    name?: string,
  ): Promise<ContractInitiation> {
    const res = await hr.post('/performance/contract-initiations').send({
      name: name ?? (await this.unique('Contract')),
      templateId,
      filters: { employeeIds },
    });
    expect(res.status, res.text).toBe(201);
    return res.body as ContractInitiation;
  }

  async contractOf(employeeId: number, templateId: number): Promise<{ id: number; version: number }> {
    return this.t.db.prisma.performanceContract.findFirstOrThrow({
      where: { employeeId, templateId },
      orderBy: { id: 'desc' },
      select: { id: true, version: true },
    });
  }

  /** Creates reviews with the wizard and returns them. */
  async reviews(hr: Agent, body: Record<string, unknown>): Promise<ReviewDetail[]> {
    const res = await hr.post('/performance/reviews').send({
      name: await this.unique('Review'),
      category: 'ANNUAL',
      type: 'MANAGER',
      cycleStartDate: '2026-01-01',
      cycleEndDate: '2026-12-31',
      ...body,
    });
    expect(res.status, res.text).toBe(201);
    return (res.body as CreateReviewResponse).items;
  }

  /** A shared-template review of one reviewee with the given reviewers. */
  async sharedReview(
    hr: Agent,
    templateId: number,
    revieweeId: number,
    reviewerIds: number[],
    extra: Record<string, unknown> = {},
  ): Promise<ReviewDetail> {
    const [review] = await this.reviews(hr, {
      templateMode: 'SHARED',
      templateId,
      reviewees: [{ employeeId: revieweeId, reviewers: reviewerIds.map((employeeId) => ({ employeeId })) }],
      ...extra,
    });
    if (!review) throw new Error('No review created');
    return review;
  }

  /** A free format review with one objective. */
  async freeReview(
    hr: Agent,
    revieweeId: number,
    reviewerIds: number[],
    extra: Record<string, unknown> = {},
  ): Promise<ReviewDetail> {
    const [review] = await this.reviews(hr, {
      templateMode: 'FREE_FORMAT',
      objectives: [{ title: 'Deliver the plan', weight: '100' }],
      reviewees: [{ employeeId: revieweeId, reviewers: reviewerIds.map((employeeId) => ({ employeeId })) }],
      ...extra,
    });
    if (!review) throw new Error('No review created');
    return review;
  }

  async version(reviewId: number): Promise<number> {
    return (await this.t.db.prisma.review.findUniqueOrThrow({ where: { id: reviewId } })).version;
  }

  /** Moves a review to `status` as the agent (with the version read from the database). */
  async move(agent: Agent, reviewId: number, status: ReviewStatus, expected = 200): Promise<ReviewDetail> {
    const res = await agent
      .post(`/performance/reviews/${reviewId}/status`)
      .send({ status, version: await this.version(reviewId) });
    expect(res.status, res.text).toBe(expected);
    return res.body as ReviewDetail;
  }

  /** Moves a review through several statuses as HR. */
  async moveAll(hr: Agent, reviewId: number, statuses: ReviewStatus[]): Promise<void> {
    for (const s of statuses) await this.move(hr, reviewId, s);
  }

  /** Rates every item of the review with the given rating (or per-item ratings) and submits. */
  async score(
    agent: Agent,
    review: ReviewDetail,
    ratings: string[] | string,
    expected = 200,
  ): Promise<ReviewDetail> {
    const scores = review.items.map((item, i) => ({
      contractItemId: item.contractItemId ?? undefined,
      objectiveId: item.objectiveId ?? undefined,
      rating: Array.isArray(ratings) ? (ratings[i] ?? '3') : ratings,
      comment: 'Fine',
    }));
    const res = await agent.post(`/performance/reviews/${review.id}/scores`).send({ scores, submit: true });
    expect(res.status, res.text).toBe(expected);
    return res.body as ReviewDetail;
  }
}
