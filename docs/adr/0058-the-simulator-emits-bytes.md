# 58. The adversarial simulator is a package, and it emits bytes rather than records

Date: 2026-08-19

## Status

Accepted

## Context

The end-to-end suite needs a deliberately messy day whose contents are known in advance. A
simulator that handed the matcher a `Payout` object would exercise the matcher and skip the
boundary — and the boundary is where a real settlement export goes wrong: an unfamiliar fee
type, a declared net that disagrees with its own itemisation, a currency the books are not
kept in, a row that is a debit.

## Decision

`packages/simulator` is a pure, seeded generator producing provider-format files and signed
webhook deliveries, plus a declared statement of what each planted anomaly is. It touches no
database, clock or filesystem, and depends on `@recon/canon` and one connector's signing
helpers.

## Consequences

- Every record the suite reconciles is one the real ingest layer produced from bytes the real
  signature check accepted, so the suite covers ingest as well as matching.
- A package rather than a test fixture, because two consumers already want the same day: the
  suite asserts against it and `apps/pipeline simulate` narrates it. A generator inside one
  test file would be copied on first reuse, and the copy would drift.
- It is the one place outside `packages/ingest` allowed to name a provider, because here it
  is being the remote systems rather than processing their data. Nomba's canonical signing
  string is built with Nomba's own exported helpers: a second implementation of a signing
  scheme is a second thing that can be wrong.
- Ground truth is declared at the moment an anomaly is planted, not derived by running the
  engine. Truth computed from the system under test is the system agreeing with itself.
