/**
 * src/lib/deepCoworkPipeline.ts
 * ---------------------------------------------------------------------------
 * Deep Cowork: a multi-stage, tool-using agent loop over the OmniRoute gateway.
 *
 * WHAT CHANGED IN THIS VERSION
 * ----------------------------
 * 1. THE BUDGET IS NO LONGER A FIXED NUMBER.
 *    `OMNIROUTE_DEEP_MAX_ITERATIONS` is now a *starting* budget, not a ceiling.
 *    Every round that lands real work (a successful edit, or a read the model
 *    had not already done) buys more rounds, up to a hard ceiling. Rounds that
 *    produce nothing but repeated failures shrink the remaining budget and can
 *    abort the run early. Setting it to 40 previously bought 40 chances to
 *    thrash; now progress extends the run and thrash ends it.
 *
 * 2. TWO-PHASE OPERATION (PLAN -> APPROVE -> EXECUTE).
 *    In `phase: "plan"` the write tools are physically removed from the tool
 *    array, a plan is drafted into `.omniroute/tasks/<id>.md`, and the run
 *    stops. Nothing can be edited during planning even if the model tries,
 *    because the tools do not exist in that request.
 *
 * 3. RESUMABLE TASKS.
 *    Progress is written to the task artifact every round. A later chat can
 *    pass `resumeTaskId` (or just say "continue") and the pipeline injects what
 *    was already read, already edited, and already failed — so the next run
 *    starts where the last one stopped instead of re-deriving it.
 *
 * 4. REPEAT-CALL DETECTION.
 *    `callSignature()` fingerprints each tool call. The second identical
 *    failing call gets a corrective tool result instead of the same error; the
 *    third aborts the round budget. This is the direct antidote to the run that
 *    retried one CRLF-doomed `replace_text` until the budget died.
 *
 * The workspace/file layer lives in src/lib/vscodeBridge.ts; the context-file
 * layer lives in src/lib/agentContext.ts. This file orchestrates them.
 */

import { tavily } from "@tavily/core";
import {
  WORKSPACE_TOOLS,
  WORKSPACE_TOOL_NAMES,
  buildWorkspaceContext,
  executeWorkspaceTool,
  vscodeBridge,
  withWorkspaceOwner,
} from "@/lib/vscodeBridge";
import {
  REFERENCE_TOOL_NAMES,
  executeReferenceTool,
  referenceToolsFor,
} from "@/lib/referenceProject";
import {
  CONTEXT_DIR,
  TASKS_DIR,
  agentStateRoot,
  appendJournal,
  buildKnowledgeContext,
  callSignature,
  extractPlanFromText,
  extractReviewFromText,
  findResumableTask,
  loadTask,
  looksLikeContinueIntent,
  newTaskState,
  nowIso,
  readKey,
  renderTaskForPrompt,
  saveKnowledge,
  recordSetup,
  saveTask,
  shortHash,
  spanOfArgs,
  type RecordedEdit,
  type RecordedFailure,
  type RecordedRead,
  type ReviewFinding,
  type ReviewResult,
  type TaskArtifact,
  type TaskState,
} from "@/lib/agentContext";
import {
  gatewayFailure,
  accountFromHeaders,
  upstreamModelFromHeaders,
  detectSubstitution,
  prettyModelName,
  shouldFailover,
  failureKindOf,
  buildNotice,
  type Candidate,
} from "@/lib/omniroute";
import { resolveGatewayCreds, type GatewayCreds } from "@/lib/gatewayCreds";
import { getProviderProfile } from "@/lib/providerProfiles";
import {
  postChatCompletionStream,
  targetFromCreds,
} from "@/lib/upstreamRequest";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Name of whoever actually answers, for error messages.
 *
 * Gateway failures used to be labelled "OmniRoute" unconditionally, so a
 * third-party or local provider's rejection still blamed the localhost gateway.
 * Wrapped in a try/catch because a bad provider id falls back to the custom
 * profile — it cannot throw — but this runs on the error path, and an error
 * while reporting an error is the worst possible place to find out otherwise.
 */
