# syntax=docker/dockerfile:1

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

FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json ./
COPY packages ./packages
# apps/api is needed for its route type definitions: the web app imports them
# type-only, so a response-shape change is a frontend compile error.
COPY apps/api ./apps/api
COPY apps/web ./apps/web
# Vite inlines VITE_* at build time, so the demo control is compiled in or out
# of the bundle. There is no runtime switch to leave on by accident.
ARG VITE_ENABLE_DEV_TOOLS=false
ENV VITE_ENABLE_DEV_TOOLS=$VITE_ENABLE_DEV_TOOLS
RUN pnpm --filter @marketplace/web build

# ── serve ─────────────────────────────────────────────────────────────────────
# No Node in the final image: it is static files plus nginx, which also
# terminates the single origin that removes CORS from the system entirely.
FROM nginx:alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
