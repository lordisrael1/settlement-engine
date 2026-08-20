# 37. Fee contracts are scoped by channel and currency

Date: 2026-08-16

## Status

Accepted

## Context

Nigerian providers price a bank transfer at a flat ten naira and a card at 1.5% capped. One
rate per merchant predicts 7,500 naira on a 500,000 naira transfer that actually cost 10.
That never produces a wrong balance — the fee charged always wins — but it produces a fee
variance on every transfer, which is an exception queue nobody reads.

## Decision

A `FeeContract`'s scope is `(source, merchantId, channel, currency)`. `channel` is a value,
not a nullable field, and `'*'` means a blended contract covering every channel. The
exclusion constraint forbids overlap within a scope; a channel-specific contract beside a
`'*'` one is a deliberate overlap resolved by `contractAt` in favour of the more specific.

## Consequences

- Currency is in the scope for the same reason at a larger scale: a rate quoted in naira says
  nothing about a payment in dollars.
- `'*'` is a value rather than `NULL` because an exclusion constraint cannot express
  "overlaps unless one side is a wildcard", and the precedence rule then lives in exactly one
  place.
- `'unknown'` is a legitimate channel — several sources do not disclose the rail, and a payout
  report names a movement rather than a channel. It finds a blended contract or nothing, and
  is never silently priced as a card.
- Two seeded contracts per source instead of one, and a channel that travels with the
  payment, hence `ledger_transactions.channel`. USSD and POS collections are left unpriced
  rather than given an invented card rate.
