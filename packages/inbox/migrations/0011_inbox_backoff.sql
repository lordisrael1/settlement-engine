-- Retries stop being a stopwatch.
--
-- The drain claimed `state = 'pending' AND attempts < maxAttempts` on a fixed timer, and
-- `recordFailure` incremented `attempts` the moment a handler threw. Nothing sat between
-- those two facts, so the interval between a delivery's first attempt and its last was
-- `intervalMs × maxAttempts` — with the shipped defaults, **four seconds**.
--
-- For the failure the design was built around that is fine. When Postgres is unreachable
-- the whole transaction fails, `attempts` never moves, and the delivery waits as long as it
-- has to. The dangerous case is the other one: Postgres reachable and the handler throwing
-- for a reason that would have cleared itself — a deadlock under concurrency, a
-- serialization failure, a replica hiccup, a lock held a second too long by a reconciliation
-- run. Every one of those increments `attempts`, and eight of them inside four seconds
-- retires an authentic payment to `failed`, permanently, where nothing retries it and only a
-- person can bring it back.
--
-- Deadlocks are not hypothetical here; the balance cache is a row per account and every
-- booking for a merchant contends on `psp_receivable` (ADR-0053). A transient error class the
-- system's own design produces is exactly the one its retry policy must survive.
--
-- One column fixes it. `next_attempt_at` is when a delivery becomes claimable again, the
-- claim query gates on it, and `recordFailure` sets it to `now + backoff(attempts)`. The
-- backoff is exponential with deterministic jitter derived from the delivery id — never
-- `Math.random`, because two workers computing different delays for the same row is the one
-- thing that would make a replay of the drain disagree with the drain (determinism), and the
-- id is already a hash so it is already uniformly distributed.
--
-- What this costs, stated: a poison payload now takes minutes rather than seconds to reach
-- `failed`. That is the correct trade. A payload nobody can parse is not urgent; a real
-- payment discarded over a deadlock is.

ALTER TABLE webhook_inbox
  -- When this delivery may be claimed again. NULL means "now", which is what every existing
  -- row means and what a freshly accepted delivery means: the first attempt never waits.
  ADD COLUMN next_attempt_at TIMESTAMPTZ;

-- The claim index, replaced rather than added to.
--
-- The old index ordered pending rows by `(received_at, delivery_id)` and the claim query now
-- also filters on `next_attempt_at`. Leaving the old one would have every claim read index
-- entries for rows that are pending but not yet due — which, on a queue that is retrying, is
-- most of them, and precisely when the claim needs to be fast.
DROP INDEX webhook_inbox_pending_idx;

CREATE INDEX webhook_inbox_claimable_idx
  ON webhook_inbox (next_attempt_at NULLS FIRST, received_at, delivery_id)
  WHERE state = 'pending';
