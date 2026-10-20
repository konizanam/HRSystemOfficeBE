-- DropIndex
DROP INDEX "Payslip_employeeId_payPeriodId_payRun_key";

-- DropIndex
DROP INDEX "TaxCertificate_employeeId_taxYear_certificateType_key";

-- AlterTable
ALTER TABLE "Payslip" ADD COLUMN     "importedByUserId" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "TaxCertificate" ADD COLUMN     "figures" JSONB,
ADD COLUMN     "importedByUserId" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'UPLOADED',
ADD COLUMN     "supersededAt" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "Payslip_employeeId_payPeriodId_payRun_idx" ON "Payslip"("employeeId", "payPeriodId", "payRun");

-- CreateIndex
CREATE INDEX "Payslip_payPeriodId_idx" ON "Payslip"("payPeriodId");

-- CreateIndex
CREATE INDEX "TaxCertificate_employeeId_taxYear_certificateType_idx" ON "TaxCertificate"("employeeId", "taxYear", "certificateType");

-- ───────────── Phase 7 raw SQL (see docs/ASSUMPTIONS.md) ─────────────

-- A re-import with replace=true supersedes the current payslip or certificate (no hard deletes),
-- so only the current one is unique.
CREATE UNIQUE INDEX ux_payslip_current ON "Payslip"("employeeId", "payPeriodId", "payRun")
  WHERE "supersededAt" IS NULL;
CREATE UNIQUE INDEX ux_tax_certificate_current ON "TaxCertificate"("employeeId", "taxYear", "certificateType")
  WHERE "supersededAt" IS NULL;

ALTER TABLE "TaxCertificate" ADD CONSTRAINT tax_certificate_source_chk CHECK ("source" IN ('UPLOADED', 'GENERATED'));
ALTER TABLE "Payslip" ADD CONSTRAINT payslip_net_pay_chk CHECK ("netPay" = "grossPay" - "totalDeductions");
