/**
 * src/lib/vscodeBridge.ts
 * ---------------------------------------------------------------------------
 * The bridge to the VS Code extension, plus everything the model needs in
 * order to DISCOVER the workspace.
 *
 * WHY THE DISCOVERY CODE LIVES HERE
 * ---------------------------------
 * The agent had no way to learn what files exist. No `list_files` tool was
 * registered, and nothing ever told it where the project root was, so it
 * guessed paths, fell back to `searchWeb`, and finally asked the user to paste
 * paths by hand. Nothing was ever written to VS Code.
 *
 * Discovery is deliberately NOT dependent on the VS Code extension. The Next
 * server runs on the same machine as VS Code, so the filesystem is always
 * available and always authoritative. The bridge is tried first (so an edit
 * shows up in VS Code's editor and undo stack), and every operation falls back
 * to plain `fs` when the extension is absent or does not implement the method.
 *
 * WORKSPACE ROOT RESOLUTION, in order:
 *   1. whatever the VS Code extension reports, if it answers one of the
 *      ROOT_RPC_METHODS probes;
 *   2. OMNIROUTE_WORKSPACE_ROOT from .env.local  <- set this if the project you
 *      edit is not the Next app itself;
 *   3. process.cwd() — the Next app's own directory (last resort).
 *
 * Relevant env vars:
 *   OMNIROUTE_WORKSPACE_ROOT=C:\path\to\project
 *   OMNIROUTE_ALLOW_OUTSIDE_ROOT=1   # permit edits outside the root (unsafe)
 *   OMNIROUTE_BRIDGE_PORT=20129
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import WebSocket, { WebSocketServer, RawData } from "ws";
import { IncomingMessage } from "http";
import { AsyncLocalStorage } from "async_hooks";
import { resolveExtensionToken } from "@/lib/extensionTokenStore";
import { getMatcherForUser, getExclusionConfig } from "@/lib/fileExclusionStore";
import {
  activeReferenceProject,
  referencePromptBlock,
} from "@/lib/referenceProjectStore";
import { isMultiTenantBridge, isBridgeEnabled } from "@/lib/deploymentMode";
/* One spelling of the proxied path, shared with the endpoint the UI hands out
 * and with the Caddyfile. A mismatch here produces a connection that is
 * refused with 404 rather than one that silently half-works. */
import { BRIDGE_PATH as BRIDGE_WS_PATH } from "@/lib/bridgeEndpoint";

const execAsync = promisify(exec);

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface WriteFileResult {
  path: string;
  success: boolean;
  hash: string;
  backupPath?: string | null;
}

interface RPCRequest {
  id: string;
  method: string;
  params?: any;
}

interface RPCResponse {
  id: string;
  result?: any;
  error?: string;
}

/* --------------------------- workspace configuration --------------------- */

const ENV_ROOT = (process.env.OMNIROUTE_WORKSPACE_ROOT || "").trim();
const ALLOW_OUTSIDE_ROOT = process.env.OMNIROUTE_ALLOW_OUTSIDE_ROOT === "1";
const BRIDGE_PORT = Number(process.env.OMNIROUTE_BRIDGE_PORT || 20129);

/**
 * Whether this process is a deployed server rather than someone's laptop.
 *
 * Read once here so every relaxation in this file states plainly that it is a
 * local-development convenience. On a server the filesystem being walked is the
 * operator's, shared by every signed-in user, so none of those relaxations are
 * safe there.
 */
const IS_PRODUCTION = process.env.NODE_ENV === "production";

/**
 * Deliberate opt-in required to start the bridge listener on a server.
 *
 * Binding a filesystem RPC port on a shared host is not a decision to make by
 * default, so the listener simply refuses to open in a production build unless
 * someone sets OMNIROUTE_BRIDGE_ENABLE=true. The rule lives in deploymentMode.ts
 * because the pairing UI and the file-tool gate must reach the same conclusion —
 * see `isBridgeEnabled` for why keeping three copies of it was a bug waiting to
 * happen.
 */
const BRIDGE_ENABLED_IN_PRODUCTION = isBridgeEnabled();

/**
 * The interface the listener binds.
 *
 * 127.0.0.1 is right on a laptop and wrong inside a container: loopback inside
 * a container is the CONTAINER's loopback, so a published port reaches nothing
 * and `docker compose` reports a healthy service that refuses every connection.
 * Set OMNIROUTE_BRIDGE_HOST=0.0.0.0 in compose and publish the port bound to the
 * host's loopback (`127.0.0.1:20129:20129`), so the only thing that can reach it
 * is Caddy on the same box.
 *
 * This is not the weakening it looks like. Before this change the address check
 * below was load-bearing; now every connection must present a token that maps to
 * a real account, so the bind address is a deployment detail rather than the
 * authorisation model. Binding wider without the token check would have been
 * catastrophic — which is exactly why the two changes ship together.
 */
const BRIDGE_HOST = (process.env.OMNIROUTE_BRIDGE_HOST || "127.0.0.1").trim();

/**
 * Whether this process serves more than one person.
 *
 * This single flag decides every "what happens when the editor is not there"
 * question in this file, and it decides them the opposite way in each mode. The
 * rule itself lives in deploymentMode.ts — a module with no imports and no side
 * effects — because agentContext.ts needs the same answer, and importing THIS
 * file to get it would start the WebSocket listener as a side effect.
 *
 * Captured once here rather than called per use so that every guard in a single
 * request sees the same value; a flag that could change mid-request would make
 * "refuse" and "fall back to fs" both reachable in one call chain.
 */
const MULTI_TENANT = isMultiTenantBridge();

export { isMultiTenantBridge };

/**
 * The owner key used when no user is in context.
 *
 * On a laptop this is everybody: there is one person, one editor, one project.
 * On a server it is nobody — `MULTI_TENANT` turns every path that would resolve
 * to it into an error, so a call site that forgets to establish an owner fails
 * closed instead of quietly operating as the operator.
 */
export const LOCAL_OWNER = "__local__";

/**
 * Carries "which user is this tool call for" down the call tree.
 *
 * WHY A CONTEXT RATHER THAN A PARAMETER
 *
 * The alternative is an extra argument on `workspaceRoot`, `callTool`,
 * `listFiles`, `readFileSmart`, `writeFileSmart`, `replaceInFileSmart`,
 * `resolveInWorkspace`, `guardPath`, `backup` and `workspaceSnapshot`, threaded
 * through every one of their call sites in three files. That is a large diff
 * whose failure mode is silent: miss one call site and it still compiles, still
 * runs, and operates on the wrong person's machine.
 *
 * With a context, the failure mode of a missed call site is that there is no
 * owner at all — which `MULTI_TENANT` turns into a refusal. Wrong-user is
 * impossible by construction; the worst case is an honest error. For something
 * that hands out filesystem access, an implicit mechanism that fails closed
 * beats an explicit one that fails silently.
 *
 * AsyncLocalStorage propagates across `await`, which is what makes this work at
 * all: one HTTP request's tool loop stays inside its own context for its whole
 * lifetime even while a dozen other requests interleave.
 */
const ownerContext = new AsyncLocalStorage<string>();

/** Stable key for one account. Prefixed so no user id can collide with LOCAL_OWNER. */
function ownerKeyFor(userId: string | null | undefined): string {
  const id = (userId ?? "").trim();
  return id ? `user:${id}` : LOCAL_OWNER;
}

/**
 * Run `fn` with every workspace operation inside it bound to one account.
 *
 * Every entry point that can reach the file tools must go through here:
 * `executeWorkspaceTool`, `buildWorkspaceContext`, and the two API routes that
 * expose the workspace directly. The return value is passed straight through,
 * so wrapping an existing call is a one-line change.
 */
export function withWorkspaceOwner<T>(
  userId: string | null | undefined,
  fn: () => T,
): T {
  return ownerContext.run(ownerKeyFor(userId), fn);
}

/** The account the current call belongs to, or LOCAL_OWNER when unscoped. */
function currentOwner(): string {
  return ownerContext.getStore() ?? LOCAL_OWNER;
}

/**
 * The bare user id for the current call, or "" when there is not one.
 *
 * The owner key is deliberately prefixed (`user:<id>`) so it cannot collide with
 * LOCAL_OWNER; the exclusion store keys on the raw id, so the prefix comes off
 * here rather than in every call site.
 *
 * "" is not a failure. `getMatcherForUser("")` returns the default matcher,
 * which still carries every ALWAYS rule and every recommended group — so a
 * local single-user install, or a background job with no owner context, gets
 * the built-in floor rather than an open door. There is no value of this
 * function that means "allow everything".
 */
function currentUserId(): string {
  const owner = currentOwner();
  return owner.startsWith("user:") ? owner.slice("user:".length) : "";
}

/** Shown whenever a tool call needs an editor and there is not one. */
const NOT_CONNECTED_MESSAGE =
  "VS Code is not connected to your account. Install the OmniRoute extension, " +
  "paste your pairing code into it, and open the folder you want me to work in. " +
  "Until then I cannot read or change your files.";


/** Where backups go. Previously they were written next to the original as
 *  `smart-backup-page.tsx`, which polluted the source tree and got picked up by
 *  tsconfig. They now live in one ignored folder at the workspace root. */
export const BACKUP_DIR = ".omniroute-backups";

/**
 * Where the UI-selected workspace override is persisted. Deliberately lives
 * next to the Next app itself (process.cwd() of the *server*, which never
 * changes) rather than inside whatever project is currently active — the
 * active project can be repointed at any time from the WorkspaceSelector, so
 * its own directory is not a stable place to remember the choice.
 */
const CONFIG_DIR = path.join(process.cwd(), ".omniroute");
const CONFIG_FILE = path.join(CONFIG_DIR, "workspace.json");

export interface DiscoveredProject {
  name: string;
  path: string;
  hasPackageJson: boolean;
}

/** Directories worth scanning for candidate projects, in priority order. */
function candidateScanRoots(): string[] {
  const home = os.homedir();
  const roots = new Set<string>([
    process.cwd(),
    path.dirname(process.cwd()),
    path.join(home, "source", "repos"), // common Windows dev layout
    path.join(home, "Documents", "GitHub"),
    path.join(home, "Documents", "Projects"),
    path.join(home, "Projects"),
    path.join(home, "dev"),
    path.join(home, "Dev"),
    path.join(home, "repos"),
    path.join(home, "code"),
    path.join(home, "Code"),
    path.join(home, "Desktop"),
    home,
  ]);
  return [...roots];
}

/** Directories that are never worth showing the model. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  ".netlify",
  ".cache",
  ".parcel-cache",
  ".svelte-kit",
  ".nuxt",
  "dist",
  "build",
  "out",
  "coverage",
  ".nyc_output",
  ".idea",
  ".vscode-test",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
  "env",
  ".pnpm-store",
  ".yarn",
  "bower_components",
  "vendor",
  "target",
  BACKUP_DIR,
  // The agent's own context files. Listing them would let the model spend
  // rounds reading its own scratch space instead of the project.
  ".omniroute",
]);

/** Binary and generated files: listing them only burns context. */
const IGNORED_FILE_EXT =
  /\.(?:png|jpe?g|jpg|gif|webp|avif|bmp|ico|icns|svg|mp4|mov|avi|webm|mp3|wav|ogg|flac|zip|tar|gz|tgz|bz2|xz|7z|rar|pdf|docx?|xlsx?|pptx?|woff2?|ttf|otf|eot|exe|dll|so|dylib|bin|dat|db|sqlite3?|pyc|class|jar|wasm|map|min\.js|min\.css|tsbuildinfo)$/i;

/** Lockfiles: huge, never edited by hand, never useful to the model. */
const IGNORED_FILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "poetry.lock",
  "Cargo.lock",
  "composer.lock",
  ".DS_Store",
  "Thumbs.db",
]);

/** Root-level files worth surfacing first in the snapshot. */
const PRIORITY_FILES = [
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "tailwind.config.ts",
  "tailwind.config.js",
  "postcss.config.mjs",
  "postcss.config.js",
  "eslint.config.mjs",
  "components.json",
  "README.md",
  "CLAUDE.md",
];

/**
 * Method names to probe for the workspace root. The extension is the user's own
 * code and its RPC vocabulary is unknown, so several spellings are tried once
 * and the outcome is cached. A total failure is fine — `fs` takes over.
 */
const ROOT_RPC_METHODS = [
  "get_workspace_root",
  "workspace_root",
  "get_workspace_info",
  "workspace_info",
  "get_workspace_folders",
  "list_workspace_folders",
];

/** Same idea for directory listing. */
const LIST_RPC_METHODS = [
  "list_files",
  "list_dir",
  "list_directory",
  "read_dir",
  "readdir",
  "glob_files",
];

/** A single read is capped so one 100 KB file cannot swallow the context. */
const MAX_READ_CHARS = 120_000;

/* ------------------------------ pure helpers ----------------------------- */

export interface WorkspaceEntry {
  /** always forward-slashed and relative to the workspace root */
  path: string;
  kind: "file" | "dir";
  bytes?: number;
}

export interface ListFilesResult {
  root: string;
  dir: string;
  entries: WorkspaceEntry[];
  fileCount: number;
  dirCount: number;
  /** true when a depth or entry cap stopped the walk before it ran out */
  truncated: boolean;
  source: "vscode-bridge" | "filesystem";
  hint?: string;
  error?: string;
}

export function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name) || (name.startsWith(".") && name !== ".github");
}

