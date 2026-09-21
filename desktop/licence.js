/**
 * desktop/licence.js
 * ---------------------------------------------------------------------------
 * The main process's side of the licence, for the key model.
 *
 * The tester enters a licence key once. We send it (with a random per-install
 * UUID) to the cloud licence server's /api/licence/check, which returns an
 * Ed25519-SIGNED entitlement blob. We verify the signature with the baked-in
 * public key, cache the blob in userData, and store the key for future checks.
 *
 * On later launches (and every 12h) we re-check with the stored key so a
 * revocation on the server takes effect. Offline, we fall back to a grace
 * window (7 days AND ≤30 launches, whichever comes first) measured from the
 * server's own timestamp so a rolled-back clock cannot extend it.
 *
 * KEEP IN STEP with src/lib/licence.ts — the grace window, the launch bound,
 * the canonical JSON, and the public key must match, or signatures fail.
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const GRACE_MAX_LAUNCHES = 30;

const LICENCE_PUBLIC_KEY_PEM =
  (process.env.LICENCE_PUBLIC_KEY && process.env.LICENCE_PUBLIC_KEY.trim()) ||
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQA/MjQku5yNd8Z7DJPi3CV1LZbITjlriWbabkRrc8To=
-----END PUBLIC KEY-----`;

/* The cloud licence server. Bake the real URL in here (or set the env at
 * launch). Trailing slashes trimmed. */
const LICENCE_URL = (
  (process.env.OMNIROUTE_LICENCE_URL && process.env.OMNIROUTE_LICENCE_URL.trim()) ||
  "https://licence.example.com"
).replace(/\/+$/, "");

/* --------------------------------------------------------------- canonical -- */

function canonicalEntitlement(e) {
  return JSON.stringify({
    active: e.active,
    email: e.email,
    expiresAt: e.expiresAt,
    installId: e.installId,
    serverTime: e.serverTime,
    tier: e.tier,
  });
}

function verifySignature(blob) {
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

/* ------------------------------------------------------------ file helpers -- */

function cacheFile(userDataDir) {
  return path.join(userDataDir, "licence-cache.json");
}
function keyFile(userDataDir) {
  return path.join(userDataDir, "licence-key");
}
function installIdFile(userDataDir) {
  return path.join(userDataDir, "install-id");
}

function readCache(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(userDataDir), "utf8"));
    if (!parsed || !parsed.entitlement || !parsed.signature) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(userDataDir, blob, launchCount) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      cacheFile(userDataDir),
      JSON.stringify({ ...blob, cachedAt: Date.now(), launchCount }, null, 2),
      "utf8",
    );
  } catch {
    /* non-fatal */
  }
}

function getStoredKey(userDataDir) {
  try {
    return fs.readFileSync(keyFile(userDataDir), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function setStoredKey(userDataDir, key) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(keyFile(userDataDir), key, "utf8");
  } catch {
    /* non-fatal — a per-run key still works for this launch */
  }
}

function getInstallId(userDataDir) {
  try {
    const existing = fs.readFileSync(installIdFile(userDataDir), "utf8").trim();
    if (existing) return existing;
  } catch {
    /* not written yet */
  }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(installIdFile(userDataDir), id, "utf8");
  } catch {
    /* non-fatal */
  }
  return id;
}

/* ------------------------------------------------------------- grace logic -- */

function graceVerdict(cache) {
  const e = cache.entitlement;
  if (!e.active) return { allowed: false, reason: "This licence has been revoked. Contact the developer." };
  if (e.expiresAt !== null && Date.now() > e.expiresAt) {
    return { allowed: false, reason: "This licence has expired." };
  }
  const elapsed = Math.max(0, Date.now() - e.serverTime);
  const launches = typeof cache.launchCount === "number" ? cache.launchCount : 0;
  if (elapsed > GRACE_MS || launches > GRACE_MAX_LAUNCHES) {
    return {
      allowed: false,
      reason: "OmniRoute needs to reach the internet to verify your licence. Connect and reopen the app.",
    };
  }
  return { allowed: true, reason: "ok" };
}

