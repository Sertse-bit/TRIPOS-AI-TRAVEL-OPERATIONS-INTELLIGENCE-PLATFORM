# TripOS container image — Phase 30.
#
# Install, build, then run `next start` from a runtime stage that carries
# only what serving needs. Three things are stated here rather than left to
# be discovered by whoever runs it:
#
#   * **The build stage sets placeholder env values.** `next build` imports
#     the app's modules, and `src/config/env.ts` fails fast when
#     DATABASE_URL / AUTH_SECRET / REDIS_URL are missing — by design. The
#     placeholders below exist only to satisfy that import-time check while
#     compiling; nothing is contacted, and the runtime stage takes its real
#     values from the environment (docker-compose.yml supplies them).
#   * **The Prisma CLI is not used here at all.** `prisma generate` needs a
#     schema-engine binary this project's build sandbox cannot download
#     (docs/DATABASE.md), runtime data access is raw `pg`, and a fresh
#     database is created from the committed prisma/sql/bootstrap.sql.
#   * **No `output: "standalone"`**, so `next start` is the entry point and
#     the whole `.next/` tree ships; `next` itself is a runtime dependency
#     in package.json, not a dev one.
#
# NOT VERIFIED IN THE BUILD SANDBOX: it has no container runtime (no
# docker/podman CLI or daemon), so `docker build` and `docker compose up`
# were never executed here. What WAS verified is in the Phase 30 entry of
# docs/BUILD_PROGRESS.md — the bootstrap DDL was applied to a scratch
# database and the full suite passed against it, and the build stage's
# command was run with exactly these placeholder values.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# --- Dependencies: only the manifests, so a source edit does not re-install.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# --- Build.
FROM deps AS build
COPY . .
# Placeholders so config/env.ts can be imported during the build. They are
# syntactically valid and deliberately unreachable.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV AUTH_SECRET=build-time-placeholder-secret-not-used-at-runtime
ENV REDIS_URL=redis://localhost:6379
RUN pnpm build

# --- Runtime: production server only.
FROM base AS runner
ENV NODE_ENV=production
# Binds all interfaces so the container is reachable from outside it.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY --from=build --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/next.config.ts ./
COPY --from=build --chown=node:node /app/tsconfig.json ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["pnpm", "start"]