function providerLabel(creds: GatewayCreds): string {
  try {
    return getProviderProfile(creds.provider).label;
  } catch {
    return "The provider";
  }
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool" | "function";
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export type PipelineStage =
  | "planning"
  | "executing"
  | "verifying"
  | "synthesizing";

/** Which half of the two-phase flow this run is. */
export type DeepPhase = "plan" | "execute" | "auto";

export interface DeepCoworkOptions {
  /**
   * Whose machine this run acts on. REQUIRED, and required on purpose.
   *
   * Every other field here is a preference; this one decides which person's
   * filesystem the run reads and writes. It is not optional because an omitted
   * optional field compiles silently, and the failure mode of a silently
   * omitted owner is a Deep Cowork run editing somebody else's project — the
   * one bug in this file that cannot be recovered from by retrying.
   *
   * `null` means "no signed-in user". On a local single-operator install that
   * is normal and the run uses the operator's own editor or filesystem; on a
   * shared deployment it means the file tools will refuse, which is correct
   * because an anonymous caller has no machine here.
   */
  userId: string | null;
  /**
   * "plan"    -> read-only, draft a plan, stop for approval.
   * "execute" -> full tools, apply the plan.
   * "auto"    -> the old one-shot behaviour (default, so existing callers keep
   *              working). Still gets the dynamic budget and resume.
   */
  phase?: DeepPhase;
  /** Continue this specific task artifact. */
  resumeTaskId?: string;
  /** Starting round budget override from the client. */
  maxIterations?: number;
  /** In plan phase, ask clarifying questions before proposing steps. */
  askQuestions?: boolean;
  /** Answers the user gave to a previous run's questions. */
  answers?: string[];
  /** Round configuration settings from localStorage. */
  roundSettings?: {
    startIterations?: number;
    ceilingIterations?: number;
    extendAmount?: number;
    stallTolerance?: number;
    repeatLimit?: number;
    accountRetries?: number;
    planStartIterations?: number;
    planCeilingIterations?: number;
  };
  /**
   * The caller's own gateway. Optional so existing callers keep compiling; when
   * absent the pipeline falls back to the server's env credentials, which is
   * only appropriate on a local install.
   */
  creds?: GatewayCreds;
  /**
   * Ultra mode: run an independent Reviewer audit over the applied edits and
   * loop back to the editor while it reports blocking findings.
   *
   * Off by default, so Deep Cowork behaves exactly as it did before.
   */
  ultra?: boolean;
  /**
   * Model the Reviewer audit runs on. An audit is only independent if it is not
   * the model that wrote the code, so this should differ from the editor's.
   *
   * Left unset, the reviewer is derived from the failover ladder: a genuinely
   * different model from later in the ladder if one exists, otherwise the
   * editor's own model. It is NEVER resolved to a hardcoded "strongest" model:
   * pinning a model over the user's UI selection is what made the rolled-back
   * Extreme Cowork build unusable (the pinned model's quota was exhausted and
   * the gateway returned 429). See `reviewModelCandidates`.
   */
  reviewModel?: string;
  /** Hard cap on review -> fix -> re-review cycles. Finite by construction. */
  maxReviewCycles?: number;
  /**
   * Remove file-writing tools for this run, independently of `phase`.
   *
   * Used by read-only slash commands (`/review`, `/init`) which need the
   * execute phase's terminal behaviour — a normal prose answer — but must not
   * touch source. Kept separate from `phase` deliberately: `planningOnly` gates
   * seventeen other behaviours (prompt, budget, task status, stage labels), and
   * a read-only command wants none of those, only the tool restriction.
   *
   * The remember tool is NOT removed, so `/init` can still write knowledge
   * files. Only tools that mutate the user's source are withheld.
   */
  readOnly?: boolean;
  /**
   * Objective injected late into the system prompt, used by slash commands to
   * state what this specific run is for. Appended after the workspace and
   * knowledge context so it reads as the most recent, most specific
   * instruction.
   */
  objective?: string;
}

export type CoworkPipelineEvent =
  | { kind: "stage"; stage: PipelineStage; label: string }
  | { kind: "thought"; text: string }
  | { kind: "delta"; text: string }
  | { kind: "tool"; name: string; details?: string }
  | { kind: "notice"; notice: any }
  | { kind: "route"; route: any }
  /** A plan is on disk and waiting for the human. */
  | {
      kind: "plan";
      plan: {
        taskId: string;
        file: string;
        title: string;
        steps: { index: number; text: string; status: string }[];
        questions: string[];
        next: string;
        status: TaskState["status"];
      };
    }
  /** Task artifact bookkeeping, so the UI can show/resume it. */
  | {
      kind: "task";
      task: {
        id: string;
        file: string;
        status: TaskState["status"];
        roundsUsed: number;
        resumed?: boolean;
      };
    }
  /** Live budget so "12 rounds" is never a mystery again. */
  | {
      kind: "budget";
      budget: {
        used: number;
        limit: number;
        ceiling: number;
        extendedBy?: number;
        reason?: string;
      };
    }
  | { kind: "error"; error: string }
  /** An independent Reviewer verdict over the edits just applied. */
  | {
      kind: "review";
      review: {
        cycle: number;
        maxCycles: number;
        passed: boolean;
        summary: string;
        model?: string;
        findings: ReviewFinding[];
      };
    }
  | { kind: "done" };

/* ------------------------------ round budget ----------------------------- */

/**
 * Read an integer from an env var, falling back when it is absent OR unparseable.
 *
 * `Math.max(2, Number("abc"))` is NaN, not 2 — so the previous form let one
 * malformed env var poison the whole budget: a NaN ceiling makes
 * `ceiling - limit` NaN, which silently kills the extension branch and leaks
 * "NaN" into the round badge. Never let a non-finite number reach RoundBudget.
 */
function envInt(raw: string | undefined, fallback: number, min: number): number {
  const parsed = Number(raw);
  const value = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.max(min, value);
}

/**
 * Starting budget. Deliberately modest: it grows when work lands, so a big
 * number here only buys more room to spin in circles.
 */
const START_ITERATIONS = envInt(
  process.env.OMNIROUTE_DEEP_MAX_ITERATIONS,
  12,
  2,
);

/** Absolute stop, so a pathological run cannot bill forever. */
const CEILING_ITERATIONS = envInt(
  process.env.OMNIROUTE_DEEP_MAX_CEILING,
  150,
  START_ITERATIONS,
);

/** Rounds granted for one productive round. */
const EXTEND_ON_PROGRESS = envInt(process.env.OMNIROUTE_DEEP_EXTEND, 3, 1);

/** Consecutive unproductive rounds tolerated before giving up early. */
const STALL_TOLERANCE = envInt(
  process.env.OMNIROUTE_DEEP_STALL_TOLERANCE,
  120,
  2,
);

/**
 * How many tool-using rounds the Reviewer gets to read the changed files before
 * it must commit to a verdict. Reading is all it can do, so this is cheap — but
 * it is finite, because an auditor that never finishes auditing is a hang.
 */
const REVIEW_READ_ROUNDS = envInt(
  process.env.OMNIROUTE_ULTRA_REVIEW_ROUNDS,
  8,
  1,
);

/** Rounds handed to the editor to fix what one review cycle found. */
const REVIEW_FIX_ROUNDS = envInt(process.env.OMNIROUTE_ULTRA_FIX_ROUNDS, 6, 1);

/** Default cap on review -> fix -> re-review cycles. */
const MAX_REVIEW_CYCLES = envInt(process.env.OMNIROUTE_ULTRA_REVIEW_CYCLES, 2, 1);

/** How many times one identical failing call may be repeated before abort. */
const REPEAT_LIMIT = 10;

/**
 * The budget as a small state machine.
 *
 * `limit` starts at START_ITERATIONS and moves. Productive rounds push it up
 * (never past the ceiling); consecutive dead rounds trip `stalled`, which ends
 * the run with a diagnosis rather than a bare "ran out of rounds".
 */
class RoundBudget {
  used = 0;
  limit: number;
  readonly ceiling: number;
  readonly extendAmount: number;
  readonly stallTolerance: number;
  readonly repeatLimit: number;
  private consecutiveDead = 0;
  /** signature -> times that exact call has failed */
  private failureCounts = new Map<string, number>();
  lastExtension = 0;
  lastReason = "";
  stallReason: string | null = null;

  constructor(
    start: number, 
    ceiling: number, 
    extendAmount: number = EXTEND_ON_PROGRESS,
    stallTolerance: number = STALL_TOLERANCE,
    repeatLimit: number = REPEAT_LIMIT
  ) {
    this.limit = Math.max(2, Math.min(start, ceiling));
    this.ceiling = ceiling;
    this.extendAmount = extendAmount;
    this.stallTolerance = stallTolerance;
    this.repeatLimit = repeatLimit;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  get exhausted(): boolean {
    return this.used >= this.limit;
  }

  get stalled(): boolean {
    return this.stallReason !== null;
  }

  startRound(): void {
    this.used += 1;
    this.lastExtension = 0;
    this.lastReason = "";
  }

  /** Called once per round with what that round actually accomplished. */
  settleRound(progress: {
    successfulEdits: number;
    freshReads: number;
    failures: number;
  }): void {
    const productive = progress.successfulEdits > 0 || progress.freshReads > 0;

    if (productive) {
      this.consecutiveDead = 0;
      const room = this.ceiling - this.limit;
      if (room > 0) {
        const grant = Math.min(this.extendAmount, room);
        this.limit += grant;
        this.lastExtension = grant;
        this.lastReason =
          progress.successfulEdits > 0
            ? `${progress.successfulEdits} edit(s) applied`
            : `${progress.freshReads} new file(s) read`;
      }
      return;
    }

    this.consecutiveDead += 1;
    if (this.consecutiveDead >= this.stallTolerance) {
      this.stallReason =
        `No file was read or written in ${this.consecutiveDead} consecutive rounds. ` +
        `Stopping early rather than spending the remaining ${this.remaining} round(s) the same way.`;
    }
  }

  /**
   * Record a failed call and say whether the model is looping.
   * `repeat` counts how many times this exact call has now failed.
   */
  noteFailure(signature: string): { repeat: number; abort: boolean } {
    const repeat = (this.failureCounts.get(signature) ?? 0) + 1;
    this.failureCounts.set(signature, repeat);
    if (repeat >= this.repeatLimit) {
      this.stallReason =
        `The same tool call failed ${repeat} times in a row without changing. ` +
        `Stopping rather than repeating it further.`;
      return { repeat, abort: true };
    }
    return { repeat, abort: false };
  }

  repeatsFor(signature: string): number {
    return this.failureCounts.get(signature) ?? 0;
  }

  /**
   * Ultra mode only. A failed review is new, actionable information, so the
   * fix attempt gets its own rounds rather than eating what is left.
   *
   * Deliberately separate from `settleRound`: the dead-round counter is reset
   * because the model is being handed a concrete list of defects, which is not
   * the "spinning without reading or writing" situation `stallTolerance`
   * exists to catch. The `ceiling` is still respected — it is the hard safety
   * limit, and a review must not be able to punch through it.
   *
   * Returns how many rounds were actually granted (0 at the ceiling).
   */
  grantReviewRounds(amount: number): number {
    const room = this.ceiling - this.limit;
    if (room <= 0) return 0;
    const grant = Math.min(Math.max(1, Math.trunc(amount)), room);
    this.limit += grant;
    this.consecutiveDead = 0;
    this.stallReason = null;
    this.lastExtension = grant;
    this.lastReason = "review findings to fix";
    return grant;
  }
}

/* ------------------------------ system prompts --------------------------- */

const BASE_IDENTITY = `You are Omni-Claude, Lead Technical Collaborator, operating in Deep Cowork Mode.
You work alongside the developer as an expert pair-programmer and architectural strategist,
with direct read/write access to their VS Code workspace.`;

const EXECUTE_PROMPT = `${BASE_IDENTITY}

Work through these stages:
1. ORIENT: Establish which real files are involved. The workspace listing below is authoritative.
   Call list_files whenever a path you need is not already listed. Never guess a path,
   never use searchWeb to look for the user's own project files, and never ask the user
   to paste file paths — you can see the workspace yourself.
2. DEEP REASONING & PLANNING: read_file the targets, identify dependencies, and plan the
   smallest set of surgical edits that satisfies the request.
3. SURGICAL MODIFICATION:
   - ALWAYS prefer \`replace_text\` over rewriting a whole file.
   - Copy \`old_text\` out of a read_file result rather than from memory.
   - Line endings and trailing whitespace are normalised for you. Never retry an edit
     "with different line endings" — that is never the problem.
   - Use \`write_file\` only for brand-new files or a deliberate full replacement.
   - If an edit introduces a dependency, migration, or config the project does not already
     have, call \`require_setup\` in the same round. You cannot install anything yourself, and
     a dependency you imported but never mentioned is a broken build the user discovers later.
     Check the manifest (package.json, requirements.txt, go.mod) before claiming something is
     missing — already-present dependencies must not be listed.
4. SELF-CORRECTION: if replace_text reports 0 matches, re-read the region it points at and
   change your snippet. NEVER resend a call that already failed unchanged — a repeated
   identical call is detected and will end the run.
5. SYNTHESIS: state plainly which files changed and what changed in each. No raw HTML,
   no unformatted tool dumps.

Apply the edits. Do not stop at describing them, and do not paste a full file into chat as
a substitute for editing it.

You have a finite round budget, shown to you if it runs low. The budget EXTENDS whenever you
make real progress, so steady work is rewarded; it shrinks when rounds accomplish nothing.
If you are running out, write what you have learned and what remains as a short
"REMAINING WORK" list at the end of your reply — it is saved and a later session resumes from it.`;

const PLAN_PROMPT_HEAD = `${BASE_IDENTITY}

THIS IS THE PLANNING PASS. You are operating READ-ONLY: no write tools exist in this request.
Do not claim to have changed anything, and do not paste replacement files.

Your job is to investigate with list_files and read_file, then produce a plan a human can
approve in under a minute. Be concrete: name real files and real functions you have actually read.`;

const PLAN_PROMPT_FORMAT = `Answer in exactly this markdown shape and nothing else after it:

## Plan
- [ ] one concrete, verifiable step (name the file and what changes in it)
- [ ] the next step

## Next
The single first action you will take once approved.

Keep the plan to the smallest set of steps that satisfies the request. Prefer 3-8 steps.
Each step must be checkable by looking at a diff.`;

const PLAN_PROMPT_QUESTIONS = `## Questions
- any decision you genuinely cannot make from reading the code

Only ask about things that would change the code you write, and where the codebase does not
already answer it. Ambiguous requirements, competing valid designs, and destructive-change
confirmations are worth asking about. Do not ask for file paths, do not ask for code you can
read yourself, and do not ask stylistic questions you can answer from the surrounding file.
If nothing is genuinely blocking, write "## Questions" followed by "- none".`;

/* ------------------------------ ultra: review ---------------------------- */

/**
 * The Reviewer is a separate pass with the write tools removed, ideally running
 * on a different model than the one that wrote the code — a model auditing its
 * own output agrees with itself.
 */
const REVIEW_PROMPT = `You are an independent code reviewer auditing changes someone else just made.
You are NOT the author. Your job is to find real defects before this ships, not to be agreeable.

You are operating READ-ONLY: no write tools exist in this request. Do not propose to edit
anything yourself — report findings and the author will fix them.

METHOD — do this, in order:
1. read_file every file listed as changed. Do NOT trust the author's description of what they
   did; the description and the file contents disagree more often than you would expect.
2. For each change, ask: does this actually do what was asked? Does it break an existing caller?
3. Check specifically for: references to identifiers that are never declared or imported,
   dropped code (a constant or declaration that used to exist and no longer does), off-by-one
   and boundary errors, unhandled error paths, secrets or credentials written into source,
   missing authentication or authorisation checks on a route, and unvalidated user input
   reaching the filesystem, a shell, or a query.
4. Only report what you can point at in a file you actually read. No speculation, no style
   opinions, no "consider adding tests" unless a change is untestable as written.

SEVERITY — be honest, and do not inflate:
- [blocker] it is broken, insecure, or does not compile as written
- [major]   it works in the happy path but is wrong in a real case
- [minor]   worth fixing, not worth blocking
- [note]    an observation

Answer in exactly this markdown shape and nothing else:

## Verdict
PASS or FAIL

## Findings
- [blocker] path/to/file.ts - what is wrong, concretely
- [minor] path/to/other.ts - what is wrong, concretely

## Summary
One sentence on whether this is safe to keep.

If you genuinely found nothing, write "## Findings" followed by "- none" and PASS.
A PASS with a blocker listed underneath it is a contradiction and will be read as FAIL.`;

/** Sent back to the editor when the audit fails, so the fix pass is targeted. */
function buildFixInstruction(review: ReviewResult, cycle: number): string {
  const blocking = review.findings.filter(
    (f) => f.severity === "blocker" || f.severity === "major",
  );
  const other = review.findings.filter(
    (f) => f.severity !== "blocker" && f.severity !== "major",
  );

  const lines = [
    `INDEPENDENT REVIEW — CYCLE ${cycle} — CHANGES REJECTED.`,
    "",
    "A separate reviewer audited the files you just changed and found problems you must fix now.",
    "",
    "MUST FIX:",
    ...blocking.map(
      (f) => `  - [${f.severity}] ${f.path ? `${f.path}: ` : ""}${f.text}`,
    ),
  ];

  if (other.length) {
    lines.push(
      "",
      "ALSO RAISED (fix if cheap, do not let it distract from the above):",
      ...other.map(
        (f) => `  - [${f.severity}] ${f.path ? `${f.path}: ` : ""}${f.text}`,
      ),
    );
  }

  lines.push(
    "",
    "Re-read the exact region before editing it — do not fix from memory. When every MUST FIX",
    "item is addressed, reply with what you changed. Do not argue with the review; if a finding",
    "is genuinely wrong, say so in one line and explain why the existing code is already correct.",
  );

  return lines.join("\n");
}

const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "searchWeb",
    description:
      "Search the public web and third-party documentation. Use this ONLY for external libraries, APIs or error messages — never to locate files in the user's own workspace.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
};

/** Note-taking tool. Only offered in execute/auto phases. */
const REMEMBER_TOOL = {
  type: "function",
  function: {
    name: "remember",
    description:
      `Save a durable note about THIS project to ${CONTEXT_DIR}/knowledge so future sessions ` +
      "start out knowing it. Use it for things that were expensive to discover and will not " +
      "change: a module's real responsibility, a non-obvious constraint, a quirk that already " +
      "cost you rounds, or how a past bug was actually resolved. Do not use it for the current " +
      "task's progress (that is tracked for you) or for anything re-readable from one file.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Short specific title, e.g. 'app.py uses CRLF line endings'.",
        },
        body: {
          type: "string",
          description:
            "A few sentences. State the fact, then why it matters for future edits.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: 'Optional, e.g. ["encoding", "flask"].',
        },
      },
      required: ["title", "body"],
    },
  },
};

