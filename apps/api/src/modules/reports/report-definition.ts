import type { Prisma } from '@prisma/client';
import {
  type BusinessDate,
  REPORT_CATALOGUE,
  REPORT_PARAM_SCHEMAS,
  type ReportCode,
  type ReportColumn,
  type ReportGroup,
  type ReportParamField,
  type ReportParams,
  type ReportRow,
  type Role,
} from '@peoplehub/shared';
import type { SecurityContext } from '../../common/context/security-context';
import type { AppPrismaClient } from '../../prisma/prisma-client';

/** What a report's `run` gets besides its params. */
export interface ReportRunContext {
  ctx: SecurityContext;
  prisma: AppPrismaClient;
  /**
   * The employees the caller may report on (their role scope), narrowed by the params' company
   * rules, employees and "include terminated". Child queries filter with `employee: employees`.
   */
  employees: Prisma.EmployeeWhereInput;
  today: BusinessDate;
  /** Rows per database round trip (cursor pagination). */
  batchSize: number;
}

/**
 * A report (section 5.7). The catalogue metadata (title, group, roles, columns and the parameter
 * panel) lives in `packages/shared` so the web app renders the same columns; the API adds `run`.
 * `run` streams rows (an async generator over cursor-paginated queries), so an export never holds
 * the whole result in memory.
 */
export interface ReportDefinition<C extends ReportCode = ReportCode> {
  code: C;
  group: ReportGroup;
  title: string;
  description: string;
  /** Validates the run request's `params`. */
  params: (typeof REPORT_PARAM_SCHEMAS)[C];
  /** The parameter panel, serialisable for the web app. */
  paramFields: ReportParamField[];
  requiredRoles: Role[];
  columns: ReportColumn[];
  run(rc: ReportRunContext, params: ReportParams<C>): AsyncIterable<ReportRow>;
}

/** Joins the shared metadata of `code` with its `run`. */
export function defineReport<C extends ReportCode>(
  code: C,
  run: (rc: ReportRunContext, params: ReportParams<C>) => AsyncIterable<ReportRow>,
): ReportDefinition<C> {
  const meta = REPORT_CATALOGUE[code];
  return {
    code,
    group: meta.group,
    title: meta.title,
    description: meta.description,
    params: REPORT_PARAM_SCHEMAS[code],
    paramFields: meta.paramFields,
    requiredRoles: meta.requiredRoles,
    columns: meta.columns,
    run,
  };
}

/** Any report, for the registry and the runner. */
export type AnyReportDefinition = { [C in ReportCode]: ReportDefinition<C> }[ReportCode];
