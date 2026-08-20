import { keyRingFromEnv, redact, retentionFromEnv } from '@recon/protect';
import type { EvidenceVault } from '@recon/reconciler';

/**
 * The CLI's key ring and retention schedule.
 *
 * Read once, here, and passed down as an argument — the same discipline the service applies
 * to its configuration and every package applies to the clock (ADR-0007). The CLI needs
 * both for the same reasons the service does: it ingests files, so it encrypts them, and it
 * runs the retention command, so it decides what is due.
 *
 * A deployment that has moved to a KMS replaces `keyRingFromEnv` here and in `apps/api`, and
 * nothing else changes — the two lines are the whole of the coupling (ADR-0063).
 */
export function vaultFromEnv(env: NodeJS.ProcessEnv = process.env): EvidenceVault {
  return { keyRing: keyRingFromEnv(env), retention: retentionFromEnv(env) };
}

/**
 * The redactor, wired to the keep-list.
 *
 * A one-line indirection so the retention command and the inbox sweep are demonstrably
 * running the same reduction, rather than two calls that happen to agree today.
 */
export const REDACTOR = (bytes: Buffer): { bytes: Buffer; dropped: number } => redact(bytes);
