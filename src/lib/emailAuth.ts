/**
 * src/lib/emailAuth.ts
 * ---------------------------------------------------------------------------
 * Identity: one-time codes, sessions, and roles.
 *
 * WHAT CHANGED AND WHY
 *
 *  1. CODES ARE HASHED. They were stored in plaintext, so anyone who could read
 *     chat.db — a backup, a synced OneDrive folder, a stray file copy — held
 *     every live login code. They are now stored as an HMAC keyed by a secret
 *     that lives in the database, so the stored value cannot be replayed.
 *
 *  2. VERIFICATION IS CAPPED. A 6-digit code is one of a million, and the old
 *     endpoint allowed unlimited guesses inside the 5-minute window. That is
 *     minutes of brute force for a scripted attacker. Attempts are counted on
 *     the row and the code is burned after five failures.
 *
 *  3. validateSession NO LONGER RETURNS A SCRAMBLED USER. It ran
 *     `SELECT s.*, u.*` across two tables that both define `id` and
 *     `createdAt`. SQLite resolves those duplicate names to whichever column
 *     comes last, so `createdAt` was silently the session's, not the user's.
 *     Every column is now named and aliased explicitly.
 *
 *  4. ROLES LIVE IN THE DATABASE. `isAdmin` was a string comparison against a
 *     hardcoded address and a hardcoded phone number, which meant admin status
 *     could not be granted or revoked without editing source. There is now a
 *     `role` column, plus a bootstrap allowlist so the owner's accounts are
 *     promoted automatically on first login and can never be locked out.
 *
 *  5. PHONE ACCOUNTS ARE IDENTIFIABLE. A phone login wrote its digits into the
 *     `email` column and nothing else, so nothing downstream could tell a phone
 *     account from an email account. The digits still go in `email` (that
 *     column is the UNIQUE identity key and existing rows depend on it) but are
 *     now mirrored into `users.phone`.
 *
 * ENVIRONMENT
 *
 *   ADMIN_EMAILS   Comma-separated. Defaults to 10cshervindias45@gmail.com.
 *   ADMIN_PHONES   Comma-separated, 10-digit. Defaults to 7264953257.
 *   ADMIN_EMAIL    Legacy single-value form of ADMIN_EMAILS; still honoured.
 *   AUTH_SECRET    HMAC key for code hashing. Optional — when absent a random
 *                  secret is generated once and persisted in app_settings.
 *   OTP_EXPIRY_MINUTES, SESSION_EXPIRY_DAYS   Optional overrides.
 */

import crypto from "crypto";
import db from "./db";

/* -------------------------------------------------------------------------
 * Tunables
 * ---------------------------------------------------------------------- */

const OTP_EXPIRY_MINUTES = positiveInt(process.env.OTP_EXPIRY_MINUTES, 5);
const SESSION_EXPIRY_DAYS = positiveInt(process.env.SESSION_EXPIRY_DAYS, 30);
/** Failed guesses allowed against a single code before it is destroyed. */
export const OTP_MAX_ATTEMPTS = 5;

export { OTP_EXPIRY_MINUTES, SESSION_EXPIRY_DAYS };

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/* -------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------- */

export type UserRole = "USER" | "ADMIN";
export type IdentifierKind = "email" | "phone";

export interface AuthUser {
  id: string;
  /** The unique identity key: a lowercased email, or 10 digits for a phone. */
  email: string;
  phone: string | null;
  tier: string;
  role: UserRole;
  createdAt: number;
  lastLoginAt: number | null;
  referralCode: string | null;
}

export interface Session {
  id: string;
  userId: string;
  token: string;
  expiresAt: number;
  createdAt: number;
}

export interface Identifier {
  kind: IdentifierKind;
  /** Canonical form, safe to use as the database key. */
  value: string;
}

export type VerifyOtpResult =
  | { ok: true; user: AuthUser }
  | {
      ok: false;
      reason: "no_code" | "expired" | "mismatch" | "too_many_attempts";
      attemptsRemaining: number;
    };

