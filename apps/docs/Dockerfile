# The Better Compute documentation site (apps/docs), built from the repository root: the reference section is
# generated from the built workspace packages (scripts/generate.mjs loads a control plane with every module), so
# the whole workspace is installed and built first.
#
#   docker build -f apps/docs/Dockerfile -t better-compute-docs .
#   docker run -p 3000:3000 better-compute-docs
FROM node:24-bookworm-slim

ENV CI=1 NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app
COPY . .

# pnpm 11.19.0 is pinned by the root package.json (`packageManager`); corepack provides exactly that version.
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
# better-iam resolves to the tarballs in vendor/better-iam (pnpm-workspace.yaml overrides) until it is published.
RUN pnpm install --frozen-lockfile
# The packages the generator loads (dist/ of core, server, postgres, pki, provision, metal, ... cli).
RUN node node_modules/typescript/bin/tsc -b
RUN node apps/docs/scripts/generate.mjs

# Baked into the static pages at build time; DOCS_SITE_URL is the canonical origin (a custom domain).
ARG DOCS_SITE_URL
ARG NEXT_PUBLIC_DOCS_REPOSITORY_URL=https://github.com/better-compute/better-compute
ARG NEXT_PUBLIC_DOCS_REPOSITORY_BRANCH=main
# Optional: the site's X account on link cards, and search console ownership tokens.
ARG DOCS_X_HANDLE
ARG DOCS_GOOGLE_SITE_VERIFICATION
ARG DOCS_BING_SITE_VERIFICATION
ARG DOCS_YANDEX_VERIFICATION
RUN pnpm --filter @better-compute/docs build

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
WORKDIR /app/apps/docs
# `next start` listens on $PORT.
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]
