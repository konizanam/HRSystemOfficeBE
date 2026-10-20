import { units4 } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  auditSince,
  createPerson,
  createRoleFixtures,
  lastAuditId,
  login,
  nextUnique,
  type RoleFixtures,
} from '../support/fixtures';
import { LEAVE_TYPE, LeaveKit } from '../support/leave';
import { WorkflowKit } from '../support/workflow';

describe('leave admin (section 12.10)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let leave: LeaveKit;
  let hr: Agent;
  let emp: Agent;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    leave = new LeaveKit(t, kit);
    await leave.setup(f.org);
    await leave.accrue([f.employee.employeeId]);
    [hr, emp] = await Promise.all([login(t, f.hrAdmin), login(t, f.employee)]);
  });

  afterAll(async () => {
    kit.restore();
    await t.close();
  });

  it('posts an ADJUSTMENT ledger entry with a reason (audited)', async () => {
    const before = (await emp.get('/leave/balances').expect(200)).body.items.find(
      (c: { leaveTypeId: number }) => c.leaveTypeId === 1,
    );
    const since = await lastAuditId(t.db);
    const res = await hr.post('/admin/leave/adjustments').send({
      employeeId: f.employee.employeeId,
      leaveTypeId: LEAVE_TYPE.annual,
      units: '2.5',
      reason: 'Long service award',
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body.entry).toMatchObject({
      entryType: 'ADJUSTMENT',
      units: '2.5000',
      note: 'Long service award',
    });
    const audit = await auditSince(t.db, since, { action: 'LEAVE.ADJUSTED' });
    expect(audit[0]).toMatchObject({
      reason: 'Long service award',
      entityType: 'LeaveLedgerEntry',
      subjectEmployeeId: f.employee.employeeId,
    });
    // A second adjustment on the same day is allowed.
    await hr
      .post('/admin/leave/adjustments')
      .send({
        employeeId: f.employee.employeeId,
        leaveTypeId: LEAVE_TYPE.annual,
        units: '-0.5',
        reason: 'Correction',
      })
      .expect(201);
    const after = (await emp.get('/leave/balances').expect(200)).body.items.find(
      (c: { leaveTypeId: number }) => c.leaveTypeId === 1,
    );
    expect(Number(after.actualAvailable) - Number(before.actualAvailable)).toBeCloseTo(2, 4);

    await emp
      .post('/admin/leave/adjustments')
      .send({ employeeId: f.employee.employeeId, leaveTypeId: 1, units: '1', reason: 'Self' })
      .expect(403);
    await hr
      .post('/admin/leave/adjustments')
      .send({ employeeId: f.otherCompany.employeeId, leaveTypeId: 1, units: '1', reason: 'Other company' })
      .expect(403);
    await hr
      .post('/admin/leave/adjustments')
      .send({ employeeId: f.employee.employeeId, leaveTypeId: 1, units: '0', reason: 'Nothing' })
      .expect(422);
    const foreignBucket = await t.db.prisma.employeeLeaveEntitlement.findFirstOrThrow({
      where: { employeeId: { not: f.employee.employeeId ?? 0 } },
    });
    await hr
      .post('/admin/leave/adjustments')
      .send({
        employeeId: f.employee.employeeId,
        leaveTypeId: 1,
        entitlementId: foreignBucket.id,
        units: '1',
        reason: 'Wrong bucket',
      })
      .expect(422);
  });

  it('imports opening balances: dry run, then commit with the token; every row audited', async () => {
    const person = await createPerson(t.db, { org: f.org, label: 'takeon' });
    const code = person.employeeCode ?? '';
    const csv = [
      'employeeCode,leaveTypeCode,kind,definitionName,cycleStartDate,cycleEndDate,entitlement,openingBalance,effectiveDate,expiresOn',
      `${code},ANN_LVE,CARRY_FORWARD,Carry Forward Leave,2026-09-01,2027-02-28,0.5024,0.5024,2026-09-01,2027-02-28`,
      `${code},ANN_LVE,CYCLE,Annual Leave,2026-09-01,2027-08-31,20,1.6667,2026-09-01,`,
    ].join('\n');
    const dry = await hr.post('/admin/leave/opening-balances/import').send({ csv, mode: 'DRY_RUN' });
    expect(dry.status, dry.text).toBe(200);
    expect(dry.body).toMatchObject({ totalRows: 2, validRows: 2, invalidRows: 0, committed: false });
    expect(dry.body.rows.map((r: { bucket: string }) => r.bucket)).toEqual(['NEW', 'NEW']);
    expect(
      await t.db.prisma.employeeLeaveEntitlement.count({ where: { employeeId: person.employeeId ?? 0 } }),
    ).toBe(0);

    await hr.post('/admin/leave/opening-balances/import').send({ csv, mode: 'COMMIT' }).expect(422);
    await hr
      .post('/admin/leave/opening-balances/import')
      .send({ csv, mode: 'COMMIT', confirmToken: 'stale' })
      .expect(422);
    const since = await lastAuditId(t.db);
    const commit = await hr
      .post('/admin/leave/opening-balances/import')
      .send({ csv, mode: 'COMMIT', confirmToken: dry.body.confirmToken });
    expect(commit.status, commit.text).toBe(200);
    expect(commit.body).toMatchObject({ committed: true, validRows: 2 });
    const imported = await auditSince(t.db, since, { action: 'LEAVE.OPENING_BALANCE_IMPORTED' });
    expect(imported).toHaveLength(2);
    const entries = await t.db.prisma.leaveLedgerEntry.findMany({
      where: { employeeId: person.employeeId ?? 0 },
      include: { entitlement: true },
    });
    expect(entries.map((e) => [e.entryType, e.entitlement.kind, units4(e.units)]).sort()).toEqual([
      ['OPENING', 'CARRY_FORWARD', '0.5024'],
      ['OPENING', 'CYCLE', '1.6667'],
    ]);
    // A second import of the same file is refused row by row.
    const again = await hr
      .post('/admin/leave/opening-balances/import')
      .send({ csv, mode: 'DRY_RUN' })
      .expect(200);
    expect(again.body.invalidRows).toBe(2);
    expect(again.body.rows[0].errors).toContain(
      'An opening balance was already imported for this bucket and date',
    );

    const invalid =
      'employeeCode,leaveTypeCode,kind,definitionName,cycleStartDate,cycleEndDate,entitlement,openingBalance,effectiveDate\nNOPE,XX,OTHER,,2026-13-01,2026-01-01,a,1.123456,2026-01-01';
    const report = (
      await hr
        .post('/admin/leave/opening-balances/import')
        .send({ csv: invalid, mode: 'DRY_RUN' })
        .expect(200)
    ).body;
    expect(report.rows[0].ok).toBe(false);
    expect(report.rows[0].errors).toEqual(
      expect.arrayContaining([
        'Unknown employee NOPE',
        'Unknown leave type XX',
        'definitionName is required',
      ]),
    );
    await hr
      .post('/admin/leave/opening-balances/import')
      .send({ csv: 'a,b\n1,2', mode: 'DRY_RUN' })
      .expect(422);
    await emp.post('/admin/leave/opening-balances/import').send({ csv, mode: 'DRY_RUN' }).expect(403);
  });

  it('manages leave types, reasons and policies with versions and audit', async () => {
    const n = await nextUnique(t.db);
    const code = `TST_${n}`;
    let since = await lastAuditId(t.db);
    const created = await hr
      .post('/admin/leave-types')
      .send({ code, description: `Test leave ${n}`, colour: '#123456' });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({ code, isActive: true, version: 1, excludeWeekends: true });
    expect(await auditSince(t.db, since, { action: 'LEAVE_TYPE.CREATED' })).toHaveLength(1);
    const id = created.body.id as number;
    await hr.post('/admin/leave-types').send({ code, description: 'Duplicate' }).expect(409);
    const updated = await hr
      .put(`/admin/leave-types/${id}`)
      .send({ version: 1, mandatoryReason: true, requiresAttachmentAfterDays: '1.5' })
      .expect(200);
    expect(updated.body).toMatchObject({
      version: 2,
      mandatoryReason: true,
      requiresAttachmentAfterDays: '1.5000',
    });
    await hr.put(`/admin/leave-types/${id}`).send({ version: 1, colour: '#FFFFFF' }).expect(409);
    expect((await hr.get(`/admin/leave-types/${id}`).expect(200)).body.colour).toBe('#123456');
    expect(
      (await hr.get('/admin/leave-types').expect(200)).body.items.map((x: { id: number }) => x.id),
    ).toContain(id);

    const reason = await hr
      .post('/admin/leave-reasons')
      .send({ leaveTypeId: id, code: 'EXAM', description: 'Exam' })
      .expect(201);
    await hr
      .post('/admin/leave-reasons')
      .send({ leaveTypeId: id, code: 'EXAM', description: 'Again' })
      .expect(409);
    await hr
      .put(`/admin/leave-reasons/${reason.body.id}`)
      .send({ version: 1, description: 'Examination' })
      .expect(200);
    const reasons = (await hr.get(`/admin/leave-reasons?leaveTypeId=${id}`).expect(200)).body.items;
    expect(reasons).toEqual([
      expect.objectContaining({ code: 'EXAM', description: 'Examination', version: 2 }),
    ]);

    since = await lastAuditId(t.db);
    const policy = await hr.post('/admin/leave-policies').send({
      leaveTypeId: id,
      companyRuleId: f.org.companyRuleId,
      definitionName: 'Test Leave',
      entitlementPerCycle: '6',
      accrualMethod: 'UPFRONT',
    });
    expect(policy.status, policy.text).toBe(201);
    expect(policy.body).toMatchObject({
      entitlementPerCycle: '6.0000',
      cycleMonths: 12,
      maxNegative: '0.0000',
    });
    expect(await auditSince(t.db, since, { action: 'LEAVE_POLICY.CREATED' })).toHaveLength(1);
    await hr
      .post('/admin/leave-policies')
      .send({
        leaveTypeId: id,
        companyRuleId: f.org.companyRuleId,
        definitionName: 'Twice',
        entitlementPerCycle: '1',
        accrualMethod: 'NONE',
      })
      .expect(409);
    await hr
      .post('/admin/leave-policies')
      .send({
        leaveTypeId: id,
        companyRuleId: f.otherOrg.companyRuleId,
        definitionName: 'Elsewhere',
        entitlementPerCycle: '1',
        accrualMethod: 'NONE',
      })
      .expect(403);
    // The employee now has the type (their company rule's policy).
    expect((await emp.get('/leave/types').expect(200)).body.items.map((x: { id: number }) => x.id)).toContain(
      id,
    );
    await hr
      .put(`/admin/leave-policies/${policy.body.id}`)
      .send({ version: 1, entitlementPerCycle: '7' })
      .expect(200);
    await hr.delete(`/admin/leave-policies/${policy.body.id}`).send({ version: 2 }).expect(200);
    expect(
      (await emp.get('/leave/types').expect(200)).body.items.map((x: { id: number }) => x.id),
    ).not.toContain(id);

    const deactivated = await hr.delete(`/admin/leave-types/${id}`).send({ version: 2 }).expect(200);
    expect(deactivated.body).toMatchObject({ isActive: false, version: 3 });
    await hr.delete(`/admin/leave-reasons/${reason.body.id}`).send({ version: 2 }).expect(200);
    const actions = (await auditSince(t.db, since)).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'LEAVE_POLICY.UPDATED',
        'LEAVE_POLICY.DEACTIVATED',
        'LEAVE_TYPE.DEACTIVATED',
        'LEAVE_REASON.DEACTIVATED',
      ]),
    );
    await emp.get('/admin/leave-types').expect(403);
  });
});
