import { z } from 'zod';
import { PayslipLineCategorySchema } from '../enums';
import { dec } from '../decimal';
import { PAY_RUNS } from '../payroll';
import { BooleanQuerySchema } from './calendar';
import { BusinessDateSchema, DecimalStringSchema, TimestampSchema } from './common';

// Contracts for section 5.5 / 12.6: `GET /payslips?page=`, `GET /payslips/:id`,
// `GET /payslips/:id/pdf` (inline, or `?download=1`) and `POST /admin/payslips/import`.

export const PayRunSchema = z.enum(PAY_RUNS);

/** Cards per "More" page (section 5.5: 4 at a time). */
export const PAYSLIP_PAGE_SIZE = 4;

/** GET /payslips?page=&pageSize=&employeeId= (employeeId: a payroll admin reading another employee). */
export const PayslipListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(PAYSLIP_PAGE_SIZE),
  employeeId: z.coerce.number().int().positive().optional(),
});
export type PayslipListQuery = z.infer<typeof PayslipListQuerySchema>;

/** One card of the left list (section 5.5). */
export const PayslipCardSchema = z.object({
  id: z.number().int(),
  employeeId: z.number().int(),
  employeeCode: z.string(),
  /** "{First} {Last}". */
  employeeName: z.string(),
  companyName: z.string(),
  payPeriodId: z.number().int(),
  payPeriodDescription: z.string(),
  periodEndDate: BusinessDateSchema,
  /** "30 Sep 2026". */
  periodEndLabel: z.string(),
  /** The company rule label, e.g. "Staff". */
  companyRule: z.string(),
  payRun: z.string(),
  /** "Main Payrun" / "2nd Payrun". */
  payRunLabel: z.string(),
  /** e.g. "Normal". */
  runType: z.string(),
  publishedAt: TimestampSchema,
});
export type PayslipCard = z.infer<typeof PayslipCardSchema>;

