# You do not containerise the packages. You containerise the app — and the packages come
# along for the ride, because the app depends on them. From the app's point of view
# @recon/ledger-core is a dependency no different in kind from pg; the only difference is
# that it comes from this repo instead of the registry. Both end up inside the image.

FROM node:20-alpine AS build
WORKDIR /app

# Manifests first, so a source-only change does not re-run the install. npm needs every
# workspace manifest present to resolve the internal links, hence the one-by-one copies.
COPY package.json package-lock.json ./
COPY packages/canon/package.json       packages/canon/
COPY packages/ledger-core/package.json packages/ledger-core/
COPY packages/ingest/package.json      packages/ingest/
COPY apps/pipeline/package.json        apps/pipeline/

# `npm ci` installs exactly what the lockfile says — the difference between a
# reproducible image and one that quietly picks up a new minor version next Tuesday.
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps

# Project references make tsc build the packages before the app that imports them.
RUN npm run build

# Drop the toolchain now that the JavaScript exists; nothing at runtime needs TypeScript.
RUN npm prune --omit=dev


FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages     ./packages
COPY --from=build /app/apps         ./apps

# Never root. A process that only reads its own code and talks to Postgres has no use
# for the privileges root would give an attacker who reached it.
USER node

# The database lives in its own container; the address arrives as configuration, and no
# secret is ever baked into the image.
ENV DATABASE_URL=""

CMD ["node", "apps/pipeline/dist/main.js", "demo"]
