/**
 * src/lib/referenceProject.ts
 * ---------------------------------------------------------------------------
 * The read-only second project: searching and reading project 1 while the
 * agent works in project 2.
 *
 * WHY THIS IS A SEPARATE MODULE FROM vscodeBridge.ts
 *
 * Because "read-only" should be a property of the code, not a rule somebody
 * has to remember. Every function in this file reaches the reference folder,
 * and none of them can write — there is no write RPC here to call, and the
 * three that exist take no destination. The write path lives in vscodeBridge
 * and resolves its root through `workspaceRoot()`, which has never heard of
 * this file. Two roots, two modules, no shared function that could be handed
 * the wrong one.
 *
 * WHAT THE MODEL IS AND IS NOT GIVEN
 *
 * Not a file map. Not an index. Not a structure summary at the start of the
 * chat. The reference project is a second codebase — often a large one — and
 * loading any part of it up front would add tens of thousands of input tokens
 * to every single turn, including the great majority of turns that never need
 * it. The tools are pull-only: the model searches for a phrase, gets a handful
 * of `file:line` hits back, and reads the one region it actually wants. A turn
 * that does not mention project 1 costs three extra tool *definitions*, and
 * nothing else.
 *
 * WHY SEARCH IS THE PRIMARY TOOL AND LISTING IS THE FALLBACK
 *
 * "How did I do X in the other project" is the real question, and a directory
 * listing is a terrible way to answer it: the model has to guess filenames,
 * read whole files to check, and usually guess wrong twice first. A content
 * search answers it in one call and returns the line, so the follow-up read is
 * a 60-line window instead of a 2000-line file. The tool descriptions say so
 * in as many words, because the order the model tries things in is decided
 * almost entirely by those sentences.
 * ------------------------------------------------------------------------- */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { isMultiTenantBridge } from "@/lib/deploymentMode";
import { getMatcherForUser } from "@/lib/fileExclusionStore";
import {
  ReferenceProject,
  activeReferenceProject,
} from "@/lib/referenceProjectStore";
import {
  makeMatcher,
  prioritiseEntries,
  vscodeBridge,
  walkWorkspace,
  withWorkspaceOwner,
  WorkspaceEntry,
} from "@/lib/vscodeBridge";

/* eslint-disable @typescript-eslint/no-explicit-any */

const MULTI_TENANT = isMultiTenantBridge();

/* -------------------------------------------------------------------------
 * Caps
 *
 * Every one of these exists to keep a single tool call from becoming a bigger
 * context cost than the answer is worth. They are generous enough that hitting
 * one means the model asked a question that was too broad, and each limit
 * reports itself in the result so the model can narrow the next call instead
 * of assuming it has seen everything.
 * ---------------------------------------------------------------------- */

/** Matches returned by one search. */
const MAX_SEARCH_RESULTS = 60;
/** Files opened by one local search before it gives up and says so. */
const MAX_SEARCH_FILES = 1500;
/** A file bigger than this is not searched — it is a bundle, not source. */
const MAX_SEARCHABLE_BYTES = 512 * 1024;
/** Characters returned by one reference read. */
const MAX_REFERENCE_CHARS = 60_000;
/** Lines returned when the model does not ask for a range. */
const DEFAULT_READ_LINES = 400;
/** Characters of the matching line kept in a search hit. */
const MAX_SNIPPET_CHARS = 240;

export interface ReferenceSearchHit {
  path: string;
  line: number;
  text: string;
}

/* -------------------------------------------------------------------------
 * Tool definitions
 * ---------------------------------------------------------------------- */

/**
 * The three tools, offered only when a reference project is configured.
 *
 * The descriptions carry two jobs beyond naming the arguments. They say the
 * folder is read-only, in the same sentence as what it is for, because a model
 * that does not know will try `write_file` against a reference path and burn a
 * round discovering it cannot. And they push search ahead of listing, because
 * left to itself a model lists a directory, reads four files whole, and
 * answers a question that one search would have settled.
 */
