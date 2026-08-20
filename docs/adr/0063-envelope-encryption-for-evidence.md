# 63. Evidence is encrypted per record, and the keys are not in the database

Date: 2026-08-20

## Status

Accepted

## Context

`evidence` stored settlement exports, bank statements and webhook payloads as plaintext
`BYTEA`. The protection was whatever the deployment's disk encryption gave it.

Disk encryption defends against somebody carrying the server out of the building. That is
not how this data leaks. It leaks through a `pg_dump` taken to debug something, a read
replica nobody remembered was there, and a backup on object storage with the wrong ACL —
and all three read the bytes through Postgres, or through a file Postgres wrote, with the
disk already decrypted.

A deployment also has to be able to rotate a key without rewriting every payload, and has to
be able to say which key sealed a given record.

## Decision

Evidence bytes are encrypted in the application, per record, with **AES-256-GCM** and a
fresh data key that is wrapped by a root key the database has never seen. Only the wrapped
key is stored. The additional authenticated data is the **evidence id**.

`KeyRing` is deliberately the shape of a KMS `Encrypt`/`Decrypt` pair — a key id, an opaque
wrapped blob, an encryption context. `localKeyRing` holds a root key in the process, which
is the honest option for a deployment that has not chosen a KMS, and is explicitly not the
destination: an AWS KMS, GCP KMS or Vault transit adapter implements the same two methods,
and the only call sites are `vaultFromEnv` in each deployable.

`recordEvidence` takes a key ring rather than a flag. There is no unencrypted path to
forget.

## Consequences

- A `pg_dump`, a replica or a leaked backup carries ciphertext. That is the exposure this
  addresses and the only one it claims to.
- Binding the ciphertext to the evidence id means a row anybody can write cannot serve one
  document's bytes as another document's evidence: decryption under the wrong id fails.
- Rotation re-wraps data keys instead of re-encrypting payloads, which is why
  `evidence_blobs` is deliberately mutable (ADR-0065). A retired key must stay configured
  for as long as anything sealed under it is still within its retention; dropping it early
  does not delete that evidence, it makes it unreadable.
- The local key ring gives up three things, stated so nobody has to work them out later: the
  key is in the process environment, so anything that can read the environment can read
  every blob; key use produces no independent audit trail, so the only record of a
  decryption is one this system writes about itself; and destroying a key is a configuration
  change rather than an API call somebody else's logs record. A KMS fixes all three, and
  `Decrypt` calls landing in CloudTrail would give a second audit trail the database cannot
  forge.
- The service refuses to start without `RECON_EVIDENCE_KEY`. Falling back to plaintext when
  a variable is missing would be a system that quietly stops doing this, discovered by an
  auditor rather than by a deploy.
- `docker-compose.yml` no longer publishes Postgres on `0.0.0.0`. With encrypted evidence in
  the database the old comment — "remove for any deployment where the database should only
  be reachable from the service" — describes an incident rather than a convenience.
