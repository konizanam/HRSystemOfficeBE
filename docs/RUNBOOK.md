# Runbook

Operating PeopleHub ESS: database roles, configuration, OIDC, backups and the restore drill, key rotation, audit verification and anchors, and re-running jobs. Commands run from the repository root unless a directory is given. Section numbers refer to [`BUILD_SPEC.md`](../BUILD_SPEC.md).

## 1. Database roles

The API never connects as the schema owner (section 9.3).

| Role        | Used by                                                                     | Rights                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_owner` | migrations (`node scripts/as-owner.mjs …`, `MIGRATION_DATABASE_URL`), owner | everything on the schema                                                                                                                    |
| `app_user`  | the API, the seed, the CLIs (`DATABASE_URL`)                                | CRUD on business tables; SELECT and INSERT only on `AuditLog`, `AuditAnchor`, `LeaveLedgerEntry` and `WorkflowAction`; no TRUNCATE anywhere |

Creating a new environment (as a PostgreSQL superuser, once per cluster; the script is idempotent):

```sh
psql -U postgres -v owner_pw='<owner password>' -v user_pw='<user password>' -v db=peoplehub -f scripts/db-roles.sql
```

It creates `app_owner` (LOGIN CREATEDB) and `app_user` (LOGIN), the database owned by `app_owner`, and grants `app_user` CONNECT. Use a separate database (for example `peoplehub_test`) for the integration tests.

Then apply the migrations as the owner and seed as the application role:

```sh
pnpm db:deploy        # prisma migrate deploy as app_owner (MIGRATION_DATABASE_URL)
pnpm db:seed          # idempotent demo data as app_user (run it twice: the second run changes nothing)
pnpm audit:verify     # the chain must be OK
```

The migration `20261020130100_constraints_and_grants` grants `app_user` its rights (with default privileges, so later tables are covered) and then revokes `UPDATE`, `DELETE` and `TRUNCATE` on the append-only tables. Triggers block the same statements even for the owner (`audit_immutable`, `append_only`). Check the grants after any manual change:

```sql
SELECT grantee, privilege_type FROM information_schema.role_table_grants
WHERE table_name IN ('AuditLog', 'AuditAnchor', 'LeaveLedgerEntry', 'WorkflowAction') AND grantee = 'app_user';
-- expected: SELECT and INSERT only
```

Rules: migrations are applied with `migrate deploy` in every shared environment; `prisma migrate reset` is never run against a database that holds real data, and `_prisma_migrations` is never edited by hand.

## 2. Environment variables

The API reads the repository-root `.env` (and `apps/api/.env`, which wins); variables already set in the process environment win over both. The schema is `apps/api/src/config/env.ts`; an invalid value stops the API at start-up with the variable named.

| Variable                                                                                                         | Purpose                                                                                                     | Default                           |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `NODE_ENV`                                                                                                       | `development`, `test` or `production`                                                                       | `development`                     |
| `PORT`                                                                                                           | HTTP port of the API                                                                                        | `3000`                            |
| `DATABASE_URL`                                                                                                   | connection string of **app_user**                                                                           | required                          |
| `MIGRATION_DATABASE_URL`                                                                                         | connection string of **app_owner** (migrations only; not read by the API)                                   | required for migrations           |
| `TEST_DATABASE_URL`, `TEST_MIGRATION_DATABASE_URL`                                                               | the integration-test database (`peoplehub_test`); without them the tests start a Testcontainers Postgres 16 | unset                             |
| `WEB_ORIGIN`                                                                                                     | the only CORS origin                                                                                        | `http://localhost:5173`           |
| `PUBLIC_URL`                                                                                                     | base URL of the web app, used in email links and OIDC redirects                                             | `http://localhost:5173`           |
| `LOG_LEVEL`                                                                                                      | pino level                                                                                                  | `info`                            |
| `ENCRYPTION_KEYS`                                                                                                | JSON `{ "k1": "<base64 32 bytes>", … }` (section 10.3)                                                      | required                          |
| `ENCRYPTION_ACTIVE_KEY`                                                                                          | the key id new values are encrypted with                                                                    | required                          |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`                                                | outgoing mail                                                                                               | `localhost:1025`, insecure        |
| `MAIL_FROM`                                                                                                      | sender (the `mail.from` setting overrides it)                                                               | `PeopleHub <noreply@example.com>` |
| `MAIL_TRANSPORT`                                                                                                 | `smtp`, or `memory` (tests, seed)                                                                           | `smtp`                            |
| `STORAGE_DRIVER`                                                                                                 | `local` or `s3`                                                                                             | `local`                           |
| `STORAGE_LOCAL_ROOT`                                                                                             | file root for `local`                                                                                       | `./storage`                       |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`       | object storage for `s3`                                                                                     | MinIO-friendly                    |
| `AUDIT_ANCHOR_BUCKET`                                                                                            | write-once (Object Lock) bucket for the daily audit anchors; empty = database only                          | unset                             |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, `OIDC_SCOPES`, `OIDC_AUTO_PROVISION` | OAuth/OIDC sign-in (section 4.3, see 3)                                                                     | off                               |
| `JOBS_ENABLED`                                                                                                   | start pg-boss workers and cron schedules                                                                    | `true`                            |
| `VIRUS_SCANNER`, `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_TIMEOUT_MS`                                               | upload scanning (`none` or `clamav`)                                                                        | `none`                            |
| `COOKIE_SECURE`                                                                                                  | Secure session cookies; set `false` only for plain-http development                                         | `true`                            |

