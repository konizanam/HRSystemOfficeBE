import { authenticator } from 'otplib';
import request from 'supertest';
import { systemContext } from '../../src/common/context/security-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  asJson,
  auditSince,
  createOrg,
  createPerson,
  lastAuditId,
  login,
  loginRequest,
  nextUnique,
  type Org,
  type Person,
} from '../support/fixtures';

/** Phase 9: user administration (SYSTEM_ADMIN) and self-service MFA disable (section 12.10). */
describe('admin: users', () => {
  let t: TestApp;
  let org: Org;
  let sysAdminPerson: Person;
  let admin: Agent;

  beforeAll(async () => {
    t = await startTestApp();
    org = await createOrg(t.db);
    sysAdminPerson = await createPerson(t.db, { org, roles: ['EMPLOYEE', 'SYSTEM_ADMIN'] });
    admin = await login(t, sysAdminPerson);
  });

  afterAll(async () => {
    await t.close();
  });

  async function userRow(id: string) {
    return (await admin.get(`/admin/users/${id}`).expect(200)).body as {
      version: number;
      [k: string]: unknown;
    };
  }

  it('creates a local user who gets a set-password link and must change the password', async () => {
    const n = await nextUnique(t.db);
    const employee = await createPerson(t.db, { org, label: 'nouser' });
    // The fixture person already has a login; link a fresh employee instead.
    const free = await t.db.tx(systemContext('test-users'), (tx) =>
      tx.employee.create({
        data: {
          entityCode: String(600_000 + n),
          employeeCode: `U${n}`,
          companyId: org.companyId,
          companyRuleId: org.companyRuleId,
          firstName: `Lin${n}`,
          lastName: `Ked${n}`,
        },
      }),
    );
    const options = await admin.get(`/admin/users/employee-options?search=U${n}`).expect(200);
    expect(options.body.items).toEqual([expect.objectContaining({ id: free.id, employeeCode: `U${n}` })]);

    const since = await lastAuditId(t.db);
    const res = await admin
      .post('/admin/users')
      .send({
        username: `u${n}.local`,
        email: `u${n}@example.test`,
        roles: ['EMPLOYEE', 'MANAGER'],
        employeeId: free.id,
      })
      .expect(201);
    expect(res.body).toMatchObject({
      authProvider: 'LOCAL',
      hasPassword: false,
      mustChangePassword: true,
      employee: { id: free.id, employeeCode: `U${n}` },
      roles: ['EMPLOYEE', 'MANAGER'],
    });
    const rows = await auditSince(t.db, since, { entityType: 'User', entityId: res.body.id as string });
    expect(rows.map((r) => r.action)).toEqual([
      'SECURITY.USER_CREATED',
      'SECURITY.ROLE_GRANTED',
      'SECURITY.ROLE_GRANTED',
    ]);
    expect(asJson(rows)).not.toContain('$argon2');
    await t.mail.flush();
    expect(t.mail.sentTo(`u${n}@example.test`).at(-1)?.template).toBe('password-reset');

    // Duplicates and double links are refused.
    await admin
      .post('/admin/users')
      .send({
        username: `U${n}.LOCAL`,
        email: null,
        roles: ['EMPLOYEE'],
        initialPassword: 'Another-Pass-2026!',
      })
      .expect(409);
    await admin
      .post('/admin/users')
      .send({
        username: `u${n}.second`,
        email: `u${n}.b@example.test`,
        roles: ['EMPLOYEE'],
        employeeId: employee.employeeId,
      })
      .expect(409);
    // Without an email or an initial password there is no way to sign in.
    await admin
      .post('/admin/users')
      .send({ username: `u${n}.none`, roles: ['EMPLOYEE'] })
      .expect(422);
  });

  it('creates a user with an initial password (policy checked) and an OAuth user', async () => {
    const n = await nextUnique(t.db);
    await admin
      .post('/admin/users')
      .send({ username: `u${n}.weak`, roles: ['EMPLOYEE'], initialPassword: 'short' })
      .expect(422);
    const local = await admin
      .post('/admin/users')
      .send({ username: `u${n}.pw`, roles: ['EMPLOYEE'], initialPassword: 'Initial-Pass-2026!' })
      .expect(201);
    expect(local.body).toMatchObject({ hasPassword: true, mustChangePassword: true });
    const signIn = await loginRequest(t, { username: `u${n}.pw`, password: 'Initial-Pass-2026!' }).expect(
      200,
    );
    expect(signIn.body.status).toBe('PASSWORD_CHANGE_REQUIRED');

    await admin
      .post('/admin/users')
      .send({ username: `u${n}.oidc`, authProvider: 'OAUTH', roles: ['EMPLOYEE'] })
      .expect(422);
    const oauth = await admin
      .post('/admin/users')
      .send({
        username: `u${n}.oidc`,
        authProvider: 'OAUTH',
        externalSubject: `sub-${n}`,
        roles: ['AUDITOR'],
      })
      .expect(201);
    expect(oauth.body).toMatchObject({
      authProvider: 'OAUTH',
      externalSubject: `sub-${n}`,
      mustChangePassword: false,
    });
    const list = await admin.get(`/admin/users?search=u${n}.&authProvider=OAUTH`).expect(200);
    expect(list.body.items.map((u: { username: string }) => u.username)).toEqual([`u${n}.oidc`]);
  });

  it('grants and revokes roles one audit row each, with the version (409 when stale)', async () => {
    const person = await createPerson(t.db, { org, roles: ['EMPLOYEE'] });
    const before = await userRow(person.userId);
    const since = await lastAuditId(t.db);
    const res = await admin
      .put(`/admin/users/${person.userId}/roles`)
      .send({ roles: ['EMPLOYEE', 'HR_ADMIN', 'AUDITOR'], reason: 'Joined HR', version: before.version })
      .expect(200);
    expect(res.body.roles).toEqual(['EMPLOYEE', 'HR_ADMIN', 'AUDITOR']);
    await admin
      .put(`/admin/users/${person.userId}/roles`)
      .send({ roles: ['EMPLOYEE'], version: before.version })
      .expect(409);
    const revoked = await admin
      .put(`/admin/users/${person.userId}/roles`)
      .send({ roles: ['EMPLOYEE', 'HR_ADMIN'], version: res.body.version })
      .expect(200);
    const rows = await auditSince(t.db, since, { entityId: person.userId, category: 'SECURITY' });
    expect(rows.map((r) => [r.action, (r.metadata as { role: string }).role])).toEqual([
      ['SECURITY.ROLE_GRANTED', 'HR_ADMIN'],
      ['SECURITY.ROLE_GRANTED', 'AUDITOR'],
      ['SECURITY.ROLE_REVOKED', 'AUDITOR'],
    ]);
    expect(rows[0]).toMatchObject({ reason: 'Joined HR', entityType: 'User' });
    expect(revoked.body.roles).toEqual(['EMPLOYEE', 'HR_ADMIN']);

    // The new role takes effect on the next request.
    const agent = await login(t, person);
    expect((await agent.get('/session').expect(200)).body.user.roles).toContain('HR_ADMIN');

    // A system admin cannot change their own roles.
    const self = await userRow(sysAdminPerson.userId);
    await admin
      .put(`/admin/users/${sysAdminPerson.userId}/roles`)
      .send({ roles: ['EMPLOYEE'], version: self.version })
      .expect(422);
  });

  it('unlocks a locked account (audited AUTH.ACCOUNT_UNLOCKED)', async () => {
    const person = await createPerson(t.db, { org });
    for (let i = 0; i < 5; i++)
      await loginRequest(t, { username: person.username, password: 'Wrong-Pass-2026!' });
    const locked = await userRow(person.userId);
    expect(locked).toMatchObject({ isLocked: true });
    expect((await loginRequest(t, person)).status).toBe(401);
    const since = await lastAuditId(t.db);
    const res = await admin
      .post(`/admin/users/${person.userId}/unlock`)
      .send({ version: locked.version, reason: 'Called the helpdesk' })
      .expect(200);
    expect(res.body).toMatchObject({ isLocked: false, failedLoginCount: 0 });
    expect((await auditSince(t.db, since, { action: 'AUTH.ACCOUNT_UNLOCKED' }))[0]).toMatchObject({
      entityId: person.userId,
      reason: 'Called the helpdesk',
    });
    expect((await loginRequest(t, person)).status).toBe(200);
  });

  it('resets the password: emails a link, forces a change and ends the sessions', async () => {
    const person = await createPerson(t.db, { org });
    const session = await login(t, person);
    const row = await userRow(person.userId);
    const since = await lastAuditId(t.db);
    const res = await admin
      .post(`/admin/users/${person.userId}/reset-password`)
      .send({ version: row.version })
      .expect(200);
    expect(res.body.mustChangePassword).toBe(true);
    await session.get('/session').expect(401);
    const rows = await auditSince(t.db, since, { action: 'AUTH.PASSWORD_RESET_REQUESTED' });
    expect(rows[0]?.metadata).toMatchObject({
      userId: person.userId,
      via: 'ADMIN_RESET',
      sessionsRevoked: 1,
    });
    await t.mail.flush();
    const mail = t.mail.sentTo(person.email as string).at(-1);
    expect(mail?.template).toBe('password-reset');
    const token = /token=([^"&\s]+)/.exec(mail?.text ?? '')?.[1];
    expect(token).toBeTruthy();
    // The link works once, and the new password clears the forced change.
    const reset = await loginRequest(t, person);
    expect(reset.body.status).toBe('PASSWORD_CHANGE_REQUIRED');
    await request(t.server)
      .post('/api/v1/auth/password/reset')
      .set('x-forwarded-for', '10.9.9.9')
      .send({ token: decodeURIComponent(token as string), newPassword: 'Brand-New-Pass-2026!' })
      .expect(204);
    const after = await loginRequest(t, {
      username: person.username,
      password: 'Brand-New-Pass-2026!',
    }).expect(200);
    expect(after.body.status).toBe('OK');
  });

  it('resets MFA (admin) and lets the user disable MFA with password and code', async () => {
    const person = await createPerson(t.db, { org });
    const agent = await login(t, person);
    const enrol = await agent.post('/auth/mfa/enroll').expect(200);
    const secret = enrol.body.secret as string;
    await agent
      .post('/auth/mfa/verify')
      .send({ code: authenticator.generate(secret) })
      .expect(204);

    // Self-service: wrong password or code is refused (audited), the right pair turns MFA off.
    let since = await lastAuditId(t.db);
    await agent
      .post('/auth/mfa/disable')
      .send({ currentPassword: 'nope', code: authenticator.generate(secret) })
      .expect(422);
    await agent
      .post('/auth/mfa/disable')
      .send({ currentPassword: person.password, code: '000000' })
      .expect(422);
    expect((await auditSince(t.db, since, { action: 'AUTH.MFA_DISABLE_FAILED' })).length).toBe(2);
    await agent
      .post('/auth/mfa/disable')
      .send({ currentPassword: person.password, code: authenticator.generate(secret) })
      .expect(204);
    expect((await auditSince(t.db, since, { action: 'AUTH.MFA_DISABLED' }))[0]).toMatchObject({
      entityId: person.userId,
    });
    expect((await agent.get('/session').expect(200)).body.user.mfaEnabled).toBe(false);
    await agent
      .post('/auth/mfa/disable')
      .send({ currentPassword: person.password, code: '123456' })
      .expect(409);

    // Admin reset after a lost phone.
    const again = await agent.post('/auth/mfa/enroll').expect(200);
    await agent
      .post('/auth/mfa/verify')
      .send({ code: authenticator.generate(again.body.secret as string) })
      .expect(204);
    const row = await userRow(person.userId);
    expect(row.mfaEnabled).toBe(true);
    since = await lastAuditId(t.db);
    const res = await admin
      .post(`/admin/users/${person.userId}/reset-mfa`)
      .send({ version: row.version })
      .expect(200);
    expect(res.body.mfaEnabled).toBe(false);
    const audit = (await auditSince(t.db, since, { action: 'AUTH.MFA_RESET' }))[0];
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit?.before)).not.toContain(again.body.secret as string);
    expect((await loginRequest(t, person)).body.status).toBe('OK');
    await admin
      .post(`/admin/users/${person.userId}/reset-mfa`)
      .send({ version: res.body.version })
      .expect(422);
  });

  it('deactivates (sessions end, no sign-in) and reactivates; links and unlinks employees', async () => {
    const person = await createPerson(t.db, { org });
    const session = await login(t, person);
    const row = await userRow(person.userId);
    const since = await lastAuditId(t.db);
    const off = await admin
      .post(`/admin/users/${person.userId}/deactivate`)
      .send({ version: row.version, reason: 'Left' })
      .expect(200);
    expect(off.body).toMatchObject({ user: { isActive: false }, sessionsRevoked: 1, stepsReassigned: 0 });
    await session.get('/session').expect(401);
    expect((await loginRequest(t, person)).status).toBe(401);
    const on = await admin
      .post(`/admin/users/${person.userId}/activate`)
      .send({ version: off.body.user.version })
      .expect(200);
    expect(on.body.isActive).toBe(true);
    expect((await loginRequest(t, person)).status).toBe(200);

    const unlinked = await admin
      .put(`/admin/users/${person.userId}`)
      .send({ employeeId: null, version: on.body.version })
      .expect(200);
    expect(unlinked.body.employee).toBeNull();
    const relinked = await admin
      .put(`/admin/users/${person.userId}`)
      .send({
        employeeId: person.employeeId,
        email: `relinked.${person.username}@example.test`,
        version: unlinked.body.version,
      })
      .expect(200);
    expect(relinked.body.employee.id).toBe(person.employeeId);
    const actions = (await auditSince(t.db, since, { entityId: person.userId, category: 'SECURITY' })).map(
      (r) => r.action,
    );
    expect(actions).toEqual([
      'SECURITY.USER_DEACTIVATED',
      'SECURITY.USER_ACTIVATED',
      'SECURITY.USER_EMPLOYEE_UNLINKED',
      'SECURITY.USER_EMPLOYEE_LINKED',
    ]);
    await admin.post(`/admin/users/${sysAdminPerson.userId}/deactivate`).send({ version: 1 }).expect(422);
    await admin.get('/admin/users/00000000-0000-0000-0000-000000000000').expect(404);
  });

  it('is SYSTEM_ADMIN only', async () => {
    const hr = await login(t, await createPerson(t.db, { org, roles: ['EMPLOYEE', 'HR_ADMIN'] }));
    const since = await lastAuditId(t.db);
    const res = await hr.get('/admin/users').expect(403);
    const rows = await auditSince(t.db, since, { requestId: res.headers['x-request-id'] as string });
    expect(rows.some((r) => r.outcome === 'DENIED')).toBe(true);
  });
});
