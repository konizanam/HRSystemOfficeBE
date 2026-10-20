import { formatTimestampDate, IDEMPOTENCY_HEADER } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  auditSince,
  createPerson,
  createRoleFixtures,
  lastAuditId,
  login,
  type Person,
  type RoleFixtures,
} from '../support/fixtures';
import { type FakeSubjectHandler, TWO_STEP, WorkflowKit } from '../support/workflow';

interface Card {
  processId: number;
  [key: string]: unknown;
}

describe('inbox API (sections 5.10 and 12.7)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let claims: FakeSubjectHandler;
  let free: FakeSubjectHandler;
  let applicant: Person;
  let manager: Person;
  let mgr: Agent;
  let app: Agent;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    claims = kit.useFakeHandler('CLAIMS');
    free = kit.useFakeHandler('FREETEXT');
    // A fresh manager and report so counts are exact.
    manager = await createPerson(t.db, { org: f.org, roles: ['EMPLOYEE', 'MANAGER'], label: 'inbox-mgr' });
    applicant = await createPerson(t.db, { org: f.org, label: 'inbox-emp', reportsToId: manager.employeeId });
    await kit.definition({ type: 'CLAIMS', companyRuleId: f.org.companyRuleId, steps: TWO_STEP });
    await kit.definition({ type: 'FREETEXT', companyRuleId: f.org.companyRuleId, steps: TWO_STEP });
    mgr = await login(t, manager);
    app = await login(t, applicant);
  });

  afterAll(async () => {
    kit.restore();
    await t.close();
  });

  const ids = (body: { items: Card[] }) => body.items.map((c) => c.processId);

  it('counts categories and tabs for the applicant and the approver', async () => {
    const before = (await mgr.get('/inbox/categories').expect(200)).body;
    expect(before.tabs.action).toBe(0);
    expect(before.isApprover).toBe(true);

    await kit.start(claims, applicant);
    await kit.start(claims, applicant);
    await kit.start(free, applicant);

    const mine = (await app.get('/inbox/categories').expect(200)).body;
    expect(mine.tabs).toMatchObject({ submitted: 3, action: 0 });
    expect(mine.isApprover).toBe(false);
    expect(mine.approvals).toEqual([]);
    expect(mine.pendingProcess).toBeNull();
    const submitted = Object.fromEntries(
      mine.submitted.map((c: { category: string; count: number }) => [c.category, c.count]),
    );
    expect(submitted).toMatchObject({ CLAIMS: 2, FREE_TEXT: 1 });
    // Enabled categories show even without items (the seed or these tests define them).
    expect(mine.submitted.map((c: { category: string }) => c.category)).toEqual(
      expect.arrayContaining(['CLAIMS', 'FREE_TEXT']),
    );
    expect(mine.submitted.find((c: { category: string }) => c.category === 'CLAIMS').workflowTypes).toEqual([
      'CLAIMS',
      'GROUPEDCLAIM',
    ]);

    const approver = (await mgr.get('/inbox/categories').expect(200)).body;
    expect(approver.tabs.action).toBe(3);
    const approvals = Object.fromEntries(
      approver.approvals.map((c: { category: string; count: number }) => [c.category, c.count]),
    );
    expect(approvals).toMatchObject({ CLAIMS: 2, FREE_TEXT: 1 });
    expect(
      (await (await login(t, f.payrollAdmin)).get('/inbox/categories').expect(200)).body.pendingProcess,
    ).toEqual(expect.any(Number));
  });

  it('lists cards in the observed format with filter, type and sort', async () => {
    const p = await kit.start(claims, applicant, {
      fake: { label: 'Overtime Claims', fromDate: '2026-09-24', toDate: '2026-09-26', units: '1.5000' },
    });
    const res = await mgr.get('/inbox/items?box=action&type=CLAIMS&pageSize=100').expect(200);
    const card = res.body.items.find((c: Card) => c.processId === p.id);
    const e = await t.db.prisma.employee.findUniqueOrThrow({ where: { id: applicant.employeeId ?? 0 } });
    const row = await kit.process(p.id);
    expect(card).toEqual({
      processId: p.id,
      version: p.version,
      workflowType: 'CLAIMS',
      typeLabel: 'Claims Workflow Process',
      requestLabel: 'Overtime Claims',
      category: 'CLAIMS',
      title: `${e.firstName} ${e.lastName} - ${e.employeeCode}`,
      applicant: {
        employeeId: e.id,
        employeeCode: e.employeeCode,
        firstName: e.firstName,
        lastName: e.lastName,
      },
      fromDate: '2026-09-24',
      toDate: '2026-09-26',
      periodText: 'from 24 Sep 2026 to 26 Sep 2026',
      status: 'IN_PROGRESS',
      statusLabel: 'In Progress',
      statusText: 'Status: In Progress',
      unitsLine: '1.5000 Days to be deducted',
      summary: row.summary,
      submittedAt: row.submittedAt?.toISOString(),
      submittedDate: formatTimestampDate(row.submittedAt ?? new Date()),
      currentStepNo: 1,
      isEscalated: false,
      parkedUntil: null,
      canAct: true,
      viewLabel: 'View fake request',
    });
    expect(res.body).toMatchObject({ page: 1, pageSize: 100 });
    expect(res.body.items.every((c: { workflowType: string }) => c.workflowType === 'CLAIMS')).toBe(true);

    const filtered = await mgr
      .get(`/inbox/items?box=action&filter=${encodeURIComponent(row.summary)}`)
      .expect(200);
    expect(ids(filtered.body)).toEqual([p.id]);
    expect((await mgr.get('/inbox/items?box=action&filter=no-such-person-xyz').expect(200)).body.total).toBe(
      0,
    );
    const byCategory = await mgr.get('/inbox/items?box=action&category=FREE_TEXT').expect(200);
    expect(byCategory.body.items.every((c: { category: string }) => c.category === 'FREE_TEXT')).toBe(true);

    const asc = ids((await mgr.get('/inbox/items?box=action&sort=submittedAt:asc').expect(200)).body);
    const desc = ids((await mgr.get('/inbox/items?box=action&sort=submittedAt:desc').expect(200)).body);
    expect(asc).toEqual([...desc].reverse());
    await mgr.get('/inbox/items?box=action&sort=summary:asc').expect(422);
    await mgr.get('/inbox/items?sort=applicant:asc').expect(200);
    await mgr.get('/inbox/items?sort=type:desc').expect(200);

    const paged = await mgr.get('/inbox/items?box=action&pageSize=1&page=2').expect(200);
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.total).toBeGreaterThan(1);
  });

  it('separates Action Required, Submitted, History and the payroll queue', async () => {
    const p = await kit.start(claims, applicant);
    expect(ids((await app.get('/inbox/items?box=submitted&pageSize=100').expect(200)).body)).toContain(p.id);
    expect(ids((await app.get('/inbox/items?box=action&pageSize=100').expect(200)).body)).not.toContain(p.id);

    const approved = await mgr
      .post(`/workflow/processes/${p.id}/approve`)
      .send({ version: p.version })
      .expect(200);
    expect(ids((await mgr.get('/inbox/items?box=action&pageSize=100').expect(200)).body)).not.toContain(p.id);
    const history = (await mgr.get('/inbox/items?box=history&pageSize=100').expect(200)).body;
    const card = history.items.find((c: Card) => c.processId === p.id);
    expect(card).toMatchObject({ canAct: false, currentStepNo: 2 });

    await (
      await login(t, f.hrAdmin)
    )
      .post(`/workflow/processes/${p.id}/approve`)
      .send({ version: approved.body.version })
      .expect(200);
    // Still "submitted" (in flight) until payroll processes it.
    expect(ids((await app.get('/inbox/items?box=submitted&pageSize=100').expect(200)).body)).toContain(p.id);
    const pay = await login(t, f.payrollAdmin);
    expect(ids((await pay.get('/inbox/items?box=process&pageSize=100').expect(200)).body)).toContain(p.id);
    await app.get('/inbox/items?box=process').expect(403);
    await (await login(t, f.hrAdmin)).get('/inbox/items?box=process').expect(403);

    const payPeriodId = await kit.payPeriod(f.org);
    await pay
      .post('/workflow/processes/process')
      .send({ ids: [p.id], payPeriodId })
      .expect(200);
    expect(ids((await app.get('/inbox/items?box=submitted&pageSize=100').expect(200)).body)).not.toContain(
      p.id,
    );
    expect(ids((await app.get('/inbox/items?box=history&pageSize=100').expect(200)).body)).toContain(p.id);
  });

  it('shows the detail panel with the subject, attachments, comments, allowed actions and warnings', async () => {
    const p = await kit.start(claims, applicant, { comment: 'Urgent', fake: { warn: true } });
    await t.db.tx(systemContext('test-attachment'), (tx) =>
      tx.attachment.create({
        data: {
          ownerEntity: 'FakeSubject',
          ownerEntityId: p.subjectEntityId,
          fileName: 'receipt.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1234,
          sha256: 'a'.repeat(64),
          storageKey: `test/${p.id}/${Date.now()}`,
          uploadedByUserId: applicant.userId,
        },
      }),
    );
    const detail = (await mgr.get(`/inbox/items/${p.id}`).expect(200)).body;
    expect(detail.card).toMatchObject({ processId: p.id, canAct: true });
    expect(detail.subject).toMatchObject({
      title: 'Fake Item request',
      requestLabel: 'Fake Item',
      headline: [{ label: 'Days to be deducted', value: '3.0000' }],
    });
    expect(detail.subject.fields[0]).toEqual({ label: 'Item', value: 'Fake Item' });
    expect(detail.attachments).toMatchObject([
      { fileName: 'receipt.pdf', mimeType: 'application/pdf', sizeBytes: 1234 },
    ]);
    expect(detail.attachments[0].downloadUrl).toMatch(/^\/api\/v1\/attachments\//);
    expect(detail.comments).toMatchObject([{ action: 'CREATE', comment: 'Urgent' }]);
    expect([...detail.allowedActions].sort()).toEqual(
      ['APPROVE', 'COMMENT', 'DECLINE', 'PARK', 'REASSIGN', 'SEND_BACK'].sort(),
    );
    expect(detail.warnings).toEqual([
      { code: 'NEGATIVE_BALANCE', message: 'Approving this takes the balance negative' },
    ]);
    expect(detail.steps).toMatchObject([
      { stepNo: 1, status: 'PENDING', name: 'Manager approval', assignee: { userId: manager.userId } },
    ]);
    expect(detail.submittedBy).toMatchObject({ userId: applicant.userId });

    const own = (await app.get(`/inbox/items/${p.id}`).expect(200)).body;
    expect([...own.allowedActions].sort()).toEqual(['COMMENT', 'WITHDRAW']);
    expect(own.warnings).toEqual([]);
    expect(own.card.canAct).toBe(false);

    await (await login(t, f.unrelated)).get(`/inbox/items/${p.id}`).expect(403);
    await (await login(t, f.auditor)).get(`/inbox/items/${p.id}`).expect(200);
    await mgr.get('/inbox/items/999999999').expect(404);
  });

  it('bulk-approves item by item, audits each, and replays an Idempotency-Key', async () => {
    const a = await kit.start(claims, applicant);
    const b = await kit.start(free, applicant);
    const stale = await kit.start(claims, applicant);
    const notMine = await kit.start(claims, f.employee);
    const key = `bulk-${Date.now()}`;
    const body = {
      items: [
        { id: a.id, version: a.version },
        { id: b.id, version: b.version },
        { id: stale.id, version: stale.version + 1 },
        { id: notMine.id, version: notMine.version },
      ],
      comment: 'Bulk OK',
    };
    const since = await lastAuditId(t.db);
    const first = await mgr
      .post('/workflow/processes/bulk-approve')
      .set(IDEMPOTENCY_HEADER, key)
      .send(body)
      .expect(200);
    expect(first.body).toMatchObject({
      succeeded: 2,
      failed: 2,
      results: [
        { processId: a.id, ok: true, process: { currentStepNo: 2 } },
        { processId: b.id, ok: true, process: { currentStepNo: 2 } },
        { processId: stale.id, ok: false, error: { status: 409 } },
        { processId: notMine.id, ok: false, error: { status: 403 } },
      ],
    });
    const approvedAudits = await auditSince(t.db, since, { action: 'WORKFLOW.APPROVED' });
    expect(approvedAudits.map((r) => Number(r.entityId)).sort()).toEqual([a.id, b.id].sort());
    expect(approvedAudits.every((r) => r.reason === 'Bulk OK')).toBe(true);
    expect(await auditSince(t.db, since, { outcome: 'DENIED', entityId: String(notMine.id) })).toHaveLength(
      1,
    );

    const afterFirst = await lastAuditId(t.db);
    const replay = await mgr
      .post('/workflow/processes/bulk-approve')
      .set(IDEMPOTENCY_HEADER, key)
      .send(body)
      .expect(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(await auditSince(t.db, afterFirst, { category: 'WORKFLOW' })).toHaveLength(0);
    expect((await kit.actions(a.id)).filter((x) => x.action === 'APPROVE')).toHaveLength(1);

    // The same key with a different body is refused.
    await mgr
      .post('/workflow/processes/bulk-approve')
      .set(IDEMPOTENCY_HEADER, key)
      .send({ items: [{ id: a.id, version: 99 }] })
      .expect(422);
  });

  it('answers can-start for the acting-as employee', async () => {
    expect((await app.get('/workflow/can-start?type=CLAIMS').expect(200)).body).toEqual({
      type: 'CLAIMS',
      employeeId: applicant.employeeId,
      canStart: true,
    });
    await app.get('/workflow/can-start?type=NOPE').expect(422);
  });
});
