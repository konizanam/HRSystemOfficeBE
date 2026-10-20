import { type BusinessDate, endOfMonth } from './dates';
import { Decimal, dec, money2 } from './decimal';

// Payroll outputs (sections 5.5 and 5.6): pay run labels, the Namibian tax year, payslip totals and
// the CSV layouts of the payslip and tax certificate imports. The API and the web app share them,
// so an import preview and the server agree on every figure.

/** Pay runs of a period, as shown on the payslip cards (section 5.5). */
export const PAY_RUNS = ['MAIN', 'SECOND'] as const;
export type PayRun = (typeof PAY_RUNS)[number];
export const PAY_RUN_LABELS: Record<PayRun, string> = { MAIN: 'Main Payrun', SECOND: '2nd Payrun' };

/** The card label of a stored pay run code; an unknown code is shown as stored. */
export function payRunLabel(code: string): string {
  return (PAY_RUN_LABELS as Record<string, string>)[code] ?? code;
}

/** The Namibian tax year runs from 1 March to the end of February and is named by its last year. */
export const TAX_YEAR_START_MONTH = 3;

/** The tax year a business date falls in (`2026-02-28` → 2026, `2026-03-01` → 2027). */
export function taxYearOf(date: BusinessDate): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month >= TAX_YEAR_START_MONTH ? year + 1 : year;
}

/** First and last day of a tax year. */
export function taxYearRange(taxYear: number): { from: BusinessDate; to: BusinessDate } {
  return { from: `${taxYear - 1}-03-01`, to: endOfMonth(`${taxYear}-02-01`) };
}

/** "Mar 2025 – Feb 2026". */
export function taxYearLabel(taxYear: number): string {
  return `Mar ${taxYear - 1} – Feb ${taxYear}`;
}

/** Line categories as printed on the payslip, in section order. */
export const PAYSLIP_SECTION_TITLES = {
  EARNING: 'Earnings',
  DEDUCTION: 'Deductions',
  COMPANY_CONTRIBUTION: 'Company Contributions',
  FRINGE_BENEFIT: 'Fringe Benefits',
  INFO: 'Information',
} as const;

export interface PayslipTotalsInput {
  category: string;
  amount: string;
  ytdAmount?: string | null;
}

export interface PayslipTotals {
  grossPay: string;
  totalDeductions: string;
  netPay: string;
  companyContributions: string;
  fringeBenefits: string;
  ytdGrossPay: string;
  ytdDeductions: string;
  ytdNetPay: string;
}

/**
 * Server-side payslip totals: gross pay = the earnings, total deductions = the deductions,
 * net pay = gross − deductions. Company contributions, fringe benefits and information lines
 * never change net pay. YTD totals add the lines' year-to-date amounts the same way.
 */
export function payslipTotals(lines: readonly PayslipTotalsInput[]): PayslipTotals {
  const sum = (category: string, pick: (l: PayslipTotalsInput) => string | null | undefined) =>
    lines
      .filter((l) => l.category === category)
      .reduce((total, l) => total.plus(dec(pick(l) ?? '0')), new Decimal(0));
  const gross = sum('EARNING', (l) => l.amount);
  const deductions = sum('DEDUCTION', (l) => l.amount);
  const ytdGross = sum('EARNING', (l) => l.ytdAmount);
  const ytdDeductions = sum('DEDUCTION', (l) => l.ytdAmount);
  return {
    grossPay: money2(gross),
    totalDeductions: money2(deductions),
    netPay: money2(gross.minus(deductions)),
    companyContributions: money2(sum('COMPANY_CONTRIBUTION', (l) => l.amount)),
    fringeBenefits: money2(sum('FRINGE_BENEFIT', (l) => l.amount)),
    ytdGrossPay: money2(ytdGross),
    ytdDeductions: money2(ytdDeductions),
    ytdNetPay: money2(ytdGross.minus(ytdDeductions)),
  };
}

/** "••••1234" for a masked number (bank accounts, ID numbers). */
export function maskedNumber(last4: string | null | undefined): string | null {
  return last4 ? `••••${last4}` : null;
}

// ───────────── CSV import layouts ─────────────

/**
 * Payslip import CSV (long format): one CSV line per payslip line. Lines with the same
 * employeeCode, periodEndDate and payRun form one payslip; runType, currency and netPay are taken
 * from the first line of the payslip that has them.
 */
export const PAYSLIP_IMPORT_CSV_COLUMNS = [
  'employeeCode',
  'periodEndDate',
  'payRun',
  'runType',
  'currency',
  'netPay',
  'category',
  'code',
  'description',
  'quantity',
  'rate',
  'amount',
  'ytdAmount',
] as const;
export type PayslipImportCsvColumn = (typeof PAYSLIP_IMPORT_CSV_COLUMNS)[number];
export const PAYSLIP_IMPORT_REQUIRED_CSV_COLUMNS: readonly PayslipImportCsvColumn[] = [
  'employeeCode',
  'periodEndDate',
  'category',
  'code',
  'description',
  'amount',
];

/**
 * Tax certificate import CSV (long format): one CSV line per certificate figure. Lines with the
 * same employeeCode, taxYear and certificateType form one certificate. `attachmentId` (an uploaded
 * PDF) is taken from the first line that has it; without one the certificate PDF is generated
 * from the figures.
 */
