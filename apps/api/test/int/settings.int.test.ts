import { SETTING_KEYS } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import { hashToken } from '../../src/modules/auth/auth-policy';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  auditSince,
  createOrg,
  createPerson,
  lastAuditId,
  login,
  type Org,
} from '../support/fixtures';

describe('system settings (section 10.5)', () => {
  let t: TestApp;
  let org: Org;
  let admin: Agent;

  beforeAll(async () => {
    t = await startTestApp();
    org = await createOrg(t.db);
    admin = await login(t, await createPerson(t.db, { org, roles: ['SYSTEM_ADMIN'] }));
  });

  afterAll(async () => {
    await t.close();
  });

  it('returns every setting with its description for SYSTEM_ADMIN', async () => {
    const res = await admin.get('/admin/settings').expect(200);
    expect(Object.keys(res.body.values).sort()).toEqual([...SETTING_KEYS].sort());
    expect(res.body.items).toHaveLength(SETTING_KEYS.length);
    const item = res.body.items.find((i: { key: string }) => i.key === 'session.warnSeconds');
    expect(item.description).toContain('countdown');
  });

  it('is forbidden to other roles, with a DENIED audit row', async () => {
    for (const roles of [['EMPLOYEE'], ['HR_ADMIN'], ['AUDITOR']] as const) {
      const agent = await login(t, await createPerson(t.db, { org, roles: [...roles] }));
      const since = await lastAuditId(t.db);
      const res = await agent.get('/admin/settings').expect(403);
      const rows = await auditSince(t.db, since, { requestId: res.headers['x-request-id'] as string });
      expect(rows[0]).toMatchObject({ action: 'SECURITY.ACCESS_DENIED', outcome: 'DENIED' });
      expect(rows[0]?.metadata).toMatchObject({ requiredRoles: ['SYSTEM_ADMIN'] });
      await agent.put('/admin/settings').send({ values: {} }).expect(403);
    }
  });

  it('updates, audits SECURITY.SETTING_CHANGED with before/after and refreshes the cache', async () => {
    const previous = await t.settings.get('ui.helpUrl');
    const url = `https://help.example.test/${Date.now()}`;
    const since = await lastAuditId(t.db);
    try {
      const res = await admin
        .put('/admin/settings')
        .send({ values: { 'ui.helpUrl': url } })
        .expect(200);
      expect(res.body.values['ui.helpUrl']).toBe(url);
      const item = res.body.items.find((i: { key: string }) => i.key === 'ui.helpUrl');
      expect(item).toMatchObject({ isDefault: false });
      expect(item.updatedAt).toEqual(expect.any(String));

      const rows = await auditSince(t.db, since, {
        action: 'SECURITY.SETTING_CHANGED',
        entityId: 'ui.helpUrl',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ category: 'SECURITY', entityType: 'SystemSetting' });
      expect(rows[0]?.before).toMatchObject({ key: 'ui.helpUrl', value: previous });
      expect(rows[0]?.after).toMatchObject({ key: 'ui.helpUrl', value: url });
      // The explicit audit covers the write: no generic DATA_CHANGE row.
      expect(
        await auditSince(t.db, since, { entityType: 'SystemSetting', category: 'DATA_CHANGE' }),
      ).toHaveLength(0);

      expect((await admin.get('/session').expect(200)).body.settings.helpUrl).toBe(url);

      // Saving the same value again changes nothing and audits nothing.
      const again = await lastAuditId(t.db);
      await admin
        .put('/admin/settings')
        .send({ values: { 'ui.helpUrl': url } })
        .expect(200);
      expect(await auditSince(t.db, again, { action: 'SECURITY.SETTING_CHANGED' })).toHaveLength(0);
    } finally {
      await t.settings.update(systemContext('test'), { 'ui.helpUrl': previous });
    }
  });

  it('validates each value and rejects unknown keys', async () => {
    const bad = await admin
      .put('/admin/settings')
      .send({ values: { 'session.idleMinutes': 0, 'ui.accentColour': 'teal' } })
      .expect(422);
    const paths = bad.body.errors.map((e: { path: string }) => e.path).sort();
    expect(paths).toEqual(['values.session.idleMinutes', 'values.ui.accentColour']);
    await admin
      .put('/admin/settings')
      .send({ values: { 'no.such.setting': true } })
      .expect(422);
  });

  it('requires the CSRF token for changes', async () => {
    await admin.put('/admin/settings', { csrf: false }).send({ values: {} }).expect(403);
  });

  it('applies session.idleMinutes to sessions immediately', async () => {
    const previous = await t.settings.get('session.idleMinutes');
    const agent = await login(t, await createPerson(t.db, { org }));
    await t.db.prisma.session.update({
      where: { id: hashToken(agent.sessionToken) },
      data: { lastActivityAt: new Date(Date.now() - 6 * 60_000) },
    });
    try {
      await admin
        .put('/admin/settings')
        .send({ values: { 'session.idleMinutes': 30 } })
        .expect(200);
      expect((await agent.get('/session').expect(200)).body.settings.idleMinutes).toBe(30);
      await admin
        .put('/admin/settings')
        .send({ values: { 'session.idleMinutes': 5 } })
        .expect(200);
      await agent.get('/session').expect(401);
    } finally {
      await t.settings.update(systemContext('test'), { 'session.idleMinutes': previous });
    }
  });
});
