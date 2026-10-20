import {
  type ChangeRequestSubmitResponse,
  dateFromBusiness,
  LOOKUP_TABLES,
  type WorkflowTypeCode,
} from '@peoplehub/shared';
import { expect } from 'vitest';
import { seedOrganisation } from '../../prisma/seed/organisation';
import { AuditService } from '../../src/audit/audit.service';
import { systemContext } from '../../src/common/context/security-context';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { BanksService } from '../../src/modules/details/banks.service';
import { LookupService } from '../../src/modules/details/lookup.service';
import type { TestApp } from './app';
import type { Agent, Org, Person } from './fixtures';
import { PDF_BYTES } from './leave';
import type { StepSpec, WorkflowKit } from './workflow';

// My Details test kit: the lookup lists and banks (seeded idempotently), two-step definitions of
// the change-request workflow types on a fixture company rule, uploads and approvals.

const sys = systemContext('test-details');

/** Section 14 shape: step 1 the manager, step 2 Payroll (BASICINF, BANKDET) or HR. */
export function detailSteps(type: WorkflowTypeCode): StepSpec[] {
  const role = type === 'BASICINF' || type === 'BANKDET' ? 'PAYROLL_ADMIN' : 'HR_ADMIN';
  return [
    { resolution: 'REPORTS_TO', name: 'Manager approval' },
    { resolution: 'ROLE', role, name: role === 'PAYROLL_ADMIN' ? 'Payroll approval' : 'HR approval' },
  ];
}

export const DETAIL_WORKFLOW_TYPES: WorkflowTypeCode[] = [
  'BASICINF',
  'BANKDET',
  'DRIVERSLICENSE',
  'BENEFICIARY',
  'FREETEXTMANEMP',
];

export class DetailsKit {
  constructor(
    readonly t: TestApp,
    readonly kit: WorkflowKit,
  ) {}

  /** Lookups and banks (idempotent) and the org's definitions of the detail workflow types. */
  async setup(org: Org): Promise<void> {
    // The 16 workflow types (idempotent), in case this file runs on a fresh database.
    await seedOrganisation({ db: this.t.db, audit: this.t.app.get(AuditService), ctx: sys, app: this.t.app });
    await this.t.app.get(LookupService).seed(sys, LOOKUP_TABLES);
    await this.t.app.get(BanksService).seed(sys);
    for (const type of DETAIL_WORKFLOW_TYPES) {
      await this.kit.definition({ type, companyRuleId: org.companyRuleId, steps: detailSteps(type) });
    }
  }

  async bank(name = 'Bank of Windhoek'): Promise<{ bankId: number; branchId: number }> {
    const bank = await this.t.db.prisma.bank.findUniqueOrThrow({ where: { name } });
    const branch = await this.t.db.prisma.bankBranch.findFirstOrThrow({
      where: { bankId: bank.id, isActive: true },
    });
    return { bankId: bank.id, branchId: branch.id };
  }

  /** Uploads a PDF as the agent and returns its id. */
  async upload(agent: Agent, fileName = 'proof.pdf'): Promise<string> {
    const res = await agent
      .post('/attachments')
      .attach('file', PDF_BYTES, { filename: fileName, contentType: 'application/pdf' });
    expect(res.status, res.text).toBe(201);
    return (res.body as { items: { id: string }[] }).items[0]?.id ?? '';
  }

  /** Approves the current step as the agent (with the version read from the database). */
  async approve(agent: Agent, processId: number, expected = 200): Promise<void> {
    const p = await this.t.db.prisma.workflowProcess.findUniqueOrThrow({ where: { id: processId } });
    const res = await agent.post(`/workflow/processes/${processId}/approve`).send({ version: p.version });
    expect(res.status, res.text).toBe(expected);
  }

  /** Step 1 by the manager, step 2 by the payroll or HR admin. */
  async approveAll(processId: number, approvers: Agent[]): Promise<void> {
    for (const agent of approvers) await this.approve(agent, processId);
  }

  process(processId: number) {
    return this.t.db.prisma.workflowProcess.findUniqueOrThrow({ where: { id: processId } });
  }

  changeRequest(id: number) {
    return this.t.db.prisma.changeRequest.findUniqueOrThrow({ where: { id } });
  }

  /** Expects a 200/201 submit and returns its body. */
  submitted(res: { status: number; text: string; body: unknown }, status = 200): ChangeRequestSubmitResponse {
    expect(res.status, res.text).toBe(status);
    return res.body as ChangeRequestSubmitResponse;
  }

  /** Creates an active bank account directly (test setup only, bypassing the workflow). */
  async account(person: Person, number = '6200123456', effectiveFrom = '2024-01-01'): Promise<number> {
    const { bankId, branchId } = await this.bank();
    const crypto = this.t.app.get(EncryptionService);
    return this.t.db.tx(sys, async (tx) => {
      const row = await tx.bankAccount.create({
        data: {
          employeeId: person.employeeId as number,
          accountType: 'CURRENT',
          holderName: person.username,
          holderRelationship: 'OWN',
          bankId,
          branchId,
          accountNumberEnc: crypto.encrypt(number),
          accountNumberLast4: number.slice(-4),
          effectiveFrom: dateFromBusiness(effectiveFrom),
        },
      });
      return row.id;
    });
  }
}
