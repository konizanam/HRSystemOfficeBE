import { API_PREFIX, AUTH_PROBLEM_TYPES, CSRF_COOKIE, SESSION_COOKIE } from '@peoplehub/shared';
import { authenticator } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import { hashToken } from '../../src/modules/auth/auth-policy';
import { startTestApp, type TestApp } from '../support/app';
import {
  asJson,
  auditSince,
  cookieFrom,
  createOrg,
  createPerson,
  lastAuditId,
  login,
  loginRequest,
  type Org,
  uniqueIp,
} from '../support/fixtures';

describe('local sign-in (section 4.3)', () => {
  let t: TestApp;
  let org: Org;

  beforeAll(async () => {
    t = await startTestApp();
    org = await createOrg(t.db);
  });

  afterAll(async () => {
    await t.close();
  });

  it('signs in, sets hardened cookies and audits AUTH.LOGIN_SUCCESS', async () => {
    const person = await createPerson(t.db, { org });
    const since = await lastAuditId(t.db);
    const res = await loginRequest(t, person).expect(200);

    expect(res.body.status).toBe('OK');
    expect(res.body.session.user).toMatchObject({ username: person.username, roles: ['EMPLOYEE'] });
    expect(res.body.session.selfEmployee.id).toBe(person.employeeId);
    expect(res.body.session.actingAs.id).toBe(person.employeeId);
    expect(res.body.session.isActingForOther).toBe(false);
    expect(res.body.session.restrictedFeatures).toEqual([]);
    expect(res.body.session.settings).toMatchObject({ dateFormat: 'dd-MMM-yyyy' });

    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '';
    const csrf = cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`)) ?? '';
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Secure/i);
    expect(csrf).not.toMatch(/HttpOnly/i);
    expect(csrf).toMatch(/SameSite=Lax/i);
    expect(res.body.session.csrfToken).toBe(cookieFrom(res, CSRF_COOKIE));

    // Only the token's hash is stored, and that hash is the audited session id.
    const token = cookieFrom(res, SESSION_COOKIE) as string;
    const row = await t.db.prisma.session.findUnique({ where: { id: hashToken(token) } });
    expect(row?.userId).toBe(person.userId);
    expect(await t.db.prisma.session.findUnique({ where: { id: token } })).toBeNull();

    const audit = await auditSince(t.db, since, { action: 'AUTH.LOGIN_SUCCESS', entityId: person.userId });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorUserId: person.userId,
      sessionId: hashToken(token),
      outcome: 'SUCCESS',
    });
  });

  it('matches usernames case-insensitively', async () => {
    const person = await createPerson(t.db, { org });
    await loginRequest(t, { username: person.username.toUpperCase(), password: person.password }).expect(200);
  });

  it('rejects a wrong password with 401, audits the attempted username only and no generic denial', async () => {
    const person = await createPerson(t.db, { org });
    const since = await lastAuditId(t.db);
    const wrong = 'Wrong-Password-123';
    const res = await loginRequest(t, { username: person.username, password: wrong }).expect(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.type).toBe(AUTH_PROBLEM_TYPES.invalidCredentials);
    expect(cookieFrom(res, SESSION_COOKIE)).toBeUndefined();

    const rows = await auditSince(t.db, since, { requestId: res.headers['x-request-id'] as string });
    expect(rows.map((r) => r.action)).toEqual(['AUTH.LOGIN_FAILURE']);
    expect(rows[0]).toMatchObject({
      outcome: 'FAILURE',
      entityType: 'User',
      entityId: person.userId,
      actorUserId: null,
    });
    expect(rows[0]?.metadata).toMatchObject({ username: person.username });
    expect(asJson(rows[0])).not.toContain(wrong);
    expect(asJson(rows[0])).not.toContain('$argon2');
  });

  it('gives an unknown username the same answer as a wrong password', async () => {
    const since = await lastAuditId(t.db);
    const username = `nobody-${Date.now()}`;
    const res = await loginRequest(t, { username, password: 'Whatever-123' }).expect(401);
    expect(res.body.type).toBe(AUTH_PROBLEM_TYPES.invalidCredentials);
    const rows = await auditSince(t.db, since, { action: 'AUTH.LOGIN_FAILURE' });
    expect(rows.find((r) => (r.metadata as { username?: string }).username === username)?.reason).toBe(
      'UNKNOWN_USER',
    );
  });

  it('refuses inactive users', async () => {
    const person = await createPerson(t.db, { org });
    await t.db.tx(systemContext(), (tx) =>
      tx.user.update({ where: { id: person.userId }, data: { isActive: false } }),
    );
    await loginRequest(t, person).expect(401);
  });

  it('locks the account for 15 minutes after 5 consecutive failures and emails the user', async () => {
    const person = await createPerson(t.db, { org });
    const since = await lastAuditId(t.db);
    const ip = uniqueIp();
    for (let i = 1; i <= 4; i++) {
      const res = await loginRequest(
        t,
        { username: person.username, password: `Wrong-pass-${i}` },
        ip,
      ).expect(401);
      expect(res.body.type).toBe(AUTH_PROBLEM_TYPES.invalidCredentials);
    }
    const fifth = await loginRequest(t, { username: person.username, password: 'Wrong-pass-5' }, ip).expect(
      401,
    );
    expect(fifth.body.type).toBe(AUTH_PROBLEM_TYPES.accountLocked);
    expect(fifth.body.detail).toContain('15 minutes');

    const user = await t.db.prisma.user.findUniqueOrThrow({ where: { id: person.userId } });
    const lockMs = (user.lockedUntil?.getTime() ?? 0) - Date.now();
    expect(lockMs).toBeGreaterThan(14 * 60_000);
    expect(lockMs).toBeLessThanOrEqual(15 * 60_000);

    // Even the right password is refused while locked.
    const locked = await loginRequest(t, person, ip).expect(401);
    expect(locked.body.type).toBe(AUTH_PROBLEM_TYPES.accountLocked);

    const rows = await auditSince(t.db, since, { entityId: person.userId });
    expect(rows.filter((r) => r.action === 'AUTH.LOGIN_FAILURE')).toHaveLength(6);
    expect(rows.filter((r) => r.action === 'AUTH.ACCOUNT_LOCKED')).toHaveLength(1);

    await t.mail.flush();
    const mail = t.mail.sentTo(person.email as string).find((m) => m.template === 'account-locked');
    expect(mail?.subject).toBe('Your PeopleHub account was locked');
    expect(mail?.html).toContain('First');

    // When the lock has passed, the right password works and clears the counter.
    await t.db.tx(systemContext(), (tx) =>
      tx.user.update({ where: { id: person.userId }, data: { lockedUntil: new Date(Date.now() - 1000) } }),
    );
    await loginRequest(t, person, uniqueIp()).expect(200);
    const after = await t.db.prisma.user.findUniqueOrThrow({ where: { id: person.userId } });
    expect(after).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
  });

  it('only counts consecutive failures', async () => {
    const person = await createPerson(t.db, { org });
    const ip = uniqueIp();
    for (let i = 0; i < 4; i++)
      await loginRequest(t, { username: person.username, password: 'Nope-nope-1' }, ip);
    await loginRequest(t, person, ip).expect(200);
    for (let i = 0; i < 4; i++)
      await loginRequest(t, { username: person.username, password: 'Nope-nope-1' }, ip);
    const user = await t.db.prisma.user.findUniqueOrThrow({ where: { id: person.userId } });
    expect(user.failedLoginCount).toBe(4);
    expect(user.lockedUntil).toBeNull();
  });

  it('rate limits /auth/* to 10 requests per minute per IP', async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 10; i++) {
      await loginRequest(t, { username: `rate-${i}`, password: 'Whatever-123' }, ip).expect(401);
    }
    const limited = await loginRequest(t, { username: 'rate-x', password: 'Whatever-123' }, ip).expect(429);
    expect(limited.headers['content-type']).toContain('application/problem+json');
    expect(limited.body.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    // Another IP is unaffected.
    await loginRequest(t, { username: 'rate-y', password: 'Whatever-123' }, uniqueIp()).expect(401);

    // The same limit applies to the other /auth routes.
    const forgotIp = uniqueIp();
    const forgot = () =>
      request(t.server)
        .post(`${API_PREFIX}/auth/password/forgot`)
        .set('x-forwarded-for', forgotIp)
        .send({ usernameOrEmail: 'nobody' });
    for (let i = 0; i < 10; i++) await forgot().expect(202);
    await forgot().expect(429);
  });

  it('validates the body with field errors', async () => {
    const res = await request(t.server)
      .post(`${API_PREFIX}/auth/login`)
      .set('x-forwarded-for', uniqueIp())
      .send({ username: '', password: '' })
      .expect(422);
    expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(['password', 'username']);
  });

  it('answers 404 problem+json for OIDC when it is not configured', async () => {
    const start = await request(t.server)
      .get(`${API_PREFIX}/auth/oidc/start`)
      .set('x-forwarded-for', uniqueIp())
      .expect(404);
    expect(start.headers['content-type']).toContain('application/problem+json');
    await request(t.server)
      .get(`${API_PREFIX}/auth/oidc/callback?code=x&state=y`)
      .set('x-forwarded-for', uniqueIp())
      .expect(404);
  });
});

describe('TOTP multi-factor sign-in', () => {
  let t: TestApp;
  let org: Org;

  beforeAll(async () => {
    t = await startTestApp();
    org = await createOrg(t.db);
  });

  afterAll(async () => {
    await t.close();
  });

  it('enrols, verifies and then requires a code at sign-in', async () => {
    const person = await createPerson(t.db, { org });
    const agent = await login(t, person);
    const since = await lastAuditId(t.db);

    const enrol = await agent.post('/auth/mfa/enroll').expect(200);
    expect(enrol.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/PeopleHub:/);
    expect(enrol.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const secret = enrol.body.secret as string;

    // Stored encrypted, and not active until verified.
    const pending = await t.db.prisma.user.findUniqueOrThrow({ where: { id: person.userId } });
    expect(pending.mfaSecretEnc).toMatch(/^k\w*:/);
    expect(pending.mfaSecretEnc).not.toContain(secret);
    expect(pending.mfaEnabledAt).toBeNull();
    await loginRequest(t, person).expect(200);

    const bad = await agent.post('/auth/mfa/verify').send({ code: '000000' }).expect(422);
    expect(bad.body.errors[0].path).toBe('code');
    await agent
      .post('/auth/mfa/verify')
      .send({ code: authenticator.generate(secret) })
      .expect(204);
    await agent.post('/auth/mfa/enroll').expect(409);

    const rows = await auditSince(t.db, since, { entityId: person.userId, action: 'AUTH.MFA_ENROLLED' });
    expect(rows).toHaveLength(1);
    expect(asJson(rows[0])).not.toContain(secret);
    expect((await agent.get('/session').expect(200)).body.user.mfaEnabled).toBe(true);

    const ip = uniqueIp();
    const challenge = await loginRequest(t, person, ip).expect(200);
    expect(challenge.body).toEqual({ status: 'MFA_REQUIRED' });
    expect(cookieFrom(challenge, SESSION_COOKIE)).toBeUndefined();

    const valid = authenticator.generate(secret);
    const wrong = await loginRequest(
      t,
      { ...person, totp: valid === '123456' ? '654321' : '123456' },
      ip,
    ).expect(401);
    expect(wrong.body.type).toBe(AUTH_PROBLEM_TYPES.invalidCredentials);
    const failure = await auditSince(t.db, since, { entityId: person.userId, action: 'AUTH.LOGIN_FAILURE' });
    expect(failure.at(-1)?.reason).toBe('BAD_MFA_CODE');

    const ok = await loginRequest(t, { ...person, totp: authenticator.generate(secret) }, ip).expect(200);
    expect(ok.body.status).toBe('OK');
    expect(cookieFrom(ok, SESSION_COOKIE)).toBeDefined();
  });
});
