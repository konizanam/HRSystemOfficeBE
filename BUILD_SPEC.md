# PeopleHub ESS: Build Specification for Claude Code

> **How to use this file**
> 1. Create an empty folder, put this file in it as `BUILD_SPEC.md`, and open Claude Code there.
> 2. Paste this prompt:
>    *"Read BUILD_SPEC.md in full. Build the application it describes, phase by phase (section 17). After each phase, run the phase's acceptance checks, fix every failure, commit, and then continue. Do not skip, stub, or 'TODO' anything that the spec marks as required. When the spec says ASSUMPTION, implement it as written and list it in `docs/ASSUMPTIONS.md`."*
>
> This spec was written by mapping a live **Sage 300 People ESS** (Employee Self-Service) tenant, version 26.3.3.2. I walked every menu, form, list, inbox view and approval-history screen, and recorded the backend API calls and their response field names. Section 1 lists what was observed. Anything I could not observe is marked **ASSUMPTION**.

---

## 0. Non-negotiables (read first)

1. **Language and runtime:** TypeScript (`strict: true`) end to end. Node.js 22 LTS. No `any` unless it is wrapped in a narrowing function.
2. **Complete audit trail:** every state change, every approval action, every login, every view of sensitive data, and every export writes an **append-only, hash-chained** audit record *in the same database transaction* as the change (section 9). If the audit write fails, the business write fails.
3. **No hard deletes** of business data. Use soft delete (`deletedAt`) or a status change. Audit rows can never be updated or deleted, and this is enforced by a DB trigger and DB grants.
4. **Server is the source of truth** for every calculation: leave units, balances, claim totals, caps and reference numbers. The client only displays.
5. **Workflow-gated master data:** employees cannot change personal, bank, licence, family or beneficiary data directly. Each change creates a `ChangeRequest` that is applied only after the final approval (section 7.6).
6. **Data scoping:** every query is scoped by the caller's security context (section 4). Unit tests must prove that one employee cannot read another employee's data.
7. **Encryption at rest** for ID numbers, passport numbers, tax numbers, bank account numbers and licence numbers (AES-256-GCM, section 10.3). Store a masked `last4` copy for display.
8. **Optimistic concurrency:** every mutable aggregate has `version Int`. Updates must send the version they read. A mismatch returns HTTP 409.
9. **Idempotent submits:** every `POST .../submit` accepts an `Idempotency-Key` header. Replays return the original result.
10. Everything ships with tests (section 16). CI must pass before a phase counts as done.

---

## 1. What was observed in the source system

### 1.1 Global chrome
- Top bar: product logo → Dashboard; **Inbox**; **"Working as {employee}"** picker; **Profile settings** menu.
- The "Working as" picker is a grid with columns Name, Known As, Emp. Code, Company Rule and Status, each with a column filter. It lists the user plus their direct reports. Choosing someone switches the entire UI to act on that employee's behalf (manager delegation).
- Profile settings menu: **Change Password**, **Out of office**, **Setup mobile**, **Help** (external link), **Sign Out**.
- Footer: app version (e.g. `26.3.3.2`) and the signed-in username.
- Sign-in page fields: Username, Password, and **Profile** (`Local` | `OAuth`). There is also a "Reset Password" link.
- Idle session timeout with a countdown warning. The server returns `sessionTimeout` and `sessionCountDown`, and the client sends a POST heartbeat (`security/updateActivity`).

### 1.2 Main navigation (exact labels → routes)
> In the new app these items appear in a **left side menu** with collapsible groups, not Sage's top dropdown bar. See section 13.
| Menu | Item | Route |
|---|---|---|
| Home | | `/dashboard` |
| Leave | Apply | `/leave/apply` |
| | Leave in Lieu ▸ (Request, Allocation) | `/leave/in-lieu` |
| | Balances | `/leave/balances` |
| | History | `/leave/history` |
| Claims | Submit | `/claims` |
| | My Expense Claims | `/claims/transactions` |
| | Balances | `/claims/balances` |
| My Details | Personal Details | `/details/personal` |
| | Bank Details | `/details/bank` |
| | Drivers Licenses | `/details/drivers-licences` |
| | Family Details | `/details/family` |
| | Beneficiaries | `/details/beneficiaries` |
| | Employee Transactions ▸ | `/details/transactions` |
| Payslips | | `/payslips` |
| Reports | | `/reports` |
| Free Text Workflow | | `/free-text` |
| Performance | Create Review | `/performance/reviews/new` |
| | Edit Review | `/performance/reviews` |
| | Review Results | `/performance/results` |
| | Performance Templates | `/performance/templates` |
| | Contract Initiation | `/performance/contract-initiations` |
| | Contracts | `/performance/contracts` |
| | Archived Contracts | `/performance/contracts/archived` |
| | Reviews | `/performance/contract-reviews` |
| My Tax Certificates | | `/tax-certificates` |
| Inbox | | `/inbox/...` |
| Profile | Out of office | `/profile/out-of-office` |
| | Change password | `/profile/password` |
| | Setup mobile | `/profile/mobile` |
| *(new)* Admin | see section 12.10 | `/admin/...` |
| *(new)* Audit | see section 9.7 | `/audit` |

### 1.3 Workflow types (exact codes observed)
```
LEAVE            Leave Workflow Process
BASICINF         Basic Information Workflow Process
BANKDET          Bank Detail Workflow Process
FREETEXT         Free Text Workflow Process
FREETEXTMANEMP   Free Text with Mandatory Employee
CLAIMS           Claims Workflow Process
CANCELLEAVE      Cancel Leave Process
BENEFICIARY      Retirement Fund Beneficiary
TRAINING         Training
QUALIFICATION    Qualification
JOBREQUISITION   Job Requisition
GROUPEDCLAIM     Grouped Claim
CHECKLISTITEM    Checklist Item
DRIVERSLICENSE   Drivers License
CREDITLVEALLOC   Leave in Lieu Allocation
CREDITLVEREQ     Leave in Lieu Request
```
v1 implements screens for every type except TRAINING, QUALIFICATION, JOBREQUISITION and CHECKLISTITEM. Those four are seeded, and the engine supports them, but they have no UI yet (Phase 9 backlog).

### 1.4 Observed statuses
- Leave or workflow item: `In Progress`, `Approved, Pending Process`, `Processed` (shown as "Completed"), `Declined`, `Cancelled`.
- Claims filter: `Saved`, `In Progress`, `Pending Processing`, `Processed`, `Cancelled / Declined`.

### 1.5 Observed approval history (reproduce this format exactly)
```
Approval history - {First} {Last} - {EmployeeCode}
Current Status Of Request
This {LeaveType} Request has been Approved and is waiting to be Processed.
History Of Request
CREATED: New {LeaveType} Request on {dd MMM yyyy} by Applicant {EmployeeCode} - {Title} {Initials} {Surname}
Step 1
Approved by {Title} {Initials} {Surname} on {dd MMM yyyy}
Remaining Approvers
Step 2
{Title} {Initials} {Surname} (Mandatory)
Workflow Process ID: {processId}
```

### 1.6 Observed leave reference number format
`E000077-T0006-N00005` = `E` + employee entity code (6 digits) + `-T` + leave type id (4 digits) + `-N` + a running sequence per (employee, leave type) (5 digits).

### 1.7 Observed leave arithmetic (use as test fixtures)
- Annual leave entitlement is 20 days per cycle. The monthly accrual is `20/12 = 1.6667` (rounded to 4 dp).
- Balance B/F `2.1691` + accrued `1.6667` − taken `0` = **C/F `3.8358`**.
- **Actual Available = ledger balance − pending units** (pending = submitted and not yet processed). Study leave check: entitlement 12, pending 9, actual available 3. At the moment the 5-day request was submitted, 4 days were already pending, so the request showed "Days available 8".
- Units use 4 decimal places. Half days are allowed (`0.5`, `1.5` were observed).
- Balance-by-definition grid columns: *Leave Definition, Entitlement, Balance Brought Forward, Accrued This Period, Taken This Period, Balance Carried Forward, Planned, Pending, Leave Cycle End Date*. There is one row per bucket (for example "Carry Forward Leave" and "Annual Leave", each with its own cycle end date) plus a Total row.

---

## 2. Tech stack (use exactly this)

| Concern | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| API | NestJS 11 (Fastify adapter) |
| ORM / DB | Prisma 6 + PostgreSQL 16 |
| Validation | Zod schemas in `packages/shared`, used by both API (via `nestjs-zod`) and web |
| API docs | OpenAPI 3.1 generated from the Zod schemas at `/api/docs` |
| Auth | Session cookies (httpOnly, Secure, SameSite=Lax) stored in DB; argon2id passwords; OIDC via `openid-client`; CSRF double-submit token; optional TOTP MFA |
| Jobs / scheduler | `pg-boss` (Postgres-backed queue) |
| Files | `StorageService` interface with `LocalDiskStorage` and `S3Storage` implementations |
| PDF | `pdfmake` (payslips, tax certificates, reports) |
| Excel / CSV | `exceljs` |
| Email | `nodemailer` (SMTP), with templates in `apps/api/src/notifications/templates` |
| Logging | `pino` (JSON) with request id; never log PII or secrets |
| Web | React 19 + Vite + TypeScript, TanStack Router, TanStack Query, react-hook-form + Zod, Tailwind CSS + shadcn/ui, date-fns (+ date-fns-tz) |
| Tests | Vitest (unit), Supertest + Testcontainers Postgres (API integration), Playwright (e2e) |
| Quality | ESLint (typescript-eslint strict), Prettier, `tsc --noEmit` in CI |
| Containers | `docker-compose.yml` with postgres, mailpit, minio (S3), api, web |

Pin exact versions in every `package.json`, using the latest stable versions at build time.

Repository layout:
```
/apps/api        NestJS app (src/modules/*, prisma/, test/)
/apps/web        React app (src/routes/*, src/features/*, src/components/*)
/packages/shared Zod schemas, enums, DTO types, date + units helpers, reference-number formatter
/docs            ASSUMPTIONS.md, ARCHITECTURE.md, AUDIT.md, RUNBOOK.md
/.github/workflows/ci.yml
```

Timezone: business dates are **`Africa/Windhoek`**. Store leave and holiday dates as `DATE` and timestamps as `timestamptz`. Display dates as `dd-MMM-yyyy` (for example `24-Sep-2026`) in grids and `dd MMM yyyy` in inbox cards, matching the source. Default currency is `NAD`.

---

## 3. Domain glossary
- **Employee:** HR record. **User:** login identity, linked 0..1 to an Employee.
- **Company / Company Rule:** a legal entity and its pay group (for example `MNA_STAFF`). Policies, pay periods and workflow definitions can vary by company rule.
- **Reports To:** the manager hierarchy, used for approver resolution and the "Working as" list.
- **Workflow Process:** one running approval instance (has an integer ID shown to users).
- **Step:** an ordered approval stage. It can be Mandatory or Optional.
- **Pending Process:** fully approved but not yet posted by payroll. A Payroll Admin "processes" it, which posts it to the ledger and links it to a pay period.
- **Leave Definition / bucket:** an entitlement bucket with its own cycle (Annual, Carry Forward, and so on).
- **Grouped Claim:** a claim header (group such as "Overtime Claims" or "Other Claims") with lines of claim types.

---

## 4. Roles, security context and "Working as"

### 4.1 Roles (`Role` enum, many per user)
| Role | Can do |
|---|---|
| `EMPLOYEE` | Self-service for own record |
| `MANAGER` | Everything EMPLOYEE can, plus act "Working as" any **direct or indirect** report (ASSUMPTION: the source showed direct reports; make the depth a setting `workingAs.maxDepth`, default 1), approve when resolved as approver, and use team views (calendar "Reports To", Employees on Leave) |
| `HR_ADMIN` | Read and write all employees in their companies; configure leave types, policies, claim types, workflows, holidays and free-text types; override leave units; post leave adjustments |
| `PAYROLL_ADMIN` | Process "Pending Process" items, manage pay periods, publish payslips and tax certificates, adjust claim balances |
| `SYSTEM_ADMIN` | Users, roles, OIDC, settings. **No** access to payslip amounts or bank numbers unless also HR or Payroll |
| `AUDITOR` | Read-only access to the audit log, reports and approval histories. Cannot change anything |

### 4.2 Security context (resolved per request)
```ts
interface SecurityContext {
  userId: string; username: string; roles: Role[];
  selfEmployeeId: number | null;
  actingAsEmployeeId: number;        // = selfEmployeeId unless "Working as" someone else
  companyIds: number[];              // admin scope
  sessionId: string; requestId: string; ip: string; userAgent: string;
}
```
- `PUT /api/v1/session/acting-as { employeeId }` validates that the target is self, a report within `maxDepth`, or (for HR_ADMIN) anyone in scope. It stores the choice on the `Session` row and writes audit `SECURITY.ACTING_AS_CHANGED`.
- Every write records both the **actor** (`userId`) and the **subject** (`actingAsEmployeeId`). The UI shows a persistent banner "Working as {name}" when they differ.
- Things that are **never** allowed while working as someone else: viewing their payslips, tax certificates, bank account numbers or ID numbers; and changing their password or out-of-office settings. Return 403 and write a `DENIED` audit row. (ASSUMPTION: the safe default. Make it configurable per feature in `SystemSetting`.)
- Approvers can see the request content they must approve, including attachments.

### 4.3 Authentication
- **Local:** username + password (argon2id). Lock the account for 15 minutes after 5 failures. Keep a password history of 5. Minimum policy: 10 characters with 3 of 4 character classes. A "must change password" flag forces the change on next login. Reset by emailed single-use token (30 minutes, stored hashed).
- **OAuth/OIDC:** the sign-in "Profile" dropdown selects `Local` or `OAuth`. OIDC maps `sub` to `User.externalSubject`. Auto-provisioning is off by default.
- Sessions: idle timeout `session.idleMinutes` (default 20) with a client countdown modal at `session.warnSeconds` (default 60). Absolute lifetime is 12 hours. The heartbeat is `POST /api/v1/session/activity`.
- Audit: `AUTH.LOGIN_SUCCESS`, `AUTH.LOGIN_FAILURE` (username attempted, never the password), `AUTH.LOGOUT`, `AUTH.SESSION_TIMEOUT`, `AUTH.PASSWORD_CHANGED`, `AUTH.PASSWORD_RESET_REQUESTED`, `AUTH.ACCOUNT_LOCKED`, `AUTH.MFA_ENROLLED`.
- Setup mobile: shows a QR code containing the server URL plus a short-lived pairing token (ASSUMPTION: the page was not observed). The token is audited.

---

## 5. Module specifications

### 5.1 Dashboard (`/dashboard`)
- Welcome banner: photo, "Welcome back, {Title} {First} {Last}", **View Profile** button, and the company logo on the right.
- Quick actions: **View Inbox**, **View Payslips**, **+ Apply Leave**. **Edit Widgets** opens a layout editor (show/hide and reorder) persisted per user in `DashboardLayout`.
- Widgets:
  1. **Latest Payslip:** period end date and a "View Payslip" button.
  2. **My Tax Certificates:** latest certificate, or "No tax certificates available".
  3. **Employees on Leave:** count of reports on approved or processed leave today, labelled "On Leave Today". Only shown to managers.
  4. **Leave Calendar:** month view (Mon–Sun) with a radio toggle **Reports To / Self**, Previous/Next, and month/year pickers. Days are coloured by leave type (`LeaveType.colour`), today is underlined, public holidays are marked, and a legend sits below. Buttons: **Export** (CSV/Excel of the visible range, audited) and **+ Apply Leave**.
  5. **My Submitted Items:** count tiles for Leave and Claims (in-flight items).
  6. **Upcoming Birthdays:** count within the next 30 days and a "View upcoming birthdays" modal listing name and day/month only, never the year. Scoped to the same company rule. Employees can opt out (ASSUMPTION).

