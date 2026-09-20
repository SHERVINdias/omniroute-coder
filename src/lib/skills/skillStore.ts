/**
 * src/lib/skills/skillStore.ts
 * ---------------------------------------------------------------------------
 * Where skills live. A table in chat.db, owned by this module.
 *
 * WHY A TABLE AND NOT A /skills DIRECTORY
 *
 * The obvious implementation is a folder: unzip an upload into
 * `/app/skills/<name>/`, read SKILL.md back when needed. It is also how this
 * feature grows a family of file-handling bugs that have nothing to do with
 * skills:
 *
 *   - zip-slip: an entry named `../../.env` writes outside the target folder.
 *   - path traversal on read: a slug of `../../../etc/passwd` reads whatever
 *     the process can reach.
 *   - zip bombs: a 40 KB upload that expands to fill the 20 GB volume, which
 *     on this deployment also takes SQLite down with it.
 *   - symlink entries pointing at real files elsewhere on the box.
 *   - and the operational one: the container filesystem is ephemeral, so every
 *     `docker compose up --build` silently deletes everyone's skills unless a
 *     volume is mounted and remembered forever.
 *
 * Each of those has a known mitigation and the mitigations are individually
 * easy to get slightly wrong. A row in the database has none of them, because
 * there is no path and no archive: the upload is parsed in memory, validated,
 * and stored as text. It also inherits things already built — the weekly
 * `.backup` cron covers it, `ON DELETE CASCADE` cleans up after a deleted
 * account, and reads are already inside a WAL-mode connection.
 *
 * WHY THE ARRAYS ARE JSON COLUMNS
 *
 * `allowedTools` and `triggers` are stored as JSON text rather than in child
 * tables. They are read and written whole, never queried by element, and hold
 * at most a handful of short strings; a `skill_tools` table would add a join to
 * every read in order to support a query nothing performs. The values are
 * validated by skillManifest before they get here, so the JSON is a
 * serialisation detail and not a way to smuggle unvalidated shapes into the
 * schema. They are still re-checked on the way out — see readRow.
 *
 * EVERY QUERY IS SCOPED BY userId
 *
 * Skill ids come from the client on update and delete. None of these functions
 * trusts an id on its own: the owner is always part of the WHERE clause, so a
 * guessed or copied id matches zero rows instead of somebody else's skill. A
 * store that looked a row up by id and *then* compared owners would be one
 * forgotten early-return away from the same bug.
 *
 * SERVER ONLY. This imports the database. skillManifest.ts is the half that is
 * safe to use from the browser.
 */

import crypto from "crypto";
import db from "@/lib/db";
import {
  SKILL_LIMITS,
  SKILL_TOOL_NAMES,
  type SkillManifest,
  type SkillTrigger,
  type StoredSkill,
} from "./skillManifest";

/* -------------------------------------------------------------------------
 * Schema
 *
 * Created here rather than in db.ts because nothing else reads this table.
 * `IF NOT EXISTS` makes it idempotent and the module-level call means the table
 * is present before any exported function can run — no ordering problem and no
 * migration step for whoever is deploying.
 * ---------------------------------------------------------------------- */

db.exec(`
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    instructions TEXT NOT NULL,
    allowedTools TEXT NOT NULL,
    triggerMode TEXT NOT NULL,
    triggers TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    builtin INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_user_slug ON skills(userId, slug);
  CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(userId, createdAt DESC);
`);

