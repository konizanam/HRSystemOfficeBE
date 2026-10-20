import {
  DASHBOARD_WIDGETS,
  isBirthdayWithin,
  nextBirthday,
  payslipTotals,
  REPORT_CATALOGUE,
  REPORT_CODES,
  type ReportRow,
} from '@peoplehub/shared';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/common/errors/domain-errors';
import { DashboardService } from '../../src/modules/dashboard/dashboard.service';
import { confirmTokenFor, rawImportRows, zodMessages } from '../../src/modules/payslips/payroll-import';
import { ReportRegistry } from '../../src/modules/reports/report-registry';
import { csvCell, firstRows, pageOfRows } from '../../src/modules/reports/report-writers';
import {
  displayCell,
  formatMoney,
  payslipDocument,
  reportDocument,
  taxCertificateDocument,
} from '../../src/pdf/documents';
import { PdfService, sha256Hex } from '../../src/pdf/pdf.service';
import { PayslipImportRowSchema } from '@peoplehub/shared';
import { payslipRowsFromCsv } from '@peoplehub/shared';

function detailOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof ValidationError ? err.detail : String(err);
  }
  return undefined;
}

const CSV = [
  'employeeCode,periodEndDate,payRun,category,code,description,amount,ytdAmount',
  'E1,2026-09-30,MAIN,EARNING,BASIC,Basic Salary,20000.00,140000.00',
  'E1,2026-09-30,MAIN,DEDUCTION,PAYE,"PAYE, monthly",4400.00,',
  'E2,2026-09-30,SECOND,EARNING,OT,Overtime,300.00,',
].join('\r\n');

