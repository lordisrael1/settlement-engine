/**
 * @recon/simulator — the adversary.
 *
 * Everything else in this repository is written to be correct. This package is written to
 * find out whether it is, by producing the files a bad Tuesday actually produces: a
 * renegotiated fee contract with payments on both sides of it, a reversal on a rail that
 * never names its payouts, a chargeback folded in beside the fees, a correspondent-bank
 * charge nobody announced, a payout that is reported and not yet credited, and exactly one
 * credit that belongs to nobody.
 *
 * Three commitments make it worth having:
 *
 *   **It produces bytes, not records.** A simulator that handed the matcher a `Payout`
 *   object would exercise the matcher and skip the boundary — and the boundary is where a
 *   real settlement export goes wrong. Every record downstream of this package is one the
 *   real ingest layer produced from bytes the real signature check accepted.
 *
 *   **It is a function of its seed.** No clock, no `randomUUID`, no filesystem. A red build
 *   hands you one integer that reproduces the exact bytes anywhere, forever (determinism). An
 *   adversarial suite you cannot reproduce has not found a bug; it has produced a rumour.
 *
 *   **Its ground truth is declared, not derived.** What each planted anomaly *is* is decided
 *   at the moment it is planted. Truth computed by running the engine is the engine agreeing
 *   with itself, which it will do just as cheerfully when it is wrong.
 *
 * Read the files in this order:
 *   random.ts    seeded draws, and why `Math.random` is disqualified
 *   wire.ts      the four providers, impersonated down to the signature scheme
 *   generate.ts  the scenario itself, and the arithmetic that keeps it unambiguous
 */

export { random, type Random } from './random.js';

export {
  generate,
  arrivals,
  type Arrival,
} from './generate.js';

export {
  daysBefore,
  naira,
  type GroundTruth,
  type Scenario,
  type ScenarioOptions,
  type SimulatedDelivery,
  type SimulatedFile,
} from './scenario.js';

export {
  bankStatementFile,
  flutterwaveCharge,
  flutterwaveSettlementFile,
  nombaPayment,
  nombaTransactionFile,
  signed,
  type NombaRow,
  type SettlementRow,
  type StatementRow,
} from './wire.js';
