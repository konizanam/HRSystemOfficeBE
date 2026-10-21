import {
  addDays,
  type AdminFundMember,
  type AdminFundMembership,
  type AdminFundMembershipsResponse,
  type AdminLookupValue,
  type AdminPublicHoliday,
  type AdminRetirementFund,
  type AdminTransactionCode,
  AuditActorOptionsResponseSchema,
  AuditListResponseSchema,
  type ClaimDetail,
  ClaimDetailSchema,
  EmployeePickerResponseSchema,
  type FundsResponse,
  InboxItemDetailSchema,
  InboxItemsResponseSchema,
  type LookupResponse,
  type PersonalDetails,
  todayBusinessDate,
  UserOptionsResponseSchema,
} from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_USER_ID, systemContext } from '../../src/common/context/security-context';
import { startTestApp, type TestApp } from '../support/app';
import { ClaimKit } from '../support/claims';
import { DetailsKit } from '../support/details';
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
import { WorkflowKit } from '../support/workflow';

/**
 * The last API gaps reported by the web app: the inbox subject entity, fund memberships (list and
 * end), the SPECIFIC_USER step picker, DELETE for lookups and transaction codes, names and pickers
 * in the audit explorer, holiday restore, HR editing addresses and contacts, and the claim
 * `canResubmit` flag.
 */
