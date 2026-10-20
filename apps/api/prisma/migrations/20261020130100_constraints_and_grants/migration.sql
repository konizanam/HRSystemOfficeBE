-- Section 11 schema notes.

-- Accrual idempotency: the composite unique key includes a nullable column, and Postgres treats
-- NULLs as distinct, so job-posted entries (no application) need their own partial index.
CREATE UNIQUE INDEX ux_ledger_accrual ON "LeaveLedgerEntry"("entitlementId", "entryType", "effectiveDate")
  WHERE "leaveApplicationId" IS NULL;

ALTER TABLE "LeaveApplication" ADD CONSTRAINT leave_application_dates_chk CHECK ("toDate" >= "fromDate");
ALTER TABLE "CreditLeaveRequest" ADD CONSTRAINT credit_leave_dates_chk CHECK ("workedTo" >= "workedFrom");
ALTER TABLE "Beneficiary" ADD CONSTRAINT beneficiary_percentage_chk CHECK ("percentage" > 0 AND "percentage" <= 100);

-- The leave ledger and workflow actions are append-only as well.
CREATE OR REPLACE FUNCTION append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON "LeaveLedgerEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();
CREATE TRIGGER workflow_action_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON "WorkflowAction"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();

-- Runtime role. Default privileges cover tables created by later migrations.
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO app_user;

-- Re-apply the append-only revocations after the blanket grant above.
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditAnchor" FROM app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "LeaveLedgerEntry" FROM app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "WorkflowAction" FROM app_user;
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM app_user;
