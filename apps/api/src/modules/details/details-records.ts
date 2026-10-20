import { Injectable } from '@nestjs/common';
import type {
  Address as AddressRow,
  AddressType,
  ContactDetail,
  ContactType,
  PostalServiceType,
} from '@prisma/client';
import {
  type Address,
  addDays,
  type BusinessDate,
  businessFromDate,
  CONTACT_TYPE_LABELS,
  type ContactNumbers,
  dateFromBusiness,
  type OtherContact,
  todayBusinessDate,
} from '@peoplehub/shared';
import type { SecurityContext } from '../../common/context/security-context';
import { NotFoundError } from '../../common/errors/domain-errors';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { ScopeService, type ScopedEmployee } from '../auth/scope.service';

// Building blocks shared by the My Details services: the "/me" employee, address and contact
// rows in the shape of the forms, and the next open pay period.

/** The physical and work address fields (section 5.4.1). */
export const ADDRESS_FIELDS = [
  'unitNumber',
  'block',
  'complex',
  'levelFloor',
  'streetNumber',
  'streetName',
  'suburb',
  'city',
  'postalCode',
  'country',
  'province',
  'district',
  'careOfName',
] as const;
export type AddressField = (typeof ADDRESS_FIELDS)[number];

/** The postal address fields besides `sameAs`. */
export const POSTAL_FIELDS = [
  'serviceType',
  'postalAddressNumber',
  'suburb',
  'city',
  'postalCode',
  'country',
  'province',
  'district',
  'careOfName',
] as const;
export type PostalField = (typeof POSTAL_FIELDS)[number];

export type PhysicalState = { [K in AddressField]: string | null };
export type PostalState = { sameAs: 'PHYSICAL' | null } & { [K in PostalField]: string | null };
export type WorkState = { sameAs: 'PHYSICAL' | 'POSTAL' | null } & PhysicalState;

export function physicalState(row: AddressRow | undefined): PhysicalState {
  return Object.fromEntries(ADDRESS_FIELDS.map((f) => [f, row?.[f] ?? null])) as PhysicalState;
}

export function postalState(row: AddressRow | undefined): PostalState {
  return {
    sameAs: row?.sameAs === 'PHYSICAL' ? 'PHYSICAL' : null,
    ...(Object.fromEntries(POSTAL_FIELDS.map((f) => [f, row?.[f] ?? null])) as {
      [K in PostalField]: string | null;
    }),
  };
}

export function workState(row: AddressRow | undefined): WorkState {
  const sameAs = row?.sameAs === 'PHYSICAL' || row?.sameAs === 'POSTAL' ? row.sameAs : null;
  return { sameAs, ...physicalState(row) };
}

/** With "Same As", the address keeps no fields of its own. */
export function withoutOwnFields<T extends object>(input: T, fields: readonly string[]): T {
  if (!(input as { sameAs?: unknown }).sameAs) return input;
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const f of fields) out[f] = null;
  return out as T;
}

