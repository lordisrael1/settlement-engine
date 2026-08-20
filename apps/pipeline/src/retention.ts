import type { Pool } from 'pg';

import { redactInboxOriginals, inboxOriginals } from '@recon/inbox';
import { runRetention } from '@recon/reconciler';

import { heading, line } from './report.js';
import { REDACTOR, vaultFromEnv } from './vault.js';

/**
 * The retention command: move every document to the state its schedule says it should be in.
 *
 * A command an operator runs on a schedule, not a background thread inside the service. Two
 * reasons, and the second is the one that decided it. A deletion of financial evidence
 * should be something somebody scheduled, with an output somebody reads — a thread quietly
 * destroying documents inside a web server is a thing nobody watches until it has been wrong
 * for a year. And the CLI is already where this system's scheduled work lives: `replay`
 * runs read-only against production on a timer and set exactly this precedent (ADR-0022).
 *
 * **Dry run by default.** `--apply` writes. A command that deletes evidence should have to
 * be asked twice, and an operator should be able to see what a run would do before it does
 * it — including on the day somebody shortens the schedule by a decimal point.
 */
export async function runRetentionCommand(
  pool: Pool,
  options: { asOf: Date; apply: boolean },
): Promise<number> {
  const vault = vaultFromEnv();
  const { retention } = vault;

  heading(options.apply ? 'Retention — applying' : 'Retention — dry run');
  line(`  originals kept ${retention.originalDays} days, records kept ${retention.redactedDays},`);
  line(`  inbox payloads redacted after ${retention.inboxOriginalDays} days.`);
  if (!options.apply) line('  \x1b[33mNothing will be written. Re-run with --apply.\x1b[0m');
  line();

  // ── Evidence ──────────────────────────────────────────────────────────────
  const report = await runRetention(pool, {
    asOf: options.asOf,
    vault,
    redact: REDACTOR,
    apply: options.apply,
  });

  line(`  evidence due for redaction: ${report.redacted.length}`);
  for (const action of report.redacted.slice(0, 20)) {
    line(`    ${action.evidenceId.slice(0, 16)}…  ${action.kind.padEnd(15)} original → redacted`);
  }

  line(`  evidence due for purge:     ${report.purged.length}`);
  for (const action of report.purged.slice(0, 20)) {
    line(`    ${action.evidenceId.slice(0, 16)}…  ${action.kind.padEnd(15)} ${action.from} → destroyed`);
  }

  // ── The inbox ─────────────────────────────────────────────────────────────
  //
  // The drain redacts everything it works, so this finds only what the drain will never
  // work: a delivery that failed its last attempt, or one still pending because a worker
  // has been down. Those are exactly the payloads that would otherwise sit here forever.
  const before = new Date(options.asOf.getTime() - retention.inboxOriginalDays * 86_400_000);
  const held = await inboxOriginals(pool);

  const overdue = held.oldest !== null && held.oldest < before ? held.originals : 0;
  line();
  line(`  inbox deliveries still holding a provider payload: ${held.originals}`);
  if (held.oldest) line(`    oldest: ${held.oldest.toISOString()}`);

  if (options.apply) {
    const swept = await redactInboxOriginals(pool, {
      before,
      at: options.asOf,
      // The inbox hands over a whole delivery; the keep-list only ever looks at the bytes.
      redact: (delivery) => REDACTOR(delivery.rawBody),
    });
    line(`    redacted: ${swept.redacted}`);
  } else if (overdue > 0) {
    line(`    past the window and awaiting --apply`);
  }

  line();
  if (options.apply) {
    line('  \x1b[32mDone. Every destruction above is an EvidencePurged event in the log.\x1b[0m');
  } else {
    line('  Re-run with --apply to carry these out.');
  }

  return 0;
}
