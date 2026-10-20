import { z } from 'zod';
import { Decimal, dec, type DecimalInput, round4 } from './decimal';
import type {
  ContractStatus,
  InitiationStatus,
  ReviewNotifyMode,
  ReviewStatus,
  TemplateItemKind,
  TemplateStatus,
} from './enums';

// Performance (section 5.9): the parameter tables, rating scales, the scoring rules and the status
// flows of templates, contracts and reviews. The server is the source of truth for every score;
// the web app uses the same helpers to show live totals.

// ───────────── Parameter tables ─────────────

/** The lookups observed in the source (section 5.9), stored as `ParameterValue.tableName`. */
export const PERFORMANCE_PARAMETER_TABLES = [
  'ReviewCategory',
  'ReviewType',
  'JobTitleType',
  'JobGrade',
  'KeyPerformanceArea',
  'KeyPerformanceIndicator',
  'SubKeyPerformanceIndicator',
  'CompetencyArea',
  'Competency',
  'SubCompetency',
  'LevelOfComplexity',
] as const;
export type PerformanceParameterTable = (typeof PERFORMANCE_PARAMETER_TABLES)[number];

export const PERFORMANCE_PARAMETER_TABLE_LABELS: Record<PerformanceParameterTable, string> = {
  ReviewCategory: 'Review Category',
  ReviewType: 'Review Type',
  JobTitleType: 'Job Title Type',
  JobGrade: 'Job Grade',
  KeyPerformanceArea: 'Key Performance Area',
  KeyPerformanceIndicator: 'Key Performance Indicator',
  SubKeyPerformanceIndicator: 'Sub Key Performance Indicator',
  CompetencyArea: 'Competency Area',
  Competency: 'Competency',
  SubCompetency: 'Sub Competency',
  LevelOfComplexity: 'Level Of Complexity',
};

/** Hierarchical tables: KPA → KPI → Sub KPI and Competency Area → Competency → Sub Competency. */
export const PERFORMANCE_PARAMETER_PARENTS: Partial<
  Record<PerformanceParameterTable, PerformanceParameterTable>
> = {
  KeyPerformanceIndicator: 'KeyPerformanceArea',
  SubKeyPerformanceIndicator: 'KeyPerformanceIndicator',
  Competency: 'CompetencyArea',
  SubCompetency: 'Competency',
};

/** The table a row's `parentId` must point into, or null when the table is flat. */
export function parameterParentTable(table: PerformanceParameterTable): PerformanceParameterTable | null {
  return PERFORMANCE_PARAMETER_PARENTS[table] ?? null;
}

export function isPerformanceParameterTable(value: string): value is PerformanceParameterTable {
  return (PERFORMANCE_PARAMETER_TABLES as readonly string[]).includes(value);
}

/** Which parameter tables a template or contract item of each kind may link to. */
export const TEMPLATE_ITEM_PARAMETER_TABLES: Record<TemplateItemKind, readonly PerformanceParameterTable[]> =
  {
    KPA: ['KeyPerformanceArea'],
    KPI: ['KeyPerformanceIndicator', 'SubKeyPerformanceIndicator'],
    COMPETENCY: ['CompetencyArea', 'Competency', 'SubCompetency'],
    OBJECTIVE: [],
  };

export const TEMPLATE_ITEM_KIND_LABELS: Record<TemplateItemKind, string> = {
  KPA: 'Key Performance Areas',
  KPI: 'Key Performance Indicators',
  COMPETENCY: 'Competencies',
  OBJECTIVE: 'Objectives',
};

// ───────────── Rating scales ─────────────

export const RatingScalePointSchema = z.object({
  value: z.number().finite().min(-1000).max(1000),
  label: z.string().trim().min(1).max(100),
});
export type RatingScalePoint = z.infer<typeof RatingScalePointSchema>;

/** At least two points with distinct values; stored in `RatingScale.points`. */
export const RatingScalePointsSchema = z
  .array(RatingScalePointSchema)
  .min(2)
  .max(20)
  .refine((points) => new Set(points.map((p) => p.value)).size === points.length, {
    message: 'Rating scale values must be distinct',
  });

