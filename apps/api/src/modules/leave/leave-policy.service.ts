import { Injectable } from '@nestjs/common';
import type { LeavePolicy, LeaveType as LeaveTypeRow } from '@prisma/client';
import { type LeaveType, LEAVE_PROBLEM_TYPES, units4 } from '@peoplehub/shared';
import { DomainError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';

export type PolicyWithType = LeavePolicy & { leaveType: LeaveTypeRow };

/**
 * Leave policies per company rule (section 14). A policy for the employee's company rule wins
 * over a policy for every company rule (`companyRuleId = null`); only active types and policies
 * count, so "the leave types the employee has a policy for" (section 5.2.1) comes from here.
 */
@Injectable()
export class LeavePolicyService {
  constructor(private readonly db: DbService) {}

  /** The most specific active policy per active leave type for a company rule. */
  async applicable(companyRuleId: number, client: Tx = this.db.prisma): Promise<PolicyWithType[]> {
    const rows = await client.leavePolicy.findMany({
      where: {
        isActive: true,
        leaveType: { isActive: true },
        OR: [{ companyRuleId }, { companyRuleId: null }],
      },
      include: { leaveType: true },
      orderBy: [{ leaveTypeId: 'asc' }, { id: 'asc' }],
    });
    const byType = new Map<number, PolicyWithType>();
    for (const row of rows) {
      const current = byType.get(row.leaveTypeId);
      if (!current || (current.companyRuleId === null && row.companyRuleId !== null))
        byType.set(row.leaveTypeId, row);
    }
    return [...byType.values()].sort((a, b) => a.leaveTypeId - b.leaveTypeId);
  }

  async policyFor(
    companyRuleId: number,
    leaveTypeId: number,
    client: Tx = this.db.prisma,
  ): Promise<PolicyWithType | null> {
    return (await this.applicable(companyRuleId, client)).find((p) => p.leaveTypeId === leaveTypeId) ?? null;
  }

  /** Like {@link policyFor}, but 422 on `path` when the employee has no policy for the type. */
  async requirePolicy(
    companyRuleId: number,
    leaveTypeId: number,
    client: Tx = this.db.prisma,
    path = 'leaveTypeId',
  ): Promise<PolicyWithType> {
    const policy = await this.policyFor(companyRuleId, leaveTypeId, client);
    if (!policy) {
      throw new DomainError(
        422,
        'Validation failed',
        'This leave type is not available for the employee',
        [{ path, message: 'This leave type is not available for the employee' }],
        LEAVE_PROBLEM_TYPES.noPolicy,
      );
    }
    return policy;
  }

  /** The `GET /leave/types` item for a policy. */
  toLeaveTypeDto(p: PolicyWithType, hasReasons: boolean): LeaveType {
    const t = p.leaveType;
    return {
      id: t.id,
      code: t.code,
      description: t.description,
      colour: t.colour,
      unit: t.unit,
      isPaid: t.isPaid,
      mandatoryReason: t.mandatoryReason,
      requiresAttachmentAfterDays:
        t.requiresAttachmentAfterDays === null ? null : units4(t.requiresAttachmentAfterDays),
      allowHalfDay: t.allowHalfDay,
      allowNegative: t.allowNegative,
      excludeWeekends: t.excludeWeekends,
      excludePublicHolidays: t.excludePublicHolidays,
      hideUnitsAvailableForESS: t.hideUnitsAvailableForESS,
      hideZeroUnitsAvailableForESS: t.hideZeroUnitsAvailableForESS,
      isCreditLeave: t.isCreditLeave,
      hasReasons,
      policy: {
        id: p.id,
        definitionName: p.definitionName,
        entitlementPerCycle: units4(p.entitlementPerCycle),
        accrualMethod: p.accrualMethod,
        cycleMonths: p.cycleMonths,
        maxNegative: units4(p.maxNegative),
      },
    };
  }
}
