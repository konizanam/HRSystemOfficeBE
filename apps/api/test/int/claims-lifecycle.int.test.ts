import {
  addDays,
  type ClaimBalancesResponse,
  type ClaimDetail,
  type ClaimGroupsResponse,
  type ClaimGroupSetupResponse,
  type ClaimSubjectData,
  formalName,
  type InboxItemDetail,
  type InboxItemsResponse,
  type PayPeriodsResponse,
  type SavedClaimsResponse,
  todayBusinessDate,
} from '@peoplehub/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import { ClaimKit } from '../support/claims';
import {
  type Agent,
  auditSince,
  createOrg,
  createRoleFixtures,
  lastAuditId,
  login,
  type RoleFixtures,
} from '../support/fixtures';
import { WorkflowKit } from '../support/workflow';

/**
 * Section 16.2 for claims: draft → update (version) → submit → approve × 2 → Approved, Pending
 * Process → process → PROCESSED, with the audit rows, the approval history, the inbox detail
 * (with the applicant's company rule), the pay periods filter and the balances afterwards.
 */
describe('claim lifecycle', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let claims: ClaimKit;
  let payPeriodId: number;
  let emp: Agent;
  let mgr: Agent;
  let hr: Agent;
  let payroll: Agent;
  let groupId: number;
  let overtimeId: number;
  let kmId: number;
  const yesterday = addDays(todayBusinessDate(), -1);
  // A line date in the current cycle (the first of the month when today is the 1st).
  const lineDate =
    yesterday.slice(0, 7) === todayBusinessDate().slice(0, 7) ? yesterday : todayBusinessDate();

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    claims = new ClaimKit(t, kit);
    ({ payPeriodId } = await claims.setup(f.org));
    groupId = await claims.group({ description: 'Lifecycle Overtime Claims' });
    overtimeId = await claims.type(groupId, f.org.companyRuleId, {
      inputMode: 'HOURS',
      rateMultiplier: '1.5',
      description: 'Overtime 1.5',
    });
    kmId = await claims.type(groupId, f.org.companyRuleId, {
      inputMode: 'KILOMETRES',
      rate: '4.5',
      description: 'Kilometre Claims',
    });
    await claims.setHourlyRate(f.employee.employeeId, '100');
    [emp, mgr, hr, payroll] = await Promise.all([
      login(t, f.employee),
      login(t, f.managerB),
      login(t, f.hrAdmin),
      login(t, f.payrollAdmin),
    ]);
  });

  afterAll(async () => {
    kit.restore();
    await t.close();
  });

  it('shows the tile and the setup with the resolved rates', async () => {
    const tiles = (await emp.get('/claims/groups').expect(200)).body as ClaimGroupsResponse;
    const tile = tiles.items.find((g) => g.id === groupId);
    expect(tile).toMatchObject({ canStart: true, submittedCount: 0, savedCount: 0, typeCount: 2 });
    // Seeded groups apply to every company rule (global NO_CAP caps).
    expect(tiles.items.some((g) => g.code === 'MSN_OT' && g.description === 'Overtime Claims')).toBe(true);

    const setup = (await emp.get(`/claims/groups/${groupId}/setup`).expect(200))
      .body as ClaimGroupSetupResponse;
    expect(setup.currency).toBe('NAD');
    const ot = setup.types.find((x) => x.id === overtimeId);
    expect(ot).toMatchObject({
      inputMode: 'HOURS',
      usesTimes: true,
      quantityLabel: 'Hours',
      rate: null,
      rateMultiplier: '1.5000',
      effectiveRate: '150.0000',
      rateSource: 'EMPLOYEE_HOURLY_RATE',
    });
    expect(ot?.caps).toEqual([
      expect.objectContaining({ mode: 'NO_CAP', modeLabel: 'No Cap', cycle: 'ANNUAL' }),
    ]);
    expect(setup.types.find((x) => x.id === kmId)).toMatchObject({
      effectiveRate: '4.5000',
      rateSource: 'TYPE',
    });
  });

  it('runs draft → update → submit → approvals → process → PROCESSED', async () => {
    const e = await t.db.prisma.employee.findUniqueOrThrow({ where: { id: f.employee.employeeId ?? 0 } });
    const hrEmployee = await t.db.prisma.employee.findUniqueOrThrow({
      where: { id: f.hrAdmin.employeeId ?? 0 },
    });
    const start = await lastAuditId(t.db);

    // ── Draft ("Saved"): the server computes every amount ──
    const draft = await claims.create(emp, {
      groupId,
      description: 'September call-outs',
      lines: [
        { claimTypeId: overtimeId, date: lineDate, startTime: '17:00', endTime: '19:30', quantity: '9' },
        { claimTypeId: kmId, date: lineDate, quantity: '100', amount: '999.99', description: 'Site visit' },
      ],
    });
    expect(draft).toMatchObject({
      status: 'DRAFT',
      statusLabel: 'Saved',
      statusFilter: 'Saved',
      referenceNumber: null,
      totalAmount: '825.00',
      lineCount: 2,
      canEdit: true,
      canResume: true,
      cancelAction: 'DISCARD',
      approvalHistory: null,
    });
    expect(draft.lines.map((l) => [l.quantity, l.rate, l.amount])).toEqual([
      ['2.5000', '150.0000', '375.00'],
      ['100.0000', '4.5000', '450.00'],
    ]);
    expect(draft.capCheck).toEqual({ warnings: [], blocks: [] });
    expect(draft.submitProblems).toEqual([]);

    const saved = (await emp.get('/claims/saved').expect(200)).body as SavedClaimsResponse;
    expect(saved.items.map((c) => c.id)).toContain(draft.id);
    const tiles = (await emp.get('/claims/groups').expect(200)).body as ClaimGroupsResponse;
    expect(tiles.items.find((g) => g.id === groupId)).toMatchObject({ savedCount: 1, submittedCount: 0 });

    // ── Update with the version read; a stale version is 409 ──
    const [otLine, kmLine] = draft.lines;
    const updateBody = {
      version: draft.version,
      description: 'September call-outs and travel',
      lines: [
        { id: otLine?.id, claimTypeId: overtimeId, date: lineDate, startTime: '17:00', endTime: '19:30' },
        { id: kmLine?.id, claimTypeId: kmId, date: lineDate, quantity: '120' },
      ],
    };
    const updated = (await emp.put(`/claims/${draft.id}`).send(updateBody).expect(200)).body as ClaimDetail;
    expect(updated.version).toBe(draft.version + 1);
    expect(updated.totalAmount).toBe('915.00');
    expect(updated.lines.map((l) => l.id)).toEqual([otLine?.id, kmLine?.id]);
    const stale = await emp.put(`/claims/${draft.id}`).send(updateBody);
    expect(stale.status).toBe(409);

    // ── Submit (Idempotency-Key replay returns the same response) ──
    const key = randomUUID();
    const submitted = await claims.submit(emp, updated, key);
    expect(submitted).toMatchObject({
      status: 'IN_PROGRESS',
      statusLabel: 'In Progress',
      workflowType: 'GROUPEDCLAIM',
      totalAmount: '915.00',
      canEdit: false,
      cancelAction: 'WITHDRAW',
    });
    expect(submitted.referenceNumber).toMatch(
      new RegExp(`^C${e.entityCode}-G${String(groupId).padStart(4, '0')}-N\\d{5}$`),
    );
    const replay = await emp
      .post(`/claims/${draft.id}/submit`)
      .set('idempotency-key', key)
      .send({ version: updated.version });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body).toEqual(submitted);
    const again = await emp
      .post(`/claims/${draft.id}/submit`)
      .set('idempotency-key', randomUUID())
      .send({ version: submitted.version });
    expect(again.status).toBe(409);
    const processId = submitted.processId ?? 0;

    // ── The manager's inbox: card and detail with the applicant's company rule ──
    const action = (await mgr.get('/inbox/items?box=action&type=GROUPEDCLAIM').expect(200))
      .body as InboxItemsResponse;
    const card = action.items.find((c) => c.processId === processId);
    expect(card).toMatchObject({
      requestLabel: 'Lifecycle Overtime Claims',
      category: 'CLAIMS',
      unitsLine: 'NAD 915.00 to be claimed',
      applicant: { companyRuleId: f.org.companyRuleId, companyRule: 'Staff' },
      canAct: true,
    });
    const detail = (await mgr.get(`/inbox/items/${processId}`).expect(200)).body as InboxItemDetail;
    expect(detail.card.applicant.companyRuleId).toBe(f.org.companyRuleId);
    expect(detail.subject.headline).toEqual([{ label: 'Total', value: 'NAD 915.00' }]);
    const data = detail.subject.data as ClaimSubjectData;
    expect(data).toMatchObject({ referenceNumber: submitted.referenceNumber, totalAmount: '915.00' });
    expect(data.lines.map((l) => l.amount)).toEqual(['375.00', '540.00']);
    expect(detail.warnings).toEqual([]);

    // ── Step 1 (manager) and step 2 (HR) ──
    await claims.approve(mgr, processId);
    await claims.approve(hr, processId);
    const pending = (await emp.get(`/claims/${draft.id}`).expect(200)).body as ClaimDetail;
    expect(pending).toMatchObject({
      status: 'APPROVED_PENDING_PROCESS',
      statusLabel: 'Pending Processing',
      statusFilter: 'Pending Processing',
      finalApprover: formalName(hrEmployee),
      cancelAction: null,
    });
    expect(pending.approvedAt).not.toBeNull();
    const history = pending.approvalHistory?.renderedText ?? '';
    expect(history).toContain(`Approval history - ${e.firstName} ${e.lastName} - ${e.employeeCode}`);
    expect(history).toContain(
      'This Lifecycle Overtime Claims Request has been Approved and is waiting to be Processed.',
    );
    expect(history).toContain(`CREATED: New Lifecycle Overtime Claims Request on`);
    expect(history).toContain(`Workflow Process ID: ${processId}`);

    // ── Payroll processes it into a pay period of the employee's company rule ──
    const periods = (
      await payroll.get(`/workflow/pay-periods?companyRuleId=${f.org.companyRuleId}`).expect(200)
    ).body as PayPeriodsResponse;
    expect(periods.items.map((p) => p.id)).toContain(payPeriodId);
    const processed = await payroll
      .post('/workflow/processes/process')
      .send({ ids: [processId], payPeriodId });
    expect(processed.status, processed.text).toBe(200);
    expect(processed.body.results[0]).toMatchObject({ ok: true });
    const done = (await emp.get(`/claims/${draft.id}`).expect(200)).body as ClaimDetail;
    expect(done).toMatchObject({
      status: 'PROCESSED',
      statusLabel: 'Processed',
      payPeriod: { id: payPeriodId },
    });
    expect(done.processedAt).not.toBeNull();

    // ── Audit rows of every step ──
    const rows = await auditSince(t.db, start);
    const claimRows = rows.filter((r) => r.entityType === 'Claim' && r.entityId === String(draft.id));
    expect(claimRows.map((r) => r.action)).toEqual([
      'CLAIM.SAVED',
      'CLAIM.UPDATED',
      'CLAIM.SUBMITTED',
      'CLAIM.APPROVED',
      'CLAIM.PROCESSED',
    ]);
    const workflowRows = rows.filter(
      (r) => r.entityType === 'WorkflowProcess' && r.entityId === String(processId),
    );
    expect(workflowRows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'WORKFLOW.CREATED',
        'WORKFLOW.SUBMITTED',
        'WORKFLOW.APPROVED',
        'WORKFLOW.PROCESSED',
      ]),
    );
    expect(workflowRows.filter((r) => r.action === 'WORKFLOW.APPROVED')).toHaveLength(2);
    const submittedRow = claimRows.find((r) => r.action === 'CLAIM.SUBMITTED');
    expect(submittedRow?.metadata).toMatchObject({ workflowType: 'GROUPEDCLAIM', total: '915.00' });
    expect(claimRows.find((r) => r.action === 'CLAIM.PROCESSED')?.metadata).toMatchObject({ payPeriodId });

    // ── Balances: processed amounts and quantities are "claimed", nothing pending ──
    const balances = (await emp.get('/claims/balances').expect(200)).body as ClaimBalancesResponse;
    const km = balances.items.find((r) => r.claimTypeId === kmId);
    expect(km).toMatchObject({
      pendingAmountClaimed: '0.00',
      amountClaimed: '540.00',
      quantityClaimed: '120.0000',
      cappingApplied: 'No Cap',
      amountAvailable: null,
    });
  });

  it('uses the CLAIMS workflow for a claim of a single claim type', async () => {
    const draft = await claims.create(emp, {
      groupId,
      lines: [{ claimTypeId: kmId, date: lineDate, quantity: '10' }],
    });
    const submitted = await claims.submit(emp, draft);
    expect(submitted).toMatchObject({ workflowType: 'CLAIMS', totalAmount: '45.00' });
    const action = (await mgr.get('/inbox/items?box=action&type=CLAIMS').expect(200))
      .body as InboxItemsResponse;
    expect(action.items.some((c) => c.processId === submitted.processId)).toBe(true);
  });

  it('filters the pay periods by company rule', async () => {
    const other = await createOrg(t.db, 'Pay period filter');
    const all = (await payroll.get('/workflow/pay-periods').expect(200)).body as PayPeriodsResponse;
    expect(all.items.every((p) => !p.isClosed)).toBe(true);
    const filtered = (
      await payroll.get(`/workflow/pay-periods?companyRuleId=${f.org.companyRuleId}`).expect(200)
    ).body as PayPeriodsResponse;
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(filtered.items.every((p) => p.companyRuleId === f.org.companyRuleId)).toBe(true);
    expect(filtered.items.every((p) => p.companyRule === 'Staff')).toBe(true);
    // Another company's rule is outside the admin's companies: nothing is listed.
    await kit.payPeriod(other);
    const outside = (
      await payroll.get(`/workflow/pay-periods?companyRuleId=${other.companyRuleId}`).expect(200)
    ).body as PayPeriodsResponse;
    expect(outside.items).toEqual([]);
    expect((await payroll.get('/workflow/pay-periods?companyRuleId=abc')).status).toBe(422);
  });
});
