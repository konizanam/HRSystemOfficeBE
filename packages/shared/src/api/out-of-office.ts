import { z } from 'zod';
import { OutOfOfficeModeSchema, WorkflowTypeCodeSchema } from '../enums';
import { BusinessDateSchema, TimestampSchema } from './common';
import { UserOptionSchema } from './workflow';

// Contracts for GET/PUT /profile/out-of-office (sections 5.11 and 12.8).

/** A nominated approver. */
export const NomineeSchema = z.object({
  userId: z.string(),
  name: z.string(),
  displayName: z.string(),
  employeeCode: z.string().nullable(),
});
export type Nominee = z.infer<typeof NomineeSchema>;

export const OutOfOfficeRuleSchema = z.object({
  workflowType: WorkflowTypeCodeSchema,
  nominee: NomineeSchema,
});
export type OutOfOfficeRule = z.infer<typeof OutOfOfficeRuleSchema>;

/** GET /profile/out-of-office (and the PUT response). */
export const OutOfOfficeResponseSchema = z.object({
  mode: OutOfOfficeModeSchema,
  fromDate: BusinessDateSchema.nullable(),
  toDate: BusinessDateSchema.nullable(),
  /** "My main nominated approver is {user}". */
  mainNominee: NomineeSchema.nullable(),
  /** "Setup nominated approvers per Workflow Type"; a rule overrides the main nominee. */
  rules: z.array(OutOfOfficeRuleSchema),
  /** Send back with the PUT; 0 while nothing has been saved yet. */
  version: z.number().int(),
  /** True when new inbox items are being sent to the nominee today. */
  isOutOfOfficeNow: z.boolean(),
  updatedAt: TimestampSchema.nullable(),
});
export type OutOfOfficeResponse = z.infer<typeof OutOfOfficeResponseSchema>;

/** PUT /profile/out-of-office. */
export const UpdateOutOfOfficeRequestSchema = z
  .object({
    mode: OutOfOfficeModeSchema,
    fromDate: BusinessDateSchema.nullable().optional(),
    toDate: BusinessDateSchema.nullable().optional(),
    mainNomineeUserId: z.string().uuid().nullable(),
    rules: z
      .array(z.object({ workflowType: WorkflowTypeCodeSchema, nomineeUserId: z.string().uuid() }))
      .max(16)
      .default([]),
    version: z.number().int().min(0),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'DATE_RANGE') {
      if (!value.fromDate)
        ctx.addIssue({ code: 'custom', path: ['fromDate'], message: 'Enter the first day' });
      if (!value.toDate) ctx.addIssue({ code: 'custom', path: ['toDate'], message: 'Enter the last day' });
      if (value.fromDate && value.toDate && value.toDate < value.fromDate) {
        ctx.addIssue({
          code: 'custom',
          path: ['toDate'],
          message: 'The last day must be on or after the first',
        });
      }
    }
    if (value.mode !== 'OFF' && !value.mainNomineeUserId) {
      ctx.addIssue({
        code: 'custom',
        path: ['mainNomineeUserId'],
        message: 'Choose your main nominated approver',
      });
    }
    const types = value.rules.map((r) => r.workflowType);
    types.forEach((type, index) => {
      if (types.indexOf(type) !== index) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'workflowType'],
          message: 'This workflow type already has a nominee',
        });
      }
    });
  });
export type UpdateOutOfOfficeRequest = z.infer<typeof UpdateOutOfOfficeRequestSchema>;

/** GET /profile/out-of-office/nominees?search=: people who can be nominated (same company). */
export const NomineeOptionsResponseSchema = z.object({
  items: z.array(UserOptionSchema),
  truncated: z.boolean(),
});
export type NomineeOptionsResponse = z.infer<typeof NomineeOptionsResponseSchema>;
