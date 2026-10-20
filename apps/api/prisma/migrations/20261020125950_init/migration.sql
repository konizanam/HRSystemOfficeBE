-- CreateEnum
CREATE TYPE "Role" AS ENUM ('EMPLOYEE', 'MANAGER', 'HR_ADMIN', 'PAYROLL_ADMIN', 'SYSTEM_ADMIN', 'AUDITOR');

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('LOCAL', 'OAUTH');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "AddressType" AS ENUM ('PHYSICAL', 'POSTAL', 'WORK');

-- CreateEnum
CREATE TYPE "PostalServiceType" AS ENUM ('PO_BOX', 'PRIVATE_BAG', 'POSTNET_SUITE', 'STREET', 'OTHER');

-- CreateEnum
CREATE TYPE "ContactType" AS ENUM ('CELL', 'EMAIL', 'FAX', 'HOME', 'WORK');

-- CreateEnum
CREATE TYPE "BankAccountType" AS ENUM ('CURRENT', 'LOAN', 'TRANSMISSION', 'SAVINGS');

-- CreateEnum
CREATE TYPE "AccountHolderRelationship" AS ENUM ('OWN', 'JOINT', 'THIRD_PARTY');

-- CreateEnum
CREATE TYPE "DayPortion" AS ENUM ('FULL', 'AM', 'PM');

-- CreateEnum
CREATE TYPE "LeaveUnit" AS ENUM ('DAYS', 'HOURS');

-- CreateEnum
CREATE TYPE "AccrualMethod" AS ENUM ('MONTHLY_PRO_RATA', 'UPFRONT', 'NONE');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('OPENING', 'ACCRUAL', 'TAKEN', 'CANCELLATION_REVERSAL', 'ADJUSTMENT', 'CARRY_FORWARD_IN', 'CARRY_FORWARD_OUT', 'FORFEIT', 'CREDIT_ALLOCATION', 'PAYOUT');

-- CreateEnum
CREATE TYPE "ProcessStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'RESUBMIT_REQUIRED', 'APPROVED_PENDING_PROCESS', 'PROCESSED', 'DECLINED', 'CANCELLED', 'CONFLICT');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('PENDING', 'PARKED', 'APPROVED', 'DECLINED', 'SKIPPED', 'REASSIGNED', 'SENT_BACK', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApproverResolution" AS ENUM ('REPORTS_TO', 'REPORTS_TO_LEVEL_2', 'SPECIFIC_USER', 'ROLE');

-- CreateEnum
CREATE TYPE "WorkflowActionType" AS ENUM ('CREATE', 'SUBMIT', 'APPROVE', 'DECLINE', 'REASSIGN', 'DELEGATE', 'PARK', 'UNPARK', 'SEND_BACK', 'RESUBMIT', 'WITHDRAW', 'CANCEL', 'ESCALATE', 'COMMENT', 'AUTO_SKIP', 'PROCESS', 'APPLY', 'CONFLICT');

-- CreateEnum
CREATE TYPE "CreditLeaveKind" AS ENUM ('REQUEST', 'ALLOCATION');

-- CreateEnum
CREATE TYPE "ClaimInputMode" AS ENUM ('AMOUNT', 'QUANTITY', 'HOURS', 'KILOMETRES');

-- CreateEnum
CREATE TYPE "CapMode" AS ENUM ('NO_CAP', 'WARN', 'BLOCK');

