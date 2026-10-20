import { ageOn, type BusinessDate, isBusinessDate } from './dates';
import { Decimal, dec, DECIMAL_STRING_PATTERN } from './decimal';
import { DEFAULT_COUNTRY_CODE } from './countries';
import { NAMIBIAN_ID_TYPE } from './lookups';

// Domain rules of My Details (section 5.4) shared by the API and the web app: phone numbers in
// E.164, the basic RFC 5322 email check, the date of birth rules, the Namibian ID number check
// (a warning, never a block), the beneficiary 100.00 rule and the change-request diff.

export interface FieldIssue {
  path: string;
  message: string;
}

// ───────────── Phone numbers (E.164) ─────────────

/**
 * Calling codes for local numbers ("081 234 5678"). Namibia is the default; the neighbouring and
 * most common countries are listed so a default other than NA can be passed.
 */
export const COUNTRY_CALLING_CODES: Readonly<Record<string, string>> = {
  NA: '264',
  ZA: '27',
  BW: '267',
  AO: '244',
  ZM: '260',
  ZW: '263',
  LS: '266',
  SZ: '268',
  MZ: '258',
  DE: '49',
  GB: '44',
  US: '1',
};

/** E.164 allows at most 15 digits; shorter than 8 (country code included) is not a real number. */
const E164_MIN_DIGITS = 8;
const E164_MAX_DIGITS = 15;
/** Namibian national significant numbers are 6 to 9 digits (81 234 5678, 61 123 456, …). */
const NA_NSN_MIN = 6;
const NA_NSN_MAX = 9;

export type PhoneResult = { ok: true; e164: string } | { ok: false; message: string };

/**
 * Normalises a phone number to E.164 (`+264812345678`). Accepts E.164 (`+264 81 234 5678`), the
 * international `00` prefix, a "(0)" trunk marker, and local numbers (`081 234 5678`), which get
 * the calling code of `defaultCountry` (Namibia, +264).
 */
export function normalisePhone(input: string, defaultCountry: string = DEFAULT_COUNTRY_CODE): PhoneResult {
  const fail = (message: string): PhoneResult => ({ ok: false, message });
  const trimmed = input.trim().replace(/\(0\)/g, '');
  if (trimmed === '') return fail('Enter a phone number');
  if (!/^\+?[\d\s().\-/]+$/.test(trimmed)) {
    return fail('Use digits, spaces, brackets or dashes, with an optional leading +');
  }
  const digits = trimmed.replace(/\D/g, '');
  let international: string;
  if (trimmed.startsWith('+')) {
    international = digits;
  } else if (digits.startsWith('00')) {
    international = digits.slice(2);
  } else {
    const callingCode = COUNTRY_CALLING_CODES[defaultCountry.toUpperCase()];
    if (!callingCode) return fail(`Unknown default country ${defaultCountry}`);
    international = callingCode + (digits.startsWith('0') ? digits.slice(1) : digits);
  }
  if (international === '' || international.startsWith('0')) {
    return fail('Start the number with a country code, or use a local number');
  }
  if (international.length < E164_MIN_DIGITS || international.length > E164_MAX_DIGITS) {
    return fail('A phone number has 8 to 15 digits including the country code');
  }
  if (international.startsWith('264')) {
    const nsn = international.length - 3;
    if (nsn < NA_NSN_MIN || nsn > NA_NSN_MAX) return fail('This is not a valid Namibian phone number');
  }
  return { ok: true, e164: `+${international}` };
}

/** True when the value is already a normalised E.164 number. */
export function isE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

// ───────────── Email (RFC 5322, basic) ─────────────

const EMAIL_LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const EMAIL_DOMAIN =
  /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** The basic RFC 5322 shape: a dot-atom local part (≤ 64), `@`, a dotted domain; ≤ 254 overall. */
export function isValidEmail(value: string): boolean {
  if (value.length > 254) return false;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return local.length <= 64 && EMAIL_LOCAL.test(local) && EMAIL_DOMAIN.test(domain);
}

// ───────────── Date of birth ─────────────

/** An employee must be at least this old (section 5.4.1). */
export const MIN_EMPLOYEE_AGE = 15;

/**
 * The date of birth rules: a valid date, not in the future and, when `minAge` is given (employees),
 * at least that many years old on `today`. Returns the message, or null when the date is fine.
 */
export function dateOfBirthIssue(
  dateOfBirth: BusinessDate,
  today: BusinessDate,
  minAge: number | null = MIN_EMPLOYEE_AGE,
): string | null {
  if (!isBusinessDate(dateOfBirth)) return 'Enter a valid date of birth';
  if (dateOfBirth > today) return 'The date of birth cannot be in the future';
  if (minAge !== null && ageOn(dateOfBirth, today) < minAge) {
    return `The employee must be at least ${minAge} years old`;
  }
  return null;
}

/** "Age: n" next to the date of birth; null without a date. */
export function ageFromDateOfBirth(dateOfBirth: BusinessDate | null, today: BusinessDate): number | null {
  return dateOfBirth && isBusinessDate(dateOfBirth) ? ageOn(dateOfBirth, today) : null;
}

// ───────────── Namibian ID number (ASSUMPTION A11: warn, do not block) ─────────────

export interface NamibianIdInput {
  identityNumber: string | null | undefined;
  dateOfBirth: BusinessDate | null | undefined;
  identityType: string | null | undefined;
  nationality?: string | null;
}

/**
 * The Namibian ID check: 11 digits whose first six (YYMMDD) match the date of birth. It applies
 * to the identity type "Namibian ID" (or, with no type, to a Namibian national). The result is a
 * list of warnings that are shown to the user; they never block a submit.
 */
