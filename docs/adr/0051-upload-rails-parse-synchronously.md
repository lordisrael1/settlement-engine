# 51. The upload rails parse inside the request

Date: 2026-08-18

## Status

Accepted

## Context

The webhook rail is asynchronous because of who is waiting: a remote system on a retry timer.
Nobody is on that timer for a file upload. Whoever posts the file can wait for the work the
upload implies.

## Decision

`POST /ingest/settlement/:source` and `POST /ingest/bank` take the file as raw bytes, parse
it, and store the evidence and normalised rows before answering. They do not enqueue, and
they do not reconcile — matching is `POST /reconcile/runs`.

## Consequences

- The response says how many payouts and lines were stored, how many were duplicates, and
  which rows were refused and why. An accepted-and-queued upload would answer with a receipt
  and move the same information into a log.
- The parse is row-isolated: a bad row is rejected and reported rather than thrown, so a
  five-thousand-row export with three broken lines stores 4,997. The evidence id is the
  SHA-256 of the bytes, so re-uploading after a failure is free and idempotent.
- The bound is a body limit, not a promise about parser speed. Past a few hundred megabytes
  the parse belongs behind a worker reading the stored bytes; the response already carries
  only the evidence id and counts, so moving the work changes when the counts are final, not
  what a client sees.
- Uploading is not reconciling. A statement landing at 04:00 and three reports arriving
  through the morning are reconciled once, at 09:00, against each other.
