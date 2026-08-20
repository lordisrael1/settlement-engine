# 5. SourceId is an open string, not a union of known providers

Date: 2026-08-15

## Status

Accepted

## Context

Payment sources differ in fees, settlement timing and file formats. A closed union of
provider names in the canonical package would make adding a source an edit to the package
everything else depends on, and would invite exhaustive `switch` statements downstream.

## Decision

`type SourceId = string`. Per-source variation travels as data — a business calendar, a fee
model — attached to the source by its adapter, never as a branch on its name.

## Consequences

- Adding a payment source is one adapter and one row of source data.
- Typos in a source name are not caught by the compiler. They are caught at the ingest
  boundary, where unknown-source handling belongs.
