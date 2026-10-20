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
prisma/               createPrismaClient (with the audit extension), DbService (tx, afterCommit, lockRow, nextSequence)
crypto/               EncryptionService (AES-256-GCM), key rotation
storage/              StorageService (local disk or S3)
jobs/                 JobsService (pg-boss; runNow for tests)
events/               EventBus (in-process listeners) and OutboxService (transactional outbox + publisher job)
modules/<feature>/    one Nest module per feature (auth, workflow, leave, claims, details, …)
  auth/               sessions, SessionGuard + RolesGuard (global), login/OIDC/MFA, ScopeService
  settings/           SettingsService: typed SystemSetting access with defaults and a cache
  notifications/      MailService (nodemailer; MAIL_TRANSPORT=memory keeps an outbox for tests), NotificationService
  workflow/           WorkflowEngine, subject registry, approver resolution, out of office, inbox, jobs, notifier
  attachments/        uploads (magic-byte sniffer, virus scanner), owner registry, audited downloads
  holidays/           HolidayService (stored rows + rules table, observed dates), holidays.generate job
  leave/              policies, buckets and ledger, units, applications and cancellations, balances,
                      leave in lieu, accrual/rollover/expiry jobs, calendar, HR admin
notifications/templates/  plain HTML email templates (copied to dist by the Nest CLI)
cli/                  audit-verify, keys-rotate
```

`prisma/seed.ts` runs inside a Nest application context (the leave fixture is submitted through `LeaveService`), with jobs off and in-memory email. `pnpm db:seed` starts it through `scripts/swc-register.cjs`, which compiles TypeScript with `@swc/core` because tsx (esbuild) cannot emit the decorator metadata Nest's dependency injection needs. The other CLIs (`audit:verify`, `keys:rotate`) do not use DI and keep using tsx.

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
  - `canAccessAny(ctx, employeeId, purposes)` / `assertCanAccessAny(...)` when several purposes may read (for example leave: self, manager, HR).
  - Inside a transaction, pass its client as the last argument (`assertCanAccessEmployee(ctx, id, purpose, tx)`), so the check does not need a second pooled connection while the transaction holds locks.
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

Each workflow type has a `WorkflowSubjectHandler`, registered with `WorkflowSubjectRegistry`. Domain events are written to `OutboxEvent` in the transaction and published by a pg-boss job after commit. See [Workflow engine](#workflow-engine) below.

## Workflow engine

`modules/workflow` implements spec section 7: definitions, approver resolution, step instances, every action, out of office, escalation and parking, the outbox, notifications and the inbox API. Feature modules never write `WorkflowProcess`, `WorkflowStepInstance` or `WorkflowAction` themselves; they call `WorkflowEngine` and react through a subject handler.

### How a request moves

```
start ──▶ IN_PROGRESS ──approve (last step)──▶ APPROVED_PENDING_PROCESS ──process──▶ PROCESSED
            │  ├─ decline ──────▶ DECLINED                         (payroll types only)
            │  ├─ send back ────▶ RESUBMIT_REQUIRED ──resubmit──▶ IN_PROGRESS (round + 1)
            │  └─ park / reassign / comment (stays IN_PROGRESS)
            └─ withdraw / cancel ─▶ CANCELLED
non-payroll types: last approval ──▶ PROCESSED (APPLY, same transaction)
onFinalApproval returns CONFLICT ──▶ CONFLICT (HR is alerted)
```

- **Definitions** are chosen by `(workflowType, companyRule | null, discriminator?)`; the most specific active one wins (`engine-rules.ts: selectDefinition`).
- **Steps** are planned when they become current (`planStep`): REPORTS_TO, REPORTS_TO_LEVEL_2, SPECIFIC_USER or ROLE. A ROLE step gets one instance per holder; the first to act wins and the others become `SUPERSEDED`. The applicant and the submitter never approve. `skipIfSameApprover` and unresolved optional steps produce `AUTO_SKIP`; an unresolved mandatory step goes to the company's HR admins.
- **Out of office** is applied to every new assignee (`resolveDelegation`: at most 3 hops, cycle → original assignee + HR alert, never to the applicant).
- **Every call** (`start`, `act`, `withdraw`, `cancel`, `resubmit`, `process`, `bulkApprove`) runs in one transaction: lock the process row (`db.lockRow`), check the caller, then the `version` (409), write `WorkflowAction` rows, `WORKFLOW.*` audit rows and `OutboxEvent` rows, and call the subject handler.
- **Jobs**: `workflow.escalate` and `workflow.unpark` every 15 minutes, `workflow.reresolve` nightly, `outbox.publish` every minute (and right after each commit when jobs run).
- **Events** (`workflow-events.ts`) are delivered by the outbox publisher to `EventBus` listeners; `WorkflowNotifier` turns them into `Notification` rows and email.

### Adding a workflow type (later phases)

1. Implement `WorkflowSubjectHandler` (`modules/workflow/workflow-subject.ts`) for the type.
2. Register it in your module's `onModuleInit`.
3. Start a process inside your submit transaction with `engine.start(...)`; the nested `db.tx` joins your transaction, so the subject row, the process and all audit rows commit together.

```ts
// modules/leave/leave-subject.handlers.ts
@Injectable()
export class LeaveSubjectHandler implements WorkflowSubjectHandler {
  readonly type = 'LEAVE' as const;

