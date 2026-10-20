-- Phase 8: the reviewee and the rating scale of a review (one review per reviewee).

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "employeeId" INTEGER,
ADD COLUMN     "ratingScaleId" INTEGER;

-- CreateIndex
CREATE INDEX "Review_employeeId_idx" ON "Review"("employeeId");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_ratingScaleId_fkey" FOREIGN KEY ("ratingScaleId") REFERENCES "RatingScale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