/** The lowest and highest value of a scale. */
export function ratingScaleBounds(points: readonly RatingScalePoint[]): { min: Decimal; max: Decimal } {
  if (points.length === 0) throw new RangeError('A rating scale needs at least one point');
  let min = dec(points[0]?.value);
  let max = min;
  for (const p of points) {
    const v = dec(p.value);
    if (v.lessThan(min)) min = v;
    if (v.greaterThan(max)) max = v;
  }
  return { min, max };
}

/** A rating is valid when it lies between the scale's lowest and highest value (inclusive). */
export function isRatingOnScale(points: readonly RatingScalePoint[], rating: DecimalInput): boolean {
  const { min, max } = ratingScaleBounds(points);
  const r = dec(rating);
  return r.greaterThanOrEqualTo(min) && r.lessThanOrEqualTo(max);
}

/** The label of the scale point a rating equals, or of the highest point at or below it. */
export function ratingLabel(points: readonly RatingScalePoint[], rating: DecimalInput | null): string | null {
  if (rating === null || points.length === 0) return null;
  const r = dec(rating);
  const sorted = [...points].sort((a, b) => a.value - b.value);
  let label: string | null = null;
  for (const p of sorted) if (dec(p.value).lessThanOrEqualTo(r)) label = p.label;
  return label;
}

// ───────────── Scoring (section 5.9) ─────────────

/** Weights of the items in one section must add up to this (422 otherwise). */
export const SECTION_WEIGHT_TOTAL = 100;

/** `itemScore = rating × weight / 100`. */
export function itemScore(rating: DecimalInput, weight: DecimalInput): Decimal {
  return dec(rating).times(dec(weight)).dividedBy(100);
}

export interface WeightedItem {
  /** The section the item belongs to (the item kind). */
  section: string;
  weight: DecimalInput;
}

export interface SectionWeightTotal {
  section: string;
  /** Sum of the section's weights to 2 dp, e.g. "100.00". */
  total: string;
  valid: boolean;
}

/** Weight totals per section, in the order sections first appear. */
export function sectionWeightTotals(items: readonly WeightedItem[]): SectionWeightTotal[] {
  const totals = new Map<string, Decimal>();
  for (const item of items)
    totals.set(item.section, (totals.get(item.section) ?? new Decimal(0)).plus(dec(item.weight)));
  return [...totals.entries()].map(([section, total]) => ({
    section,
    total: total.toFixed(2),
    valid: total.equals(SECTION_WEIGHT_TOTAL),
  }));
}

/** The sections whose weights do not add up to 100 (an empty list means valid). */
export function sectionWeightIssues(items: readonly WeightedItem[]): SectionWeightTotal[] {
  return sectionWeightTotals(items).filter((s) => !s.valid);
}

/**
 * Normalises a sum of item scores to the rating scale: the sum is divided by the rated weight
 * (as a fraction of 100), which gives the weighted average rating whatever the number of sections,
 * then clamped to the scale's bounds and rounded to 4 dp. Null when nothing was rated.
 */
export function normaliseToScale(
  sumOfItemScores: DecimalInput,
  ratedWeight: DecimalInput,
  points: readonly RatingScalePoint[],
): Decimal | null {
  const weight = dec(ratedWeight);
  if (weight.lessThanOrEqualTo(0)) return null;
  const { min, max } = ratingScaleBounds(points);
  const value = dec(sumOfItemScores).dividedBy(weight.dividedBy(100));
  return round4(Decimal.min(max, Decimal.max(min, value)));
}

export interface RatedItem {
  rating: DecimalInput;
  weight: DecimalInput;
}

/** One reviewer's total: Σ itemScore over the items they rated, normalised to the scale. */
export function reviewerTotal(
  items: readonly RatedItem[],
  points: readonly RatingScalePoint[],
): Decimal | null {
  let sum = new Decimal(0);
  let weight = new Decimal(0);
  for (const item of items) {
    sum = sum.plus(itemScore(item.rating, item.weight));
    weight = weight.plus(dec(item.weight));
  }
  return normaliseToScale(sum, weight, points);
}

