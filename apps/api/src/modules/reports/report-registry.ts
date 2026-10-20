import { Injectable } from '@nestjs/common';
import { REPORT_CODES, type ReportCode } from '@peoplehub/shared';
import * as auditReports from './definitions/audit.reports';
import * as employeeReports from './definitions/employee.reports';
import * as leaveReports from './definitions/leave.reports';
import * as performanceReports from './definitions/performance.reports';
import * as workflowReports from './definitions/workflow.reports';
import type { AnyReportDefinition, ReportDefinition } from './report-definition';

function isReport(value: unknown): value is AnyReportDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { run?: unknown }).run === 'function' &&
    (REPORT_CODES as readonly unknown[]).includes((value as { code?: unknown }).code)
  );
}

/** Every report of section 5.7 (each definition file's exports), in catalogue order. */
export const ALL_REPORTS: AnyReportDefinition[] = [
  employeeReports,
  leaveReports,
  performanceReports,
  workflowReports,
  auditReports,
]
  .flatMap((module) => Object.values(module).filter(isReport))
  .sort((a, b) => REPORT_CODES.indexOf(a.code) - REPORT_CODES.indexOf(b.code));

/**
 * The report registry. It holds one definition per catalogue code and refuses to start when a
 * code has no definition, so the catalogue the web app sees always runs.
 */
@Injectable()
export class ReportRegistry {
  private readonly reports = new Map<ReportCode, AnyReportDefinition>();

  constructor() {
    for (const report of ALL_REPORTS) this.register(report);
    const missing = REPORT_CODES.filter((code) => !this.reports.has(code));
    if (missing.length > 0) throw new Error(`Reports without a definition: ${missing.join(', ')}`);
  }

  register(report: AnyReportDefinition): void {
    if (this.reports.has(report.code)) throw new Error(`Report ${report.code} is registered twice`);
    this.reports.set(report.code, report);
  }

  get(code: string): AnyReportDefinition | undefined {
    return this.reports.get(code as ReportCode);
  }

  list(): AnyReportDefinition[] {
    return [...this.reports.values()].sort(
      (a, b) => REPORT_CODES.indexOf(a.code) - REPORT_CODES.indexOf(b.code),
    );
  }
}

export type { ReportDefinition };
