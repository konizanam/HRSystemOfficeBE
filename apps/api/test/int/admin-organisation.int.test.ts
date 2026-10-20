import { addDays, businessFromDate } from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemContext } from '../../src/common/context/security-context';
import { HolidayService } from '../../src/modules/holidays/holiday.service';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  auditSince,
  createRoleFixtures,
  lastAuditId,
  login,
  nextUnique,
  type RoleFixtures,
} from '../support/fixtures';

/** Phase 9: companies, company rules, public holidays and holiday rules (section 12.10). */
describe('admin: companies, company rules and holidays', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let hr: Agent;
  let payroll: Agent;
  let sysAdmin: Agent;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    [hr, payroll, sysAdmin] = await Promise.all([
      login(t, f.hrAdmin),
      login(t, f.payrollAdmin),
      login(t, f.sysAdmin),
    ]);
  });

  afterAll(async () => {
    await t.close();
  });

  describe('companies', () => {
    it('creates, updates with the version (409 when stale) and deactivates, all audited', async () => {
      const code = `C${await nextUnique(t.db)}`;
      const since = await lastAuditId(t.db);
      const created = await hr.post('/admin/companies').send({ code, name: 'Acme Namibia' }).expect(201);
      expect(created.body).toMatchObject({
        code,
        name: 'Acme Namibia',
        currency: 'NAD',
        country: 'NA',
        isActive: true,
        version: 1,
      });
      const id = created.body.id as number;

      await hr.post('/admin/companies').send({ code, name: 'Duplicate' }).expect(409);

      // The new company is not in this HR admin's scope (their own company is), so edits are 403.
      await hr.put(`/admin/companies/${id}`).send({ name: 'Renamed', version: 1 }).expect(403);

      // Edits of their own company work and need the current version.
      const own = (await hr.get(`/admin/companies/${f.org.companyId}`).expect(200)).body as {
        version: number;
      };
      const updated = await hr
        .put(`/admin/companies/${f.org.companyId}`)
        .send({ name: `Fixture ${code}`, version: own.version })
        .expect(200);
      expect(updated.body.version).toBe(own.version + 1);
      const stale = await hr
        .put(`/admin/companies/${f.org.companyId}`)
        .send({ name: 'Stale', version: own.version })
        .expect(409);
      expect(stale.body.current).toEqual({ version: own.version + 1 });

      // A company with active employees cannot be deactivated.
      await hr
        .delete(`/admin/companies/${f.org.companyId}`)
        .send({ version: own.version + 1 })
        .expect(422);

      const rows = await auditSince(t.db, since, { entityType: 'Company' });
      expect(rows.map((r) => r.action)).toEqual(
        expect.arrayContaining(['COMPANY.CREATED', 'COMPANY.UPDATED']),
      );
      const update = rows.find((r) => r.action === 'COMPANY.UPDATED');
      expect(update?.changes).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'name', to: `Fixture ${code}` })]),
      );
    });

    it('lists companies by scope: HR and Payroll their own, system admins all', async () => {
      const hrList = (await hr.get('/admin/companies').expect(200)).body.items as { id: number }[];
      expect(hrList.map((c) => c.id)).toEqual([f.org.companyId]);
      const payrollList = (await payroll.get('/admin/companies').expect(200)).body.items as { id: number }[];
      expect(payrollList.map((c) => c.id)).toEqual([f.org.companyId]);
      const all = (await sysAdmin.get('/admin/companies').expect(200)).body.items as { id: number }[];
      expect(all.map((c) => c.id)).toEqual(expect.arrayContaining([f.org.companyId, f.otherOrg.companyId]));
      await hr.get(`/admin/companies/${f.otherOrg.companyId}`).expect(403);
      await payroll.post('/admin/companies').send({ code: 'X', name: 'X' }).expect(403);
    });
  });

  describe('company rules', () => {
    it('creates, edits, deactivates and reactivates a rule of the own company (audited, versioned)', async () => {
      const code = `R${await nextUnique(t.db)}`;
      const since = await lastAuditId(t.db);
      const created = await hr
        .post('/admin/company-rules')
        .send({ companyId: f.org.companyId, code, description: 'Contractors' })
        .expect(201);
      const id = created.body.id as number;
      expect(created.body).toMatchObject({
        companyId: f.org.companyId,
        code,
        isActive: true,
        employeeCount: 0,
      });
      await hr
        .post('/admin/company-rules')
        .send({ companyId: f.org.companyId, code, description: 'Again' })
        .expect(409);
      await hr
        .post('/admin/company-rules')
        .send({ companyId: f.otherOrg.companyId, code, description: 'Elsewhere' })
        .expect(403);

      const edited = await hr
        .put(`/admin/company-rules/${id}`)
        .send({ description: 'Contract staff', version: 1 })
        .expect(200);
      expect(edited.body).toMatchObject({ description: 'Contract staff', version: 2 });
      await hr.put(`/admin/company-rules/${id}`).send({ description: 'Stale', version: 1 }).expect(409);
      const off = await hr.delete(`/admin/company-rules/${id}`).send({ version: 2 }).expect(200);
      expect(off.body.isActive).toBe(false);
      const listed = (await hr.get('/admin/company-rules').expect(200)).body.items as { id: number }[];
      expect(listed.some((r) => r.id === id)).toBe(false);
      const withInactive = (await hr.get('/admin/company-rules?includeInactive=true').expect(200)).body
        .items as {
        id: number;
      }[];
      expect(withInactive.some((r) => r.id === id)).toBe(true);
      const on = await hr.post(`/admin/company-rules/${id}/activate`).send({ version: 3 }).expect(200);
      expect(on.body).toMatchObject({ isActive: true, version: 4 });

      const actions = (
        await auditSince(t.db, since, { entityType: 'CompanyRule', entityId: String(id) })
      ).map((r) => r.action);
      expect(actions).toEqual([
        'COMPANY_RULE.CREATED',
        'COMPANY_RULE.UPDATED',
        'COMPANY_RULE.DEACTIVATED',
        'COMPANY_RULE.ACTIVATED',
      ]);
    });

    it('refuses to deactivate a rule that still has employees', async () => {
      const rule = (await hr.get(`/admin/company-rules/${f.org.companyRuleId}`).expect(200)).body as {
        version: number;
      };
      await hr
        .delete(`/admin/company-rules/${f.org.companyRuleId}`)
        .send({ version: rule.version })
        .expect(422);
    });
  });

  describe('public holidays and rules', () => {
    it('adds, moves and deletes a company holiday; the leave calendar follows', async () => {
      const year = 2031 + ((await nextUnique(t.db)) % 50);
      const date = `${year}-07-15`;
      const since = await lastAuditId(t.db);
      const created = await hr
        .post('/admin/public-holidays')
        .send({ companyId: f.org.companyId, date, name: 'Founders Day' })
        .expect(201);
      const id = created.body.id as number;
      expect(created.body).toMatchObject({
        companyId: f.org.companyId,
        date,
        name: 'Founders Day',
        isDeleted: false,
      });
      await hr
        .post('/admin/public-holidays')
        .send({ companyId: f.org.companyId, date, name: 'Twice' })
        .expect(409);
      await hr
        .post('/admin/public-holidays')
        .send({ companyId: f.otherOrg.companyId, date, name: 'Not mine' })
        .expect(403);

      const holidays = t.app.get(HolidayService);
      expect((await holidays.calendar(f.org.companyId, date, date)).get(date)).toBe('Founders Day');

      const moved = addDays(date, 1);
      const updated = await hr
        .put(`/admin/public-holidays/${id}`)
        .send({ date: moved, version: 1 })
        .expect(200);
      expect(updated.body).toMatchObject({ date: moved, version: 2 });
      await hr.put(`/admin/public-holidays/${id}`).send({ name: 'Stale', version: 1 }).expect(409);

      const deleted = await hr.delete(`/admin/public-holidays/${id}`).send({ version: 2 }).expect(200);
      expect(deleted.body.isDeleted).toBe(true);
      expect((await holidays.calendar(f.org.companyId, moved, moved)).has(moved)).toBe(false);
      const list = (
        await hr.get(`/admin/public-holidays?year=${year}&companyId=${f.org.companyId}`).expect(200)
      ).body.items as { id: number }[];
      expect(list.some((h) => h.id === id)).toBe(false);
      const withDeleted = (
        await hr
          .get(`/admin/public-holidays?year=${year}&companyId=${f.org.companyId}&includeDeleted=true`)
          .expect(200)
      ).body.items as { id: number }[];
      expect(withDeleted.some((h) => h.id === id)).toBe(true);

      // Adding the date again restores the soft-deleted row (its unique key).
      const restored = await hr
        .post('/admin/public-holidays')
        .send({ companyId: f.org.companyId, date: moved, name: 'Founders Day (observed)' })
        .expect(201);
      expect(restored.body).toMatchObject({ id, isDeleted: false, name: 'Founders Day (observed)' });

      const actions = (
        await auditSince(t.db, since, { entityType: 'PublicHoliday', entityId: String(id) })
      ).map((r) => r.action);
      expect(actions).toEqual(['HOLIDAY.CREATED', 'HOLIDAY.UPDATED', 'HOLIDAY.DELETED', 'HOLIDAY.RESTORED']);
    });

    it('keeps a deleted rule-generated holiday off for that year', async () => {
      const year = 2100 + ((await nextUnique(t.db)) % 90);
      const rule = await hr
        .post('/admin/holiday-rules')
        .send({ companyId: f.org.companyId, name: `Rule day ${year}`, kind: 'FIXED', month: 9, day: 9 })
        .expect(201);
      const date = `${year}-09-09`;
      const holidays = t.app.get(HolidayService);
      // Computed on the fly from the rule.
      expect(
        (await holidays.between(f.org.companyId, date, date)).some((h) => h.name === `Rule day ${year}`),
      ).toBe(true);
      // Stored, then deleted by HR: it no longer counts, and the rule does not bring it back.
      await holidays.generateYear(systemContext('test-holidays'), year);
      const stored = await t.db.prisma.publicHoliday.findFirstOrThrow({
        where: { ruleId: rule.body.id as number, date: new Date(`${date}T00:00:00Z`) },
      });
      await hr.delete(`/admin/public-holidays/${stored.id}`).send({ version: stored.version }).expect(200);
      expect(
        (await holidays.between(f.org.companyId, date, date)).some((h) => h.name === `Rule day ${year}`),
      ).toBe(false);
      expect(businessFromDate(stored.date)).toBe(date);
    });

    it('validates, versions and deactivates holiday rules', async () => {
      await hr.post('/admin/holiday-rules').send({ name: 'Broken', kind: 'FIXED', month: 2 }).expect(422);
      await hr.post('/admin/holiday-rules').send({ name: 'Broken', kind: 'EASTER_RELATIVE' }).expect(422);
      const created = await hr
        .post('/admin/holiday-rules')
        .send({
          companyId: f.org.companyId,
          name: 'Easter Tuesday',
          kind: 'EASTER_RELATIVE',
          easterOffsetDays: 2,
        })
        .expect(201);
      const id = created.body.id as number;
      expect(created.body.thisYear).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const updated = await hr
        .put(`/admin/holiday-rules/${id}`)
        .send({
          name: 'Easter Tuesday',
          kind: 'EASTER_RELATIVE',
          easterOffsetDays: 2,
          validFromYear: 2030,
          version: 1,
        })
        .expect(200);
      expect(updated.body).toMatchObject({ validFromYear: 2030, version: 2 });
      await hr
        .put(`/admin/holiday-rules/${id}`)
        .send({ name: 'x', kind: 'EASTER_RELATIVE', easterOffsetDays: 2, version: 1 })
        .expect(409);
      const off = await hr.delete(`/admin/holiday-rules/${id}`).send({ version: 2 }).expect(200);
      expect(off.body.isActive).toBe(false);
      const rules = (await hr.get(`/admin/holiday-rules?companyId=${f.org.companyId}`).expect(200)).body
        .items as {
        id: number;
        isActive: boolean;
      }[];
      expect(rules.find((r) => r.id === id)?.isActive).toBe(false);
      await payroll.get('/admin/holiday-rules').expect(403);
    });
  });
});
