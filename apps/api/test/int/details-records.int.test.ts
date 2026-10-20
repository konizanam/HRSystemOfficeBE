import {
  addDays,
  type AdminFundMembership,
  type AdminRetirementFund,
  type AdminTransactionCode,
  dateFromBusiness,
  type DriversLicencesResponse,
  type EmployeeTransaction,
  type EmployeeTransactionsResponse,
  FAMILY_EMPTY_TEXT,
  type FamilyMembersResponse,
  FUNDS_EMPTY_TEXT,
  type FundsResponse,
  LICENCES_EMPTY_TEXT,
  todayBusinessDate,
} from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { LICENCE_EXPIRY_JOB } from '../../src/modules/details/drivers-licence.service';
import { startTestApp, type TestApp } from '../support/app';
import { DetailsKit } from '../support/details';
import {
  type Agent,
  asJson,
  createRoleFixtures,
  login,
  nextUnique,
  type RoleFixtures,
} from '../support/fixtures';
import { WorkflowKit } from '../support/workflow';

describe('My Details: licences, family, beneficiaries and transactions (sections 5.4.3 to 5.4.6)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let details: DetailsKit;
  let emp: Agent;
  let emp2: Agent;
  let manager: Agent;
  let payroll: Agent;
  let hr: Agent;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    details = new DetailsKit(t, kit);
    await details.setup(f.org);
    await kit.payPeriod(f.org);
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

  describe('drivers licences', () => {
    const licences = async (agent: Agent) =>
      (await agent.get('/me/drivers-licences').expect(200)).body as DriversLicencesResponse;
    let licenceId = 0;

    it('starts empty and needs a copy of the licence and a valid code', async () => {
      const list = await licences(emp);
      expect(list).toMatchObject({ items: [], emptyText: LICENCES_EMPTY_TEXT, pendingCreate: null });
      const base = { licenceNumber: 'NA0012345678', code: 'B', expiryDate: addDays(todayBusinessDate(), 30) };
      const noCopy = await emp.post('/me/drivers-licences').send({ ...base, attachmentIds: [] });
      expect(noCopy.status).toBe(422);
      expect(noCopy.body.errors).toContainEqual({
        path: 'attachmentIds',
        message: 'Attach a copy of the licence',
      });
      const doc = await details.upload(emp, 'licence.pdf');
      const badCode = await emp
        .post('/me/drivers-licences')
        .send({ ...base, code: 'Z9', attachmentIds: [doc] });
      expect(badCode.status).toBe(422);
      expect(badCode.body.errors).toContainEqual({ path: 'code', message: 'Pick a value from the list' });
    });

    it('adds a licence with its copy after approval (manager, HR)', async () => {
      const doc = await details.upload(emp, 'licence-copy.pdf');
      const expiry = addDays(todayBusinessDate(), 30);
      const body = details.submitted(
        await emp.post('/me/drivers-licences').send({
          licenceNumber: 'NA0012345678',
          code: 'EB',
          issueDate: '2020-02-01',
          expiryDate: expiry,
          countryOfIssue: 'NA',
          restrictions: 'Glasses',
          hasPdp: true,
          pdpExpiryDate: addDays(todayBusinessDate(), 200),
          attachmentIds: [doc],
        }),
        201,
      );
      expect(body.changeRequest).toMatchObject({ workflowType: 'DRIVERSLICENSE', operation: 'CREATE' });
      expect(body.changeRequest.referenceNumber).toMatch(/^R\d{6}-DRIVERSLICENSE-N\d{5}$/);
      expect((await licences(emp)).pendingCreate?.processId).toBe(body.changeRequest.processId);
      expect(JSON.stringify((await details.changeRequest(body.changeRequest.id)).proposed)).not.toContain(
        'NA0012345678',
      );

      await details.approveAll(body.changeRequest.processId as number, [manager, hr]);
      const list = await licences(emp);
      expect(list.items).toHaveLength(1);
      const licence = list.items[0];
      licenceId = licence?.id ?? 0;
      expect(licence).toMatchObject({
        licenceNumberMasked: '••••5678',
        code: 'EB',
        expiryDate: expiry,
        expiresInDays: 30,
        isExpired: false,
        hasPdp: true,
        restrictions: 'Glasses',
      });
      expect(licence?.attachments.map((a) => a.fileName)).toEqual(['licence-copy.pdf']);
      expect((await details.changeRequest(body.changeRequest.id)).entityId).toBe(String(licenceId));
    });

    it('edits a licence through a change request', async () => {
      const current = (await licences(emp)).items[0];
      const doc = await details.upload(emp, 'renewed.pdf');
      const body = details.submitted(
        await emp
          .put(`/me/drivers-licences/${licenceId}`)
          .send({ version: current?.version, restrictions: 'None', attachmentIds: [doc] }),
      );
      expect(body.changeRequest.fieldPaths).toEqual(['restrictions']);
      await details.approveAll(body.changeRequest.processId as number, [manager, hr]);
      const after = (await licences(emp)).items[0];
      expect(after).toMatchObject({ restrictions: 'None', version: (current?.version ?? 0) + 1 });
      expect(after?.attachments).toHaveLength(2);
    });

    it('tells the employee and HR 60 days before expiry, once', async () => {
      const secondCopy = await details.upload(emp, 'second.pdf');
      const far = details.submitted(
        await emp.post('/me/drivers-licences').send({
          licenceNumber: 'NA0099998888',
          code: 'B',
          expiryDate: addDays(todayBusinessDate(), 90),
          attachmentIds: [secondCopy],
        }),
        201,
      );
      await details.approveAll(far.changeRequest.processId as number, [manager, hr]);
      const farId = Number((await details.changeRequest(far.changeRequest.id)).entityId);

      const first = await kit.jobs.runNow(LICENCE_EXPIRY_JOB);
      expect(first.notified).toBeGreaterThanOrEqual(1);
      await t.mail.flush();
      const notices = await t.db.prisma.licenceExpiryNotice.findMany({
        where: { licenceId: { in: [licenceId, farId] } },
      });
      expect(notices.map((n) => n.licenceId)).toEqual([licenceId]);
      const mine = await t.db.prisma.notification.findMany({
        where: { userId: f.employee.userId, kind: 'LICENCE_EXPIRING' },
      });
      expect(mine).toHaveLength(1);
      expect(mine[0]?.body).toContain('••••5678');
      const hrNotes = await t.db.prisma.notification.findMany({
        where: { userId: f.hrAdmin.userId, kind: 'LICENCE_EXPIRING' },
      });
      expect(hrNotes).toHaveLength(1);
      expect(
        t.mail.sentTo(f.employee.email as string).filter((m) => m.template === 'licence-expiring'),
      ).toHaveLength(1);

      const second = await kit.jobs.runNow(LICENCE_EXPIRY_JOB);
      expect(second.alreadyNotified).toBeGreaterThanOrEqual(1);
      expect(
        await t.db.prisma.notification.count({
          where: { userId: f.employee.userId, kind: 'LICENCE_EXPIRING' },
        }),
      ).toBe(1);
      const jobRows = await t.db.prisma.auditLog.findMany({
        where: { action: 'SYSTEM.JOB_RUN', entityId: LICENCE_EXPIRY_JOB },
        orderBy: { id: 'desc' },
        take: 2,
      });
      expect(jobRows).toHaveLength(2);
    });

    it('deletes a licence (soft) on approval', async () => {
      const current = (await licences(emp)).items.find((l) => l.id === licenceId);
      const body = details.submitted(
        await emp.delete(`/me/drivers-licences/${licenceId}`).send({ version: current?.version }),
      );
      expect(body.changeRequest.operation).toBe('DELETE');
      expect(body.changeRequest.changes.find((c) => c.path === 'licenceNumber')).toMatchObject({
        from: '••••5678',
        to: null,
      });
      await details.approveAll(body.changeRequest.processId as number, [manager, hr]);
      expect((await licences(emp)).items.map((l) => l.id)).not.toContain(licenceId);
      const row = await t.db.prisma.driversLicence.findUniqueOrThrow({ where: { id: licenceId } });
      expect(row.deletedAt).not.toBeNull();
      // Another employee's licence is not found through /me.
      await emp2
        .put(`/me/drivers-licences/${licenceId}`)
        .send({ version: 1, code: 'B', attachmentIds: [] })
        .expect(422);
      const doc = await details.upload(emp2);
      await emp2
        .put(`/me/drivers-licences/${licenceId}`)
        .send({ version: 1, code: 'B', attachmentIds: [doc] })
        .expect(404);
    });
  });

  describe('family', () => {
    const family = async (agent: Agent) =>
      (await agent.get('/me/family').expect(200)).body as FamilyMembersResponse;
    let memberId = 0;

    it('adds, edits and deletes a family member through BASICINF', async () => {
      expect(await family(emp2)).toMatchObject({ items: [], emptyText: FAMILY_EMPTY_TEXT });
      const bad = await emp2
        .post('/me/family')
        .send({ relationship: 'Neighbour', firstName: 'A', lastName: 'B' });
      expect(bad.status).toBe(422);
      expect(bad.body.errors).toContainEqual({ path: 'relationship', message: 'Pick a value from the list' });

      const created = details.submitted(
        await emp2.post('/me/family').send({
          relationship: 'Spouse',
          title: 'Mrs',
          firstName: 'Ndapewa',
          lastName: 'Shikongo',
          dateOfBirth: '1990-06-15',
          identityNumber: '90061500456',
          nationality: 'NA',
          isEmergencyContact: true,
          emergencyDetail: 'Call after hours',
          physicalAddress: { streetName: 'Independence Ave', city: 'Windhoek', country: 'NA' },
          postalAddress: { sameAs: 'PHYSICAL' },
          contacts: { cell: '0811112222', email: 'spouse@example.test' },
        }),
        201,
      );
      expect(created.changeRequest).toMatchObject({
        workflowType: 'BASICINF',
        entityType: 'FamilyMember',
        operation: 'CREATE',
      });
      expect(created.warnings).toEqual([]);
      await details.approveAll(created.changeRequest.processId as number, [manager, payroll]);

      const list = await family(emp2);
      expect(list.items).toHaveLength(1);
      const member = list.items[0];
      memberId = member?.id ?? 0;
      expect(member).toMatchObject({
        relationship: 'Spouse',
        firstName: 'Ndapewa',
        identityNumberMasked: '••••0456',
        dateOfBirth: '1990-06-15',
        isEmergencyContact: true,
        contacts: { cell: '+264811112222', email: 'spouse@example.test', fax: null, home: null, work: null },
      });
      expect(member?.age).toBe(
        Number(todayBusinessDate().slice(0, 4)) - 1990 - (todayBusinessDate().slice(5) < '06-15' ? 1 : 0),
      );
      expect(member?.physicalAddress).toMatchObject({ streetName: 'Independence Ave', city: 'Windhoek' });
      expect(member?.postalAddress).toMatchObject({ sameAs: 'PHYSICAL', city: 'Windhoek' });

      const edited = details.submitted(
        await emp2
          .put(`/me/family/${memberId}`)
          .send({ version: member?.version, isEmergencyContact: false, contacts: { work: '061 999 888' } }),
      );
      expect(edited.changeRequest.fieldPaths.sort()).toEqual(['contacts.work', 'isEmergencyContact']);
      await details.approveAll(edited.changeRequest.processId as number, [manager, payroll]);
      const afterEdit = (await family(emp2)).items[0];
      expect(afterEdit).toMatchObject({
        isEmergencyContact: false,
        contacts: { cell: '+264811112222', work: '+26461999888' },
      });
    });

    it('lets the family member be a beneficiary, with percentages totalling 100.00', async () => {
      const code = `TF${await nextUnique(t.db)}`;
      const fund = (
        await hr
          .post('/admin/retirement-funds')
          .send({ code, name: `Test Fund ${code}` })
          .expect(201)
      ).body as AdminRetirementFund;
      expect((await emp2.get('/me/funds').expect(200)).body).toMatchObject({
        items: [],
        emptyText: FUNDS_EMPTY_TEXT,
      });
      const membership = (
        await hr
          .post(`/admin/retirement-funds/${fund.id}/memberships`)
          .send({ employeeId: f.employee2.employeeId, memberNumber: 'M-1' })
          .expect(201)
      ).body as AdminFundMembership;
      await hr
        .post(`/admin/retirement-funds/${fund.id}/memberships`)
        .send({ employeeId: f.employee2.employeeId })
        .expect(409);

      const funds = (await emp2.get('/me/funds').expect(200)).body as FundsResponse;
      expect(funds.items).toEqual([
        expect.objectContaining({
          membershipId: membership.membershipId,
          fundCode: code,
          beneficiaries: [],
          totalPercentage: '0.00',
        }),
      ]);

      const path = `/me/funds/${membership.membershipId}/beneficiaries`;
      const short = await emp2.put(path).send({
        version: membership.version,
        beneficiaries: [
          { familyMemberId: memberId, percentage: '60.00' },
          { name: 'Free Person', relationship: 'Sibling', percentage: '39.99' },
        ],
      });
      expect(short.status).toBe(422);
      expect(short.body.errors).toContainEqual({
        path: 'beneficiaries',
        message: 'The percentages must total exactly 100.00 (they total 99.99)',
      });
      const notMine = await emp.put(path).send({
        version: membership.version,
        beneficiaries: [{ familyMemberId: memberId, percentage: '100' }],
      });
      expect(notMine.status).toBe(404);

      const body = details.submitted(
        await emp2.put(path).send({
          version: membership.version,
          beneficiaries: [
            { familyMemberId: memberId, percentage: '60.00' },
            { name: 'Free Person', relationship: 'Sibling', identityNumber: '88010100777', percentage: '40' },
          ],
        }),
      );
      expect(body.changeRequest).toMatchObject({ workflowType: 'BENEFICIARY', entityType: 'FundMembership' });
      expect(JSON.stringify((await details.changeRequest(body.changeRequest.id)).proposed)).not.toContain(
        '88010100777',
      );
      expect(asJson(body)).not.toContain('88010100777');
      await details.approveAll(body.changeRequest.processId as number, [manager, hr]);

      const after = ((await emp2.get('/me/funds').expect(200)).body as FundsResponse).items[0];
      expect(after?.totalPercentage).toBe('100.00');
      expect(after?.version).toBe(membership.version + 1);
      expect(after?.beneficiaries).toEqual([
        expect.objectContaining({
          familyMemberId: memberId,
          name: 'Ndapewa Shikongo',
          relationship: 'Spouse',
          identityNumberMasked: '••••0456',
          percentage: '60.00',
        }),
        expect.objectContaining({
          familyMemberId: null,
          name: 'Free Person',
          relationship: 'Sibling',
          identityNumberMasked: '••••0777',
          percentage: '40.00',
        }),
      ]);
    });

    it('deletes a family member on approval', async () => {
      const member = (await family(emp2)).items[0];
      const body = details.submitted(
        await emp2.delete(`/me/family/${memberId}`).send({ version: member?.version }),
      );
      expect(body.changeRequest.operation).toBe('DELETE');
      await details.approveAll(body.changeRequest.processId as number, [manager, payroll]);
      expect((await family(emp2)).items).toEqual([]);
      expect(
        (await t.db.prisma.familyMember.findUniqueOrThrow({ where: { id: memberId } })).deletedAt,
      ).not.toBeNull();
    });
  });

  describe('employee transactions', () => {
    it('lists recurring transactions and routes employee inputs through FREETEXTMANEMP', async () => {
      const n = await nextUnique(t.db);
      const open = (
        await hr
          .post('/admin/transaction-codes')
          .send({ code: `IN${n}`, description: 'Cellphone claim', allowEmployeeInput: true })
          .expect(201)
      ).body as AdminTransactionCode;
      const closed = (
        await hr
          .post('/admin/transaction-codes')
          .send({ code: `RC${n}`, description: 'Housing' })
          .expect(201)
      ).body as AdminTransactionCode;
      await t.db.tx(systemContext('test'), (tx) =>
        tx.employeeTransaction.create({
          data: {
            employeeId: f.employee.employeeId as number,
            transactionCodeId: closed.id,
            code: closed.code,
            description: closed.description,
            amount: '2500.00',
            isRecurring: true,
            startDate: dateFromBusiness('2024-01-01'),
          },
        }),
      );

      const list = (await emp.get('/me/transactions').expect(200)).body as EmployeeTransactionsResponse;
      expect(list.recurring).toContainEqual(
        expect.objectContaining({
          code: closed.code,
          amount: '2500.00',
          isRecurring: true,
          startDate: '2024-01-01',
        }),
      );
      expect(list.codes.map((c) => c.code)).toContain(open.code);
      expect(list.codes.map((c) => c.code)).not.toContain(closed.code);

      await emp.post('/me/transactions').send({ transactionCodeId: closed.id, amount: '10' }).expect(422);
      const res = await emp
        .post('/me/transactions')
        .send({ transactionCodeId: open.id, amount: '350.5', comment: 'October' });
      expect(res.status, res.text).toBe(201);
      const created = res.body as EmployeeTransaction;
      expect(created).toMatchObject({
        status: 'IN_PROGRESS',
        amount: '350.50',
        isRecurring: false,
        comment: 'October',
      });
      expect(created.referenceNumber).toMatch(/^F\d{6}-N\d{5}$/);
      const process = await details.process(created.processId as number);
      expect(process.subjectEntity).toBe('EmployeeTransaction');
      await details.approveAll(created.processId as number, [manager, hr]);
      const after = (
        (await emp.get('/me/transactions').expect(200)).body as EmployeeTransactionsResponse
      ).submitted.find((s) => s.id === created.id);
      expect(after).toMatchObject({ status: 'PROCESSED', statusLabel: 'Completed' });
      expect(after?.payPeriod).not.toBeNull();
    });
  });

  it('keeps the encryption at rest for licence, family and beneficiary numbers', async () => {
    const crypto = t.app.get(EncryptionService);
    const member = await t.db.prisma.familyMember.findFirstOrThrow({
      where: { employeeId: f.employee2.employeeId as number },
    });
    expect(member.identityNumberEnc).not.toContain('90061500456');
    expect(crypto.decrypt(member.identityNumberEnc as string)).toBe('90061500456');
    const beneficiary = await t.db.prisma.beneficiary.findFirstOrThrow({
      where: { name: 'Free Person', membership: { employeeId: f.employee2.employeeId as number } },
    });
    expect(crypto.decrypt(beneficiary.identityNumberEnc as string)).toBe('88010100777');
    expect(beneficiary.identityNumberLast4).toBe('0777');
  });
});
