-- Built-in SYSTEM user: the actor of jobs and automatic workflow actions (e.g. approver
-- re-resolution, section 7.5). It cannot sign in: no password, inactive.
INSERT INTO "User" (id, username, "authProvider", roles, "isActive", "mustChangePassword", "failedLoginCount", version, "createdAt", "updatedAt")
VALUES ('00000000-0000-0000-0000-000000000000', 'SYSTEM', 'LOCAL', ARRAY['SYSTEM_ADMIN']::"Role"[], false, false, 0, 1, now(), now())
ON CONFLICT (id) DO NOTHING;
