/**
 * vscode-extension/src/referenceOps.ts
 * ---------------------------------------------------------------------------
 * The second folder, in read-only form.
 *
 * WHY THIS IS NOT IN fileOps.ts
 *
 * fileOps owns the folder that gets written to. This file owns the folder that
 * never does. Keeping them apart means there is no function anywhere that
 * takes a root as an argument and then writes to it — the write path resolves
 * its root through `getWorkspaceRoot()`, which has never heard of the
 * reference project, and every function here resolves through
 * `requireReferenceRoot()`, which has no caller that writes. A `readOnly`
 * boolean would have been one forgotten check away from the opposite.
 *
 * WHY THE ROOT IS PUSHED FROM THE SERVER AND HELD HERE
 *
 * The alternative is a `root` parameter on every call, and that turns any bug
 * in request routing into "the agent read a folder the user never offered".
 * Pushing it once — `set_reference_root` — makes the reference root a piece of
 * state the EDITOR owns: the same message that opens project 1 for reading is
 * the one that closes it, and a tool call carries no folder at all.
 *
 * WHAT THIS FILE STILL REFUSES AFTER THE PUSH
 *
 * Holding a path is not permission to read it. Every operation re-checks three
 * things at the moment of use, not once at set time:
 *
 *   1. the folder is open in THIS window,
 *   2. the user has approved it for OmniRoute,
 *   3. the specific path is not excluded by the user's file-access rules.
 *
 * Re-checked every call because all three can change while a chat is open —
 * a folder can be closed, consent can be revoked, and a rule can be added from
 * the web app mid-conversation. A check performed once at configuration time
 * would answer for a world that no longer exists.
 *
 * WHY THE FOLDER MUST BE OPEN IN THIS WINDOW
 *
 * Two reasons, and the second is the one that bites. Consent records are
 * per-folder and only ever created for folders VS Code has open, so a folder
 * that is not open cannot have been approved in any meaningful sense. And
 * `findFiles` only searches inside workspace folders: pointed anywhere else it
 * returns an empty list rather than an error, which would present as "the
 * reference project is empty" — a lie that is much worse than a refusal.
 *
 * The practical consequence, which the error messages state outright, is that
 * both projects belong in ONE VS Code window (File → Add Folder to Workspace).
 * Two separate windows cannot work: the bridge keeps one live editor per
 * account, so a second window evicts the first and the two flap.
 */

import * as vscode from "vscode";
import * as path from "path";
import { ConsentStore } from "./consent";
import { getExclusionMatcher, buildPruneGlob } from "./fileOps";

/* -------------------------------------------------------------------------
 * Caps
 *
 * Deliberately smaller than what the machine could manage. Everything here is
 * paid for twice — once in wall-clock time, once in the tokens the result
 * costs when it reaches the model — and a search that returns 400 hits has not
 * answered the question anyway.
 * ---------------------------------------------------------------------- */

const MAX_FIND_RESULTS = 5000;
const MAX_LIST_ENTRIES = 400;
const MAX_SEARCH_RESULTS = 60;
const MAX_SEARCH_FILES = 1500;
const MAX_SEARCHABLE_BYTES = 512 * 1024;
const MAX_SNIPPET_CHARS = 240;
const MAX_READ_BYTES = 2 * 1024 * 1024;

export interface ReferenceRoot {
  path: string;
  name: string;
}

export interface ReferenceEntry {
  path: string;
  kind: "file" | "dir";
}

export interface ReferenceMatch {
  path: string;
  line: number;
  text: string;
}

/* -------------------------------------------------------------------------
 * State
 * ---------------------------------------------------------------------- */

let referenceRoot: ReferenceRoot | null = null;
let consent: ConsentStore | null = null;

/**
 * Hand this module the consent store.
 *
 * Passed in rather than imported as a singleton because ConsentStore needs the
 * extension context to exist, and a module-level instance would be constructed
 * at import time — before `activate` has run.
 */
export function attachConsent(store: ConsentStore | null): void {
  consent = store;
}

/** The configured reference root, whether or not it is currently usable. */
export function getReferenceRoot(): ReferenceRoot | null {
  return referenceRoot;
}

/**
 * Is this folder the reference project?
 *
 * Exported for one caller, and that caller is load-bearing: the resolver that
 * picks the WRITABLE root walks approved folders in workspace order and takes
 * the first. If the reference folder happens to sort first — and "Add Folder
 * to Workspace" appends, so a user who adds the working project second lands
 * exactly there — the read-only folder would quietly become the one being
 * edited. The resolver skips it by asking this.
 */