/** Read-only subset, by name. The plan phase gets exactly these. */
const READ_ONLY_TOOL_NAMES = new Set(["list_files", "read_file"]);

/**
 * Hand a setup step back to the developer.
 *
 * The agent cannot run shell commands, so when it writes code that imports a
 * package the project does not have, the install has to happen outside the run.
 * Saying so in prose does not survive — it scrolls away and the next session has
 * no idea. This writes it to `.omniroute/setup.md` instead.
 *
 * Named `require_setup` rather than `run_command` on purpose: it records an
 * instruction, it does not execute one. Nothing here can touch a shell.
 */
const SETUP_TOOL = {
  type: "function",
  function: {
    name: "require_setup",
    description:
      `Record a command the DEVELOPER must run for your changes to work, saved to ${CONTEXT_DIR}/setup.md. ` +
      "You cannot run commands yourself. Call this the moment you write code that " +
      "depends on something not currently installed or configured — a package you " +
      "imported, a migration, an env var, a build step. Do NOT use it for commands " +
      "that are merely nice to run (tests, linters, formatters), and do not record " +
      "a dependency the project already has: check the manifest first.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The exact command to run, e.g. 'npm install zod'. One command per call.",
        },
        reason: {
          type: "string",
          description:
            "Which file or feature needs it, e.g. 'src/lib/validate.ts imports zod'.",
        },
        kind: {
          type: "string",
          enum: ["dependency", "command", "manual"],
          description:
            "'dependency' to install something, 'command' for a build/migration step, " +
            "'manual' for something the developer must do by hand (e.g. set an env var).",
        },
      },
      required: ["command", "reason"],
    },
  },
};

/* --------------------------------- helpers -------------------------------- */

async function postStream(
  creds: GatewayCreds,
  model: string,
  messages: Message[],
  tools?: any[],
): Promise<Response> {
  const payload: any = {
    model,
    messages,
    stream: true,
    max_tokens: 32768,
  };
  if (tools && tools.length) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }

  /* Routed through the shared upstream layer so this works against any
   * configured provider — the auth header, the endpoint path and the
   * non-SSE-to-SSE normalisation all come from the provider profile. */
  return postChatCompletionStream(targetFromCreds(creds), payload);
}

