/**
 * src/lib/credentialManager.ts
 * ---------------------------------------------------------------------------
 * Per-user gateway credentials.
 *
 * WHAT CHANGED AND WHY
 *
 * This module used to read and write a single `providers.json` in the process
 * working directory. That meant one global provider list for the entire app:
 * whatever the last person saved became everyone's gateway, everyone's API key
 * and everyone's quota. `GET /api/credentials` then returned that file verbatim,
 * unauthenticated, with the API keys in cleartext.
 *
 * Credentials now live in the `user_providers` table, one set per account, with
 * the key encrypted at rest by lib/crypto.ts. Nothing here ever returns a
 * decrypted key to a caller that only wants to display it — see
 * `listProvidersForDisplay`, which is what the API route uses.
 *
 * MIGRATION
 *
 * `importLegacyProvidersFor(userId)` copies an existing providers.json into one
 * account, once. It is called for the first admin who opens the credentials
 * page, so the setup you already had keeps working instead of vanishing on
 * upgrade. The file is left on disk untouched; a marker row in app_settings
 * stops it being imported twice.
 *
 * THE SYNCHRONOUS READ
 *
 * `getActiveProviderSync` exists because the hot path — building an upstream
 * request — cannot be async without rewriting every caller. better-sqlite3 is
 * synchronous, so this is a genuine synchronous read rather than blocking on a
 * promise.
 */

import fs from "fs";
import path from "path";
import db from "./db";
import { encryptSecret, decryptSecret, maskSecret } from "./crypto";

const LEGACY_PROVIDERS_FILE = path.join(process.cwd(), "providers.json");
const LEGACY_IMPORT_MARKER = "providers_json_imported_for";

export interface ProviderConfig {
  id: string;
  name: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  modelIds?: string[];
  isActive?: boolean;
}

/** The safe shape: same fields, but the key is masked and cannot be recovered. */
export interface ProviderDisplay {
  id: string;
  name: string;
  provider: string;
  apiKeyPreview: string;
  hasApiKey: boolean;
  baseUrl: string;
  modelIds?: string[];
  isActive: boolean;
}

export interface ProvidersData {
  providers: ProviderConfig[];
  activeProviderId: string | null;
}

export interface ProvidersDisplayData {
  providers: ProviderDisplay[];
  activeProviderId: string | null;
}

interface ProviderRow {
  userId: string;
  id: string;
  name: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  modelIds: string | null;
  isActive: number;
}

/* -------------------------------------------------------------------------
 * Row mapping
 * ---------------------------------------------------------------------- */

function parseModelIds(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const clean = parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return clean.length > 0 ? clean : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Row -> ProviderConfig, decrypting the key.
 *
 * A key that fails to decrypt becomes an empty string rather than throwing. The
 * provider still lists, so the person can see it exists and re-enter the key;
 * throwing here would take out the whole settings page and give no clue why.
 */
function toConfig(row: ProviderRow): ProviderConfig {
  const modelIds = parseModelIds(row.modelIds);
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    apiKey: decryptSecret(row.apiKey) ?? "",
    baseUrl: row.baseUrl,
    ...(modelIds ? { modelIds } : {}),
    isActive: row.isActive === 1,
  };
}

function toDisplay(row: ProviderRow): ProviderDisplay {
  const plain = decryptSecret(row.apiKey) ?? "";
  const modelIds = parseModelIds(row.modelIds);
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    apiKeyPreview: maskSecret(plain),
    hasApiKey: plain.length > 0,
    baseUrl: row.baseUrl,
    ...(modelIds ? { modelIds } : {}),
    isActive: row.isActive === 1,
  };
}

/* -------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------- */

const selectForUserStmt = db.prepare(
  "SELECT * FROM user_providers WHERE userId = ? ORDER BY createdAt ASC",
);

function rowsFor(userId: string): ProviderRow[] {
  return selectForUserStmt.all(userId) as ProviderRow[];
}

