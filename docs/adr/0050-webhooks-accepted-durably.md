# 50. A webhook is accepted durably and interpreted afterwards

Date: 2026-08-18

## Status

Accepted

## Context

The promise worth making to a provider is "we safely received this event", not "we completed
every downstream operation before replying". Only the first can be kept in a couple of
milliseconds, and only the first stays true when the matcher is busy or a balance row is
locked. Conflating them means any slowness makes a provider believe a payment was never
delivered, so it redelivers, and a queue that was merely slow becomes one that is growing.

## Decision

`POST /webhooks/:source` verifies the signature over the raw bytes, writes one row to
`webhook_inbox`, and answers 200. A worker — `drain` in `@recon/inbox` — claims deliveries
with `FOR UPDATE SKIP LOCKED`, one database transaction per delivery, normalises them through
`@recon/ingest` and posts through `@recon/ledger-core`. The delivery id is the SHA-256 of the
source and the bytes.

## Consequences

- Content-addressing needs no parser: the event's own idempotency key is inside the payload,
  and reading it means parsing bytes a stranger chose before deciding the delivery is worth
  parsing. The event key still does its work one layer down, since the ledger transaction id
  is that key, so a provider that resends the same event with different bytes produces two
  inbox rows and one transaction.
- `ignored` and `rejected` are terminal; a handler that throws is retried up to `maxAttempts`
  and then marked `failed` for a person to look at. Retrying a poison payload forever is an
  infinite loop with a log file.
- `webhook_inbox` is deliberately mutable — `state`, `attempts` and `last_error` are updated
  as a delivery is worked — and carries no append-only trigger, the same exemption
  `account_balances` has. The evidence half of the row is never written after the insert.
- A payment is visible in the books a fraction of a second after the webhook rather than
  during it. That window is bounded by the drain interval and visible in `/health` as the
  pending depth.
