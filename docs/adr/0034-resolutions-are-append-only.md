# 34. Human resolutions are appended, never applied

Date: 2026-08-16

## Status

Accepted

## Context

The append-only discipline that protects the ledger should also protect the judgements made
about it.

## Decision

`resolutions` is append-only: subject, action, reason, a named person, a timestamp, optional
supporting evidence and an optional approver. There is no `updateResolution`.

## Consequences

- A reviewer does not edit a match, change an amount or clear an exception. They state what
  they concluded and why.
- A wrong decision is corrected by a second resolution, so both stay visible, as does the
  fact that somebody changed their mind.
- `resolvedBy` is a person, not a role and not a service account.
- Approval is all-or-nothing by constraint: a half-recorded approval looks like oversight
  that did not happen.
- An operational UI and workflow are required to use this well; the vocabulary and the table
  exist so the exception queue has somewhere to write.
