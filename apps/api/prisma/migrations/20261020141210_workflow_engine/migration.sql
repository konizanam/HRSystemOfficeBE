-- AlterEnum
ALTER TYPE "StepStatus" ADD VALUE 'SUPERSEDED';

-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" TEXT;

-- AlterTable
ALTER TABLE "WorkflowStepInstance" ADD COLUMN     "escalatedAt" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "WorkflowStepInstance_status_dueAt_idx" ON "WorkflowStepInstance"("status", "dueAt");
