import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_PREFIX,
  businessFromDate,
  formatCardDate,
  money2,
  payRunLabel,
  type PayslipCard,
  type PayslipDetail,
  type PayslipListQuery,
  type PayslipListResponse,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import { NotFoundError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import { AttachmentService } from '../attachments/attachment.service';
import { PayrollDocumentsService } from './payroll-documents.service';
import { PAYSLIP_ENTITY } from './payslip-import.service';

const CARD_SELECT = {
  id: true,
  employeeId: true,
  payRun: true,
  runType: true,
  ruleLabel: true,
  currency: true,
  grossPay: true,
  totalDeductions: true,
  netPay: true,
  pdfAttachmentId: true,
  pdfSha256: true,
  publishedAt: true,
  employee: {
    select: {
      employeeCode: true,
      firstName: true,
      lastName: true,
      company: { select: { name: true } },
      companyRule: { select: { description: true } },
    },
  },
  payPeriod: { select: { id: true, description: true, startDate: true, endDate: true, payDate: true } },
} satisfies Prisma.PayslipSelect;

type PayslipRow = Prisma.PayslipGetPayload<{ select: typeof CARD_SELECT }>;

function toCard(p: PayslipRow): PayslipCard {
  return {
    id: p.id,
    employeeId: p.employeeId,
    employeeCode: p.employee.employeeCode,
    employeeName: `${p.employee.firstName} ${p.employee.lastName}`,
    companyName: p.employee.company.name,
    payPeriodId: p.payPeriod.id,
    payPeriodDescription: p.payPeriod.description,
    periodEndDate: businessFromDate(p.payPeriod.endDate),
    periodEndLabel: formatCardDate(p.payPeriod.endDate),
    companyRule: p.ruleLabel ?? p.employee.companyRule.description,
    payRun: p.payRun,
    payRunLabel: payRunLabel(p.payRun),
    runType: p.runType,
    publishedAt: p.publishedAt.toISOString(),
  };
}

export function payslipPdfPath(id: number, download = false): string {
  return `${API_PREFIX}/payslips/${id}/pdf${download ? '?download=1' : ''}`;
}

export interface PayslipPdf {
  fileName: string;
  bytes: Buffer;
  download: boolean;
}

/**
 * Payslips (section 5.5): the card list, the metadata and the stored PDF. Every view and download
 * is audited (`DATA_VIEW.PAYSLIP`, `EXPORT.PAYSLIP_PDF`); everything is refused (403, DENIED)
 * while working as someone else unless `workingAs.restrictedFeatures` allows payslips.
 */
@Injectable()
export class PayslipService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly documents: PayrollDocumentsService,
    private readonly attachments: AttachmentService,
  ) {}

  /** GET /payslips: newest period first, `pageSize` (4) at a time with a "More" flag. */
  async list(ctx: SecurityContext, query: PayslipListQuery): Promise<PayslipListResponse> {
    await this.documents.assertNotRestricted(ctx, 'PAYSLIPS');
    const employeeId = await this.documents.listSubject(ctx, query.employeeId);
    const where: Prisma.PayslipWhereInput = { employeeId, supersededAt: null };
    const [rows, total] = await Promise.all([
      this.db.prisma.payslip.findMany({
        where,
        select: CARD_SELECT,
        orderBy: [{ payPeriod: { endDate: 'desc' } }, { payRun: 'asc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.prisma.payslip.count({ where }),
    ]);
    return {
      employeeId,
      items: rows.map(toCard),
      total,
      page: query.page,
      pageSize: query.pageSize,
      hasMore: query.page * query.pageSize < total,
    };
  }

  /** The newest current payslip of an employee (dashboard), without any check or audit. */
  async latest(employeeId: number): Promise<PayslipCard | null> {
    const row = await this.db.prisma.payslip.findFirst({
      where: { employeeId, supersededAt: null },
      select: CARD_SELECT,
      orderBy: [{ payPeriod: { endDate: 'desc' } }, { payRun: 'desc' }, { id: 'desc' }],
    });
    return row ? toCard(row) : null;
  }

  private async load(ctx: SecurityContext, id: number): Promise<PayslipRow> {
    await this.documents.assertNotRestricted(ctx, 'PAYSLIPS');
    const row = await this.db.prisma.payslip.findFirst({
      where: { id, supersededAt: null },
      select: CARD_SELECT,
    });
    if (!row) throw new NotFoundError('Payslip');
    await this.documents.assertCanView(ctx, row.employeeId);
    return row;
  }

  /** GET /payslips/:id (audited `DATA_VIEW.PAYSLIP`). */
  async detail(ctx: SecurityContext, id: number): Promise<PayslipDetail> {
    const row = await this.load(ctx, id);
    await this.audit.recordStandalone(ctx, {
      category: 'DATA_VIEW',
      action: 'DATA_VIEW.PAYSLIP',
      entityType: PAYSLIP_ENTITY,
      entityId: row.id,
      subjectEmployeeId: row.employeeId,
      metadata: { view: 'METADATA', payPeriodId: row.payPeriod.id, payRun: row.payRun },
    });
    return {
      ...toCard(row),
      payPeriodStartDate: businessFromDate(row.payPeriod.startDate),
      payDate: row.payPeriod.payDate ? businessFromDate(row.payPeriod.payDate) : null,
      currency: row.currency,
      grossPay: money2(row.grossPay),
      totalDeductions: money2(row.totalDeductions),
      netPay: money2(row.netPay),
      pdfSha256: row.pdfSha256,
      pdfUrl: payslipPdfPath(row.id),
      downloadUrl: payslipPdfPath(row.id, true),
    };
  }

  /**
   * GET /payslips/:id/pdf: the stored PDF, checked against its sha256. Inline for the preview
   * (`DATA_VIEW.PAYSLIP`) or as a download (`EXPORT.PAYSLIP_PDF`).
   */
  async pdf(ctx: SecurityContext, id: number, download: boolean): Promise<PayslipPdf> {
    const row = await this.load(ctx, id);
    if (!row.pdfAttachmentId) throw new NotFoundError('Payslip PDF');
    const file = await this.attachments.readOwned(row.pdfAttachmentId, {
      entity: PAYSLIP_ENTITY,
      entityId: row.id,
    });
    if (row.pdfSha256 && file.sha256 !== row.pdfSha256) throw new NotFoundError('Payslip PDF');
    await this.audit.recordStandalone(ctx, {
      category: download ? 'EXPORT' : 'DATA_VIEW',
      action: download ? 'EXPORT.PAYSLIP_PDF' : 'DATA_VIEW.PAYSLIP',
      entityType: PAYSLIP_ENTITY,
      entityId: row.id,
      subjectEmployeeId: row.employeeId,
      metadata: {
        view: 'PDF',
        download,
        sha256: file.sha256,
        payPeriodId: row.payPeriod.id,
        payRun: row.payRun,
      },
    });
    return { fileName: file.fileName, bytes: file.bytes, download };
  }
}
