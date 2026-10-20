import type {
  AdminParameterValue,
  ParameterValuesResponse,
  PerformanceTemplate,
  TemplatesResponse,
} from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import {
  auditSince,
  createRoleFixtures,
  lastAuditId,
  login,
  nextUnique,
  type RoleFixtures,
} from '../support/fixtures';
import { PerformanceKit } from '../support/performance';
import type { Agent } from '../support/fixtures';

describe('performance: parameters and templates', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: PerformanceKit;
  let hr: Agent;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new PerformanceKit(t);
    await kit.setup();
    hr = await login(t, f.hrAdmin);
  });

  afterAll(async () => {
    await t.close();
  });

  describe('parameter lookups', () => {
    it('serves the seeded tables and the children of a parent', async () => {
      const emp = await login(t, f.employee);
      const categories = await emp.get('/lookups/parameters/ReviewCategory');
      expect(categories.status).toBe(200);
      const codes = (categories.body as ParameterValuesResponse).items.map((i) => i.code);
      expect(codes).toEqual(expect.arrayContaining(['ANNUAL', 'PROBATION', 'MIDYEAR']));
      const types = await emp.get('/lookups/parameters/ReviewType');
      expect((types.body as ParameterValuesResponse).items.map((i) => i.code)).toEqual(
        expect.arrayContaining(['SELF', 'MANAGER', '360']),
      );

      const kpa = await kit.param('KeyPerformanceArea', 'FINANCIAL');
      const kpis = await emp.get(`/lookups/parameters/KeyPerformanceIndicator?parentId=${kpa}`);
      const body = kpis.body as ParameterValuesResponse;
      expect(body.parentTable).toBe('KeyPerformanceArea');
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.every((i) => i.parentId === kpa)).toBe(true);
      for (const table of [
        'JobTitleType',
        'JobGrade',
        'SubKeyPerformanceIndicator',
        'CompetencyArea',
        'SubCompetency',
        'LevelOfComplexity',
      ])
        expect(
          ((await emp.get(`/lookups/parameters/${table}`)).body as ParameterValuesResponse).items.length,
        ).toBeGreaterThan(0);

      expect((await emp.get('/lookups/parameters/Unknown')).status).toBe(422);
    });

    it('lets HR add, change and deactivate rows with the hierarchy checked and audited', async () => {
      const n = await nextUnique(t.db);
      const since = await lastAuditId(t.db);
      const area = await hr
        .post('/admin/parameters/KeyPerformanceArea')
        .send({ code: `KPA${n}`, description: `Area ${n}` });
      expect(area.status, area.text).toBe(201);
      const areaRow = area.body as AdminParameterValue;
      expect(areaRow).toMatchObject({ code: `KPA${n}`, parentId: null, isActive: true, version: 1 });

      // A flat table takes no parent; a child table needs one from its parent table.
      expect(
        (
          await hr
            .post('/admin/parameters/KeyPerformanceArea')
            .send({ code: `X${n}`, description: 'x', parentId: areaRow.id })
        ).status,
      ).toBe(422);
      expect(
        (
          await hr
            .post('/admin/parameters/KeyPerformanceIndicator')
            .send({ code: `KPI${n}`, description: 'k' })
        ).status,
      ).toBe(422);
      const wrongParent = await hr
        .post('/admin/parameters/KeyPerformanceIndicator')
        .send({ code: `KPI${n}`, description: 'k', parentId: await kit.param('CompetencyArea', 'CORE') });
      expect(wrongParent.status).toBe(422);
      const kpi = await hr
        .post('/admin/parameters/KeyPerformanceIndicator')
        .send({ code: `KPI${n}`, description: `Indicator ${n}`, parentId: areaRow.id });
      expect(kpi.status, kpi.text).toBe(201);
      expect((kpi.body as AdminParameterValue).parentCode).toBe(`KPA${n}`);

      // Duplicate code 409, stale version 409.
      expect(
        (
          await hr
            .post('/admin/parameters/KeyPerformanceArea')
            .send({ code: `KPA${n}`, description: 'again' })
        ).status,
      ).toBe(409);
      expect(
        (
          await hr
            .put(`/admin/parameters/KeyPerformanceArea/${areaRow.id}`)
            .send({ version: 9, description: 'x' })
        ).status,
      ).toBe(409);
      // A row of another table is not found through this table.
      expect(
        (await hr.put(`/admin/parameters/Competency/${areaRow.id}`).send({ version: 1, description: 'x' }))
          .status,
      ).toBe(404);

      const renamed = await hr
        .put(`/admin/parameters/KeyPerformanceArea/${areaRow.id}`)
        .send({ version: 1, description: `Renamed ${n}` });
      expect(renamed.status, renamed.text).toBe(200);
      const deactivated = await hr
        .delete(`/admin/parameters/KeyPerformanceArea/${areaRow.id}`)
        .send({ version: 2 });
      expect(deactivated.status, deactivated.text).toBe(200);
      expect((deactivated.body as AdminParameterValue).isActive).toBe(false);

      const active = (await hr.get('/lookups/parameters/KeyPerformanceArea')).body as ParameterValuesResponse;
      expect(active.items.some((i) => i.id === areaRow.id)).toBe(false);
      const all = (await hr.get('/admin/parameters/KeyPerformanceArea')).body as {
        items: AdminParameterValue[];
      };
      expect(all.items.find((i) => i.id === areaRow.id)?.isActive).toBe(false);

      // A deactivated parent cannot take new children.
      expect(
        (
          await hr
            .post('/admin/parameters/KeyPerformanceIndicator')
            .send({ code: `KPI${n}b`, description: 'k', parentId: areaRow.id })
        ).status,
      ).toBe(422);

      const rows = await auditSince(t.db, since, {
        entityType: 'ParameterValue',
        entityId: String(areaRow.id),
      });
      expect(rows.map((r) => r.action)).toEqual([
        'PERFORMANCE_PARAMETER.CREATED',
        'PERFORMANCE_PARAMETER.UPDATED',
        'PERFORMANCE_PARAMETER.DEACTIVATED',
      ]);
      expect(rows.every((r) => r.actorUserId === f.hrAdmin.userId)).toBe(true);
    });

    it('lists the rating scales', async () => {
      const res = await hr.get('/performance/rating-scales');
      expect(res.status).toBe(200);
      const scale = (
        res.body as {
          items: { name: string; points: { value: number; label: string }[]; min: string; max: string }[];
        }
      ).items.find((s) => s.name === '1–5');
      expect(scale?.points.map((p) => p.label)).toEqual([
        'Unacceptable',
        'Needs Improvement',
        'Meets Expectations',
        'Exceeds Expectations',
        'Outstanding',
      ]);
      expect(scale).toMatchObject({ min: '1', max: '5' });
    });
  });

  describe('templates', () => {
    it('refuses section weights that do not add up to 100 (422)', async () => {
      const items = await kit.items();
      const res = await hr.post('/performance/templates').send({
        name: await kit.unique('Bad weights'),
        contractStartDate: '2026-01-01',
        contractEndDate: '2026-12-31',
        ratingScaleId: await kit.scaleId(),
        items: [{ ...items[0], weight: '50' }, items[1], items[2]],
      });
      expect(res.status).toBe(422);
      expect((res.body as { errors: { path: string; message: string }[] }).errors).toEqual([
        {
          path: 'items',
          message: 'The Key Performance Areas weights add up to 90.00; they must add up to 100',
        },
      ]);
    });

    it('checks the parameter link of each item', async () => {
      const base = {
        name: await kit.unique('Links'),
        contractStartDate: '2026-01-01',
        contractEndDate: '2026-12-31',
        ratingScaleId: await kit.scaleId(),
      };
      const competency = await kit.param('Competency', 'TEAMWORK');
      const wrongTable = await hr
        .post('/performance/templates')
        .send({ ...base, items: [{ kind: 'KPA', parameterValueId: competency, weight: '100' }] });
      expect(wrongTable.status).toBe(422);
      expect((wrongTable.body as { errors: { path: string }[] }).errors[0]?.path).toBe(
        'items.0.parameterValueId',
      );
      const objective = await hr
        .post('/performance/templates')
        .send({ ...base, items: [{ kind: 'OBJECTIVE', parameterValueId: competency, weight: '100' }] });
      expect(objective.status).toBe(422);
      const untitled = await hr
        .post('/performance/templates')
        .send({ ...base, items: [{ kind: 'OBJECTIVE', weight: '100' }] });
      expect((untitled.body as { errors: { path: string }[] }).errors[0]?.path).toBe('items.0.title');
      const empty = await hr.post('/performance/templates').send({ ...base, status: 'ACTIVE', items: [] });
      expect(empty.status).toBe(422);
    });

    it('creates, edits, activates and copies a template with the grid fields and audit rows', async () => {
      const since = await lastAuditId(t.db);
      const draft = await kit.template(hr, { status: 'DRAFT' });
      expect(draft).toMatchObject({
        status: 'DRAFT',
        ratingScale: '1–5',
        processDefinition: 'Annual cycle',
        linkedContracts: 0,
        ownerUserId: f.hrAdmin.userId,
        createdFromTemplate: null,
        version: 1,
      });
      expect(draft.templateOwner).toMatch(/^First\d+ Last\d+$/);
      expect(draft.items.map((i) => [i.kind, i.title, i.weight])).toEqual([
        ['KPA', 'Financial', '60.00'],
        ['KPA', 'Customer', '40.00'],
        ['COMPETENCY', 'Communication', '100.00'],
      ]);
      expect(draft.sectionTotals).toEqual([
        { section: 'KPA', total: '100.00', valid: true },
        { section: 'COMPETENCY', total: '100.00', valid: true },
      ]);

      // Edit the items while DRAFT: keep two, change a weight, add an objective section.
      const [fin, cus] = draft.items;
      const edited = await hr.put(`/performance/templates/${draft.id}`).send({
        version: 1,
        items: [
          { id: fin?.id, kind: 'KPA', parameterValueId: fin?.parameterValueId, weight: '70' },
          { id: cus?.id, kind: 'KPA', parameterValueId: cus?.parameterValueId, weight: '30' },
          { kind: 'OBJECTIVE', title: 'Launch the portal', weight: '100', target: 'By June' },
        ],
      });
      expect(edited.status, edited.text).toBe(200);
      const editedBody = edited.body as PerformanceTemplate;
      expect(editedBody.items.map((i) => [i.kind, i.weight])).toEqual([
        ['KPA', '70.00'],
        ['KPA', '30.00'],
        ['OBJECTIVE', '100.00'],
      ]);
      expect(editedBody.items[0]?.id).toBe(fin?.id);
      // The removed competency is soft-deleted, not deleted.
      const removed = await t.db.prisma.performanceTemplateItem.findFirstOrThrow({
        where: { templateId: draft.id, kind: 'COMPETENCY' },
      });
      expect(removed.deletedAt).not.toBeNull();

      // Stale version 409; bad weights on edit 422.
      expect(
        (await hr.put(`/performance/templates/${draft.id}`).send({ version: 1, name: 'x' })).status,
      ).toBe(409);
      expect(
        (
          await hr.put(`/performance/templates/${draft.id}`).send({
            version: 2,
            items: [{ kind: 'OBJECTIVE', title: 'Half', weight: '50' }],
          })
        ).status,
      ).toBe(422);

      const active = await hr
        .put(`/performance/templates/${draft.id}`)
        .send({ version: 2, status: 'ACTIVE' });
      expect(active.status, active.text).toBe(200);
      expect((active.body as PerformanceTemplate).status).toBe('ACTIVE');
      // Items change only while DRAFT; an active template cannot go back to DRAFT.
      const locked = await hr
        .put(`/performance/templates/${draft.id}`)
        .send({ version: 3, items: [{ kind: 'OBJECTIVE', title: 'Only', weight: '100' }] });
      expect(locked.status).toBe(422);
      expect(
        (await hr.put(`/performance/templates/${draft.id}`).send({ version: 3, status: 'DRAFT' })).status,
      ).toBe(422);
      // The name can still change.
      expect(
        (await hr.put(`/performance/templates/${draft.id}`).send({ version: 3, name: `${draft.name} v2` }))
          .status,
      ).toBe(200);

      const copy = await hr.post(`/performance/templates/${draft.id}/copy`).send({});
      expect(copy.status, copy.text).toBe(201);
      const copyBody = copy.body as PerformanceTemplate;
      expect(copyBody).toMatchObject({
        name: `Copy of ${draft.name} v2`,
        status: 'DRAFT',
        createdFromTemplateId: draft.id,
        createdFromTemplate: `${draft.name} v2`,
        version: 1,
      });
      expect(copyBody.items.map((i) => [i.kind, i.title, i.weight])).toEqual(
        editedBody.items.map((i) => [i.kind, i.title, i.weight]),
      );

      const grid = await hr.get(
        `/performance/templates?search=${encodeURIComponent(draft.name)}&sort=name:asc`,
      );
      expect(grid.status).toBe(200);
      const names = (grid.body as TemplatesResponse).items.map((i) => i.name);
      expect(names).toEqual(expect.arrayContaining([copyBody.name, `${draft.name} v2`]));
      const archived = await hr
        .put(`/performance/templates/${draft.id}`)
        .send({ version: 4, status: 'ARCHIVED' });
      expect(archived.status).toBe(200);
      expect(
        (await hr.put(`/performance/templates/${draft.id}`).send({ version: 5, name: 'x' })).status,
      ).toBe(422);

      const actions = (await auditSince(t.db, since, { entityType: 'PerformanceTemplate' })).map((r) => [
        r.entityId,
        r.action,
      ]);
      expect(actions).toEqual([
        [String(draft.id), 'PERFORMANCE_TEMPLATE.CREATED'],
        [String(draft.id), 'PERFORMANCE_TEMPLATE.UPDATED'],
        [String(draft.id), 'PERFORMANCE_TEMPLATE.STATUS_CHANGED'],
        [String(draft.id), 'PERFORMANCE_TEMPLATE.UPDATED'],
        [String(copyBody.id), 'PERFORMANCE_TEMPLATE.COPIED'],
        [String(draft.id), 'PERFORMANCE_TEMPLATE.STATUS_CHANGED'],
      ]);
    });

    it('is managed by HR and read by auditors only', async () => {
      const template = await kit.template(hr);
      const auditor = await login(t, f.auditor);
      expect((await auditor.get(`/performance/templates/${template.id}`)).status).toBe(200);
      expect((await auditor.post(`/performance/templates/${template.id}/copy`).send({})).status).toBe(403);
      const emp = await login(t, f.employee);
      expect((await emp.get('/performance/templates')).status).toBe(403);
      expect((await hr.get('/performance/templates/999999999')).status).toBe(404);
    });
  });
});
