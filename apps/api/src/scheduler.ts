import type { Pool } from 'pg';

import { buildPolicy } from '@recon/policy';
import { reconcile, type ReconciliationRun } from '@recon/reconciler';

import type { Config } from './config.js';

/**
 * The run nobody has to remember.
 *
 * The webhook rail drains itself. The uploads happen when a file arrives. Reconciliation —
 * the thing this system exists to do — happened only when a person called
 * `POST /reconcile/runs` or typed the CLI command. So a deployment that shipped without a
 * cron never surfaced an exception at all: the three records piled up, the queue stayed
 * empty, and the empty queue read exactly like a clean set of books (ADR-0074).
 *
 * It is the same shape as the inbox worker, and for the same reasons: a poll rather than a
 * signal, so it survives a restart with no coordination; a clock passed in, so a test can
 * drive it; and `unref` on the timer, so it never holds the process open during a shutdown.
 *
 * **Two replicas would run it twice, and that is safe rather than fine.** Every write a run
 * performs is keyed — the booking's id is the bank credit's idempotency key, an exception's
 * key is derived from its subject and reason — so a concurrent second run duplicates
 * nothing. What it does duplicate is the work, which is why this is off by default and why
 * a multi-replica deployment should either leave it off and drive runs from a single cron,
 * or accept the waste knowingly. It deliberately does not take a lock: an advisory lock
 * here would be a second, quieter scheduler-election mechanism to reason about, and the
 * honest answer for now is a configuration flag and a sentence in the README.
 */

export interface ReconcileScheduler {
  /** Stop scheduling and wait for the run in flight. */
  readonly stop: () => Promise<void>;
}

export function startReconcileScheduler(
  pool: Pool,
  config: Config,
  now: () => Date,
  report: (run: ReconciliationRun) => void,
  onError: (error: unknown) => void,
): ReconcileScheduler | null {
  // Zero means off, and off is the default. A scheduler nobody asked for that starts running
  // the heaviest query in the system every few minutes is a worse surprise than no
  // scheduler, and the alert on `reconciliation_stale` is what makes the absence loud.
  if (config.reconcileIntervalMs === 0) return null;

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const pass = async (): Promise<void> => {
    try {
      const run = await reconcile(pool, {
        asOf: now(),
        policyFor: await buildPolicy(pool, config.merchantId),
        limit: config.reconcileLimit,
        limits: config.subsetLimits,
      });
      report(run);
    } catch (error) {
      // A run that throws is not a reason to stop reconciling forever. The records are
      // durable and the next pass finds them, exactly as the drain's are.
      onError(error);
    } finally {
      // Rescheduled from the *end* of the run, not on a fixed tick. A reconciliation over a
      // large window can take longer than the interval, and a fixed tick would start a
      // second run on top of the first — which is safe, and is still two workers contending
      // on the same rows to reach the same answer.
      if (!stopped) {
        timer = setTimeout(schedule, config.reconcileIntervalMs);
        timer.unref();
      }
    }
  };

  const schedule = (): void => {
    inFlight = pass();
  };

  // The first run waits a full interval rather than firing at boot. A deployment restarting
  // under load restarts every replica within a few seconds of each other, and a run at boot
  // would turn a rolling deploy into a thundering herd against the heaviest query here.
  timer = setTimeout(schedule, config.reconcileIntervalMs);
  timer.unref();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
