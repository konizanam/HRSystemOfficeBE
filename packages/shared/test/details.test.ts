import { describe, expect, it } from 'vitest';
import {
  ageFromDateOfBirth,
  applyPatch,
  BLOOD_GROUPS,
  beneficiaryPercentageIssues,
  beneficiaryTotal,
  buildChangeDiff,
  changeFieldLabel,
  CONTACT_TYPE_LABELS,
  COUNTRIES,
  countryName,
  CreateBankAccountRequestSchema,
  CreateDriversLicenceRequestSchema,
  dateOfBirthIssue,
  EmailSchema,
  IDENTITY_TYPES,
  isE164,
  isLookupTable,
  isValidEmail,
  LANGUAGES,
  last4Of,
  LICENCE_CODES,
  LOOKUP_PARAMETER_TABLES,
  LOOKUP_TABLES,
  lookupSeedValues,
  MARITAL_STATUSES,
  maskLast4,
  namibianIdWarnings,
  normaliseContactValue,
  normalisePhone,
  OtherContactInputSchema,
  patchPaths,
  pendingChangeBanner,
  PhoneSchema,
  RELATIONSHIPS,
  RELIGIONS,
  stableJson,
  SubmitEmployeeTransactionRequestSchema,
  TITLES,
  UpdateBeneficiariesRequestSchema,
  UpdatePersonalDetailsRequestSchema,
} from '../src';

