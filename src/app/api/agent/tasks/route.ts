/**
 * src/app/api/agent/tasks/route.ts
 * ---------------------------------------------------------------------------
 * Read and update the task artifacts in `<workspace>/.omniroute/tasks/`.
 *
 * The pipeline writes these files; this route is how the UI reads them without
 * asking the model to. That distinction matters: listing tasks is a filesystem
 * operation, and spending a model round on it is exactly the kind of waste the
 * context files exist to eliminate.
 *
 * GET  /api/agent/tasks            -> { workspaceRoot, tasks: [...], resumable }
 * GET  /api/agent/tasks?id=<id>    -> { task, markdown }
 * POST /api/agent/tasks
 *   { id, action: "approve" }                    -> status = "executing"
 *   { id, action: "answer", answers: string[] }  -> record answers
 *   { id, action: "revise", note }               -> back to "planning"
 *   { id, action: "discard" }                    -> status = "abandoned"
 *   { id, action: "retarget", steps: [...] }     -> replace the whole checklist
 *   { id, action: "step", index, status, note }  -> tick one step
 *
 * Every response includes the task's current state, so the client never has to
 * guess what the write produced.
 */

import { NextRequest, NextResponse } from "next/server";
import fsp from "fs/promises";
import { requireUser } from "@/lib/authGuard";
import { vscodeBridge, withWorkspaceOwner } from "@/lib/vscodeBridge";
import { isMultiTenantBridge } from "@/lib/deploymentMode";
import { fileToolsEnabled, fileToolsDisabledMessage } from "@/lib/fileToolsGate";
import {
  agentStateRoot,
  appendJournal,
  findResumableTask,
  listTasks,
  loadTask,
  saveTask,
  taskFilePath,
  type TaskState,
  type TaskStep,
} from "@/lib/agentContext";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * These artifacts are files in the operator's workspace — they can contain the
 * plan text and the answers to questions asked about their private code. This
 * route used to serve them to anyone who asked, and let anyone approve or
 * discard a plan. Both methods now require a session and enabled file tools.
 */
function gate(req: NextRequest) {
  const auth = requireUser(req);
  if (!auth.ok) return { denied: auth.response, userId: null };

  if (!fileToolsEnabled()) {
    return {
      denied: NextResponse.json(
        {
          success: false,
          error: fileToolsDisabledMessage(),
          code: "FILE_TOOLS_DISABLED",
        },
        { status: 503 },
      ),
      userId: null,
    };
  }

  /* The user id is returned, not discarded. It was discarded before, which was
   * fine when there was one workspace; now it decides which directory these
   * artifacts are read from, so dropping it would serve every account the same
   * task list. */
  return { denied: null, userId: auth.user.id };
}

/**
 * The directory holding this user's task artifacts.
 *
 * Two different things on purpose. Locally it is the workspace itself, so the
 * files the UI lists are the same ones sitting in the user's repo. On a shared
 * deployment `workspaceRoot()` describes a folder on the user's own laptop,
 * which this process cannot read, so the artifacts live in a per-user directory
 * beside the database — see `agentStateRoot`. Either way the pipeline and this
 * route derive it identically, so what was written is what gets listed. If they
 * ever diverged the symptom would be quiet and confusing: the Tasks panel would
 * show nothing while the pipeline reported saving plans perfectly well.
 *
 * `source` is read inside the same owner context, because the label describes
 * how THIS user's root was decided and the bridge answers per-session.
 */
async function resolveRoot(userId: string | null): Promise<{
  root: string;
  workspace: string;
  source: string;
}> {
  let workspace = "";
  let source = "no workspace resolved";
  try {
    ({ workspace, source } = await withWorkspaceOwner(userId, async () => ({
      workspace: await vscodeBridge.workspaceRoot(),
      source: vscodeBridge.rootSourceLabel(),
    })));
  } catch (err) {
    /* On a shared deployment the state directory does not depend on the
     * workspace at all, so the user's task history is still readable with their
     * editor closed — which is rather the point of persisting it server-side.
     *
     * Locally the root IS the workspace, so there is nothing to list without
     * one and swallowing the error would answer 200 with an empty array while
     * quietly pointing `listTasks` at a relative path (i.e. the server's own
     * cwd). The original failure is more useful than that. */
    if (!isMultiTenantBridge()) throw err;
    workspace = "";
  }
  return { root: agentStateRoot(workspace, userId), workspace, source };
}

/** The shape the UI needs, without the full read/edit/failure history. */
function summarise(state: TaskState) {
  return {
    id: state.id,
    title: state.title,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    model: state.model ?? null,
    roundsUsed: state.roundsUsed,
    attempts: state.attempts,
    stepCount: state.steps.length,
    stepsDone: state.steps.filter((s) => s.status === "done").length,
    openQuestions: state.questions.filter((_, i) => !state.answers[i]).length,
    editCount: state.edits.filter((e) => e.ok).length,
    failureCount: state.failures.length,
    blocker: state.blocker ?? null,
    next: state.next,
  };
}

