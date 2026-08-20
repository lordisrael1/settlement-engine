# 21. Chart-of-accounts policy lives in the ledger core, not in the application

Date: 2026-08-15

## Status

Accepted

## Context

`postTransaction` is a mechanism: it writes any balanced set of entries. Which accounts a
given economic event touches is policy.

## Decision

`bookAuthorizedPayment()` lives in `packages/ledger-core/src/bookings.ts`, beside the
mechanism it composes.

## Consequences

- Policy about the chart of accounts sits with the component that is the authority on the
  chart of accounts, rather than in a deployable where every future deployable would
  reimplement it.
- It takes a `CanonicalPayment` — canonical language, not a foreign shape. Knowing that
  payments exist is not the same as branching on their source.
- It refuses to book a payment that is not `SUCCESSFUL`, because booking a pending or failed
  payment as a promise would put cash in the books nobody agreed to send.