export interface ParticipantTotal {
  total: DecimalInput | null;
  weight: DecimalInput;
}

/**
 * The review's Total Actual from each participant's total: the weighted average over the
 * participants who submitted (a null total) and carry a positive weight; null when there is none.
 */
export function combineParticipantTotals(totals: readonly ParticipantTotal[]): Decimal | null {
  let sum = new Decimal(0);
  let weight = new Decimal(0);
  for (const t of totals) {
    if (t.total === null) continue;
    const w = dec(t.weight);
    if (w.lessThanOrEqualTo(0)) continue;
    sum = sum.plus(dec(t.total).times(w));
    weight = weight.plus(w);
  }
  return weight.isZero() ? null : round4(sum.dividedBy(weight));
}

/**
 * The weight of each participant when computing Total Actual (ASSUMPTION A93): an explicit
 * `ReviewParticipant.weight` wins; otherwise reviewers share equally and the self-assessment counts 0.
 */
export function participantWeights(
  participants: readonly { key: string; role: 'REVIEWEE' | 'REVIEWER'; weight: DecimalInput | null }[],
): Map<string, Decimal> {
  const out = new Map<string, Decimal>();
  for (const p of participants) {
    if (p.weight !== null && p.weight !== undefined) out.set(p.key, dec(p.weight));
    else out.set(p.key, new Decimal(p.role === 'REVIEWER' ? 1 : 0));
  }
  return out;
}

// ───────────── Status flows ─────────────

/** Template statuses (section 5.9): drafts become active; active and draft templates are archived. */
export const TEMPLATE_STATUS_TRANSITIONS: Record<TemplateStatus, readonly TemplateStatus[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['ARCHIVED'],
  ARCHIVED: [],
};

export function canTransitionTemplate(from: TemplateStatus, to: TemplateStatus): boolean {
  return TEMPLATE_STATUS_TRANSITIONS[from].includes(to);
}

/** Contract statuses: DRAFT → AGREED → ACTIVE → CLOSED → ARCHIVED; a draft may also be archived. */
export const CONTRACT_STATUS_TRANSITIONS: Record<ContractStatus, readonly ContractStatus[]> = {
  DRAFT: ['AGREED', 'ARCHIVED'],
  AGREED: ['ACTIVE'],
  ACTIVE: ['CLOSED'],
  CLOSED: ['ARCHIVED'],
  ARCHIVED: [],
};

export function canTransitionContract(from: ContractStatus, to: ContractStatus): boolean {
  return CONTRACT_STATUS_TRANSITIONS[from].includes(to);
}

/** Who moves a contract: the employee, their manager (within working-as depth) or HR in scope. */
export type ContractActor = 'EMPLOYEE' | 'MANAGER' | 'HR_ADMIN';

export const CONTRACT_TRANSITION_ACTORS: Record<ContractStatus, readonly ContractActor[]> = {
  DRAFT: [],
  AGREED: ['EMPLOYEE', 'MANAGER', 'HR_ADMIN'],
  ACTIVE: ['MANAGER', 'HR_ADMIN'],
  CLOSED: ['MANAGER', 'HR_ADMIN'],
  ARCHIVED: ['HR_ADMIN'],
};

/** The contract statuses an actor holding `actors` may move a contract in status `from` to. */
export function allowedContractTransitions(
  from: ContractStatus,
  actors: readonly ContractActor[],
): ContractStatus[] {
  return CONTRACT_STATUS_TRANSITIONS[from].filter((to) =>
    CONTRACT_TRANSITION_ACTORS[to].some((a) => actors.includes(a)),
  );
}

/** Contract items (and weights) can change only while the contract is a draft. */
export function isContractEditable(status: ContractStatus): boolean {
  return status === 'DRAFT';
}

/**
 * Review statuses (section 5.9): DRAFT → OPEN → SELF_ASSESSMENT → REVIEWER_ASSESSMENT →
 * MODERATION → COMPLETED, and CANCELLED from any status before COMPLETED.
 */
