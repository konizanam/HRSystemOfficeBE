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
  claims/             eligibility and setup, drafts and lines, caps and balances, submit, GROUPEDCLAIM and
                      CLAIMS handlers, My Expense Claims and its export, HR/Payroll admin
  details/            My Details: the ChangeRequest engine and handler, personal details, bank accounts
                      and banks, drivers licences (+ expiry job), family, beneficiaries and funds,
                      employee transactions (FREETEXTMANEMP), lookups, HR admin
  performance/        parameter lookups, rating scales, templates, contract initiation (job),
                      contracts and archive, reviews (wizard, flow, scores), results, contract reviews
  payslips/           payslips and tax certificates: audited PDF reads, the PAYROLL_ADMIN imports
                      (dry run, commit, PDF generation), PayrollDocumentsService (viewers, branding)
  dashboard/          widget layout, summary, upcoming birthdays
  reports/            report registry, scope, runner and streaming writers; definitions/ per group
pdf/                  PdfService (pdfmake, embedded Roboto) and the document definitions
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

## Claims

`modules/claims` implements spec section 5.3.

- **Eligibility** (`ClaimSetupService`): a claim type applies to an employee's company rule through its active caps: the rule's own caps, or else the global ones (`capsForRule`). A group's tile can start when one of its types applies and `WorkflowEngine.canStartFor(employee, 'GROUPEDCLAIM', groupId)` is true. The setup endpoint resolves each type's rate (`resolveClaimRate` in `packages/shared`: `ClaimType.rate`, or `Employee.hourlyRate × rateMultiplier` for HOURS).
- **Line amounts** come from `computeClaimLineAmount` (shared, so the editor's live total matches the server): HOURS = hours × rate (hours from the start and end time when given), KILOMETRES = km × rate per km, QUANTITY = quantity × rate, AMOUNT = as entered. The server recomputes every line on each save and again on submit with today's rates; the client never sends an amount for the other modes.
- **Drafts** (`ClaimService`): `POST /claims` and `PUT /claims/:id` (version checked) write the lines grid; lines keep their `id`, lines left out are soft-deleted (`ClaimLine.deletedAt`) with their files. Files are bound at save time to `Claim` or `ClaimLine` and taken off with `AttachmentService.detach`; both owners have attachment resolvers, so approvers can download line files.
- **Caps and balances** (`ClaimBalanceService`, pure rules in `claim-rules.ts`): per type, cap and cycle (`cycleFor`: calendar year, calendar month, or the pay period of the company rule), pending (in flight) and claimed (processed) line totals, payroll adjustments (`ClaimBalanceAdjustment` by cycle start) and the pro-rata limit (`proRataFactor` = months employed in the cycle / cycle length). `check` returns the WARN warnings (stored in `Claim.warnings`) and the BLOCK errors (422 on the line); `balances` builds the section 5.3.3 grid.
- **Submit** runs in one transaction: lock the claim and the employee, recompute, check lines → attachments → caps, allocate `C{entity}-G{group}-N{seq}` (`sequenceKeys.claim`), start CLAIMS (one claim type, when a CLAIMS definition applies) or GROUPEDCLAIM with the group id as discriminator, audit `CLAIM.SUBMITTED`.
- **Handlers** (`ClaimSubjectHandler` per type over `ClaimWorkflowService`): `describe` gives the group, description, lines and total (`ClaimSubjectData`) and lists the lines as extra attachment owners; `warnings` shows the stored cap warnings to approvers; final approval records the approver; processing links the pay period and sets PROCESSED; decline, withdraw, cancel and send back mirror the status; a resubmission may carry edited lines and is checked again.
- **Reads**: My Expense Claims (`scope` self / reports / company, the §5.3.2 status buckets from `CLAIM_STATUS_FILTER_MAP`), its audited export (`EXPORT.CLAIMS`), the Saved Claims list and the detail with the approval history. Claim readers follow the leave rule (`claim-access.ts`): self or "Working as", manager, HR/Payroll in scope, auditors, plus the process's approvers.
- **Admin** (`ClaimAdminService`): groups, types and caps (HR_ADMIN or PAYROLL_ADMIN; deactivate, never delete; versioned) and balance adjustments (PAYROLL_ADMIN).

## My Details

`modules/details` implements spec section 5.4 with the ChangeRequest pattern of section 7.6. Employees never write master data: every add, change and delete becomes a `ChangeRequest` that is applied after the final approval.

```
PUT /me/personal ──▶ domain service: lock employee, check version (409), open change (409),
                     diff (422 "No changes to submit"), validate, seal sensitive values
                ──▶ ChangeRequestService.submit: R{entity}-{TYPE}-N{seq}, bind documents, engine.start
final approval ──▶ ChangeRequestHandler.onFinalApproval ──▶ applier.conflict(): version drift → CONFLICT
                                                       └──▶ applier.apply(): the same write HR edits use
```

- **Records and workflows.** `Employee` (personal details) and `FamilyMember` go through BASICINF, `BankAccount` through BANKDET, `DriversLicence` through DRIVERSLICENSE and `FundMembership` (its beneficiaries) through BENEFICIARY. One `ChangeRequestHandler` instance per type delegates to `ChangeRequestService`; each record type has a `ChangeApplier` (`PersonalDetailsService`, `BankAccountService`, `DriversLicenceService`, `FamilyService`, `BeneficiaryService`), registered in `DetailsModule.onModuleInit`.
- **The diff.** `buildChangeDiff` (shared) keeps only the changed leaves of the form; `proposed` stores them nested like the form and `before` their old values. Sensitive values are sealed (`{ valueEnc, last4 }`, see `sealed.ts`) inside `proposed` and masked in `before`, so neither the JSON column nor the audit trail holds a plaintext number. `pnpm keys:rotate` re-seals them too.
- **Banner data.** Every GET returns `pendingChange` per record (and `pendingCreate` for a pending add): the change request, its process id, the edited field paths and the text "Changes pending approval (Process #821)".
- **Same write for HR.** `PersonalDetailsService.write` is used by `PUT /admin/employees/:id/personal` and by the applier, so validation and the `EMPLOYEE.PERSONAL_DETAILS_UPDATED` row are identical. An HR edit between submit and approval bumps `Employee.version`, so the change request ends in CONFLICT and the engine alerts HR.
- **Masking.** GETs mask every number (`••••1234`). Full ID numbers come from `GET /me/personal/id-numbers`; full account numbers from the payroll-only unmask endpoints with a reason. Both are refused while working as someone else and audited. `describe` receives the viewer, so only a payroll admin in the inbox detail panel sees a proposed account number in full.
- **Bank changes.** The new account is active from the next open pay period; the replaced account gets `isActive=false` and `effectiveTo`. The outbox event `details.bankDetailsChanged` makes `DetailsNotifier` notify and email the employee ("Your bank details were changed").
- **Jobs.** `details.licenceExpiry` (daily 02:15) notifies the employee and HR 60 days before a licence expires, once per licence and expiry date (`LicenceExpiryNotice`).
- **Lookups.** `GET /lookups/:table` reads `ParameterValue` rows (tables in `LOOKUP_PARAMETER_TABLES`), seeded from the shared lists; `LookupService.assertValid` checks changed fields against the active rows.
- **Employee transactions.** Recurring transactions are read-only; an employee input for a code HR opened is an `EmployeeTransaction` on the FREETEXTMANEMP workflow (`FreeTextManEmpHandler`).

## Performance

`modules/performance` implements spec section 5.9. The scoring rules and status flows are pure helpers in `packages/shared/src/performance.ts`, so the web app shows the same live totals.

```
templates ──POST /contract-initiations──▶ performance.initiateContracts (pg-boss)
                                            └─▶ one DRAFT contract per employee (+ items), errors per employee
contracts: DRAFT ─▶ AGREED ─▶ ACTIVE ─▶ CLOSED ─▶ ARCHIVED
reviews:   DRAFT ─▶ OPEN ─▶ SELF_ASSESSMENT ─▶ REVIEWER_ASSESSMENT ─▶ MODERATION ─▶ COMPLETED (or CANCELLED)
scores ──▶ participant totals (Σ rating × weight / 100, normalised) ──▶ Review.totalActual
```

- **Lookups** (`PerformanceParameterService`): the eleven parameter tables are `ParameterValue` rows (`tableName` = the table name). `GET /lookups/parameters/:table` serves the active rows (`?parentId=` for KPIs of a KPA, competencies of an area); `/admin/parameters/:table` (HR_ADMIN) writes through the My Details `LookupService.createParameterRow/updateParameterRow` and adds the parent checks.
- **Templates** (`TemplateService`): items of kind KPA, KPI, COMPETENCY or OBJECTIVE, linked to a parameter of a matching table, with a weight and a target. `resolveItems` (in `performance-common.ts`, shared with contracts) checks ids, links and titles, and that each section (kind) adds up to 100 (422). Items change only while DRAFT; copies record `createdFromTemplateId`.
- **Initiation** (`InitiationService`): POST resolves the employees (HR companies, company rules, employees, positions), stores them in `ContractInitiation.filters`, and sends `performance.initiateContracts`. The job creates each contract in its own transaction; the unique key `(initiationId, employeeId)` makes it idempotent, and progress (`createdCount`, `failedCount`, `errors`) is written every 25 employees. Without a running queue (tests) `JobsService.send` runs it in-process before the POST answers.
- **Contracts** (`ContractService`): the Contracts and Archived Contracts grids, the detail with `allowedStatuses` and `canEdit`, PUT (fields while DRAFT, status moves by actor) and archive (HR).
- **Reviews** (`ReviewService`): the wizard creates one review per reviewee (`Review.employeeId`) with REVIEWEE and REVIEWER participants, objectives and the contract (Shared Template) or objectives only (Free Format). PUT only while DRAFT or OPEN; `POST /reviews/:id/status` moves the flow (HR; the reviewee closes the self-assessment); `POST /reviews/:id/scores` stores the caller's ratings and recomputes Total Actual. Results and the contract reviews grid are filtered lists of the same rows.
- **Notifications** (`ReviewNotifier`): Immediately on opening, Specific Date through the daily `performance.reviewNotify` job, once per review (`Review.notifiedAt`), in-app and by email (`performance-review`).
- **Scope** (`PerformanceAccess`): HR in their companies, auditors everywhere, employees their own (reviews once opened), reviewers their participations, managers their reports, and the assignee their contract. List queries use `contractWhere`/`reviewWhere`; details check the same rules and answer 403 (audited).
- **Seed** (`PerformanceSeedService`, also used by the test kit): the parameter tables, the "1–5" scale and one active template.

## Payslips and tax certificates

`modules/payslips` implements spec sections 5.5 and 5.6.

- **Reads** (`PayslipService`, `TaxCertificateService`): every endpoint first calls `assertNotRestricted(ctx, 'PAYSLIPS' | 'TAX_CERTIFICATES')` (403 + DENIED while working as someone else, by default), then `PayrollDocumentsService.assertCanView` (the employee or the acting-as employee, or PAYROLL_ADMIN of the employee's company). The services write `DATA_VIEW.PAYSLIP` / `EXPORT.PAYSLIP_PDF` and `DATA_VIEW.TAX_CERTIFICATE` / `EXPORT.TAX_CERTIFICATE_PDF` themselves, because the action depends on `?download=1`.
- **PDFs** are attachments owned by `Payslip` / `TaxCertificate`, created with `AttachmentService.storeGenerated` (before the transaction) and `recordGenerated` (inside it), and read with `readOwned`, which re-checks the sha256. No owner resolver is registered for them, so `GET /attachments/:id` never serves them.
- **Imports** (`PayslipImportService`, `TaxCertificateImportService`): `rawImportRows` turns CSV (grouped by `payslipRowsFromCsv` / `taxCertificateRowsFromCsv` from `packages/shared`) or JSON into rows; `check` validates each row (schema, employee in the importer's PAYROLL scope, pay period or tax year, employment, duplicates, existing current rows and `replace`). A dry run returns the results and a token (`confirmTokenFor`). A commit renders and stores the PDFs, then re-runs `check` in one transaction and writes the rows, the attachment rows, the audit rows and the in-app notifications.
- **Rendering**: `pdf/documents.ts` builds pdfmake definitions (`payslipDocument`, `taxCertificateDocument`, `reportDocument`) as pure functions; `PdfService.render` (Buffer) and `PdfService.stream` (reports) print them with the Roboto font embedded from pdfmake's virtual file system.

## Dashboard

`modules/dashboard` implements spec section 5.1: `GET/PUT /dashboard/layout` (per signed-in user, validated against `DASHBOARD_WIDGETS`, normalised on read), `GET /dashboard/summary` (welcome banner, latest payslip and certificate, which come back null with a `restricted` flag while working as someone else, submitted counts, On Leave Today from `LeaveCalendarService.onLeaveTodayCount`, the birthday count) and `GET /birthdays/upcoming` (`BirthdayService`, day and month only, from the pure helpers in `packages/shared/src/birthdays.ts`).

## Reports

`modules/reports` implements spec section 5.7. A report is a `ReportDefinition`:

```ts
interface ReportDefinition<C extends ReportCode> {
  code: C;
  group: ReportGroup;
  title: string;
  description: string;
  params: ZodSchema; // REPORT_PARAM_SCHEMAS[code]
  paramFields: ReportParamField[]; // the serialisable parameter panel
  requiredRoles: Role[];
  columns: ReportColumn[];
  run(rc: ReportRunContext, params): AsyncIterable<ReportRow>;
}
```

The metadata (group, title, roles, columns, parameter panel and the Zod params schema) lives in `packages/shared/src/api/reports.ts` (`REPORT_CATALOGUE`, `REPORT_PARAM_SCHEMAS`), so the web app renders the same columns and validates the same params. The API adds `run` with `defineReport(code, run)`.

How a run works (`ReportsService.run`):

1. The registry finds the report (404) and checks `requiredRoles` (403, audited DENIED).
2. The params are validated against the report's schema (422 on `params.<name>`).
3. `ReportScopeService.population` turns the caller's accepted roles into a population (auditors and system admins: everyone; HR and Payroll: their companies; managers: themselves and their reports; employees: themselves). Selected `employeeIds` outside it are 403. `rc.employees` is the population narrowed by the params' company rules, employees and "include terminated".
4. `EXPORT.REPORT` is audited with the format and the params before the first row is read.
5. `run` is an async generator over cursor-paginated queries (`batches` in `report-helpers.ts`, 500 rows per round trip). JSON reads one page (`pageOfRows`); CSV (`csvStream`) and Excel (`xlsxStream`, exceljs `WorkbookWriter`) stream every row with chunked encoding; PDF reads at most `REPORT_PDF_ROW_LIMIT` rows into `reportDocument`. Columns flagged `payData` are blanked for a system admin who is not also HR or Payroll.

### Adding a report

1. Add the code, its params schema and its catalogue entry in `packages/shared/src/api/reports.ts`:

```ts
// REPORT_PARAM_SCHEMAS
OVERTIME_HOURS: peopleParams({ claimGroupIds: IdListSchema(100).optional() }),

// REPORT_CATALOGUE
OVERTIME_HOURS: {
  code: 'OVERTIME_HOURS',
  group: 'WORKFLOW',
  title: 'Overtime Hours',
  description: 'Overtime hours claimed per employee.',
  requiredRoles: SELF_TEAM_ADMIN,
  paramFields: [P.range('Line dates between'), ...PEOPLE, P.claimGroups],
  columns: columns(['employeeCode', 'Employee Code'], ['employeeName', 'Employee Name'], ['hours', 'Hours', 'decimal']),
},
```

2. Implement `run` in the group's file under `modules/reports/definitions/` and export it; the registry picks up every export and refuses to start when a catalogue code has no definition:

```ts
export const overtimeHours = defineReport('OVERTIME_HOURS', async function* (rc, params) {
  for await (const batch of employeeBatches(rc.prisma, rc.employees, rc.batchSize)) {
    const lines = await rc.prisma.claimLine.findMany({
      where: {
        deletedAt: null,
        claimType: { inputMode: 'HOURS' },
        claim: { employeeId: { in: batch.map((e) => e.id) }, status: { not: 'DRAFT' } },
        ...(params.from || params.to ? { date: dateRange(params.from, params.to) } : {}),
      },
      select: { quantity: true, claim: { select: { employeeId: true } } },
    });
    for (const e of batch) {
      const own = lines.filter((l) => l.claim.employeeId === e.id);
      if (own.length === 0) continue;
      const hours = own.reduce((t, l) => t.plus(l.quantity ?? 0), new Prisma.Decimal(0));
      yield { ...employeeCells(e), hours: dec4(hours) };
    }
  }
});
```

3. Always filter people through `rc.employees` (or `employee: rc.employees` on child tables), read in batches with Prisma cursor pagination, return decimals as strings, dates as `YYYY-MM-DD` and timestamps as ISO (`day`, `ts`, `dec4`, `money`), and mark payslip amounts `payData`. Add the code to the report tests; `reports.int.test.ts` runs every catalogue code as JSON and CSV.

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
- `authz.ts` holds the authorisation-matrix runner; `test/int/authz-matrix.int.test.ts` (Phase 2), `test/int/authz-matrix-workflow.int.test.ts` (Phase 3), `test/int/authz-matrix-leave.int.test.ts` (Phase 4), `test/int/authz-matrix-claims.int.test.ts` (Phase 5), `test/int/authz-matrix-details.int.test.ts` (Phase 6), `test/int/authz-matrix-payroll.int.test.ts` (Phase 7) and `test/int/authz-matrix-performance.int.test.ts` (Phase 8) list the cases. Add new endpoints to a matrix file for your phase.
- `leave.ts` holds the leave kit: `setup(org)` seeds the leave reference data and holidays (idempotent) and the two-step definitions of the leave workflow types on the fixture company rule; `accrue(employeeIds, asOf?)`, `monday(days)` and `range(from, units)` for future working-day ranges, `upload(agent)` and `submit(agent, body)`.
- `claims.ts` holds the claims kit: `setup(org)` seeds the claim reference data (idempotent) and the GROUPEDCLAIM and CLAIMS definitions on the fixture company rule; `group()` and `type(groupId, companyRuleId, spec)` create fresh groups and types whose caps sit on the fixture company rule (so they never reach other tests); `setHourlyRate`, `upload`, `create`, `submit` and `approve`.
- `details.ts` holds the My Details kit: `setup(org)` seeds the workflow types, lookups and banks (idempotent) and two-step definitions of BASICINF, BANKDET, DRIVERSLICENSE, BENEFICIARY and FREETEXTMANEMP on the fixture company rule; `upload(agent)`, `approve(agent, processId)` / `approveAll`, `account(person, number)` for a bank account set up directly, and `submitted(res)`.
- `performance.ts` holds the performance kit: `setup()` seeds the parameter tables, the "1–5" scale and the seed template (idempotent); `template(hr)` creates an ACTIVE template with a unique name (KPA 60/40, competency 100); `initiate(hr, templateId, employeeIds)`, `contractOf(employeeId, templateId)`, `sharedReview(...)`, `freeReview(...)`, `move(agent, reviewId, status)` and `score(agent, review, ratings)`.
- `payroll.ts` holds the payroll kit: `periods(org, n)` for pay periods of the last n months, `row(employeeCode, periodEnd)`, `importPayslips(agent, rows, replace?)` and `importCertificates(agent, rows)` (dry run then commit), `upload(agent)`, `actAs(agent, employeeId)`, and `bufferParser` (binary bodies with their chunk count, for the streaming checks).
- `workflow.ts` holds the workflow kit: `FakeSubjectHandler` (records every hook call and describes subjects from memory), `kit.useFakeHandler(type)` (swaps it in for a real type and restores the original at the end), `kit.definition(...)` for a definition on a fixture company rule (which outranks the seeded defaults), `kit.start(...)`, `kit.payPeriod(org)`, `kit.publish()` (delivers the outbox and waits for email) and `contextFor(person)`.
- `t.mail.outbox` / `t.mail.flush()` read email sent in memory mode; `fake-oidc.ts` is a minimal OpenID provider.
