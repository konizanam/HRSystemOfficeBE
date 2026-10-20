# Audit trail

The audit trail records every state change, approval action, login, sensitive-data view and export (spec §9). This document explains how it works and how to check it.

## Guarantees

1. **Same transaction.** Audit rows are written inside the business transaction, as its last statement. If the audit insert fails, the whole transaction rolls back (`DbService.tx`).
2. **Append-only.** `UPDATE`, `DELETE` and `TRUNCATE` on `AuditLog` are blocked in two ways:
   - the `audit_no_update` trigger, which applies to every role, including the owner;
   - grants: `app_user`, the role the application runs as, has only `SELECT` and `INSERT`.
3. **Tamper-evident.** Each row stores `hash = sha256(prevHash || canonicalJson(row without hash))`. Changing, deleting or reordering any row breaks the chain from that point on.
4. **Anchored.** A nightly job (`audit.anchor`, 00:05 Africa/Windhoek) stores the last id and hash of each day in `AuditAnchor`. When `AUDIT_ANCHOR_BUCKET` is set, it also writes them to a write-once S3 bucket with Object Lock in COMPLIANCE mode.

## How rows are produced

| Mechanism             | Where                                                                     | Rows                                                                               |
| --------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Explicit domain audit | `audit.record(tx, ctx, {...})` in every service method that changes state | `LEAVE.SUBMITTED`, `WORKFLOW.APPROVED`, …                                          |
| Safety net            | Prisma extension `audit-safety-net` (`src/prisma/prisma-client.ts`)       | `DATA_CHANGE.{MODEL}.{OP}` for audited-model writes that no explicit audit covered |
| Stand-alone events    | `audit.recordStandalone(actor, {...})`                                    | login failures, data views, exports                                                |
| HTTP layer            | `ProblemFilter`                                                           | `SECURITY.ACCESS_DENIED` for every 401/403                                         |
| Sensitive reads       | `@AuditView({ what: 'PAYSLIP', … })`                                      | `DATA_VIEW.*` / `EXPORT.*`                                                         |
| Jobs                  | `JobsService`                                                             | `SYSTEM.JOB_RUN` with counts and duration                                          |

The safety net also enforces three rules:

- Writes to audited models are refused outside `DbService.tx`.
- `updateMany` and `deleteMany` on audited models throw, unless a job opts in with `{ allowBulk: true }` and audits each row.
- An entity is covered when an explicit entry has the same `entityType` (the Prisma model name) and `entityId`.

## Canonical JSON

- Object keys are sorted recursively, with no whitespace.
- Timestamps are ISO-8601 with microsecond precision (`2026-10-20T08:15:30.123000Z`).
- Decimals and bigints are strings.
- Before hashing, values are normalised to plain JSON. What is stored in `jsonb` therefore reads back identically.

The chain is serialised with `pg_advisory_xact_lock(727274)`. The row `id` is drawn from the sequence while that lock is held, so ids, hash order and commit order all agree.

## Redaction (`src/audit/redact.ts`)

- Passwords, password hashes, tokens, CSRF tokens and MFA secrets are stored as `"[REDACTED]"`.
- Encrypted columns (`*Enc`) are stored as `{ "last4": "1234", "changed": true }`, never as plaintext or ciphertext.
- Attachments are reduced to `{ id, fileName, sha256, sizeBytes }`.
- `test/unit/redact.test.ts` runs the policy against every model in the Prisma schema.

## Verifying

```bash
pnpm audit:verify                       # whole chain
pnpm audit:verify --from=2026-10-01T00:00:00Z --to=2026-10-31T23:59:59Z
```

Auditors and system admins can also call `GET /api/v1/audit/verify?from=&to=` or use **Verify chain** on the Audit page. A broken chain reports the first broken `id` and the reason, for example `hash does not match row content`.

## Retention

Audit rows are kept forever (`audit.retentionYears = null`). Business records are soft-deleted only.
