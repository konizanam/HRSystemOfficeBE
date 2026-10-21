import { z } from 'zod';
import { DECIMAL_STRING_PATTERN, dec } from '../decimal';
import { beneficiaryPercentageIssues, dateOfBirthIssue, isValidEmail, normalisePhone } from '../details';
import { todayBusinessDate } from '../dates';
import {
  AccountHolderRelationshipSchema,
  AddressTypeSchema,
  BankAccountTypeSchema,
  ChangeOperationSchema,
  type ContactType,
  ContactTypeSchema,
  EmployeeStatusSchema,
  PostalServiceTypeSchema,
  ProcessStatusSchema,
  PROCESS_STATUSES,
  WorkflowTypeCodeSchema,
} from '../enums';
import { AttachmentIdsSchema, AttachmentSchema } from './attachments';
import { BooleanQuerySchema } from './calendar';
import {
  BusinessDateSchema,
  DecimalStringSchema,
  pageOf,
  SearchTextSchema,
  TimestampSchema,
  VersionSchema,
} from './common';

// Contracts for My Details (sections 5.4 and 12.5): personal details, bank details, drivers
// licences, family, beneficiaries and employee transactions. Every employee change becomes a
// ChangeRequest (section 7.6) that is applied after the final approval. `/me` is the "Working as"
// employee. Validation schemas are shared with the web app's forms.

// ───────────── Messages and limits ─────────────

/** 422 when the submitted form matches the current record (section 5.4.1). */
export const NO_CHANGES_MESSAGE = 'No changes to submit';
/** 409 while a change for the same record is open (section 7.6). */
export const CHANGE_PENDING_MESSAGE = 'A change is already awaiting approval';
export const FAMILY_EMPTY_TEXT =
  "No existing family members. Select 'Add new family member' to add your family members.";
export const FUNDS_EMPTY_TEXT = 'No Retirement Funds.';
export const LICENCES_EMPTY_TEXT = 'Please select a Drivers License';
/** Days before expiry at which the employee and HR hear about a drivers licence (section 5.4.3). */
export const LICENCE_EXPIRY_NOTICE_DAYS = 60;
/** At most this many "Other Contact Details" rows. */
export const OTHER_CONTACTS_MAX = 20;
export const BENEFICIARIES_MAX = 20;
export const CHANGE_COMMENT_MAX = 1000;

/** "Changes pending approval (Process #821)" (section 7.6). */
export function pendingChangeBanner(processId: number | null): string {
  return processId === null ? 'Changes pending approval' : `Changes pending approval (Process #${processId})`;
}

/** Problem `type` values of My Details errors the web app branches on. */
export const DETAILS_PROBLEM_TYPES = {
  noChanges: 'urn:peoplehub:problem:no-changes',
  changePending: 'urn:peoplehub:problem:change-pending',
} as const;

// ───────────── Field schemas (shared with the forms) ─────────────

function blankToNull(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? null : value;
}

/** Optional free text: trimmed, `''` becomes null (clears the field), missing = unchanged. */
function text(max: number) {
  return z.preprocess(blankToNull, z.string().trim().max(max).nullable()).optional();
}

/**
 * `{ clear: true }`: the explicit "remove this number" action for an encrypted number the form
 * only shows masked (`••••1234`). A form cannot tell "left blank" from "emptied" for such a
 * field, so a blank or missing value keeps the stored number and `{ clear: true }` removes it.
 */
export const ClearSensitiveValueSchema = z.object({ clear: z.literal(true) }).strict();
export type ClearSensitiveValue = z.infer<typeof ClearSensitiveValueSchema>;

/** True when a form value is the explicit clear action. */
export function isClearSensitiveValue(value: unknown): value is ClearSensitiveValue {
  return ClearSensitiveValueSchema.safeParse(value).success;
}

/**
 * An encrypted number on a change (ID, passport, tax and birth certificate numbers, a family
 * member's or beneficiary's ID number): a new value replaces it, `{ clear: true }` removes it
 * (the change request then proposes null, and the change is audited as a change to null), and a
 * missing field keeps it. `''`/null are still accepted as a clear for older clients.
 */
function sensitiveText(max: number) {
  return z
    .union([
      ClearSensitiveValueSchema.transform(() => null),
      z.preprocess(blankToNull, z.string().trim().max(max).nullable()),
    ])
    .optional();
}

/** A required name on create; when sent on update it cannot be blank. */
function requiredText(max: number) {
  return z.string().trim().min(1, 'This field is required').max(max);
}

/** Email in the basic RFC 5322 shape. */
export const EmailSchema = z
  .string()
  .trim()
  .max(254, 'An email address has at most 254 characters')
  .refine(isValidEmail, 'Enter a valid email address');

/** A phone number in E.164 or a local format; the parsed value is E.164 (default country NA). */
export const PhoneSchema = z
  .string()
  .max(40)
  .transform((value, ctx) => {
    const result = normalisePhone(value);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message });
      return z.NEVER;
    }
    return result.e164;
  });

const optionalPhone = z.preprocess(blankToNull, PhoneSchema.nullable()).optional();
const optionalEmail = z.preprocess(blankToNull, EmailSchema.nullable()).optional();
const optionalDate = z.preprocess(blankToNull, BusinessDateSchema.nullable()).optional();

/** ISO 3166-1 alpha-2 code (the server checks it against the countries table). */
export const CountryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Pick a country');
const optionalCountry = z.preprocess(blankToNull, CountryCodeSchema.nullable()).optional();

/** Date of birth of an employee: not in the future and at least 15 years ago. */
export const EmployeeDateOfBirthSchema = BusinessDateSchema.superRefine((value, ctx) => {
  const issue = dateOfBirthIssue(value, todayBusinessDate());
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
});

/** Date of birth of a family member: not in the future (children are fine). */
export const FamilyDateOfBirthSchema = BusinessDateSchema.superRefine((value, ctx) => {
  const issue = dateOfBirthIssue(value, todayBusinessDate(), null);
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
});

export const FieldIssueSchema = z.object({ path: z.string(), message: z.string() });
export type FieldIssueDto = z.infer<typeof FieldIssueSchema>;

