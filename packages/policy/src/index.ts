/**
 * @recon/policy — the seam, and it is one function long.
 *
 * The matcher needs to know, per source, when money is late and what we expected to be
 * charged. Neither fact is its to hold: the business calendar is declared by the ingest
 * layer alongside the adapter that knows the rail, and fee contracts are administered data
 * with effective dates and an approver, so they live in the database.
 *
 * Neither of those packages may import the other. The reconciler especially must not reach
 * ingest, because the moment it can read a source table it can branch on a source name
 * The missing edge is load-bearing, and it is why `SourcePolicy` is handed *in* rather
 * than looked up. So something has to join them, and that something is allowed to
 * import both precisely because it contains no matching logic to corrupt: it fetches, it
 * joins, it hands over a lookup.
 *
 * This lived in `apps/pipeline` while the CLI was the only deployable. The service added a
 * second one, and two copies of a join that decides how long to wait before calling money
 * late is two copies that can disagree — which would mean the API and the CLI reconciling
 * the same database to different answers. So it is a library, imported by both.
 *
 * Nothing depends on this except deployables, and it depends on everything below it. That
 * is deliberate: it is the only package with that shape, and if a second one appears it is
 * probably an app that forgot to run.
 */

export { buildPolicy } from './policy.js';
