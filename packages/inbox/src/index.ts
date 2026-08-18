/**
 * @recon/inbox — the durable acceptance rail.
 *
 * A PSP webhook is the only inbound record this system does not choose the timing of.
 * Somebody else's process, on somebody else's schedule, with a retry timer already
 * running, is holding a connection open waiting for an answer. Everything else — a
 * settlement export, a bank statement — we fetch or an operator uploads, and we can take
 * as long as the work honestly takes.
 *
 * So the webhook rail is split in two, and this package is the seam:
 *
 *   `accept`   verify, write the bytes down, answer. One insert, no interpretation.
 *   `drain`    a worker gives the delivery meaning, at our pace, transactionally.
 *
 * The promise made to the provider is exactly *"we safely received this event"* — not
 * "we finished every downstream financial operation before replying". Those are different
 * promises, and only one of them can be kept in a few milliseconds at a thousand
 * deliveries a second. Conflating them means a slow reconciliation query, a locked balance
 * row or a settlement file being parsed can each make a provider believe a payment was
 * never delivered, and redeliver it — which is how a queue that is merely slow becomes a
 * queue that is growing.
 *
 * What is deliberately absent: any knowledge of payments, signatures, or providers. This
 * package stores deliveries and hands them back; `@recon/ingest` decides what bytes mean
 * and `@recon/ledger-core` decides what the books do about it. The handler passed to
 * `drain` is where a deployable joins the three, which is the only place that join belongs.
 */

export {
  accept,
  deliveryAt,
  deliveryId,
  drain,
  inboxDepth,
  INBOX_MIGRATIONS_DIR,
  type Accepted,
  type ClaimedDelivery,
  type DeliveryHandler,
  type DeliveryOutcome,
  type DeliveryRecord,
  type DrainOptions,
  type DrainReport,
  type InboundDelivery,
} from './inbox.js';