/** The value of an "Other Contact Details" row, validated and normalised by its type. */
export function normaliseContactValue(
  type: ContactType,
  value: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (type === 'EMAIL') {
    const trimmed = value.trim();
    return isValidEmail(trimmed)
      ? { ok: true, value: trimmed }
      : { ok: false, message: 'Enter a valid email address' };
  }
  const phone = normalisePhone(value);
  return phone.ok ? { ok: true, value: phone.e164 } : phone;
}

export const OtherContactInputSchema = z
  .object({ type: ContactTypeSchema, value: z.string().trim().min(1, 'Enter a value').max(254) })
  .transform((row, ctx) => {
    const result = normaliseContactValue(row.type, row.value);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: result.message });
      return z.NEVER;
    }
    return { type: row.type, value: result.value };
  });
export type OtherContactInput = z.infer<typeof OtherContactInputSchema>;

// ───────────── Addresses and contacts ─────────────

const AddressFieldsShape = {
  unitNumber: text(20),
  block: text(40),
  complex: text(100),
  levelFloor: text(20),
  streetNumber: text(20),
  streetName: text(150),
  suburb: text(100),
  city: text(100),
  postalCode: text(20),
  country: optionalCountry,
  province: text(100),
  district: text(100),
  careOfName: text(150),
};

/** Physical Address (section 5.4.1). */
export const PhysicalAddressInputSchema = z.object(AddressFieldsShape);
export type PhysicalAddressInput = z.infer<typeof PhysicalAddressInputSchema>;

/** Postal Address: "Postal Address Same As [Physical Address]" or its own fields. */
export const PostalAddressInputSchema = z.object({
  sameAs: z.enum(['PHYSICAL']).nullable().optional(),
  serviceType: PostalServiceTypeSchema.nullable().optional(),
  postalAddressNumber: text(40),
  suburb: text(100),
  city: text(100),
  postalCode: text(20),
  country: optionalCountry,
  province: text(100),
  district: text(100),
  careOfName: text(150),
});
export type PostalAddressInput = z.infer<typeof PostalAddressInputSchema>;

/** Work Address: "Work Address Same As [Physical Address | Postal Address]" or its own fields. */
export const WorkAddressInputSchema = z.object({
  sameAs: z.enum(['PHYSICAL', 'POSTAL']).nullable().optional(),
  ...AddressFieldsShape,
});
export type WorkAddressInput = z.infer<typeof WorkAddressInputSchema>;

/** Contact Details: Cell Number, E-Mail Address, Fax Number, Home Number, Work Number. */
export const ContactNumbersInputSchema = z.object({
  cell: optionalPhone,
  email: optionalEmail,
  fax: optionalPhone,
  home: optionalPhone,
  work: optionalPhone,
});
export type ContactNumbersInput = z.infer<typeof ContactNumbersInputSchema>;

const nullableString = z.string().nullable();

/** An address as read back. With `sameAs`, the fields are those of the referenced address. */
export const AddressSchema = z.object({
  type: AddressTypeSchema,
  sameAs: AddressTypeSchema.nullable(),
  unitNumber: nullableString,
  block: nullableString,
  complex: nullableString,
  levelFloor: nullableString,
  streetNumber: nullableString,
  streetName: nullableString,
  suburb: nullableString,
  city: nullableString,
  postalCode: nullableString,
  country: nullableString,
  province: nullableString,
  district: nullableString,
  careOfName: nullableString,
  serviceType: PostalServiceTypeSchema.nullable(),
  postalAddressNumber: nullableString,
});
export type Address = z.infer<typeof AddressSchema>;

export const ContactNumbersSchema = z.object({
  cell: nullableString,
  email: nullableString,
  fax: nullableString,
  home: nullableString,
  work: nullableString,
});
export type ContactNumbers = z.infer<typeof ContactNumbersSchema>;

export const OtherContactSchema = z.object({
  id: z.number().int(),
  type: ContactTypeSchema,
  typeLabel: z.string(),
  value: z.string(),
});
export type OtherContact = z.infer<typeof OtherContactSchema>;

// ───────────── Change requests (section 7.6) ─────────────

/** The records a change request can be about (Prisma model names). */
export const CHANGE_ENTITY_TYPES = [
  'Employee',
  'BankAccount',
  'DriversLicence',
  'FamilyMember',
  'FundMembership',
] as const;
export const ChangeEntityTypeSchema = z.enum(CHANGE_ENTITY_TYPES);
export type ChangeEntityType = z.infer<typeof ChangeEntityTypeSchema>;

export const CHANGE_ENTITY_LABELS: Record<ChangeEntityType, string> = {
  Employee: 'Personal details',
  BankAccount: 'Bank account',
  DriversLicence: 'Drivers licence',
  FamilyMember: 'Family member',
  FundMembership: 'Beneficiaries',
};

