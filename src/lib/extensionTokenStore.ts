/**
 * src/lib/extensionTokenStore.ts
 * ---------------------------------------------------------------------------
 * Pairing tokens for the VS Code bridge — one or more per user, hashed at rest.
 *
 * WHAT THIS REPLACED, AND WHY IT HAD TO CHANGE
 *
 * The previous version held ONE token for the whole server, in a module-level
 * variable:
 *
 *     let activePairingTokenRecord: TokenRecord | null = null;
 *
 * That is correct for exactly one deployment shape — a single operator running
 * the app on their own laptop — and wrong for every other. Three failures, in
 * increasing order of severity:
 *
 *   1. A restart wiped it. The editor that had been paired for a week was
 *      silently unpaired the next time the container was recreated, with no
 *      message anywhere explaining why file operations had stopped working.
 *   2. Minting a token for a second person invalidated the first person's.
 *      Two beta testers could not be paired at the same time, and the one who
 *      lost the race got no notification.
 *   3. It identified nobody. The token said "somebody who has the token", not
 *      "user 9f2c…". With a single global socket that distinction did not
 *      exist; with a socket per user it is the whole authorisation model.
 *
 * So a token now BELONGS to a user, survives a restart, and can be revoked
 * without disturbing anyone else's.
 *
 * WHY THE TOKEN IS HASHED
 *
 * This table is inside chat.db, which is backed up to /home/ubuntu/backups by
 * the weekly cron job and copied around by hand during a restore. A plaintext
 * token in that file is a live credential sitting in a tarball: anyone holding
 * a backup could pair their own editor as somebody else. The stored value is
 * therefore sha256 of the token and nothing else — a stolen backup yields
 * hashes, and a hash cannot be presented to the socket.
 *
 * Lookup is BY the hash, not by scanning rows and comparing. That keeps the
 * query O(1) through the unique index and means there is no row-by-row compare
 * whose duration could leak which prefixes exist. `crypto.timingSafeEqual` is
 * still used on the final comparison because it costs nothing to be careful
 * twice.
 *
 * WHY NOT A JWT
 *
 * The obvious alternative — sign a JWT, let the socket verify it statelessly —
 * cannot be revoked. "My laptop was stolen, cut it off now" is a requirement
 * for something that hands out filesystem access, and a stateless token cannot
 * satisfy it without a revocation list, which is the table below with extra
 * steps. It would also mean a new dependency (`jsonwebtoken`), and this app
 * deliberately adds none.
 */

import crypto from "crypto";
import db from "@/lib/db";

/* -------------------------------------------------------------------------
 * Schema
 * ---------------------------------------------------------------------- */

/**
 * Created here rather than in db.ts because this table is owned by this module
 * and nothing else reads it. `IF NOT EXISTS` makes it idempotent, and the
 * module-level call means the table is guaranteed present before any exported
 * function can run — no ordering problem, no migration step for the operator.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS extension_tokens (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    tokenHash TEXT NOT NULL UNIQUE,
    preview TEXT NOT NULL,
    label TEXT,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    lastUsedAt INTEGER,
    revokedAt INTEGER,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_extension_tokens_user
    ON extension_tokens(userId, createdAt DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_tokens_hash
    ON extension_tokens(tokenHash);
`);

/* -------------------------------------------------------------------------
 * Policy
 * ---------------------------------------------------------------------- */

/**
 * Thirty days, matching what a person expects from "stay signed in on this
 * machine". Long enough that a beta tester is not re-pairing every week;
 * short enough that a token forgotten on a machine they no longer own stops
 * working without anyone having to remember to revoke it.
 */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A cap, so a loop calling the mint endpoint cannot grow the table without
 * bound. Five is "laptop, desktop, work machine, and two mistakes".
 */
const MAX_TOKENS_PER_USER = 5;

const TOKEN_PREFIX = "omr_pair_";

export interface ExtensionTokenSummary {
  id: string;
  preview: string;
  label: string | null;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  /** Convenience for the UI, so it does not re-derive the clock comparison. */
  expired: boolean;
}