/** Full records including decrypted keys. Server-side callers only. */
export function readProvidersFor(userId: string): ProvidersData {
  const rows = rowsFor(userId);
  const providers = rows.map(toConfig);
  const active = rows.find((row) => row.isActive === 1);
  return { providers, activeProviderId: active?.id ?? null };
}

/** Masked records, safe to serialise to a browser. */
export function listProvidersForDisplay(userId: string): ProvidersDisplayData {
  const rows = rowsFor(userId);
  const providers = rows.map(toDisplay);
  const active = rows.find((row) => row.isActive === 1);
  return { providers, activeProviderId: active?.id ?? null };
}

export function getActiveProviderFor(userId: string): ProviderConfig | null {
  const row = db
    .prepare("SELECT * FROM user_providers WHERE userId = ? AND isActive = 1")
    .get(userId) as ProviderRow | undefined;
  return row ? toConfig(row) : null;
}

/** Synchronous alias, for the request hot path. */
export function getActiveProviderSync(userId: string): ProviderConfig | null {
  return getActiveProviderFor(userId);
}

export function getProviderById(
  userId: string,
  providerId: string,
): ProviderConfig | null {
  const row = db
    .prepare("SELECT * FROM user_providers WHERE userId = ? AND id = ?")
    .get(userId, providerId) as ProviderRow | undefined;
  return row ? toConfig(row) : null;
}

/* -------------------------------------------------------------------------
 * Writes
 * ---------------------------------------------------------------------- */

/** Build a provider id that is unique within one user's namespace. */
export function generateProviderId(userId: string, provider: string): string {
  const base = provider.trim().toLowerCase() || "provider";
  const taken = new Set(rowsFor(userId).map((row) => row.id));

  let counter = 1;
  let candidate = `${base}-${counter}`;
  while (taken.has(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}`;
  }
  return candidate;
}

/**
 * Insert or update one provider for one user.
 *
 * Runs in a transaction with the active-flag update because the partial unique
 * index on (userId) WHERE isActive = 1 means clearing and setting the flag must
 * not be observable as two separate states.
 *
 * `apiKey` is optional on update: an empty value keeps the stored key, so the
 * settings form can be write-only — it never has to receive a real key in order
 * to send one back.
 */
export const upsertProvider = db.transaction(
  (
    userId: string,
    input: {
      id: string;
      name: string;
      provider: string;
      apiKey?: string;
      baseUrl: string;
      modelIds?: string[];
      makeActive?: boolean;
    },
  ): void => {
    const now = Date.now();
    const existing = db
      .prepare("SELECT * FROM user_providers WHERE userId = ? AND id = ?")
      .get(userId, input.id) as ProviderRow | undefined;

    const encryptedKey =
      input.apiKey && input.apiKey.trim()
        ? encryptSecret(input.apiKey.trim())
        : existing?.apiKey ?? "";

    const modelIdsJson =
      input.modelIds && input.modelIds.length > 0
        ? JSON.stringify(input.modelIds)
        : null;

    if (existing) {
      db.prepare(
        `UPDATE user_providers
            SET name = ?, provider = ?, apiKey = ?, baseUrl = ?,
                modelIds = ?, updatedAt = ?
          WHERE userId = ? AND id = ?`,
      ).run(
        input.name,
        input.provider,
        encryptedKey,
        input.baseUrl,
        modelIdsJson,
        now,
        userId,
        input.id,
      );
    } else {
      db.prepare(
        `INSERT INTO user_providers
           (userId, id, name, provider, apiKey, baseUrl, modelIds,
            isActive, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        userId,
        input.id,
        input.name,
        input.provider,
        encryptedKey,
        input.baseUrl,
        modelIdsJson,
        now,
        now,
      );
    }

    /* First provider becomes active automatically — otherwise someone adds one
     * credential, nothing is marked active, and every request falls back to the
     * env default with no indication why. */
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM user_providers WHERE userId = ?")
      .get(userId) as { n: number };

    if (input.makeActive || count.n === 1) {
      db.prepare(
        "UPDATE user_providers SET isActive = 0 WHERE userId = ?",
      ).run(userId);
      db.prepare(
        "UPDATE user_providers SET isActive = 1 WHERE userId = ? AND id = ?",
      ).run(userId, input.id);
    }
  },
);

