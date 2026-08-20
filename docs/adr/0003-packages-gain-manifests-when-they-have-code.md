# 3. A package gets a manifest when it has something to export

Date: 2026-08-15

## Status

Superseded — every package listed here now has a manifest and source.

## Context

The initial layout defined the package boundaries and the dependency graph before most
packages had any code.

## Decision

`ledger-core`, `ingest`, `reconciler` and `apps/api` exist as directories with a README
stating their purpose and dependencies, but no `package.json`, `tsconfig.json` or `src/`
until they have something to export.

## Consequences

- The layout and the dependency graph are documented without shipping empty modules that
  the build must carry and a reviewer must read past.
- Stub packages exporting nothing were rejected: they make the build do work that proves
  nothing.
