import { describe, expect, it } from 'vitest';
import {
  birthdayDayMonth,
  birthdayFallsBetween,
  birthdayInYear,
  birthdayLabel,
  canRunReport,
  DASHBOARD_WIDGETS,
  daysUntilBirthday,
  isBirthdayWithin,
  maskedNumber,
  nextBirthday,
  payRunLabel,
  PayslipImportRequestSchema,
  PayslipImportRowSchema,
  payslipRowsFromCsv,
  payslipTotals,
  REPORT_CATALOGUE,
  REPORT_CODES,
  REPORT_PARAM_SCHEMAS,
  RunReportRequestSchema,
  TaxCertificateImportRowSchema,
  taxCertificateRowsFromCsv,
  taxYearLabel,
  taxYearOf,
  taxYearRange,
  UpdateDashboardLayoutRequestSchema,
} from '../src';

describe('pay runs and tax years', () => {
  it('labels pay runs as on the cards', () => {
    expect(payRunLabel('MAIN')).toBe('Main Payrun');
    expect(payRunLabel('SECOND')).toBe('2nd Payrun');
    expect(payRunLabel('BONUS')).toBe('BONUS');
  });

  it('uses the March to February tax year', () => {
    expect(taxYearOf('2026-02-28')).toBe(2026);
    expect(taxYearOf('2026-03-01')).toBe(2027);
    expect(taxYearRange(2026)).toEqual({ from: '2025-03-01', to: '2026-02-28' });
    expect(taxYearRange(2028)).toEqual({ from: '2027-03-01', to: '2028-02-29' });
    expect(taxYearLabel(2026)).toBe('Mar 2025 – Feb 2026');
  });

  it('masks numbers', () => {
    expect(maskedNumber('1234')).toBe('••••1234');
    expect(maskedNumber(null)).toBeNull();
  });
});

describe('payslip totals', () => {
  it('nets earnings and deductions and ignores the other categories', () => {
    const totals = payslipTotals([
      { category: 'EARNING', amount: '20000.00', ytdAmount: '140000.00' },
      { category: 'EARNING', amount: '-500.10', ytdAmount: null },
      { category: 'DEDUCTION', amount: '4400.00', ytdAmount: '30800.00' },
      { category: 'COMPANY_CONTRIBUTION', amount: '1800.00' },
      { category: 'FRINGE_BENEFIT', amount: '300.00' },
      { category: 'INFO', amount: '173.33' },
    ]);
    expect(totals).toEqual({
      grossPay: '19499.90',
      totalDeductions: '4400.00',
      netPay: '15099.90',
      companyContributions: '1800.00',
      fringeBenefits: '300.00',
      ytdGrossPay: '140000.00',
      ytdDeductions: '30800.00',
      ytdNetPay: '109200.00',
    });
  });
});

