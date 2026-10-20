import {
  addDays,
  addMonths,
  type BankAccountsResponse,
  type BankAccountUnmasked,
  type BankBranchesResponse,
  type BanksResponse,
  CHANGE_PENDING_MESSAGE,
  type InboxItemDetail,
  type InboxItemsResponse,
  NO_CHANGES_MESSAGE,
  startOfMonth,
  todayBusinessDate,
} from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import { DetailsKit } from '../support/details';
import {
  type Agent,
  asJson,
  auditSince,
  createPerson,
  createRoleFixtures,
  lastAuditId,
  login,
  type Person,
  type RoleFixtures,
} from '../support/fixtures';
import { WorkflowKit } from '../support/workflow';

describe('My Details: bank details (section 5.4.2)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let details: DetailsKit;
  let emp: Agent;
  let emp2: Agent;
  let manager: Agent;
  let payroll: Agent;
  let hr: Agent;
  let nextPeriodStart = '';
  let seededAccountId = 0;
  let newAccountId = 0;

  const accounts = async (agent: Agent): Promise<BankAccountsResponse> =>
    (await agent.get('/me/bank-accounts').expect(200)).body as BankAccountsResponse;

  const expectDenied = async (res: { status: number; headers: Record<string, unknown> }, since: bigint) => {
    expect(res.status).toBe(403);
    const rows = await auditSince(t.db, since, { requestId: res.headers['x-request-id'] as string });
    expect(rows.some((r) => r.outcome === 'DENIED')).toBe(true);
  };

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    details = new DetailsKit(t, kit);
    await details.setup(f.org);
    await kit.payPeriod(f.org);
    nextPeriodStart = startOfMonth(addMonths(todayBusinessDate(), 1));
    await kit.payPeriod(f.org, { month: nextPeriodStart });
    seededAccountId = await details.account(f.employee, '6200123456');
    [emp, emp2, manager, payroll, hr] = await Promise.all([
      login(t, f.employee),
      login(t, f.employee2),
      login(t, f.managerB),
      login(t, f.payrollAdmin),
      login(t, f.hrAdmin),
    ]);
  });

  afterAll(async () => {
    kit.restore();
    await t.close();
  });

  it('lists the 40 observed banks and the observed branches', async () => {
    const banks = (await emp.get('/banks').expect(200)).body as BanksResponse;
    const names = banks.items.map((b) => b.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'ABN Amro Bank',
        'ABSA',
        'African Bank',
        'Bank of Athens',
        'Bank of Windhoek',
        'Bank BIC',
        'Bank Atlantico',
        'FNB Namibia',
      ]),
    );
    expect(names.length).toBeGreaterThanOrEqual(40);
    const windhoek = banks.items.find((b) => b.name === 'Bank of Windhoek');
    const branches = (await emp.get(`/banks/${windhoek?.id}/branches`).expect(200))
      .body as BankBranchesResponse;
    expect(branches.items.map((b) => b.name)).toEqual(
      expect.arrayContaining([
        'Universal Code',
        'Main Branch',
        'Exclusive Banking',
        'Oshikango',
        'Ausspanplatz',
        'Swakopmund',
        'Katutura',
        'Henties Bay',
      ]),
    );
    expect(branches.items.find((b) => b.name === 'Universal Code')?.code).toBe('483872');
    await emp.get('/banks/999999999/branches').expect(404);
  });

  it('shows the existing accounts masked, with the grid columns', async () => {
    const list = await accounts(emp);
    expect(list.heading).toMatch(/^Bank Details for: First\d+ Last\d+$/);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      id: seededAccountId,
      accountNumberMasked: '••••3456',
      accountHolderRelationship: 'OWN',
      accountHolderRelationshipLabel: 'Own',
      accountType: 'CURRENT',
      accountTypeLabel: 'Current Account',
      bankName: 'Bank of Windhoek',
      currency: 'NAD',
      isActive: true,
    });
    expect(asJson(list)).not.toContain('6200123456');
  });

  it('requires a supporting document for every bank change', async () => {
    const { bankId, branchId } = await details.bank();
    const res = await emp.post('/me/bank-accounts').send({
      accountType: 'SAVINGS',
      accountHolderName: 'Third Party Holder',
      accountHolderRelationship: 'THIRD_PARTY',
      bankId,
      branchId,
      accountNumber: '1234567890',
      attachmentIds: [],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toContainEqual({
      path: 'attachmentIds',
      message: 'Attach a supporting document',
    });
  });

  it('applies an approved change from the next pay period and emails the employee (submitted by the manager)', async () => {
    const { bankId, branchId } = await details.bank('FNB Namibia');
    const acting = await login(t, f.managerB);
    await acting.put('/session/acting-as').send({ employeeId: f.employee.employeeId }).expect(200);
    const doc = await details.upload(acting, 'bank-letter.pdf');
    const since = await lastAuditId(t.db);
    const body = details.submitted(
      await acting.post('/me/bank-accounts').send({
        accountType: 'SAVINGS',
        accountHolderName: 'Joint Holders',
        accountHolderRelationship: 'JOINT',
        bankId,
        branchId,
        accountNumber: '620 0998 8776',
        attachmentIds: [doc],
      }),
      201,
    );
    const cr = body.changeRequest;
    expect(cr).toMatchObject({
      workflowType: 'BANKDET',
      operation: 'CREATE',
      entityId: null,
      status: 'IN_PROGRESS',
    });
    expect(cr.referenceNumber).toMatch(/^R\d{6}-BANKDET-N\d{5}$/);
    expect(cr.changes.find((c) => c.path === 'accountNumber')?.to).toBe('••••8776');
    expect(cr.changes.find((c) => c.path === 'bankId')?.to).toBe('FNB Namibia');
    expect(JSON.stringify((await details.changeRequest(cr.id)).proposed)).not.toContain('62009988776');
    expect((await accounts(emp)).pendingCreate?.banner).toBe(
      `Changes pending approval (Process #${cr.processId})`,
    );

    // A second new-account change while this one is open is refused.
    const secondDoc = await details.upload(emp);
    const again = await emp.post('/me/bank-accounts').send({
      accountType: 'SAVINGS',
      accountHolderName: 'X',
      accountHolderRelationship: 'OWN',
      bankId,
      accountNumber: '1111122222',
      attachmentIds: [secondDoc],
    });
    expect(again.status).toBe(409);
    expect(again.body.detail).toBe(CHANGE_PENDING_MESSAGE);

    const processId = cr.processId as number;
    // The manager submitted it, so their own step is skipped; payroll approves.
    const process = await details.process(processId);
    expect(process.currentStepNo).toBe(2);

    // Only the payroll approver sees the new number in full, in the detail panel, audited.
    const cards = (await payroll.get('/inbox/items?box=action').expect(200)).body as InboxItemsResponse;
    expect(cards.items.some((c) => c.processId === processId)).toBe(true);
    expect(asJson(cards)).not.toContain('62009988776');
    const beforeView = await lastAuditId(t.db);
    const full = (await payroll.get(`/inbox/items/${processId}`).expect(200)).body as InboxItemDetail;
    expect(full.subject.fields).toContainEqual({ label: 'Account Number', value: '(empty) → 62009988776' });
    expect(full.attachments.map((a) => a.fileName)).toContain('bank-letter.pdf');
    const viewed = await auditSince(t.db, beforeView, { action: 'DATA_VIEW.BANK_ACCOUNT_UNMASKED' });
    expect(viewed).toHaveLength(1);
    expect(viewed[0]).toMatchObject({ entityType: 'ChangeRequest', reason: 'Approval review' });
    const masked = (await hr.get(`/inbox/items/${processId}`).expect(200)).body as InboxItemDetail;
    expect(masked.subject.fields).toContainEqual({ label: 'Account Number', value: '(empty) → ••••8776' });

    await details.approve(payroll, processId);
    expect((await details.process(processId)).status).toBe('PROCESSED');

    const list = await accounts(emp);
    expect(list.items).toHaveLength(1);
    const created = list.items[0];
    newAccountId = created?.id ?? 0;
    expect(created).toMatchObject({
      accountNumberMasked: '••••8776',
      accountHolderRelationship: 'JOINT',
      bankName: 'FNB Namibia',
      isActive: true,
      effectiveFrom: nextPeriodStart,
      effectiveTo: null,
    });
    expect(list.history).toEqual([
      expect.objectContaining({
        id: seededAccountId,
        isActive: false,
        effectiveTo: addDays(nextPeriodStart, -1),
      }),
    ]);
    expect(list.pendingCreate).toBeNull();

    const audits = await auditSince(t.db, since, {
      action: { in: ['BANK_ACCOUNT.CREATED', 'BANK_ACCOUNT.DEACTIVATED'] },
    });
    expect(audits.map((a) => a.action).sort()).toEqual(['BANK_ACCOUNT.CREATED', 'BANK_ACCOUNT.DEACTIVATED']);
    expect(asJson(await auditSince(t.db, since))).not.toContain('62009988776');

    await kit.publish();
    const mails = t.mail
      .sentTo(f.employee.email as string)
      .filter((m) => m.template === 'bank-details-changed');
    expect(mails).toHaveLength(1);
    expect(mails[0]?.subject).toBe('Your bank details were changed');
    expect(mails[0]?.text).not.toContain('8776');
    const notes = await t.db.prisma.notification.findMany({
      where: { userId: f.employee.userId, kind: 'BANK_DETAILS_CHANGED' },
    });
    expect(notes).toHaveLength(1);
  });

  it('lets only a payroll administrator unmask a number, with a reason, never while working as someone', async () => {
    let since = await lastAuditId(t.db);
    await expectDenied(
      await emp.get(`/me/bank-accounts/${newAccountId}/unmasked?reason=Just%20curious`),
      since,
    );

    const own = await details.account(f.payrollAdmin, '7700112233');
    await payroll.get(`/me/bank-accounts/${own}/unmasked`).expect(422);
    since = await lastAuditId(t.db);
    const res = await payroll
      .get(`/me/bank-accounts/${own}/unmasked?reason=Verify%20payment%20file`)
      .expect(200);
    expect((res.body as BankAccountUnmasked).accountNumber).toBe('7700112233');
    const rows = await auditSince(t.db, since, { action: 'DATA_VIEW.BANK_ACCOUNT_UNMASKED' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reason: 'Verify payment file',
      entityType: 'BankAccount',
      entityId: String(own),
    });
    // Someone else's account is not "mine".
    await payroll.get(`/me/bank-accounts/${newAccountId}/unmasked?reason=Verify%20payment`).expect(404);

    // The admin route covers employees in the payroll admin's companies.
    const admin = await payroll
      .get(`/admin/bank-accounts/${newAccountId}/unmasked?reason=Payroll%20run%20check`)
      .expect(200);
    expect((admin.body as BankAccountUnmasked).accountNumber).toBe('62009988776');
    const otherPayroll: Person = await createPerson(t.db, {
      org: f.otherOrg,
      roles: ['EMPLOYEE', 'PAYROLL_ADMIN'],
    });
    since = await lastAuditId(t.db);
    await expectDenied(
      await (
        await login(t, otherPayroll)
      ).get(`/admin/bank-accounts/${newAccountId}/unmasked?reason=Payroll%20check`),
      since,
    );
    since = await lastAuditId(t.db);
    await expectDenied(
      await hr.get(`/admin/bank-accounts/${newAccountId}/unmasked?reason=HR%20check`),
      since,
    );

    // A payroll administrator who manages someone cannot unmask while working as them.
    const boss = await createPerson(t.db, { org: f.org, roles: ['EMPLOYEE', 'MANAGER', 'PAYROLL_ADMIN'] });
    const report = await createPerson(t.db, { org: f.org, reportsToId: boss.employeeId });
    const reportAccount = await details.account(report, '5500667788');
    const bossAgent = await login(t, boss);
    await bossAgent.put('/session/acting-as').send({ employeeId: report.employeeId }).expect(200);
    since = await lastAuditId(t.db);
    const denied = await bossAgent.get(`/me/bank-accounts/${reportAccount}/unmasked?reason=Check%20account`);
    await expectDenied(denied, since);
    expect(denied.body.type).toBe('urn:peoplehub:problem:restricted-while-working-as');
    since = await lastAuditId(t.db);
    await expectDenied(
      await bossAgent.get(`/admin/bank-accounts/${reportAccount}/unmasked?reason=Check%20account`),
      since,
    );
    // The masked grid is still available while working as them.
    const grid = await accounts(bossAgent);
    expect(grid.items[0]?.accountNumberMasked).toBe('••••7788');
  });

  it('ends a change in CONFLICT when another approved change replaced the account', async () => {
    const accountId = await details.account(f.employee2, '4400112200');
    const list = await accounts(emp2);
    const account = list.items.find((a) => a.id === accountId);
    const docs = [await details.upload(emp2), await details.upload(emp2)];
    const unchanged = await emp2.put(`/me/bank-accounts/${accountId}`).send({
      version: account?.version,
      accountHolderName: account?.accountHolderName,
      attachmentIds: [docs[0]],
    });
    expect(unchanged.status).toBe(422);
    expect(unchanged.body.detail).toBe(NO_CHANGES_MESSAGE);

    const update = details.submitted(
      await emp2
        .put(`/me/bank-accounts/${accountId}`)
        .send({ version: account?.version, accountHolderName: 'Renamed Holder', attachmentIds: [docs[0]] }),
    );
    expect(update.changeRequest).toMatchObject({ operation: 'UPDATE', entityId: String(accountId) });
    const { bankId } = await details.bank();
    const create = details.submitted(
      await emp2.post('/me/bank-accounts').send({
        accountType: 'CURRENT',
        accountHolderName: 'New Holder',
        accountHolderRelationship: 'OWN',
        bankId,
        accountNumber: '4400998877',
        attachmentIds: [docs[1]],
      }),
      201,
    );
    await details.approveAll(create.changeRequest.processId as number, [manager, payroll]);
    await details.approveAll(update.changeRequest.processId as number, [manager, payroll]);
    expect((await details.process(update.changeRequest.processId as number)).status).toBe('CONFLICT');
    expect((await details.changeRequest(update.changeRequest.id)).status).toBe('CONFLICT');
    const after = await accounts(emp2);
    expect(after.items.map((a) => a.accountNumberMasked)).toEqual(['••••8877']);
    expect(after.history.map((a) => a.accountHolderName)).not.toContain('Renamed Holder');
  });
});