/** One changed field for the approver and the "pending" banner, sensitive values masked. */
export const ChangeFieldSchema = z.object({
  /** Dotted path, e.g. `identity.lastName`; the web app greys out these fields. */
  path: z.string(),
  /** English form label, e.g. "First Name". */
  label: z.string(),
  /**
   * Stable i18n key of the label, e.g. `details.personal.firstName` or
   * `details.personal.physicalAddress.city` (see {@link changeFieldLabelKey}); translate it and
   * fall back to `label`.
   */
  labelKey: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type ChangeField = z.infer<typeof ChangeFieldSchema>;

/** The open change of a record, for the banner "Changes pending approval (Process #821)". */
export const PendingChangeSchema = z.object({
  changeRequestId: z.number().int(),
  referenceNumber: z.string(),
  processId: z.number().int().nullable(),
  status: ProcessStatusSchema,
  statusLabel: z.string(),
  operation: ChangeOperationSchema,
  /** Edited field paths (greyed out in the form). */
  fieldPaths: z.array(z.string()),
  banner: z.string(),
});
export type PendingChange = z.infer<typeof PendingChangeSchema>;

export const ChangeRequestSchema = z.object({
  id: z.number().int(),
  /** `R{entityCode}-{typeCode}-N{seq:5}` (section 8.2). */
  referenceNumber: z.string(),
  workflowType: WorkflowTypeCodeSchema,
  entityType: ChangeEntityTypeSchema,
  entityLabel: z.string(),
  /** Null for a create that is not applied yet. */
  entityId: z.string().nullable(),
  operation: ChangeOperationSchema,
  status: ProcessStatusSchema,
  statusLabel: z.string(),
  processId: z.number().int().nullable(),
  baseVersion: z.number().int().nullable(),
  summary: z.string(),
  fieldPaths: z.array(z.string()),
  changes: z.array(ChangeFieldSchema),
  createdAt: TimestampSchema,
  appliedAt: TimestampSchema.nullable(),
});
export type ChangeRequestDto = z.infer<typeof ChangeRequestSchema>;

/** Every My Details submit answers with the created change request and any warnings. */
export const ChangeRequestSubmitResponseSchema = z.object({
  changeRequest: ChangeRequestSchema,
  /** Shown but never blocking, e.g. the Namibian ID number check (ASSUMPTION A11). */
  warnings: z.array(FieldIssueSchema),
});
export type ChangeRequestSubmitResponse = z.infer<typeof ChangeRequestSubmitResponseSchema>;

export const CHANGE_REQUEST_STATUS_FILTERS = ['open', 'closed', ...PROCESS_STATUSES] as const;

/** GET /me/change-requests?status=open|closed|IN_PROGRESS|… (default: all). */
export const ChangeRequestsQuerySchema = z.object({
  status: z.enum(CHANGE_REQUEST_STATUS_FILTERS).optional(),
});
export type ChangeRequestsQuery = z.infer<typeof ChangeRequestsQuerySchema>;

export const ChangeRequestsResponseSchema = z.object({
  employeeId: z.number().int(),
  items: z.array(ChangeRequestSchema),
});
export type ChangeRequestsResponse = z.infer<typeof ChangeRequestsResponseSchema>;

const ChangeSubmitShape = {
  /** Supporting documents, uploaded first through POST /attachments. */
  attachmentIds: AttachmentIdsSchema.optional(),
  /** The applicant's comment on the workflow. */
  comment: z.string().trim().max(CHANGE_COMMENT_MAX).optional(),
};

/** DELETE of a licence or family member (applied on approval). */
export const DeleteDetailRequestSchema = VersionSchema.extend({
  comment: z.string().trim().max(CHANGE_COMMENT_MAX).optional(),
});
export type DeleteDetailRequest = z.infer<typeof DeleteDetailRequestSchema>;

// ───────────── Personal details (section 5.4.1, workflow BASICINF) ─────────────

export const PersonalIdentityInputSchema = z.object({
  title: text(40),
  initials: text(20),
  lastName: requiredText(100).optional(),
  firstName: requiredText(100).optional(),
  secondName: text(100),
  otherNames: text(150),
  knownAs: text(100),
  maidenName: text(100),
  identityNumber: sensitiveText(40),
  dateOfBirth: z.preprocess(blankToNull, EmployeeDateOfBirthSchema.nullable()).optional(),
  identityType: text(60),
  countryOfBirth: optionalCountry,
  passportNumber: sensitiveText(40),
  passportCountry: optionalCountry,
  taxNumber: sensitiveText(40),
  nationality: optionalCountry,
  birthCertificateNumber: sensitiveText(40),
  cityOfBirth: text(100),
  homeLanguage: text(60),
  gender: text(60),
  maritalStatus: text(60),
  bloodGroup: text(60),
  religion: text(60),
});
export type PersonalIdentityInput = z.infer<typeof PersonalIdentityInputSchema>;

/**
 * PUT /me/personal (and PUT /admin/employees/:id/personal for HR). Every section is optional and a
 * missing field is unchanged; `''` or null clears a field. The encrypted numbers (identity,
 * passport, tax, birth certificate) are only sent when they change: a new value, or
 * `{ clear: true }` to remove the number without revealing it first.
 */
export const UpdatePersonalDetailsRequestSchema = z.object({
  /** `version` of the personal details as read. */
  version: z.number().int().positive(),
  identity: PersonalIdentityInputSchema.optional(),
  physicalAddress: PhysicalAddressInputSchema.optional(),
  postalAddress: PostalAddressInputSchema.optional(),
  workAddress: WorkAddressInputSchema.optional(),
  /** Correspondence Address: Physical, Postal, Work, or null ("None…"). */
  correspondenceAddressType: AddressTypeSchema.nullable().optional(),
  contacts: ContactNumbersInputSchema.optional(),
  /** Replaces the "Other Contact Details" rows as a whole. */
  otherContacts: z.array(OtherContactInputSchema).max(OTHER_CONTACTS_MAX).optional(),
  ...ChangeSubmitShape,
});
export type UpdatePersonalDetailsRequest = z.infer<typeof UpdatePersonalDetailsRequestSchema>;

export const PersonalIdentitySchema = z.object({
  title: nullableString,
  initials: nullableString,
  lastName: z.string(),
  firstName: z.string(),
  secondName: nullableString,
  otherNames: nullableString,
  knownAs: nullableString,
  maidenName: nullableString,
  /** Read-only. */
  entityCode: z.string(),
  /** `••••1234`; the full numbers come from GET /me/personal/id-numbers. */
  identityNumberMasked: nullableString,
  dateOfBirth: BusinessDateSchema.nullable(),
  /** "Age: n", calculated by the server. */
  age: z.number().int().nullable(),
  identityType: nullableString,
  countryOfBirth: nullableString,
  passportNumberMasked: nullableString,
  passportCountry: nullableString,
  taxNumberMasked: nullableString,
  nationality: nullableString,
  birthCertificateNumberMasked: nullableString,
  cityOfBirth: nullableString,
  homeLanguage: nullableString,
  gender: nullableString,
  maritalStatus: nullableString,
  bloodGroup: nullableString,
  religion: nullableString,
});
export type PersonalIdentity = z.infer<typeof PersonalIdentitySchema>;

/** GET /me/personal (and GET /admin/employees/:id/personal). */
export const PersonalDetailsSchema = z.object({
  employeeId: z.number().int(),
  employeeCode: z.string(),
  displayName: z.string(),
  /** Send this back with PUT. */
  version: z.number().int(),
  identity: PersonalIdentitySchema,
  physicalAddress: AddressSchema,
  postalAddress: AddressSchema,
  workAddress: AddressSchema,
  correspondenceAddressType: AddressTypeSchema.nullable(),
  contacts: ContactNumbersSchema,
  otherContacts: z.array(OtherContactSchema),
  /** True while "Working as" someone else: the full ID numbers cannot be shown. */
  idNumbersRestricted: z.boolean(),
  /** Warnings on the stored data, e.g. the Namibian ID number check. */
  warnings: z.array(FieldIssueSchema),
  pendingChange: PendingChangeSchema.nullable(),
});
export type PersonalDetails = z.infer<typeof PersonalDetailsSchema>;

/** GET /me/personal/id-numbers: the unmasked numbers (audited; refused while working as someone). */
export const PersonalIdNumbersSchema = z.object({
  employeeId: z.number().int(),
  identityNumber: nullableString,
  passportNumber: nullableString,
  taxNumber: nullableString,
  birthCertificateNumber: nullableString,
});
export type PersonalIdNumbers = z.infer<typeof PersonalIdNumbersSchema>;

/** PUT /admin/employees/:id/personal: HR applies directly (same domain service, audited). */
export const AdminPersonalDetailsUpdateResponseSchema = z.object({
  personal: PersonalDetailsSchema,
  warnings: z.array(FieldIssueSchema),
  changedFields: z.array(z.string()),
});
export type AdminPersonalDetailsUpdateResponse = z.infer<typeof AdminPersonalDetailsUpdateResponseSchema>;

// ───────────── Banks and bank accounts (section 5.4.2, workflow BANKDET) ─────────────

export const BankSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  universalBranchCode: nullableString,
  country: nullableString,
});
export type Bank = z.infer<typeof BankSchema>;

