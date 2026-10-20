import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

/** Single Prometheus registry exposed at GET /metrics (section 15). */
export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export const jobDuration = new Histogram({
  name: 'job_duration_seconds',
  help: 'Background job duration',
  labelNames: ['job', 'outcome'],
  buckets: [0.05, 0.1, 0.5, 1, 5, 15, 60, 300],
  registers: [metricsRegistry],
});

export const auditInsertDuration = new Histogram({
  name: 'audit_insert_duration_seconds',
  help: 'Time to append a batch of audit rows to the hash chain',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1],
  registers: [metricsRegistry],
});

export const auditRowsTotal = new Counter({
  name: 'audit_rows_total',
  help: 'Audit rows written',
  registers: [metricsRegistry],
});

export const workflowProcessesByStatus = new Gauge({
  name: 'workflow_processes',
  help: 'Workflow processes by type and status',
  labelNames: ['type', 'status'],
  registers: [metricsRegistry],
});
