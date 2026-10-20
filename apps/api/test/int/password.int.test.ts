import { API_PREFIX, AUTH_PROBLEM_TYPES } from '@peoplehub/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../../src/modules/auth/auth-policy';
import { startTestApp, type TestApp } from '../support/app';
import {
  asJson,
  auditSince,
  createOrg,
  createPerson,
  lastAuditId,
  login,
  loginRequest,
  type Org,
  type Person,
  uniqueIp,
} from '../support/fixtures';

function tokenFrom(html: string): string {
  const match = /reset-password\?token=([^"&]+)/.exec(html);
  if (!match?.[1]) throw new Error('No reset link in the email');
  return decodeURIComponent(match[1]);
}

describe('password change, history and reset (section 4.3)', () => {
  let t: TestApp;
  let org: Org;

  beforeAll(async () => {
    t = await startTestApp();
    org = await createOrg(t.db);
  });

  afterAll(async () => {
    await t.close();
  });

  function forgot(identifier: string) {
    return request(t.server)
      .post(`${API_PREFIX}/auth/password/forgot`)
      .set('x-forwarded-for', uniqueIp())
      .send({ usernameOrEmail: identifier });
  }

  function reset(token: string, newPassword: string) {
    return request(t.server)
      .post(`${API_PREFIX}/auth/password/reset`)
      .set('x-forwarded-for', uniqueIp())
      .send({ token, newPassword });
  }

  async function resetMailFor(person: Person) {
    await t.mail.flush();
    const mails = t.mail.sentTo(person.email as string).filter((m) => m.template === 'password-reset');
    return mails.at(-1);
  }

  it('changes the password, revokes other sessions, audits and emails', async () => {
    const person = await createPerson(t.db, { org });
    const agent = await login(t, person);
    const other = await login(t, person);
    const since = await lastAuditId(t.db);

    const wrong = await agent
      .post('/auth/password/change')
      .send({ currentPassword: 'Not-my-password-1', newPassword: 'Brand-New-Pass-1' })
      .expect(422);
    expect(wrong.body.errors).toEqual([
      { path: 'currentPassword', message: 'Your current password is incorrect' },
    ]);

    const weak = await agent
      .post('/auth/password/change')
      .send({ currentPassword: person.password, newPassword: 'short' })
      .expect(422);
    expect(weak.body.errors.every((e: { path: string }) => e.path === 'newPassword')).toBe(true);

    const withUsername = await agent
      .post('/auth/password/change')
      .send({ currentPassword: person.password, newPassword: `${person.username}-X1` })
      .expect(422);
    expect(withUsername.body.errors[0].message).toContain('username');

    const same = await agent
      .post('/auth/password/change')
      .send({ currentPassword: person.password, newPassword: person.password })
      .expect(422);
    expect(same.body.errors[0].message).toContain('last 5');

    await agent
      .post('/auth/password/change')
      .send({ currentPassword: person.password, newPassword: 'Brand-New-Pass-1' })
      .expect(204);

    await agent.get('/session').expect(200);
    await other.get('/session').expect(401);
    await loginRequest(t, person).expect(401);
    await loginRequest(t, { username: person.username, password: 'Brand-New-Pass-1' }).expect(200);

    const rows = await auditSince(t.db, since, { entityId: person.userId });
    const changed = rows.filter((r) => r.action === 'AUTH.PASSWORD_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.metadata).toMatchObject({ via: 'CHANGE', otherSessionsRevoked: 1 });
    expect(rows.filter((r) => r.action === 'AUTH.PASSWORD_CHANGE_FAILED')).toHaveLength(1);
    expect(asJson(rows)).not.toContain('Brand-New-Pass-1');

    await t.mail.flush();
    const mail = t.mail.sentTo(person.email as string).find((m) => m.template === 'password-changed');
    expect(mail?.subject).toBe('Your PeopleHub password was changed');
  });

  it('keeps a history of 5: the last five passwords are refused, the sixth is allowed again', async () => {
    const original = 'History-Pass-00';
    const person = await createPerson(t.db, { org, password: original });
    const agent = await login(t, person);
    let current = original;
    for (let i = 1; i <= 5; i++) {
      const next = `History-Pass-0${i}`;
      await agent
        .post('/auth/password/change')
        .send({ currentPassword: current, newPassword: next })
        .expect(204);
      current = next;
    }
    // History (newest first): 05 04 03 02 01 00. The last five are 05..01.
    const reuse = await agent
      .post('/auth/password/change')
      .send({ currentPassword: current, newPassword: 'History-Pass-01' })
      .expect(422);
    expect(reuse.body.errors[0].path).toBe('newPassword');
    await agent
      .post('/auth/password/change')
      .send({ currentPassword: current, newPassword: original })
      .expect(204);
  });

  it('forces a password change when mustChangePassword is set', async () => {
    const person = await createPerson(t.db, { org, mustChangePassword: true });
    const res = await loginRequest(t, person).expect(200);
    expect(res.body.status).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(res.body.session.user.mustChangePassword).toBe(true);

    const agent = await login(t, person);
    await agent.get('/session').expect(200);
    await agent.post('/session/activity').expect(200);
    const blocked = await agent.get('/session/acting-as/options').expect(403);
    expect(blocked.body.type).toBe(AUTH_PROBLEM_TYPES.passwordChangeRequired);
    await agent.post('/profile/mobile/pairing').expect(403);

    await agent
      .post('/auth/password/change')
      .send({ currentPassword: person.password, newPassword: 'Changed-At-Last-1' })
      .expect(204);
    await agent.get('/session/acting-as/options').expect(200);
    expect((await agent.get('/session').expect(200)).body.user.mustChangePassword).toBe(false);
    await agent.post('/auth/logout').expect(204);
  });

  it('resets a password with an emailed single-use token', async () => {
    const person = await createPerson(t.db, { org });
    const existing = await login(t, person);
    const since = await lastAuditId(t.db);

    const res = await forgot(person.username).expect(202);
    expect(res.body.message).toContain('If the account exists');
    const mail = await resetMailFor(person);
    expect(mail).toBeDefined();
    const token = tokenFrom(mail?.html ?? '');

    // No PII beyond the first name and a link.
    expect(mail?.html).toContain('First');
    expect(mail?.html).not.toContain('Last');
    expect(mail?.html).not.toContain(person.username);
    expect(mail?.text).toContain(`reset-password?token=`);

    // Only the hash is stored, valid for 30 minutes.
    const stored = await t.db.prisma.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(token) },
    });
    expect(stored.userId).toBe(person.userId);
    const ttl = stored.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000);

    const weak = await reset(token, 'weak').expect(422);
    expect(weak.body.errors[0].path).toBe('newPassword');
    const reused = await reset(token, person.password).expect(422);
    expect(reused.body.errors[0].path).toBe('newPassword');

    await reset(token, 'Reset-Password-77').expect(204);
    const again = await reset(token, 'Reset-Password-78').expect(422);
    expect(again.body.errors).toEqual([
      { path: 'token', message: 'This reset link is invalid or has expired' },
    ]);

    await existing.get('/session').expect(401);
    await loginRequest(t, { username: person.username, password: 'Reset-Password-77' }).expect(200);

    const rows = await auditSince(t.db, since);
    expect(
      rows.find(
        (r) => r.action === 'AUTH.PASSWORD_RESET_REQUESTED' && r.subjectEmployeeId === person.employeeId,
      ),
    ).toBeDefined();
    const changed = rows.find((r) => r.action === 'AUTH.PASSWORD_CHANGED' && r.entityId === person.userId);
    expect(changed?.metadata).toMatchObject({ via: 'RESET', sessionsRevoked: 1 });
    expect(asJson(rows)).not.toContain(token);
  });

  it('accepts an email address, invalidates older links and clears a lockout', async () => {
    const person = await createPerson(t.db, { org });
    const ip = uniqueIp();
    for (let i = 0; i < 5; i++)
      await loginRequest(t, { username: person.username, password: 'Wrong-Wrong-1' }, ip);
    expect((await loginRequest(t, person).expect(401)).body.type).toBe(AUTH_PROBLEM_TYPES.accountLocked);

    await forgot(person.email?.toUpperCase() as string).expect(202);
    const first = tokenFrom((await resetMailFor(person))?.html ?? '');
    await forgot(person.username).expect(202);
    const second = tokenFrom((await resetMailFor(person))?.html ?? '');
    expect(second).not.toBe(first);

    await reset(first, 'Unlock-Me-Please-1').expect(422);
    await reset(second, 'Unlock-Me-Please-1').expect(204);
    await loginRequest(t, { username: person.username, password: 'Unlock-Me-Please-1' }).expect(200);
  });

  it('refuses an expired token', async () => {
    const person = await createPerson(t.db, { org });
    await forgot(person.username).expect(202);
    const token = tokenFrom((await resetMailFor(person))?.html ?? '');
    await t.db.prisma.passwordResetToken.update({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await reset(token, 'Too-Late-Password-1').expect(422);
  });

  it('answers 202 for unknown accounts without sending mail', async () => {
    const before = t.mail.outbox.length;
    const since = await lastAuditId(t.db);
    const identifier = `ghost-${Date.now()}@example.test`;
    const res = await forgot(identifier).expect(202);
    expect(res.body.message).toContain('If the account exists');
    await t.mail.flush();
    expect(t.mail.outbox.length).toBe(before);
    const rows = await auditSince(t.db, since, { action: 'AUTH.PASSWORD_RESET_REQUESTED' });
    expect(rows.at(-1)).toMatchObject({ outcome: 'FAILURE', reason: 'UNKNOWN_ACCOUNT' });
  });

  it('does not send reset mail to accounts without an email address', async () => {
    const person = await createPerson(t.db, { org, email: null });
    const before = t.mail.outbox.length;
    await forgot(person.username).expect(202);
    await t.mail.flush();
    expect(t.mail.outbox.length).toBe(before);
  });
});
