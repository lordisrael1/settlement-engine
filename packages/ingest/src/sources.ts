import type { Connector } from '@pay-normalize/core';
import { flutterwave } from '@pay-normalize/flutterwave';
import { monnify } from '@pay-normalize/monnify';
import { nomba } from '@pay-normalize/nomba';
import { paystack } from '@pay-normalize/paystack';

import type { SettlementWindow, SourceId } from '@recon/canon';

import { feeModel, type FeeModel } from './fees.js';
import {
  flutterwaveSettlements,
  monnifySettlements,
  nombaSettlements,
} from './settlement/adapters.js';
import type { SettlementSource } from './settlement/types.js';

/**
 * Everything the system knows about one payment source, in one place.
 *
 * This is how Law 7 survives contact with reality. Sources genuinely do differ — they
 * settle on different schedules and charge different fees — and pretending otherwise
 * would just push the difference somewhere less visible. So the difference is captured
 * *as data*, here, at the boundary. Downstream code asks a profile what the window is;
 * it never asks which source this is.
 *
 * Adding a source is one entry in this table plus its connector. Nothing else in the
 * system changes.
 */
export interface SourceProfile {
  readonly id: SourceId;
  /** The webhook half: signature verification and payload normalisation. */
  readonly connector: Connector;
  /** The money half. `null` when no fixture-verified settlement format exists yet. */
  readonly settlement: SettlementSource | null;
  readonly settlementWindow: SettlementWindow;
  /** `null` when the rate card is not known — see the note on Nomba below. */
  readonly expectedFee: FeeModel | null;
}

/**
 * T+1 channels get a T+2 deadline, not a T+1 one.
 *
 * The window is the point at which silence becomes an *exception* a human is woken for,
 * not the point at which money is expected. Setting it to the expected arrival time
 * would make every ordinary weekend and public holiday an incident, and an alert that
 * cries wolf is worse than no alert.
 */
const T_PLUS_2: SettlementWindow = { deadlineMinutes: 2 * 24 * 60 };
const T_PLUS_1: SettlementWindow = { deadlineMinutes: 24 * 60 };

/**
 * Published NGN rate cards, as of the last review.
 *
 * These are *expectations* used to explain differences, so being slightly stale
 * degrades gracefully — a changed rate shows up as a rising `FEE_VARIANCE` count rather
 * than as a wrong balance, because the fee actually charged always wins. Review them
 * against your own signed rate card; a negotiated rate is common above modest volume.
 */
const PAYSTACK_NGN = feeModel({
  percentBasisPoints: 150,
  flatKobo: 10_000n, // ₦100
  flatWaivedBelowKobo: 250_000n, // waived under ₦2,500
  capKobo: 200_000n, // capped at ₦2,000
});

const FLUTTERWAVE_NGN = feeModel({
  percentBasisPoints: 140,
  flatKobo: 0n,
  flatWaivedBelowKobo: null,
  capKobo: 200_000n,
});

const MONNIFY_NGN = feeModel({
  percentBasisPoints: 150,
  flatKobo: 0n,
  flatWaivedBelowKobo: null,
  capKobo: 200_000n,
});

const PROFILES: readonly SourceProfile[] = [
  {
    id: paystack.provider,
    connector: paystack,
    // Paystack's connector refuses to parse settlement exports until a sanitized real
    // file pins the column layout. Inventing one here would produce a parser that looks
    // right and is wrong, which is worse than not having one — so this stays null until
    // a real export exists. The promise half works fully in the meantime.
    settlement: null,
    settlementWindow: T_PLUS_2,
    expectedFee: PAYSTACK_NGN,
  },
  {
    id: flutterwave.provider,
    connector: flutterwave,
    settlement: flutterwaveSettlements,
    settlementWindow: T_PLUS_2,
    expectedFee: FLUTTERWAVE_NGN,
  },
  {
    id: nomba.provider,
    connector: nomba,
    settlement: nombaSettlements,
    settlementWindow: T_PLUS_1,
    // Nomba prices per merchant rather than from a public card, so there is no rate
    // card to encode. `null` is the honest value: the reconciler will match these on
    // reference and exact amount, and report a fee it cannot predict rather than
    // pretending to predict one.
    expectedFee: null,
  },
  {
    id: monnify.provider,
    connector: monnify,
    settlement: monnifySettlements,
    settlementWindow: T_PLUS_1,
    expectedFee: MONNIFY_NGN,
  },
];

export const SOURCES: ReadonlyMap<SourceId, SourceProfile> = new Map(
  PROFILES.map((profile) => [profile.id, profile]),
);

export const SOURCE_IDS: readonly SourceId[] = PROFILES.map((profile) => profile.id);

export class UnknownSourceError extends Error {
  constructor(readonly source: SourceId) {
    super(
      `No adapter for source "${source}". Known sources: ${SOURCE_IDS.join(', ')}. ` +
        `Adding one is a single entry in the source profile table.`,
    );
    this.name = 'UnknownSourceError';
  }
}

export function sourceProfile(source: SourceId): SourceProfile {
  const profile = SOURCES.get(source);
  if (!profile) throw new UnknownSourceError(source);
  return profile;
}
