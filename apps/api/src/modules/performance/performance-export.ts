import {
  type PerformanceExportColumn,
  type PerformanceExportFormat,
  todayBusinessDate,
} from '@peoplehub/shared';
import ExcelJS from 'exceljs';

/** A grid export ready to send (the controller sets the headers). */
export interface ExportFile {
  fileName: string;
  contentType: string;
  body: Buffer;
}

function cell(value: unknown): string | number {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/**
 * Writes grid rows as CSV or Excel with the given columns (the claims export pattern: exceljs,
 * a bold header row). Callers audit `EXPORT.*` themselves.
 */
export async function gridExport<R extends object>(
  rows: readonly R[],
  columns: readonly PerformanceExportColumn<Extract<keyof R, string>>[],
  options: { format: PerformanceExportFormat; sheet: string; fileBase: string },
): Promise<ExportFile> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PeopleHub';
  const sheet = workbook.addWorksheet(options.sheet);
  sheet.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: Math.max(14, c.header.length + 4),
  }));
  for (const row of rows) sheet.addRow(columns.map((c) => cell(row[c.key])));
  sheet.getRow(1).font = { bold: true };
  const body =
    options.format === 'csv'
      ? Buffer.from(await workbook.csv.writeBuffer())
      : Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    fileName: `${options.fileBase}-${todayBusinessDate()}.${options.format}`,
    contentType:
      options.format === 'csv'
        ? 'text/csv; charset=utf-8'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body,
  };
}

export type SortDirection = 'asc' | 'desc';

/**
 * The orderBy of every `field:asc|desc` sort from one builder per field (ties are broken by the
 * builder, usually on `id` in the same direction).
 */
export function sortMap<F extends string, O>(
  builders: Record<F, (dir: SortDirection) => O[]>,
): Record<`${F}:${SortDirection}`, O[]> {
  const out = {} as Record<`${F}:${SortDirection}`, O[]>;
  for (const field of Object.keys(builders) as F[]) {
    for (const dir of ['asc', 'desc'] as const) out[`${field}:${dir}`] = builders[field](dir);
  }
  return out;
}