export function isIgnoredFile(name: string): boolean {
  if (IGNORED_FILE_NAMES.has(name)) return true;
  if (IGNORED_FILE_EXT.test(name)) return true;
  // Leftovers from the old backup scheme.
  if (name.startsWith("smart-backup-")) return true;
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------- line endings (the CRLF bug) -------------------- */

/**
 * THE BUG THIS SOLVES
 * -------------------
 * A run against a Windows-authored `app.py` burned an entire iteration budget
 * and produced no final answer. Its own narration gave it away: "get the exact
 * text with proper line endings", "copying the exact text with Windows line
 * endings". The file is CRLF. `read_file` returns the content with `\r\n`
 * intact, the model re-emits `old_text` through JSON with plain `\n`, and
 * `before.split(oldText)` therefore matched ZERO times — every round, forever.
 *
 * The model cannot fix this on its own: it has no way to see the difference
 * between `\n` and `\r\n` in its own output. So the matcher has to be tolerant
 * instead, while still writing back in the file's own style so a CRLF file does
 * not silently become mixed-ending.
 */

export type EolStyle = "crlf" | "lf" | "cr";

/** The dominant line ending in a piece of text. */
export function detectEol(text: string): EolStyle {
  const crlf = (text.match(/\r\n/g) || []).length;
  // Lone \n and lone \r, i.e. not part of a \r\n pair.
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  const cr = (text.match(/\r(?!\n)/g) || []).length;
  if (crlf >= lf && crlf >= cr && crlf > 0) return "crlf";
  if (cr > lf && cr > 0) return "cr";
  return "lf";
}

export function eolString(style: EolStyle): string {
  return style === "crlf" ? "\r\n" : style === "cr" ? "\r" : "\n";
}

/** Collapse every ending style to `\n` so two texts can be compared. */
export function normaliseEol(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Re-apply one ending style to LF-normalised text. */
export function applyEol(text: string, style: EolStyle): string {
  const lf = normaliseEol(text);
  return style === "lf" ? lf : lf.split("\n").join(eolString(style));
}

/** Strip trailing spaces/tabs from every line, keeping the line count. */
export function stripTrailingWs(text: string): string {
  return normaliseEol(text)
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n");
}

export interface SnippetMatch {
  /** Index into the ORIGINAL text where the match starts. */
  index: number;
  /** Length in the ORIGINAL text. */
  length: number;
}

/**
 * Find `needle` inside `haystack` under a given text transform.
 *
 * A transform that changes length (trailing-whitespace stripping) makes indices
 * from the transformed text meaningless in the original, so matches are located
 * by walking a line-offset table built from the untransformed text. Everything
 * is line-aligned in practice: a snippet copied out of `read_file` always
 * starts at a line boundary.
 */
function findByLines(
  haystack: string,
  needle: string,
  transform: (s: string) => string,
): SnippetMatch[] {
  const rawLines = haystack.split(/(?<=\n)/); // keep the terminators
  const offsets: number[] = [];
  let pos = 0;
  for (const line of rawLines) {
    offsets.push(pos);
    pos += line.length;
  }

  const tNeedleLines = transform(needle).split("\n");
  // A snippet ending with a newline yields a trailing "" — not a real line.
  if (tNeedleLines.length > 1 && tNeedleLines[tNeedleLines.length - 1] === "") {
    tNeedleLines.pop();
  }
  if (tNeedleLines.length === 0) return [];

  const tHayLines = rawLines.map((l) => transform(l.replace(/\r?\n$/, "")));

  const matches: SnippetMatch[] = [];

  for (let i = 0; i + tNeedleLines.length <= tHayLines.length; i++) {
    let ok = true;
    for (let j = 0; j < tNeedleLines.length; j++) {
      if (tHayLines[i + j] !== tNeedleLines[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const start = offsets[i];
    const lastIdx = i + tNeedleLines.length - 1;
    // Include the final line's own terminator only if the needle had one.
    const needleEndsWithNewline = /\r?\n$/.test(needle);
    const lastLine = rawLines[lastIdx];
    const lastLineBody = lastLine.replace(/\r?\n$/, "");
    const end =
      offsets[lastIdx] +
      (needleEndsWithNewline ? lastLine.length : lastLineBody.length);

    matches.push({ index: start, length: end - start });
  }

  return matches;
}

export type MatchStrategy =
  | "exact"
  | "line-endings"
  | "trailing-whitespace"
  | "none";

export interface SnippetLocation {
  strategy: MatchStrategy;
  matches: SnippetMatch[];
}

/**
 * Locate a snippet using progressively more forgiving comparisons, stopping at
 * the first strategy that finds anything. Order matters: an exact match must
 * never be overridden by a fuzzy one.
 */
export function locateSnippet(
  haystack: string,
  needle: string,
): SnippetLocation {
  // 1. Exact — the fast path, and the only one that needs no line alignment.
  const exact: SnippetMatch[] = [];
  if (needle.length > 0) {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      exact.push({ index: at, length: needle.length });
      from = at + Math.max(1, needle.length);
    }
  }
  if (exact.length > 0) return { strategy: "exact", matches: exact };

  // 2. Same text, different line endings. This is the CRLF case.
  const eolMatches = findByLines(haystack, needle, normaliseEol);
  if (eolMatches.length > 0) {
    return { strategy: "line-endings", matches: eolMatches };
  }

  // 3. Same text modulo trailing whitespace, which editors add and remove
  //    invisibly and which no model can reproduce reliably.
  const wsMatches = findByLines(haystack, needle, stripTrailingWs);
  if (wsMatches.length > 0) {
    return { strategy: "trailing-whitespace", matches: wsMatches };
  }

  return { strategy: "none", matches: [] };
}

/** Splice a replacement into `text` at the given match. */
export function spliceAt(
  text: string,
  match: SnippetMatch,
  replacement: string,
): string {
  return (
    text.slice(0, match.index) +
    replacement +
    text.slice(match.index + match.length)
  );
}

/**
 * Build a path matcher. A pattern containing `*` or `?` is treated as a glob
 * over the whole relative path; anything else is a case-insensitive substring
 * test, so `pattern: ".tsx"` and `pattern: "page"` both do the obvious thing.
 */
export function makeMatcher(pattern?: string): (rel: string) => boolean {
  const p = (pattern || "").trim().toLowerCase();
  if (!p) return () => true;

  if (p.includes("*") || p.includes("?")) {
    const source = p
      .split("")
      .map((ch) =>
        ch === "*" ? "[\\s\\S]*" : ch === "?" ? "." : escapeRegExp(ch),
      )
      .join("");
    let rx: RegExp;
    try {
      rx = new RegExp(`^${source}$`, "i");
    } catch {
      return (rel) => rel.toLowerCase().includes(p);
    }
    // Match the basename too, so "*.tsx" works without a leading "**/".
    return (rel) => {
      const lower = rel.toLowerCase();
      return rx.test(lower) || rx.test(lower.split("/").pop() || lower);
    };
  }

  return (rel) => rel.toLowerCase().includes(p);
}

export interface WalkOptions {
  /** how many directory levels below `relDir` to descend; 1 = children only */
  depth?: number;
  maxEntries?: number;
  pattern?: string;
  includeDirs?: boolean;
}

/**
 * Breadth-first walk, so a shallow-but-wide project still yields a useful
 * listing when the entry cap is hit. Never throws: an unreadable directory is
 * skipped rather than aborting the whole listing.
 */
export async function walkWorkspace(
  root: string,
  relDir: string,
  options: WalkOptions = {},
): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
  const depth = Math.max(1, Math.min(12, options.depth ?? 3));
  const maxEntries = Math.max(1, Math.min(4000, options.maxEntries ?? 400));
  const includeDirs = options.includeDirs === true;
  const matches = makeMatcher(options.pattern);

  const entries: WorkspaceEntry[] = [];
  let truncated = false;

  const start = relDir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const queue: Array<{ rel: string; level: number }> = [
    { rel: start, level: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;

    // A directory at the depth limit is not enumerated; say so honestly.
    if (current.level >= depth) {
      truncated = true;
      continue;
    }

    // No explicit Dirent annotation: its generic parameter differs between
    // @types/node versions and this project has no compiler run available.
    const dirents = await fsp
      .readdir(path.join(root, current.rel), { withFileTypes: true })
      .catch(() => null);
    if (!dirents) continue;

    dirents.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });

    for (const dirent of dirents) {
      const rel = current.rel ? `${current.rel}/${dirent.name}` : dirent.name;

      if (dirent.isDirectory()) {
        if (isIgnoredDir(dirent.name)) continue;
        if (includeDirs && matches(rel)) {
          if (entries.length >= maxEntries) truncated = true;
          else entries.push({ path: rel, kind: "dir" });
        }
        queue.push({ rel, level: current.level + 1 });
        continue;
      }

      if (!dirent.isFile()) continue;
      if (isIgnoredFile(dirent.name)) continue;
      if (!matches(rel)) continue;

      if (entries.length >= maxEntries) {
        truncated = true;
        continue;
      }

      let bytes: number | undefined;
      try {
        bytes = (await fsp.stat(path.join(root, rel))).size;
      } catch {
        bytes = undefined;
      }
      entries.push({ path: rel, kind: "file", bytes });
    }
  }

  return { entries, truncated };
}

/** Order a listing so root config files and `src/` come first. */
export function prioritiseEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  const rank = (e: WorkspaceEntry): number => {
    if (PRIORITY_FILES.includes(e.path)) return 0;
    if (!e.path.includes("/")) return 1;
    if (e.path.startsWith("src/") || e.path.startsWith("app/")) return 2;
    if (e.path.startsWith("lib/") || e.path.startsWith("components/")) return 3;
    return 4;
  };
  return [...entries].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.path.localeCompare(b.path);
  });
}

function isLocalhostAddress(addr: string): boolean {
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.toLowerCase() === "localhost"
  );
}

/* ------------------------- upgrade authentication ------------------------ */

/** What `verifyUpgrade` proved about a connection, read back on `connection`. */
interface UpgradeIdentity {
  /** null means the unauthenticated local session — only possible off-server. */
  userId: string | null;
  tokenId: string | null;
}

/**
 * `IncomingMessage` with the field the handshake attaches.
 *
 * `ws` gives the same request object to `verifyClient` and to the `connection`
 * handler, which is the only channel between them — there is no per-connection
 * bag to put things in. Declaring the shape here keeps that from being an
 * `any` cast in two places that could drift apart.
 */
type AuthenticatedUpgrade = IncomingMessage & {
  omniIdentity?: UpgradeIdentity;
};

/**
 * Pull the pairing token out of an upgrade request.
 *
 * Order matters: header, then subprotocol, then query string — least likely to
 * be logged first. See `verifyUpgrade` for why the query string is accepted at
 * all despite ending up in Caddy's access log.
 */
function readUpgradeToken(req: IncomingMessage, url: URL): string | null {
  const authHeader = req.headers["authorization"];
  const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const bearer = /^bearer\s+(.+)$/i.exec((auth || "").trim());
  if (bearer?.[1]) return bearer[1].trim();

  /* `Sec-WebSocket-Protocol: omniroute, omr_pair_…` — a comma-separated list,
   * of which the second entry is the credential. The server does not echo a
   * chosen subprotocol back, and the extension does not require one. */
  const protoHeader = req.headers["sec-websocket-protocol"];
  const proto = Array.isArray(protoHeader)
    ? protoHeader.join(",")
    : protoHeader;
  if (proto) {
    const parts = proto
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const carried = parts.find((p) => p.startsWith("omr_pair_"));
    if (carried) return carried;
  }

  const query = url.searchParams.get("token");
  return query?.trim() || null;
}


/**
 * Turn a `file://` URI into a plain path.
 * Naive `.replace(/^file:\/\/\/?/, "")` eats the leading slash of a POSIX path
 * (`file:///home/u` -> `home/u`, a relative path pointing nowhere), so the
 * drive-letter case is handled separately.
 */
