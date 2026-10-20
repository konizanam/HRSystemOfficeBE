import type {
  PayslipDetail,
  PayslipImportResponse,
  PayslipListResponse,
  TaxCertificatesResponse,
} from '@peoplehub/shared';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app';
import {
  type Agent,
  auditSince,
  createRoleFixtures,
  lastAuditId,
  login,
  type RoleFixtures,
} from '../support/fixtures';
import { bufferParser, PayrollKit } from '../support/payroll';
import { WorkflowKit } from '../support/workflow';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('payslips and tax certificates (sections 5.5, 5.6)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let kit: PayrollKit;
  let payroll: Agent;
  let ends: string[];
  let firstImport: PayslipImportResponse;

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    kit = new PayrollKit(t, new WorkflowKit(t));
    ends = await kit.periods(f.org, 5);
    await kit.periods(f.otherOrg, 1);
    payroll = await login(t, f.payrollAdmin);
  });

  afterAll(async () => {
    await t.close();
  });

  describe('import', () => {
    it('dry run validates without writing; commit creates payslips with stored PDFs, audited per row', async () => {
      const rows = ends.map((end) => kit.row(f.employee.employeeCode ?? '', end));
      const since = await lastAuditId(t.db);
      const { dry, commit } = await kit.importPayslips(payroll, rows);
      expect(dry).toMatchObject({ mode: 'DRY_RUN', committed: false, validRows: 5, invalidRows: 0 });
      expect(dry.rows.every((r) => r.payslipId === null && r.action === 'CREATE')).toBe(true);
      expect(dry.rows[0]).toMatchObject({ grossPay: '20000.00', netPay: '15600.00', lineCount: 3 });
      expect(commit).toMatchObject({ committed: true, validRows: 5 });
      firstImport = commit;

      const audits = await auditSince(t.db, since);
      const imported = audits.filter((a) => a.action === 'PAYSLIP.IMPORTED');
      expect(imported).toHaveLength(5);
      expect(
        imported.every(
          (a) => a.subjectEmployeeId === f.employee.employeeId && a.actorUserId === f.payrollAdmin.userId,
        ),
      ).toBe(true);
      expect(JSON.stringify(imported.map((a) => [a.after, a.metadata]))).not.toContain('15600');
      expect(audits.filter((a) => a.action === 'ATTACHMENT.GENERATED')).toHaveLength(5);

      const stored = await t.db.prisma.payslip.findMany({
        where: { id: { in: commit.rows.map((r) => r.payslipId ?? 0) } },
        include: { lines: true },
      });
      expect(stored).toHaveLength(5);
      for (const p of stored) {
        expect(p.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(p.netPay.toFixed(2)).toBe('15600.00');
        expect(p.lines.map((l) => l.category)).toEqual(['EARNING', 'DEDUCTION', 'COMPANY_CONTRIBUTION']);
        const file = await t.db.prisma.attachment.findUniqueOrThrow({
          where: { id: p.pdfAttachmentId ?? '' },
        });
        expect(file).toMatchObject({
          ownerEntity: 'Payslip',
          ownerEntityId: String(p.id),
          sha256: p.pdfSha256,
        });
      }
      const notes = await t.db.prisma.notification.findMany({
        where: { userId: f.employee.userId, kind: 'PAYSLIP_AVAILABLE' },
      });
      expect(notes).toHaveLength(5);
    });

    it('commit needs the dry run token of the same content', async () => {
      const body = {
        format: 'json',
        rows: [kit.row(f.employee2.employeeCode ?? '', ends[0] ?? '')],
        replace: false,
      };
      const res = await payroll
        .post('/admin/payslips/import')
        .send({ ...body, mode: 'COMMIT', confirmToken: 'x'.repeat(64) });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].path).toBe('confirmToken');
    });

    it('reports row errors: unknown or out-of-scope employee, no period, net pay control, duplicates', async () => {
      const res = await payroll.post('/admin/payslips/import').send({
        mode: 'DRY_RUN',
        format: 'json',
        rows: [
          kit.row('NOPE-1', ends[0] ?? ''),
          kit.row(f.otherCompany.employeeCode ?? '', ends[4] ?? ''),
          kit.row(f.employee2.employeeCode ?? '', '2001-01-31'),
          kit.row(f.employee2.employeeCode ?? '', ends[1] ?? '', { netPay: '1.00' }),
          kit.row(f.employee2.employeeCode ?? '', ends[2] ?? ''),
          kit.row(f.employee2.employeeCode ?? '', ends[2] ?? ''),
          { employeeCode: 'X', periodEndDate: 'bad', lines: [] },
        ],
      });
      expect(res.status, res.text).toBe(200);
      const rows = (res.body as PayslipImportResponse).rows;
      expect(rows.map((r) => r.ok)).toEqual([false, false, false, false, true, false, false]);
      expect(rows[0]?.errors[0]).toContain('Unknown employee');
      expect(rows[1]?.errors[0]).toContain('not in your companies');
      expect(rows[2]?.errors[0]).toContain('No pay period');
      expect(rows[3]?.errors[0]).toContain('does not match');
      expect(rows[5]?.errors[0]).toContain('twice');
      expect(rows[6]?.errors.join(' ')).toContain('periodEndDate');
      const commit = await payroll.post('/admin/payslips/import').send({
        mode: 'COMMIT',
        format: 'json',
        rows: [kit.row('NOPE-1', ends[0] ?? '')],
        confirmToken: (res.body as PayslipImportResponse).confirmToken,
      });
      expect(commit.status).toBe(422);
    });

    it('refuses a re-import unless replace=true, which supersedes the old payslip (audited)', async () => {
      const row = kit.row(f.employee.employeeCode ?? '', ends[4] ?? '');
      const dry = await payroll
        .post('/admin/payslips/import')
        .send({ mode: 'DRY_RUN', format: 'json', rows: [row] });
      expect((dry.body as PayslipImportResponse).rows[0]?.errors[0]).toContain('replace');
      const since = await lastAuditId(t.db);
      const changed = {
        ...row,
        lines: [
          { category: 'EARNING' as const, code: 'BASIC', description: 'Basic Salary', amount: '21000.00' },
        ],
      };
      const { dry: d2, commit } = await kit.importPayslips(payroll, [changed], true);
      expect(d2.rows[0]?.action).toBe('REPLACE');
      const oldId = firstImport.rows[4]?.payslipId ?? 0;
      const old = await t.db.prisma.payslip.findUniqueOrThrow({ where: { id: oldId } });
      expect(old.supersededAt).not.toBeNull();
      const audits = await auditSince(t.db, since);
      expect(audits.map((a) => a.action)).toEqual(
        expect.arrayContaining(['PAYSLIP.SUPERSEDED', 'PAYSLIP.REPLACED']),
      );
      const replaced = commit.rows[0];
      if (replaced) firstImport.rows[4] = replaced;
      const emp = await login(t, f.employee);
      expect((await emp.get(`/payslips/${oldId}`)).status).toBe(404);
    });

    it('imports the CSV layout', async () => {
      const code = f.employee2.employeeCode ?? '';
      const csv = [
        'employeeCode,periodEndDate,payRun,runType,category,code,description,amount,ytdAmount',
        `${code},${ends[3]},SECOND,Bonus,EARNING,BONUS,Bonus,5000.00,5000.00`,
        `${code},${ends[3]},SECOND,Bonus,DEDUCTION,PAYE,PAYE,1000.00,`,
      ].join('\n');
      const dry = await payroll.post('/admin/payslips/import').send({ mode: 'DRY_RUN', format: 'csv', csv });
      expect(dry.status, dry.text).toBe(200);
      expect((dry.body as PayslipImportResponse).rows[0]).toMatchObject({
        ok: true,
        sourceLines: [1, 2],
        payRun: 'SECOND',
      });
      const commit = await payroll.post('/admin/payslips/import').send({
        mode: 'COMMIT',
        format: 'csv',
        csv,
        confirmToken: (dry.body as PayslipImportResponse).confirmToken,
      });
      expect(commit.status, commit.text).toBe(200);
      const p = await t.db.prisma.payslip.findUniqueOrThrow({ where: { id: commit.body.rows[0].payslipId } });
      expect([p.payRun, p.runType, p.netPay.toFixed(2)]).toEqual(['SECOND', 'Bonus', '4000.00']);
    });
  });

  describe('reading', () => {
    it('lists cards 4 at a time with "More"', async () => {
      const emp = await login(t, f.employee);
      const page1 = (await emp.get('/payslips').expect(200)).body as PayslipListResponse;
      expect(page1).toMatchObject({
        total: 5,
        pageSize: 4,
        hasMore: true,
        employeeId: f.employee.employeeId,
      });
      expect(page1.items).toHaveLength(4);
      const card = page1.items[0];
      expect(card?.periodEndDate).toBe(ends[4]);
      expect(card).toMatchObject({ companyRule: 'Staff', payRunLabel: 'Main Payrun', runType: 'Normal' });
      expect(card?.periodEndLabel).toMatch(/^\d{2} [A-Z][a-z]{2} \d{4}$/);
      expect(card?.companyName).toContain('Fixture Company');
      expect(card).not.toHaveProperty('netPay');
      const page2 = (await emp.get('/payslips?page=2').expect(200)).body as PayslipListResponse;
      expect(page2).toMatchObject({ hasMore: false });
      expect(page2.items).toHaveLength(1);
    });

    it('audits the metadata view, the inline PDF and the download', async () => {
      const emp = await login(t, f.employee);
      const id = firstImport.rows[0]?.payslipId ?? 0;
      const since = await lastAuditId(t.db);
      const meta = (await emp.get(`/payslips/${id}`).expect(200)).body as PayslipDetail;
      expect(meta).toMatchObject({ netPay: '15600.00', pdfUrl: `/api/v1/payslips/${id}/pdf` });
      const inline = await emp.get(`/payslips/${id}/pdf`).buffer(true).parse(bufferParser);
      expect(inline.status).toBe(200);
      expect(inline.headers['content-type']).toBe('application/pdf');
      expect(inline.headers['content-disposition']).toMatch(/^inline;/);
      const bytes = (inline.body as { bytes: Buffer }).bytes;
      expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
      expect(sha256(bytes)).toBe(meta.pdfSha256);
      const download = await emp.get(`/payslips/${id}/pdf?download=1`).buffer(true).parse(bufferParser);
      expect(download.headers['content-disposition']).toMatch(/^attachment;/);
      const audits = await auditSince(t.db, since, { entityType: 'Payslip', entityId: String(id) });
      expect(audits.map((a) => a.action)).toEqual([
        'DATA_VIEW.PAYSLIP',
        'DATA_VIEW.PAYSLIP',
        'EXPORT.PAYSLIP_PDF',
      ]);
      expect(audits.every((a) => a.subjectEmployeeId === f.employee.employeeId)).toBe(true);
    });

    it('lets a payroll admin in scope read any payslip (audited), not a manager or a colleague', async () => {
      const id = firstImport.rows[1]?.payslipId ?? 0;
      expect((await payroll.get(`/payslips/${id}`)).status).toBe(200);
      expect((await payroll.get(`/payslips?employeeId=${f.employee.employeeId}`)).body.total).toBe(5);
      for (const person of [f.employee2, f.managerB, f.hrAdmin, f.auditor, f.sysAdmin]) {
        const agent = await login(t, person);
        const since = await lastAuditId(t.db);
        const res = await agent.get(`/payslips/${id}`);
        expect(res.status, person.username).toBe(403);
        const denied = await auditSince(t.db, since, { requestId: res.headers['x-request-id'] as string });
        expect(denied.some((a) => a.outcome === 'DENIED')).toBe(true);
        expect((await agent.get(`/payslips/${id}/pdf`)).status).toBe(403);
      }
      const manager = await login(t, f.managerB);
      expect((await manager.get(`/payslips?employeeId=${f.employee.employeeId}`)).status).toBe(403);
    });

    it('returns 403 with a DENIED audit row when viewing payslips while working as someone else', async () => {
      const manager = await login(t, f.managerB);
      await kit.actAs(manager, f.employee.employeeId);
      for (const path of [
        '/payslips',
        `/payslips/${firstImport.rows[0]?.payslipId}`,
        `/payslips/${firstImport.rows[0]?.payslipId}/pdf`,
      ]) {
        const since = await lastAuditId(t.db);
        const res = await manager.get(path);
        expect(res.status, path).toBe(403);
        expect(res.body.type).toBe('urn:peoplehub:problem:restricted-while-working-as');
        const rows = await auditSince(t.db, since, { requestId: res.headers['x-request-id'] as string });
        const denied = rows.find((r) => r.outcome === 'DENIED');
        expect(denied?.metadata).toMatchObject({ feature: 'PAYSLIPS' });
        expect(denied?.subjectEmployeeId).toBe(f.employee.employeeId);
      }
    });

    it('never serves a payslip PDF through the attachments endpoint', async () => {
      const p = await t.db.prisma.payslip.findUniqueOrThrow({
        where: { id: firstImport.rows[0]?.payslipId ?? 0 },
      });
      const emp = await login(t, f.employee);
      expect((await emp.get(`/attachments/${p.pdfAttachmentId}`)).status).toBe(403);
    });
  });

  describe('tax certificates', () => {
    let generatedId = 0;

    it('imports a generated certificate and an uploaded PDF, audited, and lists them by tax year', async () => {
      const uploadId = await kit.upload(payroll);
      const since = await lastAuditId(t.db);
      const result = await kit.importCertificates(payroll, [
        {
          employeeCode: f.employee.employeeCode ?? '',
          taxYear: 2026,
          figures: [{ code: '3601', description: 'Gross remuneration', amount: '240000.00' }],
        },
        { employeeCode: f.employee.employeeCode ?? '', taxYear: 2025, attachmentId: uploadId },
      ]);
      expect(result.rows.map((r) => [r.ok, r.source])).toEqual([
        [true, 'GENERATED'],
        [true, 'UPLOADED'],
      ]);
      generatedId = result.rows[0]?.certificateId ?? 0;
      const audits = await auditSince(t.db, since);
      expect(audits.filter((a) => a.action === 'TAX_CERTIFICATE.IMPORTED')).toHaveLength(2);
      expect(audits.some((a) => a.action === 'ATTACHMENT.BOUND' && a.entityId === uploadId)).toBe(true);
      const uploaded = await t.db.prisma.taxCertificate.findUniqueOrThrow({
        where: { id: result.rows[1]?.certificateId ?? 0 },
      });
      expect(uploaded).toMatchObject({ pdfAttachmentId: uploadId, source: 'UPLOADED' });

      const emp = await login(t, f.employee);
      const list = (await emp.get('/tax-certificates').expect(200)).body as TaxCertificatesResponse;
      expect(list.years.map((y) => [y.taxYear, y.label, y.items.length])).toEqual([
        [2026, 'Mar 2025 – Feb 2026', 1],
        [2025, 'Mar 2024 – Feb 2025', 1],
      ]);
      const other = await login(t, f.employee2);
      expect((await other.get('/tax-certificates').expect(200)).body).toMatchObject({ total: 0, years: [] });
    });

    it('refuses an upload that is not an unused PDF of the importer', async () => {
      const res = await payroll.post('/admin/tax-certificates/import').send({
        mode: 'DRY_RUN',
        format: 'json',
        rows: [
          {
            employeeCode: f.employee2.employeeCode,
            taxYear: 2026,
            attachmentId: '6f1c1c5e-8a8e-4f3c-9b55-111111111111',
          },
        ],
      });
      expect(res.body.rows[0].errors[0]).toContain('upload');
    });

    it('audits the PDF view and download; restricted while working as someone else', async () => {
      const emp = await login(t, f.employee);
      const since = await lastAuditId(t.db);
      const view = await emp.get(`/tax-certificates/${generatedId}/pdf`).buffer(true).parse(bufferParser);
      expect(view.status).toBe(200);
      expect((view.body as { bytes: Buffer }).bytes.subarray(0, 4).toString()).toBe('%PDF');
      await emp
        .get(`/tax-certificates/${generatedId}/pdf?download=1`)
        .buffer(true)
        .parse(bufferParser)
        .expect(200);
      const audits = await auditSince(t.db, since, { entityType: 'TaxCertificate' });
      expect(audits.map((a) => a.action)).toEqual([
        'DATA_VIEW.TAX_CERTIFICATE',
        'EXPORT.TAX_CERTIFICATE_PDF',
      ]);

      expect((await (await login(t, f.employee2)).get(`/tax-certificates/${generatedId}/pdf`)).status).toBe(
        403,
      );
      const manager = await login(t, f.managerB);
      await kit.actAs(manager, f.employee.employeeId);
      const res = await manager.get('/tax-certificates');
      expect(res.status).toBe(403);
      const rows = await auditSince(t.db, since, { requestId: res.headers['x-request-id'] as string });
      expect(rows.find((r) => r.outcome === 'DENIED')?.metadata).toMatchObject({
        feature: 'TAX_CERTIFICATES',
      });
    });
  });
});
