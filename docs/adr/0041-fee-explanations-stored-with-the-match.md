# 41. The contract that explained a decision is stored with the decision

Date: 2026-08-16

## Status

Accepted

## Context

Effective-dated contracts make a past period reconcile at that period's rates. They do not
make a past decision reproducible: rates are renegotiated, scopes are added, and a rate-card
typo gets corrected, so recomputing an old conclusion against today's table can reach a
different answer than the one acted on.

## Decision

`MatchResult.explainedBy` carries one `FeeExplanation` per promise — contract id, scope,
expected fee, expected VAT, observed fee — and `matches.fee_explanations` persists it.

## Consequences

- "Why did we accept this fee in March?" is answered by a stored contract id rather than by a
  re-derivation that may no longer reproduce.
- `contractId: null` records that a match was made on amounts alone, which is itself a
  conclusion. A conclusion left unwritten is indistinguishable later from one nobody reached.