describe('payslip import schema', () => {
  const row = {
    employeeCode: 'E000077',
    periodEndDate: '2026-09-30',
    lines: [{ category: 'EARNING', code: 'BASIC', description: 'Basic Salary', amount: '1000.00' }],
  };

  it('defaults the pay run and run type', () => {
    expect(PayslipImportRowSchema.parse(row)).toMatchObject({ payRun: 'MAIN', runType: 'Normal' });
  });

  it('rejects bad amounts, categories, dates and empty payslips', () => {
    const bad = PayslipImportRowSchema.safeParse({
      ...row,
      periodEndDate: '2026-02-30',
      payRun: 'THIRD',
      lines: [{ category: 'BONUS', code: '', description: 'x', amount: '1.234' }],
    });
    expect(bad.success).toBe(false);
    const paths = bad.success ? [] : bad.error.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(
      expect.arrayContaining([
        'periodEndDate',
        'payRun',
        'lines.0.category',
        'lines.0.code',
        'lines.0.amount',
      ]),
    );
    expect(PayslipImportRowSchema.safeParse({ ...row, lines: [] }).success).toBe(false);
  });

  it('needs a dry run token to commit and content for the format', () => {
    expect(PayslipImportRequestSchema.safeParse({ mode: 'COMMIT', format: 'csv', csv: 'x' }).success).toBe(
      false,
    );
    expect(PayslipImportRequestSchema.safeParse({ mode: 'DRY_RUN', format: 'json', rows: [] }).success).toBe(
      false,
    );
    expect(PayslipImportRequestSchema.safeParse({ mode: 'DRY_RUN', format: 'csv' }).success).toBe(false);
    expect(PayslipImportRequestSchema.parse({ mode: 'DRY_RUN', format: 'json', rows: [row] }).replace).toBe(
      false,
    );
  });

  it('groups CSV lines into payslips', () => {
    const csv = [
      [
        'employeeCode',
        'periodEndDate',
        'payRun',
        'runType',
        'netPay',
        'category',
        'code',
        'description',
        'quantity',
        'rate',
        'amount',
        'ytdAmount',
      ],
      ['E1', '2026-09-30', '', 'Normal', '', 'earning', 'BASIC', 'Basic', '', '', '1000.00', '9000.00'],
      ['E1', '2026-09-30', 'main', '', '800.00', 'DEDUCTION', 'PAYE', 'Tax', '', '', '200.00', ''],
      ['E2', '2026-09-30', 'SECOND', '', '', 'EARNING', 'OT', 'Overtime', '2', '150', '300.00', ''],
    ];
    const mapped = payslipRowsFromCsv(csv);
    expect(mapped.headerErrors).toEqual([]);
    expect(mapped.rows).toHaveLength(2);
    expect(mapped.rows[0]?.sourceLines).toEqual([1, 2]);
    const first = PayslipImportRowSchema.parse(mapped.rows[0]?.value);
    expect(first).toMatchObject({ employeeCode: 'E1', payRun: 'MAIN', runType: 'Normal', netPay: '800.00' });
    expect(first.lines.map((l) => [l.category, l.amount, l.ytdAmount ?? null])).toEqual([
      ['EARNING', '1000.00', '9000.00'],
      ['DEDUCTION', '200.00', null],
    ]);
    expect(PayslipImportRowSchema.parse(mapped.rows[1]?.value).lines[0]).toMatchObject({
      quantity: '2',
      rate: '150',
    });
  });

  it('reports header problems', () => {
    expect(payslipRowsFromCsv([]).headerErrors).toEqual(['The file is empty']);
    expect(payslipRowsFromCsv([['employeeCode', 'colour']]).headerErrors).toEqual([
      'The header row is missing: periodEndDate, category, code, description, amount',
      'Unknown columns: colour',
    ]);
  });
});

describe('tax certificate import schema', () => {
  it('needs an uploaded PDF or figures', () => {
    expect(TaxCertificateImportRowSchema.safeParse({ employeeCode: 'E1', taxYear: 2026 }).success).toBe(
      false,
    );
    expect(
      TaxCertificateImportRowSchema.parse({
        employeeCode: 'E1',
        taxYear: 2026,
        figures: [{ code: '3601', description: 'Gross', amount: '100.00' }],
      }).certificateType,
    ).toBe('PAYE5');
  });

  it('groups CSV lines by employee, year and type', () => {
    const mapped = taxCertificateRowsFromCsv([
      ['employeeCode', 'taxYear', 'certificateType', 'attachmentId', 'code', 'description', 'amount'],
      ['E1', '2026', '', '', '3601', 'Gross', '100.00'],
      ['E1', '2026', 'PAYE5', '', '4102', 'PAYE', '22.00'],
      ['E2', '2026', '', '6f1c1c5e-8a8e-4f3c-9b55-111111111111', '', '', ''],
      ['E3', 'abc', '', '', '', '', ''],
    ]);
    expect(mapped.rows).toHaveLength(3);
    expect(mapped.rows[0]?.value).toMatchObject({ taxYear: 2026, certificateType: 'PAYE5' });
    expect((mapped.rows[0]?.value.figures as unknown[]).length).toBe(2);
    expect(TaxCertificateImportRowSchema.parse(mapped.rows[1]?.value).attachmentId).toBeDefined();
    expect(TaxCertificateImportRowSchema.safeParse(mapped.rows[2]?.value).success).toBe(false);
    expect(taxCertificateRowsFromCsv([['taxYear']]).headerErrors[0]).toContain('employeeCode');
  });
});

