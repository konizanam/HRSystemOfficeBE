import type { Address, ContactDetail } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { redact } from '../../src/audit/redact';
import { EncryptionService } from '../../src/crypto/encryption.service';
import { resealJson } from '../../src/crypto/key-rotation';
import { SEED_BANKS, SEED_BRANCHES } from '../../src/modules/details/bank-data';
import {
  addressData,
  addressDto,
  contactsState,
  dayBefore,
  otherContactsDto,
  otherContactsState,
  physicalState,
  postalState,
  withoutOwnFields,
  workState,
} from '../../src/modules/details/details-records';
import { summaryOf } from '../../src/modules/details/personal-details.service';
import {
  columnsOf,
  isMasked,
  isSealed,
  isSensitiveLeaf,
  masked,
  maskedText,
  seal,
  sealStored,
} from '../../src/modules/details/sealed';

const crypto = EncryptionService.withRing({ keys: { k1: randomBytes(32) }, activeKeyId: 'k1' });

function address(type: Address['type'], fields: Partial<Address>): Address {
  return {
    id: 1,
    employeeId: 1,
    familyMemberId: null,
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
    version: 1,
    updatedAt: new Date(),
    ...fields,
  };
}

function contact(
  id: number,
  type: ContactDetail['type'],
  value: string,
  isPrimary: boolean,
  deleted = false,
): ContactDetail {
  return {
    id,
    employeeId: 1,
    familyMemberId: null,
    type,
    value,
    isPrimary,
    deletedAt: deleted ? new Date() : null,
  };
}

describe('sealed values (encrypted inside change requests)', () => {
  it('encrypts with a masked last4 and reads back', () => {
    const sealed = seal(crypto, '85031700123');
    expect(sealed).not.toBeNull();
    expect(isSealed(sealed)).toBe(true);
    expect(sealed?.last4).toBe('0123');
    expect(sealed?.valueEnc).not.toContain('85031700123');
    expect(crypto.decrypt(sealed?.valueEnc as string)).toBe('85031700123');
    expect(seal(crypto, '')).toBeNull();
    expect(seal(crypto, null)).toBeNull();
    expect(sealStored(null, null)).toBeNull();
    expect(sealStored('k1:a:b:c', '1234')).toEqual({ valueEnc: 'k1:a:b:c', last4: '1234' });
  });

  it('masks for display and tells leaves apart', () => {
    expect(masked('6200123456')).toEqual({ last4: '3456' });
    expect(masked(null)).toBeNull();
    expect(isMasked({ last4: '3456' })).toBe(true);
    expect(isMasked({ last4: '3456', other: 1 })).toBe(false);
    expect(isSensitiveLeaf({ valueEnc: 'x', last4: null })).toBe(true);
    expect(isSensitiveLeaf({ city: 'Windhoek' })).toBe(false);
    expect(maskedText({ valueEnc: 'x', last4: '0123' })).toBe('••••0123');
    expect(maskedText({ last4: '9999' })).toBe('••••9999');
    expect(maskedText('NA0012345678')).toBe('••••5678');
    expect(maskedText('')).toBeNull();
    expect(maskedText(42)).toBeNull();
    expect(columnsOf(null)).toEqual({ enc: null, last4: null });
    expect(columnsOf({ valueEnc: 'e', last4: 'l' })).toEqual({ enc: 'e', last4: 'l' });
  });

  it('never lets the ciphertext of a proposed value into the audit trail', () => {
    const sealed = seal(crypto, '62009988776');
    const out = redact('ChangeRequest', { proposed: { accountNumber: sealed, bankId: 3 } });
    expect(JSON.stringify(out)).not.toContain(sealed?.valueEnc ?? '');
    expect(out).toEqual({
      proposed: { accountNumber: { valueEnc: { last4: null, changed: true }, last4: '8776' }, bankId: 3 },
    });
  });

  it('redacts the new masked columns of employees and beneficiaries', () => {
    const employee = redact('Employee', { passportNumberEnc: 'k1:x', passportNumberLast4: '4321' });
    expect(employee).toEqual({
      passportNumberEnc: { last4: '4321', changed: true },
      passportNumberLast4: '4321',
    });
    const beneficiary = redact('Beneficiary', { identityNumberEnc: 'k1:x', identityNumberLast4: '0777' });
    expect(beneficiary).toEqual({
      identityNumberEnc: { last4: '0777', changed: true },
      identityNumberLast4: '0777',
    });
  });
});

