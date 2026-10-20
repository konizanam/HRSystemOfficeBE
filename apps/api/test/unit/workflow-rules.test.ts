import { describe, expect, it } from 'vitest';
import {
  type AwayState,
  type DefinitionCandidate,
  definitionSpecificity,
  planStep,
  resolveDelegation,
  selectDefinition,
  type StepFacts,
  type StepRule,
} from '../../src/modules/workflow/engine-rules';

function def(id: number, partial: Partial<DefinitionCandidate> = {}): DefinitionCandidate {
  return { id, companyRuleId: null, discriminator: null, versionNo: 1, isActive: true, ...partial };
}

describe('definition selection (section 7.1)', () => {
  it('prefers the most specific active definition', () => {
    const all = [
      def(1),
      def(2, { companyRuleId: 7 }),
      def(3, { discriminator: 'G1' }),
      def(4, { companyRuleId: 7, discriminator: 'G1' }),
      def(5, { companyRuleId: 8, discriminator: 'G1' }),
    ];
    expect(selectDefinition(all, 7, 'G1')?.id).toBe(4);
    expect(selectDefinition(all, 7, null)?.id).toBe(2);
    expect(selectDefinition(all, 9, 'G1')?.id).toBe(3);
    expect(selectDefinition(all, 9, null)?.id).toBe(1);
    expect(selectDefinition(all.slice(1, 2), 9, null)).toBeNull();
  });

  it('ignores inactive definitions and breaks ties by version, then id', () => {
    expect(selectDefinition([def(1, { versionNo: 2 }), def(2, { versionNo: 1 })], 1, null)?.id).toBe(1);
    expect(selectDefinition([def(1), def(2)], 1, null)?.id).toBe(2);
    expect(selectDefinition([def(1, { isActive: false })], 1, null)).toBeNull();
    expect(definitionSpecificity(def(1, { companyRuleId: 1, discriminator: 'x' }))).toBe(3);
  });
});

const ROLE: StepRule = { stepNo: 2, resolution: 'ROLE', isMandatory: true, skipIfSameApprover: true };
const MANAGER: StepRule = {
  stepNo: 1,
  resolution: 'REPORTS_TO',
  isMandatory: true,
  skipIfSameApprover: true,
};

function facts(partial: Partial<StepFacts> = {}): StepFacts {
  return {
    applicantUserIds: new Set(['applicant', 'submitter']),
    previousApproverUserId: null,
    resolved: [],
    fallback: ['hr1'],
    ...partial,
  };
}

describe('approver resolution (section 7.1)', () => {
  it('assigns the resolved approver', () => {
    expect(planStep(MANAGER, facts({ resolved: ['mgr'] }))).toEqual({
      kind: 'ASSIGN',
      userIds: ['mgr'],
      usedFallback: false,
    });
  });

  it('never lets the applicant or submitter approve', () => {
    expect(planStep(MANAGER, facts({ resolved: ['submitter'] }))).toEqual({
      kind: 'SKIP',
      reason: 'SAME_AS_APPLICANT',
      resolvedUserId: 'submitter',
    });
    // Without skipIfSameApprover it counts as unresolved: mandatory → HR fallback.
    expect(planStep({ ...MANAGER, skipIfSameApprover: false }, facts({ resolved: ['applicant'] }))).toEqual({
      kind: 'ASSIGN',
      userIds: ['hr1'],
      usedFallback: true,
    });
    expect(
      planStep(
        { ...MANAGER, skipIfSameApprover: false },
        facts({ resolved: ['applicant'], fallback: ['applicant'] }),
      ),
    ).toEqual({ kind: 'UNRESOLVABLE' });
  });

  it('skips a step whose approver approved the previous step', () => {
    expect(planStep(MANAGER, facts({ resolved: ['mgr'], previousApproverUserId: 'mgr' }))).toEqual({
      kind: 'SKIP',
      reason: 'SAME_AS_PREVIOUS',
      resolvedUserId: 'mgr',
    });
    expect(
      planStep(
        { ...MANAGER, skipIfSameApprover: false },
        facts({ resolved: ['mgr'], previousApproverUserId: 'mgr' }),
      ),
    ).toMatchObject({ kind: 'ASSIGN', userIds: ['mgr'] });
  });

  it('skips an optional step without an approver and falls back for a mandatory one', () => {
    expect(planStep({ ...MANAGER, isMandatory: false }, facts())).toEqual({
      kind: 'SKIP',
      reason: 'NO_APPROVER',
      resolvedUserId: null,
    });
    expect(planStep(MANAGER, facts())).toEqual({ kind: 'ASSIGN', userIds: ['hr1'], usedFallback: true });
    expect(planStep(MANAGER, facts({ fallback: [] }))).toEqual({ kind: 'UNRESOLVABLE' });
  });

  it('gives a ROLE step to every holder except the applicant and the previous approver', () => {
    expect(planStep(ROLE, facts({ resolved: ['hr1', 'hr2', 'applicant', 'hr1'] }))).toEqual({
      kind: 'ASSIGN',
      userIds: ['hr1', 'hr2'],
      usedFallback: false,
    });
    expect(planStep(ROLE, facts({ resolved: ['hr1', 'hr2'], previousApproverUserId: 'hr1' }))).toEqual({
      kind: 'ASSIGN',
      userIds: ['hr2'],
      usedFallback: false,
    });
    expect(planStep(ROLE, facts({ resolved: ['hr1'], previousApproverUserId: 'hr1' }))).toEqual({
      kind: 'SKIP',
      reason: 'SAME_AS_PREVIOUS',
      resolvedUserId: 'hr1',
    });
    expect(planStep(ROLE, facts({ resolved: ['applicant'] }))).toMatchObject({
      kind: 'SKIP',
      reason: 'SAME_AS_APPLICANT',
    });
    expect(
      planStep({ ...ROLE, skipIfSameApprover: false }, facts({ resolved: ['applicant'] })),
    ).toMatchObject({
      kind: 'ASSIGN',
      usedFallback: true,
    });
    expect(planStep({ ...ROLE, isMandatory: false }, facts({ resolved: [] }))).toMatchObject({
      kind: 'SKIP',
      reason: 'NO_APPROVER',
    });
  });
});

