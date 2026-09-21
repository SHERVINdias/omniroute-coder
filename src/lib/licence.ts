/**
 * src/lib/licence.ts
 * ---------------------------------------------------------------------------
 * The entitlement client: fetch a signed licence blob, verify it, cache it, and
 * decide — offline included — whether this install may run.
 *
 * WHAT IS AND IS NOT DEFENDED
 *
 * The blob is Ed25519-signed by the licence server; the public key is baked into
 * the app. Verifying before trusting the cache is what stops the grace period
 * being extended by editing a JSON file on disk. It does NOT stop someone
 * unpacking app.asar and deleting the check — that is an accepted limit for a
 * 10-person beta whose testers already accepted a threat warning. Signing raises
 * the bar from "edit a date in Notepad" to "patch the binary", which is the
 * right amount of effort to spend here.
 *
 * CLOCK ROLLBACK
 *
 * Grace is measured from the server's own timestamp in the signed blob, and
 * elapsed time is max(0, now - serverTime) so a backwards clock yields zero
 * elapsed rather than a negative that would read as "still fresh forever".
 * Because a frozen or rolled-back clock could still keep elapsed at zero, grace
 * is ALSO bounded by a launch count: every launch increments a counter in the
 * cache, and enough launches exhaust grace regardless of the clock.
 *
 * WHERE THIS RUNS
 *
 * In the app's own Next server (the desktop child process). It refreshes on boot
 * and on a timer; requireUser reads only the cached verdict, synchronously, so
 * no request pays for a network round-trip. desktop/main.js reads the same cache
 * file with the same logic for its coarse launch-time gate.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

import { isDesktopBuild } from "@/lib/deploymentMode";
import { stateRoot } from "@/lib/stateRoot";

/* --------------------------------------------------------------- constants -- */

/** Grace window: how long an install keeps working while it cannot reach the
 *  licence server, once it has had at least one successful check. */
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Second bound on grace, in launches, so a rolled-back clock still runs out. */
const GRACE_MAX_LAUNCHES = 30;

/** Cache filename inside the writable state root. */
const CACHE_FILE = "licence-cache.json";

/**
 * The Ed25519 public key that verifies server signatures. Baked in for the
 * desktop build (an env override exists for development and for rotating the key
 * without a rebuild). This is a PUBLIC key, so embedding it is safe.
 *
 * REPLACE THE PLACEHOLDER before shipping: generate a keypair with
 *   node scripts/gen-licence-keys.mjs
 * put the PRIVATE key in the licence server's LICENCE_SIGNING_KEY env, and paste
 * the PUBLIC key here.
 */
