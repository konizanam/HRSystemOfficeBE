import { Injectable } from '@nestjs/common';
import {
  canRunReport,
  formatGridDate,
  REPORT_FORMATS,
  REPORT_GROUP_LABELS,
  REPORT_GROUPS,
  REPORT_PDF_ROW_LIMIT,
  type ReportCatalogue,
  type ReportEmployeesQuery,
  type ReportEmployeesResponse,
  type ReportPage,
  type ReportRow,
  type RunReportRequest,
  todayBusinessDate,
} from '@peoplehub/shared';
import type { Readable } from 'node:stream';
import { AuditService } from '../../audit/audit.service';
import { hasRole, type SecurityContext } from '../../common/context/security-context';
import { ForbiddenError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { displayCell, reportDocument } from '../../pdf/documents';
import { PdfService } from '../../pdf/pdf.service';
import { DbService } from '../../prisma/db.service';
import type { AnyReportDefinition, ReportRunContext } from './report-definition';
import { ReportRegistry } from './report-registry';
import { ReportScopeService } from './report-scope.service';
import { csvStream, firstRows, pageOfRows, xlsxStream } from './report-writers';

/** Rows per database round trip inside `run`. */
export const REPORT_BATCH_SIZE = 500;

export type ReportResult =
  | { kind: 'json'; page: ReportPage }
  | { kind: 'file'; contentType: string; fileName: string; stream: Readable };

const CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
} as const;

/** "From: 01-Jan-2026 · Statuses: IN_PROGRESS" for the PDF header. */
function describeParams(params: Record<string, unknown>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => {
      const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
      if (Array.isArray(v)) return `${label}: ${v.length > 6 ? `${v.length} selected` : v.join(', ')}`;
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return `${label}: ${formatGridDate(v)}`;
      return `${label}: ${String(v)}`;
    })
    .join(' · ');
}

