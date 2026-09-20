/**
 * src/lib/agentContext.ts
 * ---------------------------------------------------------------------------
 * The context-file layer: durable, human-readable, version-controllable state
 * that lets an agent run survive process death, iteration exhaustion, and the
 * end of a chat session.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Deep Cowork run used to hold everything in memory. When the iteration
 * budget ran out the whole conversation was thrown away and the only thing the
 * user got was:
 *
 *     Stopped after 12 tool rounds on Free Stack without a final answer.
 *
 * Every file the model had read, every edit it had landed, and every dead end
 * it had already ruled out died with that message. Saying "continue" in a new
 * chat started from nothing and re-did the same reads.
 *
 * Now every run owns a task artifact on disk. It records the request, the
 * resolved workspace root, a step checklist, the files read (with hashes), the
 * edits applied, and a `Next` line. Resuming reads that file instead of
 * replaying the work.
 *
 * WHERE THE FILES LIVE
 * --------------------
 * Inside the TARGET project, not inside omniroute-coder:
 *
 *   <active-workspace>/.omniroute/
 *     tasks/2026-09-09-143020-frosted-glass-nav.md
 *     knowledge/app-py-uses-crlf.md
 *     journal.md
 *
 * That is deliberate. Knowledge about a project belongs to that project: it can
 * be committed next to the code it describes, reviewed in a diff, and edited by
 * hand. A central store in omniroute-coder would divorce the two.
 *
 * FILE FORMAT
 * -----------
 * Each task file is markdown for humans with one fenced `json` block named
 * `omniroute:state` for machines. Prose can be edited freely without breaking
 * the parser, and the parser never has to guess: if the JSON block is missing
 * or corrupt the file is treated as unresumable rather than half-understood.
 *
 * Nothing here throws. A read-only or full disk must degrade the agent to its
 * old stateless behaviour, never break a chat turn.
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { databasePath } from "@/lib/db";
import { isMultiTenantBridge } from "@/lib/deploymentMode";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const CONTEXT_DIR = ".omniroute";
export const TASKS_DIR = "tasks";
export const KNOWLEDGE_DIR = "knowledge";
export const JOURNAL_FILE = "journal.md";

/** Marker for the machine-readable block inside a task file. */
const STATE_FENCE_OPEN = "```json omniroute:state";
const STATE_FENCE_CLOSE = "```";

/** Cap the arrays that grow per round so a long run cannot bloat the file. */
const MAX_RECORDED_READS = 120;
const MAX_RECORDED_EDITS = 200;
const MAX_RECORDED_FAILURES = 60;
const MAX_JOURNAL_BYTES = 256 * 1024;

export type TaskStatus =
  | "planning" // plan being drafted, no edits permitted yet
  | "awaiting-approval" // plan written, waiting on the human
  | "executing" // approved, edits in flight
  | "stalled" // budget exhausted or a hard blocker; resumable
  | "complete"
  | "abandoned";

export interface TaskStep {
  /** 1-based, stable across rewrites so `Next` can point at one. */
  index: number;
  text: string;
  status: "todo" | "doing" | "done" | "skipped";
  note?: string;
}

export interface RecordedRead {
  path: string;
  /** sha256 of the content actually returned, first 16 chars */
  hash: string;
  /**
   * Which slice of the file was read, as "start-end" (e.g. "1-400", "401-end").
   * Empty/absent means the whole file.
   *
   * This exists because progress used to be keyed on the bare path. A large file
   * is legitimately read in pages — `read_file`'s own truncation notice tells the
   * model to page it with start_line/end_line — so every page after the first
   * collapsed onto the same key, scored zero fresh reads, and tripped the stall
   * abort precisely when the model was doing the right thing.
   */
  span?: string;
  totalLines?: number;
  at: string;
}

export interface RecordedEdit {
  path: string;
  tool: "replace_text" | "write_file";
  ok: boolean;
  detail?: string;
  at: string;
}

export interface RecordedFailure {
  tool: string;
  path: string;
  /** Stable fingerprint of the call, used to spot exact repeats. */
  signature: string;
  error: string;
  at: string;
}

/**
 * How badly a Reviewer finding should block the run.
 * `blocker` and `major` send the work back to the editor; `minor` and `note`
 * are reported but do not cost a fix cycle.
 */
export type ReviewSeverity = "blocker" | "major" | "minor" | "note";

export interface ReviewFinding {
  severity: ReviewSeverity;
  /** File the finding is about, when the reviewer named one. */
  path?: string;
  /** What is wrong, in one sentence. */
  text: string;
}

export interface ReviewResult {
  /** True when nothing blocker/major was found. */
  passed: boolean;
  findings: ReviewFinding[];
  /** One-line summary the reviewer gave. */
  summary: string;
  /** Which fix cycle produced this verdict (1-based). */
  cycle: number;
  /** Model that performed the audit — meaningful only if it differs from the editor's. */
  model?: string;
  at: string;
}

export interface TaskState {
  id: string;
  title: string;
  request: string;
  workspaceRoot: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  model?: string;
  /** Rounds consumed across every attempt, not just the current one. */
  roundsUsed: number;
  attempts: number;
  steps: TaskStep[];
  /** Free-text pointer at what to do first on resume. */
  next: string;
  /** Questions the model wants answered before it edits anything. */
  questions: string[];
  /** The human's answers, in the order the questions were asked. */
  answers: string[];
  reads: RecordedRead[];
  edits: RecordedEdit[];
  failures: RecordedFailure[];
  blocker?: string;
  /** Most recent Reviewer verdict, when the audit phase has run. */
  review?: ReviewResult;
  /** Knowledge item slugs this run created or relied on. */
  knowledge: string[];
}

