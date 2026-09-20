/**
 * src/lib/referenceProjectStore.ts
 * ---------------------------------------------------------------------------
 * Per-user storage for the *reference project*: a second folder the assistant
 * may search and read, but may never write to.
 *
 * WHAT THIS IS FOR
 *
 * "If I need some features of project 1 to be put in project 2." The old way
 * to do that was to paste files from one project into the chat by hand, which
 * costs a fortune in input tokens and goes stale the moment the source changes.
 * The reference project makes project 1 addressable instead: the model can
 * search it and read the parts it needs, and project 2 stays the only place
 * anything is written.
 *
 * WHY READ-ONLY IS ENFORCED BY THE SHAPE OF THE API, NOT BY A FLAG
 *
 * There is no `writable` column here and no write tool that accepts a root.
 * The reference folder is reachable through exactly three RPCs — list, read,
 * search — and the write path resolves its root through a different function
 * that cannot return it. A boolean would have been one forgotten `if` away
 * from writing to the wrong project, and the whole value of this feature is
 * that project 1 is safe from the agent working on project 2.
 *
 * WHY THE SERVER CANNOT VALIDATE THE PATH
 *
 * The folder is on the user's machine, not on this server. `fs.existsSync`
 * here answers a question about the wrong computer — on a shared deployment it
 * would be probing the operator's container. So this module validates only the
 * *shape* of the string, and the real authorisation happens where the files
 * are: the extension refuses any reference root the user has not approved in
 * VS Code, and re-checks that on every call rather than once at set time,
 * because consent can be revoked while a chat is open.
 * ------------------------------------------------------------------------- */

import db from "@/lib/db";

/* -------------------------------------------------------------------------
 * Schema
 * ---------------------------------------------------------------------- */

/**
 * One row per user.
 *
 * `enabled` is a separate column from `path` on purpose: "off for now" and
 * "never configured" are different states, and collapsing them would mean a
 * user who switches the feature off loses the folder they chose and has to
 * find it again. The user asked for this to be optional, and optional includes
 * being able to put it down and pick it up.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS user_reference_project (
    userId TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );
`);

/* -------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------- */

export interface ReferenceProject {
  /** Absolute path on the USER's machine, in that machine's spelling. */
  path: string;
  /** Folder name, for display. Derived when the caller does not supply one. */
  name: string;
  enabled: boolean;
  updatedAt: number;
}

export const NO_REFERENCE_PROJECT: ReferenceProject = {
  path: "",
  name: "",
  enabled: false,
  updatedAt: 0,
};

export interface SanitizedReference {
  config: ReferenceProject;
  /** Why the input was refused, or null when it was accepted. */
  error: string | null;
}

/**
 * Longest path we will store.
 *
 * Windows' traditional limit is 260 and its long-path form allows ~32767;
 * nothing legitimate is anywhere near either. The cap exists so a pasted blob
 * cannot become a row, and so the string that ends up inside an RPC payload
 * stays a path rather than a payload of its own.
 */
export const MAX_PATH_LENGTH = 1024;

/* -------------------------------------------------------------------------
 * Validation
 * ---------------------------------------------------------------------- */

/**
 * Does this look like an absolute path on *some* operating system?
 *
 * Deliberately not `path.isAbsolute`. That function answers for the platform
 * this process runs on, and this process is very often Linux in a container
 * while the folder is on a Windows laptop — where `path.isAbsolute` says false
 * for `C:\Users\me\project` and the only legitimate input would be rejected.
 * Both spellings are accepted because both are real.
 */
function looksAbsolute(value: string): boolean {
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\]/.test(value) // UNC share: \\server\share
  );
}

/** The last path segment, for display. Handles both separators. */
export function folderNameFrom(fsPath: string): string {
  const parts = String(fsPath ?? "")
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : fsPath;
}

/**
 * Validate and normalise what the settings panel sent.
 *
 * Returns a config plus one message rather than throwing, so the route can
 * answer "here is what I stored and here is why your input was not it" in a
 * single response. An empty path is a legitimate input meaning "clear it".
 */
