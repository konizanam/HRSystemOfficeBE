import { addDays, formatCardDate, todayBusinessDate, WORKFLOW_PROBLEM_TYPES } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { contextFor, type FakeSubjectHandler, TWO_STEP, WorkflowKit } from '../support/workflow';

describe('workflow engine (section 7) with a fake subject handler', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let claims: FakeSubjectHandler;
  let free: FakeSubjectHandler;
  let hr2: Person;
  const agents = new Map<string, Agent>();
  const today = formatCardDate(todayBusinessDate());

  async function as(person: Person): Promise<Agent> {
    const existing = agents.get(person.userId);
    if (existing) return existing;
    const agent = await login(t, person);
    agents.set(person.userId, agent);
    return agent;
  }

  async function formal(person: Person): Promise<string> {
    const e = await t.db.prisma.employee.findFirstOrThrow({ where: { user: { id: person.userId } } });
    return `${e.title} ${e.initials} ${e.lastName}`;
  }

  async function processAudits(id: number) {
    return auditSince(t.db, 0n, { entityType: 'WorkflowProcess', entityId: String(id) });
  }

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    hr2 = await createPerson(t.db, { org: f.org, roles: ['EMPLOYEE', 'HR_ADMIN'], label: 'hr-two' });
    kit = new WorkflowKit(t);
    claims = kit.useFakeHandler('CLAIMS');
    free = kit.useFakeHandler('FREETEXT');
    await kit.definition({ type: 'CLAIMS', companyRuleId: f.org.companyRuleId, steps: TWO_STEP });
    await kit.definition({ type: 'FREETEXT', companyRuleId: f.org.companyRuleId, steps: TWO_STEP });
  });

  afterAll(async () => {
    kit.restore();
    await t.close();
  });

  it('runs the full payroll lifecycle: submit → step 1 → step 2 → pending process → processed', async () => {
    const since = await lastAuditId(t.db);
    const started = await kit.start(claims, f.employee, { comment: 'Please approve' });
    expect(started).toMatchObject({
      status: 'IN_PROGRESS',
      currentStepNo: 1,
      round: 1,
      workflowType: 'CLAIMS',
    });
    const id = started.id;

    const created = await auditSince(t.db, since, { entityType: 'WorkflowProcess', entityId: String(id) });
    expect(created.map((r) => r.action)).toEqual(['WORKFLOW.CREATED', 'WORKFLOW.SUBMITTED']);
    expect(created[0]?.before).toBeNull();
    expect(created[0]?.after).toMatchObject({ status: 'IN_PROGRESS', currentStepNo: 1 });
    expect(created.every((r) => r.category === 'WORKFLOW')).toBe(true);
    expect(await kit.instances(id)).toMatchObject([
      { stepNo: 1, round: 1, status: 'PENDING', assigneeUserId: f.managerB.userId },
    ]);

    // Step 1: manager B sees it in Action Required and approves.
    const mb = await as(f.managerB);
    const inbox = await mb.get('/inbox/items?box=action').expect(200);
    const card = inbox.body.items.find((c: { processId: number }) => c.processId === id);
    expect(card).toMatchObject({ canAct: true, version: started.version, currentStepNo: 1 });
    const r1 = await mb
      .post(`/workflow/processes/${id}/approve`)
      .send({ version: started.version })
      .expect(200);
    expect(r1.body).toMatchObject({ status: 'IN_PROGRESS', currentStepNo: 2 });
    expect(r1.body.version).toBe(started.version + 1);

    // Step 2 (ROLE HR_ADMIN): both HR admins of the company see it.
    const step2 = (await kit.instances(id)).filter((i) => i.stepNo === 2);
    expect(step2.map((i) => i.assigneeUserId).sort()).toEqual([f.hrAdmin.userId, hr2.userId].sort());
    const hr = await as(f.hrAdmin);
    const r2 = await hr
      .post(`/workflow/processes/${id}/approve`)
      .send({ version: r1.body.version, comment: 'Looks fine' })
      .expect(200);
    expect(r2.body).toMatchObject({ status: 'APPROVED_PENDING_PROCESS', currentStepNo: null });
    expect(claims.callsFor(id, 'onFinalApproval')).toMatchObject([{ status: 'APPROVED_PENDING_PROCESS' }]);
    expect(claims.callsFor(id, 'onProcess')).toHaveLength(0);

    const pending = await (await as(f.employee)).get(`/workflow/processes/${id}/history`).expect(200);
    expect(pending.body.statusText).toBe(
      'This Fake Item Request has been Approved and is waiting to be Processed.',
    );
    expect(pending.body.remaining).toEqual([]);

    // Payroll processes it into a pay period.
    const payPeriodId = await kit.payPeriod(f.org);
    const pay = await as(f.payrollAdmin);
    const r3 = await pay
      .post('/workflow/processes/process')
      .send({ ids: [id], payPeriodId })
      .expect(200);
    expect(r3.body).toMatchObject({
      succeeded: 1,
      failed: 0,
      results: [{ processId: id, ok: true, process: { status: 'PROCESSED' } }],
    });
    expect(claims.callsFor(id, 'onProcess')).toMatchObject([
      { payPeriodId, automatic: false, status: 'PROCESSED' },
    ]);

    const p = await kit.process(id);
    expect(p).toMatchObject({ status: 'PROCESSED' });
    expect(p.finalApprovedAt).not.toBeNull();
    expect(p.processedAt).not.toBeNull();
    expect((await kit.actions(id)).map((a) => a.action)).toEqual([
      'CREATE',
      'SUBMIT',
      'APPROVE',
      'APPROVE',
      'PROCESS',
    ]);
    const audits = await processAudits(id);
    expect(audits.map((a) => a.action)).toEqual([
      'WORKFLOW.CREATED',
      'WORKFLOW.SUBMITTED',
      'WORKFLOW.APPROVED',
      'WORKFLOW.APPROVED',
      'WORKFLOW.PROCESSED',
    ]);
    expect(audits[2]).toMatchObject({
      actorUserId: f.managerB.userId,
      subjectEmployeeId: f.employee.employeeId,
    });
    expect(audits[4]?.metadata).toMatchObject({ payPeriodId, toStatus: 'PROCESSED' });
    expect(
      await auditSince(t.db, since, { entityType: 'WorkflowProcess', category: 'DATA_CHANGE' }),
    ).toHaveLength(0);

    // The approval history in the section 1.5 format.
    const history = await (await as(f.auditor)).get(`/workflow/processes/${id}/history`).expect(200);
    const e = await t.db.prisma.employee.findUniqueOrThrow({ where: { id: f.employee.employeeId ?? 0 } });
    expect(history.body.renderedText.split('\n')).toEqual([
      `Approval history - ${e.firstName} ${e.lastName} - ${e.employeeCode}`,
      'Current Status Of Request',
      'This Fake Item Request has been Approved and Processed.',
      'History Of Request',
      `CREATED: New Fake Item Request on ${today} by Applicant ${e.employeeCode} - ${e.title} ${e.initials} ${e.lastName}`,
      'Step 1',
      `Approved by ${await formal(f.managerB)} on ${today}`,
      'Step 2',
      `Approved by ${await formal(f.hrAdmin)} on ${today}`,
      'Comment: Looks fine',
      `PROCESSED: Fake Item Request processed on ${today} by ${await formal(f.payrollAdmin)}`,
      `Workflow Process ID: ${id}`,
    ]);
    expect(history.body.events.map((ev: { action: string }) => ev.action)).toEqual([
      'CREATE',
      'SUBMIT',
      'APPROVE',
      'APPROVE',
      'PROCESS',
    ]);

    // Notifications are created from the outbox after commit.
    await kit.publish();
    expect((await kit.notifications(f.managerB.userId, id)).map((n) => n.kind)).toEqual([
      'WORKFLOW_SUBMITTED',
    ]);
    expect((await kit.notifications(hr2.userId, id)).map((n) => n.kind)).toEqual([
      'WORKFLOW_APPROVAL_REQUIRED',
    ]);
    expect((await kit.notifications(f.employee.userId, id)).map((n) => n.kind)).toEqual([
      'WORKFLOW_STEP_APPROVED',
      'WORKFLOW_APPROVED',
      'WORKFLOW_PROCESSED',
    ]);
    const mails = t.mail.sentTo(f.employee.email ?? '').filter((m) => m.text.includes(`/inbox/items/${id}`));
    expect(mails.map((m) => m.template)).toEqual([
      'workflow-step-approved',
      'workflow-approved',
      'workflow-processed',
    ]);
    // No PII beyond the first name, the request type and a link.
    for (const mail of mails) {
      expect(mail.html).toContain(`Hi ${e.firstName},`);
      expect(mail.html).not.toContain(e.lastName);
      expect(mail.html).not.toContain(e.employeeCode);
    }
  });

  it('applies non-payroll types straight away (PROCESSED on the last approval)', async () => {
    const p = await kit.start(free, f.employee);
    const r1 = await (
      await as(f.managerB)
    )
      .post(`/workflow/processes/${p.id}/approve`)
      .send({ version: p.version })
      .expect(200);
    const r2 = await (
      await as(hr2)
    )
      .post(`/workflow/processes/${p.id}/approve`)
      .send({ version: r1.body.version })
      .expect(200);
    expect(r2.body.status).toBe('PROCESSED');
    expect(free.callsFor(p.id).map((c) => c.hook)).toEqual(['onFinalApproval']);
    expect((await kit.actions(p.id)).map((a) => a.action).slice(-2)).toEqual(['APPROVE', 'APPLY']);
    expect((await processAudits(p.id)).map((a) => a.action).slice(-2)).toEqual([
      'WORKFLOW.APPROVED',
      'WORKFLOW.APPLIED',
    ]);
  });

  it('ends in CONFLICT when the handler cannot apply the change, and alerts HR', async () => {
    const p = await kit.start(free, f.employee2);
    const r1 = await (
      await as(f.managerB)
    )
      .post(`/workflow/processes/${p.id}/approve`)
      .send({ version: p.version })
      .expect(200);
    free.finalResult = { outcome: 'CONFLICT', reason: 'The record changed' };
    try {
      const r2 = await (
        await as(f.hrAdmin)
      )
        .post(`/workflow/processes/${p.id}/approve`)
        .send({ version: r1.body.version })
        .expect(200);
      expect(r2.body.status).toBe('CONFLICT');
    } finally {
      free.finalResult = { outcome: 'APPLIED' };
    }
    expect((await kit.actions(p.id)).at(-1)).toMatchObject({ action: 'CONFLICT', toStatus: 'CONFLICT' });
    await kit.publish();
    expect((await kit.notifications(hr2.userId, p.id)).map((n) => n.kind)).toContain('WORKFLOW_CONFLICT');
  });

  it('processes automatically on final approval when workflow.autoProcess.{TYPE} is on', async () => {
    const payPeriodId = await kit.payPeriod(f.org);
    const restore = await kit.setting('workflow.autoProcess.CLAIMS', true);
    try {
      const p = await kit.start(claims, f.employee);
      const r1 = await (
        await as(f.managerB)
      )
        .post(`/workflow/processes/${p.id}/approve`)
        .send({ version: p.version })
        .expect(200);
      const r2 = await (
        await as(f.hrAdmin)
      )
        .post(`/workflow/processes/${p.id}/approve`)
        .send({ version: r1.body.version })
        .expect(200);
      expect(r2.body.status).toBe('PROCESSED');
      expect(claims.callsFor(p.id, 'onProcess')).toMatchObject([{ payPeriodId, automatic: true }]);
      expect((await kit.actions(p.id)).at(-1)).toMatchObject({
        action: 'PROCESS',
        actorUserId: '00000000-0000-0000-0000-000000000000',
      });
    } finally {
      await restore();
    }
  });

  it('declines with a required comment and tells the applicant', async () => {
    const p = await kit.start(claims, f.employee2);
    const mb = await as(f.managerB);
    await mb
      .post(`/workflow/processes/${p.id}/decline`)
      .send({ version: p.version, comment: ' ' })
      .expect(422);
    const res = await mb
      .post(`/workflow/processes/${p.id}/decline`)
      .send({ version: p.version, comment: 'Not budgeted' })
      .expect(200);
    expect(res.body.status).toBe('DECLINED');
    expect(claims.callsFor(p.id, 'onDeclined')).toMatchObject([
      { comment: 'Not budgeted', status: 'DECLINED' },
    ]);
    expect((await processAudits(p.id)).at(-1)).toMatchObject({
      action: 'WORKFLOW.DECLINED',
      reason: 'Not budgeted',
    });
    await kit.publish();
    const [note] = await kit.notifications(f.employee2.userId, p.id);
    expect(note).toMatchObject({ kind: 'WORKFLOW_DECLINED' });
    expect(note?.body).toContain('Not budgeted');
    const mail = t.mail.sentTo(f.employee2.email ?? '').find((m) => m.text.includes(`/inbox/items/${p.id}`));
    expect(mail?.template).toBe('workflow-declined');
    expect(mail?.html).not.toContain('Not budgeted');
  });

  it('sends back for resubmission and starts a new round on resubmit', async () => {
    const p = await kit.start(claims, f.employee);
    const mb = await as(f.managerB);
    const sent = await mb
      .post(`/workflow/processes/${p.id}/send-back`)
      .send({ version: p.version, comment: 'Add the receipt' })
      .expect(200);
    expect(sent.body).toMatchObject({ status: 'RESUBMIT_REQUIRED', currentStepNo: null });
    expect(claims.callsFor(p.id, 'onSentBack')).toMatchObject([{ comment: 'Add the receipt' }]);
    await mb.post(`/workflow/processes/${p.id}/approve`).send({ version: sent.body.version }).expect(403);
    await (
      await as(f.hrAdmin)
    )
      .post(`/workflow/processes/${p.id}/resubmit`)
      .send({ version: sent.body.version })
      .expect(403);

    const resubmitted = await (
      await as(f.employee)
    )
      .post(`/workflow/processes/${p.id}/resubmit`)
      .send({ version: sent.body.version, comment: 'Receipt attached', changes: { amount: '12.00' } })
      .expect(200);
    expect(resubmitted.body).toMatchObject({ status: 'IN_PROGRESS', round: 2, currentStepNo: 1 });
    expect(claims.callsFor(p.id, 'onResubmitted')).toMatchObject([
      { round: 2, changes: { amount: '12.00' }, comment: 'Receipt attached' },
    ]);
    expect(
      (await kit.instances(p.id)).map((i) => ({ round: i.round, stepNo: i.stepNo, status: i.status })),
    ).toEqual([
      { round: 1, stepNo: 1, status: 'SENT_BACK' },
      { round: 2, stepNo: 1, status: 'PENDING' },
    ]);
    const history = await mb.get(`/workflow/processes/${p.id}/history`).expect(200);
    const lines: string[] = history.body.renderedText.split('\n');
    expect(lines.filter((l) => l === 'Step 1')).toHaveLength(2);
    expect(lines).toContain(`Sent back for resubmission by ${await formal(f.managerB)} on ${today}`);
    expect(lines).toContain('Comment: Add the receipt');
    expect(lines.some((l) => l.startsWith('RESUBMITTED: Fake Item Request resubmitted on'))).toBe(true);
    expect(history.body.remaining).toMatchObject([
      { stepNo: 1, isCurrent: true, approvers: [{ userId: f.managerB.userId }] },
      { stepNo: 2, isCurrent: false, roleLabel: 'Any HR Administrator' },
    ]);
    expect(lines.slice(-6)).toEqual([
      'Remaining Approvers',
      'Step 1',
      `${await formal(f.managerB)} (Mandatory)`,
      'Step 2',
      'Any HR Administrator (Mandatory)',
      `Workflow Process ID: ${p.id}`,
    ]);
    expect((await processAudits(p.id)).map((a) => a.action)).toEqual(
      expect.arrayContaining(['WORKFLOW.SENT_BACK', 'WORKFLOW.RESUBMITTED']),
    );
    await kit.publish();
    expect((await kit.notifications(f.employee.userId, p.id)).map((n) => n.kind)).toContain(
      'WORKFLOW_SENT_BACK',
    );
    expect((await kit.notifications(f.managerB.userId, p.id)).map((n) => n.kind)).toEqual([
      'WORKFLOW_SUBMITTED',
      'WORKFLOW_SUBMITTED',
    ]);
  });

  it('parks a step out of Action Required and brings it back at parkUntil', async () => {
    const p = await kit.start(claims, f.employee2);
    const mb = await as(f.managerB);
    const tomorrowish = addDays(todayBusinessDate(), 3);
    await mb
      .post(`/workflow/processes/${p.id}/park`)
      .send({ version: p.version, until: todayBusinessDate() })
      .expect(422);
    const parked = await mb
      .post(`/workflow/processes/${p.id}/park`)
      .send({ version: p.version, until: tomorrowish, comment: 'After month end' })
      .expect(200);
    const ids = async () =>
      (await mb.get('/inbox/items?box=action&pageSize=100').expect(200)).body.items.map(
        (c: { processId: number }) => c.processId,
      );
    expect(await ids()).not.toContain(p.id);
    const detail = await mb.get(`/inbox/items/${p.id}`).expect(200);
    expect(detail.body.allowedActions).toContain('APPROVE');
    expect(detail.body.card.parkedUntil).toEqual(expect.any(String));
    expect((await processAudits(p.id)).at(-1)).toMatchObject({ action: 'WORKFLOW.PARKED' });

    // Time passes: once parkUntil is reached the item shows again, and the job flips it back.
    await t.db.prisma.workflowStepInstance.updateMany({
      where: { processId: p.id, status: 'PARKED' },
      data: { parkedUntil: new Date(Date.now() - 60_000) },
    });
    expect(await ids()).toContain(p.id);
    const counts = await kit.jobs.runNow('workflow.unpark');
    expect(Number(counts.unparked)).toBeGreaterThanOrEqual(1);
    expect((await kit.instances(p.id))[0]).toMatchObject({ status: 'PENDING' });
    expect((await kit.actions(p.id)).at(-1)).toMatchObject({ action: 'UNPARK' });
    expect((await processAudits(p.id)).at(-1)).toMatchObject({ action: 'WORKFLOW.UNPARKED' });
    // Unparking is not a user change: the version the approver holds still works.
    expect((await kit.process(p.id)).version).toBe(parked.body.version);
    await kit.publish();
    expect((await kit.notifications(f.managerB.userId, p.id)).map((n) => n.kind)).toContain(
      'WORKFLOW_PARKED_DUE',
    );
    await mb.post(`/workflow/processes/${p.id}/approve`).send({ version: parked.body.version }).expect(200);
  });

  it('reassigns a step to another approver', async () => {
    const p = await kit.start(claims, f.employee);
    const mb = await as(f.managerB);
    const url = `/workflow/processes/${p.id}/reassign`;
    await mb.post(url).send({ version: p.version, toUserId: f.employee.userId }).expect(422);
    await mb.post(url).send({ version: p.version, toUserId: f.otherCompany.userId }).expect(422);
    await mb.post(url).send({ version: p.version, toUserId: f.managerB.userId }).expect(422);
    const moved = await mb
      .post(url)
      .send({ version: p.version, toUserId: f.managerA.userId, comment: 'Please cover' })
      .expect(200);
    expect(moved.body).toMatchObject({ status: 'IN_PROGRESS', currentStepNo: 1 });
    expect((await kit.instances(p.id)).map((i) => [i.assigneeUserId, i.status])).toEqual([
      [f.managerB.userId, 'REASSIGNED'],
      [f.managerA.userId, 'PENDING'],
    ]);
    await mb.post(`/workflow/processes/${p.id}/approve`).send({ version: moved.body.version }).expect(403);
    const audit = (await processAudits(p.id)).at(-1);
    expect(audit).toMatchObject({ action: 'WORKFLOW.REASSIGNED', reason: 'Please cover' });
    expect(audit?.metadata).toMatchObject({ fromUserId: f.managerB.userId, toUserId: f.managerA.userId });
    await (
      await as(f.managerA)
    )
      .post(`/workflow/processes/${p.id}/approve`)
      .send({ version: moved.body.version })
      .expect(200);
    await kit.publish();
    expect((await kit.notifications(f.managerA.userId, p.id)).map((n) => n.kind)).toContain(
      'WORKFLOW_REASSIGNED',
    );
  });

  it('honours the definition flags (reassign, park, send back) of the most specific definition', async () => {
    const discriminator = `LOCKED-${Date.now()}`;
    await kit.definition({
      type: 'CLAIMS',
      companyRuleId: f.org.companyRuleId,
      discriminator,
      steps: TWO_STEP,
      allowReassign: false,
      allowResubmit: false,
      canPark: false,
    });
    const p = await kit.start(claims, f.employee, { discriminator });
    const mb = await as(f.managerB);
    const base = `/workflow/processes/${p.id}`;
    const reassign = await mb
      .post(`${base}/reassign`)
      .send({ version: p.version, toUserId: f.managerA.userId });
    expect(reassign.status).toBe(422);
    expect(reassign.body.type).toBe(WORKFLOW_PROBLEM_TYPES.notAllowed);
    await mb
      .post(`${base}/park`)
      .send({ version: p.version, until: addDays(todayBusinessDate(), 2) })
      .expect(422);
    await mb.post(`${base}/send-back`).send({ version: p.version, comment: 'x' }).expect(422);
    const detail = await mb.get(`/inbox/items/${p.id}`).expect(200);
    expect(detail.body.allowedActions.sort()).toEqual(['APPROVE', 'COMMENT', 'DECLINE']);
  });

  it('lets only the applicant withdraw', async () => {
    const p = await kit.start(claims, f.employee);
    await (
      await as(f.managerB)
    )
      .post(`/workflow/processes/${p.id}/withdraw`)
      .send({ version: p.version })
      .expect(403);
    const emp = await as(f.employee);
    const res = await emp
      .post(`/workflow/processes/${p.id}/withdraw`)
      .send({ version: p.version })
      .expect(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(claims.callsFor(p.id, 'onCancelled')).toMatchObject([{ reason: 'WITHDRAWN' }]);
    expect((await kit.instances(p.id))[0]?.status).toBe('CANCELLED');
    expect((await processAudits(p.id)).at(-1)).toMatchObject({ action: 'WORKFLOW.WITHDRAWN' });
    await emp.post(`/workflow/processes/${p.id}/withdraw`).send({ version: res.body.version }).expect(409);
    await kit.publish();
    expect((await kit.notifications(f.managerB.userId, p.id)).map((n) => n.kind)).toContain(
      'WORKFLOW_CANCELLED',
    );
    expect((await kit.notifications(f.employee.userId, p.id)).map((n) => n.kind)).not.toContain(
      'WORKFLOW_CANCELLED',
    );
  });

  it('returns 409 on a stale version and never lets the applicant approve', async () => {
    const p = await kit.start(claims, f.employee);
    const stale = await (
      await as(f.managerB)
    )
      .post(`/workflow/processes/${p.id}/approve`)
      .send({ version: p.version + 5 })
      .expect(409);
    expect(stale.body.current).toEqual({ version: p.version });
    const own = await (
      await as(f.employee)
    )
      .post(`/workflow/processes/${p.id}/approve`)
      .send({ version: p.version })
      .expect(403);
    expect(own.body.type).toBe(WORKFLOW_PROBLEM_TYPES.ownRequest);

    // A step configured to the applicant themself goes to HR instead (mandatory, no skip).
    const discriminator = `SELF-${Date.now()}`;
    await kit.definition({
      type: 'CLAIMS',
      companyRuleId: f.org.companyRuleId,
      discriminator,
      steps: [{ resolution: 'SPECIFIC_USER', userId: f.employee.userId, skipIfSameApprover: false }],
    });
    const self = await kit.start(claims, f.employee, { discriminator });
    const assignees = (await kit.instances(self.id)).map((i) => i.assigneeUserId).sort();
    expect(assignees).toEqual([f.hrAdmin.userId, hr2.userId].sort());
    await (
      await as(f.employee)
    )
      .post(`/workflow/processes/${self.id}/approve`)
      .send({ version: self.version })
      .expect(403);
    // Nor can the step be reassigned to the applicant.
    await (
      await as(f.hrAdmin)
    )
      .post(`/workflow/processes/${self.id}/reassign`)
      .send({ version: self.version, toUserId: f.employee.userId })
      .expect(422);
  });

  it('auto-skips steps (same approver as applicant, as the previous step, no approver) and audits AUTO_SKIP', async () => {
    // Manager B submits for their report: step 1 would be manager B themself.
    const onBehalf = await kit.start(claims, f.managerB, { subject: f.employee });
    expect(onBehalf.currentStepNo).toBe(2);
    expect((await kit.instances(onBehalf.id)).map((i) => [i.stepNo, i.status])).toEqual([
      [1, 'SKIPPED'],
      [2, 'PENDING'],
      [2, 'PENDING'],
    ]);
    const skipAudit = (await processAudits(onBehalf.id)).find((a) => a.action === 'WORKFLOW.AUTO_SKIPPED');
    expect(skipAudit?.metadata).toMatchObject({ reason: 'SAME_AS_APPLICANT', stepNo: 1 });

    // Two REPORTS_TO steps: the second is the same approver, so approving the first finishes.
    const same = `SAME-${Date.now()}`;
    await kit.definition({
      type: 'CLAIMS',
      companyRuleId: f.org.companyRuleId,
      discriminator: same,
      steps: [{ resolution: 'REPORTS_TO' }, { resolution: 'REPORTS_TO' }],
    });
    const twice = await kit.start(claims, f.employee, { discriminator: same });
    const approved = await (
      await as(f.managerB)
    )
      .post(`/workflow/processes/${twice.id}/approve`)
      .send({ version: twice.version })
      .expect(200);
    expect(approved.body.status).toBe('APPROVED_PENDING_PROCESS');
    expect((await kit.actions(twice.id)).map((a) => a.action).slice(-2)).toEqual(['APPROVE', 'AUTO_SKIP']);

    // An optional step with no approver (manager A has no second-level manager) is skipped.
    const optional = `OPT-${Date.now()}`;
    await kit.definition({
      type: 'CLAIMS',
      companyRuleId: f.org.companyRuleId,
      discriminator: optional,
      steps: [
        { resolution: 'REPORTS_TO_LEVEL_2', isMandatory: false },
        { resolution: 'ROLE', role: 'HR_ADMIN' },
      ],
    });
    const opt = await kit.start(claims, f.managerA, { discriminator: optional });
    expect(opt.currentStepNo).toBe(2);
    const optAudit = (await processAudits(opt.id)).find((a) => a.action === 'WORKFLOW.AUTO_SKIPPED');
    expect(optAudit?.metadata).toMatchObject({ reason: 'NO_APPROVER' });
  });

  it('refuses to start when a mandatory step has nobody to approve it', async () => {
    await kit.definition({
      type: 'CLAIMS',
      companyRuleId: f.otherOrg.companyRuleId,
      steps: [{ resolution: 'REPORTS_TO' }],
    });
    await expect(kit.start(claims, f.otherCompany)).rejects.toMatchObject({
      status: 422,
      type: WORKFLOW_PROBLEM_TYPES.noApprover,
    });
    expect(
      await t.db.prisma.workflowProcess.count({
        where: { subjectEmployeeId: f.otherCompany.employeeId ?? 0 },
      }),
    ).toBe(0);
    // Nor for someone the submitter may not act for.
    await expect(kit.start(claims, f.employee, { subject: f.otherCompany })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('gives a ROLE step to every holder; the first to act wins', async () => {
    const p = await kit.start(claims, f.employee2);
    const r1 = await (
      await as(f.managerB)
    )
      .post(`/workflow/processes/${p.id}/approve`)
      .send({ version: p.version })
      .expect(200);
    for (const person of [f.hrAdmin, hr2]) {
      const box = await (
        await as(person)
      )
        .get('/inbox/items?box=action&type=CLAIMS&pageSize=100')
        .expect(200);
      expect(box.body.items.map((c: { processId: number }) => c.processId)).toContain(p.id);
    }
    const won = await (
      await as(hr2)
    )
      .post(`/workflow/processes/${p.id}/approve`)
      .send({ version: r1.body.version })
      .expect(200);
    const late = await as(f.hrAdmin);
    await late.post(`/workflow/processes/${p.id}/approve`).send({ version: r1.body.version }).expect(409);
    await late.post(`/workflow/processes/${p.id}/approve`).send({ version: won.body.version }).expect(403);
    const step2 = (await kit.instances(p.id)).filter((i) => i.stepNo === 2);
    expect(step2.find((i) => i.assigneeUserId === hr2.userId)).toMatchObject({
      status: 'APPROVED',
      actedByUserId: hr2.userId,
    });
    expect(step2.find((i) => i.assigneeUserId === f.hrAdmin.userId)?.status).toBe('SUPERSEDED');
  });

  it('records comments from the applicant and approvers', async () => {
    const p = await kit.start(claims, f.employee);
    const c1 = await (
      await as(f.employee)
    )
      .post(`/workflow/processes/${p.id}/comment`)
      .send({ version: p.version, comment: 'Receipt is in the post' })
      .expect(200);
    const c2 = await (
      await as(f.managerB)
    )
      .post(`/workflow/processes/${p.id}/comment`)
      .send({ version: c1.body.version, comment: 'Thanks' })
      .expect(200);
    await (
      await as(f.unrelated)
    )
      .post(`/workflow/processes/${p.id}/comment`)
      .send({ version: c2.body.version, comment: 'Hello' })
      .expect(403);
    const detail = await (await as(f.managerB)).get(`/inbox/items/${p.id}`).expect(200);
    expect(detail.body.comments.map((c: { comment: string }) => c.comment)).toEqual([
      'Receipt is in the post',
      'Thanks',
    ]);
    expect((await processAudits(p.id)).filter((a) => a.action === 'WORKFLOW.COMMENTED')).toHaveLength(2);
  });

  it('shows the history to the applicant, approvers, HR/Payroll in scope and auditors only', async () => {
    const p = await kit.start(claims, f.employee);
    const url = `/workflow/processes/${p.id}/history`;
    for (const person of [f.employee, f.managerB, f.hrAdmin, f.payrollAdmin, f.auditor]) {
      await (await as(person)).get(url).expect(200);
    }
    for (const person of [f.unrelated, f.otherCompany, f.sysAdmin, f.managerA]) {
      const since = await lastAuditId(t.db);
      const res = await (await as(person)).get(url).expect(403);
      const rows = await auditSince(t.db, since, { requestId: res.headers['x-request-id'] as string });
      expect(rows.some((r) => r.outcome === 'DENIED')).toBe(true);
    }
    await (await as(f.auditor)).get('/workflow/processes/999999999/history').expect(404);
  });

  it('processes in bulk with per-item results and checks the pay period', async () => {
    const pay = await as(f.payrollAdmin);
    const payPeriodId = await kit.payPeriod(f.org);
    const inFlight = await kit.start(claims, f.employee);
    // The fixture company rule is new in every run, so this period is always created closed.
    const closed = await kit.payPeriod(f.org, { closed: true, month: '2020-01-01' });
    const closedRes = await pay
      .post('/workflow/processes/process')
      .send({ ids: [inFlight.id], payPeriodId: closed })
      .expect(422);
    expect(closedRes.body.errors).toEqual([{ path: 'payPeriodId', message: 'This pay period is closed' }]);
    await pay
      .post('/workflow/processes/process')
      .send({ ids: [inFlight.id], payPeriodId: 999_999_999 })
      .expect(422);

    // Another company's approved item: outside the payroll admin's scope.
    await kit.definition({
      type: 'CLAIMS',
      companyRuleId: f.otherOrg.companyRuleId,
      discriminator: 'OTHER-HR',
      steps: [{ resolution: 'SPECIFIC_USER', userId: f.hrAdmin.userId }],
    });
    const other = await kit.start(claims, f.otherCompany, { discriminator: 'OTHER-HR' });
    await (
      await as(f.hrAdmin)
    )
      .post(`/workflow/processes/${other.id}/approve`)
      .send({ version: other.version })
      .expect(200);

    const since = await lastAuditId(t.db);
    const res = await pay
      .post('/workflow/processes/process')
      .send({ ids: [inFlight.id, other.id], payPeriodId })
      .expect(200);
    expect(res.body).toMatchObject({
      succeeded: 0,
      failed: 2,
      results: [
        { processId: inFlight.id, ok: false, error: { status: 409 } },
        { processId: other.id, ok: false, error: { status: 403 } },
      ],
    });
    const denied = await auditSince(t.db, since, { outcome: 'DENIED', entityId: String(other.id) });
    expect(denied).toHaveLength(1);
    await (
      await as(f.hrAdmin)
    )
      .post('/workflow/processes/process')
      .send({ ids: [inFlight.id], payPeriodId })
      .expect(403);
  });

  it('starts as the submitter on behalf of a report and records it', async () => {
    const p = await kit.engine.start(contextFor(f.managerB), {
      type: 'FREETEXT',
      subjectEntity: 'FakeSubject',
      subjectEntityId: `fake-behalf-${Date.now()}`,
      subjectEmployeeId: f.employee2.employeeId ?? 0,
      summary: 'On behalf',
    });
    const row = await kit.process(p.id);
    expect(row).toMatchObject({ submittedByUserId: f.managerB.userId, submittedOnBehalf: true });
    const history = await (await as(f.employee2)).get(`/workflow/processes/${p.id}/history`).expect(200);
    expect(history.body).toMatchObject({
      submittedOnBehalf: true,
      submittedBy: { userId: f.managerB.userId },
    });
  });
});
