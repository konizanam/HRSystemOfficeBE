import type { ApproverResolution } from '@prisma/client';
import { DELEGATION_MAX_HOPS } from '@peoplehub/shared';

// Pure decision rules of the workflow engine (section 7.1, 5.11). No database access, so they are
// unit-tested directly; the engine gathers the facts and applies the outcome.

// ───────────── Definition selection ─────────────

export interface DefinitionCandidate {
  id: number;
  companyRuleId: number | null;
  discriminator: string | null;
  versionNo: number;
  isActive: boolean;
}

/**
 * How specific a definition is: a discriminator match (for example a claim group) outranks a
 * company-rule match, and both outrank the type-wide default (ASSUMPTION, see docs).
 */
export function definitionSpecificity(candidate: DefinitionCandidate): number {
  return (candidate.discriminator !== null ? 2 : 0) + (candidate.companyRuleId !== null ? 1 : 0);
}

/**
 * Picks the definition for `(workflowType, companyRule | null, discriminator?)`: only active
 * definitions whose company rule is null or equal, and whose discriminator is null or equal,
 * are eligible; the most specific wins, then the highest version, then the newest.
 */
export function selectDefinition<T extends DefinitionCandidate>(
  candidates: readonly T[],
  companyRuleId: number,
  discriminator: string | null,
): T | null {
  const eligible = candidates.filter(
    (c) =>
      c.isActive &&
      (c.companyRuleId === null || c.companyRuleId === companyRuleId) &&
      (c.discriminator === null || c.discriminator === discriminator),
  );
  eligible.sort(
    (a, b) => definitionSpecificity(b) - definitionSpecificity(a) || b.versionNo - a.versionNo || b.id - a.id,
  );
  return eligible[0] ?? null;
}

// ───────────── Step planning ─────────────

export interface StepRule {
  stepNo: number;
  resolution: ApproverResolution;
  isMandatory: boolean;
  skipIfSameApprover: boolean;
}

export interface StepFacts {
  /** Users who may never approve: the applicant's user and the submitter. */
  applicantUserIds: ReadonlySet<string>;
  /** The user who approved the previous step of this round, if any. */
  previousApproverUserId: string | null;
  /** Active users the resolution rule produced (one for REPORTS_TO*, SPECIFIC_USER; many for ROLE). */
  resolved: readonly string[];
  /** Active HR admins of the applicant's company, used when a mandatory step cannot resolve. */
  fallback: readonly string[];
}

export type SkipReason = 'NO_APPROVER' | 'SAME_AS_APPLICANT' | 'SAME_AS_PREVIOUS';

export type StepPlan =
  | { kind: 'ASSIGN'; userIds: string[]; usedFallback: boolean }
  | { kind: 'SKIP'; reason: SkipReason; resolvedUserId: string | null }
  | { kind: 'UNRESOLVABLE' };

function unresolved(step: StepRule, facts: StepFacts): StepPlan {
  if (!step.isMandatory) return { kind: 'SKIP', reason: 'NO_APPROVER', resolvedUserId: null };
  const fallback = [...new Set(facts.fallback)].filter((u) => !facts.applicantUserIds.has(u));
  return fallback.length > 0
    ? { kind: 'ASSIGN', userIds: fallback, usedFallback: true }
    : { kind: 'UNRESOLVABLE' };
}

/**
 * Decides what happens when a step becomes current (section 7.1):
 *
 * - The applicant (and the submitter) can never approve. If the rule resolves to them, the step is
 *   auto-skipped when `skipIfSameApprover` is set, otherwise it counts as unresolved.
 * - `skipIfSameApprover` also skips a step whose approver approved the previous step. For a ROLE
 *   step that approver is simply left out of the candidates; the step is skipped only when no
 *   one else holds the role.
 * - An unresolved optional step is skipped; an unresolved mandatory step goes to the company's HR
 *   admins (ASSUMPTION), and is UNRESOLVABLE when there are none.
 */
