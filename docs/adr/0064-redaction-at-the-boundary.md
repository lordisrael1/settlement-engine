# 64. Provider payloads are reduced to a keep-list, and the signature is not re-runnable afterwards

Date: 2026-08-20

## Status

Accepted

## Context

ADR-0049 kept customer names, emails and phone numbers out of the reconciliation tables and
was right to. It said nothing about `webhook_inbox.raw`, which stores whole provider
payloads forever.

A Paystack `charge.success` body carries `customer.first_name`, `customer.last_name`,
`customer.email`, `ip_address`, and an `authorization` object with the card's BIN, last four
and expiry. Reconciliation reads six fields: a reference, an amount, a currency, a status, a
channel and a timestamp. Everything else was being retained because the payload arrived as
one blob and nobody separated the parts — which made the inbox the largest collection of
personal data in a system whose design principle is holding as little as possible.

The obstacle is that the delivery id is `SHA-256(source ‖ body)` and the signature is an
HMAC over exactly those bytes. Keeping the original forever and not keeping it are
contradictory, and something has to give.

## Decision

`@recon/protect` reduces a provider payload to a **keep-list**, and the drain applies it in
the same database transaction that records what the delivery meant.

The list is by **path**, not by key name: `$.data.id` is a transaction id and
`$.data.customer.id` is a person. Two structural rules do the rest — a scalar survives only
if its own path is listed, and a container survives only if something inside it survived. So
`customer` and `authorization` disappear without being named.

Originals survive a **dispute window** (30 days by default) and are then replaced. What is
given up is the ability to re-run the HMAC over the stored bytes; what remains provable
forever is that these exact bytes arrived, hashed to this delivery id, and verified at
acceptance time.

Settlement exports and bank statements are **not** reduced. They are the financial record
itself, and a counterparty's name in a bank narration is evidence rather than an accident of
transport (ADR-0033). They are encrypted, access-logged and expired instead (ADR-0065).

## Consequences

- The redaction happens inside the drain's transaction, so there is no window in which a
  delivery is both worked and unredacted. Any earlier would break the signature check the
  worker is about to perform; any later would make "how much personal data do we hold?"
  depend on how busy a background job has been.
- A delivery that *threw* keeps its bytes: it will be claimed again and re-verified. Only a
  terminal delivery is reduced.
- Deliveries the drain will never work — failed, or pending because a worker has been down —
  are swept at the end of the dispute window by `evidence-retention`. The cost is stated
  rather than hidden: after that, a failed delivery can no longer be replayed. Thirty days
  is long enough to fix a parser.
- A keep-list fails by dropping a diagnostic field. A deny-list would fail by silently
  passing whatever a provider adds next, and providers add fields without telling anyone —
  which this codebase already knows and handles for event types.
- Whether the list is *complete* is a fact about the connectors rather than about the
  redactor, so it is a test: every fixture is redacted, re-parsed, and asserted to produce an
  identical `CanonicalPayment`. A connector that starts reading an unlisted field is a
  failing test rather than a surprise six months later.
- Bytes that are not JSON cannot be reduced field by field and are replaced whole. An
  unparseable payload is the case where we least know what we are holding, so keeping it
  because we cannot inspect it has the logic backwards.
- Every redacted copy carries a `_redaction` marker. Bytes travel, and a redacted payload
  that does not say so will eventually be presented as the payload the provider sent.