Never commit `.env` files. Runtime behaviour that HR or a system admin changes (idle timeout, "Working as" depth and restrictions, auto-processing, escalation, birthdays, branding, deactivating logins on termination) lives in `SystemSetting` and is edited through `GET/PUT /api/v1/admin/settings` (send back the `revision` you read; a stale one answers 409).

## 3. OIDC (OAuth sign-in)

1. Register a confidential client with the identity provider: redirect URI `https://<api host>/api/v1/auth/oidc/callback`, scopes `openid profile email`, PKCE allowed.
2. Set `OIDC_ISSUER` (the issuer URL with `/.well-known/openid-configuration`), `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` (the URI above) and, if needed, `OIDC_SCOPES`. Restart the API. Until all three of issuer, client id and redirect URI are set, `/auth/oidc/*` answers 404.
3. Users are matched only by `User.externalSubject` = the token's `sub`. With `OIDC_AUTO_PROVISION=false` (the default) a system admin creates each OAuth user first: `POST /api/v1/admin/users` with `authProvider: "OAUTH"` and `externalSubject`, or the `authProvider` and `externalSubject` columns of the employee import.
4. Test: open `/api/v1/auth/oidc/start`, sign in at the provider and expect a redirect to `PUBLIC_URL/dashboard` and an `AUTH.LOGIN_SUCCESS` row with `provider: OAUTH`. Failures redirect to `/login?error=<code>` and are audited `AUTH.LOGIN_FAILURE`.

## 4. Backups

Two layers, both required in production:

1. **Continuous WAL archiving** (point-in-time recovery). In `postgresql.conf`:

   ```ini
   wal_level = replica
   archive_mode = on
   archive_command = 'test ! -f /backup/wal/%f && cp %p /backup/wal/%f'   # or wal-g / pgBackRest to object storage
   archive_timeout = 300
   ```

   Take a base backup at least weekly: `pg_basebackup -D /backup/base/$(date +%F) -Ft -z -X stream -U <replication user>`.

2. **Nightly logical dump** (portable, easy to inspect), as `app_owner`:

   ```sh
   pg_dump --format=custom --no-owner --file=/backup/dump/peoplehub-$(date +%F).dump "$MIGRATION_DATABASE_URL"
   ```

Also back up the attachment store (`STORAGE_LOCAL_ROOT`, or enable versioning on the S3 bucket): payslip and tax certificate PDFs are attachments and their `sha256` is checked on every read. Keep `ENCRYPTION_KEYS` in a secret manager, separately from the backups: a backup without its keys cannot be decrypted (by design), and keys without the backup reveal nothing.