/* ----------------------------------------------------------- cloud checks -- */

/**
 * Ask the cloud to validate a key. Returns:
 *   { kind: "active", blob }      key is good
 *   { kind: "revoked", blob }     key exists but is revoked
 *   { kind: "unknown" }           server does not recognise the key (404)
 *   { kind: "bad-signature" }     response failed verification
 *   { kind: "offline", error }    could not reach the server
 */
async function checkWithCloud(userDataDir, key) {
  if (!LICENCE_URL) return { kind: "offline", error: "no licence URL configured" };
  try {
    const res = await fetch(`${LICENCE_URL}/api/licence/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key,
        installId: getInstallId(userDataDir),
        appVersion: process.env.OMNIROUTE_APP_VERSION || null,
      }),
      redirect: "manual",
    });

    if (res.status === 404) return { kind: "unknown" };

    const blob = await res.json().catch(() => null);
    if (!blob || !verifySignature(blob)) return { kind: "bad-signature" };

    return { kind: blob.entitlement.active ? "active" : "revoked", blob };
  } catch (error) {
    return { kind: "offline", error: error && error.message ? error.message : String(error) };
  }
}

/**
 * Validate the key the tester just entered. On success, store the key and cache
 * the signed blob. Returns { ok, reason }.
 */
async function activateWithKey(userDataDir, key) {
  const trimmed = String(key || "").trim();
  if (!trimmed) return { ok: false, reason: "Enter your licence key." };

  const result = await checkWithCloud(userDataDir, trimmed);
  switch (result.kind) {
    case "active":
      setStoredKey(userDataDir, trimmed);
      writeCache(userDataDir, result.blob, 0);
      return { ok: true, reason: "ok" };
    case "revoked":
      writeCache(userDataDir, result.blob, 0);
      return { ok: false, reason: "This licence key has been revoked." };
    case "unknown":
      return { ok: false, reason: "That licence key is not recognised. Check it and try again." };
    case "bad-signature":
      return { ok: false, reason: "The licence server's reply could not be verified." };
    default:
      return { ok: false, reason: "Could not reach the licence server. Check your internet and try again." };
  }
}

/**
 * Re-check with the stored key (launch + 12h timer). Updates the cache. Offline,
 * it leaves the cache intact so grace continues. Returns a launch-style verdict.
 */
async function refreshFromCloud(userDataDir) {
  const key = getStoredKey(userDataDir);
  const prior = readCache(userDataDir);
  const nextLaunch = ((prior && prior.launchCount) || 0) + 1;

  if (!key) return evaluateAtLaunch(userDataDir);

  const result = await checkWithCloud(userDataDir, key);
  if (result.kind === "active") {
    writeCache(userDataDir, result.blob, 0);
    return { allowed: true, reason: "ok" };
  }
  if (result.kind === "revoked") {
    writeCache(userDataDir, result.blob, 0);
    return { allowed: false, reason: "This licence has been revoked. Contact the developer." };
  }
  if (result.kind === "unknown") {
    return { allowed: false, reason: "This licence key is no longer recognised." };
  }
  /* offline or bad-signature: fall back to cached grace. */
  if (prior && verifySignature(prior)) {
    writeCache(userDataDir, prior, nextLaunch);
    return graceVerdict({ ...prior, launchCount: nextLaunch });
  }
  return { allowed: false, reason: "never-activated" };
}

/**
 * The synchronous launch verdict from cache alone. Missing cache = never
 * activated (the caller then prompts for a key). A cached revocation, expiry, or
 * exhausted grace refuses.
 */
function evaluateAtLaunch(userDataDir) {
  const cache = readCache(userDataDir);
  if (!cache) return { allowed: false, reason: "never-activated" };
  if (!verifySignature(cache)) {
    return { allowed: false, reason: "The stored licence could not be verified. Re-enter your key." };
  }
  return graceVerdict(cache);
}

module.exports = {
  evaluateAtLaunch,
  refreshFromCloud,
  activateWithKey,
  getStoredKey,
};