/** An out-of-office directory: user → nominee (null = away with no nominee); absent = present. */
function directory(away: Record<string, string | null>) {
  return async (userId: string): Promise<AwayState | null> =>
    userId in away ? { nomineeUserId: away[userId] ?? null } : null;
}

describe('out-of-office delegation (section 5.11)', () => {
  const excluded = new Set(['applicant']);

  it('keeps the step when the assignee is not away', async () => {
    expect(await resolveDelegation('a', directory({}), { excluded })).toEqual({
      assigneeUserId: 'a',
      chain: ['a'],
      outcome: 'NONE',
    });
  });

  it('follows nominees through people who are away too', async () => {
    expect(await resolveDelegation('a', directory({ a: 'b', b: 'c' }), { excluded })).toEqual({
      assigneeUserId: 'c',
      chain: ['a', 'b', 'c'],
      outcome: 'DELEGATED',
    });
  });

  it('stops after three hops', async () => {
    const result = await resolveDelegation('a', directory({ a: 'b', b: 'c', c: 'd', d: 'e' }), { excluded });
    expect(result).toEqual({ assigneeUserId: 'd', chain: ['a', 'b', 'c', 'd'], outcome: 'HOP_LIMIT' });
    expect(
      await resolveDelegation('a', directory({ a: 'b', b: 'c' }), { excluded, maxHops: 1 }),
    ).toMatchObject({
      assigneeUserId: 'b',
      outcome: 'HOP_LIMIT',
    });
  });

  it('falls back to the original assignee on a cycle', async () => {
    expect(await resolveDelegation('a', directory({ a: 'b', b: 'c', c: 'a' }), { excluded })).toEqual({
      assigneeUserId: 'a',
      chain: ['a', 'b', 'c', 'a'],
      outcome: 'CYCLE',
    });
    expect(await resolveDelegation('a', directory({ a: 'b', b: 'b' }), { excluded })).toMatchObject({
      assigneeUserId: 'a',
      outcome: 'CYCLE',
    });
  });

  it('never delegates to the applicant', async () => {
    expect(await resolveDelegation('a', directory({ a: 'b', b: 'applicant' }), { excluded })).toEqual({
      assigneeUserId: 'b',
      chain: ['a', 'b'],
      outcome: 'NOMINEE_EXCLUDED',
    });
  });

  it('keeps the step with an away assignee who has no nominee', async () => {
    expect(await resolveDelegation('a', directory({ a: null }), { excluded })).toEqual({
      assigneeUserId: 'a',
      chain: ['a'],
      outcome: 'NO_NOMINEE',
    });
  });
});
