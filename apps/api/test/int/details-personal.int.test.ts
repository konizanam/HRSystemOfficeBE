import {
  type AdminPersonalDetailsUpdateResponse,
  CHANGE_PENDING_MESSAGE,
  type ChangeRequestsResponse,
  type InboxItemDetail,
  type LookupResponse,
  NO_CHANGES_MESSAGE,
  type PersonalDetails,
  type PersonalIdNumbers,
} from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import { DetailsKit } from '../support/details';
import {
  type Agent,
  asJson,
  auditSince,
  createRoleFixtures,
  lastAuditId,
  login,
  type RoleFixtures,
} from '../support/fixtures';
import { WorkflowKit } from '../support/workflow';

describe('My Details: personal details through change requests (sections 5.4.1 and 7.6)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let details: DetailsKit;
  let emp: Agent;
  let emp2: Agent;
  let manager: Agent;
  let payroll: Agent;
  let hr: Agent;

  const personal = async (agent: Agent): Promise<PersonalDetails> => {
    const res = await agent.get('/me/personal');
    expect(res.status, res.text).toBe(200);
    return res.body as PersonalDetails;
  };

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    details = new DetailsKit(t, kit);
    await details.setup(f.org);
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

  it('serves the lookup lists from ParameterValue rows', async () => {
    const titles = (await emp.get('/lookups/titles').expect(200)).body as LookupResponse;
    expect(titles.items.map((i) => i.code)).toEqual(
      expect.arrayContaining(['Mr', 'Dr', 'His Royal Highness']),
    );
    const countries = (await emp.get('/lookups/countries').expect(200)).body as LookupResponse;
    expect(countries.items.length).toBeGreaterThanOrEqual(249);
    expect(countries.items).toContainEqual(expect.objectContaining({ code: 'NA', description: 'Namibia' }));
    const blood = (await emp.get('/lookups/bloodGroups').expect(200)).body as LookupResponse;
    expect(blood.items.map((i) => i.code)).toContain('O Positive');
    await emp.get('/lookups/salaries').expect(422);
  });

  it('reads the acting-as employee with masked numbers and no pending change', async () => {
    const p = await personal(emp);
    expect(p.employeeId).toBe(f.employee.employeeId);
    expect(p.identity.entityCode).toMatch(/^\d{6}$/);
    expect(p.identity.identityNumberMasked).toBeNull();
    expect(p.pendingChange).toBeNull();
    expect(p.idNumbersRestricted).toBe(false);
  });

  it('answers 422 "No changes to submit" and 409 on a stale version', async () => {
    const p = await personal(emp);
    const same = await emp
      .put('/me/personal')
      .send({ version: p.version, identity: { lastName: p.identity.lastName } });
    expect(same.status).toBe(422);
    expect(same.body.detail).toBe(NO_CHANGES_MESSAGE);
    await emp
      .put('/me/personal')
      .send({ version: p.version + 5, identity: { lastName: 'X' } })
      .expect(409);
    const badTitle = await emp
      .put('/me/personal')
      .send({ version: p.version, identity: { title: 'Captain' } });
    expect(badTitle.status).toBe(422);
    expect(badTitle.body.errors).toContainEqual({
      path: 'identity.title',
      message: 'Pick a value from the list',
    });
  });

  it('submits only the changed fields, blocks a second change, applies after two approvals', async () => {
    const before = await personal(emp);
    const since = await lastAuditId(t.db);
    const res = await emp.put('/me/personal').send({
      version: before.version,
      identity: {
        lastName: 'Nangolo',
        firstName: before.identity.firstName,
        identityType: 'Namibian ID',
        identityNumber: '85031700123',
        dateOfBirth: '1985-03-18',
        nationality: 'NA',
      },
      contacts: { cell: '081 234 5678' },
      otherContacts: [{ type: 'EMAIL', value: 'alt.address@example.test' }],
      physicalAddress: { city: 'Windhoek', country: 'NA' },
      correspondenceAddressType: 'PHYSICAL',
    });
    const body = details.submitted(res);
    const cr = body.changeRequest;
    // The Namibian ID starts 850317 but the date of birth is 18 March: a warning, not a block.
    expect(body.warnings).toEqual([
      {
        path: 'identity.identityNumber',
        message: 'The ID number does not start with the date of birth (YYMMDD)',
      },
    ]);
    expect(cr.referenceNumber).toMatch(/^R\d{6}-BASICINF-N\d{5}$/);
    expect(cr.workflowType).toBe('BASICINF');
    expect(cr.status).toBe('IN_PROGRESS');
    expect(cr.baseVersion).toBe(before.version);
    expect(cr.fieldPaths.sort()).toEqual([
      'contacts.cell',
      'correspondenceAddressType',
      'identity.dateOfBirth',
      'identity.identityNumber',
      'identity.identityType',
      'identity.lastName',
      'identity.nationality',
      'otherContacts',
      'physicalAddress.city',
      'physicalAddress.country',
    ]);
    const idChange = cr.changes.find((c) => c.path === 'identity.identityNumber');
    expect(idChange).toMatchObject({ label: 'Identity Number', from: null, to: '••••0123' });
    expect(cr.changes.find((c) => c.path === 'contacts.cell')?.to).toBe('+264812345678');

    // The identity number is encrypted inside the change request and never in the audit trail.
    const row = await details.changeRequest(cr.id);
    expect(JSON.stringify(row.proposed)).not.toContain('85031700123');
    expect(JSON.stringify(row.proposed)).toContain('valueEnc');
    expect(asJson(await auditSince(t.db, since))).not.toContain('85031700123');

    const pending = await personal(emp);
    expect(pending.pendingChange).toMatchObject({
      changeRequestId: cr.id,
      processId: cr.processId,
      banner: `Changes pending approval (Process #${cr.processId})`,
    });
    expect(pending.pendingChange?.fieldPaths).toContain('identity.lastName');
    expect(pending.identity.lastName).toBe(before.identity.lastName);

    const second = await emp
      .put('/me/personal')
      .send({ version: before.version, identity: { knownAs: 'Anna' } });
    expect(second.status).toBe(409);
    expect(second.body.detail).toBe(CHANGE_PENDING_MESSAGE);

    // The approver sees the masked number in the inbox detail.
    const processId = cr.processId as number;
    const detail = (await manager.get(`/inbox/items/${processId}`).expect(200)).body as InboxItemDetail;
    expect(detail.subject.title).toBe('Personal details change');
    expect(detail.subject.fields).toContainEqual({ label: 'Identity Number', value: '(empty) → ••••0123' });
    expect(asJson(detail)).not.toContain('85031700123');

    await details.approveAll(processId, [manager, payroll]);
    expect((await details.process(processId)).status).toBe('PROCESSED');
    const applied = await details.changeRequest(cr.id);
    expect(applied.status).toBe('PROCESSED');
    expect(applied.appliedAt).not.toBeNull();

    const after = await personal(emp);
    expect(after.version).toBe(before.version + 1);
    expect(after.pendingChange).toBeNull();
    expect(after.identity).toMatchObject({
      lastName: 'Nangolo',
      identityNumberMasked: '••••0123',
      identityType: 'Namibian ID',
      dateOfBirth: '1985-03-18',
    });
    expect(after.identity.age).toBeGreaterThanOrEqual(41);
    expect(after.contacts.cell).toBe('+264812345678');
    expect(after.otherContacts).toEqual([
      expect.objectContaining({ type: 'EMAIL', typeLabel: 'E-Mail', value: 'alt.address@example.test' }),
    ]);
    expect(after.physicalAddress).toMatchObject({ city: 'Windhoek', country: 'NA' });
    expect(after.correspondenceAddressType).toBe('PHYSICAL');
    expect(after.warnings).toHaveLength(1);

    const audits = await auditSince(t.db, since, { action: 'EMPLOYEE.PERSONAL_DETAILS_UPDATED' });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: 'Employee',
      entityId: String(f.employee.employeeId),
      subjectEmployeeId: f.employee.employeeId,
      actorUserId: f.payrollAdmin.userId,
    });
    expect(audits[0]?.metadata).toMatchObject({ source: 'CHANGE_REQUEST', changeRequestId: cr.id });

    const list = (await emp.get('/me/change-requests?status=closed').expect(200))
      .body as ChangeRequestsResponse;
    expect(list.items.map((i) => i.id)).toContain(cr.id);
    const open = (await emp.get('/me/change-requests?status=open').expect(200))
      .body as ChangeRequestsResponse;
    expect(open.items.map((i) => i.id)).not.toContain(cr.id);
  });

  it('shows the unmasked ID numbers to the employee, audited', async () => {
    const since = await lastAuditId(t.db);
    const res = await emp.get('/me/personal/id-numbers').expect(200);
    expect((res.body as PersonalIdNumbers).identityNumber).toBe('85031700123');
    const rows = await auditSince(t.db, since, { action: 'DATA_VIEW.ID_NUMBERS_UNMASKED' });
    expect(rows).toHaveLength(1);
    expect(asJson(rows)).not.toContain('85031700123');
  });

  it('writes the same audit row for an HR edit as for an approved change request', async () => {
    const value = { lastName: 'Same-Audit', maritalStatus: 'Married', homeLanguage: 'Oshiwambo' };
    const p1 = (await hr.get(`/admin/employees/${f.employee2.employeeId}/personal`).expect(200))
      .body as PersonalDetails;

    // Employee 2 through the workflow …
    const since = await lastAuditId(t.db);
    const submitted = details.submitted(
      await emp2.put('/me/personal').send({ version: p1.version, identity: value }),
    );
    await details.approveAll(submitted.changeRequest.processId as number, [manager, payroll]);
    const [viaChange] = await auditSince(t.db, since, { action: 'EMPLOYEE.PERSONAL_DETAILS_UPDATED' });

    // … and the unrelated colleague by HR directly.
    const p2 = (await hr.get(`/admin/employees/${f.unrelated.employeeId}/personal`).expect(200))
      .body as PersonalDetails;
    const since2 = await lastAuditId(t.db);
    const res = await hr
      .put(`/admin/employees/${f.unrelated.employeeId}/personal`)
      .send({ version: p2.version, identity: value });
    expect(res.status, res.text).toBe(200);
    const edit = res.body as AdminPersonalDetailsUpdateResponse;
    expect(edit.personal.version).toBe(p2.version + 1);
    expect(edit.personal.identity.lastName).toBe('Same-Audit');
    expect(edit.changedFields.sort()).toEqual([
      'identity.homeLanguage',
      'identity.lastName',
      'identity.maritalStatus',
    ]);
    const [viaHr] = await auditSince(t.db, since2, { action: 'EMPLOYEE.PERSONAL_DETAILS_UPDATED' });

    expect(viaChange && viaHr).toBeTruthy();
    const shape = (row: typeof viaHr) => ({
      category: row?.category,
      action: row?.action,
      entityType: row?.entityType,
      changes: (row?.changes as { path: string; to: unknown }[]).map((c) => ({ path: c.path, to: c.to })),
      fields: (row?.metadata as { fields: string[] }).fields,
    });
    expect(shape(viaChange)).toEqual(shape(viaHr));
    expect((viaChange?.metadata as { source: string }).source).toBe('CHANGE_REQUEST');
    expect((viaHr?.metadata as { source: string }).source).toBe('HR_EDIT');
    expect(
      (await hr.get(`/admin/employees/${f.employee2.employeeId}/personal`).expect(200)).body.version,
    ).toBe(p1.version + 1);
  });

  it('ends in CONFLICT when HR edits between submit and approval, and alerts HR', async () => {
    const p = await personal(emp2);
    const submitted = details.submitted(
      await emp2.put('/me/personal').send({ version: p.version, identity: { lastName: 'Proposed' } }),
    );
    const processId = submitted.changeRequest.processId as number;
    await details.approve(manager, processId);

    const edit = await hr
      .put(`/admin/employees/${f.employee2.employeeId}/personal`)
      .send({ version: p.version, identity: { knownAs: 'Edited by HR' } });
    expect(edit.status, edit.text).toBe(200);

    await details.approve(payroll, processId);
    expect((await details.process(processId)).status).toBe('CONFLICT');
    expect((await details.changeRequest(submitted.changeRequest.id)).status).toBe('CONFLICT');
    const after = await personal(emp2);
    expect(after.identity.lastName).toBe(p.identity.lastName);
    expect(after.identity.knownAs).toBe('Edited by HR');
    expect(after.pendingChange).toBeNull();

    await kit.publish();
    const alerts = await kit.notifications(f.hrAdmin.userId, processId);
    expect(alerts.map((n) => n.kind)).toContain('WORKFLOW_CONFLICT');
    expect(t.mail.sentTo(f.hrAdmin.email as string).some((m) => m.template === 'workflow-conflict')).toBe(
      true,
    );
  });

  it('audits HR viewing personal details and keeps ID numbers from someone working as the employee', async () => {
    const since = await lastAuditId(t.db);
    await hr.get(`/admin/employees/${f.employee.employeeId}/personal`).expect(200);
    const views = await auditSince(t.db, since, { action: 'DATA_VIEW.PERSONAL_DETAILS' });
    expect(views).toHaveLength(1);
    expect(views[0]?.subjectEmployeeId).toBe(f.employee.employeeId);

    const acting = await login(t, f.managerB);
    await acting.put('/session/acting-as').send({ employeeId: f.employee.employeeId }).expect(200);
    const since2 = await lastAuditId(t.db);
    const p = await personal(acting);
    expect(p.employeeId).toBe(f.employee.employeeId);
    expect(p.idNumbersRestricted).toBe(true);
    expect(p.identity.identityNumberMasked).toBe('••••0123');
    const viewed = await auditSince(t.db, since2, { action: 'DATA_VIEW.PERSONAL_DETAILS' });
    expect(viewed.map((r) => r.subjectEmployeeId)).toEqual([f.employee.employeeId]);

    const denied = await acting.get('/me/personal/id-numbers');
    expect(denied.status).toBe(403);
    const rows = await auditSince(t.db, since2, { requestId: denied.headers['x-request-id'] as string });
    expect(rows.some((r) => r.outcome === 'DENIED')).toBe(true);
  });

  it('scopes personal details: employees cannot read or edit another employee', async () => {
    await emp.get(`/admin/employees/${f.employee2.employeeId}/personal`).expect(403);
    await emp
      .put(`/admin/employees/${f.employee2.employeeId}/personal`)
      .send({ version: 1, identity: { lastName: 'X' } })
      .expect(403);
    const otherHr = await login(t, f.otherCompany);
    await otherHr.get(`/admin/employees/${f.employee.employeeId}/personal`).expect(403);
    // "Working as" someone who is not a report is refused by the session.
    await emp.put('/session/acting-as').send({ employeeId: f.employee2.employeeId }).expect(403);
  });
});
