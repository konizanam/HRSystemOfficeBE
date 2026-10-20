import { Injectable } from '@nestjs/common';
import type {
  Address as AddressRow,
  AddressType,
  ChangeRequest,
  ContactDetail,
  FamilyMember,
  Prisma,
} from '@prisma/client';
import {
  ageFromDateOfBirth,
  applyPatch,
  buildChangeDiff,
  businessFromDate,
  type ChangeRequestSubmitResponse,
  type CreateFamilyMemberRequest,
  dateFromBusiness,
  dateOfBirthIssue,
  type DeleteDetailRequest,
  FAMILY_EMPTY_TEXT,
  type FamilyMember as FamilyMemberDto,
  type FamilyMembersResponse,
  type FieldIssue,
  type LookupTable,
  maskLast4,
  namibianIdWarnings,
  type PendingChange,
  todayBusinessDate,
  type UpdateFamilyMemberRequest,
} from '@peoplehub/shared';
import { AuditService } from '../../audit/audit.service';
import type { SecurityContext } from '../../common/context/security-context';
import { assertVersion, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { EncryptionService } from '../../crypto/encryption.service';
import { DbService } from '../../prisma/db.service';
import type { Tx } from '../../prisma/prisma-client';
import { type ChangeApplier, ChangeRequestService } from './change-request.service';
import {
  addressData,
  addressDto,
  contactsDto,
  contactsState,
  type ContactsState,
  DetailsAccess,
  physicalState,
  type PhysicalState,
  POSTAL_FIELDS,
  postalState,
  type PostalState,
  withoutOwnFields,
  writePrimaryContacts,
} from './details-records';
import { LookupService } from './lookup.service';
import { isSealed, masked, seal } from './sealed';

const PLAIN_FIELDS = [
  'relationship',
  'title',
  'initials',
  'firstName',
  'secondName',
  'otherNames',
  'lastName',
  'knownAs',
  'gender',
  'nationality',
  'isEmergencyContact',
  'emergencyDetail',
] as const;

const ADDRESS_SECTIONS: [section: 'physicalAddress' | 'postalAddress', type: AddressType][] = [
  ['physicalAddress', 'PHYSICAL'],
  ['postalAddress', 'POSTAL'],
];

/** A family member in the shape of the form, ID number in plaintext. */
interface FamilyState extends Record<string, unknown> {
  relationship: string;
  title: string | null;
  initials: string | null;
  firstName: string;
  secondName: string | null;
  otherNames: string | null;
  lastName: string;
  knownAs: string | null;
  identityNumber: string | null;
  gender: string | null;
  dateOfBirth: string | null;
  nationality: string | null;
  isEmergencyContact: boolean;
  emergencyDetail: string | null;
  physicalAddress: PhysicalState;
  postalAddress: PostalState;
  contacts: ContactsState;
}

type MemberRow = FamilyMember & { addresses: AddressRow[]; contacts: ContactDetail[] };

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const MEMBER_INCLUDE = {
  addresses: true,
  contacts: { where: { deletedAt: null }, orderBy: { id: 'asc' } },
} as const satisfies Prisma.FamilyMemberInclude;

/**
 * Family Details (section 5.4.4). Add, edit and delete are change requests through the BASICINF
 * workflow (ASSUMPTION A16), applied on approval; a delete is a soft delete. The age is calculated
 * by the server; ID numbers are encrypted with a masked last4.
 */
@Injectable()
export class FamilyService implements ChangeApplier {
  readonly entityType = 'FamilyMember' as const;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly crypto: EncryptionService,
    private readonly access: DetailsAccess,
    private readonly changes: ChangeRequestService,
    private readonly lookups: LookupService,
  ) {}

  async listMine(ctx: SecurityContext): Promise<FamilyMembersResponse> {
    const me = await this.access.me(ctx);
    const prisma = this.db.prisma;
    const [rows, pending] = await Promise.all([
      prisma.familyMember.findMany({
        where: { employeeId: me.id, deletedAt: null },
        include: MEMBER_INCLUDE,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
      }),
      this.changes.pendingFor(prisma, me.id, 'FamilyMember'),
    ]);
    return {
      employeeId: me.id,
      items: rows.map((r) => this.dto(r, pending.get(String(r.id)) ?? null)),
      emptyText: FAMILY_EMPTY_TEXT,
      pendingCreate: pending.get('') ?? null,
    };
  }

  private dto(row: MemberRow, pendingChange: PendingChange | null): FamilyMemberDto {
    const dob = row.dateOfBirth ? businessFromDate(row.dateOfBirth) : null;
    return {
      id: row.id,
      version: row.version,
      knownAs: row.knownAs,
      lastName: row.lastName,
      relationship: row.relationship,
      title: row.title,
      firstName: row.firstName,
      otherNames: row.otherNames,
      identityNumberMasked: maskLast4(row.identityNumberLast4) || null,
      gender: row.gender,
      initials: row.initials,
      secondName: row.secondName,
      dateOfBirth: dob,
      age: ageFromDateOfBirth(dob, todayBusinessDate()),
      nationality: row.nationality,
      isEmergencyContact: row.isEmergencyContact,
      emergencyDetail: row.emergencyDetail,
      physicalAddress: addressDto('PHYSICAL', row.addresses),
      postalAddress: addressDto('POSTAL', row.addresses),
      contacts: contactsDto(row.contacts),
      pendingChange,
    };
  }

  private state(row: MemberRow): FamilyState {
    const byType = new Map(row.addresses.map((a) => [a.type, a]));
    return {
      relationship: row.relationship,
      title: row.title,
      initials: row.initials,
      firstName: row.firstName,
      secondName: row.secondName,
      otherNames: row.otherNames,
      lastName: row.lastName,
      knownAs: row.knownAs,
      identityNumber: this.crypto.decryptNullable(row.identityNumberEnc),
      gender: row.gender,
      dateOfBirth: row.dateOfBirth ? businessFromDate(row.dateOfBirth) : null,
      nationality: row.nationality,
      isEmergencyContact: row.isEmergencyContact,
      emergencyDetail: row.emergencyDetail,
      physicalAddress: physicalState(byType.get('PHYSICAL')),
      postalAddress: postalState(byType.get('POSTAL')),
      contacts: contactsState(row.contacts),
    };
  }

  private emptyState(): FamilyState {
    return {
      relationship: '',
      title: null,
      initials: null,
      firstName: '',
      secondName: null,
      otherNames: null,
      lastName: '',
      knownAs: null,
      identityNumber: null,
      gender: null,
      dateOfBirth: null,
      nationality: null,
      isEmergencyContact: false,
      emergencyDetail: null,
      physicalAddress: physicalState(undefined),
      postalAddress: postalState(undefined),
      contacts: contactsState([]),
    };
  }

  private async validate(client: Tx, patch: Record<string, unknown>, merged: FamilyState): Promise<void> {
    const checks: [LookupTable, string | null | undefined, string][] = [
      ['relationships', patch.relationship as string | undefined, 'relationship'],
      ['titles', patch.title as string | null | undefined, 'title'],
      ['genders', patch.gender as string | null | undefined, 'gender'],
      ['countries', patch.nationality as string | null | undefined, 'nationality'],
    ];
    for (const [section] of ADDRESS_SECTIONS) {
      checks.push([
        'countries',
        rec(patch[section]).country as string | null | undefined,
        `${section}.country`,
      ]);
    }
    await this.lookups.assertValid(client, checks);
    const errors: FieldIssue[] = [];
    if (!merged.firstName) errors.push({ path: 'firstName', message: 'The first name is required' });
    if (!merged.lastName) errors.push({ path: 'lastName', message: 'The surname is required' });
    if (!merged.relationship) errors.push({ path: 'relationship', message: 'Pick a relationship' });
    if (typeof patch.dateOfBirth === 'string') {
      const issue = dateOfBirthIssue(patch.dateOfBirth, todayBusinessDate(), null);
      if (issue) errors.push({ path: 'dateOfBirth', message: issue });
    }
    if (errors.length > 0) throw new ValidationError(errors);
  }

  private warnings(state: FamilyState): FieldIssue[] {
    return namibianIdWarnings(
      {
        identityNumber: state.identityNumber,
        dateOfBirth: state.dateOfBirth,
        identityType: null,
        nationality: state.nationality,
      },
      'identityNumber',
    );
  }

  private proposedOf(input: Record<string, unknown>): Record<string, unknown> {
    const proposed = { ...input };
    if (input.postalAddress)
      proposed.postalAddress = withoutOwnFields(rec(input.postalAddress), POSTAL_FIELDS);
    return proposed;
  }

  private sealPatch(
    diff: { patch: Record<string, unknown>; previous: Record<string, unknown> },
    current: FamilyState | null,
  ): void {
    if (!('identityNumber' in diff.patch)) return;
    diff.patch.identityNumber = seal(this.crypto, diff.patch.identityNumber as string | null);
    diff.previous.identityNumber = masked(current?.identityNumber ?? null);
  }

  private async mine(tx: Tx, ctx: SecurityContext, id: number) {
    const me = await this.access.me(ctx, tx);
    await this.db.lockRow(tx, 'Employee', me.id);
    const row = await tx.familyMember.findUnique({ where: { id }, include: MEMBER_INCLUDE });
    if (!row || row.employeeId !== me.id || row.deletedAt) throw new NotFoundError('Family member');
    return { me, row };
  }

  async submitCreate(
    ctx: SecurityContext,
    body: CreateFamilyMemberRequest,
  ): Promise<ChangeRequestSubmitResponse> {
    return this.db.tx(ctx, async (tx) => {
      const me = await this.access.me(ctx, tx);
      await this.db.lockRow(tx, 'Employee', me.id);
      await this.changes.assertNoOpen(tx, me.id, 'FamilyMember', null);
      const { attachmentIds, comment, ...input } = body;
      const empty = this.emptyState();
      const diff = buildChangeDiff(empty, this.proposedOf({ isEmergencyContact: false, ...input }));
      const merged = applyPatch(empty, diff.patch);
      await this.validate(tx, diff.patch, merged);
      this.sealPatch(diff, null);
      const changeRequest = await this.changes.submit(ctx, {
        employeeId: me.id,
        entityType: 'FamilyMember',
        entityId: null,
        operation: 'CREATE',
        patch: diff.patch,
        previous: null,
        baseVersion: null,
        summary: `New family member ${merged.firstName} ${merged.lastName} (${merged.relationship})`,
        attachmentIds,
        comment,
      });
      return { changeRequest, warnings: this.warnings(merged) };
    });
  }

  async submitUpdate(
    ctx: SecurityContext,
    id: number,
    body: UpdateFamilyMemberRequest,
  ): Promise<ChangeRequestSubmitResponse> {
    return this.db.tx(ctx, async (tx) => {
      const { me, row } = await this.mine(tx, ctx, id);
      assertVersion(row, body.version);
      await this.changes.assertNoOpen(tx, me.id, 'FamilyMember', id);
      const { version: _v, attachmentIds, comment, ...input } = body;
      const current = this.state(row);
      const diff = buildChangeDiff(current, this.proposedOf(input));
      this.changes.assertHasChanges(diff.paths);
      const merged = applyPatch(current, diff.patch);
      await this.validate(tx, diff.patch, merged);
      this.sealPatch(diff, current);
      const changeRequest = await this.changes.submit(ctx, {
        employeeId: me.id,
        entityType: 'FamilyMember',
        entityId: id,
        operation: 'UPDATE',
        patch: diff.patch,
        previous: diff.previous,
        baseVersion: row.version,
        summary: `Change family member ${row.firstName} ${row.lastName}`,
        attachmentIds,
        comment,
      });
      return { changeRequest, warnings: this.warnings(merged) };
    });
  }

  async submitDelete(
    ctx: SecurityContext,
    id: number,
    body: DeleteDetailRequest,
  ): Promise<ChangeRequestSubmitResponse> {
    return this.db.tx(ctx, async (tx) => {
      const { me, row } = await this.mine(tx, ctx, id);
      assertVersion(row, body.version);
      await this.changes.assertNoOpen(tx, me.id, 'FamilyMember', id);
      const current = this.state(row);
      const changeRequest = await this.changes.submit(ctx, {
        employeeId: me.id,
        entityType: 'FamilyMember',
        entityId: id,
        operation: 'DELETE',
        patch: {},
        previous: {
          relationship: current.relationship,
          firstName: current.firstName,
          lastName: current.lastName,
          identityNumber: masked(current.identityNumber),
        },
        baseVersion: row.version,
        summary: `Remove family member ${row.firstName} ${row.lastName}`,
        comment: body.comment,
      });
      return { changeRequest, warnings: [] };
    });
  }

  // ───────────── ChangeApplier ─────────────

  async conflict(tx: Tx, cr: ChangeRequest): Promise<string | null> {
    if (cr.operation === 'CREATE') return null;
    const row = await tx.familyMember.findUnique({
      where: { id: Number(cr.entityId) },
      select: { version: true, deletedAt: true },
    });
    if (!row || row.deletedAt) return 'The family member was removed after this request was submitted';
    if (row.version !== cr.baseVersion) return 'The family member changed after this request was submitted';
    return null;
  }

  async apply(tx: Tx, ctx: SecurityContext, cr: ChangeRequest): Promise<string> {
    const patch = rec(cr.proposed);
    const meta = { source: 'CHANGE_REQUEST', changeRequestId: cr.id, referenceNumber: cr.referenceNumber };
    const now = new Date();
    if (cr.operation === 'DELETE') {
      const id = Number(cr.entityId);
      const before = await tx.familyMember.findUniqueOrThrow({ where: { id } });
      const after = await tx.familyMember.update({
        where: { id },
        data: { deletedAt: now, version: { increment: 1 } },
      });
      this.audit.record(tx, ctx, {
        category: 'DATA_CHANGE',
        action: 'FAMILY_MEMBER.DELETED',
        entityType: 'FamilyMember',
        entityId: id,
        subjectEmployeeId: cr.employeeId,
        before,
        after,
        metadata: meta,
      });
      return String(id);
    }

    const existing =
      cr.operation === 'UPDATE'
        ? await tx.familyMember.findUniqueOrThrow({
            where: { id: Number(cr.entityId) },
            include: MEMBER_INCLUDE,
          })
        : null;
    const current = existing ? this.state(existing) : this.emptyState();
    const plain: Record<string, unknown> = { ...patch };
    if (isSealed(patch.identityNumber))
      plain.identityNumber = this.crypto.decrypt(patch.identityNumber.valueEnc);
    const merged = applyPatch(current, plain);
    await this.validate(tx, patch, merged);

    const data: Record<string, unknown> = {};
    for (const key of PLAIN_FIELDS) if (key in patch) data[key] = merged[key];
    if ('dateOfBirth' in patch)
      data.dateOfBirth = merged.dateOfBirth ? dateFromBusiness(merged.dateOfBirth) : null;
    if ('identityNumber' in patch) {
      const sealed = isSealed(patch.identityNumber) ? patch.identityNumber : null;
      data.identityNumberEnc = sealed?.valueEnc ?? null;
      data.identityNumberLast4 = sealed?.last4 ?? null;
    }
    const member = existing
      ? await tx.familyMember.update({
          where: { id: existing.id },
          data: { ...(data as Prisma.FamilyMemberUncheckedUpdateInput), version: { increment: 1 } },
        })
      : await tx.familyMember.create({
          data: {
            ...(data as Omit<Prisma.FamilyMemberUncheckedCreateInput, 'employeeId'>),
            employeeId: cr.employeeId,
          } as Prisma.FamilyMemberUncheckedCreateInput,
        });
    for (const [section, type] of ADDRESS_SECTIONS) {
      if (!patch[section]) continue;
      const fields = addressData(
        type,
        type === 'POSTAL' ? withoutOwnFields(merged.postalAddress, POSTAL_FIELDS) : merged.physicalAddress,
      );
      await tx.address.upsert({
        where: { familyMemberId_type: { familyMemberId: member.id, type } },
        create: { familyMemberId: member.id, ...fields },
        update: { ...fields, version: { increment: 1 } },
      });
    }
    if (patch.contacts) {
      await writePrimaryContacts(
        tx,
        { familyMemberId: member.id },
        existing?.contacts ?? [],
        rec(patch.contacts) as Partial<ContactsState>,
        now,
      );
    }
    this.audit.record(tx, ctx, {
      category: 'DATA_CHANGE',
      action: existing ? 'FAMILY_MEMBER.UPDATED' : 'FAMILY_MEMBER.CREATED',
      entityType: 'FamilyMember',
      entityId: member.id,
      subjectEmployeeId: cr.employeeId,
      before: existing ?? undefined,
      after: member,
      metadata: meta,
    });
    return String(member.id);
  }

  async formatValue(_client: Tx, path: string, value: unknown): Promise<string | null | undefined> {
    if (path === 'isEmergencyContact' && typeof value === 'boolean') return value ? 'Yes' : 'No';
    return undefined;
  }
}