/** GET /banks: the active banks. */
export const BanksResponseSchema = z.object({ items: z.array(BankSchema) });
export type BanksResponse = z.infer<typeof BanksResponseSchema>;

export const BankBranchSchema = z.object({
  id: z.number().int(),
  bankId: z.number().int(),
  name: z.string(),
  /** ASSUMPTION A12: branch codes were not visible in the source; HR edits them. */
  code: nullableString,
});
export type BankBranch = z.infer<typeof BankBranchSchema>;

/** GET /banks/:id/branches: the active branches of a bank. */
export const BankBranchesResponseSchema = z.object({
  bankId: z.number().int(),
  items: z.array(BankBranchSchema),
});
export type BankBranchesResponse = z.infer<typeof BankBranchesResponseSchema>;

/** Digits only (spaces and dashes are removed), 5 to 20 of them. */
export const BankAccountNumberSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\d{5,20}$/, 'An account number has 5 to 20 digits'));

export const CurrencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code');

/** A bank change always needs a supporting document (ASSUMPTION A13; Third Party too). */
const RequiredAttachmentIdsSchema = AttachmentIdsSchema.refine(
  (ids) => ids.length > 0,
  'Attach a supporting document',
);

/** POST /me/bank-accounts: a new salary account that replaces the active one on approval. */
export const CreateBankAccountRequestSchema = z.object({
  accountType: BankAccountTypeSchema,
  accountHolderName: requiredText(150),
  accountHolderRelationship: AccountHolderRelationshipSchema,
  bankId: z.number().int().positive(),
  branchId: z.number().int().positive().nullable().optional(),
  accountNumber: BankAccountNumberSchema,
  currency: CurrencySchema.default('NAD'),
  attachmentIds: RequiredAttachmentIdsSchema,
  comment: ChangeSubmitShape.comment,
});
export type CreateBankAccountRequest = z.infer<typeof CreateBankAccountRequestSchema>;

/** PUT /me/bank-accounts/:id: changes an account; a missing field (or number) is unchanged. */
export const UpdateBankAccountRequestSchema = VersionSchema.extend({
  accountType: BankAccountTypeSchema.optional(),
  accountHolderName: requiredText(150).optional(),
  accountHolderRelationship: AccountHolderRelationshipSchema.optional(),
  bankId: z.number().int().positive().optional(),
  branchId: z.number().int().positive().nullable().optional(),
  accountNumber: BankAccountNumberSchema.optional(),
  currency: CurrencySchema.optional(),
  attachmentIds: RequiredAttachmentIdsSchema,
  comment: ChangeSubmitShape.comment,
});
export type UpdateBankAccountRequest = z.infer<typeof UpdateBankAccountRequestSchema>;

/** A row of the "existing accounts" grid (section 5.4.2). */
export const BankAccountSchema = z.object({
  id: z.number().int(),
  version: z.number().int(),
  /** `••••1234`. */
  accountNumberMasked: z.string(),
  accountHolderName: z.string(),
  accountHolderRelationship: AccountHolderRelationshipSchema,
  accountHolderRelationshipLabel: z.string(),
  accountType: BankAccountTypeSchema,
  accountTypeLabel: z.string(),
  bankId: z.number().int(),
  bankName: z.string(),
  branchId: z.number().int().nullable(),
  branchName: nullableString,
  branchCode: nullableString,
  currency: z.string(),
  isActive: z.boolean(),
  effectiveFrom: BusinessDateSchema,
  effectiveTo: BusinessDateSchema.nullable(),
  pendingChange: PendingChangeSchema.nullable(),
});
export type BankAccount = z.infer<typeof BankAccountSchema>;

/** GET /me/bank-accounts. */
export const BankAccountsResponseSchema = z.object({
  employeeId: z.number().int(),
  /** "Bank Details for: {name}". */
  heading: z.string(),
  /** Active accounts (the grid). */
  items: z.array(BankAccountSchema),
  /** Replaced accounts, newest first. */
  history: z.array(BankAccountSchema),
  /** An open "new account" change. */
  pendingCreate: PendingChangeSchema.nullable(),
});
export type BankAccountsResponse = z.infer<typeof BankAccountsResponseSchema>;

/** GET /me/bank-accounts/:id/unmasked?reason=: PAYROLL_ADMIN only, audited. */
export const BankAccountUnmaskQuerySchema = z.object({
  reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500),
});
export type BankAccountUnmaskQuery = z.infer<typeof BankAccountUnmaskQuerySchema>;

export const BankAccountUnmaskedSchema = z.object({
  id: z.number().int(),
  employeeId: z.number().int(),
  accountNumber: z.string(),
});
export type BankAccountUnmasked = z.infer<typeof BankAccountUnmaskedSchema>;

/** GET /admin/employees/:id/bank-accounts (HR and Payroll in scope): the masked grid. */
export const AdminBankAccountsResponseSchema = BankAccountsResponseSchema;

export const AdminBankSchema = BankSchema.extend({
  isActive: z.boolean(),
  version: z.number().int(),
  branchCount: z.number().int(),
});
export type AdminBank = z.infer<typeof AdminBankSchema>;

