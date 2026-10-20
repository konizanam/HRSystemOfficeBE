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

### Reads and scoping

- Controllers take `@Ctx() ctx: SecurityContext`. Every query is scoped by the caller (spec §4): self, a report within `workingAs.maxDepth`, or company scope for admins.
- Use the scope helpers in `modules/auth/scope.service.ts` rather than writing ad-hoc checks. Never trust an employee id from the client without checking it.
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

The fixtures in `test/support/` sign users in and build an authenticated agent for each role.