describe('phone numbers (E.164, default NA +264)', () => {
  it.each([
    ['081 234 5678', '+264812345678'],
    ['0812345678', '+264812345678'],
    ['812345678', '+264812345678'],
    ['+264 81 234 5678', '+264812345678'],
    ['+264 (0)81 234 5678', '+264812345678'],
    ['00264812345678', '+264812345678'],
    ['(061) 123-456', '+26461123456'],
    ['+27 82 123 4567', '+27821234567'],
    ['+1 (415) 555-0123', '+14155550123'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalisePhone(input)).toEqual({ ok: true, e164: expected });
  });

  it('uses another default country for local numbers', () => {
    expect(normalisePhone('082 123 4567', 'ZA')).toEqual({ ok: true, e164: '+27821234567' });
    expect(normalisePhone('082 123 4567', 'XX')).toEqual({
      ok: false,
      message: 'Unknown default country XX',
    });
  });

  it.each([
    ['', 'Enter a phone number'],
    ['   ', 'Enter a phone number'],
    ['081-CALL-ME', 'Use digits, spaces, brackets or dashes, with an optional leading +'],
    ['81+234', 'Use digits, spaces, brackets or dashes, with an optional leading +'],
    ['+0812345678', 'Start the number with a country code, or use a local number'],
    ['+264 1', 'A phone number has 8 to 15 digits including the country code'],
    ['+1234567890123456', 'A phone number has 8 to 15 digits including the country code'],
    ['+264 8123 45678 9', 'This is not a valid Namibian phone number'],
  ])('rejects %j', (input, message) => {
    expect(normalisePhone(input)).toEqual({ ok: false, message });
  });

  it('recognises E.164 and parses through the schema', () => {
    expect(isE164('+264812345678')).toBe(true);
    expect(isE164('0812345678')).toBe(false);
    expect(PhoneSchema.parse('081 234 5678')).toBe('+264812345678');
    expect(PhoneSchema.safeParse('abc').success).toBe(false);
  });

  it('normalises "Other Contact Details" rows by type', () => {
    expect(OtherContactInputSchema.parse({ type: 'CELL', value: '081 234 5678' })).toEqual({
      type: 'CELL',
      value: '+264812345678',
    });
    expect(OtherContactInputSchema.parse({ type: 'EMAIL', value: ' a.b@example.com ' })).toEqual({
      type: 'EMAIL',
      value: 'a.b@example.com',
    });
    const bad = OtherContactInputSchema.safeParse({ type: 'EMAIL', value: 'not-an-email' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['value']);
    expect(normaliseContactValue('FAX', 'x')).toEqual({
      ok: false,
      message: 'Use digits, spaces, brackets or dashes, with an optional leading +',
    });
  });
});

describe('email (RFC 5322, basic)', () => {
  it.each(['a@b.co', 'first.last+tag@sub.example.com', "o'brien@example.na", 'x_y-z@a-b.example'])(
    'accepts %s',
    (value) => {
      expect(isValidEmail(value)).toBe(true);
    },
  );

  it.each([
    'plain',
    '@example.com',
    'a@',
    'a..b@example.com',
    '.a@example.com',
    'a.@example.com',
    'a@example',
    'a@-example.com',
    'a b@example.com',
    `${'x'.repeat(65)}@example.com`,
    `a@${'x'.repeat(250)}.com`,
  ])('rejects %s', (value) => {
    expect(isValidEmail(value)).toBe(false);
  });

  it('trims through the schema', () => {
    expect(EmailSchema.parse('  a@b.co ')).toBe('a@b.co');
  });
});

describe('date of birth', () => {
  const today = '2026-10-20';

  it('accepts a date at least 15 years ago', () => {
    expect(dateOfBirthIssue('2011-10-20', today)).toBeNull();
    expect(dateOfBirthIssue('1980-01-01', today)).toBeNull();
  });

  it('refuses a future date and an employee under 15', () => {
    expect(dateOfBirthIssue('2026-10-21', today)).toBe('The date of birth cannot be in the future');
    expect(dateOfBirthIssue('2011-10-21', today)).toBe('The employee must be at least 15 years old');
    expect(dateOfBirthIssue('2026-02-30', today)).toBe('Enter a valid date of birth');
  });

  it('lets a family member be any age up to today', () => {
    expect(dateOfBirthIssue('2026-10-20', today, null)).toBeNull();
    expect(dateOfBirthIssue('2026-10-21', today, null)).toBe('The date of birth cannot be in the future');
  });

  it('calculates the age shown next to the date', () => {
    expect(ageFromDateOfBirth('1990-10-21', today)).toBe(35);
    expect(ageFromDateOfBirth('1990-10-20', today)).toBe(36);
    expect(ageFromDateOfBirth(null, today)).toBeNull();
    expect(ageFromDateOfBirth('bad', today)).toBeNull();
  });
});

describe('Namibian ID number (warn, do not block)', () => {
  const base = { identityType: 'Namibian ID', dateOfBirth: '1985-03-17' };

  it('passes 11 digits starting with YYMMDD of the date of birth', () => {
    expect(namibianIdWarnings({ ...base, identityNumber: '85031700123' })).toEqual([]);
    expect(namibianIdWarnings({ ...base, identityNumber: '850317 00123' })).toEqual([]);
  });

  it('warns about the length and a date mismatch', () => {
    expect(namibianIdWarnings({ ...base, identityNumber: '8503170012' })).toEqual([
      { path: 'identity.identityNumber', message: 'A Namibian ID number has 11 digits' },
    ]);
    expect(namibianIdWarnings({ ...base, identityNumber: '85031800123' }, 'identityNumber')).toEqual([
      { path: 'identityNumber', message: 'The ID number does not start with the date of birth (YYMMDD)' },
    ]);
  });

  it('applies to Namibian nationals without a type, and to nothing else', () => {
    expect(
      namibianIdWarnings({ identityType: null, nationality: 'NA', dateOfBirth: null, identityNumber: '1' }),
    ).toHaveLength(1);
    expect(
      namibianIdWarnings({
        identityType: null,
        nationality: 'NA',
        dateOfBirth: null,
        identityNumber: '85031700123',
      }),
    ).toEqual([]);
    expect(namibianIdWarnings({ ...base, identityType: 'Passport', identityNumber: 'X1' })).toEqual([]);
    expect(namibianIdWarnings({ ...base, identityNumber: null })).toEqual([]);
  });
});

describe('beneficiary percentages = 100.00', () => {
  it('accepts a split that totals exactly 100.00', () => {
    expect(beneficiaryPercentageIssues([{ percentage: '33.33' }, { percentage: '66.67' }])).toEqual([]);
    expect(beneficiaryPercentageIssues([{ percentage: '100' }])).toEqual([]);
    expect(beneficiaryTotal(['50', '25.5', 'x'])).toEqual(beneficiaryTotal(['75.5']));
  });

  it('refuses totals other than 100.00 and bad rows', () => {
    expect(beneficiaryPercentageIssues([{ percentage: '33.33' }, { percentage: '66.66' }])).toEqual([
      { path: 'beneficiaries', message: 'The percentages must total exactly 100.00 (they total 99.99)' },
    ]);
    const issues = beneficiaryPercentageIssues([
      { percentage: 'abc' },
      { percentage: '10.555' },
      { percentage: '0' },
      { percentage: '101' },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      'beneficiaries.0.percentage',
      'beneficiaries.1.percentage',
      'beneficiaries.2.percentage',
      'beneficiaries.3.percentage',
      'beneficiaries',
    ]);
  });

  it('is enforced by the request schema', () => {
    const ok = UpdateBeneficiariesRequestSchema.safeParse({
      version: 1,
      beneficiaries: [
        { familyMemberId: 3, percentage: '60' },
        { name: 'A Person', relationship: 'Sibling', percentage: '40.00' },
      ],
    });
    expect(ok.success).toBe(true);
    const bad = UpdateBeneficiariesRequestSchema.safeParse({
      version: 1,
      beneficiaries: [{ name: 'A', relationship: 'Sibling', percentage: '99' }, { percentage: '0.5' }],
    });
    expect(bad.success).toBe(false);
    const paths = bad.error?.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('beneficiaries');
    expect(paths).toContain('beneficiaries.1.name');
    expect(paths).toContain('beneficiaries.1.relationship');
  });
});

describe('change-request diff', () => {
  const current = {
    identity: { lastName: 'Shikongo', firstName: 'Anna', knownAs: null },
    physicalAddress: { city: 'Windhoek', suburb: 'Klein Windhoek' },
    otherContacts: [{ type: 'CELL', value: '+264812345678' }],
    correspondenceAddressType: 'PHYSICAL',
  };

  it('keeps only the changed leaves', () => {
    const diff = buildChangeDiff(current, {
      identity: { lastName: 'Nangolo', firstName: 'Anna', knownAs: undefined },
      physicalAddress: { city: 'Windhoek', suburb: 'Olympia' },
      otherContacts: [{ type: 'CELL', value: '+264812345678' }],
      correspondenceAddressType: 'POSTAL',
    });
    expect(diff.paths).toEqual(['identity.lastName', 'physicalAddress.suburb', 'correspondenceAddressType']);
    expect(diff.patch).toEqual({
      identity: { lastName: 'Nangolo' },
      physicalAddress: { suburb: 'Olympia' },
      correspondenceAddressType: 'POSTAL',
    });
    expect(diff.previous).toEqual({
      identity: { lastName: 'Shikongo' },
      physicalAddress: { suburb: 'Klein Windhoek' },
      correspondenceAddressType: 'PHYSICAL',
    });
  });

  it('reports no changes when the form matches', () => {
    expect(buildChangeDiff(current, { identity: { firstName: 'Anna', knownAs: null } }).paths).toEqual([]);
    expect(buildChangeDiff(current, {}).paths).toEqual([]);
  });

  it('treats a missing current value as null and compares arrays whole', () => {
    const diff = buildChangeDiff(null, {
      workAddress: { city: 'Swakopmund' },
      otherContacts: [{ value: '+264811111111', type: 'CELL' }],
      maidenName: null,
    });
    expect(diff.paths).toEqual(['workAddress.city', 'otherContacts']);
    expect(diff.previous).toEqual({ workAddress: { city: null }, otherContacts: null });
    expect(
      buildChangeDiff(current, { otherContacts: [{ value: '+264812345678', type: 'CELL' }] }).paths,
    ).toEqual([]);
    expect(buildChangeDiff({ a: 'x' }, { a: { b: 1 } }).paths).toEqual(['a']);
  });

  it('lists the leaf paths of a stored patch and merges it', () => {
    const patch = {
      identity: { lastName: 'N', identityNumber: { valueEnc: 'k1:..', last4: '0123' } },
      x: [1],
    };
    expect(patchPaths(patch, (v) => 'valueEnc' in v)).toEqual([
      'identity.lastName',
      'identity.identityNumber',
      'x',
    ]);
    expect(patchPaths(patch)).toEqual([
      'identity.lastName',
      'identity.identityNumber.valueEnc',
      'identity.identityNumber.last4',
      'x',
    ]);
    expect(applyPatch(current, { identity: { lastName: 'N' }, otherContacts: [] })).toEqual({
      ...current,
      identity: { lastName: 'N', firstName: 'Anna', knownAs: null },
      otherContacts: [],
    });
  });

  it('serialises with sorted keys', () => {
    expect(stableJson({ b: 1, a: [null, undefined, { d: 2, c: undefined }] })).toBe(
      '{"a":[null,null,{"d":2}],"b":1}',
    );
  });

  it('labels changed fields like the form', () => {
    expect(changeFieldLabel('identity.lastName')).toBe('Surname');
    expect(changeFieldLabel('identity.unknown')).toBe('unknown');
    expect(changeFieldLabel('physicalAddress.city')).toBe('Physical Address: City/Town');
    expect(changeFieldLabel('postalAddress.custom')).toBe('Postal Address: custom');
    expect(changeFieldLabel('contacts.cell')).toBe('Cell Number');
    expect(changeFieldLabel('contacts.other')).toBe('other');
    expect(changeFieldLabel('accountNumber')).toBe('Account Number');
    expect(changeFieldLabel('firstName')).toBe('First Name');
    expect(changeFieldLabel('mystery')).toBe('mystery');
    expect(changeFieldLabel('a.b')).toBe('a.b');
    expect(pendingChangeBanner(821)).toBe('Changes pending approval (Process #821)');
    expect(pendingChangeBanner(null)).toBe('Changes pending approval');
  });

  it('masks to the last four characters', () => {
    expect(maskLast4('1234')).toBe('••••1234');
    expect(maskLast4(null)).toBe('');
    expect(last4Of('62-0012-3456')).toBe('3456');
    expect(last4Of('--')).toBeNull();
    expect(last4Of(undefined)).toBeNull();
  });
});

describe('lookup lists', () => {
  it('has the observed values with the corrections and additions', () => {
    expect(TITLES).toHaveLength(13);
    expect(TITLES).toContain('His Royal Highness');
    expect(LANGUAGES).toHaveLength(39);
    expect(LANGUAGES).toEqual(expect.arrayContaining(['Oshiwambo', 'Khoekhoegowab', 'Setswana', 'Arabic']));
    expect(MARITAL_STATUSES).toHaveLength(8);
    expect(BLOOD_GROUPS).toContain('O Positive');
    expect(BLOOD_GROUPS).not.toContain('O Postive');
    expect(RELIGIONS).toHaveLength(9);
    expect(RELATIONSHIPS).toHaveLength(24);
    expect(RELATIONSHIPS).toEqual(
      expect.arrayContaining([
        'Father (I am the Child in law)',
        'Grandparent',
        'Grandchild',
        'Aunt',
        'Uncle',
      ]),
    );
    expect(LICENCE_CODES).toEqual(['A1', 'A', 'B', 'C1', 'C', 'EB', 'EC1', 'EC']);
    expect(IDENTITY_TYPES).toContain('Namibian ID');
    expect(CONTACT_TYPE_LABELS.EMAIL).toBe('E-Mail');
  });

  it('seeds every table, countries from ISO 3166-1', () => {
    expect(COUNTRIES).toHaveLength(249);
    expect(new Set(COUNTRIES.map((c) => c.code)).size).toBe(249);
    expect(countryName('na')).toBe('Namibia');
    expect(countryName('ZZ')).toBeNull();
    expect(countryName(null)).toBeNull();
    for (const table of LOOKUP_TABLES) {
      const rows = lookupSeedValues(table);
      expect(rows.length, table).toBeGreaterThan(1);
      expect(new Set(rows.map((r) => r.code)).size, table).toBe(rows.length);
      expect(LOOKUP_PARAMETER_TABLES[table]).toMatch(/^[A-Z][A-Za-z]+$/);
    }
    expect(lookupSeedValues('countries')).toContainEqual({ code: 'NA', description: 'Namibia' });
    expect(lookupSeedValues('titles')[0]).toEqual({ code: 'Adv', description: 'Adv' });
    expect(isLookupTable('countries')).toBe(true);
    expect(isLookupTable('salaries')).toBe(false);
  });
});

describe('My Details request schemas', () => {
  it('parses a personal details form, clearing blanks and normalising contacts', () => {
    const parsed = UpdatePersonalDetailsRequestSchema.parse({
      version: 3,
      identity: { lastName: ' Nangolo ', maidenName: '', nationality: 'na', dateOfBirth: '1990-01-01' },
      contacts: { cell: '081 234 5678', email: '' },
      otherContacts: [{ type: 'WORK', value: '061 123 456' }],
    });
    expect(parsed.identity).toMatchObject({ lastName: 'Nangolo', maidenName: null, nationality: 'NA' });
    expect(parsed.contacts).toEqual({ cell: '+264812345678', email: null });
    expect(parsed.otherContacts).toEqual([{ type: 'WORK', value: '+26461123456' }]);
    const young = UpdatePersonalDetailsRequestSchema.safeParse({
      version: 1,
      identity: { dateOfBirth: '2020-01-01' },
    });
    expect(young.success).toBe(false);
    expect(
      UpdatePersonalDetailsRequestSchema.safeParse({ version: 1, identity: { lastName: ' ' } }).success,
    ).toBe(false);
  });

  it('requires a supporting document for bank changes and a licence copy', () => {
    const bank = {
      accountType: 'SAVINGS',
      accountHolderName: 'A',
      accountHolderRelationship: 'OWN',
      bankId: 1,
      accountNumber: '62 0012-3456',
      attachmentIds: [] as string[],
    };
    expect(CreateBankAccountRequestSchema.safeParse(bank).success).toBe(false);
    const withDoc = CreateBankAccountRequestSchema.parse({
      ...bank,
      attachmentIds: ['7c9e6679-7425-40de-944b-e07fc1f90ae7'],
    });
    expect(withDoc).toMatchObject({ accountNumber: '6200123456', currency: 'NAD' });
    expect(CreateBankAccountRequestSchema.safeParse({ ...bank, accountNumber: '12' }).success).toBe(false);

    const licence = {
      licenceNumber: 'NA123456',
      code: 'B',
      issueDate: '2020-01-01',
      expiryDate: '2019-01-01',
      hasPdp: true,
      attachmentIds: ['7c9e6679-7425-40de-944b-e07fc1f90ae7'],
    };
    const bad = CreateDriversLicenceRequestSchema.safeParse(licence);
    expect(bad.error?.issues.map((i) => i.path.join('.')).sort()).toEqual(['expiryDate', 'pdpExpiryDate']);
    expect(
      CreateDriversLicenceRequestSchema.safeParse({
        ...licence,
        issueDate: '2999-01-01',
        expiryDate: '2999-02-01',
      }).error?.issues[0]?.path,
    ).toEqual(['issueDate']);
  });

  it('takes either an amount or a quantity for an employee transaction', () => {
    expect(
      SubmitEmployeeTransactionRequestSchema.safeParse({ transactionCodeId: 1, amount: '10.50' }).success,
    ).toBe(true);
    expect(SubmitEmployeeTransactionRequestSchema.safeParse({ transactionCodeId: 1 }).success).toBe(false);
    expect(
      SubmitEmployeeTransactionRequestSchema.safeParse({ transactionCodeId: 1, amount: '1', quantity: '1' })
        .success,
    ).toBe(false);
  });
});
