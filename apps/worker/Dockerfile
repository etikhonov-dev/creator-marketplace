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
# Runs TypeScript directly via tsx — same trade as the API image.
#
# Also the bootstrap image: compose overrides CMD to run migrate + seed +
# `worker --once` as a one-shot job, and the long-running worker starts from
# the same image. One image, two commands, so the migration path and the
# runtime path cannot drift apart.
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
COPY apps/worker ./apps/worker

ENV NODE_ENV=production
USER node

CMD ["pnpm", "--filter", "@marketplace/worker", "start:loop"]
