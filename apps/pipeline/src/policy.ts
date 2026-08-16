import type { MerchantId } from '@recon/canon';
import { feeModel } from '@recon/canon';
import { SOURCE_IDS, sourceProfile } from '@recon/ingest';
import type { Executor } from '@recon/ledger-core';
import { loadFeeContracts, type PolicyLookup, type SourcePolicy } from '@recon/reconciler';

/**
 * The seam between the three halves of the system, and it is one function long.
 *
 * The reconciler needs to know, per source, when money is late and what we expected to be
 * charged. Neither fact is its to hold: the business calendar is declared by the ingest
 * layer alongside the adapter that knows the rail, and fee contracts are administered
 * data with effective dates and an approver, so they live in the database.
 *
 * Neither package imports the other — the reconciler cannot, because then it could branch
 * on a source name (Law 7) — so the deployable fetches both and hands over a lookup. This
 * is what "the app is the conductor" means concretely: no business logic, just wiring.
 *
 * Contracts are loaded once per run rather than per payment. A reconciliation is a
 * snapshot taken at `asOf`, and re-reading the contract table halfway through would let a
 * concurrent edit change the answer partway down the file.
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
      // than generating a stream of variances against a rate nobody quoted (D-026).
      expectedFee: contracts.length === 0 ? null : feeModel(contracts),
      // Correspondent-bank charges on an inbound transfer are real, small and never
      // announced. ₦100 is the threshold below which chasing one costs more than it is
      // worth; above it, somebody looks.
      bankChargeAllowance: 10_000n,
    });
  }

  return (source) => policies.get(source) ?? null;
}