export const PayslipListResponseSchema = z.object({
  employeeId: z.number().int(),
  items: z.array(PayslipCardSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** Show the "More" button. */
  hasMore: z.boolean(),
});
export type PayslipListResponse = z.infer<typeof PayslipListResponseSchema>;

/** GET /payslips/:id: the metadata (audited `DATA_VIEW.PAYSLIP`). */
export const PayslipDetailSchema = PayslipCardSchema.extend({
  payPeriodStartDate: BusinessDateSchema,
  payDate: BusinessDateSchema.nullable(),
  currency: z.string(),
  grossPay: DecimalStringSchema,
  totalDeductions: DecimalStringSchema,
  netPay: DecimalStringSchema,
  /** sha256 of the stored PDF (hex). */
  pdfSha256: z.string().nullable(),
  /** Inline PDF for the iframe preview. */
  pdfUrl: z.string(),
  /** The same PDF as an attachment (audited `EXPORT.PAYSLIP_PDF`). */
  downloadUrl: z.string(),
});
export type PayslipDetail = z.infer<typeof PayslipDetailSchema>;

/** `GET /payslips/:id/pdf?download=1` (and the tax certificate PDF) sets `attachment`. */
export const PdfQuerySchema = z.object({ download: BooleanQuerySchema.default(false) });
export type PdfQuery = z.infer<typeof PdfQuerySchema>;

// ───────────── Import (PAYROLL_ADMIN) ─────────────

export const PAYROLL_IMPORT_MODES = ['DRY_RUN', 'COMMIT'] as const;
export const PayrollImportModeSchema = z.enum(PAYROLL_IMPORT_MODES);
export type PayrollImportMode = z.infer<typeof PayrollImportModeSchema>;

export const PAYROLL_IMPORT_FORMATS = ['csv', 'json'] as const;
export const PayrollImportFormatSchema = z.enum(PAYROLL_IMPORT_FORMATS);
export type PayrollImportFormat = z.infer<typeof PayrollImportFormatSchema>;

/** Most payslips (or certificates) in one import. */
export const PAYROLL_IMPORT_MAX_ROWS = 2000;

/** Money: a decimal string with at most 2 decimals (negative allowed for corrections). */
export const MoneyStringSchema = DecimalStringSchema.refine((v) => dec(v).decimalPlaces() <= 2, {
  message: 'Use at most 2 decimals',
});
const Decimal4Schema = DecimalStringSchema.refine((v) => dec(v).decimalPlaces() <= 4, {
  message: 'Use at most 4 decimals',
});

export const PayslipImportLineSchema = z.object({
  category: PayslipLineCategorySchema,
  code: z.string().trim().min(1, 'code is required').max(30),
  description: z.string().trim().min(1, 'description is required').max(100),
  quantity: Decimal4Schema.nullish(),
  rate: Decimal4Schema.nullish(),
  amount: MoneyStringSchema,
  /** Year to date (the "YTD totals" section adds these up per category). */
  ytdAmount: MoneyStringSchema.nullish(),
});
export type PayslipImportLine = z.infer<typeof PayslipImportLineSchema>;

/**
 * One payslip of the import (the JSON shape; the CSV layout `PAYSLIP_IMPORT_CSV_COLUMNS` maps to
 * it). The pay period is the employee's company-rule period that ends on `periodEndDate`. Gross
 * pay, deductions and net pay are computed by the server from the lines; `netPay`, when given, is
 * a control total that must match.
 */
export const PayslipImportRowSchema = z.object({
  employeeCode: z.string().trim().min(1, 'employeeCode is required').max(30),
  periodEndDate: BusinessDateSchema,
  payRun: PayRunSchema.default('MAIN'),
  runType: z.string().trim().min(1).max(40).default('Normal'),
  /** Defaults to the company's currency. */
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code')
    .optional(),
  netPay: MoneyStringSchema.optional(),
  lines: z.array(PayslipImportLineSchema).min(1, 'A payslip needs at least one line').max(200),
});
export type PayslipImportRow = z.infer<typeof PayslipImportRowSchema>;
export type PayslipImportRowInput = z.input<typeof PayslipImportRowSchema>;

/** Rows travel unparsed so that a dry run reports every row's problems instead of one 422. */
const RawRowsSchema = z.array(z.record(z.unknown())).max(PAYROLL_IMPORT_MAX_ROWS);

/** The request shape shared by the payslip and tax certificate imports. */
export function payrollImportRequestSchema() {
  return z
    .object({
      mode: PayrollImportModeSchema,
      /** The dry run's token; COMMIT applies exactly the content that was reviewed. */
      confirmToken: z.string().max(128).optional(),
      /** Supersede an existing current payslip/certificate for the same key (audited). */
      replace: z.boolean().default(false),
      format: PayrollImportFormatSchema,
      csv: z.string().max(10_000_000).optional(),
      rows: RawRowsSchema.optional(),
    })
    .superRefine((value, ctx) => {
      if (value.mode === 'COMMIT' && !value.confirmToken) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmToken'], message: 'Run a dry run first' });
      }
      if (value.format === 'csv' && !value.csv) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['csv'], message: 'The file is empty' });
      }
      if (value.format === 'json' && (!value.rows || value.rows.length === 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rows'], message: 'Add at least one row' });
      }
    });
}

/** POST /admin/payslips/import: dry run first, then commit with the dry run's token. */
export const PayslipImportRequestSchema = payrollImportRequestSchema();
export type PayslipImportRequest = z.infer<typeof PayslipImportRequestSchema>;

/** What a valid row does on commit. */
export const IMPORT_ROW_ACTIONS = ['CREATE', 'REPLACE'] as const;
export const ImportRowActionSchema = z.enum(IMPORT_ROW_ACTIONS);

export const PayslipImportRowResultSchema = z.object({
  /** 1-based payslip number in the import. */
  row: z.number().int(),
  /** CSV data lines (1-based) of the payslip; empty for JSON. */
  sourceLines: z.array(z.number().int()),
  employeeCode: z.string(),
  periodEndDate: z.string(),
  payRun: z.string(),
  ok: z.boolean(),
  errors: z.array(z.string()),
  action: ImportRowActionSchema.nullable(),
  lineCount: z.number().int(),
  grossPay: DecimalStringSchema.nullable(),
  netPay: DecimalStringSchema.nullable(),
  /** Set after a commit. */
  payslipId: z.number().int().nullable(),
});
export type PayslipImportRowResult = z.infer<typeof PayslipImportRowResultSchema>;

export const PayslipImportResponseSchema = z.object({
  mode: PayrollImportModeSchema,
  format: PayrollImportFormatSchema,
  replace: z.boolean(),
  confirmToken: z.string(),
  totalRows: z.number().int(),
  validRows: z.number().int(),
  invalidRows: z.number().int(),
  committed: z.boolean(),
  rows: z.array(PayslipImportRowResultSchema),
});
export type PayslipImportResponse = z.infer<typeof PayslipImportResponseSchema>;
