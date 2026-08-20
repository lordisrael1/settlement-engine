# @recon/protect

The data-protection boundary. Three functions, no database, no clock.

    refuseCardData   a payload carrying a PAN or SAD is refused before it is stored
    redact           a keep-list over provider payloads: what the matcher reads, nothing else
    seal / unseal    AES-256-GCM per record, data key wrapped by a root key

**Depends on:** `@recon/canon`. **Imported by:** `@recon/ingest`, `@recon/inbox`,
`@recon/reconciler`, `apps/api`, `apps/pipeline`.

## Why it exists

Reconciliation needs a reference, an amount, a currency, a status, a channel and a
timestamp. A Paystack `charge.success` body also carries a customer's name, email and IP
address, and a card's BIN, last four and expiry. Before this package, all of it was stored
forever in `webhook_inbox.raw` — the real personal-data store in the system, and the one
nothing in the design acknowledged ([ADR-0064](../../docs/adr/0064-redaction-at-the-boundary.md)).

## The PCI position, as an invariant

The honest claim is **tokens and approved truncations only**: no PAN, no sensitive
authentication data, and a BIN plus a last four is the truncated form PCI DSS treats as the
maximum that may be displayed. `refuseCardData` is what makes that a property rather than an
observation — a new provider adapter or a changed payload shape that brings a real card
number in is refused at the door and never written down, and a test feeds a synthetic PAN
through the boundary and asserts nothing is stored
([ADR-0066](../../docs/adr/0066-pci-scope-and-evidence-access.md)).

## The keep-list is a list of paths

`$.data.id` is a transaction id and `$.data.customer.id` is a person, so a keep-list of bare
key names cannot tell them apart. Two structural rules do the rest: a scalar survives only
if its own path is listed, and a container survives only if something inside it survived —
which is why `customer` and `authorization` disappear without being named, and why a field a
provider adds next month is dropped by default.

## Keys are not in the database

`KeyRing` is deliberately the shape of a KMS `Encrypt`/`Decrypt` pair. `localKeyRing` holds
a root key in the process, which is the honest option for a deployment that has not chosen a
KMS yet and explicitly not the destination; an AWS KMS, GCP KMS or Vault adapter implements
the same two methods and nothing else changes
([ADR-0063](../../docs/adr/0063-envelope-encryption-for-evidence.md)).
