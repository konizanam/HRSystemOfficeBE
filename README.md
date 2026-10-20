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

The Docker stack (`docker compose up`) runs Postgres, Mailpit, MinIO, the API and the web app. The web app is built from `../HRSystemOfficeFE`.

## Quality gates

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests (90% coverage on shared)
pnpm test:int                              # integration tests against TEST_DATABASE_URL (or Testcontainers)
pnpm audit:verify                          # recompute the audit hash chain
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/AUDIT.md](docs/AUDIT.md)
- [docs/RUNBOOK.md](docs/RUNBOOK.md)
- [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md)
