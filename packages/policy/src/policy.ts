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
): Promise<PolicyLookup> {
  const policies = new Map<string, SourcePolicy>();

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
    });
  }

  return (source) => policies.get(source) ?? null;
}
