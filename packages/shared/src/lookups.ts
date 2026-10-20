import { COUNTRIES } from './countries';
import type { AddressType, ContactType } from './enums';

// The My Details pick lists (section 5.4). They seed `ParameterValue` rows, one table per list, so
// HR can edit them; `GET /lookups/:table` serves the stored rows. Values are stored as they are
// shown, except countries, which are stored as ISO 3166-1 alpha-2 codes.

/** Title (section 5.4.1, observed). */
export const TITLES = [
  'Adv',
  'Dr',
  'Judge',
  'Miss',
  'Mr',
  'Mrs',
  'Ms',
  'Prof.',
  'Pr',
  'Rabbi',
  'Rev',
  'Sir',
  'His Royal Highness',
] as const;

/** Home Language as observed in the source tenant. */
export const OBSERVED_LANGUAGES = [
  'Afrikaans',
  'English',
  'French',
  'German',
  'Greek',
  'Italian',
  'Ndebele',
  'Portuguese',
  'Sepedi',
  'Sotho',
  'Spanish',
  'Swati',
  'Swahili',
  'Tswana',
  'Tsonga',
  'Venda',
  'Xhosa',
  'Zulu',
  'Bengali',
  'Cantonese',
  'Gujarati',
  'Hindi',
  'Indonesian',
  'Japanese',
  'Javanese',
  'Korean',
  'Malay',
  'Mandarin',
  'Marathi',
  'Sundanese',
  'Tamil',
  'Telugu',
  'Arabic',
] as const;

/** ASSUMPTION (A10): Namibian languages added because the tenant is Namibian. */
export const NAMIBIAN_LANGUAGES = [
  'Oshiwambo',
  'Otjiherero',
  'Rukwangali',
  'Silozi',
  'Khoekhoegowab',
  'Setswana',
] as const;

export const LANGUAGES = [...OBSERVED_LANGUAGES, ...NAMIBIAN_LANGUAGES] as const;

export const GENDERS = ['Male', 'Female'] as const;

export const MARITAL_STATUSES = [
  'Single',
  'Married in Community',
  'Married out of Community',
  'Divorced',
  'Widowed',
  'Permanently Separated',
  'Life Partner',
  'Married',
] as const;

/** Blood Group; the source's typo "O Postive" is fixed. */
export const BLOOD_GROUPS = [
  'A Positive',
  'A Negative',
  'AB Positive',
  'AB Negative',
  'B Positive',
  'B Negative',
  'O Positive',
  'O Negative',
] as const;

export const RELIGIONS = [
  'Atheist',
  'Buddhism',
  'Catholic',
  'Hinduism',
  'Chinese Folk Religion',
  'Islam',
  'Christianity',
  'Judaism',
  'Taoism',
] as const;

/** ASSUMPTION (A51): the Identity Type values were not observed. */
export const IDENTITY_TYPES = ['Namibian ID', 'Passport', 'Foreign National ID', 'Other'] as const;

/** The identity type that the Namibian ID number check applies to. */
export const NAMIBIAN_ID_TYPE = 'Namibian ID';

/** Family relationship values observed in the source (a partial list, section 5.4.4). */
export const OBSERVED_RELATIONSHIPS = [
  'Child (I am the Father)',
  'Child (I am the Mother)',
  'Sibling',
  'Spouse',
  'Life partner',
  'Other',
  'Stepchild (I am the Father)',
  'Stepchild (I am the Mother)',
  'Child (I am the Father in law)',
  'Child (I am the Mother in law)',
  'Cousin',
  'Nibling (I am the Aunt)',
  'Nibling (I am the Uncle)',
  'Adopted Child (I am the Father)',
  'Adopted Child (I am the Mother)',
  'Child (I am the Guardian)',
  'Father (I am the Child)',
  'Mother (I am the Child)',
] as const;

/** ASSUMPTION (A15): the matching reverse relationships that complete the list. */
export const REVERSE_RELATIONSHIPS = [
  'Father (I am the Child in law)',
  'Mother (I am the Child in law)',
  'Grandparent',
  'Grandchild',
  'Aunt',
  'Uncle',
] as const;

export const RELATIONSHIPS = [...OBSERVED_RELATIONSHIPS, ...REVERSE_RELATIONSHIPS] as const;

/** Drivers licence Code/Class (ASSUMPTION A14). */
export const LICENCE_CODES = ['A1', 'A', 'B', 'C1', 'C', 'EB', 'EC1', 'EC'] as const;

/** "Other Contact Details" type labels (section 5.4.1). */
export const CONTACT_TYPE_LABELS: Record<ContactType, string> = {
  CELL: 'Cell',
  EMAIL: 'E-Mail',
  FAX: 'Fax',
  HOME: 'Home',
  WORK: 'Work',
};

/** Correspondence Address options; null is "None…". */
export const ADDRESS_TYPE_LABELS: Record<AddressType, string> = {
  PHYSICAL: 'Physical',
  POSTAL: 'Postal',
  WORK: 'Work',
};

/** The tables `GET /lookups/:table` serves. */
export const LOOKUP_TABLES = [
  'countries',
  'languages',
  'titles',
  'marital',
  'bloodGroups',
  'religions',
  'relationships',
  'licenceCodes',
  'genders',
  'identityTypes',
] as const;
export type LookupTable = (typeof LOOKUP_TABLES)[number];

/** `ParameterValue.tableName` of each lookup table. */
export const LOOKUP_PARAMETER_TABLES: Record<LookupTable, string> = {
  countries: 'Country',
  languages: 'Language',
  titles: 'Title',
  marital: 'MaritalStatus',
  bloodGroups: 'BloodGroup',
  religions: 'Religion',
  relationships: 'Relationship',
  licenceCodes: 'LicenceCode',
  genders: 'Gender',
  identityTypes: 'IdentityType',
};

/** A seed row of a lookup table: the stored code and the label shown. */
export interface LookupSeedValue {
  code: string;
  description: string;
}

function asValues(list: readonly string[]): LookupSeedValue[] {
  return list.map((value) => ({ code: value, description: value }));
}

/** The seed rows of every lookup table, in display order. */
export function lookupSeedValues(table: LookupTable): LookupSeedValue[] {
  switch (table) {
    case 'countries':
      return COUNTRIES.map((c) => ({ code: c.code, description: c.name }));
    case 'languages':
      return asValues(LANGUAGES);
    case 'titles':
      return asValues(TITLES);
    case 'marital':
      return asValues(MARITAL_STATUSES);
    case 'bloodGroups':
      return asValues(BLOOD_GROUPS);
    case 'religions':
      return asValues(RELIGIONS);
    case 'relationships':
      return asValues(RELATIONSHIPS);
    case 'licenceCodes':
      return asValues(LICENCE_CODES);
    case 'genders':
      return asValues(GENDERS);
    case 'identityTypes':
      return asValues(IDENTITY_TYPES);
  }
}

export function isLookupTable(value: string): value is LookupTable {
  return (LOOKUP_TABLES as readonly string[]).includes(value);
}
