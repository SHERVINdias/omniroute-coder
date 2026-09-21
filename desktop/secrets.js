/**
 * desktop/secrets.js
 * ---------------------------------------------------------------------------
 * The two secrets the production boot guard requires, generated once and kept
 * beside the database.
 *
 * WHY THIS IS DATA, NOT CONFIG
 *
 * src/lib/productionGuard.ts refuses to boot without AUTH_SECRET. So the desktop
 * app must supply one — which means the DB-persisted fallback in crypto.ts never
 * runs, and AUTH_SECRET (or CREDENTIALS_SECRET, if we set it) becomes the key
 * that decrypts every stored provider API key. If this file were lost or
 * regenerated, every saved key would become undecryptable. That makes these
 * files part of the user's DATA: they live in the same userData folder as
 * chat.db, so anything that moves one moves the other, and the backup feature
 * must include them.
 *
 * We generate CREDENTIALS_SECRET separately from AUTH_SECRET rather than let one
 * cover both, because crypto.ts warns when they are the same: sharing means a
 * single leaked value exposes both session signing and credential encryption.
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/**
 * Return the secret stored in `filename` inside userData, generating and
 * persisting a strong one on first run. 32 random bytes, base64 — comfortably
 * past the guard's 32-character minimum.
 */
function persistentSecret(userDataDir, filename) {
  const file = path.join(userDataDir, filename);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* not written yet */
  }
  const generated = crypto.randomBytes(32).toString("base64");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  /* 0o600 where the platform honours it; harmless on Windows. */
  fs.writeFileSync(file, generated, { encoding: "utf8", mode: 0o600 });
  return generated;
}

/** Both secrets, created before the server spawns. */
function ensureSecrets(userDataDir) {
  return {
    AUTH_SECRET: persistentSecret(userDataDir, "auth-secret"),
    CREDENTIALS_SECRET: persistentSecret(userDataDir, "credentials-secret"),
  };
}

module.exports = { ensureSecrets };
