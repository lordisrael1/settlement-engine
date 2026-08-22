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

    buildPolicy(db, merchantId, { reserveReleaseDays? }) -> PolicyLookup

What a `SourcePolicy` carries has grown, and every addition is the same shape: a number or a
flag somebody chose, handed *in* rather than looked up, so the matcher still has no source
name to branch on.

| Field | What it decides |
|---|---|
| `calendar` | when money is late |
| `expectedFee` | what we expected to be charged, or `null` for "we cannot predict this" |
| `bankChargeAllowance` | how much a bank may quietly take before it stops being a bank charge |
| `pairEqualAmounts` | whether same-amount credits may be paired as a set ([ADR-0072](../../docs/adr/0072-same-amount-credits-are-paired-as-a-set.md)) |
| `reserveReleaseDays` | when a withheld reserve is due back; `null` means the source declared no schedule, which is different from zero ([ADR-0071](../../docs/adr/0071-reserves-carry-a-deadline.md)) |

`UNPROFILED_SOURCE` answers `false` and `null` to the last two, as it answers zero to the
allowance: a source we know nothing about gets the strict behaviour, and pretending to know
when its reserves are due would manufacture an exception no evidence could ever clear.

This package imports several others and is imported only by applications. That shape
otherwise belongs to a deployable, and it is intentional here.