export interface IssuedExtensionToken extends ExtensionTokenSummary {
  /**
   * The only time the full token exists outside the user's machine. It is not
   * stored, so this field cannot be produced again — the UI has to show it
   * once and say so.
   */
  token: string;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * `omr_pair_9f2c…` with the middle removed. Enough for someone with three
 * paired machines to tell which row is which, far too little to authenticate
 * with: 8 of the 48 hex characters, and the other 40 are never stored anywhere.
 */
function previewOf(token: string): string {
  const body = token.slice(TOKEN_PREFIX.length);
  return `${TOKEN_PREFIX}${body.slice(0, 6)}…${body.slice(-4)}`;
}

/* -------------------------------------------------------------------------
 * Issuing and listing
 * ---------------------------------------------------------------------- */

/**
 * Mint a token for one user.
 *
 * 24 random bytes. The comparison is against a stored hash of the whole
 * string, so the only thing that matters is that it cannot be guessed; 192
 * bits cannot be.
 */
export function issueExtensionToken(
  userId: string,
  label?: string | null,
): IssuedExtensionToken {
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
  const now = Date.now();
  const record = {
    id: crypto.randomUUID(),
    userId,
    tokenHash: hashToken(token),
    preview: previewOf(token),
    label: (label ?? "").trim() || null,
    createdAt: now,
    expiresAt: now + TOKEN_TTL_MS,
  };

  /* Prune before inserting, not after, so the cap is a cap and not a cap plus
   * one. Expired and revoked rows go first — they are dead weight — and only
   * then the oldest live ones. */
  const insert = db.transaction(() => {
    db.prepare(
      `DELETE FROM extension_tokens
        WHERE userId = ? AND (revokedAt IS NOT NULL OR expiresAt <= ?)`,
    ).run(userId, now);

    db.prepare(
      `DELETE FROM extension_tokens
        WHERE id IN (
          SELECT id FROM extension_tokens
           WHERE userId = ?
           ORDER BY createdAt DESC
           LIMIT -1 OFFSET ?
        )`,
    ).run(userId, MAX_TOKENS_PER_USER - 1);

    db.prepare(
      `INSERT INTO extension_tokens
         (id, userId, tokenHash, preview, label, createdAt, expiresAt)
       VALUES (@id, @userId, @tokenHash, @preview, @label, @createdAt, @expiresAt)`,
    ).run(record);
  });
  insert();

  return {
    id: record.id,
    preview: record.preview,
    label: record.label,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: null,
    expired: false,
    token,
  };
}

/** Live tokens for one user, newest first. Never includes the hash. */
export function listExtensionTokens(userId: string): ExtensionTokenSummary[] {
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT id, preview, label, createdAt, expiresAt, lastUsedAt
         FROM extension_tokens
        WHERE userId = ? AND revokedAt IS NULL
        ORDER BY createdAt DESC`,
    )
    .all(userId) as Array<{
    id: string;
    preview: string;
    label: string | null;
    createdAt: number;
    expiresAt: number;
    lastUsedAt: number | null;
  }>;

  return rows.map((row) => ({ ...row, expired: row.expiresAt <= now }));
}

/**
 * Revoke one token.
 *
 * Scoped on `userId` as well as `id` so a caller cannot revoke somebody else's
 * pairing by guessing a uuid — the same reasoning as the UNIQUE(userId, id) on
 * user_providers.
 *
 * Marks rather than deletes, so `lastUsedAt` survives for anyone investigating
 * "was this token used after I revoked it". The row is cleaned up on the next
 * mint.
 */
export function revokeExtensionToken(userId: string, id: string): boolean {
  const result = db
    .prepare(
      `UPDATE extension_tokens
          SET revokedAt = ?
        WHERE id = ? AND userId = ? AND revokedAt IS NULL`,
    )
    .run(Date.now(), id, userId);
  return result.changes > 0;
}

/** Revoke every token a user holds. Returns how many were live. */
export function revokeAllExtensionTokens(userId: string): number {
  const result = db
    .prepare(
      `UPDATE extension_tokens
          SET revokedAt = ?
        WHERE userId = ? AND revokedAt IS NULL`,
    )
    .run(Date.now(), userId);
  return result.changes;
}

/* -------------------------------------------------------------------------
 * Verification — the socket's front door
 * ---------------------------------------------------------------------- */

export interface ResolvedExtensionToken {
  userId: string;
  tokenId: string;
}

/**
 * Turn a token presented on the WebSocket upgrade into the user it belongs to.
 *
 * Returns null for every failure — unknown, revoked, expired, malformed — and
 * deliberately does not say which. The caller closes the socket with one
 * message for all of them. Distinguishing "no such token" from "expired" would
 * tell someone probing the endpoint whether a guess had ever been valid.
 *
 * `lastUsedAt` is written on success. That is what makes the token list in the
 * UI useful: "last used 3 minutes ago" is how a person recognises the row for
 * the laptop in front of them, and a token that has never been used is the one
 * that is safe to revoke.
 */
export function resolveExtensionToken(
  rawToken: string,
): ResolvedExtensionToken | null {
  const token = (rawToken ?? "").trim();
  /* Cheap structural rejection first. A well-formed token is a fixed length,
   * so anything else is not worth a database round trip. */
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  if (token.length !== TOKEN_PREFIX.length + 48) return null;

  const row = db
    .prepare(
      `SELECT id, userId, tokenHash, expiresAt, revokedAt
         FROM extension_tokens
        WHERE tokenHash = ?`,
    )
    .get(hashToken(token)) as
    | {
        id: string;
        userId: string;
        tokenHash: string;
        expiresAt: number;
        revokedAt: number | null;
      }
    | undefined;

  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt <= Date.now()) return null;

  /* The lookup above already proved equality — SQLite matched the string. This
   * is belt and braces against a future refactor that changes the lookup to a
   * scan-and-compare, which is exactly the shape that leaks timing. */
  const expected = Buffer.from(row.tokenHash, "utf8");
  const supplied = Buffer.from(hashToken(token), "utf8");
  if (expected.length !== supplied.length) return null;
  if (!crypto.timingSafeEqual(expected, supplied)) return null;

  db.prepare("UPDATE extension_tokens SET lastUsedAt = ? WHERE id = ?").run(
    Date.now(),
    row.id,
  );

  return { userId: row.userId, tokenId: row.id };
}

/* -------------------------------------------------------------------------
 * Loopback detection
 * ---------------------------------------------------------------------- */

/** Loopback literals, lowercase, including the IPv4-mapped forms Node reports. */
const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "0:0:0:0:0:0:0:1",
  "::ffff:127.0.0.1",
  "0:0:0:0:0:ffff:127.0.0.1",
]);

/**
 * True when `address` is a loopback literal, with or without a port.
 *
 * WHY THE PARSING LOOKS LIKE THIS
 *
 * The original was:
 *
 *     const clean = address.replace(/^.*:/, "");
 *     return clean === "127.0.0.1" || clean === "localhost" || clean === "1" || …
 *
 * `^.*:` is greedy, so it strips everything up to the LAST colon.
 * "203.0.113.9:1" therefore reduced to "1" — and "1" was on the allowlist. Any
 * caller could satisfy the loopback gate by connecting from port 1. The "1"
 * entry existed only to cope with that same stripping producing a bare port, so
 * parsing the address properly removes the need for it entirely.
 *
 * The replacement handles the three shapes an address actually arrives in:
 * bracketed IPv6 with an optional port, a bare IPv6 literal (more than one
 * colon means every colon belongs to the address, so there is no port to
 * strip), and IPv4 or a hostname with at most one trailing port.
 *
 * NOTE ON WHERE THIS IS STILL USED. It is no longer the socket's authorisation
 * check — behind a reverse proxy every caller looks like loopback, which is
 * precisely why that check was replaced by the token above. It survives for the
 * admin pairing endpoint, where it is a secondary signal on top of a real
 * session, and for deciding whether the app is being used locally.
 */
export function isLocalhost(address: string): boolean {
  const raw = (address ?? "").trim().toLowerCase();
  if (!raw) return false;

  /* "[::1]" or "[::1]:3000" — the only form where an IPv6 address can carry a
   * port unambiguously. */
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(raw);
  if (bracketed) return LOOPBACK_HOSTS.has(bracketed[1]);

  /* More than one colon means a bare IPv6 literal. Treating a trailing group as
   * a port here is exactly what broke the old check. */
  if (raw.split(":").length > 2) return LOOPBACK_HOSTS.has(raw);

  /* IPv4 or hostname, with at most one trailing port. */
  const withPort = /^([^:]+):\d{1,5}$/.exec(raw);
  return LOOPBACK_HOSTS.has(withPort ? withPort[1] : raw);
}