export const REFERENCE_TOOLS = [
  {
    type: "function",
    function: {
      name: "ref_search",
      description:
        "Search the READ-ONLY reference project for a phrase and get back matching lines with their file and line number. This is the right first move whenever you want to know how something was done in the other project — far cheaper and more accurate than listing directories and reading files to find out. The reference project is a SEPARATE codebase from the one you are editing: you can never write to it, and its paths are not valid paths in the working project.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Text to find. A function name, a component name, an import, a distinctive string. Matched case-insensitively unless case_sensitive is set.",
          },
          pattern: {
            type: "string",
            description:
              'Optional file filter, e.g. "*.ts" or "src/**/*.tsx". Narrow with this when the query is a common word.',
          },
          max_results: {
            type: "number",
            description: `Cap on matches returned. Default 30, maximum ${MAX_SEARCH_RESULTS}.`,
          },
          case_sensitive: { type: "boolean" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ref_read_file",
      description:
        "Read a file from the READ-ONLY reference project. Use the path exactly as ref_search reported it, and pass start_line/end_line to read only the region around a match rather than the whole file. Reading this file does NOT put it in the working project — to use something from it you still have to write the code into the working project yourself.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Path relative to the reference project's root.",
          },
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
      name: "ref_list_files",
      description:
        "List files in the READ-ONLY reference project. Use this only for questions about its layout — for anything you could phrase as a search, ref_search costs far less and answers more precisely.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Directory relative to the reference project root. Omit or use "" for the root.',
          },
          depth: {
            type: "number",
            description: "Levels to descend. Default 3, max 12.",
          },
          pattern: {
            type: "string",
            description: 'Optional glob or substring filter, e.g. "*.tsx".',
          },
        },
      },
    },
  },
];

export const REFERENCE_TOOL_NAMES = new Set([
  "ref_search",
  "ref_read_file",
  "ref_list_files",
]);

/**
 * The reference tools for this user, or none.
 *
 * Offered per request rather than baked into a constant because whether they
 * exist depends on a setting, and a tool the model is shown but cannot use is
 * worse than no tool at all: it will call it, get a refusal, and spend a round
 * finding out. When nothing is configured the model is never told any of this
 * is possible.
 */
export function referenceToolsFor(userId: string | null): any[] {
  return activeReferenceProject(userId || "") ? [...REFERENCE_TOOLS] : [];
}

/* -------------------------------------------------------------------------
 * Prompt
 *
 * `referencePromptBlock` deliberately lives in referenceProjectStore, not
 * here. vscodeBridge needs it to build the system prompt, and this module
 * imports vscodeBridge — putting it here would close an import cycle between
 * the two largest modules on the server path. The store has no imports of its
 * own beyond the database, so it is the safe end of the dependency to hang it
 * from.
 * ---------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
 * Execution
 * ---------------------------------------------------------------------- */

/**
 * Run one reference tool and return a JSON string for the `tool` message.
 *
 * Mirrors `executeWorkspaceTool`: it establishes the owner context, and it
 * never throws — an error inside a tool loop kills the turn, whereas an error
 * *result* is something the model can read and correct.
 */
export async function executeReferenceTool(
  name: string,
  args: Record<string, any>,
  userId: string | null,
): Promise<string> {
  return withWorkspaceOwner(userId, async () => {
    const reference = activeReferenceProject(userId || "");
    if (!reference) {
      return JSON.stringify({
        success: false,
        error:
          "No reference project is configured, so there is nothing to read. " +
          "Ask the user to choose one in Projects, or work from the current " +
          "project only.",
      });
    }

    try {
      switch (name) {
        case "ref_search":
          return JSON.stringify(
            await searchReference(userId, reference, {
              query: String(args?.query ?? ""),
              pattern:
                typeof args?.pattern === "string" ? args.pattern : undefined,
              maxResults: Number(args?.max_results) || 30,
              caseSensitive: args?.case_sensitive === true,
            }),
          );

        case "ref_read_file":
          return JSON.stringify(
            await readReference(
              userId,
              reference,
              String(args?.file_path ?? args?.path ?? ""),
              {
                startLine: Number(args?.start_line) || undefined,
                endLine: Number(args?.end_line) || undefined,
              },
            ),
          );

        case "ref_list_files":
          return JSON.stringify(
            await listReference(userId, reference, {
              dir: String(args?.path ?? args?.dir ?? ""),
              depth: Number(args?.depth) || 3,
              pattern:
                typeof args?.pattern === "string" ? args.pattern : undefined,
            }),
          );

        default:
          return JSON.stringify({
            success: false,
            error: `Unknown reference tool: ${name}`,
          });
      }
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: describeFailure(err),
      });
    }
  });
}

/**
 * Turn an RPC failure into something the model can act on.
 *
 * The version-skew case is called out by name because it is the one failure
 * the model must NOT retry: an extension that does not know `ref_read_file`
 * will not know it on the second attempt either, and the fix is a human
 * reinstalling something.
 */
function describeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/unsupported message action/i.test(message)) {
    return (
      "The connected VS Code extension is too old to open a reference project. " +
      "This will not succeed on a retry — the user has to reinstall the " +
      "extension from Connect VS Code. Carry on using the working project only."
    );
  }
  return message;
}

/* ------------------------------ containment ----------------------------- */

