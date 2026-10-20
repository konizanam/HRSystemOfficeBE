import {
  dec,
  formalName,
  formatTimestampDate,
  type LeaveApplicationDetail,
  type LeaveApplicationRow,
  type LeaveBalancesResponse,
  units4,
} from '@peoplehub/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  auditSince,
  createRoleFixtures,
  lastAuditId,
  login,
  type Person,
  type RoleFixtures,
} from '../support/fixtures';
import { LEAVE_TYPE, LeaveKit } from '../support/leave';
import { WorkflowKit } from '../support/workflow';

/**
 * Section 16.2: the full leave lifecycle through the API. Submit → step 1 approve → step 2
 * approve → "Approved, Pending Process" → process → ledger TAKEN → cancel → CANCELLEAVE approve
 * and process → reversal, with the audit rows of every step and the exact approval history text.
 */
describe('leave lifecycle (section 16.2)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let leave: LeaveKit;
  let payPeriodId: number;
  let emp: Agent;
  let mgr: Agent;
  let hr: Agent;
  let payroll: Agent;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    leave = new LeaveKit(t, kit);
    ({ payPeriodId } = await leave.setup(f.org));
    await leave.accrue([f.employee.employeeId]);
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

  async function nameOf(person: Person): Promise<string> {
    const e = await t.db.prisma.employee.findUniqueOrThrow({ where: { id: person.employeeId ?? 0 } });
    return formalName(e);
  }

  async function actionsSince(since: bigint): Promise<string[]> {
    return (await auditSince(t.db, since)).map((r) => r.action);
  }

  async function history(processId: number): Promise<string> {
    const res = await emp.get(`/workflow/processes/${processId}/history`).expect(200);
    return (res.body as { renderedText: string }).renderedText;
  }

  async function annual(agent: Agent): Promise<{ actualAvailable: string | null; pending: string }> {
    const res = await agent.get('/leave/balances').expect(200);
    const card = (res.body as LeaveBalancesResponse).items.find((c) => c.leaveTypeId === LEAVE_TYPE.annual);
    if (!card) throw new Error('No Annual Leave card');
    return card;
  }

  async function approve(agent: Agent, processId: number): Promise<void> {
    const p = await kit.process(processId);
    const res = await agent.post(`/workflow/processes/${processId}/approve`).send({ version: p.version });
    expect(res.status, res.text).toBe(200);
  }

  async function processItem(processId: number): Promise<void> {
    const res = await payroll.post('/workflow/processes/process').send({ ids: [processId], payPeriodId });
    expect(res.status, res.text).toBe(200);
    expect(res.body.results[0], JSON.stringify(res.body)).toMatchObject({ ok: true });
  }

  it('runs submit → approvals → process → cancel → CANCELLEAVE approvals → process → reversal', async () => {
    const e = await t.db.prisma.employee.findUniqueOrThrow({ where: { id: f.employee.employeeId ?? 0 } });
    const applicant = `${e.employeeCode} - ${formalName(e)}`;
    const [managerName, hrName, payrollName] = await Promise.all([
      nameOf(f.managerB),
      nameOf(f.hrAdmin),
      nameOf(f.payrollAdmin),
    ]);
    const header = `Approval history - ${e.firstName} ${e.lastName} - ${e.employeeCode}`;
    const before = await annual(emp);
    expect(before.actualAvailable).toBe('16.6670');
    const { fromDate, toDate } = await leave.range(
      await leave.monday(14, f.org.companyId),
      3,
      f.org.companyId,
    );
    const reason = await t.db.prisma.leaveReason.findUniqueOrThrow({
      where: { leaveTypeId_code: { leaveTypeId: LEAVE_TYPE.annual, code: 'VACATION' } },
    });

    // ── Submit ──
    let since = await lastAuditId(t.db);
    const app = await leave.submit(
      emp,
      {
        leaveTypeId: LEAVE_TYPE.annual,
        fromDate,
        toDate,
        leaveReasonId: reason.id,
        comment: 'Family holiday',
      },
      randomUUID(),
    );
    const processId = app.processId ?? 0;
    const today = formatTimestampDate(new Date());
    expect(app).toMatchObject({
      status: 'IN_PROGRESS',
      statusLabel: 'In Progress',
      unitsTaken: '3.0000',
      availableAtSubmit: '16.6670',
      leaveReason: 'Vacation',
      cancelAction: 'WITHDRAW',
    });
    expect(app.referenceNumber).toMatch(new RegExp(`^E${e.entityCode}-T0001-N\\d{5}$`));
    expect(app.days).toHaveLength(3);
    expect(app.allocations.map((a) => a.units)).toEqual(['3.0000']);
    let actions = await actionsSince(since);
    expect(actions).toEqual(
      expect.arrayContaining(['LEAVE.SUBMITTED', 'WORKFLOW.CREATED', 'WORKFLOW.SUBMITTED']),
    );
    const submitted = (await auditSince(t.db, since, { action: 'LEAVE.SUBMITTED' }))[0];
    expect(submitted?.entityType).toBe('LeaveApplication');
    expect(submitted?.after).toMatchObject({ referenceNumber: app.referenceNumber, status: 'IN_PROGRESS' });
    expect(await annual(emp)).toEqual({ ...before, actualAvailable: '13.6670', pending: '3.0000' });
    expect(await history(processId)).toBe(
      [
        header,
        'Current Status Of Request',
        'This Annual Leave Request is In Progress and is waiting to be Approved.',
        'History Of Request',
        `CREATED: New Annual Leave Request on ${today} by Applicant ${applicant}`,
        'Remaining Approvers',
        'Step 1',
        `${managerName} (Mandatory)`,
        'Step 2',
        'Any HR Administrator (Mandatory)',
        `Workflow Process ID: ${processId}`,
      ].join('\n'),
    );

    // The approver's inbox detail (section 5.10).
    const detail = (await mgr.get(`/inbox/items/${processId}`).expect(200)).body;
    expect(detail.subject.headline).toEqual([
      { label: 'Days available', value: '16.6670' },
      { label: 'Days to be deducted', value: '3.0000' },
    ]);
    expect(detail.subject.fields.map((x: { label: string }) => x.label)).toEqual([
      'Leave type',
      'Reason for leave',
      'Leave start date',
      'Leave end date',
      'I am taking',
      'Date submitted',
      'Comments',
      'Reference number',
    ]);
    expect(detail.card.unitsLine).toBe('3.0000 Days to be deducted');
    expect(detail.allowedActions).toContain('APPROVE');

    // ── Step 1: manager ──
    since = await lastAuditId(t.db);
    await approve(mgr, processId);
    expect(await actionsSince(since)).toEqual(['WORKFLOW.APPROVED']);
    expect(await history(processId)).toBe(
      [
        header,
        'Current Status Of Request',
        'This Annual Leave Request is In Progress and is waiting to be Approved.',
        'History Of Request',
        `CREATED: New Annual Leave Request on ${today} by Applicant ${applicant}`,
        'Step 1',
        `Approved by ${managerName} on ${today}`,
        'Remaining Approvers',
        'Step 2',
        `${hrName} (Mandatory)`,
        `Workflow Process ID: ${processId}`,
      ].join('\n'),
    );

    // ── Step 2: HR → Approved, Pending Process ──
    since = await lastAuditId(t.db);
    await approve(hr, processId);
    actions = await actionsSince(since);
    expect(actions).toEqual(expect.arrayContaining(['WORKFLOW.APPROVED', 'LEAVE.APPROVED']));
    const approved = (await emp.get(`/leave/applications/${app.id}`).expect(200))
      .body as LeaveApplicationDetail;
    expect(approved).toMatchObject({
      status: 'APPROVED_PENDING_PROCESS',
      statusLabel: 'Approved, Pending Process',
      finalApprover: hrName,
      cancelAction: 'REQUEST_CANCELLATION',
    });
    expect(approved.dateApproved).not.toBeNull();
    // The exact section 1.5 text.
    expect(await history(processId)).toBe(
      [
        header,
        'Current Status Of Request',
        'This Annual Leave Request has been Approved and is waiting to be Processed.',
        'History Of Request',
        `CREATED: New Annual Leave Request on ${today} by Applicant ${applicant}`,
        'Step 1',
        `Approved by ${managerName} on ${today}`,
        'Step 2',
        `Approved by ${hrName} on ${today}`,
        `Workflow Process ID: ${processId}`,
      ].join('\n'),
    );
    expect(approved.approvalHistory?.renderedText).toBe(await history(processId));

    // ── Process: TAKEN entries ──
    since = await lastAuditId(t.db);
    await processItem(processId);
    expect(await actionsSince(since)).toEqual(
      expect.arrayContaining(['WORKFLOW.PROCESSED', 'LEAVE.PROCESSED', 'LEAVE.TAKEN_POSTED']),
    );
    const taken = await t.db.prisma.leaveLedgerEntry.findMany({
      where: { leaveApplicationId: app.id, entryType: 'TAKEN' },
    });
    expect(taken.map((x) => units4(x.units))).toEqual(['-3.0000']);
    expect(taken[0]?.payPeriodId).toBe(payPeriodId);
    const processed = (await emp.get(`/leave/applications/${app.id}`).expect(200))
      .body as LeaveApplicationDetail;
    expect(processed).toMatchObject({
      status: 'PROCESSED',
      statusLabel: 'Completed',
      payPeriod: { id: payPeriodId },
    });
    expect(await annual(emp)).toEqual({ ...before, actualAvailable: '13.6670', pending: '0.0000' });
    const processedHistory = await history(processId);
    expect(processedHistory).toContain('This Annual Leave Request has been Approved and Processed.');
    expect(processedHistory).toContain(
      `PROCESSED: Annual Leave Request processed on ${today} by ${payrollName}`,
    );

    // ── Cancel: a CANCELLEAVE request ──
    since = await lastAuditId(t.db);
    const cancel = await emp
      .post(`/leave/applications/${app.id}/cancel`)
      .set('idempotency-key', randomUUID())
      .send({ version: processed.version, comment: 'Plans changed' });
    expect(cancel.status, cancel.text).toBe(200);
    expect(cancel.body.outcome).toBe('CANCELLATION_REQUESTED');
    const cancellation = cancel.body.cancellation as LeaveApplicationRow;
    expect(cancellation).toMatchObject({
      isCancellation: true,
      leaveTypeLabel: 'Cancel Annual Leave',
      status: 'IN_PROGRESS',
      cancels: { id: app.id, referenceNumber: app.referenceNumber },
      unitsTaken: '3.0000',
    });
    expect(cancellation.referenceNumber).not.toBe(app.referenceNumber);
    expect(cancel.body.application.cancellation).toMatchObject({
      id: cancellation.id,
      status: 'IN_PROGRESS',
    });
    expect(cancel.body.application.cancelAction).toBeNull();
    expect(await actionsSince(since)).toEqual(
      expect.arrayContaining(['LEAVE.CANCELLATION_REQUESTED', 'WORKFLOW.CREATED', 'WORKFLOW.SUBMITTED']),
    );
    // Only one open cancellation per application.
    const again = await emp.post(`/leave/applications/${app.id}/cancel`).send({ version: processed.version });
    expect(again.status).toBe(409);

    const cancelProcessId = cancellation.processId ?? 0;
    await approve(mgr, cancelProcessId);
    since = await lastAuditId(t.db);
    await approve(hr, cancelProcessId);
    expect(await actionsSince(since)).toEqual(
      expect.arrayContaining(['WORKFLOW.APPROVED', 'LEAVE.CANCELLATION_APPROVED']),
    );
    // The original stays processed until the cancellation is processed.
    expect((await t.db.prisma.leaveApplication.findUniqueOrThrow({ where: { id: app.id } })).status).toBe(
      'PROCESSED',
    );

    // ── Process the cancellation: reversal ──
    since = await lastAuditId(t.db);
    await processItem(cancelProcessId);
    expect(await actionsSince(since)).toEqual(
      expect.arrayContaining([
        'WORKFLOW.PROCESSED',
        'LEAVE.CANCELLATION_REVERSED',
        'LEAVE.CANCELLED',
        'LEAVE.CANCELLATION_PROCESSED',
      ]),
    );
    const reversals = await t.db.prisma.leaveLedgerEntry.findMany({
      where: { leaveApplicationId: app.id, entryType: 'CANCELLATION_REVERSAL' },
    });
    expect(reversals.map((r) => [r.entitlementId, units4(r.units)])).toEqual(
      taken.map((x) => [x.entitlementId, units4(dec(x.units).negated())]),
    );
    const original = (await emp.get(`/leave/applications/${app.id}`).expect(200))
      .body as LeaveApplicationDetail;
    expect(original.status).toBe('CANCELLED');
    expect(await annual(emp)).toEqual(before);
    expect(await history(cancelProcessId)).toBe(
      [
        header,
        'Current Status Of Request',
        'This Cancel Annual Leave Request has been Approved and Processed.',
        'History Of Request',
        `CREATED: New Cancel Annual Leave Request on ${today} by Applicant ${applicant}`,
        'Step 1',
        `Approved by ${managerName} on ${today}`,
        'Step 2',
        `Approved by ${hrName} on ${today}`,
        `PROCESSED: Cancel Annual Leave Request processed on ${today} by ${payrollName}`,
        `Workflow Process ID: ${cancelProcessId}`,
      ].join('\n'),
    );

    // History lists both, From Date newest first.
    const completed = (await emp.get('/leave/applications?status=completed').expect(200)).body;
    const rows = completed.items as LeaveApplicationRow[];
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([app.id, cancellation.id]));
    expect(rows.find((r) => r.id === cancellation.id)?.status).toBe('PROCESSED');
  });
});
