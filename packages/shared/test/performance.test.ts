import { describe, expect, it } from 'vitest';
import {
  allowedContractTransitions,
  allowedReviewTransitions,
  canTransitionContract,
  canTransitionReview,
  canTransitionTemplate,
  combineParticipantTotals,
  ContractReviewsQuerySchema,
  CreateReviewRequestSchema,
  CreateTemplateRequestSchema,
  dec,
  initiationProgress,
  isContractEditable,
  isPerformanceParameterTable,
  isRatingOnScale,
  isReviewEditable,
  itemScore,
  normaliseToScale,
  parameterParentTable,
  participantWeights,
  RatingScalePointsSchema,
  ratingLabel,
  ratingScaleBounds,
  reviewerTotal,
  reviewTransitionActors,
  scoringRoleFor,
  ScoreInputSchema,
  sectionWeightIssues,
  sectionWeightTotals,
  TEMPLATE_ITEM_PARAMETER_TABLES,
  WeightSchema,
} from '../src';

const SCALE = [
  { value: 1, label: 'Unacceptable' },
  { value: 2, label: 'Needs Improvement' },
  { value: 3, label: 'Meets Expectations' },
  { value: 4, label: 'Exceeds Expectations' },
  { value: 5, label: 'Outstanding' },
];

describe('item score', () => {
  it('is rating × weight / 100', () => {
    expect(itemScore('4', '25').toString()).toBe('1');
    expect(itemScore('3', '40').toString()).toBe('1.2');
    expect(itemScore('3.5', '33.33').toFixed(4)).toBe('1.1666');
  });
});

describe('section weights', () => {
  it('accepts sections that each add up to 100', () => {
    const items = [
      { section: 'KPA', weight: '40' },
      { section: 'KPA', weight: '60.00' },
      { section: 'COMPETENCY', weight: '33.34' },
      { section: 'COMPETENCY', weight: '33.33' },
      { section: 'COMPETENCY', weight: '33.33' },
    ];
    expect(sectionWeightIssues(items)).toEqual([]);
    expect(sectionWeightTotals(items)).toEqual([
      { section: 'KPA', total: '100.00', valid: true },
      { section: 'COMPETENCY', total: '100.00', valid: true },
    ]);
  });

  it('reports every section that does not add up to 100', () => {
    const issues = sectionWeightIssues([
      { section: 'KPA', weight: '40' },
      { section: 'KPA', weight: '50' },
      { section: 'KPI', weight: '100' },
      { section: 'OBJECTIVE', weight: '100.01' },
    ]);
    expect(issues).toEqual([
      { section: 'KPA', total: '90.00', valid: false },
      { section: 'OBJECTIVE', total: '100.01', valid: false },
    ]);
  });

  it('has no sections for no items', () => {
    expect(sectionWeightIssues([])).toEqual([]);
  });

  it('validates the weight format', () => {
    expect(WeightSchema.safeParse('100').success).toBe(true);
    expect(WeightSchema.safeParse('12.25').success).toBe(true);
    expect(WeightSchema.safeParse('100.01').success).toBe(false);
    expect(WeightSchema.safeParse('-1').success).toBe(false);
    expect(WeightSchema.safeParse('1.234').success).toBe(false);
  });
});

describe('rating scales', () => {
  it('validates points', () => {
    expect(RatingScalePointsSchema.safeParse(SCALE).success).toBe(true);
    expect(RatingScalePointsSchema.safeParse([{ value: 1, label: 'Only' }]).success).toBe(false);
    expect(
      RatingScalePointsSchema.safeParse([
        { value: 1, label: 'A' },
        { value: 1, label: 'B' },
      ]).success,
    ).toBe(false);
  });

  it('finds the bounds and labels', () => {
    const { min, max } = ratingScaleBounds([...SCALE].reverse());
    expect(min.toString()).toBe('1');
    expect(max.toString()).toBe('5');
    expect(() => ratingScaleBounds([])).toThrow(RangeError);
    expect(isRatingOnScale(SCALE, '1')).toBe(true);
    expect(isRatingOnScale(SCALE, '4.5')).toBe(true);
    expect(isRatingOnScale(SCALE, '0.99')).toBe(false);
    expect(isRatingOnScale(SCALE, '5.01')).toBe(false);
    expect(ratingLabel(SCALE, '5')).toBe('Outstanding');
    expect(ratingLabel(SCALE, '3.5')).toBe('Meets Expectations');
    expect(ratingLabel(SCALE, null)).toBeNull();
    expect(ratingLabel([], '3')).toBeNull();
  });
});