export function stripFileUri(raw: string): string {
  const trimmed = raw.trim();
  if (!/^file:\/\//i.test(trimmed)) return trimmed;
  let p = trimmed.replace(/^file:\/\//i, "");
  try {
    p = decodeURIComponent(p);
  } catch {
    /* leave percent-escapes as-is rather than throwing */
  }
  // "/c:/Users/x" -> "c:/Users/x", but "/home/u" keeps its slash.
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  return p;
}

/**
 * Pull a directory path out of whatever shape the extension replies with.
 *
 * This has to cope with VS Code's own `workspace.workspaceFolders`, i.e.
 * `[{ uri: { fsPath, path, scheme }, name, index }]` — the most likely reply to
 * the `get_workspace_folders` probe. An earlier version only looked for
 * *string*-valued `uri` keys and so failed on exactly that shape.
 */
export function rootFromRpcResult(result: any, hops = 0): string {
  if (!result || hops > 6) return "";
  if (typeof result === "string") return stripFileUri(result);
  if (Array.isArray(result)) {
    for (const item of result) {
      const found = rootFromRpcResult(item, hops + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof result === "object") {
    // Direct string-valued keys.
    for (const key of [
      "root",
      "rootPath",
      "workspaceRoot",
      "workspacePath",
      "path",
      "fsPath",
      "dir",
      "cwd",
      "uri",
      "folder",
      "workspace",
    ]) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return stripFileUri(value);
    }
    // Object- or array-valued keys worth descending into.
    for (const key of [
      "uri",
      "folder",
      "workspaceFolder",
      "workspace",
      "folders",
      "workspaceFolders",
      "result",
      "data",
      "info",
    ]) {
      const nested = (result as Record<string, unknown>)[key];
      if (nested && typeof nested === "object") {
        const found = rootFromRpcResult(nested, hops + 1);
        if (found) return found;
      }
    }
  }
  return "";
}

/**
 * True if any segment of a relative path is an ignored directory, or the final
 * segment is an ignored file. Checking only the basename let a recursive
 * bridge listing (`glob_files` would return one) push the whole of
 * node_modules into the prompt, because `index.js` is not itself ignorable.
 */
export function isIgnoredRelPath(rel: string, kind: "file" | "dir"): boolean {
  const segments = rel.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  const dirSegments = kind === "dir" ? segments : segments.slice(0, -1);
  for (const seg of dirSegments) {
    if (isIgnoredDir(seg)) return true;
  }
  if (kind === "file") return isIgnoredFile(segments[segments.length - 1]);
  return false;
}

/** Normalise a bridge listing reply into WorkspaceEntry[]. */
export function entriesFromRpcResult(
  result: any,
  dir: string,
): WorkspaceEntry[] {
  const list: any[] = Array.isArray(result)
    ? result
    : Array.isArray(result?.entries)
      ? result.entries
      : Array.isArray(result?.files)
        ? result.files
        : Array.isArray(result?.result)
          ? result.result
          : [];

  const cleanDir = dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const prefix = cleanDir ? `${cleanDir}/` : "";

  /** A bridge asked to list `src/app` may answer with bare basenames. Those
   *  must be re-anchored, or the model's next read_file uses a path that does
   *  not exist relative to the workspace root. */
  const applyPrefix = (rel: string): string =>
    !prefix || rel.startsWith(prefix) ? rel : `${prefix}${rel}`;

  return list
    .map((item): WorkspaceEntry | null => {
      if (typeof item === "string") {
        const cleaned = item.replace(/\\/g, "/").replace(/^\.\//, "");
        if (!cleaned) return null;
        const looksLikeDir = cleaned.endsWith("/");
        const rel = applyPrefix(cleaned.replace(/\/+$/, ""));
        if (!rel) return null;
        return {
          path: rel,
          kind: looksLikeDir || !/\.[a-z0-9]+$/i.test(rel) ? "dir" : "file",
        };
      }
      if (item && typeof item === "object") {
        const raw =
          item.path ??
          item.relativePath ??
          item.name ??
          item.file ??
          item.fsPath;
        if (typeof raw !== "string" || !raw) return null;
        const cleaned = raw.replace(/\\/g, "/").replace(/^\.\//, "");
        if (!cleaned) return null;
        const isDir =
          item.kind === "dir" ||
          item.type === "dir" ||
          item.type === "directory" ||
          item.isDirectory === true ||
          cleaned.endsWith("/");
        const rel = applyPrefix(cleaned.replace(/\/+$/, ""));
        if (!rel) return null;
        return {
          path: rel,
          kind: isDir ? "dir" : "file",
          bytes: typeof item.size === "number" ? item.size : undefined,
        };
      }
      return null;
    })
    .filter((e): e is WorkspaceEntry => e !== null)
    .filter((e) => !isIgnoredRelPath(e.path, e.kind));
}

/* ------------------------------- the bridge ------------------------------ */

/** One pending RPC, waiting for the editor to answer. */
interface PendingRequest {
  resolve: (val: any) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * One entry in a session's recent-activity ring.
 *
 * WHY THE BRIDGE KEEPS THIS AT ALL
 *
 * Handing a program on someone else's server read and write access to your
 * source tree is a large thing to agree to, and until now it was also an
 * invisible one: the file operations happened inside a chat turn, and the only
 * evidence afterwards was the diff. "Trust me" is not a security model. This
 * ring is the audit trail — every RPC this account's editor was asked to
 * perform, whether it succeeded, and how long it took — and it is what the
 * Connect-editor panel renders live.
 *
 * WHAT IS DELIBERATELY NOT IN IT
 *
 * File *contents*. Not the bytes read, not the bytes written, not the text
 * being replaced. A path is enough to answer "what is it touching?", and
 * keeping contents would turn a diagnostic aid into a second copy of the user's
 * code sitting in the server's heap for as long as the socket lives — exactly
 * the thing this architecture promises not to do.
 *
 * It is in memory only and dies with the process. That is the right lifetime
 * for something whose entire purpose is to describe the current session; a
 * durable audit log is a different feature with different storage and retention
 * questions, and pretending this is one would be worse than not having it.
 */
export interface BridgeActivity {
  /** Monotonic within a session, so a client can poll for "anything after N". */
  seq: number;
  /** ms since epoch, when the request was sent. */
  at: number;
  /** RPC method name, e.g. "read_file". */
  method: string;
  /** The path or pattern it names, truncated. Never file contents. */
  target: string | null;
  state: "pending" | "ok" | "error" | "timeout";
  /** Round trip in ms, once settled. */
  ms: number | null;
  /** Failure reason, truncated. Null while pending or on success. */
  detail: string | null;
}

/** How many RPCs of history a session keeps. */
const ACTIVITY_LIMIT = 60;

/**
 * The most identifying string in an RPC's parameters, for display.
 *
 * Reads only keys that name a *location* — never `content`, `new_text` or
 * anything else carrying the user's code — and truncates, because a generated
 * glob or a long path should not be able to distort the panel's layout or the
 * size of the status response.
 */
function describeTarget(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const bag = params as Record<string, unknown>;
  for (const key of ["path", "filePath", "file_path", "pattern", "directory", "dir", "query"]) {
    const value = bag[key];
    if (typeof value === "string" && value.trim()) {
      const clean = value.trim().replace(/[\r\n\t]+/g, " ");
      return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
    }
  }
  return null;
}

/**
 * One connected editor.
 *
 * WHY THIS IS A TYPE AND NOT SIX MORE FIELDS ON THE MANAGER
 *
 * It was six fields on the manager — `activeSocket`, `pendingRequests`,
 * `cachedRoot`, `rootSource`, `rootProbedForSocket`, `listMethod` — and every
 * one of them was global. With one editor that is simply the state of the
 * bridge. With two it is a collision:
 *
 *   - `this.activeSocket = ws` on connect, and the line above it closed the
 *     previous socket with "Replaced by newer connection". The second beta
 *     tester to open VS Code silently disconnected the first.
 *   - `cachedRoot` held one path. Even without the disconnection, user B's
 *     file operations would have resolved against user A's workspace root.
 *   - `pendingRequests` was keyed by an id of the form
 *     `rpc_<Date.now()>_<5 random chars>`, shared between everyone. A reply
 *     from any socket could settle a request made for any other.
 *
 * Grouping the per-connection state into one object makes the multi-user case
 * the only case: there is no shared field left to collide over, and the type
 * system stops anyone reintroducing one by accident.
 */
interface BridgeSession {
  ws: WebSocket;
  /** Owner key — `user:<id>`, or LOCAL_OWNER for an unauthenticated local editor. */
  owner: string;
  /** The account id, or null for the local development session. */
  userId: string | null;
  /** Which pairing token was used, so it can be named in the UI and revoked. */
  tokenId: string | null;
  remote: string;
  connectedAt: number;
  /** Requests sent to THIS editor, awaiting THIS editor's reply. */
  pending: Map<string, PendingRequest>;
  /** Workspace root as reported by this editor. */
  cachedRoot: string | null;
  rootSource: "override" | "vscode-bridge" | "env" | "cwd";
  /** Whether the root probe has already run for this connection. */
  rootProbed: boolean;
  /** Which listing RPC this editor speaks: a name, null for none, undefined for untried. */
  listMethod: string | null | undefined;
  /** Newest-last ring of recent RPCs, capped at ACTIVITY_LIMIT. */
  activity: BridgeActivity[];
  /** Next `seq` to hand out. */
  activitySeq: number;
}

class VSCodeBridgeManager {
  private wss: WebSocketServer | null = null;

  /* Set only from the server's own "listening" event, never from the fact that
   * we called `new WebSocketServer(...)`.
   *
   * The two are genuinely different. The constructor returns immediately and
   * binds on a later tick, so a manager that has a `wss` may still be a manager
   * whose port was taken by someone else — the EADDRINUSE arrives afterwards.
   * Reporting "ready" from the constructor is what let the UI claim the bridge
   * was fine while nothing was bound. */
  private listening = false;

  /** One live editor per account. Keyed by owner key, never by socket. */
  private sessions = new Map<string, BridgeSession>();

  /**
   * Root state for the single-user case, where there may be no editor at all
   * and the root still has to come from somewhere (an override, an env var, or
   * cwd). A connected session keeps its own copy of these on the session
   * object; this is only consulted when `MULTI_TENANT` is false.
   */
  private cachedRoot: string | null = null;
  private rootSource: "override" | "vscode-bridge" | "env" | "cwd" = "cwd";
  private listMethod: string | null | undefined = undefined;

  /** The directory explicitly chosen from the UI. Takes priority over every
   *  other discovery method once set, and is persisted so it survives a
   *  server restart — that persistence is the actual fix for "the workspace
   *  doesn't change dynamically": before this, there was nowhere to write
   *  a UI selection to, so `workspaceRoot()` always re-derived the same
   *  answer no matter what the WorkspaceSelector did.
   *
   *  Single-user only. It names a directory on the SERVER's disk, which in a
   *  multi-tenant deployment belongs to the operator and to nobody who is
   *  signed in — so `workspaceRoot()` ignores it entirely when MULTI_TENANT is
   *  set, and `setWorkspaceOverride()` refuses to set it. */
  private overrideRoot: string | null = null;
  private overrideLoaded = false;


  /**
   * Start listening for the VS Code extension.
   *
   * WHAT THE AUTHORISATION MODEL USED TO BE, AND WHY IT HAD TO CHANGE
   *
   * It was the peer's address: `isLocalhostAddress(req.socket.remoteAddress)`,
   * and nothing else. On a laptop that is a sound proxy for "this is my own
   * editor" — nothing else can open a TCP connection from 127.0.0.1.
   *
   * It stops being sound the moment anything proxies the port. A
   * `handle /vscode-bridge* { reverse_proxy 127.0.0.1:20129 }` block makes
   * every connection arrive from the proxy, so the check passes for the entire
   * internet, and what sits behind it reads and writes files. That is not a
   * weakness in the check; it is the check being asked a question it cannot
   * answer once there is a hop in between.
   *
   * So the address is no longer consulted for authorisation. Every connection
   * presents a pairing token, the token resolves to exactly one account, and
   * that account is the only workspace the session can ever touch. The
   * remaining defences are:
   *
   *   1. A token, verified at the handshake (`verifyUpgrade`), that maps to a
   *      real user and can be revoked from the UI at any time.
   *   2. In production the listener refuses to start unless
   *      OMNIROUTE_BRIDGE_ENABLE=true is set deliberately.
   *   3. The bind address (OMNIROUTE_BRIDGE_HOST, default 127.0.0.1) still
   *      decides who can reach the port at all. In Docker it must be 0.0.0.0
   *      to be reachable from the host at all, and the published port is bound
   *      to the host's loopback so only Caddy can dial it.
   *   4. With MULTI_TENANT set, a session that has no editor cannot fall back
   *      to the server's own disk — see the flag's own comment.
   *
   * NOTE ON WHAT CALLS THIS: the module self-starts. The bottom of this file
   * calls `vscodeBridge.initialize()` at import time under
   * `typeof window === "undefined"`, and `src/app/api/chat/route.ts` imports
   * WORKSPACE_TOOLS from here — so the side effect runs on every server boot,
   * not only when someone reaches for the bridge. Defence 2 is what holds the
   * port shut in production; there is no second line of "nothing calls it
   * anyway" behind it. An earlier revision of this comment claimed nothing
   * called this method; that was wrong, and the claim had been copied into
   * productionGuard.ts and the env template from here.
   */
  public initialize(port = BRIDGE_PORT) {
    if (typeof window !== "undefined" || this.wss) return;

    if (IS_PRODUCTION && !BRIDGE_ENABLED_IN_PRODUCTION) {
      console.warn(
        "[VSCodeBridge] Not starting: this is a production build and " +
          "OMNIROUTE_BRIDGE_ENABLE is not set. Nobody will be able to connect " +
          "their editor until it is.",
      );
      return;
    }

    try {
      this.wss = new WebSocketServer({
        port,
        host: BRIDGE_HOST,
        /* The handshake is where authorisation happens, because it is the last
         * moment at which a refusal can still be an HTTP status the client can
         * read. Rejecting after the upgrade means closing an established
         * WebSocket, and the extension sees "connection closed" with no way to
         * tell a bad token from a network blip — so it retries forever with a
         * token that will never work. */
        verifyClient: (
          info: { origin: string; secure: boolean; req: IncomingMessage },
          done: (ok: boolean, code?: number, message?: string) => void,
        ) => this.verifyUpgrade(info.req, done),
      });

      this.wss.on("listening", () => {
        this.listening = true;
        console.log(
          `[VSCodeBridge] Listening on ${BRIDGE_HOST}:${port}` +
            (MULTI_TENANT ? " (multi-tenant, token required)." : " (single-user)."),
        );
      });

      this.wss.on("close", () => {
        this.listening = false;
      });

      this.wss.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;

        if (code === "EADDRINUSE") {
          /* Something else already holds the port, and for a long time that
           * something else was US.
           *
           * The manager used to be a bare `new VSCodeBridgeManager()` at module
           * scope. Next.js re-evaluates modules on every hot reload, so each
           * reload built a second manager, and the second one lost this race —
           * silently, because this handler only warned. The live socket stayed
           * on the orphaned first instance while every API route asked the new,
           * session-less one whether an editor was connected. It always said
           * no. The panel showed "Connect VS Code" next to an extension that
           * was, in fact, connected.
           *
           * The manager is pinned to globalThis at the bottom of this file now,
           * so a reload reuses the instance that already owns the port and this
           * branch stops firing for that reason. If it still fires, the port is
           * genuinely held by another process — a second dev server, a leftover
           * `next start`, or a container publishing the same port. */
          this.listening = false;
          /* A dead server must not be left in the field: `initialize()` treats a
           * non-null `wss` as "already started" and would refuse to ever retry. */
          this.wss = null;
          console.error(
            `[VSCodeBridge] Port ${BRIDGE_HOST}:${port} is already in use, so the ` +
              "editor bridge is OFF. Another process is holding it — most likely a " +
              "second copy of this server. Stop it, or set OMNIROUTE_BRIDGE_PORT to " +
              "a free port and repair the extension.",
          );
          return;
        }

        console.warn("[VSCodeBridge] WebSocket Server error:", err.message);
      });

      this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
        /* `verifyUpgrade` already ran and stashed the result; reaching here
         * without one would mean the handshake path changed underneath us, so
         * treat it as a refusal rather than as the local case. */
        const identity = (req as AuthenticatedUpgrade).omniIdentity;
        if (!identity) {
          ws.close(4001, "Unauthorised.");
          return;
        }

        const owner = ownerKeyFor(identity.userId);

        /* Replacing a session only ever affects the SAME account — reopening
         * VS Code, or a stale socket the network dropped without telling us.
         * It can no longer disconnect a different person, which is what the
         * single global socket did. */
        const existing = this.sessions.get(owner);
        if (existing && existing.ws !== ws) {
          this.closeSession(existing, "Replaced by a newer connection.");
        }

        const session: BridgeSession = {
          ws,
          owner,
          userId: identity.userId,
          tokenId: identity.tokenId,
          remote: req.socket.remoteAddress || "",
          connectedAt: Date.now(),
          pending: new Map(),
          cachedRoot: null,
          rootSource: "vscode-bridge",
          rootProbed: false,
          listMethod: undefined,
          activity: [],
          activitySeq: 1,
        };
        this.sessions.set(owner, session);

        console.log(
          `[VSCodeBridge] Editor connected for ${identity.userId ? `user ${identity.userId}` : "the local session"}.`,
        );

        /* Send this account's exclusion rules before anything else can ask for
         * a file. Not awaited: the connection handler must return so the
         * socket starts reading, and the extension is already enforcing the
         * full default set until this lands — so the gap is stricter than the
         * steady state, never looser. */
        void this.pushExclusions(session);

        /* And which folder, if any, is the read-only reference project.
         *
         * Order matters between these two only in the sense that both must
         * happen before a tool call does. Neither is awaited, for the reason
         * above; and a reference root that has not landed yet fails closed —
         * the extension answers "no reference project is configured", which is
         * a refusal, never a read of the wrong folder. */
        void this.pushReferenceRoot(session);

        ws.on("message", (data: RawData) => {
          this.handleMessage(session, data.toString());
        });

        ws.on("close", () => {
          if (this.sessions.get(owner) === session) {
            this.sessions.delete(owner);
          }
          this.clearPending(session, "VS Code extension connection closed.");
        });

        ws.on("error", (err) => {
          console.warn("[VSCodeBridge] Socket error:", err.message);
        });
      });
    } catch (err) {
      console.warn("[VSCodeBridge] Failed to bind server:", err);
    }
  }

  /**
   * Decide whether one upgrade request may become a bridge session.
   *
   * WHAT REPLACED WHAT
   *
   * This used to be, in the connection handler:
   *
   *     if (!isLocalhostAddress(req.socket.remoteAddress)) ws.close(...)
   *
   * On a laptop that check is genuinely meaningful. Behind Caddy it is worse
   * than meaningless: every proxied connection arrives FROM the proxy, so the
   * peer address is 127.0.0.1 for the whole internet and the check passes for
   * everyone. The thing it was protecting — a filesystem RPC — would have been
   * open to anyone who found the path.
   *
   * So the token is the gate now, and the peer address is not consulted at all.
   *
   * WHERE THE TOKEN COMES FROM
   *
   * Three transports are accepted, in order of preference:
   *
   *   1. `Authorization: Bearer <token>`. The right place for a credential.
   *   2. `Sec-WebSocket-Protocol: omniroute, <token>`. The browser WebSocket
   *      API cannot set headers, so this is the standard workaround; the
   *      extension does not need it, but anything else that pairs later will.
   *   3. `?token=` on the query string. Last resort, and the reason it is last:
   *      query strings land in access logs. Caddy's default log format records
   *      the URI, so a token presented this way ends up on disk in cleartext.
   *      Accepted because it is the only option for some clients, and logged
   *      about so it is not chosen by accident.
   *
   * The path is checked too. Caddy is configured to forward only
   * `/vscode-bridge`, so a request arriving on any other path means either a
   * misconfiguration or someone probing the port directly — neither is a
   * session worth opening.
   */
  private verifyUpgrade(
    req: IncomingMessage,
    done: (ok: boolean, code?: number, message?: string) => void,
  ): void {
    let url: URL;
    try {
      url = new URL(req.url || "/", "http://bridge.local");
    } catch {
      done(false, 400, "Bad request.");
      return;
    }

    if (url.pathname !== "/" && url.pathname !== BRIDGE_WS_PATH) {
      done(false, 404, "Not found.");
      return;
    }

    const token = readUpgradeToken(req, url);

    if (!token) {
      /* No token. On a laptop that is the historical, expected case — the
       * extension predates pairing entirely — so the loopback check earns its
       * keep as a local convenience. On a server it is simply a refusal. */
      if (MULTI_TENANT) {
        done(false, 401, "A pairing code is required.");
        return;
      }
      if (!isLocalhostAddress(req.socket.remoteAddress || "")) {
        done(false, 403, "Connections must come from this machine.");
        return;
      }
      (req as AuthenticatedUpgrade).omniIdentity = {
        userId: null,
        tokenId: null,
      };
      done(true);
      return;
    }

    const resolved = resolveExtensionToken(token);
    if (!resolved) {
      /* One message for unknown, revoked, expired and malformed. Telling them
       * apart would let someone probing the endpoint learn whether a guess had
       * ever been a real token. */
      done(false, 401, "That pairing code is not valid.");
      return;
    }

    (req as AuthenticatedUpgrade).omniIdentity = {
      userId: resolved.userId,
      tokenId: resolved.tokenId,
    };
    done(true);
  }


  /* ---------------------------- session lookup -------------------------- */

  /** The live session for the account this call belongs to, if any. */
  private session(): BridgeSession | null {
    const session = this.sessions.get(currentOwner());
    if (!session) return null;
    if (session.ws.readyState !== WebSocket.OPEN) return null;
    return session;
  }

  /** Reject everything this session was waiting on. */
  private clearPending(session: BridgeSession, reason: string): void {
    for (const [, pending] of session.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    session.pending.clear();
  }

  private closeSession(session: BridgeSession, reason: string): void {
    this.clearPending(session, reason);
    try {
      session.ws.close(1000, reason);
    } catch {
      /* Already gone. */
    }
  }

  /** Whether the account this call belongs to has an editor attached. */
  public isConnected(): boolean {
    return this.session() !== null;
  }

  /**
   * Who is connected right now, for the status panel.
   *
   * Scoped to the calling account deliberately: "somebody's editor is
   * connected" is not information one user should have about another, and a
   * count would leak how many people are using the beta.
   */
  /**
   * Whether the bridge port is actually bound right now.
   *
   * Distinct from `bridgeConfigured()`, which only answers "was this deployment
   * *allowed* to open the bridge". Configuration and reality disagree in both
   * directions and the two failures need different advice: an operator who
   * never set OMNIROUTE_BRIDGE_ENABLE has to edit an env file and restart,
   * whereas an operator whose port was taken has to find the other process. The
   * UI could not tell those apart while it only had the configuration flag, so
   * both appeared as one red pill that named only the first cause.
   */
  public isListening(): boolean {
    return this.listening;
  }

  public connectionInfo(): {
    connected: boolean;
    since: number | null;
    tokenId: string | null;
    root: string | null;
  } {
    const session = this.session();
    if (!session) {
      return { connected: false, since: null, tokenId: null, root: null };
    }
    return {
      connected: true,
      since: session.connectedAt,
      tokenId: session.tokenId,
      root: session.cachedRoot,
    };
  }

  /** Drop the editor attached to one account. Used when its token is revoked. */
  public disconnectOwner(userId: string | null, reason: string): boolean {
    const session = this.sessions.get(ownerKeyFor(userId));
    if (!session) return false;
    this.sessions.delete(ownerKeyFor(userId));
    this.closeSession(session, reason);
    return true;
  }

  /* -----------------------------------------------------------------------
   * Exclusion rules, pushed to the editor
   * -------------------------------------------------------------------- */

  /**
   * Send this account's file-exclusion rules to its connected editor.
   *
   * WHY THE EDITOR NEEDS THEM AT ALL
   *
   * The server already refuses excluded paths at the tool dispatcher, so this
   * is not what makes the feature work — it is what makes it hold. The
   * extension is the process with the file handle, and it used to carry its
   * own hardcoded denylist that nobody could change and that disagreed with
   * the server's. Replacing that list with the user's real rules means both
   * ends reach the same verdict from the same compiled patterns, and a path
   * that somehow skips the dispatcher still does not open.
   *
   * WHY FAILURE IS LOGGED AND SWALLOWED
   *
   * A push that does not land leaves the extension on DEFAULT_MATCHER, which
   * enforces the credential floor and every recommended group. That is a
   * stricter state than the user asked for, not a looser one, so it is not
   * worth failing a connection or a settings save over. The asymmetry is the
   * whole reason the extension's fallback is the full default set rather than
   * an empty one.
   */
  private async pushExclusions(session: BridgeSession): Promise<boolean> {
    try {
      const config = getExclusionConfig(session.userId || "");
      await this.callToolOn(
        session,
        "set_exclusions",
        {
          config: {
            patterns: config.patterns,
            disabledGroups: config.disabledGroups,
            updatedAt: config.updatedAt,
          },
        },
        8000,
      );
      return true;
    } catch (err) {
      /* An older extension answers "Unsupported message action: set_exclusions".
       * That is a real and expected state — the user has not reinstalled yet —
       * so it gets a sentence that names the fix rather than a stack trace. */
      const message = err instanceof Error ? err.message : String(err);
      if (/unsupported message action/i.test(message)) {
        console.warn(
          "[VSCodeBridge] The connected extension is too old to receive file-exclusion " +
            "rules, so it is enforcing the built-in defaults instead of this user's " +
            "settings. The server still enforces the real rules. Reinstall the " +
            "extension from Settings -> Connect VS Code to bring the two in step.",
        );
      } else {
        console.warn(`[VSCodeBridge] Could not push exclusion rules: ${message}`);
      }
      return false;
    }
  }

  /**
   * Re-push after a settings save. Returns false when nothing is connected,
   * which is ordinary rather than an error.
   */
  public async refreshExclusions(userId: string | null): Promise<boolean> {
    const session = this.sessions.get(ownerKeyFor(userId));
    if (!session || session.ws.readyState !== WebSocket.OPEN) return false;
    return this.pushExclusions(session);
  }

  /* -----------------------------------------------------------------------
   * The reference project, pushed to the editor
   * -------------------------------------------------------------------- */

  /**
   * Tell the editor which folder is the read-only reference, or that there
   * isn't one.
   *
   * WHY THE ROOT IS PUSHED INSTEAD OF SENT WITH EACH CALL
   *
   * The obvious design is to put the folder in the parameters of every
   * reference read — `ref_read_file({ root, path })`. That design makes the
   * server able to name any folder it likes at the moment of the read, which
   * means a bug anywhere in the request path becomes "the agent read a folder
   * the user never offered". Pushing it once makes the editor's reference root
   * a piece of state the editor owns: the reads carry no root at all, and the
   * only way to change which folder they reach is this one message, which the
   * extension refuses unless the user has already approved that folder in VS
   * Code. The blast radius of every other bug shrinks to "wrong file inside a
   * folder the user chose".
   *
   * It is also what stops the reference folder being writable. The extension
   * resolves writes through the *consented* root and explicitly skips the
   * reference, so the same message that opens project 1 for reading is what
   * closes it for writing.
   */
  private async pushReferenceRoot(session: BridgeSession): Promise<boolean> {
    try {
      const reference = activeReferenceProject(session.userId || "");
      await this.callToolOn(
        session,
        "set_reference_root",
        {
          path: reference?.path ?? null,
          name: reference?.name ?? null,
        },
        8000,
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/unsupported message action/i.test(message)) {
        console.warn(
          "[VSCodeBridge] The connected extension is too old to open a reference " +
            "project. Reinstall it from Settings -> Connect VS Code. Until then " +
            "the reference tools refuse, which is the correct outcome — nothing " +
            "silently reads the wrong folder.",
        );
      } else {
        console.warn(`[VSCodeBridge] Could not push the reference root: ${message}`);
      }
      return false;
    }
  }

  /** Re-push after the reference project is changed in the settings panel. */
  public async refreshReferenceRoot(userId: string | null): Promise<boolean> {
    const session = this.sessions.get(ownerKeyFor(userId));
    if (!session || session.ws.readyState !== WebSocket.OPEN) return false;
    return this.pushReferenceRoot(session);
  }

  /**
   * The folders this account's editor has approved, for the settings picker.
   *
   * Only granted folders come back — the extension decides that, not this
   * process — so an account with one approved folder cannot use this to
   * enumerate the rest of the machine. An editor that is not connected, or one
   * too old to answer, yields an empty list rather than an error: "no folders
   * to choose from" is a state the panel has to render anyway.
   */
  public async grantedFolders(): Promise<{ path: string; name: string }[]> {
    const session = this.session();
    if (!session) return [];
    try {
      const result = await this.callTool<any>("get_workspace_folders", {}, 5000);
      const raw = Array.isArray(result?.folders)
        ? result.folders
        : Array.isArray(result)
          ? result
          : [];
      return raw
        .map((entry: any) => {
          const folderPath = String(
            entry?.path ?? entry?.fsPath ?? entry?.uri ?? entry ?? "",
          ).trim();
          if (!folderPath) return null;
          const name =
            String(entry?.name ?? "").trim() ||
            folderPath.split(/[\\/]+/).filter(Boolean).pop() ||
            folderPath;
          return { path: stripFileUri(folderPath), name };
        })
        .filter((entry: { path: string; name: string } | null): entry is {
          path: string;
          name: string;
        } => entry !== null);
    } catch {
      return [];
    }
  }


  public async callTool<T = any>(
    method: string,
    params: any = {},
    timeoutMs = 15000,
  ): Promise<T> {
    const session = this.session();
    if (!session) {
      throw new Error(NOT_CONNECTED_MESSAGE);
    }
    return this.callToolOn<T>(session, method, params, timeoutMs);
  }

  /**
   * The same RPC, against a session named explicitly rather than resolved from
   * the ambient owner.
   *
   * `callTool` reads `currentOwner()` out of AsyncLocalStorage, which is right
   * for anything happening inside a request — but the two callers that push
   * exclusion rules are not inside one. One runs in the WebSocket `connection`
   * handler, where there is no ALS context at all; the other runs after a
   * settings save, on behalf of a user who may not be the one whose context is
   * current. Both already hold the session, so they say which one they mean.
   */
  private async callToolOn<T = any>(
    session: BridgeSession,
    method: string,
    params: any = {},
    timeoutMs = 15000,
  ): Promise<T> {
    /* `Date.now()` plus five base-36 characters was unique enough when one
     * socket owned the whole map. It is still unique enough now, but the map it
     * goes into belongs to this session alone, so a reply from one editor can
     * no longer settle a request made for another even if the ids collided. */
    const id = `rpc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const payload: RPCRequest = { id, method, params };

    /* Recorded before the send, so a request that never comes back is visible
     * as `pending` rather than absent. "Nothing is happening" and "something
     * hung" look identical in a log that only records completions. */
    const entry = this.beginActivity(session, method, params);

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.pending.delete(id);
        this.settleActivity(entry, "timeout", `No reply within ${timeoutMs}ms.`);
        reject(
          new Error(
            `OmniRoute VS Code tool call '${method}' timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);

      /* The settle hooks wrap the caller's resolve/reject rather than living in
       * `handleMessage`, because this is the only place that knows which
       * activity entry belongs to which id without a second map to keep in
       * step. */
      session.pending.set(id, {
        resolve: (value: any) => {
          this.settleActivity(entry, "ok", null);
          resolve(value as T);
        },
        reject: (err: Error) => {
          this.settleActivity(entry, "error", err?.message || String(err));
          reject(err);
        },
        timeout,
      });
      try {
        session.ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timeout);
        session.pending.delete(id);
        const error = err instanceof Error ? err : new Error(String(err));
        this.settleActivity(entry, "error", error.message);
        reject(error);
      }
    });
  }

  /* -----------------------------------------------------------------------
   * Activity ring
   * -------------------------------------------------------------------- */

  private beginActivity(
    session: BridgeSession,
    method: string,
    params: unknown,
  ): BridgeActivity {
    const entry: BridgeActivity = {
      seq: session.activitySeq++,
      at: Date.now(),
      method,
      target: describeTarget(params),
      state: "pending",
      ms: null,
      detail: null,
    };
    session.activity.push(entry);
    if (session.activity.length > ACTIVITY_LIMIT) {
      session.activity.splice(0, session.activity.length - ACTIVITY_LIMIT);
    }
    return entry;
  }

  /**
   * Mark an entry finished.
   *
   * Guarded on `state === "pending"` because a timeout and a late reply can
   * both arrive: the timer fires, the entry is marked `timeout`, and then the
   * editor's answer turns up and would otherwise rewrite history into `ok` for
   * a call the caller has already been told failed. First settlement wins,
   * which is the same rule the promise itself follows.
   *
   * The entry is mutated in place; it may already have been evicted from the
   * ring, in which case this quietly updates an object nobody will read again.
   */
  private settleActivity(
    entry: BridgeActivity,
    state: "ok" | "error" | "timeout",
    detail: string | null,
  ): void {
    if (entry.state !== "pending") return;
    entry.state = state;
    entry.ms = Math.max(0, Date.now() - entry.at);
    entry.detail = detail ? detail.replace(/\s+/g, " ").slice(0, 200) : null;
  }

  /**
   * Recent RPCs for the calling account's editor, oldest first.
   *
   * Scoped by `session()` — i.e. by the AsyncLocalStorage owner — for the same
   * reason `connectionInfo` is: one user's file paths are not another user's
   * business. No session means no history, not the local session's history.
   */
  public recentActivity(): BridgeActivity[] {
    const session = this.session();
    if (!session) return [];
    return session.activity.map((entry) => ({ ...entry }));
  }

  /* ----------------------- raw RPC passthroughs -------------------------
   *
   * These three go straight to `callTool` with whatever path they were handed.
   * They do NOT call `resolveInWorkspace`, so they get neither the root check
   * nor the relative-path normalisation that the `*Smart` methods get — which
   * is the whole reason they need their own exclusion check rather than
   * inheriting one.
   *
   * Nothing in the shipping app calls them today (the four workspace tools all
   * route through `readFileSmart` / `writeFileSmart` / `replaceInFileSmart`),
   * but they are public methods on an exported singleton, so the next call site
   * that appears gets the check for free instead of quietly reopening the hole.
   * --------------------------------------------------------------------- */

  /** Throw if the caller's rules put this path out of bounds. */
  private assertNotExcluded(filePath: string, action: "read" | "write" | "edit"): void {
    this.guardExcluded(
      { relative: String(filePath ?? "").replace(/\\/g, "/"), absolute: String(filePath ?? "") },
      action,
    );
  }

  public async readFile(filePath: string): Promise<string> {
    this.assertNotExcluded(filePath, "read");
    return this.callTool<string>("read_file", {
      path: filePath,
      filePath,
      file_path: filePath,
    });
  }

  public async writeFile(
    filePath: string,
    content: string,
  ): Promise<WriteFileResult> {
    this.assertNotExcluded(filePath, "write");
    return this.callTool<WriteFileResult>("write_file", {
      path: filePath,
      filePath,
      file_path: filePath,
      content,
    });
  }

  public async replaceInFile(
    filePath: string,
    findText: string,
    replaceText: string,
  ): Promise<WriteFileResult> {
    this.assertNotExcluded(filePath, "edit");
    return this.callTool<WriteFileResult>("replace_text", {
      path: filePath,
      filePath,
      file_path: filePath,
      old_text: findText,
      new_text: replaceText,
      findText,
      replaceText,
    });
  }

  /* --------------------------- workspace discovery ---------------------- */

  /**
   * The directory every relative path is resolved against.
   *
   * TWO MODES, AND THE DIFFERENCE MATTERS
   *
   * Multi-tenant: the root is whatever the user's own editor reports, full
   * stop. It is a path on THEIR machine — `C:\Users\priya\app` while this
   * process runs on Linux — so it is neither resolved nor checked for
   * existence here; only the extension can do either, and it does. If the
   * editor is not connected, or has no folder open, this throws. There is no
   * env fallback and no cwd fallback, because both of those name directories on
   * the SERVER, and handing one of those back would point every subsequent file
   * operation at the operator's disk.
   *
   * Single-user: unchanged from before. An explicit UI selection wins, then the
   * editor's answer, then OMNIROUTE_WORKSPACE_ROOT, then cwd — all of which are
   * this machine, which is the point.
   */
  public async workspaceRoot(): Promise<string> {
    const session = this.session();

    if (session) {
      /* The override still wins on a laptop: the WorkspaceSelector is how a
       * local user retargets the agent at a different project, and it would be
       * surprising for opening VS Code to silently undo that. In multi-tenant
       * mode there is no override to consult. */
      if (!MULTI_TENANT) {
        const override = this.overrideIfUsable();
        if (override) return override;
      }

      if (session.cachedRoot) return session.cachedRoot;

      if (!session.rootProbed) {
        session.rootProbed = true;
        const probed = await this.probeRootFromEditor();
        if (probed) {
          session.cachedRoot = probed;
          session.rootSource = "vscode-bridge";
          return probed;
        }
      }

      if (MULTI_TENANT) {
        throw new Error(
          "No folder is open in the VS Code window that is connected to your " +
            "account. Open the project folder you want me to work in (File → " +
            "Open Folder), then ask again.",
        );
      }
    } else if (MULTI_TENANT) {
      throw new Error(NOT_CONNECTED_MESSAGE);
    }

    /* ---- single-user discovery ---- */

    const override = this.overrideIfUsable();
    if (override) return override;

    if (this.cachedRoot) return this.cachedRoot;

    if (ENV_ROOT) {
      const resolved = path.resolve(ENV_ROOT);
      if (fs.existsSync(resolved)) {
        this.cachedRoot = resolved;
        this.rootSource = "env";
        return resolved;
      }
      console.warn(
        `[VSCodeBridge] OMNIROUTE_WORKSPACE_ROOT="${ENV_ROOT}" does not exist; falling back to process.cwd().`,
      );
    }

    this.cachedRoot = process.cwd();
    this.rootSource = "cwd";
    return this.cachedRoot;
  }

  /**
   * The UI-selected root, if one is set and still exists.
   *
   * Pulled out of `workspaceRoot` because it is now consulted from two places
   * and the bookkeeping it does — invalidating cached probe results when the
   * selection changes — must happen identically in both.
   */
  private overrideIfUsable(): string | null {
    if (MULTI_TENANT) return null;
    this.loadPersistedOverride();
    if (!this.overrideRoot || !fs.existsSync(this.overrideRoot)) return null;

    if (this.cachedRoot !== this.overrideRoot) {
      this.cachedRoot = this.overrideRoot;
      this.rootSource = "override";
      // A different project may now be open; old probe results (which RPC
      // method works, whether root came from the extension) do not apply.
      this.listMethod = undefined;
      for (const session of this.sessions.values()) {
        session.rootProbed = false;
        session.cachedRoot = null;
        session.listMethod = undefined;
      }
    }
    return this.overrideRoot;
  }

  /**
   * Ask the editor where its workspace is, trying each spelling once.
   *
   * In multi-tenant mode the answer is taken verbatim. `path.resolve()` would
   * be actively harmful there: on a Linux server, `path.resolve("C:\\Users\\
   * priya\\app")` produces `/app/C:\Users\priya\app`, a path that exists
   * nowhere, and `fs.existsSync` on it is a question about the wrong machine.
   */
  private async probeRootFromEditor(): Promise<string | null> {
    for (const method of ROOT_RPC_METHODS) {
      try {
        const result = await this.callTool<any>(method, {}, 2500);
        const candidate = rootFromRpcResult(result);
        if (!candidate) continue;

        if (MULTI_TENANT) {
          const trimmed = candidate.trim().replace(/[\\/]+$/, "");
          if (trimmed) return trimmed;
          continue;
        }

        const resolved = path.resolve(candidate);
        if (fs.existsSync(resolved)) return resolved;
      } catch {
        /* method absent or extension busy — try the next spelling */
      }
    }
    return null;
  }

  /** How the current caller's root was decided, and what it is. */
  private rootState(): {
    source: "override" | "vscode-bridge" | "env" | "cwd";
    root: string | null;
  } {
    const session = this.session();
    if (session && session.cachedRoot) {
      return { source: session.rootSource, root: session.cachedRoot };
    }
    return { source: this.rootSource, root: this.cachedRoot };
  }

  public rootSourceLabel(): string {
    switch (this.rootState().source) {
      case "override":
        return "selected in the UI (Workspace Selector)";
      case "vscode-bridge":
        return "reported by the VS Code extension";
      case "env":
        return "OMNIROUTE_WORKSPACE_ROOT";
      default:
        return "process.cwd() fallback";
    }
  }

  /** Read the persisted override once per process. Cheap re-checks after that
   *  just look at the in-memory field, so this never touches disk per request. */
  private loadPersistedOverride(): void {
    if (this.overrideLoaded) return;
    this.overrideLoaded = true;
    try {
      if (!fs.existsSync(CONFIG_FILE)) return;
      const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      const stored =
        typeof parsed?.activeWorkspace === "string"
          ? parsed.activeWorkspace
          : "";
      if (stored && fs.existsSync(stored)) {
        this.overrideRoot = path.resolve(stored);
      } else if (stored) {
        console.warn(
          `[VSCodeBridge] Persisted workspace "${stored}" no longer exists; ignoring.`,
        );
      }
    } catch (err) {
      console.warn(
        "[VSCodeBridge] Failed to read persisted workspace override:",
        err,
      );
    }
  }

  private persistOverride(root: string | null): void {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(
        CONFIG_FILE,
        JSON.stringify(
          { activeWorkspace: root, updatedAt: new Date().toISOString() },
          null,
          2,
        ),
        "utf-8",
      );
    } catch (err) {
      console.warn("[VSCodeBridge] Failed to persist workspace override:", err);
    }
  }

  /**
   * Directories that must never become the workspace root.
   *
   * Not an attempt at a complete list of sensitive paths — that list does not
   * exist. It blocks the specific choices that would defeat `guardPath`
   * wholesale: a filesystem root makes every path on the machine "inside the
   * workspace", and these system directories are where credentials and process
   * state live. A project folder is never one of them.
   */
  private static readonly FORBIDDEN_ROOTS: readonly string[] =
    process.platform === "win32"
      ? [
          "c:\\windows",
          "c:\\program files",
          "c:\\program files (x86)",
          "c:\\programdata",
        ]
      : [
          "/etc",
          "/proc",
          "/sys",
          "/dev",
          "/boot",
          "/root",
          "/var",
          "/usr",
          "/bin",
          "/sbin",
          "/lib",
          "/lib64",
        ];

  /**
   * Called by POST /api/workspace when the user picks a directory in the
   * WorkspaceSelector — either from the discovered list, a native folder
   * dialog, or the manual path override field.
   *
   * WHY THE CHOICE IS CONSTRAINED
   *
   * Whatever lands here becomes the workspace root, and `guardPath` measures
   * every later file operation against it. So this function does not merely
   * choose a convenience default — it sets the boundary. Passing "/" or "C:\"
   * would place the entire disk inside the workspace and silence the guard
   * without tripping it, which is why a filesystem root, a system directory and
   * the bare home directory (which holds .ssh, .aws and .env files) are all
   * refused. Subdirectories of home are fine; that is where projects live.
   *
   * On a deployed server the operator pins OMNIROUTE_WORKSPACE_ROOT, and the
   * selection must then sit inside it. That turns the setting from a default
   * into a containment boundary a signed-in user cannot step outside of.
   *
   * MULTI-TENANT: REFUSED OUTRIGHT
   *
   * Every path this function can accept names a directory on the SERVER. In a
   * deployment that serves other people, the answer to "which folder should the
   * agent work in" is not the operator's to give and not a signed-in user's to
   * choose — it is whichever folder that user has open in their own editor. The
   * containment check above would still hold, but it would be containing the
   * wrong machine's filesystem, so the whole operation is refused instead.
   */
  public async setActiveWorkspace(rawPath: string): Promise<string> {
    this.refuseServerBrowsing();
    const cleaned = String(rawPath ?? "")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!cleaned) {
      throw new Error("No directory path was provided.");
    }

    const resolved = path.resolve(cleaned);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Directory does not exist: ${resolved}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`Not a directory: ${resolved}`);
    }

    /* A path whose parent is itself is a filesystem root: "/", "C:\", "\\srv\". */
    if (path.dirname(resolved) === resolved) {
      throw new Error(
        `Refusing to use "${resolved}" as the workspace. A filesystem root would put every ` +
          `file on this machine inside the workspace and disable the path guard. Pick the ` +
          `folder that contains your project instead.`,
      );
    }

    const lowered = resolved.toLowerCase().replace(/[\\/]+$/, "");
    for (const forbidden of VSCodeBridgeManager.FORBIDDEN_ROOTS) {
      if (lowered === forbidden || lowered.startsWith(`${forbidden}${path.sep}`)) {
        throw new Error(
          `Refusing to use "${resolved}" as the workspace: it is a system directory. ` +
            `Pick a project folder.`,
        );
      }
    }

    const home = os.homedir();
    if (home && lowered === home.toLowerCase().replace(/[\\/]+$/, "")) {
      throw new Error(
        `Refusing to use your home directory as the workspace — it contains SSH keys, cloud ` +
          `credentials and .env files. Pick the project folder inside it.`,
      );
    }

    /* Production containment: when the operator has pinned a root, that is the
     * boundary, not a starting suggestion. */
    if (IS_PRODUCTION && ENV_ROOT) {
      const pinned = path.resolve(ENV_ROOT);
      const rel = path.relative(pinned, resolved);
      const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      if (!inside) {
        throw new Error(
          `Refusing to use "${resolved}": this server restricts workspaces to ${pinned} ` +
            `(OMNIROUTE_WORKSPACE_ROOT).`,
        );
      }
    }

    this.overrideRoot = resolved;
    this.overrideLoaded = true;
    this.persistOverride(resolved);

    // Force every cached discovery result to be re-derived against the new
    // root on the very next call — the whole reason this was broken before.
    this.cachedRoot = resolved;
    this.rootSource = "override";
    this.listMethod = undefined;
    for (const session of this.sessions.values()) {
      session.rootProbed = false;
      session.cachedRoot = null;
      session.listMethod = undefined;
    }

    return resolved;
  }

  /**
   * Refuse an operation that would expose the server's own filesystem.
   *
   * The three callers — the project scanner, the native folder dialog and the
   * workspace override — all made sense when "the machine running Next" and
   * "the machine with the user's code on it" were the same computer. On a
   * shared host they are a directory listing of somebody else's server,
   * a GUI dialog on a box with no display, and a way to point the agent at
   * /app respectively.
   */
  private refuseServerBrowsing(): void {
    if (!MULTI_TENANT) return;
    throw new Error(
      "This server does not browse its own filesystem. The folder the agent " +
        "works in is whichever folder you have open in the VS Code window " +
        "connected to your account — change it there, not here.",
    );
  }

  /**
   * Scan a handful of likely locations for folders that look like real
   * projects (contain a package.json), for the WorkspaceSelector's picker.
   * Never throws — an unreadable directory is skipped, not fatal.
   *
   * Returns nothing at all in multi-tenant mode: the directories it would list
   * are the operator's, and their names alone ("acme-client", "tax-2025") are
   * information no signed-in user is entitled to.
   */
  public async discoverProjects(maxResults = 40): Promise<DiscoveredProject[]> {
    if (MULTI_TENANT) return [];
    const seen = new Set<string>();
    const results: DiscoveredProject[] = [];

    const consider = async (dir: string) => {
      if (results.length >= maxResults) return;
      const resolved = path.resolve(dir);
      if (seen.has(resolved)) return;
      seen.add(resolved);
      if (isIgnoredDir(path.basename(resolved))) return;

      const pkgPath = path.join(resolved, "package.json");
      const hasPackageJson = fs.existsSync(pkgPath);
      if (hasPackageJson) {
        results.push({
          name: path.basename(resolved),
          path: resolved,
          hasPackageJson: true,
        });
      }
    };

    for (const root of candidateScanRoots()) {
      if (results.length >= maxResults) break;
      let entries: string[];
      try {
        entries = await fsp.readdir(root);
      } catch {
        continue; // does not exist or not readable — skip silently
      }

      // The root itself may be a project (e.g. process.cwd()'s parent).
      await consider(root);

      for (const name of entries) {
        if (results.length >= maxResults) break;
        if (isIgnoredDir(name)) continue;
        const full = path.join(root, name);
        let stat: fs.Stats;
        try {
          stat = await fsp.stat(full);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;
        await consider(full);
      }
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Open a native OS folder-picker dialog on the machine running the Next
   * server. Only meaningful for local/self-hosted use (this is a localhost
   * dev tool, not a hosted service) — exactly the OmniRoute deployment model.
   */
  public async browseForFolder(): Promise<string | null> {
    this.refuseServerBrowsing();
    const platform = process.platform;

    try {
      if (platform === "win32") {
        const psScript =
          "Add-Type -AssemblyName System.Windows.Forms; " +
          "$f = New-Object System.Windows.Forms.FolderBrowserDialog; " +
          "$f.Description = 'Select the OmniRoute target project directory'; " +
          "if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }";
        const { stdout } = await execAsync(
          `powershell -NoProfile -STA -Command "${psScript}"`,
          { timeout: 120000 },
        );
        const selected = stdout.trim();
        return selected || null;
      }

      if (platform === "darwin") {
        const { stdout } = await execAsync(
          `osascript -e 'POSIX path of (choose folder with prompt "Select the OmniRoute target project directory")'`,
          { timeout: 120000 },
        );
        const selected = stdout.trim();
        return selected || null;
      }

      // Linux: try zenity, then kdialog. Neither present -> caller falls
      // back to the manual path field, which is always available.
      try {
        const { stdout } = await execAsync(
          `zenity --file-selection --directory --title="Select the OmniRoute target project directory"`,
          { timeout: 120000 },
        );
        return stdout.trim() || null;
      } catch {
        const { stdout } = await execAsync(
          `kdialog --getexistingdirectory ~ --title "Select the OmniRoute target project directory"`,
          { timeout: 120000 },
        );
        return stdout.trim() || null;
      }
    } catch (err: any) {
      // Non-zero exit is how every one of these tools reports "user hit
      // Cancel" — that's routine, not an error, so the caller can tell them
      // apart from a genuinely missing dialog tool via the message below.
      const msg = err?.message || String(err);
      if (/cancel/i.test(msg) || err?.code === 1) return null;
      throw new Error(
        `Could not open a native folder dialog on this machine (${platform}): ${msg}. ` +
          `Use the manual path field instead.`,
      );
    }
  }

  /**
   * Turn a model-supplied path into an absolute one.
   *
   * Absolute paths pass through. Relative paths resolve against the workspace
   * root — NOT process.cwd(), which was the old behaviour and pointed at the
   * Next app's own directory even when VS Code had a different project open.
   *
   * When the root was determined explicitly (env var or the extension), paths
   * that escape it are rejected: a model should not be able to write anywhere
   * on the disk. The guard is skipped for the cwd fallback in development only,
   * where the root is genuinely a guess — see `guardPath`.
   *
   * MULTI-TENANT: RELATIVE PATHS ONLY
   *
   * The root is then a path on the user's machine and this process is almost
   * certainly a different operating system, which makes `path.isAbsolute`
   * answer a question about the wrong platform. On Linux,
   * `path.isAbsolute("C:\\Users\\priya\\app\\src")` is FALSE — so a Windows
   * absolute path would be quietly joined onto the root and turned into
   * `C:\Users\priya\app/C:\Users\priya\app\src`, a path that exists nowhere,
   * and the failure would be reported as a missing file. Rejecting absolute
   * paths outright turns a confusing wrong answer into a clear instruction the
   * model can act on, and it costs nothing: every tool description already
   * tells it to use workspace-relative paths.
   */
  public async resolveInWorkspace(rawPath: string): Promise<{
    absolute: string;
    relative: string;
    root: string;
    outsideRoot: boolean;
  }> {
    const root = await this.workspaceRoot();
    const cleaned = String(rawPath ?? "")
      .trim()
      .replace(/^["']|["']$/g, "");

    if (MULTI_TENANT) {
      /* Both spellings, because the server's own `path` module only recognises
       * one of them and the user's machine may be the other. */
      const looksAbsolute =
        cleaned.startsWith("/") ||
        cleaned.startsWith("\\") ||
        /^[A-Za-z]:[\\/]/.test(cleaned);
      if (looksAbsolute) {
        throw new Error(
          `Use a path relative to the workspace root, not an absolute one ` +
            `("${cleaned}"). The workspace root is on your machine, not on this ` +
            `server, so only relative paths can be resolved.`,
        );
      }

      /* The root is a foreign path, so `path.relative` cannot be trusted to
       * produce the right answer. Containment is decided from the cleaned
       * relative path alone — which is the only thing sent to the editor — and
       * the editor checks it a second time before touching anything. */
      const normalised = cleaned.replace(/\\/g, "/").replace(/^\.\/+/, "");
      const escapes = normalised
        .split("/")
        .some((segment) => segment === "..");
      return {
        absolute: `${root}${root.includes("\\") ? "\\" : "/"}${normalised.replace(/\//g, root.includes("\\") ? "\\" : "/")}`,
        relative: normalised,
        root,
        outsideRoot: escapes,
      };
    }

    const absolute = path.isAbsolute(cleaned)
      ? path.normalize(cleaned)
      : path.resolve(root, cleaned);

    const relativeRaw = path.relative(root, absolute);
    const outsideRoot =
      relativeRaw.startsWith("..") || path.isAbsolute(relativeRaw);

    return {
      absolute,
      relative: (outsideRoot ? absolute : relativeRaw).replace(/\\/g, "/"),
      root,
      outsideRoot,
    };
  }

  /**
   * Reject a path that escapes the workspace root.
   *
   * The message names this guard explicitly. It used to read "Refusing to
   * touch ..." with no indication of which layer refused, which made it look
   * like a filesystem permission error when it was in fact this policy check.
   *
   * THE cwd ESCAPE HATCH IS DEVELOPMENT-ONLY
   *
   * When nothing has told us where the workspace is, the root falls back to
   * `process.cwd()`, and skipping the guard in that case is a reasonable local
   * convenience: the root really is only a guess, and a legitimate edit may sit
   * beside the project rather than inside it.
   *
   * On a server it is not a convenience, it is the guard switching itself off.
   * A container's cwd is /app, so an unset OMNIROUTE_WORKSPACE_ROOT would have
   * turned every path check into a no-op and left the whole filesystem — the
   * SQLite database with everyone's encrypted credentials, /proc/self/environ
   * with every secret in it — readable and writable through the file tools.
   * `OMNIROUTE_ENABLE_FILE_TOOLS` defaults off in production and is the primary
   * defence; this is the second one, because a single flag is not a boundary.
   */
  private guardPath(resolved: {
    outsideRoot: boolean;
    absolute: string;
  }): void {
    if (!resolved.outsideRoot) return;
    /* Both escape hatches are local-only. On a shared server the root is
     * another person's machine, so "allow outside the root" and "the root was
     * only a guess" are not statements this process is in a position to make. */
    if (!MULTI_TENANT && ALLOW_OUTSIDE_ROOT) return;
    const state = this.rootState();
    if (!MULTI_TENANT && state.source === "cwd" && !IS_PRODUCTION) return;
    throw new Error(
      `Workspace guard: refusing to access "${resolved.absolute}" because it is outside ` +
        `the active workspace root (${state.root ?? "unresolved"}, ${this.rootSourceLabel()}). ` +
        `Use a path inside the workspace, switch projects in the Workspace Selector, or set ` +
        `OMNIROUTE_ALLOW_OUTSIDE_ROOT=1 to allow this.`,
    );
  }

  /**
   * Reject a path the user has put out of bounds.
   *
   * HOW THIS DIFFERS FROM guardPath, WHICH IT SITS NEXT TO
   *
   * `guardPath` answers "is this inside the workspace". This answers "is this
   * something the model is allowed to see at all". They are orthogonal: the
   * most dangerous file in any repo — `.env` — is squarely inside the root and
   * passes `guardPath` without complaint. Two checks because they fail for two
   * different reasons and the user can only change one of them.
   *
   * WHY IT THROWS INSTEAD OF RETURNING AN EMPTY RESULT
   *
   * A read that silently returns "" teaches the model the file is empty, and it
   * will happily write a replacement for a file it thinks has no contents. The
   * throw is caught by `runWorkspaceTool` and turned into a tool result the
   * model can read and reason about, which is the outcome that ends the turn
   * instead of corrupting a file.
   *
   * WHY THE RELATIVE PATH
   *
   * The rules are written against workspace-relative paths, the way a
   * .gitignore is. `resolved.relative` is exactly that, already normalised to
   * forward slashes. In the one case where it is not — a local-mode path
   * outside the root — every ALWAYS pattern is basename-style, so the
   * credential floor still fires on an absolute path.
   */
  private guardExcluded(
    resolved: { relative: string; absolute: string },
    action: "read" | "write" | "edit",
  ): void {
    const matcher = getMatcherForUser(currentUserId());
    const verdict = matcher.decide(resolved.relative);
    if (!verdict.excluded) return;

    const verb =
      action === "read" ? "read" : action === "write" ? "write" : "edit";
    throw new Error(
      `File access blocked: I cannot ${verb} this file. ${verdict.reason ?? ""} ` +
        `Do not retry this path or look for the same contents somewhere else — ` +
        `the block is enforced here, not by the editor, and it will refuse every time.`,
    );
  }

  /**
   * List the workspace. Tries the extension first (so a custom indexer is used
   * when present), then — on a laptop only — walks the filesystem.
   *
   * The `fs` branch is the single most dangerous line in this file on a shared
   * host: it would enumerate the SERVER's disk and hand the listing to whoever
   * asked. In multi-tenant mode it is replaced by an error that says what to do
   * instead.
   */
  public async listFiles(
    options: WalkOptions & { dir?: string } = {},
  ): Promise<ListFilesResult> {
    const root = await this.workspaceRoot();
    const dir = String(options.dir ?? "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.?\/+/, "")
      .replace(/\/+$/, "");

    const base: Omit<ListFilesResult, "entries" | "source"> = {
      root,
      dir,
      fileCount: 0,
      dirCount: 0,
      truncated: false,
    };

    /* THE LISTING IS WHERE AN EXCLUSION EITHER HOLDS OR LEAKS.
     *
     * Blocking `read_file` on `.env` while `list_files` still names it is half
     * a feature: the model learns the file exists, learns its neighbours, and
     * — worse for the user's actual goal here — spends tokens on a directory of
     * things it is not allowed to open. Every entry is filtered, and the
     * `isDir` flag is passed per the matcher's call-site contract so that
     * directory-only rules ("node_modules/") hide the directory's own row and
     * not just the files under it.
     *
     * Unlike a read, this does not throw for the entries: a listing that drops
     * three rows is still a useful listing. A listing of a directory that is
     * ITSELF excluded is not, so that one refuses outright. */
    const matcher = getMatcherForUser(currentUserId());
    if (dir) {
      const dirVerdict = matcher.decide(dir, true);
      if (dirVerdict.excluded) {
        return {
          ...base,
          entries: [],
          source: "vscode-bridge",
          error: `${dirVerdict.reason ?? `"${dir}" is excluded.`} Nothing in this directory can be listed or read.`,
        };
      }
    }
    const keep = (entry: { path: string; kind: string }) =>
      !matcher.test(entry.path, entry.kind === "dir");

    /* ---- 1. the extension, if it speaks a listing method ---- */
    const session = this.session();
    const listMethod = session ? session.listMethod : this.listMethod;
    if (session && listMethod !== null) {
      const methods = listMethod === undefined ? LIST_RPC_METHODS : [listMethod];

      for (const method of methods) {
        try {
          const result = await this.callTool<any>(
            method,
            {
              path: dir,
              dir,
              directory: dir,
              recursive: true,
              depth: options.depth ?? 3,
              pattern: options.pattern,
            },
            4000,
          );
          const entries = entriesFromRpcResult(result, dir);
          if (entries.length > 0) {
            session.listMethod = method;
            if (!MULTI_TENANT) this.listMethod = method;
            const matches = makeMatcher(options.pattern);
            const filtered = entries.filter(
              (e) => matches(e.path) && keep(e),
            );
            return {
              ...base,
              entries: filtered,
              fileCount: filtered.filter((e) => e.kind === "file").length,
              dirCount: filtered.filter((e) => e.kind === "dir").length,
              source: "vscode-bridge",
            };
          }
        } catch {
          /* try the next spelling */
        }
      }
      // Nothing worked; stop probing for the lifetime of this connection.
      session.listMethod = null;
      if (!MULTI_TENANT) this.listMethod = null;
    }

    /* ---- 2. the filesystem ---- */
    if (MULTI_TENANT) {
      return {
        ...base,
        entries: [],
        source: "vscode-bridge",
        error: session
          ? "Your editor did not return a file listing. Make sure a folder is " +
            "open in the connected VS Code window and that you approved access " +
            "to it when prompted."
          : NOT_CONNECTED_MESSAGE,
      };
    }

    try {
      const { entries, truncated } = await walkWorkspace(root, dir, options);
      /* The same filter as the bridge branch. It has to be repeated rather than
       * hoisted to the end of the method because the two branches return from
       * different places; a single exit point here would be a larger change to
       * a function that decides what the model can see. */
      const visible = entries.filter(keep);
      return {
        ...base,
        entries: visible,
        fileCount: visible.filter((e) => e.kind === "file").length,
        dirCount: visible.filter((e) => e.kind === "dir").length,
        truncated,
        source: "filesystem",
      };
    } catch (err) {
      return {
        ...base,
        entries: [],
        source: "filesystem",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * The block that gets injected into the system prompt. This is what stops the
   * model from web-searching for its own project layout.
   */
  public async workspaceSnapshot(
    options: { depth?: number; maxEntries?: number; maxChars?: number } = {},
  ): Promise<string> {
    const depth = options.depth ?? 4;
    const maxEntries = options.maxEntries ?? 260;
    const maxChars = options.maxChars ?? 5000;

    const listing = await this.listFiles({
      depth,
      maxEntries,
      includeDirs: false,
    });
    const ordered = prioritiseEntries(listing.entries);

    const lines: string[] = [];
    lines.push("=== VS CODE WORKSPACE (live, read at request time) ===");
    lines.push(`root: ${listing.root}`);
    lines.push(
      `root determined by: ${this.rootSourceLabel()}  |  path separator: "${path.sep}"`,
    );
    lines.push(
      `vs code bridge: ${
        this.isConnected()
          ? "connected — edits appear in the editor"
          : MULTI_TENANT
            ? "NOT connected — file tools will fail until the user connects VS Code"
            : "NOT connected — edits are written straight to disk with fs"
      }`,
    );
    lines.push(`listing source: ${listing.source}`);

    if (listing.error) lines.push(`listing error: ${listing.error}`);

    lines.push(
      `files (walked ${depth} levels, showing ${ordered.length}${
        listing.truncated ? ", more exist below" : ""
      }):`,
    );

    let body = "";
    let shown = 0;
    for (const entry of ordered) {
      const size =
        typeof entry.bytes === "number"
          ? ` (${entry.bytes >= 1024 ? `${Math.round(entry.bytes / 1024)}kb` : `${entry.bytes}b`})`
          : "";
      const line = `  ${entry.path}${size}\n`;
      if (body.length + line.length > maxChars) {
        body += `  ... ${ordered.length - shown} more file(s) not shown — call list_files with a "pattern" to find them\n`;
        break;
      }
      body += line;
      shown += 1;
    }

    lines.push(body.replace(/\n$/, ""));

    if (listing.truncated) {
      lines.push(
        `(deeper files exist — call list_files with a larger "depth" or a "pattern")`,
      );
    }
    lines.push("=== END VS CODE WORKSPACE ===");

    return lines.join("\n");
  }

  /* ---------------------------- tool executors -------------------------- */

  /** Copy a file into .omniroute-backups/ before it is modified.
   *
   *  Local only. In multi-tenant mode the file lives on the user's machine and
   *  there is nothing here to copy — `fs.existsSync` would simply answer false
   *  for every path — so this returns null immediately and the safety net is
   *  the extension's own git checkpoint, which runs on the machine that
   *  actually holds the file. */
  public async backup(
    absolutePath: string,
    root: string,
  ): Promise<string | null> {
    if (MULTI_TENANT) return null;
    try {
      if (!fs.existsSync(absolutePath)) return null;
      const relative = path.relative(root, absolutePath);
      const safeRelative = relative.startsWith("..")
        ? path.basename(absolutePath)
        : relative;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const target = path.join(
        root,
        BACKUP_DIR,
        `${safeRelative}.${stamp}.bak`,
      );
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(absolutePath, target);
      
      // Clean up old backups, keeping only the 10 most recent
      await this.cleanupOldBackups(root, safeRelative);
      
      return target;
    } catch {
      return null;
    }
  }

  /** Remove old backups for a file, keeping only the 10 most recent. */
  private async cleanupOldBackups(
    root: string,
    relativeFilePath: string,
  ): Promise<void> {
    try {
      const backupDir = path.join(root, BACKUP_DIR, path.dirname(relativeFilePath));
      const fileName = path.basename(relativeFilePath);
      
      if (!fs.existsSync(backupDir)) return;
      
      const files = await fsp.readdir(backupDir);
      const backupFiles = files
        .filter((f) => f.startsWith(fileName + ".") && f.endsWith(".bak"))
        .map((f) => ({
          name: f,
          path: path.join(backupDir, f),
          stat: fs.statSync(path.join(backupDir, f)),
        }))
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs); // Sort by modification time, newest first
      
      // Keep only the 10 most recent backups
      if (backupFiles.length > 10) {
        const toDelete = backupFiles.slice(10);
        for (const file of toDelete) {
          await fsp.unlink(file.path).catch(() => {
            /* ignore errors */
          });
        }
      }
    } catch {
      // Silently ignore cleanup errors to not block the backup operation
    }
  }

  /**
   * Read one file through the editor, returning the WHOLE file or null.
   *
   * Pulled out of `readFileSmart` because `replaceInFileSmart` needs the same
   * thing and must not reuse `readFileSmart` itself: that method truncates at
   * MAX_READ_CHARS for the model's benefit, and splicing an edit into a
   * truncated buffer and writing it back would silently delete everything past
   * the cut. The one-line version of that bug destroys files.
   */
  private async readWholeFileViaBridge(
    relative: string,
  ): Promise<string | null> {
    if (!this.isConnected()) return null;
    try {
      const result: any = await this.callTool("read_file", {
        path: relative,
        filePath: relative,
        file_path: relative,
      });
      if (typeof result === "string") return result;
      if (typeof result?.content === "string") return result.content;
      if (typeof result?.text === "string") return result.text;
      return null;
    } catch {
      return null;
    }
  }

  public async readFileSmart(
    rawPath: string,
    options: { startLine?: number; endLine?: number } = {},
  ): Promise<Record<string, unknown>> {
    const resolved = await this.resolveInWorkspace(rawPath);
    this.guardPath(resolved);
    this.guardExcluded(resolved, "read");

    let content: string | null = null;
    let source: "vscode-bridge" | "filesystem" = "filesystem";

    if (this.isConnected()) {
      content = await this.readWholeFileViaBridge(resolved.relative);
      if (content !== null) source = "vscode-bridge";
    }

    if (content === null) {
      /* THE FALLBACK THAT COULD NOT SURVIVE DEPLOYMENT.
       *
       * Reading from `fs` here means reading the machine this process runs on.
       * On a laptop that is the same disk the editor would have read, so the
       * fallback is invisible and useful. On a server it is the operator's
       * disk, and the file tools sit behind a chat box: "read .env" would have
       * returned the Resend key, the auth secret and the database path to
       * anyone with an account. The extension's own denylist (.env, *.pem,
       * .git) does not apply, because this path never reaches the extension.
       *
       * So in multi-tenant mode there is no fallback. Either the user's editor
       * answered, or the call fails. */
      if (MULTI_TENANT) {
        return {
          success: false,
          error: this.isConnected()
            ? `Your editor did not return ${resolved.relative}. It may not exist, or access to this folder may not have been approved.`
            : NOT_CONNECTED_MESSAGE,
          root: resolved.root,
        };
      }

      if (!fs.existsSync(resolved.absolute)) {
        return {
          success: false,
          error: `File not found: ${resolved.relative}`,
          root: resolved.root,
          hint: "Call list_files to see what actually exists before reading.",
        };
      }
      content = await fsp.readFile(resolved.absolute, "utf-8");
    }

    const allLines = content.split("\n");
    const totalLines = allLines.length;

    let sliced = content;
    let slicedFrom: number | null = null;
    let slicedTo: number | null = null;

    if (options.startLine || options.endLine) {
      const from = Math.max(1, Math.floor(options.startLine || 1));
      const to = Math.min(
        totalLines,
        Math.floor(options.endLine || totalLines),
      );
      if (to >= from) {
        sliced = allLines.slice(from - 1, to).join("\n");
        slicedFrom = from;
        slicedTo = to;
      }
    }

    const truncated = sliced.length > MAX_READ_CHARS;

    return {
      success: true,
      path: resolved.relative,
      absolutePath: resolved.absolute,
      source,
      totalLines,
      ...(slicedFrom !== null
        ? { startLine: slicedFrom, endLine: slicedTo }
        : {}),
      truncated,
      ...(truncated
        ? {
            note: `Only the first ${MAX_READ_CHARS} characters are shown. Re-read with start_line/end_line to page through the rest.`,
          }
        : {}),
      content: truncated ? sliced.slice(0, MAX_READ_CHARS) : sliced,
    };
  }

  public async writeFileSmart(
    rawPath: string,
    content: string,
  ): Promise<Record<string, unknown>> {
    const resolved = await this.resolveInWorkspace(rawPath);
    this.guardPath(resolved);
    /* Writes are gated too, not just reads. An excluded file is one the model
     * was never allowed to see, so it cannot have read the current contents —
     * any write it produces is a guess that would overwrite the real file. */
    this.guardExcluded(resolved, "write");

    if (typeof content !== "string") {
      return {
        success: false,
        error: "write_file requires a string `content` argument.",
      };
    }

    const backupPath = await this.backup(resolved.absolute, resolved.root);

    /* Used only for the `created` flag in the reply. Skipped entirely on a
     * shared server, where `resolved.absolute` is a path on somebody else's
     * machine and this process answering "does it exist" is answering about the
     * wrong disk — and answering out loud, since the flag goes back to the
     * caller. One bit is not much of a leak, but it is a leak of the server's
     * filesystem through a question about the user's, which is the exact
     * confusion this mode exists to prevent. `undefined` is honest: whether the
     * file existed is something only the editor knows. */
    const existed = MULTI_TENANT ? undefined : fs.existsSync(resolved.absolute);

    if (this.isConnected()) {
      try {
        const result: any = await this.callTool("write_file", {
          path: resolved.relative,
          filePath: resolved.relative,
          file_path: resolved.relative,
          content,
        });
        return {
          success: result?.success !== false,
          path: resolved.relative,
          absolutePath: resolved.absolute,
          source: "vscode-bridge",
          created: existed === undefined ? undefined : !existed,
          bytes: Buffer.byteLength(content, "utf8"),
          backupPath,
          ...(result && typeof result === "object" ? { bridge: result } : {}),
        };
      } catch (err) {
        // Fall through to fs, but say that the bridge was tried and failed.
        const bridgeError = err instanceof Error ? err.message : String(err);
        /* Not on a shared server. A failed write to the user's editor must not
         * become a successful write to the operator's disk — that turns "your
         * edit did not land" into "something was created on a machine you have
         * never seen", at a path chosen by a language model. */
        if (MULTI_TENANT) {
          return {
            success: false,
            path: resolved.relative,
            error: `Your editor refused or failed the write: ${bridgeError}`,
            hint: "Check that the folder is still open in VS Code and that you approved access to it.",
          };
        }
        await fsp.mkdir(path.dirname(resolved.absolute), { recursive: true });
        await fsp.writeFile(resolved.absolute, content, "utf-8");
        return {
          success: true,
          path: resolved.relative,
          absolutePath: resolved.absolute,
          source: "filesystem",
          created: !existed,
          bytes: Buffer.byteLength(content, "utf8"),
          backupPath,
          bridgeError,
          hash: crypto
            .createHash("sha256")
            .update(content)
            .digest("hex")
            .slice(0, 16),
        };
      }
    }

    /* No editor at all. Same reasoning as the catch above: on a laptop this is
     * the ordinary "VS Code isn't running" case and writing directly is what
     * the user wants; on a server there is no user's disk here to write to. */
    if (MULTI_TENANT) {
      return {
        success: false,
        path: resolved.relative,
        error: NOT_CONNECTED_MESSAGE,
      };
    }

    await fsp.mkdir(path.dirname(resolved.absolute), { recursive: true });
    await fsp.writeFile(resolved.absolute, content, "utf-8");
    return {
      success: true,
      path: resolved.relative,
      absolutePath: resolved.absolute,
      source: "filesystem",
      created: !existed,
      bytes: Buffer.byteLength(content, "utf8"),
      backupPath,
      hash: crypto
        .createHash("sha256")
        .update(content)
        .digest("hex")
        .slice(0, 16),
    };
  }

  /**
   * Surgical replace.
   *
   * Two deliberate behaviour changes over the original:
   *
   * 1. `split(old).join(new)` silently rewrote EVERY occurrence. A snippet that
   *    appears twice now fails with the count, so the model can extend the
   *    snippet — or pass `replace_all: true` on purpose.
   *
   * 2. Matching is TIERED (exact -> line-endings -> trailing whitespace). A
   *    CRLF file used to be unmatchable, because the model's `old_text` always
   *    arrives LF-only; that single incompatibility is what burned a whole
   *    iteration budget on `app.py` without landing one edit. See locateSnippet.
   *
   * When the match was not exact the edit is applied by SPLICING at the located
   * offsets and written through `write_file`, never by asking the extension to
   * repeat the same `replace_text` — its matcher would fail identically.
   */
  public async replaceInFileSmart(
    rawPath: string,
    oldText: string,
    newText: string,
    options: { replaceAll?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const resolved = await this.resolveInWorkspace(rawPath);
    this.guardPath(resolved);
    /* `replace_text` is a read primitive as much as a write one: a deliberately
     * non-matching `old_text` makes the error message quote the surrounding
     * lines back. Gating it as an edit closes that side channel. */
    this.guardExcluded(resolved, "edit");

    if (typeof oldText !== "string" || oldText.length === 0) {
      return {
        success: false,
        error: "replace_text requires a non-empty `old_text`.",
      };
    }

    /* THE FILE IS READ FROM WHEREVER IT WILL BE WRITTEN.
     *
     * This used to be an unconditional `fs.existsSync` + `fsp.readFile` on the
     * server's own disk — not a fallback, the primary path. Behind a shared
     * deployment that is a file-read primitive with no denylist in front of it:
     * `replace_text` on `.env`, with `old_text` chosen to fail, reports the
     * surrounding lines in its error message. Reading through the editor keeps
     * the operation on the machine the file actually lives on, and keeps the
     * extension's own refusals (.env, *.pem, .git, outside-root) in force. */
    let before: string;
    if (MULTI_TENANT) {
      const fetched = await this.readWholeFileViaBridge(resolved.relative);
      if (fetched === null) {
        return {
          success: false,
          error: this.isConnected()
            ? `Could not read ${resolved.relative} from your editor. It may not exist, or access to this folder may not have been approved.`
            : NOT_CONNECTED_MESSAGE,
          root: resolved.root,
          hint: "Call list_files to confirm the path, then read_file before editing.",
        };
      }
      before = fetched;
    } else {
      if (!fs.existsSync(resolved.absolute)) {
        return {
          success: false,
          error: `File not found: ${resolved.relative}`,
          root: resolved.root,
          hint: "Call list_files to confirm the path, then read_file before editing.",
        };
      }
      before = await fsp.readFile(resolved.absolute, "utf-8");
    }

    const eol = detectEol(before);

    const located = locateSnippet(before, oldText);
    const occurrences = located.matches.length;

    if (occurrences === 0) {
      // Actionable failure. The anchor search is done on normalised text so a
      // CRLF file still reports useful line numbers.
      const firstLine = normaliseEol(oldText).split("\n")[0].trim();
      const anchor = firstLine.slice(0, 60);
      const haystackLines = normaliseEol(before).split("\n");
      const anchorHits = anchor
        ? haystackLines.reduce<number[]>((acc, line, index) => {
            if (line.includes(anchor)) acc.push(index + 1);
            return acc;
          }, [])
        : [];
      return {
        success: false,
        error: `old_text was not found in ${resolved.relative}.`,
        occurrences: 0,
        totalLines: haystackLines.length,
        fileLineEndings: eol,
        ...(anchorHits.length > 0
          ? {
              anchorFoundOnLines: anchorHits.slice(0, 10),
              hint:
                `The first line of your snippet appears on these lines. read_file with ` +
                `start_line/end_line around one of them and copy the text again. Line endings ` +
                `and trailing whitespace are already handled for you — the mismatch is in the ` +
                `visible characters or the indentation.`,
            }
          : {
              hint:
                "read_file that region first and copy the target text verbatim, including " +
                "indentation. Line endings do not need to match.",
            }),
      };
    }

    if (occurrences > 1 && options.replaceAll !== true) {
      return {
        success: false,
        error: `old_text appears ${occurrences} times in ${resolved.relative}; refusing to guess.`,
        occurrences,
        matchStrategy: located.strategy,
        hint: "Extend old_text until it is unique, or pass replace_all: true if every occurrence should change.",
      };
    }

    /* The replacement adopts the file's own line endings. Without this a CRLF
     * file gains LF-only islands wherever the model edited it, which shows up
     * later as a whole-file diff in git. */
    const replacement = applyEol(newText, eol);

    // Splice from the end so earlier offsets stay valid.
    const targets = options.replaceAll
      ? [...located.matches].sort((a, b) => b.index - a.index)
      : [located.matches[0]];

    let after = before;
    for (const match of targets) {
      after = spliceAt(after, match, replacement);
    }

    if (after === before) {
      return {
        success: false,
        error: `The edit would not change ${resolved.relative} (new_text is identical to old_text).`,
        occurrences,
        matchStrategy: located.strategy,
      };
    }

    const backupPath = await this.backup(resolved.absolute, resolved.root);
    const replaced = targets.length;

    /* Only an EXACT match may be delegated to the extension's own replace_text:
     * its matcher is byte-exact, so a line-endings or whitespace match would
     * fail there for the very reason it was needed here. Non-exact matches are
     * pushed through write_file with the already-computed content. */
    if (this.isConnected()) {
      const bridgeMethod =
        located.strategy === "exact" ? "replace_text" : "write_file";
      try {
        const params =
          bridgeMethod === "replace_text"
            ? {
                path: resolved.relative,
                filePath: resolved.relative,
                file_path: resolved.relative,
                old_text: oldText,
                new_text: replacement,
                findText: oldText,
                replaceText: replacement,
                replace_all: options.replaceAll === true,
                replaceAll: options.replaceAll === true,
              }
            : {
                path: resolved.relative,
                filePath: resolved.relative,
                file_path: resolved.relative,
                content: after,
              };

        const result: any = await this.callTool(bridgeMethod, params);
        const ok = result?.success !== false;

        // A bridge that reports failure must not be treated as done: fall
        // through to fs rather than telling the model the edit landed.
        if (!ok)
          throw new Error(result?.error || "Extension reported failure.");

        return {
          success: true,
          path: resolved.relative,
          absolutePath: resolved.absolute,
          source: "vscode-bridge",
          occurrences,
          replaced,
          matchStrategy: located.strategy,
          fileLineEndings: eol,
          appliedVia: bridgeMethod,
          ...(located.strategy !== "exact"
            ? {
                note: `Matched ignoring ${
                  located.strategy === "line-endings"
                    ? "line-ending differences (file is " +
                      eol.toUpperCase() +
                      ")"
                    : "trailing whitespace"
                }; the file's own line endings were preserved.`,
              }
            : {}),
          backupPath,
          ...(result && typeof result === "object" ? { bridge: result } : {}),
        };
      } catch (err) {
        const bridgeError = err instanceof Error ? err.message : String(err);
        /* Same reasoning as writeFileSmart: when the editor refused or the
         * socket dropped, writing to `resolved.absolute` writes to the
         * SERVER's disk. `resolved.absolute` in multi-tenant mode is a display
         * string built from the user's own root — on Linux, joining a Windows
         * root produces something like `/app/C:\Users\priya\app/src/x.ts`,
         * which fs would happily create. A silent success that edited a file
         * nobody asked about is worse than a visible failure. */
        if (MULTI_TENANT) {
          return {
            success: false,
            error: `Your editor did not apply the edit to ${resolved.relative}: ${bridgeError}`,
            path: resolved.relative,
            root: resolved.root,
            hint: "Re-read the file — it may have changed — then try the edit again.",
          };
        }
        await fsp.writeFile(resolved.absolute, after, "utf-8");
        return {
          success: true,
          path: resolved.relative,
          absolutePath: resolved.absolute,
          source: "filesystem",
          occurrences,
          replaced,
          matchStrategy: located.strategy,
          fileLineEndings: eol,
          backupPath,
          bridgeError,
        };
      }
    }

    /* No editor attached at all. Locally that is the normal case and the
     * filesystem is the right target; on a shared server it means the request
     * arrived with no machine to act on, and the only correct answer is to say
     * so rather than to edit whatever happens to be on the host. */
    if (MULTI_TENANT) {
      return {
        success: false,
        error: NOT_CONNECTED_MESSAGE,
        path: resolved.relative,
        root: resolved.root,
      };
    }

    await fsp.writeFile(resolved.absolute, after, "utf-8");
    return {
      success: true,
      path: resolved.relative,
      absolutePath: resolved.absolute,
      source: "filesystem",
      occurrences,
      replaced,
      matchStrategy: located.strategy,
      fileLineEndings: eol,
      ...(located.strategy !== "exact"
        ? {
            note: `Matched ignoring ${
              located.strategy === "line-endings"
                ? "line-ending differences (file is " + eol.toUpperCase() + ")"
                : "trailing whitespace"
            }; the file's own line endings were preserved.`,
          }
        : {}),
      backupPath,
    };
  }

  /**
   * A reply arrived on ONE session's socket.
   *
   * The session is a parameter rather than being looked up, and that is the
   * whole point of the change. The previous version read
   * `this.pendingRequests.get(response.id)` — one map for the entire process —
   * so a reply arriving on any socket could settle a request that had been sent
   * on a different one. The ids were `req_<counter>`, minted from a single
   * counter, so two editors reconnecting in the wrong order was enough to have
   * one user's `read_file` resolved with another user's file contents. Scoping
   * the map to the session makes that unrepresentable: a reply can only ever
   * settle a request sent on the same socket.
   */
  private handleMessage(session: BridgeSession, raw: string) {
    let response: RPCResponse;
    try {
      response = JSON.parse(raw);
    } catch {
      return;
    }

    if (!response.id) return;

    const pending = session.pending.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    session.pending.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error));
    } else {
      pending.resolve(response.result);
    }
  }
}

declare global {
  /* eslint-disable-next-line no-var */
  var __omnirouteVscodeBridge: VSCodeBridgeManager | undefined;
}

/**
 * ONE MANAGER PER PROCESS, PINNED TO globalThis.
 *
 * This used to be a plain `new VSCodeBridgeManager()`, which is correct exactly
 * once — and this module is not evaluated once. `next dev` re-evaluates modules
 * on every hot reload, and `src/app/api/chat/route.ts` imports this file, so a
 * reload built a whole new manager: new session map, new listener, new attempt
 * to bind 20129.
 *
 * The second bind loses with EADDRINUSE, which arrives asynchronously and used
 * to be swallowed by a `console.warn`. The result was a split brain. The live
 * WebSocket stayed attached to the orphaned first manager, while the API routes
 * — freshly re-imported, pointing at the new one — asked a manager with an empty
 * session map whether an editor was connected. It said no, forever, and no
 * amount of reconnecting from VS Code could fix it, because reconnecting landed
 * back on the instance nobody was reading.
 *
 * `db.ts` learned this first and says so in its own header ("Next.js dev
 * re-evaluates modules on every hot reload... The handle now lives on
 * globalThis"). `documentRender.ts` and `otpDelivery.ts` followed. This file was
 * the last process-wide singleton still creating a fresh instance per
 * evaluation, and it was the one holding a listening TCP port — the single worst
 * kind of thing to duplicate.
 *
 * The pin is server-only. In a browser bundle the constructor is harmless
 * (`initialize()` returns immediately on `typeof window !== "undefined"`) and
 * there is no cross-module state worth sharing, so nothing is stored there.
 */
export const vscodeBridge: VSCodeBridgeManager =
  globalThis.__omnirouteVscodeBridge ?? new VSCodeBridgeManager();

if (typeof window === "undefined") {
  globalThis.__omnirouteVscodeBridge = vscodeBridge;
  /* Idempotent: on a reused instance the guard at the top of initialize() sees
   * a live `wss` and returns, so a hot reload does not re-bind. */
  vscodeBridge.initialize();
}

/* --------------------- shared tool schemas + dispatcher ------------------ */

/**
 * ONE definition of the workspace tools, imported by both the chat route and
 * the deep pipeline so the two can never drift apart again.
 *
 * `list_files` is listed FIRST and described in imperative terms on purpose:
 * its absence is why the agent used searchWeb to look for the user's own files
 * and then asked for paths by hand.
 */
export const WORKSPACE_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List real files in the user's VS Code workspace. ALWAYS call this before read_file, replace_text or write_file if you are not already certain a path exists. Never guess a path, never search the web for the user's own project layout, and never ask the user to paste paths — call this instead.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Directory to list, relative to the workspace root. Omit or use "" for the root itself.',
          },
          depth: {
            type: "number",
            description:
              "How many directory levels to descend. 1 = immediate children. Default 3, max 12.",
          },
          pattern: {
            type: "string",
            description:
              'Optional filter. A glob such as "*.tsx" or "src/**/route.ts", or a plain substring such as "page" or ".css".',
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from the workspace. Use start_line/end_line to page through a large file instead of re-reading all of it.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Path relative to the workspace root, or absolute.",
          },
          path: { type: "string" },
          start_line: { type: "number", description: "1-based, inclusive." },
          end_line: { type: "number", description: "1-based, inclusive." },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_text",
      description:
        "Replace a snippet inside an existing file. Prefer this over write_file for edits to large files. " +
        "old_text should match the visible characters and indentation of the target; LINE ENDINGS (CRLF vs LF) " +
        "and trailing whitespace are normalised automatically, and the file's own line-ending style is preserved " +
        "on write, so never retry a failed edit just to change line endings. If the snippet is not unique the call " +
        "fails and reports the match count — extend old_text instead of retrying the same call.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Path relative to the workspace root, or absolute.",
          },
          old_text: {
            type: "string",
            description: "Exact text to find, copied verbatim from read_file.",
          },
          new_text: { type: "string", description: "Replacement text." },
          replace_all: {
            type: "boolean",
            description:
              "Set true only when every occurrence really should change.",
          },
        },
        required: ["file_path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write a complete file to the workspace. Use for new files or a full rewrite; prefer replace_text for edits to existing large files.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Path relative to the workspace root, or absolute.",
          },
          path: { type: "string" },
          content: {
            type: "string",
            description: "Complete file contents.",
          },
        },
        required: ["file_path", "content"],
      },
    },
  },
];

