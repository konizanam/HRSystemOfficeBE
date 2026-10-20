import { Injectable } from '@nestjs/common';
import type { LeaveType as LeaveTypeRow } from '@prisma/client';
import {
  addDays,
  type BusinessDate,
  businessFromDate,
  dateFromBusiness,
  type DayPortion,
  Decimal,
  dec,
  formatGridDate,
  LEAVE_PROBLEM_TYPES,
  round4,
  todayBusinessDate,
  units4,
} from '@peoplehub/shared';
import { hasRole, type SecurityContext } from '../../common/context/security-context';
import { DomainError, type FieldError } from '../../common/errors/domain-errors';
import type { Tx } from '../../prisma/prisma-client';
import { HolidayService } from '../holidays/holiday.service';
import { type BucketView, EntitlementService } from './entitlement.service';
import { type LeaveEmployee, OVERLAP_EXCLUDED_STATUSES } from './leave-constants';
import type { PolicyWithType } from './leave-policy.service';
import {
  type Allocation,
  allocateUnits,
  availableFor,
  calculateUnits,
  overlappingDates,
  type UnitCalculation,
} from './leave-rules';

export interface LeaveRequestDraft {
  employee: LeaveEmployee;
  leaveType: LeaveTypeRow;
  policy: PolicyWithType;
  fromDate: BusinessDate;
  toDate: BusinessDate;
  startPortion: DayPortion;
  endPortion: DayPortion;
  leaveReasonId: number | null;
  attachmentCount: number;
  /** HR_ADMIN override of the calculated units (already authorised by the caller). */
  overrideUnits: Decimal | null;
  /** The application being edited (resubmission): left out of overlap and reservations. */
  excludeApplicationId?: number;
}

export interface EvaluatedLeaveRequest {
  calculation: UnitCalculation;
  units: Decimal;
  /** Actual available before this request (the "Days available" snapshot). */
  available: Decimal;
  allocations: Allocation[];
  buckets: BucketView[];
}

/**
 * The submit validation of section 5.2.1, shared by submit and resubmission. Every failure is
 * collected and returned as one 422 with field-level messages. Run it inside the submit
 * transaction after locking the employee, so the balance and overlap checks cannot race.
 */
@Injectable()
export class LeaveRequestValidator {
  constructor(
    private readonly holidays: HolidayService,
    private readonly entitlements: EntitlementService,
  ) {}