describe('address and contact rows in the shape of the forms', () => {
  const rows = [
    address('PHYSICAL', { streetName: 'Independence Ave', city: 'Windhoek', country: 'NA' }),
    address('POSTAL', { sameAs: 'PHYSICAL' }),
    address('WORK', { sameAs: 'POSTAL' }),
  ];

  it('resolves "Same As" for display, through a postal address that is the same as physical', () => {
    expect(addressDto('POSTAL', rows)).toMatchObject({
      type: 'POSTAL',
      sameAs: 'PHYSICAL',
      city: 'Windhoek',
    });
    expect(addressDto('WORK', rows)).toMatchObject({
      type: 'WORK',
      sameAs: 'POSTAL',
      streetName: 'Independence Ave',
    });
    expect(addressDto('WORK', [address('WORK', { sameAs: 'POSTAL', city: 'Own' })])).toMatchObject({
      city: 'Own',
    });
    expect(addressDto('PHYSICAL', [])).toMatchObject({ type: 'PHYSICAL', city: null, sameAs: null });
  });

  it('builds states and rows', () => {
    expect(physicalState(rows[0])).toMatchObject({ city: 'Windhoek', unitNumber: null });
    expect(postalState(rows[1])).toMatchObject({ sameAs: 'PHYSICAL', serviceType: null });
    expect(postalState(undefined).sameAs).toBeNull();
    expect(workState(rows[2]).sameAs).toBe('POSTAL');
    expect(workState(address('WORK', { sameAs: 'WORK' })).sameAs).toBeNull();
    const postal = withoutOwnFields({ sameAs: 'PHYSICAL', city: 'X', suburb: 'Y' }, ['city', 'suburb']);
    expect(postal).toEqual({ sameAs: 'PHYSICAL', city: null, suburb: null });
    const own = { sameAs: null, city: 'X' };
    expect(withoutOwnFields(own, ['city'])).toBe(own);
    expect(
      addressData('POSTAL', { serviceType: 'PO_BOX', postalAddressNumber: '1234', city: 'Windhoek' }),
    ).toMatchObject({
      type: 'POSTAL',
      serviceType: 'PO_BOX',
      postalAddressNumber: '1234',
      city: 'Windhoek',
      sameAs: null,
    });
    expect(addressData('PHYSICAL', { serviceType: 'PO_BOX', postalAddressNumber: '1' })).toMatchObject({
      serviceType: null,
      postalAddressNumber: null,
    });
  });

  it('splits primary contacts from the "Other Contact Details" rows, skipping removed ones', () => {
    const contacts = [
      contact(3, 'CELL', '+264812345678', true),
      contact(4, 'EMAIL', 'old@example.test', true, true),
      contact(5, 'EMAIL', 'alt@example.test', false),
      contact(2, 'WORK', '+26461123456', false),
    ];
    expect(contactsState(contacts)).toEqual({
      cell: '+264812345678',
      email: null,
      fax: null,
      home: null,
      work: null,
    });
    expect(otherContactsState(contacts)).toEqual([
      { type: 'WORK', value: '+26461123456' },
      { type: 'EMAIL', value: 'alt@example.test' },
    ]);
    expect(otherContactsDto(contacts).map((c) => c.typeLabel)).toEqual(['Work', 'E-Mail']);
  });

  it('summarises change paths and dates', () => {
    expect(summaryOf(['identity.lastName', 'contacts.cell'])).toBe('Surname, Cell Number');
    expect(
      summaryOf([
        'identity.lastName',
        'contacts.cell',
        'contacts.fax',
        'physicalAddress.city',
        'otherContacts',
      ]),
    ).toBe('Surname, Cell Number, Fax Number and 2 more');
    expect(dayBefore('2026-11-01')).toBe('2026-10-31');
  });
});

describe('bank seed data (section 5.4.2)', () => {
  it('has the 40 observed banks in order, with the observed first and last entries', () => {
    expect(SEED_BANKS).toHaveLength(40);
    expect(new Set(SEED_BANKS.map((b) => b.name)).size).toBe(40);
    expect(SEED_BANKS.slice(0, 5).map((b) => b.name)).toEqual([
      'ABN Amro Bank',
      'ABSA',
      'African Bank',
      'Bank of Athens',
      'Bank of Windhoek',
    ]);
    expect(SEED_BANKS.slice(-2).map((b) => b.name)).toEqual(['Bank BIC', 'Bank Atlantico']);
  });

  it('seeds the observed Bank Windhoek and FNB Namibia branches with placeholder codes', () => {
    for (const bank of ['Bank of Windhoek', 'FNB Namibia']) {
      const branches = SEED_BRANCHES[bank] ?? [];
      expect(branches.map((b) => b.name)).toEqual(
        expect.arrayContaining([
          'Universal Code',
          'Main Branch',
          'Exclusive Banking',
          'Oshikango',
          'Ausspanplatz',
          'Swakopmund',
          'Katutura',
          'Henties Bay',
        ]),
      );
      expect(new Set(branches.map((b) => b.code)).size).toBe(branches.length);
      expect(SEED_BANKS.find((b) => b.name === bank)?.universalBranchCode).toBe(
        branches.find((b) => b.name === 'Universal Code')?.code,
      );
    }
  });
});

describe('key rotation of sealed change-request values', () => {
  it('re-encrypts every valueEnc to the active key and leaves the rest alone', () => {
    const k1 = randomBytes(32);
    const old = EncryptionService.withRing({ keys: { k1 }, activeKeyId: 'k1' });
    const next = EncryptionService.withRing({ keys: { k1, k2: randomBytes(32) }, activeKeyId: 'k2' });
    const proposed = {
      identity: { identityNumber: seal(old, '85031700123'), lastName: 'Nangolo' },
      beneficiaries: [{ name: 'A', identityNumber: seal(old, '88010100777'), percentage: '100.00' }],
    };
    const rotated = resealJson(proposed, next);
    expect(rotated.changed).toBe(true);
    const value = rotated.value as typeof proposed;
    expect(next.keyIdOf(value.identity.identityNumber?.valueEnc ?? '')).toBe('k2');
    expect(next.decrypt(value.identity.identityNumber?.valueEnc ?? '')).toBe('85031700123');
    expect(next.decrypt(value.beneficiaries[0]?.identityNumber?.valueEnc ?? '')).toBe('88010100777');
    expect(value.identity.lastName).toBe('Nangolo');
    expect(resealJson(value, next).changed).toBe(false);
    expect(resealJson(null, next)).toEqual({ value: null, changed: false });
  });
});
