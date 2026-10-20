-- Phase 8 (performance): soft deletes for template/contract items, review objectives and
-- reviewers, the contract item parameter link, Review.notifiedAt, one contract per
-- (initiation, employee), lookup indexes, and the checks below.

-- AlterTable
ALTER TABLE "PerformanceContractItem" ADD COLUMN     "deletedAt" TIMESTAMPTZ(6),
ADD COLUMN     "parameterValueId" INTEGER;

-- AlterTable
ALTER TABLE "PerformanceTemplateItem" ADD COLUMN     "deletedAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "notifiedAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "ReviewObjective" ADD COLUMN     "deletedAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "ReviewParticipant" ADD COLUMN     "deletedAt" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "ParameterValue_tableName_parentId_idx" ON "ParameterValue"("tableName", "parentId");

-- CreateIndex
CREATE INDEX "PerformanceContract_employeeId_idx" ON "PerformanceContract"("employeeId");

-- CreateIndex
CREATE INDEX "PerformanceContract_templateId_idx" ON "PerformanceContract"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceContract_initiationId_employeeId_key" ON "PerformanceContract"("initiationId", "employeeId");

-- CreateIndex
CREATE INDEX "PerformanceContractItem_contractId_idx" ON "PerformanceContractItem"("contractId");

-- CreateIndex
CREATE INDEX "PerformanceTemplateItem_templateId_idx" ON "PerformanceTemplateItem"("templateId");

-- CreateIndex
CREATE INDEX "Review_status_idx" ON "Review"("status");

-- CreateIndex
CREATE INDEX "Review_contractId_idx" ON "Review"("contractId");

-- CreateIndex
CREATE INDEX "ReviewObjective_reviewId_idx" ON "ReviewObjective"("reviewId");

-- CreateIndex
CREATE INDEX "ReviewParticipant_reviewId_idx" ON "ReviewParticipant"("reviewId");

-- CreateIndex
CREATE INDEX "ReviewParticipant_employeeId_idx" ON "ReviewParticipant"("employeeId");

-- CreateIndex
CREATE INDEX "ReviewParticipant_userId_idx" ON "ReviewParticipant"("userId");

-- CreateIndex
CREATE INDEX "ReviewScore_reviewId_reviewerUserId_idx" ON "ReviewScore"("reviewId", "reviewerUserId");

-- AddForeignKey
ALTER TABLE "PerformanceTemplateItem" ADD CONSTRAINT "PerformanceTemplateItem_parameterValueId_fkey" FOREIGN KEY ("parameterValueId") REFERENCES "ParameterValue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceContractItem" ADD CONSTRAINT "PerformanceContractItem_parameterValueId_fkey" FOREIGN KEY ("parameterValueId") REFERENCES "ParameterValue"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Weights are percentages.
ALTER TABLE "PerformanceTemplateItem" ADD CONSTRAINT "PerformanceTemplateItem_weight_check" CHECK ("weight" >= 0 AND "weight" <= 100);
ALTER TABLE "PerformanceContractItem" ADD CONSTRAINT "PerformanceContractItem_weight_check" CHECK ("weight" >= 0 AND "weight" <= 100);
ALTER TABLE "ReviewObjective" ADD CONSTRAINT "ReviewObjective_weight_check" CHECK ("weight" >= 0 AND "weight" <= 100);
ALTER TABLE "ReviewParticipant" ADD CONSTRAINT "ReviewParticipant_weight_check" CHECK ("weight" IS NULL OR ("weight" >= 0 AND "weight" <= 100));

-- A score rates exactly one contract item or one review objective.
ALTER TABLE "ReviewScore" ADD CONSTRAINT "ReviewScore_target_check" CHECK (("contractItemId" IS NULL) <> ("objectiveId" IS NULL));

-- One score per reviewer and item (a resubmission updates it).
CREATE UNIQUE INDEX "ux_review_score_item" ON "ReviewScore"("reviewId", "reviewerUserId", "contractItemId") WHERE "contractItemId" IS NOT NULL;
CREATE UNIQUE INDEX "ux_review_score_objective" ON "ReviewScore"("reviewId", "reviewerUserId", "objectiveId") WHERE "objectiveId" IS NOT NULL;

-- Initiation counters never go negative.
ALTER TABLE "ContractInitiation" ADD CONSTRAINT "ContractInitiation_counts_check" CHECK ("contractCount" >= 0 AND "createdCount" >= 0 AND "failedCount" >= 0);
