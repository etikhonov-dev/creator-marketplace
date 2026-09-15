# syntax=docker/dockerfile:1

# ── deps ──────────────────────────────────────────────────────────────────────
# The whole workspace is needed to resolve `workspace:*` links, so this stage
# takes the lockfile and every manifest but no source. Editing a source file
# therefore does not invalidate the install layer.
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json     packages/db/
COPY apps/api/package.json        apps/api/
COPY apps/worker/package.json     apps/worker/
COPY apps/web/package.json        apps/web/
RUN pnpm install --frozen-lockfile

# ── runtime ───────────────────────────────────────────────────────────────────
# Runs TypeScript directly via tsx rather than compiling. A one-day take-home
# gains nothing from a tsc build step here, and the trade is explicit: slightly
# slower boot and a dev dependency in the image, in exchange for one fewer
# build stage that could diverge from what the tests ran against.
FROM node:22-alpine AS runtime
RUN corepack enable
WORKDIR /repo

# The install tree wholesale, then source overlaid on top. Enumerating
# per-package node_modules breaks the moment a package has no dependencies:
# pnpm creates no directory for it and the COPY fails. .dockerignore keeps
# node_modules out of the build context, so the overlay cannot clobber it.
COPY --from=deps /repo ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api

ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@marketplace/api", "start"]
