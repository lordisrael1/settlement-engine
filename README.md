# Reconciliation Engine

A Nigerian fintech reconciliation engine, built on `pay-normalize`.

> **Record the fast promise, wait for the slow money, and explain — provably — every
> difference between them.**

A payment notification arrives in seconds. The settled cash arrives later — T+1 for card
and PSP-aggregated channels, near-instant for direct NIP transfers and virtual-account
credits. This system records the promise immediately, waits for the money, and partitions
every difference into **matched**, **explained**, or **exception** — so a human only ever
looks at a genuine anomaly.

## Documents

| Document | What it is |
|---|---|
| [docs/RECONCILIATION-BIBLE.md](docs/RECONCILIATION-BIBLE.md) | The doctrine: core beliefs, the seven Laws, target attributes, and the ten build phases with exit criteria. **The specification.** |
| [docs/FIRST-PRINCIPLES.md](docs/FIRST-PRINCIPLES.md) | Why the design is what it is, derived from scratch: why a balance is never a fact, why double-entry falls out of conservation, what reconciliation actually is. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Libraries vs. deployables, the one-directional dependency graph, and how it becomes a containerised service. |
| [docs/DECISIONS.md](docs/DECISIONS.md) | The decision log. Every non-obvious choice with its reasoning. |
| [AGENTS.md](AGENTS.md) | Engineering rules for anyone (human or agent) writing code here. |

## Status

**Phase 0 — Foundations and the canonical model.** In progress.

- [x] Monorepo layout
- [x] Canonical types (`packages/canon`)
- [x] Chart of accounts
- [x] Decision log
- [ ] Phase 1 — the ledger core

Phases 1–9 are specified in the bible and not yet built. Each package directory carries a
README stating which phase brings it into existence.

## Layout

```
packages/canon         the shared language — types only, depends on nothing
packages/ledger-core   the double-entry engine          (Phase 1)
packages/ingest        the anti-corruption boundary     (Phase 2)
packages/reconciler    the matching engine              (Phases 3–4)
apps/api               the Fastify service — the only runnable thing (Phase 6)
```

## Development

Requires Node 20+.

```bash
npm install
npm run build     # tsc --build across the workspace
```