/**
 * Normalise a model-supplied path and refuse the ones that escape.
 *
 * Absolute paths are refused outright rather than resolved. In the deployed
 * case the reference root is on someone else's machine and this process cannot
 * reason about its shape at all; in the local case an absolute path is simply
 * a way to leave the folder. Neither is worth supporting when every tool
 * description already asks for a relative path, and `ref_search` hands back
 * exactly that.
 */
function relativeInReference(rawPath: string): string {
  const cleaned = String(rawPath ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");

  if (!cleaned) {
    throw new Error("A file path is required.");
  }
  if (cleaned.startsWith("/") || /^[A-Za-z]:\//.test(cleaned)) {
    throw new Error(
      `Use a path relative to the reference project root, not an absolute one ("${cleaned}"). ` +
        "ref_search reports paths in exactly the form this tool wants.",
    );
  }
  if (cleaned.split("/").some((segment) => segment === "..")) {
    throw new Error(
      `"${cleaned}" tries to leave the reference project. Only paths inside it can be read.`,
    );
  }
  return cleaned;
}

/**
 * The user's exclusion rules, applied to the reference project too.
 *
 * Same rules, same engine, same reasons — a `.env` in project 1 is exactly as
 * private as a `.env` in project 2, and a second set of rules for the second
 * folder would be the fourth denylist this codebase has spent real effort
 * getting rid of.
 */
function guardExcluded(userId: string | null, rel: string, isDir = false): void {
  const verdict = getMatcherForUser(userId || "").decide(rel, isDir);
  if (verdict.excluded) {
    throw new Error(
      `File access blocked: ${verdict.reason ?? `"${rel}" is excluded.`} ` +
        "The same rules apply to the reference project as to the working one.",
    );
  }
}

/* -------------------------------- reading -------------------------------- */

interface ReadRange {
  startLine?: number;
  endLine?: number;
}

async function readReference(
  userId: string | null,
  reference: ReferenceProject,
  rawPath: string,
  range: ReadRange,
): Promise<any> {
  const rel = relativeInReference(rawPath);
  guardExcluded(userId, rel);

  const viaEditor = vscodeBridge.connectionInfo().connected;
  const content = viaEditor
    ? await readViaEditor(rel, range)
    : await readViaDisk(reference, rel);

  return sliceForModel(rel, content, range, reference);
}

async function readViaEditor(rel: string, range: ReadRange): Promise<string> {
  /* The range is forwarded so an extension that can page a file does not send
   * the whole thing over the socket; the slice below is applied again on
   * whatever comes back, so a reply that ignored the range is still trimmed
   * before it reaches the model. */
  const result = await vscodeBridge.callTool<any>(
    "ref_read_file",
    {
      path: rel,
      file_path: rel,
      start_line: range.startLine,
      end_line: range.endLine,
    },
    20000,
  );
  const content = result?.content ?? result?.text ?? result;
  if (typeof content !== "string") {
    throw new Error(
      `The editor did not return the contents of "${rel}" from the reference project.`,
    );
  }
  return content;
}

/**
 * The local-install path: read the reference folder off this machine's disk.
 *
 * Refused outright on a shared server. The reference root there is a path on
 * the user's own computer, so resolving it here would either fail or — much
 * worse — find a same-named folder belonging to the operator and read that
 * instead. The bridge is the only correct way to reach a user's files on a
 * deployment, and "no editor connected" is the honest answer.
 */
async function readViaDisk(
  reference: ReferenceProject,
  rel: string,
): Promise<string> {
  assertLocalReadAllowed();
  const absolute = path.resolve(reference.path, rel);
  const relativeBack = path.relative(path.resolve(reference.path), absolute);
  if (relativeBack.startsWith("..") || path.isAbsolute(relativeBack)) {
    throw new Error(
      `"${rel}" resolves outside the reference project. Refusing to read it.`,
    );
  }
  return fsp.readFile(absolute, "utf-8");
}

function assertLocalReadAllowed(): void {
  if (MULTI_TENANT) {
    throw new Error(
      "No VS Code editor is connected, so the reference project cannot be " +
        "reached. It lives on the user's machine, not on this server.",
    );
  }
}

/**
 * Cut the returned text down to something worth sending.
 *
 * A reference file is being consulted, not maintained, so the default is a
 * window rather than the whole thing — and when the window is not the whole
 * file, the result says exactly which lines it holds and how many there are.
 * Silently truncating is the failure that makes a model confidently describe
 * the second half of a file it never saw.
 */
function sliceForModel(
  rel: string,
  content: string,
  range: ReadRange,
  reference: ReferenceProject,
): any {
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;

  const explicit = Boolean(range.startLine || range.endLine);
  const start = Math.max(1, Math.floor(range.startLine || 1));
  const end = Math.min(
    totalLines,
    Math.floor(range.endLine || (explicit ? totalLines : start + DEFAULT_READ_LINES - 1)),
  );

  if (start > totalLines) {
    return {
      success: false,
      project: reference.name,
      path: rel,
      totalLines,
      error: `start_line ${start} is past the end of the file, which has ${totalLines} lines.`,
    };
  }

  let text = lines.slice(start - 1, Math.max(start, end)).join("\n");
  let charTruncated = false;
  if (text.length > MAX_REFERENCE_CHARS) {
    text = text.slice(0, MAX_REFERENCE_CHARS);
    charTruncated = true;
  }

  const truncated = charTruncated || end < totalLines || start > 1;

  return {
    success: true,
    project: reference.name,
    readOnly: true,
    path: rel,
    startLine: start,
    endLine: end,
    totalLines,
    truncated,
    content: text,
    ...(truncated
      ? {
          hint:
            `Showing lines ${start}-${end} of ${totalLines}. ` +
            "Call ref_read_file again with start_line/end_line for another region — " +
            "and only if you actually need it.",
        }
      : {}),
  };
}

/* ------------------------------- listing --------------------------------- */

async function listReference(
  userId: string | null,
  reference: ReferenceProject,
  options: { dir: string; depth: number; pattern?: string },
): Promise<any> {
  const dir = options.dir
    ? relativeInReference(options.dir).replace(/\/+$/, "")
    : "";
  if (dir) guardExcluded(userId, dir, true);

  const matcher = getMatcherForUser(userId || "");
  const keep = (entry: WorkspaceEntry) =>
    !matcher.test(entry.path, entry.kind === "dir");

  let entries: WorkspaceEntry[] = [];
  let truncated = false;

  if (vscodeBridge.connectionInfo().connected) {
    const result = await vscodeBridge.callTool<any>(
      "ref_list_files",
      { path: dir, dir, depth: options.depth, pattern: options.pattern },
      20000,
    );
    const raw = Array.isArray(result?.files)
      ? result.files
      : Array.isArray(result?.entries)
        ? result.entries
        : [];
    const matches = makeMatcher(options.pattern);
    entries = raw
      .map((entry: any) => ({
        path: String(entry?.path ?? entry ?? "").replace(/\\/g, "/"),
        kind: (entry?.kind === "dir" ? "dir" : "file") as "dir" | "file",
      }))
      .filter((entry: WorkspaceEntry) => entry.path && matches(entry.path));
    truncated = result?.truncated === true;
  } else {
    assertLocalReadAllowed();
    const walked = await walkWorkspace(reference.path, dir, {
      depth: options.depth,
      pattern: options.pattern,
      maxEntries: 400,
      includeDirs: true,
    });
    entries = walked.entries;
    truncated = walked.truncated;
  }

  const visible = prioritiseEntries(entries.filter(keep));

  return {
    success: true,
    project: reference.name,
    readOnly: true,
    dir,
    truncated,
    fileCount: visible.filter((e) => e.kind === "file").length,
    entries: visible,
    hint:
      visible.length === 0
        ? "Nothing matched in the reference project. Try ref_search instead — it finds files by what is in them."
        : "These paths belong to the REFERENCE project. Use them with ref_read_file only, never with read_file or write_file.",
  };
}

/* -------------------------------- search --------------------------------- */

interface SearchOptions {
  query: string;
  pattern?: string;
  maxResults: number;
  caseSensitive: boolean;
}

async function searchReference(
  userId: string | null,
  reference: ReferenceProject,
  options: SearchOptions,
): Promise<any> {
  const query = options.query.trim();
  if (!query) {
    return {
      success: false,
      error: "A search query is required.",
    };
  }

  const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, options.maxResults));
  const matcher = getMatcherForUser(userId || "");

  let hits: ReferenceSearchHit[] = [];
  let scanned = 0;
  let truncated = false;

  if (vscodeBridge.connectionInfo().connected) {
    const result = await vscodeBridge.callTool<any>(
      "ref_search",
      {
        query,
        pattern: options.pattern,
        max_results: limit,
        case_sensitive: options.caseSensitive,
      },
      25000,
    );
    const raw = Array.isArray(result?.matches) ? result.matches : [];
    hits = raw
      .map((hit: any) => ({
        path: String(hit?.path ?? "").replace(/\\/g, "/"),
        line: Number(hit?.line) || 0,
        text: String(hit?.text ?? "").slice(0, MAX_SNIPPET_CHARS),
      }))
      .filter((hit: ReferenceSearchHit) => hit.path);
    scanned = Number(result?.scanned) || 0;
    truncated = result?.truncated === true;
  } else {
    assertLocalReadAllowed();
    const local = await searchOnDisk(reference.path, query, options, limit);
    hits = local.hits;
    scanned = local.scanned;
    truncated = local.truncated;
  }

  /* Filtered again here even though the editor filters too. The rules are the
   * user's and this process is the one that holds them; the editor's copy is a
   * push that may be a version behind. Neither end is trusted to be the only
   * one that checked. */
  const visible = hits.filter((hit) => !matcher.test(hit.path, false));

  return {
    success: true,
    project: reference.name,
    readOnly: true,
    query,
    filesScanned: scanned,
    matchCount: visible.length,
    truncated: truncated || visible.length >= limit,
    matches: visible.slice(0, limit),
    hint:
      visible.length === 0
        ? "No match in the reference project. Try a shorter or more distinctive phrase, or drop the file pattern."
        : "Read only the regions you need: ref_read_file with start_line/end_line around a match.",
  };
}

