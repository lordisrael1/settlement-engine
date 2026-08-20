# Multi-stage build for the API service. The workspace packages are compiled into the image
# as dependencies of the app, no differently from any registry dependency.

FROM node:20-alpine AS build
WORKDIR /app

# Manifests first, so a source-only change does not re-run the install. npm needs every
# workspace manifest present to resolve the internal links, and the copies are one by one
# because `COPY packages/*/package.json` flattens the paths. Add new workspaces here; an
# omission fails `npm ci` at build time with the missing package named.
COPY package.json package-lock.json ./
COPY packages/canon/package.json       packages/canon/
COPY packages/ledger-core/package.json packages/ledger-core/
COPY packages/ingest/package.json      packages/ingest/
COPY packages/reconciler/package.json  packages/reconciler/
COPY packages/policy/package.json      packages/policy/
COPY packages/inbox/package.json       packages/inbox/
COPY packages/simulator/package.json   packages/simulator/
COPY apps/pipeline/package.json        apps/pipeline/
COPY apps/api/package.json             apps/api/

# `npm ci` installs exactly what the lockfile pins, so the image is reproducible.
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps

# Project references make tsc build the packages before the app that imports them.
RUN npm run build

# Nothing at runtime needs TypeScript.
RUN npm prune --omit=dev


FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages     ./packages
COPY --from=build /app/apps         ./apps

# The process only reads its own code and talks to Postgres, so it does not run as root.
USER node

# The database address and every secret arrive as configuration; nothing is baked into the
# image. The service refuses to start without RECON_API_KEY.
ENV DATABASE_URL=""
ENV PORT=8080

EXPOSE 8080

# The default command. The CLI is in the same image and runs by overriding it:
#   docker compose run --rm api node apps/pipeline/dist/main.js balances
CMD ["node", "apps/api/dist/main.js"]
