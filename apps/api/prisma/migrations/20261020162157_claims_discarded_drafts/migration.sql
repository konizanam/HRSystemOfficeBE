-- A discarded draft is CANCELLED without ever having been submitted, so it has no reference
-- number either; every other non-draft claim has one.
ALTER TABLE "Claim" DROP CONSTRAINT claim_reference_chk;
ALTER TABLE "Claim" ADD CONSTRAINT claim_reference_chk
  CHECK ("referenceNumber" IS NOT NULL OR "status" = 'DRAFT' OR ("status" = 'CANCELLED' AND "submittedAt" IS NULL));