export const WORKSPACE_TOOL_NAMES = new Set([
  "list_files",
  "read_file",
  "replace_text",
  "write_file",
]);

/**
 * Execute one workspace tool call and return a JSON string for the `tool`
 * message. Never throws — a thrown error inside a tool loop kills the whole
 * turn, whereas an error *result* lets the model correct itself.
 *
 * WHY `userId` IS REQUIRED AND NOT OPTIONAL
 *
 * This is the boundary between "a chat turn" and "somebody's filesystem", and
 * it is the only place that knows both. Everything below it reads the owner out
 * of the AsyncLocalStorage context this function establishes; nothing below it
 * takes a user id as an argument.
 *
 * The parameter is non-optional deliberately. An optional `userId?` would let a
 * forgotten call site keep compiling, and a forgotten call site is not a
 * cosmetic bug — it is a chat turn belonging to user A being executed against
 * whichever editor the process last thought of as "the" editor. Making it
 * required turns every such omission into a compile error, which is the only
 * kind of failure that is guaranteed to be noticed.
 *
 * `null` is a legitimate value and means "no signed-in user": an anonymous
 * turn, or the single-operator localhost case. In multi-tenant mode that
 * resolves to an owner with no session, and every file tool refuses. That is
 * the correct outcome — an anonymous caller on a shared server has no machine
 * of their own to act on.
 */
