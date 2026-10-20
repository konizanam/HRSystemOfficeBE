import { API_PREFIX, AUTH_PROBLEM_TYPES, CSRF_HEADER, SESSION_COOKIE } from '@peoplehub/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../../src/modules/auth/auth-policy';
import { PAIRING_URI_PREFIX } from '../../src/modules/auth/mobile-pairing.service';
import { startTestApp, type TestApp } from '../support/app';
import {
  Agent,
  auditSince,
  cookieFrom,
  createOrg,
  createPerson,
  lastAuditId,
  login,
  type Org,
} from '../support/fixtures';

const MINUTE = 60_000;

describe('sessions, CSRF and timeouts (section 4.3)', () => {
  let t: TestApp;
  let org: Org;

  beforeAll(async () => {
    t = await startTestApp();
    org = await createOrg(t.db);
  });

  afterAll(async () => {
    await t.close();
  });

  async function signIn(): Promise<Agent> {
    return login(t, await createPerson(t.db, { org }));
  }

  function sessionId(agent: Agent): string {
    return hashToken(agent.sessionToken);
  }

  it('requires a session and audits the 401', async () => {
    const since = await lastAuditId(t.db);
    const res = await request(t.server).get(`${API_PREFIX}/session`).expect(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const rows = await auditSince(t.db, since, { requestId: res.headers['x-request-id'] as string });
    expect(rows.map((r) => [r.action, r.outcome])).toEqual([['SECURITY.ACCESS_DENIED', 'DENIED']]);

    await request(t.server)
      .get(`${API_PREFIX}/session`)
      .set('cookie', `${SESSION_COOKIE}=not-a-real-session`)
      .expect(401);
  });

  it('describes the session for GET /session', async () => {
    const person = await createPerson(t.db, { org, roles: ['EMPLOYEE', 'MANAGER'] });
    const agent = await login(t, person);
    const res = await agent.get('/session').expect(200);
    expect(res.body).toMatchObject({
      user: {
        id: person.userId,
        username: person.username,
        roles: ['EMPLOYEE', 'MANAGER'],
        authProvider: 'LOCAL',
      },
      selfEmployee: { id: person.employeeId, employeeCode: person.employeeCode, companyRule: 'Staff' },
      actingAs: { id: person.employeeId },
      isActingForOther: false,
      restrictedFeatures: [],
      csrfToken: agent.csrfToken,
      appVersion: expect.any(String),
    });
    expect(res.body.settings.idleMinutes).toBeGreaterThan(0);
    expect(res.body.settings.warnSeconds).toBeGreaterThan(0);
    expect(res.body.selfEmployee.displayName).toBe(
      `${res.body.selfEmployee.firstName} ${res.body.selfEmployee.lastName}`,
    );
    const deadline = new Date(res.body.expiresAt).getTime() - Date.now();
    expect(deadline).toBeGreaterThan((res.body.settings.idleMinutes - 1) * MINUTE);
  });

  it('rejects unsafe requests without a matching CSRF token', async () => {
    const agent = await signIn();
    const since = await lastAuditId(t.db);

    const missing = await agent.post('/session/activity', { csrf: false }).expect(403);
    expect(missing.body.type).toBe(AUTH_PROBLEM_TYPES.csrf);
    await agent.post('/session/activity', { csrf: false }).set(CSRF_HEADER, 'wrong').expect(403);

    // Header equal to a forged cookie is not enough: it must also be this session's token.
    await request(t.server)
      .post(`${API_PREFIX}/session/activity`)
      .set('cookie', `${SESSION_COOKIE}=${agent.sessionToken}; ph_csrf=forged-token-value`)
      .set(CSRF_HEADER, 'forged-token-value')
      .set('x-forwarded-for', agent.ip)
      .expect(403);

    // Safe methods need no token; a correct token passes.
    await agent.request('get', '/session', { csrf: false }).expect(200);
    await agent.post('/session/activity').expect(200);

    const denied = await auditSince(t.db, since, {
      action: 'SECURITY.ACCESS_DENIED',
      sessionId: sessionId(agent),
    });
    expect(denied).toHaveLength(3);
    expect(
      denied.every((r) => r.outcome === 'DENIED' && (r.metadata as { reason: string }).reason === 'CSRF'),
    ).toBe(true);
  });

  it('ends an idle session, audits AUTH.SESSION_TIMEOUT and clears the cookies', async () => {
    const agent = await signIn();
    const idleMinutes = (await agent.get('/session').expect(200)).body.settings.idleMinutes as number;
    const since = await lastAuditId(t.db);
    await t.db.prisma.session.update({
      where: { id: sessionId(agent) },
      data: { lastActivityAt: new Date(Date.now() - (idleMinutes + 1) * MINUTE) },
    });

    const res = await agent.get('/session').expect(401);
    expect(res.body.type).toBe(AUTH_PROBLEM_TYPES.sessionExpired);
    expect(cookieFrom(res, SESSION_COOKIE)).toBe('');

    const rows = await auditSince(t.db, since, { sessionId: sessionId(agent) });
    expect(rows.map((r) => r.action)).toEqual(['AUTH.SESSION_TIMEOUT']);
    expect(rows[0]?.metadata).toMatchObject({ reason: 'IDLE', idleMinutes });

    const stored = await t.db.prisma.session.findUniqueOrThrow({ where: { id: sessionId(agent) } });
    expect(stored.revokedAt).not.toBeNull();
    // Later requests are a plain 401 and do not audit the timeout again.
    await agent.get('/session').expect(401);
    expect(
      await auditSince(t.db, since, { action: 'AUTH.SESSION_TIMEOUT', sessionId: sessionId(agent) }),
    ).toHaveLength(1);
  });

  it('ends a session at the 12-hour absolute lifetime even when active', async () => {
    const agent = await signIn();
    const stored = await t.db.prisma.session.findUniqueOrThrow({ where: { id: sessionId(agent) } });
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(12 * 60 * MINUTE);

    const since = await lastAuditId(t.db);
    await t.db.prisma.session.update({
      where: { id: sessionId(agent) },
      data: { expiresAt: new Date(Date.now() - 1000), lastActivityAt: new Date() },
    });
    await agent.post('/session/activity').expect(401);
    const rows = await auditSince(t.db, since, {
      action: 'AUTH.SESSION_TIMEOUT',
      sessionId: sessionId(agent),
    });
    expect(rows[0]?.metadata).toMatchObject({ reason: 'ABSOLUTE' });
  });

  it('extends the idle deadline on the heartbeat but not on reads', async () => {
    const agent = await signIn();
    const idleMinutes = (await agent.get('/session').expect(200)).body.settings.idleMinutes as number;
    const stale = new Date(Date.now() - (idleMinutes - 1) * MINUTE);
    await t.db.prisma.session.update({ where: { id: sessionId(agent) }, data: { lastActivityAt: stale } });

    await agent.get('/session').expect(200);
    const afterRead = await t.db.prisma.session.findUniqueOrThrow({ where: { id: sessionId(agent) } });
    expect(afterRead.lastActivityAt.getTime()).toBe(stale.getTime());

    const beat = await agent.post('/session/activity').expect(200);
    expect(beat.body.idleMinutes).toBe(idleMinutes);
    const remaining = new Date(beat.body.expiresAt).getTime() - Date.now();
    expect(remaining).toBeGreaterThan((idleMinutes - 1) * MINUTE);
    const afterBeat = await t.db.prisma.session.findUniqueOrThrow({ where: { id: sessionId(agent) } });
    expect(afterBeat.lastActivityAt.getTime()).toBeGreaterThan(stale.getTime());
  });

  it('logs out: revokes the session, clears cookies and audits AUTH.LOGOUT', async () => {
    const agent = await signIn();
    const since = await lastAuditId(t.db);
    const res = await agent.post('/auth/logout').expect(204);
    expect(cookieFrom(res, SESSION_COOKIE)).toBe('');
    await agent.get('/session').expect(401);
    const rows = await auditSince(t.db, since, { action: 'AUTH.LOGOUT', sessionId: sessionId(agent) });
    expect(rows).toHaveLength(1);
  });

  it('issues an audited, short-lived mobile pairing token stored only as a hash', async () => {
    const agent = await signIn();
    const since = await lastAuditId(t.db);
    const res = await agent.post('/profile/mobile/pairing').expect(201);
    expect(res.body.serverUrl).toBe('http://localhost:5173');
    expect(res.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const ttl = new Date(res.body.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(4 * MINUTE);
    expect(ttl).toBeLessThanOrEqual(5 * MINUTE);

    const stored = await t.db.prisma.mobilePairingToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(res.body.token) },
    });
    expect(stored.usedAt).toBeNull();
    const rows = await auditSince(t.db, since, { action: 'AUTH.MOBILE_PAIRING_CREATED' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: 'MobilePairingToken', entityId: stored.id });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain(res.body.token);
    expect(PAIRING_URI_PREFIX).toBe('peoplehub://pair');
  });
});
