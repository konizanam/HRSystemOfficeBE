import {
  type AllocatableEmployeesResponse,
  addDays,
  type ClaimDetail,
  CLAIM_PROBLEM_TYPES,
  ClaimCapProblemSchema,
  COMMON_PROBLEM_TYPES,
  IDEMPOTENCY_IN_PROGRESS_TITLE,
  type InboxItemDetail,
  InboxItemDetailSchema,
  type LeaveApplicationsResponse,
  type LeaveBalanceDefinitionsResponse,
  type LeaveBalancesResponse,
  leaveBalanceRowReconciles,
  NO_CHANGES_MESSAGE,
  type PersonalDetails,
  todayBusinessDate,
} from '@peoplehub/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/audit/canonical-json';
import { systemContext } from '../../src/common/context/security-context';
import { EncryptionService } from '../../src/crypto/encryption.service';
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
  type Person,
  type RoleFixtures,
} from '../support/fixtures';
import { LEAVE_TYPE, LeaveKit } from '../support/leave';
import { WorkflowKit } from '../support/workflow';

const sys = systemContext('test-gaps');

/**
 * The API gaps reported by the web app: leave history sort and filters, balance figures and ESS
 * flags, the leave in lieu allocation picker, the 409 problem types, claim cap line references and
 * the process version, typed inbox subject data, clearing masked numbers, label keys and the
 * session's restricted features.
 */
