import { z } from 'zod';
import { ClaimSubjectDataSchema } from './claims';
import { ChangeSubjectDataSchema, EmployeeTransactionSubjectDataSchema } from './details';
import { FreeTextSubjectDataSchema } from './free-text';
import { CreditLeaveSubjectDataSchema, LeaveSubjectDataSchema } from './leave';

// The typed `subject.data` of the inbox detail (section 5.10), discriminated by `subject.kind`.
// Each workflow type's handler describes its own subject; `kind` says which shape `data` has.

/**
 * Which shape `subject.data` has:
 * - `LEAVE`: LEAVE and CANCELLEAVE ({@link LeaveSubjectDataSchema});
 * - `CREDIT_LEAVE`: CREDITLVEREQ and CREDITLVEALLOC ({@link CreditLeaveSubjectDataSchema});
 * - `CLAIM`: CLAIMS and GROUPEDCLAIM ({@link ClaimSubjectDataSchema});
 * - `CHANGE_REQUEST`: BASICINF, BANKDET, DRIVERSLICENSE and BENEFICIARY ({@link ChangeSubjectDataSchema});
 * - `EMPLOYEE_TRANSACTION`: FREETEXTMANEMP employee inputs ({@link EmployeeTransactionSubjectDataSchema});
 * - `FREE_TEXT`: FREETEXT and FREETEXTMANEMP free text requests ({@link FreeTextSubjectDataSchema});
 * - `GENERIC`: every other subject; `data` is an open object (often empty).
 */
export const SUBJECT_DATA_KINDS = [
  'LEAVE',
  'CREDIT_LEAVE',
  'CLAIM',
  'CHANGE_REQUEST',
  'EMPLOYEE_TRANSACTION',
  'FREE_TEXT',
  'GENERIC',
] as const;
export const SubjectDataKindSchema = z.enum(SUBJECT_DATA_KINDS);
export type SubjectDataKind = z.infer<typeof SubjectDataKindSchema>;

/** `data` of a GENERIC subject: whatever the handler added (no fixed shape). */
export const GenericSubjectDataSchema = z.record(z.unknown());
export type GenericSubjectData = z.infer<typeof GenericSubjectDataSchema>;

/** A label/value pair in the detail panel ("Leave type: Annual Leave"). */
export const SubjectFieldSchema = z.object({
  label: z.string(),
  value: z.string(),
});
export type SubjectField = z.infer<typeof SubjectFieldSchema>;

const SubjectDetailBase = z.object({
  /** Panel heading, e.g. "Leave request". */
  title: z.string(),
  requestLabel: z.string(),
  /** The highlighted figures, e.g. "Days available", "Days to be deducted". */
  headline: z.array(SubjectFieldSchema),
  /** The field list in display order. */
  fields: z.array(SubjectFieldSchema),
});

/**
 * The subject DTO of the inbox detail panel. Switch on `kind` to read `data` with its type;
 * `title`, `requestLabel`, `headline` and `fields` are the same for every kind.
 */
export const SubjectDetailSchema = z.discriminatedUnion('kind', [
  SubjectDetailBase.extend({ kind: z.literal('LEAVE'), data: LeaveSubjectDataSchema }),
  SubjectDetailBase.extend({ kind: z.literal('CREDIT_LEAVE'), data: CreditLeaveSubjectDataSchema }),
  SubjectDetailBase.extend({ kind: z.literal('CLAIM'), data: ClaimSubjectDataSchema }),
  SubjectDetailBase.extend({ kind: z.literal('CHANGE_REQUEST'), data: ChangeSubjectDataSchema }),
  SubjectDetailBase.extend({
    kind: z.literal('EMPLOYEE_TRANSACTION'),
    data: EmployeeTransactionSubjectDataSchema,
  }),
  SubjectDetailBase.extend({ kind: z.literal('FREE_TEXT'), data: FreeTextSubjectDataSchema }),
  SubjectDetailBase.extend({ kind: z.literal('GENERIC'), data: GenericSubjectDataSchema }),
]);
export type SubjectDetail = z.infer<typeof SubjectDetailSchema>;

/** The typed subject data, by kind (for handlers that build `data`). */
export interface SubjectDataByKind {
  LEAVE: z.infer<typeof LeaveSubjectDataSchema>;
  CREDIT_LEAVE: z.infer<typeof CreditLeaveSubjectDataSchema>;
  CLAIM: z.infer<typeof ClaimSubjectDataSchema>;
  CHANGE_REQUEST: z.infer<typeof ChangeSubjectDataSchema>;
  EMPLOYEE_TRANSACTION: z.infer<typeof EmployeeTransactionSubjectDataSchema>;
  FREE_TEXT: z.infer<typeof FreeTextSubjectDataSchema>;
  GENERIC: GenericSubjectData;
}

/** A subject's `data` narrowed to `kind`, or null for another kind. */
export function subjectDataOf<K extends SubjectDataKind>(
  subject: Pick<SubjectDetail, 'kind' | 'data'>,
  kind: K,
): SubjectDataByKind[K] | null {
  return subject.kind === kind ? (subject.data as SubjectDataByKind[K]) : null;
}
