import type { ReportColumn, ReportRow } from '@peoplehub/shared';
import ExcelJS from 'exceljs';
import { PassThrough, Readable } from 'node:stream';
import { displayCell } from '../../pdf/documents';

// Streaming writers for the report exports (section 5.7). Each consumes the report's row
// iterator lazily, so memory stays bounded by one database batch whatever the row count.

const NUMERIC = new Set(['integer', 'decimal', 'money']);
/** UTF-8 byte order mark, so Excel opens the CSV as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** RFC 4180 quoting, plus a leading `'` on text that a spreadsheet would run as a formula. */
export function csvCell(column: ReportColumn, row: ReportRow): string {
  let text = displayCell(column, row[column.key] ?? null);
  if (column.type === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV with a UTF-8 BOM, written in chunks of about 64 rows. */
export function csvStream(columns: ReportColumn[], rows: AsyncIterable<ReportRow>): Readable {
  async function* lines(): AsyncGenerator<string> {
    yield `${BOM}${columns.map((c) => csvCell({ ...c, type: 'string' }, { [c.key]: c.label })).join(',')}\r\n`;
    let chunk = '';
    let count = 0;
    for await (const row of rows) {
      chunk += `${columns.map((c) => csvCell(c, row)).join(',')}\r\n`;
      count += 1;
      if (count % 64 === 0) {
        yield chunk;
        chunk = '';
      }
    }
    if (chunk) yield chunk;
  }
  return Readable.from(lines());
}

function excelValue(column: ReportColumn, row: ReportRow): string | number | null {
  const value = row[column.key] ?? null;
  if (value === null) return null;
  if (NUMERIC.has(column.type)) return Number(value);
  return displayCell(column, value);
}

/** Excel through exceljs' streaming `WorkbookWriter`: each row is committed as it is read. */
export function xlsxStream(title: string, columns: ReportColumn[], rows: AsyncIterable<ReportRow>): Readable {
  const out = new PassThrough();
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: out,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.creator = 'PeopleHub';
  const sheet = workbook.addWorksheet(title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  sheet.columns = columns.map((c) => ({
    header: c.label,
    key: c.key,
    width: Math.min(40, Math.max(12, c.label.length + 2)),
    style: c.type === 'money' ? { numFmt: '#,##0.00' } : {},
  }));
  sheet.getRow(1).font = { bold: true };
  void (async () => {
    for await (const row of rows) {
      sheet.addRow(columns.map((c) => excelValue(c, row))).commit();
    }
    sheet.commit();
    await workbook.commit();
  })().catch((err: unknown) => out.destroy(err instanceof Error ? err : new Error(String(err))));
  return out;
}

/** Reads up to `limit` rows for the PDF; `truncated` when there were more. */
export async function firstRows(
  rows: AsyncIterable<ReportRow>,
  limit: number,
): Promise<{ rows: ReportRow[]; truncated: boolean }> {
  const out: ReportRow[] = [];
  for await (const row of rows) {
    if (out.length === limit) return { rows: out, truncated: true };
    out.push(row);
  }
  return { rows: out, truncated: false };
}

/** One page of rows for the on-screen grid; reads one row past the page to set `hasMore`. */
export async function pageOfRows(
  rows: AsyncIterable<ReportRow>,
  page: number,
  pageSize: number,
): Promise<{ rows: ReportRow[]; hasMore: boolean }> {
  const skip = (page - 1) * pageSize;
  const out: ReportRow[] = [];
  let index = 0;
  for await (const row of rows) {
    if (index >= skip) {
      if (out.length === pageSize) return { rows: out, hasMore: true };
      out.push(row);
    }
    index += 1;
  }
  return { rows: out, hasMore: false };
}
