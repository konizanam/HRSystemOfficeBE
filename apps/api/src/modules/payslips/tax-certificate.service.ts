import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_PREFIX,
  type TaxCertificate,
  type TaxCertificateSource,
  type TaxCertificatesResponse,
  taxYearLabel,
  taxYearRange,
  type TaxYearGroup,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import { NotFoundError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import { AttachmentService } from '../attachments/attachment.service';
import { PayrollDocumentsService } from './payroll-documents.service';

/** Prisma model (and attachment owner entity) of a tax certificate. */
export const TAX_CERTIFICATE_ENTITY = 'TaxCertificate';

const CERTIFICATE_SELECT = {
  id: true,
  employeeId: true,
  taxYear: true,
  certificateType: true,
  source: true,
  issuedAt: true,
  pdfAttachmentId: true,
  pdfSha256: true,
  employee: { select: { employeeCode: true, firstName: true, lastName: true } },
} satisfies Prisma.TaxCertificateSelect;

type CertificateRow = Prisma.TaxCertificateGetPayload<{ select: typeof CERTIFICATE_SELECT }>;

export function taxCertificatePdfPath(id: number, download = false): string {
  return `${API_PREFIX}/tax-certificates/${id}/pdf${download ? '?download=1' : ''}`;
}

function toDto(c: CertificateRow): TaxCertificate {
  const range = taxYearRange(c.taxYear);
  return {
    id: c.id,
    employeeId: c.employeeId,
    employeeCode: c.employee.employeeCode,
    employeeName: `${c.employee.firstName} ${c.employee.lastName}`,
    taxYear: c.taxYear,
    taxYearLabel: taxYearLabel(c.taxYear),
    periodFrom: range.from,
    periodTo: range.to,
    certificateType: c.certificateType,
    source: c.source as TaxCertificateSource,
    issuedAt: c.issuedAt.toISOString(),
    pdfSha256: c.pdfSha256,
    pdfUrl: taxCertificatePdfPath(c.id),
    downloadUrl: taxCertificatePdfPath(c.id, true),
  };
}

export interface TaxCertificatePdf {
  fileName: string;
  bytes: Buffer;
  download: boolean;
}

/**
 * My Tax Certificates (section 5.6): the list by tax year and the stored PDF. Views and downloads
 * are audited (`DATA_VIEW.TAX_CERTIFICATE`, `EXPORT.TAX_CERTIFICATE_PDF`) and refused while
 * working as someone else (feature TAX_CERTIFICATES).
 */
@Injectable()
export class TaxCertificateService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly documents: PayrollDocumentsService,
    private readonly attachments: AttachmentService,
  ) {}

  async list(ctx: SecurityContext, employeeId?: number): Promise<TaxCertificatesResponse> {
    await this.documents.assertNotRestricted(ctx, 'TAX_CERTIFICATES');
    const subject = await this.documents.listSubject(ctx, employeeId);
    const rows = await this.db.prisma.taxCertificate.findMany({
      where: { employeeId: subject, supersededAt: null },
      select: CERTIFICATE_SELECT,
      orderBy: [{ taxYear: 'desc' }, { certificateType: 'asc' }, { id: 'desc' }],
    });
    const years: TaxYearGroup[] = [];
    for (const row of rows) {
      let group = years.find((y) => y.taxYear === row.taxYear);
      if (!group) {
        group = { taxYear: row.taxYear, label: taxYearLabel(row.taxYear), items: [] };
        years.push(group);
      }
      group.items.push(toDto(row));
    }
    return { employeeId: subject, total: rows.length, years };
  }

  /** The newest current certificate of an employee (dashboard), without any check or audit. */
  async latest(employeeId: number): Promise<TaxCertificate | null> {
    const row = await this.db.prisma.taxCertificate.findFirst({
      where: { employeeId, supersededAt: null },
      select: CERTIFICATE_SELECT,
      orderBy: [{ taxYear: 'desc' }, { issuedAt: 'desc' }, { id: 'desc' }],
    });
    return row ? toDto(row) : null;
  }

  async pdf(ctx: SecurityContext, id: number, download: boolean): Promise<TaxCertificatePdf> {
    await this.documents.assertNotRestricted(ctx, 'TAX_CERTIFICATES');
    const row = await this.db.prisma.taxCertificate.findFirst({
      where: { id, supersededAt: null },
      select: CERTIFICATE_SELECT,
    });
    if (!row) throw new NotFoundError('Tax certificate');
    await this.documents.assertCanView(ctx, row.employeeId);
    const file = await this.attachments.readOwned(row.pdfAttachmentId, {
      entity: TAX_CERTIFICATE_ENTITY,
      entityId: row.id,
    });
    if (file.sha256 !== row.pdfSha256) throw new NotFoundError('Tax certificate PDF');
    await this.audit.recordStandalone(ctx, {
      category: download ? 'EXPORT' : 'DATA_VIEW',
      action: download ? 'EXPORT.TAX_CERTIFICATE_PDF' : 'DATA_VIEW.TAX_CERTIFICATE',
      entityType: TAX_CERTIFICATE_ENTITY,
      entityId: row.id,
      subjectEmployeeId: row.employeeId,
      metadata: { download, sha256: file.sha256, taxYear: row.taxYear, certificateType: row.certificateType },
    });
    return {
      fileName: `tax-certificate-${row.employee.employeeCode}-${row.taxYear}-${row.certificateType}.pdf`,
      bytes: file.bytes,
      download,
    };
  }
}