export const TAX_CERTIFICATE_IMPORT_CSV_COLUMNS = [
  'employeeCode',
  'taxYear',
  'certificateType',
  'attachmentId',
  'code',
  'description',
  'amount',
] as const;
export type TaxCertificateImportCsvColumn = (typeof TAX_CERTIFICATE_IMPORT_CSV_COLUMNS)[number];
export const TAX_CERTIFICATE_IMPORT_REQUIRED_CSV_COLUMNS: readonly TaxCertificateImportCsvColumn[] = [
  'employeeCode',
  'taxYear',
];

export const DEFAULT_TAX_CERTIFICATE_TYPE = 'PAYE5';

/** One grouped import row built from CSV lines, before schema validation. */
export interface CsvImportGroup {
  /** 1-based data line numbers (the header is line 0) that make up the row. */
  sourceLines: number[];
  value: Record<string, unknown>;
}

export interface CsvImportMapping {
  /** Header problems; when present no rows are returned. */
  headerErrors: string[];
  rows: CsvImportGroup[];
}

function readTable<C extends string>(
  table: readonly (readonly string[])[],
  columns: readonly C[],
  required: readonly C[],
): { headerErrors: string[]; records: { line: number; get: (c: C) => string }[] } {
  const header = (table[0] ?? []).map((h) => h.trim());
  const missing = required.filter((c) => !header.includes(c));
  const unknown = header.filter((h) => h !== '' && !(columns as readonly string[]).includes(h));
  const headerErrors: string[] = [];
  if (table.length === 0) headerErrors.push('The file is empty');
  else {
    if (missing.length > 0) headerErrors.push(`The header row is missing: ${missing.join(', ')}`);
    if (unknown.length > 0) headerErrors.push(`Unknown columns: ${unknown.join(', ')}`);
  }
  const records = table.slice(1).map((raw, index) => ({
    line: index + 1,
    get: (c: C) => {
      const at = header.indexOf(c);
      return at >= 0 ? (raw[at] ?? '').trim() : '';
    },
  }));
  return { headerErrors, records };
}

/** Empty CSV cells are "not given". */
function optional(value: string): string | undefined {
  return value === '' ? undefined : value;
}

/** Groups payslip CSV lines into payslip rows (the JSON shape of `PayslipImportRow`). */
export function payslipRowsFromCsv(table: readonly (readonly string[])[]): CsvImportMapping {
  const { headerErrors, records } = readTable(
    table,
    PAYSLIP_IMPORT_CSV_COLUMNS,
    PAYSLIP_IMPORT_REQUIRED_CSV_COLUMNS,
  );
  if (headerErrors.length > 0) return { headerErrors, rows: [] };
  const groups = new Map<string, CsvImportGroup>();
  for (const r of records) {
    const payRun = r.get('payRun').toUpperCase() || 'MAIN';
    const key = `${r.get('employeeCode')}|${r.get('periodEndDate')}|${payRun}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        sourceLines: [],
        value: {
          employeeCode: r.get('employeeCode'),
          periodEndDate: r.get('periodEndDate'),
          payRun,
          lines: [] as Record<string, unknown>[],
        },
      };
      groups.set(key, group);
    }
    group.sourceLines.push(r.line);
    for (const field of ['runType', 'currency', 'netPay'] as const) {
      const v = optional(r.get(field));
      if (v !== undefined && group.value[field] === undefined) group.value[field] = v;
    }
    (group.value.lines as Record<string, unknown>[]).push({
      category: r.get('category').toUpperCase(),
      code: r.get('code'),
      description: r.get('description'),
      quantity: optional(r.get('quantity')),
      rate: optional(r.get('rate')),
      amount: r.get('amount'),
      ytdAmount: optional(r.get('ytdAmount')),
    });
  }
  return { headerErrors: [], rows: [...groups.values()] };
}

/** Groups tax certificate CSV lines into certificate rows (the JSON shape of the import row). */
export function taxCertificateRowsFromCsv(table: readonly (readonly string[])[]): CsvImportMapping {
  const { headerErrors, records } = readTable(
    table,
    TAX_CERTIFICATE_IMPORT_CSV_COLUMNS,
    TAX_CERTIFICATE_IMPORT_REQUIRED_CSV_COLUMNS,
  );
  if (headerErrors.length > 0) return { headerErrors, rows: [] };
  const groups = new Map<string, CsvImportGroup>();
  for (const r of records) {
    const certificateType = r.get('certificateType').toUpperCase() || DEFAULT_TAX_CERTIFICATE_TYPE;
    const taxYearText = r.get('taxYear');
    const key = `${r.get('employeeCode')}|${taxYearText}|${certificateType}`;
    let group = groups.get(key);
    if (!group) {
      const taxYear = /^\d{4}$/.test(taxYearText) ? Number(taxYearText) : taxYearText;
      group = {
        sourceLines: [],
        value: { employeeCode: r.get('employeeCode'), taxYear, certificateType, figures: [] },
      };
      groups.set(key, group);
    }
    group.sourceLines.push(r.line);
    const attachmentId = optional(r.get('attachmentId'));
    if (attachmentId !== undefined && group.value.attachmentId === undefined) {
      group.value.attachmentId = attachmentId;
    }
    const code = r.get('code');
    if (code !== '') {
      (group.value.figures as Record<string, unknown>[]).push({
        code,
        description: r.get('description'),
        amount: r.get('amount'),
      });
    }
  }
  return { headerErrors: [], rows: [...groups.values()] };
}
