import type { Prisma } from '@prisma/client';
import {
  addDays,
  BUSINESS_TIMEZONE,
  type BusinessDate,
  businessFromDate,
  dateFromBusiness,
  money2,
  PROCESS_STATUS_LABELS,
  type ProcessStatus,
  units4,
} from '@peoplehub/shared';
import { fromZonedTime } from 'date-fns-tz';
import type { AppPrismaClient } from '../../prisma/prisma-client';

// Building blocks for report `run` functions.

/** The page arguments `fetch` must pass to `findMany` (Prisma cursor pagination). */
export interface CursorPage<K> {
  take: number;
  skip?: number;
  cursor?: { id: K };
}

/**
 * Prisma cursor pagination: yields one batch at a time, so a report holds at most `batchSize`
 * rows. `fetch` must use a stable order that ends with `id` (or a unique order on `id`).
 */
export function batches<T extends { id: number }>(
  fetch: (page: CursorPage<number>) => Promise<T[]>,
  batchSize: number,
): AsyncGenerator<T[]> {
  return cursorBatches<T, number>(fetch, batchSize);
}

/** {@link batches} for tables with a bigint id (the audit log). */
export function bigintBatches<T extends { id: bigint }>(
  fetch: (page: CursorPage<bigint>) => Promise<T[]>,
  batchSize: number,
): AsyncGenerator<T[]> {
  return cursorBatches<T, bigint>(fetch, batchSize);
}

async function* cursorBatches<T extends { id: K }, K extends number | bigint>(
  fetch: (page: CursorPage<K>) => Promise<T[]>,
  batchSize: number,
): AsyncGenerator<T[]> {
  let cursor: K | undefined;
  for (;;) {
    const rows = await fetch(
      cursor === undefined ? { take: batchSize } : { take: batchSize, skip: 1, cursor: { id: cursor } },
    );
    if (rows.length > 0) yield rows;
    if (rows.length < batchSize) return;
    cursor = (rows[rows.length - 1] as T).id;
  }
}

/** Business date of a `@db.Date` column, or null. */
export function day(value: Date | null | undefined): string | null {
  return value ? businessFromDate(value) : null;
}

/** ISO timestamp, or null. */
export function ts(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export function dec4(value: Prisma.Decimal | string | number | null | undefined): string | null {
  return value === null || value === undefined ? null : units4(value);
}

export function money(value: Prisma.Decimal | string | number | null | undefined): string | null {
  return value === null || value === undefined ? null : money2(value);
}

export function statusLabel(status: ProcessStatus): string {
  return PROCESS_STATUS_LABELS[status];
}

export function fullName(e: { firstName: string; lastName: string }): string {
  return `${e.firstName} ${e.lastName}`;
}

/** `@db.Date` filter for a date range param (either end optional). */
export function dateRange(from?: BusinessDate, to?: BusinessDate): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: dateFromBusiness(from) } : {}),
    ...(to ? { lte: dateFromBusiness(to) } : {}),
  };
}

/** Timestamp filter for a business date range: Windhoek midnight of `from` up to the end of `to`. */
export function timestampRange(from?: BusinessDate, to?: BusinessDate): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: fromZonedTime(`${from}T00:00:00`, BUSINESS_TIMEZONE) } : {}),
    ...(to ? { lt: fromZonedTime(`${addDays(to, 1)}T00:00:00`, BUSINESS_TIMEZONE) } : {}),
  };
}

/** The years' first and last day when a report defaults to "this year". */
export function thisYear(today: BusinessDate): { from: BusinessDate; to: BusinessDate } {
  const year = today.slice(0, 4);
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/** Display names of users ("{First} {Last}", else the username), for approver and actor columns. */
export async function userNames(
  prisma: AppPrismaClient,
  ids: Iterable<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))];
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, username: true, employee: { select: { firstName: true, lastName: true } } },
  });
  return new Map(users.map((u) => [u.id, u.employee ? fullName(u.employee) : u.username]));
}

/** The employee columns most reports start with. */
export const EMPLOYEE_REF_SELECT = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  companyRule: { select: { description: true } },
} satisfies Prisma.EmployeeSelect;

export type EmployeeRef = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_REF_SELECT }>;

export function employeeCells(e: EmployeeRef): { employeeCode: string; employeeName: string } {
  return { employeeCode: e.employeeCode, employeeName: fullName(e) };
}

/** Ids of the in-scope employees, in batches (for queries that group by employee). */
export function employeeBatches(
  prisma: AppPrismaClient,
  where: Prisma.EmployeeWhereInput,
  batchSize: number,
): AsyncGenerator<EmployeeRef[]> {
  return batches(
    (page) =>
      prisma.employee.findMany({
        where,
        select: EMPLOYEE_REF_SELECT,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        ...page,
      }),
    batchSize,
  );
}