describe('payroll import mapping', () => {
  it('maps CSV lines to payslip rows with their source lines', () => {
    const rows = rawImportRows({ format: 'csv', csv: CSV, replace: false }, payslipRowsFromCsv, 10);
    expect(rows.map((r) => [r.row, r.sourceLines])).toEqual([
      [1, [1, 2]],
      [2, [3]],
    ]);
    const first = PayslipImportRowSchema.parse(rows[0]?.value);
    expect(first.lines[1]).toMatchObject({ description: 'PAYE, monthly', amount: '4400.00' });
    expect(payslipTotals(first.lines).netPay).toBe('15600.00');
  });

  it('takes JSON rows as sent and enforces the row limit', () => {
    const rows = rawImportRows(
      { format: 'json', rows: [{ a: 1 }, { b: 2 }], replace: false },
      payslipRowsFromCsv,
      10,
    );
    expect(rows.map((r) => [r.row, r.sourceLines.length])).toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(
      detailOf(() =>
        rawImportRows({ format: 'json', rows: [{}, {}], replace: false }, payslipRowsFromCsv, 1),
      ),
    ).toMatch(/at most 1 rows/);
    expect(
      detailOf(() => rawImportRows({ format: 'csv', csv: 'nope', replace: false }, payslipRowsFromCsv, 10)),
    ).toMatch(/missing/);
    expect(
      detailOf(() =>
        rawImportRows({ format: 'csv', csv: CSV.split('\r\n')[0], replace: false }, payslipRowsFromCsv, 10),
      ),
    ).toMatch(/no data rows/);
  });

  it('binds the confirm token to the content and the replace choice', () => {
    const base = { format: 'csv' as const, csv: CSV, replace: false };
    expect(confirmTokenFor('PAYSLIP', base)).toBe(confirmTokenFor('PAYSLIP', { ...base }));
    expect(confirmTokenFor('PAYSLIP', base)).not.toBe(confirmTokenFor('PAYSLIP', { ...base, replace: true }));
    expect(confirmTokenFor('PAYSLIP', base)).not.toBe(confirmTokenFor('TAX_CERTIFICATE', base));
    expect(confirmTokenFor('PAYSLIP', base)).not.toBe(
      confirmTokenFor('PAYSLIP', { ...base, csv: `${CSV}\r\n` }),
    );
  });

  it('turns schema issues into row messages', () => {
    const parsed = PayslipImportRowSchema.safeParse({ employeeCode: 'E1', periodEndDate: 'x', lines: [] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(zodMessages(parsed.error)).toEqual(
        expect.arrayContaining([
          'periodEndDate: Expected a date in YYYY-MM-DD format',
          'lines: A payslip needs at least one line',
        ]),
      );
    }
  });
});

describe('birthday window (day and month only)', () => {
  it('wraps the year end and keeps 29 February on 28 February in other years', () => {
    expect(isBirthdayWithin('1985-01-03', '2026-12-15', 30)).toBe(true);
    expect(nextBirthday('1985-01-03', '2026-12-15')).toBe('2027-01-03');
    expect(nextBirthday('1996-02-29', '2026-02-10')).toBe('2026-02-28');
    expect(isBirthdayWithin('1996-02-29', '2026-03-01', 30)).toBe(false);
  });
});

describe('dashboard layout normalisation', () => {
  it('drops unknown widgets and appends new ones', () => {
    const layout = DashboardService.normalise([
      { id: 'UPCOMING_BIRTHDAYS', visible: false },
      { id: 'GONE', visible: true },
      { id: 'UPCOMING_BIRTHDAYS', visible: true },
    ]);
    expect(layout[0]).toEqual({ id: 'UPCOMING_BIRTHDAYS', visible: false });
    expect(layout.map((w) => w.id).sort()).toEqual([...DASHBOARD_WIDGETS].sort());
    expect(DashboardService.normalise('garbage')).toHaveLength(DASHBOARD_WIDGETS.length);
  });
});

describe('report registry and writers', () => {
  it('registers one definition per catalogue code with its schema', () => {
    const registry = new ReportRegistry();
    expect(registry.list().map((r) => r.code)).toEqual(REPORT_CODES);
    for (const r of registry.list()) {
      expect(r.columns).toBe(REPORT_CATALOGUE[r.code].columns);
      expect(r.params.safeParse({ includeTerminated: 'yes' }).success).toBe(false);
    }
    expect(registry.get('NOPE')).toBeUndefined();
    expect(() => registry.register(registry.list()[0] as never)).toThrow(/twice/);
  });

  it('escapes CSV cells and neutralises formulas in text', () => {
    const text = { key: 'x', label: 'X', type: 'string' as const, payData: false };
    const num = { ...text, type: 'decimal' as const };
    expect(csvCell(text, { x: 'a,"b"' })).toBe('"a,""b"""');
    expect(csvCell(text, { x: '=SUM(A1)' })).toBe("'=SUM(A1)");
    expect(csvCell(num, { x: '-1.5000' })).toBe('-1.5000');
    expect(csvCell(text, { x: null })).toBe('');
  });

  it('formats display cells', () => {
    const col = (type: 'date' | 'datetime' | 'boolean' | 'money') => ({
      key: 'k',
      label: 'K',
      type,
      payData: false,
    });
    expect(displayCell(col('date'), '2026-09-30')).toBe('30-Sep-2026');
    expect(displayCell(col('boolean'), true)).toBe('Yes');
    expect(displayCell(col('money'), '1234567.5')).toBe('1,234,567.50');
    expect(displayCell(col('datetime'), '2026-09-30T10:00:00.000Z')).toBe('30 Sep 2026 12:00');
    expect(formatMoney('-1000')).toBe('-1,000.00');
    expect(formatMoney(null)).toBe('');
  });

  it('pages and truncates without reading everything', async () => {
    let read = 0;
    async function* rows(): AsyncGenerator<ReportRow> {
      for (let i = 0; i < 1000; i++) {
        read += 1;
        yield { i };
      }
    }
    expect(await pageOfRows(rows(), 2, 10)).toMatchObject({
      hasMore: true,
      rows: [{ i: 10 }, ...Array(9).fill(expect.anything())],
    });
    expect(read).toBe(21);
    read = 0;
    const first = await firstRows(rows(), 5);
    expect(first.truncated).toBe(true);
    expect(first.rows).toHaveLength(5);
    expect(read).toBe(6);
    expect((await pageOfRows(rows(), 101, 10)).hasMore).toBe(false);
  });
});

describe('PDF generation (pdfmake, embedded fonts)', () => {
  const pdf = new PdfService();
  const lines = [
    {
      category: 'EARNING',
      code: 'BASIC',
      description: 'Basic Salary',
      quantity: null,
      rate: null,
      amount: '20000.00',
      ytdAmount: '140000.00',
    },
    {
      category: 'DEDUCTION',
      code: 'PAYE',
      description: 'PAYE',
      quantity: null,
      rate: null,
      amount: '4400.00',
      ytdAmount: '30800.00',
    },
    {
      category: 'INFO',
      code: 'HOURS',
      description: 'Normal Hours',
      quantity: null,
      rate: null,
      amount: '173.33',
      ytdAmount: null,
    },
  ];

  it('renders a payslip PDF and its sha256', async () => {
    const bytes = await pdf.render(
      payslipDocument({
        company: { name: 'Demo Company (Pty) Ltd', logo: null },
        employee: {
          name: 'Mr Test Person',
          employeeCode: 'E000077',
          idNumberMasked: '••••1234',
          jobTitle: 'Clerk',
          department: 'Operations',
          dateEngaged: '2020-01-01',
          companyRule: 'Staff',
        },
        period: {
          description: 'September 2026',
          startDate: '2026-09-01',
          endDate: '2026-09-30',
          payDate: '2026-09-30',
        },
        payRunLabel: 'Main Payrun',
        runType: 'Normal',
        currency: 'NAD',
        bankMasked: 'Bank Windhoek ••••9876',
        lines,
        totals: payslipTotals(lines),
        leave: [{ leaveType: 'Annual Leave', available: '3.8358', pending: '0.0000' }],
        generatedAt: new Date('2026-10-01T08:00:00Z'),
      }),
    );
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(sha256Hex(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('renders certificate and report PDFs, the report as a stream', async () => {
    const cert = await pdf.render(
      taxCertificateDocument({
        company: { name: 'Demo', logo: null },
        employee: { name: 'A B', employeeCode: 'E1', idNumberMasked: null, taxNumberMasked: '••••5555' },
        taxYear: 2026,
        taxYearLabel: 'Mar 2025 – Feb 2026',
        periodFrom: '2025-03-01',
        periodTo: '2026-02-28',
        certificateType: 'PAYE5',
        currency: 'NAD',
        figures: [{ code: '3601', description: 'Gross remuneration', amount: '300000.00' }],
        generatedAt: new Date(),
      }),
    );
    expect(cert.subarray(0, 4).toString()).toBe('%PDF');
    const columns = REPORT_CATALOGUE.LEAVE_BASIC.columns;
    const stream = pdf.stream(
      reportDocument({
        title: 'Leave Basic',
        group: 'Leave',
        columns,
        parameters: '',
        generatedAt: new Date(),
        generatedBy: 'tester',
        rows: [],
        truncatedAt: 1000,
      }),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).subarray(0, 4).toString()).toBe('%PDF');
  });
});