-- CreateEnum
CREATE TYPE "CapCycle" AS ENUM ('PAY_PERIOD', 'MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "PayslipLineCategory" AS ENUM ('EARNING', 'DEDUCTION', 'COMPANY_CONTRIBUTION', 'FRINGE_BENEFIT', 'INFO');

-- CreateEnum
CREATE TYPE "ChangeOperation" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- CreateEnum
CREATE TYPE "OutOfOfficeMode" AS ENUM ('OFF', 'WHILE_ON_LEAVE', 'DATE_RANGE');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TemplateItemKind" AS ENUM ('KPA', 'KPI', 'COMPETENCY', 'OBJECTIVE');

-- CreateEnum
CREATE TYPE "InitiationStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'AGREED', 'ACTIVE', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ReviewNotifyMode" AS ENUM ('IMMEDIATELY', 'NEVER', 'SPECIFIC_DATE');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('DRAFT', 'OPEN', 'SELF_ASSESSMENT', 'REVIEWER_ASSESSMENT', 'MODERATION', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('REVIEWEE', 'REVIEWER');

-- CreateEnum
CREATE TYPE "AuditCategory" AS ENUM ('AUTH', 'SECURITY', 'DATA_CHANGE', 'WORKFLOW', 'DATA_VIEW', 'EXPORT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'DENIED', 'FAILURE');

-- CreateTable
CREATE TABLE "Company" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NAD',
    "country" TEXT NOT NULL DEFAULT 'NA',
    "logoAttachmentId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyRule" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "CompanyRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicHoliday" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "PublicHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" SERIAL NOT NULL,
    "entityCode" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "companyId" INTEGER NOT NULL,
    "companyRuleId" INTEGER NOT NULL,
    "title" TEXT,
    "initials" TEXT,
    "firstName" TEXT NOT NULL,
    "secondName" TEXT,
    "otherNames" TEXT,
    "lastName" TEXT NOT NULL,
    "knownAs" TEXT,
    "maidenName" TEXT,
    "identityType" TEXT,
    "identityNumberEnc" TEXT,
    "identityNumberLast4" TEXT,
    "dateOfBirth" DATE,
    "countryOfBirth" TEXT,
    "cityOfBirth" TEXT,
    "birthCertificateNumberEnc" TEXT,
    "passportNumberEnc" TEXT,
    "passportCountry" TEXT,
    "taxNumberEnc" TEXT,
    "taxNumberLast4" TEXT,
    "nationality" TEXT,
    "homeLanguage" TEXT,
    "gender" TEXT,
    "maritalStatus" TEXT,
    "bloodGroup" TEXT,
    "religion" TEXT,
    "correspondenceAddressType" "AddressType",
    "jobTitle" TEXT,
    "jobGrade" TEXT,
    "department" TEXT,
    "hourlyRate" DECIMAL(14,4),
    "workPattern" JSONB,
    "dateEngaged" DATE,
    "terminationDate" DATE,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "birthdayVisible" BOOLEAN NOT NULL DEFAULT true,
    "photoAttachmentId" TEXT,
    "reportsToId" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT,
    "authProvider" "AuthProvider" NOT NULL DEFAULT 'LOCAL',
    "externalSubject" TEXT,
    "roles" "Role"[],
    "employeeId" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(6),
    "lastLoginAt" TIMESTAMPTZ(6),
    "passwordChangedAt" TIMESTAMPTZ(6),
    "mfaSecretEnc" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "actingAsEmployeeId" INTEGER,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordHistory" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Address" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER,
    "familyMemberId" INTEGER,
    "type" "AddressType" NOT NULL,
    "sameAs" "AddressType",
    "unitNumber" TEXT,
    "block" TEXT,
    "complex" TEXT,
    "levelFloor" TEXT,
    "streetNumber" TEXT,
    "streetName" TEXT,
    "suburb" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "province" TEXT,
    "district" TEXT,
    "careOfName" TEXT,
    "serviceType" "PostalServiceType",
    "postalAddressNumber" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactDetail" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER,
    "familyMemberId" INTEGER,
    "type" "ContactType" NOT NULL,
    "value" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ContactDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bank" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "universalBranchCode" TEXT,
    "country" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Bank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankBranch" (
    "id" SERIAL NOT NULL,
    "bankId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "BankBranch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "accountType" "BankAccountType" NOT NULL,
    "holderName" TEXT NOT NULL,
    "holderRelationship" "AccountHolderRelationship" NOT NULL,
    "bankId" INTEGER NOT NULL,
    "branchId" INTEGER,
    "accountNumberEnc" TEXT NOT NULL,
    "accountNumberLast4" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NAD',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriversLicence" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "licenceNumberEnc" TEXT NOT NULL,
    "licenceLast4" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "issueDate" DATE,
    "expiryDate" DATE NOT NULL,
    "countryOfIssue" TEXT,
    "restrictions" TEXT,
    "hasPdp" BOOLEAN NOT NULL DEFAULT false,
    "pdpExpiryDate" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DriversLicence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FamilyMember" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "relationship" TEXT NOT NULL,
    "title" TEXT,
    "initials" TEXT,
    "firstName" TEXT NOT NULL,
    "secondName" TEXT,
    "otherNames" TEXT,
    "lastName" TEXT NOT NULL,
    "knownAs" TEXT,
    "identityNumberEnc" TEXT,
    "identityNumberLast4" TEXT,
    "gender" TEXT,
    "dateOfBirth" DATE,
    "nationality" TEXT,
    "isEmergencyContact" BOOLEAN NOT NULL DEFAULT false,
    "emergencyDetail" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "FamilyMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetirementFund" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RetirementFund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundMembership" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "fundId" INTEGER NOT NULL,
    "memberNumber" TEXT,
    "startDate" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "FundMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Beneficiary" (
    "id" SERIAL NOT NULL,
    "membershipId" INTEGER NOT NULL,
    "familyMemberId" INTEGER,
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "identityNumberEnc" TEXT,
    "percentage" DECIMAL(5,2) NOT NULL,

    CONSTRAINT "Beneficiary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeRequest" (
    "id" SERIAL NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "operation" "ChangeOperation" NOT NULL,
    "proposed" JSONB NOT NULL,
    "before" JSONB,
    "baseVersion" INTEGER,
    "status" "ProcessStatus" NOT NULL DEFAULT 'DRAFT',
    "processId" INTEGER,
    "appliedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowType" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "WorkflowType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowDefinition" (
    "id" SERIAL NOT NULL,
    "workflowTypeId" INTEGER NOT NULL,
    "companyRuleId" INTEGER,
    "discriminator" TEXT,
    "name" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "allowReassign" BOOLEAN NOT NULL DEFAULT true,
    "allowResubmit" BOOLEAN NOT NULL DEFAULT true,
    "canPark" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowStep" (
    "id" SERIAL NOT NULL,
    "definitionId" INTEGER NOT NULL,
    "stepNo" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "resolution" "ApproverResolution" NOT NULL,
    "approverUserId" TEXT,
    "approverRole" "Role",
    "isMandatory" BOOLEAN NOT NULL DEFAULT true,
    "skipIfSameApprover" BOOLEAN NOT NULL DEFAULT true,
    "escalationHours" INTEGER,

    CONSTRAINT "WorkflowStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowProcess" (
    "id" SERIAL NOT NULL,
    "workflowTypeId" INTEGER NOT NULL,
    "definitionId" INTEGER NOT NULL,
    "subjectEmployeeId" INTEGER NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "submittedOnBehalf" BOOLEAN NOT NULL DEFAULT false,
    "subjectEntity" TEXT NOT NULL,
    "subjectEntityId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" "ProcessStatus" NOT NULL DEFAULT 'DRAFT',
    "currentStepNo" INTEGER,
    "round" INTEGER NOT NULL DEFAULT 1,
    "isEscalated" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMPTZ(6),
    "finalApprovedAt" TIMESTAMPTZ(6),
    "processedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkflowProcess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowStepInstance" (
    "id" SERIAL NOT NULL,
    "processId" INTEGER NOT NULL,
    "stepId" INTEGER NOT NULL,
    "stepNo" INTEGER NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "assigneeUserId" TEXT NOT NULL,
    "delegatedFromUserId" TEXT,
    "status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "isMandatory" BOOLEAN NOT NULL,
    "dueAt" TIMESTAMPTZ(6),
    "parkedUntil" TIMESTAMPTZ(6),
    "actedAt" TIMESTAMPTZ(6),
    "actedByUserId" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowStepInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowAction" (
    "id" SERIAL NOT NULL,
    "processId" INTEGER NOT NULL,
    "stepInstanceId" INTEGER,
    "action" "WorkflowActionType" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "onBehalfOfEmployeeId" INTEGER,
    "comment" TEXT,
    "fromStatus" "ProcessStatus",
    "toStatus" "ProcessStatus",
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutOfOffice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" "OutOfOfficeMode" NOT NULL DEFAULT 'OFF',
    "fromDate" DATE,
    "toDate" DATE,
    "mainNomineeUserId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OutOfOffice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutOfOfficeRule" (
    "id" SERIAL NOT NULL,
    "outOfOfficeId" TEXT NOT NULL,
    "workflowTypeId" INTEGER NOT NULL,
    "nomineeUserId" TEXT NOT NULL,

    CONSTRAINT "OutOfOfficeRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveType" (
    "id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "colour" TEXT,
    "unit" "LeaveUnit" NOT NULL DEFAULT 'DAYS',
    "isPaid" BOOLEAN NOT NULL DEFAULT true,
    "mandatoryReason" BOOLEAN NOT NULL DEFAULT false,
    "requiresAttachmentAfterDays" DECIMAL(12,4),
    "allowHalfDay" BOOLEAN NOT NULL DEFAULT true,
    "allowNegative" BOOLEAN NOT NULL DEFAULT false,
    "excludeWeekends" BOOLEAN NOT NULL DEFAULT true,
    "excludePublicHolidays" BOOLEAN NOT NULL DEFAULT true,
    "hideUnitsAvailableForESS" BOOLEAN NOT NULL DEFAULT false,
    "hideZeroUnitsAvailableForESS" BOOLEAN NOT NULL DEFAULT false,
    "isCreditLeave" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveReason" (
    "id" SERIAL NOT NULL,
    "leaveTypeId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LeaveReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeavePolicy" (
    "id" SERIAL NOT NULL,
    "leaveTypeId" INTEGER NOT NULL,
    "companyRuleId" INTEGER,
    "definitionName" TEXT NOT NULL,
    "entitlementPerCycle" DECIMAL(12,4) NOT NULL,
    "accrualMethod" "AccrualMethod" NOT NULL,
    "cycleMonths" INTEGER NOT NULL DEFAULT 12,
    "maxCarryForward" DECIMAL(12,4),
    "carryForwardExpiryMonths" INTEGER,
    "maxNegative" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "creditExpiryDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LeavePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeLeaveEntitlement" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "leaveTypeId" INTEGER NOT NULL,
    "policyId" INTEGER,
    "definitionName" TEXT NOT NULL,
    "entitlement" DECIMAL(12,4) NOT NULL,
    "cycleStartDate" DATE NOT NULL,
    "cycleEndDate" DATE NOT NULL,
    "expiresOn" DATE,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "EmployeeLeaveEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveLedgerEntry" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "leaveTypeId" INTEGER NOT NULL,
    "entitlementId" INTEGER NOT NULL,
    "entryType" "LedgerEntryType" NOT NULL,
    "units" DECIMAL(12,4) NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "payPeriodId" INTEGER,
    "leaveApplicationId" INTEGER,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveApplication" (
    "id" SERIAL NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "leaveTypeId" INTEGER NOT NULL,
    "leaveReasonId" INTEGER,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "startPortion" "DayPortion" NOT NULL DEFAULT 'FULL',
    "endPortion" "DayPortion" NOT NULL DEFAULT 'FULL',
    "unitsTaken" DECIMAL(12,4) NOT NULL,
    "unitsOverridden" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "noteSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "noteReceived" BOOLEAN NOT NULL DEFAULT false,
    "takeOnTransaction" BOOLEAN NOT NULL DEFAULT false,
    "comment" TEXT,
    "status" "ProcessStatus" NOT NULL DEFAULT 'DRAFT',
    "processId" INTEGER,
    "cancelsApplicationId" INTEGER,
    "payPeriodId" INTEGER,
    "submittedAt" TIMESTAMPTZ(6),
    "approvedAt" TIMESTAMPTZ(6),
    "finalApproverUserId" TEXT,
    "processedAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LeaveApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveApplicationDay" (
    "id" SERIAL NOT NULL,
    "applicationId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "portion" "DayPortion" NOT NULL,
    "units" DECIMAL(12,4) NOT NULL,

    CONSTRAINT "LeaveApplicationDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveApplicationAllocation" (
    "id" SERIAL NOT NULL,
    "applicationId" INTEGER NOT NULL,
    "entitlementId" INTEGER NOT NULL,
    "units" DECIMAL(12,4) NOT NULL,

    CONSTRAINT "LeaveApplicationAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLeaveRequest" (
    "id" SERIAL NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "kind" "CreditLeaveKind" NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "leaveTypeId" INTEGER NOT NULL,
    "workedFrom" DATE NOT NULL,
    "workedTo" DATE NOT NULL,
    "units" DECIMAL(12,4) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ProcessStatus" NOT NULL DEFAULT 'DRAFT',
    "processId" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimGroup" (
    "id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "attachmentMandatory" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ClaimGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimType" (
    "id" INTEGER NOT NULL,
    "groupId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "inputMode" "ClaimInputMode" NOT NULL,
    "rate" DECIMAL(14,4),
    "rateMultiplier" DECIMAL(6,4),
    "payrollCode" TEXT,
    "requiresAttachment" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ClaimType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimCap" (
    "id" SERIAL NOT NULL,
    "claimTypeId" INTEGER NOT NULL,
    "companyRuleId" INTEGER,
    "cycle" "CapCycle" NOT NULL,
    "mode" "CapMode" NOT NULL DEFAULT 'NO_CAP',
    "amountLimit" DECIMAL(14,2),
    "quantityLimit" DECIMAL(12,4),
    "proRata" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ClaimCap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" SERIAL NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "groupId" INTEGER NOT NULL,
    "description" TEXT,
    "totalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "warnings" JSONB,
    "status" "ProcessStatus" NOT NULL DEFAULT 'DRAFT',
    "processId" INTEGER,
    "payPeriodId" INTEGER,
    "submittedAt" TIMESTAMPTZ(6),
    "processedAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimLine" (
    "id" SERIAL NOT NULL,
    "claimId" INTEGER NOT NULL,
    "claimTypeId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "startTime" TEXT,
    "endTime" TEXT,
    "quantity" DECIMAL(12,4),
    "rate" DECIMAL(14,4),
    "amount" DECIMAL(14,2) NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ClaimLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimBalanceAdjustment" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "claimTypeId" INTEGER NOT NULL,
    "cycleStartDate" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "quantity" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimBalanceAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayPeriod" (
    "id" SERIAL NOT NULL,
    "companyRuleId" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "payDate" DATE,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PayPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payslip" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "payPeriodId" INTEGER NOT NULL,
    "payRun" TEXT NOT NULL,
    "runType" TEXT NOT NULL DEFAULT 'Normal',
    "ruleLabel" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'NAD',
    "grossPay" DECIMAL(14,2) NOT NULL,
    "totalDeductions" DECIMAL(14,2) NOT NULL,
    "netPay" DECIMAL(14,2) NOT NULL,
    "pdfAttachmentId" TEXT,
    "pdfSha256" TEXT,
    "publishedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payslip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayslipLine" (
    "id" SERIAL NOT NULL,
    "payslipId" INTEGER NOT NULL,
    "category" "PayslipLineCategory" NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,4),
    "rate" DECIMAL(14,4),
    "amount" DECIMAL(14,2) NOT NULL,
    "ytdAmount" DECIMAL(14,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PayslipLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxCertificate" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "certificateType" TEXT NOT NULL,
    "pdfAttachmentId" TEXT NOT NULL,
    "pdfSha256" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeTransaction" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,2),
    "quantity" DECIMAL(12,4),
    "payPeriodId" INTEGER,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "status" "ProcessStatus" NOT NULL DEFAULT 'PROCESSED',
    "processId" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreeTextType" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "requiresSubjectEmployee" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "FreeTextType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreeTextRequest" (
    "id" SERIAL NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "typeId" INTEGER NOT NULL,
    "applicantId" INTEGER NOT NULL,
    "aboutEmployeeId" INTEGER,
    "body" TEXT NOT NULL,
    "status" "ProcessStatus" NOT NULL DEFAULT 'DRAFT',
    "processId" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FreeTextRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParameterValue" (
    "id" SERIAL NOT NULL,
    "tableName" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "parentId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'A',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ParameterValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RatingScale" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "points" JSONB NOT NULL,

    CONSTRAINT "RatingScale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceTemplate" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "contractStartDate" DATE NOT NULL,
    "contractEndDate" DATE NOT NULL,
    "ratingScaleId" INTEGER,
    "processDefinition" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "createdFromTemplateId" INTEGER,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceTemplateItem" (
    "id" SERIAL NOT NULL,
    "templateId" INTEGER NOT NULL,
    "kind" "TemplateItemKind" NOT NULL,
    "parameterValueId" INTEGER,
    "title" TEXT NOT NULL,
    "weight" DECIMAL(6,2) NOT NULL,
    "target" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PerformanceTemplateItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractInitiation" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "templateId" INTEGER NOT NULL,
    "contractStartDate" DATE NOT NULL,
    "contractEndDate" DATE NOT NULL,
    "filters" JSONB NOT NULL,
    "status" "InitiationStatus" NOT NULL DEFAULT 'QUEUED',
    "contractCount" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ContractInitiation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceContract" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "templateId" INTEGER NOT NULL,
    "initiationId" INTEGER,
    "name" TEXT NOT NULL,
    "contractType" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "currentlyAssignedUserId" TEXT,
    "archivedAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PerformanceContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceContractItem" (
    "id" SERIAL NOT NULL,
    "contractId" INTEGER NOT NULL,
    "kind" "TemplateItemKind" NOT NULL,
    "title" TEXT NOT NULL,
    "weight" DECIMAL(6,2) NOT NULL,
    "target" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PerformanceContractItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" SERIAL NOT NULL,
    "contractId" INTEGER,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "cycleStartDate" DATE NOT NULL,
    "cycleEndDate" DATE NOT NULL,
    "notifyMode" "ReviewNotifyMode" NOT NULL DEFAULT 'IMMEDIATELY',
    "notifyDate" DATE,
    "isFreeFormat" BOOLEAN NOT NULL DEFAULT false,
    "status" "ReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "totalActual" DECIMAL(8,4),
    "createdByUserId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewParticipant" (
    "id" SERIAL NOT NULL,
    "reviewId" INTEGER NOT NULL,
    "role" "ParticipantRole" NOT NULL,
    "employeeId" INTEGER,
    "userId" TEXT,
    "weight" DECIMAL(6,2),

    CONSTRAINT "ReviewParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewObjective" (
    "id" SERIAL NOT NULL,
    "reviewId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "weight" DECIMAL(6,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ReviewObjective_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewScore" (
    "id" SERIAL NOT NULL,
    "reviewId" INTEGER NOT NULL,
    "contractItemId" INTEGER,
    "objectiveId" INTEGER,
    "reviewerUserId" TEXT NOT NULL,
    "rating" DECIMAL(6,2),
    "comment" TEXT,
    "submittedAt" TIMESTAMPTZ(6),

    CONSTRAINT "ReviewScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "ownerEntity" TEXT NOT NULL,
    "ownerEntityId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "readAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DashboardLayout" (
    "userId" TEXT NOT NULL,
    "widgets" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DashboardLayout_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "ReferenceSequence" (
    "key" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL,

    CONSTRAINT "ReferenceSequence_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestId" TEXT,
    "sessionId" TEXT,
    "actorUserId" TEXT,
    "actorUsername" TEXT,
    "actingAsEmployeeId" INTEGER,
    "subjectEmployeeId" INTEGER,
    "category" "AuditCategory" NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "outcome" "AuditOutcome" NOT NULL DEFAULT 'SUCCESS',
    "before" JSONB,
    "after" JSONB,
    "changes" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditAnchor" (
    "day" DATE NOT NULL,
    "lastAuditId" BIGINT NOT NULL,
    "lastHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditAnchor_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_code_key" ON "Company"("code");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyRule_companyId_code_key" ON "CompanyRule"("companyId", "code");

-- CreateIndex
CREATE INDEX "PublicHoliday_date_idx" ON "PublicHoliday"("date");

-- CreateIndex
CREATE UNIQUE INDEX "PublicHoliday_companyId_date_key" ON "PublicHoliday"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_entityCode_key" ON "Employee"("entityCode");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_employeeCode_key" ON "Employee"("employeeCode");

-- CreateIndex
CREATE INDEX "Employee_companyId_companyRuleId_idx" ON "Employee"("companyId", "companyRuleId");

-- CreateIndex
CREATE INDEX "Employee_reportsToId_idx" ON "Employee"("reportsToId");

-- CreateIndex
CREATE INDEX "Employee_lastName_firstName_idx" ON "Employee"("lastName", "firstName");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_externalSubject_key" ON "User"("externalSubject");

-- CreateIndex
CREATE UNIQUE INDEX "User_employeeId_key" ON "User"("employeeId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "PasswordHistory_userId_idx" ON "PasswordHistory"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Address_employeeId_type_key" ON "Address"("employeeId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Address_familyMemberId_type_key" ON "Address"("familyMemberId", "type");

-- CreateIndex
CREATE INDEX "ContactDetail_employeeId_idx" ON "ContactDetail"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Bank_name_key" ON "Bank"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BankBranch_bankId_name_key" ON "BankBranch"("bankId", "name");

-- CreateIndex
CREATE INDEX "BankAccount_employeeId_isActive_idx" ON "BankAccount"("employeeId", "isActive");

-- CreateIndex
CREATE INDEX "DriversLicence_expiryDate_idx" ON "DriversLicence"("expiryDate");

-- CreateIndex
CREATE UNIQUE INDEX "RetirementFund_code_key" ON "RetirementFund"("code");

-- CreateIndex
CREATE UNIQUE INDEX "FundMembership_employeeId_fundId_key" ON "FundMembership"("employeeId", "fundId");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeRequest_referenceNumber_key" ON "ChangeRequest"("referenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeRequest_processId_key" ON "ChangeRequest"("processId");

-- CreateIndex
CREATE INDEX "ChangeRequest_employeeId_entityType_status_idx" ON "ChangeRequest"("employeeId", "entityType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowType_code_key" ON "WorkflowType"("code");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowStep_definitionId_stepNo_key" ON "WorkflowStep"("definitionId", "stepNo");

-- CreateIndex
CREATE INDEX "WorkflowProcess_status_workflowTypeId_idx" ON "WorkflowProcess"("status", "workflowTypeId");

-- CreateIndex
CREATE INDEX "WorkflowProcess_subjectEmployeeId_status_idx" ON "WorkflowProcess"("subjectEmployeeId", "status");

-- CreateIndex
CREATE INDEX "WorkflowStepInstance_assigneeUserId_status_idx" ON "WorkflowStepInstance"("assigneeUserId", "status");

-- CreateIndex
CREATE INDEX "WorkflowStepInstance_processId_round_stepNo_idx" ON "WorkflowStepInstance"("processId", "round", "stepNo");

-- CreateIndex
CREATE INDEX "WorkflowAction_processId_createdAt_idx" ON "WorkflowAction"("processId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutOfOffice_userId_key" ON "OutOfOffice"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OutOfOfficeRule_outOfOfficeId_workflowTypeId_key" ON "OutOfOfficeRule"("outOfOfficeId", "workflowTypeId");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_idx" ON "OutboxEvent"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveType_code_key" ON "LeaveType"("code");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveReason_leaveTypeId_code_key" ON "LeaveReason"("leaveTypeId", "code");

-- CreateIndex
CREATE INDEX "EmployeeLeaveEntitlement_employeeId_leaveTypeId_cycleEndDat_idx" ON "EmployeeLeaveEntitlement"("employeeId", "leaveTypeId", "cycleEndDate");

-- CreateIndex
CREATE INDEX "LeaveLedgerEntry_employeeId_leaveTypeId_effectiveDate_idx" ON "LeaveLedgerEntry"("employeeId", "leaveTypeId", "effectiveDate");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveLedgerEntry_entitlementId_entryType_effectiveDate_leav_key" ON "LeaveLedgerEntry"("entitlementId", "entryType", "effectiveDate", "leaveApplicationId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveApplication_referenceNumber_key" ON "LeaveApplication"("referenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveApplication_processId_key" ON "LeaveApplication"("processId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveApplication_cancelsApplicationId_key" ON "LeaveApplication"("cancelsApplicationId");

-- CreateIndex
CREATE INDEX "LeaveApplication_employeeId_fromDate_toDate_idx" ON "LeaveApplication"("employeeId", "fromDate", "toDate");

-- CreateIndex
CREATE INDEX "LeaveApplication_status_idx" ON "LeaveApplication"("status");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveApplicationDay_applicationId_date_key" ON "LeaveApplicationDay"("applicationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLeaveRequest_referenceNumber_key" ON "CreditLeaveRequest"("referenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLeaveRequest_processId_key" ON "CreditLeaveRequest"("processId");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimGroup_code_key" ON "ClaimGroup"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimType_groupId_code_key" ON "ClaimType"("groupId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_referenceNumber_key" ON "Claim"("referenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_processId_key" ON "Claim"("processId");

-- CreateIndex
CREATE INDEX "Claim_employeeId_status_idx" ON "Claim"("employeeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PayPeriod_companyRuleId_startDate_key" ON "PayPeriod"("companyRuleId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "Payslip_employeeId_payPeriodId_payRun_key" ON "Payslip"("employeeId", "payPeriodId", "payRun");

-- CreateIndex
CREATE UNIQUE INDEX "TaxCertificate_employeeId_taxYear_certificateType_key" ON "TaxCertificate"("employeeId", "taxYear", "certificateType");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeTransaction_processId_key" ON "EmployeeTransaction"("processId");

-- CreateIndex
CREATE UNIQUE INDEX "FreeTextType_code_key" ON "FreeTextType"("code");

-- CreateIndex
CREATE UNIQUE INDEX "FreeTextRequest_referenceNumber_key" ON "FreeTextRequest"("referenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "FreeTextRequest_processId_key" ON "FreeTextRequest"("processId");

-- CreateIndex
CREATE UNIQUE INDEX "ParameterValue_tableName_code_key" ON "ParameterValue"("tableName", "code");

-- CreateIndex
CREATE UNIQUE INDEX "RatingScale_name_key" ON "RatingScale"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");

-- CreateIndex
CREATE INDEX "Attachment_ownerEntity_ownerEntityId_idx" ON "Attachment"("ownerEntity", "ownerEntityId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_hash_key" ON "AuditLog"("hash");

-- CreateIndex
CREATE INDEX "AuditLog_occurredAt_idx" ON "AuditLog"("occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_occurredAt_idx" ON "AuditLog"("actorUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_subjectEmployeeId_occurredAt_idx" ON "AuditLog"("subjectEmployeeId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_category_action_idx" ON "AuditLog"("category", "action");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");

-- AddForeignKey
ALTER TABLE "CompanyRule" ADD CONSTRAINT "CompanyRule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicHoliday" ADD CONSTRAINT "PublicHoliday_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_companyRuleId_fkey" FOREIGN KEY ("companyRuleId") REFERENCES "CompanyRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_reportsToId_fkey" FOREIGN KEY ("reportsToId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordHistory" ADD CONSTRAINT "PasswordHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_familyMemberId_fkey" FOREIGN KEY ("familyMemberId") REFERENCES "FamilyMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactDetail" ADD CONSTRAINT "ContactDetail_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactDetail" ADD CONSTRAINT "ContactDetail_familyMemberId_fkey" FOREIGN KEY ("familyMemberId") REFERENCES "FamilyMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankBranch" ADD CONSTRAINT "BankBranch_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "BankBranch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriversLicence" ADD CONSTRAINT "DriversLicence_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyMember" ADD CONSTRAINT "FamilyMember_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundMembership" ADD CONSTRAINT "FundMembership_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundMembership" ADD CONSTRAINT "FundMembership_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "RetirementFund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Beneficiary" ADD CONSTRAINT "Beneficiary_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "FundMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Beneficiary" ADD CONSTRAINT "Beneficiary_familyMemberId_fkey" FOREIGN KEY ("familyMemberId") REFERENCES "FamilyMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_processId_fkey" FOREIGN KEY ("processId") REFERENCES "WorkflowProcess"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_workflowTypeId_fkey" FOREIGN KEY ("workflowTypeId") REFERENCES "WorkflowType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDefinition" ADD CONSTRAINT "WorkflowDefinition_companyRuleId_fkey" FOREIGN KEY ("companyRuleId") REFERENCES "CompanyRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "WorkflowDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_approverUserId_fkey" FOREIGN KEY ("approverUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowProcess" ADD CONSTRAINT "WorkflowProcess_workflowTypeId_fkey" FOREIGN KEY ("workflowTypeId") REFERENCES "WorkflowType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowProcess" ADD CONSTRAINT "WorkflowProcess_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "WorkflowDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowProcess" ADD CONSTRAINT "WorkflowProcess_subjectEmployeeId_fkey" FOREIGN KEY ("subjectEmployeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowProcess" ADD CONSTRAINT "WorkflowProcess_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStepInstance" ADD CONSTRAINT "WorkflowStepInstance_processId_fkey" FOREIGN KEY ("processId") REFERENCES "WorkflowProcess"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStepInstance" ADD CONSTRAINT "WorkflowStepInstance_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "WorkflowStep"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStepInstance" ADD CONSTRAINT "WorkflowStepInstance_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStepInstance" ADD CONSTRAINT "WorkflowStepInstance_actedByUserId_fkey" FOREIGN KEY ("actedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAction" ADD CONSTRAINT "WorkflowAction_processId_fkey" FOREIGN KEY ("processId") REFERENCES "WorkflowProcess"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAction" ADD CONSTRAINT "WorkflowAction_stepInstanceId_fkey" FOREIGN KEY ("stepInstanceId") REFERENCES "WorkflowStepInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAction" ADD CONSTRAINT "WorkflowAction_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutOfOffice" ADD CONSTRAINT "OutOfOffice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutOfOffice" ADD CONSTRAINT "OutOfOffice_mainNomineeUserId_fkey" FOREIGN KEY ("mainNomineeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutOfOfficeRule" ADD CONSTRAINT "OutOfOfficeRule_outOfOfficeId_fkey" FOREIGN KEY ("outOfOfficeId") REFERENCES "OutOfOffice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutOfOfficeRule" ADD CONSTRAINT "OutOfOfficeRule_workflowTypeId_fkey" FOREIGN KEY ("workflowTypeId") REFERENCES "WorkflowType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutOfOfficeRule" ADD CONSTRAINT "OutOfOfficeRule_nomineeUserId_fkey" FOREIGN KEY ("nomineeUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveReason" ADD CONSTRAINT "LeaveReason_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_companyRuleId_fkey" FOREIGN KEY ("companyRuleId") REFERENCES "CompanyRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeLeaveEntitlement" ADD CONSTRAINT "EmployeeLeaveEntitlement_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeLeaveEntitlement" ADD CONSTRAINT "EmployeeLeaveEntitlement_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeLeaveEntitlement" ADD CONSTRAINT "EmployeeLeaveEntitlement_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "LeavePolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "EmployeeLeaveEntitlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_payPeriodId_fkey" FOREIGN KEY ("payPeriodId") REFERENCES "PayPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_leaveApplicationId_fkey" FOREIGN KEY ("leaveApplicationId") REFERENCES "LeaveApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveApplication" ADD CONSTRAINT "LeaveApplication_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveApplication" ADD CONSTRAINT "LeaveApplication_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveApplication" ADD CONSTRAINT "LeaveApplication_leaveReasonId_fkey" FOREIGN KEY ("leaveReasonId") REFERENCES "LeaveReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveApplication" ADD CONSTRAINT "LeaveApplication_processId_fkey" FOREIGN KEY ("processId") REFERENCES "WorkflowProcess"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveApplication" ADD CONSTRAINT "LeaveApplication_payPeriodId_fkey" FOREIGN KEY ("payPeriodId") REFERENCES "PayPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveApplication" ADD CONSTRAINT "LeaveApplication_cancelsApplicationId_fkey" FOREIGN KEY ("cancelsApplicationId") REFERENCES "LeaveApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveApplicationDay" ADD CONSTRAINT "LeaveApplicationDay_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "LeaveApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveApplicationAllocation" ADD CONSTRAINT "LeaveApplicationAllocation_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "LeaveApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveApplicationAllocation" ADD CONSTRAINT "LeaveApplicationAllocation_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "EmployeeLeaveEntitlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLeaveRequest" ADD CONSTRAINT "CreditLeaveRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLeaveRequest" ADD CONSTRAINT "CreditLeaveRequest_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLeaveRequest" ADD CONSTRAINT "CreditLeaveRequest_processId_fkey" FOREIGN KEY ("processId") REFERENCES "WorkflowProcess"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimType" ADD CONSTRAINT "ClaimType_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ClaimGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimCap" ADD CONSTRAINT "ClaimCap_claimTypeId_fkey" FOREIGN KEY ("claimTypeId") REFERENCES "ClaimType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimCap" ADD CONSTRAINT "ClaimCap_companyRuleId_fkey" FOREIGN KEY ("companyRuleId") REFERENCES "CompanyRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ClaimGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_processId_fkey" FOREIGN KEY ("processId") REFERENCES "WorkflowProcess"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_payPeriodId_fkey" FOREIGN KEY ("payPeriodId") REFERENCES "PayPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimLine" ADD CONSTRAINT "ClaimLine_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimLine" ADD CONSTRAINT "ClaimLine_claimTypeId_fkey" FOREIGN KEY ("claimTypeId") REFERENCES "ClaimType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimBalanceAdjustment" ADD CONSTRAINT "ClaimBalanceAdjustment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimBalanceAdjustment" ADD CONSTRAINT "ClaimBalanceAdjustment_claimTypeId_fkey" FOREIGN KEY ("claimTypeId") REFERENCES "ClaimType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayPeriod" ADD CONSTRAINT "PayPeriod_companyRuleId_fkey" FOREIGN KEY ("companyRuleId") REFERENCES "CompanyRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_payPeriodId_fkey" FOREIGN KEY ("payPeriodId") REFERENCES "PayPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayslipLine" ADD CONSTRAINT "PayslipLine_payslipId_fkey" FOREIGN KEY ("payslipId") REFERENCES "Payslip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxCertificate" ADD CONSTRAINT "TaxCertificate_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransaction" ADD CONSTRAINT "EmployeeTransaction_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransaction" ADD CONSTRAINT "EmployeeTransaction_payPeriodId_fkey" FOREIGN KEY ("payPeriodId") REFERENCES "PayPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransaction" ADD CONSTRAINT "EmployeeTransaction_processId_fkey" FOREIGN KEY ("processId") REFERENCES "WorkflowProcess"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreeTextRequest" ADD CONSTRAINT "FreeTextRequest_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "FreeTextType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreeTextRequest" ADD CONSTRAINT "FreeTextRequest_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreeTextRequest" ADD CONSTRAINT "FreeTextRequest_aboutEmployeeId_fkey" FOREIGN KEY ("aboutEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreeTextRequest" ADD CONSTRAINT "FreeTextRequest_processId_fkey" FOREIGN KEY ("processId") REFERENCES "WorkflowProcess"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParameterValue" ADD CONSTRAINT "ParameterValue_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ParameterValue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceTemplate" ADD CONSTRAINT "PerformanceTemplate_ratingScaleId_fkey" FOREIGN KEY ("ratingScaleId") REFERENCES "RatingScale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceTemplate" ADD CONSTRAINT "PerformanceTemplate_createdFromTemplateId_fkey" FOREIGN KEY ("createdFromTemplateId") REFERENCES "PerformanceTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceTemplateItem" ADD CONSTRAINT "PerformanceTemplateItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PerformanceTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractInitiation" ADD CONSTRAINT "ContractInitiation_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PerformanceTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceContract" ADD CONSTRAINT "PerformanceContract_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceContract" ADD CONSTRAINT "PerformanceContract_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PerformanceTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceContract" ADD CONSTRAINT "PerformanceContract_initiationId_fkey" FOREIGN KEY ("initiationId") REFERENCES "ContractInitiation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceContractItem" ADD CONSTRAINT "PerformanceContractItem_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "PerformanceContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "PerformanceContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewParticipant" ADD CONSTRAINT "ReviewParticipant_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewParticipant" ADD CONSTRAINT "ReviewParticipant_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewObjective" ADD CONSTRAINT "ReviewObjective_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewScore" ADD CONSTRAINT "ReviewScore_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewScore" ADD CONSTRAINT "ReviewScore_contractItemId_fkey" FOREIGN KEY ("contractItemId") REFERENCES "PerformanceContractItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewScore" ADD CONSTRAINT "ReviewScore_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "ReviewObjective"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardLayout" ADD CONSTRAINT "DashboardLayout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