describe('contract gaps (leave, claims, details, inbox, session)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: WorkflowKit;
  let leave: LeaveKit;
  let claims: ClaimKit;
  let details: DetailsKit;
  let mgr: Agent;
  let hr: Agent;
  let payroll: Agent;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new WorkflowKit(t);
    leave = new LeaveKit(t, kit);
    claims = new ClaimKit(t, kit);
    details = new DetailsKit(t, kit);
    await leave.setup(f.org);
    await claims.setup(f.org);
    await details.setup(f.org);
    [mgr, hr, payroll] = await Promise.all([
      login(t, f.managerB),
      login(t, f.hrAdmin),
      login(t, f.payrollAdmin),
    ]);
  });

  afterAll(async () => {
    kit.restore();
    await t.close();
  });

  /** A fresh employee reporting to manager B, with accrued balances. */
  async function freshEmployee(): Promise<{ person: Person; agent: Agent }> {
    const person = await createPerson(t.db, {
      org: f.org,
      label: 'gaps',
      reportsToId: f.managerB.employeeId,
    });
    await leave.accrue([person.employeeId]);
    return { person, agent: await login(t, person) };
  }

  const inboxDetail = async (agent: Agent, processId: number): Promise<InboxItemDetail> => {
    const res = await agent.get(`/inbox/items/${processId}`);
    expect(res.status, res.text).toBe(200);
    // The typed subject parses with the shared contract.
    return InboxItemDetailSchema.parse(res.body) as InboxItemDetail;
  };

  describe('leave', () => {
    it('sorts and filters the history on the server, paginated', async () => {
      const { agent } = await freshEmployee();
      const sickReason = await t.db.prisma.leaveReason.findFirstOrThrow({
        where: { leaveTypeId: LEAVE_TYPE.sick, isActive: true },
      });
      const d1 = await leave.monday(60, f.org.companyId);
      const d2 = await leave.monday(74, f.org.companyId);
      const d3 = await leave.monday(88, f.org.companyId);
      const a1 = await leave.submit(agent, { leaveTypeId: LEAVE_TYPE.annual, fromDate: d1, toDate: d1 });
      const a2 = await leave.submit(agent, {
        leaveTypeId: LEAVE_TYPE.sick,
        fromDate: d2,
        toDate: d2,
        leaveReasonId: sickReason.id,
      });
      const a3 = await leave.submit(agent, { leaveTypeId: LEAVE_TYPE.annual, fromDate: d3, toDate: d3 });
      const list = async (query: string): Promise<LeaveApplicationsResponse> => {
        const res = await agent.get(`/leave/applications?status=inProgress${query}`);
        expect(res.status, res.text).toBe(200);
        return res.body as LeaveApplicationsResponse;
      };

      const byDefault = await list('');
      expect(byDefault.sort).toBe('fromDate:desc');
      expect(byDefault.items.map((r) => r.id)).toEqual([a3.id, a2.id, a1.id]);
      expect((await list('&sort=fromDate:asc')).items.map((r) => r.id)).toEqual([a1.id, a2.id, a3.id]);
      expect((await list('&sort=submittedAt:asc')).items.map((r) => r.id)).toEqual([a1.id, a2.id, a3.id]);
      const refs = [a1, a2, a3].map((a) => a.referenceNumber).sort();
      expect((await list('&sort=referenceNumber:asc')).items.map((r) => r.referenceNumber)).toEqual(refs);
      expect((await list('&sort=referenceNumber:desc')).items.map((r) => r.referenceNumber)).toEqual(
        [...refs].reverse(),
      );

      expect((await list(`&leaveTypeId=${LEAVE_TYPE.sick}`)).items.map((r) => r.id)).toEqual([a2.id]);
      const ranged = await list(`&from=${addDays(d1, 1)}&to=${d2}`);
      expect(ranged.items.map((r) => r.id)).toEqual([a2.id]);
      expect(ranged.total).toBe(1);
      const suffix = a3.referenceNumber.slice(-8).toLowerCase();
      expect((await list(`&reference=${suffix}`)).items.map((r) => r.id)).toEqual([a3.id]);

      const page = await list('&pageSize=2&page=2');
      expect(page).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(page.items.map((r) => r.id)).toEqual([a1.id]);

      await agent.get('/leave/applications?sort=units:asc').expect(422);
      await agent.get(`/leave/applications?from=${d2}&to=${d1}`).expect(422);
    });

    it('shows adjustments in the bucket grid so every row adds up, and the ESS flags on the cards', async () => {
      const { person, agent } = await freshEmployee();
      const res = await hr.post('/admin/leave/adjustments').send({
        employeeId: person.employeeId,
        leaveTypeId: LEAVE_TYPE.annual,
        units: '-0.2500',
        reason: 'Correction',
      });
      expect(res.status, res.text).toBe(201);
      const day = await leave.monday(40, f.org.companyId);
      await leave.submit(agent, { leaveTypeId: LEAVE_TYPE.annual, fromDate: day, toDate: day });

      const grid = (await agent.get(`/leave/balances/${LEAVE_TYPE.annual}/definitions`).expect(200))
        .body as LeaveBalanceDefinitionsResponse;
      const adjusted = grid.rows.find((r) => r.adjustmentsThisPeriod === '-0.2500');
      expect(adjusted).toBeDefined();
      expect(grid.total.adjustmentsThisPeriod).toBe('-0.2500');
      expect(grid.total.pending).toBe('1.0000');
      for (const row of [...grid.rows, grid.total]) expect(leaveBalanceRowReconciles(row)).toBe(true);
      const type = await t.db.prisma.leaveType.findUniqueOrThrow({ where: { id: LEAVE_TYPE.annual } });
      expect(grid).toMatchObject({
        hideUnitsAvailableForESS: type.hideUnitsAvailableForESS,
        hideZeroUnitsAvailableForESS: type.hideZeroUnitsAvailableForESS,
      });

      const cards = (await agent.get('/leave/balances').expect(200)).body as LeaveBalancesResponse;
      const types = await t.db.prisma.leaveType.findMany({
        where: { id: { in: cards.items.map((c) => c.leaveTypeId) } },
      });
      expect(cards.items.length).toBeGreaterThan(0);
      for (const card of cards.items) {
        const lt = types.find((x) => x.id === card.leaveTypeId);
        expect(card.hideUnitsAvailableForESS).toBe(lt?.hideUnitsAvailableForESS);
        expect(card.hideZeroUnitsAvailableForESS).toBe(lt?.hideZeroUnitsAvailableForESS);
        expect(card.hideUnitsAvailable).toBe(card.hideUnitsAvailableForESS);
      }
    });

    it('lists the employees the caller may allocate leave in lieu to', async () => {
      const indirect = await createPerson(t.db, {
        org: f.org,
        label: 'indirect',
        reportsToId: f.employee.employeeId,
      });
      const leaver = await createPerson(t.db, {
        org: f.org,
        label: 'leaver',
        reportsToId: f.managerB.employeeId,
        employee: { status: 'TERMINATED' },
      });
      const get = async (agent: Agent, query = ''): Promise<AllocatableEmployeesResponse> => {
        const res = await agent.get(`/leave/in-lieu/allocatable-employees?pageSize=100${query}`);
        expect(res.status, res.text).toBe(200);
        return res.body as AllocatableEmployeesResponse;
      };

      const mine = await get(mgr);
      const ids = mine.items.map((r) => r.employeeId);
      expect(ids).toEqual(expect.arrayContaining([f.employee.employeeId, f.employee2.employeeId]));
      expect(ids).not.toContain(f.managerB.employeeId);
      expect(ids).not.toContain(f.unrelated.employeeId);
      expect(ids).not.toContain(indirect.employeeId);
      expect(ids).not.toContain(leaver.employeeId);
      expect(mine.items.every((r) => r.relation === 'REPORT')).toBe(true);
      expect(mine.total).toBe(mine.items.length);
      expect(mine.items.find((r) => r.employeeId === f.employee.employeeId)).toMatchObject({
        employeeCode: f.employee.employeeCode,
        displayName: expect.stringMatching(/^First\d+ Last\d+$/),
        companyRuleId: f.org.companyRuleId,
      });

      const company = await get(hr);
      const companyIds = company.items.map((r) => r.employeeId);
      expect(companyIds).toEqual(
        expect.arrayContaining([f.unrelated.employeeId, f.managerB.employeeId, indirect.employeeId]),
      );
      expect(companyIds).not.toContain(f.hrAdmin.employeeId);
      expect(companyIds).not.toContain(f.otherCompany.employeeId);
      expect(company.items.every((r) => r.relation === 'COMPANY')).toBe(true);

      const searched = await get(hr, `&search=${f.unrelated.employeeCode?.toLowerCase() ?? ''}`);
      expect(searched.items.map((r) => r.employeeId)).toEqual([f.unrelated.employeeId]);
      const paged = (await hr.get('/leave/in-lieu/allocatable-employees?pageSize=1&page=2').expect(200))
        .body as AllocatableEmployeesResponse;
      expect(paged.items).toHaveLength(1);
      expect(paged.total).toBe(company.total);

      await (await login(t, f.employee)).get('/leave/in-lieu/allocatable-employees').expect(403);
    });

    it('answers a stale version and an Idempotency-Key still in progress with distinct problem types', async () => {
      const { person, agent } = await freshEmployee();
      const day = await leave.monday(50, f.org.companyId);
      const body = { leaveTypeId: LEAVE_TYPE.annual, fromDate: day, toDate: day };
      const app = await leave.submit(agent, body, randomUUID());

      const stale = await agent
        .post(`/leave/applications/${app.id}/cancel`)
        .send({ version: app.version + 9 });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({
        type: COMMON_PROBLEM_TYPES.versionConflict,
        current: { version: app.version },
      });

      // A second key whose first request is still running (its record has no response yet).
      const first = await t.db.prisma.idempotencyRecord.findFirstOrThrow({
        where: { userId: person.userId, path: { endsWith: '/leave/applications' } },
        orderBy: { createdAt: 'desc' },
      });
      const key = randomUUID();
      await t.db.prisma.idempotencyRecord.create({
        data: {
          key: sha256Hex(`${person.userId}:POST:${first.path}:${key}`),
          userId: person.userId,
          method: 'POST',
          path: first.path,
          requestHash: first.requestHash,
          responseStatus: 0,
          responseBody: {},
        },
      });
      const running = await agent.post('/leave/applications').set('idempotency-key', key).send(body);
      expect(running.status).toBe(409);
      expect(running.body).toMatchObject({
        type: COMMON_PROBLEM_TYPES.idempotencyInProgress,
        title: IDEMPOTENCY_IN_PROGRESS_TITLE,
      });
      expect(
        await t.db.prisma.leaveApplication.count({ where: { employeeId: person.employeeId ?? 0 } }),
      ).toBe(1);
    });

    it('types the inbox subject of a leave request', async () => {
      const { agent } = await freshEmployee();
      const day = await leave.monday(55, f.org.companyId);
      const app = await leave.submit(agent, { leaveTypeId: LEAVE_TYPE.annual, fromDate: day, toDate: day });
      const detail = await inboxDetail(mgr, app.processId ?? 0);
      expect(detail.subject.kind).toBe('LEAVE');
      expect(detail.subject.data).toMatchObject({
        applicationId: app.id,
        referenceNumber: app.referenceNumber,
      });
    });
  });

  describe('claims', () => {
    it('points cap findings at their line, trims quantities and carries the process version', async () => {
      const { person, agent } = await freshEmployee();
      const groupId = await claims.group();
      const free = await claims.type(groupId, f.org.companyRuleId, { inputMode: 'QUANTITY', rate: '10' });
      const capped = await claims.type(groupId, f.org.companyRuleId, {
        inputMode: 'QUANTITY',
        rate: '50',
        caps: [{ companyRuleId: f.org.companyRuleId, mode: 'BLOCK', quantityLimit: '5', cycle: 'MONTHLY' }],
      });
      const today = todayBusinessDate();
      const draft = await claims.create(agent, {
        groupId,
        lines: [
          { claimTypeId: free, date: today, quantity: '2.5' },
          { claimTypeId: capped, date: today, quantity: '6' },
        ],
      });
      expect(draft.lines.map((l) => [l.quantity, l.quantityDisplay])).toEqual([
        ['2.5000', '2.5'],
        ['6.0000', '6'],
      ]);
      expect(draft.processVersion).toBeNull();
      const lineId = draft.lines[1]?.id;
      expect(draft.capCheck?.blocks).toEqual([
        expect.objectContaining({ claimTypeId: capped, lineIndex: 1, lineId, lineIndexes: [1] }),
      ]);

      const blocked = await agent.post(`/claims/${draft.id}/submit`).send({ version: draft.version });
      expect(blocked.status).toBe(422);
      const problem = ClaimCapProblemSchema.parse(blocked.body);
      expect(problem.type).toBe(CLAIM_PROBLEM_TYPES.capExceeded);
      expect(problem.errors?.[0]?.path).toBe('lines.1.quantity');
      expect(problem.findings).toEqual([
        expect.objectContaining({ lineIndex: 1, lineId, measure: 'QUANTITY' }),
      ]);

      const fixed = await agent.put(`/claims/${draft.id}`).send({
        version: draft.version,
        lines: [
          { id: draft.lines[0]?.id, claimTypeId: free, date: today, quantity: '2.5' },
          { id: lineId, claimTypeId: capped, date: today, quantity: '4' },
        ],
      });
      expect(fixed.status, fixed.text).toBe(200);
      const submitted = await claims.submit(agent, fixed.body as ClaimDetail);
      const process = await kit.process(submitted.processId ?? 0);
      expect(submitted.processVersion).toBe(process.version);
      const read = (await agent.get(`/claims/${submitted.id}`).expect(200)).body as ClaimDetail;
      expect(read.processVersion).toBe(process.version);

      const detail = await inboxDetail(mgr, submitted.processId ?? 0);
      expect(detail.subject.kind).toBe('CLAIM');
      if (detail.subject.kind === 'CLAIM') {
        expect(detail.subject.data.lines.map((l) => l.quantityDisplay)).toEqual(['2.5', '4']);
      }
      expect(person.employeeId).toBe(submitted.employee.id);
    });
  });

  describe('my details', () => {
    it('clears a masked number with { clear: true }, audited as a change to null, with label keys', async () => {
      const { person, agent } = await freshEmployee();
      const crypto = t.app.get(EncryptionService);
      await t.db.tx(sys, (tx) =>
        tx.employee.update({
          where: { id: person.employeeId ?? 0 },
          data: { passportNumberEnc: crypto.encrypt('P7654567'), passportNumberLast4: '4567' },
        }),
      );
      const before = (await agent.get('/me/personal').expect(200)).body as PersonalDetails;
      expect(before.identity.passportNumberMasked).toBe('••••4567');

      const empty = await agent
        .put('/me/personal')
        .send({ version: before.version, identity: { taxNumber: { clear: true } } });
      expect(empty.status).toBe(422);
      expect(empty.body.detail).toBe(NO_CHANGES_MESSAGE);
      await agent
        .put('/me/personal')
        .send({ version: before.version, identity: { passportNumber: { clear: false } } })
        .expect(422);

      const since = await lastAuditId(t.db);
      const res = await agent.put('/me/personal').send({
        version: before.version,
        identity: { passportNumber: { clear: true }, knownAs: 'Gap' },
      });
      const cr = details.submitted(res).changeRequest;
      expect(cr.changes).toEqual(
        expect.arrayContaining([
          {
            path: 'identity.passportNumber',
            label: 'Passport Number',
            labelKey: 'details.personal.passportNumber',
            from: '••••4567',
            to: null,
          },
          expect.objectContaining({ path: 'identity.knownAs', labelKey: 'details.personal.knownAs' }),
        ]),
      );

      const processId = cr.processId ?? 0;
      const inbox = await inboxDetail(mgr, processId);
      expect(inbox.subject.kind).toBe('CHANGE_REQUEST');
      if (inbox.subject.kind === 'CHANGE_REQUEST') {
        expect(inbox.subject.data).toMatchObject({
          changeRequestId: cr.id,
          entityType: 'Employee',
          entityLabel: 'Personal details',
          revealed: false,
        });
      }

      await details.approveAll(processId, [mgr, payroll]);
      const after = (await agent.get('/me/personal').expect(200)).body as PersonalDetails;
      expect(after.identity.passportNumberMasked).toBeNull();
      expect(after.identity.knownAs).toBe('Gap');
      const stored = await t.db.prisma.employee.findUniqueOrThrow({ where: { id: person.employeeId ?? 0 } });
      expect(stored.passportNumberEnc).toBeNull();
      const [audit] = await auditSince(t.db, since, { action: 'EMPLOYEE.PERSONAL_DETAILS_UPDATED' });
      expect(audit?.changes).toEqual(
        expect.arrayContaining([{ path: 'identity.passportNumber', from: '••••4567', to: null }]),
      );
    });
  });

  describe('session', () => {
    it('restricts ID and bank account numbers while working as someone else', async () => {
      const agent = await login(t, f.managerB);
      await agent.put('/session/acting-as').send({ employeeId: f.employee.employeeId }).expect(200);
      const session = (await agent.get('/session').expect(200)).body as { restrictedFeatures: string[] };
      expect(session.restrictedFeatures).toEqual(
        expect.arrayContaining(['PAYSLIPS', 'TAX_CERTIFICATES', 'ID_NUMBERS', 'BANK_ACCOUNT_NUMBERS']),
      );
      const personal = (await agent.get('/me/personal').expect(200)).body as PersonalDetails;
      expect(personal.idNumbersRestricted).toBe(true);
      await agent.get('/me/personal/id-numbers').expect(403);
    });
  });
});
