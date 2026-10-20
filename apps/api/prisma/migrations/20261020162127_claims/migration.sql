-- AlterTable
ALTER TABLE "Claim" ADD COLUMN     "approvedAt" TIMESTAMPTZ(6),
ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "finalApproverUserId" TEXT,
ALTER COLUMN "referenceNumber" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ClaimCap" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ClaimGroup" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ClaimLine" ADD COLUMN     "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "deletedAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "ClaimType" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "Claim_createdByUserId_status_idx" ON "Claim"("createdByUserId", "status");

-- CreateIndex
CREATE INDEX "ClaimBalanceAdjustment_employeeId_claimTypeId_cycleStartDat_idx" ON "ClaimBalanceAdjustment"("employeeId", "claimTypeId", "cycleStartDate");

-- CreateIndex
CREATE INDEX "ClaimCap_claimTypeId_isActive_idx" ON "ClaimCap"("claimTypeId", "isActive");

-- CreateIndex
CREATE INDEX "ClaimLine_claimId_idx" ON "ClaimLine"("claimId");

-- CreateIndex
CREATE INDEX "ClaimLine_claimTypeId_date_idx" ON "ClaimLine"("claimTypeId", "date");

-- Phase 5: the server computes every claim amount; the database refuses impossible values too.
ALTER TABLE "ClaimLine" ADD CONSTRAINT claim_line_amount_chk CHECK ("amount" >= 0);
ALTER TABLE "ClaimLine" ADD CONSTRAINT claim_line_quantity_chk CHECK ("quantity" IS NULL OR "quantity" >= 0);
ALTER TABLE "Claim" ADD CONSTRAINT claim_total_chk CHECK ("totalAmount" >= 0);
-- A submitted claim always has its reference number (drafts have none until submit).
ALTER TABLE "Claim" ADD CONSTRAINT claim_reference_chk CHECK ("status" = 'DRAFT' OR "referenceNumber" IS NOT NULL);
