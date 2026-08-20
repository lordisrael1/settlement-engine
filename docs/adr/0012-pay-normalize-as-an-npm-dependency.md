# 12. pay-normalize is consumed as a published npm dependency

Date: 2026-08-15

## Status

Accepted

## Context

The ingest layer needs signature verification, amount conversion, provider status
vocabularies and settlement parsing. `pay-normalize` provides these and is published to npm
under a scope; the unscoped package name does not exist.

## Decision

`packages/ingest` depends on `@pay-normalize/core`, `/paystack`, `/flutterwave`, `/nomba`
and `/monnify` from the npm registry.

## Consequences

- The Docker build context stays self-contained. Vendored tarballs or a `file:../` link
  would put a sibling repository outside the build context and break the image.
- The ingest layer is thin. `@pay-normalize/core` already defines a `Connector` interface
  including `parseSettlementFile`, and Flutterwave, Nomba and Monnify ship working parsers.
  It also owns kobo conversion, status ranking, dedupe-key composition and four signature
  schemes.
- What remains for this repository is the translation into canonical types plus the two
  facts a stateless normalisation library will not have: an expected settlement window and
  an expected fee.
- The supported sources are Paystack, Flutterwave, Nomba and Monnify — the connectors that
  exist.