  async evaluate(
    tx: Tx,
    ctx: SecurityContext,
    draft: LeaveRequestDraft,
    settings: { maxBackdateDays: number },
  ): Promise<EvaluatedLeaveRequest> {
    const { employee, leaveType, policy } = draft;
    const errors: FieldError[] = [];
    const today = todayBusinessDate();

    // The employee is ACTIVE and the dates are within employment.
    if (employee.status !== 'ACTIVE' || employee.deletedAt !== null) {
      errors.push({ path: 'employeeId', message: 'Leave can only be applied for active employees' });
    }
    if (employee.dateEngaged && draft.fromDate < businessFromDate(employee.dateEngaged)) {
      errors.push({
        path: 'fromDate',
        message: `Leave cannot start before the employee was engaged (${formatGridDate(employee.dateEngaged)})`,
      });
    }
    if (employee.terminationDate && draft.toDate > businessFromDate(employee.terminationDate)) {
      errors.push({
        path: 'toDate',
        message: `Leave cannot end after the employee's termination date (${formatGridDate(employee.terminationDate)})`,
      });
    }

    // Backdating: from ≥ today − leave.maxBackdateDays, unless HR_ADMIN.
    const earliest = addDays(today, -settings.maxBackdateDays);
    if (!hasRole(ctx, 'HR_ADMIN') && draft.fromDate < earliest) {
      errors.push({
        path: 'fromDate',
        message: `Leave can start at most ${settings.maxBackdateDays} days in the past (from ${formatGridDate(earliest)})`,
      });
    }

    // Units (a range with no working days throws 422 here).
    const holidays = await this.holidays.calendar(employee.companyId, draft.fromDate, draft.toDate, tx);
    const calculation = calculateUnits({
      fromDate: draft.fromDate,
      toDate: draft.toDate,
      startPortion: draft.startPortion,
      endPortion: draft.endPortion,
      excludeWeekends: leaveType.excludeWeekends,
      excludePublicHolidays: leaveType.excludePublicHolidays,
      allowHalfDay: leaveType.allowHalfDay,
      holidays,
    });
    const units = draft.overrideUnits ? round4(draft.overrideUnits) : calculation.units;
    if (units.lte(0)) errors.push({ path: 'units', message: 'Units must be greater than 0' });

    // Mandatory reason; a reason must belong to the type and be active.
    if (draft.leaveReasonId !== null) {
      const reason = await tx.leaveReason.findFirst({
        where: { id: draft.leaveReasonId, leaveTypeId: leaveType.id, isActive: true },
        select: { id: true },
      });
      if (!reason) errors.push({ path: 'leaveReasonId', message: 'Choose a reason for this leave type' });
    } else if (leaveType.mandatoryReason) {
      errors.push({ path: 'leaveReasonId', message: 'The reason for taking leave is required' });
    }

    // Attachment required when units > requiresAttachmentAfterDays.
    if (
      leaveType.requiresAttachmentAfterDays !== null &&
      units.gt(dec(leaveType.requiresAttachmentAfterDays)) &&
      draft.attachmentCount === 0
    ) {
      errors.push({
        path: 'attachmentIds',
        message: dec(leaveType.requiresAttachmentAfterDays).isZero()
          ? 'Attach a supporting document'
          : `Attach a supporting document for more than ${units4(leaveType.requiresAttachmentAfterDays)} days`,
      });
    }

    // No overlap with another live application (any type), at half-day granularity.
    const existing = await tx.leaveApplicationDay.findMany({
      where: {
        date: { gte: dateFromBusiness(draft.fromDate), lte: dateFromBusiness(draft.toDate) },
        application: {
          employeeId: employee.id,
          status: { notIn: OVERLAP_EXCLUDED_STATUSES },
          cancelsApplicationId: null,
          ...(draft.excludeApplicationId !== undefined ? { id: { not: draft.excludeApplicationId } } : {}),
        },
      },
      select: { date: true, portion: true, application: { select: { referenceNumber: true } } },
    });
    const clashes = overlappingDates(
      calculation.days,
      existing.map((d) => ({ date: businessFromDate(d.date), portion: d.portion })),
    );
    let overlapError: FieldError | null = null;
    if (clashes.length > 0) {
      const refs = [
        ...new Set(
          existing
            .filter((d) => clashes.includes(businessFromDate(d.date)))
            .map((d) => d.application.referenceNumber),
        ),
      ];
      overlapError = {
        path: 'fromDate',
        message: `These dates overlap leave already applied for (${refs.join(', ')}) on ${clashes.map(formatGridDate).join(', ')}`,
      };
      errors.push(overlapError);
    }

    // Balance: actualAvailable − units ≥ −maxNegative, unless the type allows negative balances.
    const buckets = await this.entitlements.buckets(employee.id, leaveType.id, {
      client: tx,
      excludeApplicationId: draft.excludeApplicationId,
    });
    const available = availableFor(buckets, draft.fromDate);
    let balanceError: FieldError | null = null;
    if (!leaveType.allowNegative && available.minus(units).lt(dec(policy.maxNegative).negated())) {
      balanceError = {
        path: 'units',
        message: `Not enough ${leaveType.description} available: ${units4(available)} Days available, ${units4(units)} Days requested`,
      };
      errors.push(balanceError);
    }
    const allocations = allocateUnits(units, buckets, draft.fromDate);
    if (allocations.length === 0 && !balanceError) {
      errors.push({
        path: 'leaveTypeId',
        message: `There is no ${leaveType.description} entitlement to take this leave from`,
      });
    }

    if (errors.length > 0) {
      // The problem type tells the web app the main cause when there is a single one.
      const type =
        errors.length === 1 && overlapError
          ? LEAVE_PROBLEM_TYPES.overlap
          : errors.length === 1 && balanceError
            ? LEAVE_PROBLEM_TYPES.insufficientBalance
            : 'about:blank';
      throw new DomainError(422, 'Validation failed', errors[0]?.message, errors, type);
    }
    return { calculation, units, available: round4(available), allocations, buckets };
  }
}