/** Prisma data of an address row from its state (every column, so an update is complete). */
export function addressData(
  type: AddressType,
  state: object,
): {
  type: AddressType;
  sameAs: AddressType | null;
  serviceType: PostalServiceType | null;
} & { [K in AddressField | 'postalAddressNumber']: string | null } {
  const value = (key: string): string | null => {
    const v = (state as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : null;
  };
  return {
    type,
    sameAs: (value('sameAs') as AddressType | null) ?? null,
    serviceType: type === 'POSTAL' ? ((value('serviceType') as PostalServiceType | null) ?? null) : null,
    postalAddressNumber: type === 'POSTAL' ? value('postalAddressNumber') : null,
    ...(Object.fromEntries(ADDRESS_FIELDS.map((f) => [f, value(f)])) as {
      [K in AddressField]: string | null;
    }),
  };
}

const EMPTY_ADDRESS = (type: AddressType): Address => ({
  type,
  sameAs: null,
  unitNumber: null,
  block: null,
  complex: null,
  levelFloor: null,
  streetNumber: null,
  streetName: null,
  suburb: null,
  city: null,
  postalCode: null,
  country: null,
  province: null,
  district: null,
  careOfName: null,
  serviceType: null,
  postalAddressNumber: null,
});

/**
 * The address as shown: with "Same As", the fields of the referenced address (work may point at a
 * postal address that is itself the same as the physical one).
 */
export function addressDto(type: AddressType, rows: readonly AddressRow[]): Address {
  const byType = new Map(rows.map((r) => [r.type, r]));
  const own = byType.get(type);
  if (!own) return EMPTY_ADDRESS(type);
  let source = own;
  for (let hop = 0; hop < 2 && source.sameAs && source.sameAs !== source.type; hop++) {
    const next = byType.get(source.sameAs);
    if (!next) break;
    source = next;
  }
  const out: Address = { ...EMPTY_ADDRESS(type), sameAs: own.sameAs };
  for (const f of ADDRESS_FIELDS) out[f] = source[f];
  out.serviceType = source.serviceType;
  out.postalAddressNumber = source.postalAddressNumber;
  return out;
}

// ───────────── Contacts ─────────────

export const CONTACT_KEYS = { cell: 'CELL', email: 'EMAIL', fax: 'FAX', home: 'HOME', work: 'WORK' } as const;
export type ContactKey = keyof typeof CONTACT_KEYS;
export type ContactsState = { [K in ContactKey]: string | null };
export type OtherContactState = { type: ContactType; value: string };

function live(rows: readonly ContactDetail[]): ContactDetail[] {
  return rows.filter((r) => r.deletedAt === null).sort((a, b) => a.id - b.id);
}

/** Cell / E-Mail / Fax / Home / Work: the primary row of each type. */
export function contactsState(rows: readonly ContactDetail[]): ContactsState {
  const primary = live(rows).filter((r) => r.isPrimary);
  const out = {} as ContactsState;
  for (const [key, type] of Object.entries(CONTACT_KEYS) as [ContactKey, ContactType][]) {
    out[key] = primary.find((r) => r.type === type)?.value ?? null;
  }
  return out;
}

export function contactsDto(rows: readonly ContactDetail[]): ContactNumbers {
  return contactsState(rows);
}

/** "Other Contact Details": the non-primary rows in entry order. */
export function otherContactsState(rows: readonly ContactDetail[]): OtherContactState[] {
  return live(rows)
    .filter((r) => !r.isPrimary)
    .map((r) => ({ type: r.type, value: r.value }));
}

export function otherContactsDto(rows: readonly ContactDetail[]): OtherContact[] {
  return live(rows)
    .filter((r) => !r.isPrimary)
    .map((r) => ({ id: r.id, type: r.type, typeLabel: CONTACT_TYPE_LABELS[r.type], value: r.value }));
}

export type ContactOwner = { employeeId: number } | { familyMemberId: number };

/** Writes the changed primary contacts: update, create, or soft-delete when cleared. */
export async function writePrimaryContacts(
  tx: Tx,
  owner: ContactOwner,
  rows: readonly ContactDetail[],
  patch: Partial<ContactsState>,
  now: Date,
): Promise<void> {
  const primary = live(rows).filter((r) => r.isPrimary);
  for (const [key, value] of Object.entries(patch) as [ContactKey, string | null | undefined][]) {
    if (value === undefined) continue;
    const type = CONTACT_KEYS[key];
    const existing = primary.find((r) => r.type === type);
    if (existing && value === null) {
      await tx.contactDetail.update({ where: { id: existing.id }, data: { deletedAt: now } });
    } else if (existing && value !== null) {
      await tx.contactDetail.update({ where: { id: existing.id }, data: { value } });
    } else if (value !== null) {
      await tx.contactDetail.create({ data: { ...owner, type, value, isPrimary: true } });
    }
  }
}

/** Replaces the "Other Contact Details" rows: unchanged rows stay, the rest are soft-deleted. */
export async function writeOtherContacts(
  tx: Tx,
  owner: ContactOwner,
  rows: readonly ContactDetail[],
  next: readonly OtherContactState[],
  now: Date,
): Promise<void> {
  const remaining = live(rows).filter((r) => !r.isPrimary);
  for (const item of next) {
    const index = remaining.findIndex((r) => r.type === item.type && r.value === item.value);
    if (index >= 0) {
      remaining.splice(index, 1);
      continue;
    }
    await tx.contactDetail.create({
      data: { ...owner, type: item.type, value: item.value, isPrimary: false },
    });
  }
  for (const row of remaining) {
    await tx.contactDetail.update({ where: { id: row.id }, data: { deletedAt: now } });
  }
}

// ───────────── Access and pay periods ─────────────

export interface MeEmployee extends ScopedEmployee {
  firstName: string;
  lastName: string;
  entityCode: string;
}

/**
 * `/me` is the "Working as" employee (section 12.5), checked with the "Working as" rule on every
 * request. Users without an employee record get 404.
 */
@Injectable()
export class DetailsAccess {
  constructor(
    private readonly db: DbService,
    private readonly scope: ScopeService,
  ) {}

  async me(ctx: SecurityContext, client: Tx = this.db.prisma): Promise<MeEmployee> {
    if (!ctx.actingAsEmployeeId) throw new NotFoundError('Employee', 'Your user has no employee record');
    return this.employee(ctx, ctx.actingAsEmployeeId, 'SELF_SERVICE', client);
  }

  async employee(
    ctx: SecurityContext,
    employeeId: number,
    purpose: 'SELF_SERVICE' | 'HR_READ' | 'HR_WRITE' | 'PAYROLL',
    client: Tx = this.db.prisma,
  ): Promise<MeEmployee> {
    const scoped = await this.scope.assertCanAccessEmployee(ctx, employeeId, purpose, client);
    const names = await client.employee.findUniqueOrThrow({
      where: { id: scoped.id },
      select: { firstName: true, lastName: true, entityCode: true },
    });
    return { ...scoped, ...names };
  }
}

/**
 * The start of the next open pay period of a company rule (section 5.4.2: a new bank account is
 * active from there); today when no later open period exists (ASSUMPTION B103).
 */
export async function nextOpenPeriodStart(
  client: Tx,
  companyRuleId: number,
  today: BusinessDate = todayBusinessDate(),
): Promise<BusinessDate> {
  const period = await client.payPeriod.findFirst({
    where: { companyRuleId, isClosed: false, startDate: { gt: dateFromBusiness(today) } },
    orderBy: { startDate: 'asc' },
    select: { startDate: true },
  });
  return period ? businessFromDate(period.startDate) : today;
}

export function dayBefore(date: BusinessDate): BusinessDate {
  return addDays(date, -1);
}