export async function GET(req: NextRequest) {
  const { denied, userId } = gate(req);
  if (denied) return denied;

  try {
    const { root, workspace, source } = await resolveRoot(userId);
    const id = req.nextUrl.searchParams.get("id");

    /* The path shown to the client is the user's WORKSPACE, never `root`. On a
     * shared deployment `root` is a directory inside the server next to the
     * database, and printing it in the UI would hand every signed-in account a
     * map of the host's filesystem for no benefit — they cannot open it. */
    const displayRoot = workspace || "(no editor connected)";

    if (id) {
      const artifact = await loadTask(root, id);
      if (!artifact) {
        return NextResponse.json(
          { error: `No readable task named "${id}" in this workspace.` },
          { status: 404 },
        );
      }
      // The markdown is returned as well, because the whole point of a task
      // artifact is that a human can read and edit it directly.
      let markdown = "";
      try {
        markdown = await fsp.readFile(artifact.file, "utf-8");
      } catch {
        markdown = "";
      }
      return NextResponse.json({
        workspaceRoot: displayRoot,
        task: artifact.state,
        summary: summarise(artifact.state),
        file: artifact.relative,
        markdown,
      });
    }

    const limitParam = Number(req.nextUrl.searchParams.get("limit"));
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.floor(limitParam), 100)
        : 25;

    const tasks = await listTasks(root, limit);
    const resumable = await findResumableTask(root);

    return NextResponse.json({
      workspaceRoot: displayRoot,
      source: source,
      tasks: tasks.map((t) => ({ ...summarise(t.state), file: t.relative })),
      resumable: resumable
        ? { ...summarise(resumable.state), file: resumable.relative }
        : null,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to read tasks." },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const { denied, userId } = gate(req);
  if (denied) return denied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const action = String(body?.action ?? "").toLowerCase();

  if (!id) {
    return NextResponse.json(
      { success: false, error: "Provide { id }." },
      { status: 400 },
    );
  }

  try {
    const { root, workspace } = await resolveRoot(userId);
    const displayRoot = workspace || "(no editor connected)";
    const artifact = await loadTask(root, id);
    if (!artifact) {
      return NextResponse.json(
        {
          success: false,
          error: `No readable task named "${id}" in this workspace.`,
        },
        { status: 404 },
      );
    }

    let state: TaskState = artifact.state;
    let journal = "";

    switch (action) {
      case "approve": {
        // Approving is deliberately allowed from any non-terminal status: the
        // user may have hand-edited a stalled plan and want it run as-is.
        if (state.status === "complete" || state.status === "abandoned") {
          return NextResponse.json(
            {
              success: false,
              error: `Task is ${state.status}; nothing to approve.`,
              summary: summarise(state),
            },
            { status: 409 },
          );
        }
        const answers = Array.isArray(body?.answers)
          ? body.answers.map((a: any) => String(a ?? ""))
          : state.answers;
        state = { ...state, status: "executing", answers };
        journal = `approved: ${state.title} (${state.steps.length} step(s))`;
        break;
      }

      case "answer": {
        const answers = Array.isArray(body?.answers)
          ? body.answers.map((a: any) => String(a ?? ""))
          : [];
        if (answers.length === 0) {
          return NextResponse.json(
            { success: false, error: "Provide { answers: string[] }." },
            { status: 400 },
          );
        }
        state = { ...state, answers };
        journal = `answered ${answers.filter(Boolean).length} question(s): ${state.title}`;
        break;
      }

      case "revise": {
        const note = String(body?.note ?? "").trim();
        state = {
          ...state,
          status: "planning",
          // The note becomes the steer for the next planning pass.
          next: note || state.next,
          blocker: note ? `Revision requested: ${note}` : state.blocker,
        };
        journal = `revision requested: ${state.title}${note ? ` — ${note}` : ""}`;
        break;
      }

      case "discard": {
        state = { ...state, status: "abandoned" };
        journal = `abandoned: ${state.title}`;
        break;
      }

      /**
       * Replace the whole checklist with one the user edited by hand.
       *
       * This is what makes the plan gate genuinely interactive: "revise" throws
       * the plan away and pays for another planning pass, whereas editing three
       * words in step 4 should cost nothing. Unlike "step", which only moves a
       * status, this rewrites text and ordering.
       *
       * Everything here is untrusted client input, so the step list is rebuilt
       * from scratch rather than merged: indices are reassigned 1..n in the
       * order given (that IS the reorder), text is trimmed and length-capped,
       * and an unrecognised status falls back to "todo" instead of writing a
       * value the rest of the pipeline would choke on.
       */
      case "retarget": {
        if (state.status === "complete" || state.status === "abandoned") {
          return NextResponse.json(
            {
              success: false,
              error: `Task is ${state.status}; its plan can no longer be edited.`,
              summary: summarise(state),
            },
            { status: 409 },
          );
        }

        const raw = Array.isArray(body?.steps) ? body.steps : null;
        if (!raw) {
          return NextResponse.json(
            { success: false, error: "Provide { steps: [...] }." },
            { status: 400 },
          );
        }
        if (raw.length > 60) {
          return NextResponse.json(
            {
              success: false,
              error: "A plan longer than 60 steps is almost certainly a mistake.",
            },
            { status: 400 },
          );
        }

        const allowedStatus: TaskStep["status"][] = [
          "todo",
          "doing",
          "done",
          "skipped",
        ];

        /* Preserve the status and note of steps the user kept, matched on their
         * ORIGINAL index, so editing step 5's wording does not resurrect work
         * already marked done. Steps with no originalIndex are new. */
        const priorByIndex = new Map(state.steps.map((s) => [s.index, s]));

        const steps: TaskStep[] = [];
        for (const entry of raw) {
          const text = String(entry?.text ?? "").trim().slice(0, 500);
          if (!text) continue; // an empty row is a deletion

          const originalIndex = Number(entry?.originalIndex);
          const prior = Number.isFinite(originalIndex)
            ? priorByIndex.get(originalIndex)
            : undefined;

          const requested = String(
            entry?.status ?? prior?.status ?? "todo",
          ).toLowerCase() as TaskStep["status"];

          steps.push({
            index: steps.length + 1,
            text,
            status: allowedStatus.includes(requested) ? requested : "todo",
            ...(prior?.note ? { note: prior.note } : {}),
          });
        }

        if (steps.length === 0) {
          return NextResponse.json(
            {
              success: false,
              error:
                "That would leave the plan empty. Discard the task instead if that is the intent.",
            },
            { status: 400 },
          );
        }

        const edited = steps.length !== state.steps.length
          ? `${state.steps.length} -> ${steps.length} step(s)`
          : `${steps.length} step(s) reworded or reordered`;

        state = { ...state, steps };
        journal = `plan edited by hand: ${state.title} (${edited})`;
        break;
      }

      case "step": {
        const index = Number(body?.index);
        const nextStatus = String(body?.status ?? "").toLowerCase();
        const allowed: TaskStep["status"][] = [
          "todo",
          "doing",
          "done",
          "skipped",
        ];
        if (!Number.isFinite(index)) {
          return NextResponse.json(
            { success: false, error: "Provide { index }." },
            { status: 400 },
          );
        }
        if (!allowed.includes(nextStatus as TaskStep["status"])) {
          return NextResponse.json(
            {
              success: false,
              error: `status must be one of ${allowed.join(", ")}.`,
            },
            { status: 400 },
          );
        }
        const steps = state.steps.map((s) =>
          s.index === index
            ? {
                ...s,
                status: nextStatus as TaskStep["status"],
                ...(typeof body?.note === "string" && body.note.trim()
                  ? { note: body.note.trim() }
                  : {}),
              }
            : s,
        );
        if (!steps.some((s) => s.index === index)) {
          return NextResponse.json(
            { success: false, error: `No step with index ${index}.` },
            { status: 404 },
          );
        }
        state = { ...state, steps };
        journal = `step ${index} -> ${nextStatus}: ${state.title}`;
        break;
      }

      default:
        return NextResponse.json(
          {
            success: false,
            error:
              'action must be one of "approve", "answer", "revise", "discard", "retarget", "step".',
          },
          { status: 400 },
        );
    }

    const saved = await saveTask(root, state);
    if (!saved) {
      /* The full path is only named on a laptop, where it is the user's own
       * folder and the most useful thing we can tell them. On a shared host it
       * is a server directory they have no business seeing and could not fix
       * anyway, so the message describes the problem instead of the path. */
      return NextResponse.json(
        {
          success: false,
          error: isMultiTenantBridge()
            ? `Could not save task "${state.id}". The server could not write to your task storage.`
            : `Could not write ${taskFilePath(root, state.id)}. Check the folder is writable.`,
        },
        { status: 500 },
      );
    }

    if (journal) await appendJournal(root, journal);

    return NextResponse.json({
      success: true,
      workspaceRoot: displayRoot,
      task: saved.state,
      summary: summarise(saved.state),
      file: saved.relative,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || "Failed to update the task." },
      { status: 500 },
    );
  }
}
