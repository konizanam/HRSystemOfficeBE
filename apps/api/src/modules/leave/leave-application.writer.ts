import { Injectable } from '@nestjs/common';
import type { LeaveApplication, Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import type { Tx } from '../../prisma/prisma-client';

/**
 * Updates a leave application from a workflow hook: bumps its `version`, keeps its status in step
 * with the process and writes one domain audit row with before/after.
 */
@Injectable()
export class LeaveApplicationWriter {
  constructor(private readonly audit: AuditService) {}

  async update(
    tx: Tx,
    ctx: SecurityContext,
    id: number,
    data: Prisma.LeaveApplicationUncheckedUpdateInput,
    audit: { action: string; reason?: string | null; metadata?: Record<string, unknown> },
  ): Promise<LeaveApplication> {
    const before = await tx.leaveApplication.findUniqueOrThrow({ where: { id } });
    const after = await tx.leaveApplication.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
    });
    this.audit.record(tx, ctx, {
      category: 'WORKFLOW',
      action: audit.action,
      entityType: 'LeaveApplication',
      entityId: id,
      subjectEmployeeId: after.employeeId,
      before,
      after,
      reason: audit.reason ?? null,
      metadata: { referenceNumber: after.referenceNumber, processId: after.processId, ...audit.metadata },
    });
    return after;
  }

  /** Ends the application's reservations (declined, withdrawn, cancelled). */
  async releaseAllocations(tx: Tx, applicationId: number): Promise<number> {
    const result = await tx.leaveApplicationAllocation.updateMany({
      where: { applicationId, releasedAt: null },
      data: { releasedAt: new Date() },
    });
    return result.count;
  }
}