export interface TaskArtifact {
  /** Absolute path of the .md file. */
  file: string;
  /** Path relative to the workspace root, forward-slashed. */
  relative: string;
  state: TaskState;
}

/* ------------------------------- utilities ------------------------------- */

export function nowIso(): string {
  return new Date().toISOString();
}

export function shortHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** Filesystem-safe slug. Never empty, never longer than 48 chars. */
export function slugify(input: string, fallback = "task"): string {
  const slug = String(input || "")
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/** `2026-09-09-143020` — sorts lexicographically, which is why resume can just
 *  take the last entry rather than stat-ing every file. */
export function timeStamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * A stable fingerprint for one tool call, used to detect the model retrying
 * the identical failing call. The full argument text is hashed rather than
 * truncated so two long, nearly-identical `old_text` values are still told
 * apart.
 */
export function callSignature(tool: string, args: Record<string, any>): string {
  const target = String(
    args?.file_path ?? args?.path ?? args?.filePath ?? args?.dir ?? "",
  );
  const body = String(
    args?.old_text ?? args?.oldText ?? args?.content ?? args?.pattern ?? "",
  );
  return `${tool}:${target}:${shortHash(body)}`;
}

/**
 * Normalise a `read_file` call's line range into a stable "start-end" string.
 * Returns "" for a whole-file read, so an unpaged read keys on the path alone
 * and stays compatible with artifacts written before spans were recorded.
 */
export function spanOfArgs(args: Record<string, any>): string {
  const rawStart = args?.start_line ?? args?.startLine;
  const rawEnd = args?.end_line ?? args?.endLine;
  const start = Number(rawStart);
  const end = Number(rawEnd);
  const hasStart = Number.isFinite(start);
  const hasEnd = Number.isFinite(end);
  if (!hasStart && !hasEnd) return "";
  return `${hasStart ? Math.trunc(start) : 1}-${hasEnd ? Math.trunc(end) : "end"}`;
}

/**
 * Dedup key for "have I already read this?". Keyed on path AND line span, so
 * paging through a large file counts each page as genuine progress.
 *
 * Keying this on the bare path was the second of the three defects that killed
 * the rolled-back Extreme Cowork build: `read_file` tells the model to page a
 * truncated file with start_line/end_line, then every page after the first
 * scored zero fresh reads and drove the run into the stall abort.
 */
export function readKey(path: string, span?: string): string {
  return span ? `${path}#${span}` : path;
}

/** First non-empty line of the request, trimmed to something title-shaped. */
export function titleFromRequest(request: string): string {
  const line =
    String(request || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) || "Untitled task";
  return line.replace(/\s+/g, " ").slice(0, 90);
}

/**
 * Does this message mean "pick up where you left off"?
 *
 * Kept deliberately tight. A false positive silently injects a stale plan into
 * an unrelated request, which is far more confusing than a missed resume — the
 * user can always click Continue on the task card instead.
 */
export function looksLikeContinueIntent(text: string): boolean {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/g, "");
  if (!t) return false;
  if (t.length > 120) return false;

  const patterns = [
    /^continue$/,
    /^continue (the|that|with) (task|work|edit|plan|it)$/,
    /^continue (working|from) (on |where )?/,
    /^(please )?(go on|carry on|keep going|resume|proceed)$/,
    /^resume (the|that) (task|work|plan)$/,
    /^(pick up|carry on|continue|go on) where (you|we) left off$/,
    /^finish (it|the (task|job|work|edit|plan))$/,
    /^(complete|finish) what you started$/,
  ];
  return patterns.some((rx) => rx.test(t));
}

/* ---------------------------- path resolution ---------------------------- */

/**
 * Where this run's `.omniroute` state lives.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Every function below joins a path onto `root` and then calls `fsp`. That is
 * correct when `root` is a directory on the machine running this process, which
 * is what it always was: a local install, where the workspace root and the
 * server are the same disk.
 *
 * On a shared deployment `root` is whatever the user's editor reported — a path
 * on THEIR laptop, very often a Windows one. On Linux, `path.join(
 * "C:\\Users\\priya\\app", ".omniroute")` produces the *relative* string
 * `C:\Users\priya\app/.omniroute`, because a Windows root is not absolute here.
 * `fsp.mkdir(..., {recursive:true})` then happily creates it under the
 * container's cwd: `/app/C:\Users\priya\app/.omniroute/`. Nothing errors, so
 * nothing is noticed — the app just accumulates a junk directory per user, and
 * two users whose editors report the same path share one task folder.
 *
 * So in multi-tenant mode the agent's own state is kept SERVER-SIDE, in a
 * directory named after the user, next to the database. The database is the
 * thing that is already backed up and already mounted on a volume, so task
 * artifacts survive a container recreation exactly as chat history does.
 *
 * THE TRADE-OFF, STATED PLAINLY
 *
 * Locally, `.omniroute/tasks/*.md` appears inside the user's own repository and
 * they can open it in their editor — that is a deliberate feature. On a shared
 * deployment they cannot, because writing it would mean pushing files the user
 * never asked for through their editor's write path and into their git working
 * tree. They read the same content through the Tasks panel instead, which is
 * served from here. Knowledge notes written by `remember` and `/init` are
 * likewise stored server-side per user rather than in the user's repo.
 */
