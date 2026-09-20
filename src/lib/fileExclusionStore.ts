/**
 * src/lib/fileExclusionStore.ts
 * ---------------------------------------------------------------------------
 * Per-user storage for the file-exclusion rules, plus the compiled-matcher
 * cache that the tool layer hits on every single file operation.
 *
 * Split from `fileExclusions.ts` on purpose: that module is pure and has no
 * imports, so it can be bundled into the VS Code extension and imported by
 * browser code. This one owns a SQLite handle and can only ever run on the
 * server.
 *
 * WHY A CACHE
 *
 * `listFiles` asks about every entry it returns, and a Deep Cowork round can
 * touch hundreds of paths. Rebuilding ~150 RegExps per call would be wasteful,
 * and doing a SELECT per path would be worse. So the compiled matcher is held
 * per user and invalidated on write.
 *
 * The cache is keyed by userId and validated against `updatedAt`, not just by
 * presence. In dev, Next hot-reloads this module while the SQLite file stays
 * put, and a cache that only checked presence would keep serving a matcher
 * built from rules the user has since changed — the exact failure where
 * someone adds an exclusion, sees the model read the file anyway, and
 * reasonably concludes the feature does not work.
 * ------------------------------------------------------------------------- */

import db from "@/lib/db";
import {
  ExclusionConfig,
  ExclusionMatcher,
  EMPTY_EXCLUSION_CONFIG,
  matcherFrom,
  sanitizeConfig,
  SanitizedConfig,
} from "@/lib/fileExclusions";

/* -------------------------------------------------------------------------
 * Schema
 * ---------------------------------------------------------------------- */

/**
 * One row per user, holding two JSON arrays.
 *
 * JSON rather than a row-per-pattern table because ORDER MATTERS here — "!"
 * negations are last-match-wins — and an ordered child table needs a position
 * column that every reorder has to rewrite. The whole list is read and written
 * as a unit by both the UI and the engine, so there is nothing to gain from
 * splitting it and a real invariant to lose.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS user_file_exclusions (
    userId TEXT PRIMARY KEY,
    patterns TEXT NOT NULL,
    disabledGroups TEXT NOT NULL,
    updatedAt INTEGER NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );
`);

/* -------------------------------------------------------------------------
 * Read / write
 * ---------------------------------------------------------------------- */

interface Row {
  patterns: string;
  disabledGroups: string;
  updatedAt: number;
}

const selectStmt = db.prepare<[string]>(
  "SELECT patterns, disabledGroups, updatedAt FROM user_file_exclusions WHERE userId = ?",
);

const upsertStmt = db.prepare<[string, string, string, number]>(`
  INSERT INTO user_file_exclusions (userId, patterns, disabledGroups, updatedAt)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(userId) DO UPDATE SET
    patterns = excluded.patterns,
    disabledGroups = excluded.disabledGroups,
    updatedAt = excluded.updatedAt
`);

function parseArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    /* A corrupted row must not take file access down with it. Falling back to
     * "no user rules" still leaves ALWAYS and every recommended group in
     * force, so the failure mode is over-exclusion, never under. */
    return [];
  }
}

/**
 * The stored config, or the empty default.
 *
 * An empty config is NOT "nothing is excluded" — the recommended groups are on
 * unless explicitly listed in `disabledGroups`, so a brand new account starts
 * protected. Opting out is a deliberate act that leaves a row behind.
 */
export function getExclusionConfig(userId: string): ExclusionConfig {
  if (!userId) return EMPTY_EXCLUSION_CONFIG;
  const row = selectStmt.get(userId) as Row | undefined;
  if (!row) return EMPTY_EXCLUSION_CONFIG;
  return {
    patterns: parseArray(row.patterns),
    disabledGroups: parseArray(row.disabledGroups),
    updatedAt: row.updatedAt,
  };
}

/**
 * Validate, store, and drop the cached matcher.
 *
 * Returns the sanitized config together with per-pattern complaints so the UI
 * can show "3 of your 40 rules were not saved, here is why" instead of a
 * single opaque failure.
 */
export function saveExclusionConfig(userId: string, input: unknown): SanitizedConfig {
  const result = sanitizeConfig(input);
  if (!userId) return result;

  upsertStmt.run(
    userId,
    JSON.stringify(result.config.patterns),
    JSON.stringify(result.config.disabledGroups),
    result.config.updatedAt,
  );
  cache.delete(userId);
  return result;
}

/* -------------------------------------------------------------------------
 * Matcher cache
 * ---------------------------------------------------------------------- */

interface CacheEntry {
  updatedAt: number;
  matcher: ExclusionMatcher;
}

const cache = new Map<string, CacheEntry>();

/**
 * A cap, so a server with many accounts cannot accumulate one compiled rule
 * set per user forever. Eviction is oldest-inserted-first, which is good
 * enough: the entry costs one SELECT plus ~150 RegExp compiles to rebuild.
 */
const MAX_CACHED_MATCHERS = 200;

/**
 * The matcher for this user, compiled once and reused.
 *
 * `userId` may be empty — a single-user install with no auth context, or a
 * background job. That case gets the default matcher, which still enforces
 * ALWAYS and every recommended group. There is deliberately no code path here
 * that returns "allow everything".
 */
export function getMatcherForUser(userId: string): ExclusionMatcher {
  const config = getExclusionConfig(userId);
  if (!userId) return matcherFrom(config);

  const hit = cache.get(userId);
  if (hit && hit.updatedAt === config.updatedAt) return hit.matcher;

  const matcher = matcherFrom(config);
  if (cache.size >= MAX_CACHED_MATCHERS) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(userId, { updatedAt: config.updatedAt, matcher });
  return matcher;
}

/** For tests and for the settings route after a reset. */
export function clearExclusionCache(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}