/** A short, human-readable summary of a tool call for the UI chip. */
function describeToolCall(name: string, rawArgs: string): string {
  let args: any = {};
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    /* partial or malformed arguments */
  }

  const target = args.file_path || args.path || args.filePath || args.dir || "";

  switch (name) {
    case "list_files":
      return `list_files ${target || "(workspace root)"}${
        args.pattern ? ` pattern="${args.pattern}"` : ""
      }`;
    case "read_file":
      return `read_file ${target}${
        args.start_line
          ? ` lines ${args.start_line}-${args.end_line ?? "end"}`
          : ""
      }`;
    case "replace_text":
      return `replace_text ${target}`;
    case "write_file":
      return `write_file ${target}`;
    case "remember":
      return `remember "${String(args.title || "").slice(0, 60)}"`;
    case "searchWeb":
      return `searchWeb "${String(args.query || "").slice(0, 60)}"`;
    default:
      return name;
  }
}

function targetOf(args: any): string {
  return String(
    args?.file_path ?? args?.path ?? args?.filePath ?? args?.dir ?? "",
  );
}

function safeParseArgs(raw: string): any {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

/** Last user message, flattened out of whatever shape the client sent. */
function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .map((part: any) =>
          typeof part === "string" ? part : (part?.text ?? ""),
        )
        .join(" ");
    }
  }
  return "";
}

/**
 * Did a tool result report success? Tool results are JSON strings from
 * `executeWorkspaceTool`, which never throws — so this is how the pipeline
 * learns whether a round actually accomplished anything.
 */
function readToolOutcome(resultText: string): {
  ok: boolean;
  error?: string;
  hash?: string;
  totalLines?: number;
  detail?: string;
} {
  let parsed: any;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return { ok: true, detail: "unparsed result" };
  }
  if (parsed && typeof parsed === "object") {
    if (parsed.success === false || typeof parsed.error === "string") {
      return {
        ok: false,
        error: String(parsed.error || "reported failure").slice(0, 400),
      };
    }
    const body =
      typeof parsed.content === "string"
        ? parsed.content
        : typeof parsed.text === "string"
          ? parsed.text
          : "";
    return {
      ok: true,
      ...(body ? { hash: shortHash(body) } : {}),
      ...(typeof parsed.totalLines === "number"
        ? { totalLines: parsed.totalLines }
        : {}),
      ...(typeof parsed.note === "string" ? { detail: parsed.note } : {}),
      ...(typeof parsed.matchStrategy === "string"
        ? { detail: `match: ${parsed.matchStrategy}` }
        : {}),
    };
  }
  return { ok: true };
}

/**
 * Escalating guidance appended to a repeated failure's tool result. The model
 * gets a different message the second time, which is what breaks the loop —
 * handing back the identical error invites the identical call.
 */
function repeatGuidance(repeat: number, tool: string): string {
  if (repeat <= 1) return "";
  if (repeat === 2) {
    return (
      ` STOP: this is attempt ${repeat} of the SAME ${tool} call and it failed identically. ` +
      "Do not send it again. Re-read the exact region with read_file (use start_line/end_line) " +
      "and build old_text from what you actually see, or take a different approach entirely. " +
      "Line endings are not the problem — they are normalised for you."
    );
  }
  return (
    ` HARD STOP: ${repeat} identical failed attempts. This run will end if you repeat it. ` +
    "Summarise what you learned and what remains instead."
  );
}

/* -------------------------- ultra: the review pass ------------------------ */

/**
 * Decide which model(s) to try for the review pass, best first.
 *
 * The point of a reviewer is a SECOND OPINION, and a model reviewing its own
 * output is the weakest possible version of that — it tends to re-affirm the
 * reasoning it just used. So when the user has not named a reviewer, prefer a
 * genuinely different model already present in the failover ladder.
 *
 * Not every ladder entry qualifies. `account-retry` and `provider-swap` are the
 * same weights reached by another route, so they are no more independent than
 * self-review; only `version-drift` and `combo-fallback` are actually different
 * models. Those are the kinds worth reaching for.
 *
 * Only entries AFTER the active one are considered. Anything earlier in the
 * ladder already failed this run — that is why the loop advanced past it — so
 * preferring one would mean sending the audit to a model that just returned a
 * quota or server error.
 *
 * Returns an ordered list rather than one id, because the fallback discipline
 * matters more than the preference: the LAST entry is always the model we know
 * answered successfully this run. That guarantees choosing a diverse reviewer
 * can never leave the run less audited than not choosing one — the exact
 * failure mode that made pinning a "strongest" model unusable when its quota
 * ran out.
 */
function reviewModelCandidates(
  ladder: Candidate[],
  activeIndex: number,
  override?: string,
): string[] {
  const working = ladder[activeIndex]?.id ?? "";

  // An explicit choice wins outright, but still falls back to what works.
  const explicit = override?.trim();
  if (explicit) {
    return explicit === working ? [working] : [explicit, working];
  }

  const seen = new Set<string>([working]);
  const diverse: string[] = [];
  for (const c of ladder.slice(activeIndex + 1)) {
    if (c.kind !== "version-drift" && c.kind !== "combo-fallback") continue;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    diverse.push(c.id);
  }

  /* No genuinely different model available, so self-review it is. Note that
   * when the selection was a combo this is not really self-review: the ladder
   * is one entry, the gateway picks the concrete model per request, and a
   * second call can well land on different weights. */
  return [...diverse, working];
}

/**
 * Run one bounded, strictly read-only completion loop and return its final prose.
 *
 * This is deliberately a plain function rather than part of the main generator:
 * the Reviewer's intermediate chatter is not the deliverable, so it is not
 * streamed to the UI. Only the parsed verdict is.
 *
 * It never throws for tool problems — a reviewer that cannot read a file should
 * say so in its findings rather than kill a run whose edits already landed.
 * Gateway failures DO throw, so the caller can decide whether to fail over.
 */
