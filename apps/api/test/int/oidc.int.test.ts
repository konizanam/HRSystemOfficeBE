import { API_PREFIX, CSRF_COOKIE, SESSION_COOKIE } from '@peoplehub/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import { resetEnvCache } from '../../src/config/env';
import { OIDC_FLOW_COOKIE } from '../../src/modules/auth/oidc.service';
import { startTestApp, type TestApp } from '../support/app';
import { type FakeOidcProvider, startFakeOidcProvider } from '../support/fake-oidc';
import {
  auditSince,
  cookieFrom,
  createOrg,
  createPerson,
  lastAuditId,
  type Org,
  uniqueIp,
} from '../support/fixtures';

const REDIRECT_URI = 'http://localhost:3000/api/v1/auth/oidc/callback';
const WEB = 'http://localhost:5173';

describe('OIDC sign-in (section 4.3)', () => {
  let t: TestApp;
  let idp: FakeOidcProvider;
  let org: Org;

  beforeAll(async () => {
    idp = await startFakeOidcProvider();
    process.env.OIDC_ISSUER = idp.issuer;
    process.env.OIDC_CLIENT_ID = idp.clientId;
    process.env.OIDC_CLIENT_SECRET = idp.clientSecret;
    process.env.OIDC_REDIRECT_URI = REDIRECT_URI;
    process.env.OIDC_AUTO_PROVISION = 'false';
    resetEnvCache();
    t = await startTestApp();
    org = await createOrg(t.db);
  });

  afterAll(async () => {
    await t.close();
    await idp.close();
  });

  async function oauthUser(subject: string) {
    const person = await createPerson(t.db, { org });
    await t.db.tx(systemContext(), (tx) =>
      tx.user.update({
        where: { id: person.userId },
        data: { authProvider: 'OAUTH', externalSubject: subject, passwordHash: null },
      }),
    );
    return person;
  }

  async function start(returnTo?: string) {
    const ip = uniqueIp();
    const res = await request(t.server)
      .get(`${API_PREFIX}/auth/oidc/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`)
      .set('x-forwarded-for', ip)
      .expect(302);
    return { ip, location: res.headers.location as string, flow: cookieFrom(res, OIDC_FLOW_COOKIE), res };
  }

  function callback(query: string, flow: string | undefined, ip: string) {
    const req = request(t.server).get(`${API_PREFIX}/auth/oidc/callback?${query}`).set('x-forwarded-for', ip);
    return flow ? req.set('cookie', `${OIDC_FLOW_COOKIE}=${flow}`) : req;
  }

  it('redirects to the provider with PKCE, state and nonce in an encrypted cookie', async () => {
    const { location, flow, res } = await start('/leave/apply');
    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe(`${idp.issuer}/authorize`);
    expect(url.searchParams.get('client_id')).toBe(idp.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();

    const raw = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith(OIDC_FLOW_COOKIE));
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Path=\/api\/v1\/auth\/oidc/);
    expect(flow).toBeDefined();
    expect(decodeURIComponent(flow ?? '')).not.toContain(url.searchParams.get('state') ?? 'missing');
  });

  it('signs in a user linked by externalSubject and returns to the requested page', async () => {
    const subject = `sub-${Date.now()}`;
    const person = await oauthUser(subject);
    const since = await lastAuditId(t.db);
    const { location, flow, ip } = await start('/leave/apply');
    const state = new URL(location).searchParams.get('state') ?? '';
    const code = idp.issueCode(location, { sub: subject });

    const res = await callback(`code=${code}&state=${state}`, flow, ip).expect(302);
    expect(res.headers.location).toBe(`${WEB}/leave/apply`);
    const session = cookieFrom(res, SESSION_COOKIE);
    const csrf = cookieFrom(res, CSRF_COOKIE);
    expect(session).toBeTruthy();
    expect(cookieFrom(res, OIDC_FLOW_COOKIE)).toBe('');

    const me = await request(t.server)
      .get(`${API_PREFIX}/session`)
      .set('cookie', `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}`)
      .expect(200);
    expect(me.body.user).toMatchObject({ id: person.userId, authProvider: 'OAUTH' });

    const rows = await auditSince(t.db, since, { action: 'AUTH.LOGIN_SUCCESS', entityId: person.userId });
    expect(rows[0]?.metadata).toMatchObject({ provider: 'OAUTH', issuer: idp.issuer });
  });

  it('refuses a mismatched state, a missing cookie and an unknown subject', async () => {
    const subject = `sub-state-${Date.now()}`;
    await oauthUser(subject);

    const first = await start();
    const code = idp.issueCode(first.location, { sub: subject });
    const bad = await callback(`code=${code}&state=not-the-state`, first.flow, first.ip).expect(302);
    expect(bad.headers.location).toBe(`${WEB}/login?error=oidc_failed`);
    expect(cookieFrom(bad, SESSION_COOKIE)).toBeUndefined();

    const second = await start();
    const state = new URL(second.location).searchParams.get('state') ?? '';
    const noCookie = await callback(`code=x&state=${state}`, undefined, second.ip).expect(302);
    expect(noCookie.headers.location).toBe(`${WEB}/login?error=oidc_state`);

    const third = await start();
    const since = await lastAuditId(t.db);
    const unknownCode = idp.issueCode(third.location, { sub: `nobody-${Date.now()}` });
    const thirdState = new URL(third.location).searchParams.get('state') ?? '';
    const unknown = await callback(`code=${unknownCode}&state=${thirdState}`, third.flow, third.ip).expect(
      302,
    );
    expect(unknown.headers.location).toBe(`${WEB}/login?error=oidc_unknown_user`);
    const rows = await auditSince(t.db, since, { action: 'AUTH.LOGIN_FAILURE' });
    expect(rows.at(-1)).toMatchObject({ outcome: 'FAILURE', reason: 'OIDC_UNKNOWN_USER' });
  });

  it('refuses open redirects', async () => {
    await request(t.server)
      .get(`${API_PREFIX}/auth/oidc/start?returnTo=${encodeURIComponent('//evil.example')}`)
      .set('x-forwarded-for', uniqueIp())
      .expect(422);
  });

  it('provisions unknown subjects only when OIDC_AUTO_PROVISION is on', async () => {
    process.env.OIDC_AUTO_PROVISION = 'true';
    resetEnvCache();
    try {
      const subject = `sub-new-${Date.now()}`;
      const username = `oidc.${Date.now()}`;
      const since = await lastAuditId(t.db);
      const { location, flow, ip } = await start();
      const state = new URL(location).searchParams.get('state') ?? '';
      const code = idp.issueCode(location, {
        sub: subject,
        preferred_username: username,
        email: `${username}@example.test`,
      });
      const res = await callback(`code=${code}&state=${state}`, flow, ip).expect(302);
      expect(res.headers.location).toBe(`${WEB}/dashboard`);

      const user = await t.db.prisma.user.findUniqueOrThrow({ where: { externalSubject: subject } });
      expect(user).toMatchObject({
        username,
        authProvider: 'OAUTH',
        roles: ['EMPLOYEE'],
        employeeId: null,
        passwordHash: null,
      });
      const rows = await auditSince(t.db, since, { entityId: user.id });
      expect(rows.map((r) => r.action)).toEqual(['AUTH.USER_PROVISIONED', 'AUTH.LOGIN_SUCCESS']);
    } finally {
      process.env.OIDC_AUTO_PROVISION = 'false';
      resetEnvCache();
    }
  });
});
