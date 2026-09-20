/**
 * src/lib/rateLimit.ts
 * ---------------------------------------------------------------------------
 * Sliding-window rate limiting, in process memory.
 *
 * Scope, stated plainly: this counts requests inside ONE Node process. The app
 * runs as a single `next dev` / `next start` process on localhost, so that is
 * the whole system and the counts are complete. If this is ever put behind more
 * than one instance, each instance gets its own counters and the effective
 * limit multiplies by the instance count — at that point this needs to move to
 * Redis or the database. Nothing here silently pretends otherwise.
 *
 * The map is pinned to globalThis because Next.js re-evaluates modules on every
 * hot reload in dev. Without that, editing any file would reset every counter
 * and hand an attacker a free window on each save.
 */

export interface RateLimitRule {
  /** How many hits are allowed inside the window. */
  limit: number;
  /** Width of the sliding window, in milliseconds. */
  windowMs: number;
  /**
   * How long to lock the key out after the limit is exceeded. Optional; when
   * omitted the caller is simply refused until the window slides far enough
   * that an older hit drops off.
   */
  blockMs?: number;
}

export interface RateLimitResult {
  /** True when the caller may proceed. */
  ok: boolean;
  /** Hits still available in the current window. Zero when `ok` is false. */
  remaining: number;
  /** Milliseconds until the caller may retry. Zero when `ok` is true. */
  retryAfterMs: number;
}

interface Bucket {
  /** Timestamps of hits inside the window, oldest first. */
  hits: number[];
  /** Set when a block is active; the key is refused until this moment. */
  blockedUntil: number;
}

declare global {
  /* eslint-disable-next-line no-var */
  var __omnirouteRateLimit: Map<string, Bucket> | undefined;
}

const buckets: Map<string, Bucket> =
  globalThis.__omnirouteRateLimit ?? new Map<string, Bucket>();
globalThis.__omnirouteRateLimit = buckets;

/**
 * Drop buckets that have gone quiet so a long-running process does not grow a
 * map entry per unique identifier forever. Called opportunistically rather than
 * on a timer — a timer would hold the event loop open and interfere with
 * shutdown.
 */
let lastSweep = 0;
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    const newest = bucket.hits.length ? bucket.hits[bucket.hits.length - 1] : 0;
    const idleSince = Math.max(newest, bucket.blockedUntil);
    if (now - idleSince > 3_600_000) buckets.delete(key);
  }
}

/**
 * Record a hit against `key` and report whether it is allowed.
 *
 * Note that calling this CONSUMES a hit. To ask without consuming, use
 * {@link peekRateLimit}.
 */
export function rateLimit(key: string, rule: RateLimitRule): RateLimitResult {
  const now = Date.now();
  sweep(now);

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [], blockedUntil: 0 };
    buckets.set(key, bucket);
  }

  if (bucket.blockedUntil > now) {
    return { ok: false, remaining: 0, retryAfterMs: bucket.blockedUntil - now };
  }

  const windowStart = now - rule.windowMs;
  /* Hits are appended in time order, so everything to drop is a prefix. */
  let firstLive = 0;
  while (firstLive < bucket.hits.length && bucket.hits[firstLive] <= windowStart) {
    firstLive++;
  }
  if (firstLive > 0) bucket.hits.splice(0, firstLive);

  if (bucket.hits.length >= rule.limit) {
    if (rule.blockMs && rule.blockMs > 0) {
      bucket.blockedUntil = now + rule.blockMs;
      return { ok: false, remaining: 0, retryAfterMs: rule.blockMs };
    }
    /* No explicit block: the caller waits for the oldest hit to age out. */
    const oldest = bucket.hits[0] ?? now;
    return {
      ok: false,
      remaining: 0,
      retryAfterMs: Math.max(1, oldest + rule.windowMs - now),
    };
  }

  bucket.hits.push(now);
  return {
    ok: true,
    remaining: Math.max(0, rule.limit - bucket.hits.length),
    retryAfterMs: 0,
  };
}

/** Report the current state of `key` without consuming a hit. */
export function peekRateLimit(key: string, rule: RateLimitRule): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket) return { ok: true, remaining: rule.limit, retryAfterMs: 0 };

  if (bucket.blockedUntil > now) {
    return { ok: false, remaining: 0, retryAfterMs: bucket.blockedUntil - now };
  }

  const windowStart = now - rule.windowMs;
  const live = bucket.hits.filter((t) => t > windowStart);
  if (live.length >= rule.limit) {
    const oldest = live[0] ?? now;
    return {
      ok: false,
      remaining: 0,
      retryAfterMs: Math.max(1, oldest + rule.windowMs - now),
    };
  }
  return { ok: true, remaining: rule.limit - live.length, retryAfterMs: 0 };
}

/** Forget a key entirely — used after a successful login clears the penalty. */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/**
 * Whether the proxy headers may be believed.
 *
 * `x-forwarded-for` is set by the client unless something in front of the app
 * overwrites it. Trusting it unconditionally means an attacker sends a
 * different value on every request, lands in a fresh bucket each time, and the
 * per-IP limit never fires. So it is opt-in, and only correct when a reverse
 * proxy (Cloudflare Tunnel, nginx, Caddy) is actually rewriting the header.
 */
