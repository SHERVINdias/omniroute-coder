/**
 * src/lib/crypto.ts
 * ---------------------------------------------------------------------------
 * Symmetric encryption for secrets held at rest.
 *
 * WHY THIS EXISTS
 *
 * Provider API keys used to live in `providers.json` as cleartext, in one
 * global file, served verbatim by an unauthenticated GET. Moving them into the
 * database fixes the access-control half of that problem; this file fixes the
 * other half. A stolen `chat.db` — a careless backup, a snapshot left on a
 * shared volume, a `docker cp` — should not be a stolen set of API keys.
 *
 * DESIGN NOTES
 *
 * AES-256-GCM, because it authenticates as well as encrypts: a tampered
 * ciphertext fails loudly at `decipher.final()` instead of silently decrypting
 * to garbage that then gets sent to a gateway as a Bearer token.
 *
 * The key is derived with scrypt rather than used raw, so that a short or
 * low-entropy CREDENTIALS_SECRET still produces a uniform 32-byte key. scrypt
 * is deliberately slow, so the derived key is cached per secret for the life of
 * the process — without that cache every single decrypt would pay the full
 * derivation cost, and a page that lists ten providers would stall.
 *
 * The stored format is `v1:<iv>:<tag>:<ciphertext>`, all base64url. The version
 * prefix is what makes a future key rotation or algorithm change possible: a
 * reader can recognise an old record rather than having to guess.
 *
 * WHAT THIS IS NOT
 *
 * This protects data at rest, not data in use. Anything that can read the
 * secret can decrypt the records, and the running server by definition can.
 * There is no way around that for credentials the server must present upstream;
 * the realistic goal is that a leaked database file alone is not enough.
 */

import crypto from "crypto";
import db from "./db";

/** Cache of derived keys, keyed by the secret they came from. */
const keyCache = new Map<string, Buffer>();

/** Where the generated secret is kept when CREDENTIALS_SECRET is unset. */
const SECRET_ROW_KEY = "credentials_secret";

/**
 * The master secret.
 *
 * Prefers CREDENTIALS_SECRET, then AUTH_SECRET, then a generated value
 * persisted in app_settings. Persisting matters: a per-process secret would
 * mean every restart made every stored credential undecryptable, which looks
 * exactly like data loss to the person whose keys just disappeared.
 *
 * The INSERT OR IGNORE / re-read pattern is the same one emailAuth uses for its
 * own secret — if two requests race, both attempt the insert, one wins, and
 * both then read the winning row rather than each trusting its own value.
 */
function masterSecret(): string {
  const fromEnv = (process.env.CREDENTIALS_SECRET ?? "").trim();
  if (fromEnv) return fromEnv;

  const authEnv = (process.env.AUTH_SECRET ?? "").trim();
  if (authEnv) return authEnv;

  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(SECRET_ROW_KEY) as { value: string } | undefined;
  if (row?.value) return row.value;

  const generated = crypto.randomBytes(32).toString("hex");
  db.prepare(
    "INSERT OR IGNORE INTO app_settings (key, value, updatedAt) VALUES (?, ?, ?)",
  ).run(SECRET_ROW_KEY, generated, Date.now());

  const settled = db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(SECRET_ROW_KEY) as { value: string } | undefined;
  return settled?.value ?? generated;
}

/**
 * Derive the AES key.
 *
 * The salt is fixed and derived from the app name rather than random, because
 * the ciphertext has to be decryptable later without storing a per-record salt.
 * That is a real weakening versus per-record salts, and it is the standard
 * trade-off for envelope-less symmetric storage: the security here rests on the
 * secret's entropy, not on the salt.
 */
function derivedKey(): Buffer {
  const secret = masterSecret();

  const cached = keyCache.get(secret);
  if (cached) return cached;

  const key = crypto.scryptSync(secret, "omniroute.credentials.v1", 32);
  keyCache.set(secret, key);
  return key;
}

function b64(buf: Buffer): string {
  return buf.toString("base64url");
}

/** True when `value` looks like something this module produced. */
export function isEncrypted(value: string): boolean {
  return typeof value === "string" && value.startsWith("v1:");
}

/**
 * Encrypt a UTF-8 string. Returns `v1:<iv>:<tag>:<ciphertext>`.
 *
 * An empty input returns an empty string rather than a valid-looking record,
 * so "no key configured" cannot be confused with "a key that decrypts to
 * nothing".
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return "";

  const iv = crypto.randomBytes(12); // 96-bit nonce, the GCM standard
  const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `v1:${b64(iv)}:${b64(tag)}:${b64(ciphertext)}`;
}

/**
 * Decrypt a record produced by `encryptSecret`.
 *
 * Returns null on any failure — malformed record, wrong key, tampered
 * ciphertext. Callers treat null as "this credential is unusable", which is the
 * only safe reading: the alternative is passing corrupted bytes upstream as an
 * Authorization header.
 *
 * A value that is not in the v1 format is returned unchanged. That is the
 * migration path for rows written before encryption existed, so an upgrade does
 * not strand anyone's existing key.
 */
export function decryptSecret(stored: string): string | null {
  if (!stored) return null;
  if (!isEncrypted(stored)) return stored;

  const parts = stored.split(":");
  if (parts.length !== 4) return null;

  const [, ivB64, tagB64, dataB64] = parts;

  try {
    const iv = Buffer.from(ivB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    const data = Buffer.from(dataB64, "base64url");

    /* GCM requires a 12-byte IV and a 16-byte tag. createDecipheriv would
     * accept some other IV lengths, so check explicitly rather than let a
     * truncated record proceed. */
    if (iv.length !== 12 || tag.length !== 16) return null;

    const decipher = crypto.createDecipheriv("aes-256-gcm", derivedKey(), iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    /* Wrong key or tampered data. */
    return null;
  }
}

/**
 * A display form that proves which key is stored without revealing it.
 *
 * Shows at most the last four characters. Anything short enough that a suffix
 * would be most of the key is masked completely — a four-character "preview" of
 * a six-character key is not a preview.
 */
export function maskSecret(plaintext: string | null | undefined): string {
  if (!plaintext) return "";
  if (plaintext.length <= 8) return "•".repeat(plaintext.length);
  return `${"•".repeat(8)}${plaintext.slice(-4)}`;
}
