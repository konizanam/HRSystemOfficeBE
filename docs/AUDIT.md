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
- Change requests (`ChangeRequest.proposed`) carry sensitive values sealed as `{ valueEnc, last4 }`; `valueEnc` ends in `Enc`, so the audit copy becomes `{ "last4": null, "changed": true }` next to the masked `last4`.
- `test/unit/redact.test.ts` runs the policy against every model in the Prisma schema.

## Verifying

```bash
pnpm audit:verify                       # whole chain
pnpm audit:verify --from=2026-10-01T00:00:00Z --to=2026-10-31T23:59:59Z
```

Auditors and system admins can also call `GET /api/v1/audit/verify?from=&to=` (a date is a whole day in Africa/Windhoek, a timestamp is exact) or use **Verify chain** on the Audit page. The answer also carries the latest daily anchor up to the end of the range, to compare with the copy in the write-once bucket. A broken chain reports the first broken `id` and the reason, for example `hash does not match row content`. The restore drill and what to do about a broken chain are in [RUNBOOK.md](RUNBOOK.md#6-audit-verification-and-anchors).

## Reading the trail (audit API, spec §9.7 and §12.11)

| Endpoint                                  | Who                               | What                                                                                                      |
| ----------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /audit`                              | AUDITOR, SYSTEM_ADMIN             | the explorer grid, paginated, newest first (`sort=id:asc` for oldest first)                               |
| `GET /audit/:id`                          | AUDITOR, SYSTEM_ADMIN             | one row with `before`, `after`, `changes`, `metadata` and the hashes, for the side-by-side diff           |
| `GET /audit/entity/:entityType/:entityId` | anyone allowed to see that entity | the record history tab: the entity's rows, the rows of its workflow processes and their `WorkflowAction`s |
| `GET /audit/verify?from=&to=`             | AUDITOR, SYSTEM_ADMIN             | chain verification (above)                                                                                |
| `POST /audit/export {filters, format}`    | AUDITOR, SYSTEM_ADMIN             | CSV or Excel, streamed oldest first, at most 100,000 rows; audited `EXPORT.AUDIT` with the filters first  |

**Filters** (all optional, combined with AND): `from` and `to` (dates or timestamps), `actorUserId`, `actorUsername` (contains), `subjectEmployeeId`, `categories` and `outcomes` (comma-separated), `action` (prefix, for example `LEAVE.`), `entityType` and `entityId`, and `q`, free text searched in `metadata` and `reason` (contains, case-insensitive; `%` and `_` match literally). Unknown query parameters are a 422.

**What a viewer sees.** Values were redacted when the row was written (above), so reading never exposes a secret. On top of that:

- A system admin who is not also HR, Payroll or an auditor never sees pay data (spec §4.1): payslip and tax certificate figures, pay rates and payslip lines read `"[HIDDEN]"`, and the row says `payDataHidden: true`. Bank account numbers are never in the trail (only `last4`).
- The record history hides the request plumbing (IP, request and session ids, user agent) from viewers who are not auditors or system admins.
- Reading the explorer is not itself audited (that would audit every audit read). The export is, and every refusal is a `SECURITY.ACCESS_DENIED` row.

**Record history access** (`EntityHistoryAccess`, using the owning module's scoping rules):

| Entity                                                                                                                                                                                               | Who may open its history                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LeaveApplication`, `CreditLeaveRequest`, `Claim`, `ChangeRequest`, `EmployeeTransaction`, `FreeTextRequest`, `EmployeeLeaveEntitlement`, `PerformanceContract`, `Review`                            | the employee (or someone "Working as" them), their manager, HR/Payroll of their company, and every reader of the entity's workflow process (approvers, HR/Payroll in scope, auditors) |
| `Employee`, `BankAccount`, `DriversLicence`, `FamilyMember`, `FundMembership`                                                                                                                        | the employee and HR/Payroll of their company (not the manager)                                                                                                                        |
| `Payslip`, `TaxCertificate`                                                                                                                                                                          | the employee and Payroll of their company                                                                                                                                             |
| `WorkflowProcess`                                                                                                                                                                                    | the readers of the process                                                                                                                                                            |
| `User`                                                                                                                                                                                               | that user                                                                                                                                                                             |
| `Company`, `CompanyRule`                                                                                                                                                                             | HR and Payroll of that company                                                                                                                                                        |
| `PayPeriod`                                                                                                                                                                                          | Payroll of its company                                                                                                                                                                |
| `ClaimGroup`, `ClaimType`, `ClaimCap`, `Bank`, `BankBranch`                                                                                                                                          | HR and Payroll                                                                                                                                                                        |
| other configuration (leave types, reasons and policies, workflow definitions and steps, free text types, holidays and holiday rules, parameters, funds, templates, rating scales, transaction codes) | HR                                                                                                                                                                                    |
| anything else                                                                                                                                                                                        | auditors and system admins only                                                                                                                                                       |

Auditors and system admins open every history. For anyone else a missing entity or an unknown type is a 404, and a refusal is a 403 (audited `DENIED`). Each list is cut at the 500 newest rows (`truncated: true`).

## Action names added in Phase 9

| Area           | Actions                                                                                                                                                                                                                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organisation   | `COMPANY.CREATED/UPDATED/ACTIVATED/DEACTIVATED`, `COMPANY_RULE.*` (the same), `HOLIDAY.CREATED/UPDATED/DELETED/RESTORED`, `HOLIDAY_RULE.CREATED/UPDATED/ACTIVATED/DEACTIVATED`                                                                                                                                                    |
| Employees      | `EMPLOYEE.CREATED`, `EMPLOYEE.UPDATED`, `EMPLOYEE.STATUS_ACTIVE` / `STATUS_SUSPENDED`, `EMPLOYEE.TERMINATED` (reason, sessions ended, login deactivated), `EMPLOYEE.PHOTO_CHANGED` / `PHOTO_REMOVED`                                                                                                                              |
| Import         | `EMPLOYEE.IMPORT_CREATED`, `EMPLOYEE.IMPORT_UPDATED`, `EMPLOYEE.IMPORT_UNCHANGED` (one per row, with the row number and the file's token), `EMPLOYEE.IMPORT_COMMITTED` (the totals)                                                                                                                                               |
| Users          | `SECURITY.USER_CREATED/UPDATED/ACTIVATED/DEACTIVATED`, `SECURITY.USER_EMPLOYEE_LINKED/UNLINKED`, `SECURITY.ROLE_GRANTED` and `SECURITY.ROLE_REVOKED` (one per role), `AUTH.ACCOUNT_UNLOCKED`, `AUTH.PASSWORD_RESET_REQUESTED` (`via: ADMIN_RESET` or `CREATED`), `AUTH.MFA_RESET`, `AUTH.MFA_DISABLED`, `AUTH.MFA_DISABLE_FAILED` |
| Workflow setup | `WORKFLOW_DEFINITION.CREATED`, `WORKFLOW_DEFINITION.SUPERSEDED` (the old version, with the new id and how many open processes keep it), `WORKFLOW_DEFINITION.VERSION_CREATED`, `WORKFLOW_DEFINITION.ACTIVATED/DEACTIVATED`                                                                                                        |
| Payroll        | `PAY_PERIOD.CREATED/UPDATED/CLOSED` (the close names the `payPeriod.closed` event)                                                                                                                                                                                                                                                |
| Free text      | `FREE_TEXT.SUBMITTED/APPROVED/DECLINED/SENT_BACK/RESUBMITTED/WITHDRAWN/CANCELLED`, `FREE_TEXT_TYPE.CREATED/UPDATED/ACTIVATED/DEACTIVATED/SEEDED`                                                                                                                                                                                  |
| Settings       | `SECURITY.SETTING_CHANGED` (unchanged; a stale `revision` is a 409 and writes nothing)                                                                                                                                                                                                                                            |
| Exports        | `EXPORT.AUDIT`                                                                                                                                                                                                                                                                                                                    |

## Retention

Audit rows are kept forever (`audit.retentionYears = null`). Business records are soft-deleted only.