interface SkillRow {
  id: string;
  userId: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  allowedTools: string;
  triggerMode: string;
  triggers: string;
  enabled: number;
  builtin: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Turn a row into a skill, defensively.
 *
 * The JSON columns are parsed inside a try and filtered against the live tool
 * catalog. This is not paranoia about our own writes — it is the restore case.
 * A database can arrive from a backup taken by an older build, or be edited by
 * hand at 2am, and a JSON.parse throwing inside a list endpoint would take the
 * whole Skills panel down rather than showing one broken skill. Dropping an
 * unrecognised tool name also means renaming a tool in a future version
 * degrades a skill instead of breaking the page.
 */
function readRow(row: SkillRow): StoredSkill {
  let allowedTools: string[] = [];
  try {
    const parsed = JSON.parse(row.allowedTools);
    if (Array.isArray(parsed)) {
      allowedTools = parsed.filter(
        (t): t is string => typeof t === "string" && SKILL_TOOL_NAMES.includes(t),
      );
    }
  } catch {
    allowedTools = [];
  }

  let triggers: string[] = [];
  try {
    const parsed = JSON.parse(row.triggers);
    if (Array.isArray(parsed)) {
      triggers = parsed.filter((t): t is string => typeof t === "string");
    }
  } catch {
    triggers = [];
  }

  return {
    id: row.id,
    userId: row.userId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    allowedTools,
    triggerMode: row.triggerMode === "keyword" ? "keyword" : "always",
    triggers,
    enabled: row.enabled === 1,
    builtin: row.builtin === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/* -------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------- */

export function listSkills(userId: string): StoredSkill[] {
  const rows = db
    .prepare(
      `SELECT * FROM skills WHERE userId = ? ORDER BY enabled DESC, createdAt DESC`,
    )
    .all(userId) as SkillRow[];
  return rows.map(readRow);
}

/** Enabled skills only — what the chat pipeline asks for. */
export function enabledSkills(userId: string): StoredSkill[] {
  const rows = db
    .prepare(
      `SELECT * FROM skills WHERE userId = ? AND enabled = 1 ORDER BY createdAt ASC`,
    )
    .all(userId) as SkillRow[];
  return rows.map(readRow);
}

export function getSkill(userId: string, id: string): StoredSkill | null {
  const row = db
    .prepare(`SELECT * FROM skills WHERE id = ? AND userId = ?`)
    .get(id, userId) as SkillRow | undefined;
  return row ? readRow(row) : null;
}

export function countSkills(userId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM skills WHERE userId = ?`)
    .get(userId) as { n: number };
  return row.n;
}

/* -------------------------------------------------------------------------
 * Writes
 * ---------------------------------------------------------------------- */

export type StoreResult =
  | { ok: true; skill: StoredSkill }
  | { ok: false; error: string; conflict?: boolean };

/**
 * Add a skill.
 *
 * The per-user cap and the slug collision are both returned as ordinary errors
 * rather than thrown, because both are things a user can legitimately hit and
 * both have an obvious next action ("delete one", "rename it"). An exception
 * here would become a 500 and tell them nothing.
 */
export function createSkill(
  userId: string,
  manifest: SkillManifest,
  opts: { builtin?: boolean } = {},
): StoreResult {
  if (countSkills(userId) >= SKILL_LIMITS.maxSkillsPerUser) {
    return {
      ok: false,
      error:
        `You already have ${SKILL_LIMITS.maxSkillsPerUser} skills, which is the ` +
        `limit. Delete one you are not using.`,
    };
  }

  const existing = db
    .prepare(`SELECT name FROM skills WHERE userId = ? AND slug = ?`)
    .get(userId, manifest.slug) as { name: string } | undefined;
  if (existing) {
    return {
      ok: false,
      conflict: true,
      error:
        `You already have a skill with the id "${manifest.slug}" ` +
        `("${existing.name}"). Rename this one, or update that one instead.`,
    };
  }

  const now = Date.now();
  const id = crypto.randomUUID();

  db.prepare(
    `INSERT INTO skills (
       id, userId, slug, name, description, instructions,
       allowedTools, triggerMode, triggers, enabled, builtin,
       createdAt, updatedAt
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    manifest.slug,
    manifest.name,
    manifest.description,
    manifest.instructions,
    JSON.stringify(manifest.allowedTools),
    manifest.triggerMode,
    JSON.stringify(manifest.triggers),
    /* Added switched ON. A skill you just deliberately installed and then have
     * to go and enable reads as a bug, and the manual trigger mode already
     * means "enabled" does not mean "always applied". */
    1,
    opts.builtin ? 1 : 0,
    now,
    now,
  );

  const created = getSkill(userId, id);
  if (!created) {
    /* Cannot happen without the insert having silently failed, which would be
     * worth knowing about rather than papering over with a cast. */
    return { ok: false, error: "The skill was not saved. Try again." };
  }
  return { ok: true, skill: created };
}

export interface SkillPatch {
  name?: string;
  description?: string;
  instructions?: string;
  allowedTools?: string[];
  triggerMode?: SkillTrigger;
  triggers?: string[];
  enabled?: boolean;
}

/**
 * Change a skill in place.
 *
 * The slug is deliberately NOT patchable. It is the stable handle a skill is
 * referred to by — in the UI, in an export, and in anything a user has written
 * down — and letting it move would turn "update" into "replace" without saying
 * so. Renaming means deleting and adding.
 *
 * Only the fields actually present in the patch are written, so a UI that sends
 * one toggle does not have to round-trip the whole 20 KB instruction body to
 * avoid blanking it.
 */
export function updateSkill(
  userId: string,
  id: string,
  patch: SkillPatch,
): StoreResult {
  const current = getSkill(userId, id);
  if (!current) return { ok: false, error: "That skill does not exist." };

  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.name !== undefined) {
    sets.push("name = ?");
    values.push(patch.name);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    values.push(patch.description);
  }
  if (patch.instructions !== undefined) {
    sets.push("instructions = ?");
    values.push(patch.instructions);
  }
  if (patch.allowedTools !== undefined) {
    sets.push("allowedTools = ?");
    values.push(JSON.stringify(patch.allowedTools));
  }
  if (patch.triggerMode !== undefined) {
    sets.push("triggerMode = ?");
    values.push(patch.triggerMode);
  }
  if (patch.triggers !== undefined) {
    sets.push("triggers = ?");
    values.push(JSON.stringify(patch.triggers));
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    values.push(patch.enabled ? 1 : 0);
  }

  if (sets.length === 0) return { ok: true, skill: current };

  sets.push("updatedAt = ?");
  values.push(Date.now());

  db.prepare(
    `UPDATE skills SET ${sets.join(", ")} WHERE id = ? AND userId = ?`,
  ).run(...values, id, userId);

  const updated = getSkill(userId, id);
  return updated
    ? { ok: true, skill: updated }
    : { ok: false, error: "The skill disappeared while being updated." };
}

export function deleteSkill(userId: string, id: string): boolean {
  const result = db
    .prepare(`DELETE FROM skills WHERE id = ? AND userId = ?`)
    .run(id, userId);
  return result.changes > 0;
}

/**
 * Whether a user has any skills at all — used to decide if the Skills surface
 * shows its empty state or its list, without pulling every instruction body
 * out of the database to answer a yes/no question.
 */
export function hasAnySkills(userId: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS present FROM skills WHERE userId = ? LIMIT 1`)
    .get(userId) as { present: number } | undefined;
  return Boolean(row);
}
