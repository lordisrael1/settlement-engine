# 39. A canonical record traces to a row, and evidence carries a storage locator

Date: 2026-08-16

## Status

Accepted

## Context

"Which file?" was already answerable. In a five-thousand-row export that is not the question:
reproducing a conclusion means finding the row again.

## Decision

Every canonical record carries `lineage: { rowNumber, path }` beside its `evidenceId`,
recorded by the parser. `Evidence` gains `storageLocation`.

## Consequences

- The path is a locator in the artifact's own idiom (`$[3]`, `$.data[3]`), because a locator
  naming the wrong container is worse than none.
- `storageLocation` covers the deployment `evidence.raw` cannot serve: statements run to
  hundreds of megabytes and retention eventually requires deleting the payload while keeping
  the record. It is recorded at ingest and never resolved there, which keeps the ingest layer
  free of a network.
- Three more columns on three tables, and a parser that has to count rows.