async function runReadOnlyPass(
  creds: GatewayCreds,
  /** Whose editor the Reviewer reads from. Required for the same reason as
   *  everywhere else: a reviewer auditing the wrong person's files produces
   *  confident findings about code the user never wrote. */
  userId: string | null,
  model: string,
  messages: Message[],
  maxRounds: number,
  onTool?: (name: string, details: string) => void,
): Promise<string> {
  const convo: Message[] = [...messages];
  /* The reviewer may read the reference project too — comparing the code under
   * review against how it was done in project 1 is exactly the kind of thing a
   * reviewer wants to do, and every reference tool is read-only, so it fits the
   * audit-not-edit contract without loosening it. Empty when no reference
   * project is configured. */
  const readOnlyTools = [
    ...WORKSPACE_TOOLS.filter((t: any) =>
      READ_ONLY_TOOL_NAMES.has(t.function.name),
    ),
    ...referenceToolsFor(userId),
  ];

  let finalText = "";

  /* One extra round beyond the reading budget: it runs with NO tools attached,
   * so the model physically cannot ask for another file and has to commit to a
   * verdict. This is also why there is no recursion here — an earlier draft of
   * this function re-entered itself to force the verdict, which could loop
   * forever, re-issuing gateway requests each time. */
  for (let round = 0; round <= maxRounds; round++) {
    const verdictOnly = round === maxRounds;
    if (verdictOnly) {
      convo.push({
        role: "system",
        content:
          "No more reading rounds. Give your verdict now, based only on what you have " +
          "actually read. If you could not read enough to judge something, say so as a finding.",
      });
    }

    const res = await postStream(
      creds,
      model,
      convo,
      verdictOnly ? undefined : readOnlyTools,
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw gatewayFailure(res.status, errText, providerLabel(creds));
    }
    if (!res.body) throw gatewayFailure(0, "Empty stream response body.", providerLabel(creds));

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const toolCallsAcc: Record<
      number,
      { id?: string; name?: string; args: string }
    > = {};

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") continue;

        let json: any;
        try {
          json = JSON.parse(dataStr);
        } catch {
          continue;
        }

        if (json.error) {
          const message =
            typeof json.error === "string"
              ? json.error
              : json.error.message || JSON.stringify(json.error);
          throw gatewayFailure(json.error?.status || 200, message, providerLabel(creds));
        }

        const choice = json.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta || {};
        if (typeof delta.content === "string") content += delta.content;

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = toolCallsAcc[idx] || (toolCallsAcc[idx] = { args: "" });
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
          }
        }
      }
    }

    const calls = Object.values(toolCallsAcc)
      .filter((t) => t.name)
      .map((t) => ({
        id:
          t.id ||
          `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        type: "function",
        function: { name: t.name as string, arguments: t.args || "{}" },
      }));

    if (calls.length === 0) {
      /* Don't let a blank final round wipe out prose we already captured. */
      if (content.trim() || !finalText) finalText = content;
      break;
    }

    /* Keep the last prose we saw: if the loop runs out of rounds mid-audit, a
     * partial verdict still parses better than an empty string. */
    if (content.trim()) finalText = content;

    const toolResponses: Message[] = [];
    for (const tc of calls) {
      const fnName = tc.function.name;
      const args = safeParseArgs(tc.function.arguments);
      onTool?.(fnName, describeToolCall(fnName, tc.function.arguments));

      let resultText: string;
      if (READ_ONLY_TOOL_NAMES.has(fnName)) {
        resultText = await executeWorkspaceTool(fnName, args, userId);
      } else if (REFERENCE_TOOL_NAMES.has(fnName)) {
        /* Read-only against the second folder — allowed during review for the
         * same reason it is offered: it cannot change anything. */
        resultText = await executeReferenceTool(fnName, args, userId);
      } else {
        /* Belt and braces, same as the planning pass: the tool was not offered,
         * but a model can still hallucinate a call to it. */
        resultText = JSON.stringify({
          success: false,
          error:
            `${fnName} is unavailable during review. You are auditing, not editing. ` +
            "Report the problem as a finding instead.",
        });
      }

      toolResponses.push({
        role: "tool",
        tool_call_id: tc.id,
        name: fnName,
        content: resultText,
      });
    }

    convo.push({
      role: "assistant",
      content: content || null,
      tool_calls: calls,
    });
    for (const tr of toolResponses) convo.push(tr);
  }

  return finalText;
}

/* -------------------------------- the loop -------------------------------- */

export async function* runDeepCoworkPipeline(
  targetModel: string,
  ladder: Candidate[],
  messages: Message[],
  tavilyApiKey: string | undefined,
  options: DeepCoworkOptions,
): AsyncGenerator<CoworkPipelineEvent> {
  const phase: DeepPhase = options.phase ?? "auto";
  const planningOnly = phase === "plan";

  /* Pulled out once. Every file-touching call in this pipeline passes it, and
   * reading `options.userId` at each of those sites would make it easy for a
   * later edit to reach for some other user-ish variable in scope. */
  const userId = options.userId;

  /* Resolve once for the whole run. A pipeline can span many minutes and dozens
   * of upstream calls; re-reading per call would let a credential change
   * mid-run swap the gateway underneath an in-flight task. */
  const creds: GatewayCreds = options.creds ?? resolveGatewayCreds(null);

  yield {
    kind: "stage",
    stage: "planning",
    label: planningOnly
      ? "Investigating & Drafting a Plan"
      : "Deep Reasoning & Architecture Planning",
  };

  /* ---- workspace + durable context ---- */

  const workspaceContext = await buildWorkspaceContext(userId);

  let workspaceRoot = "";
  try {
    /* Also owner-scoped: the root is a property of the connected editor, and
     * without a context this would return whatever the single-user discovery
     * path finds on the server (its own cwd), which is not this user's project
     * and would send `buildKnowledgeContext` reading the server's disk. */
    workspaceRoot = await withWorkspaceOwner(userId, () =>
      vscodeBridge.workspaceRoot(),
    );
  } catch {
    workspaceRoot = "";
  }

  /* Where the run's own notes, task artifacts and journal are written.
   *
   * Locally this IS `workspaceRoot`, so `.omniroute/` appears inside the user's
   * repo exactly as before — including the empty-string case, which keeps every
   * `if (stateRoot)` guard below behaving the way `if (workspaceRoot)` did.
   *
   * On a shared deployment it is a per-user directory beside the database,
   * because `workspaceRoot` there is a path on somebody else's laptop and
   * joining onto it produces a junk directory inside the container. See
   * agentStateRoot for the full reasoning. */
  const stateRoot = agentStateRoot(workspaceRoot, userId);

  const knowledgeContext = stateRoot
    ? await buildKnowledgeContext(stateRoot)
    : "";

  /* ---- resume: explicit id, or an unfinished task plus "continue" ---- */

  const userText = lastUserText(messages);
  let resumed: TaskArtifact | null = null;

  if (stateRoot) {
    if (options.resumeTaskId) {
      resumed = await loadTask(stateRoot, options.resumeTaskId);
    } else if (looksLikeContinueIntent(userText)) {
      resumed = await findResumableTask(stateRoot);
    }
  }

  /* ---- task artifact ---- */

  let task: TaskState =
    resumed?.state ??
    newTaskState({
      request: userText || targetModel,
      workspaceRoot: workspaceRoot || "(unresolved)",
      model: targetModel,
      status: planningOnly ? "planning" : "executing",
    });

  if (resumed) {
    task = {
      ...task,
      attempts: task.attempts + 1,
      status: planningOnly ? "planning" : "executing",
      model: targetModel,
      ...(options.answers && options.answers.length
        ? { answers: options.answers }
        : {}),
    };
    yield {
      kind: "notice",
      notice: {
        type: "resume",
        title: "Resuming an earlier task",
        message:
          `Picking up "${task.title}" — ${task.roundsUsed} round(s) already spent, ` +
          `${task.edits.filter((e) => e.ok).length} edit(s) already applied. ` +
          "Previous reads, edits and dead ends were loaded instead of being redone.",
        taskId: task.id,
      },
    };
  } else if (options.answers && options.answers.length) {
    task = { ...task, answers: options.answers };
  }

  const persist = async (patch: Partial<TaskState> = {}) => {
    if (!stateRoot) return null;
    task = { ...task, ...patch, updatedAt: nowIso() };
    return saveTask(stateRoot, task);
  };

  const firstSave = await persist();
  if (firstSave) {
    yield {
      kind: "task",
      task: {
        id: task.id,
        file: firstSave.relative,
        status: task.status,
        roundsUsed: task.roundsUsed,
        ...(resumed ? { resumed: true } : {}),
      },
    };
  }

  /* ---- prompt assembly ---- */

  const planPrompt = [
    PLAN_PROMPT_HEAD,
    "",
    PLAN_PROMPT_FORMAT,
    ...(options.askQuestions ? ["", PLAN_PROMPT_QUESTIONS] : []),
  ].join("\n");

  const systemParts = [
    planningOnly ? planPrompt : EXECUTE_PROMPT,
    workspaceContext,
  ];
  if (knowledgeContext) systemParts.push(knowledgeContext);
  if (resumed) systemParts.push(renderTaskForPrompt(task));
  if (!planningOnly && task.steps.length > 0 && !resumed) {
    systemParts.push(renderTaskForPrompt(task));
  }
  if (task.questions.length > 0 && task.answers.length > 0) {
    systemParts.push(
      [
        "=== ANSWERS FROM THE DEVELOPER ===",
        ...task.questions.map(
          (q, i) => `Q: ${q}\nA: ${task.answers[i] || "(unanswered)"}`,
        ),
        "Treat these as settled. Do not ask them again.",
        "=== END ANSWERS ===",
      ].join("\n"),
    );
  }

  /* Last, so it is the most specific thing in the prompt. A slash command's
   * objective has to outrank the generic execute prompt above it. */
  if (options.objective && options.objective.trim()) {
    systemParts.push(options.objective.trim());
  }

  const activeMessages: Message[] = [
    { role: "system", content: systemParts.join("\n\n") },
    ...messages.filter((m) => m.role !== "system"),
  ];

  /* ---- tools: the plan phase physically cannot write ---- */

  /* Two different reasons to withhold write tools: the plan phase, and a
   * read-only slash command. Both mean "cannot touch source", so they share the
   * filter — but only the plan phase also withholds the remember tool, because
   * `/init`'s entire job is to write knowledge files. */
  const noSourceWrites = planningOnly || Boolean(options.readOnly);

  const workspaceSubset = noSourceWrites
    ? WORKSPACE_TOOLS.filter((t: any) =>
        READ_ONLY_TOOL_NAMES.has(t.function.name),
      )
    : WORKSPACE_TOOLS;

  const tools: any[] = [...workspaceSubset];
  if (!planningOnly) tools.push(REMEMBER_TOOL);
  /* Only when the run can actually write code — a read-only pass has no new
   * dependencies to declare, and the plan phase has not written anything yet. */
  if (!noSourceWrites) tools.push(SETUP_TOOL);
  if (tavilyApiKey) tools.push(SEARCH_TOOL);
  /* The reference project is available in every phase, including planning —
   * reading how project 1 did something is precisely what informs the plan for
   * project 2, and every reference tool is read-only so it never conflicts with
   * the "plan phase cannot write" rule. Empty when none is configured. */
  tools.push(...referenceToolsFor(userId));

  /* ---- budget ---- */

  /* Client settings, then clamp. These arrive from localStorage, so any of them
   * can be absent, a string, or non-finite — and a non-finite ceiling is the
   * dangerous one: `ceiling - limit` becomes NaN, which silently disables budget
   * extension and leaks "NaN"/"Infinity" into the round badge. */
  const settings = options.roundSettings || {};
  const clampInt = (value: unknown, fallback: number, min: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed)
      ? Math.max(min, Math.trunc(parsed))
      : fallback;
  };

  const configuredStart = clampInt(
    settings.startIterations,
    START_ITERATIONS,
    2,
  );
  const configuredCeiling = clampInt(
    settings.ceilingIterations,
    CEILING_ITERATIONS,
    configuredStart,
  );
  const configuredExtend = clampInt(
    settings.extendAmount,
    EXTEND_ON_PROGRESS,
    1,
  );
  const configuredStallTolerance = clampInt(
    settings.stallTolerance,
    STALL_TOLERANCE,
    2,
  );
  const configuredRepeatLimit = clampInt(settings.repeatLimit, REPEAT_LIMIT, 2);
  const configuredPlanStart = clampInt(settings.planStartIterations, 8, 2);
  const configuredPlanCeiling = clampInt(
    settings.planCeilingIterations,
    16,
    configuredPlanStart,
  );

  const requestedStart = Number(options.maxIterations);
  const startBudget =
    Number.isFinite(requestedStart) && requestedStart >= 2
      ? Math.min(Math.floor(requestedStart), configuredCeiling)
      : configuredStart;

  // Planning is investigation only; it should not need a long leash.
  const budget = new RoundBudget(
    planningOnly ? Math.min(startBudget, configuredPlanStart) : startBudget,
    planningOnly ? Math.min(configuredCeiling, configuredPlanCeiling) : configuredCeiling,
    configuredExtend,
    configuredStallTolerance,
    configuredRepeatLimit
  );

  yield {
    kind: "budget",
    budget: { used: 0, limit: budget.limit, ceiling: budget.ceiling },
  };

  /* ---- per-run accumulators ---- */

  let account: string | null = null;
  let servedModel: string | null = null;
  let activeCandidate: Candidate | null = null;
  let totalRequests = 0;
  let finalText = "";

  /* Keyed on path + line span, NOT bare path. `read_file`'s truncation notice
   * tells the model to page a large file with start_line/end_line; keying on the
   * path alone made every page after the first score zero fresh reads and drove
   * correct behaviour straight into the stall abort. */
  const readKeys = new Set(task.reads.map((r) => readKey(r.path, r.span)));
  const newReads: RecordedRead[] = [];
  const newEdits: RecordedEdit[] = [];
  const newFailures: RecordedFailure[] = [];
  const newKnowledge: string[] = [];
  /* Setup steps the agent asked for. Collected so one notice can summarise them
   * at the end rather than interrupting the run with a card per dependency. */
  const newSetup: string[] = [];
  /* True if any of those could not actually be written to disk, so the closing
   * notice does not claim a file was written when it was not. */
  let setupWriteFailed = false;

  /* Ultra mode review state. Declared outside the ladder loop so a mid-run
   * failover cannot reset the cycle counter and restart the audit from one. */
  const reviewEnabled = Boolean(options.ultra) && !planningOnly;
  const maxReviewCycles = clampInt(
    options.maxReviewCycles,
    MAX_REVIEW_CYCLES,
    1,
  );
  let reviewCycle = 0;
  let lastReview: ReviewResult | null = null;

  // Dead ends carried in from a previous attempt count toward the repeat limit,
  // so a resumed run cannot re-burn the budget on the same doomed call.
  for (const f of task.failures) {
    if (f.signature) budget.noteFailure(f.signature);
  }
  budget.stallReason = null;

  for (let i = 0; i < ladder.length; i++) {
    const candidate = ladder[i];

    try {
      yield {
        kind: "stage",
        stage: planningOnly ? "planning" : "executing",
        label: planningOnly
          ? `Investigating via ${prettyModelName(candidate.id)}`
          : `Executing via ${prettyModelName(candidate.id)}`,
      };

      while (!budget.exhausted && !budget.stalled) {
        budget.startRound();
        totalRequests += 1;

        // Warn the model when the leash is short, so it can wrap up cleanly
        // rather than being cut off mid-thought.
        if (budget.remaining <= 2) {
          activeMessages.push({
            role: "system",
            content:
              `BUDGET WARNING: ${budget.remaining} round(s) left. Finish the current edit if you ` +
              "can, then reply with what changed and a short 'REMAINING WORK' list. " +
              "Progress extends the budget; repeated failures do not.",
          });
        }

        const res = await postStream(creds, candidate.id, activeMessages, tools);

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw gatewayFailure(res.status, errText, providerLabel(creds));
        }

        const acc = accountFromHeaders(res.headers);
        const upstream = upstreamModelFromHeaders(res.headers);
        if (acc) account = acc;
        if (upstream) servedModel = upstream;

        if (!res.body) throw gatewayFailure(0, "Empty stream response body.", providerLabel(creds));

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let assistantContent = "";
        const toolCallsAcc: Record<
          number,
          { id?: string; name?: string; args: string }
        > = {};

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue;
            const dataStr = line.slice(5).trim();
            if (!dataStr || dataStr === "[DONE]") continue;

            let json: any;
            try {
              json = JSON.parse(dataStr);
            } catch {
              continue; // partial chunk
            }

            // An error can arrive inside a 200 stream; it must still fail over.
            if (json.error) {
              const message =
                typeof json.error === "string"
                  ? json.error
                  : json.error.message || JSON.stringify(json.error);
              throw gatewayFailure(
                json.error?.status || 200,
                message,
                providerLabel(creds),
              );
            }

            if (typeof json.model === "string" && json.model) {
              servedModel = json.model;
            }

            const choice = json.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta || {};
            if (typeof delta.content === "string" && delta.content.length > 0) {
              assistantContent += delta.content;
              // In the plan phase the prose IS the deliverable, so stream it.
              yield { kind: "delta", text: delta.content };
            }

            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const cur =
                  toolCallsAcc[idx] || (toolCallsAcc[idx] = { args: "" });
                if (tc.id) cur.id = tc.id;
                if (tc.function?.name) cur.name = tc.function.name;
                if (tc.function?.arguments) cur.args += tc.function.arguments;
              }
            }
          }
        }

        const formattedToolCalls = Object.values(toolCallsAcc)
          .filter((t) => t.name)
          .map((t) => ({
            id:
              t.id ||
              `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            type: "function",
            function: { name: t.name as string, arguments: t.args || "{}" },
          }));

        /* ---- no tool calls: this was the final answer ---- */
        if (formattedToolCalls.length === 0) {
          finalText = assistantContent;
          yield {
            kind: "stage",
            stage: "synthesizing",
            label: planningOnly
              ? "Writing the Plan for Review"
              : "Final Code Synthesis & Review",
          };
          activeCandidate = candidate;

          /* ---- ultra: independent review before we call it done ----
           *
           * This sits INSIDE the round loop on purpose. A failed review pushes
           * a fix instruction and `continue`s, so the repair turn reuses the
           * existing repeat detection, edit recording, budget accounting and
           * failover instead of a second copy of all of it.
           *
           * `reviewEnabled` is false unless ultra is on, so Deep Cowork's
           * behaviour here is byte-for-byte what it was. */
          if (reviewEnabled) {
            /* Both sources: `persist()` folds `newEdits` into `task.edits` each
             * round, but it no-ops when there is no workspaceRoot, in which
             * case the only record of the edits is still in `newEdits`. */
            const changed = Array.from(
              new Set(
                [...task.edits, ...newEdits]
                  .filter((e) => e.ok)
                  .map((e) => e.path),
              ),
            );

            /* Nothing was written, so there is nothing to audit. Reviewing a
             * pure explanation would be theatre. */
            if (changed.length > 0 && reviewCycle < maxReviewCycles) {
              reviewCycle += 1;
              yield {
                kind: "stage",
                stage: "verifying",
                label:
                  reviewCycle === 1
                    ? `Independent review of ${changed.length} changed file(s)`
                    : `Re-reviewing after fixes (cycle ${reviewCycle})`,
              };

              const attemptModels = reviewModelCandidates(
                ladder,
                i,
                options.reviewModel,
              );
              let review: ReviewResult | null = null;
              let auditModel = attemptModels[0];
              let reviewErr: any = null;

              /* Try each reviewer in turn. The list ends with the model we know
               * works, so a quota-dead first choice costs one failed request
               * rather than the whole audit. */
              for (const model of attemptModels) {
                try {
                  const reviewText = await runReadOnlyPass(
                    creds,
                    userId,
                    model,
                    [
                      { role: "system", content: REVIEW_PROMPT },
                      { role: "system", content: workspaceContext },
                      {
                        role: "user",
                        content: [
                          `TASK: ${task.title}`,
                          "",
                          "FILES CHANGED (audit every one):",
                          ...changed.map((p) => `  - ${p}`),
                          "",
                          "The author's own account of the work is below. It is a claim, not",
                          "evidence. Verify it against the files themselves.",
                          "",
                          "--- author's summary ---",
                          assistantContent.slice(0, 4000),
                          "--- end author's summary ---",
                        ].join("\n"),
                      },
                    ],
                    REVIEW_READ_ROUNDS,
                  );

                  auditModel = model;
                  reviewErr = null;
                  const parsed = extractReviewFromText(reviewText, reviewCycle);
                  review = { ...parsed, model };
                  break;
                } catch (err: any) {
                  reviewErr = err;
                }
              }

              if (!review) {
                /* The edits already landed. A reviewer that cannot run is a
                 * reason to tell the user the work is unaudited — not a reason
                 * to throw away a finished run or trigger failover. */
                yield {
                  kind: "notice",
                  notice: {
                    type: "warning",
                    title: "Review could not run",
                    message:
                      `The independent review pass failed (${
                        reviewErr?.message || String(reviewErr)
                      }). The changes above were applied but have NOT been audited.`,
                  },
                };
              } else if (auditModel === candidate.id && attemptModels.length > 1) {
                /* A diverse reviewer was available but unreachable. Say so —
                 * self-review is a materially weaker audit and the user should
                 * know which one they got. */
                yield {
                  kind: "notice",
                  notice: {
                    type: "warning",
                    title: "Reviewed by the same model that wrote the code",
                    message:
                      `A second opinion from ${attemptModels[0]} was not reachable, so ` +
                      "the audit below is self-review. Treat a pass verdict with more caution.",
                  },
                };
              }

              if (review) {
                lastReview = review;
                yield {
                  kind: "review",
                  review: {
                    cycle: reviewCycle,
                    maxCycles: maxReviewCycles,
                    passed: review.passed,
                    summary: review.summary,
                    model: auditModel,
                    findings: review.findings,
                  },
                };

                if (!review.passed && reviewCycle < maxReviewCycles) {
                  const granted = budget.grantReviewRounds(REVIEW_FIX_ROUNDS);
                  if (granted > 0) {
                    /* The assistant's final answer never got pushed (the loop
                     * breaks here normally), so push it before the critique or
                     * the fix instruction refers to a turn that isn't in the
                     * transcript. */
                    activeMessages.push({
                      role: "assistant",
                      content:
                        assistantContent ||
                        "(finished without a written summary)",
                    });
                    activeMessages.push({
                      role: "user",
                      content: buildFixInstruction(review, reviewCycle),
                    });
                    continue;
                  }

                  yield {
                    kind: "notice",
                    notice: {
                      type: "warning",
                      title: "No budget left to apply review fixes",
                      message:
                        "The review found problems, but the round ceiling was reached. " +
                        "The findings are recorded on the task — send 'continue' to act on them.",
                    },
                  };
                }
              }
            }
          }

          break;
        }

        yield {
          kind: "stage",
          stage: "verifying",
          label: planningOnly
            ? "Reading the Project"
            : "Applying Surgical Edits & Validating Context",
        };

        const toolResponses: Message[] = [];
        let roundEdits = 0;
        let roundFreshReads = 0;
        let roundFailures = 0;
        let abortNow = false;

        for (const tc of formattedToolCalls) {
          const fnName = tc.function.name;
          const args = safeParseArgs(tc.function.arguments);
          const target = targetOf(args);
          const signature = callSignature(fnName, args);

          yield {
            kind: "tool",
            name: fnName,
            details: describeToolCall(fnName, tc.function.arguments),
          };

          let resultText: string;

          if (
            planningOnly &&
            !READ_ONLY_TOOL_NAMES.has(fnName) &&
            !REFERENCE_TOOL_NAMES.has(fnName) &&
            fnName !== "searchWeb"
          ) {
            // Belt and braces: the tool was not offered, but a model can still
            // hallucinate a call to it. Reference tools are exempt because they
            // are read-only — reading project 1 during planning is fine.
            resultText = JSON.stringify({
              success: false,
              error:
                `${fnName} is unavailable during the planning pass. Describe the change as a ` +
                "plan step instead; it will run after the developer approves.",
            });
          } else if (WORKSPACE_TOOL_NAMES.has(fnName)) {
            resultText = await executeWorkspaceTool(fnName, args, userId);
          } else if (REFERENCE_TOOL_NAMES.has(fnName)) {
            /* Read-only against the second folder, in every phase. */
            resultText = await executeReferenceTool(fnName, args, userId);
          } else if (fnName === "remember") {
            if (!stateRoot) {
              resultText = JSON.stringify({
                success: false,
                error: "No workspace root resolved, so notes cannot be saved.",
              });
            } else {
              const slug = await saveKnowledge(stateRoot, {
                title: String(args?.title || "note"),
                body: String(args?.body || ""),
                tags: Array.isArray(args?.tags)
                  ? args.tags.map((t: any) => String(t))
                  : [],
              });
              if (slug) newKnowledge.push(slug);
              resultText = JSON.stringify(
                slug
                  ? {
                      success: true,
                      saved: `${CONTEXT_DIR}/knowledge/${slug}.md`,
                    }
                  : { success: false, error: "Could not write the note." },
              );
            }
          } else if (fnName === "require_setup") {
            if (!stateRoot) {
              resultText = JSON.stringify({
                success: false,
                error: "No workspace root resolved, so setup steps cannot be saved.",
              });
            } else {
              const written = await recordSetup(stateRoot, [
                {
                  command: String(args?.command || ""),
                  reason: String(args?.reason || ""),
                  kind: String(args?.kind || "command"),
                },
              ]);
              resultText = JSON.stringify(
                written === null
                  ? { success: false, error: "Could not write the setup file." }
                  : written === 0
                    ? {
                        success: true,
                        saved: false,
                        note: "Already recorded; not duplicated.",
                      }
                    : {
                        success: true,
                        saved: `${CONTEXT_DIR}/setup.md`,
                        note: "The developer runs this after the task.",
                      },
              );
              if (written === null || written > 0) {
                newSetup.push(String(args?.command || "").trim());
              }
              if (written === null) setupWriteFailed = true;
            }
          } else if (fnName === "searchWeb") {
            if (!tavilyApiKey) {
              resultText = JSON.stringify({
                error: "Web search is not configured (TAVILY_API_KEY missing).",
              });
            } else {
              try {
                const tvly = tavily({ apiKey: tavilyApiKey });
                const sr = await tvly.search(String(args.query || ""), {
                  searchDepth: "basic",
                  maxResults: 3,
                });
                resultText = JSON.stringify(
                  sr.results.map((x: any) => ({
                    title: x.title,
                    url: x.url,
                    content: String(x.content || "").slice(0, 2000),
                  })),
                );
              } catch (err: any) {
                resultText = JSON.stringify({
                  error: err?.message || String(err),
                });
              }
            }
          } else {
            resultText = JSON.stringify({
              error: `Unknown tool: ${fnName}`,
              availableTools: tools.map((t: any) => t.function.name),
            });
          }

          /* ---- account for what that call actually did ---- */

          const outcome = readToolOutcome(resultText);

          if (!outcome.ok) {
            roundFailures += 1;
            const { repeat, abort } = budget.noteFailure(signature);
            newFailures.push({
              tool: fnName,
              path: target,
              signature,
              error: outcome.error || "failed",
              at: nowIso(),
            });

            const guidance = repeatGuidance(repeat, fnName);
            if (guidance) {
              // Rewrite the tool result so a repeat gets a *different* message.
              try {
                const obj = JSON.parse(resultText);
                obj.error = String(obj.error || "failed") + guidance;
                obj.repeatedAttempts = repeat;
                resultText = JSON.stringify(obj);
              } catch {
                resultText = JSON.stringify({
                  success: false,
                  error: (outcome.error || "failed") + guidance,
                  repeatedAttempts: repeat,
                });
              }
            }
            if (abort) abortNow = true;
          } else if (fnName === "read_file") {
            const span = spanOfArgs(args);
            const key = readKey(target, span);
            if (target && !readKeys.has(key)) {
              readKeys.add(key);
              roundFreshReads += 1;
              newReads.push({
                path: target,
                hash: outcome.hash || "",
                ...(span ? { span } : {}),
                ...(outcome.totalLines
                  ? { totalLines: outcome.totalLines }
                  : {}),
                at: nowIso(),
              });
            }
          } else if (fnName === "replace_text" || fnName === "write_file") {
            roundEdits += 1;
            newEdits.push({
              path: target,
              tool: fnName,
              ok: true,
              ...(outcome.detail ? { detail: outcome.detail } : {}),
              at: nowIso(),
            });
          }

          toolResponses.push({
            role: "tool",
            tool_call_id: tc.id,
            name: fnName,
            content: resultText,
          });
        }

        activeMessages.push({
          role: "assistant",
          content: assistantContent || null,
          tool_calls: formattedToolCalls,
        });
        for (const tr of toolResponses) {
          activeMessages.push(tr);
        }

        /* ---- settle the budget for this round ---- */

        const before = budget.limit;
        budget.settleRound({
          successfulEdits: roundEdits,
          freshReads: roundFreshReads,
          failures: roundFailures,
        });

        yield {
          kind: "budget",
          budget: {
            used: budget.used,
            limit: budget.limit,
            ceiling: budget.ceiling,
            ...(budget.limit > before
              ? { extendedBy: budget.limit - before, reason: budget.lastReason }
              : {}),
          },
        };

        /* ---- checkpoint progress to disk every round ---- */

        await persist({
          roundsUsed: task.roundsUsed + budget.used,
          reads: [...task.reads, ...newReads.splice(0)],
          edits: [...task.edits, ...newEdits.splice(0)],
          failures: [...task.failures, ...newFailures.splice(0)],
          knowledge: Array.from(
            new Set([...task.knowledge, ...newKnowledge.splice(0)]),
          ),
        });

        if (abortNow) break;
      }

      if (activeCandidate) break;

      /* ---- ran out of rounds, or stalled ---- */
      if (budget.exhausted || budget.stalled) {
        const diagnosis =
          budget.stallReason ??
          `Spent all ${budget.used} rounds (budget grew to ${budget.limit}) without a final answer.`;

        const appliedEdits = task.edits.filter((e) => e.ok);
        const saved = await persist({
          status: "stalled",
          blocker: diagnosis,
          next:
            task.next ||
            "Re-read the last file that failed, then continue from the first unfinished step.",
        });

        if (stateRoot) {
          await appendJournal(
            stateRoot,
            `stalled: ${task.title} — ${diagnosis}`,
          );
        }

        if (saved) {
          yield {
            kind: "task",
            task: {
              id: task.id,
              file: saved.relative,
              status: "stalled",
              roundsUsed: saved.state.roundsUsed,
            },
          };
        }

        yield {
          kind: "error",
          error:
            `${diagnosis} ` +
            (appliedEdits.length
              ? `${appliedEdits.length} edit(s) did land and are saved. `
              : "") +
            (saved
              ? `Progress was written to ${CONTEXT_DIR}/${TASKS_DIR}/${task.id}.md — ` +
                'say "continue" in a new chat and it resumes from there instead of starting over.'
              : "Progress could not be saved (the workspace root is not writable), so a resume would start over."),
        };
        return;
      }
    } catch (err: any) {
      const kind = failureKindOf(err);
      const nextCandidate = ladder[i + 1];
      if (!nextCandidate || !shouldFailover(kind)) {
        await persist({
          status: "stalled",
          blocker: err?.message || String(err),
        });
        yield { kind: "error", error: err?.message || String(err) };
        return;
      }
      yield {
        kind: "notice",
        notice: buildNotice(candidate.id, nextCandidate, kind, account),
      };
      account = null;
    }
  }

  /* ---- finished cleanly ---- */

  if (planningOnly) {
    const extracted = extractPlanFromText(finalText);
    const questions = extracted.questions.filter(
      (q) => q.trim().toLowerCase() !== "none",
    );

    const saved = await persist({
      status: "awaiting-approval",
      steps: extracted.steps,
      questions,
      next: extracted.next,
      roundsUsed: task.roundsUsed + budget.used,
    });

    if (stateRoot) {
      await appendJournal(
        stateRoot,
        `plan drafted: ${task.title} — ${extracted.steps.length} step(s), ${questions.length} question(s)`,
      );
    }

    yield {
      kind: "plan",
      plan: {
        taskId: task.id,
        file: saved?.relative ?? `${CONTEXT_DIR}/${TASKS_DIR}/${task.id}.md`,
        title: task.title,
        steps: extracted.steps.map((s) => ({
          index: s.index,
          text: s.text,
          status: s.status,
        })),
        questions,
        next: extracted.next,
        status: "awaiting-approval",
      },
    };

    if (!saved) {
      yield {
        kind: "notice",
        notice: {
          type: "warning",
          title: "Plan not saved to disk",
          message:
            `Could not write ${CONTEXT_DIR}/${TASKS_DIR}/. The plan above is still valid, but ` +
            "approving it will re-plan rather than resume.",
        },
      };
    }
  } else {
    const remaining = /REMAINING WORK/i.test(finalText);
    /* A run whose last review still had blockers is not "complete", whatever
     * the model's closing prose says. Recording it as stalled is what makes
     * "continue" resume against the findings instead of starting over. */
    const reviewFailed = Boolean(lastReview && !lastReview.passed);
    const saved = await persist({
      status: remaining || reviewFailed ? "stalled" : "complete",
      roundsUsed: task.roundsUsed + budget.used,
      steps: task.steps.map((s) =>
        s.status === "todo" && !remaining && !reviewFailed
          ? { ...s, status: "done" }
          : s,
      ),
      ...(lastReview ? { review: lastReview } : {}),
      ...(remaining
        ? { next: finalText.split(/REMAINING WORK/i)[1]?.slice(0, 600) ?? "" }
        : reviewFailed
          ? {
              next:
                `Unresolved review findings:\n` +
                lastReview!.findings
                  .filter(
                    (f) => f.severity === "blocker" || f.severity === "major",
                  )
                  .map((f) => `- ${f.path ? `${f.path}: ` : ""}${f.text}`)
                  .join("\n")
                  .slice(0, 600),
            }
          : {}),
    });

    if (stateRoot) {
      await appendJournal(
        stateRoot,
        `${remaining || reviewFailed ? "partial" : "complete"}: ${task.title} — ` +
          `${task.edits.filter((e) => e.ok).length} edit(s), ${budget.used} round(s)` +
          (lastReview
            ? `, review ${lastReview.passed ? "passed" : "failed"} after ${reviewCycle} cycle(s)`
            : ""),
      );
    }

    if (saved) {
      yield {
        kind: "task",
        task: {
          id: task.id,
          file: saved.relative,
          status: saved.state.status,
          roundsUsed: saved.state.roundsUsed,
        },
      };
    }
  }

  if (activeCandidate) {
    const substituted = detectSubstitution(activeCandidate.id, servedModel);
    yield {
      kind: "route",
      route: {
        requested: targetModel,
        dispatched: activeCandidate.id,
        served: servedModel,
        account,
        viaCombo: activeCandidate.yieldsControl,
        attempts: totalRequests,
        substituted,
        bridge: vscodeBridge.isConnected() ? "vscode" : "filesystem",
        rounds: budget.used,
        roundLimit: budget.limit,
        phase,
        taskId: task.id,
      },
    };
  }

  /* One summary rather than a card per dependency. The agent cannot install
   * anything, so this is the only place the developer learns that the code they
   * are about to run needs something they do not have. */
  if (newSetup.length > 0) {
    yield {
      kind: "notice",
      notice: {
        type: "warning",
        title:
          newSetup.length === 1
            ? "1 setup step needed"
            : `${newSetup.length} setup steps needed`,
        message: setupWriteFailed
          ? `Could NOT be written to ${CONTEXT_DIR}/setup.md — the list above is from ` +
            "this run's memory only, so copy it before the window goes away. Nothing " +
            "was installed; the agent cannot run commands."
          : `Written to ${CONTEXT_DIR}/setup.md. Nothing was installed — the agent ` +
            "cannot run commands. Run them yourself once you are happy with the changes.",
        details: newSetup,
      },
    };
  }

  yield { kind: "done" };
}