/**
 * Content search over a folder on this machine.
 *
 * Plain substring matching, not a regular expression. A model-supplied regex
 * is a denial-of-service waiting to happen — one nested quantifier against a
 * 500 KB minified file is a pathological backtrack that pins a CPU — and the
 * queries that matter here are identifiers and phrases, which substring
 * matching handles exactly as well.
 */
async function searchOnDisk(
  root: string,
  query: string,
  options: SearchOptions,
  limit: number,
): Promise<{ hits: ReferenceSearchHit[]; scanned: number; truncated: boolean }> {
  const { entries } = await walkWorkspace(root, "", {
    depth: 12,
    maxEntries: MAX_SEARCH_FILES,
    pattern: options.pattern,
    includeDirs: false,
  });

  const needle = options.caseSensitive ? query : query.toLowerCase();
  const hits: ReferenceSearchHit[] = [];
  let scanned = 0;
  let truncated = false;

  for (const entry of entries) {
    if (hits.length >= limit) {
      truncated = true;
      break;
    }
    if (entry.kind !== "file") continue;
    if (typeof entry.bytes === "number" && entry.bytes > MAX_SEARCHABLE_BYTES) {
      continue;
    }

    let content: string;
    try {
      content = await fsp.readFile(path.join(root, entry.path), "utf-8");
    } catch {
      continue;
    }
    scanned++;

    /* A cheap whole-file test first: most files do not contain the needle at
     * all, and splitting a file into lines to discover that is the expensive
     * way to find out. */
    const haystack = options.caseSensitive ? content : content.toLowerCase();
    if (!haystack.includes(needle)) continue;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = options.caseSensitive ? lines[i] : lines[i].toLowerCase();
      if (!line.includes(needle)) continue;
      hits.push({
        path: entry.path,
        line: i + 1,
        text: lines[i].trim().slice(0, MAX_SNIPPET_CHARS),
      });
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
    }
  }

  return { hits, scanned, truncated };
}

