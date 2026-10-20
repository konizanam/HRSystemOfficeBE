/**
 * Business entities covered by the DATA_CHANGE safety net (section 9.4.2). Children written through
 * their parent (application days, allocations), append-only tables (ledger, workflow actions) and
 * platform plumbing (sessions, outbox, sequences, notifications) are audited by explicit domain
 * actions instead.
 */
export const AUDITED_MODELS = new Set<string>([
  'Company',
  'CompanyRule',
  'PublicHoliday',
  'Employee',
  'User',
  'Address',
  'ContactDetail',
  'Bank',
  'BankBranch',
  'BankAccount',
  'DriversLicence',
  'FamilyMember',
  'RetirementFund',
  'FundMembership',
  'Beneficiary',
  'ChangeRequest',
  'WorkflowType',
  'WorkflowDefinition',
  'WorkflowStep',
  'WorkflowProcess',
  'OutOfOffice',
  'OutOfOfficeRule',
  'LeaveType',
  'LeaveReason',
  'LeavePolicy',
  'EmployeeLeaveEntitlement',
  'LeaveApplication',
  'CreditLeaveRequest',
  'ClaimGroup',
  'ClaimType',
  'ClaimCap',
  'Claim',
  'ClaimBalanceAdjustment',
  'PayPeriod',
  'Payslip',
  'TaxCertificate',
  'EmployeeTransaction',
  'FreeTextType',
  'FreeTextRequest',
  'ParameterValue',
  'RatingScale',
  'PerformanceTemplate',
  'PerformanceTemplateItem',
  'ContractInitiation',
  'PerformanceContract',
  'PerformanceContractItem',
  'Review',
  'ReviewParticipant',
  'ReviewObjective',
  'ReviewScore',
  'Attachment',
  'SystemSetting',
  'DashboardLayout',
]);

export const WRITE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

export const BULK_OPERATIONS = new Set(['updateMany', 'deleteMany', 'updateManyAndReturn']);

/** `BankAccount` -> `BANK_ACCOUNT`. */
export function modelConstant(model: string): string {
  return model.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** `BankAccount` -> `bankAccount` (the Prisma client delegate name). */
export function delegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}
