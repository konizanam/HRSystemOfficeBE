import {
  addMonths,
  type BusinessDate,
  endOfMonth,
  type PayslipImportResponse,
  type PayslipImportRowInput,
  startOfMonth,
  type TaxCertificateImportResponse,
  type TaxCertificateImportRowInput,
  todayBusinessDate,
} from '@peoplehub/shared';
import type request from 'supertest';
import { expect } from 'vitest';
import type { TestApp } from './app';
import type { Agent, Org } from './fixtures';
import type { WorkflowKit } from './workflow';

/** A minimal valid PDF for uploads. */
export const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/** Payslip and tax certificate helpers for integration tests. */
export class PayrollKit {
  constructor(
    private readonly t: TestApp,
    private readonly workflow: WorkflowKit,
  ) {}

  /** Pay periods for the last `count` months (oldest first) of the org's rule; returns their end dates. */
  async periods(org: Org, count: number): Promise<BusinessDate[]> {
    const ends: BusinessDate[] = [];
    for (let i = count; i >= 1; i--) {
      const month = startOfMonth(addMonths(todayBusinessDate(), -i));
      await this.workflow.payPeriod(org, { month });
      ends.push(endOfMonth(month));
    }
    return ends;
  }

  row(
    employeeCode: string,
    periodEndDate: string,
    extra: Partial<PayslipImportRowInput> = {},
  ): PayslipImportRowInput {
    return {
      employeeCode,
      periodEndDate,
      lines: [
        {
          category: 'EARNING',
          code: 'BASIC',
          description: 'Basic Salary',
          amount: '20000.00',
          ytdAmount: '140000.00',
        },
        {
          category: 'DEDUCTION',
          code: 'PAYE',
          description: 'PAYE',
          amount: '4400.00',
          ytdAmount: '30800.00',
        },
        {
          category: 'COMPANY_CONTRIBUTION',
          code: 'PENSION_ER',
          description: 'Pension (Employer)',
          amount: '2000.00',
        },
      ],
      ...extra,
    };
  }

  /** Dry run then commit; returns both responses (expects 200 for both). */
  async importPayslips(
    agent: Agent,
    rows: PayslipImportRowInput[],
    replace = false,
  ): Promise<{ dry: PayslipImportResponse; commit: PayslipImportResponse }> {
    const body = { format: 'json', rows, replace };
    const dry = await agent.post('/admin/payslips/import').send({ ...body, mode: 'DRY_RUN' });
    expect(dry.status, dry.text).toBe(200);
    const dryBody = dry.body as PayslipImportResponse;
    const commit = await agent
      .post('/admin/payslips/import')
      .send({ ...body, mode: 'COMMIT', confirmToken: dryBody.confirmToken });
    expect(commit.status, commit.text).toBe(200);
    return { dry: dryBody, commit: commit.body as PayslipImportResponse };
  }

  async importCertificates(
    agent: Agent,
    rows: TaxCertificateImportRowInput[],
    replace = false,
  ): Promise<TaxCertificateImportResponse> {
    const body = { format: 'json', rows, replace };
    const dry = await agent.post('/admin/tax-certificates/import').send({ ...body, mode: 'DRY_RUN' });
    expect(dry.status, dry.text).toBe(200);
    const commit = await agent.post('/admin/tax-certificates/import').send({
      ...body,
      mode: 'COMMIT',
      confirmToken: (dry.body as TaxCertificateImportResponse).confirmToken,
    });
    expect(commit.status, commit.text).toBe(200);
    return commit.body as TaxCertificateImportResponse;
  }

  async upload(agent: Agent, fileName = 'certificate.pdf'): Promise<string> {
    const res = await agent
      .post('/attachments')
      .attach('file', PDF_BYTES, { filename: fileName, contentType: 'application/pdf' });
    expect(res.status, res.text).toBe(201);
    return (res.body as { items: { id: string }[] }).items[0]?.id ?? '';
  }

  /** Switches the agent's "Working as" employee. */
  async actAs(agent: Agent, employeeId: number | null): Promise<void> {
    const res = await agent.put('/session/acting-as').send({ employeeId });
    expect(res.status, res.text).toBe(200);
  }

  /** Reads a binary response fully. */
  static binary(res: { body: unknown }): Buffer {
    return res.body as Buffer;
  }
}

/** supertest parser that keeps the body as a Buffer and counts the chunks it arrived in. */
export function bufferParser(
  res: request.Response,
  callback: (err: Error | null, body: { bytes: Buffer; chunks: number }) => void,
): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const parts: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => parts.push(Buffer.from(chunk)));
  stream.on('end', () => callback(null, { bytes: Buffer.concat(parts), chunks: parts.length }));
  stream.on('error', (err: Error) => callback(err, { bytes: Buffer.alloc(0), chunks: 0 }));
}