const LICENCE_PUBLIC_KEY_PEM =
  process.env.LICENCE_PUBLIC_KEY?.trim() ||
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQA/MjQku5yNd8Z7DJPi3CV1LZbITjlriWbabkRrc8To=
-----END PUBLIC KEY-----`;

/** The licence server's base URL, e.g. https://licence.example.com */
function licenceServerUrl(): string {
  return (process.env.OMNIROUTE_LICENCE_URL?.trim() || "").replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ types -- */

export interface Entitlement {
  email: string;
  tier: string;
  active: boolean;
  /** ms epoch, or null for a licence that does not expire. */
  expiresAt: number | null;
  /** The server's own clock at signing time — the anchor for grace. */
  serverTime: number;
  installId: string;
}

interface SignedBlob {
  entitlement: Entitlement;
  /** base64 Ed25519 signature over the canonical JSON of `entitlement`. */
  signature: string;
}

interface CacheFile extends SignedBlob {
  /** local clock when we wrote it — diagnostic only, never trusted for grace. */
  cachedAt: number;
  /** launches counted since the last successful online check. */
  launchCount: number;
}

export type Verdict =
  | { allowed: true; reason: "valid" | "grace" }
  | {
      allowed: false;
      reason:
        | "revoked"
        | "expired"
        | "grace-expired"
        | "never-activated"
        | "no-signature";
      detail: string;
    };

/* -------------------------------------------------------------- canonical -- */

/** Stable JSON so the string the server signed is byte-identical to the string
 *  we verify. Keys in a fixed order; no incidental whitespace. */
export function canonicalEntitlement(e: Entitlement): string {
  return JSON.stringify({
    active: e.active,
    email: e.email,
    expiresAt: e.expiresAt,
    installId: e.installId,
    serverTime: e.serverTime,
    tier: e.tier,
  });
}

function verifySignature(blob: SignedBlob): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(canonicalEntitlement(blob.entitlement), "utf8"),
      LICENCE_PUBLIC_KEY_PEM,
      Buffer.from(blob.signature, "base64"),
    );
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ cache -- */

function cachePath(): string {
  return path.join(stateRoot(), CACHE_FILE);
}

/**
 * The stable per-install UUID, generated once in the state root and reused
 * forever. Random, so it identifies the install without revealing anything
 * about the machine. Both this module and desktop/main.js resolve it the same
 * way, from the same file.
 */
export function getInstallId(): string {
  const file = path.join(stateRoot(), "install-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* not written yet */
  }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, id, "utf8");
  } catch {
    /* If we cannot persist it, a per-run id is still valid — it just won't be
     * stable, which at worst over-counts installs on the server. */
  }
  return id;
}

function readCache(): CacheFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as CacheFile;
    if (!parsed?.entitlement || !parsed?.signature) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(blob: SignedBlob, launchCount: number): void {
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    const out: CacheFile = { ...blob, cachedAt: Date.now(), launchCount };
    fs.writeFileSync(cachePath(), JSON.stringify(out, null, 2), "utf8");
  } catch {
    /* Non-fatal: we still return a verdict for this run; only the next launch
     * loses the cached success. */
  }
}

/* ----------------------------------------------------------- grace verdict -- */

/**
 * Decide from a verified cached blob whether the install may run offline.
 * Assumes the signature has already been checked.
 */
function graceVerdict(cache: CacheFile): Verdict {
  const e = cache.entitlement;

  /* A cached revocation still bites — an explicit "not active" outranks the
   * grace window. */
  if (!e.active) {
    return { allowed: false, reason: "revoked", detail: "This licence has been revoked." };
  }

  if (e.expiresAt !== null && Date.now() > e.expiresAt) {
    return { allowed: false, reason: "expired", detail: "This licence has expired." };
  }

  const elapsed = Math.max(0, Date.now() - e.serverTime);
  if (elapsed > GRACE_MS) {
    return {
      allowed: false,
      reason: "grace-expired",
      detail: "OmniRoute needs to reach the internet to verify your licence.",
    };
  }
  if (cache.launchCount > GRACE_MAX_LAUNCHES) {
    return {
      allowed: false,
      reason: "grace-expired",
      detail: "OmniRoute needs to reach the internet to verify your licence.",
    };
  }

  return { allowed: true, reason: "grace" };
}

/* --------------------------------------------------------- public surface -- */

/**
 * The synchronous verdict from cache alone — no network. Used by requireUser on
 * every request and by the launch gate. Off the desktop build this always
 * allows (there is no licence on a server or in dev).
 */
export function cachedVerdict(): Verdict {
  if (!isDesktopBuild()) return { allowed: true, reason: "valid" };

  const cache = readCache();
  if (!cache) {
    /* Never activated. No grace is ever granted without a prior success,
     * otherwise a fresh install would be a permanent 7-day free pass. The app
     * still LOADS (main.js allows a missing cache so the user can sign in); this
     * verdict only blocks entitled actions until the first successful check. */
    return {
      allowed: false,
      reason: "never-activated",
      detail: "Sign in to activate OmniRoute Coder.",
    };
  }

  if (!verifySignature(cache)) {
    return {
      allowed: false,
      reason: "no-signature",
      detail: "The stored licence could not be verified. Sign in again.",
    };
  }

  return graceVerdict(cache);
}

/**
 * The tester's licence key, stored once in the state root. The desktop app
 * writes it after the tester enters it (see desktop/main.js); this is the read
 * side for the in-app refresh path.
 */
export function getStoredKey(): string | null {
  try {
    const k = fs.readFileSync(path.join(stateRoot(), "licence-key"), "utf8").trim();
    return k || null;
  } catch {
    return null;
  }
}

/**
 * Fetch a fresh signed blob from the licence server using the stored key, verify
 * it, and cache it. Returns the resulting verdict.
 *
 * The desktop main process owns the primary refresh (at launch and on a timer)
 * in desktop/licence.js; this is the in-app equivalent, so a running session can
 * re-check without a relaunch. On a network failure it does NOT clear the cache
 * — it falls back to the cached grace verdict, which is the point of grace.
 */
export async function refreshEntitlement(): Promise<Verdict> {
  if (!isDesktopBuild()) return { allowed: true, reason: "valid" };

  const base = licenceServerUrl();
  const key = getStoredKey();
  const prior = readCache();
  const nextLaunchCount = (prior?.launchCount ?? 0) + 1;

  if (!base || !key) {
    /* No server or no key yet — behave as offline / not-yet-activated. */
    if (prior && verifySignature(prior)) {
      writeCache(prior, nextLaunchCount);
      return graceVerdict({ ...prior, launchCount: nextLaunchCount });
    }
    return cachedVerdict();
  }

  try {
    const res = await fetch(`${base}/api/licence/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key,
        installId: getInstallId(),
        appVersion: process.env.OMNIROUTE_APP_VERSION ?? null,
      }),
      redirect: "manual",
    });

    if (res.status === 404) {
      /* Unknown key — nothing to cache; the app should ask for a valid one. */
      return {
        allowed: false,
        reason: "never-activated",
        detail: "This licence key is not recognised.",
      };
    }

    if (res.status === 403) {
      /* Explicit revocation. Persist it so the next launch refuses too. */
      const revoked = (await res.json().catch(() => null)) as SignedBlob | null;
      if (revoked && verifySignature(revoked) && !revoked.entitlement.active) {
        writeCache(revoked, 0);
      }
      return { allowed: false, reason: "revoked", detail: "This licence has been revoked." };
    }

    if (!res.ok) throw new Error(`licence server returned ${res.status}`);

    const blob = (await res.json()) as SignedBlob;
    if (!verifySignature(blob)) {
      return {
        allowed: false,
        reason: "no-signature",
        detail: "The licence server's response could not be verified.",
      };
    }

    /* Success resets the launch counter — grace is only spent while offline. */
    writeCache(blob, 0);

    if (!blob.entitlement.active) {
      return { allowed: false, reason: "revoked", detail: "This licence has been revoked." };
    }
    return { allowed: true, reason: "valid" };
  } catch {
    /* Offline. Fall back to the cached grace verdict, incrementing the launch
     * counter so grace cannot be held open forever by a frozen clock. */
    if (prior && verifySignature(prior)) {
      writeCache(prior, nextLaunchCount);
      return graceVerdict({ ...prior, launchCount: nextLaunchCount });
    }
    return cachedVerdict();
  }
}
