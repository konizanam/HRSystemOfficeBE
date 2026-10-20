import { Injectable } from '@nestjs/common';
import type {
  Address as AddressRow,
  AddressType,
  ChangeRequest,
  ContactDetail,
  Employee,
  Prisma,
} from '@prisma/client';
import {
  type AdminPersonalDetailsUpdateResponse,
  ageFromDateOfBirth,
  applyPatch,
  buildChangeDiff,
  businessFromDate,
  type ChangeRequestSubmitResponse,
  changeFieldLabel,
  dateFromBusiness,
  dateOfBirthIssue,
  type FieldIssue,
  type LookupTable,
  maskLast4,
  namibianIdWarnings,
  patchPaths,
  type PersonalDetails,
  type PersonalIdNumbers,
  todayBusinessDate,
  type UpdatePersonalDetailsRequest,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import { isActingForOther, type SecurityContext } from '../../common/context/security-context';
import { assertVersion, ValidationError } from '../../common/errors/domain-errors';
import { EncryptionService } from '../../crypto/encryption.service';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { AttachmentService } from '../attachments/attachment.service';
import { ScopeService } from '../auth/scope.service';
import type { ChangeApplier } from './change-request.service';
import { ChangeRequestService } from './change-request.service';
import {
  ADDRESS_FIELDS,
  addressData,
  addressDto,
  contactsDto,
  contactsState,
  type ContactsState,
  DetailsAccess,
  otherContactsDto,
  otherContactsState,
  type OtherContactState,
  physicalState,
  type PhysicalState,
  POSTAL_FIELDS,
  postalState,
  type PostalState,
  withoutOwnFields,
  workState,
  type WorkState,
  writeOtherContacts,
  writePrimaryContacts,
} from './details-records';
import { LookupService } from './lookup.service';
import { isSealed, isSensitiveLeaf, masked, maskedText, seal, type SealedValue } from './sealed';

/** Owner entity of documents HR attaches to a direct edit. */
export const EMPLOYEE_ENTITY = 'Employee';

/** Encrypted identity numbers and their columns (section 0.7). */
const SENSITIVE = {
  identityNumber: ['identityNumberEnc', 'identityNumberLast4'],
  passportNumber: ['passportNumberEnc', 'passportNumberLast4'],
  taxNumber: ['taxNumberEnc', 'taxNumberLast4'],
  birthCertificateNumber: ['birthCertificateNumberEnc', 'birthCertificateNumberLast4'],
} as const;
type SensitiveKey = keyof typeof SENSITIVE;
const SENSITIVE_KEYS = Object.keys(SENSITIVE) as SensitiveKey[];

/** Plain identity columns, in form order. `lastName` is the Surname. */
const PLAIN_IDENTITY = [
  'title',
  'initials',
  'lastName',
  'firstName',
  'secondName',
  'otherNames',
  'knownAs',
  'maidenName',
  'dateOfBirth',
  'identityType',
  'countryOfBirth',
  'passportCountry',
  'nationality',
  'cityOfBirth',
  'homeLanguage',
  'gender',
  'maritalStatus',
  'bloodGroup',
  'religion',
] as const;
type PlainIdentityKey = (typeof PLAIN_IDENTITY)[number];

const IDENTITY_LOOKUPS: [key: string, table: LookupTable][] = [
  ['title', 'titles'],
  ['homeLanguage', 'languages'],
  ['gender', 'genders'],
  ['maritalStatus', 'marital'],
  ['bloodGroup', 'bloodGroups'],
  ['religion', 'religions'],
  ['identityType', 'identityTypes'],
  ['countryOfBirth', 'countries'],
  ['passportCountry', 'countries'],
  ['nationality', 'countries'],
];

const ADDRESS_SECTIONS: [section: 'physicalAddress' | 'postalAddress' | 'workAddress', type: AddressType][] =
  [
    ['physicalAddress', 'PHYSICAL'],
    ['postalAddress', 'POSTAL'],
    ['workAddress', 'WORK'],
  ];

type IdentityState = Record<PlainIdentityKey | SensitiveKey, string | null>;

/** The personal details in the shape of the form, with the identity numbers in plaintext. */
export interface PersonalState extends Record<string, unknown> {
  identity: IdentityState;
  physicalAddress: PhysicalState;
  postalAddress: PostalState;
  workAddress: WorkState;
  correspondenceAddressType: AddressType | null;
  contacts: ContactsState;
  otherContacts: OtherContactState[];
}

type PersonalInput = Omit<UpdatePersonalDetailsRequest, 'version' | 'attachmentIds' | 'comment'>;

interface Loaded {
  employee: Employee;
  addresses: AddressRow[];
  contacts: ContactDetail[];
  state: PersonalState;
}

export interface WriteMeta {
  source: 'CHANGE_REQUEST' | 'HR_EDIT';
  changeRequestId?: number;
  referenceNumber?: string;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Personal Details (section 5.4.1). Employees change them through a BASICINF change request; HR
 * edits them directly. Both paths end in {@link write}, so the validation and the audit row
 * (`EMPLOYEE.PERSONAL_DETAILS_UPDATED`) are the same. The personal details version is
 * `Employee.version`, bumped by every write.
 */
@Injectable()
export class PersonalDetailsService implements ChangeApplier {
  readonly entityType = 'Employee' as const;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly crypto: EncryptionService,
    private readonly scope: ScopeService,
    private readonly access: DetailsAccess,
    private readonly changes: ChangeRequestService,
    private readonly attachments: AttachmentService,
    private readonly lookups: LookupService,
  ) {}

  // ───────────── Reads ─────────────

  /** GET /me/personal. HR or a manager "Working as" the employee is audited (section 9.1). */
  async getMine(ctx: SecurityContext): Promise<PersonalDetails> {
    const me = await this.access.me(ctx);
    const dto = await this.read(ctx, me.id);
    if (isActingForOther(ctx)) await this.auditView(ctx, me.id, 'ME');
    return dto;
  }

  /** GET /admin/employees/:id/personal (HR and Payroll in scope), audited DATA_VIEW.PERSONAL_DETAILS. */
  async getForAdmin(ctx: SecurityContext, employeeId: number): Promise<PersonalDetails> {
    await this.access.employee(ctx, employeeId, 'HR_READ');
    const dto = await this.read(ctx, employeeId);
    await this.auditView(ctx, employeeId, 'ADMIN');
    return dto;
  }

  /** GET /me/personal/id-numbers: refused while working as someone else (ID_NUMBERS). */
  async idNumbers(ctx: SecurityContext): Promise<PersonalIdNumbers> {
    const me = await this.access.me(ctx);
    await this.scope.assertNotRestricted(ctx, 'ID_NUMBERS');
    const e = await this.db.prisma.employee.findUniqueOrThrow({ where: { id: me.id } });
    await this.audit.recordStandalone(ctx, {
      category: 'DATA_VIEW',
      action: 'DATA_VIEW.ID_NUMBERS_UNMASKED',
      entityType: 'Employee',
      entityId: me.id,
      subjectEmployeeId: me.id,
      metadata: { fields: SENSITIVE_KEYS.filter((k) => e[SENSITIVE[k][0]] !== null) },
    });
    return {
      employeeId: me.id,
      identityNumber: this.crypto.decryptNullable(e.identityNumberEnc),
      passportNumber: this.crypto.decryptNullable(e.passportNumberEnc),
      taxNumber: this.crypto.decryptNullable(e.taxNumberEnc),
      birthCertificateNumber: this.crypto.decryptNullable(e.birthCertificateNumberEnc),
    };
  }

  private async auditView(ctx: SecurityContext, employeeId: number, via: 'ME' | 'ADMIN'): Promise<void> {
    await this.audit.recordStandalone(ctx, {
      category: 'DATA_VIEW',
      action: 'DATA_VIEW.PERSONAL_DETAILS',
      entityType: 'Employee',
      entityId: employeeId,
      subjectEmployeeId: employeeId,
      metadata: { via },
    });
  }

  async read(
    ctx: SecurityContext,
    employeeId: number,
    client: Tx = this.db.prisma,
  ): Promise<PersonalDetails> {
    const { employee: e, addresses, contacts, state } = await this.load(client, employeeId);
    const restricted = (await this.scope.restrictedFeatures(ctx)).includes('ID_NUMBERS');
    const pending = await this.changes.pendingFor(client, employeeId, 'Employee');
    const dob = e.dateOfBirth ? businessFromDate(e.dateOfBirth) : null;
    return {
      employeeId: e.id,
      employeeCode: e.employeeCode,
      displayName: `${e.firstName} ${e.lastName}`,
      version: e.version,
      identity: {
        title: e.title,
        initials: e.initials,
        lastName: e.lastName,
        firstName: e.firstName,
        secondName: e.secondName,
        otherNames: e.otherNames,
        knownAs: e.knownAs,
        maidenName: e.maidenName,
        entityCode: e.entityCode,
        identityNumberMasked: maskLast4(e.identityNumberLast4) || null,
        dateOfBirth: dob,
        age: ageFromDateOfBirth(dob, todayBusinessDate()),
        identityType: e.identityType,
        countryOfBirth: e.countryOfBirth,
        passportNumberMasked: maskLast4(e.passportNumberLast4) || null,
        passportCountry: e.passportCountry,
        taxNumberMasked: maskLast4(e.taxNumberLast4) || null,
        nationality: e.nationality,
        birthCertificateNumberMasked: maskLast4(e.birthCertificateNumberLast4) || null,
        cityOfBirth: e.cityOfBirth,
        homeLanguage: e.homeLanguage,
        gender: e.gender,
        maritalStatus: e.maritalStatus,
        bloodGroup: e.bloodGroup,
        religion: e.religion,
      },
      physicalAddress: addressDto('PHYSICAL', addresses),
      postalAddress: addressDto('POSTAL', addresses),
      workAddress: addressDto('WORK', addresses),
      correspondenceAddressType: e.correspondenceAddressType,
      contacts: contactsDto(contacts),
      otherContacts: otherContactsDto(contacts),
      idNumbersRestricted: restricted,
      warnings: this.warnings(state),
      pendingChange: pending.get(String(employeeId)) ?? null,
    };
  }

  private async load(client: Tx, employeeId: number): Promise<Loaded> {
    const employee = await client.employee.findUniqueOrThrow({ where: { id: employeeId } });
    const [addresses, contacts] = await Promise.all([
      client.address.findMany({ where: { employeeId } }),
      client.contactDetail.findMany({ where: { employeeId, deletedAt: null }, orderBy: { id: 'asc' } }),
    ]);
    const byType = new Map(addresses.map((a) => [a.type, a]));
    const identity = {} as IdentityState;
    for (const key of PLAIN_IDENTITY) {
      const value = employee[key];
      identity[key] = value instanceof Date ? businessFromDate(value) : (value ?? null);
    }
    for (const key of SENSITIVE_KEYS)
      identity[key] = this.crypto.decryptNullable(employee[SENSITIVE[key][0]]);
    return {
      employee,
      addresses,
      contacts,
      state: {
        identity,
        physicalAddress: physicalState(byType.get('PHYSICAL')),
        postalAddress: postalState(byType.get('POSTAL')),
        workAddress: workState(byType.get('WORK')),
        correspondenceAddressType: employee.correspondenceAddressType,
        contacts: contactsState(contacts),
        otherContacts: otherContactsState(contacts),
      },
    };
  }

  private warnings(state: PersonalState): FieldIssue[] {
    return namibianIdWarnings({
      identityNumber: state.identity.identityNumber,
      dateOfBirth: state.identity.dateOfBirth,
      identityType: state.identity.identityType,
      nationality: state.identity.nationality,
    });
  }

  // ───────────── Diff and validation ─────────────

  /** The changed fields of a form against the stored details; identity numbers sealed. */
  private diff(
    state: PersonalState,
    input: PersonalInput,
  ): { patch: Record<string, unknown>; previous: Record<string, unknown>; paths: string[] } {
    const proposed: Record<string, unknown> = { ...input };
    if (input.postalAddress) proposed.postalAddress = withoutOwnFields(input.postalAddress, POSTAL_FIELDS);
    if (input.workAddress) proposed.workAddress = withoutOwnFields(input.workAddress, ADDRESS_FIELDS);
    const diff = buildChangeDiff(state, proposed);
    const identity = rec(diff.patch.identity);
    const before = rec(diff.previous.identity);
    for (const key of SENSITIVE_KEYS) {
      if (!(key in identity)) continue;
      identity[key] = seal(this.crypto, identity[key] as string | null);
      before[key] = masked(before[key] as string | null);
    }
    return diff;
  }

  /** The stored state with a (sealed) patch applied, identity numbers in plaintext. */
  private merge(state: PersonalState, patch: Record<string, unknown>): PersonalState {
    const plain: Record<string, unknown> = { ...patch };
    if (patch.identity) {
      const identity = { ...rec(patch.identity) };
      for (const key of SENSITIVE_KEYS) {
        const value = identity[key];
        if (isSealed(value)) identity[key] = this.crypto.decrypt(value.valueEnc);
      }
      plain.identity = identity;
    }
    return applyPatch(state, plain);
  }

  /** Validation shared by submit and apply: lookups of the changed fields, names, DOB, correspondence. */
  private async validate(client: Tx, patch: Record<string, unknown>, merged: PersonalState): Promise<void> {
    const identity = rec(patch.identity);
    const checks: [LookupTable, string | null | undefined, string][] = IDENTITY_LOOKUPS.map(
      ([key, table]) => [table, identity[key] as string | null | undefined, `identity.${key}`],
    );
    for (const [section] of ADDRESS_SECTIONS) {
      const country = rec(patch[section]).country as string | null | undefined;
      checks.push(['countries', country, `${section}.country`]);
    }
    await this.lookups.assertValid(client, checks);

    const errors: FieldIssue[] = [];
    if (!merged.identity.lastName)
      errors.push({ path: 'identity.lastName', message: 'The surname is required' });
    if (!merged.identity.firstName)
      errors.push({ path: 'identity.firstName', message: 'The first name is required' });
    if (typeof identity.dateOfBirth === 'string') {
      const issue = dateOfBirthIssue(identity.dateOfBirth, todayBusinessDate());
      if (issue) errors.push({ path: 'identity.dateOfBirth', message: issue });
    }
    const corr = merged.correspondenceAddressType;
    if ('correspondenceAddressType' in patch && corr) {
      const section = ADDRESS_SECTIONS.find(([, type]) => type === corr)?.[0];
      const address = section ? rec(merged[section]) : {};
      const hasDetails =
        Object.entries(address).some(([k, v]) => k !== 'sameAs' && v !== null) || !!address.sameAs;
      if (!hasDetails) {
        errors.push({ path: 'correspondenceAddressType', message: 'This address has no details yet' });
      }
    }
    if (errors.length > 0) throw new ValidationError(errors);
  }

  // ───────────── Submits ─────────────

  /** PUT /me/personal → a BASICINF change request with only the changed fields. */
  async submitMine(
    ctx: SecurityContext,
    body: UpdatePersonalDetailsRequest,
  ): Promise<ChangeRequestSubmitResponse> {
    return this.db.tx(ctx, async (tx) => {
      const me = await this.access.me(ctx, tx);
      await this.db.lockRow(tx, 'Employee', me.id);
      const loaded = await this.load(tx, me.id);
      assertVersion(loaded.employee, body.version);
      await this.changes.assertNoOpen(tx, me.id, 'Employee', me.id);
      const { version: _v, attachmentIds, comment, ...input } = body;
      const diff = this.diff(loaded.state, input);
      this.changes.assertHasChanges(diff.paths);
      const merged = this.merge(loaded.state, diff.patch);
      await this.validate(tx, diff.patch, merged);
      const changeRequest = await this.changes.submit(ctx, {
        employeeId: me.id,
        entityType: 'Employee',
        entityId: me.id,
        operation: 'UPDATE',
        patch: diff.patch,
        previous: diff.previous,
        baseVersion: loaded.employee.version,
        summary: `Personal details: ${summaryOf(diff.paths)}`,
        attachmentIds,
        comment,
      });
      return { changeRequest, warnings: this.warnings(merged) };
    });
  }

  /** PUT /admin/employees/:id/personal: HR applies directly through the same {@link write}. */
  async updateAsHr(
    ctx: SecurityContext,
    employeeId: number,
    body: UpdatePersonalDetailsRequest,
  ): Promise<AdminPersonalDetailsUpdateResponse> {
    return this.db.tx(ctx, async (tx) => {
      await this.access.employee(ctx, employeeId, 'HR_WRITE', tx);
      await this.db.lockRow(tx, 'Employee', employeeId);
      const loaded = await this.load(tx, employeeId);
      assertVersion(loaded.employee, body.version);
      const { version: _v, attachmentIds, comment, ...input } = body;
      const diff = this.diff(loaded.state, input);
      this.changes.assertHasChanges(diff.paths);
      const merged = await this.write(tx, ctx, employeeId, diff.patch, { source: 'HR_EDIT' }, comment);
      if (attachmentIds?.length) {
        await this.attachments.bind(tx, ctx, attachmentIds, {
          entity: EMPLOYEE_ENTITY,
          entityId: employeeId,
          subjectEmployeeId: employeeId,
        });
      }
      return {
        personal: await this.read(ctx, employeeId, tx),
        warnings: this.warnings(merged),
        changedFields: diff.paths,
      };
    });
  }

  // ───────────── The domain write (HR edits and approved change requests) ─────────────

  /**
   * Writes a patch of changed fields (identity numbers sealed): validates, updates the employee,
   * addresses and contacts, bumps `Employee.version` and audits `EMPLOYEE.PERSONAL_DETAILS_UPDATED`.
   * The caller holds the employee row lock.
   */
  async write(
    tx: Tx,
    ctx: SecurityContext,
    employeeId: number,
    patch: Record<string, unknown>,
    meta: WriteMeta,
    reason?: string | null,
  ): Promise<PersonalState> {
    const loaded = await this.load(tx, employeeId);
    const merged = this.merge(loaded.state, patch);
    await this.validate(tx, patch, merged);
    const now = new Date();

    const data: Prisma.EmployeeUncheckedUpdateInput = { version: { increment: 1 } };
    const identity = rec(patch.identity);
    for (const [key, value] of Object.entries(identity)) {
      if ((SENSITIVE_KEYS as string[]).includes(key)) {
        const sealed = isSealed(value) ? (value as SealedValue) : null;
        const [encColumn, last4Column] = SENSITIVE[key as SensitiveKey];
        data[encColumn] = sealed?.valueEnc ?? null;
        data[last4Column] = sealed?.last4 ?? null;
      } else if (key === 'dateOfBirth') {
        data.dateOfBirth = typeof value === 'string' ? dateFromBusiness(value) : null;
      } else if ((PLAIN_IDENTITY as readonly string[]).includes(key)) {
        (data as Record<string, unknown>)[key] = value;
      }
    }
    if ('correspondenceAddressType' in patch)
      data.correspondenceAddressType = merged.correspondenceAddressType;
    await tx.employee.update({ where: { id: employeeId }, data });

    for (const [section, type] of ADDRESS_SECTIONS) {
      if (!patch[section]) continue;
      const fields = addressData(
        type,
        withoutOwnFields(merged[section], type === 'POSTAL' ? POSTAL_FIELDS : ADDRESS_FIELDS),
      );
      await tx.address.upsert({
        where: { employeeId_type: { employeeId, type } },
        create: { employeeId, ...fields },
        update: { ...fields, version: { increment: 1 } },
      });
    }
    if (patch.contacts) {
      await writePrimaryContacts(
        tx,
        { employeeId },
        loaded.contacts,
        rec(patch.contacts) as Partial<ContactsState>,
        now,
      );
    }
    if (Array.isArray(patch.otherContacts)) {
      await writeOtherContacts(tx, { employeeId }, loaded.contacts, merged.otherContacts, now);
    }

    const beforeView = auditView(loaded.state);
    const afterView = auditView(merged);
    const paths = patchPaths(patch, isSensitiveLeaf);
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: 'EMPLOYEE.PERSONAL_DETAILS_UPDATED',
      entityType: 'Employee',
      entityId: employeeId,
      subjectEmployeeId: employeeId,
      before: beforeView,
      after: afterView,
      changes: paths.map((path) => ({
        path,
        from: (valueAt(beforeView, path) ?? null) as never,
        to: (valueAt(afterView, path) ?? null) as never,
      })),
      reason: reason ?? null,
      metadata: { ...meta, fields: paths },
    });
    return merged;
  }

  // ───────────── ChangeApplier ─────────────

  async conflict(tx: Tx, cr: ChangeRequest): Promise<string | null> {
    const employee = await tx.employee.findUnique({
      where: { id: cr.employeeId },
      select: { version: true, deletedAt: true },
    });
    if (!employee || employee.deletedAt) return 'The employee record no longer exists';
    if (employee.version !== cr.baseVersion) {
      return `The personal details changed after this request was submitted (version ${cr.baseVersion ?? '?'} → ${employee.version})`;
    }
    return null;
  }

  async apply(tx: Tx, ctx: SecurityContext, cr: ChangeRequest): Promise<string> {
    await this.write(tx, ctx, cr.employeeId, rec(cr.proposed), {
      source: 'CHANGE_REQUEST',
      changeRequestId: cr.id,
      referenceNumber: cr.referenceNumber,
    });
    return String(cr.employeeId);
  }
}

/** "Surname, Cell Number and 2 more". */
export function summaryOf(paths: readonly string[]): string {
  const labels = [...new Set(paths.map(changeFieldLabel))];
  if (labels.length <= 3) return labels.join(', ');
  return `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more`;
}

function valueAt(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split('.')) current = rec(current)[part];
  return current;
}

/** The personal details as audited: identity numbers masked (section 9.5). */
function auditView(state: PersonalState): Record<string, unknown> {
  const identity: Record<string, unknown> = { ...state.identity };
  for (const key of SENSITIVE_KEYS) identity[key] = maskedText(state.identity[key]);
  return { ...state, identity };
}
