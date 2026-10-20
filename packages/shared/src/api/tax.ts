import { z } from 'zod';
import { DEFAULT_TAX_CERTIFICATE_TYPE } from '../payroll';
import { BusinessDateSchema, DecimalStringSchema, TimestampSchema } from './common';
import {
  ImportRowActionSchema,
  MoneyStringSchema,
  PayrollImportFormatSchema,
  PayrollImportModeSchema,
  payrollImportRequestSchema,
} from './payslips';

// Contracts for section 5.6 / 12.6: `GET /tax-certificates`, `GET /tax-certificates/:id/pdf`
// (inline, or `?download=1`) and `POST /admin/tax-certificates/import`.

/** Empty state wording (section 5.6). */
export const NO_TAX_CERTIFICATES_MESSAGE = 'No Tax Certificates to view';

export const TAX_CERTIFICATE_SOURCES = ['UPLOADED', 'GENERATED'] as const;
export const TaxCertificateSourceSchema = z.enum(TAX_CERTIFICATE_SOURCES);
export type TaxCertificateSource = z.infer<typeof TaxCertificateSourceSchema>;

/** GET /tax-certificates?employeeId= (employeeId: a payroll admin reading another employee). */
export const TaxCertificatesQuerySchema = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
});
export type TaxCertificatesQuery = z.infer<typeof TaxCertificatesQuerySchema>;

export const TaxCertificateSchema = z.object({
  id: z.number().int(),
  employeeId: z.number().int(),
  employeeCode: z.string(),
  employeeName: z.string(),
  taxYear: z.number().int(),
  /** "Mar 2025 – Feb 2026". */
  taxYearLabel: z.string(),
  periodFrom: BusinessDateSchema,
  periodTo: BusinessDateSchema,
  certificateType: z.string(),
  source: TaxCertificateSourceSchema,
  issuedAt: TimestampSchema,
  pdfSha256: z.string(),
  /** Inline PDF for the preview (audited `DATA_VIEW.TAX_CERTIFICATE`). */
  pdfUrl: z.string(),
  /** Download (audited `EXPORT.TAX_CERTIFICATE_PDF`). */
  downloadUrl: z.string(),
});
export type TaxCertificate = z.infer<typeof TaxCertificateSchema>;

export const TaxYearGroupSchema = z.object({
  taxYear: z.number().int(),
  label: z.string(),
  items: z.array(TaxCertificateSchema),
});
export type TaxYearGroup = z.infer<typeof TaxYearGroupSchema>;

/** Newest tax year first; an empty `years` list shows {@link NO_TAX_CERTIFICATES_MESSAGE}. */
export const TaxCertificatesResponseSchema = z.object({
  employeeId: z.number().int(),
  total: z.number().int(),
  years: z.array(TaxYearGroupSchema),
});
export type TaxCertificatesResponse = z.infer<typeof TaxCertificatesResponseSchema>;

// ───────────── Import (PAYROLL_ADMIN) ─────────────

export const TaxCertificateFigureSchema = z.object({
  code: z.string().trim().min(1, 'code is required').max(30),
  description: z.string().trim().min(1, 'description is required').max(100),
  amount: MoneyStringSchema,
});
export type TaxCertificateFigure = z.infer<typeof TaxCertificateFigureSchema>;

/**
 * One certificate of the import. Either `attachmentId` names a PDF the payroll admin uploaded
 * through `POST /attachments` (the payroll system's certificate, kept as-is), or the server
 * generates the PDF from `figures`. With both, the uploaded PDF is used and the figures are kept.
 */
export const TaxCertificateImportRowSchema = z
  .object({
    employeeCode: z.string().trim().min(1, 'employeeCode is required').max(30),
    taxYear: z.number().int().min(2000).max(2100),
    certificateType: z
      .string()
      .trim()
      .regex(/^[A-Z0-9_]{2,20}$/, 'Use 2-20 capitals, digits or _')
      .default(DEFAULT_TAX_CERTIFICATE_TYPE),
    attachmentId: z.string().uuid().optional(),
    figures: z.array(TaxCertificateFigureSchema).max(60).default([]),
  })
  .superRefine((value, ctx) => {
    if (!value.attachmentId && value.figures.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['figures'],
        message: 'Upload the certificate PDF (attachmentId) or give its figures',
      });
    }
  });
export type TaxCertificateImportRow = z.infer<typeof TaxCertificateImportRowSchema>;
export type TaxCertificateImportRowInput = z.input<typeof TaxCertificateImportRowSchema>;

/** POST /admin/tax-certificates/import: dry run first, then commit with the dry run's token. */
export const TaxCertificateImportRequestSchema = payrollImportRequestSchema();
export type TaxCertificateImportRequest = z.infer<typeof TaxCertificateImportRequestSchema>;

export const TaxCertificateImportRowResultSchema = z.object({
  row: z.number().int(),
  sourceLines: z.array(z.number().int()),
  employeeCode: z.string(),
  taxYear: z.union([z.number().int(), z.string()]),
  certificateType: z.string(),
  ok: z.boolean(),
  errors: z.array(z.string()),
  action: ImportRowActionSchema.nullable(),
  source: TaxCertificateSourceSchema.nullable(),
  figureCount: z.number().int(),
  certificateId: z.number().int().nullable(),
});
export type TaxCertificateImportRowResult = z.infer<typeof TaxCertificateImportRowResultSchema>;

export const TaxCertificateImportResponseSchema = z.object({
  mode: PayrollImportModeSchema,
  format: PayrollImportFormatSchema,
  replace: z.boolean(),
  confirmToken: z.string(),
  totalRows: z.number().int(),
  validRows: z.number().int(),
  invalidRows: z.number().int(),
  committed: z.boolean(),
  rows: z.array(TaxCertificateImportRowResultSchema),
});
export type TaxCertificateImportResponse = z.infer<typeof TaxCertificateImportResponseSchema>;

/** Figures printed on a generated certificate, in order. */
export const TaxCertificateFiguresSchema = z.array(
  z.object({ code: z.string(), description: z.string(), amount: DecimalStringSchema }),
);
