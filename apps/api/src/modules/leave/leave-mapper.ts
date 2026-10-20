import type { Prisma, ProcessStatus } from '@prisma/client';
import {
  businessFromDate,
  type LeaveApplicationRow,
  type LeaveCancelAction,
  type LeaveTypeRef,
  PROCESS_STATUS_LABELS,
  units4,
} from '@peoplehub/shared';

/** What a history row needs from the database. */
export const APPLICATION_ROW_INCLUDE = {
  leaveType: true,
  leaveReason: { select: { description: true } },
  cancels: { select: { id: true, referenceNumber: true } },
  cancellations: {
    orderBy: { id: 'desc' },
    take: 1,
    select: { id: true, referenceNumber: true, status: true, processId: true },
  },
} satisfies Prisma.LeaveApplicationInclude;

export type ApplicationRowSource = Prisma.LeaveApplicationGetPayload<{
  include: typeof APPLICATION_ROW_INCLUDE;
}>;

const OPEN_STATUSES: ProcessStatus[] = [
  'DRAFT',
  'IN_PROGRESS',
  'RESUBMIT_REQUIRED',
  'APPROVED_PENDING_PROCESS',
];
const CANCELLABLE_STATUSES: ProcessStatus[] = ['IN_PROGRESS', 'APPROVED_PENDING_PROCESS', 'PROCESSED'];

export function isOpenStatus(status: ProcessStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

/**
 * What Cancel does (section 5.2.3): withdraw when nothing has been actioned yet (or the request
 * was sent back to the applicant), otherwise request a cancellation, unless one is already open.
 */
export function cancelActionFor(
  app: Pick<ApplicationRowSource, 'status' | 'cancelsApplicationId' | 'cancellations'>,
  actioned: boolean,
): LeaveCancelAction | null {
  const withdrawable = app.status === 'RESUBMIT_REQUIRED' || (app.status === 'IN_PROGRESS' && !actioned);
  if (app.cancelsApplicationId !== null) return withdrawable ? 'WITHDRAW' : null;
  if (withdrawable) return 'WITHDRAW';
  const latest = app.cancellations[0];
  if (latest && isOpenStatus(latest.status)) return null;
  return CANCELLABLE_STATUSES.includes(app.status) ? 'REQUEST_CANCELLATION' : null;
}

export function leaveTypeRef(t: {
  id: number;
  code: string;
  description: string;
  colour: string | null;
}): LeaveTypeRef {
  return { id: t.id, code: t.code, description: t.description, colour: t.colour };
}

/** "Annual Leave", or "Cancel Annual Leave" for a cancellation request. */
export function leaveTypeLabel(app: {
  cancelsApplicationId: number | null;
  leaveType: { description: string };
}): string {
  return app.cancelsApplicationId === null
    ? app.leaveType.description
    : `Cancel ${app.leaveType.description}`;
}

export function toApplicationRow(
  app: ApplicationRowSource,
  extra: { finalApprover: string | null; actioned: boolean },
): LeaveApplicationRow {
  const latest = app.cancellations[0];
  return {
    id: app.id,
    version: app.version,
    employeeId: app.employeeId,
    leaveType: leaveTypeRef(app.leaveType),
    leaveTypeLabel: leaveTypeLabel(app),
    referenceNumber: app.referenceNumber,
    fromDate: businessFromDate(app.fromDate),
    toDate: businessFromDate(app.toDate),
    startPortion: app.startPortion,
    endPortion: app.endPortion,
    unitsTaken: units4(app.unitsTaken),
    leaveReason: app.leaveReason?.description ?? null,
    noteSubmitted: app.noteSubmitted,
    noteReceived: app.noteReceived,
    takeOnTransaction: app.takeOnTransaction,
    dateSubmitted: app.submittedAt?.toISOString() ?? null,
    dateApproved: app.approvedAt?.toISOString() ?? null,
    finalApprover: extra.finalApprover,
    status: app.status,
    statusLabel: PROCESS_STATUS_LABELS[app.status],
    processId: app.processId,
    isCancellation: app.cancelsApplicationId !== null,
    cancels: app.cancels ? { id: app.cancels.id, referenceNumber: app.cancels.referenceNumber } : null,
    cancellation: latest
      ? {
          id: latest.id,
          referenceNumber: latest.referenceNumber,
          status: latest.status,
          statusLabel: PROCESS_STATUS_LABELS[latest.status],
          processId: latest.processId,
        }
      : null,
    cancelAction: cancelActionFor(app, extra.actioned),
  };
}
