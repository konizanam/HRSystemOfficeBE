-- Section 9.3: the audit log is append-only. Enforced by a trigger (for every role, including
-- the owner unless it explicitly disables triggers) and by grants (app_user cannot even try).

CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'AuditLog is append-only'; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE OR TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();

CREATE TRIGGER audit_anchor_no_update BEFORE UPDATE OR DELETE OR TRUNCATE ON "AuditAnchor"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();

GRANT SELECT, INSERT ON "AuditLog" TO app_user;
GRANT SELECT, INSERT ON "AuditAnchor" TO app_user;
GRANT USAGE, SELECT ON SEQUENCE "AuditLog_id_seq" TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditAnchor" FROM app_user;
