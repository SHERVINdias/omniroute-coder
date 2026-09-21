/**
 * src/lib/licenceAdmin.ts
 * ---------------------------------------------------------------------------
 * The operator's side of the licence: mint a key for a tester, revoke it,
 * reinstate it, and see which installs have checked in.
 *
 * THE MODEL
 *
 * Each tester gets one opaque key string. The desktop app sends it (with its
 * random install UUID) to /api/licence/check on launch. This module is the
 * WRITE side of the licence_keys table plus the reads the admin panel needs.
 * Revocation is a single flag on the key row: flip it and the next licence
 * check returns a signed active:false blob, which the app caches and enforces
 * even offline.
 *
 * WHERE THIS MATTERS
 *
 * On the cloud licence server (OMNIROUTE_ROLE=licence). On the desktop app's own
 * database these tables stay empty — the desktop never mints or checks keys
 * locally, it asks the cloud.
 */

import crypto from "crypto";

import db from "@/lib/db";

/* -------------------------------------------------------------- key format -- */

/**
 * A human-friendly-ish key: OMNI-XXXX-XXXX-XXXX, uppercase, no ambiguous
 * characters (no 0/O, 1/I). Random, so it is unguessable; the dashes are only
 * for legibility when a tester copies it.
 */
function mintKeyString(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const group = () =>
    Array.from(crypto.randomBytes(4))
      .map((b) => alphabet[b % alphabet.length])
      .join("");
  return `OMNI-${group()}-${group()}-${group()}`;
}

/* ----------------------------------------------------------------- writes -- */

export interface LicenceKeyRow {
  key: string;
  label: string;
  revoked: number;
  createdAt: number;
  revokedAt: number | null;
  lastSeen: number | null;
}

/** Mint and store a new licence key. `label` is a note for the admin panel. */
export function generateLicenceKey(label: string): LicenceKeyRow {
  const key = mintKeyString();
  const now = Date.now();
  db.prepare(
    `INSERT INTO licence_keys (key, label, revoked, createdAt) VALUES (?, ?, 0, ?)`,
  ).run(key, label.slice(0, 120), now);
  return { key, label, revoked: 0, createdAt: now, revokedAt: null, lastSeen: null };
}

/** Revoke a key. Idempotent. The tester's app refuses to run at its next check. */
export function revokeLicenceKey(key: string): boolean {
  const res = db
    .prepare(
      `UPDATE licence_keys SET revoked = 1, revokedAt = ? WHERE key = ?`,
    )
    .run(Date.now(), key);
  return res.changes > 0;
}

/** Reinstate a revoked key. Idempotent. */
export function reinstateLicenceKey(key: string): boolean {
  const res = db
    .prepare(
      `UPDATE licence_keys SET revoked = 0, revokedAt = NULL WHERE key = ?`,
    )
    .run(key);
  return res.changes > 0;
}

/* ------------------------------------------------------------------ reads -- */

/** Validate a key at check time. Returns whether it exists and is active. */
export function validateLicenceKey(
  key: string,
): { exists: boolean; active: boolean; label: string } {
  const row = db
    .prepare(`SELECT label, revoked FROM licence_keys WHERE key = ?`)
    .get(key) as { label: string; revoked: number } | undefined;
  if (!row) return { exists: false, active: false, label: "" };
  return { exists: true, active: row.revoked === 0, label: row.label };
}

/** Stamp lastSeen on a key when it checks in. */
export function touchLicenceKey(key: string): void {
  db.prepare(`UPDATE licence_keys SET lastSeen = ? WHERE key = ?`).run(
    Date.now(),
    key,
  );
}

/** All keys, newest first, for the admin panel. */
export function listLicenceKeys(): LicenceKeyRow[] {
  return db
    .prepare(
      `SELECT key, label, revoked, createdAt, revokedAt, lastSeen
       FROM licence_keys ORDER BY createdAt DESC`,
    )
    .all() as LicenceKeyRow[];
}

/* --------------------------------------------------------------- installs -- */

export interface InstallRow {
  installId: string;
  licenceKey: string | null;
  userId: string | null;
  firstSeen: number;
  lastSeen: number;
  appVersion: string | null;
}

/** Record (or refresh) an install's check-in, tied to the key it presented. */
export function recordInstall(
  installId: string,
  licenceKey: string | null,
  appVersion: string | null,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO installs (installId, licenceKey, userId, firstSeen, lastSeen, appVersion)
     VALUES (?, ?, NULL, ?, ?, ?)
     ON CONFLICT(installId) DO UPDATE SET
       licenceKey = excluded.licenceKey,
       lastSeen = excluded.lastSeen,
       appVersion = excluded.appVersion`,
  ).run(installId, licenceKey, now, now, appVersion);
}

/** Every install that has checked in, most-recently-seen first. */
export function listInstalls(): InstallRow[] {
  return db
    .prepare(
      `SELECT installId, licenceKey, userId, firstSeen, lastSeen, appVersion
       FROM installs ORDER BY lastSeen DESC`,
    )
    .all() as InstallRow[];
}

/** How many distinct machines are running a given key — the "passed it around"
 *  signal. */
export function installCountForKey(key: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM installs WHERE licenceKey = ?")
    .get(key) as { n: number };
  return row.n;
}