/* -------------------------------------------------------------------------
 * Identifier handling
 *
 * Everything that touches the database goes through classifyIdentifier first,
 * so `Foo@Example.COM `, `foo@example.com`, `+91 72649 53257` and `7264953257`
 * can never end up as separate accounts.
 * ---------------------------------------------------------------------- */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Reduce user input to a canonical identity key, or null if it is neither a
 * plausible email nor a phone number.
 *
 * Phone canonicalisation targets 10 national digits because that is the shape
 * the existing rows and the existing `/^\d{10}$/` contract already use. A
 * leading 0 or a 91 country prefix is stripped so the same person typing the
 * number three different ways lands on one account.
 */
export function classifyIdentifier(raw: string): Identifier | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  if (trimmed.includes("@")) {
    const lowered = trimmed.toLowerCase();
    return EMAIL_PATTERN.test(lowered) ? { kind: "email", value: lowered } : null;
  }

  /* Reject anything with characters that are not plausibly part of a number
   * before stripping, so "abc" does not quietly become the empty string. */
  if (!/^[+\d\s()\-.]+$/.test(trimmed)) return null;

  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);

  return digits.length === 10 ? { kind: "phone", value: digits } : null;
}

/** Back-compatible predicate. Prefer classifyIdentifier, which also normalises. */
export function isValidIdentifier(identifier: string): boolean {
  return classifyIdentifier(identifier) !== null;
}

/* -------------------------------------------------------------------------
 * Secrets
 * ---------------------------------------------------------------------- */

/**
 * HMAC key for code hashing.
 *
 * Prefers AUTH_SECRET. Without it, a random 32-byte secret is generated once
 * and persisted in app_settings — that keeps existing codes valid across a
 * restart, which a per-process secret would not, and means the zero-config
 * setup is still not storing anything replayable.
 */
function authSecret(): string {
  const fromEnv = (process.env.AUTH_SECRET ?? "").trim();
  if (fromEnv) return fromEnv;

  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = 'auth_secret'")
    .get() as { value: string } | undefined;
  if (row?.value) return row.value;

  const generated = crypto.randomBytes(32).toString("hex");
  /* INSERT OR IGNORE, then re-read: if two requests race here, both try to
   * insert, one wins, and both end up reading the same winning value. */
  db.prepare(
    "INSERT OR IGNORE INTO app_settings (key, value, updatedAt) VALUES ('auth_secret', ?, ?)",
  ).run(generated, Date.now());

  const settled = db
    .prepare("SELECT value FROM app_settings WHERE key = 'auth_secret'")
    .get() as { value: string } | undefined;
  return settled?.value ?? generated;
}

function hashOtp(identifier: string, code: string): string {
  return crypto
    .createHmac("sha256", authSecret())
    .update(`${identifier}:${code}`)
    .digest("hex");
}

/* -------------------------------------------------------------------------
 * Admin bootstrap
 * ---------------------------------------------------------------------- */

function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Accounts that are always admins.
 *
 * This exists so the owner cannot lock themselves out: even if the `role`
 * column is wiped, these identifiers are treated as admin and are re-promoted
 * on their next successful login.
 *
 * WHY THERE ARE NO DEFAULTS IN THIS FILE ANY MORE
 *
 * The owner's real email address and phone number used to sit here as literal
 * fallbacks. Two problems with that. It puts personal contact details into
 * every clone of the repository, and — the part that actually matters — the
 * fallback follows the code. Anyone who deploys this source without setting
 * ADMIN_EMAILS gets an installation whose permanent administrator is an
 * identity they do not control, and whoever holds that inbox can request an
 * OTP and sign in as admin on their server.
 *
 * So the allowlist now comes only from the environment. Set ADMIN_EMAILS
 * and/or ADMIN_PHONES (comma-separated) in `.env.local` for development and in
 * `.env.production` on the server. With neither set the allowlist is empty and
 * admin is decided purely by the `role` column, which is the correct behaviour
 * for a fresh deployment by a third party.
 *
 * Each entry goes through classifyIdentifier, so an allowlist written as
 * "+91 72649 53257" or "Owner@Gmail.com" still matches the canonical key that
 * actually gets stored.
 */
