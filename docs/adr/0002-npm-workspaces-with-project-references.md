# 2. npm workspaces with TypeScript project references, and no build tool

Date: 2026-08-15

## Status

Accepted

## Context

The repository is a monorepo of TypeScript libraries and two deployables. Build ordering,
caching and dependency-graph enforcement all need an answer.

## Decision

Use plain npm workspaces with `tsc --build` and TypeScript project references. No Turborepo,
no pnpm, no bundler.

## Consequences

- `tsc --build` orders and caches the builds, and project references express the dependency
  graph as a machine-checked assertion that no cycle exists.
- Turborepo was rejected: it adds caching the build does not yet need.
- A bundler was rejected: the deployables are Node services and run the emitted JS directly.
- Revisit when build times become noticeable.