describe('normalisation to the rating scale', () => {
  it('divides by the rated weight so the result is a weighted average rating', () => {
    // Two sections of 100 each: KPA 4×60 + 2×40 = 3.2; competency 5×100 = 5. Σ = 8.2 over weight 200.
    expect(normaliseToScale('8.2', '200', SCALE)?.toFixed(4)).toBe('4.1000');
    expect(normaliseToScale('3.2', '100', SCALE)?.toFixed(4)).toBe('3.2000');
  });

  it('clamps to the scale and rounds to 4 dp', () => {
    expect(normaliseToScale('7', '100', SCALE)?.toFixed(4)).toBe('5.0000');
    expect(normaliseToScale('0.5', '100', SCALE)?.toFixed(4)).toBe('1.0000');
    expect(normaliseToScale('1', '30', SCALE)?.toFixed(4)).toBe('3.3333');
  });

  it('is null when nothing was rated', () => {
    expect(normaliseToScale('0', '0', SCALE)).toBeNull();
  });

  it('computes a reviewer total from rated items', () => {
    const total = reviewerTotal(
      [
        { rating: '4', weight: '60' },
        { rating: '2', weight: '40' },
        { rating: '5', weight: '100' },
      ],
      SCALE,
    );
    expect(total?.toFixed(4)).toBe('4.1000');
    expect(reviewerTotal([], SCALE)).toBeNull();
  });
});

describe('participant weighting', () => {
  it('lets reviewers share equally and gives the self-assessment no weight by default', () => {
    const weights = participantWeights([
      { key: 'self', role: 'REVIEWEE', weight: null },
      { key: 'r1', role: 'REVIEWER', weight: null },
      { key: 'r2', role: 'REVIEWER', weight: '30' },
    ]);
    expect(weights.get('self')?.toString()).toBe('0');
    expect(weights.get('r1')?.toString()).toBe('1');
    expect(weights.get('r2')?.toString()).toBe('30');
  });

  it('takes the weighted average of the submitted totals', () => {
    expect(
      combineParticipantTotals([
        { total: '4', weight: 1 },
        { total: '2', weight: 1 },
        { total: '5', weight: 0 },
        { total: null, weight: 1 },
      ])?.toFixed(4),
    ).toBe('3.0000');
    expect(
      combineParticipantTotals([
        { total: '4', weight: '75' },
        { total: '2', weight: '25' },
      ])?.toFixed(4),
    ).toBe('3.5000');
    expect(combineParticipantTotals([{ total: null, weight: 1 }])).toBeNull();
    expect(combineParticipantTotals([{ total: '3', weight: 0 }])).toBeNull();
  });

  it('rounds the combined total to 4 dp', () => {
    expect(
      combineParticipantTotals([
        { total: '1', weight: 1 },
        { total: '2', weight: 1 },
        { total: '2', weight: 1 },
      ])?.toFixed(4),
    ).toBe(dec(5).dividedBy(3).toFixed(4));
  });
});