export function namibianIdWarnings(input: NamibianIdInput, path = 'identity.identityNumber'): FieldIssue[] {
  const applies =
    input.identityType === NAMIBIAN_ID_TYPE || (!input.identityType && input.nationality === 'NA');
  const raw = input.identityNumber?.replace(/\s/g, '') ?? '';
  if (!applies || raw === '') return [];
  if (!/^\d{11}$/.test(raw)) return [{ path, message: 'A Namibian ID number has 11 digits' }];
  const dob = input.dateOfBirth;
  if (!dob || !isBusinessDate(dob)) return [];
  const expected = `${dob.slice(2, 4)}${dob.slice(5, 7)}${dob.slice(8, 10)}`;
  if (raw.slice(0, 6) !== expected) {
    return [{ path, message: 'The ID number does not start with the date of birth (YYMMDD)' }];
  }
  return [];
}

// ───────────── Beneficiaries ─────────────

/** The percentages of one fund's beneficiaries must total exactly this (section 5.4.5). */
export const BENEFICIARY_TOTAL = '100.00';

export function beneficiaryTotal(percentages: readonly string[]): Decimal {
  let total = new Decimal(0);
  for (const p of percentages) {
    if (DECIMAL_STRING_PATTERN.test(p)) total = total.plus(dec(p));
  }
  return total;
}

/**
 * The beneficiary percentage rules: each one is a number above 0, at most 100, with at most two
 * decimal places, and together they total exactly 100.00.
 */
export function beneficiaryPercentageIssues(
  rows: readonly { percentage: string }[],
  path = 'beneficiaries',
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  rows.forEach((row, index) => {
    const p = row.percentage;
    const at = `${path}.${index}.percentage`;
    if (!DECIMAL_STRING_PATTERN.test(p)) issues.push({ path: at, message: 'Enter a percentage' });
    else if (dec(p).decimalPlaces() > 2) issues.push({ path: at, message: 'Use at most 2 decimal places' });
    else if (dec(p).lte(0) || dec(p).gt(100)) {
      issues.push({ path: at, message: 'A percentage is more than 0 and at most 100' });
    }
  });
  const total = beneficiaryTotal(rows.map((r) => r.percentage));
  if (!total.eq(BENEFICIARY_TOTAL)) {
    issues.push({
      path,
      message: `The percentages must total exactly ${BENEFICIARY_TOTAL} (they total ${total.toFixed(2)})`,
    });
  }
  return issues;
}

// ───────────── Change-request diff (section 7.6) ─────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** JSON with sorted keys; `undefined` reads as null. Used to compare proposed and current values. */
export function stableJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface ChangeDiff {
  /** Only the changed leaves of `proposed`, in the same nesting. */
  patch: Record<string, unknown>;
  /** The current values of the same leaves (null when there was none). */
  previous: Record<string, unknown>;
  /** Dotted paths of the changed leaves, e.g. `identity.lastName`, `physicalAddress.city`. */
  paths: string[];
}

/**
 * Compares a proposed (possibly partial) value with the current one and keeps only what changed
 * (section 5.4.1: "Only fields that changed are put in the ChangeRequest diff"). Keys missing
 * from `proposed` (or `undefined`) are unchanged; nested objects are compared field by field;
 * arrays and scalars are compared as a whole. An empty `paths` means "No changes to submit".
 */
export function buildChangeDiff(
  current: Record<string, unknown> | null | undefined,
  proposed: Record<string, unknown>,
  prefix = '',
): ChangeDiff {
  const patch: Record<string, unknown> = {};
  const previous: Record<string, unknown> = {};
  const paths: string[] = [];
  const base = current ?? {};
  for (const key of Object.keys(proposed)) {
    const next = proposed[key];
    if (next === undefined) continue;
    const before = base[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(next) && (isPlainObject(before) || before === undefined || before === null)) {
      const inner = buildChangeDiff(isPlainObject(before) ? before : null, next, path);
      if (inner.paths.length > 0) {
        patch[key] = inner.patch;
        previous[key] = inner.previous;
        paths.push(...inner.paths);
      }
      continue;
    }
    if (stableJson(next) !== stableJson(before)) {
      patch[key] = next;
      previous[key] = before ?? null;
      paths.push(path);
    }
  }
  return { patch, previous, paths };
}

/**
 * The dotted leaf paths of a stored patch. `isLeaf` marks objects that are values rather than
 * nesting (for example an encrypted value), so they count as one leaf.
 */
export function patchPaths(
  patch: Record<string, unknown>,
  isLeaf: (value: Record<string, unknown>) => boolean = () => false,
  prefix = '',
): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && !isLeaf(value)) out.push(...patchPaths(value, isLeaf, path));
    else out.push(path);
  }
  return out;
}

/** Deep-merges a patch into a value (objects field by field, everything else replaced). */
export function applyPatch<T extends Record<string, unknown>>(value: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...value };
  for (const [key, next] of Object.entries(patch)) {
    const before = out[key];
    out[key] = isPlainObject(next) && isPlainObject(before) ? applyPatch(before, next) : next;
  }
  return out as T;
}

// ───────────── Masked display ─────────────

/** `••••1234` (section 0.7), or an empty string when there is no value. */
export function maskLast4(last4: string | null | undefined): string {
  return last4 ? `••••${last4}` : '';
}

/** The last four letters or digits of a value, for the masked copy. */
export function last4Of(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = value.replace(/[^A-Za-z0-9]/g, '');
  return clean.slice(-4) || null;
}
