# PeopleHub ESS: API

This repository holds the back end of PeopleHub ESS, an Employee Self-Service system: the NestJS API (`apps/api`) and the shared Zod contracts (`packages/shared`). The React web app is in the sibling repository [HRSystemOfficeFE](https://github.com/konizanam/HRSystemOfficeFE). The full specification is in [BUILD_SPEC.md](BUILD_SPEC.md).

## Stack

- Node 22+, pnpm workspaces, Turborepo
- NestJS 11 on Fastify, Prisma 6, PostgreSQL 16+
- Zod for validation (`nestjs-zod`) and OpenAPI 3.1 docs at `/api/docs`
- pg-boss for background jobs, pdfmake and exceljs for exports, nodemailer for email

## Getting started

1. **Database roles.** Run once per cluster, as a superuser:

   ```bash
   psql -U postgres -v owner_pw=... -v user_pw=... -v db=peoplehub -f scripts/db-roles.sql
   ```

   Migrations run as `app_owner`. The API runs as `app_user`, which cannot alter or delete audit rows.

2. **Environment.** Copy `.env.example` to `.env` (and to `apps/api/.env` for the Prisma CLI), then fill in the passwords. Generate an encryption key with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

3. **Install, migrate, seed and run:**

   ```bash
   pnpm install
   pnpm --filter @peoplehub/shared build
   pnpm db:deploy
   pnpm db:seed
   pnpm dev            # API on http://localhost:3000, docs at /api/docs
   ```

`pnpm db:seed` creates the section 14 demo users: `hr.admin`, `payroll.admin`, `sys.admin`, `auditor`, `manager.a`, `manager.b` (reports to manager A) and `employee1` to `employee6` (report to manager B). They share one development password, which the seed prints when `NODE_ENV=development`. For local http, set `COOKIE_SECURE=false`.

The Docker stack (`docker compose up`) runs Postgres, Mailpit, MinIO, the API and the web app. The web app is built from `../HRSystemOfficeFE`.

## What the API covers

| Area                          | Endpoints (under `/api/v1`)                                                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth and session              | `/auth/*` (local, OIDC, password reset, MFA enrol/verify/disable), `/session`, "Working as"                                                                                                                            |
| Self-service                  | `/dashboard`, `/leave`, `/claims`, `/me` (My Details), `/payslips`, `/tax-certificates`, `/free-text`, `/performance`, `/reports`                                                                                      |
| Approvals                     | `/inbox`, `/workflow/processes/*`, `/profile/out-of-office`, `/notifications`                                                                                                                                          |
| Administration (HR, Payroll)  | `/admin/employees` (+ terminate, photo, CSV import), companies, company rules, holidays, workflow definitions, free text types, leave and claims set-up, banks, funds, lookups, pay periods (+ close), payroll imports |
| Administration (system admin) | `/admin/users` (roles, activation, unlock, password and MFA resets), `/admin/settings`                                                                                                                                 |
| Audit                         | `/audit` explorer, row detail, record history of any entity, chain verification, audited export                                                                                                                        |

The OpenAPI document at `/api/docs` lists every route with its request and response schemas (the Zod contracts in `packages/shared/src/api`).

## Quality gates

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests (90% coverage on shared)
pnpm test:int                              # integration tests against TEST_DB_NAME (or Testcontainers)
pnpm audit:verify                          # recompute the audit hash chain
```

## Operations

```bash
pnpm keys:rotate                           # re-encrypt every encrypted field to ENCRYPTION_ACTIVE_KEY
pnpm jobs:run                              # list the background jobs
pnpm jobs:run leave.accrue '{"asOf":"2026-11-01"}'   # re-run one job now (audited SYSTEM.JOB_RUN)
```

Backups, the restore drill, key rotation, audit anchors, OIDC set-up and every environment variable are described in [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/AUDIT.md](docs/AUDIT.md)
- [docs/RUNBOOK.md](docs/RUNBOOK.md)
- [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md)
