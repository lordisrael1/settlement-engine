# @recon/policy

Joins the per-source business calendars declared by `@recon/ingest` to the fee contracts
administered in the database, and returns the `PolicyLookup` the matcher takes as an
argument.

**Depends on:** `canon`, `ingest`, `ledger-core`, `reconciler`.
**Imported by:** the deployables only.

## Why it exists

The matcher needs a calendar and a fee model per source. `@recon/reconciler` may import
neither: the moment it can read a source table it can branch on a source name, and that
missing edge is what keeps the canonical boundary structural rather than remembered. So the
join happens here, in a module that decides nothing — it fetches, it joins, it hands over a
lookup.

It was a file in `apps/pipeline` while the CLI was the only deployable. Two copies of the
join that decides how long to wait before calling money late is two copies that can
disagree. See [ADR-0055](../../docs/adr/0055-the-policy-join-is-a-package.md).

## API

    buildPolicy(db, merchantId) -> PolicyLookup

This package imports several others and is imported only by applications. That shape
otherwise belongs to a deployable, and it is intentional here.
