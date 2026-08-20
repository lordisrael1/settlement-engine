/**
 * Keeping what reconciliation reads, and nothing else.
 *
 * A Paystack `charge.success` body carries `customer.first_name`, `customer.last_name`,
 * `customer.email`, `ip_address`, and an `authorization` object with the card's BIN, last
 * four and expiry. None of it is read by anything in this system: the matcher works on a
 * reference, an amount, a currency, a status, a channel and a timestamp. Every one of those
 * personal fields is stored today only because the payload arrived as one blob and nobody
 * separated the parts (ADR-0064).
 *
 * The redactor is a **keep-list**, not a deny-list, and that choice is the whole design. A
 * deny-list names the fields we know are sensitive and silently passes whatever a provider
 * adds next — and providers add fields without telling anyone, which this codebase already
 * knows and handles for event types. A keep-list names the fields reconciliation reads, and
 * anything new is dropped until somebody decides it is needed. The failure mode of a
 * keep-list is a missing diagnostic field; the failure mode of a deny-list is a new PII
 * column nobody noticed.
 *
 * The list is by **path**, not by key name, which the `customer.id` case makes necessary:
 * `id` is a field the Flutterwave parser reads at `$.data.id` and a customer identifier at
 * `$.data.customer.id`, and a keep-list of bare key names cannot tell them apart.
 *
 * Two structural rules do the rest:
 *
 *   a **scalar** survives only if its own path is on the list;
 *   a **container** survives only if something inside it survived.
 *
 * So `customer` disappears without being named, because nothing inside it is on the list —
 * which is the property that makes this safe against a payload shape nobody has seen.
 *
 * What this does not touch: settlement exports and bank statements. Those are the financial
 * record itself, we are required to keep them, and their personal content — a counterparty
 * name in a narration — is the evidence rather than an accident of transport. They are
 * encrypted and access-logged instead (ADR-0065).
 */

/** The redaction rules' own version, written into every redacted copy. */
export const REDACTION_VERSION = 'keep-list-1';

/**
 * Every path reconciliation reads, across the four connectors `@pay-normalize` provides.
 *
 * Array indices are normalised to `[]`, so one entry covers every element. Grouped by
 * provider because that is how they are checked when a connector changes: the test at the
 * bottom of this package feeds the real fixtures through `redact` and then through the real
 * parser, and asserts the canonical payment is identical — so a path missing from this list
 * is a failing test rather than a surprise six months from now.
 */
const KEPT_PATHS: ReadonlySet<string> = new Set([
  // ── Paystack ──────────────────────────────────────────────────────────────
  '$.event',
  '$.data.id',
  '$.data.status',
  '$.data.reference',
  '$.data.amount',
  '$.data.fees',
  '$.data.currency',
  '$.data.channel',
  '$.data.paid_at',
  '$.data.created_at',
  '$.data.updated_at',
  '$.data.message',
  '$.data.transaction_reference',
  '$.data.transaction_date',
  '$.data.refund_created_at',

  // ── Flutterwave ───────────────────────────────────────────────────────────
  '$.type',
  '$.webhook_id',
  '$.timestamp',
  '$.data.created_datetime',
  '$.data.transaction_datetime',
  '$.data.payment_method.type',
  '$.data.payment_method_details.type',
  '$.data.fees[].amount',
  '$.data.fees[].type',

  // ── Monnify ───────────────────────────────────────────────────────────────
  '$.eventType',
  '$.eventData.transactionReference',
  '$.eventData.paymentReference',
  '$.eventData.paymentStatus',
  '$.eventData.status',
  '$.eventData.amountPaid',
  '$.eventData.amount',
  '$.eventData.fee',
  '$.eventData.settlementAmount',
  '$.eventData.settlementReference',
  '$.eventData.settlementTime',
  '$.eventData.currency',
  '$.eventData.paymentMethod',
  '$.eventData.paidOn',
  '$.eventData.createdOn',
  '$.eventData.completedOn',
  '$.eventData.created_on',
  // The one field of the rejected-payment envelope the parser reads. Its siblings name the
  // payer and their account, and are deliberately not listed.
  '$.eventData.paymentSourceInformation.amountPaid',

  // ── Nomba ─────────────────────────────────────────────────────────────────
  '$.event_type',
  '$.requestId',
  '$.data.transaction.transactionId',
  '$.data.transaction.transactionAmount',
  '$.data.transaction.fee',
  '$.data.transaction.fixedCharge',
  '$.data.transaction.type',
  '$.data.transaction.time',
  '$.data.transaction.entryType',
  '$.data.transaction.responseCode',
  '$.data.transaction.aliasAccountReference',
  // A bank narration is the only thing linking a credit to a payout at most Nigerian banks
  // (ADR-0033), so it is evidence rather than incidental — kept, and it is the one kept
  // field that can contain a person's name.
  '$.data.transaction.narration',
]);

