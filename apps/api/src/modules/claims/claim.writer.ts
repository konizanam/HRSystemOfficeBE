import { Injectable } from '@nestjs/common';
import type { AuditCategory, Claim, Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import type { Tx } from '../../prisma/prisma-client';

/**
 * Updates a claim: bumps its `version` and writes one domain audit row with before/after (the
 * workflow hooks keep the claim's status in step with its process through here).
 */
@Injectable()
export class ClaimWriter {
  constructor(private readonly audit: AuditService) {}

  async update(
    tx: Tx,
    ctx: SecurityContext,
    id: number,
    data: Prisma.ClaimUncheckedUpdateInput,
    audit: {
      action: string;
      category?: AuditCategory;
      reason?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Claim> {
    const before = await tx.claim.findUniqueOrThrow({ where: { id } });
    const after = await tx.claim.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
    this.audit.record(tx, ctx, {
      category: audit.category ?? 'WORKFLOW',
      action: audit.action,
      entityType: 'Claim',
      entityId: id,
      subjectEmployeeId: after.employeeId,
      before,
      after,
      reason: audit.reason ?? null,
      metadata: { referenceNumber: after.referenceNumber, processId: after.processId, ...audit.metadata },
    });
    return after;
  }
}