### 5.2 Leave

#### 5.2.1 Apply (`/leave/apply`)
Form fields, in observed order:
| Field | Rules |
|---|---|
| The application is for* | Combobox. Defaults to the acting-as employee. Lists self plus permitted reports |
| I am applying for* | Leave type list, showing only active types the employee has a policy for |
| Apply For Leave*: Start, End | Date pickers. End ≥ Start |
| Day portion | For each of start and end: `Full day` / `Morning (AM)` / `Afternoon (PM)` (`ampmOptionType`). Single-day requests offer Full/AM/PM |
| I am taking: {n} Days | Read-only, calculated by the server (`POST /leave/calculate`). Editable only by HR_ADMIN with `overrideUnits=true` (audited with the reason) |
| The reason for taking leave is | Leave reason list for that type. Required if `LeaveType.mandatoryReason` |
| Any comments? | Text, up to 1000 characters |
| Attachments | Drag-and-drop, multiple files. pdf/png/jpg/jpeg/docx, max 10 MB each, virus-scan hook. Required when `units > LeaveType.requiresAttachmentAfterDays` |
| Note Submitted | Checkbox (for example a sick note will be submitted) → `noteSubmitted` |
| Cancel / Submit | Submit is disabled until the form is valid |

**Right-hand balance panel** (updates live): employee name, leave type badge, FROM/TO, **Available**, **To be Deducted**, **Remaining** (= Available − To be Deducted). All shown to 4 dp with the label "Days".

**Server-side calculation `calculateUnits(employee, type, from, to, startPortion, endPortion)`:**
1. Iterate the dates. Skip weekends if `excludeWeekends`. Skip public holidays for the employee's company if `excludePublicHolidays`. (ASSUMPTION: the working-week pattern is Mon–Fri by default. Add `Employee.workPattern` JSON for shift workers later.)
2. Each counted day = 1. The start day = 0.5 if portion is AM or PM. The end day = 0.5 if portion is AM or PM. If start = end, the day is 0.5 or 1 based on the start portion.
3. Return the per-day breakdown (`LeaveApplicationDay[]`) and the total, rounded to 4 dp.

**Validation on submit** (each failure returns 422 with a field-level message):
- The employee is ACTIVE, and the dates are within employment.
- No overlap with another non-cancelled, non-declined application for the same employee (any type), compared at half-day granularity.
- `units > 0`.
- Balance: `actualAvailable − units ≥ −policy.maxNegative`, unless `LeaveType.allowNegative`.
- Backdating: `from ≥ today − setting leave.maxBackdateDays` (default 30) unless HR_ADMIN.
- Reason and attachment rules as above.

**On submit (single DB transaction):**
1. Allocate a reference number (section 8.1).
2. Insert `LeaveApplication` (status `IN_PROGRESS`), its days, and its bucket **allocations**: consume the bucket with the earliest `cycleEndDate` first (Carry Forward before current Annual). Allocations are a reservation and post nothing to the ledger yet.
3. Start the `LEAVE` workflow (section 7).
4. Write audit `LEAVE.SUBMITTED` (with the after-snapshot) and `WORKFLOW.CREATED`.
5. Notify the first-step approvers.

#### 5.2.2 Balances (`/leave/balances`)
- One card per leave type: name, **Actual Available** (days), **Pending** (days), and a "+" to expand. Respect `hideUnitsAvailableForESS` (hide the number) and `hideZeroUnitsAvailableForESS` (hide the card when 0).
- The expanded section shows "{Type}, Period Ending: {dd-MMM-yyyy}" and the bucket grid described in section 1.7, with a Total row.
- Formulas per bucket:
  - `BF` = sum of the ledger before the current pay period start.
  - `Accrued This Period` = sum of ACCRUAL in the period.
  - `Taken This Period` = −sum of TAKEN in the period.
  - `CF` = BF + accrued − taken + adjustments in the period.
  - `Pending` = allocations of IN_PROGRESS + APPROVED_PENDING_PROCESS applications.
  - `Planned` = allocations of approved applications whose dates are in the future (ASSUMPTION).
  - Actual Available = CF − Pending.

#### 5.2.3 History (`/leave/history`)
Two grids: **Completed Leave Items** and **Leave Items In Progress**. Columns: Leave Type, Reference Number, From Date, To Date, Units Taken, Leave reason, Note Received, Takeon Transaction, Date Submitted, Date Approved, Final Approver, and an action **Cancel**. Rows are sorted by From Date descending. Clicking a row opens the leave detail modal with the approval history.

**Cancel:**
- If the item is `IN_PROGRESS` and no step has been actioned yet: withdraw immediately (status `CANCELLED`, release allocations, audit `LEAVE.WITHDRAWN`).
- Otherwise: create a **CANCELLEAVE** application, a new `LeaveApplication` with `cancelsApplicationId`, the same dates, and its own reference number and workflow. When it is approved and processed, post `CANCELLATION_REVERSAL` ledger entries that mirror the original TAKEN entries, and set the original to `CANCELLED`. If the original was not yet processed, approving the cancellation simply releases the allocations.
- Only one open cancellation per application is allowed.

#### 5.2.4 Leave in Lieu (`/leave/in-lieu`)
Two sub-items:
- **Request (`CREDITLVEREQ`):** the employee asks for credit for days worked (weekend or public holiday). Fields: date(s) worked, units, reason, attachment.
- **Allocation (`CREDITLVEALLOC`):** a manager or HR grants credit to an employee.

On final approval and processing, post a `CREDIT_ALLOCATION` ledger entry to the credit leave type (`LeaveType.isCreditLeave = true`), with expiry from `LeavePolicy.creditExpiryDays` (the source exposes `daysToExpiry`). A nightly job posts `FORFEIT` entries for expired credit. (ASSUMPTION: the field-level layout was not observed.)

#### 5.2.5 Accrual and cycle jobs (pg-boss, idempotent per period)
- `leave.accrue` runs on each pay period close (or monthly on the 1st at 01:00 Africa/Windhoek). For each active employee and policy where `accrualMethod = MONTHLY_PRO_RATA`, post `ACCRUAL = round4(entitlementDaysPerCycle / 12)`. Pro-rate the first and last month by calendar days employed. A unique constraint `(entitlementId, entryType, effectiveDate)` prevents double posting.
- `leave.cycleRollover` runs at a bucket's `cycleEndDate`. It moves `min(balance, maxCarryForward)` into a new "Carry Forward Leave" bucket (`CARRY_FORWARD_OUT` / `CARRY_FORWARD_IN`), forfeits the excess (`FORFEIT`), sets the carry-forward expiry, and opens the next cycle bucket.
- `UPFRONT` policies post the full entitlement at cycle start.
- Every job run writes `SYSTEM.JOB_RUN` audit rows with counts.

### 5.3 Claims