const BOOTSTRAP_ADMINS: ReadonlySet<string> = (() => {
  const entries = [
    ...parseList(process.env.ADMIN_EMAILS ?? process.env.ADMIN_EMAIL),
    ...parseList(process.env.ADMIN_PHONES),
  ];

  if (entries.length === 0) {
    /* Not fatal: role-based admin still works, and a brand new install has no
     * users at all. Warned once at module load so the cause of "I cannot get
     * into the admin panel" is visible in the log rather than guessed at. */
    console.warn(
      "[auth] No ADMIN_EMAILS or ADMIN_PHONES configured; the permanent admin allowlist is empty.",
    );
  }

  const canonical = new Set<string>();
  for (const entry of entries) {
    const parsed = classifyIdentifier(entry);
    if (parsed) canonical.add(parsed.value);
    else {
      console.warn(
        `[auth] Ignoring unparseable admin allowlist entry: ${JSON.stringify(entry)}`,
      );
    }
  }
  return canonical;
})();

/** True when the identifier is on the permanent allowlist. */
export function isBootstrapAdmin(identifier: string): boolean {
  const parsed = classifyIdentifier(identifier);
  return parsed ? BOOTSTRAP_ADMINS.has(parsed.value) : false;
}

/** The configured allowlist, for display in the admin panel. */
export function listBootstrapAdmins(): string[] {
  return [...BOOTSTRAP_ADMINS];
}

/* -------------------------------------------------------------------------
 * Users
 * ---------------------------------------------------------------------- */

/** Every user read names its columns, so a schema addition cannot reorder them. */
const USER_COLUMNS = `
  u.id          AS id,
  u.email       AS email,
  u.phone       AS phone,
  u.tier        AS tier,
  u.role        AS role,
  u.createdAt   AS createdAt,
  u.lastLoginAt AS lastLoginAt,
  u.referralCode AS referralCode
`;

function rowToUser(row: Record<string, unknown> | undefined): AuthUser | null {
  if (!row) return null;
  return {
    id: String(row.id),
    email: String(row.email),
    phone: row.phone === null || row.phone === undefined ? null : String(row.phone),
    tier: String(row.tier ?? "FREE"),
    role: row.role === "ADMIN" ? "ADMIN" : "USER",
    createdAt: Number(row.createdAt ?? 0),
    lastLoginAt:
      row.lastLoginAt === null || row.lastLoginAt === undefined
        ? null
        : Number(row.lastLoginAt),
    referralCode:
      row.referralCode === null || row.referralCode === undefined
        ? null
        : String(row.referralCode),
  };
}

/**
 * Find or create the account for a canonical identifier.
 *
 * Accepts raw input and normalises it, so callers cannot accidentally create a
 * second account by passing a differently-cased address.
 */
export function getOrCreateUserByEmail(identifierInput: string): AuthUser {
  const parsed = classifyIdentifier(identifierInput);
  if (!parsed) throw new Error("Not a valid email address or phone number.");

  const { kind, value } = parsed;

  const existing = rowToUser(
    db
      .prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.email = ?`)
      .get(value) as Record<string, unknown> | undefined,
  );
  if (existing) {
    /* Backfill `phone` for accounts created before that column existed. */
    if (kind === "phone" && !existing.phone) {
      db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(value, existing.id);
      existing.phone = value;
    }
    return existing;
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const role: UserRole = BOOTSTRAP_ADMINS.has(value) ? "ADMIN" : "USER";

  db.prepare(
    `INSERT INTO users (id, email, phone, tier, role, createdAt, referralCode)
     VALUES (?, ?, ?, 'FREE', ?, ?, NULL)`,
  ).run(id, value, kind === "phone" ? value : null, role, now);

  const created = rowToUser(
    db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`).get(id) as
      | Record<string, unknown>
      | undefined,
  );
  if (!created) throw new Error("Failed to create the account.");
  return created;
}

export function getUserById(id: string): AuthUser | null {
  return rowToUser(
    db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`).get(id) as
      | Record<string, unknown>
      | undefined,
  );
}

export function getUserByIdentifier(identifierInput: string): AuthUser | null {
  const parsed = classifyIdentifier(identifierInput);
  if (!parsed) return null;
  return rowToUser(
    db
      .prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.email = ?`)
      .get(parsed.value) as Record<string, unknown> | undefined,
  );
}

/* -------------------------------------------------------------------------
 * Roles
 * ---------------------------------------------------------------------- */