describe('status flows', () => {
  it('moves templates DRAFT → ACTIVE → ARCHIVED', () => {
    expect(canTransitionTemplate('DRAFT', 'ACTIVE')).toBe(true);
    expect(canTransitionTemplate('DRAFT', 'ARCHIVED')).toBe(true);
    expect(canTransitionTemplate('ACTIVE', 'ARCHIVED')).toBe(true);
    expect(canTransitionTemplate('ACTIVE', 'DRAFT')).toBe(false);
    expect(canTransitionTemplate('ARCHIVED', 'ACTIVE')).toBe(false);
  });

  it('moves contracts DRAFT → AGREED → ACTIVE → CLOSED → ARCHIVED', () => {
    expect(canTransitionContract('DRAFT', 'AGREED')).toBe(true);
    expect(canTransitionContract('AGREED', 'ACTIVE')).toBe(true);
    expect(canTransitionContract('ACTIVE', 'CLOSED')).toBe(true);
    expect(canTransitionContract('CLOSED', 'ARCHIVED')).toBe(true);
    expect(canTransitionContract('DRAFT', 'ARCHIVED')).toBe(true);
    expect(canTransitionContract('DRAFT', 'ACTIVE')).toBe(false);
    expect(canTransitionContract('ACTIVE', 'ARCHIVED')).toBe(false);
    expect(canTransitionContract('ARCHIVED', 'DRAFT')).toBe(false);
    expect(isContractEditable('DRAFT')).toBe(true);
    expect(isContractEditable('AGREED')).toBe(false);
  });

  it('lets the employee agree a contract but only managers and HR activate and close it', () => {
    expect(allowedContractTransitions('DRAFT', ['EMPLOYEE'])).toEqual(['AGREED']);
    expect(allowedContractTransitions('AGREED', ['EMPLOYEE'])).toEqual([]);
    expect(allowedContractTransitions('AGREED', ['MANAGER'])).toEqual(['ACTIVE']);
    expect(allowedContractTransitions('ACTIVE', ['MANAGER'])).toEqual(['CLOSED']);
    expect(allowedContractTransitions('CLOSED', ['MANAGER'])).toEqual([]);
    expect(allowedContractTransitions('CLOSED', ['HR_ADMIN'])).toEqual(['ARCHIVED']);
    expect(allowedContractTransitions('DRAFT', ['HR_ADMIN'])).toEqual(['AGREED', 'ARCHIVED']);
  });

  it('moves reviews along the flow and cancels before completion', () => {
    const flow = [
      'DRAFT',
      'OPEN',
      'SELF_ASSESSMENT',
      'REVIEWER_ASSESSMENT',
      'MODERATION',
      'COMPLETED',
    ] as const;
    for (let i = 0; i < flow.length - 1; i++) {
      expect(canTransitionReview(flow[i] as never, flow[i + 1] as never)).toBe(true);
      expect(canTransitionReview(flow[i] as never, 'CANCELLED')).toBe(true);
    }
    expect(canTransitionReview('OPEN', 'REVIEWER_ASSESSMENT')).toBe(false);
    expect(canTransitionReview('COMPLETED', 'CANCELLED')).toBe(false);
    expect(canTransitionReview('CANCELLED', 'OPEN')).toBe(false);
  });

  it('names who may move each review step', () => {
    expect(reviewTransitionActors('DRAFT', 'OPEN')).toEqual(['HR_ADMIN']);
    expect(reviewTransitionActors('SELF_ASSESSMENT', 'REVIEWER_ASSESSMENT')).toEqual([
      'HR_ADMIN',
      'REVIEWEE',
    ]);
    expect(reviewTransitionActors('OPEN', 'COMPLETED')).toEqual([]);
    expect(allowedReviewTransitions('SELF_ASSESSMENT', ['REVIEWEE'])).toEqual(['REVIEWER_ASSESSMENT']);
    expect(allowedReviewTransitions('OPEN', ['REVIEWEE'])).toEqual([]);
    expect(allowedReviewTransitions('MODERATION', ['HR_ADMIN'])).toEqual(['COMPLETED', 'CANCELLED']);
  });

  it('allows edits only while DRAFT or OPEN and scoring in the assessment steps', () => {
    expect(isReviewEditable('DRAFT')).toBe(true);
    expect(isReviewEditable('OPEN')).toBe(true);
    expect(isReviewEditable('SELF_ASSESSMENT')).toBe(false);
    expect(isReviewEditable('COMPLETED')).toBe(false);
    expect(scoringRoleFor('SELF_ASSESSMENT')).toBe('REVIEWEE');
    expect(scoringRoleFor('REVIEWER_ASSESSMENT')).toBe('REVIEWER');
    expect(scoringRoleFor('OPEN')).toBeNull();
    expect(scoringRoleFor('MODERATION')).toBeNull();
  });
});