export function sanitizeReference(input: unknown): SanitizedReference {
  const raw = (input ?? {}) as Record<string, unknown>;
  const now = Date.now();

  const rawPath = typeof raw.path === "string" ? raw.path.trim() : "";
  /* An explicit `enabled: false` with a path keeps the folder but stops the
   * tools being offered. Absent means "on", because the only reason to send a
   * path is to use it. */
  const enabled = raw.enabled === undefined ? true : raw.enabled === true;

  if (!rawPath) {
    return {
      config: { path: "", name: "", enabled: false, updatedAt: now },
      error: null,
    };
  }

  if (rawPath.length > MAX_PATH_LENGTH) {
    return {
      config: NO_REFERENCE_PROJECT,
      error: `That path is ${rawPath.length} characters long; the limit is ${MAX_PATH_LENGTH}.`,
    };
  }

  if (!looksAbsolute(rawPath)) {
    return {
      config: NO_REFERENCE_PROJECT,
      error:
        "The reference project must be an absolute path, because it names a " +
        "folder on your machine rather than somewhere inside the folder you " +
        "are working in.",
    };
  }

  /* `..` is refused before it can be stored, rather than only at use time.
   * The extension checks containment again, but a stored root containing `..`
   * would make every later "is this inside the reference?" comparison answer a
   * question about a folder the user never chose. */
  if (
    rawPath
      .split(/[\\/]+/)
      .some((segment) => segment === "..")
  ) {
    return {
      config: NO_REFERENCE_PROJECT,
      error: "The path contains \"..\". Use the folder's real location.",
    };
  }

  if (/\0/.test(rawPath)) {
    return {
      config: NO_REFERENCE_PROJECT,
      error: "That path contains a null byte.",
    };
  }

  const name =
    typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim().slice(0, 120)
      : folderNameFrom(rawPath);

  return {
    config: { path: rawPath, name, enabled, updatedAt: now },
    error: null,
  };
}

/* -------------------------------------------------------------------------
 * Read / write
 * ---------------------------------------------------------------------- */

interface Row {
  path: string;
  name: string;
  enabled: number;
  updatedAt: number;
}

const selectStmt = db.prepare<[string]>(
  "SELECT path, name, enabled, updatedAt FROM user_reference_project WHERE userId = ?",
);

const upsertStmt = db.prepare<[string, string, string, number, number]>(`
  INSERT INTO user_reference_project (userId, path, name, enabled, updatedAt)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(userId) DO UPDATE SET
    path = excluded.path,
    name = excluded.name,
    enabled = excluded.enabled,
    updatedAt = excluded.updatedAt
`);

/** The stored reference project, or the "none configured" default. */
export function getReferenceProject(userId: string): ReferenceProject {
  if (!userId) return NO_REFERENCE_PROJECT;
  const row = selectStmt.get(userId) as Row | undefined;
  if (!row) return NO_REFERENCE_PROJECT;
  return {
    path: row.path,
    name: row.name || folderNameFrom(row.path),
    enabled: row.enabled === 1,
    updatedAt: row.updatedAt,
  };
}

/**
 * The reference project only if it is actually usable right now.
 *
 * This is the accessor the tool layer uses, and it collapses "not configured",
 * "configured but switched off" and "configured with an empty path" into one
 * answer — because all three mean the same thing to a dispatcher: do not offer
 * the tools, and refuse the call if something asks anyway.
 */
export function activeReferenceProject(userId: string): ReferenceProject | null {
  const config = getReferenceProject(userId);
  if (!config.enabled || !config.path) return null;
  return config;
}

/* -------------------------------------------------------------------------
 * Prompt
 * ---------------------------------------------------------------------- */

/**
 * The system-prompt paragraph describing the reference project, or "" when
 * none is configured.
 *
 * WHY IT LIVES HERE AND NOT IN referenceProject.ts
 *
 * vscodeBridge builds the system prompt and needs this, and referenceProject
 * imports vscodeBridge — so defining it in referenceProject would close an
 * import cycle between the two largest modules on the server path. This store
 * imports nothing but `db`, which makes it the safe end to hang the string
 * from. It reads the same `activeReferenceProject` accessor the tool layer
 * uses, so the prompt and the tools can never disagree about whether a
 * reference project is in play.
 *
 * Deliberately short. It names the folder, states the one rule that cannot be
 * discovered by trying (you cannot write there), and warns about the single
 * mistake the feature invites: quoting a path from project 1 as though it
 * existed in project 2.
 */
export function referencePromptBlock(userId: string): string {
  const reference = activeReferenceProject(userId || "");
  if (!reference) return "";

  return [
    "",
    "REFERENCE PROJECT (READ-ONLY)",
    `- A second project, "${reference.name}", is available for reading only. It is NOT the project you are editing.`,
    "- Use ref_search to find how something is done there, then ref_read_file for just the region you need.",
    "- You cannot write to it. write_file and replace_text always act on the working project, never on this one.",
    "- Its paths are not working-project paths. To bring something across, read it there and then write the",
    "  code into the working project at a path you confirmed with list_files.",
    "- Do not read it speculatively. Reach for it when the user refers to the other project, or when you need",
    "  to match something that already exists there.",
  ].join("\n");
}

/** Validate, store, return what was stored plus any complaint. */
export function saveReferenceProject(
  userId: string,
  input: unknown,
): SanitizedReference {
  const result = sanitizeReference(input);
  if (!userId || result.error) return result;

  upsertStmt.run(
    userId,
    result.config.path,
    result.config.name,
    result.config.enabled ? 1 : 0,
    result.config.updatedAt,
  );
  return result;
}
