import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * A ceiling on how fast one caller may knock.
 *
 * This exists because of one endpoint. `POST /webhooks/:source` is unauthenticated by
 * design — the signature over the body *is* the authentication (ADR-0052) — which means the
 * work of deciding a request is unauthentic happens **before** anything rejects it: up to
 * `webhookBytes` are buffered into memory and an HMAC-SHA512 is computed over all of them,
 * and only then does the 401 go out. Junk never reaches the database, which was always the
 * important half; what was missing is that junk still costs CPU and memory in proportion to
 * how much of it arrives, on a URL anybody who has read the docs can find.
 *
 * **What this is not.** It is per-process and in-memory, so two replicas allow twice the
 * rate, a restart forgets everything, and an attacker with a thousand source addresses is
 * a thousand callers as far as it is concerned. None of those are oversights to be fixed
 * here: a rate limit that actually holds against a distributed flood belongs at the edge —
 * a WAF, an API gateway, Cloudflare — where it can see all the traffic and drop it before it
 * costs a TLS handshake. That deployment requirement is stated in the README and the
 * compose file rather than implied.
 *
 * What this *is*: the floor. A deployment that forgets the gateway is no longer completely
 * open, a single misconfigured client cannot spin the CPU, and the limit is visible in code
 * rather than being a thing everybody assumed somebody else had done.
 */

export interface RateLimit {
  /** Requests allowed per window, per caller. Zero disables the limiter entirely. */
  readonly perWindow: number;
  readonly windowMs: number;
  /**
   * How many distinct callers to remember.
   *
   * A bound, not a tuning knob. Keying by client address means the key space is chosen by
   * whoever is calling, and an unbounded map keyed by attacker-supplied values is a memory
   * exhaustion bug wearing the costume of a defence against one. Past this, the oldest
   * windows are dropped — which is the safe direction: a forgotten caller is allowed
   * through, never wrongly refused.
   */
  readonly maxKeys: number;
}

export const DISABLED: RateLimit = { perWindow: 0, windowMs: 60_000, maxKeys: 0 };

interface Window {
  count: number;
  /** When this window ends. Also the eviction order key. */
  resetAt: number;
}

/**
 * A fixed-window counter, deliberately.
 *
 * A sliding window or a token bucket would be smoother at the boundary — a fixed window
 * admits up to twice the rate across the seam between two windows — and neither is worth
 * the state here. The number that matters is the order of magnitude: this is between "one
 * client cannot spin the CPU" and "no limit at all", not between two carefully tuned rates.
 */
export class FixedWindow {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly limit: RateLimit) {}

  /**
   * Record one request and say whether it is allowed.
   *
   * `now` is an argument like every other clock in this repository, so the suite can prove
   * the window rolls over without waiting a minute for it.
   */
  take(key: string, now: number): { allowed: boolean; retryAfterMs: number } {
    if (this.limit.perWindow === 0) return { allowed: true, retryAfterMs: 0 };

    const existing = this.windows.get(key);
    if (!existing || existing.resetAt <= now) {
      this.evictIfFull(now);
      this.windows.set(key, { count: 1, resetAt: now + this.limit.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }

    existing.count += 1;
    return existing.count > this.limit.perWindow
      ? { allowed: false, retryAfterMs: existing.resetAt - now }
      : { allowed: true, retryAfterMs: 0 };
  }

  /** How many callers are being tracked. For the health endpoint, and for the suite. */
  get size(): number {
    return this.windows.size;
  }

  /**
   * Make room, cheaply.
   *
   * Expired windows first, because dropping those loses nothing at all. Only if that frees
   * nothing does it drop live ones, oldest-reset first — which is the closest thing to
   * least-recently-started without keeping a second index.
   */
  private evictIfFull(now: number): void {
    if (this.windows.size < this.limit.maxKeys) return;

    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    if (this.windows.size < this.limit.maxKeys) return;

    const oldest = [...this.windows.entries()]
      .sort((a, b) => a[1].resetAt - b[1].resetAt)
      .slice(0, Math.max(1, Math.floor(this.limit.maxKeys / 4)));
    for (const [key] of oldest) this.windows.delete(key);
  }
}

/**
 * Install a limiter over every route in the scope it is registered in.
 *
 * Registered per plugin rather than globally, because the two rails want different keys and
 * different numbers. The webhook rail is keyed by client address — there is no principal, by
 * design — and set high enough that a provider's genuine burst on a busy morning passes
 * without a thought. The management rail is keyed by principal where there is one, so one
 * operator's runaway script cannot lock out another's.
 *
 * `/health` is deliberately never limited by anything registered here: it lives in its own
 * plugin, and a health check refused with a 429 is a load balancer removing a healthy
 * instance from rotation.
 */
export function rateLimit(
  app: FastifyInstance,
  limit: RateLimit,
  keyOf: (request: FastifyRequest) => string,
  now: () => Date,
): void {
  if (limit.perWindow === 0) return;

  const windows = new FixedWindow(limit);

  // `onRequest` — the earliest hook Fastify offers, before the body is read. That is the
  // whole point: the cost this is defending against is buffering the body and hashing it,
  // and a limiter that ran after the payload was parsed would have already paid it.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const outcome = windows.take(keyOf(request), now().getTime());
    if (outcome.allowed) return;

    const seconds = Math.ceil(outcome.retryAfterMs / 1000);
    return reply
      .code(429)
      .header('retry-after', String(seconds))
      .send({
        error:
          `Too many requests. This instance allows ${limit.perWindow} per ` +
          `${Math.round(limit.windowMs / 1000)}s per caller; try again in ${seconds}s.`,
      });
  });
}

/**
 * Who is calling, for limiting purposes.
 *
 * `request.ip` is Fastify's, which respects `trustProxy` when it is configured and otherwise
 * reports the socket address. Behind a load balancer with `trustProxy` unset, every caller
 * shares the balancer's address and this becomes a global limit — which is a real trap, and
 * the reason the README says to configure `trustProxy` or to put the real limit at the edge.
 */
export function addressOf(request: FastifyRequest): string {
  return request.ip || 'unknown';
}