export function planStep(step: StepRule, facts: StepFacts): StepPlan {
  const resolved = [...new Set(facts.resolved)];
  const previous = facts.previousApproverUserId;

  if (step.resolution !== 'ROLE') {
    const userId = resolved[0];
    if (userId === undefined) return unresolved(step, facts);
    if (facts.applicantUserIds.has(userId)) {
      return step.skipIfSameApprover
        ? { kind: 'SKIP', reason: 'SAME_AS_APPLICANT', resolvedUserId: userId }
        : unresolved(step, facts);
    }
    if (step.skipIfSameApprover && userId === previous) {
      return { kind: 'SKIP', reason: 'SAME_AS_PREVIOUS', resolvedUserId: userId };
    }
    return { kind: 'ASSIGN', userIds: [userId], usedFallback: false };
  }

  if (resolved.length === 0) return unresolved(step, facts);
  const notApplicant = resolved.filter((u) => !facts.applicantUserIds.has(u));
  if (notApplicant.length === 0) {
    return step.skipIfSameApprover
      ? { kind: 'SKIP', reason: 'SAME_AS_APPLICANT', resolvedUserId: resolved[0] ?? null }
      : unresolved(step, facts);
  }
  if (step.skipIfSameApprover && previous !== null && notApplicant.includes(previous)) {
    const others = notApplicant.filter((u) => u !== previous);
    if (others.length === 0) return { kind: 'SKIP', reason: 'SAME_AS_PREVIOUS', resolvedUserId: previous };
    return { kind: 'ASSIGN', userIds: others, usedFallback: false };
  }
  return { kind: 'ASSIGN', userIds: notApplicant, usedFallback: false };
}

// ───────────── Out-of-office delegation ─────────────

/** A user's out-of-office state for one workflow type, or null when they are not away. */
export interface AwayState {
  /** The rule for the type, else the main nominee; null when no (active) nominee is set. */
  nomineeUserId: string | null;
}

export type DelegationOutcome =
  'NONE' | 'DELEGATED' | 'CYCLE' | 'HOP_LIMIT' | 'NOMINEE_EXCLUDED' | 'NO_NOMINEE';

export interface DelegationResult {
  /** Who gets the step. */
  assigneeUserId: string;
  /** The users visited, starting with the original assignee. On a cycle it ends with the repeat. */
  chain: string[];
  outcome: DelegationOutcome;
}

/**
 * Follows out-of-office nominees from `original` (section 5.11):
 *
 * - at most `maxHops` delegations (default 3); a nominee who is away too stays the assignee
 *   once the limit is reached (`HOP_LIMIT`);
 * - a nominee already in the chain is a cycle: the step falls back to the original assignee
 *   (`CYCLE`) and the caller alerts HR;
 * - a nominee who may not approve (the applicant or submitter) is never used: the step stays
 *   with the last eligible user (`NOMINEE_EXCLUDED`).
 */
export async function resolveDelegation(
  original: string,
  awayState: (userId: string) => Promise<AwayState | null>,
  options: { excluded: ReadonlySet<string>; maxHops?: number },
): Promise<DelegationResult> {
  const maxHops = options.maxHops ?? DELEGATION_MAX_HOPS;
  const chain = [original];
  let current = original;
  for (;;) {
    const state = await awayState(current);
    if (!state) return { assigneeUserId: current, chain, outcome: chain.length > 1 ? 'DELEGATED' : 'NONE' };
    const nominee = state.nomineeUserId;
    if (nominee === null) return { assigneeUserId: current, chain, outcome: 'NO_NOMINEE' };
    if (chain.includes(nominee)) {
      return { assigneeUserId: original, chain: [...chain, nominee], outcome: 'CYCLE' };
    }
    if (options.excluded.has(nominee)) return { assigneeUserId: current, chain, outcome: 'NOMINEE_EXCLUDED' };
    if (chain.length - 1 >= maxHops) return { assigneeUserId: current, chain, outcome: 'HOP_LIMIT' };
    chain.push(nominee);
    current = nominee;
  }
}