export function isReferenceFolder(fsPath: string): boolean {
  if (!referenceRoot) return false;
  return samePath(fsPath, referenceRoot.path);
}

/**
 * Compare two paths for "same folder".
 *
 * Case-insensitive on Windows and macOS, case-sensitive on Linux, matching
 * what those filesystems actually do. Getting this wrong in the permissive
 * direction would be a security bug on Linux, where `/home/me/Work` and
 * `/home/me/work` are genuinely different folders; getting it wrong in the
 * strict direction on Windows would just make the feature look broken when a
 * user typed `c:\` instead of `C:\`.
 */
function samePath(a: string, b: string): boolean {
  const left = path.resolve(String(a ?? ""));
  const right = path.resolve(String(b ?? ""));
  if (process.platform === "linux") return left === right;
  return left.toLowerCase() === right.toLowerCase();
}

/** The open workspace folder matching this path, if there is one. */
function openFolderFor(fsPath: string): vscode.WorkspaceFolder | null {
  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    if (samePath(folder.uri.fsPath, fsPath)) return folder;
  }
  return null;
}

export interface SetReferenceRootResult {
  configured: boolean;
  path: string | null;
  name: string | null;
  /** The folder is open in this window. */
  open: boolean;
  /** The user has approved it for OmniRoute. */
  granted: boolean;
  /** What the user has to do next, or null when nothing. */
  reason: string | null;
}

/**
 * Accept the reference root the server pushed.
 *
 * Stores it even when it is not open or not approved, and reports why. That
 * combination is deliberate: the user configures this in a browser, and the
 * folder often is not open in VS Code yet at that moment. Refusing to store it
 * would mean the setting appeared not to save; storing it and reporting the
 * gap means the panel can say "now add it to your VS Code window", and the
 * next call succeeds without the user going back to the browser.
 *
 * Nothing becomes readable as a result of this call. Every read re-checks.
 */
export function setReferenceRoot(input: {
  path?: string | null;
  name?: string | null;
}): SetReferenceRootResult {
  const raw = typeof input?.path === "string" ? input.path.trim() : "";

  if (!raw) {
    referenceRoot = null;
    return {
      configured: false,
      path: null,
      name: null,
      open: false,
      granted: false,
      reason: null,
    };
  }

  const resolved = path.resolve(raw);
  const name =
    (typeof input?.name === "string" && input.name.trim()) ||
    path.basename(resolved) ||
    resolved;

  referenceRoot = { path: resolved, name };

  const folder = openFolderFor(resolved);
  const granted = Boolean(folder && consent?.isGranted(folder.uri.fsPath));

  /* If it is open but undecided, raise the prompt now rather than on the first
   * tool call. The alternative is a refusal in the middle of an answer, with
   * the consent prompt appearing behind the browser window the user is looking
   * at. */
  if (folder && !granted) {
    consent?.promptInBackground(folder);
  }

  return {
    configured: true,
    path: resolved,
    name,
    open: Boolean(folder),
    granted,
    reason: folder
      ? granted
        ? null
        : `"${name}" is open but not approved for OmniRoute yet. A prompt should be visible in VS Code — click Allow, or run "OmniRoute: Approve a Folder for File Access".`
      : `"${name}" is not open in this VS Code window. Use File → Add Folder to Workspace and add it alongside the project you are working in, then approve it. Both folders must be in the SAME window — a second window would disconnect this one.`,
  };
}

/**
 * The reference root, or a refusal that names the fix.
 *
 * Throws rather than returning null so no caller can forget to check, and the
 * messages are long on purpose: a refusal the model cannot act on becomes
 * three more attempts at the same file, each one a full round trip.
 */
function requireReferenceRoot(): string {
  if (!referenceRoot) {
    throw new Error(
      "No reference project is configured. Choose one in the web app under " +
        "Projects, then try again.",
    );
  }

  const folder = openFolderFor(referenceRoot.path);
  if (!folder) {
    throw new Error(
      `The reference project "${referenceRoot.name}" is not open in this VS Code window. ` +
        "Add it with File → Add Folder to Workspace, in the SAME window as the project being " +
        "edited, then approve it for OmniRoute. This will keep failing until that is done, so " +
        "do not retry — carry on using the working project.",
    );
  }

  if (!consent?.isGranted(folder.uri.fsPath)) {
    consent?.promptInBackground(folder);
    throw new Error(
      `OmniRoute is not approved to read "${referenceRoot.name}" yet. A prompt should be ` +
        'visible in VS Code — click "Allow", or run "OmniRoute: Approve a Folder for File ' +
        'Access". Until then nothing in that folder can be read.',
    );
  }

  return referenceRoot.path;
}

