# Architecture

PeopleHub ESS is an Employee Self-Service system: leave, claims, personal details, payslips, approvals and performance, with a complete audit trail. This document describes how the system is put together and the conventions every module follows. The behaviour is specified in [`BUILD_SPEC.md`](../BUILD_SPEC.md).

## Repositories

| Repository         | Contents                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `HRSystemOfficeBE` | `apps/api` (NestJS 11 on Fastify, Prisma 6), `packages/shared` (Zod contracts, enums, domain helpers), `docs/`, CI, Docker                |
| `HRSystemOfficeFE` | `apps/web` (React 19, Vite, TanStack Router and Query, Tailwind, shadcn/ui), plus a synced copy of `packages/shared` (`pnpm sync:shared`) |

`packages/shared` is the single source of truth for the API contract. The API validates with it through `nestjs-zod` DTOs, and the web app uses the same schemas in its forms and query hooks.

## API layout (`apps/api/src`)

```
app.factory.ts        Fastify adapter, helmet/CSP, cookies, CORS, multipart, rate limit, OpenAPI
app.module.ts         root module: logger, CoreModule, feature modules, global pipe and filter
core.module.ts        @Global: DbService, AuditService, EncryptionService, StorageService, JobsService
config/env.ts         Zod-validated environment (env())
common/
  context/            SecurityContext, AuditActor, systemContext(), hasRole()
  errors/             DomainError subclasses and ProblemFilter (RFC 7807, audits 401/403)
  http/               @Ctx(), @Meta(), @AuditView(), @Idempotent()
audit/                AuditService, chain writer, canonical JSON, redaction, safety net, anchors
prisma/               createPrismaClient (with the audit extension), DbService (tx, lockRow, nextSequence)
crypto/               EncryptionService (AES-256-GCM), key rotation
storage/              StorageService (local disk or S3)
jobs/                 JobsService (pg-boss; runNow for tests)
modules/<feature>/    one Nest module per feature (auth, workflow, leave, claims, details, …)
  auth/               sessions, SessionGuard + RolesGuard (global), login/OIDC/MFA, ScopeService
  settings/           SettingsService: typed SystemSetting access with defaults and a cache
  notifications/      MailService (nodemailer; MAIL_TRANSPORT=memory keeps an outbox for tests)
notifications/templates/  plain HTML email templates (copied to dist by the Nest CLI)
cli/                  audit-verify, keys-rotate
```

## Conventions (every module)

### Writes

Every state change runs inside `db.tx(ctx, async (tx) => { … })` and calls `this.audit.record(tx, ctx, {...})`:

```ts
return this.db.tx(ctx, async (tx) => {
  const before = await tx.leaveApplication.findUniqueOrThrow({ where: { id } });
  assertVersion(before, input.version);                       // 409 on mismatch
  const after = await tx.leaveApplication.update({ where: { id }, data: { …, version: { increment: 1 } } });
  this.audit.record(tx, ctx, {
    category: 'WORKFLOW', action: 'LEAVE.WITHDRAWN',
    entityType: 'LeaveApplication', entityId: id,             // Prisma model name + id
    subjectEmployeeId: after.employeeId, before, after,
  });
  return after;
});
```

- `entityType` must be the **Prisma model name**. That name is how the safety net knows a write was audited explicitly.
- Nested `db.tx` calls join the outer transaction, so services compose freely.
- Writes to audited models outside `db.tx` throw. So do `updateMany`/`deleteMany`, unless a job passes `{ allowBulk: true }` and audits each row.
- Events with no business write (a login failure, a view, an export) use `audit.recordStandalone(actor, entry)`.
- **No hard deletes** of business data. Use `deletedAt` or a status.
- Mutable aggregates carry `version`. Clients send the version they read; check it with `assertVersion()` and increment it on every update.
- Reference numbers come from `db.nextSequence(tx, sequenceKeys.leave(...))` inside the submit transaction, formatted with the shared `format*Reference` helpers.
- Process rows are locked with `db.lockRow(tx, 'WorkflowProcess', id)` before workflow actions.

### Authentication

