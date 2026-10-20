import type { ReviewDetail, ReviewsResponse } from '@peoplehub/shared';
import { addDays, todayBusinessDate } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsService } from '../../src/jobs/jobs.service';
import { PERFORMANCE_REVIEW_NOTIFY_JOB } from '../../src/modules/performance/performance-common';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  auditSince,
  createRoleFixtures,
  lastAuditId,
  login,
  type RoleFixtures,
} from '../support/fixtures';
import { PerformanceKit } from '../support/performance';

describe('performance: reviews and scores', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: PerformanceKit;
  let hr: Agent;
  let templateId: number;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new PerformanceKit(t);
    await kit.setup();
    hr = await login(t, f.hrAdmin);
    const template = await kit.template(hr);
    templateId = template.id;
    await kit.initiate(hr, templateId, [f.employee.employeeId ?? 0, f.employee2.employeeId ?? 0]);
  });

  afterAll(async () => {
    await t.close();
  });

  it('runs create → open → scores → Total Actual, with edits blocked after OPEN', async () => {
    const emp = await login(t, f.employee);
    const mgr = await login(t, f.managerB);
    const mgrA = await login(t, f.managerA);
    const since = await lastAuditId(t.db);
    await t.mail.flush();
    const mailBefore = t.mail.outbox.length;

    const review = await kit.sharedReview(hr, templateId, f.employee.employeeId ?? 0, [
      f.managerB.employeeId ?? 0,
      f.managerA.employeeId ?? 0,
    ]);
    expect(review).toMatchObject({
      status: 'DRAFT',
      templateMode: 'SHARED',
      category: 'ANNUAL',
      categoryDescription: 'Annual Review',
      type: 'MANAGER',
      typeDescription: 'Manager Review',
      notifyMode: 'IMMEDIATELY',
      employeeId: f.employee.employeeId,
      reviewerCount: 2,
      totalActual: null,
      canEdit: true,
      allowedStatuses: ['OPEN', 'CANCELLED'],
    });
    expect(review.contractId).toBe((await kit.contractOf(f.employee.employeeId ?? 0, templateId)).id);
    expect(review.items.map((i) => [i.section, i.weight])).toEqual([
      ['KPA', '60.00'],
      ['KPA', '40.00'],
      ['COMPETENCY', '100.00'],
    ]);
    expect(review.participants.map((p) => [p.role, p.effectiveWeight])).toEqual([
      ['REVIEWEE', '0.00'],
      ['REVIEWER', '1.00'],
      ['REVIEWER', '1.00'],
    ]);

    // A DRAFT review is hidden from the reviewee and the reviewers.
    expect((await emp.get(`/performance/reviews/${review.id}`)).status).toBe(403);
    expect(
      ((await mgr.get('/performance/reviews')).body as ReviewsResponse).items.some((r) => r.id === review.id),
    ).toBe(false);

    // Edit while DRAFT; the reviewee cannot open it.
    const renamed = await hr
      .put(`/performance/reviews/${review.id}`)
      .send({ version: 1, name: `${review.name} (edited)` });
    expect(renamed.status, renamed.text).toBe(200);
    await kit.move(emp, review.id, 'OPEN', 403);
    const opened = await kit.move(hr, review.id, 'OPEN');
    expect(opened.notifiedAt).not.toBeNull();

    // Notify Immediately: every participant gets an in-app notification and an email.
    const notes = await t.db.prisma.notification.findMany({
      where: { kind: 'PERFORMANCE_REVIEW', link: `/performance/reviews/${review.id}` },
    });
    expect(notes.map((n) => n.userId).sort()).toEqual(
      [f.employee.userId, f.managerB.userId, f.managerA.userId].sort(),
    );
    await t.mail.flush();
    expect(t.mail.outbox.length - mailBefore).toBe(3);

    // Edit is still allowed while OPEN (reviewers replaced: manager A out, kept manager B).
    const edited = await hr.put(`/performance/reviews/${review.id}`).send({
      version: 3,
      reviewers: [{ employeeId: f.managerB.employeeId }, { employeeId: f.managerA.employeeId }],
    });
    expect(edited.status, edited.text).toBe(200);

    await kit.move(hr, review.id, 'SELF_ASSESSMENT');
    // Edits are blocked after OPEN.
    const blocked = await hr.put(`/performance/reviews/${review.id}`).send({ version: 5, name: 'Too late' });
    expect(blocked.status).toBe(422);

    // Reviewers cannot score during the self-assessment; the reviewee can.
    const open = (await emp.get(`/performance/reviews/${review.id}`)).body as ReviewDetail;
    expect(open).toMatchObject({ myRole: 'REVIEWEE', canScore: true, canEdit: false });
    await kit.score(mgr, open, '4', 422);
    const selfScored = await kit.score(emp, open, ['5', '5', '5']);
    // The self-assessment has no weight by default, so there is no Total Actual yet.
    expect(selfScored.totalActual).toBeNull();
    expect(selfScored.scores.every((s) => s.role === 'REVIEWEE')).toBe(true);

    // The reviewee closes their self-assessment.
    await kit.move(emp, review.id, 'REVIEWER_ASSESSMENT');
    await kit.move(hr, review.id, 'MODERATION', 422);

    // Manager B rates 4, 2 and 5: Σ itemScore = 4×60/100 + 2×40/100 + 5×100/100 = 8.2 over
    // weight 200 → 4.1000 on the 1–5 scale.
    const forMgr = (await mgr.get(`/performance/reviews/${review.id}`)).body as ReviewDetail;
    expect(forMgr.canScore).toBe(true);
    const afterB = await kit.score(mgr, forMgr, ['4', '2', '5']);
    expect(afterB.totalActual).toBe('4.1000');
    // Manager B manages the reviewee, so they see the self-assessment too.
    const byB = afterB.scores.filter((s) => s.reviewerUserId === f.managerB.userId);
    expect(byB.map((s) => s.itemScore)).toEqual(['2.4000', '0.8000', '5.0000']);
    expect(byB.map((s) => s.ratingLabel)).toEqual([
      'Exceeds Expectations',
      'Needs Improvement',
      'Outstanding',
    ]);
    // Manager A rates 3 everywhere (3.0000); the reviewers weigh equally: (4.1 + 3) / 2 = 3.55.
    const afterA = await kit.score(mgrA, forMgr, '3');
    expect(afterA.totalActual).toBe('3.5500');
    const stored = await t.db.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(stored.totalActual?.toFixed(4)).toBe('3.5500');

    // HR sees every participant's total; a reviewer sees only their own scores and total.
    const asHr = (await hr.get(`/performance/reviews/${review.id}`)).body as ReviewDetail;
    expect(asHr.participants.map((p) => p.total)).toEqual(['5.0000', '4.1000', '3.0000']);
    expect(asHr.scores).toHaveLength(9);
    const asMgrA = (await mgrA.get(`/performance/reviews/${review.id}`)).body as ReviewDetail;
    expect(asMgrA.scores.every((s) => s.reviewerUserId === f.managerA.userId)).toBe(true);

    await kit.moveAll(hr, review.id, ['MODERATION', 'COMPLETED']);
    const done = (await hr.get(`/performance/reviews/${review.id}`)).body as ReviewDetail;
    expect(done).toMatchObject({ status: 'COMPLETED', allowedStatuses: [], canScore: false });
    // Scoring is closed once the review moved on.
    await kit.score(mgrA, forMgr, '1', 422);

    // Review Results lists the scored review.
    const results = (await hr.get(`/performance/results?search=${encodeURIComponent(review.name)}`))
      .body as ReviewsResponse;
    expect(results.items.map((r) => [r.id, r.totalActual])).toContainEqual([review.id, '3.5500']);

    const actions = (
      await auditSince(t.db, since, { entityType: 'Review', entityId: String(review.id) })
    ).map((r) => r.action);
    expect(actions).toEqual([
      'REVIEW.CREATED',
      'REVIEW.UPDATED',
      'REVIEW.STATUS_CHANGED',
      'REVIEW.NOTIFIED',
      'REVIEW.UPDATED',
      'REVIEW.STATUS_CHANGED',
      'REVIEW.SCORES_SUBMITTED',
      'REVIEW.STATUS_CHANGED',
      'REVIEW.SCORES_SUBMITTED',
      'REVIEW.SCORES_SUBMITTED',
      'REVIEW.STATUS_CHANGED',
      'REVIEW.STATUS_CHANGED',
    ]);
  });

  it('validates scores: scale, items, completeness and participants', async () => {
    const review = await kit.freeReview(hr, f.employee2.employeeId ?? 0, [f.managerB.employeeId ?? 0], {
      objectives: [
        { title: 'Ship it', weight: '70' },
        { title: 'Document it', weight: '30' },
      ],
    });
    await kit.moveAll(hr, review.id, ['OPEN', 'SELF_ASSESSMENT', 'REVIEWER_ASSESSMENT']);
    const mgr = await login(t, f.managerB);
    const detail = (await mgr.get(`/performance/reviews/${review.id}`)).body as ReviewDetail;
    const [ship, doc] = detail.items;
    const post = (agent: Agent, body: object) =>
      agent.post(`/performance/reviews/${review.id}/scores`).send(body);

    expect((await post(mgr, { scores: [{ objectiveId: ship?.objectiveId, rating: '6' }] })).status).toBe(422);
    expect((await post(mgr, { scores: [{ contractItemId: 999999, rating: '3' }] })).status).toBe(422);
    const incomplete = await post(mgr, { scores: [{ objectiveId: ship?.objectiveId, rating: '4' }] });
    expect(incomplete.status).toBe(422);
    // A draft may be partial and does not count.
    const draft = await post(mgr, {
      scores: [{ objectiveId: ship?.objectiveId, rating: '4' }],
      submit: false,
    });
    expect(draft.status, draft.text).toBe(200);
    expect((draft.body as ReviewDetail).totalActual).toBeNull();
    const submitted = await post(mgr, { scores: [{ objectiveId: doc?.objectiveId, rating: '2.5' }] });
    expect(submitted.status, submitted.text).toBe(200);
    // 4 × 70/100 + 2.5 × 30/100 = 3.55 over weight 100.
    expect((submitted.body as ReviewDetail).totalActual).toBe('3.5500');
    // Someone who is not a participant gets 403 (audited).
    expect(
      (await post(await login(t, f.unrelated), { scores: [{ objectiveId: doc?.objectiveId, rating: '3' }] }))
        .status,
    ).toBe(403);
    expect((await post(hr, { scores: [{ objectiveId: doc?.objectiveId, rating: '3' }] })).status).toBe(403);
  });

  it('checks the wizard: codes, weights, contracts and reviewers', async () => {
    const base = {
      name: 'Wizard',
      category: 'ANNUAL',
      type: 'MANAGER',
      cycleStartDate: '2026-01-01',
      cycleEndDate: '2026-12-31',
    };
    const errorsOf = async (body: object) => {
      const res = await hr.post('/performance/reviews').send({ ...base, ...body });
      return {
        status: res.status,
        paths: ((res.body as { errors?: { path: string }[] }).errors ?? []).map((e) => e.path),
      };
    };
    const reviewee = (employeeId: number | null, reviewers: (number | null)[]) => ({
      employeeId,
      reviewers: reviewers.map((employeeId) => ({ employeeId })),
    });
    expect(
      await errorsOf({
        category: 'NOPE',
        type: 'NOPE',
        templateMode: 'FREE_FORMAT',
        objectives: [{ title: 'A', weight: '60' }],
        reviewees: [reviewee(f.employee.employeeId, [f.managerB.employeeId])],
      }),
    ).toEqual({ status: 422, paths: ['category', 'type', 'objectives'] });
    // No contract from the template for the unrelated colleague; a reviewer cannot be the reviewee.
    expect(
      await errorsOf({
        templateMode: 'SHARED',
        templateId,
        reviewees: [reviewee(f.unrelated.employeeId, [f.unrelated.employeeId])],
      }),
    ).toEqual({ status: 422, paths: ['reviewees.0.contractId', 'reviewees.0.reviewers.0.employeeId'] });
    // Reviewees outside the HR scope are refused.
    expect(
      (
        await errorsOf({
          templateMode: 'FREE_FORMAT',
          objectives: [{ title: 'A', weight: '100' }],
          reviewees: [reviewee(f.otherCompany.employeeId, [f.managerB.employeeId])],
        })
      ).status,
    ).toBe(403);
    // Only HR creates reviews.
    const mgr = await login(t, f.managerB);
    expect((await mgr.post('/performance/reviews').send(base)).status).toBe(403);
  });

  it('creates one review per reviewee and copies a review', async () => {
    const reviews = await kit.reviews(hr, {
      templateMode: 'SHARED',
      templateId,
      objectives: [{ title: 'Extra objective', weight: '100' }],
      reviewees: [
        { employeeId: f.employee.employeeId, reviewers: [{ employeeId: f.managerB.employeeId }] },
        {
          employeeId: f.employee2.employeeId,
          selfWeight: '20',
          reviewers: [{ employeeId: f.managerB.employeeId, weight: '80' }],
        },
      ],
    });
    expect(reviews.map((r) => r.employeeId)).toEqual([f.employee.employeeId, f.employee2.employeeId]);
    expect(reviews[1]?.participants.map((p) => [p.role, p.weight])).toEqual([
      ['REVIEWEE', '20.00'],
      ['REVIEWER', '80.00'],
    ]);
    // Contract items plus the review objective section.
    expect(reviews[0]?.sectionTotals.map((s) => s.section)).toEqual(['KPA', 'COMPETENCY', 'OBJECTIVE']);

    const source = reviews[0] as ReviewDetail;
    const since = await lastAuditId(t.db);
    const copy = await hr
      .post(`/performance/reviews/${source.id}/copy`)
      .send({ cycleStartDate: '2027-01-01', cycleEndDate: '2027-12-31' });
    expect(copy.status, copy.text).toBe(201);
    const copied = copy.body as ReviewDetail;
    expect(copied).toMatchObject({
      name: `Copy of ${source.name}`,
      status: 'DRAFT',
      cycleStartDate: '2027-01-01',
      employeeId: source.employeeId,
      contractId: source.contractId,
      totalActual: null,
      version: 1,
    });
    expect(copied.participants.map((p) => [p.role, p.employeeId])).toEqual(
      source.participants.map((p) => [p.role, p.employeeId]),
    );
    expect(copied.objectives.map((o) => o.title)).toEqual(['Extra objective']);
    const row = (await auditSince(t.db, since, { action: 'REVIEW.COPIED' }))[0];
    expect(row?.metadata).toMatchObject({ sourceReviewId: source.id });

    // Invalid moves are 422 for HR; a stale version is 409.
    await kit.move(hr, copied.id, 'COMPLETED', 422);
    const stale = await hr
      .post(`/performance/reviews/${copied.id}/status`)
      .send({ status: 'OPEN', version: 9 });
    expect(stale.status).toBe(409);
    await kit.move(hr, copied.id, 'CANCELLED');
    expect((await hr.put(`/performance/reviews/${copied.id}`).send({ version: 2, name: 'x' })).status).toBe(
      422,
    );
  });

  it('notifies on a specific date through the daily job', async () => {
    const tomorrow = addDays(todayBusinessDate(), 1);
    const review = await kit.freeReview(hr, f.employee.employeeId ?? 0, [f.managerB.employeeId ?? 0], {
      notifyMode: 'SPECIFIC_DATE',
      notifyDate: tomorrow,
    });
    const opened = await kit.move(hr, review.id, 'OPEN');
    expect(opened.notifiedAt).toBeNull();
    const jobs = t.app.get(JobsService);
    const early = await jobs.runNow(PERFORMANCE_REVIEW_NOTIFY_JOB, { asOf: todayBusinessDate() });
    expect(
      await t.db.prisma.notification.count({ where: { link: `/performance/reviews/${review.id}` } }),
    ).toBe(0);
    expect(early).toMatchObject({ reviews: 0 });
    const due = await jobs.runNow(PERFORMANCE_REVIEW_NOTIFY_JOB, { asOf: tomorrow });
    expect(Number(due.reviews)).toBeGreaterThanOrEqual(1);
    expect(
      await t.db.prisma.notification.count({ where: { link: `/performance/reviews/${review.id}` } }),
    ).toBe(2);
    // Once only.
    await jobs.runNow(PERFORMANCE_REVIEW_NOTIFY_JOB, { asOf: tomorrow });
    expect(
      await t.db.prisma.notification.count({ where: { link: `/performance/reviews/${review.id}` } }),
    ).toBe(2);

    // Never: opening sends nothing.
    const never = await kit.freeReview(hr, f.employee2.employeeId ?? 0, [f.managerB.employeeId ?? 0], {
      notifyMode: 'NEVER',
    });
    await kit.move(hr, never.id, 'OPEN');
    expect(
      await t.db.prisma.notification.count({ where: { link: `/performance/reviews/${never.id}` } }),
    ).toBe(0);
  });
});
