import {
  addDays,
  CLAIM_BALANCE_COLUMNS,
  CLAIM_PROBLEM_TYPES,
  type ClaimBalancesResponse,
  type ClaimDetail,
  type ClaimGroupsResponse,
  type ClaimsResponse,
  type InboxItemDetail,
  type SavedClaimsResponse,
  startOfMonth,
  todayBusinessDate,
  type WorkflowProcessDto,
} from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import { ClaimKit } from '../support/claims';
import {
  type Agent,
  auditSince,
  createPerson,
  createRoleFixtures,
  lastAuditId,
  login,
  type RoleFixtures,
} from '../support/fixtures';
import { WorkflowKit } from '../support/workflow';

/**
 * Claims through the API: caps (WARN stored, BLOCK 422, pro-rata, adjustments), mandatory
 * attachments (group and type, line-level), the balances grid, My Expense Claims filters and
 * status buckets, the audited export, cancel, resubmission, scoping and the admin API.
 */
describe('claims', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let claims: ClaimKit;
  let emp: Agent;
  let mgr: Agent;
  let hr: Agent;
  let payroll: Agent;
  const today = todayBusinessDate();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    claims = new ClaimKit(t, kit);
    await claims.setup(f.org);
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

  async function detail(agent: Agent, id: number): Promise<ClaimDetail> {
    return (await agent.get(`/claims/${id}`).expect(200)).body as ClaimDetail;
  }

  async function submitRaw(agent: Agent, claim: { id: number; version: number }) {
    return agent.post(`/claims/${claim.id}/submit`).send({ version: claim.version });
  }

  describe('caps', () => {
    it('WARN: the claim is submitted and the warning is stored and shown to approvers', async () => {
      const groupId = await claims.group();
      const typeId = await claims.type(groupId, f.org.companyRuleId, {
        inputMode: 'QUANTITY',
        rate: '100',
        caps: [{ companyRuleId: f.org.companyRuleId, mode: 'WARN', amountLimit: '500' }],
      });
      const draft = await claims.create(emp, {
        groupId,
        lines: [{ claimTypeId: typeId, date: today, quantity: '6' }],
      });
      expect(draft.capCheck?.warnings).toHaveLength(1);
      expect(draft.capCheck?.blocks).toEqual([]);
      const submitted = await claims.submit(emp, draft);
      expect(submitted.hasWarnings).toBe(true);
      expect(submitted.warnings).toEqual([
        expect.objectContaining({
          code: 'CAP_EXCEEDED',
          mode: 'WARN',
          claimTypeId: typeId,
          measure: 'AMOUNT',
          limit: '500.00',
          available: '500.00',
          requested: '600.00',
          cycleStartDate: `${year}-01-01`,
          cycleEndDate: `${year}-12-31`,
        }),
      ]);
      const row = await t.db.prisma.claim.findUniqueOrThrow({ where: { id: draft.id } });
      expect(Array.isArray(row.warnings) && row.warnings.length).toBe(1);
      const inbox = (await mgr.get(`/inbox/items/${submitted.processId}`).expect(200))
        .body as InboxItemDetail;
      expect(inbox.warnings).toEqual([
        { code: 'CLAIM_CAP_EXCEEDED', message: submitted.warnings[0]?.message ?? '' },
      ]);
    });

    it('BLOCK: 422 on the line; a payroll adjustment adds headroom; balances show the figures', async () => {
      const groupId = await claims.group();
      const typeId = await claims.type(groupId, f.org.companyRuleId, {
        inputMode: 'QUANTITY',
        rate: '50',
        caps: [{ companyRuleId: f.org.companyRuleId, mode: 'BLOCK', quantityLimit: '5', cycle: 'MONTHLY' }],
      });
      const first = await claims.create(emp, {
        groupId,
        lines: [{ claimTypeId: typeId, date: today, quantity: '3' }],
      });
      await claims.submit(emp, first);
      const second = await claims.create(emp, {
        groupId,
        lines: [{ claimTypeId: typeId, date: today, quantity: '3' }],
      });
      expect(second.capCheck?.blocks).toEqual([
        expect.objectContaining({
          mode: 'BLOCK',
          measure: 'QUANTITY',
          available: '2.0000',
          requested: '3.0000',
        }),
      ]);
      const blocked = await submitRaw(emp, second);
      expect(blocked.status).toBe(422);
      expect(blocked.body.type).toBe(CLAIM_PROBLEM_TYPES.capExceeded);
      expect(blocked.body.errors[0].path).toBe('lines.0.quantity');
      expect((await detail(emp, second.id)).status).toBe('DRAFT');

      const since = await lastAuditId(t.db);
      const adjustment = await payroll.post('/admin/claims/adjustments').send({
        employeeId: f.employee.employeeId,
        claimTypeId: typeId,
        quantity: '1',
        reason: 'Approved extra',
      });
      expect(adjustment.status, adjustment.text).toBe(201);
      expect(adjustment.body).toMatchObject({
        cycle: 'MONTHLY',
        cycleStartDate: startOfMonth(today),
        quantity: '1.0000',
        amount: '0.00',
      });
      expect((await auditSince(t.db, since)).map((r) => r.action)).toContain('CLAIM.BALANCE_ADJUSTED');

      const balances = (await emp.get('/claims/balances').expect(200)).body as ClaimBalancesResponse;
      expect(balances.columns.map((c) => c.label)).toEqual(CLAIM_BALANCE_COLUMNS.map((c) => c.label));
      const row = balances.items.find((r) => r.claimTypeId === typeId);
      expect(row).toEqual({
        claimTypeId: typeId,
        claimType: expect.any(String),
        group: expect.objectContaining({ id: groupId }),
        capId: expect.any(Number),
        cycle: 'MONTHLY',
        cycleStartDate: startOfMonth(today),
        cycleEndDate: expect.stringMatching(new RegExp(`^${today.slice(0, 7)}-\\d{2}$`)),
        amountCappingLimit: null,
        proRataCappingLimit: null,
        pendingAmountClaimed: '150.00',
        amountClaimed: '0.00',
        balanceAdjustmentAmount: '0.00',
        amountAvailable: null,
        quantityCappingLimit: '5.0000',
        pendingQuantityClaimed: '3.0000',
        quantityClaimed: '0.0000',
        balanceAdjustmentQuantity: '1.0000',
        quantityAvailable: '3.0000',
        cappingApplied: 'Block',
        capMode: 'BLOCK',
        proRata: false,
      });
      for (const column of CLAIM_BALANCE_COLUMNS) expect(row).toHaveProperty(column.key);

      const now = await detail(emp, second.id);
      await claims.submit(emp, now);
    });

    it('pro-rata: the limit is months employed in the cycle / 12 of the annual limit', async () => {
      const engaged = `${year}-${String(month).padStart(2, '0')}-01`;
      const joiner = await createPerson(t.db, {
        org: f.org,
        label: 'joiner',
        reportsToId: f.managerB.employeeId,
        employee: { dateEngaged: new Date(`${engaged}T00:00:00Z`) },
      });
      const agent = await login(t, joiner);
      const groupId = await claims.group();
      const typeId = await claims.type(groupId, f.org.companyRuleId, {
        inputMode: 'AMOUNT',
        caps: [{ companyRuleId: f.org.companyRuleId, mode: 'BLOCK', amountLimit: '1200', proRata: true }],
      });
      const limit = ((13 - month) * 100).toFixed(2);
      const balances = (await agent.get('/claims/balances').expect(200)).body as ClaimBalancesResponse;
      expect(balances.items.find((r) => r.claimTypeId === typeId)).toMatchObject({
        amountCappingLimit: '1200.00',
        proRataCappingLimit: limit,
        amountAvailable: limit,
        proRata: true,
      });
      const over = await claims.create(agent, {
        groupId,
        lines: [{ claimTypeId: typeId, date: today, amount: (Number(limit) + 0.01).toFixed(2) }],
      });
      expect((await submitRaw(agent, over)).status).toBe(422);
      const exact = await claims.create(agent, {
        groupId,
        lines: [{ claimTypeId: typeId, date: today, amount: limit }],
      });
      expect((await claims.submit(agent, exact)).status).toBe('IN_PROGRESS');
    });
  });

  describe('mandatory attachments and line attachments', () => {
    it('a group that needs a document: 422 until one is attached', async () => {
      const groupId = await claims.group({ attachmentMandatory: true, description: 'Receipts needed' });
      const typeId = await claims.type(groupId, f.org.companyRuleId, { inputMode: 'AMOUNT' });
      const draft = await claims.create(emp, {
        groupId,
        lines: [{ claimTypeId: typeId, date: today, amount: '80' }],
      });
      expect(draft.attachmentMandatory).toBe(true);
      expect(draft.submitProblems).toEqual([
        { path: 'attachmentIds', message: 'Receipts needed need a supporting document' },
      ]);
      const refused = await submitRaw(emp, draft);
      expect(refused.status).toBe(422);
      expect(refused.body.type).toBe(CLAIM_PROBLEM_TYPES.attachmentRequired);
      const upload = await claims.upload(emp);
      const withFile = (
        await emp
          .put(`/claims/${draft.id}`)
          .send({
            version: draft.version,
            lines: [{ id: draft.lines[0]?.id, claimTypeId: typeId, date: today, amount: '80' }],
            attachmentIds: [upload],
          })
          .expect(200)
      ).body as ClaimDetail;
      expect(withFile.attachments.map((a) => a.id)).toEqual([upload]);
      expect(withFile.submitProblems).toEqual([]);
      await claims.submit(emp, withFile);
    });

    it('a type that needs a document per line; line files reach the approver; removed lines drop theirs', async () => {
      const groupId = await claims.group();
      const typeId = await claims.type(groupId, f.org.companyRuleId, {
        inputMode: 'AMOUNT',
        requiresAttachment: true,
        description: 'S&T Allowance',
      });
      const kept = await claims.upload(emp, 'kept.pdf');
      const dropped = await claims.upload(emp, 'dropped.pdf');
      const draft = await claims.create(emp, {
        groupId,
        lines: [
          { claimTypeId: typeId, date: today, amount: '100' },
          { claimTypeId: typeId, date: today, amount: '50', attachmentIds: [dropped] },
        ],
      });
      expect(draft.lines[1]?.attachments.map((a) => a.id)).toEqual([dropped]);
      const refused = await submitRaw(emp, draft);
      expect(refused.status).toBe(422);
      expect(refused.body.errors).toEqual([
        { path: 'lines.0.attachmentIds', message: 'S&T Allowance needs a supporting document on the line' },
      ]);
      // Attach to the first line and remove the second line (its file goes with it).
      const updated = (
        await emp
          .put(`/claims/${draft.id}`)
          .send({
            version: draft.version,
            lines: [
              {
                id: draft.lines[0]?.id,
                claimTypeId: typeId,
                date: today,
                amount: '100',
                attachmentIds: [kept],
              },
            ],
          })
          .expect(200)
      ).body as ClaimDetail;
      expect(updated.lines).toHaveLength(1);
      expect(updated.totalAmount).toBe('100.00');
      expect(
        (await t.db.prisma.attachment.findUniqueOrThrow({ where: { id: dropped } })).deletedAt,
      ).not.toBeNull();
      expect(
        (await t.db.prisma.claimLine.findUniqueOrThrow({ where: { id: draft.lines[1]?.id ?? 0 } })).deletedAt,
      ).not.toBeNull();
      // An attachment of another claim cannot be removed from this one.
      const stray = await emp
        .put(`/claims/${draft.id}`)
        .send({ version: updated.version, lines: [], removeAttachmentIds: [dropped] });
      expect(stray.status).toBe(422);

      const submitted = await claims.submit(emp, updated);
      const inbox = (await mgr.get(`/inbox/items/${submitted.processId}`).expect(200))
        .body as InboxItemDetail;
      expect(inbox.attachments.map((a) => a.id)).toEqual([kept]);
      await mgr.get(`/attachments/${kept}`).expect(200);
      await (await login(t, f.unrelated)).get(`/attachments/${kept}`).expect(403);
    });
  });

  describe('validation', () => {
    it('refuses a type of another group, times on a non-hours type, a future date and an incomplete line', async () => {
      const groupId = await claims.group();
      const typeId = await claims.type(groupId, f.org.companyRuleId, { inputMode: 'QUANTITY', rate: '10' });
      const otherGroup = await claims.group();
      const otherType = await claims.type(otherGroup, f.org.companyRuleId, { inputMode: 'AMOUNT' });
      const wrongType = await emp
        .post('/claims')
        .send({ groupId, lines: [{ claimTypeId: otherType, date: today, amount: '5' }] });
      expect(wrongType.status).toBe(422);
      expect(wrongType.body.errors[0].path).toBe('lines.0.claimTypeId');
      const times = await emp.post('/claims').send({
        groupId,
        lines: [{ claimTypeId: typeId, date: today, quantity: '1', startTime: '08:00', endTime: '09:00' }],
      });
      expect(times.status).toBe(422);
      expect(times.body.errors[0].path).toBe('lines.0.startTime');

      const draft = await claims.create(emp, {
        groupId,
        lines: [
          { claimTypeId: typeId, date: addDays(today, 3), quantity: '1' },
          { claimTypeId: typeId, date: today },
        ],
      });
      expect(draft.totalAmount).toBe('10.00');
      const refused = await submitRaw(emp, draft);
      expect(refused.status).toBe(422);
      expect(refused.body.errors.map((e: { path: string }) => e.path)).toEqual([
        'lines.0.date',
        'lines.1.quantity',
      ]);
      expect((await submitRaw(emp, { id: draft.id, version: draft.version + 7 })).status).toBe(409);
      const empty = await claims.create(emp, { groupId });
      expect((await submitRaw(emp, empty)).body.errors).toEqual([
        { path: 'lines', message: 'Add at least one claim line' },
      ]);
    });

    it('a group with no eligible type for the company rule cannot be started', async () => {
      const groupId = await claims.group();
      await claims.type(groupId, f.otherOrg.companyRuleId, { inputMode: 'AMOUNT' });
      const res = await emp.post('/claims').send({ groupId });
      expect(res.status).toBe(422);
      expect(res.body.type).toBe(CLAIM_PROBLEM_TYPES.notEligible);
      const tiles = (await emp.get('/claims/groups').expect(200)).body as ClaimGroupsResponse;
      expect(tiles.items.some((g) => g.id === groupId)).toBe(false);
    });
  });

  describe('My Expense Claims', () => {
    let groupId: number;
    let typeId: number;
    const ids: Record<string, number> = {};

    beforeAll(async () => {
      groupId = await claims.group();
      typeId = await claims.type(groupId, f.org.companyRuleId, { inputMode: 'AMOUNT' });
      const e2 = await login(t, f.employee2);
      const make = async (description: string) =>
        claims.create(e2, {
          groupId,
          description,
          lines: [{ claimTypeId: typeId, date: today, amount: '10' }],
        });
      ids.saved = (await make('Saved fuel')).id;
      const inProgress = await make('Pending airport parking');
      ids.inProgress = (await claims.submit(e2, inProgress)).id;
      const declined = await claims.submit(e2, await make('Declined meals'));
      ids.declined = declined.id;
      const p = await kit.process(declined.processId ?? 0);
      await mgr
        .post(`/workflow/processes/${p.id}/decline`)
        .send({ version: p.version, comment: 'Not claimable' })
        .expect(200);
      const withdrawn = await claims.submit(e2, await make('Withdrawn toll'));
      ids.withdrawn = withdrawn.id;
      await e2.post(`/claims/${withdrawn.id}/cancel`).send({ version: withdrawn.version }).expect(200);
      const discarded = await make('Discarded draft');
      ids.discarded = discarded.id;
      await e2.post(`/claims/${discarded.id}/cancel`).send({ version: discarded.version }).expect(200);
    });

    async function list(query: string): Promise<number[]> {
      const res = await hr.get(
        `/claims?scope=company&employeeId=${f.employee2.employeeId}&type=${groupId}&${query}`,
      );
      expect(res.status, res.text).toBe(200);
      return (res.body as ClaimsResponse).items.map((c) => c.id).sort((a, b) => a - b);
    }

    it('maps the status buckets of section 5.3.2', async () => {
      const sorted = (...xs: (number | undefined)[]) => xs.map((x) => x ?? 0).sort((a, b) => a - b);
      expect(await list('status=All')).toEqual(
        sorted(ids.saved, ids.inProgress, ids.declined, ids.withdrawn),
      );
      expect(await list('status=Saved')).toEqual(sorted(ids.saved));
      expect(await list('status=In%20Progress')).toEqual(sorted(ids.inProgress));
      expect(await list(`status=${encodeURIComponent('Cancelled / Declined')}`)).toEqual(
        sorted(ids.declined, ids.withdrawn),
      );
      expect(await list('status=Processed')).toEqual([]);
      expect((await hr.get('/claims?status=Done')).status).toBe(422);
    });

    it('filters by description, group and date, and paginates', async () => {
      expect(await list('description=AIRPORT')).toEqual([ids.inProgress]);
      expect(await list(`from=${addDays(today, 1)}`)).toEqual([]);
      expect((await list(`from=${today}&to=${today}`)).length).toBe(4);
      const page = (await hr.get(`/claims?scope=company&type=${groupId}&pageSize=1&page=2`).expect(200))
        .body as ClaimsResponse;
      expect(page).toMatchObject({ total: 4, page: 2, pageSize: 1 });
      expect(page.items).toHaveLength(1);
      const row = (await hr.get(`/claims?scope=company&type=${groupId}&status=In%20Progress`).expect(200))
        .body as ClaimsResponse;
      expect(row.items[0]).toMatchObject({
        statusLabel: 'In Progress',
        group: { id: groupId },
        employee: { id: f.employee2.employeeId },
        submittedDate: expect.stringMatching(/^\d{2}-[A-Z][a-z]{2}-\d{4}$/),
      });
    });

    it('exports the filtered grid as CSV and Excel, audited EXPORT.CLAIMS', async () => {
      const since = await lastAuditId(t.db);
      const csv = await hr.get(`/claims/export?scope=company&type=${groupId}&format=csv`).expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toMatch(/attachment; filename="expense-claims-.*\.csv"/);
      const text = csv.text;
      expect(text.split('\n')[0]).toContain('Reference Number');
      expect(text).toContain('Pending airport parking');
      expect(text).not.toContain('Discarded draft');
      const xlsx = await hr.get(`/claims/export?scope=company&type=${groupId}&format=xlsx`).expect(200);
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');
      const rows = await auditSince(t.db, since, { action: 'EXPORT.CLAIMS' });
      expect(rows).toHaveLength(2);
      expect(rows[0]?.metadata).toMatchObject({
        format: 'csv',
        rows: 4,
        filters: { type: groupId, scope: 'company' },
      });
    });

    it('scopes the list: own claims, the manager’s reports, HR’s companies', async () => {
      const own = (await (await login(t, f.employee2)).get(`/claims?type=${groupId}`).expect(200))
        .body as ClaimsResponse;
      expect(own.total).toBe(4);
      expect((await emp.get(`/claims?type=${groupId}`).expect(200)).body.total).toBe(0);
      expect((await emp.get(`/claims?employeeId=${f.employee2.employeeId}`)).status).toBe(403);
      expect((await mgr.get(`/claims?scope=reports&type=${groupId}`).expect(200)).body.total).toBe(4);
      expect((await emp.get('/claims?scope=reports')).status).toBe(403);
      expect((await emp.get('/claims?scope=company')).status).toBe(403);
      const unrelated = await login(t, f.unrelated);
      expect((await unrelated.get(`/claims/${ids.inProgress}`)).status).toBe(403);
      const other = await login(t, f.otherCompany);
      expect((await other.get(`/claims/${ids.inProgress}`)).status).toBe(403);
      expect((await hr.get(`/claims/${ids.inProgress}`)).status).toBe(200);
      const otherHr = await createPerson(t.db, { org: f.otherOrg, roles: ['EMPLOYEE', 'HR_ADMIN'] });
      const otherHrAgent = await login(t, otherHr);
      expect((await otherHrAgent.get(`/claims?scope=company&type=${groupId}`).expect(200)).body.total).toBe(
        0,
      );
      expect((await otherHrAgent.get(`/claims/${ids.inProgress}`)).status).toBe(403);
    });
  });

  describe('cancel', () => {
    let groupId: number;
    let typeId: number;

    beforeAll(async () => {
      groupId = await claims.group();
      typeId = await claims.type(groupId, f.org.companyRuleId, { inputMode: 'AMOUNT' });
    });

    const line = () => ({ claimTypeId: typeId, date: today, amount: '20' });

    it('discards a draft', async () => {
      const draft = await claims.create(emp, { groupId, lines: [line()] });
      const since = await lastAuditId(t.db);
      const res = await emp.post(`/claims/${draft.id}/cancel`).send({ version: draft.version }).expect(200);
      expect(res.body).toMatchObject({ status: 'CANCELLED', cancelAction: null, canEdit: false });
      expect((await auditSince(t.db, since)).map((r) => r.action)).toContain('CLAIM.DISCARDED');
      expect(
        (await emp.put(`/claims/${draft.id}`).send({ version: res.body.version, lines: [] })).status,
      ).toBe(409);
    });

    it('withdraws a request nobody has acted on', async () => {
      const submitted = await claims.submit(emp, await claims.create(emp, { groupId, lines: [line()] }));
      const since = await lastAuditId(t.db);
      const res = await emp
        .post(`/claims/${submitted.id}/cancel`)
        .send({ version: submitted.version })
        .expect(200);
      expect(res.body).toMatchObject({ status: 'CANCELLED', statusLabel: 'Cancelled' });
      const actions = (await auditSince(t.db, since)).map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['WORKFLOW.WITHDRAWN', 'CLAIM.WITHDRAWN']));
    });

    it('once approval started only HR or Payroll cancel, with a reason', async () => {
      const submitted = await claims.submit(emp, await claims.create(emp, { groupId, lines: [line()] }));
      await claims.approve(mgr, submitted.processId ?? 0);
      const current = await detail(emp, submitted.id);
      expect(current.cancelAction).toBeNull();
      expect(
        (await emp.post(`/claims/${submitted.id}/cancel`).send({ version: current.version })).status,
      ).toBe(409);
      const asHr = await detail(hr, submitted.id);
      expect(asHr.cancelAction).toBe('CANCEL');
      expect((await hr.post(`/claims/${submitted.id}/cancel`).send({ version: asHr.version })).status).toBe(
        422,
      );
      const res = await hr
        .post(`/claims/${submitted.id}/cancel`)
        .send({ version: asHr.version, comment: 'Duplicate of another claim' })
        .expect(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(
        (await (await login(t, f.unrelated)).post(`/claims/${submitted.id}/cancel`).send({ version: 1 }))
          .status,
      ).toBe(403);
    });
  });

  it('resubmits a sent-back claim with edited lines', async () => {
    const groupId = await claims.group();
    const typeId = await claims.type(groupId, f.org.companyRuleId, { inputMode: 'QUANTITY', rate: '25' });
    const submitted = await claims.submit(
      emp,
      await claims.create(emp, { groupId, lines: [{ claimTypeId: typeId, date: today, quantity: '4' }] }),
    );
    let p = await kit.process(submitted.processId ?? 0);
    await mgr
      .post(`/workflow/processes/${p.id}/send-back`)
      .send({ version: p.version, comment: 'Only 2' })
      .expect(200);
    const sentBack = await detail(emp, submitted.id);
    expect(sentBack).toMatchObject({ status: 'RESUBMIT_REQUIRED', cancelAction: 'WITHDRAW' });
    expect(sentBack.capCheck).toEqual({ warnings: [], blocks: [] });
    p = await kit.process(p.id);
    const bad = await emp
      .post(`/workflow/processes/${p.id}/resubmit`)
      .send({ version: p.version, changes: { lines: [{ claimTypeId: 999999, date: today }] } });
    expect(bad.status).toBe(422);
    const res = await emp.post(`/workflow/processes/${p.id}/resubmit`).send({
      version: p.version,
      changes: { lines: [{ id: sentBack.lines[0]?.id, claimTypeId: typeId, date: today, quantity: '2' }] },
    });
    expect(res.status, res.text).toBe(200);
    expect((res.body as WorkflowProcessDto).status).toBe('IN_PROGRESS');
    expect(await detail(emp, submitted.id)).toMatchObject({ status: 'IN_PROGRESS', totalAmount: '50.00' });
  });

  it('a manager applies for a report (the leave pattern)', async () => {
    const groupId = await claims.group();
    const typeId = await claims.type(groupId, f.org.companyRuleId, { inputMode: 'AMOUNT' });
    const draft = await claims.create(mgr, {
      employeeId: f.employee.employeeId,
      groupId,
      lines: [{ claimTypeId: typeId, date: today, amount: '33.30' }],
    });
    expect(draft.employee.id).toBe(f.employee.employeeId);
    const mine = (await mgr.get(`/claims/saved?groupId=${groupId}`).expect(200)).body as SavedClaimsResponse;
    expect(mine.items.map((c) => c.id)).toEqual([draft.id]);
    const theirs = (await emp.get(`/claims/saved?groupId=${groupId}&sort=applicant`).expect(200))
      .body as SavedClaimsResponse;
    expect(theirs.items.map((c) => c.id)).toEqual([draft.id]);
    const submitted = await claims.submit(mgr, draft);
    const process = await kit.process(submitted.processId ?? 0);
    expect(process.submittedOnBehalf).toBe(true);
    expect(
      (
        await (
          await login(t, f.unrelated)
        )
          .post('/claims')
          .send({ employeeId: f.employee.employeeId, groupId })
      ).status,
    ).toBe(403);
  });

  describe('admin API', () => {
    it('creates, updates and deactivates groups, types and caps, audited', async () => {
      const since = await lastAuditId(t.db);
      const group = await hr
        .post('/admin/claim-groups')
        .send({ code: `ADM${Date.now() % 100000}`, description: 'Admin group' })
        .expect(201);
      expect(
        (await hr.post('/admin/claim-groups').send({ code: group.body.code, description: 'Twin' })).status,
      ).toBe(409);
      const renamed = await hr
        .put(`/admin/claim-groups/${group.body.id}`)
        .send({ version: group.body.version, description: 'Admin claims' })
        .expect(200);
      expect(
        (await hr.put(`/admin/claim-groups/${group.body.id}`).send({ version: 1, description: 'x' })).status,
      ).toBe(409);
      const type = await payroll
        .post('/admin/claim-types')
        .send({ groupId: group.body.id, code: 'S&T', description: 'S&T Allowance', inputMode: 'AMOUNT' })
        .expect(201);
      expect(
        (
          await hr
            .post('/admin/claim-types')
            .send({ groupId: group.body.id, code: 'KM', description: 'Km', inputMode: 'AMOUNT', rate: '4' })
        ).status,
      ).toBe(422);
      const cap = await hr
        .post('/admin/claim-caps')
        .send({
          claimTypeId: type.body.id,
          companyRuleId: f.org.companyRuleId,
          cycle: 'MONTHLY',
          mode: 'WARN',
          amountLimit: '300',
        })
        .expect(201);
      expect(
        (
          await hr
            .post('/admin/claim-caps')
            .send({ claimTypeId: type.body.id, companyRuleId: f.org.companyRuleId, cycle: 'MONTHLY' })
        ).status,
      ).toBe(409);
      expect(
        (
          await hr
            .post('/admin/claim-caps')
            .send({ claimTypeId: type.body.id, cycle: 'ANNUAL', mode: 'BLOCK' })
        ).status,
      ).toBe(422);
      expect(
        (
          await hr
            .post('/admin/claim-caps')
            .send({ claimTypeId: type.body.id, companyRuleId: f.otherOrg.companyRuleId, cycle: 'ANNUAL' })
        ).status,
      ).toBe(403);
      const setup = await emp.get(`/claims/groups/${group.body.id}/setup`).expect(200);
      expect(setup.body.types[0].caps[0]).toMatchObject({
        mode: 'WARN',
        amountLimit: '300.00',
        cycle: 'MONTHLY',
      });
      await hr.delete(`/admin/claim-caps/${cap.body.id}`).send({ version: cap.body.version }).expect(200);
      await hr.delete(`/admin/claim-types/${type.body.id}`).send({ version: type.body.version }).expect(200);
      const off = await hr
        .delete(`/admin/claim-groups/${group.body.id}`)
        .send({ version: renamed.body.version })
        .expect(200);
      expect(off.body.isActive).toBe(false);
      expect(await t.db.prisma.claimGroup.findUnique({ where: { id: group.body.id } })).not.toBeNull();
      expect((await emp.get(`/claims/groups/${group.body.id}/setup`)).status).toBe(404);
      const actions = (await auditSince(t.db, since)).map((r) => r.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'CLAIM_GROUP.CREATED',
          'CLAIM_GROUP.UPDATED',
          'CLAIM_GROUP.DEACTIVATED',
          'CLAIM_TYPE.CREATED',
          'CLAIM_TYPE.DEACTIVATED',
          'CLAIM_CAP.CREATED',
          'CLAIM_CAP.DEACTIVATED',
        ]),
      );
    });
  });
});