describe('final API gaps', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let claims: ClaimKit;
  let hr: Agent;
  let emp: Agent;
  let mgr: Agent;
  let auditor: Agent;
  let sysAdmin: Agent;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    claims = new ClaimKit(t, kit);
    await claims.setup(f.org);
    await new DetailsKit(t, kit).setup(f.org);
    [hr, emp, mgr, auditor, sysAdmin] = await Promise.all([
      login(t, f.hrAdmin),
      login(t, f.employee),
      login(t, f.managerB),
      login(t, f.auditor),
      login(t, f.sysAdmin),
    ]);
  });

  afterAll(async () => {
    kit.restore();
    await t.close();
  });

  /** A submitted one-line claim of the fixture employee. */
  async function submittedClaim(): Promise<ClaimDetail> {
    const groupId = await claims.group();
    const typeId = await claims.type(groupId, f.org.companyRuleId, { inputMode: 'QUANTITY', rate: '10' });
    const draft = await claims.create(emp, {
      groupId,
      lines: [{ claimTypeId: typeId, date: todayBusinessDate(), quantity: '1.5' }],
    });
    return claims.submit(emp, draft);
  }

  describe('inbox subject entity', () => {
    it('names the subject record on the card and the detail', async () => {
      const claim = await submittedClaim();
      const processId = claim.processId ?? 0;
      const detail = InboxItemDetailSchema.parse(
        (await mgr.get(`/inbox/items/${processId}`).expect(200)).body,
      );
      expect(detail.subjectEntity).toBe('Claim');
      expect(detail.subjectEntityId).toBe(String(claim.id));
      expect(detail.card.subjectEntity).toBe('Claim');
      expect(detail.card.subjectEntityId).toBe(String(claim.id));

      const list = InboxItemsResponseSchema.parse(
        (await emp.get('/inbox/items?box=submitted&pageSize=100').expect(200)).body,
      );
      const card = list.items.find((c) => c.processId === processId);
      expect(card).toMatchObject({ subjectEntity: 'Claim', subjectEntityId: String(claim.id) });

      // The record history opens with those values.
      await mgr.get(`/audit/entity/${detail.subjectEntity}/${detail.subjectEntityId}`).expect(200);
    });
  });

  describe('claim canResubmit', () => {
    it('is true only for the applicant while the claim is sent back', async () => {
      const claim = await submittedClaim();
      expect(claim.canResubmit).toBe(false);
      const p = await kit.process(claim.processId ?? 0);
      await mgr
        .post(`/workflow/processes/${p.id}/send-back`)
        .send({ version: p.version, comment: 'Please fix' })
        .expect(200);

      const mine = ClaimDetailSchema.parse((await emp.get(`/claims/${claim.id}`).expect(200)).body);
      expect(mine.status).toBe('RESUBMIT_REQUIRED');
      expect(mine.canResubmit).toBe(true);
      for (const agent of [mgr, hr, auditor]) {
        const res = await agent.get(`/claims/${claim.id}`);
        if (res.status === 200) expect((res.body as ClaimDetail).canResubmit).toBe(false);
      }

      const resubmitted = await emp
        .post(`/workflow/processes/${p.id}/resubmit`)
        .send({ version: mine.processVersion, comment: 'Fixed' });
      expect(resubmitted.status, resubmitted.text).toBe(200);
      const after = (await emp.get(`/claims/${claim.id}`).expect(200)).body as ClaimDetail;
      expect(after.canResubmit).toBe(false);
    });
  });

  describe('fund memberships', () => {
    it('lists the members in HR scope, ends a membership (audited) and reopens it', async () => {
      const n = await nextUnique(t.db);
      const fund = (
        await hr
          .post('/admin/retirement-funds')
          .send({ code: `FG${n}`, name: `Final Gaps Fund ${n}` })
          .expect(201)
      ).body as AdminRetirementFund;
      const start = addDays(todayBusinessDate(), -60);
      const enrol = async (employeeId: number | null, memberNumber: string) => {
        const res = await hr
          .post(`/admin/retirement-funds/${fund.id}/memberships`)
          .send({ employeeId, memberNumber, startDate: start });
        expect(res.status, res.text).toBe(201);
        return res.body as AdminFundMembership;
      };
      const m1 = await enrol(f.employee.employeeId, `M-${n}-1`);
      await enrol(f.employee2.employeeId, `M-${n}-2`);
      expect(m1.endDate).toBeNull();
      // A member of another company (enrolled by the system) stays out of HR's list.
      await t.db.tx(systemContext('test-final-gaps'), (tx) =>
        tx.fundMembership.create({ data: { employeeId: f.otherCompany.employeeId ?? 0, fundId: fund.id } }),
      );

      const list = (await hr.get(`/admin/retirement-funds/${fund.id}/memberships`).expect(200))
        .body as AdminFundMembershipsResponse;
      expect(list.total).toBe(2);
      expect(list.items.map((m) => m.employeeId).sort()).toEqual(
        [f.employee.employeeId, f.employee2.employeeId].sort(),
      );
      const row = list.items.find((m) => m.membershipId === m1.membershipId);
      expect(row).toMatchObject({
        employeeCode: f.employee.employeeCode,
        memberNumber: `M-${n}-1`,
        startDate: start,
        endDate: null,
        isActive: true,
        beneficiaryCount: 0,
      });
      expect(row?.employeeName).toMatch(/\S+ \S+/);
      const searched = (
        await hr.get(`/admin/retirement-funds/${fund.id}/memberships?search=M-${n}-2`).expect(200)
      ).body as AdminFundMembershipsResponse;
      expect(searched.items.map((m) => m.employeeId)).toEqual([f.employee2.employeeId]);
      await hr.get('/admin/retirement-funds/999999999/memberships').expect(404);

      const base = `/admin/retirement-funds/${fund.id}/memberships/${m1.membershipId}/end`;
      await hr.post(base).send({ version: 999 }).expect(409);
      const early = await hr.post(base).send({ version: m1.version, endDate: addDays(start, -1) });
      expect(early.status).toBe(422);
      expect(early.body.errors[0].path).toBe('endDate');

      const yesterday = addDays(todayBusinessDate(), -1);
      const since = await lastAuditId(t.db);
      const ended = await hr.post(base).send({ version: m1.version, endDate: yesterday });
      expect(ended.status, ended.text).toBe(200);
      expect(ended.body as AdminFundMember).toMatchObject({ endDate: yesterday, isActive: false });
      const [audit] = await auditSince(t.db, since, { action: 'FUND_MEMBERSHIP.ENDED' });
      expect(audit).toMatchObject({ entityType: 'FundMembership', subjectEmployeeId: f.employee.employeeId });
      await hr
        .post(base)
        .send({ version: (ended.body as AdminFundMember).version })
        .expect(409);

      const open = (await hr.get(`/admin/retirement-funds/${fund.id}/memberships`).expect(200))
        .body as AdminFundMembershipsResponse;
      expect(open.items.map((m) => m.membershipId)).not.toContain(m1.membershipId);
      const all = (
        await hr.get(`/admin/retirement-funds/${fund.id}/memberships?includeEnded=true`).expect(200)
      ).body as AdminFundMembershipsResponse;
      expect(all.items.find((m) => m.membershipId === m1.membershipId)?.isActive).toBe(false);
      const mine = (await emp.get('/me/funds').expect(200)).body as FundsResponse;
      expect(mine.items.map((m) => m.fundId)).not.toContain(fund.id);

      const reopened = await enrol(f.employee.employeeId, `M-${n}-1b`);
      expect(reopened).toMatchObject({
        membershipId: m1.membershipId,
        endDate: null,
        memberNumber: `M-${n}-1b`,
      });
      expect(await auditSince(t.db, since, { action: 'FUND_MEMBERSHIP.REOPENED' })).toHaveLength(1);
      const back = (await emp.get('/me/funds').expect(200)).body as FundsResponse;
      expect(back.items.map((m) => m.fundId)).toContain(fund.id);
    });
  });

  describe('SPECIFIC_USER step picker', () => {
    it('lists active users of HR’s companies and users without an employee', async () => {
      const loose = await createPerson(t.db, { org: f.org, label: 'no-employee', withEmployee: false });
      const options = async (search: string) =>
        UserOptionsResponseSchema.parse(
          (
            await hr
              .get(`/admin/workflow-definitions/user-options?search=${encodeURIComponent(search)}`)
              .expect(200)
          ).body,
        ).items.map((i) => i.userId);
      expect(await options(f.employee.employeeCode ?? '')).toEqual([f.employee.userId]);
      expect(await options(f.otherCompany.employeeCode ?? '')).toEqual([]);
      expect(await options(loose.username)).toEqual([loose.userId]);
      expect(await options(f.hrAdmin.employeeCode ?? '')).toEqual([f.hrAdmin.userId]);
      expect(await options('system')).not.toContain(SYSTEM_USER_ID);
      // The same-company picker of /workflow/user-options never lists users without an employee.
      const same = UserOptionsResponseSchema.parse(
        (await hr.get(`/workflow/user-options?search=${loose.username}`).expect(200)).body,
      );
      expect(same.items).toEqual([]);
    });
  });

  describe('deletes', () => {
    it('DELETE /admin/lookups/:table/:id deactivates the value', async () => {
      const n = await nextUnique(t.db);
      const created = (
        await hr
          .post('/admin/lookups/titles')
          .send({ code: `FG${n}`, description: `Final ${n}` })
          .expect(201)
      ).body as AdminLookupValue;
      await hr.delete(`/admin/lookups/titles/${created.id}`).send({ version: 999 }).expect(409);
      await hr
        .delete(`/admin/lookups/languages/${created.id}`)
        .send({ version: created.version })
        .expect(404);
      const since = await lastAuditId(t.db);
      const res = await hr.delete(`/admin/lookups/titles/${created.id}`).send({ version: created.version });
      expect(res.status, res.text).toBe(200);
      expect(res.body as AdminLookupValue).toMatchObject({ isActive: false, version: created.version + 1 });
      expect(
        await auditSince(t.db, since, { action: 'LOOKUP.DEACTIVATED', entityId: String(created.id) }),
      ).toHaveLength(1);
      const lookup = (await emp.get('/lookups/titles').expect(200)).body as LookupResponse;
      expect(lookup.items.map((i) => i.code)).not.toContain(`FG${n}`);
    });

    it('DELETE /admin/transaction-codes/:id deactivates the code', async () => {
      const n = await nextUnique(t.db);
      const created = (
        await hr
          .post('/admin/transaction-codes')
          .send({ code: `FG${n}`, description: `Final ${n}`, allowEmployeeInput: true })
          .expect(201)
      ).body as AdminTransactionCode;
      await hr.delete(`/admin/transaction-codes/${created.id}`).send({ version: 999 }).expect(409);
      const since = await lastAuditId(t.db);
      const res = await hr
        .delete(`/admin/transaction-codes/${created.id}`)
        .send({ version: created.version });
      expect(res.status, res.text).toBe(200);
      expect(res.body as AdminTransactionCode).toMatchObject({ isActive: false });
      expect(
        await auditSince(t.db, since, {
          action: 'TRANSACTION_CODE.DEACTIVATED',
          entityId: String(created.id),
        }),
      ).toHaveLength(1);
    });
  });

  describe('audit explorer', () => {
    it('adds the acting-as and subject names to the list rows', async () => {
      const employee = await t.db.prisma.employee.findUniqueOrThrow({
        where: { id: f.employee.employeeId ?? 0 },
      });
      const name = `${employee.firstName} ${employee.lastName}`;
      for (const agent of [auditor, sysAdmin]) {
        const res = await agent.get(`/audit?subjectEmployeeId=${employee.id}&pageSize=5`).expect(200);
        const page = AuditListResponseSchema.parse(res.body);
        expect(page.items.length).toBeGreaterThan(0);
        for (const row of page.items) expect(row.subjectEmployeeName).toBe(name);
      }
      const acted = AuditListResponseSchema.parse(
        (await auditor.get(`/audit?actorUserId=${f.employee.userId}&pageSize=5`).expect(200)).body,
      );
      const withActing = acted.items.filter((r) => r.actingAsEmployeeId === employee.id);
      expect(withActing.length).toBeGreaterThan(0);
      for (const row of withActing) expect(row.actingAsEmployeeName).toBe(name);
      // The stored row is unchanged: the detail has no names.
      const detail = (await auditor.get(`/audit/${acted.items[0]?.id}`).expect(200)).body as Record<
        string,
        unknown
      >;
      expect(detail).not.toHaveProperty('subjectEmployeeName');
    });

    it('offers every employee and login to auditors and system admins', async () => {
      const code = f.otherCompany.employeeCode ?? '';
      for (const agent of [auditor, sysAdmin]) {
        const people = EmployeePickerResponseSchema.parse(
          (await agent.get(`/audit/employee-options?search=${code}`).expect(200)).body,
        );
        expect(people.items.map((p) => p.id)).toEqual([f.otherCompany.employeeId]);
        const actors = AuditActorOptionsResponseSchema.parse(
          (await agent.get(`/audit/actor-options?search=${f.otherCompany.username}`).expect(200)).body,
        );
        expect(actors.items).toEqual([
          expect.objectContaining({
            userId: f.otherCompany.userId,
            employeeId: f.otherCompany.employeeId,
            isActive: true,
          }),
        ]);
      }
      // The scoped picker still shows a system admin only themself.
      const scoped = EmployeePickerResponseSchema.parse(
        (await sysAdmin.get(`/lookups/employees?search=${code}`).expect(200)).body,
      );
      expect(scoped.items).toEqual([]);
      const system = AuditActorOptionsResponseSchema.parse(
        (await auditor.get('/audit/actor-options?search=system&pageSize=100').expect(200)).body,
      );
      expect(system.items.map((a) => a.userId)).toContain(SYSTEM_USER_ID);
    });
  });

  describe('holiday restore', () => {
    it('restores a deleted holiday, audited, with the version', async () => {
      const n = await nextUnique(t.db);
      const date = addDays('2090-01-01', n % 3000);
      const created = (
        await hr
          .post('/admin/public-holidays')
          .send({ companyId: f.org.companyId, date, name: `Restore ${n}` })
          .expect(201)
      ).body as AdminPublicHoliday;
      const restorePath = `/admin/public-holidays/${created.id}/restore`;
      await hr.post(restorePath).send({ version: created.version }).expect(422);
      const deleted = (
        await hr.delete(`/admin/public-holidays/${created.id}`).send({ version: created.version }).expect(200)
      ).body as AdminPublicHoliday;
      expect(deleted.isDeleted).toBe(true);
      await hr.post(restorePath).send({ version: created.version }).expect(409);
      const since = await lastAuditId(t.db);
      const res = await hr.post(restorePath).send({ version: deleted.version });
      expect(res.status, res.text).toBe(200);
      expect(res.body as AdminPublicHoliday).toMatchObject({
        isDeleted: false,
        name: `Restore ${n}`,
        date,
        version: deleted.version + 1,
      });
      expect(
        await auditSince(t.db, since, { action: 'HOLIDAY.RESTORED', entityId: String(created.id) }),
      ).toHaveLength(1);
      const other = await login(t, f.otherCompany);
      await other
        .post(restorePath)
        .send({ version: deleted.version + 1 })
        .expect(403);
    });
  });

  describe('HR personal details', () => {
    it('edits addresses and contacts through PUT /admin/employees/:id/personal', async () => {
      const id = f.unrelated.employeeId ?? 0;
      const before = (await hr.get(`/admin/employees/${id}/personal`).expect(200)).body as PersonalDetails;
      const res = await hr.put(`/admin/employees/${id}/personal`).send({
        version: before.version,
        physicalAddress: { streetNumber: '12', streetName: 'Independence Avenue', city: 'Windhoek' },
        contacts: { cell: '+264811234567', email: 'final.gaps@example.com' },
        otherContacts: [{ type: 'EMAIL', value: 'other.gaps@example.com' }],
      });
      expect(res.status, res.text).toBe(200);
      const after = (await hr.get(`/admin/employees/${id}/personal`).expect(200)).body as PersonalDetails;
      expect(after.version).toBe(before.version + 1);
      expect(JSON.stringify(after)).toContain('Independence Avenue');
      expect(JSON.stringify(after)).toContain('final.gaps@example.com');
      expect(JSON.stringify(after)).toContain('other.gaps@example.com');
    });
  });
});
