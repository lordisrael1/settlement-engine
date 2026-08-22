import type { MerchantId } from '@recon/canon';
import { feeModel } from '@recon/canon';
import { SOURCE_IDS, sourceProfile } from '@recon/ingest';
import type { Executor } from '@recon/ledger-core';
import { loadFeeContracts, type PolicyLookup, type SourcePolicy } from '@recon/reconciler';

/**
 * Everything the matcher is told about every source, assembled once.
 *
 * Contracts are loaded once per run rather than per payment. A reconciliation is a snapshot
 * taken at `asOf`, and re-reading the contract table halfway through would let a concurrent
 * edit change the answer partway down the file — the same run reaching two different
 * conclusions about two identical payments (determinism).
 */
export async function buildPolicy(
  db: Executor,
  merchantId: MerchantId,
  options: { readonly reserveReleaseDays?: number | null } = {},
): Promise<PolicyLookup> {
  const policies = new Map<string, SourcePolicy>();
  const reserveDays =
    options.reserveReleaseDays === undefined ? 90 : options.reserveReleaseDays;

  for (const source of SOURCE_IDS) {
    const profile = sourceProfile(source);
    const contracts = await loadFeeContracts(db, source, merchantId);

    policies.set(source, {
      calendar: profile.calendar,
      // No contract is the honest answer for a source we have no agreement with: the
      // matcher then matches on amounts alone and reports the fee it observed, rather
      // than generating a stream of variances against a rate nobody quoted (ADR-0026).
      expectedFee: contracts.length === 0 ? null : feeModel(contracts),
      // Correspondent-bank charges on an inbound transfer are real, small and never
      // announced. ₦100 is the threshold below which chasing one costs more than it is
      // worth; above it, somebody looks.
      bankChargeAllowance: 10_000n,
      // Enabled for sources we hold a profile for. The alternative — refusing every
      // same-amount pair — makes queue depth scale with transaction volume for any
      // fixed-price business, which is the way reconciliation tools die in practice: not
      // wrong, just unread by Thursday (ADR-0072).
      pairEqualAmounts: true,
      // Ninety days is the common Nigerian rolling-reserve term. A number somebody chose,
      // and the only thing that makes a reserve position falsifiable: without it, a PSP that
      // returns reserves on schedule and one that never returns them produce identical books
      // (ADR-0071).
      reserveReleaseDays: reserveDays,
    });
  }

  return (source) => policies.get(source) ?? null;
}
