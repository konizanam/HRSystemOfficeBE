-- Phase 6: My Details (section 5.4) through change requests (section 7.6). See docs/ASSUMPTIONS.md.

-- AlterTable
ALTER TABLE "Bank" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "BankBranch" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Beneficiary" ADD COLUMN     "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "deletedAt" TIMESTAMPTZ(6),
ADD COLUMN     "identityNumberLast4" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "ContactDetail" ADD COLUMN     "deletedAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "birthCertificateNumberLast4" TEXT,
ADD COLUMN     "passportNumberLast4" TEXT;

-- AlterTable
ALTER TABLE "EmployeeTransaction" ADD COLUMN     "comment" TEXT,
ADD COLUMN     "endDate" DATE,
ADD COLUMN     "referenceNumber" TEXT,
ADD COLUMN     "startDate" DATE,
ADD COLUMN     "transactionCodeId" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ParameterValue" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "RetirementFund" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "PayrollTransactionCode" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "allowEmployeeInput" BOOLEAN NOT NULL DEFAULT false,
    "inputMode" TEXT NOT NULL DEFAULT 'AMOUNT',
    "requiresAttachment" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollTransactionCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LicenceExpiryNotice" (
    "id" SERIAL NOT NULL,
    "licenceId" INTEGER NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "expiryDate" DATE NOT NULL,
    "notifiedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LicenceExpiryNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollTransactionCode_code_key" ON "PayrollTransactionCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "LicenceExpiryNotice_licenceId_expiryDate_key" ON "LicenceExpiryNotice"("licenceId", "expiryDate");

-- CreateIndex
CREATE INDEX "Beneficiary_membershipId_idx" ON "Beneficiary"("membershipId");

-- CreateIndex
CREATE INDEX "ContactDetail_familyMemberId_idx" ON "ContactDetail"("familyMemberId");

-- CreateIndex
CREATE INDEX "DriversLicence_employeeId_idx" ON "DriversLicence"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeTransaction_referenceNumber_key" ON "EmployeeTransaction"("referenceNumber");

-- CreateIndex
CREATE INDEX "EmployeeTransaction_employeeId_isRecurring_idx" ON "EmployeeTransaction"("employeeId", "isRecurring");

-- AddForeignKey
ALTER TABLE "EmployeeTransaction" ADD CONSTRAINT "EmployeeTransaction_transactionCodeId_fkey" FOREIGN KEY ("transactionCodeId") REFERENCES "PayrollTransactionCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LicenceExpiryNotice" ADD CONSTRAINT "LicenceExpiryNotice_licenceId_fkey" FOREIGN KEY ("licenceId") REFERENCES "DriversLicence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Section 7.6: at most one open change request per (employee, entity type, entity). The service
-- checks first and answers 409 "A change is already awaiting approval"; this index is the
-- backstop for concurrent submits. A create has no entity id yet, so null counts as one key.
CREATE UNIQUE INDEX ux_change_request_open ON "ChangeRequest"("employeeId", "entityType", (COALESCE("entityId", '')))
  WHERE status IN ('DRAFT', 'IN_PROGRESS', 'RESUBMIT_REQUIRED', 'APPROVED_PENDING_PROCESS');

-- Section 5.4.6: an employee input is either an amount or a quantity.
ALTER TABLE "PayrollTransactionCode" ADD CONSTRAINT payroll_transaction_code_input_mode_chk
  CHECK ("inputMode" IN ('AMOUNT', 'QUANTITY'));
