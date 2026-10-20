import { z } from 'zod';

// Mirrors the Prisma enums in apps/api/prisma/schema.prisma. Keep the two in sync.

export const ROLES = ['EMPLOYEE', 'MANAGER', 'HR_ADMIN', 'PAYROLL_ADMIN', 'SYSTEM_ADMIN', 'AUDITOR'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

export const AUTH_PROVIDERS = ['LOCAL', 'OAUTH'] as const;
export const AuthProviderSchema = z.enum(AUTH_PROVIDERS);
export type AuthProvider = z.infer<typeof AuthProviderSchema>;

export const EMPLOYEE_STATUSES = ['ACTIVE', 'SUSPENDED', 'TERMINATED'] as const;
export const EmployeeStatusSchema = z.enum(EMPLOYEE_STATUSES);
export type EmployeeStatus = z.infer<typeof EmployeeStatusSchema>;

export const ADDRESS_TYPES = ['PHYSICAL', 'POSTAL', 'WORK'] as const;
export const AddressTypeSchema = z.enum(ADDRESS_TYPES);
export type AddressType = z.infer<typeof AddressTypeSchema>;

export const POSTAL_SERVICE_TYPES = ['PO_BOX', 'PRIVATE_BAG', 'POSTNET_SUITE', 'STREET', 'OTHER'] as const;
export const PostalServiceTypeSchema = z.enum(POSTAL_SERVICE_TYPES);
export type PostalServiceType = z.infer<typeof PostalServiceTypeSchema>;
export const POSTAL_SERVICE_TYPE_LABELS: Record<PostalServiceType, string> = {
  PO_BOX: 'P O Box',
  PRIVATE_BAG: 'Private Bag',
  POSTNET_SUITE: 'Postnet Suite',
  STREET: 'Street',
  OTHER: 'Other Service Type',
};

export const CONTACT_TYPES = ['CELL', 'EMAIL', 'FAX', 'HOME', 'WORK'] as const;
export const ContactTypeSchema = z.enum(CONTACT_TYPES);
export type ContactType = z.infer<typeof ContactTypeSchema>;

export const BANK_ACCOUNT_TYPES = ['CURRENT', 'LOAN', 'TRANSMISSION', 'SAVINGS'] as const;
export const BankAccountTypeSchema = z.enum(BANK_ACCOUNT_TYPES);
export type BankAccountType = z.infer<typeof BankAccountTypeSchema>;
export const BANK_ACCOUNT_TYPE_LABELS: Record<BankAccountType, string> = {
  CURRENT: 'Current Account',
  LOAN: 'Loan Account',
  TRANSMISSION: 'Transmission Account',
  SAVINGS: 'Savings Account',
};

export const ACCOUNT_HOLDER_RELATIONSHIPS = ['OWN', 'JOINT', 'THIRD_PARTY'] as const;
export const AccountHolderRelationshipSchema = z.enum(ACCOUNT_HOLDER_RELATIONSHIPS);
export type AccountHolderRelationship = z.infer<typeof AccountHolderRelationshipSchema>;
export const ACCOUNT_HOLDER_RELATIONSHIP_LABELS: Record<AccountHolderRelationship, string> = {
  OWN: 'Own',
  JOINT: 'Joint',
  THIRD_PARTY: 'Third Party',
};

export const DAY_PORTIONS = ['FULL', 'AM', 'PM'] as const;
export const DayPortionSchema = z.enum(DAY_PORTIONS);
export type DayPortion = z.infer<typeof DayPortionSchema>;
export const DAY_PORTION_LABELS: Record<DayPortion, string> = {
  FULL: 'Full day',
  AM: 'Morning (AM)',
  PM: 'Afternoon (PM)',
};

export const LEAVE_UNITS = ['DAYS', 'HOURS'] as const;
export const LeaveUnitSchema = z.enum(LEAVE_UNITS);
export type LeaveUnit = z.infer<typeof LeaveUnitSchema>;

export const ACCRUAL_METHODS = ['MONTHLY_PRO_RATA', 'UPFRONT', 'NONE'] as const;
export const AccrualMethodSchema = z.enum(ACCRUAL_METHODS);
export type AccrualMethod = z.infer<typeof AccrualMethodSchema>;

export const LEDGER_ENTRY_TYPES = [
  'OPENING',
  'ACCRUAL',
  'TAKEN',
  'CANCELLATION_REVERSAL',
  'ADJUSTMENT',
  'CARRY_FORWARD_IN',
  'CARRY_FORWARD_OUT',
  'FORFEIT',
  'CREDIT_ALLOCATION',
  'PAYOUT',
] as const;
export const LedgerEntryTypeSchema = z.enum(LEDGER_ENTRY_TYPES);
export type LedgerEntryType = z.infer<typeof LedgerEntryTypeSchema>;

export const PROCESS_STATUSES = [
  'DRAFT',
  'IN_PROGRESS',
  'RESUBMIT_REQUIRED',
  'APPROVED_PENDING_PROCESS',
  'PROCESSED',
  'DECLINED',
  'CANCELLED',
  'CONFLICT',
] as const;
export const ProcessStatusSchema = z.enum(PROCESS_STATUSES);
export type ProcessStatus = z.infer<typeof ProcessStatusSchema>;

/** Status labels as shown by the source system (section 1.4). */
export const PROCESS_STATUS_LABELS: Record<ProcessStatus, string> = {
  DRAFT: 'Saved',
  IN_PROGRESS: 'In Progress',
  RESUBMIT_REQUIRED: 'Resubmission Required',
  APPROVED_PENDING_PROCESS: 'Approved, Pending Process',
  PROCESSED: 'Completed',
  DECLINED: 'Declined',
  CANCELLED: 'Cancelled',
  CONFLICT: 'Conflict',
};

/** Claim list filter buckets as shown by the source system (section 5.3.2). */
export const CLAIM_STATUS_FILTERS = [
  'All',
  'Saved',
  'In Progress',
  'Pending Processing',
  'Processed',
  'Cancelled / Declined',
] as const;
export type ClaimStatusFilter = (typeof CLAIM_STATUS_FILTERS)[number];
export const CLAIM_STATUS_FILTER_MAP: Record<Exclude<ClaimStatusFilter, 'All'>, ProcessStatus[]> = {
  Saved: ['DRAFT'],
  'In Progress': ['IN_PROGRESS', 'RESUBMIT_REQUIRED'],
  'Pending Processing': ['APPROVED_PENDING_PROCESS'],
  Processed: ['PROCESSED'],
  'Cancelled / Declined': ['CANCELLED', 'DECLINED'],
};

export const STEP_STATUSES = [
  'PENDING',
  'PARKED',
  'APPROVED',
  'DECLINED',
  'SKIPPED',
  'REASSIGNED',
  'SENT_BACK',
  'CANCELLED',
] as const;
export const StepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const APPROVER_RESOLUTIONS = ['REPORTS_TO', 'REPORTS_TO_LEVEL_2', 'SPECIFIC_USER', 'ROLE'] as const;
export const ApproverResolutionSchema = z.enum(APPROVER_RESOLUTIONS);
export type ApproverResolution = z.infer<typeof ApproverResolutionSchema>;

export const WORKFLOW_ACTION_TYPES = [
  'CREATE',
  'SUBMIT',
  'APPROVE',
  'DECLINE',
  'REASSIGN',
  'DELEGATE',
  'PARK',
  'UNPARK',
  'SEND_BACK',
  'RESUBMIT',
  'WITHDRAW',
  'CANCEL',
  'ESCALATE',
  'COMMENT',
  'AUTO_SKIP',
  'PROCESS',
  'APPLY',
  'CONFLICT',
] as const;
export const WorkflowActionTypeSchema = z.enum(WORKFLOW_ACTION_TYPES);
export type WorkflowActionType = z.infer<typeof WorkflowActionTypeSchema>;

export const CREDIT_LEAVE_KINDS = ['REQUEST', 'ALLOCATION'] as const;
export const CreditLeaveKindSchema = z.enum(CREDIT_LEAVE_KINDS);
export type CreditLeaveKind = z.infer<typeof CreditLeaveKindSchema>;

export const CLAIM_INPUT_MODES = ['AMOUNT', 'QUANTITY', 'HOURS', 'KILOMETRES'] as const;
export const ClaimInputModeSchema = z.enum(CLAIM_INPUT_MODES);
export type ClaimInputMode = z.infer<typeof ClaimInputModeSchema>;

export const CAP_MODES = ['NO_CAP', 'WARN', 'BLOCK'] as const;
export const CapModeSchema = z.enum(CAP_MODES);
export type CapMode = z.infer<typeof CapModeSchema>;
export const CAP_MODE_LABELS: Record<CapMode, string> = { NO_CAP: 'No Cap', WARN: 'Warn', BLOCK: 'Block' };

export const CAP_CYCLES = ['PAY_PERIOD', 'MONTHLY', 'ANNUAL'] as const;
export const CapCycleSchema = z.enum(CAP_CYCLES);
export type CapCycle = z.infer<typeof CapCycleSchema>;

export const PAYSLIP_LINE_CATEGORIES = [
  'EARNING',
  'DEDUCTION',
  'COMPANY_CONTRIBUTION',
  'FRINGE_BENEFIT',
  'INFO',
] as const;
export const PayslipLineCategorySchema = z.enum(PAYSLIP_LINE_CATEGORIES);
export type PayslipLineCategory = z.infer<typeof PayslipLineCategorySchema>;

export const CHANGE_OPERATIONS = ['CREATE', 'UPDATE', 'DELETE'] as const;
export const ChangeOperationSchema = z.enum(CHANGE_OPERATIONS);
export type ChangeOperation = z.infer<typeof ChangeOperationSchema>;

export const OUT_OF_OFFICE_MODES = ['OFF', 'WHILE_ON_LEAVE', 'DATE_RANGE'] as const;
export const OutOfOfficeModeSchema = z.enum(OUT_OF_OFFICE_MODES);
export type OutOfOfficeMode = z.infer<typeof OutOfOfficeModeSchema>;

export const TEMPLATE_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export const TemplateStatusSchema = z.enum(TEMPLATE_STATUSES);
export type TemplateStatus = z.infer<typeof TemplateStatusSchema>;

export const TEMPLATE_ITEM_KINDS = ['KPA', 'KPI', 'COMPETENCY', 'OBJECTIVE'] as const;
export const TemplateItemKindSchema = z.enum(TEMPLATE_ITEM_KINDS);
export type TemplateItemKind = z.infer<typeof TemplateItemKindSchema>;

export const INITIATION_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'] as const;
export const InitiationStatusSchema = z.enum(INITIATION_STATUSES);
export type InitiationStatus = z.infer<typeof InitiationStatusSchema>;

export const CONTRACT_STATUSES = ['DRAFT', 'AGREED', 'ACTIVE', 'CLOSED', 'ARCHIVED'] as const;
export const ContractStatusSchema = z.enum(CONTRACT_STATUSES);
export type ContractStatus = z.infer<typeof ContractStatusSchema>;

export const REVIEW_NOTIFY_MODES = ['IMMEDIATELY', 'NEVER', 'SPECIFIC_DATE'] as const;
export const ReviewNotifyModeSchema = z.enum(REVIEW_NOTIFY_MODES);
export type ReviewNotifyMode = z.infer<typeof ReviewNotifyModeSchema>;

export const REVIEW_STATUSES = [
  'DRAFT',
  'OPEN',
  'SELF_ASSESSMENT',
  'REVIEWER_ASSESSMENT',
  'MODERATION',
  'COMPLETED',
  'CANCELLED',
] as const;
export const ReviewStatusSchema = z.enum(REVIEW_STATUSES);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const PARTICIPANT_ROLES = ['REVIEWEE', 'REVIEWER'] as const;
export const ParticipantRoleSchema = z.enum(PARTICIPANT_ROLES);
export type ParticipantRole = z.infer<typeof ParticipantRoleSchema>;

export const AUDIT_CATEGORIES = [
  'AUTH',
  'SECURITY',
  'DATA_CHANGE',
  'WORKFLOW',
  'DATA_VIEW',
  'EXPORT',
  'SYSTEM',
] as const;
export const AuditCategorySchema = z.enum(AUDIT_CATEGORIES);
export type AuditCategory = z.infer<typeof AuditCategorySchema>;

export const AUDIT_OUTCOMES = ['SUCCESS', 'DENIED', 'FAILURE'] as const;
export const AuditOutcomeSchema = z.enum(AUDIT_OUTCOMES);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

/** Workflow type codes observed in the source system (section 1.3). */
export const WORKFLOW_TYPES = {
  LEAVE: 'Leave Workflow Process',
  BASICINF: 'Basic Information Workflow Process',
  BANKDET: 'Bank Detail Workflow Process',
  FREETEXT: 'Free Text Workflow Process',
  FREETEXTMANEMP: 'Free Text with Mandatory Employee',
  CLAIMS: 'Claims Workflow Process',
  CANCELLEAVE: 'Cancel Leave Process',
  BENEFICIARY: 'Retirement Fund Beneficiary',
  TRAINING: 'Training',
  QUALIFICATION: 'Qualification',
  JOBREQUISITION: 'Job Requisition',
  GROUPEDCLAIM: 'Grouped Claim',
  CHECKLISTITEM: 'Checklist Item',
  DRIVERSLICENSE: 'Drivers License',
  CREDITLVEALLOC: 'Leave in Lieu Allocation',
  CREDITLVEREQ: 'Leave in Lieu Request',
} as const;
export type WorkflowTypeCode = keyof typeof WORKFLOW_TYPES;
export const WORKFLOW_TYPE_CODES = Object.keys(WORKFLOW_TYPES) as WorkflowTypeCode[];
export const WorkflowTypeCodeSchema = z.enum(
  WORKFLOW_TYPE_CODES as [WorkflowTypeCode, ...WorkflowTypeCode[]],
);

/** Types that need a payroll "process" step after final approval (section 7.2). */
export const PAYROLL_PROCESSED_WORKFLOW_TYPES: readonly WorkflowTypeCode[] = [
  'LEAVE',
  'CANCELLEAVE',
  'CLAIMS',
  'GROUPEDCLAIM',
  'CREDITLVEALLOC',
  'CREDITLVEREQ',
];

export function requiresPayrollProcessing(type: WorkflowTypeCode): boolean {
  return PAYROLL_PROCESSED_WORKFLOW_TYPES.includes(type);
}
