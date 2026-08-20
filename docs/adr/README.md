# Architecture Decision Records

Each file records one decision: the context that forced it, the decision itself, and the
consequences accepted. The format follows Michael Nygard's template.

Records are immutable once merged. A decision that changes is superseded by a new record
that says so, and the old one keeps its number and its status line.

New record: copy the most recent file, take the next number, and add a row below.

| # | Decision | Status |
|---|---|---|
| 0001 | [PostgreSQL is the ledger's system of record](0001-postgresql-as-system-of-record.md) | Accepted |
| 0002 | [npm workspaces with TypeScript project references, and no build tool](0002-npm-workspaces-with-project-references.md) | Accepted |
| 0003 | [A package gets a manifest when it has something to export](0003-packages-gain-manifests-when-they-have-code.md) | Superseded — every package listed here now has a manifest and source |
| 0004 | [A payment is two ledger transactions, and deductions are booked at settlement](0004-two-transactions-per-payment.md) | Accepted — amended by ADR-0027 and ADR-0031 |
| 0005 | [SourceId is an open string, not a union of known providers](0005-source-id-is-an-open-string.md) | Accepted |
| 0006 | [Money is a typed wrapper, not a bare bigint](0006-money-is-a-typed-wrapper.md) | Accepted |
| 0007 | [Timestamps are Date, and the current time is always an argument](0007-timestamps-are-passed-in.md) | Accepted |
| 0008 | [SettlementWindow models a deadline only](0008-settlement-window-models-a-deadline.md) | Superseded by ADR-0031 |
| 0009 | [Payment status has a total order, defined in the canonical package](0009-payment-status-ranking.md) | Accepted — the naming half superseded by ADR-0013 |
| 0010 | [Source narration is retained verbatim and never parsed for decisions](0010-narration-is-evidence-not-a-decision.md) | Accepted |
| 0011 | [The canonical package ships without tests](0011-no-test-harness-in-canon.md) | Superseded by ADR-0023 — the harness arrived with the ledger |
| 0012 | [pay-normalize is consumed as a published npm dependency](0012-pay-normalize-as-an-npm-dependency.md) | Accepted |
| 0013 | [Canonical payment status adopts the upstream spelling](0013-canonical-status-spelling.md) | Accepted — supersedes the naming half of ADR-0009 |
| 0014 | [A transaction's id is the causing event's idempotency key](0014-transaction-id-is-the-idempotency-key.md) | Accepted |
| 0015 | [Balance-zero and append-only are enforced by database triggers](0015-invariants-enforced-by-database-triggers.md) | Accepted |
| 0016 | [Transaction lifecycle state is derived, not stored](0016-lifecycle-state-is-derived.md) | Accepted |
| 0017 | [Idempotency keys take the connector's dedupe key whole](0017-idempotency-keys-use-the-connector-dedupe-key.md) | Accepted |
| 0018 | [Upstream kobo is a number; canonical kobo is a bigint](0018-kobo-widened-to-bigint.md) | Accepted |
| 0019 | [SettlementLine.settledAt is nullable](0019-settled-at-is-nullable.md) | Accepted |
| 0020 | [Ingest has no database, and deduplication takes an injected predicate](0020-ingest-has-no-database.md) | Accepted |
| 0021 | [Chart-of-accounts policy lives in the ledger core, not in the application](0021-chart-of-accounts-policy-lives-in-ledger-core.md) | Accepted |
| 0022 | [A CLI deployable is built before the HTTP service](0022-a-cli-deployable-alongside-the-service.md) | Accepted |
| 0023 | [Plain SQL migrations with a checksum-verifying runner](0023-plain-sql-migrations.md) | Accepted — supersedes ADR-0011 |
| 0024 | [reverse() is an exact negation and nothing more](0024-reverse-is-an-exact-negation.md) | Accepted |
| 0025 | [No Paystack settlement adapter](0025-no-paystack-settlement-adapter.md) | Accepted |
| 0026 | [Windows mark a deadline, and a rate card may be null](0026-deadline-windows-and-nullable-rate-cards.md) | Accepted — the window half superseded by ADR-0031, the fee half by ADR-0030 |
| 0027 | [Reconciliation is three-way: webhook, PSP report, bank statement](0027-three-way-reconciliation.md) | Accepted |
| 0028 | [The payout is a first-class entity, and inflows unify the two source shapes](0028-payouts-and-expected-inflows.md) | Accepted |
| 0029 | [Deductions are named, and a booking that needs a plug is refused](0029-named-deductions-and-no-plug-entries.md) | Accepted |
| 0030 | [Fee contracts are versioned data, not a function](0030-versioned-fee-contracts.md) | Accepted — supersedes the fee half of ADR-0026 |
| 0031 | [Deadlines are business days and cut-offs, not fixed minutes](0031-business-day-deadlines.md) | Accepted — supersedes ADR-0008 and the window half of ADR-0026 |
| 0032 | [Allocation is an amount, so settlement can be partial and split](0032-allocations-carry-an-amount.md) | Accepted |
| 0033 | [Evidence is content-addressed and retained; narration is tokenised](0033-content-addressed-evidence.md) | Accepted — the retention half superseded by ADR-0065 |
| 0034 | [Human resolutions are appended, never applied](0034-resolutions-are-append-only.md) | Accepted |
| 0035 | [The matcher escalates ambiguity rather than resolving it](0035-the-matcher-escalates-ambiguity.md) | Accepted |
| 0036 | [The reason-code taxonomy covers the three-way model](0036-reason-code-taxonomy.md) | Accepted |
| 0037 | [Fee contracts are scoped by channel and currency](0037-fee-contract-scoping.md) | Accepted |
| 0038 | [Calendars name a time zone, and holiday tables are versioned](0038-time-zones-and-versioned-holiday-tables.md) | Accepted |
| 0039 | [A canonical record traces to a row, and evidence carries a storage locator](0039-record-lineage-and-storage-locators.md) | Accepted |
| 0040 | [Batch deductions are apportioned pro rata by gross, by largest remainder](0040-pro-rata-apportionment.md) | Accepted |
| 0041 | [The contract that explained a decision is stored with the decision](0041-fee-explanations-stored-with-the-match.md) | Accepted |
| 0042 | [Resolutions are keyed, valued, maker-checked, and may not touch cash](0042-maker-checker-on-resolutions.md) | Accepted |
| 0043 | [An exception is an entity with an appended lifecycle and a derived key](0043-exceptions-are-entities.md) | Accepted |
| 0044 | [The exception queue clears itself by diffing each run against what is open](0044-the-queue-clears-itself.md) | Accepted |
| 0045 | [The matcher keeps the candidates it rejected](0045-rejected-candidates-are-retained.md) | Accepted |
| 0046 | [Returned payouts and duplicate credits are produced, not merely declared](0046-returned-and-duplicate-bank-credits.md) | Accepted |
| 0047 | [The event log is written beside the ledger, not instead of it](0047-event-log-beside-the-ledger.md) | Accepted |
| 0048 | [The log opens with a genesis event](0048-genesis-event.md) | Accepted |
| 0049 | [The product database is not a fourth record](0049-the-product-database-is-not-a-record.md) | Accepted |
| 0050 | [A webhook is accepted durably and interpreted afterwards](0050-webhooks-accepted-durably.md) | Accepted |
| 0051 | [The upload rails parse inside the request](0051-upload-rails-parse-synchronously.md) | Accepted |
| 0052 | [Signature authentication for providers, an API key for operators](0052-two-authentication-rails.md) | Accepted — the operator-identity half superseded by ADR-0066 |
| 0053 | [Structural scaling concerns are built now; capacity tuning is deferred](0053-scaling-decisions-built-and-deferred.md) | Accepted |
| 0054 | [Summarising and resolving live in the reconciler, not in route handlers](0054-domain-logic-stays-out-of-the-api.md) | Accepted |
| 0055 | [The policy join is a package, because two deployables need it](0055-the-policy-join-is-a-package.md) | Accepted |
| 0056 | [The service migrates on boot, under an advisory lock](0056-migrations-run-on-boot-under-a-lock.md) | Accepted |
| 0057 | [Bank evidence arrives as an uploaded statement; a feed is an adapter behind the same boundary](0057-bank-evidence-arrives-as-an-upload.md) | Accepted |
| 0058 | [The adversarial simulator is a package, and it emits bytes rather than records](0058-the-simulator-emits-bytes.md) | Accepted |
| 0059 | [Generated amounts carry a kobo salt, so the matcher is never asked to guess](0059-kobo-salt-for-unambiguous-subsets.md) | Accepted |
| 0060 | [Arrival order is an argument, and the final state may not depend on it](0060-arrival-order-independence.md) | Accepted |
| 0061 | [The chargeback settlement status is unreachable through ingest, and is recorded as a gap](0061-chargeback-settlement-status-is-unreachable.md) | Accepted |
| 0062 | [simulate runs in a schema of its own](0062-simulate-runs-in-its-own-schema.md) | Accepted |
| 0063 | [Evidence is encrypted per record, and the keys are not in the database](0063-envelope-encryption-for-evidence.md) | Accepted |
| 0064 | [Provider payloads are reduced to a keep-list, and the signature is not re-runnable afterwards](0064-redaction-at-the-boundary.md) | Accepted |
| 0065 | [Evidence is split into an immutable record and an expiring body, on a schedule a command runs](0065-evidence-retention-schedule.md) | Accepted — supersedes the retention half of ADR-0033 |
| 0066 | [Tokens and approved truncations only, and every read of a document is attributable](0066-pci-scope-and-evidence-access.md) | Accepted — supersedes the operator-identity half of ADR-0052 |
| 0067 | [Format drift is a keyed record with a lifecycle, not a counter in a response](0067-format-drift-is-a-record-not-a-counter.md) | Accepted |