/**
 * Is this account an admin?
 *
 * Takes either an identifier string or a loaded user, because both call sites
 * exist. The allowlist is checked in addition to the stored role so a bootstrap
 * admin is recognised even before their first login has written the column.
 */
export function isAdmin(subject: string | AuthUser): boolean {
  if (typeof subject !== "string") {
    return subject.role === "ADMIN" || BOOTSTRAP_ADMINS.has(subject.email);
  }
  const parsed = classifyIdentifier(subject);
  if (!parsed) return false;
  if (BOOTSTRAP_ADMINS.has(parsed.value)) return true;
  const user = getUserByIdentifier(parsed.value);
  return user?.role === "ADMIN";
}

/**
 * Grant or revoke admin.
 *
 * Refuses to demote a bootstrap admin — that allowlist is the recovery path,
 * and letting the UI contradict it would produce an account the panel shows as
 * USER while every permission check still says ADMIN.
 */
export function setUserRole(
  userId: string,
  role: UserRole,
): { ok: true } | { ok: false; error: string } {
  const user = getUserById(userId);
  if (!user) return { ok: false, error: "No such user." };
  if (role !== "ADMIN" && BOOTSTRAP_ADMINS.has(user.email)) {
    return {
      ok: false,
      error:
        "This account is on the ADMIN_EMAILS/ADMIN_PHONES allowlist and cannot be demoted from the panel. Remove it from the environment first.",
    };
  }
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
  return { ok: true };
}

/* -------------------------------------------------------------------------
 * One-time codes
 * ---------------------------------------------------------------------- */

/**
 * A 6-digit code.
 *
 * The upper bound is exclusive, so the old `randomInt(100000, 999999)` could
 * never produce 999999. Cosmetic, but it is the kind of off-by-one that makes
 * people distrust the rest of the file.
 */