#### 5.3.1 Submit (`/claims`)
- Tiles per **claim group**, for example "Overtime Claims" and "Other Claims" (keep the source's misspelling "Other Calims" only as seed data that HR can fix). Each tile shows **Submitted n**, **Saved n** and an **Apply** button.
- A tile only shows when `employeeCanStartWorkflow(GROUPEDCLAIM, groupId)` is true. That depends on company rule eligibility and on an active workflow definition existing.
- The **Saved Claims** list has Filter and "Sort by" options (Applicant, Type, Date Created) and "Select saved claim" to resume a draft.
- Claim editor: a header (applicant, group, description) and a **lines grid** (claim type, date, start/end time for overtime, quantity, rate, amount, description, attachment per line). Show a live total. Buttons: **Save** (status `DRAFT` = "Saved"), **Submit**, **Cancel**.
- Per claim type `inputMode`:
  - `HOURS`: quantity is hours, `amount = hours × rate`, where rate comes from `ClaimType.rate` or `Employee.hourlyRate × multiplier` (ASSUMPTION: OT 1.5/2.0 multipliers are taken from the code).
  - `KILOMETRES`: `amount = km × ratePerKm`.
  - `QUANTITY`: `amount = qty × rate`.
  - `AMOUNT`: the user enters the amount.
- **Caps** (`ClaimCap`) are checked per cycle: `NO_CAP`, `WARN` (submit allowed and the warning is stored in `ignoreWarnings`), or `BLOCK` (422). Pro-rata caps use months employed in the cycle divided by the cycle length.
- `attachmentMandatory` is checked per group and per type.
- Submit starts the `GROUPEDCLAIM` workflow (or `CLAIMS` for single-type claims). Payroll "process" links the claim to a pay period and sets it to `PROCESSED`.

Seed claim groups and types exactly as observed:
```
Group MSN_OT  "Overtime Claims"   | Group OT     "Overtime Claims"
Group MSN_OTHER "Other Claims"    | Group OTHER  "Other Calims"
Group REBATECLMS "Rebate Claims"
Types: OT1_5 Overtime 1.5 · OT2_0 Overtime 2.0 · NSHIFT Night Shift Allowance ·
       STANDBY Standby Allowance · STANDBY_WK Standby Weekly (MHC only) ·
       CALL_OUT Call Out Fee · S&T S&T Allowance · KM_CLM Kilometre Claims
```
(Put OT1_5, OT2_0, NSHIFT, STANDBY and STANDBY_WK under the overtime groups, and CALL_OUT, S&T and KM_CLM under the other groups. ASSUMPTION: this mapping is inferred from the balances page.)

#### 5.3.2 My Expense Claims (`/claims/transactions`)
Filters: Claim Type (All or a group), Description (contains), Status (`All, Saved, In Progress, Pending Processing, Processed, Cancelled / Declined`), From Date, To Date. Grid columns: reference, group, description, submitted date, total, status, final approver, and actions (View, Cancel, Resume if saved). Export is audited.

#### 5.3.3 Claim balances (`/claims/balances`)
Columns exactly as observed: *Claim Type, Cycle Start Date, Cycle End Date, Amount Capping Limit, Pro Rata Capping Limit, Pending Amount Claimed, Amount Claimed, Balance Adjustment Amount, Amount Available, Quantity Capping Limit, Pending Quantity Claimed, Quantity Claimed, Balance Adjustment Quantity, Quantity Available, Capping Applied* (`No Cap` / `Warn` / `Block`).

### 5.4 My Details (all changes go through workflows; see section 7.6)

#### 5.4.1 Personal Details (`/details/personal`, workflow `BASICINF`)
Sections and fields (observed):
- **Identity:**
  - Title: `Adv, Dr, Judge, Miss, Mr, Mrs, Ms, Prof., Pr, Rabbi, Rev, Sir, His Royal Highness`.
  - Initials, Surname, First Name, Entity Code (read-only), Second Name, Other Names, Known As, Maiden Name, Identity Number, Date of Birth (shows "Age: n"), Identity Type.
  - Country of Birth, Passport Number, Passport Country, Tax Number, Nationality Country, Birth Certificate Number, City Of Birth. Countries come from the ISO-3166 list; seed the full list.
  - Home Language: `Afrikaans, English, French, German, Greek, Italian, Ndebele, Portuguese, Sepedi, Sotho, Spanish, Swati, Swahili, Tswana, Tsonga, Venda, Xhosa, Zulu, Bengali, Cantonese, Gujarati, Hindi, Indonesian, Japanese, Javanese, Korean, Malay, Mandarin, Marathi, Sundanese, Tamil, Telugu, Arabic`. Also add `Oshiwambo, Otjiherero, Rukwangali, Silozi, Khoekhoegowab, Setswana` as ASSUMPTION, since the tenant is Namibian. HR can edit the list.
  - Gender: `Male, Female`.
  - Marital Status: `Single, Married in Community, Married out of Community, Divorced, Widowed, Permanently Separated, Life Partner, Married`.
  - Blood Group: `A Positive, A Negative, AB Positive, AB Negative, B Positive, B Negative, O Positive, O Negative` (fix the source's typo "O Postive").
  - Religion: `Atheist, Buddhism, Catholic, Hinduism, Chinese Folk Religion, Islam, Christianity, Judaism, Taoism`.
- **Physical Address:** Unit Number, Block, Complex, Level/Floor, Street Number, Street/Farm Name, Suburb/District, City/Town, Postal Code, Country, Province, District, Care of Name.
- **Postal Address:** "Postal Address Same As [Physical Address]". Address Service Type: `P O Box, Private Bag, Postnet Suite, Street, Other Service Type`. Postal Address Number, Suburb/District, City/Town, Postal Code, Country, Province, District, Care of Name.
- **Work Address:** "Work Address Same As [Physical Address | Postal Address]", plus the same fields as Physical.
- **Correspondence Address:** select `None… | Physical | Postal | Work`.
- **Contact Details:** Cell Number, E-Mail Address, Fax Number, Home Number, Work Number, plus **Other Contact Details** (repeatable rows: type = Home/Work/Fax/Cell/E-Mail, value).
- **Upload supporting documentation:** Attach (drag and drop).
- Buttons: **Submit**, **Cancel**.
- Validation: email RFC 5322 (basic); phone in E.164 or a local format normalised to E.164 with default country NA (+264); DOB not in the future and age ≥ 15; Namibian ID is 11 digits starting with YYMMDD that must match the DOB (ASSUMPTION; warn, don't block).
- Only fields that changed are put in the ChangeRequest diff. If nothing changed, show "No changes to submit".

#### 5.4.2 Bank Details (`/details/bank`, workflow `BANKDET`)
- "Bank Details for: {name}".
- Fields: Type of Account (`Current Account, Loan Account, Transmission Account, Savings Account`), Account Holder Name, Bank Name, Account Number, Account Holder Relationship (`Own, Joint, Third Party`), Branch (list filtered by bank, with branch code), Currency.
- Seed banks exactly as observed (40 entries, starting with ABN Amro Bank, ABSA, African Bank, Bank of Athens, Bank of Windhoek … Bank BIC, Bank Atlantico). Seed the Bank Windhoek and FNB Namibia branch lists that were observed (Universal Code, Main Branch, Exclusive Banking, Oshikango, Ausspanplatz, Swakopmund, Katutura, … Henties Bay). The branch code values were not visible, so mark them ASSUMPTION and make them editable by HR.
- Existing accounts grid: Account Number (masked `••••1234`), Account Holder Name, Account Holder Relationship, Type of Account, Bank Name, Branch, Currency.
- **Third Party** relationship requires a supporting document. A bank change always requires a supporting document (ASSUMPTION: the safe default).
- Viewing the unmasked number is only allowed for PAYROLL_ADMIN, needs a reason, and writes audit `DATA_VIEW.BANK_ACCOUNT_UNMASKED`.
- On approval and apply: the old account is set `isActive=false` with `effectiveTo`, and the new one becomes active from the next open pay period. Email the employee: "Your bank details were changed". This is anti-fraud and is sent even when someone else submitted the change.

#### 5.4.3 Drivers Licences (`/details/drivers-licences`, workflow `DRIVERSLICENSE`)
- A list with "Please select a Drivers License" when empty, and Add/Edit.
- Fields (ASSUMPTION, not observed beyond the list): Licence Number, Code/Class (`A1, A, B, C1, C, EB, EC1, EC`), Issue Date, Expiry Date, Country of Issue, Restrictions, Professional Driving Permit (Y/N + expiry), copy of licence (attachment, required).
- A nightly job notifies the employee and HR 60 days before expiry.

#### 5.4.4 Family Details (`/details/family`)
- "Family Members", an **Add New Family Member** button, and the empty state "No existing family members. Select 'Add new family member' to add your family members."
- Fields (observed): Known As Name, Surname, Relationship, Title, First Name, Other Names, Identity Number, Gender, Initials, Second Name, Date of Birth, Age (calculated), Nationality Country, **Emergency Contact** (checkbox), Emergency Detail, Physical address block, Postal address block, Cell / E-Mail / Fax / Home / Work numbers.
- Relationship values (observed, partial list): `Child (I am the Father), Child (I am the Mother), Sibling, Spouse, Life partner, Other, Stepchild (I am the Father), Stepchild (I am the Mother), Child (I am the Father in law), Child (I am the Mother in law), Cousin, Nibling (I am the Aunt), Nibling (I am the Uncle), Adopted Child (I am the Father), Adopted Child (I am the Mother), Child (I am the Guardian), Father (I am the Child), Mother (I am the Child), …`. Complete the list with the matching reverse relationships (`Father (I am the Child in law)`, `Mother (I am the Child in law)`, `Grandparent`, `Grandchild`, `Aunt`, `Uncle`) as ASSUMPTION, editable by HR.
- Submit goes through the `BASICINF` workflow (ASSUMPTION: Sage routes family changes through basic info).

#### 5.4.5 Beneficiaries (`/details/beneficiaries`, workflow `BENEFICIARY`)
- Lists the retirement funds the employee is a member of. Empty state: "No Retirement Funds."
- For each fund, a beneficiary grid: beneficiary (pick a family member or capture a free person), relationship, ID number, percentage.
- **Validation: the percentages must total exactly 100.00** per fund.

#### 5.4.6 Employee Transactions (`/details/transactions`)
(ASSUMPTION: the submenu was not expandable during mapping.) Read-only list of the employee's recurring payroll transactions (code, description, amount/quantity, start/end period). There is also a submit form for employee-initiated payroll inputs, configured by HR per transaction code, which routes through the `FREETEXTMANEMP` workflow until a dedicated type is configured.

### 5.5 Payslips (`/payslips`)
- The left list shows cards: employee name, company name, **period end date** (`30 Sep 2026`), company rule label (`Staff`), **pay run** (`Main Payrun`, `2nd Payrun`), and run type (`Normal`). There is a **More** button (pagination, 4 at a time) and "Select payslip to preview".
- The right pane is an inline PDF preview (iframe) with a Download button.
- PDF sections: company header and logo; employee block (name, code, ID masked, job title, department, date engaged, pay period, bank masked); Earnings; Deductions; Company Contributions; Fringe Benefits; YTD totals; Leave balances summary; Net Pay. Generate it on publish, then store the file and its `sha256`.
- **Every view and download is audited** (`DATA_VIEW.PAYSLIP`, `EXPORT.PAYSLIP_PDF`).
- Payslips are imported or published by PAYROLL_ADMIN through `POST /admin/payslips/import` (CSV/JSON schema in `packages/shared`). This app is ESS, not a payroll engine.

### 5.6 Tax Certificates (`/tax-certificates`)
A list by tax year with preview and download PDF. The empty state is "No Tax Certificates to view". They are published by Payroll the same way as payslips. All views and downloads are audited.

### 5.7 Reports (`/reports`)
Reports are grouped exactly as observed. Each report has a parameter panel: date range, company rule, employee multi-select (limited to the user's scope), status where relevant, and "include terminated". Output can be an on-screen grid, PDF, Excel or CSV. **Each run and export writes `EXPORT.REPORT` audit rows with the parameters.**
- **Employee:** Employee Pay Period Basic · Employee Basic · Employee Detail · Birthday List · EmployeeTransaction · Development Plan Report
- **Leave:** Leave Detail · Leave Max Credit · Leave Basic · Leave Summary · Leave History Per Period · Leave In Lieu · Leave By Month
- **Performance:** Individual Performance Review Results · Contract And Review Overview · Reviewer Detail
- **Workflow:** Processed Claims · Expense Claim Workflow Status · Expense Claim Report · Claim Line · Step Approver Actions · Claim Summary · Process History · Escalation Items
- *(new)* **Audit:** Audit Trail Extract · Sensitive Data Access · Failed Logins · Changes by User (AUDITOR, SYSTEM_ADMIN)

Implement each report as a `ReportDefinition { code, group, title, params: ZodSchema, requiredRoles, run(ctx, params): AsyncIterable<Row>, columns }`. Stream results so a large export does not load everything into memory.

### 5.8 Free Text Workflow (`/free-text`)
- "The application is for {employee}", "who is applying for {FreeTextType}" (observed example: **Onboarding Arrival Update**), a free-text body (required) and attachments. Buttons: Submit, Cancel.
- `FreeTextType.requiresSubjectEmployee` → workflow `FREETEXTMANEMP`, which adds a mandatory "About employee" picker. Otherwise the workflow is `FREETEXT`.
- HR configures the types and their workflow definitions.

### 5.9 Performance
Lookups (parameter tables observed): `ReviewCategory, ReviewType, JobTitleType, JobGrade, KeyPerformanceArea, KeyPerformanceIndicator, SubKeyPerformanceIndicator, CompetencyArea, Competency, SubCompetency, LevelOfComplexity`.

- **Create Review** (`/performance/reviews/new`): a wizard with left nav *Overview → Shared Review Info. → Complete*.
  - Fields: Review Name*, Review Category*, Review Type*, Review Cycle Start Date*, Review Cycle End Date*, **Notify:** `Immediately | Never | Specific Date`, Additional: **Modify**, **Add Objectives**.
  - **Reviewees:** "Shared Template" or "Free Format Template", plus **Add Employees**.
  - **Reviewers:** add reviewers per reviewee.
  - Submit, Cancel.
- **Edit Review:** a list with Filter, Sort by and **Copy**. Edit is only allowed while `DRAFT`/`OPEN`.
- **Review Results:** scored reviews (filter, sort, copy).
- **Performance Templates** grid: Name, Contract Start Date, Contract End Date, Overall Rating Scale, Process Definition, Linked Contracts, Template Owner, Created From Template, Status.
- **Contract Initiation** grid: Contract Name, Contract Start Date, Contract End Date, Status, Progress, Contract Count, Created, Failed, Last Changed. Initiation is a background job (pg-boss) that creates one contract per selected employee from a template and reports progress and failures.
- **Contracts / Archived Contracts** grid: Employee Code, First Name, Last Name, Template Name, Contract Name, Contract Start Date, Contract End Date, Job Title, Job Grade, Employee Company Rule, Reports To, Employee Date Engaged, Employee Status, Contract Type, Contract Status, Currently Assigned.
- **Reviews** (contract reviews) has a **Filter Selection** modal: Companies, Company Rules, Employees, Positions, Review Types, Review Categories (each a multi-select with "+"), Review Name, Review Statuses, Start Date Between / And, End Date Between / And, and buttons Clear / Cancel / Search. Grid: Employee Name, Employee Surname, Employee Company, Employee Company Rule, Employee Position, Contract Name, Review Name, Review Category, Review Type, Review Cycle Start Date, Review Cycle End Date, Review Status, Review Total Actual.
- Scoring: `itemScore = rating × weight / 100`. `Review Total Actual = Σ itemScore`, normalised to the template's `RatingScale`. Weights per section must sum to 100 (422 otherwise).

### 5.10 Inbox (`/inbox`)
- **Left panel:**
  - "My Submitted Items": Leave, Personal Details, Bank Details, Free Text, Claims, Beneficiaries, Job Requisition, Checklist. Show only types that have items or are enabled.
  - "Approvals" (shown when the user is an approver): the same categories, with counts of items awaiting the user.
  - "My Notifications" → Notification Inbox.
- **Middle panel:** tabs **Action Required (n) / Submitted (n) / History (n)**, plus Filter and Sort. Cards show "{First} {Last} - {EmpCode}", the type, "from {dd MMM yyyy} to {dd MMM yyyy}", "Status: {status}", "{n} Days to be deducted", the submitted date, and "View leave request".
- **Right panel (detail):** title and an **Approval history** button that opens a modal in the exact format of section 1.5. Then applicant, "Date submitted", **Days available**, **Days to be deducted**, Status; field list (Leave type, Reason for leave, Leave start date, Leave end date, I am taking, Date submitted, Comments); **Attached documents** with Download (audited); and comments from all approvers.
- **Approver actions** (only when the current step is assigned to the user, directly or through out-of-office delegation):
  - **Approve** (optional comment).
  - **Decline** (comment required).
  - **Reassign** (pick a user; requires `allowReassign`).
  - **Park** until a date (`canPark`); the item is hidden from Action Required until then.
  - **Send back for resubmission** (`allowResubmit`; the applicant can edit and resubmit, which creates a new step round).
  - **Bulk approve** in the list (each item still audited individually).
- The approver sees a warning if approving would take the applicant's balance negative.

### 5.11 Out of office (`/profile/out-of-office`)
Observed form:
- ( ) "Send my inbox items to the nominated approver while I am on leave" (uses the user's approved leave dates).
- ( ) "Send my inbox items to the nominated approver during the following dates {from} to {to}".
- "My main nominated approver is {user}".
- "Setup nominated approvers per Workflow Type": a select of workflow type plus a user, as repeatable rows. A rule for a specific type overrides the main nominee.
- Save, Cancel.

Engine behaviour: when a step is assigned and the assignee is out of office, assign it to the nominee. Record `delegatedFromUserId`, and write audit `WORKFLOW.DELEGATED`. Delegation is not transitive beyond 3 hops; on a cycle, fall back to the original assignee and alert HR. Nominees cannot be the applicant (segregation of duties).

---

## 6. Notifications
- In-app (`Notification` table, bell count, Notification Inbox) plus email.
- Events: request submitted (to the approvers), step approved (to the applicant), final approval, declined (with comment), sent back, cancelled, processed, escalation, reassigned, parked item due, bank details changed, licence expiring, password changed, account locked.
- Email templates are plain HTML with no PII beyond first name, request type and a link.

---

## 7. Workflow engine (`apps/api/src/modules/workflow`)

### 7.1 Definition model
A `WorkflowDefinition` is chosen per `(workflowType, companyRule | null)`. The most specific active definition wins. Each definition has ordered `WorkflowStep`s:
- `resolution`: `REPORTS_TO` (the applicant's manager), `REPORTS_TO_LEVEL_2` (the manager's manager), `SPECIFIC_USER`, or `ROLE` (any user with the role in the same company; the first to act wins).
- `isMandatory`: if false, the step may be auto-skipped when the approver cannot be resolved.
- `skipIfSameApprover`: if the resolved approver equals the previous step's approver or the applicant, auto-skip (audited `AUTO_SKIP`). **The applicant can never approve their own request.**
- `escalationHours`: after this long, escalate (section 7.4).

### 7.2 Process lifecycle
```
DRAFT ──submit──▶ IN_PROGRESS ──(all steps approved)──▶ APPROVED_PENDING_PROCESS ──process──▶ PROCESSED
   │                 │  ├─decline────────────▶ DECLINED
   │                 │  ├─sendBack──────────▶ RESUBMIT_REQUIRED ──resubmit──▶ IN_PROGRESS (new round)
   │                 │  ├─park──────────────▶ (step PARKED, process stays IN_PROGRESS)
   └─discard         └─withdraw/cancel─────▶ CANCELLED
```
- Types that do not need payroll (BASICINF, BANKDET, DRIVERSLICENSE, BENEFICIARY, FREETEXT*, CHECKLISTITEM) go straight from the last approval to `PROCESSED`, and the change is applied in the same transaction.
- `LEAVE`, `CANCELLEAVE`, `CLAIMS`, `GROUPEDCLAIM`, `CREDITLVE*` stop at `APPROVED_PENDING_PROCESS` until a PAYROLL_ADMIN processes them (single or bulk, choosing the pay period). Processing posts the ledger entries. Setting `workflow.autoProcess.{TYPE}=true` processes automatically on final approval.

### 7.3 Engine API (internal service)
```ts
start(ctx, { type, subjectEntity, subjectEntityId, subjectEmployeeId, summary }): Promise<WorkflowProcess>
act(ctx, processId, { action: 'APPROVE'|'DECLINE'|'REASSIGN'|'PARK'|'SEND_BACK'|'COMMENT', comment?, reassignToUserId?, parkUntil?, expectedVersion }): Promise<WorkflowProcess>
withdraw(ctx, processId, expectedVersion)
resubmit(ctx, processId, expectedVersion)
process(ctx, processIds[], payPeriodId)
history(ctx, processId): ApprovalHistoryDto   // renders the section 1.5 format
canStart(ctx, type, discriminator?): boolean  // = employeeCanStartWorkflow
```
- Each call runs in one transaction, locks the process row (`SELECT … FOR UPDATE`), checks `version`, writes a `WorkflowAction` row and the audit row(s), and emits domain events (`workflow.approved`, and so on) **after commit** through a transactional outbox table polled by pg-boss.
- Subject handlers implement `WorkflowSubjectHandler { onFinalApproval, onProcess, onDeclined, onCancelled }` per type, for example `LeaveHandler` and `ChangeRequestHandler`.

### 7.4 Escalation and parking
A pg-boss cron job runs every 15 minutes:
- For overdue `PENDING` steps: notify the assignee and their manager, and set `isEscalated` (an "Escalation Items" report source).
- After `2 × escalationHours`, if `workflow.escalation.autoReassign` is on, reassign to `REPORTS_TO_LEVEL_2` (audited `ESCALATE`).
- Parked steps return to Action Required at `parkUntil`.

### 7.5 Approver-change resilience
If an approver is terminated or deactivated, pending steps assigned to them are re-resolved by a nightly job and on employee termination (audited `REASSIGN` with actor `SYSTEM`).

### 7.6 ChangeRequest pattern (master data)
- `ChangeRequest { entityType, entityId?, operation: CREATE|UPDATE|DELETE, proposed: Json, baseVersion, before: Json }`.
- While a ChangeRequest for the same `(employee, entityType, entityId)` is open, a new one is rejected with 409 "A change is already awaiting approval".
- On final approval, `ChangeRequestHandler` re-reads the entity. If `version !== baseVersion`, it marks the request `CONFLICT` and notifies HR, who must re-apply manually. Otherwise it applies the patch through the same domain service used by HR edits, so validation and audit are identical.
- The UI shows a banner on the page, "Changes pending approval (Process #821)", and greys out the edited fields.

---

## 8. Reference numbers and sequences

### 8.1 Leave
`E{entityCode padded 6}-T{leaveTypeId padded 4}-N{seq padded 5}`. The sequence key is `LEAVE:{employeeId}:{leaveTypeId}`, allocated with
```sql
INSERT INTO "ReferenceSequence"(key, "lastValue") VALUES ($1, 1)
ON CONFLICT (key) DO UPDATE SET "lastValue" = "ReferenceSequence"."lastValue" + 1
RETURNING "lastValue";
```
inside the submit transaction. Numbers are never reused, including for withdrawn requests.

### 8.2 Others
- Claims: `C{entityCode}-G{groupId:4}-N{seq:5}`.
- Change requests: `R{entityCode}-{typeCode}-N{seq:5}`.
- Free text: `F{entityCode}-N{seq:5}`.
- Workflow process IDs: an integer identity column, shown as "Workflow Process ID: n".

---

## 9. Audit trail (required; implement in Phase 1, before any feature)

### 9.1 What is recorded
| Category | Examples |
|---|---|
| `AUTH` | login success/failure, logout, timeout, password change/reset, lockout, MFA |
| `SECURITY` | acting-as changed, permission denied (403), role granted/revoked, setting changed |
| `DATA_CHANGE` | every create/update/soft-delete of a business entity, with before/after and a field diff |
| `WORKFLOW` | created, submitted, approved, declined, reassigned, delegated, parked, escalated, sent back, resubmitted, withdrawn, cancelled, processed, auto-skipped |
| `DATA_VIEW` | payslip view, tax certificate view, bank unmasked, ID number unmasked, attachment download, another employee's personal details viewed (by HR/manager) |
| `EXPORT` | report run/export, calendar export, payslip PDF download, audit export |
| `SYSTEM` | job runs (accrual, rollover, escalation, initiation), migrations, seed, key rotation |

### 9.2 Table design (`AuditLog`, see the Prisma schema)
Columns: `id bigint identity`, `occurredAt timestamptz`, `requestId`, `sessionId`, `actorUserId`, `actorUsername` (denormalised), `actingAsEmployeeId`, `subjectEmployeeId`, `category`, `action` (`DOMAIN.VERB`, for example `LEAVE.SUBMITTED`), `entityType`, `entityId`, `outcome` (`SUCCESS|DENIED|FAILURE`), `before jsonb`, `after jsonb`, `changes jsonb` (an array of `{path, from, to}`), `reason`, `ip`, `userAgent`, `metadata jsonb`, `prevHash`, `hash`.

### 9.3 Tamper evidence
- `hash = sha256(prevHash || canonicalJson(row without hash))`. Canonical JSON uses sorted keys, no whitespace, ISO timestamps with µs precision, and decimals as strings.
- Chain serialisation: within the business transaction, call `SELECT pg_advisory_xact_lock(727274)`, read the last hash (`SELECT hash FROM "AuditLog" ORDER BY id DESC LIMIT 1`), then insert. One global chain is fine at ESS scale. The audit write must stay last in the transaction to keep the lock short.
- Write a DB migration (raw SQL in a Prisma migration) that does the following:
  ```sql
  CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger AS $$
  BEGIN RAISE EXCEPTION 'AuditLog is append-only'; END; $$ LANGUAGE plpgsql;
  CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE OR TRUNCATE ON "AuditLog"
    FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();
  REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM app_user;
  ```
  The app connects as `app_user`. Migrations run as `app_owner`.
- `pnpm audit:verify` (CLI) and `GET /api/v1/audit/verify?from=&to=` (AUDITOR) recompute the chain and report the first broken id.
- A nightly job writes a **daily anchor** (the last id and hash of the day) to `AuditAnchor` and optionally to an external write-once store (S3 Object Lock) when it is configured.

### 9.4 Capture mechanics
1. **Explicit domain audit:** every service method that changes state calls `audit.record(tx, ctx, {...})` with a meaningful action name. This is the primary mechanism.
2. **Safety net:** a Prisma client extension (`$extends` query hooks) on `create|update|upsert|delete|createMany|updateMany` for audited models. If a write happens in a transaction that has no explicit audit for that entity, it records a generic `DATA_CHANGE.{MODEL}.{OP}` row with the before/after state. The before state is read inside the same transaction. `updateMany`/`deleteMany` on audited models are **forbidden** by the extension (throw), except for an allow-listed set of job paths that audit per row.
3. **HTTP layer:** a Nest interceptor attaches `requestId`, `ip` and `userAgent` to `ctx`, and records `SECURITY.ACCESS_DENIED` for every 401/403.
4. **Reads:** controllers of sensitive endpoints are decorated with `@AuditView('PAYSLIP')`, and so on.

### 9.5 Redaction rules
- Never store passwords, password hashes, tokens, MFA secrets or encryption keys in `before`/`after`. They become `"[REDACTED]"`.
- Encrypted fields are stored in audit as `{ "last4": "1234", "changed": true }`, never as plaintext or ciphertext.
- Attachments are recorded as `{ id, fileName, sha256, size }`.
- The rules are a central, unit-tested `redact(modelName, data)` function with a per-model field policy.

### 9.6 Retention
Audit rows are kept forever (`audit.retentionYears` defaults to `null`). Business records are soft-deleted only.

### 9.7 Audit UI (`/audit`, AUDITOR and SYSTEM_ADMIN)
- Filters: date range, actor, subject employee, category, action, entity type and id, outcome, free text in metadata.
- Grid with an expandable row that shows a side-by-side before/after diff.
- "Verify chain" button. Export to CSV/Excel (and that export is itself audited).
- **Record history tab** on every entity screen (leave application, claim, employee, bank account, and so on) for users who are allowed to see that entity: it shows that entity's audit rows plus its workflow actions.

---

## 10. Cross-cutting

### 10.1 API conventions
- Base path `/api/v1`. JSON. Errors use RFC 7807 problem+json: `{type,title,status,detail,errors:[{path,message}]}`.
- Pagination is `?page=&pageSize=` (max 100) and returns `{items,total,page,pageSize}`. Sorting is `?sort=field:asc`.
- Dates in DTOs: `YYYY-MM-DD` for business dates and ISO-8601 UTC for timestamps. Decimals are sent as **strings** (`"3.8358"`) to avoid float errors. Use `decimal.js` in shared helpers.
- Rate limit `/auth/*` to 10 requests per minute per IP.

### 10.2 Security headers
Helmet with a strict CSP (no inline scripts), HSTS, `X-Content-Type-Options`, `Referrer-Policy: same-origin`, and CORS restricted to the web origin.

### 10.3 Encryption
- `ENCRYPTION_KEYS` is JSON `{ "k1": "<base64 32 bytes>", ... }` plus `ENCRYPTION_ACTIVE_KEY=k1`.
- Ciphertext format is `k1:iv:tag:ciphertext` (base64 parts).
- `pnpm keys:rotate` re-encrypts everything to the active key in batches, with audit `SYSTEM.KEY_ROTATION`.

### 10.4 Files
- Upload goes through `POST /api/v1/attachments` (multipart). Validate magic bytes against the MIME type, enforce size, and compute sha256. A virus-scan hook interface (`ClamAV` implementation optional). Store under `yyyy/mm/{uuid}`.
- Download goes through `GET /api/v1/attachments/:id` with an authorisation check against the owning entity, and is audited.

### 10.5 Configuration (`SystemSetting`, editable in Admin, every change audited)
`session.idleMinutes`, `session.warnSeconds`, `leave.maxBackdateDays`, `workingAs.maxDepth`, `workingAs.restrictedFeatures`, `workflow.autoProcess.*`, `workflow.escalation.autoReassign`, `birthdays.enabled`, `mail.from`, `company.logoAttachmentId`, `ui.dateFormat`.

### 10.6 Accessibility and i18n
WCAG 2.1 AA (labels, focus states, keyboard-operable comboboxes and date pickers). All strings go through `i18next` (English only in v1). The layout is responsive down to 360px.

---

## 11. Prisma schema (`apps/api/prisma/schema.prisma`)

Use this schema as written. Add indexes if profiling needs them, but do not remove fields. Run `prisma format` and then `prisma validate`, and fix anything it reports before writing any service code. I checked every relation pair in this schema by hand, but `prisma validate` could not be run while the spec was written.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ───────────── Enums ─────────────
enum Role {
  EMPLOYEE
  MANAGER
  HR_ADMIN
  PAYROLL_ADMIN
  SYSTEM_ADMIN
  AUDITOR
}

enum AuthProvider {
  LOCAL
  OAUTH
}

enum EmployeeStatus {
  ACTIVE
  SUSPENDED
  TERMINATED
}

enum AddressType {
  PHYSICAL
  POSTAL
  WORK
}

enum PostalServiceType {
  PO_BOX
  PRIVATE_BAG
  POSTNET_SUITE
  STREET
  OTHER
}

enum ContactType {
  CELL
  EMAIL
  FAX
  HOME
  WORK
}

enum BankAccountType {
  CURRENT
  LOAN
  TRANSMISSION
  SAVINGS
}

enum AccountHolderRelationship {
  OWN
  JOINT
  THIRD_PARTY
}

enum DayPortion {
  FULL
  AM
  PM
}

enum LeaveUnit {
  DAYS
  HOURS
}

enum AccrualMethod {
  MONTHLY_PRO_RATA
  UPFRONT
  NONE
}

enum LedgerEntryType {
  OPENING
  ACCRUAL
  TAKEN
  CANCELLATION_REVERSAL
  ADJUSTMENT
  CARRY_FORWARD_IN
  CARRY_FORWARD_OUT
  FORFEIT
  CREDIT_ALLOCATION
  PAYOUT
}

enum ProcessStatus {
  DRAFT
  IN_PROGRESS
  RESUBMIT_REQUIRED
  APPROVED_PENDING_PROCESS
  PROCESSED
  DECLINED
  CANCELLED
  CONFLICT
}

enum StepStatus {
  PENDING
  PARKED
  APPROVED
  DECLINED
  SKIPPED
  REASSIGNED
  SENT_BACK
  CANCELLED
}

enum ApproverResolution {
  REPORTS_TO
  REPORTS_TO_LEVEL_2
  SPECIFIC_USER
  ROLE
}

enum WorkflowActionType {
  CREATE
  SUBMIT
  APPROVE
  DECLINE
  REASSIGN
  DELEGATE
  PARK
  UNPARK
  SEND_BACK
  RESUBMIT
  WITHDRAW
  CANCEL
  ESCALATE
  COMMENT
  AUTO_SKIP
  PROCESS
  APPLY
  CONFLICT
}

enum CreditLeaveKind {
  REQUEST
  ALLOCATION
}

enum ClaimInputMode {
  AMOUNT
  QUANTITY
  HOURS
  KILOMETRES
}

enum CapMode {
  NO_CAP
  WARN
  BLOCK
}

enum CapCycle {
  PAY_PERIOD
  MONTHLY
  ANNUAL
}

enum PayslipLineCategory {
  EARNING
  DEDUCTION
  COMPANY_CONTRIBUTION
  FRINGE_BENEFIT
  INFO
}

enum ChangeOperation {
  CREATE
  UPDATE
  DELETE
}

enum OutOfOfficeMode {
  OFF
  WHILE_ON_LEAVE
  DATE_RANGE
}

enum TemplateStatus {
  DRAFT
  ACTIVE
  ARCHIVED
}

enum TemplateItemKind {
  KPA
  KPI
  COMPETENCY
  OBJECTIVE
}

enum InitiationStatus {
  QUEUED
  RUNNING
  COMPLETED
  FAILED
}

enum ContractStatus {
  DRAFT
  AGREED
  ACTIVE
  CLOSED
  ARCHIVED
}

enum ReviewNotifyMode {
  IMMEDIATELY
  NEVER
  SPECIFIC_DATE
}

enum ReviewStatus {
  DRAFT
  OPEN
  SELF_ASSESSMENT
  REVIEWER_ASSESSMENT
  MODERATION
  COMPLETED
  CANCELLED
}

enum ParticipantRole {
  REVIEWEE
  REVIEWER
}

enum AuditCategory {
  AUTH
  SECURITY
  DATA_CHANGE
  WORKFLOW
  DATA_VIEW
  EXPORT
  SYSTEM
}

enum AuditOutcome {
  SUCCESS
  DENIED
  FAILURE
}

// ───────────── Organisation ─────────────
model Company {
  id             Int             @id @default(autoincrement())
  code           String          @unique
  name           String
  currency       String          @default("NAD")
  country        String          @default("NA")
  logoAttachmentId String?
  createdAt      DateTime        @default(now()) @db.Timestamptz(6)
  updatedAt      DateTime        @updatedAt @db.Timestamptz(6)
  rules          CompanyRule[]
  employees      Employee[]
  publicHolidays PublicHoliday[]
}

model CompanyRule {
  id                  Int                  @id @default(autoincrement())
  companyId           Int
  code                String
  description         String
  company             Company              @relation(fields: [companyId], references: [id])
  employees           Employee[]
  payPeriods          PayPeriod[]
  workflowDefinitions WorkflowDefinition[]
  leavePolicies       LeavePolicy[]
  claimCaps           ClaimCap[]
  @@unique([companyId, code])
}

model PublicHoliday {
  id        Int      @id @default(autoincrement())
  companyId Int?
  date      DateTime @db.Date
  name      String
  company   Company? @relation(fields: [companyId], references: [id])
  @@unique([companyId, date])
  @@index([date])
}

// ───────────── People & identity ─────────────
model Employee {
  id                        Int                        @id @default(autoincrement())
  entityCode                String                     @unique
  employeeCode              String                     @unique
  companyId                 Int
  companyRuleId             Int
  title                     String?
  initials                  String?
  firstName                 String
  secondName                String?
  otherNames                String?
  lastName                  String
  knownAs                   String?
  maidenName                String?
  identityType              String?
  identityNumberEnc         String?
  identityNumberLast4       String?
  dateOfBirth               DateTime?                  @db.Date
  countryOfBirth            String?
  cityOfBirth               String?
  birthCertificateNumberEnc String?
  passportNumberEnc         String?
  passportCountry           String?
  taxNumberEnc              String?
  taxNumberLast4            String?
  nationality               String?
  homeLanguage              String?
  gender                    String?
  maritalStatus             String?
  bloodGroup                String?
  religion                  String?
  correspondenceAddressType AddressType?
  jobTitle                  String?
  jobGrade                  String?
  department                String?
  hourlyRate                Decimal?                   @db.Decimal(14, 4)
  workPattern               Json?
  dateEngaged               DateTime?                  @db.Date
  terminationDate           DateTime?                  @db.Date
  status                    EmployeeStatus             @default(ACTIVE)
  birthdayVisible           Boolean                    @default(true)
  photoAttachmentId         String?
  reportsToId               Int?
  version                   Int                        @default(1)
  createdAt                 DateTime                   @default(now()) @db.Timestamptz(6)
  updatedAt                 DateTime                   @updatedAt @db.Timestamptz(6)
  deletedAt                 DateTime?                  @db.Timestamptz(6)

  company                   Company                    @relation(fields: [companyId], references: [id])
  companyRule               CompanyRule                @relation(fields: [companyRuleId], references: [id])
  reportsTo                 Employee?                  @relation("ReportsTo", fields: [reportsToId], references: [id])
  directReports             Employee[]                 @relation("ReportsTo")
  user                      User?
  addresses                 Address[]
  contacts                  ContactDetail[]
  bankAccounts              BankAccount[]
  driversLicences           DriversLicence[]
  familyMembers             FamilyMember[]
  fundMemberships           FundMembership[]
  leaveEntitlements         EmployeeLeaveEntitlement[]
  leaveLedger               LeaveLedgerEntry[]
  leaveApplications         LeaveApplication[]
  creditLeaveRequests       CreditLeaveRequest[]
  claims                    Claim[]
  claimAdjustments          ClaimBalanceAdjustment[]
  payslips                  Payslip[]
  taxCertificates           TaxCertificate[]
  changeRequests            ChangeRequest[]
  employeeTransactions      EmployeeTransaction[]
  processesAsSubject        WorkflowProcess[]          @relation("ProcessSubject")
  freeTextApplied           FreeTextRequest[]          @relation("FreeTextApplicant")
  freeTextAbout             FreeTextRequest[]          @relation("FreeTextSubject")
  performanceContracts      PerformanceContract[]
  reviewParticipations      ReviewParticipant[]

  @@index([companyId, companyRuleId])
  @@index([reportsToId])
  @@index([lastName, firstName])
}

model User {
  id                 String                 @id @default(uuid())
  username           String                 @unique
  email              String?                @unique
  passwordHash       String?
  authProvider       AuthProvider           @default(LOCAL)
  externalSubject    String?                @unique
  roles              Role[]
  employeeId         Int?                   @unique
  isActive           Boolean                @default(true)
  mustChangePassword Boolean                @default(false)
  failedLoginCount   Int                    @default(0)
  lockedUntil        DateTime?              @db.Timestamptz(6)
  lastLoginAt        DateTime?              @db.Timestamptz(6)
  passwordChangedAt  DateTime?              @db.Timestamptz(6)
  mfaSecretEnc       String?
  version            Int                    @default(1)
  createdAt          DateTime               @default(now()) @db.Timestamptz(6)
  updatedAt          DateTime               @updatedAt @db.Timestamptz(6)

  employee           Employee?              @relation(fields: [employeeId], references: [id])
  sessions           Session[]
  passwordHistory    PasswordHistory[]
  passwordResets     PasswordResetToken[]
  outOfOffice        OutOfOffice?           @relation("OOOOwner")
  oooMainNominee     OutOfOffice[]          @relation("OOOMainNominee")
  oooRuleNominee     OutOfOfficeRule[]      @relation("OOORuleNominee")
  stepDefinitions    WorkflowStep[]         @relation("StepDefinitionUser")
  assignedSteps      WorkflowStepInstance[] @relation("StepAssignee")
  actedSteps         WorkflowStepInstance[] @relation("StepActor")
  workflowActions    WorkflowAction[]       @relation("ActionActor")
  submittedProcesses WorkflowProcess[]      @relation("ProcessSubmitter")
  attachments        Attachment[]
  notifications      Notification[]
  dashboardLayout    DashboardLayout?
}

model Session {
  id                 String    @id @default(uuid())
  userId             String
  csrfToken          String
  actingAsEmployeeId Int?
  ip                 String?
  userAgent          String?
  createdAt          DateTime  @default(now()) @db.Timestamptz(6)
  lastActivityAt     DateTime  @default(now()) @db.Timestamptz(6)
  expiresAt          DateTime  @db.Timestamptz(6)
  revokedAt          DateTime? @db.Timestamptz(6)
  user               User      @relation(fields: [userId], references: [id])
  @@index([userId])
}

model PasswordHistory {
  id        Int      @id @default(autoincrement())
  userId    String
  hash      String
  createdAt DateTime @default(now()) @db.Timestamptz(6)
  user      User     @relation(fields: [userId], references: [id])
  @@index([userId])
}

model PasswordResetToken {
  id        String    @id @default(uuid())
  userId    String
  tokenHash String    @unique
  expiresAt DateTime  @db.Timestamptz(6)
  usedAt    DateTime? @db.Timestamptz(6)
  createdAt DateTime  @default(now()) @db.Timestamptz(6)
  user      User      @relation(fields: [userId], references: [id])
}

// ───────────── Personal details ─────────────
model Address {
  id                  Int                @id @default(autoincrement())
  employeeId          Int?
  familyMemberId      Int?
  type                AddressType
  sameAs              AddressType?
  unitNumber          String?
  block               String?
  complex             String?
  levelFloor          String?
  streetNumber        String?
  streetName          String?
  suburb              String?
  city                String?
  postalCode          String?
  country             String?
  province            String?
  district            String?
  careOfName          String?
  serviceType         PostalServiceType?
  postalAddressNumber String?
  version             Int                @default(1)
  updatedAt           DateTime           @updatedAt @db.Timestamptz(6)
  employee            Employee?          @relation(fields: [employeeId], references: [id])
  familyMember        FamilyMember?      @relation(fields: [familyMemberId], references: [id])
  @@unique([employeeId, type])
  @@unique([familyMemberId, type])
}

model ContactDetail {
  id             Int           @id @default(autoincrement())
  employeeId     Int?
  familyMemberId Int?
  type           ContactType
  value          String
  isPrimary      Boolean       @default(false)
  employee       Employee?     @relation(fields: [employeeId], references: [id])
  familyMember   FamilyMember? @relation(fields: [familyMemberId], references: [id])
  @@index([employeeId])
}

model Bank {
  id                  Int           @id @default(autoincrement())
  name                String        @unique
  universalBranchCode String?
  country             String?
  isActive            Boolean       @default(true)
  branches            BankBranch[]
  accounts            BankAccount[]
}

model BankBranch {
  id       Int           @id @default(autoincrement())
  bankId   Int
  name     String
  code     String?
  isActive Boolean       @default(true)
  bank     Bank          @relation(fields: [bankId], references: [id])
  accounts BankAccount[]
  @@unique([bankId, name])
}

model BankAccount {
  id                 Int                       @id @default(autoincrement())
  employeeId         Int
  accountType        BankAccountType
  holderName         String
  holderRelationship AccountHolderRelationship
  bankId             Int
  branchId           Int?
  accountNumberEnc   String
  accountNumberLast4 String
  currency           String                    @default("NAD")
  isActive           Boolean                   @default(true)
  effectiveFrom      DateTime                  @db.Date
  effectiveTo        DateTime?                 @db.Date
  version            Int                       @default(1)
  createdAt          DateTime                  @default(now()) @db.Timestamptz(6)
  updatedAt          DateTime                  @updatedAt @db.Timestamptz(6)
  employee           Employee                  @relation(fields: [employeeId], references: [id])
  bank               Bank                      @relation(fields: [bankId], references: [id])
  branch             BankBranch?               @relation(fields: [branchId], references: [id])
  @@index([employeeId, isActive])
}

model DriversLicence {
  id               Int       @id @default(autoincrement())
  employeeId       Int
  licenceNumberEnc String
  licenceLast4     String
  code             String
  issueDate        DateTime? @db.Date
  expiryDate       DateTime  @db.Date
  countryOfIssue   String?
  restrictions     String?
  hasPdp           Boolean   @default(false)
  pdpExpiryDate    DateTime? @db.Date
  version          Int       @default(1)
  deletedAt        DateTime? @db.Timestamptz(6)
  updatedAt        DateTime  @updatedAt @db.Timestamptz(6)
  employee         Employee  @relation(fields: [employeeId], references: [id])
  @@index([expiryDate])
}

model FamilyMember {
  id                 Int             @id @default(autoincrement())
  employeeId         Int
  relationship       String
  title              String?
  initials           String?
  firstName          String
  secondName         String?
  otherNames         String?
  lastName           String
  knownAs            String?
  identityNumberEnc  String?
  identityNumberLast4 String?
  gender             String?
  dateOfBirth        DateTime?       @db.Date
  nationality        String?
  isEmergencyContact Boolean         @default(false)
  emergencyDetail    String?
  version            Int             @default(1)
  deletedAt          DateTime?       @db.Timestamptz(6)
  updatedAt          DateTime        @updatedAt @db.Timestamptz(6)
  employee           Employee        @relation(fields: [employeeId], references: [id])
  addresses          Address[]
  contacts           ContactDetail[]
  beneficiaryOf      Beneficiary[]
}

model RetirementFund {
  id          Int              @id @default(autoincrement())
  code        String           @unique
  name        String
  isActive    Boolean          @default(true)
  memberships FundMembership[]
}

model FundMembership {
  id            Int            @id @default(autoincrement())
  employeeId    Int
  fundId        Int
  memberNumber  String?
  startDate     DateTime?      @db.Date
  version       Int            @default(1)
  employee      Employee       @relation(fields: [employeeId], references: [id])
  fund          RetirementFund @relation(fields: [fundId], references: [id])
  beneficiaries Beneficiary[]
  @@unique([employeeId, fundId])
}

model Beneficiary {
  id                Int            @id @default(autoincrement())
  membershipId      Int
  familyMemberId    Int?
  name              String
  relationship      String
  identityNumberEnc String?
  percentage        Decimal        @db.Decimal(5, 2)
  membership        FundMembership @relation(fields: [membershipId], references: [id])
  familyMember      FamilyMember?  @relation(fields: [familyMemberId], references: [id])
}

model ChangeRequest {
  id               Int              @id @default(autoincrement())
  referenceNumber  String           @unique
  employeeId       Int
  entityType       String
  entityId         String?
  operation        ChangeOperation
  proposed         Json
  before           Json?
  baseVersion      Int?
  status           ProcessStatus    @default(DRAFT)
  processId        Int?             @unique
  appliedAt        DateTime?        @db.Timestamptz(6)
  createdAt        DateTime         @default(now()) @db.Timestamptz(6)
  updatedAt        DateTime         @updatedAt @db.Timestamptz(6)
  version          Int              @default(1)
  employee         Employee         @relation(fields: [employeeId], references: [id])
  process          WorkflowProcess? @relation(fields: [processId], references: [id])
  @@index([employeeId, entityType, status])
}

// ───────────── Workflow ─────────────
model WorkflowType {
  id          Int                  @id @default(autoincrement())
  code        String               @unique
  description String
  isActive    Boolean              @default(true)
  definitions WorkflowDefinition[]
  processes   WorkflowProcess[]
  oooRules    OutOfOfficeRule[]
}

model WorkflowDefinition {
  id             Int               @id @default(autoincrement())
  workflowTypeId Int
  companyRuleId  Int?
  discriminator  String?
  name           String
  versionNo      Int               @default(1)
  isActive       Boolean           @default(true)
  allowReassign  Boolean           @default(true)
  allowResubmit  Boolean           @default(true)
  canPark        Boolean           @default(true)
  createdAt      DateTime          @default(now()) @db.Timestamptz(6)
  workflowType   WorkflowType      @relation(fields: [workflowTypeId], references: [id])
  companyRule    CompanyRule?      @relation(fields: [companyRuleId], references: [id])
  steps          WorkflowStep[]
  processes      WorkflowProcess[]
}

model WorkflowStep {
  id                 Int                    @id @default(autoincrement())
  definitionId       Int
  stepNo             Int
  name               String
  resolution         ApproverResolution
  approverUserId     String?
  approverRole       Role?
  isMandatory        Boolean                @default(true)
  skipIfSameApprover Boolean                @default(true)
  escalationHours    Int?
  definition         WorkflowDefinition     @relation(fields: [definitionId], references: [id])
  approverUser       User?                  @relation("StepDefinitionUser", fields: [approverUserId], references: [id])
  instances          WorkflowStepInstance[]
  @@unique([definitionId, stepNo])
}

model WorkflowProcess {
  id                  Int                    @id @default(autoincrement())
  workflowTypeId      Int
  definitionId        Int
  subjectEmployeeId   Int
  submittedByUserId   String
  submittedOnBehalf   Boolean                @default(false)
  subjectEntity       String
  subjectEntityId     String
  summary             String
  status              ProcessStatus          @default(DRAFT)
  currentStepNo       Int?
  round               Int                    @default(1)
  isEscalated         Boolean                @default(false)
  submittedAt         DateTime?              @db.Timestamptz(6)
  finalApprovedAt     DateTime?              @db.Timestamptz(6)
  processedAt         DateTime?              @db.Timestamptz(6)
  completedAt         DateTime?              @db.Timestamptz(6)
  version             Int                    @default(1)
  createdAt           DateTime               @default(now()) @db.Timestamptz(6)
  updatedAt           DateTime               @updatedAt @db.Timestamptz(6)
  workflowType        WorkflowType           @relation(fields: [workflowTypeId], references: [id])
  definition          WorkflowDefinition     @relation(fields: [definitionId], references: [id])
  subjectEmployee     Employee               @relation("ProcessSubject", fields: [subjectEmployeeId], references: [id])
  submittedBy         User                   @relation("ProcessSubmitter", fields: [submittedByUserId], references: [id])
  stepInstances       WorkflowStepInstance[]
  actions             WorkflowAction[]
  leaveApplication    LeaveApplication?
  creditLeaveRequest  CreditLeaveRequest?
  claim               Claim?
  changeRequest       ChangeRequest?
  freeTextRequest     FreeTextRequest?
  employeeTransaction EmployeeTransaction?
  @@index([status, workflowTypeId])
  @@index([subjectEmployeeId, status])
}

model WorkflowStepInstance {
  id                  Int              @id @default(autoincrement())
  processId           Int
  stepId              Int
  stepNo              Int
  round               Int              @default(1)
  assigneeUserId      String
  delegatedFromUserId String?
  status              StepStatus       @default(PENDING)
  isMandatory         Boolean
  dueAt               DateTime?        @db.Timestamptz(6)
  parkedUntil         DateTime?        @db.Timestamptz(6)
  actedAt             DateTime?        @db.Timestamptz(6)
  actedByUserId       String?
  comment             String?
  createdAt           DateTime         @default(now()) @db.Timestamptz(6)
  process             WorkflowProcess  @relation(fields: [processId], references: [id])
  step                WorkflowStep     @relation(fields: [stepId], references: [id])
  assignee            User             @relation("StepAssignee", fields: [assigneeUserId], references: [id])
  actedBy             User?            @relation("StepActor", fields: [actedByUserId], references: [id])
  actions             WorkflowAction[]
  @@index([assigneeUserId, status])
  @@index([processId, round, stepNo])
}

model WorkflowAction {
  id                   Int                   @id @default(autoincrement())
  processId            Int
  stepInstanceId       Int?
  action               WorkflowActionType
  actorUserId          String
  onBehalfOfEmployeeId Int?
  comment              String?
  fromStatus           ProcessStatus?
  toStatus             ProcessStatus?
  metadata             Json?
  createdAt            DateTime              @default(now()) @db.Timestamptz(6)
  process              WorkflowProcess       @relation(fields: [processId], references: [id])
  stepInstance         WorkflowStepInstance? @relation(fields: [stepInstanceId], references: [id])
  actor                User                  @relation("ActionActor", fields: [actorUserId], references: [id])
  @@index([processId, createdAt])
}

model OutOfOffice {
  id                String            @id @default(uuid())
  userId            String            @unique
  mode              OutOfOfficeMode   @default(OFF)
  fromDate          DateTime?         @db.Date
  toDate            DateTime?         @db.Date
  mainNomineeUserId String?
  version           Int               @default(1)
  updatedAt         DateTime          @updatedAt @db.Timestamptz(6)
  user              User              @relation("OOOOwner", fields: [userId], references: [id])
  mainNominee       User?             @relation("OOOMainNominee", fields: [mainNomineeUserId], references: [id])
  rules             OutOfOfficeRule[]
}

model OutOfOfficeRule {
  id             Int          @id @default(autoincrement())
  outOfOfficeId  String
  workflowTypeId Int
  nomineeUserId  String
  outOfOffice    OutOfOffice  @relation(fields: [outOfOfficeId], references: [id])
  workflowType   WorkflowType @relation(fields: [workflowTypeId], references: [id])
  nominee        User         @relation("OOORuleNominee", fields: [nomineeUserId], references: [id])
  @@unique([outOfOfficeId, workflowTypeId])
}

model OutboxEvent {
  id          BigInt    @id @default(autoincrement())
  type        String
  payload     Json
  createdAt   DateTime  @default(now()) @db.Timestamptz(6)
  publishedAt DateTime? @db.Timestamptz(6)
  @@index([publishedAt])
}

// ───────────── Leave ─────────────
model LeaveType {
  id                          Int                        @id
  code                        String                     @unique
  description                 String
  colour                      String?
  unit                        LeaveUnit                  @default(DAYS)
  isPaid                      Boolean                    @default(true)
  mandatoryReason             Boolean                    @default(false)
  requiresAttachmentAfterDays Decimal?                   @db.Decimal(12, 4)
  allowHalfDay                Boolean                    @default(true)
  allowNegative               Boolean                    @default(false)
  excludeWeekends             Boolean                    @default(true)
  excludePublicHolidays       Boolean                    @default(true)
  hideUnitsAvailableForESS    Boolean                    @default(false)
  hideZeroUnitsAvailableForESS Boolean                   @default(false)
  isCreditLeave               Boolean                    @default(false)
  isActive                    Boolean                    @default(true)
  reasons                     LeaveReason[]
  policies                    LeavePolicy[]
  entitlements                EmployeeLeaveEntitlement[]
  ledger                      LeaveLedgerEntry[]
  applications                LeaveApplication[]
  creditLeaveRequests         CreditLeaveRequest[]
}

model LeaveReason {
  id           Int                @id @default(autoincrement())
  leaveTypeId  Int
  code         String
  description  String
  isActive     Boolean            @default(true)
  leaveType    LeaveType          @relation(fields: [leaveTypeId], references: [id])
  applications LeaveApplication[]
  @@unique([leaveTypeId, code])
}

model LeavePolicy {
  id                       Int                        @id @default(autoincrement())
  leaveTypeId              Int
  companyRuleId            Int?
  definitionName           String
  entitlementPerCycle      Decimal                    @db.Decimal(12, 4)
  accrualMethod            AccrualMethod
  cycleMonths              Int                        @default(12)
  maxCarryForward          Decimal?                   @db.Decimal(12, 4)
  carryForwardExpiryMonths Int?
  maxNegative              Decimal                    @default(0) @db.Decimal(12, 4)
  creditExpiryDays         Int?
  isActive                 Boolean                    @default(true)
  leaveType                LeaveType                  @relation(fields: [leaveTypeId], references: [id])
  companyRule              CompanyRule?               @relation(fields: [companyRuleId], references: [id])
  entitlements             EmployeeLeaveEntitlement[]
}

model EmployeeLeaveEntitlement {
  id             Int                          @id @default(autoincrement())
  employeeId     Int
  leaveTypeId    Int
  policyId       Int?
  definitionName String
  entitlement    Decimal                      @db.Decimal(12, 4)
  cycleStartDate DateTime                     @db.Date
  cycleEndDate   DateTime                     @db.Date
  expiresOn      DateTime?                    @db.Date
  isClosed       Boolean                      @default(false)
  employee       Employee                     @relation(fields: [employeeId], references: [id])
  leaveType      LeaveType                    @relation(fields: [leaveTypeId], references: [id])
  policy         LeavePolicy?                 @relation(fields: [policyId], references: [id])
  ledger         LeaveLedgerEntry[]
  allocations    LeaveApplicationAllocation[]
  @@index([employeeId, leaveTypeId, cycleEndDate])
}

model LeaveLedgerEntry {
  id                 Int                      @id @default(autoincrement())
  employeeId         Int
  leaveTypeId        Int
  entitlementId      Int
  entryType          LedgerEntryType
  units              Decimal                  @db.Decimal(12, 4)
  effectiveDate      DateTime                 @db.Date
  payPeriodId        Int?
  leaveApplicationId Int?
  note               String?
  createdByUserId    String?
  createdAt          DateTime                 @default(now()) @db.Timestamptz(6)
  employee           Employee                 @relation(fields: [employeeId], references: [id])
  leaveType          LeaveType                @relation(fields: [leaveTypeId], references: [id])
  entitlement        EmployeeLeaveEntitlement @relation(fields: [entitlementId], references: [id])
  payPeriod          PayPeriod?               @relation(fields: [payPeriodId], references: [id])
  leaveApplication   LeaveApplication?        @relation(fields: [leaveApplicationId], references: [id])
  @@index([employeeId, leaveTypeId, effectiveDate])
  @@unique([entitlementId, entryType, effectiveDate, leaveApplicationId])
}

model LeaveApplication {
  id                   Int                          @id @default(autoincrement())
  referenceNumber      String                       @unique
  employeeId           Int
  leaveTypeId          Int
  leaveReasonId        Int?
  fromDate             DateTime                     @db.Date
  toDate               DateTime                     @db.Date
  startPortion         DayPortion                   @default(FULL)
  endPortion           DayPortion                   @default(FULL)
  unitsTaken           Decimal                      @db.Decimal(12, 4)
  unitsOverridden      Boolean                      @default(false)
  overrideReason       String?
  noteSubmitted        Boolean                      @default(false)
  noteReceived         Boolean                      @default(false)
  takeOnTransaction    Boolean                      @default(false)
  comment              String?
  status               ProcessStatus                @default(DRAFT)
  processId            Int?                         @unique
  cancelsApplicationId Int?                         @unique
  payPeriodId          Int?
  submittedAt          DateTime?                    @db.Timestamptz(6)
  approvedAt           DateTime?                    @db.Timestamptz(6)
  finalApproverUserId  String?
  processedAt          DateTime?                    @db.Timestamptz(6)
  version              Int                          @default(1)
  createdAt            DateTime                     @default(now()) @db.Timestamptz(6)
  updatedAt            DateTime                     @updatedAt @db.Timestamptz(6)
  employee             Employee                     @relation(fields: [employeeId], references: [id])
  leaveType            LeaveType                    @relation(fields: [leaveTypeId], references: [id])
  leaveReason          LeaveReason?                 @relation(fields: [leaveReasonId], references: [id])
  process              WorkflowProcess?             @relation(fields: [processId], references: [id])
  payPeriod            PayPeriod?                   @relation(fields: [payPeriodId], references: [id])
  cancels              LeaveApplication?            @relation("LeaveCancellation", fields: [cancelsApplicationId], references: [id])
  cancellation         LeaveApplication?            @relation("LeaveCancellation")
  days                 LeaveApplicationDay[]
  allocations          LeaveApplicationAllocation[]
  ledgerEntries        LeaveLedgerEntry[]
  @@index([employeeId, fromDate, toDate])
  @@index([status])
}

model LeaveApplicationDay {
  id              Int              @id @default(autoincrement())
  applicationId   Int
  date            DateTime         @db.Date
  portion         DayPortion
  units           Decimal          @db.Decimal(12, 4)
  application     LeaveApplication @relation(fields: [applicationId], references: [id])
  @@unique([applicationId, date])
}

model LeaveApplicationAllocation {
  id            Int                      @id @default(autoincrement())
  applicationId Int
  entitlementId Int
  units         Decimal                  @db.Decimal(12, 4)
  application   LeaveApplication         @relation(fields: [applicationId], references: [id])
  entitlement   EmployeeLeaveEntitlement @relation(fields: [entitlementId], references: [id])
}

model CreditLeaveRequest {
  id              Int              @id @default(autoincrement())
  referenceNumber String           @unique
  kind            CreditLeaveKind
  employeeId      Int
  leaveTypeId     Int
  workedFrom      DateTime         @db.Date
  workedTo        DateTime         @db.Date
  units           Decimal          @db.Decimal(12, 4)
  reason          String
  status          ProcessStatus    @default(DRAFT)
  processId       Int?             @unique
  version         Int              @default(1)
  createdAt       DateTime         @default(now()) @db.Timestamptz(6)
  employee        Employee         @relation(fields: [employeeId], references: [id])
  leaveType       LeaveType        @relation(fields: [leaveTypeId], references: [id])
  process         WorkflowProcess? @relation(fields: [processId], references: [id])
}

// ───────────── Claims ─────────────
model ClaimGroup {
  id                  Int         @id
  code                String      @unique
  description         String
  attachmentMandatory Boolean     @default(false)
  isActive            Boolean     @default(true)
  claimTypes          ClaimType[]
  claims              Claim[]
}

model ClaimType {
  id                 Int                      @id
  groupId            Int
  code               String
  description        String
  inputMode          ClaimInputMode
  rate               Decimal?                 @db.Decimal(14, 4)
  rateMultiplier     Decimal?                 @db.Decimal(6, 4)
  payrollCode        String?
  requiresAttachment Boolean                  @default(false)
  isActive           Boolean                  @default(true)
  group              ClaimGroup               @relation(fields: [groupId], references: [id])
  caps               ClaimCap[]
  lines              ClaimLine[]
  adjustments        ClaimBalanceAdjustment[]
  @@unique([groupId, code])
}

model ClaimCap {
  id            Int          @id @default(autoincrement())
  claimTypeId   Int
  companyRuleId Int?
  cycle         CapCycle
  mode          CapMode      @default(NO_CAP)
  amountLimit   Decimal?     @db.Decimal(14, 2)
  quantityLimit Decimal?     @db.Decimal(12, 4)
  proRata       Boolean      @default(false)
  claimType     ClaimType    @relation(fields: [claimTypeId], references: [id])
  companyRule   CompanyRule? @relation(fields: [companyRuleId], references: [id])
}

model Claim {
  id              Int              @id @default(autoincrement())
  referenceNumber String           @unique
  employeeId      Int
  groupId         Int
  description     String?
  totalAmount     Decimal          @default(0) @db.Decimal(14, 2)
  warnings        Json?
  status          ProcessStatus    @default(DRAFT)
  processId       Int?             @unique
  payPeriodId     Int?
  submittedAt     DateTime?        @db.Timestamptz(6)
  processedAt     DateTime?        @db.Timestamptz(6)
  version         Int              @default(1)
  createdAt       DateTime         @default(now()) @db.Timestamptz(6)
  updatedAt       DateTime         @updatedAt @db.Timestamptz(6)
  employee        Employee         @relation(fields: [employeeId], references: [id])
  group           ClaimGroup       @relation(fields: [groupId], references: [id])
  process         WorkflowProcess? @relation(fields: [processId], references: [id])
  payPeriod       PayPeriod?       @relation(fields: [payPeriodId], references: [id])
  lines           ClaimLine[]
  @@index([employeeId, status])
}

model ClaimLine {
  id          Int       @id @default(autoincrement())
  claimId     Int
  claimTypeId Int
  date        DateTime  @db.Date
  startTime   String?
  endTime     String?
  quantity    Decimal?  @db.Decimal(12, 4)
  rate        Decimal?  @db.Decimal(14, 4)
  amount      Decimal   @db.Decimal(14, 2)
  description String?
  sortOrder   Int       @default(0)
  claim       Claim     @relation(fields: [claimId], references: [id])
  claimType   ClaimType @relation(fields: [claimTypeId], references: [id])
}

model ClaimBalanceAdjustment {
  id              Int       @id @default(autoincrement())
  employeeId      Int
  claimTypeId     Int
  cycleStartDate  DateTime  @db.Date
  amount          Decimal   @default(0) @db.Decimal(14, 2)
  quantity        Decimal   @default(0) @db.Decimal(12, 4)
  reason          String
  createdByUserId String
  createdAt       DateTime  @default(now()) @db.Timestamptz(6)
  employee        Employee  @relation(fields: [employeeId], references: [id])
  claimType       ClaimType @relation(fields: [claimTypeId], references: [id])
}

// ───────────── Payroll outputs ─────────────
model PayPeriod {
  id                   Int                   @id @default(autoincrement())
  companyRuleId        Int
  description          String
  startDate            DateTime              @db.Date
  endDate              DateTime              @db.Date
  payDate              DateTime?             @db.Date
  isClosed             Boolean               @default(false)
  companyRule          CompanyRule           @relation(fields: [companyRuleId], references: [id])
  payslips             Payslip[]
  leaveApplications    LeaveApplication[]
  ledgerEntries        LeaveLedgerEntry[]
  claims               Claim[]
  employeeTransactions EmployeeTransaction[]
  @@unique([companyRuleId, startDate])
}

model Payslip {
  id               Int           @id @default(autoincrement())
  employeeId       Int
  payPeriodId      Int
  payRun           String
  runType          String        @default("Normal")
  ruleLabel        String?
  currency         String        @default("NAD")
  grossPay         Decimal       @db.Decimal(14, 2)
  totalDeductions  Decimal       @db.Decimal(14, 2)
  netPay           Decimal       @db.Decimal(14, 2)
  pdfAttachmentId  String?
  pdfSha256        String?
  publishedAt      DateTime      @default(now()) @db.Timestamptz(6)
  employee         Employee      @relation(fields: [employeeId], references: [id])
  payPeriod        PayPeriod     @relation(fields: [payPeriodId], references: [id])
  lines            PayslipLine[]
  @@unique([employeeId, payPeriodId, payRun])
}

model PayslipLine {
  id        Int                 @id @default(autoincrement())
  payslipId Int
  category  PayslipLineCategory
  code      String
  description String
  quantity  Decimal?            @db.Decimal(12, 4)
  rate      Decimal?            @db.Decimal(14, 4)
  amount    Decimal             @db.Decimal(14, 2)
  ytdAmount Decimal?            @db.Decimal(14, 2)
  sortOrder Int                 @default(0)
  payslip   Payslip             @relation(fields: [payslipId], references: [id])
}

model TaxCertificate {
  id              Int      @id @default(autoincrement())
  employeeId      Int
  taxYear         Int
  certificateType String
  pdfAttachmentId String
  pdfSha256       String
  issuedAt        DateTime @default(now()) @db.Timestamptz(6)
  employee        Employee @relation(fields: [employeeId], references: [id])
  @@unique([employeeId, taxYear, certificateType])
}

model EmployeeTransaction {
  id          Int              @id @default(autoincrement())
  employeeId  Int
  code        String
  description String
  amount      Decimal?         @db.Decimal(14, 2)
  quantity    Decimal?         @db.Decimal(12, 4)
  payPeriodId Int?
  isRecurring Boolean          @default(false)
  status      ProcessStatus    @default(PROCESSED)
  processId   Int?             @unique
  createdAt   DateTime         @default(now()) @db.Timestamptz(6)
  employee    Employee         @relation(fields: [employeeId], references: [id])
  payPeriod   PayPeriod?       @relation(fields: [payPeriodId], references: [id])
  process     WorkflowProcess? @relation(fields: [processId], references: [id])
}

// ───────────── Free text ─────────────
model FreeTextType {
  id                      Int               @id @default(autoincrement())
  code                    String            @unique
  description             String
  requiresSubjectEmployee Boolean           @default(false)
  isActive                Boolean           @default(true)
  requests                FreeTextRequest[]
}

model FreeTextRequest {
  id                 Int              @id @default(autoincrement())
  referenceNumber    String           @unique
  typeId             Int
  applicantId        Int
  aboutEmployeeId    Int?
  body               String
  status             ProcessStatus    @default(DRAFT)
  processId          Int?             @unique
  version            Int              @default(1)
  createdAt          DateTime         @default(now()) @db.Timestamptz(6)
  type               FreeTextType     @relation(fields: [typeId], references: [id])
  applicant          Employee         @relation("FreeTextApplicant", fields: [applicantId], references: [id])
  aboutEmployee      Employee?        @relation("FreeTextSubject", fields: [aboutEmployeeId], references: [id])
  process            WorkflowProcess? @relation(fields: [processId], references: [id])
}

// ───────────── Performance ─────────────
model ParameterValue {
  id          Int              @id @default(autoincrement())
  tableName   String
  code        String
  description String
  parentId    Int?
  status      String           @default("A")
  sortOrder   Int              @default(0)
  parent      ParameterValue?  @relation("ParamParent", fields: [parentId], references: [id])
  children    ParameterValue[] @relation("ParamParent")
  @@unique([tableName, code])
}

model RatingScale {
  id        Int                   @id @default(autoincrement())
  name      String                @unique
  points    Json
  templates PerformanceTemplate[]
}

model PerformanceTemplate {
  id                     Int                       @id @default(autoincrement())
  name                   String
  contractStartDate      DateTime                  @db.Date
  contractEndDate        DateTime                  @db.Date
  ratingScaleId          Int?
  processDefinition      String?
  ownerUserId            String
  createdFromTemplateId  Int?
  status                 TemplateStatus            @default(DRAFT)
  version                Int                       @default(1)
  createdAt              DateTime                  @default(now()) @db.Timestamptz(6)
  ratingScale            RatingScale?              @relation(fields: [ratingScaleId], references: [id])
  createdFrom            PerformanceTemplate?      @relation("TemplateCopy", fields: [createdFromTemplateId], references: [id])
  copies                 PerformanceTemplate[]     @relation("TemplateCopy")
  items                  PerformanceTemplateItem[]
  initiations            ContractInitiation[]
  contracts              PerformanceContract[]
}

model PerformanceTemplateItem {
  id               Int                 @id @default(autoincrement())
  templateId       Int
  kind             TemplateItemKind
  parameterValueId Int?
  title            String
  weight           Decimal             @db.Decimal(6, 2)
  target           String?
  sortOrder        Int                 @default(0)
  template         PerformanceTemplate @relation(fields: [templateId], references: [id])
}

model ContractInitiation {
  id                Int                   @id @default(autoincrement())
  name              String
  templateId        Int
  contractStartDate DateTime              @db.Date
  contractEndDate   DateTime              @db.Date
  filters           Json
  status            InitiationStatus      @default(QUEUED)
  contractCount     Int                   @default(0)
  createdCount      Int                   @default(0)
  failedCount       Int                   @default(0)
  errors            Json?
  createdByUserId   String
  createdAt         DateTime              @default(now()) @db.Timestamptz(6)
  updatedAt         DateTime              @updatedAt @db.Timestamptz(6)
  template          PerformanceTemplate   @relation(fields: [templateId], references: [id])
  contracts         PerformanceContract[]
}

model PerformanceContract {
  id                      Int                       @id @default(autoincrement())
  employeeId              Int
  templateId              Int
  initiationId            Int?
  name                    String
  contractType            String?
  startDate               DateTime                  @db.Date
  endDate                 DateTime                  @db.Date
  status                  ContractStatus            @default(DRAFT)
  currentlyAssignedUserId String?
  archivedAt              DateTime?                 @db.Timestamptz(6)
  version                 Int                       @default(1)
  employee                Employee                  @relation(fields: [employeeId], references: [id])
  template                PerformanceTemplate       @relation(fields: [templateId], references: [id])
  initiation              ContractInitiation?       @relation(fields: [initiationId], references: [id])
  items                   PerformanceContractItem[]
  reviews                 Review[]
}

model PerformanceContractItem {
  id         Int                 @id @default(autoincrement())
  contractId Int
  kind       TemplateItemKind
  title      String
  weight     Decimal             @db.Decimal(6, 2)
  target     String?
  sortOrder  Int                 @default(0)
  contract   PerformanceContract @relation(fields: [contractId], references: [id])
  scores     ReviewScore[]
}

model Review {
  id              Int                  @id @default(autoincrement())
  contractId      Int?
  name            String
  category        String
  type            String
  cycleStartDate  DateTime             @db.Date
  cycleEndDate    DateTime             @db.Date
  notifyMode      ReviewNotifyMode     @default(IMMEDIATELY)
  notifyDate      DateTime?            @db.Date
  isFreeFormat    Boolean              @default(false)
  status          ReviewStatus         @default(DRAFT)
  totalActual     Decimal?             @db.Decimal(8, 4)
  createdByUserId String
  version         Int                  @default(1)
  createdAt       DateTime             @default(now()) @db.Timestamptz(6)
  updatedAt       DateTime             @updatedAt @db.Timestamptz(6)
  contract        PerformanceContract? @relation(fields: [contractId], references: [id])
  participants    ReviewParticipant[]
  objectives      ReviewObjective[]
  scores          ReviewScore[]
}

model ReviewParticipant {
  id         Int             @id @default(autoincrement())
  reviewId   Int
  role       ParticipantRole
  employeeId Int?
  userId     String?
  weight     Decimal?        @db.Decimal(6, 2)
  review     Review          @relation(fields: [reviewId], references: [id])
  employee   Employee?       @relation(fields: [employeeId], references: [id])
}

model ReviewObjective {
  id          Int           @id @default(autoincrement())
  reviewId    Int
  title       String
  description String?
  weight      Decimal       @db.Decimal(6, 2)
  sortOrder   Int           @default(0)
  review      Review        @relation(fields: [reviewId], references: [id])
  scores      ReviewScore[]
}

model ReviewScore {
  id             Int                      @id @default(autoincrement())
  reviewId       Int
  contractItemId Int?
  objectiveId    Int?
  reviewerUserId String
  rating         Decimal?                 @db.Decimal(6, 2)
  comment        String?
  submittedAt    DateTime?                @db.Timestamptz(6)
  review         Review                   @relation(fields: [reviewId], references: [id])
  contractItem   PerformanceContractItem? @relation(fields: [contractItemId], references: [id])
  objective      ReviewObjective?         @relation(fields: [objectiveId], references: [id])
}

// ───────────── Platform ─────────────
model Attachment {
  id               String    @id @default(uuid())
  ownerEntity      String
  ownerEntityId    String
  fileName         String
  mimeType         String
  sizeBytes        Int
  sha256           String
  storageKey       String    @unique
  uploadedByUserId String
  createdAt        DateTime  @default(now()) @db.Timestamptz(6)
  deletedAt        DateTime? @db.Timestamptz(6)
  uploadedBy       User      @relation(fields: [uploadedByUserId], references: [id])
  @@index([ownerEntity, ownerEntityId])
}

model Notification {
  id        String    @id @default(uuid())
  userId    String
  kind      String
  title     String
  body      String
  link      String?
  readAt    DateTime? @db.Timestamptz(6)
  createdAt DateTime  @default(now()) @db.Timestamptz(6)
  user      User      @relation(fields: [userId], references: [id])
  @@index([userId, readAt])
}

model DashboardLayout {
  userId    String   @id
  widgets   Json
  updatedAt DateTime @updatedAt @db.Timestamptz(6)
  user      User     @relation(fields: [userId], references: [id])
}

model ReferenceSequence {
  key       String @id
  lastValue Int
}

model SystemSetting {
  key             String   @id
  value           Json
  updatedByUserId String?
  updatedAt       DateTime @updatedAt @db.Timestamptz(6)
}

model AuditLog {
  id                 BigInt        @id @default(autoincrement())
  occurredAt         DateTime      @default(now()) @db.Timestamptz(6)
  requestId          String?
  sessionId          String?
  actorUserId        String?
  actorUsername      String?
  actingAsEmployeeId Int?
  subjectEmployeeId  Int?
  category           AuditCategory
  action             String
  entityType         String?
  entityId           String?
  outcome            AuditOutcome  @default(SUCCESS)
  before             Json?
  after              Json?
  changes            Json?
  reason             String?
  ip                 String?
  userAgent          String?
  metadata           Json?
  prevHash           String?
  hash               String        @unique
  @@index([occurredAt])
  @@index([entityType, entityId])
  @@index([actorUserId, occurredAt])
  @@index([subjectEmployeeId, occurredAt])
  @@index([category, action])
}

model AuditAnchor {
  day        DateTime @id @db.Date
  lastAuditId BigInt
  lastHash   String
  createdAt  DateTime @default(now()) @db.Timestamptz(6)
}
```

Schema notes for Claude Code:
- The `LeaveLedgerEntry` unique key includes the nullable `leaveApplicationId`. Postgres treats NULLs as distinct, so for accrual idempotency also add a **partial unique index** in raw SQL: `CREATE UNIQUE INDEX ux_ledger_accrual ON "LeaveLedgerEntry"("entitlementId","entryType","effectiveDate") WHERE "leaveApplicationId" IS NULL;`
- Add the audit trigger/grant SQL from section 9.3 in a migration named `audit_immutability`.
- Add a raw-SQL `CHECK ("toDate" >= "fromDate")` on `LeaveApplication` and `CreditLeaveRequest`.
- Add a DB trigger that also blocks UPDATE/DELETE on `LeaveLedgerEntry` and `WorkflowAction`, since both are append-only.

---

## 12. REST API (`/api/v1`)

All endpoints require a session unless marked *public*. "Scope" means the security context in section 4 is applied.

### 12.1 Auth and session
```
POST   /auth/login                  public  {username,password,profile:'LOCAL'}  → sets cookie
GET    /auth/oidc/start             public
GET    /auth/oidc/callback          public
POST   /auth/logout
POST   /auth/password/forgot        public  {usernameOrEmail}   (always 202)
POST   /auth/password/reset         public  {token,newPassword}
POST   /auth/password/change        {currentPassword,newPassword}
GET    /session                     → {user, roles, selfEmployee, actingAs, settings:{idleMinutes,warnSeconds}}
POST   /session/activity            heartbeat
GET    /session/acting-as/options   → grid rows {employeeId,name,knownAs,employeeCode,companyRule,status}
PUT    /session/acting-as           {employeeId}
```
### 12.2 Dashboard
```
GET /dashboard/layout · PUT /dashboard/layout
GET /dashboard/summary  → {latestPayslip, latestTaxCertificate, submittedCounts:{leave,claims}, onLeaveToday, upcomingBirthdays}
GET /calendar/leave?from=&to=&scope=self|reports   · GET /calendar/leave/export?from=&to=&scope=&format=csv|xlsx
GET /holidays?from=&to=
GET /birthdays/upcoming?days=30
```
### 12.3 Leave
```
GET  /leave/types                         (for acting-as employee, with ESS visibility flags)
GET  /leave/types/:id/reasons
GET  /leave/balances                      cards
GET  /leave/balances/:leaveTypeId/definitions   bucket grid
POST /leave/calculate                     {employeeId,leaveTypeId,fromDate,toDate,startPortion,endPortion} → {units, days[], available, toBeDeducted, remaining}
POST /leave/applications                  submit (Idempotency-Key)
GET  /leave/applications?status=completed|inProgress
GET  /leave/applications/:id
POST /leave/applications/:id/cancel       {comment}
POST /leave/in-lieu                        {kind,employeeId,workedFrom,workedTo,units,reason,attachmentIds}
GET  /leave/in-lieu
```
### 12.4 Claims
```
GET  /claims/groups                       tiles with counts + canStart
GET  /claims/groups/:id/setup             types, caps, mandatory attachment flags
GET  /claims/saved
POST /claims                              create draft
PUT  /claims/:id                          update draft (version)
POST /claims/:id/submit                   (Idempotency-Key)
POST /claims/:id/cancel
GET  /claims?type=&description=&status=&from=&to=
GET  /claims/:id
GET  /claims/balances
```
### 12.5 My details
```
GET /me/personal            PUT → creates ChangeRequest (BASICINF)
GET /me/bank-accounts       POST/PUT → ChangeRequest (BANKDET)
GET /me/bank-accounts/:id/unmasked   PAYROLL_ADMIN + reason (audited)
GET /banks · GET /banks/:id/branches
GET /me/drivers-licences    POST/PUT/DELETE → ChangeRequest (DRIVERSLICENSE)
GET /me/family              POST/PUT/DELETE → ChangeRequest (BASICINF)
GET /me/funds               PUT /me/funds/:membershipId/beneficiaries → ChangeRequest (BENEFICIARY)
GET /me/transactions
GET /me/change-requests?status=
GET /lookups/:table         countries, languages, titles, marital, bloodGroups, religions, relationships, licenceCodes
```
(`/me` resolves to the acting-as employee, subject to the restricted-feature list.)
### 12.6 Payslips and tax
```
GET /payslips?page=   · GET /payslips/:id (meta) · GET /payslips/:id/pdf   (audited)
GET /tax-certificates · GET /tax-certificates/:id/pdf (audited)
```
### 12.7 Inbox and workflow
```
GET  /inbox/categories                    counts per type for submitted/approvals
GET  /inbox/items?box=action|submitted|history&type=LEAVE&sort=&filter=
GET  /inbox/items/:processId              detail (subject DTO + attachments + comments)
GET  /workflow/processes/:id/history      approval history DTO + rendered text
POST /workflow/processes/:id/approve      {comment?,version}
POST /workflow/processes/:id/decline      {comment,version}
POST /workflow/processes/:id/reassign     {toUserId,comment?,version}
POST /workflow/processes/:id/park         {until,comment?,version}
POST /workflow/processes/:id/send-back    {comment,version}
POST /workflow/processes/:id/resubmit     {version, changes?}
POST /workflow/processes/:id/withdraw     {version}
POST /workflow/processes/bulk-approve     {items:[{id,version}],comment?}
POST /workflow/processes/process          PAYROLL_ADMIN {ids[],payPeriodId}
GET  /notifications · POST /notifications/:id/read · POST /notifications/read-all
```
### 12.8 Free text and out of office
```
GET /free-text/types · POST /free-text · GET /free-text
GET /profile/out-of-office · PUT /profile/out-of-office
```
### 12.9 Performance
```
GET/POST/PUT /performance/reviews · POST /performance/reviews/:id/copy · GET /performance/results
GET/POST/PUT /performance/templates · POST /performance/templates/:id/copy
GET/POST /performance/contract-initiations   (POST enqueues job) · GET /performance/contract-initiations/:id
GET /performance/contracts?archived=false|true · GET/PUT /performance/contracts/:id · POST /performance/contracts/:id/archive
GET /performance/contract-reviews?companies=&companyRules=&employees=&positions=&reviewTypes=&reviewCategories=&reviewName=&statuses=&startFrom=&startTo=&endFrom=&endTo=
POST /performance/reviews/:id/scores
GET /lookups/parameters/:table
```
### 12.10 Admin (HR/Payroll/System)
```
CRUD /admin/employees (+ /:id/terminate) · /admin/users (+roles, unlock, reset) · /admin/companies · /admin/company-rules
CRUD /admin/leave-types · /admin/leave-reasons · /admin/leave-policies · POST /admin/leave/adjustments · POST /admin/leave/opening-balances/import
CRUD /admin/public-holidays · /admin/claim-groups · /admin/claim-types · /admin/claim-caps · POST /admin/claims/adjustments
CRUD /admin/workflow-definitions (+steps) · /admin/free-text-types · /admin/parameters/:table · /admin/banks (+branches) · /admin/retirement-funds
CRUD /admin/pay-periods (+close) · POST /admin/payslips/import · POST /admin/tax-certificates/import
GET/PUT /admin/settings
POST /admin/import/employees (CSV, dry-run first, then commit; every row audited)
```
### 12.11 Reports and audit
```
GET  /reports                          catalogue filtered by role
POST /reports/:code/run                {params, format:'json'|'pdf'|'xlsx'|'csv'}  (streams)
GET  /audit?…filters                   AUDITOR/SYSTEM_ADMIN
GET  /audit/:id
GET  /audit/entity/:entityType/:entityId
GET  /audit/verify?from=&to=
POST /audit/export                     {filters, format}
```

---

## 13. Frontend (`apps/web`)
- **Layout: side menu, not a top menu.** This replaces Sage's horizontal dropdown menu. The menu items and routes are the same as in section 1.2, but they are arranged as a vertical side menu:
  - **Left sidebar**, fixed, 240px wide, full height. The company logo and product name sit at the top.
  - Each top-level menu from section 1.2 (Home, Leave, Claims, My Details, Payslips, Reports, Free Text Workflow, Performance, My Tax Certificates, then Admin and Audit when the role allows) is a sidebar entry with a single-colour line icon (lucide-react) and a label.
  - Entries with children (Leave, Claims, My Details, Performance, Admin) expand and collapse in place as an indented sub-list. No flyout or hover menus. The group that holds the current route opens automatically, and the expanded state is remembered per user in `localStorage`.
  - The active item has a solid 3px left border in the accent colour and a slightly darker background. There is no pill or rounded highlight.
  - The bottom of the sidebar holds the "Working as" picker, Profile settings (Out of office, Change password, Setup mobile, Help, Sign out), and the version and username, which replaces the footer.
  - **Collapse toggle:** the sidebar can shrink to a 64px icon-only rail, with a tooltip on each icon. The state is remembered per user.
  - **Below 1024px:** the sidebar becomes an off-canvas drawer opened by a hamburger button in a slim top bar. The drawer closes when a route is chosen or Esc is pressed.
  - The sidebar is keyboard operable: arrow keys move between items, Enter/Space opens a group, and there is a visible focus ring. Use `aria-current="page"` and `aria-expanded`.
  - **Slim top bar** over the content area (48px): page title and breadcrumb on the left, and Inbox with an unread count plus notifications on the right.
  - Inbox (section 5.10) keeps its own inner category list, shown as a second, narrower panel next to the main sidebar.
  - A "Working as" banner shows when acting for someone, as a full-width flat strip under the top bar.
  - Idle-timeout modal with countdown and "Stay signed in".
- **Visual style: square, flat and minimal.** This is required for every screen and component.
  - **Square corners everywhere:** set `border-radius: 0` on buttons, inputs, selects, cards, modals, drawers, badges, tabs, dropdowns, toasts, tooltips, date pickers and table containers. In Tailwind, set every `theme.borderRadius` key to `0` (keep only `full` for avatars and status dots). Override the shadcn/ui `--radius` to `0rem`.
  - **Flat:** no drop shadows, gradients, glows, glassmorphism or 3D effects. Set the Tailwind `boxShadow` theme to `none`. Separate things with 1px solid borders (`#E5E7EB` light / `#2A2F36` dark) and background tone, never elevation. Modals use a flat translucent backdrop and a bordered panel.
  - **Minimal:** generous whitespace (8px spacing grid), at most one primary action per view, and secondary actions as outline or text buttons. No decorative illustrations. Icons only where they help scanning.
  - **Colour:** a neutral greyscale base plus **one** accent colour, configurable from company settings (default `#0F766E`). Semantic colours are used only for status: success `#15803D`, warning `#B45309`, danger `#B91C1C`, info `#1D4ED8`. Leave-type colours (section 14) are used only as small square swatches on the calendar and in badges.
  - **Typography:** a single sans-serif family (Inter, self-hosted). Sizes are 12, 14 (body), 16, 20 and 24. Weights are 400, 500 and 600 only. Numbers in tables and balances use `font-variant-numeric: tabular-nums`, right-aligned.
  - **Components:** buttons are 36px high and square. Inputs have a 1px border that becomes the accent colour on focus, plus a 2px accent focus outline (WCAG-visible). Tables have a bordered header row, no zebra striping, and a hover tint. Status badges are square, outlined, and uppercase at 12px. Dashboard widgets are flat bordered panels with a title row, with no shadows.
  - **Light and dark themes**, both flat. Define colours as CSS variables in `apps/web/src/styles/tokens.css` and use only those tokens; no hard-coded colours in components.
  - Add a `docs/UI_GUIDELINES.md` that records these rules. Add a Playwright visual check that fails if any rendered element has a computed `border-radius` other than `0px` (excluding avatars and status dots marked `data-round`) or a `box-shadow` other than `none`.
- **Feature folders:** `dashboard, leave, claims, details, payslips, tax, reports, freeText, performance, inbox, profile, admin, audit`.
- **Data:** TanStack Query hooks generated from the shared Zod contracts (`packages/shared/src/api/*.ts`). Invalidate the relevant queries after mutations. Handle 409 by showing "This record changed; reload" with a diff.
- **Forms:** react-hook-form + zodResolver using the **same** schemas as the API. Server 422 errors map to fields.
- **Grids:** one reusable `DataGrid` (column filters, sort, pagination, column settings, CSV export that calls the audited server export).
- **Date pickers:** Monday-first week, dd-MMM-yyyy display, public holidays shaded.
- **Leave Apply:** debounce `POST /leave/calculate` by 300ms on any change. Disable Submit while calculating.
- **PDF preview:** use `<iframe>` on a blob URL from `/payslips/:id/pdf`.
- **Empty states** reuse the source's wording (quoted in section 5).
- **Admin screens:** list + edit drawer per entity, each with a "History" tab (audit).
- **Branding:** the accent colour and logo come from company settings, inside the flat, square, minimal rules above. Do not copy Sage logos, trademarks or Sage's visual design.

---

## 14. Seed data (`pnpm db:seed`, idempotent)
- Company `DEMO` "Demo Company (Pty) Ltd", currency NAD; company rule `STAFF` ("Staff").
- Users and employees: 1 HR admin, 1 payroll admin, 1 system admin, 1 auditor, 2 managers (manager B reports to manager A), and 6 employees reporting to manager B. Use fake names generated with `@faker-js/faker` and a fixed seed. **Never use real people's data.** Print the dev passwords to the console only in `NODE_ENV=development`.
- Leave types: the 12 observed, with these ids, codes and colours:
  `1 ANN_LVE Annual Leave #C0FFC0 · 2 SICK_LVE Sick Leave #FFFFC0 · 3 DC_LVE Discretionary Leave #80FF80 · 4 COMP_LVE Compassionate Leave #C0C0FF · 5 MAT_LVE Maternity Leave #FFC0FF · 6 STUDY Study Leave #FFE0C0 · 7 PAT_LVE Paternity Leave #C0FFFF · 8 SPORT_LVE Sports Leave #FFC080 · 9 UNPD_LVE Unpaid Leave · 10 RESET_LVE Resettlement Leave · 11 LOST_LVE Lost Leave #FFC0C0 · 12 UN_SICK Unpaid Sick Leave #8080FF`
- Policies (ASSUMPTION; HR edits these): Annual 20 days, MONTHLY_PRO_RATA, max carry forward 5, carry-forward expiry 6 months. Sick 34 days over a 36-month cycle, UPFRONT, attachment required after 2 days. Compassionate 10 UPFRONT. Paternity 3 UPFRONT. Resettlement 4 UPFRONT. Sports 10 UPFRONT. Study 12 UPFRONT, attachment required. Maternity 84 UPFRONT. Discretionary, Lost, Unpaid and Unpaid Sick 0 with allowNegative=false (Unpaid types allowNegative=true, maxNegative 365).
- The 16 workflow types (section 1.3). A default 2-step definition for each (Step 1 REPORTS_TO mandatory; Step 2 ROLE HR_ADMIN mandatory). BASICINF and BANKDET use Step 2 = ROLE PAYROLL_ADMIN.
- Claim groups and types (section 5.3.1) with `NO_CAP` caps.
- Banks (observed list) and the observed branch names.
- Free text type `ONBOARD_ARRIVAL` "Onboarding Arrival Update".
- Parameter tables: ReviewCategory (`ANNUAL`, `PROBATION`, `MIDYEAR`), ReviewType (`SELF`, `MANAGER`, `360`), plus samples for the KPA/KPI/Competency tables.
- Rating scale "1–5": `[{value:1,label:"Unacceptable"},…,{value:5,label:"Outstanding"}]`.
- **Namibian public holidays 2026** (company = null). HR must verify these against the official Government Gazette each year; the seed prints a reminder.
  `2026-01-01 New Year's Day · 2026-03-21 Independence Day · 2026-04-03 Good Friday · 2026-04-06 Easter Monday · 2026-05-01 Workers' Day · 2026-05-04 Cassinga Day · 2026-05-14 Ascension Day · 2026-05-25 Africa Day · 2026-05-28 Genocide Remembrance Day · 2026-08-26 Heroes' Day · 2026-12-10 Human Rights Day · 2026-12-25 Christmas Day · 2026-12-26 Family Day`.
  Rule: a holiday that falls on a Sunday is observed on the Monday. Implement this as `observedDate` logic in `HolidayService` and generate future years from a rules table (fixed dates plus Easter-relative dates, using the Anonymous Gregorian computus).
- Opening leave balances that reproduce the section 1.7 fixtures for one demo employee (BF 2.1691 on Annual; Study entitlement 12).

---

## 15. Observability and operations
- `GET /health` (liveness) and `GET /ready` (DB and queue).
- Prometheus metrics at `/metrics`: request latency, job durations, workflow counts by status, audit insert latency.
- `docs/RUNBOOK.md` covers backup (pg_dump plus WAL), restore drill, key rotation, audit verification, and how to re-run failed jobs.
- Ship a Dockerfile per app (multi-stage, non-root user) and `docker-compose.yml` for local use.

---

## 16. Tests (required; CI gates)

### 16.1 Unit (Vitest), at least 90% line coverage on `packages/shared` and on domain services
- `calculateUnits`: weekends, public holidays, Sunday→Monday observed holidays, AM/PM start/end, single-day AM, cross-month and cross-year ranges, and a range of only holidays (0 → 422).
- Balance maths reproduces the section 1.7 fixtures exactly (`2.1691 + 1.6667 = 3.8358`; study `12 − 9 = 3`; the "8 available" snapshot).
- Accrual rounding and pro-rata for first and last months; idempotent re-run.
- Cycle rollover: carry-forward cap, forfeit, expiry.
- Bucket allocation order (oldest `cycleEndDate` first).
- Reference number formatting (`E000077-T0006-N00005`) and concurrency (100 parallel submits → 100 unique numbers).
- Claim cap modes (NO_CAP, WARN, BLOCK) and pro-rata.
- Beneficiary percentages = 100.00.
- `redact()` policies for every model.
- Audit hash chain: tampering with any row is detected by `verify`.

### 16.2 API integration (Supertest + Testcontainers)
- **Authorisation matrix:** for every endpoint × role × (self / report / non-report / other company), assert the allowed and forbidden outcomes. Every 403 writes a `DENIED` audit row.
- Full leave lifecycle: submit → step 1 approve → step 2 approve → "Approved, Pending Process" → process → ledger TAKEN → cancel → CANCELLEAVE approve and process → reversal. Every step has its audit rows and the correct approval history text.
- Out-of-office delegation, per-type override, cycle protection, and that the applicant cannot approve their own request.
- Optimistic locking returns 409. Idempotency-Key replay returns the same response.
- ChangeRequest conflict path (`CONFLICT` status).
- Audit table: `UPDATE "AuditLog"` and `DELETE` fail at the DB level.
- Viewing a payslip as acting-as returns 403 by default.

### 16.3 E2E (Playwright)
Login → dashboard widgets → apply leave (balance panel updates) → manager approves in the inbox → HR approves → payroll processes → the employee sees it in History → the auditor sees the full trail and verifies the chain. A claim draft → submit → approve. A bank change → approve → masked display → notification email captured in Mailpit.

---

## 17. Build phases (do them in order; each ends with green CI and a commit)

1. **Foundation:** monorepo, lint, tsconfig, docker-compose, Prisma schema + migrations (including the raw-SQL triggers, checks and partial index), seed skeleton, `AuditService` (hash chain, redaction, Prisma extension, verify CLI), encryption service, request context, error format, health, OpenAPI. *Acceptance:* `prisma validate` passes; audit immutability and chain tests pass.
2. **Auth and session:** local + OIDC login, lockout, password policy and history, reset, idle timeout, CSRF, acting-as with scoping guard, roles. Web shell built to the section 13 rules: design tokens, the square/flat Tailwind and shadcn overrides, the collapsible left side menu with rail and mobile drawer, the slim top bar, the login page, the timeout modal, and the acting-as picker in the sidebar. The radius/shadow Playwright check runs from this phase onward. *Acceptance:* auth tests and authorisation-matrix skeleton pass.
3. **Workflow engine:** definitions, resolution, step instances, all actions, out of office, escalation and park jobs, outbox, notifications, inbox API and inbox UI with approval-history modal. *Acceptance:* engine tests pass with a fake subject handler.
4. **Leave:** types, policies, entitlements, ledger, calculation, apply UI with live balance panel, balances page, history, cancel and CANCELLEAVE, leave in lieu, accrual and rollover jobs, holidays, dashboard calendar. *Acceptance:* section 16.1 leave tests and the lifecycle integration test pass.
5. **Claims:** groups, types, caps, drafts, submit, processing, transactions list, balances.
6. **My Details:** personal, bank, licences, family, beneficiaries, transactions, all through ChangeRequest; masked display; unmask flow.
7. **Payslips, tax certificates, dashboard widgets, reports framework and all listed reports, exports.**
8. **Performance:** lookups, templates, initiation job, contracts and archive, reviews wizard, scoring, results, contract reviews filter.
9. **Admin and audit UI:** all admin CRUD with history tabs, settings, imports, audit explorer and verify, docs (`ARCHITECTURE.md`, `AUDIT.md`, `RUNBOOK.md`, `ASSUMPTIONS.md`), and the e2e suite. Backlog: TRAINING, QUALIFICATION, JOBREQUISITION, CHECKLISTITEM screens.

**Definition of done for the whole build:** all phases are green; `pnpm audit:verify` passes on the seeded and exercised database; the e2e suite passes; `docs/ASSUMPTIONS.md` lists every ASSUMPTION from this spec and any new ones; there are no `TODO`/`FIXME` in `src`.

---

## 18. Open points to confirm with the business (do not block the build; implement the ASSUMPTION)
1. The exact field layout of Leave in Lieu, Employee Transactions and Drivers Licence forms (their submenus or forms did not render during mapping).
2. Whether family-detail changes use `BASICINF` or a separate workflow.
3. The real leave policies (cycle lengths, carry-forward caps, sick cycle) per company rule. Only Annual (20 days per year with monthly accrual) is confirmed.
4. Whether managers may act for indirect reports, and which features are blocked while acting as someone else.
5. Claim type → group mapping, rates, and caps.
6. Payslip PDF layout. The source renders an embedded PDF whose contents were intentionally not captured.
7. The list of bank branch codes.