export const AdminBanksResponseSchema = z.object({ items: z.array(AdminBankSchema) });
export type AdminBanksResponse = z.infer<typeof AdminBanksResponseSchema>;

export const CreateBankRequestSchema = z.object({
  name: requiredText(150),
  universalBranchCode: text(20),
  country: optionalCountry,
});
export type CreateBankRequest = z.infer<typeof CreateBankRequestSchema>;

export const UpdateBankRequestSchema = VersionSchema.extend({
  name: requiredText(150).optional(),
  universalBranchCode: text(20),
  country: optionalCountry,
  isActive: z.boolean().optional(),
});
export type UpdateBankRequest = z.infer<typeof UpdateBankRequestSchema>;

export const AdminBankBranchSchema = BankBranchSchema.extend({
  isActive: z.boolean(),
  version: z.number().int(),
});
export type AdminBankBranch = z.infer<typeof AdminBankBranchSchema>;

export const AdminBankBranchesResponseSchema = z.object({
  bankId: z.number().int(),
  items: z.array(AdminBankBranchSchema),
});
export type AdminBankBranchesResponse = z.infer<typeof AdminBankBranchesResponseSchema>;

export const CreateBankBranchRequestSchema = z.object({ name: requiredText(150), code: text(20) });
export type CreateBankBranchRequest = z.infer<typeof CreateBankBranchRequestSchema>;

export const UpdateBankBranchRequestSchema = VersionSchema.extend({
  name: requiredText(150).optional(),
  code: text(20),
  isActive: z.boolean().optional(),
});
export type UpdateBankBranchRequest = z.infer<typeof UpdateBankBranchRequestSchema>;

export const BankBranchParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  branchId: z.coerce.number().int().positive(),
});
export type BankBranchParam = z.infer<typeof BankBranchParamSchema>;

// ───────────── Drivers licences (section 5.4.3, workflow DRIVERSLICENSE) ─────────────

const LicenceShape = {
  licenceNumber: z.string().trim().min(4, 'Enter the licence number').max(40),
  /** Code/Class (A1, A, B, C1, C, EB, EC1, EC), from the licenceCodes lookup. */
  code: z.string().trim().min(1, 'Pick a code').max(10),
  issueDate: optionalDate,
  expiryDate: BusinessDateSchema,
  countryOfIssue: optionalCountry,
  restrictions: text(200),
  /** Professional Driving Permit (Y/N + expiry). */
  hasPdp: z.boolean().default(false),
  pdpExpiryDate: optionalDate,
};

function licenceDates(
  value: { issueDate?: string | null; expiryDate?: string; hasPdp?: boolean; pdpExpiryDate?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (value.issueDate && value.expiryDate && value.expiryDate < value.issueDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiryDate'], message: 'Expiry is before issue' });
  }
  if (value.issueDate && value.issueDate > todayBusinessDate()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['issueDate'],
      message: 'Issue date is in the future',
    });
  }
  if (value.hasPdp === true && !value.pdpExpiryDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pdpExpiryDate'],
      message: 'Enter the PDP expiry date',
    });
  }
}

/** POST /me/drivers-licences. A copy of the licence is required (ASSUMPTION A14). */
export const CreateDriversLicenceRequestSchema = z
  .object({
    ...LicenceShape,
    attachmentIds: AttachmentIdsSchema.refine((ids) => ids.length > 0, 'Attach a copy of the licence'),
    comment: ChangeSubmitShape.comment,
  })
  .superRefine(licenceDates);
export type CreateDriversLicenceRequest = z.infer<typeof CreateDriversLicenceRequestSchema>;

/** PUT /me/drivers-licences/:id: a missing field is unchanged; a copy of the licence is required. */
export const UpdateDriversLicenceRequestSchema = VersionSchema.extend({
  licenceNumber: LicenceShape.licenceNumber.optional(),
  code: LicenceShape.code.optional(),
  issueDate: optionalDate,
  expiryDate: BusinessDateSchema.optional(),
  countryOfIssue: optionalCountry,
  restrictions: text(200),
  hasPdp: z.boolean().optional(),
  pdpExpiryDate: optionalDate,
  attachmentIds: AttachmentIdsSchema.refine((ids) => ids.length > 0, 'Attach a copy of the licence'),
  comment: ChangeSubmitShape.comment,
}).superRefine(licenceDates);
export type UpdateDriversLicenceRequest = z.infer<typeof UpdateDriversLicenceRequestSchema>;

export const DriversLicenceSchema = z.object({
  id: z.number().int(),
  version: z.number().int(),
  licenceNumberMasked: z.string(),
  code: z.string(),
  issueDate: BusinessDateSchema.nullable(),
  expiryDate: BusinessDateSchema,
  countryOfIssue: nullableString,
  restrictions: nullableString,
  hasPdp: z.boolean(),
  pdpExpiryDate: BusinessDateSchema.nullable(),
  isExpired: z.boolean(),
  /** Negative once expired. */
  expiresInDays: z.number().int(),
  /** The copies of the licence sent with its approved changes. */
  attachments: z.array(AttachmentSchema),
  pendingChange: PendingChangeSchema.nullable(),
});
export type DriversLicence = z.infer<typeof DriversLicenceSchema>;

/** GET /me/drivers-licences. */
export const DriversLicencesResponseSchema = z.object({
  employeeId: z.number().int(),
  items: z.array(DriversLicenceSchema),
  emptyText: z.string(),
  pendingCreate: PendingChangeSchema.nullable(),
});
export type DriversLicencesResponse = z.infer<typeof DriversLicencesResponseSchema>;

// ───────────── Family (section 5.4.4, workflow BASICINF per ASSUMPTION A16) ─────────────

const FamilyShape = {
  relationship: requiredText(60),
  title: text(40),
  initials: text(20),
  firstName: requiredText(100),
  secondName: text(100),
  otherNames: text(150),
  lastName: requiredText(100),
  knownAs: text(100),
  identityNumber: sensitiveText(40),
  gender: text(60),
  dateOfBirth: z.preprocess(blankToNull, FamilyDateOfBirthSchema.nullable()).optional(),
  nationality: optionalCountry,
  isEmergencyContact: z.boolean().optional(),
  emergencyDetail: text(500),
  physicalAddress: PhysicalAddressInputSchema.optional(),
  postalAddress: PostalAddressInputSchema.optional(),
  contacts: ContactNumbersInputSchema.optional(),
};

