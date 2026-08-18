# @recon/policy — the seam

**Problem it solves.** The matcher needs a business calendar and a fee model per source.
The calendar is declared by `ingest`, beside the adapter that knows the rail. The
contracts are administered data with effective dates and an approver, so they live in the
database. `reconciler` may import neither — the moment it can read a source table it can
branch on a source name, and that missing edge is what makes Law 7 structural rather than
remembered.

**What it is.** One function, `buildPolicy(db, merchantId)`, that fetches both and returns
the `PolicyLookup` the matcher takes as an argument. No matching logic, no per-source
branches, nothing that decides anything about money.

**Why it is a package and not a file in an app.** It was a file in an app — Phase 3 put it
in `apps/pipeline`, when the CLI was the only deployable. Phase 6 added a second, and two
copies of the join that decides how long to wait before calling money late is two copies
that can disagree: the API and the CLI would reconcile the same database to different
answers.

**Depends on:** `canon`, `ingest`, `ledger-core`, `reconciler`. **Depended on by:** the
deployables only. It is the one package with that shape, and deliberately the only one.

See [DECISIONS.md § D-055](../../docs/DECISIONS.md).