/* -------------------------------------------------------------------------
 * Status, for the settings panel
 * ---------------------------------------------------------------------- */

/**
 * Whether the configured reference folder is one this process could actually
 * reach right now, and why not when it cannot.
 *
 * The panel needs this because "I saved a reference project" and "the agent
 * can read it" are different claims, and the gap between them (no editor
 * connected, folder not approved, extension too old) is exactly where a user
 * would otherwise conclude the feature is broken.
 */
export function referenceReachability(userId: string | null): {
  configured: boolean;
  reachable: boolean;
  reason: string | null;
} {
  const reference = activeReferenceProject(userId || "");
  if (!reference) {
    return { configured: false, reachable: false, reason: null };
  }
  /* Wrapped because `connectionInfo()` resolves the session from the ambient
   * owner, and this is called from a route rather than from inside a tool
   * loop. Unwrapped it would ask whether the *local* owner has an editor,
   * which on a deployment is a question about nobody. */
  const connected = withWorkspaceOwner(
    userId,
    () => vscodeBridge.connectionInfo().connected,
  );
  if (connected) {
    return { configured: true, reachable: true, reason: null };
  }
  if (MULTI_TENANT) {
    return {
      configured: true,
      reachable: false,
      reason:
        "No VS Code window is connected, so the reference project cannot be read yet.",
    };
  }
  if (!fs.existsSync(reference.path)) {
    return {
      configured: true,
      reachable: false,
      reason: `This server cannot see ${reference.path}. Connect VS Code, or check the path.`,
    };
  }
  return { configured: true, reachable: true, reason: null };
}