/** POST /me/family. */
export const CreateFamilyMemberRequestSchema = z.object({ ...FamilyShape, ...ChangeSubmitShape });
export type CreateFamilyMemberRequest = z.infer<typeof CreateFamilyMemberRequestSchema>;

/** PUT /me/family/:id: a missing field is unchanged. */
export const UpdateFamilyMemberRequestSchema = VersionSchema.extend({
  ...FamilyShape,
  relationship: FamilyShape.relationship.optional(),
  firstName: FamilyShape.firstName.optional(),
  lastName: FamilyShape.lastName.optional(),
  ...ChangeSubmitShape,
});
export type UpdateFamilyMemberRequest = z.infer<typeof UpdateFamilyMemberRequestSchema>;

export const FamilyMemberSchema = z.object({
  id: z.number().int(),
  version: z.number().int(),
  knownAs: nullableString,
  lastName: z.string(),
  relationship: z.string(),
  title: nullableString,
  firstName: z.string(),
  otherNames: nullableString,
  identityNumberMasked: nullableString,
  gender: nullableString,
  initials: nullableString,
  secondName: nullableString,
  dateOfBirth: BusinessDateSchema.nullable(),
  /** Calculated by the server. */
  age: z.number().int().nullable(),
  nationality: nullableString,
  isEmergencyContact: z.boolean(),
  emergencyDetail: nullableString,
  physicalAddress: AddressSchema,
  postalAddress: AddressSchema,
  contacts: ContactNumbersSchema,
  pendingChange: PendingChangeSchema.nullable(),
});
export type FamilyMember = z.infer<typeof FamilyMemberSchema>;

/** GET /me/family. */
export const FamilyMembersResponseSchema = z.object({
  employeeId: z.number().int(),
  items: z.array(FamilyMemberSchema),
  emptyText: z.string(),
  pendingCreate: PendingChangeSchema.nullable(),
});
export type FamilyMembersResponse = z.infer<typeof FamilyMembersResponseSchema>;

// ───────────── Beneficiaries (section 5.4.5, workflow BENEFICIARY) ─────────────

export const PercentageSchema = DecimalStringSchema.refine(
  (v) => DECIMAL_STRING_PATTERN.test(v) && dec(v).decimalPlaces() <= 2,
  'Use at most 2 decimal places',
);

/** A beneficiary: a family member, or a free person with a name and relationship. */
export const BeneficiaryInputSchema = z
  .object({
    /** An existing beneficiary of the fund being kept (its ID number stays unless sent). */
    id: z.number().int().positive().optional(),
    familyMemberId: z.number().int().positive().nullable().optional(),
    name: text(150),
    relationship: text(60),
    identityNumber: sensitiveText(40),
    percentage: PercentageSchema,
  })
  .superRefine((row, ctx) => {
    if (row.familyMemberId) return;
    if (!row.name) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['name'], message: 'Enter the name' });
    if (!row.relationship) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['relationship'], message: 'Pick a relationship' });
    }
  });
export type BeneficiaryInput = z.infer<typeof BeneficiaryInputSchema>;

/** PUT /me/funds/:membershipId/beneficiaries: replaces the fund's beneficiaries (total 100.00). */
export const UpdateBeneficiariesRequestSchema = VersionSchema.extend({
  beneficiaries: z
    .array(BeneficiaryInputSchema)
    .min(1, 'Add at least one beneficiary')
    .max(BENEFICIARIES_MAX),
  ...ChangeSubmitShape,
}).superRefine((value, ctx) => {
  for (const issue of beneficiaryPercentageIssues(value.beneficiaries)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path.split('.'), message: issue.message });
  }
});
export type UpdateBeneficiariesRequest = z.infer<typeof UpdateBeneficiariesRequestSchema>;

export const MembershipIdParamSchema = z.object({ membershipId: z.coerce.number().int().positive() });
export type MembershipIdParam = z.infer<typeof MembershipIdParamSchema>;

export const BeneficiarySchema = z.object({
  id: z.number().int(),
  familyMemberId: z.number().int().nullable(),
  name: z.string(),
  relationship: z.string(),
  identityNumberMasked: nullableString,
  percentage: z.string(),
});
export type Beneficiary = z.infer<typeof BeneficiarySchema>;

export const FundMembershipSchema = z.object({
  membershipId: z.number().int(),
  version: z.number().int(),
  fundId: z.number().int(),
  fundCode: z.string(),
  fundName: z.string(),
  memberNumber: nullableString,
  startDate: BusinessDateSchema.nullable(),
  beneficiaries: z.array(BeneficiarySchema),
  totalPercentage: z.string(),
  pendingChange: PendingChangeSchema.nullable(),
});
export type FundMembership = z.infer<typeof FundMembershipSchema>;

/** GET /me/funds. */
export const FundsResponseSchema = z.object({
  employeeId: z.number().int(),
  items: z.array(FundMembershipSchema),
  emptyText: z.string(),
});
export type FundsResponse = z.infer<typeof FundsResponseSchema>;

export const AdminRetirementFundSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  version: z.number().int(),
  memberCount: z.number().int(),
});
export type AdminRetirementFund = z.infer<typeof AdminRetirementFundSchema>;

export const AdminRetirementFundsResponseSchema = z.object({ items: z.array(AdminRetirementFundSchema) });
export type AdminRetirementFundsResponse = z.infer<typeof AdminRetirementFundsResponseSchema>;

export const CreateRetirementFundRequestSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]{2,20}$/, 'Use 2 to 20 letters, digits or underscores'),
  name: requiredText(150),
});
export type CreateRetirementFundRequest = z.infer<typeof CreateRetirementFundRequestSchema>;