export async function executeWorkspaceTool(
  name: string,
  args: Record<string, any>,
  userId: string | null,
): Promise<string> {
  /* The context is entered synchronously and the whole awaited chain below
   * inherits it, so every `currentOwner()` call made while this promise is in
   * flight — however deep, however many awaits later — sees this user. Two
   * concurrent turns from two users interleave without ever reading each
   * other's owner, which a module-level "current user" variable could not
   * manage. */
  return withWorkspaceOwner(userId, () => runWorkspaceTool(name, args));
}

async function runWorkspaceTool(
  name: string,
  args: Record<string, any>,
): Promise<string> {
  const rawPath = String(
    args?.file_path ?? args?.path ?? args?.filePath ?? args?.dir ?? "",
  );

  try {
    switch (name) {
      case "list_files": {
        const result = await vscodeBridge.listFiles({
          dir: rawPath,
          depth: Number(args?.depth) || 3,
          pattern: typeof args?.pattern === "string" ? args.pattern : undefined,
          maxEntries: Number(args?.max_entries) || 400,
          includeDirs: args?.include_dirs !== false,
        });
        return JSON.stringify({
          ...result,
          entries: prioritiseEntries(result.entries),
          hint:
            result.entries.length === 0
              ? 'Nothing matched. Try depth: 5, drop the pattern, or list "" for the workspace root.'
              : "Use these paths verbatim in read_file / replace_text / write_file.",
        });
      }

      case "read_file":
        return JSON.stringify(
          await vscodeBridge.readFileSmart(rawPath, {
            startLine: Number(args?.start_line) || undefined,
            endLine: Number(args?.end_line) || undefined,
          }),
        );

      case "replace_text":
        return JSON.stringify(
          await vscodeBridge.replaceInFileSmart(
            rawPath,
            String(args?.old_text ?? args?.oldText ?? args?.search ?? ""),
            String(args?.new_text ?? args?.newText ?? args?.replace ?? ""),
            {
              replaceAll:
                args?.replace_all === true || args?.replaceAll === true,
            },
          ),
        );

      case "write_file":
        return JSON.stringify(
          await vscodeBridge.writeFileSmart(
            rawPath,
            typeof args?.content === "string" ? args.content : "",
          ),
        );

      default:
        return JSON.stringify({
          success: false,
          error: `Unknown workspace tool: ${name}`,
        });
    }
  } catch (err) {
    return JSON.stringify({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The workspace block for the system prompt, plus the rules that go with it.
 *
 * Takes the same required `userId` as `executeWorkspaceTool`, for the same
 * reason and with an extra one: the snapshot describes a specific machine. Built
 * without an owner it would describe whatever workspace happened to be cached,
 * and the model would open the turn holding a file listing from somebody else's
 * project — which is both a leak and a guarantee that every subsequent path it
 * quotes is wrong.
 */
export async function buildWorkspaceContext(
  userId: string | null,
): Promise<string> {
  return withWorkspaceOwner(userId, () => buildWorkspaceContextInner());
}

async function buildWorkspaceContextInner(): Promise<string> {
  let snapshot: string;
  try {
    snapshot = await vscodeBridge.workspaceSnapshot();
  } catch (err) {
    snapshot =
      "=== VS CODE WORKSPACE ===\n" +
      `could not be read: ${err instanceof Error ? err.message : String(err)}\n` +
      "Call list_files to discover the project yourself.\n" +
      "=== END VS CODE WORKSPACE ===";
  }

  return [
    snapshot,
    "",
    "FILE ACCESS RULES",
    "- The listing above is the real project on this machine. Use those paths verbatim.",
    "- If a path you need is not listed, call list_files (with a pattern or a bigger depth). Do NOT guess.",
    "- Never use searchWeb to look for the user's own files, and never ask the user to paste file paths.",
    "- read_file before replace_text, and copy old_text out of that result rather than from memory.",
    "- LINE ENDINGS ARE HANDLED FOR YOU. replace_text matches regardless of CRLF vs LF and",
    "  ignores trailing whitespace, then writes back in the file's own style. Never retry a failed",
    "  edit 'with Windows line endings' — that is not the problem, and repeating it wastes rounds.",
    "- If replace_text reports 0 matches it tells you which lines the first line of your snippet",
    "  appears on. Re-read those lines and fix the visible text or indentation. Do not resend the",
    "  identical call.",
    "- Relative paths are resolved against the workspace root shown above.",
    /* This line used to be unconditional, and in multi-tenant mode it became a
     * lie: `backup()` returns null there, because writing .omniroute-backups
     * would write it to the SERVER's disk, not the user's. A model told its
     * edits are reversible edits more boldly than one that knows they are not,
     * so the claim has to track the behaviour. */
    MULTI_TENANT
      ? "- Edits are applied by the user's editor and are NOT backed up by this server. The extension keeps its own checkpoint, but treat every edit as permanent: read before you write, and change the smallest region that does the job."
      : "- Every edit is backed up automatically, so make the edit rather than describing it.",
    "",
    /* Announcing the limits is not the enforcement — the dispatcher refusing is.
     * It is here because a model that does not know a file is off limits reads
     * the refusal, assumes a transient error, and tries the same file three
     * more ways. Each of those retries is a full round trip at this project's
     * ~85k input tokens, so saying it once up front is also the cheaper of the
     * two options. */
    getMatcherForUser(currentUserId()).promptSummary(),
    /* Appended, not interleaved, and empty when no reference project is set.
     *
     * Nothing about the reference project belongs in the block above: that one
     * describes the folder being edited, and mixing a second root into it is
     * how a model ends up quoting a path from project 1 as though it were a
     * path in project 2. Kept as its own headed section so the separation is
     * visible to the model as well as to us. */
    referencePromptBlock(currentUserId()),
  ].join("\n");
}
