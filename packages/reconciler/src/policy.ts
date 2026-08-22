import type { BusinessCalendar, FeeModel, SourceId } from '@recon/canon';

/**
 * Everything the matcher is told about where a record came from.
 *
 * Note what it is: *data*, handed in. Not a lookup the matcher performs. That is what
 * keeps `if (source === 'paystack')` structurally impossible in here — the
 * reconciler cannot branch on a source name because it is never given one it could branch
 * on, only a calendar and a fee model.
 *
 * `@recon/ingest`'s `SourceProfile` supplies the calendar and its fee contracts supply the
 * model, and the deployable joins them. The reconciler does not import ingest, and the
 * dependency graph stays pointed one way.
 */
export interface SourcePolicy {
  readonly calendar: BusinessCalendar;
  /**
   * `null` when we hold no contract for this source and merchant — an honest "we cannot
   * predict this", which becomes matching on amounts alone rather than a false variance
   * against a rate nobody agreed to (ADR-0026).
   */
  readonly expectedFee: FeeModel | null;
  /**
   * How much a bank may quietly take off a credit before it stops being a bank charge and
   * starts being a discrepancy.
   *
   * Correspondent-bank charges on an inbound transfer are real, small, and never announced
   * in advance, so a credit arriving ₦52.50 short of a payout is ordinary. One arriving
   * ₦52,000 short is not, and the only thing separating the two is a number somebody chose
   * deliberately. Zero disables the allowance entirely.
   */
  readonly bankChargeAllowance: bigint;
  /**
   * May a *set* of same-amount credits be paired with the same-sized set of same-amount
   * inflows, when no narration distinguishes them?
   *
   * The problem this answers is not exotic; for a subscription or fixed-price business it
   * is Tuesday. Two payouts that net to the same figure on the same day arrive as two
   * identical credits, `uniqueByAmount` finds two candidates for each and refuses both, and
   * a queue that is supposed to hold genuine anomalies fills with pairs of credits whose
   * correspondence is visually obvious. Nigerian bank narrations are frequently truncated or
   * generic, so the reference path — the thing that would otherwise rescue this — is
   * unavailable in exactly the case that produces it.
   *
   * Set-level uniqueness is what keeps this from being a guess. Pairing happens only when
   * the two sets are the same size and every credit is legal against every inflow in the
   * group, so there is exactly one *set* of pairings up to ordering; and since every member
   * carries the same amount, each booking's entries are identical whichever way round the
   * bijection falls. What differs between orderings is only which statement row is filed as
   * the evidence for which payout — an audit imprecision, recorded as one, and a far better
   * bargain than escalating both (ADR-0072).
   *
   * `false` for a source we know nothing about, like every other allowance here: a rail
   * nobody declared a policy for gets the strict behaviour.
   */
  readonly pairEqualAmounts: boolean;
  /**
   * How many days after withholding a reserve the source undertook to return it.
   *
   * `null` for a source that declared no schedule, and that is not the same as zero. A
   * reserve with no deadline is recorded and reported — it is still our money in somebody
   * else's account — but it never becomes an exception, because an exception no evidence can
   * clear is the worst entry a queue can hold. Inventing a deadline for a source that
   * promised nothing would manufacture exactly that (ADR-0071).
   *
   * Ninety days is the common Nigerian rolling-reserve term, and it is a *number somebody
   * chose* rather than a truth — which is why it lives in policy beside the calendar and the
   * bank-charge allowance rather than as a constant in the matcher.
   */
  readonly reserveReleaseDays: number | null;
}

/** `null` for a source we hold no profile for. */
export type PolicyLookup = (source: SourceId) => SourcePolicy | null;

/**
 * How an unprofiled source is treated: no fee model, no bank-charge allowance, and a
 * calendar with no patience at all.
 *
 * Items from such a source escalate on the first run. That is the loud failure, and it is
 * the right one — money or promises from a source we know nothing about is exactly the
 * situation that should reach a human immediately, rather than sitting in
 * `pending_settlement` forever because nobody ever declared how long to wait.
 */
export const UNPROFILED_SOURCE: SourcePolicy = {
  calendar: {
    // UTC and no holiday table: not a claim that the source settles in UTC, but the absence
    // of any claim at all. Nothing waits under this calendar long enough for a zone to
    // matter, which is the point.
    timeZone: 'UTC',
    cutOffMinutes: 0,
    settlementBusinessDays: 0,
    weekend: [],
    holidayCalendars: [],
    graceMinutes: 0,
  },
  expectedFee: null,
  bankChargeAllowance: 0n,
  pairEqualAmounts: false,
  // No schedule, because none was declared. Consistent with everything else here: an
  // unprofiled source is one we know nothing about, and pretending to know when its reserves
  // are due is a worse failure than admitting we do not.
  reserveReleaseDays: null,
};

export function policyOf(policyFor: PolicyLookup, source: SourceId): SourcePolicy {
  return policyFor(source) ?? UNPROFILED_SOURCE;
}