/* -------------------------------------------------------------------------
 * Path handling
 * ---------------------------------------------------------------------- */

/**
 * Resolve a relative path inside the reference root, or refuse.
 *
 * Two checks, and they are not the same check. Containment stops `../..` from
 * walking out of the folder the user approved. The exclusion verdict stops a
 * path that is inside it but that the user has told us never to read — a
 * `.env` in project 1 is exactly as private as a `.env` in project 2, and the
 * rules that protect one protect the other.
 */
function resolveInside(root: string, relativePath: string, isDir = false): string {
  const rel = String(relativePath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "");

  const target = path.resolve(root, rel);
  const back = path.relative(root, target);
  if (back.startsWith("..") || path.isAbsolute(back)) {
    throw new Error(
      `File access blocked: "${relativePath}" is outside the reference project. ` +
        "Only paths inside the approved folder can be read.",
    );
  }

  if (rel) {
    const verdict = getExclusionMatcher().decide(rel, isDir);
    if (verdict.excluded) {
      throw new Error(
        `File access blocked: ${verdict.reason ?? `"${rel}" is excluded.`} ` +
          "The same file-access rules apply to the reference project. This is enforced " +
          "inside the editor, so no other tool or spelling will reach it.",
      );
    }
  }

  return target;
}

/** Build the findFiles include pattern from a directory and an optional glob. */
function includeFor(relDir: string, pattern?: string): string {
  const glob = (pattern || "").trim();
  const base = relDir ? `${relDir}/` : "";
  if (!glob) return `${base}**/*`;
  /* A pattern with a separator is already a path shape and is used as written;
   * a bare one ("*.ts") is a filename filter and is applied at every depth. */
  if (glob.includes("/")) return `${base}${glob}`;
  return `${base}**/${glob}`;
}

/* -------------------------------------------------------------------------
 * list
 * ---------------------------------------------------------------------- */

export async function refListFiles(options: {
  dir?: string;
  depth?: number;
  pattern?: string;
}): Promise<{ entries: ReferenceEntry[]; truncated: boolean; root: string }> {
  const root = requireReferenceRoot();
  const relDir = String(options?.dir ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");

  if (relDir) resolveInside(root, relDir, true);

  const depth = Math.max(1, Math.min(12, Number(options?.depth) || 3));
  const matcher = getExclusionMatcher();

  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(vscode.Uri.file(root), includeFor(relDir, options?.pattern)),
    buildPruneGlob(matcher),
    MAX_FIND_RESULTS,
  );

  const entries: ReferenceEntry[] = [];
  const seenDirs = new Set<string>();
  let truncated = found.length >= MAX_FIND_RESULTS;

  for (const uri of found) {
    const rel = path.relative(root, uri.fsPath).replace(/\\/g, "/");
    if (!rel || matcher.test(rel, false)) continue;

    /* Depth is measured from the directory being listed, not from the root, so
     * `depth: 1` on a subdirectory means its immediate children rather than
     * nothing at all. */
    const inner = relDir ? rel.slice(relDir.length + 1) : rel;
    const segments = inner.split("/");
    if (segments.length > depth) {
      /* Too deep to show as a file, but its ancestor directories are still
       * part of the answer — that is what makes this a layout rather than a
       * flat list with holes in it. */
      let prefix = relDir;
      for (let i = 0; i < depth && i < segments.length - 1; i++) {
        prefix = prefix ? `${prefix}/${segments[i]}` : segments[i];
        if (seenDirs.has(prefix) || matcher.test(prefix, true)) continue;
        seenDirs.add(prefix);
        entries.push({ path: prefix, kind: "dir" });
      }
      truncated = true;
      continue;
    }

    let prefix = relDir;
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i];
      if (seenDirs.has(prefix) || matcher.test(prefix, true)) continue;
      seenDirs.add(prefix);
      entries.push({ path: prefix, kind: "dir" });
    }

    entries.push({ path: rel, kind: "file" });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  if (entries.length > MAX_LIST_ENTRIES) {
    return {
      entries: entries.slice(0, MAX_LIST_ENTRIES),
      truncated: true,
      root,
    };
  }

  return { entries, truncated, root };
}

/* -------------------------------------------------------------------------
 * read
 * ---------------------------------------------------------------------- */

