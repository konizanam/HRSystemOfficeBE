import { auditInsertDuration, auditRowsTotal } from '../metrics/registry';

export const auditMetrics = {
  observeInsert(seconds: number, rows: number): void {
    auditInsertDuration.observe(seconds);
    auditRowsTotal.inc(rows);
  },
};
