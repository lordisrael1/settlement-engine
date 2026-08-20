import { NoSettlementAdapterError, UnknownSourceError } from '@recon/ingest';
import {
  ImplausibleSettlementError,
  InvalidStateTransitionError,
  LawViolationError,
  UnbalancedTransactionError,
  UnbookablePaymentError,
  UnbookableResolutionError,
  UnknownTransactionError,
} from '@recon/ledger-core';
import { CardDataRefused } from '@recon/protect';
import {
  EvidenceUnavailableError,
  UnapprovedExportError,
  UnapprovedResolutionError,
} from '@recon/reconciler';

/**
 * Which HTTP status a domain refusal deserves — the whole of the translation this layer is
 * allowed to perform.
 *
 * The engine's refusals are not failures of the request; they are the system working. A
 * write-off submitted without an approver, a settlement that would need a plug entry to
 * balance, a resolution that would move `bank_account` — each is a rule doing its job, and
 * each has an error message written for the person who tripped it. Those messages are
 * returned verbatim, because a 422 saying "unprocessable entity" teaches an operator
 * nothing and the one the ledger wrote teaches them the rule.
 *
 * The reverse is also true and is the reason this file exists at all: **the mapping is the
 * only thing the API knows about these errors.** It does not catch them to retry, to
 * soften, or to decide the request was fine after all. If a status code here starts needing
 * a condition — `if this account`, `if that source` — a Law has begun leaking upward and
 * belongs back in the package that owns it.
 */
export function statusFor(error: unknown): number | null {
  // A source nobody has an adapter for is a URL that names nothing.
  if (error instanceof UnknownSourceError) return 404;
  if (error instanceof UnknownTransactionError) return 404;

  // Honest unsupported. Paystack's settlement export has no fixture-verified column
  // layout, so there is no parser — and inventing one is how you get a parser that looks
  // right and is quietly wrong (ADR-0025). "Not implemented" is exactly what that is.
  if (error instanceof NoSettlementAdapterError) return 501;

  // The lifecycle said no: a transition that history does not allow.
  if (error instanceof InvalidStateTransitionError) return 409;

  // The document existed and its bytes did not survive their retention. 410 rather than
  // 404, because "it was destroyed on schedule" and "we have never heard of it" are
  // different facts and only one of them means somebody should go looking (ADR-0065).
  if (error instanceof EvidenceUnavailableError) return 410;

  // Well-formed, understood, and refused on the merits. Every one of these carries a
  // message that names the money and the rule.
  if (error instanceof UnapprovedResolutionError) return 422;
  if (error instanceof UnapprovedExportError) return 422;
  // Authentic, well-formed, and carrying something this system may not hold. Nothing was
  // stored, and the message says so — an operator whose upload is refused needs to know
  // whether they must now go and delete something (ADR-0066).
  if (error instanceof CardDataRefused) return 422;
  if (error instanceof UnbookableResolutionError) return 422;
  if (error instanceof UnbookablePaymentError) return 422;
  if (error instanceof ImplausibleSettlementError) return 422;
  if (error instanceof UnbalancedTransactionError) return 422;
  if (error instanceof LawViolationError) return 422;

  return null;
}