- Every route needs a session unless it is marked `@Public()`. `SessionGuard` builds `request.securityContext`, checks CSRF (`x-csrf-token` must equal the `ph_csrf` cookie and the session's token) on unsafe methods, and refuses everything except `@AllowPendingPasswordChange()` routes while a password change is required.
- `@Roles('HR_ADMIN', …)` on a controller or handler restricts it to those roles (`RolesGuard`).
- Each `/auth/*` handler carries `@AuthRateLimit()` (10 requests per minute per IP).
- Settings are read with `settings.get('session.idleMinutes')`; the keys, schemas and defaults are in `packages/shared/src/api/settings.ts`.
- Email goes through `mail.sendInBackground({ to, template, data })`. Add a template by adding its HTML file and an entry in `MailTemplateData` and `MAIL_SUBJECTS`.

### Reads and scoping

- Controllers take `@Ctx() ctx: SecurityContext`. Every query is scoped by the caller (spec §4): self, a report within `workingAs.maxDepth`, or company scope for admins.
- Use the scope helpers in `modules/auth/scope.service.ts` rather than writing ad-hoc checks. Never trust an employee id from the client without checking it:
  - `assertCanAccessEmployee(ctx, employeeId, purpose)` with purpose `SELF_SERVICE` (the "Working as" rule), `TEAM`, `HR_READ`, `HR_WRITE`, `PAYROLL` or `AUDIT`; 404 when missing, 403 (audited DENIED) when out of scope.
  - `assertNotRestricted(ctx, 'PAYSLIPS')` before any feature in `workingAs.restrictedFeatures`.
  - `canActFor(ctx, employeeId)` and `reportIdsWithinDepth(managerEmployeeId, depth?)` for lists.
- Sensitive reads are decorated with `@AuditView({ what: 'PAYSLIP', entityType: 'Payslip' })`.

### Validation and errors

- Request DTOs are `createZodDto(Schema)` classes, and the schemas live in `packages/shared/src/api/<feature>.ts`.
- Business rule failures throw `ValidationError([{ path, message }])`, which returns 422 with field errors. Other errors: `NotFoundError` (404), `ForbiddenError` (403, audited automatically), `ConflictError` (409).
- Decimals travel as strings (`units4()`, `money2()`), business dates as `YYYY-MM-DD`, timestamps as ISO-8601 UTC.
- Pagination is `?page=&pageSize=` (max 100) and returns `{ items, total, page, pageSize }`.

### Submits

`POST …/submit` endpoints use `@Idempotent()`. A replay with the same `Idempotency-Key` returns the original response.

### Jobs

A module registers handlers in `onModuleInit`, for example `jobs.register('leave.accrue', handler, { cron: '0 1 1 * *' })`. Handlers return a counts object, which goes into the `SYSTEM.JOB_RUN` audit row. Tests call `jobs.runNow(name, data)`.

### Workflow subjects

Each workflow type has a `WorkflowSubjectHandler` (`onFinalApproval`, `onProcess`, `onDeclined`, `onCancelled`), registered with the workflow engine. Domain events are written to `OutboxEvent` in the transaction and published by a pg-boss job after commit.

## Database roles

| Role        | Used by                                                         | Rights                                                                                                                |
| ----------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `app_owner` | migrations (`node scripts/as-owner.mjs prisma …`), schema owner | everything                                                                                                            |
| `app_user`  | the API, seed, CLIs, tests                                      | CRUD on business tables; SELECT and INSERT only on `AuditLog`, `AuditAnchor`, `LeaveLedgerEntry` and `WorkflowAction` |

To add a migration, edit `prisma/schema.prisma` and run `pnpm --filter @peoplehub/api db:migrate --name <name>` (runs `migrate dev` as the owner). Raw SQL (triggers, checks, partial indexes) goes in a `--create-only` migration that you then edit. `prisma migrate reset` is never part of a script or test.

## Testing

| Suite           | Command                                      | Notes                                                                                                                                                            |
| --------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared unit     | `pnpm --filter @peoplehub/shared test`       | ≥ 90% line coverage                                                                                                                                              |
| API unit        | `pnpm --filter @peoplehub/api test`          | `test/unit/**`, pure domain logic, no DB                                                                                                                         |
| API integration | `pnpm test:int`                              | `test/int/**`, Supertest against `createApp()` on `TEST_DATABASE_URL` (Testcontainers when unset); files run serially; use unique keys, never assume an empty DB |
| Web e2e         | `pnpm --filter @peoplehub/web e2e` (FE repo) | Playwright, including the radius/shadow visual rule                                                                                                              |

The fixtures in `test/support/` sign users in and build an authenticated agent for each role:

- `createOrg`, `createPerson` and `createRoleFixtures` (one person per role, manager A → manager B → employees, an unrelated colleague and another company) in `fixtures.ts`. Codes and usernames come from a database sequence, so they never collide between runs.
- `login(t, person)` returns an `Agent` that sends the session cookie, the CSRF header and its own `x-forwarded-for` IP (so rate limits do not leak between tests).
- `authz.ts` holds the authorisation-matrix runner; `test/int/authz-matrix.int.test.ts` lists the cases. Add new endpoints there.
- `t.mail.outbox` / `t.mail.flush()` read email sent in memory mode; `fake-oidc.ts` is a minimal OpenID provider.
