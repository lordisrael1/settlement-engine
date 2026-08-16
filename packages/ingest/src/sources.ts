import type { Connector } from '@pay-normalize/core';
import { flutterwave } from '@pay-normalize/flutterwave';
import { monnify } from '@pay-normalize/monnify';
import { nomba } from '@pay-normalize/nomba';
import { paystack } from '@pay-normalize/paystack';

import type { BusinessCalendar, FeeContract, MerchantId, SourceId } from '@recon/canon';

import {
  CUT_OFF_5PM_WAT,
  ONE_DAY_GRACE,
  FOUR_HOURS_GRACE,
  calendar,
} from './calendar.js';
import {
  FLUTTERWAVE_PUBLISHED_NGN,
  FLUTTERWAVE_TRANSFER_NGN,
  MONNIFY_PUBLISHED_NGN,
  MONNIFY_TRANSFER_NGN,
  PAYSTACK_PUBLISHED_NGN,
  PAYSTACK_TRANSFER_NGN,
  publishedContract,
} from './fees.js';
import {
  flutterwaveSettlements,
  monnifySettlements,
  nombaSettlements,
} from './settlement/adapters.js';
import type { SettlementSource } from './settlement/types.js';

/**
 * Everything the system knows about one payment source, in one place.
 *
 * This is how Law 7 survives contact with reality. Sources genuinely do differ — they cut
 * off at different times, settle on different schedules, and charge different rates — and
 * pretending otherwise would just push the difference somewhere less visible. So the
 * difference is captured *as data*, here, at the boundary. Downstream code asks a profile
 * when money is due; it never asks which source this is.
 *
 * Adding a source is one entry in this table plus its connector. Nothing else changes.
 */
export interface SourceProfile {
  readonly id: SourceId;
  /** The webhook half: signature verification and payload normalisation. */
  readonly connector: Connector;
  /** The money half. `null` when no fixture-verified settlement format exists yet. */
  readonly settlement: SettlementSource | null;
  /** When money is actually late, in business days and cut-off times. */
  readonly calendar: BusinessCalendar;
  /**
   * Strings this source's payouts tend to carry in a bank narration.
   *
   * Bank narration is the only thing linking a credit to a payout for most Nigerian banks,
   * and it is truncated, inconsistent and occasionally absent. These are *hints for
   * extraction*, kept as data so that the guessing is visible and per-source rather than
   * hidden in a regex somewhere downstream. A credit whose narration matches nothing is
   * matched on amount and date instead, at lower confidence — never by a parser deciding.
   */
  readonly narrationMarkers: readonly string[];
}

/**
 * Card and PSP-aggregated rails are T+1 with a 5pm cut-off and a full day of grace: a
 * Friday-evening payment is not late until Tuesday, and saying otherwise turns every
 * weekend into an incident.
 */
const T_PLUS_1 = calendar({
  cutOffMinutes: CUT_OFF_5PM_WAT,
  settlementBusinessDays: 1,
  graceMinutes: ONE_DAY_GRACE,
});

/** Rails that quote T+2, with the same cut-off and the same tolerance. */
const T_PLUS_2 = calendar({
  cutOffMinutes: CUT_OFF_5PM_WAT,
  settlementBusinessDays: 2,
  graceMinutes: ONE_DAY_GRACE,
});

/**
 * Near-instant rails — NIP transfers, virtual-account credits — settle the same business
 * day, and unmatched money there is suspicious within hours rather than days.
 */
const SAME_DAY = calendar({
  cutOffMinutes: CUT_OFF_5PM_WAT,
  settlementBusinessDays: 0,
  graceMinutes: FOUR_HOURS_GRACE,
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
    calendar: T_PLUS_2,
    narrationMarkers: ['PAYSTACK', 'PSTK'],
  },
  {
    id: flutterwave.provider,
    connector: flutterwave,
    settlement: flutterwaveSettlements,
    calendar: T_PLUS_2,
    narrationMarkers: ['FLUTTERWAVE', 'FLW', 'RAVE'],
  },
  {
    id: nomba.provider,
    connector: nomba,
    settlement: nombaSettlements,
    calendar: T_PLUS_1,
    narrationMarkers: ['NOMBA'],
  },
  {
    id: monnify.provider,
    connector: monnify,
    settlement: monnifySettlements,
    calendar: SAME_DAY,
    narrationMarkers: ['MONNIFY', 'MFY'],
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

/**
 * The published rate cards, as contracts, for one merchant.
 *
 * A deployment that has loaded its own signed agreements does not call this — it reads
 * contracts from the database, where they carry real effective dates and a real approver.
 * This exists so that a deployment which has not is working from list prices *explicitly*,
 * rather than from a constant buried in the matcher.
 *
 * Nomba is absent on purpose. It prices per merchant with no public card, so there is
 * nothing honest to seed: the matcher will match its payments on amount and report the fee
 * it observed, rather than generating a permanent stream of variances against a rate
 * nobody ever quoted (D-026).
 *
 * Two contracts per source, not one: the card rate is a percentage and the transfer rate is
 * ten naira flat, and a single blended contract would predict the card fee for every
 * transfer. That is not a wrong balance — the fee charged always wins — but it is a
 * permanent stream of variances against a price nobody quoted for that rail, which is the
 * same thing as no fee model at all, only noisier.
 *
 * Nothing is seeded for `'*'`. A channel the rate cards do not cover — a USSD or POS
 * collection — is left unpriced deliberately, and the matcher matches it on amounts alone.
 */
export function publishedContracts(merchantId: MerchantId): FeeContract[] {
  return [
    publishedContract(paystack.provider, merchantId, PAYSTACK_PUBLISHED_NGN, 'card'),
    publishedContract(paystack.provider, merchantId, PAYSTACK_TRANSFER_NGN, 'bank_transfer'),
    publishedContract(flutterwave.provider, merchantId, FLUTTERWAVE_PUBLISHED_NGN, 'card'),
    publishedContract(flutterwave.provider, merchantId, FLUTTERWAVE_TRANSFER_NGN, 'bank_transfer'),
    publishedContract(monnify.provider, merchantId, MONNIFY_PUBLISHED_NGN, 'card'),
    publishedContract(monnify.provider, merchantId, MONNIFY_TRANSFER_NGN, 'bank_transfer'),
  ];
}