/** Remove one provider. Returns false when the user does not own that id. */
export const removeProvider = db.transaction(
  (userId: string, providerId: string): boolean => {
    const existing = db
      .prepare("SELECT isActive FROM user_providers WHERE userId = ? AND id = ?")
      .get(userId, providerId) as { isActive: number } | undefined;

    if (!existing) return false;

    db.prepare(
      "DELETE FROM user_providers WHERE userId = ? AND id = ?",
    ).run(userId, providerId);

    /* Promote another row so the user is not left with providers configured but
     * none active, which reads as "my key vanished". */
    if (existing.isActive === 1) {
      const next = db
        .prepare(
          "SELECT id FROM user_providers WHERE userId = ? ORDER BY createdAt ASC LIMIT 1",
        )
        .get(userId) as { id: string } | undefined;

      if (next) {
        db.prepare(
          "UPDATE user_providers SET isActive = 1 WHERE userId = ? AND id = ?",
        ).run(userId, next.id);
      }
    }

    return true;
  },
) as (userId: string, providerId: string) => boolean;

/** Switch the active provider. Returns false when the id is not the user's. */
export const setActiveProvider = db.transaction(
  (userId: string, providerId: string): boolean => {
    const exists = db
      .prepare("SELECT 1 FROM user_providers WHERE userId = ? AND id = ?")
      .get(userId, providerId);

    if (!exists) return false;

    db.prepare("UPDATE user_providers SET isActive = 0 WHERE userId = ?").run(
      userId,
    );
    db.prepare(
      "UPDATE user_providers SET isActive = 1 WHERE userId = ? AND id = ?",
    ).run(userId, providerId);

    return true;
  },
) as (userId: string, providerId: string) => boolean;

/* -------------------------------------------------------------------------
 * Legacy import
 * ---------------------------------------------------------------------- */

/**
 * Copy a pre-existing providers.json into one account, at most once.
 *
 * Returns the number of providers imported. Safe to call on every request: the
 * marker row makes repeat calls a no-op, and a user who already has providers
 * is skipped so an import can never overwrite something they configured
 * themselves.
 */
export function importLegacyProvidersFor(userId: string): number {
  try {
    const already = db
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(LEGACY_IMPORT_MARKER) as { value: string } | undefined;
    if (already) return 0;

    if (rowsFor(userId).length > 0) return 0;
    if (!fs.existsSync(LEGACY_PROVIDERS_FILE)) return 0;

    const raw = fs.readFileSync(LEGACY_PROVIDERS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ProvidersData>;
    if (!parsed || !Array.isArray(parsed.providers)) return 0;

    let imported = 0;
    for (const entry of parsed.providers) {
      if (!entry?.id || !entry.baseUrl) continue;

      upsertProvider(userId, {
        id: String(entry.id),
        name: String(entry.name || entry.id),
        provider: String(entry.provider || "omniroute"),
        ...(entry.apiKey ? { apiKey: String(entry.apiKey) } : {}),
        baseUrl: String(entry.baseUrl),
        ...(Array.isArray(entry.modelIds) ? { modelIds: entry.modelIds } : {}),
        makeActive: entry.id === parsed.activeProviderId,
      });
      imported += 1;
    }

    db.prepare(
      "INSERT OR IGNORE INTO app_settings (key, value, updatedAt) VALUES (?, ?, ?)",
    ).run(LEGACY_IMPORT_MARKER, userId, Date.now());

    return imported;
  } catch {
    /* A malformed or unreadable providers.json must not break sign-in. */
    return 0;
  }
}
