# 17. Idempotency keys take the connector's dedupe key whole

Date: 2026-08-15

## Status

Accepted

## Context

A connector may legitimately override its dedupe key when a provider's reference is not
one-to-one with a transaction. Paystack does exactly this, producing keys of the form
`paystack:charge:PSK_...`.

## Decision

`idempotencyKey(rail, dedupeKey)` prefixes the rail onto the key the connector produced,
rather than recomposing it from source and reference.

## Consequences

- Recomposing would discard the connector's knowledge and collide two distinct events onto
  one key, which under [ADR-0014](0014-transaction-id-is-the-idempotency-key.md) means one of
  them is dropped as a duplicate.
- The rail prefix exists because a promise and a settlement for the same reference are
  different events and must not collide.
