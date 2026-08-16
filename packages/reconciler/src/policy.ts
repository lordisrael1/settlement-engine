import type { BusinessCalendar, FeeModel, SourceId } from '@recon/canon';

/**
 * Everything the matcher is told about where a record came from.
 *
 * Note what it is: *data*, handed in. Not a lookup the matcher performs. That is what
 * keeps `if (source === 'paystack')` structurally impossible in here (Law 7) — the
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
   * against a rate nobody agreed to (D-026).
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
};

export function policyOf(policyFor: PolicyLookup, source: SourceId): SourcePolicy {
  return policyFor(source) ?? UNPROFILED_SOURCE;
}
