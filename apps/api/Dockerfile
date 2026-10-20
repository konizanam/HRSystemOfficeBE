# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.34.7 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @peoplehub/shared build && pnpm --filter @peoplehub/api build \
 && pnpm deploy --filter @peoplehub/api --prod --legacy /out \
 && cp -r apps/api/dist /out/dist && cp -r apps/api/prisma /out/prisma \
 && cd /out && npx prisma@6.19.3 generate --schema prisma/schema.prisma

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /out /app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
# Migrations run as app_owner, then the API runs as app_user.
CMD ["sh", "-c", "DATABASE_URL=$MIGRATION_DATABASE_URL npx prisma migrate deploy --schema prisma/schema.prisma && node dist/main.js"]
