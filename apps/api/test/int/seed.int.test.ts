import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import { runSeed } from '../../prisma/seed/index';
import { SEED_DEV_PASSWORD, SEED_PEOPLE } from '../../prisma/seed/people';
import { startTestApp, type TestApp } from '../support/app';
import { auditSince, lastAuditId, login } from '../support/fixtures';
import { AuditService } from '../../src/audit/audit.service';

describe('seed (section 14)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('is idempotent and creates the section 14 people', async () => {
    const deps = { db: t.db, audit: t.app.get(AuditService), ctx: systemContext('seed-test') };
    await runSeed(deps);
    const since = await lastAuditId(t.db);
    const second = await runSeed(deps);
    expect(second.usersCreated).toBe(0);
    expect(await auditSince(t.db, since)).toHaveLength(0);

    const users = await t.db.prisma.user.findMany({
      where: { username: { in: SEED_PEOPLE.map((p) => p.username) } },
      include: { employee: { include: { reportsTo: { include: { user: true } } } } },
    });
    expect(users).toHaveLength(12);
    const by = new Map(users.map((u) => [u.username, u]));
    expect(by.get('employee1')?.employee).toMatchObject({ entityCode: '000077', employeeCode: 'E000077' });
    expect(by.get('manager.b')?.employee?.reportsTo?.user?.username).toBe('manager.a');
    for (let i = 1; i <= 6; i++) {
      expect(by.get(`employee${i}`)?.employee?.reportsTo?.user?.username).toBe('manager.b');
    }
    expect(by.get('hr.admin')?.roles).toContain('HR_ADMIN');
    expect(by.get('payroll.admin')?.roles).toContain('PAYROLL_ADMIN');
    expect(by.get('sys.admin')?.roles).toContain('SYSTEM_ADMIN');
    expect(by.get('auditor')?.roles).toContain('AUDITOR');
    expect(users.every((u) => /^\d{6}$/.test(u.employee?.entityCode ?? ''))).toBe(true);

    const agent = await login(t, { username: 'employee1', password: SEED_DEV_PASSWORD });
    expect(agent.login.status).toBe('OK');
    expect((await agent.get('/session').expect(200)).body.selfEmployee.employeeCode).toBe('E000077');
  });
});