export const UpdateRetirementFundRequestSchema = VersionSchema.extend({
  name: requiredText(150).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateRetirementFundRequest = z.infer<typeof UpdateRetirementFundRequestSchema>;

/** POST /admin/retirement-funds/:id/memberships: enrols an employee in the fund. */
export const CreateFundMembershipRequestSchema = z.object({
  employeeId: z.number().int().positive(),
  memberNumber: text(40),
  startDate: optionalDate,
});
export type CreateFundMembershipRequest = z.infer<typeof CreateFundMembershipRequestSchema>;

export const AdminFundMembershipSchema = z.object({
  membershipId: z.number().int(),
  fundId: z.number().int(),
  employeeId: z.number().int(),
  memberNumber: nullableString,
  startDate: BusinessDateSchema.nullable(),
  /** The last day of the membership once HR ended it; null while it is open. */
  endDate: BusinessDateSchema.nullable(),
  version: z.number().int(),
});
export type AdminFundMembership = z.infer<typeof AdminFundMembershipSchema>;

/**
 * GET /admin/retirement-funds/:id/memberships (HR_ADMIN): the fund's members in the caller's
 * companies, by surname. `search` matches the employee's name or code and the member number;
 * ended memberships are listed only with `includeEnded=true`.
 */
export const AdminFundMembershipsQuerySchema = z.object({
  search: SearchTextSchema,
  includeEnded: BooleanQuerySchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type AdminFundMembershipsQuery = z.infer<typeof AdminFundMembershipsQuerySchema>;

/** A row of the fund's membership list. */
export const AdminFundMemberSchema = AdminFundMembershipSchema.extend({
  employeeCode: z.string(),
  /** "{First} {Last}". */
  employeeName: z.string(),
  employeeStatus: EmployeeStatusSchema,
  /** False once the end date has passed (the employee no longer sees the fund). */
  isActive: z.boolean(),
  beneficiaryCount: z.number().int(),
});
export type AdminFundMember = z.infer<typeof AdminFundMemberSchema>;

export const AdminFundMembershipsResponseSchema = pageOf(AdminFundMemberSchema);
export type AdminFundMembershipsResponse = z.infer<typeof AdminFundMembershipsResponseSchema>;

export const FundMembershipParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  membershipId: z.coerce.number().int().positive(),
});
export type FundMembershipParam = z.infer<typeof FundMembershipParamSchema>;

/**
 * POST /admin/retirement-funds/:id/memberships/:membershipId/end: ends the membership on
 * `endDate` (default today, never before the start date). The row is kept (no hard delete); the
 * employee stops seeing the fund after that day. Enrolling the employee again reopens it.
 */
export const EndFundMembershipRequestSchema = VersionSchema.extend({
  endDate: BusinessDateSchema.optional(),
});
export type EndFundMembershipRequest = z.infer<typeof EndFundMembershipRequestSchema>;

// ───────────── Employee transactions (section 5.4.6, ASSUMPTION A17) ─────────────

export const TRANSACTION_INPUT_MODES = ['AMOUNT', 'QUANTITY'] as const;
export const TransactionInputModeSchema = z.enum(TRANSACTION_INPUT_MODES);
export type TransactionInputMode = z.infer<typeof TransactionInputModeSchema>;

export const EmployeeTransactionSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  description: z.string(),
  /** Money, 2 places; null for a quantity transaction. */
  amount: z.string().nullable(),
  /** 4 places; null for an amount transaction. */
  quantity: z.string().nullable(),
  isRecurring: z.boolean(),
  startDate: BusinessDateSchema.nullable(),
  endDate: BusinessDateSchema.nullable(),
  payPeriod: nullableString,
  status: ProcessStatusSchema,
  statusLabel: z.string(),
  referenceNumber: nullableString,
  processId: z.number().int().nullable(),
  comment: nullableString,
  createdAt: TimestampSchema,
});
export type EmployeeTransaction = z.infer<typeof EmployeeTransactionSchema>;

/** A code HR has opened for employee input. */
export const TransactionCodeOptionSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  description: z.string(),
  inputMode: TransactionInputModeSchema,
  requiresAttachment: z.boolean(),
});
export type TransactionCodeOption = z.infer<typeof TransactionCodeOptionSchema>;

/** GET /me/transactions. */
export const EmployeeTransactionsResponseSchema = z.object({
  employeeId: z.number().int(),
  /** Read-only recurring payroll transactions. */
  recurring: z.array(EmployeeTransactionSchema),
  /** Inputs the employee submitted (FREETEXTMANEMP), newest first. */
  submitted: z.array(EmployeeTransactionSchema),
  /** Codes the employee may submit inputs for. */
  codes: z.array(TransactionCodeOptionSchema),
});
export type EmployeeTransactionsResponse = z.infer<typeof EmployeeTransactionsResponseSchema>;

const MoneySchema = DecimalStringSchema.refine((v) => dec(v).decimalPlaces() <= 2, 'Use at most 2 decimals');
const QuantitySchema = DecimalStringSchema.refine(
  (v) => dec(v).decimalPlaces() <= 4,
  'Use at most 4 decimals',
);

/** POST /me/transactions: an employee-initiated payroll input for a configured code. */
export const SubmitEmployeeTransactionRequestSchema = z
  .object({
    transactionCodeId: z.number().int().positive(),
    amount: MoneySchema.refine((v) => dec(v).gt(0), 'The amount must be more than 0').optional(),
    quantity: QuantitySchema.refine((v) => dec(v).gt(0), 'The quantity must be more than 0').optional(),
    ...ChangeSubmitShape,
  })
  .refine((v) => (v.amount === undefined) !== (v.quantity === undefined), {
    message: 'Enter either an amount or a quantity',
    path: ['amount'],
  });
export type SubmitEmployeeTransactionRequest = z.infer<typeof SubmitEmployeeTransactionRequestSchema>;

export const AdminTransactionCodeSchema = TransactionCodeOptionSchema.extend({
  allowEmployeeInput: z.boolean(),
  isActive: z.boolean(),
  version: z.number().int(),
});
export type AdminTransactionCode = z.infer<typeof AdminTransactionCodeSchema>;

export const AdminTransactionCodesResponseSchema = z.object({ items: z.array(AdminTransactionCodeSchema) });
export type AdminTransactionCodesResponse = z.infer<typeof AdminTransactionCodesResponseSchema>;

export const CreateTransactionCodeRequestSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]{2,20}$/, 'Use 2 to 20 letters, digits or underscores'),
  description: requiredText(150),
  allowEmployeeInput: z.boolean().default(false),
  inputMode: TransactionInputModeSchema.default('AMOUNT'),
  requiresAttachment: z.boolean().default(false),
});
export type CreateTransactionCodeRequest = z.infer<typeof CreateTransactionCodeRequestSchema>;

