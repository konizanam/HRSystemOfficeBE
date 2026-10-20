import {
  REPORT_CATALOGUE,
  REPORT_CODES,
  type ReportCatalogue,
  type ReportCode,
  type ReportPage,
  todayBusinessDate,
} from '@peoplehub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { systemContext } from '../../src/common/context/security-context';
import { startTestApp, type TestApp } from '../support/app';
import { ClaimKit } from '../support/claims';
import {
  type Agent,
  auditSince,
  createPerson,
  createRoleFixtures,
  lastAuditId,
  login,
  type RoleFixtures,
} from '../support/fixtures';
import { LEAVE_TYPE, LeaveKit } from '../support/leave';
import { bufferParser, PayrollKit } from '../support/payroll';
import { PerformanceKit } from '../support/performance';
import { WorkflowKit } from '../support/workflow';

const AUDIT_CODES = REPORT_CODES.filter((c) => REPORT_CATALOGUE[c].group === 'AUDIT');
const BUSINESS_CODES = REPORT_CODES.filter((c) => REPORT_CATALOGUE[c].group !== 'AUDIT');
const BULK_LINES = 3000;

type Binary = { bytes: Buffer; chunks: number };

describe('reports (section 5.7)', () => {
  let t: TestApp;
  let f: RoleFixtures;
  let hr: Agent;
  let auditor: Agent;
  let bulkEmployeeId = 0;
  let scope: { employeeIds: number[] };

  async function run(agent: Agent, code: string, body: Record<string, unknown>) {
    return agent.post(`/reports/${code}/run`).send(body);
  }

  async function runFile(agent: Agent, code: string, body: Record<string, unknown>) {
    return agent.post(`/reports/${code}/run`).send(body).buffer(true).parse(bufferParser);
  }

  beforeAll(async () => {
    t = await startTestApp();
    f = await createRoleFixtures(t.db);
    const workflow = new WorkflowKit(t);
    const leave = new LeaveKit(t, workflow);
    const claims = new ClaimKit(t, workflow);
    const payroll = new PayrollKit(t, workflow);
    await leave.setup(f.org);
    await leave.accrue([f.employee.employeeId]);
    const emp = await login(t, f.employee);
    const start = await leave.monday(14, f.org.companyId);
    await leave.submit(emp, {
      leaveTypeId: LEAVE_TYPE.annual,
      ...(await leave.range(start, 2, f.org.companyId)),
    });

    await claims.setup(f.org);
    const groupId = await claims.group();
    const typeId = await claims.type(groupId, f.org.companyRuleId, { inputMode: 'AMOUNT' });
    await claims.submit(
      emp,
      await claims.create(emp, {
        groupId,
        lines: [{ claimTypeId: typeId, date: todayBusinessDate(), amount: '99.50' }],
      }),
    );

    const [end] = await payroll.periods(f.org, 1);
    await payroll.importPayslips(await login(t, f.payrollAdmin), [
      payroll.row(f.employee.employeeCode ?? '', end ?? ''),
    ]);

    // A large dataset: one processed claim with thousands of lines for a dedicated employee.
    const bulk = await createPerson(t.db, { org: f.org, label: 'bulk' });
    bulkEmployeeId = bulk.employeeId ?? 0;
    const sys = systemContext('test-reports');
    await t.db.tx(sys, async (tx) => {
      const claim = await tx.claim.create({
        data: {
          referenceNumber: `CBULK-${bulkEmployeeId}`,
          employeeId: bulkEmployeeId,
          groupId,
          description: 'Bulk lines',
          status: 'PROCESSED',
          totalAmount: BULK_LINES,
          submittedAt: new Date(),
          processedAt: new Date(),
        },
      });
      await tx.claimLine.createMany({
        data: Array.from({ length: BULK_LINES }, (_, i) => ({
          claimId: claim.id,
          claimTypeId: typeId,
          date: new Date(`${todayBusinessDate()}T00:00:00Z`),
          amount: '1.00',
          description: `Line ${i + 1}, "quoted"`,
          sortOrder: i,
        })),
      });
      t.app.get(AuditService).record(tx, sys, {
        category: 'DATA_CHANGE',
        action: 'TEST.BULK_CLAIM',
        entityType: 'Claim',
        entityId: claim.id,
      });
    });

    hr = await login(t, f.hrAdmin);
    auditor = await login(t, f.auditor);
    scope = { employeeIds: [f.employee.employeeId ?? 0, f.employee2.employeeId ?? 0] };
  }, 300_000);

  afterAll(async () => {
    await t.close();
  });

  describe('catalogue', () => {
    async function codes(agent: Agent): Promise<string[]> {
      const body = (await agent.get('/reports').expect(200)).body as ReportCatalogue;
      return body.groups.flatMap((g) => g.reports.map((r) => r.code));
    }

    it('is filtered by role and grouped as observed', async () => {
      const body = (await auditor.get('/reports').expect(200)).body as ReportCatalogue;
      expect(body.groups.map((g) => g.label)).toEqual([
        'Employee',
        'Leave',
        'Performance',
        'Workflow',
        'Audit',
      ]);
      expect(body.groups.flatMap((g) => g.reports.map((r) => r.code))).toEqual(REPORT_CODES);
      const leaveDetail = body.groups[1]?.reports.find((r) => r.code === 'LEAVE_DETAIL');
      expect(leaveDetail?.params.map((p) => p.kind)).toEqual([
        'dateRange',
        'companyRules',
        'employees',
        'includeTerminated',
        'leaveTypes',
        'statuses',
      ]);
      expect(leaveDetail?.formats).toEqual(['json', 'pdf', 'xlsx', 'csv']);

      const employee = await codes(await login(t, f.employee));
      expect(employee).toContain('LEAVE_DETAIL');
      expect(employee).not.toContain('EMPLOYEE_BASIC');
      expect(employee.some((c) => AUDIT_CODES.includes(c as ReportCode))).toBe(false);
      const sysAdmin = await codes(await login(t, f.sysAdmin));
      expect(sysAdmin).toEqual(expect.arrayContaining(AUDIT_CODES));
      expect(sysAdmin).not.toContain('EMPLOYEE_PAY_PERIOD_BASIC');
      const hrCodes = await codes(hr);
      expect(hrCodes).toEqual(BUSINESS_CODES);
      const hrBody = (await hr.get('/reports').expect(200)).body as ReportCatalogue;
      expect(hrBody.options.companyRules.map((r) => r.id)).toEqual([f.org.companyRuleId]);
    });

    it('offers only in-scope employees in the picker', async () => {
      const manager = await login(t, f.managerB);
      const res = await manager.get('/reports/EMPLOYEE_BASIC/employees').expect(200);
      expect(res.body.items.map((e: { employeeId: number }) => e.employeeId).sort()).toEqual(
        [f.managerB.employeeId, f.employee.employeeId, f.employee2.employeeId].sort(),
      );
      expect((await (await login(t, f.employee)).get('/reports/EMPLOYEE_BASIC/employees')).status).toBe(403);
    });
  });

  describe('runs', () => {
    it.each(BUSINESS_CODES)('%s runs as JSON and CSV', async (code) => {
      const json = await run(hr, code, { params: scope, format: 'json' });
      expect(json.status, json.text).toBe(200);
      const page = json.body as ReportPage;
      expect(page.columns.map((c) => c.key)).toEqual(REPORT_CATALOGUE[code].columns.map((c) => c.key));
      for (const row of page.rows)
        expect(Object.keys(row).sort()).toEqual(page.columns.map((c) => c.key).sort());
      const csv = await runFile(hr, code, { params: scope, format: 'csv' });
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      const text = (csv.body as Binary).bytes.toString('utf8');
      const header = text.slice(text.charCodeAt(0) === 0xfeff ? 1 : 0).split('\r\n')[0];
      expect(header).toBe(REPORT_CATALOGUE[code].columns.map((c) => c.label).join(','));
    });

    it.each(AUDIT_CODES)('%s runs as JSON and CSV', async (code) => {
      const params = { from: todayBusinessDate(), actorUsername: f.employee.username };
      const json = await run(auditor, code, { params, format: 'json' });
      expect(json.status, json.text).toBe(200);
      const csv = await runFile(auditor, code, { params, format: 'csv' });
      expect(csv.status).toBe(200);
    });

    it('streams Excel and PDF', async () => {
      for (const [agent, code, params] of [
        [hr, 'EMPLOYEE_BASIC', scope],
        [hr, 'LEAVE_DETAIL', scope],
        [auditor, 'AUDIT_TRAIL_EXTRACT', { from: todayBusinessDate(), actorUsername: f.employee.username }],
      ] as const) {
        const xlsx = await runFile(agent, code, { params, format: 'xlsx' });
        expect(xlsx.status, code).toBe(200);
        expect(xlsx.headers['content-type']).toContain('spreadsheetml');
        expect((xlsx.body as Binary).bytes.subarray(0, 2).toString()).toBe('PK');
        const pdf = await runFile(agent, code, { params, format: 'pdf' });
        expect(pdf.status, code).toBe(200);
        expect(pdf.headers['content-disposition']).toMatch(/^attachment; filename=".+\.pdf"$/);
        expect((pdf.body as Binary).bytes.subarray(0, 4).toString()).toBe('%PDF');
      }
    });

    it('audits every run and export as EXPORT.REPORT with the params', async () => {
      const since = await lastAuditId(t.db);
      await run(hr, 'LEAVE_BASIC', {
        params: { ...scope, statuses: ['IN_PROGRESS'] },
        format: 'json',
        page: 1,
        pageSize: 5,
      });
      await runFile(hr, 'LEAVE_BASIC', { params: scope, format: 'csv' });
      const rows = await auditSince(t.db, since, { action: 'EXPORT.REPORT' });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        category: 'EXPORT',
        entityType: 'Report',
        entityId: 'LEAVE_BASIC',
        actorUserId: f.hrAdmin.userId,
      });
      expect(rows[0]?.metadata).toMatchObject({
        format: 'json',
        page: 1,
        pageSize: 5,
        params: { employeeIds: scope.employeeIds, statuses: ['IN_PROGRESS'], includeTerminated: false },
      });
      expect(rows[1]?.metadata).toMatchObject({ format: 'csv' });
    });

    it('returns the data each report describes', async () => {
      const emp = await login(t, f.employee);
      const leave = (await run(emp, 'LEAVE_DETAIL', { format: 'json' }).then((r) => r.body)) as ReportPage;
      expect(leave.rows.length).toBeGreaterThan(0);
      expect(leave.rows.every((r) => r.employeeCode === f.employee.employeeCode)).toBe(true);
      expect(leave.rows[0]).toMatchObject({
        leaveType: 'Annual Leave',
        status: 'In Progress',
        units: '2.0000',
      });

      const payroll = await login(t, f.payrollAdmin);
      const basic = (
        await run(payroll, 'EMPLOYEE_PAY_PERIOD_BASIC', { params: { employeeIds: [f.employee.employeeId] } })
      ).body as ReportPage;
      expect(basic.rows.some((r) => r.netPay === '15600.00' && r.payRuns === 'Main Payrun')).toBe(true);

      const lines = (await run(hr, 'CLAIM_LINE', { params: scope })).body as ReportPage;
      expect(lines.rows).toEqual([expect.objectContaining({ amount: '99.50', claimStatus: 'In Progress' })]);
      const summary = (await run(hr, 'CLAIM_SUMMARY', { params: scope })).body as ReportPage;
      expect(summary.rows[0]).toMatchObject({ lines: 1, pendingAmount: '99.50', processedAmount: '0.00' });
      const processes = (await run(hr, 'PROCESS_HISTORY', { params: scope })).body as ReportPage;
      expect(processes.rows.map((r) => r.workflowType).sort()).toEqual(['CLAIMS', 'LEAVE']);

      const sensitive = (
        await run(auditor, 'SENSITIVE_DATA_ACCESS', {
          params: { from: todayBusinessDate(), employeeIds: [f.employee.employeeId] },
        })
      ).body as ReportPage;
      expect(sensitive.rows.every((r) => String(r.action).startsWith('DATA_VIEW.'))).toBe(true);
    });

    it('reports performance contracts, reviews and reviewers (Phase 8 data)', async () => {
      const perf = new PerformanceKit(t);
      await perf.setup();
      const template = await perf.template(hr);
      await perf.initiate(hr, template.id, [f.employee.employeeId ?? 0]);
      const review = await perf.sharedReview(hr, template.id, f.employee.employeeId ?? 0, [
        f.managerB.employeeId ?? 0,
      ]);
      const params = { employeeIds: [f.employee.employeeId] };
      const results = (await run(hr, 'PERFORMANCE_REVIEW_RESULTS', { params })).body as ReportPage;
      expect(results.rows).toEqual([
        expect.objectContaining({
          reviewName: review.name,
          employeeCode: f.employee.employeeCode,
          reviewers: 1,
        }),
      ]);
      const contracts = (await run(hr, 'CONTRACT_REVIEW_OVERVIEW', { params })).body as ReportPage;
      expect(contracts.rows).toEqual([expect.objectContaining({ templateName: template.name, reviews: 1 })]);
      const reviewers = (await run(hr, 'REVIEWER_DETAIL', { params })).body as ReportPage;
      expect(reviewers.rows).toEqual([
        expect.objectContaining({
          reviewName: review.name,
          revieweeCode: f.employee.employeeCode,
          scoresSubmitted: 0,
        }),
      ]);
      const plan = (await run(hr, 'DEVELOPMENT_PLAN', { params })).body as ReportPage;
      expect(plan.rows.map((r) => r.itemKind)).toEqual(['Competency']);
      const own = (await run(await login(t, f.employee), 'PERFORMANCE_REVIEW_RESULTS', {}))
        .body as ReportPage;
      expect(own.rows.every((r) => r.employeeCode === f.employee.employeeCode)).toBe(true);
    });

    it('pages the JSON grid', async () => {
      const res = await run(hr, 'EMPLOYEE_BASIC', { params: {}, pageSize: 1 });
      expect(res.body).toMatchObject({ page: 1, pageSize: 1, hasMore: true });
      expect(res.body.rows).toHaveLength(1);
    });
  });

  describe('scope', () => {
    it('limits managers to themselves and their reports', async () => {
      const manager = await login(t, f.managerB);
      const page = (await run(manager, 'EMPLOYEE_BASIC', { params: {} })).body as ReportPage;
      expect(page.rows.map((r) => r.employeeCode).sort()).toEqual(
        [f.managerB.employeeCode, f.employee.employeeCode, f.employee2.employeeCode].sort(),
      );
      const since = await lastAuditId(t.db);
      const res = await run(manager, 'EMPLOYEE_BASIC', { params: { employeeIds: [f.unrelated.employeeId] } });
      expect(res.status).toBe(403);
      const denied = await auditSince(t.db, since, { requestId: res.headers['x-request-id'] as string });
      expect(denied.some((a) => a.outcome === 'DENIED')).toBe(true);
      expect((await auditSince(t.db, since, { action: 'EXPORT.REPORT' })).length).toBe(0);
    });

    it('limits HR to their companies and refuses reports outside the role', async () => {
      expect(
        (await run(hr, 'EMPLOYEE_BASIC', { params: { employeeIds: [f.otherCompany.employeeId] } })).status,
      ).toBe(403);
      const all = (await run(hr, 'EMPLOYEE_BASIC', { params: {}, pageSize: 500 })).body as ReportPage;
      expect(all.rows.some((r) => r.employeeCode === f.otherCompany.employeeCode)).toBe(false);
      expect((await run(hr, 'AUDIT_TRAIL_EXTRACT', {})).status).toBe(403);
      const employee = await login(t, f.employee);
      expect((await run(employee, 'EMPLOYEE_BASIC', {})).status).toBe(403);
      const sysAdmin = await login(t, f.sysAdmin);
      expect((await run(sysAdmin, 'EMPLOYEE_PAY_PERIOD_BASIC', {})).status).toBe(403);
      expect((await run(sysAdmin, 'FAILED_LOGINS', { params: { from: todayBusinessDate() } })).status).toBe(
        200,
      );
    });

    it('answers 404 for an unknown report and 422 on params', async () => {
      expect((await run(hr, 'NO_SUCH_REPORT', {})).status).toBe(404);
      const bad = await run(hr, 'LEAVE_DETAIL', {
        params: { from: '2026-02-01', to: '2026-01-01', extra: 1 },
      });
      expect(bad.status).toBe(422);
      expect(bad.body.errors.map((e: { path: string }) => e.path)).toEqual(
        expect.arrayContaining(['params', 'params.to']),
      );
    });
  });

  describe('streaming', () => {
    it(`streams ${BULK_LINES} rows in chunks without a content length`, async () => {
      const params = { employeeIds: [bulkEmployeeId] };
      const res = await runFile(hr, 'CLAIM_LINE', { params, format: 'csv' });
      expect(res.status).toBe(200);
      expect(res.headers['transfer-encoding']).toBe('chunked');
      expect(res.headers['content-length']).toBeUndefined();
      const body = res.body as Binary;
      expect(body.chunks).toBeGreaterThan(1);
      const lines = body.bytes
        .toString('utf8')
        .split('\r\n')
        .filter((l) => l !== '');
      expect(lines).toHaveLength(BULK_LINES + 1);
      expect(lines[1]).toContain('"Line');
      const xlsx = await runFile(hr, 'CLAIM_LINE', { params, format: 'xlsx' });
      expect(xlsx.headers['transfer-encoding']).toBe('chunked');
      expect((xlsx.body as Binary).bytes.subarray(0, 2).toString()).toBe('PK');
      const pdf = await runFile(hr, 'CLAIM_LINE', { params, format: 'pdf' });
      expect((pdf.body as Binary).bytes.subarray(0, 4).toString()).toBe('%PDF');
    }, 120_000);
  });
});
