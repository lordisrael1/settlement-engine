# 6. Money is a typed wrapper, not a bare bigint

Date: 2026-08-15

## Status

Accepted

## Context

Amounts are integer kobo held as `bigint`. A bare `bigint` is structurally identical to a
count, an identifier or a timestamp, so the compiler cannot prevent adding a transaction
count to an amount.

## Decision

`Money = { kobo: bigint, currency: 'NGN' }`, with arithmetic through functions that check
currency agreement.

## Consequences

- Every amount is self-describing at the point of use, and a second currency has somewhere
  to live.
- Allocation per amount, and arithmetic through functions rather than operators. Neither is
  a correctness or performance concern at this system's volumes.
- `Currency` is a single-member union today, so the mismatch guard in `add` and `subtract`
  is currently unreachable. It is kept as an invariant assertion.
