import { Injectable } from '@nestjs/common';
import {
  businessFromDate,
  dateFromBusiness,
  dec,
  PAYROLL_IMPORT_MAX_ROWS,
  payRunLabel,
  payslipRowsFromCsv,
  payslipTotals,
  type PayslipImportRequest,
  type PayslipImportResponse,
  type PayslipImportRow,
  type PayslipImportRowResult,
  PayslipImportRowSchema,
  type PayslipTotals,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import { ValidationError } from '../../common/errors/domain-errors';
import { payslipDocument } from '../../pdf/documents';
import { PdfService } from '../../pdf/pdf.service';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { AttachmentService, type GeneratedFile } from '../attachments/attachment.service';
import { ScopeService } from '../auth/scope.service';
import { LeaveBalanceService } from '../leave/leave-balance.service';
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

/** Prisma model (and attachment owner entity) of a payslip. */
export const PAYSLIP_ENTITY = 'Payslip';

interface PayPeriodRef {
  id: number;
  description: string;
  startDate: Date;
  endDate: Date;
  payDate: Date | null;
}

interface CheckedRow {
  raw: RawImportRow;
  result: PayslipImportRowResult;
  valid?: {
    row: PayslipImportRow;
    employee: DocumentEmployee;
    payPeriod: PayPeriodRef;
    totals: PayslipTotals;
    currency: string;
    existingId: number | null;
  };
}

/**
 * `POST /admin/payslips/import` (section 5.5). DRY_RUN validates every payslip and returns a
 * token bound to the content; COMMIT re-validates inside one transaction and, per payslip,
 * creates the Payslip and its lines, generates and stores the PDF (sha256 on the payslip and
 * the attachment), notifies the employee in-app and audits `PAYSLIP.IMPORTED` (or
 * `PAYSLIP.REPLACED`). Re-importing a published payslip needs `replace: true`; the old one is
 * superseded, never deleted.
 */
@Injectable()
export class PayslipImportService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly pdf: PdfService,
    private readonly attachments: AttachmentService,
    private readonly documents: PayrollDocumentsService,
    private readonly leaveBalances: LeaveBalanceService,
    private readonly notifications: NotificationService,
  ) {}

  async import(ctx: SecurityContext, input: PayslipImportRequest): Promise<PayslipImportResponse> {
    const confirmToken = confirmTokenFor('PAYSLIP', input);
    const raw = rawImportRows(input, payslipRowsFromCsv, PAYROLL_IMPORT_MAX_ROWS);
    const checked = await this.check(ctx, raw, input.replace, this.db.prisma);
    const summary = (committed: boolean, rows: CheckedRow[]): PayslipImportResponse => ({
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

    // PDFs are rendered and stored first (storage cannot join the transaction); a failed
    // transaction removes them again.
    const files: GeneratedFile[] = [];
    try {
      const logos = new Map<number, string | null>();
      for (const r of checked) files.push(await this.renderAndStore(ctx, r, logos));
      const committed = await this.db.tx(
        ctx,
        async (tx) => {
          const again = await this.check(ctx, raw, input.replace, tx);
          if (again.some((r) => !r.result.ok)) throw invalidRowsError(again.map((r) => r.result));
          for (const [i, r] of again.entries()) {
            await this.commitRow(tx, ctx, r, files[i] as GeneratedFile, input);
          }
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

  /** Validates every row (schema, employee scope, pay period, duplicates, existing payslips). */
  private async check(
    ctx: SecurityContext,
    rows: RawImportRow[],
    replace: boolean,
    client: Tx,
  ): Promise<CheckedRow[]> {
    const seen = new Set<string>();
    const out: CheckedRow[] = [];
    for (const raw of rows) {
      const errors: string[] = [];
      const result: PayslipImportRowResult = {
        row: raw.row,
        sourceLines: raw.sourceLines,
        employeeCode: textOf(raw.value.employeeCode),
        periodEndDate: textOf(raw.value.periodEndDate),
        payRun: textOf(raw.value.payRun) || 'MAIN',
        ok: false,
        errors,
        action: null,
        lineCount: Array.isArray(raw.value.lines) ? raw.value.lines.length : 0,
        grossPay: null,
        netPay: null,
        payslipId: null,
      };
      const checkedRow: CheckedRow = { raw, result };
      out.push(checkedRow);

      const parsed = PayslipImportRowSchema.safeParse(raw.value);
      if (!parsed.success) {
        errors.push(...zodMessages(parsed.error));
        continue;
      }
      const row = parsed.data;
      result.payRun = row.payRun;
      const key = `${row.employeeCode}|${row.periodEndDate}|${row.payRun}`;
      if (seen.has(key)) errors.push('The same employee, period and pay run appear twice in the import');
      seen.add(key);

      const totals = payslipTotals(row.lines.map((l) => ({ ...l, ytdAmount: l.ytdAmount ?? null })));
      result.grossPay = totals.grossPay;
      result.netPay = totals.netPay;
      if (totals.netPay.startsWith('-')) errors.push('Net pay cannot be negative');
      if (row.netPay !== undefined && !dec(row.netPay).eq(dec(totals.netPay))) {
        errors.push(`netPay ${row.netPay} does not match the lines (${totals.netPay})`);
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
      const payPeriod = await client.payPeriod.findFirst({
        where: { companyRuleId: employee.companyRuleId, endDate: dateFromBusiness(row.periodEndDate) },
        select: { id: true, description: true, startDate: true, endDate: true, payDate: true },
      });
      if (!payPeriod) {
        errors.push(`No pay period of ${employee.companyRule.description} ends on ${row.periodEndDate}`);
        continue;
      }
      if (employee.dateEngaged && employee.dateEngaged > payPeriod.endDate) {
        errors.push('The employee was engaged after this pay period');
      }
      if (employee.terminationDate && employee.terminationDate < payPeriod.startDate) {
        errors.push('The employee was terminated before this pay period');
      }
      const existing = await client.payslip.findFirst({
        where: { employeeId: employee.id, payPeriodId: payPeriod.id, payRun: row.payRun, supersededAt: null },
        select: { id: true },
      });
      if (existing && !replace) {
        errors.push(
          'A payslip was already published for this employee, period and pay run; import with replace to supersede it',
        );
      }
      result.action = existing ? 'REPLACE' : 'CREATE';
      checkedRow.valid = {
        row,
        employee,
        payPeriod,
        totals,
        currency: row.currency ?? employee.company.currency,
        existingId: existing?.id ?? null,
      };
    }
    for (const r of out) r.result.ok = r.result.errors.length === 0;
    return out;
  }

  private async renderAndStore(
    ctx: SecurityContext,
    r: CheckedRow,
    logos: Map<number, string | null>,
  ): Promise<GeneratedFile> {
    const v = r.valid;
    if (!v) throw new Error(`Payslip row ${r.result.row} was not validated`);
    const e = v.employee;
    const block = this.documents.employeeBlock(e);
    const balances = await this.leaveBalances.cards(ctx, e.id);
    const bytes = await this.pdf.render(
      payslipDocument({
        company: { name: e.company.name, logo: await this.documents.logo(e.company, logos) },
        employee: {
          name: block.name,
          employeeCode: e.employeeCode,
          idNumberMasked: block.idNumberMasked,
          jobTitle: e.jobTitle,
          department: e.department,
          dateEngaged: e.dateEngaged ? businessFromDate(e.dateEngaged) : null,
          companyRule: e.companyRule.description,
        },
        period: {
          description: v.payPeriod.description,
          startDate: businessFromDate(v.payPeriod.startDate),
          endDate: businessFromDate(v.payPeriod.endDate),
          payDate: v.payPeriod.payDate ? businessFromDate(v.payPeriod.payDate) : null,
        },
        payRunLabel: payRunLabel(v.row.payRun),
        runType: v.row.runType,
        currency: v.currency,
        bankMasked: block.bankMasked,
        lines: v.row.lines.map((l) => ({
          category: l.category,
          code: l.code,
          description: l.description,
          quantity: l.quantity ?? null,
          rate: l.rate ?? null,
          amount: l.amount,
          ytdAmount: l.ytdAmount ?? null,
        })),
        totals: v.totals,
        leave: balances.items.map((b) => ({
          leaveType: b.description,
          available: b.actualAvailable,
          pending: b.pending,
        })),
        generatedAt: new Date(),
      }),
    );
    const periodEnd = businessFromDate(v.payPeriod.endDate);
    return this.attachments.storeGenerated({
      fileName: `payslip-${e.employeeCode}-${periodEnd}-${v.row.payRun}.pdf`,
      mimeType: 'application/pdf',
      bytes,
    });
  }

  private async commitRow(
    tx: Tx,
    ctx: SecurityContext,
    r: CheckedRow,
    file: GeneratedFile,
    input: PayslipImportRequest,
  ): Promise<void> {
    const v = r.valid;
    if (!v) throw new Error(`Payslip row ${r.result.row} was not validated`);
    const { row, employee, payPeriod, totals } = v;
    if (v.existingId !== null) {
      await this.db.lockRow(tx, 'Payslip', v.existingId);
      const superseded = await tx.payslip.update({
        where: { id: v.existingId },
        data: { supersededAt: new Date() },
        select: { id: true, supersededAt: true, pdfSha256: true },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'PAYSLIP.SUPERSEDED',
        entityType: PAYSLIP_ENTITY,
        entityId: superseded.id,
        subjectEmployeeId: employee.id,
        reason: 'Replaced by a re-import',
        metadata: { pdfSha256: superseded.pdfSha256, row: r.result.row },
      });
    }
    const payslip = await tx.payslip.create({
      data: {
        employeeId: employee.id,
        payPeriodId: payPeriod.id,
        payRun: row.payRun,
        runType: row.runType,
        ruleLabel: employee.companyRule.description,
        currency: v.currency,
        grossPay: totals.grossPay,
        totalDeductions: totals.totalDeductions,
        netPay: totals.netPay,
        pdfAttachmentId: file.id,
        pdfSha256: file.sha256,
        importedByUserId: ctx.userId,
      },
    });
    await tx.payslipLine.createMany({
      data: row.lines.map((l, i) => ({
        payslipId: payslip.id,
        category: l.category,
        code: l.code,
        description: l.description,
        quantity: l.quantity ?? null,
        rate: l.rate ?? null,
        amount: l.amount,
        ytdAmount: l.ytdAmount ?? null,
        sortOrder: i,
      })),
    });
    await this.attachments.recordGenerated(tx, ctx, file, {
      entity: PAYSLIP_ENTITY,
      entityId: payslip.id,
      subjectEmployeeId: employee.id,
    });
    // Amounts stay out of the audit trail (system admins read it, section 4.1); the PDF's sha256
    // identifies exactly what was published.
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: v.existingId !== null ? 'PAYSLIP.REPLACED' : 'PAYSLIP.IMPORTED',
      entityType: PAYSLIP_ENTITY,
      entityId: payslip.id,
      subjectEmployeeId: employee.id,
      after: {
        id: payslip.id,
        employeeId: payslip.employeeId,
        payPeriodId: payslip.payPeriodId,
        payRun: payslip.payRun,
        runType: payslip.runType,
        currency: payslip.currency,
        pdfAttachmentId: payslip.pdfAttachmentId,
        pdfSha256: payslip.pdfSha256,
      },
      metadata: {
        import: 'PAYSLIP',
        format: input.format,
        row: r.result.row,
        sourceLines: r.result.sourceLines,
        employeeCode: employee.employeeCode,
        periodEndDate: businessFromDate(payPeriod.endDate),
        payPeriodId: payPeriod.id,
        payRun: row.payRun,
        lineCount: row.lines.length,
        replace: input.replace,
        supersededPayslipId: v.existingId,
        pdfSha256: file.sha256,
      },
    });
    if (employee.user?.isActive) {
      await this.notifications.create(tx, {
        userId: employee.user.id,
        kind: 'PAYSLIP_AVAILABLE',
        title: v.existingId !== null ? 'Payslip updated' : 'Payslip available',
        body: `Your ${payRunLabel(row.payRun)} payslip for ${payPeriod.description} is ${
          v.existingId !== null ? 'updated' : 'available'
        }.`,
        link: '/payslips',
      });
    }
    r.result.payslipId = payslip.id;
  }
}