export interface Redaction {
  /** The redacted payload, as bytes. Never hashes to the delivery id — see `content`. */
  readonly bytes: Buffer;
  /** How many scalar values were dropped. Zero means the payload held nothing but kept fields. */
  readonly dropped: number;
}

/**
 * A marker written into every redacted copy.
 *
 * Bytes travel: into an export, onto somebody's laptop, into an email nobody should have
 * sent. A redacted payload that does not say it is redacted will eventually be presented as
 * the payload the provider sent, and the difference matters enough to spend twenty bytes
 * on. Every connector parses with `passthrough`, so the extra key changes no parse.
 */
interface Marker {
  readonly redacted: string;
  readonly dropped: number;
}

/**
 * Drop everything the matcher does not read.
 *
 * Bytes in, bytes out, no source argument: the paths are unambiguous across the four
 * providers, and a redactor that branched on the source would be exactly the
 * `if (source === 'paystack')` this codebase forbids downstream of ingest.
 *
 * Bytes that are not JSON cannot be redacted field by field, and are replaced wholesale.
 * That is the honest answer rather than a conservative one: an unparseable payload is the
 * case where we least know what we are holding, so keeping it because we cannot inspect it
 * has the logic exactly backwards.
 */
export function redact(bytes: Buffer): Redaction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    const marker: Marker & { reason: string } = {
      redacted: REDACTION_VERSION,
      dropped: 0,
      reason:
        'the original bytes were not JSON, so no field-level keep-list could be applied ' +
        'and the payload was replaced whole',
    };
    return { bytes: Buffer.from(JSON.stringify(marker), 'utf8'), dropped: 0 };
  }

  const counter = { dropped: 0 };
  const kept = keep(parsed, '$', counter);
  const marker: Marker = { redacted: REDACTION_VERSION, dropped: counter.dropped };

  const body =
    kept !== undefined && typeof kept === 'object' && kept !== null && !Array.isArray(kept)
      ? { ...(kept as Record<string, unknown>), _redaction: marker }
      : { _redaction: marker, kept: kept ?? null };

  return { bytes: Buffer.from(JSON.stringify(body), 'utf8'), dropped: counter.dropped };
}

/**
 * The recursion. `undefined` means "nothing here survived", which is what makes a container
 * disappear without being named.
 */
function keep(value: unknown, path: string, counter: { dropped: number }): unknown {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => keep(item, `${path}[]`, counter))
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    let any = false;

    for (const [key, item] of Object.entries(value)) {
      const kept = keep(item, `${path}.${key}`, counter);
      if (kept !== undefined) {
        result[key] = kept;
        any = true;
      }
    }

    return any ? result : undefined;
  }

  if (KEPT_PATHS.has(path)) return value;

  // A dropped `null` is not a dropped value: the field was already empty, and counting it
  // would make the number in the marker an argument about JSON rather than about PII.
  if (value !== null) counter.dropped += 1;
  return undefined;
}
