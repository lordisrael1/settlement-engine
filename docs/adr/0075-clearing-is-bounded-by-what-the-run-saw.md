# 75. The queue clears only what the run looked at, and never what a person owns

Date: 2026-08-22

## Status

Accepted — amends ADR-0044

## Context

ADR-0044 is the reason the exception queue is readable on a Thursday. Every run diffs its
findings against what is open, and anything it no longer finds is resolved with
`evidence_arrived`: a T+1 straggler raised on Tuesday clears itself when Wednesday's
settlement file lands, and nobody is woken for either event.

The mechanism has one requirement, and it was never checked: that "the run did not find it"
means "the conclusion is no longer reachable".

Every loader in `reconcile` is bounded. `loadCandidates`, `unallocatedPayouts`,
`unallocatedSettlementLines`, `unmatchedBankLines`, `openInflows`, `confirmedInflows` — all of
them stop at `limit`, which defaults to 1000 (ADR-0053, and correctly: subset-sum over an
unbounded set of open promises is how a matcher stops returning).

Past that bound, the matcher never considers the remaining records. It reaches no conclusion
about them. They are absent from the findings — and absence meant resolved.

So the first day a deployment had more than a thousand candidates, every genuine, still-open
exception beyond the cutoff was closed with `evidence_arrived`: no human, no evidence, no
event but the one asserting that evidence had arrived. The mechanism that keeps the queue from
growing was also the mechanism that silently emptied it, and it emptied it fastest exactly when
there was most to lose.

The second problem was smaller and worse to be on the receiving end of. The query read
`WHERE state <> 'resolved'`, so it also closed `acknowledged` items — an exception a named
person had taken ownership of and was actively investigating could be closed out from under
them, labelled as though the evidence had turned up.

## Decision

**A run states what it saw, and clears only within it.**

`clearVanished` takes a `ClearScope`: per subject kind, the set of subject ids the run
actually loaded, and whether the loaders hit their bound.

`truncated: false` means the run read the entire population of that kind, so absence from the
findings really does mean the conclusion is unreachable — and clearing stays safe for subjects
*outside* `witnessed` too. That case matters and is easy to get wrong: a bank credit that
finally confirmed a payout is no longer an unmatched line, so it is not in `witnessed`, and its
old `UNIDENTIFIED_CREDIT` must still clear.

`truncated: true` means the opposite, and clearing is confined to what was loaded. An
exception outside the window is left exactly as it is, and counted as `withheld`.

The `payout` window unions three loaders — unallocated payouts, open inflows, confirmed
inflows — plus the reserve findings of ADR-0071, because a payout-subject exception can be
raised through any of them, and one whose subject was only ever visible through the loader we
forgot would never clear itself.

**Only `open` is ever cleared.** An acknowledged exception is somebody's open tab. If the
problem really is gone, they close it, and the queue records who did.

**The bound is reported rather than implied.** A run returns a `window` describing how much of
each record it read and whether it reached the end, and `queue.withheld` counts the items it
declined to clear. The CLI prints both, in yellow, because a run over a sample and a run over
everything otherwise produce identical-looking reports and only one of them is a
reconciliation.

## Consequences

The failure direction is now the safe one. Leaving an exception open costs somebody a glance;
closing a real one costs a week of not knowing anything is wrong.

`withheld` is the number to watch. Zero is the healthy state. A figure that persists across
runs means the queue's subjects no longer fit inside `limit` — the queue has stopped being
self-clearing, and the fix is a larger `RECON_RECONCILE_LIMIT` or a narrower run, not patience.

An exception outside a truncated window clears one run later, once the queue ahead of it has
drained. That is a real delay and it is strictly better than the alternative.

Every deployment small enough that nothing truncates — which is most of them — sees no change
at all, because `truncated: false` restores exactly the old behaviour.

The scope is now shaped for the partial run ADR-0044 anticipated but could not express: a run
over one source, or bank statements alone, narrows it by omitting the kinds it did not read.