export const UpdateTransactionCodeRequestSchema = VersionSchema.extend({
  description: requiredText(150).optional(),
  allowEmployeeInput: z.boolean().optional(),
  inputMode: TransactionInputModeSchema.optional(),
  requiresAttachment: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateTransactionCodeRequest = z.infer<typeof UpdateTransactionCodeRequestSchema>;

// ───────────── Field labels for approvers and the banner ─────────────

const IDENTITY_LABELS: Record<string, string> = {
  title: 'Title',
  initials: 'Initials',
  lastName: 'Surname',
  firstName: 'First Name',
  secondName: 'Second Name',
  otherNames: 'Other Names',
  knownAs: 'Known As',
  maidenName: 'Maiden Name',
  identityNumber: 'Identity Number',
  dateOfBirth: 'Date of Birth',
  identityType: 'Identity Type',
  countryOfBirth: 'Country of Birth',
  passportNumber: 'Passport Number',
  passportCountry: 'Passport Country',
  taxNumber: 'Tax Number',
  nationality: 'Nationality Country',
  birthCertificateNumber: 'Birth Certificate Number',
  cityOfBirth: 'City Of Birth',
  homeLanguage: 'Home Language',
  gender: 'Gender',
  maritalStatus: 'Marital Status',
  bloodGroup: 'Blood Group',
  religion: 'Religion',
  relationship: 'Relationship',
  isEmergencyContact: 'Emergency Contact',
  emergencyDetail: 'Emergency Detail',
};

const ADDRESS_LABELS: Record<string, string> = {
  sameAs: 'Same As',
  unitNumber: 'Unit Number',
  block: 'Block',
  complex: 'Complex',
  levelFloor: 'Level/Floor',
  streetNumber: 'Street Number',
  streetName: 'Street/Farm Name',
  suburb: 'Suburb/District',
  city: 'City/Town',
  postalCode: 'Postal Code',
  country: 'Country',
  province: 'Province',
  district: 'District',
  careOfName: 'Care of Name',
  serviceType: 'Address Service Type',
  postalAddressNumber: 'Postal Address Number',
};

const SECTION_LABELS: Record<string, string> = {
  physicalAddress: 'Physical Address',
  postalAddress: 'Postal Address',
  workAddress: 'Work Address',
};

const CONTACT_LABELS: Record<string, string> = {
  cell: 'Cell Number',
  email: 'E-Mail Address',
  fax: 'Fax Number',
  home: 'Home Number',
  work: 'Work Number',
};

const OTHER_LABELS: Record<string, string> = {
  correspondenceAddressType: 'Correspondence Address',
  otherContacts: 'Other Contact Details',
  accountType: 'Type of Account',
  accountHolderName: 'Account Holder Name',
  accountHolderRelationship: 'Account Holder Relationship',
  bankId: 'Bank Name',
  branchId: 'Branch',
  accountNumber: 'Account Number',
  currency: 'Currency',
  licenceNumber: 'Licence Number',
  code: 'Code/Class',
  issueDate: 'Issue Date',
  expiryDate: 'Expiry Date',
  countryOfIssue: 'Country of Issue',
  restrictions: 'Restrictions',
  hasPdp: 'Professional Driving Permit',
  pdpExpiryDate: 'PDP Expiry Date',
  beneficiaries: 'Beneficiaries',
};

/** The form label of a changed field path, e.g. `physicalAddress.city` → "Physical Address: City/Town". */
export function changeFieldLabel(path: string): string {
  const [head = '', leaf] = path.split('.', 2);
  if (head === 'identity' && leaf) return IDENTITY_LABELS[leaf] ?? leaf;
  if (head === 'contacts' && leaf) return CONTACT_LABELS[leaf] ?? leaf;
  if (SECTION_LABELS[head] && leaf) return `${SECTION_LABELS[head]}: ${ADDRESS_LABELS[leaf] ?? leaf}`;
  if (leaf === undefined) return OTHER_LABELS[head] ?? IDENTITY_LABELS[head] ?? head;
  return path;
}

/** The i18n namespace of each record's field labels. */
export const CHANGE_ENTITY_LABEL_KEYS: Record<ChangeEntityType, string> = {
  Employee: 'details.personal',
  BankAccount: 'details.bank',
  DriversLicence: 'details.licence',
  FamilyMember: 'details.family',
  FundMembership: 'details.beneficiaries',
};

/**
 * The stable i18n key of a changed field's label: the record's namespace plus the field path,
 * without the `identity` section and list indexes. `identity.firstName` on personal details →
 * `details.personal.firstName`; `physicalAddress.city` → `details.personal.physicalAddress.city`;
 * `accountNumber` on a bank account → `details.bank.accountNumber`.
 */
export function changeFieldLabelKey(entityType: ChangeEntityType, path: string): string {
  const parts = path.split('.').filter((part) => part !== '' && !/^\d+$/.test(part));
  if (parts[0] === 'identity' && parts.length > 1) parts.shift();
  return [CHANGE_ENTITY_LABEL_KEYS[entityType], ...parts].join('.');
}

// ───────────── Inbox subject data (BASICINF, BANKDET, DRIVERSLICENSE, BENEFICIARY, FREETEXTMANEMP) ─────────────

/**
 * `subject.data` of a change request in the inbox detail: the Field / Before / After rows
 * (`changes`), sensitive values masked unless `revealed` (a payroll administrator reviewing a new
 * bank account number).
 */
export const ChangeSubjectDataSchema = z.object({
  changeRequestId: z.number().int(),
  referenceNumber: z.string(),
  entityType: ChangeEntityTypeSchema,
  /** e.g. "Personal details", "Bank account". */
  entityLabel: z.string(),
  /** Null for a create that is not applied yet. */
  entityId: z.string().nullable(),
  operation: ChangeOperationSchema,
  status: ProcessStatusSchema,
  changes: z.array(ChangeFieldSchema),
  revealed: z.boolean(),
});
export type ChangeSubjectData = z.infer<typeof ChangeSubjectDataSchema>;

/** `subject.data` of an employee transaction input (FREETEXTMANEMP) in the inbox detail. */
export const EmployeeTransactionSubjectDataSchema = z.object({
  employeeTransactionId: z.number().int(),
  referenceNumber: z.string().nullable(),
  code: z.string(),
});
export type EmployeeTransactionSubjectData = z.infer<typeof EmployeeTransactionSubjectDataSchema>;
