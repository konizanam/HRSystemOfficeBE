import type { CsvImportMapping, PayrollImportFormat } from '@peoplehub/shared';
import { createHash } from 'node:crypto';
import type { ZodError } from 'zod';
import { ValidationError } from '../../common/errors/domain-errors';
import { parseCsv } from '../leave/csv';

/** One import row (a payslip or a certificate) before schema validation. */
export interface RawImportRow {
  /** 1-based row number in the import. */
  row: number;
  /** CSV data lines of the row (empty for JSON). */
  sourceLines: number[];
  value: Record<string, unknown>;
}

export interface ImportInput {
  format: PayrollImportFormat;
  csv?: string;
  rows?: Record<string, unknown>[];
  replace: boolean;
}

/**
 * The dry run's token: sha256 over what will be imported and how, so a COMMIT applies exactly the
 * content (and the replace choice) that was reviewed.
 */
export function confirmTokenFor(kind: string, input: ImportInput): string {
  const content = input.format === 'csv' ? (input.csv ?? '') : JSON.stringify(input.rows ?? []);
  return createHash('sha256')
    .update(JSON.stringify({ kind, format: input.format, replace: input.replace, content }))
    .digest('hex');
}

/** Turns the request into rows: CSV lines are grouped by `mapCsv`, JSON rows are taken as sent. */
export function rawImportRows(
  input: ImportInput,
  mapCsv: (table: string[][]) => CsvImportMapping,
  maxRows: number,
): RawImportRow[] {
  let rows: RawImportRow[];
  if (input.format === 'csv') {
    const mapping = mapCsv(parseCsv(input.csv ?? ''));
    if (mapping.headerErrors.length > 0) throw ValidationError.field('csv', mapping.headerErrors.join('; '));
    rows = mapping.rows.map((g, i) => ({ row: i + 1, sourceLines: g.sourceLines, value: g.value }));
  } else {
    rows = (input.rows ?? []).map((value, i) => ({ row: i + 1, sourceLines: [], value }));
  }
  if (rows.length === 0) {
    throw ValidationError.field(input.format === 'csv' ? 'csv' : 'rows', 'The import has no data rows');
  }
  if (rows.length > maxRows) {
    throw ValidationError.field('rows', `Import at most ${maxRows} rows at a time`);
  }
  return rows;
}

/** "lines.0.amount: Expected a decimal number". */
export function zodMessages(error: ZodError): string[] {
  return error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message));
}

/** The 422 a COMMIT answers when rows still have errors. */
export function invalidRowsError(rows: { row: number; errors: string[]; ok: boolean }[]): ValidationError {
  return new ValidationError(
    rows.filter((r) => !r.ok).map((r) => ({ path: `rows.${r.row}`, message: r.errors.join('; ') })),
    'Fix the rows with errors and run the dry run again',
  );
}

/** A value for a string field of a row whose schema validation failed (for the result line). */
export function textOf(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
