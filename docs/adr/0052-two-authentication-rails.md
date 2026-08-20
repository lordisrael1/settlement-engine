# 52. Signature authentication for providers, an API key for operators

Date: 2026-08-18

## Status

Accepted — the operator-identity half superseded by
[ADR-0066](0066-pci-scope-and-evidence-access.md)

## Context

A payment provider holds no credential of ours. Asking one to present an API key means either
handing a management credential to external companies or maintaining more secrets to no
benefit. What a provider does hold is a shared signing secret.

## Decision

Webhook endpoints authenticate by the provider's signature over the raw bytes and by nothing
else. Every management endpoint requires a static `X-API-Key`, compared in constant time. The
service refuses to start without one.

## Consequences

- A signature over the exact bytes proves both origin and integrity, which is more than a
  bearer token proves.
- The raw bytes are load-bearing. `JSON.parse` followed by re-serialising produces different
  bytes, so a JSON body parser upstream of verification rejects valid payloads,
  intermittently. Fastify scopes content-type parsers to the plugin that declares them, so
  the webhook and upload plugins keep the `Buffer` while management routes receive parsed
  JSON.
- A service that quietly serves balances and accepts uploads because an environment variable
  was missing is a worse failure than one that does not start.
- One static key cannot tell two operators apart, so evidence records the uploader as a claim
  (`X-Recon-Operator`) rather than as a verified identity, and says so.