Retention: keep base backups and WAL for at least 35 days and monthly dumps for the record-retention period. Audit rows are never deleted (`audit.retentionYears` = null, section 9.6).

## 5. Restore drill (quarterly)

Run it on a scratch server, never over production.

1. Create the roles (section 1) and an empty database owned by `app_owner`.
2. Restore: `pg_restore --no-owner --role=app_owner --dbname=<scratch url> /backup/dump/peoplehub-<date>.dump`. For point-in-time recovery restore the base backup, set `restore_command = 'cp /backup/wal/%f %p'` and `recovery_target_time = '<timestamp>'`, create `recovery.signal` and start Postgres.
3. Re-apply the grants if the restore ran without them (they are part of the migrations): run `pnpm db:deploy` against the scratch database; it reports "No pending migrations" and leaves data alone.
4. Point a scratch API at it (`DATABASE_URL`, the same `ENCRYPTION_KEYS`, `JOBS_ENABLED=false`, `MAIL_TRANSPORT=memory`).
5. Verify:
   - `pnpm audit:verify` reports `Audit chain OK`;
   - compare the last row with the latest anchor (section 6): `SELECT "lastAuditId", "lastHash" FROM "AuditAnchor" ORDER BY day DESC LIMIT 1;` and, when configured, the matching object in `AUDIT_ANCHOR_BUCKET` (`audit-anchors/<day>.json`);
   - sign in as a test user and open a payslip PDF (decryption and file store work);
   - `UPDATE "AuditLog" SET action = 'x' WHERE id = 1;` must fail as both `app_user` and `app_owner`.
6. Record the drill (date, backup used, duration, results) in the operations log.

## 6. Audit verification and anchors

- **Chain check:** `pnpm audit:verify` (whole log) or `pnpm audit:verify --from=2026-10-01T00:00:00Z --to=2026-10-31T23:59:59Z`. It prints the JSON result and exits 1 when the chain is broken, naming the first broken id and the reason. The same check is `GET /api/v1/audit/verify?from=&to=` (AUDITOR, SYSTEM_ADMIN; dates are whole days in Africa/Windhoek) and the "Verify chain" button of the audit explorer. Run it nightly from cron after the anchor job and alert on a non-zero exit.
- **Anchors:** the `audit.anchor` job (00:05 daily) stores the last id and hash of the previous business day in `AuditAnchor` (append-only) and, when `AUDIT_ANCHOR_BUCKET` is set, writes `audit-anchors/<day>.json` with S3 Object Lock in COMPLIANCE mode for ten years. A verify whose range ends on a day returns that day's anchor; it must equal the hash of the row with that id. A missing anchor is re-created with `pnpm jobs:run audit.anchor '{"day":"2026-10-19"}'` (idempotent).
- **A broken chain:** do not "repair" rows (they cannot be updated). Freeze the database (take a snapshot), compare the broken row and its neighbours with the last good backup and the external anchors, and treat it as a security incident: the rows after the break are still evidence, and the break itself is the finding.

## 7. Key rotation

1. Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Add it to `ENCRYPTION_KEYS` (keep every old key), set `ENCRYPTION_ACTIVE_KEY` to the new id and restart the API: new values are written with the new key, old ones still decrypt.
3. Run `pnpm keys:rotate`. It re-encrypts every encrypted column (ID, passport, tax, birth certificate, bank account, licence numbers, MFA secrets) and the sealed values inside pending change requests in batches, and writes `SYSTEM.KEY_ROTATION` rows with the counts. It is safe to re-run.
4. Confirm nothing uses the old key: `SELECT count(*) FROM "BankAccount" WHERE "accountNumberEnc" LIKE 'k1:%';` (and the same for the other columns) returns 0.
5. Remove the old key from `ENCRYPTION_KEYS` only after the next full backup has been taken with the new key (older backups still need the old key: keep it in the secret manager's history).

## 8. Jobs: schedules and re-running

Jobs run on pg-boss (schema `pgboss` in the application database) with cron times in Africa/Windhoek. Each run writes a `SYSTEM.JOB_RUN` audit row with its input, counts and duration (`outcome: FAILURE` and the error as `reason` when it throws). List them with `pnpm jobs:run`:

| Job                             | Schedule         | What it does                                                                              |
| ------------------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `outbox.publish`                | every minute     | delivers domain events (notifications, bank-change email, `payPeriod.closed`)             |
| `workflow.escalate`             | every 15 minutes | escalates overdue steps; auto-reassigns after twice the time when enabled                 |
| `workflow.unpark`               | every 15 minutes | returns parked steps                                                                      |
| `workflow.reresolve`            | 02:30            | moves open steps of inactive or terminated approvers                                      |
| `audit.anchor`                  | 00:05            | daily audit anchor                                                                        |
| `leave.accrue`                  | 01:00 on the 1st | accruals (also queued by each pay-period close)                                           |
| `leave.cycleRollover`           | 00:15            | carry forward and forfeit at cycle end                                                    |
| `leave.creditExpiry`            | 00:30            | forfeits expired leave-in-lieu credit                                                     |
| `leave.carryForwardExpiry`      | 00:45            | forfeits expired carry-forward                                                            |
| `holidays.generate`             | 02:00 on 1 Dec   | stores next year's rule-generated holidays for HR to check against the Government Gazette |
| `details.licenceExpiry`         | 02:15            | licence expiry notices                                                                    |
| `performance.reviewNotify`      | 06:00            | "Specific date" review notifications                                                      |
| `performance.initiateContracts` | on demand        | contract initiation                                                                       |

Every job is idempotent, so re-running is always safe:

- **Find failures:** `GET /api/v1/audit?action=SYSTEM.JOB_RUN&outcomes=FAILURE` (or the "Audit Trail Extract" report), and pg-boss's own record: `SELECT name, state, output, completed_on FROM pgboss.job WHERE state = 'failed' ORDER BY completed_on DESC;`.
- **Re-run now, in-process:** `pnpm jobs:run <name> '<json data>'`, for example `pnpm jobs:run leave.accrue '{"asOf":"2026-11-01","companyRuleId":1}'` or `pnpm jobs:run workflow.reresolve`. This is `JobsService.runNow` in a short-lived application context with the workers off, so it does not clash with the running API.
- **Re-queue through pg-boss** (the API's workers pick it up; pg-boss 10 schema): `INSERT INTO pgboss.job (name, data) VALUES ('<name>', '{"asOf":"2026-11-01"}'::jsonb);`, or retry a failed job with `UPDATE pgboss.job SET state = 'retry', retry_count = 0, start_after = now() WHERE id = '<id>';`.
- **Outbox:** an event that failed 10 times stays in `OutboxEvent` with `lastError`. After fixing the cause, reset it with `UPDATE "OutboxEvent" SET attempts = 0, "lastError" = NULL WHERE id = <id>;` and run `pnpm jobs:run outbox.publish`.

## 9. Routine operations

- **Pay period close** (Payroll): `POST /api/v1/admin/pay-periods/:id/close` is final, audited `PAY_PERIOD.CLOSED`, and writes the `payPeriod.closed` event; its listener queues `leave.accrue` for the day after the period. The response lists approved items still waiting to be processed.
- **Employee termination** (HR): `POST /api/v1/admin/employees/:id/terminate` ends the employee's sessions, deactivates the login (setting `employees.deactivateUserOnTermination`) and re-resolves their open approval steps at once; the nightly `workflow.reresolve` catches anything left.
- **Locked or forgotten accounts** (system admin): `POST /api/v1/admin/users/:id/unlock`, `…/reset-password` (emails a 30-minute link, forces a change and ends the sessions), `…/reset-mfa`.
- **Public holidays:** each December check the generated dates (`GET /api/v1/admin/public-holidays?year=`) against the Government Gazette and add proclaimed once-off holidays.
- **Health:** `GET /health` (liveness), `GET /ready` (database and queue), `GET /metrics` (Prometheus: request latency, job durations, workflow counts, audit insert latency).