export function generateOTP(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Replace any outstanding code for this identifier with a new one.
 *
 * Storing the HMAC rather than the code means a database reader cannot sign in,
 * and it means this function is the only place the plaintext exists.
 */
export function storeOTP(
  identifierInput: string,
  code: string,
  channel: IdentifierKind = "email",
): void {
  const parsed = classifyIdentifier(identifierInput);
  if (!parsed) throw new Error("Not a valid email address or phone number.");

  const now = Date.now();
  const write = db.transaction(() => {
    db.prepare("DELETE FROM otp_codes WHERE email = ?").run(parsed.value);
    db.prepare(
      `INSERT INTO otp_codes (id, email, code, expiresAt, createdAt, verified, attempts, channel)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
    ).run(
      crypto.randomUUID(),
      parsed.value,
      hashOtp(parsed.value, code),
      now + OTP_EXPIRY_MINUTES * 60 * 1000,
      now,
      channel,
    );
  });
  write();
}

interface OtpRow {
  id: string;
  code: string;
  expiresAt: number;
  attempts: number;
}

/**
 * Check a code and, on success, return the account it belongs to.
 *
 * Returns a reason rather than a bare null so the route can distinguish "you
 * mistyped it" from "it expired" from "stop guessing" — the old single-null
 * return made every one of those the same opaque message.
 */
export function verifyOTP(identifierInput: string, code: string): VerifyOtpResult {
  const parsed = classifyIdentifier(identifierInput);
  if (!parsed) {
    return { ok: false, reason: "no_code", attemptsRemaining: 0 };
  }

  const submitted = (code ?? "").trim();
  const row = db
    .prepare(
      `SELECT id, code, expiresAt, attempts
       FROM otp_codes
       WHERE email = ? AND verified = 0
       ORDER BY createdAt DESC
       LIMIT 1`,
    )
    .get(parsed.value) as OtpRow | undefined;

  if (!row) return { ok: false, reason: "no_code", attemptsRemaining: 0 };

  if (row.expiresAt <= Date.now()) {
    db.prepare("DELETE FROM otp_codes WHERE id = ?").run(row.id);
    return { ok: false, reason: "expired", attemptsRemaining: 0 };
  }

  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    db.prepare("DELETE FROM otp_codes WHERE id = ?").run(row.id);
    return { ok: false, reason: "too_many_attempts", attemptsRemaining: 0 };
  }

  if (!timingSafeEqualHex(hashOtp(parsed.value, submitted), row.code)) {
    const attempts = row.attempts + 1;
    const remaining = OTP_MAX_ATTEMPTS - attempts;
    if (remaining <= 0) {
      db.prepare("DELETE FROM otp_codes WHERE id = ?").run(row.id);
      return { ok: false, reason: "too_many_attempts", attemptsRemaining: 0 };
    }
    db.prepare("UPDATE otp_codes SET attempts = ? WHERE id = ?").run(attempts, row.id);
    return { ok: false, reason: "mismatch", attemptsRemaining: remaining };
  }

  /* Consume the code before issuing the session: a code must work exactly once
   * even if two requests arrive together. */
  const consumed = db
    .prepare("DELETE FROM otp_codes WHERE id = ? AND verified = 0")
    .run(row.id);
  if (consumed.changes === 0) {
    return { ok: false, reason: "no_code", attemptsRemaining: 0 };
  }

  const user = getOrCreateUserByEmail(parsed.value);
  const now = Date.now();

  /* Re-assert the allowlist on every login. This is what makes the configured
   * owner accounts self-healing rather than a one-time migration. */
  const shouldPromote = BOOTSTRAP_ADMINS.has(user.email) && user.role !== "ADMIN";
  db.prepare(
    `UPDATE users SET lastLoginAt = ?${shouldPromote ? ", role = 'ADMIN'" : ""} WHERE id = ?`,
  ).run(now, user.id);

  return {
    ok: true,
    user: { ...user, lastLoginAt: now, role: shouldPromote ? "ADMIN" : user.role },
  };
}

/** Constant-time comparison of two hex digests of equal expected length. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  /* timingSafeEqual throws on a length mismatch, which would itself leak. */
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Seconds until the caller may request another code, or 0 if they may now. */
export function otpCooldownRemaining(identifierInput: string): number {
  const parsed = classifyIdentifier(identifierInput);
  if (!parsed) return 0;
  const row = db
    .prepare("SELECT createdAt FROM otp_codes WHERE email = ? ORDER BY createdAt DESC LIMIT 1")
    .get(parsed.value) as { createdAt: number } | undefined;
  if (!row) return 0;
  const elapsed = Date.now() - row.createdAt;
  const cooldown = 30_000;
  return elapsed >= cooldown ? 0 : Math.ceil((cooldown - elapsed) / 1000);
}

/* -------------------------------------------------------------------------
 * Sessions
 * ---------------------------------------------------------------------- */

export function createSession(userId: string): Session {
  const token = generateSessionToken();
  const now = Date.now();
  const expiresAt = now + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const id = crypto.randomUUID();

  db.prepare(
    `INSERT INTO auth_sessions (id, userId, token, expiresAt, createdAt)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, userId, token, expiresAt, now);

  return { id, userId, token, expiresAt, createdAt: now };
}

/**
 * Resolve a session token to its user, or null.
 *
 * Note the explicit column list. The previous `SELECT s.*, u.*` produced two
 * columns named `id` and two named `createdAt`; better-sqlite3 keeps the last
 * of each, so the returned object's `createdAt` was the session's creation time
 * masquerading as the user's, and the code had to paper over `id` by hand.
 */
export function validateSession(token: string): AuthUser | null {
  if (!token) return null;

  return rowToUser(
    db
      .prepare(
        `SELECT ${USER_COLUMNS}
         FROM auth_sessions s
         JOIN users u ON u.id = s.userId
         WHERE s.token = ? AND s.expiresAt > ?`,
      )
      .get(token, Date.now()) as Record<string, unknown> | undefined,
  );
}

export function deleteSession(token: string): void {
  db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
}

/** Sign an account out everywhere. Used when a role changes. */
export function deleteAllSessionsForUser(userId: string): void {
  db.prepare("DELETE FROM auth_sessions WHERE userId = ?").run(userId);
}

export function cleanupExpiredSessions(): void {
  const now = Date.now();
  db.prepare("DELETE FROM auth_sessions WHERE expiresAt <= ?").run(now);
  db.prepare("DELETE FROM otp_codes WHERE expiresAt <= ?").run(now);
}

export function getUserFromToken(token: string): AuthUser | null {
  return validateSession(token);
}