export function agentStateRoot(
  workspaceRoot: string,
  userId: string | null,
): string {
  if (!isMultiTenantBridge()) return workspaceRoot;

  /* The id is hashed rather than used directly. User ids are uuids today, but a
   * directory name built from an identifier that might later be an email
   * address is a path-traversal bug waiting to be written; a hex digest cannot
   * contain a separator, a dot-dot, or a drive letter. */
  const key = userId
    ? crypto.createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 32)
    : "anonymous";

  return path.join(path.dirname(databasePath()), "agent-state", key);
}

export function contextDir(root: string): string {
  return path.join(root, CONTEXT_DIR);
}

export function tasksDir(root: string): string {
  return path.join(root, CONTEXT_DIR, TASKS_DIR);
}

export function knowledgeDir(root: string): string {
  return path.join(root, CONTEXT_DIR, KNOWLEDGE_DIR);
}

export function journalPath(root: string): string {
  return path.join(root, CONTEXT_DIR, JOURNAL_FILE);
}

async function ensureDir(dir: string): Promise<boolean> {
  try {
    await fsp.mkdir(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `.gitignore` rules once, so the machine-readable churn does not land in
 * the user's commits while the knowledge notes still can. Only `journal.md` is
 * ignored by default — task plans and knowledge items are the whole point of
 * keeping this in the repo.
 */
async function ensureGitignore(root: string): Promise<void> {
  const file = path.join(contextDir(root), ".gitignore");
  try {
    if (fs.existsSync(file)) return;
    await fsp.writeFile(
      file,
      [
        "# Written by OmniRoute. Task plans and knowledge items are intentionally",
        "# NOT ignored: they are meant to be reviewed and committed.",
        "journal.md",
        "",
      ].join("\n"),
      "utf-8",
    );
  } catch {
    /* non-fatal */
  }
}

/* --------------------------- serialize / parse ---------------------------- */

function stepLine(step: TaskStep): string {
  const box =
    step.status === "done"
      ? "[x]"
      : step.status === "doing"
        ? "[~]"
        : step.status === "skipped"
          ? "[-]"
          : "[ ]";
  return `${box} ${step.index}. ${step.text}${step.note ? `  <!-- ${step.note} -->` : ""}`;
}

/** Render a task artifact as markdown with an embedded state block. */
export function serializeTask(state: TaskState): string {
  const lines: string[] = [];

  lines.push(`# ${state.title}`);
  lines.push("");
  lines.push(`- **status**: ${state.status}`);
  lines.push(`- **id**: ${state.id}`);
  lines.push(`- **workspace**: ${state.workspaceRoot}`);
  lines.push(`- **created**: ${state.createdAt}`);
  lines.push(`- **updated**: ${state.updatedAt}`);
  lines.push(
    `- **rounds used**: ${state.roundsUsed}  |  **attempts**: ${state.attempts}`,
  );
  if (state.model) lines.push(`- **model**: ${state.model}`);
  lines.push("");

  lines.push("## Request");
  lines.push("");
  lines.push(state.request.trim() || "_(empty)_");
  lines.push("");

  lines.push("## Plan");
  lines.push("");
  if (state.steps.length === 0) {
    lines.push("_No steps drafted yet._");
  } else {
    for (const step of state.steps) lines.push(stepLine(step));
  }
  lines.push("");

  if (state.questions.length > 0) {
    lines.push("## Open questions");
    lines.push("");
    state.questions.forEach((q, i) => {
      lines.push(`${i + 1}. ${q}`);
      const a = state.answers[i];
      if (a) lines.push(`   - **answer**: ${a}`);
    });
    lines.push("");
  }

  lines.push("## Next");
  lines.push("");
  lines.push(state.next.trim() || "_Not set._");
  lines.push("");

  if (state.blocker) {
    lines.push("## Blocker");
    lines.push("");
    lines.push(state.blocker.trim());
    lines.push("");
  }

  if (state.reads.length > 0) {
    lines.push("## Files already read");
    lines.push("");
    for (const r of state.reads) {
      lines.push(
        `- \`${r.path}\`${r.span ? ` lines ${r.span}` : ""} (hash ${r.hash}${
          r.totalLines ? `, ${r.totalLines} lines` : ""
        })`,
      );
    }
    lines.push("");
  }

  if (state.edits.length > 0) {
    lines.push("## Edits applied");
    lines.push("");
    for (const e of state.edits) {
      lines.push(
        `- ${e.ok ? "OK" : "FAILED"} \`${e.path}\` via ${e.tool}${
          e.detail ? ` — ${e.detail}` : ""
        }`,
      );
    }
    lines.push("");
  }

  if (state.failures.length > 0) {
    lines.push("## Dead ends (do not retry these verbatim)");
    lines.push("");
    for (const f of state.failures) {
      lines.push(`- ${f.tool} \`${f.path}\` — ${f.error}`);
    }
    lines.push("");
  }

  if (state.knowledge.length > 0) {
    lines.push("## Related knowledge");
    lines.push("");
    for (const k of state.knowledge) {
      lines.push(`- \`${CONTEXT_DIR}/${KNOWLEDGE_DIR}/${k}.md\``);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "<!-- Machine state. Edit the prose above freely; leave this alone. -->",
  );
  lines.push(STATE_FENCE_OPEN);
  lines.push(JSON.stringify(state, null, 2));
  lines.push(STATE_FENCE_CLOSE);
  lines.push("");

  return lines.join("\n");
}

function coerceStep(raw: any, index: number): TaskStep {
  const status =
    raw?.status === "done" ||
    raw?.status === "doing" ||
    raw?.status === "skipped"
      ? raw.status
      : "todo";
  return {
    index: Number.isFinite(raw?.index) ? Number(raw.index) : index + 1,
    text: String(raw?.text ?? "").trim() || `Step ${index + 1}`,
    status,
    ...(raw?.note ? { note: String(raw.note) } : {}),
  };
}

function coerceStatus(raw: any): TaskStatus {
  const allowed: TaskStatus[] = [
    "planning",
    "awaiting-approval",
    "executing",
    "stalled",
    "complete",
    "abandoned",
  ];
  return allowed.includes(raw) ? raw : "planning";
}

function asStringArray(raw: any, cap: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => String(x ?? "").trim())
    .filter((x) => x.length > 0)
    .slice(-cap);
}

/**
 * Recover a TaskState from a task file.
 *
 * Returns null rather than a partial object: a half-parsed plan is worse than
 * no plan, because the model would silently resume against wrong state.
 */
export function parseTask(markdown: string): TaskState | null {
  const openIdx = markdown.indexOf(STATE_FENCE_OPEN);
  if (openIdx === -1) return null;

  const bodyStart = openIdx + STATE_FENCE_OPEN.length;
  const closeIdx = markdown.indexOf(`\n${STATE_FENCE_CLOSE}`, bodyStart);
  if (closeIdx === -1) return null;

  const raw = markdown.slice(bodyStart, closeIdx);

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.id !== "string" || !parsed.id) return null;

  const steps = Array.isArray(parsed.steps) ? parsed.steps.map(coerceStep) : [];
  const review = sanitizeReview(parsed.review);

  return {
    id: parsed.id,
    title: String(parsed.title ?? "Untitled task"),
    request: String(parsed.request ?? ""),
    workspaceRoot: String(parsed.workspaceRoot ?? ""),
    status: coerceStatus(parsed.status),
    createdAt: String(parsed.createdAt ?? nowIso()),
    updatedAt: String(parsed.updatedAt ?? nowIso()),
    ...(parsed.model ? { model: String(parsed.model) } : {}),
    roundsUsed: Number.isFinite(parsed.roundsUsed)
      ? Number(parsed.roundsUsed)
      : 0,
    attempts: Number.isFinite(parsed.attempts) ? Number(parsed.attempts) : 1,
    steps,
    next: String(parsed.next ?? ""),
    questions: asStringArray(parsed.questions, 20),
    answers: asStringArray(parsed.answers, 20),
    reads: Array.isArray(parsed.reads)
      ? parsed.reads
          .filter((r: any) => r && typeof r.path === "string")
          .map((r: any) => ({
            path: String(r.path),
            hash: String(r.hash ?? ""),
            ...(typeof r.span === "string" && r.span ? { span: r.span } : {}),
            ...(Number.isFinite(r.totalLines)
              ? { totalLines: Number(r.totalLines) }
              : {}),
            at: String(r.at ?? nowIso()),
          }))
          .slice(-MAX_RECORDED_READS)
      : [],
    edits: Array.isArray(parsed.edits)
      ? parsed.edits
          .filter((e: any) => e && typeof e.path === "string")
          .map((e: any) => ({
            path: String(e.path),
            tool: e.tool === "write_file" ? "write_file" : "replace_text",
            ok: e.ok !== false,
            ...(e.detail ? { detail: String(e.detail) } : {}),
            at: String(e.at ?? nowIso()),
          }))
          .slice(-MAX_RECORDED_EDITS)
      : [],
    failures: Array.isArray(parsed.failures)
      ? parsed.failures
          .filter((f: any) => f && typeof f.signature === "string")
          .map((f: any) => ({
            tool: String(f.tool ?? ""),
            path: String(f.path ?? ""),
            signature: String(f.signature),
            error: String(f.error ?? ""),
            at: String(f.at ?? nowIso()),
          }))
          .slice(-MAX_RECORDED_FAILURES)
      : [],
    ...(parsed.blocker ? { blocker: String(parsed.blocker) } : {}),
    ...(review ? { review } : {}),
    knowledge: asStringArray(parsed.knowledge, 40),
  };
}

/**
 * Re-validate a review verdict read back off disk. The task file is editable by
 * hand, so nothing here may be trusted to have the right shape.
 */
function sanitizeReview(raw: any): ReviewResult | null {
  if (!raw || typeof raw !== "object") return null;
  const severities: ReviewSeverity[] = ["blocker", "major", "minor", "note"];
  const findings: ReviewFinding[] = Array.isArray(raw.findings)
    ? raw.findings
        .filter((f: any) => f && typeof f.text === "string" && f.text.trim())
        .map((f: any) => ({
          severity: severities.includes(f.severity) ? f.severity : "note",
          ...(typeof f.path === "string" && f.path ? { path: f.path } : {}),
          text: String(f.text).slice(0, 500),
        }))
        .slice(0, 40)
    : [];
  return {
    passed: raw.passed === true,
    findings,
    summary: String(raw.summary ?? "").slice(0, 600),
    cycle: Number.isFinite(raw.cycle) ? Math.trunc(Number(raw.cycle)) : 1,
    ...(typeof raw.model === "string" && raw.model
      ? { model: String(raw.model) }
      : {}),
    at: String(raw.at ?? nowIso()),
  };
}

/* ------------------------------- task store ------------------------------ */

export function newTaskState(input: {
  request: string;
  workspaceRoot: string;
  model?: string;
  status?: TaskStatus;
}): TaskState {
  const title = titleFromRequest(input.request);
  const stamp = timeStamp();
  return {
    id: `${stamp}-${slugify(title)}`,
    title,
    request: input.request,
    workspaceRoot: input.workspaceRoot,
    status: input.status ?? "planning",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...(input.model ? { model: input.model } : {}),
    roundsUsed: 0,
    attempts: 1,
    steps: [],
    next: "",
    questions: [],
    answers: [],
    reads: [],
    edits: [],
    failures: [],
    knowledge: [],
  };
}

export function taskFilePath(root: string, id: string): string {
  return path.join(tasksDir(root), `${id}.md`);
}

/** Persist a task artifact. Returns null when the disk refuses. */
export async function saveTask(
  root: string,
  state: TaskState,
): Promise<TaskArtifact | null> {
  const dir = tasksDir(root);
  if (!(await ensureDir(dir))) return null;
  await ensureGitignore(root);

  const trimmed: TaskState = {
    ...state,
    updatedAt: nowIso(),
    reads: state.reads.slice(-MAX_RECORDED_READS),
    edits: state.edits.slice(-MAX_RECORDED_EDITS),
    failures: state.failures.slice(-MAX_RECORDED_FAILURES),
  };

  const file = taskFilePath(root, trimmed.id);
  try {
    await fsp.writeFile(file, serializeTask(trimmed), "utf-8");
  } catch {
    return null;
  }

  return {
    file,
    relative: path.relative(root, file).replace(/\\/g, "/"),
    state: trimmed,
  };
}

export async function loadTask(
  root: string,
  id: string,
): Promise<TaskArtifact | null> {
  const file = taskFilePath(root, id);
  try {
    const raw = await fsp.readFile(file, "utf-8");
    const state = parseTask(raw);
    if (!state) return null;
    return {
      file,
      relative: path.relative(root, file).replace(/\\/g, "/"),
      state,
    };
  } catch {
    return null;
  }
}

/** Newest first. Unparsable files are skipped, not fatal. */
export async function listTasks(
  root: string,
  limit = 25,
): Promise<TaskArtifact[]> {
  const dir = tasksDir(root);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }

  const files = names
    .filter((n) => n.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, limit);

  const out: TaskArtifact[] = [];
  for (const name of files) {
    const full = path.join(dir, name);
    try {
      const raw = await fsp.readFile(full, "utf-8");
      const state = parseTask(raw);
      if (!state) continue;
      out.push({
        file: full,
        relative: path.relative(root, full).replace(/\\/g, "/"),
        state,
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * The newest task that could still be continued.
 *
 * `awaiting-approval` counts: a plan the user approved in a later chat session
 * is exactly the case this whole mechanism exists for.
 */
export async function findResumableTask(
  root: string,
): Promise<TaskArtifact | null> {
  const tasks = await listTasks(root, 25);
  return (
    tasks.find(
      (t) =>
        t.state.status === "stalled" ||
        t.state.status === "executing" ||
        t.state.status === "awaiting-approval",
    ) || null
  );
}

/* ----------------------------- knowledge items ---------------------------- */

export interface KnowledgeItem {
  slug: string;
  title: string;
  body: string;
  tags: string[];
  updatedAt: string;
}

export async function saveKnowledge(
  root: string,
  input: { title: string; body: string; tags?: string[]; slug?: string },
): Promise<string | null> {
  const dir = knowledgeDir(root);
  if (!(await ensureDir(dir))) return null;
  await ensureGitignore(root);

  const slug = slugify(input.slug || input.title, "note");
  const file = path.join(dir, `${slug}.md`);
  const tags = (input.tags || []).map((t) => slugify(t, "tag")).slice(0, 12);

  const body = [
    `# ${input.title.trim() || slug}`,
    "",
    `- **updated**: ${nowIso()}`,
    ...(tags.length ? [`- **tags**: ${tags.join(", ")}`] : []),
    "",
    input.body.trim(),
    "",
  ].join("\n");

  try {
    await fsp.writeFile(file, body, "utf-8");
    return slug;
  } catch {
    return null;
  }
}

/* ------------------------------ setup steps ------------------------------- */

export interface SetupRequirement {
  /** What the developer has to run or do. */
  command: string;
  /** Why it is needed — which file or feature depends on it. */
  reason: string;
  /** "dependency" | "command" | "manual". Free-form; used only for grouping. */
  kind: string;
}

export function setupPath(root: string): string {
  return path.join(contextDir(root), "setup.md");
}

/**
 * Append setup requirements to `.omniroute/setup.md`.
 *
 * The agent cannot run shell commands — that capability was deliberately removed
 * — so anything it needs installed has to be handed back to the developer. A
 * sentence in a chat transcript gets lost; a file does not. This is the seam
 * between "the agent wrote code that imports X" and "X is actually installed".
 *
 * Appends rather than overwrites, and skips commands already present, so a
 * multi-round run accumulates one clean list instead of rewriting the file each
 * time. Returns the number of NEW entries written, or null if the file could not
 * be written at all.
 */
export async function recordSetup(
  root: string,
  entries: SetupRequirement[],
): Promise<number | null> {
  if (entries.length === 0) return 0;
  if (!(await ensureDir(contextDir(root)))) return null;
  await ensureGitignore(root);

  const file = setupPath(root);

  let existing = "";
  try {
    existing = await fsp.readFile(file, "utf-8");
  } catch {
    existing = "";
  }

  /* Dedupe on whole lines, not substrings. Commands are written on their own
   * line inside a fenced block, so a line-exact test is both more accurate and
   * avoids the trap where "npm install zod" is suppressed because
   * "npm install zod-form" already appears somewhere in the file. */
  const existingLines = new Set(existing.split("\n").map((l) => l.trim()));
  const fresh = entries.filter(
    (e) => e.command.trim() && !existingLines.has(e.command.trim()),
  );
  if (fresh.length === 0) return 0;

  const header = existing
    ? ""
    : [
        "# Setup required",
        "",
        "Generated by Ultra Mode. The agent cannot run commands, so anything it",
        "needed installed or configured is listed here for you to run.",
        "",
        "Review before running — these are the agent's claims about what the code",
        "it wrote depends on, not a verified build.",
        "",
      ].join("\n");

  const block = fresh
    .map((e) =>
      [
        `## ${e.kind.trim() || "step"}: ${e.reason.trim() || "(no reason given)"}`,
        "",
        "```sh",
        e.command.trim(),
        "```",
        "",
      ].join("\n"),
    )
    .join("");

  try {
    await fsp.writeFile(
      file,
      `${existing}${header}${block}`.replace(/\n{3,}/g, "\n\n"),
      "utf-8",
    );
    return fresh.length;
  } catch {
    return null;
  }
}

export async function listKnowledge(
  root: string,
  limit = 40,
): Promise<KnowledgeItem[]> {
  const dir = knowledgeDir(root);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }

  const out: KnowledgeItem[] = [];
  for (const name of names.filter((n) => n.endsWith(".md")).slice(0, limit)) {
    const full = path.join(dir, name);
    try {
      const raw = await fsp.readFile(full, "utf-8");
      const firstLine = raw.split("\n").find((l) => l.startsWith("# "));
      const tagLine = raw
        .split("\n")
        .find((l) => l.toLowerCase().includes("**tags**"));
      const stat = await fsp.stat(full);
      out.push({
        slug: name.replace(/\.md$/, ""),
        title: firstLine ? firstLine.replace(/^#\s*/, "").trim() : name,
        body: raw,
        tags: tagLine
          ? tagLine
              .split(":")
              .slice(1)
              .join(":")
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
        updatedAt: stat.mtime.toISOString(),
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * The knowledge block for the system prompt. Titles plus a short excerpt: the
 * whole point is to be cheap enough to always include, so the model learns
 * "app.py is CRLF" without a tool call.
 */
export async function buildKnowledgeContext(
  root: string,
  maxChars = 2400,
): Promise<string> {
  const items = await listKnowledge(root, 24);
  if (items.length === 0) return "";

  const lines: string[] = [];
  lines.push("=== PROJECT KNOWLEDGE (.omniroute/knowledge) ===");
  lines.push(
    "Durable notes from earlier sessions. Trust these before re-deriving them.",
  );

  let used = 0;
  for (const item of items) {
    // Skip the heading and metadata lines; keep the substance.
    const substance = item.body
      .split("\n")
      .filter(
        (l) =>
          l.trim() &&
          !l.startsWith("#") &&
          !l.includes("**updated**") &&
          !l.includes("**tags**"),
      )
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 220);
    const line = `- ${item.title}: ${substance}`;
    if (used + line.length > maxChars) {
      lines.push(
        `- ... ${items.length} notes total; read the rest with read_file.`,
      );
      break;
    }
    lines.push(line);
    used += line.length;
  }

  lines.push("=== END PROJECT KNOWLEDGE ===");
  return lines.join("\n");
}

/* --------------------------------- journal ------------------------------- */

/** Append-only run log. Trimmed from the front when it gets large. */
export async function appendJournal(
  root: string,
  entry: string,
): Promise<void> {
  if (!(await ensureDir(contextDir(root)))) return;
  await ensureGitignore(root);

  const file = journalPath(root);
  const line = `- ${nowIso()} — ${entry.replace(/\n/g, " ").trim()}\n`;

  try {
    let existing = "";
    if (fs.existsSync(file)) {
      existing = await fsp.readFile(file, "utf-8");
    } else {
      existing = "# OmniRoute journal\n\n";
    }

    let next = existing + line;
    if (Buffer.byteLength(next, "utf8") > MAX_JOURNAL_BYTES) {
      const kept = next.split("\n").slice(-1200).join("\n");
      next = `# OmniRoute journal\n\n_(trimmed)_\n${kept}`;
    }
    await fsp.writeFile(file, next, "utf-8");
  } catch {
    /* non-fatal */
  }
}

/* ------------------------- prompt-facing rendering ------------------------ */

/**
 * Render a task artifact for injection into the system prompt on resume.
 *
 * This is the payload that replaces re-doing the work. Reads are listed so the
 * model does not read them again; edits so it does not re-apply them; dead ends
 * so it does not retry a call that has already failed — which is exactly how
 * the 12-round run burned its budget.
 */
export function renderTaskForPrompt(state: TaskState): string {
  const lines: string[] = [];

  lines.push("=== RESUMING AN EARLIER TASK ===");
  lines.push(`task file: ${CONTEXT_DIR}/${TASKS_DIR}/${state.id}.md`);
  lines.push(`status: ${state.status}`);
  lines.push(
    `rounds already spent: ${state.roundsUsed} across ${state.attempts} attempt(s)`,
  );
  lines.push("");
  lines.push(`ORIGINAL REQUEST: ${state.request.trim()}`);
  lines.push("");

  if (state.steps.length > 0) {
    lines.push("PLAN (carry on from the first unfinished step):");
    for (const step of state.steps) {
      const mark =
        step.status === "done"
          ? "DONE"
          : step.status === "doing"
            ? "IN PROGRESS"
            : step.status === "skipped"
              ? "SKIPPED"
              : "TODO";
      lines.push(`  ${step.index}. [${mark}] ${step.text}`);
    }
    lines.push("");
  }

  if (state.questions.length > 0) {
    lines.push("CLARIFICATIONS ALREADY SETTLED:");
    state.questions.forEach((q, i) => {
      lines.push(`  Q: ${q}`);
      lines.push(`  A: ${state.answers[i] || "(unanswered)"}`);
    });
    lines.push("");
  }

  if (state.edits.length > 0) {
    lines.push("EDITS ALREADY APPLIED — do NOT repeat these:");
    for (const e of state.edits.filter((x) => x.ok)) {
      lines.push(`  - ${e.path} (${e.tool})`);
    }
    lines.push("");
  }

  if (state.reads.length > 0) {
    /* Group by path and report which spans were actually seen. Listing only the
     * path would tell the model it has read a whole file when it may have read
     * one page of it, which invites confidently wrong edits to the rest. */
    const spansByPath = new Map<string, Set<string>>();
    for (const r of state.reads) {
      const seen = spansByPath.get(r.path) ?? new Set<string>();
      seen.add(r.span ? `lines ${r.span}` : "whole file");
      spansByPath.set(r.path, seen);
    }
    const described = Array.from(spansByPath.entries()).map(([path, spans]) =>
      spans.has("whole file")
        ? path
        : `${path} (${Array.from(spans).join(", ")} only)`,
    );
    lines.push(
      "FILES ALREADY READ (re-read only if you need the exact text again, or to " +
        `reach a part you have not seen): ${described.join("; ")}`,
    );
    lines.push("");
  }

  if (state.failures.length > 0) {
    lines.push("DEAD ENDS — these exact calls already failed:");
    for (const f of state.failures.slice(-12)) {
      lines.push(`  - ${f.tool} on ${f.path}: ${f.error}`);
    }
    lines.push(
      "Do not retry them unchanged. Change approach, or read the region again first.",
    );
    lines.push("");
  }

  if (state.blocker) {
    lines.push(`BLOCKER RECORDED LAST TIME: ${state.blocker}`);
    lines.push("");
  }

  lines.push(`NEXT: ${state.next.trim() || "Resume at the first TODO step."}`);
  lines.push("=== END RESUMING ===");

  return lines.join("\n");
}

/**
 * Pull a `PLAN:` / `QUESTIONS:` / `NEXT:` structure out of the planning pass's
 * prose. The model is asked for this shape in the prompt, but a model that
 * ignores the format must still produce a usable plan, so every section falls
 * back to "scan for list items".
 */
export function extractPlanFromText(text: string): {
  steps: TaskStep[];
  questions: string[];
  next: string;
} {
  const src = String(text || "");
  const lines = src.split("\n");

  const steps: TaskStep[] = [];
  const questions: string[] = [];
  let next = "";

  type Section = "none" | "plan" | "questions" | "next";
  let section: Section = "none";

  const listItem = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = line
      .replace(/[#*`:]/g, "")
      .trim()
      .toLowerCase();

    if (/^plan\b/.test(heading) || /^steps\b/.test(heading)) {
      section = "plan";
      continue;
    }
    if (
      /^questions\b/.test(heading) ||
      /^open questions\b/.test(heading) ||
      /^clarif/.test(heading)
    ) {
      section = "questions";
      continue;
    }
    if (/^next\b/.test(heading)) {
      section = "next";
      continue;
    }
    if (/^(files|notes|summary|risks?|assumptions?)\b/.test(heading)) {
      section = "none";
      continue;
    }

    const m = line.match(listItem);

    if (section === "plan" && m) {
      const text2 = m[1].replace(/^\[[ x~-]\]\s*/i, "").trim();
      if (text2) {
        steps.push({ index: steps.length + 1, text: text2, status: "todo" });
      }
      continue;
    }

    if (section === "questions") {
      const q = m ? m[1].trim() : line;
      if (q.length > 3) questions.push(q.replace(/^\[[ x~-]\]\s*/i, ""));
      continue;
    }

    if (section === "next") {
      next = next ? `${next} ${line}` : line;
      continue;
    }
  }

  // No explicit PLAN heading: treat every checkbox/numbered line as a step.
  if (steps.length === 0) {
    for (const rawLine of lines) {
      const m = rawLine.trim().match(listItem);
      if (!m) continue;
      const text2 = m[1].replace(/^\[[ x~-]\]\s*/i, "").trim();
      if (text2.length > 3 && !text2.endsWith("?")) {
        steps.push({ index: steps.length + 1, text: text2, status: "todo" });
      }
    }
  }

  // Questions can also just be any line ending in "?".
  if (questions.length === 0) {
    for (const rawLine of lines) {
      const line = rawLine.trim().replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
      if (line.endsWith("?") && line.length > 8 && line.length < 300) {
        questions.push(line);
      }
    }
  }

  return {
    steps: steps.slice(0, 40),
    questions: Array.from(new Set(questions)).slice(0, 8),
    next: next.slice(0, 600),
  };
}

/**
 * Parse a Reviewer verdict out of the audit pass's prose.
 *
 * Expected shape (see REVIEW_PROMPT in deepCoworkPipeline.ts):
 *
 *   ## Verdict
 *   PASS | FAIL
 *
 *   ## Findings
 *   - [blocker] src/app/api/chat/route.ts - the token is never checked
 *   - [minor] naming is inconsistent
 *
 *   ## Summary
 *   one line
 *
 * `passed` is derived from the findings, not from the verdict word: a model will
 * happily write "PASS" and then list a blocker underneath it. Anything tagged
 * blocker or major fails the audit regardless of what the verdict line claims.
 */
export function extractReviewFromText(
  text: string,
  cycle = 1,
): Omit<ReviewResult, "at"> & { at: string } {
  const src = String(text || "");
  const lines = src.split("\n");

  const findings: ReviewFinding[] = [];
  let summary = "";
  let declaredPass: boolean | null = null;

  type Section = "none" | "verdict" | "findings" | "summary";
  let section: Section = "none";

  const listItem = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
  const tagged = /^\[?(blocker|major|minor|note|critical|high|low|info)\]?\s*[:\-—]?\s*(.*)$/i;

  const normaliseSeverity = (raw: string): ReviewSeverity => {
    const s = raw.toLowerCase();
    if (s === "blocker" || s === "critical") return "blocker";
    if (s === "major" || s === "high") return "major";
    if (s === "minor" || s === "low") return "minor";
    return "note";
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = line
      .replace(/[#*`:]/g, "")
      .trim()
      .toLowerCase();

    if (/^verdict\b/.test(heading) || /^result\b/.test(heading)) {
      section = "verdict";
      continue;
    }
    if (/^findings?\b/.test(heading) || /^issues?\b/.test(heading)) {
      section = "findings";
      continue;
    }
    if (/^summary\b/.test(heading) || /^conclusion\b/.test(heading)) {
      section = "summary";
      continue;
    }

    if (section === "verdict") {
      if (/\bpass(ed)?\b|\bapprove|\bclean\b|\blgtm\b/i.test(line)) {
        declaredPass = true;
      } else if (/\bfail(ed)?\b|\breject|\bblocked?\b|\bchanges? requested\b/i.test(line)) {
        declaredPass = false;
      }
      continue;
    }

    if (section === "findings") {
      const m = line.match(listItem);
      const body = (m ? m[1] : line).trim();
      if (!body) continue;
      if (/^none\b|^no (issues|findings|problems)\b/i.test(body)) continue;

      const t = body.match(tagged);
      const severity = t ? normaliseSeverity(t[1]) : "note";
      let rest = (t ? t[2] : body).trim();
      if (!rest) continue;

      /* "src/foo.ts - description" / "src/foo.ts: description" — pull the path
       * out so the UI can link it and the fix pass knows where to look. */
      let path: string | undefined;
      const pathMatch = rest.match(
        /^[`"']?([\w./\\@-]+\.[A-Za-z0-9]{1,8})[`"']?\s*(?:[:\-—]|\s)\s*(.+)$/,
      );
      if (pathMatch) {
        path = pathMatch[1];
        rest = pathMatch[2].trim();
      }

      findings.push({
        severity,
        ...(path ? { path } : {}),
        text: rest.slice(0, 500),
      });
      continue;
    }

    if (section === "summary") {
      summary = summary ? `${summary} ${line}` : line;
      continue;
    }
  }

  const blocking = findings.some(
    (f) => f.severity === "blocker" || f.severity === "major",
  );

  /* If the reviewer produced no parseable structure at all, do not silently
   * treat that as a pass — an unreadable audit is not an audit. The one
   * exception is an explicit PASS verdict with no findings. */
  const parsedAnything = findings.length > 0 || declaredPass !== null;

  return {
    passed: parsedAnything ? !blocking && declaredPass !== false : false,
    findings: findings.slice(0, 40),
    summary:
      summary.slice(0, 600) ||
      (parsedAnything
        ? blocking
          ? "The reviewer raised blocking findings."
          : "The reviewer found nothing blocking."
        : "The reviewer's response could not be parsed into a verdict."),
    cycle,
    at: nowIso(),
  };
}
