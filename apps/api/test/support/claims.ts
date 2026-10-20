import type { CapCycle, CapMode, ClaimInputMode } from '@prisma/client';
import type { ClaimDetail } from '@peoplehub/shared';
import { expect } from 'vitest';
import { seedClaimReferenceData } from '../../prisma/seed/claims';
import { systemContext } from '../../src/common/context/security-context';
import type { TestApp } from './app';
import type { Agent, Org } from './fixtures';
import { PDF_BYTES } from './leave';
import { TWO_STEP, type WorkflowKit } from './workflow';

// Claims test kit: the seeded claim reference data, the two-step GROUPEDCLAIM and CLAIMS
// definitions on a fixture company rule, fresh claim groups and types (with caps on the fixture
// company rule, so they never touch other tests), uploads and the draft/submit calls.

const sys = systemContext('test-claims');

export interface CapSpec {
  companyRuleId: number | null;
  cycle?: CapCycle;
  mode?: CapMode;
  amountLimit?: string | null;
  quantityLimit?: string | null;
  proRata?: boolean;
}

export interface TypeSpec {
  inputMode: ClaimInputMode;
  rate?: string | null;
  rateMultiplier?: string | null;
  requiresAttachment?: boolean;
  description?: string;
  /** Default: one NO_CAP ANNUAL cap for the given company rule. */
  caps?: CapSpec[];
}

export class ClaimKit {
  constructor(
    readonly t: TestApp,
    readonly kit: WorkflowKit,
  ) {}

  /** Seeds the claim reference data (idempotent), the org's claim definitions and a pay period. */
  async setup(org: Org): Promise<{ payPeriodId: number }> {
    await seedClaimReferenceData({ db: this.t.db, ctx: sys });
    for (const type of ['GROUPEDCLAIM', 'CLAIMS'] as const) {
      await this.kit.definition({ type, companyRuleId: org.companyRuleId, steps: TWO_STEP });
    }
    return { payPeriodId: await this.kit.payPeriod(org) };
  }

  /** A new claim group with the next free id. */
  async group(options: { attachmentMandatory?: boolean; description?: string } = {}): Promise<number> {
    return this.t.db.tx(sys, async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "ClaimGroup" IN SHARE ROW EXCLUSIVE MODE');
      const max = await tx.claimGroup.aggregate({ _max: { id: true } });
      const id = (max._max.id ?? 0) + 1;
      await tx.claimGroup.create({
        data: {
          id,
          code: `TG${id}`,
          description: options.description ?? `Test Claims ${id}`,
          attachmentMandatory: options.attachmentMandatory ?? false,
        },
      });
      return id;
    });
  }

  /** A new claim type in the group, with its caps (default: NO_CAP ANNUAL for `companyRuleId`). */
  async type(groupId: number, companyRuleId: number, spec: TypeSpec): Promise<number> {
    return this.t.db.tx(sys, async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "ClaimType" IN SHARE ROW EXCLUSIVE MODE');
      const max = await tx.claimType.aggregate({ _max: { id: true } });
      const id = (max._max.id ?? 0) + 1;
      await tx.claimType.create({
        data: {
          id,
          groupId,
          code: `TT${id}`,
          description: spec.description ?? `Test type ${id}`,
          inputMode: spec.inputMode,
          rate: spec.rate ?? null,
          rateMultiplier: spec.rateMultiplier ?? null,
          requiresAttachment: spec.requiresAttachment ?? false,
        },
      });
      for (const cap of spec.caps ?? [{ companyRuleId }]) {
        await tx.claimCap.create({
          data: {
            claimTypeId: id,
            companyRuleId: cap.companyRuleId,
            cycle: cap.cycle ?? 'ANNUAL',
            mode: cap.mode ?? 'NO_CAP',
            amountLimit: cap.amountLimit ?? null,
            quantityLimit: cap.quantityLimit ?? null,
            proRata: cap.proRata ?? false,
          },
        });
      }
      return id;
    });
  }

  async setHourlyRate(employeeId: number | null, rate: string): Promise<void> {
    await this.t.db.tx(sys, async (tx) => {
      await tx.employee.update({ where: { id: employeeId ?? 0 }, data: { hourlyRate: rate } });
    });
  }

  /** Uploads a PDF as the agent and returns its id. */
  async upload(agent: Agent, fileName = 'receipt.pdf'): Promise<string> {
    const res = await agent
      .post('/attachments')
      .attach('file', PDF_BYTES, { filename: fileName, contentType: 'application/pdf' });
    expect(res.status, res.text).toBe(201);
    return (res.body as { items: { id: string }[] }).items[0]?.id ?? '';
  }

  /** POST /claims and expect 201. */
  async create(agent: Agent, body: Record<string, unknown>): Promise<ClaimDetail> {
    const res = await agent.post('/claims').send(body);
    expect(res.status, res.text).toBe(201);
    return res.body as ClaimDetail;
  }

  /** POST /claims/:id/submit and expect 200. */
  async submit(agent: Agent, claim: { id: number; version: number }, key?: string): Promise<ClaimDetail> {
    const req = agent.post(`/claims/${claim.id}/submit`);
    if (key) req.set('idempotency-key', key);
    const res = await req.send({ version: claim.version });
    expect(res.status, res.text).toBe(200);
    return res.body as ClaimDetail;
  }

  /** Approves the process as the agent with its current version. */
  async approve(agent: Agent, processId: number): Promise<void> {
    const p = await this.kit.process(processId);
    const res = await agent.post(`/workflow/processes/${processId}/approve`).send({ version: p.version });
    expect(res.status, res.text).toBe(200);
  }
}