export const REVIEW_STATUS_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  DRAFT: ['OPEN', 'CANCELLED'],
  OPEN: ['SELF_ASSESSMENT', 'CANCELLED'],
  SELF_ASSESSMENT: ['REVIEWER_ASSESSMENT', 'CANCELLED'],
  REVIEWER_ASSESSMENT: ['MODERATION', 'CANCELLED'],
  MODERATION: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransitionReview(from: ReviewStatus, to: ReviewStatus): boolean {
  return REVIEW_STATUS_TRANSITIONS[from].includes(to);
}

/** Who moves a review: HR in scope always; the reviewee closes their own self-assessment. */
export type ReviewActor = 'HR_ADMIN' | 'REVIEWEE' | 'REVIEWER';

export function reviewTransitionActors(from: ReviewStatus, to: ReviewStatus): ReviewActor[] {
  if (!canTransitionReview(from, to)) return [];
  if (from === 'SELF_ASSESSMENT' && to === 'REVIEWER_ASSESSMENT') return ['HR_ADMIN', 'REVIEWEE'];
  return ['HR_ADMIN'];
}

export function allowedReviewTransitions(from: ReviewStatus, actors: readonly ReviewActor[]): ReviewStatus[] {
  return REVIEW_STATUS_TRANSITIONS[from].filter((to) =>
    reviewTransitionActors(from, to).some((a) => actors.includes(a)),
  );
}

/** Edit Review (section 5.9): only while DRAFT or OPEN. */
export const REVIEW_EDITABLE_STATUSES: readonly ReviewStatus[] = ['DRAFT', 'OPEN'];

export function isReviewEditable(status: ReviewStatus): boolean {
  return REVIEW_EDITABLE_STATUSES.includes(status);
}

/** Which participant scores in a status: the reviewee in SELF_ASSESSMENT, reviewers after it. */
export function scoringRoleFor(status: ReviewStatus): 'REVIEWEE' | 'REVIEWER' | null {
  if (status === 'SELF_ASSESSMENT') return 'REVIEWEE';
  if (status === 'REVIEWER_ASSESSMENT') return 'REVIEWER';
  return null;
}

/** Statuses in which participants have been told about the review (not DRAFT or CANCELLED). */
export const REVIEW_LIVE_STATUSES: readonly ReviewStatus[] = [
  'OPEN',
  'SELF_ASSESSMENT',
  'REVIEWER_ASSESSMENT',
  'MODERATION',
  'COMPLETED',
];

// ───────────── Labels ─────────────

export const TEMPLATE_STATUS_LABELS: Record<TemplateStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  ARCHIVED: 'Archived',
};

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  DRAFT: 'Draft',
  AGREED: 'Agreed',
  ACTIVE: 'Active',
  CLOSED: 'Closed',
  ARCHIVED: 'Archived',
};

export const INITIATION_STATUS_LABELS: Record<InitiationStatus, string> = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  DRAFT: 'Draft',
  OPEN: 'Open',
  SELF_ASSESSMENT: 'Self Assessment',
  REVIEWER_ASSESSMENT: 'Reviewer Assessment',
  MODERATION: 'Moderation',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/** "Notify: Immediately | Never | Specific Date" (section 5.9). */
export const REVIEW_NOTIFY_MODE_LABELS: Record<ReviewNotifyMode, string> = {
  IMMEDIATELY: 'Immediately',
  NEVER: 'Never',
  SPECIFIC_DATE: 'Specific Date',
};

/** Reviewees use a "Shared Template" (their contract) or a "Free Format Template" (objectives). */
export const REVIEW_TEMPLATE_MODES = ['SHARED', 'FREE_FORMAT'] as const;
export type ReviewTemplateMode = (typeof REVIEW_TEMPLATE_MODES)[number];
export const REVIEW_TEMPLATE_MODE_LABELS: Record<ReviewTemplateMode, string> = {
  SHARED: 'Shared Template',
  FREE_FORMAT: 'Free Format Template',
};

/** Initiation progress as a whole percentage of the contracts processed so far. */
export function initiationProgress(contractCount: number, created: number, failed: number): number {
  if (contractCount <= 0) return 100;
  return Math.min(100, Math.floor(((created + failed) * 100) / contractCount));
}