  constructor(private readonly audit: AuditService) {}

  async describe(client: Tx, process: WorkflowProcessSnapshot): Promise<SubjectDescription> {
    const app = await client.leaveApplication.findUniqueOrThrow({
      where: { id: Number(process.subjectEntityId) },
      include: { leaveType: true },
    });
    const units = app.unitsTaken.toFixed(4);
    return {
      requestLabel: app.leaveType.description, // "This Annual Leave Request …"
      title: 'Leave request',
      fromDate: businessFromDate(app.fromDate),
      toDate: businessFromDate(app.toDate),
      unitsLine: `${units} Days to be deducted`,
      headline: [{ label: 'Days to be deducted', value: units }],
      fields: [{ label: 'Leave type', value: app.leaveType.description } /* … */],
      data: { referenceNumber: app.referenceNumber },
      viewLabel: 'View leave request',
    };
  }

  async onFinalApproval({ tx, ctx, process }: WorkflowHookContext): Promise<FinalApprovalResult> {
    await tx.leaveApplication.update({
      where: { id: Number(process.subjectEntityId) },
      data: { status: process.status, approvedAt: new Date() },
    });
    // … audit LEAVE.APPROVED with this.audit.record(tx, ctx, {...})
    return { outcome: 'APPLIED' }; // { outcome: 'CONFLICT', reason } for ChangeRequest conflicts
  }

  async onProcess({ tx, ctx, process, payPeriod }: WorkflowProcessHookContext): Promise<void> {
    // post TAKEN ledger entries into payPeriod, set the application PROCESSED, audit
  }

  async onDeclined({ tx, process, comment }: WorkflowCommentHookContext): Promise<void> {
    // release the allocations
  }

  async onCancelled({ tx, process, reason }: WorkflowCancelHookContext): Promise<void> {
    // release the allocations; reason is WITHDRAWN or CANCELLED
  }

  // Optional: onSentBack, onResubmitted (receives the applicant's `changes`), and
  // warnings(client, process, viewer) for the approver panel, e.g. a negative balance.
}

// modules/leave/leave.module.ts
@Module({ imports: [WorkflowModule], providers: [LeaveSubjectHandler, LeaveService] })
export class LeaveModule implements OnModuleInit {
  constructor(
    private readonly registry: WorkflowSubjectRegistry,
    private readonly handler: LeaveSubjectHandler,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.handler);
  }
}