describe('birthdays (day and month only)', () => {
  it('shows the day and month, never the year', () => {
    expect(birthdayLabel('1990-11-05')).toBe('05 Nov');
    expect(birthdayDayMonth('1990-11-05')).toEqual({ day: 5, month: 11 });
  });

  it('finds the next birthday, wrapping into next year', () => {
    expect(nextBirthday('1990-11-05', '2026-10-20')).toBe('2026-11-05');
    expect(nextBirthday('1990-01-10', '2026-12-20')).toBe('2027-01-10');
    expect(nextBirthday('1990-10-20', '2026-10-20')).toBe('2026-10-20');
    expect(daysUntilBirthday('1990-01-10', '2026-12-20')).toBe(21);
  });

  it('handles 29 February', () => {
    expect(birthdayInYear('2000-02-29', 2027)).toBe('2027-02-28');
    expect(birthdayInYear('2000-02-29', 2028)).toBe('2028-02-29');
    expect(nextBirthday('2000-02-29', '2027-02-01')).toBe('2027-02-28');
    expect(isBirthdayWithin('2000-02-29', '2027-02-01', 30)).toBe(true);
  });

  it('counts today through the next 30 days', () => {
    expect(isBirthdayWithin('1990-10-20', '2026-10-20', 30)).toBe(true);
    expect(isBirthdayWithin('1990-11-19', '2026-10-20', 30)).toBe(true);
    expect(isBirthdayWithin('1990-11-20', '2026-10-20', 30)).toBe(false);
    expect(isBirthdayWithin('1990-01-05', '2026-12-20', 30)).toBe(true);
  });

  it('matches a birthday against a range of any years', () => {
    expect(birthdayFallsBetween('1990-01-05', '2026-12-20', '2027-01-10')).toBe(true);
    expect(birthdayFallsBetween('1990-06-05', '2026-12-20', '2027-01-10')).toBe(false);
    expect(birthdayFallsBetween('1990-06-05', '2027-01-10', '2026-12-20')).toBe(false);
  });
});

describe('dashboard layout contract', () => {
  const all = DASHBOARD_WIDGETS.map((id) => ({ id, visible: true }));

  it('accepts every widget once in any order', () => {
    expect(UpdateDashboardLayoutRequestSchema.safeParse({ widgets: [...all].reverse() }).success).toBe(true);
  });

  it('rejects unknown, repeated and missing widgets', () => {
    expect(
      UpdateDashboardLayoutRequestSchema.safeParse({ widgets: [...all, { id: 'WEATHER', visible: true }] })
        .success,
    ).toBe(false);
    expect(UpdateDashboardLayoutRequestSchema.safeParse({ widgets: [...all, all[0]] }).success).toBe(false);
    expect(UpdateDashboardLayoutRequestSchema.safeParse({ widgets: all.slice(1) }).success).toBe(false);
  });
});

describe('report contracts', () => {
  it('has catalogue metadata and a parameter schema for every report', () => {
    expect(REPORT_CODES).toHaveLength(28);
    for (const code of REPORT_CODES) {
      const meta = REPORT_CATALOGUE[code];
      expect(meta.code).toBe(code);
      expect(meta.columns.length).toBeGreaterThan(0);
      expect(new Set(meta.columns.map((c) => c.key)).size).toBe(meta.columns.length);
      expect(REPORT_PARAM_SCHEMAS[code].safeParse({}).success).toBe(true);
    }
  });

  it('validates parameters strictly', () => {
    const leave = REPORT_PARAM_SCHEMAS.LEAVE_DETAIL;
    expect(leave.parse({ from: '2026-01-01', statuses: ['PROCESSED'] }).includeTerminated).toBe(false);
    expect(leave.safeParse({ from: '2026-02-01', to: '2026-01-01' }).success).toBe(false);
    expect(leave.safeParse({ unknown: 1 }).success).toBe(false);
    expect(leave.safeParse({ statuses: ['DONE'] }).success).toBe(false);
    expect(
      REPORT_PARAM_SCHEMAS.AUDIT_TRAIL_EXTRACT.safeParse({ categories: ['AUTH'], action: 'AUTH.' }).success,
    ).toBe(true);
    expect(REPORT_PARAM_SCHEMAS.AUDIT_TRAIL_EXTRACT.safeParse({ includeTerminated: true }).success).toBe(
      false,
    );
  });

  it('limits reports to their roles', () => {
    expect(canRunReport(REPORT_CATALOGUE.AUDIT_TRAIL_EXTRACT, ['EMPLOYEE', 'SYSTEM_ADMIN'])).toBe(true);
    expect(canRunReport(REPORT_CATALOGUE.AUDIT_TRAIL_EXTRACT, ['EMPLOYEE', 'HR_ADMIN'])).toBe(false);
    expect(canRunReport(REPORT_CATALOGUE.EMPLOYEE_PAY_PERIOD_BASIC, ['EMPLOYEE', 'MANAGER'])).toBe(false);
    expect(canRunReport(REPORT_CATALOGUE.LEAVE_DETAIL, ['EMPLOYEE'])).toBe(true);
  });

  it('defaults the run request to a JSON page', () => {
    expect(RunReportRequestSchema.parse({})).toEqual({ params: {}, format: 'json', page: 1, pageSize: 100 });
    expect(RunReportRequestSchema.safeParse({ format: 'docx' }).success).toBe(false);
  });
});