/**
 * Runs reports (section 5.7): checks the caller's roles and scope, validates the params, writes
 * the `EXPORT.REPORT` audit row (with the params) before any row leaves the server, then answers
 * a JSON page or streams CSV, Excel or PDF.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly registry: ReportRegistry,
    private readonly scope: ReportScopeService,
    private readonly pdf: PdfService,
  ) {}

  /** GET /reports: the reports the caller may run, grouped as observed. */
  async catalogue(ctx: SecurityContext): Promise<ReportCatalogue> {
    const reports = this.registry.list().filter((r) => canRunReport(r, ctx.roles));
    const adminCompanies = hasRole(ctx, 'HR_ADMIN', 'PAYROLL_ADMIN') ? ctx.companyIds : [];
    const ownRule = ctx.selfEmployeeId
      ? await this.db.prisma.employee.findUnique({
          where: { id: ctx.selfEmployeeId },
          select: { companyRuleId: true },
        })
      : null;
    const [companyRules, leaveTypes, claimGroups] = await Promise.all([
      this.db.prisma.companyRule.findMany({
        where: hasRole(ctx, 'AUDITOR', 'SYSTEM_ADMIN')
          ? {}
          : { OR: [{ companyId: { in: adminCompanies } }, { id: ownRule?.companyRuleId ?? -1 }] },
        select: { id: true, code: true, description: true, company: { select: { name: true } } },
        orderBy: [{ companyId: 'asc' }, { code: 'asc' }],
      }),
      this.db.prisma.leaveType.findMany({
        where: { isActive: true },
        select: { id: true, code: true, description: true },
        orderBy: { id: 'asc' },
      }),
      this.db.prisma.claimGroup.findMany({
        where: { isActive: true },
        select: { id: true, code: true, description: true },
        orderBy: { id: 'asc' },
      }),
    ]);
    return {
      groups: REPORT_GROUPS.map((group) => ({
        group,
        label: REPORT_GROUP_LABELS[group],
        reports: reports
          .filter((r) => r.group === group)
          .map((r) => ({
            code: r.code,
            group: r.group,
            title: r.title,
            description: r.description,
            formats: [...REPORT_FORMATS],
            columns: r.columns,
            params: r.paramFields,
            pdfRowLimit: REPORT_PDF_ROW_LIMIT,
          })),
      })).filter((g) => g.reports.length > 0),
      options: {
        companyRules: companyRules.map((r) => ({
          id: r.id,
          code: r.code,
          description: r.description,
          companyName: r.company.name,
        })),
        leaveTypes,
        claimGroups,
      },
    };
  }

  private report(ctx: SecurityContext, code: string): AnyReportDefinition {
    const report = this.registry.get(code);
    if (!report) throw new NotFoundError('Report');
    if (!canRunReport(report, ctx.roles)) {
      throw new ForbiddenError('You may not run this report', { metadata: { report: code } });
    }
    return report;
  }

  /** GET /reports/:code/employees: the employee picker, limited to the caller's scope. */
  async employees(
    ctx: SecurityContext,
    code: string,
    query: ReportEmployeesQuery,
  ): Promise<ReportEmployeesResponse> {
    const report = this.report(ctx, code);
    const population = await this.scope.population(ctx, report.requiredRoles);
    const search = query.search;
    const where = {
      AND: [
        this.scope.employeeWhere(population, { includeTerminated: query.includeTerminated ?? false }),
        search
          ? {
              OR: [
                { firstName: { contains: search, mode: 'insensitive' as const } },
                { lastName: { contains: search, mode: 'insensitive' as const } },
                { knownAs: { contains: search, mode: 'insensitive' as const } },
                { employeeCode: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.db.prisma.employee.findMany({
        where,
        select: {
          id: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          status: true,
          companyRule: { select: { description: true } },
        },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.prisma.employee.count({ where }),
    ]);
    return {
      items: rows.map((e) => ({
        employeeId: e.id,
        employeeCode: e.employeeCode,
        name: `${e.firstName} ${e.lastName}`,
        companyRule: e.companyRule.description,
        status: e.status,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** POST /reports/:code/run. */
  async run(ctx: SecurityContext, code: string, request: RunReportRequest): Promise<ReportResult> {
    const report = this.report(ctx, code);
    const parsed = report.params.safeParse(request.params);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => ({ path: ['params', ...i.path].join('.'), message: i.message })),
      );
    }
    const params = parsed.data as Record<string, unknown> & {
      employeeIds?: number[];
      companyRuleIds?: number[];
      includeTerminated?: boolean;
    };
    const population = await this.scope.population(ctx, report.requiredRoles);
    await this.scope.assertEmployeesInScope(population, params.employeeIds, report.code);
    const rc: ReportRunContext = {
      ctx,
      prisma: this.db.prisma,
      employees: this.scope.employeeWhere(population, params),
      today: todayBusinessDate(),
      batchSize: REPORT_BATCH_SIZE,
    };
    const generatedAt = new Date();
    // Audited before the first row is read: an export that starts is always on record.
    await this.audit.recordStandalone(ctx, {
      category: 'EXPORT',
      action: 'EXPORT.REPORT',
      entityType: 'Report',
      entityId: report.code,
      metadata: {
        report: report.code,
        title: report.title,
        format: request.format,
        params,
        ...(request.format === 'json' ? { page: request.page, pageSize: request.pageSize } : {}),
      },
    });
    const rows = this.masked(
      ctx,
      report,
      (report.run as (rc: ReportRunContext, p: unknown) => AsyncIterable<ReportRow>)(rc, params),
    );
    const fileBase = `${report.code.toLowerCase().replace(/_/g, '-')}-${rc.today}`;
    switch (request.format) {
      case 'json': {
        const page = await pageOfRows(rows, request.page, request.pageSize);
        return {
          kind: 'json',
          page: {
            code: report.code,
            title: report.title,
            columns: report.columns,
            rows: page.rows,
            page: request.page,
            pageSize: request.pageSize,
            hasMore: page.hasMore,
            generatedAt: generatedAt.toISOString(),
          },
        };
      }
      case 'csv':
        return {
          kind: 'file',
          contentType: CONTENT_TYPES.csv,
          fileName: `${fileBase}.csv`,
          stream: csvStream(report.columns, rows),
        };
      case 'xlsx':
        return {
          kind: 'file',
          contentType: CONTENT_TYPES.xlsx,
          fileName: `${fileBase}.xlsx`,
          stream: xlsxStream(report.title, report.columns, rows),
        };
      case 'pdf': {
        const first = await firstRows(rows, REPORT_PDF_ROW_LIMIT);
        const stream = this.pdf.stream(
          reportDocument({
            title: report.title,
            group: REPORT_GROUP_LABELS[report.group],
            columns: report.columns,
            parameters: describeParams(params),
            generatedAt,
            generatedBy: ctx.username,
            rows: first.rows.map((row) => report.columns.map((c) => displayCell(c, row[c.key] ?? null))),
            truncatedAt: first.truncated ? REPORT_PDF_ROW_LIMIT : null,
          }),
        );
        return { kind: 'file', contentType: CONTENT_TYPES.pdf, fileName: `${fileBase}.pdf`, stream };
      }
    }
  }

  /**
   * Blanks payslip amounts for a system admin who is not also HR or Payroll (section 4.1). The
   * catalogue keeps such reports away from system admins already; this is defence in depth.
   */
  private async *masked(
    ctx: SecurityContext,
    report: AnyReportDefinition,
    rows: AsyncIterable<ReportRow>,
  ): AsyncGenerator<ReportRow> {
    const blank =
      hasRole(ctx, 'SYSTEM_ADMIN') && !hasRole(ctx, 'HR_ADMIN', 'PAYROLL_ADMIN')
        ? report.columns.filter((c) => c.payData).map((c) => c.key)
        : [];
    for await (const row of rows) {
      if (blank.length === 0) yield row;
      else yield { ...row, ...Object.fromEntries(blank.map((k) => [k, null])) };
    }
  }
}