// modules/leave/leave.service.ts, inside the submit transaction
const process = await this.engine.start(ctx, {
  type: 'LEAVE',
  subjectEntity: 'LeaveApplication',
  subjectEntityId: application.id,
  subjectEmployeeId: application.employeeId,
  summary: `${leaveType.description} ${formatGridDate(from)} to ${formatGridDate(to)}`,
  discriminator: null, // e.g. the claim group id for GROUPEDCLAIM
  comment: input.comment,
});
await tx.leaveApplication.update({
  where: { id: application.id },
  data: { processId: process.id, status: 'IN_PROGRESS' },
});
```

Rules for handlers:

- Hooks run inside the engine's transaction after the transition is decided (`process.status` is already the new status). Throwing rolls the whole action back.
- Write through `hook.tx` and record your own domain audit rows (`LEAVE.APPROVED`, …); the engine writes the `WORKFLOW.*` rows.
- Payroll types (`PAYROLL_PROCESSED_WORKFLOW_TYPES`) get `onProcess` from `POST /workflow/processes/process` or `workflow.autoProcess.{TYPE}`; other types apply their change in `onFinalApproval` and never get `onProcess`.
- `describe` is read-only and is called for every inbox card, so keep it to one or two queries.
- A type with no handler uses `GenericSubjectHandler`, which describes the request by its summary.
- Use `engine.cancel(ctx, processId, { comment })` when your domain cancels a request (for example an approved leave cancellation), and `engine.reresolveForUser(userId)` from the employee termination flow.

The web app links to a request at `/inbox/items/{processId}`; notifications and email use that path.

## Attachments

`modules/attachments` implements spec section 10.4. Feature modules never write `Attachment` rows themselves.

1. The client uploads first: `POST /attachments` (multipart, field `file`, up to 10 files). Each file is checked (extension, declared type, magic bytes, 10 MB, virus scan through the `VIRUS_SCANNER` provider), stored under `yyyy/mm/{uuid}` with its sha256, and recorded as **unowned**: `ownerEntity = 'Unowned'`, `ownerEntityId` = the uploader's user id. Only the uploader can download or delete it.
2. The submit sends the ids (`attachmentIds`), and the submit transaction binds them to the new subject: `attachments.bind(tx, ctx, ids, { entity: 'LeaveApplication', entityId, subjectEmployeeId })`. An id that is not an unowned upload of the caller fails the whole submit with 422 on `attachmentIds.n`.
3. Each module registers a resolver for its owner entities in `onModuleInit`, so the download check can find the owning employee and process:

```ts
this.owners.register('LeaveApplication', async (client, id) => {
  const app = await client.leaveApplication.findUnique({
    where: { id: Number(id) },
    select: { employeeId: true, processId: true },
  });
  return app ? { employeeId: app.employeeId, processId: app.processId } : null;
});
```

4. `GET /attachments/:id` allows the owning employee (or someone "Working as" them), their manager, HR/Payroll of their company and every reader of the owning process (approvers, auditors), and writes `DATA_VIEW.ATTACHMENT_DOWNLOAD`. The inbox detail lists the attachments of the subject entity (and of the process) with that download URL.

## Leave

`modules/leave` implements spec section 5.2.

- **Policies** (`LeavePolicyService`): the most specific active policy per type (company rule over `null`); "the types the employee has a policy for" comes from here.
- **Buckets and ledger** (`EntitlementService`): `EmployeeLeaveEntitlement` rows of kind `CYCLE`, `CARRY_FORWARD` or `CREDIT`, and the append-only `LeaveLedgerEntry` (UPDATE/DELETE are blocked by trigger and grants). Every posting goes through `entitlements.post(tx, ctx, entry, { action })`, which audits it. Leave writes for one employee lock the employee row first (`lockEmployee`), which serialises balance, overlap and allocation decisions. Buckets of the current cycle are opened lazily (submit, jobs, adjustments).
- **Rules** (`leave-rules.ts`): pure functions for units, overlap, allocation, period figures, accrual, cycles and rollover; the unit tests pin them to the section 1.7 fixtures.
- **Applications** (`LeaveService`, `LeaveRequestValidator`): submit validates everything in one pass (422 with field errors), reserves units through `LeaveApplicationAllocation` (earliest cycle end first) and starts the `LEAVE` workflow in the same transaction. Cancel withdraws or starts a `CANCELLEAVE` application.
- **Handlers** (`LeaveSubjectHandler`, `CancelLeaveHandler`, `CreditLeaveHandler` for `CREDITLVEREQ`/`CREDITLVEALLOC`) keep the subject's status in step with the process; processing posts TAKEN, CANCELLATION_REVERSAL or CREDIT_ALLOCATION into the pay period.
- **Jobs** (`LeaveJobs`): `leave.accrue` (monthly, and on the `payPeriod.closed` outbox event), `leave.cycleRollover`, `leave.creditExpiry`, `leave.carryForwardExpiry`; each takes `{ asOf?, employeeIds?, companyRuleId? }` and is idempotent. A module that closes pay periods (Phase 9) emits `payPeriod.closed` with `{ payPeriodId }` through the outbox.
- **Calendar** (`LeaveCalendarService`): the dashboard calendar, its audited export and `onLeaveTodayCount(ctx)` for the dashboard summary.
- **Holidays** (`modules/holidays`): `HolidayService.calendar(companyId, from, to)` gives the excluded days (observed dates included) for the unit calculation.

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
- `authz.ts` holds the authorisation-matrix runner; `test/int/authz-matrix.int.test.ts` (Phase 2), `test/int/authz-matrix-workflow.int.test.ts` (Phase 3) and `test/int/authz-matrix-leave.int.test.ts` (Phase 4) list the cases. Add new endpoints to a matrix file for your phase.
- `leave.ts` holds the leave kit: `setup(org)` seeds the leave reference data and holidays (idempotent) and the two-step definitions of the leave workflow types on the fixture company rule; `accrue(employeeIds, asOf?)`, `monday(days)` and `range(from, units)` for future working-day ranges, `upload(agent)` and `submit(agent, body)`.
- `workflow.ts` holds the workflow kit: `FakeSubjectHandler` (records every hook call and describes subjects from memory), `kit.useFakeHandler(type)` (swaps it in for a real type and restores the original at the end), `kit.definition(...)` for a definition on a fixture company rule (which outranks the seeded defaults), `kit.start(...)`, `kit.payPeriod(org)`, `kit.publish()` (delivers the outbox and waits for email) and `contextFor(person)`.
- `t.mail.outbox` / `t.mail.flush()` read email sent in memory mode; `fake-oidc.ts` is a minimal OpenID provider.
