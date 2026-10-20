-- CreateEnum
CREATE TYPE "HolidayRuleKind" AS ENUM ('FIXED', 'EASTER_RELATIVE');

-- CreateEnum
CREATE TYPE "EntitlementKind" AS ENUM ('CYCLE', 'CARRY_FORWARD', 'CREDIT');

-- DropIndex
DROP INDEX "LeaveApplication_cancelsApplicationId_key";

-- AlterTable
ALTER TABLE "CreditLeaveRequest" ADD COLUMN     "approvedAt" TIMESTAMPTZ(6),
ADD COLUMN     "entitlementId" INTEGER,
ADD COLUMN     "payPeriodId" INTEGER,
ADD COLUMN     "processedAt" TIMESTAMPTZ(6),
ADD COLUMN     "submittedAt" TIMESTAMPTZ(6),
ADD COLUMN     "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "EmployeeLeaveEntitlement" ADD COLUMN     "closedAt" TIMESTAMPTZ(6),
ADD COLUMN     "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "kind" "EntitlementKind" NOT NULL DEFAULT 'CYCLE',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "LeaveApplication" ADD COLUMN     "availableAtSubmit" DECIMAL(12,4);

-- AlterTable
ALTER TABLE "LeaveApplicationAllocation" ADD COLUMN     "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "releasedAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "LeavePolicy" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "LeaveReason" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "LeaveType" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "PublicHoliday" ADD COLUMN     "ruleId" INTEGER;

-- CreateTable
CREATE TABLE "HolidayRule" (
    "id" SERIAL NOT NULL,
    "companyId" INTEGER,
    "name" TEXT NOT NULL,
    "kind" "HolidayRuleKind" NOT NULL,
    "month" INTEGER,
    "day" INTEGER,
    "easterOffsetDays" INTEGER,
    "observeSundayOnMonday" BOOLEAN NOT NULL DEFAULT true,
    "validFromYear" INTEGER,
    "validToYear" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "HolidayRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HolidayRule_companyId_idx" ON "HolidayRule"("companyId");

-- CreateIndex
CREATE INDEX "CreditLeaveRequest_employeeId_status_idx" ON "CreditLeaveRequest"("employeeId", "status");

-- CreateIndex
CREATE INDEX "LeaveApplication_cancelsApplicationId_idx" ON "LeaveApplication"("cancelsApplicationId");

-- CreateIndex
CREATE INDEX "LeaveApplicationAllocation_entitlementId_idx" ON "LeaveApplicationAllocation"("entitlementId");

-- CreateIndex
CREATE INDEX "LeaveApplicationAllocation_applicationId_idx" ON "LeaveApplicationAllocation"("applicationId");

-- CreateIndex
CREATE INDEX "PublicHoliday_ruleId_idx" ON "PublicHoliday"("ruleId");

-- AddForeignKey
ALTER TABLE "PublicHoliday" ADD CONSTRAINT "PublicHoliday_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "HolidayRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HolidayRule" ADD CONSTRAINT "HolidayRule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLeaveRequest" ADD CONSTRAINT "CreditLeaveRequest_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "EmployeeLeaveEntitlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLeaveRequest" ADD CONSTRAINT "CreditLeaveRequest_payPeriodId_fkey" FOREIGN KEY ("payPeriodId") REFERENCES "PayPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ───────────── Phase 4 raw SQL (see docs/ASSUMPTIONS.md) ─────────────

-- Ledger idempotency. The Phase 1 partial index covered every entry without an application, which
-- would also forbid two HR adjustments (or a release forfeit) on the same bucket and day. It now
-- covers the entry types that jobs and imports post once per bucket and date.
DROP INDEX IF EXISTS ux_ledger_accrual;
CREATE UNIQUE INDEX ux_ledger_accrual ON "LeaveLedgerEntry"("entitlementId", "entryType", "effectiveDate")
  WHERE "leaveApplicationId" IS NULL
    AND "entryType" IN ('OPENING', 'ACCRUAL', 'CARRY_FORWARD_IN', 'CARRY_FORWARD_OUT', 'CREDIT_ALLOCATION');

-- One cycle (and one carry-forward) bucket per employee, leave type and start date, so the
-- rollover job and lazy bucket creation can never open the same cycle twice.
CREATE UNIQUE INDEX ux_entitlement_cycle ON "EmployeeLeaveEntitlement"("employeeId", "leaveTypeId", "kind", "cycleStartDate")
  WHERE "kind" IN ('CYCLE', 'CARRY_FORWARD');
ALTER TABLE "EmployeeLeaveEntitlement" ADD CONSTRAINT entitlement_dates_chk CHECK ("cycleEndDate" >= "cycleStartDate");

-- At most one open CANCELLEAVE per application (section 5.2.3). A declined or withdrawn
-- cancellation no longer blocks a new one, so the column is no longer unique on its own.
CREATE UNIQUE INDEX ux_leave_open_cancellation ON "LeaveApplication"("cancelsApplicationId")
  WHERE "cancelsApplicationId" IS NOT NULL
    AND "status" IN ('DRAFT', 'IN_PROGRESS', 'RESUBMIT_REQUIRED', 'APPROVED_PENDING_PROCESS');

-- Holidays for every company (companyId null): one per date. NULLs are distinct in the composite key.
CREATE UNIQUE INDEX ux_public_holiday_global ON "PublicHoliday"("date") WHERE "companyId" IS NULL;
-- A rule generates at most one holiday per year.
CREATE UNIQUE INDEX ux_public_holiday_rule_year ON "PublicHoliday"("ruleId", (EXTRACT(YEAR FROM "date")))
  WHERE "ruleId" IS NOT NULL;

-- Holiday rules: a FIXED rule has a month and day, an EASTER_RELATIVE rule an offset.
ALTER TABLE "HolidayRule" ADD CONSTRAINT holiday_rule_shape_chk CHECK (
  ("kind" = 'FIXED' AND "month" BETWEEN 1 AND 12 AND "day" BETWEEN 1 AND 31 AND "easterOffsetDays" IS NULL)
  OR ("kind" = 'EASTER_RELATIVE' AND "easterOffsetDays" IS NOT NULL AND "month" IS NULL AND "day" IS NULL)
);
CREATE UNIQUE INDEX ux_holiday_rule_global_name ON "HolidayRule"("name") WHERE "companyId" IS NULL;
CREATE UNIQUE INDEX ux_holiday_rule_company_name ON "HolidayRule"("companyId", "name") WHERE "companyId" IS NOT NULL;
