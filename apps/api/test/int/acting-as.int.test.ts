import { AUTH_PROBLEM_TYPES, RESTRICTED_FEATURES } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SecurityContext, systemContext } from '../../src/common/context/security-context';
import { ForbiddenError, NotFoundError } from '../../src/common/errors/domain-errors';
import { ScopeService } from '../../src/modules/auth/scope.service';
import { SessionService } from '../../src/modules/auth/session.service';
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

describe('"Working as" and data scoping (section 4.2)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let scope: ScopeService;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    scope = t.app.get(ScopeService);
  });

  afterAll(async () => {
    await t.close();
  });

  async function contextOf(agent: Agent): Promise<SecurityContext> {
    const auth = await t.app.get(SessionService).authenticate(agent.sessionToken, {
      requestId: 'test',
      ip: agent.ip,
      userAgent: 'vitest',
    });
    return auth.ctx;
  }

  async function optionIds(person: Person, search?: string): Promise<number[]> {
    const agent = await login(t, person);
    const res = await agent
      .get(`/session/acting-as/options${search ? `?search=${encodeURIComponent(search)}` : ''}`)
      .expect(200);
    return (res.body.items as { employeeId: number }[]).map((i) => i.employeeId);
  }

  async function withMaxDepth<T>(depth: number, fn: () => Promise<T>): Promise<T> {
    const previous = await t.settings.get('workingAs.maxDepth');
    await t.settings.update(systemContext('test'), { 'workingAs.maxDepth': depth });
    try {
      return await fn();
    } finally {
      await t.settings.update(systemContext('test'), { 'workingAs.maxDepth': previous });
    }
  }

  describe('options grid', () => {
    it('lists self first, then direct reports, for a manager', async () => {
      const agent = await login(t, f.managerB);
      const res = await agent.get('/session/acting-as/options').expect(200);
      expect(res.body.truncated).toBe(false);
      expect(res.body.items[0]).toMatchObject({
        employeeId: f.managerB.employeeId,
        isSelf: true,
        employeeCode: f.managerB.employeeCode,
        companyRule: 'Staff',
        status: 'ACTIVE',
      });
      expect(res.body.items.map((i: { employeeId: number }) => i.employeeId).sort()).toEqual(
        [f.managerB.employeeId, f.employee.employeeId, f.employee2.employeeId].sort(),
      );
    });

    it('stops at workingAs.maxDepth (default 1)', async () => {
      expect((await optionIds(f.managerA)).sort()).toEqual(
        [f.managerA.employeeId, f.managerB.employeeId].sort(),
      );
    });

    it('lists only self for an employee', async () => {
      expect(await optionIds(f.employee)).toEqual([f.employee.employeeId]);
    });

    it('lists everyone in the company for HR_ADMIN, and supports search', async () => {
      const ids = await optionIds(f.hrAdmin);
      expect(ids[0]).toBe(f.hrAdmin.employeeId);
      for (const p of [f.managerA, f.managerB, f.employee, f.unrelated, f.payrollAdmin]) {
        expect(ids).toContain(p.employeeId);
      }
      expect(ids).not.toContain(f.otherCompany.employeeId);
      expect(await optionIds(f.hrAdmin, f.unrelated.employeeCode ?? '')).toEqual([f.unrelated.employeeId]);
    });
  });

  describe('PUT /session/acting-as', () => {
    it('allows self without an audit row', async () => {
      const agent = await login(t, f.employee);
      const since = await lastAuditId(t.db);
      const res = await agent
        .put('/session/acting-as')
        .send({ employeeId: f.employee.employeeId })
        .expect(200);
      expect(res.body.isActingForOther).toBe(false);
      expect(await auditSince(t.db, since, { action: 'SECURITY.ACTING_AS_CHANGED' })).toHaveLength(0);
    });

    it('lets a manager work as a direct report, stores it on the session and audits it', async () => {
      const agent = await login(t, f.managerB);
      const since = await lastAuditId(t.db);
      const res = await agent
        .put('/session/acting-as')
        .send({ employeeId: f.employee.employeeId })
        .expect(200);
      expect(res.body).toMatchObject({
        isActingForOther: true,
        selfEmployee: { id: f.managerB.employeeId },
        actingAs: { id: f.employee.employeeId },
      });
      expect(res.body.restrictedFeatures).toEqual([...RESTRICTED_FEATURES]);

      const ctx = await contextOf(agent);
      expect(ctx.actingAsEmployeeId).toBe(f.employee.employeeId);
      expect((await agent.get('/session').expect(200)).body.actingAs.id).toBe(f.employee.employeeId);

      const rows = await auditSince(t.db, since, { action: 'SECURITY.ACTING_AS_CHANGED' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: f.managerB.userId,
        subjectEmployeeId: f.employee.employeeId,
        entityType: 'Session',
      });
      expect(rows[0]?.metadata).toMatchObject({ from: f.managerB.employeeId, to: f.employee.employeeId });

      // Later writes carry both the actor and the subject.
      const pairingSince = await lastAuditId(t.db);
      await agent.post('/profile/mobile/pairing').expect(201);
      const [pairing] = await auditSince(t.db, pairingSince, { action: 'AUTH.MOBILE_PAIRING_CREATED' });
      expect(pairing).toMatchObject({
        actorUserId: f.managerB.userId,
        actingAsEmployeeId: f.employee.employeeId,
      });

      // And back to self.
      const back = await agent
        .put('/session/acting-as')
        .send({ employeeId: f.managerB.employeeId })
        .expect(200);
      expect(back.body.isActingForOther).toBe(false);
      expect(back.body.restrictedFeatures).toEqual([]);
    });

    it('refuses a non-report with 403 and a DENIED audit row', async () => {
      const agent = await login(t, f.managerB);
      const since = await lastAuditId(t.db);
      const res = await agent
        .put('/session/acting-as')
        .send({ employeeId: f.unrelated.employeeId })
        .expect(403);
      expect(res.body.detail).toBe('You cannot work as this employee');
      const rows = await auditSince(t.db, since, { requestId: res.headers['x-request-id'] as string });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'SECURITY.ACCESS_DENIED',
        outcome: 'DENIED',
        actorUserId: f.managerB.userId,
        subjectEmployeeId: f.unrelated.employeeId,
      });
      expect((await agent.get('/session').expect(200)).body.actingAs.id).toBe(f.managerB.employeeId);
    });

    it('refuses an employee of another company', async () => {
      const manager = await login(t, f.managerB);
      await manager.put('/session/acting-as').send({ employeeId: f.otherCompany.employeeId }).expect(403);
      const hr = await login(t, f.hrAdmin);
      await hr.put('/session/acting-as').send({ employeeId: f.otherCompany.employeeId }).expect(403);
    });

    it('lets HR_ADMIN work as anyone in their company', async () => {
      const hr = await login(t, f.hrAdmin);
      await hr.put('/session/acting-as').send({ employeeId: f.unrelated.employeeId }).expect(200);
    });

    it('refuses a plain employee working as a colleague, and unknown employees', async () => {
      const agent = await login(t, f.employee);
      await agent.put('/session/acting-as').send({ employeeId: f.employee2.employeeId }).expect(403);
      await agent.put('/session/acting-as').send({ employeeId: 2_000_000_000 }).expect(404);
      await agent.put('/session/acting-as').send({ employeeId: 0 }).expect(422);
    });

    it('reaches indirect reports only when workingAs.maxDepth allows it', async () => {
      const agent = await login(t, f.managerA);
      await agent.put('/session/acting-as').send({ employeeId: f.employee.employeeId }).expect(403);
      await withMaxDepth(2, async () => {
        await agent.put('/session/acting-as').send({ employeeId: f.employee.employeeId }).expect(200);
        expect(await optionIds(f.managerA)).toContain(f.employee.employeeId);
      });
      // With the depth back at 1 the stored choice is no longer allowed: it falls back to self.
      const since = await lastAuditId(t.db);
      const res = await agent.get('/session').expect(200);
      expect(res.body.actingAs.id).toBe(f.managerA.employeeId);
      const rows = await auditSince(t.db, since, { action: 'SECURITY.ACTING_AS_CHANGED' });
      expect(rows[0]?.metadata).toMatchObject({ automatic: true, from: f.employee.employeeId });
    });
  });

  describe('restricted features while working as someone else', () => {
    it('refuses a password change with 403 and a DENIED audit row naming the feature', async () => {
      const agent = await login(t, f.managerB);
      await agent.put('/session/acting-as').send({ employeeId: f.employee2.employeeId }).expect(200);
      const since = await lastAuditId(t.db);
      const res = await agent
        .post('/auth/password/change')
        .send({ currentPassword: f.managerB.password, newPassword: 'Another-Password-9' })
        .expect(403);
      expect(res.body.type).toBe(AUTH_PROBLEM_TYPES.restrictedFeature);
      expect(res.body.detail).toBe('Change password is not available while working as someone else');

      const rows = await auditSince(t.db, since, { requestId: res.headers['x-request-id'] as string });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'SECURITY.ACCESS_DENIED',
        outcome: 'DENIED',
        actorUserId: f.managerB.userId,
        actingAsEmployeeId: f.employee2.employeeId,
        subjectEmployeeId: f.employee2.employeeId,
      });
      expect(rows[0]?.metadata).toMatchObject({ feature: 'PASSWORD', restricted: true, status: 403 });

      // Back as self the same request reaches the password check.
      await agent.put('/session/acting-as').send({ employeeId: f.managerB.employeeId }).expect(200);
      await agent
        .post('/auth/password/change')
        .send({ currentPassword: 'Not-The-Password-1', newPassword: 'Another-Password-9' })
        .expect(422);
    });

    it('follows workingAs.restrictedFeatures', async () => {
      const agent = await login(t, f.managerB);
      await agent.put('/session/acting-as').send({ employeeId: f.employee.employeeId }).expect(200);
      const ctx = await contextOf(agent);
      const previous = await t.settings.get('workingAs.restrictedFeatures');
      await t.settings.update(systemContext('test'), { 'workingAs.restrictedFeatures': ['PAYSLIPS'] });
      try {
        await expect(scope.assertNotRestricted(ctx, 'PASSWORD')).resolves.toBeUndefined();
        await expect(scope.assertNotRestricted(ctx, 'PAYSLIPS')).rejects.toBeInstanceOf(ForbiddenError);
        expect((await agent.get('/session').expect(200)).body.restrictedFeatures).toEqual(['PAYSLIPS']);
      } finally {
        await t.settings.update(systemContext('test'), { 'workingAs.restrictedFeatures': previous });
      }
      const self = await contextOf(await login(t, f.employee));
      await expect(scope.assertNotRestricted(self, 'PAYSLIPS')).resolves.toBeUndefined();
    });
  });

  describe('ScopeService', () => {
    it('lists reports within a depth and survives reporting cycles', async () => {
      expect((await scope.reportIdsWithinDepth(f.managerA.employeeId as number, 1)).sort()).toEqual([
        f.managerB.employeeId,
      ]);
      expect(
        (await scope.reportIdsWithinDepth(f.managerA.employeeId as number, 2)).sort((a, b) => a - b),
      ).toEqual(
        [f.managerB.employeeId, f.employee.employeeId, f.employee2.employeeId].sort(
          (a, b) => (a ?? 0) - (b ?? 0),
        ),
      );
      expect(await scope.reportIdsWithinDepth(f.employee.employeeId as number)).toEqual([]);
      expect(await scope.reportIdsWithinDepth(f.managerA.employeeId as number, 0)).toEqual([]);

      const a = await createPerson(t.db, { org: f.org, roles: ['EMPLOYEE', 'MANAGER'] });
      const b = await createPerson(t.db, { org: f.org, reportsToId: a.employeeId });
      await t.db.tx(systemContext(), (tx) =>
        tx.employee.update({ where: { id: a.employeeId as number }, data: { reportsToId: b.employeeId } }),
      );
      expect(await scope.reportIdsWithinDepth(a.employeeId as number, 5)).toEqual([b.employeeId]);
      expect(await scope.isReportWithinDepth(a.employeeId as number, b.employeeId as number, 5)).toBe(true);
      expect(await scope.isReportWithinDepth(a.employeeId as number, a.employeeId as number, 5)).toBe(false);
    });

    it('checks access per purpose', async () => {
      const ctxOf = async (p: Person) => contextOf(await login(t, p));
      const [manager, hr, payroll, auditor, employee] = await Promise.all([
        ctxOf(f.managerB),
        ctxOf(f.hrAdmin),
        ctxOf(f.payrollAdmin),
        ctxOf(f.auditor),
        ctxOf(f.employee),
      ]);
      const id = (p: Person) => p.employeeId as number;

      await expect(
        scope.assertCanAccessEmployee(employee, id(f.employee), 'SELF_SERVICE'),
      ).resolves.toMatchObject({
        id: id(f.employee),
        companyId: f.org.companyId,
      });
      await expect(
        scope.assertCanAccessEmployee(employee, id(f.employee2), 'SELF_SERVICE'),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(scope.assertCanAccessEmployee(manager, id(f.employee), 'TEAM')).resolves.toBeDefined();
      await expect(scope.assertCanAccessEmployee(manager, id(f.unrelated), 'TEAM')).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(scope.assertCanAccessEmployee(hr, id(f.unrelated), 'HR_WRITE')).resolves.toBeDefined();
      await expect(scope.assertCanAccessEmployee(hr, id(f.otherCompany), 'HR_READ')).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(scope.assertCanAccessEmployee(payroll, id(f.unrelated), 'PAYROLL')).resolves.toBeDefined();
      await expect(
        scope.assertCanAccessEmployee(payroll, id(f.unrelated), 'HR_WRITE'),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        scope.assertCanAccessEmployee(auditor, id(f.otherCompany), 'AUDIT'),
      ).resolves.toBeDefined();
      await expect(scope.assertCanAccessEmployee(employee, id(f.employee), 'AUDIT')).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(scope.assertCanAccessEmployee(hr, 2_000_000_000, 'HR_READ')).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        scope.assertCanAccessEmployee(systemContext(), id(f.otherCompany), 'HR_WRITE'),
      ).resolves.toBeDefined();

      expect(hr.companyIds).toEqual([f.org.companyId]);
      expect(manager.companyIds).toEqual([]);
      expect(await scope.canActFor(manager, id(f.employee))).toBe(true);
      expect(await scope.canActFor(manager, id(f.otherCompany))).toBe(false);
    });

    it('gives an HR admin without an employee record every company (ASSUMPTION B14)', async () => {
      const admin = await createPerson(t.db, { org: f.org, roles: ['HR_ADMIN'], withEmployee: false });
      const agent = await login(t, admin);
      const ctx = await contextOf(agent);
      expect(ctx.selfEmployeeId).toBeNull();
      expect(ctx.actingAsEmployeeId).toBe(0);
      expect(ctx.companyIds).toEqual(expect.arrayContaining([f.org.companyId, f.otherOrg.companyId]));
      const session = await agent.get('/session').expect(200);
      expect(session.body).toMatchObject({ selfEmployee: null, actingAs: null, isActingForOther: false });
      await agent.put('/session/acting-as').send({ employeeId: f.otherCompany.employeeId }).expect(200);
    });
  });
});