export async function refReadFile(options: {
  path?: string;
  startLine?: number;
  endLine?: number;
}): Promise<{ path: string; content: string; totalLines: number; size: number }> {
  const root = requireReferenceRoot();
  const rel = String(options?.path ?? "").trim();
  if (!rel) {
    throw new Error("Missing 'path' parameter for ref_read_file.");
  }

  const target = resolveInside(root, rel);
  const uri = vscode.Uri.file(target);

  /* Size is checked before the read rather than after. A 200 MB file read into
   * a string to discover it is a 200 MB file is how an extension host runs out
   * of memory, and the reference project is somebody else's repository — there
   * is no telling what is in it. */
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(
      `"${rel}" is ${Math.round(stat.size / 1024)} KB, too large to read from the reference ` +
        "project. Use ref_search to find the part you need and read a line range around it.",
    );
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  const content = Buffer.from(bytes).toString("utf-8");
  const lines = content.split(/\r?\n/);

  const explicit = Boolean(options?.startLine || options?.endLine);
  if (!explicit) {
    return {
      path: rel.replace(/\\/g, "/"),
      content,
      totalLines: lines.length,
      size: stat.size,
    };
  }

  const start = Math.max(1, Math.floor(Number(options.startLine) || 1));
  const end = Math.min(
    lines.length,
    Math.floor(Number(options.endLine) || lines.length),
  );

  return {
    path: rel.replace(/\\/g, "/"),
    content: lines.slice(start - 1, Math.max(start, end)).join("\n"),
    totalLines: lines.length,
    size: stat.size,
  };
}

/* -------------------------------------------------------------------------
 * search
 * ---------------------------------------------------------------------- */

/**
 * Content search over the reference project.
 *
 * HAND-ROLLED BECAUSE THE API IS NOT AVAILABLE
 *
 * `vscode.workspace.findTextInFiles` — which would do this properly, using the
 * same ripgrep the editor's own search uses — is a PROPOSED API. A stable
 * extension published as a `.vsix` cannot call it; VS Code refuses to activate
 * an extension that declares proposed APIs unless it is running in a special
 * development mode. So this opens the files itself, and the caps above are
 * what stop that being a bad idea.
 *
 * Substring, not regular expression. A model-supplied regex against a large
 * file is a pathological-backtracking denial of service waiting to happen, and
 * the queries that matter here — an identifier, an import, a distinctive
 * phrase — are ones substring matching handles exactly as well.
 */
export async function refSearch(options: {
  query?: string;
  pattern?: string;
  maxResults?: number;
  caseSensitive?: boolean;
}): Promise<{
  matches: ReferenceMatch[];
  scanned: number;
  truncated: boolean;
  root: string;
}> {
  const root = requireReferenceRoot();
  const query = String(options?.query ?? "").trim();
  if (!query) {
    throw new Error("Missing 'query' parameter for ref_search.");
  }

  const limit = Math.max(
    1,
    Math.min(MAX_SEARCH_RESULTS, Number(options?.maxResults) || 30),
  );
  const caseSensitive = options?.caseSensitive === true;
  const needle = caseSensitive ? query : query.toLowerCase();
  const matcher = getExclusionMatcher();

  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(vscode.Uri.file(root), includeFor("", options?.pattern)),
    buildPruneGlob(matcher),
    MAX_FIND_RESULTS,
  );

  const matches: ReferenceMatch[] = [];
  let scanned = 0;
  let truncated = false;

  for (const uri of found) {
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    if (scanned >= MAX_SEARCH_FILES) {
      truncated = true;
      break;
    }

    const rel = path.relative(root, uri.fsPath).replace(/\\/g, "/");
    if (!rel || matcher.test(rel, false)) continue;

    let content: string;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_SEARCHABLE_BYTES) continue;
      const bytes = await vscode.workspace.fs.readFile(uri);
      /* A NUL in the first kilobyte means binary. Searching a compiled
       * artifact for an identifier finds it, reports a line number that means
       * nothing, and hands back a snippet of mojibake. */
      if (bytes.subarray(0, 1024).includes(0)) continue;
      content = Buffer.from(bytes).toString("utf-8");
    } catch {
      continue;
    }
    scanned++;

    /* One cheap test on the whole file first: most files do not contain the
     * needle, and splitting into lines to find that out is the expensive way
     * to learn nothing. */
    const haystack = caseSensitive ? content : content.toLowerCase();
    if (!haystack.includes(needle)) continue;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = caseSensitive ? lines[i] : lines[i].toLowerCase();
      if (!line.includes(needle)) continue;
      matches.push({
        path: rel,
        line: i + 1,
        text: lines[i].trim().slice(0, MAX_SNIPPET_CHARS),
      });
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
    }
  }

  return { matches, scanned, truncated, root };
}