describe('parameter tables', () => {
  it('knows the hierarchy and the tables each item kind links to', () => {
    expect(parameterParentTable('KeyPerformanceIndicator')).toBe('KeyPerformanceArea');
    expect(parameterParentTable('SubKeyPerformanceIndicator')).toBe('KeyPerformanceIndicator');
    expect(parameterParentTable('SubCompetency')).toBe('Competency');
    expect(parameterParentTable('ReviewCategory')).toBeNull();
    expect(isPerformanceParameterTable('JobGrade')).toBe(true);
    expect(isPerformanceParameterTable('Country')).toBe(false);
    expect(TEMPLATE_ITEM_PARAMETER_TABLES.OBJECTIVE).toEqual([]);
  });
});

describe('initiation progress', () => {
  it('is the processed share as a whole percentage', () => {
    expect(initiationProgress(3, 1, 1)).toBe(66);
    expect(initiationProgress(3, 2, 1)).toBe(100);
    expect(initiationProgress(0, 0, 0)).toBe(100);
  });
});

describe('performance contracts', () => {
  const review = {
    name: 'Annual 2026',
    category: 'ANNUAL',
    type: 'MANAGER',
    cycleStartDate: '2026-01-01',
    cycleEndDate: '2026-12-31',
    templateMode: 'FREE_FORMAT',
    objectives: [{ title: 'Deliver', weight: '100' }],
    reviewees: [{ employeeId: 1, reviewers: [{ employeeId: 2 }] }],
  };

  it('accepts the wizard and defaults notify to Immediately', () => {
    const parsed = CreateReviewRequestSchema.parse(review);
    expect(parsed.notifyMode).toBe('IMMEDIATELY');
  });

  it('checks the wizard rules', () => {
    const issues = (body: object) =>
      CreateReviewRequestSchema.safeParse({ ...review, ...body }).error?.issues.map((i) =>
        i.path.join('.'),
      ) ?? [];
    expect(issues({ cycleEndDate: '2025-12-31' })).toEqual(['cycleEndDate']);
    expect(issues({ notifyMode: 'SPECIFIC_DATE' })).toEqual(['notifyDate']);
    expect(issues({ notifyMode: 'NEVER', notifyDate: '2026-02-01' })).toEqual(['notifyDate']);
    expect(issues({ templateMode: 'SHARED' })).toEqual(['templateId']);
    expect(issues({ templateId: 4 })).toEqual(['templateId']);
    expect(issues({ objectives: [] })).toEqual(['objectives']);
    expect(issues({ reviewees: [{ employeeId: 1, reviewers: [] }] })).toEqual(['reviewees.0.reviewers']);
  });

  it('rejects a template that ends before it starts', () => {
    const res = CreateTemplateRequestSchema.safeParse({
      name: 'T',
      contractStartDate: '2026-02-01',
      contractEndDate: '2026-01-01',
      ratingScaleId: 1,
    });
    expect(res.success).toBe(false);
  });

  it('needs exactly one target per score', () => {
    expect(ScoreInputSchema.safeParse({ contractItemId: 1, rating: '3' }).success).toBe(true);
    expect(ScoreInputSchema.safeParse({ rating: '3' }).success).toBe(false);
    expect(ScoreInputSchema.safeParse({ contractItemId: 1, objectiveId: 2, rating: '3' }).success).toBe(
      false,
    );
  });

  it('reads multi-select filters from comma lists and repeated parameters', () => {
    const q = ContractReviewsQuerySchema.parse({
      companies: '1,2',
      companyRules: ['3', '4,5'],
      positions: 'Clerk',
      statuses: 'OPEN,COMPLETED',
      reviewTypes: '',
    });
    expect(q.companies).toEqual([1, 2]);
    expect(q.companyRules).toEqual([3, 4, 5]);
    expect(q.positions).toEqual(['Clerk']);
    expect(q.statuses).toEqual(['OPEN', 'COMPLETED']);
    expect(q.reviewTypes).toBeUndefined();
    expect(
      ContractReviewsQuerySchema.safeParse({ startFrom: '2026-02-01', startTo: '2026-01-01' }).success,
    ).toBe(false);
    expect(ContractReviewsQuerySchema.safeParse({ endFrom: '2026-02-01', endTo: '2026-01-01' }).success).toBe(
      false,
    );
  });
});
