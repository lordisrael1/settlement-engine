# 67. Format drift is a keyed record with a lifecycle, not a counter in a response

Date: 2026-08-20

## Status

Accepted

## Context

PSP and bank export formats change without notice, and the ingest layer was already careful
about it in every way except one: it could not remember.

Each parser refused what it could not read, row by row, and returned counts — `malformed`
for structurally unusable rows, `not-a-settlement` for valid rows that are not money.
ADR-0020 keeps ingest free of a database, so those counts went into the HTTP response and
nowhere else. A cron job's `curl` discarded them. Nothing could say that a field first
appeared three weeks ago, that somebody was already looking at it, or that it had stopped
appearing — which is the same position ADR-0043 found the exception queue in, one layer up.

Three specific gaps followed from that, and they fire at different times:

**Unknown fields were invisible.** Every connector schema ends in `.passthrough()`. That is
the correct choice for a normalisation library — refusing a row because it grew a field would
break every host on the provider's schedule — but it is also precisely "accept what you do not
understand and say nothing". A key nobody reads is the *earliest* warning available, because
providers extend a format long before they lean on the extension, and nothing in the system
was looking for one.

**Unknown values were misfiled.** A record type the connector has never seen is rejected as
`not-a-settlement` and lands beside the ordinary pending rows that arrive in their thousands.
A count cannot separate those. Similarly, an unrecognised Flutterwave fee type is booked as a
fee and keeps its label — the right handling, since the money is real — but an unrecognised
deduction absorbed into `fee` forever is a permanent overstatement of what a source charges,
arriving later as a fee variance nobody can trace to the afternoon it started.

**A moved container looked like a quiet day.** A parser handed an envelope whose row array has
been renamed finds no rows and reports an empty file, which is indistinguishable from a day on
which nothing settled.

One thing that was *not* a gap, and was assumed to be: a renamed status. Each connector maps
the provider's vocabulary to a closed enum and returns a `parse_error` for anything unmapped,
so a provider renaming `SUCCESSFUL` to `SUCCESS` fails one layer earlier and lands in
`malformed` — the loud counter, and the correct one.

## Decision

Drift becomes an entity, `IngestAnomaly`, with the same three properties ADR-0043 gave the
exception:

- **A derived key**, `(source, kind, detail)`. The same unknown field seen in forty files is
  one anomaly seen forty times. `detail` may therefore never carry a row number, a timestamp
  or a count; those live in columns that vary without splitting the history.
- **An appended lifecycle** in `ingest_anomaly_events`, with `ingest_anomalies` deriving
  current state from the newest event per key — the shape `exception_events` and
  `transaction_state_changes` already use.
- **Self-clearing**, per ADR-0044. `clearConformed` runs on every upload and is scoped to one
  source, so a provider who fixed their own bad afternoon costs nobody a click, and a healthy
  chatty source can never silence a quiet broken one.

Severity comes from the kind and the *share* of the file affected, because one malformed row
in five thousand and four thousand in five thousand are the same kind and different events.
The denominator counts rejected rows, not surviving ones — measuring the share of rows that
parsed would report a file where everything failed as perfectly healthy.

Detection does not reject. A file that drifts is admitted, whatever parsed is stored, and the
response carries a `degraded` marker plus the observed drift. This extends the row-isolation
rule already in force one level down — one mangled row must not cost us the other four
thousand nine hundred and ninety-nine — to the file: a bank adding a column must not stop the
morning's reconciliation.

Anomalies are **not** exceptions. `ExceptionSubject` is deliberately the four things a
`Resolution` can answer, and no human decision about a payout answers "Monnify added a field".
An anomaly has no amount, no due date and no rejected candidates, and filing it there would
widen a vocabulary ADR-0043 and ADR-0034 both depend on in order to hold something nobody
could resolve.

## Consequences

- `SettlementSource` gains `knownFields`, a declared list of every key the adapter and its
  connector read. It is a maintenance obligation on purpose: a field added to a parser and not
  added here reports itself as drift on the next file, which is a loud and cheap reminder. The
  alternative — inferring it from types — is impossible, since TypeScript's knowledge is erased
  long before the bytes arrive.
- Two levels are declarable, because Monnify wraps each row in its own envelope and watching
  only the wrapper would leave the fields that carry the money unwatched.
- The row normalisers stay pure. They return a `DriftNote` rather than taking a mutable
  collector, so mutation is confined to the fold and a row function is still something you can
  call in a test without constructing anything.
- `ingest_anomaly_events.evidence_id` carries a foreign key to `evidence`. An anomaly whose
  file cannot be produced is a complaint with no evidence behind it (ADR-0033).
- A false alarm is possible and is the failure worth having: a spurious anomaly is deleted in
  a minute, while a missed one is what this exists to close.
- What this does not address: `parserVersion` is maintained by hand here while the parsing
  lives in `@pay-normalize/*` at caret ranges, so a patch release can change behaviour while
  the recorded version stays constant. That is a separate decision and is still open.