function trustProxyHeaders(): boolean {
  const raw = (process.env.OMNIROUTE_TRUST_PROXY ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * The bucket every client shares when the source address cannot be determined.
 * Named so callers can reason about it rather than comparing bare strings.
 *
 * Declared before `clientIp` because that function compares against it. A
 * `const` is hoisted but not initialised, and while the call always happens
 * long after this module finishes evaluating, depending on that is a needless
 * subtlety.
 */
export const UNTRUSTED_IP = "untrusted";

/**
 * How many proxies sit in front of this app.
 *
 * 1 (the default) is one terminator — Caddy, nginx, or a Cloudflare Tunnel
 * connector — talking straight to the container, which is the layout in
 * docker-compose.yml and the deployment guide. Cloudflare's proxy *plus* a
 * local terminator is 2.
 *
 * Only used to decide how far from the right of `x-forwarded-for` to read. Too
 * large and the value drifts into client-controlled entries, so it is clamped
 * at the call site; too small and several visitors share a bucket, which merely
 * over-limits.
 */
function proxyDepth(): number {
  const raw = Number.parseInt(
    (process.env.OMNIROUTE_PROXY_DEPTH ?? "").trim(),
    10,
  );
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
}

/**
 * Best-effort client address for rate-limit keying.
 *
 * There is no socket address available in a route handler, so without a trusted
 * proxy the honest answer is a single shared bucket rather than a forged one.
 * That is not a loss: every caller also keys on the identifier being acted upon
 * (the email or phone number), which is what actually protects an account from
 * being brute-forced. The IP dimension is defence in depth on top of that.
 *
 * WHY THE RIGHTMOST VALUE, NOT THE LEFTMOST
 *
 * `x-forwarded-for` is a comma-separated list that proxies APPEND to. nginx's
 * `$proxy_add_x_forwarded_for`, Caddy and Cloudflare all take whatever arrived
 * and add the address they saw it come from, on the right.
 *
 * So the leftmost entry is the part the CLIENT supplied, and it is free text. A
 * caller that sends `x-forwarded-for: <random>` on every request would land in a
 * fresh bucket each time and never hit the limit — which is the exact bypass
 * this function exists to prevent. Reading the rightmost entry instead yields
 * the address our own proxy observed, which a client cannot control.
 *
 * The cost of this choice is that behind TWO proxies the rightmost value is the
 * inner proxy rather than the visitor, so everyone shares a bucket again. That
 * fails closed (over-limiting, not under-limiting) and is the safer direction to
 * be wrong in. `OMNIROUTE_PROXY_DEPTH` adjusts it for that case.
 */
export function clientIp(request: Request): string {
  if (trustProxyHeaders()) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const parts = forwarded
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);

      if (parts.length > 0) {
        /* Count in from the right: depth 1 (the default) is the address the
         * nearest proxy saw. Clamped so a misconfigured depth larger than the
         * list cannot walk into client-supplied territory. */
        const depth = proxyDepth();
        const index = Math.max(0, parts.length - depth);
        const candidate = parts[index];
        /* A client could send the literal sentinel to try to claim the shared
         * bucket's larger allowance; refuse to hand it over. */
        if (candidate && candidate !== UNTRUSTED_IP) return candidate;
      }
    }
    const real = request.headers.get("x-real-ip")?.trim();
    if (real && real !== UNTRUSTED_IP) return real;
  }
  return UNTRUSTED_IP;
}

/**
 * How much headroom the shared bucket gets.
 *
 * Without a trusted proxy every caller keys on {@link UNTRUSTED_IP}, so a
 * per-IP limit sized for one client becomes a limit on the ENTIRE user base.
 * The send-otp gate allows 20 sends per 15 minutes; applied to a shared bucket
 * that means roughly twenty sign-in attempts across all users exhausts it and
 * locks out everybody for ten minutes. A denial of service dressed as a
 * defence.
 *
 * Scaling the limit keeps both properties that matter: there is still a hard
 * ceiling on how much email or SMS a stranger can trigger (the operator's money
 * and sending reputation), but the ceiling is sized for a population, not for
 * one person. Once `OMNIROUTE_TRUST_PROXY=true` is set behind a real proxy each
 * client is counted separately and the base limit applies again.
 */
const UNTRUSTED_LIMIT_MULTIPLIER = 25;

/**
 * Per-source rate limit for a route handler.
 *
 * Prefer this over a bare `rateLimit(\`…:${clientIp(request)}\`)`: it is the
 * same thing, except that an unidentifiable source degrades to a generous
 * shared ceiling instead of a strict one-client limit that a single visitor
 * could trip for everyone.
 */
export function rateLimitByIp(
  prefix: string,
  request: Request,
  rule: RateLimitRule,
): RateLimitResult {
  const ip = clientIp(request);
  if (ip !== UNTRUSTED_IP) return rateLimit(`${prefix}:${ip}`, rule);
  return rateLimit(`${prefix}:${ip}`, {
    ...rule,
    limit: rule.limit * UNTRUSTED_LIMIT_MULTIPLIER,
  });
}

/**
 * True when per-source limiting is running in shared-bucket mode, i.e. the
 * deployment has not declared that a proxy rewrites the forwarding headers.
 * The production guard warns about this at boot.
 */
export function ipLimitsAreShared(): boolean {
  return !trustProxyHeaders();
}

/** Human-readable retry hint, e.g. "45 seconds" or "3 minutes". */
export function formatRetryAfter(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
