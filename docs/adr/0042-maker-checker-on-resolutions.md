# 42. Resolutions are keyed, valued, maker-checked, and may not touch cash

Date: 2026-08-16

## Status

Accepted

## Context

The person who notices a discrepancy is the person best placed to make it disappear. They
are usually acting in good faith and occasionally not, and a second named person is the
cheapest control that distinguishes the two.

## Decision

`Resolution` gains `resolutionKey` — its natural key, and the id of the transaction it posts
— and `amount`. `recordResolution` enforces an `ApprovalPolicy`, posts the compensating
journal in the same database transaction as the decision, and refuses any entry touching
`bank_account`. Self-approval is refused by the application and by a database constraint.

## Consequences

- `approveAnyBooking` means anything that moves value needs an approver, whatever its size.
- The entry and the decision are one write, because a compensating entry whose justification
  failed to save is money moved for no recorded reason.
- `bank_account` is forbidden because cash moves on bank evidence and a reviewer's conclusion
  is not bank evidence. An operator who believes the bank balance is wrong has found either a
  statement line not yet ingested, or a genuine bank error that is resolved with the bank and
  arrives back as a statement line.
- A reclassification does not touch the original booking. That booking recorded what was
  known at the time; being wrong about it is a second fact, not a reason to erase the first.
- Identities, permissions and an approval UI are required to operate this.
