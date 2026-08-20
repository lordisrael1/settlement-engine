# 26. Windows mark a deadline, and a rate card may be null

Date: 2026-08-15

## Status

Accepted — the window half superseded by
[ADR-0031](0031-business-day-deadlines.md), the fee half by
[ADR-0030](0030-versioned-fee-contracts.md).

## Context

T+1 sources settle the next day, but weekends and public holidays extend that. Nomba prices
per merchant, so there is no published rate card to encode.

## Decision

T+1 sources are given a T+2 window. `expectedFee` is `null` for Nomba.

## Consequences

- The window marks the point at which silence becomes an exception a human is alerted to,
  not the point at which money is expected. Setting it to the expected arrival time makes
  every weekend and public holiday an incident.
- A guessed rate card would generate a permanent stream of false fee-variance findings. With
  `null`, the matcher falls back to reference and exact amount and reports the fee it
  observed.
- Rate cards are validated against the provider's own arithmetic where possible: Paystack
  states the fee it charged in its webhook payload, and the model is checked against it on
  three amounts that each exercise a different branch.
