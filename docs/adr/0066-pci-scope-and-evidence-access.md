# 66. Tokens and approved truncations only, and every read of a document is attributable

Date: 2026-08-20

## Status

Accepted — supersedes the operator-identity half of ADR-0052

## Context

Two questions an assessor asks, and this system could answer neither well.

**What card data do you store?** The honest answer was good: no PAN, because a BIN plus a
last four is the truncated form PCI DSS treats as the maximum that may be displayed and the
middle digits never reach us; no sensitive authentication data, because no payload contains
a CVV, track data or a PIN block; and `authorization_code` is a provider token rather than a
card number. But that was a fact about the four adapters we have and the payload shapes they
send this month, not a property of the system. A new adapter or a changed payload could
bring a full PAN into `webhook_inbox.raw` tomorrow.

**Who read this document?** Nothing recorded reads at all. Every control in the system
governs writes — the balance-zero invariant, the append-only triggers, maker-checker on
resolutions — and none of them notices somebody reading a hundred thousand evidence records
on a Sunday. Exfiltration is a read.

Worse, there was nobody to record. ADR-0052 gave the service one shared management key and
took the operator's name from an `X-Recon-Operator` header, recorded as an unverified claim.
That was honest and nearly worthless: it answers "what did somebody type?" rather than "who
did this?".

## Decision

**The PCI claim becomes an invariant.** `refuseCardData` scans every delivery and every
upload for Luhn-valid digit runs under a real issuer prefix *and* a length that scheme
issues, and for field names that carry sensitive authentication data. Anything it finds is
refused with a 422 and **nothing is stored** — the scan runs on the webhook request path
between the signature check and the insert, which is the only place that can keep a card
number out of the database at all. Expiry month and year are dropped by the keep-list; there
is no reconciliation use for them.

**Keys belong to named principals.** `RECON_API_KEYS` is a list of
`principal:secret:grant|grant`; the verified principal is what every audit record carries,
and it is what `receivedFrom` records on an upload. Two grants exist, and only two:
`evidence.raw` and `evidence.export`.

**Reading a document is its own endpoint.** `GET /evidence/:id/raw` is separate from
`GET /evidence/:id`, requires the grant, requires a `reason`, and writes to an append-only
`evidence_access` table naming the principal, the action, the reason, the request id and the
time.

**Export is maker-checked, with the control that already exists.** A redacted export needs
no approver; an original needs a second named person, measured by ADR-0042's
`ApprovalPolicy` and refused by a database constraint that also refuses self-approval. The
archive is sealed under a key returned exactly once and never stored, delivered through a
short-lived single-use link.

## Consequences

- "We do not store card numbers" is now enforced by the same kind of mechanism as "entries
  sum to zero": a refusal at the boundary, with a test that feeds a synthetic PAN through
  `ingestWebhook` and asserts nothing is written. The honest position to hand an assessor is
  **tokens and approved truncations only** — and it is your acquirer or QSA who confirms
  scope, not this document.
- Prefix *and* length together, not Luhn alone. Luhn alone refuses roughly one arbitrary
  sixteen-digit identifier in ten, and a guard that refuses one upload in ten is a guard
  somebody switches off within a week. A seventeen-digit settlement reference beginning
  `300` passes Luhn and matches the Diners prefix, and is not a card, because Diners issues
  fourteen digits.
- A finding travels into an error message, a log line and an alert, so it carries the field
  name or a masked form and never the digits. A guard against storing card numbers that
  writes the card number to the application log has moved the problem.
- Refusing rather than silently redacting: a payload with a PAN in it is a bug in an adapter
  or a mistake by an operator, and cleaning it up quietly would hide both while leaving the
  bytes in a proxy buffer and a crash report upstream.
- `RECON_API_KEY` is not a fallback — the service refuses to start if it is set, naming the
  replacement. One shared key would make the access log a list of the word "api".
- Keys are looked up by digest rather than compared in a loop, so there is no timing channel
  and no cost that grows with the number of principals.
- This is **not** OIDC and does not pretend to be. Static keys do not expire on their own,
  carry no group membership, and revoking one is a deploy. What they do give is the property
  the access log needs: two operators are two principals, and no configuration change makes
  them the same one. When an identity provider arrives, `Principals.authenticate` is the
  function that changes and nothing downstream of a principal changes with it.
- The alert worth building is on **volume** — one principal, many documents, a short window —
  which `accessVolume` counts. No per-request check can see it, because every individual
  request in that pattern is legitimate.
- An export archive stored in a form the service can read would make `evidence_exports` a
  second copy of every document anybody ever exported. Sealing it under a key we do not keep
  is what makes "delivered as an encrypted archive" mean anything.
- The signed link is ours today because there is no object storage. The contract — short
  lived, single use, encrypted payload, recorded with a reason — is the same one a bucket's
  signed URL provides, so moving to one changes the delivery and nothing above it.
