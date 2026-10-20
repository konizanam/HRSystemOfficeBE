import { Injectable } from '@nestjs/common';
import {
  dateFromBusiness,
  PAYROLL_IMPORT_MAX_ROWS,
  type TaxCertificateImportRequest,
  type TaxCertificateImportResponse,
  type TaxCertificateImportRow,
  type TaxCertificateImportRowResult,
  TaxCertificateImportRowSchema,
  taxCertificateRowsFromCsv,
  taxYearLabel,
  taxYearRange,
  UNOWNED_ATTACHMENT_OWNER,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import { ValidationError } from '../../common/errors/domain-errors';
import { taxCertificateDocument } from '../../pdf/documents';
import { PdfService } from '../../pdf/pdf.service';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { AttachmentService, type GeneratedFile } from '../attachments/attachment.service';
import { ScopeService } from '../auth/scope.service';
import { NotificationService } from '../notifications/notification.service';
import { type DocumentEmployee, PayrollDocumentsService } from './payroll-documents.service';
import {
  confirmTokenFor,
  invalidRowsError,
  type RawImportRow,
  rawImportRows,
  textOf,
  zodMessages,
} from './payroll-import';
import { TAX_CERTIFICATE_ENTITY } from './tax-certificate.service';

interface CheckedRow {
  raw: RawImportRow;
  result: TaxCertificateImportRowResult;
  valid?: {
    row: TaxCertificateImportRow;
    employee: DocumentEmployee;
    upload: { id: string; sha256: string } | null;
    existingId: number | null;
  };
}

/**
 * `POST /admin/tax-certificates/import` (section 5.6). Each certificate either brings the PDF the
 * payroll system produced (uploaded first through `POST /attachments`, then bound here) or has its
 * PDF generated from the imported figures (ASSUMPTION, see docs). Dry run, then commit with the
 * token; every certificate is audited and the employee is notified in-app.
 */
@Injectable()
export class TaxCertificateImportService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly pdf: PdfService,
    private readonly attachments: AttachmentService,
    private readonly documents: PayrollDocumentsService,
    private readonly notifications: NotificationService,
  ) {}

  async import(
    ctx: SecurityContext,
    input: TaxCertificateImportRequest,
  ): Promise<TaxCertificateImportResponse> {
    const confirmToken = confirmTokenFor('TAX_CERTIFICATE', input);
    const raw = rawImportRows(input, taxCertificateRowsFromCsv, PAYROLL_IMPORT_MAX_ROWS);
    const checked = await this.check(ctx, raw, input.replace, this.db.prisma);
    const summary = (committed: boolean, rows: CheckedRow[]): TaxCertificateImportResponse => ({
      mode: input.mode,
      format: input.format,
      replace: input.replace,
      confirmToken,
      totalRows: rows.length,
      validRows: rows.filter((r) => r.result.ok).length,
      invalidRows: rows.filter((r) => !r.result.ok).length,
      committed,
      rows: rows.map((r) => r.result),
    });
    if (input.mode === 'DRY_RUN') return summary(false, checked);
    if (input.confirmToken !== confirmToken) {
      throw ValidationError.field('confirmToken', 'Run a dry run of this exact import before committing it');
    }
    if (checked.some((r) => !r.result.ok)) throw invalidRowsError(checked.map((r) => r.result));

    const files: GeneratedFile[] = [];
    try {
      const logos = new Map<number, string | null>();
      const generated: (GeneratedFile | null)[] = [];
      for (const r of checked) {
        const file = r.valid?.upload ? null : await this.renderAndStore(r, logos);
        if (file) files.push(file);
        generated.push(file);
      }
      const committed = await this.db.tx(
        ctx,
        async (tx) => {
          const again = await this.check(ctx, raw, input.replace, tx);
          if (again.some((r) => !r.result.ok)) throw invalidRowsError(again.map((r) => r.result));
          for (const [i, r] of again.entries()) await this.commitRow(tx, ctx, r, generated[i] ?? null, input);
          return again;
        },
        { timeoutMs: 300_000, maxWaitMs: 60_000 },
      );
      return summary(true, committed);
    } catch (err) {
      await this.attachments.discardGenerated(files);
      throw err;
    }
  }

  private async check(
    ctx: SecurityContext,
    rows: RawImportRow[],
    replace: boolean,
    client: Tx,
  ): Promise<CheckedRow[]> {
    const seen = new Set<string>();
    const uploads = new Set<string>();
    const out: CheckedRow[] = [];
    for (const raw of rows) {
      const errors: string[] = [];
      const taxYear = raw.value.taxYear;
      const result: TaxCertificateImportRowResult = {
        row: raw.row,
        sourceLines: raw.sourceLines,
        employeeCode: textOf(raw.value.employeeCode),
        taxYear: typeof taxYear === 'number' ? taxYear : textOf(taxYear),
        certificateType: textOf(raw.value.certificateType),
        ok: false,
        errors,
        action: null,
        source: null,
        figureCount: Array.isArray(raw.value.figures) ? raw.value.figures.length : 0,
        certificateId: null,
      };
      const checkedRow: CheckedRow = { raw, result };
      out.push(checkedRow);

      const parsed = TaxCertificateImportRowSchema.safeParse(raw.value);
      if (!parsed.success) {
        errors.push(...zodMessages(parsed.error));
        continue;
      }
      const row = parsed.data;
      result.certificateType = row.certificateType;
      result.source = row.attachmentId ? 'UPLOADED' : 'GENERATED';
      const key = `${row.employeeCode}|${row.taxYear}|${row.certificateType}`;
      if (seen.has(key)) errors.push('The same employee, tax year and certificate type appear twice');
      seen.add(key);

      let upload: { id: string; sha256: string } | null = null;
      if (row.attachmentId) {
        if (uploads.has(row.attachmentId)) errors.push('The same uploaded PDF is used twice');
        uploads.add(row.attachmentId);
        const file = await client.attachment.findUnique({ where: { id: row.attachmentId } });
        if (
          !file ||
          file.deletedAt ||
          file.ownerEntity !== UNOWNED_ATTACHMENT_OWNER ||
          file.uploadedByUserId !== ctx.userId
        ) {
          errors.push('attachmentId is not an unused upload of yours; upload the PDF again');
        } else if (file.mimeType !== 'application/pdf') {
          errors.push('The uploaded certificate must be a PDF');
        } else {
          upload = { id: file.id, sha256: file.sha256 };
        }
      }

      const found = await client.employee.findFirst({
        where: { employeeCode: row.employeeCode, deletedAt: null },
        select: { id: true },
      });
      if (!found) {
        errors.push(`Unknown employee ${row.employeeCode}`);
        continue;
      }
      if (!(await this.scope.canAccessAny(ctx, found.id, ['PAYROLL'], client))) {
        errors.push('The employee is not in your companies');
        continue;
      }
      const employee = await this.documents.employee(found.id, client);
      const range = taxYearRange(row.taxYear);
      if (employee.dateEngaged && employee.dateEngaged > dateFromBusiness(range.to)) {
        errors.push('The employee was engaged after this tax year');
      }
      if (employee.terminationDate && employee.terminationDate < dateFromBusiness(range.from)) {
        errors.push('The employee was terminated before this tax year');
      }
      const existing = await client.taxCertificate.findFirst({
        where: {
          employeeId: employee.id,
          taxYear: row.taxYear,
          certificateType: row.certificateType,
          supersededAt: null,
        },
        select: { id: true },
      });
      if (existing && !replace) {
        errors.push(
          'A certificate was already published for this employee, tax year and type; import with replace to supersede it',
        );
      }
      result.action = existing ? 'REPLACE' : 'CREATE';
      checkedRow.valid = { row, employee, upload, existingId: existing?.id ?? null };
    }
    for (const r of out) r.result.ok = r.result.errors.length === 0;
    return out;
  }

  private async renderAndStore(r: CheckedRow, logos: Map<number, string | null>): Promise<GeneratedFile> {
    const v = r.valid;
    if (!v) throw new Error(`Certificate row ${r.result.row} was not validated`);
    const e = v.employee;
    const block = this.documents.employeeBlock(e);
    const range = taxYearRange(v.row.taxYear);
    const bytes = await this.pdf.render(
      taxCertificateDocument({
        company: { name: e.company.name, logo: await this.documents.logo(e.company, logos) },
        employee: {
          name: block.name,
          employeeCode: e.employeeCode,
          idNumberMasked: block.idNumberMasked,
          taxNumberMasked: block.taxNumberMasked,
        },
        taxYear: v.row.taxYear,
        taxYearLabel: taxYearLabel(v.row.taxYear),
        periodFrom: range.from,
        periodTo: range.to,
        certificateType: v.row.certificateType,
        currency: e.company.currency,
        figures: v.row.figures,
        generatedAt: new Date(),
      }),
    );
    return this.attachments.storeGenerated({
      fileName: `tax-certificate-${e.employeeCode}-${v.row.taxYear}-${v.row.certificateType}.pdf`,
      mimeType: 'application/pdf',
      bytes,
    });
  }

  private async commitRow(
    tx: Tx,
    ctx: SecurityContext,
    r: CheckedRow,
    file: GeneratedFile | null,
    input: TaxCertificateImportRequest,
  ): Promise<void> {
    const v = r.valid;
    if (!v) throw new Error(`Certificate row ${r.result.row} was not validated`);
    const pdf = v.upload ?? (file ? { id: file.id, sha256: file.sha256 } : null);
    if (!pdf) throw new Error(`Certificate row ${r.result.row} has no PDF`);
    const { row, employee } = v;
    if (v.existingId !== null) {
      await this.db.lockRow(tx, 'TaxCertificate', v.existingId);
      const superseded = await tx.taxCertificate.update({
        where: { id: v.existingId },
        data: { supersededAt: new Date() },
        select: { id: true, pdfSha256: true },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'TAX_CERTIFICATE.SUPERSEDED',
        entityType: TAX_CERTIFICATE_ENTITY,
        entityId: superseded.id,
        subjectEmployeeId: employee.id,
        reason: 'Replaced by a re-import',
        metadata: { pdfSha256: superseded.pdfSha256, row: r.result.row },
      });
    }
    const certificate = await tx.taxCertificate.create({
      data: {
        employeeId: employee.id,
        taxYear: row.taxYear,
        certificateType: row.certificateType,
        pdfAttachmentId: pdf.id,
        pdfSha256: pdf.sha256,
        source: v.upload ? 'UPLOADED' : 'GENERATED',
        figures: row.figures.length > 0 ? row.figures : undefined,
        importedByUserId: ctx.userId,
      },
    });
    if (v.upload) {
      await this.attachments.bind(tx, ctx, [v.upload.id], {
        entity: TAX_CERTIFICATE_ENTITY,
        entityId: certificate.id,
        subjectEmployeeId: employee.id,
      });
    } else if (file) {
      await this.attachments.recordGenerated(tx, ctx, file, {
        entity: TAX_CERTIFICATE_ENTITY,
        entityId: certificate.id,
        subjectEmployeeId: employee.id,
      });
    }
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: v.existingId !== null ? 'TAX_CERTIFICATE.REPLACED' : 'TAX_CERTIFICATE.IMPORTED',
      entityType: TAX_CERTIFICATE_ENTITY,
      entityId: certificate.id,
      subjectEmployeeId: employee.id,
      after: {
        id: certificate.id,
        employeeId: certificate.employeeId,
        taxYear: certificate.taxYear,
        certificateType: certificate.certificateType,
        source: certificate.source,
        pdfAttachmentId: certificate.pdfAttachmentId,
        pdfSha256: certificate.pdfSha256,
      },
      metadata: {
        import: 'TAX_CERTIFICATE',
        format: input.format,
        row: r.result.row,
        sourceLines: r.result.sourceLines,
        employeeCode: employee.employeeCode,
        figureCount: row.figures.length,
        replace: input.replace,
        supersededCertificateId: v.existingId,
      },
    });
    if (employee.user?.isActive) {
      await this.notifications.create(tx, {
        userId: employee.user.id,
        kind: 'TAX_CERTIFICATE_AVAILABLE',
        title: v.existingId !== null ? 'Tax certificate updated' : 'Tax certificate available',
        body: `Your ${row.certificateType} tax certificate for ${taxYearLabel(row.taxYear)} is ${
          v.existingId !== null ? 'updated' : 'available'
        }.`,
        link: '/tax-certificates',
      });
    }
    r.result.certificateId = certificate.id;
  }
}
