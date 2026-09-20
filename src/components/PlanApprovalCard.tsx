"use client";

/**
 * src/components/PlanApprovalCard.tsx
 * ---------------------------------------------------------------------------
 * The approval gate for Deep Cowork.
 *
 * The planning pass runs read-only, writes `.omniroute/tasks/<id>.md`, and
 * stops. This card renders that plan so the developer can approve a short
 * checklist instead of auditing a few hundred generated lines afterwards.
 *
 * Division of labour, deliberately:
 *   - This card owns the *task file* (approve / answer / revise / discard /
 *     retarget all go to /api/agent/tasks, which writes the artifact).
 *   - page.tsx owns the *conversation*. After a successful approve, onApprove
 *     fires and page.tsx sends the execute-phase request. Doing the disk write
 *     here means the approval survives even if the follow-up request fails.
 *
 * Two ways to change a plan, and the difference is the point:
 *   - "Revise" sends a note and pays for a whole new planning pass. Right when
 *     the plan misunderstood the request.
 *   - "Edit steps" rewrites the checklist in place via `retarget` and costs no
 *     model round at all. Right when the plan is 90% correct and step 4 needs
 *     three words changed, or the order is wrong, or one step should go.
 * Editing is what makes this an approval gate rather than a yes/no prompt.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  FileText,
  HelpCircle,
  ListPlus,
  Loader2,
  Pencil,
  Play,
  Save,
  SkipForward,
  Trash2,
  X,
} from "lucide-react";

export interface PlanStep {
  index: number;
  text: string;
  status: string;
}

export interface PlanPayload {
  taskId: string;
  file: string;
  title: string;
  steps: PlanStep[];
  questions: string[];
  next: string;
  status: string;
}

interface PlanApprovalCardProps {
  plan: PlanPayload;
  /** Fired after the task file is marked "executing". */
  onApprove?: (taskId: string, answers: string[]) => void;
  /** Fired after the task file is put back to "planning". */
  onRevise?: (taskId: string, note: string) => void;
  onDiscard?: (taskId: string) => void;
  /** Set once the execute run has started, so the card stops offering Approve. */
  resolved?: boolean;
}

type Busy = null | "approve" | "revise" | "discard" | "save";

/**
 * A step in the editor.
 *
 * `key` exists because React needs a stable identity across reorders, and
 * neither the index nor the text qualifies: the index is what reordering
 * changes, and two steps can legitimately hold the same text mid-edit. Keying
 * on either would make inputs swap their contents under the user's cursor.
 *
 * `originalIndex` is how the server re-attaches the status and note of a step
 * that already ran. Without it, rewording step 2 of a resumed plan would
 * silently reset it from "done" to "todo" and the executor would redo the work.
 * New steps carry `null` and are born as "todo".
 */
interface DraftStep {
  key: string;
  text: string;
  status: string;
  originalIndex: number | null;
}

let draftKeySeq = 0;
const nextKey = () => `s${++draftKeySeq}`;

const toDraft = (steps: PlanStep[]): DraftStep[] =>
  steps.map((s) => ({
    key: nextKey(),
    text: s.text,
    status: s.status,
    originalIndex: s.index,
  }));

export function PlanApprovalCard({
  plan,
  onApprove,
  onRevise,
  onDiscard,
  resolved = false,
}: PlanApprovalCardProps) {
  const [answers, setAnswers] = useState<string[]>(() =>
    plan.questions.map(() => ""),
  );
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseNote, setReviseNote] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<
    null | "approved" | "revised" | "discarded"
  >(null);

  /* ---- plan editing ---- */

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftStep[]>(() => toDraft(plan.steps));
  const [dirty, setDirty] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  /** The last state written to disk, so Cancel can actually revert. */
  const [baseline, setBaseline] = useState<PlanStep[]>(() => plan.steps);

  /**
   * Re-seed the editor when this card is pointed at a different task.
   *
   * Keyed on `plan.taskId` and NOT on `plan.steps`: the parent rebuilds the
   * plan object on most renders, so depending on the array would throw away
   * whatever the user was halfway through typing.
   */
  useEffect(() => {
    setDraft(toDraft(plan.steps));
    setBaseline(plan.steps);
    setDirty(false);
    setEditing(false);
    setSavedNote(null);
    setError(null);
    setOutcome(null);
    setAnswers(plan.questions.map(() => ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.taskId]);

  const unanswered = useMemo(
    () => plan.questions.filter((_, i) => !answers[i]?.trim()).length,
    [plan.questions, answers],
  );

  const done = resolved || outcome !== null;

  /** Every mutation goes through here so "dirty" can never drift out of sync. */
  function mutate(next: (rows: DraftStep[]) => DraftStep[]) {
    setDraft((rows) => next(rows));
    setDirty(true);
    setSavedNote(null);
    setError(null);
  }

  const setText = (key: string, text: string) =>
    mutate((rows) => rows.map((r) => (r.key === key ? { ...r, text } : r)));

  const removeStep = (key: string) =>
    mutate((rows) => rows.filter((r) => r.key !== key));

  const addStep = () =>
    mutate((rows) => [
      ...rows,
      { key: nextKey(), text: "", status: "todo", originalIndex: null },
    ]);

  /** Swap with the neighbour. Reordering IS the new index order on save. */
  const moveStep = (key: string, delta: -1 | 1) =>
    mutate((rows) => {
      const at = rows.findIndex((r) => r.key === key);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= rows.length) return rows;
      const copy = [...rows];
      [copy[at], copy[to]] = [copy[to], copy[at]];
      return copy;
    });

  async function post(action: string, extra: Record<string, unknown> = {}) {
    const res = await fetch("/api/agent/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: plan.taskId, action, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success !== true) {
      throw new Error(data?.error || `Could not ${action} the plan.`);
    }
    return data;
  }

  /**
   * Write the edited checklist to the task file.
   *
   * Returns the step count the server accepted, which can differ from what was
   * sent — blank rows are dropped as deletions server-side. Re-seeding the
   * draft from the response is what keeps `originalIndex` truthful for a second
   * round of edits; skipping it would make the next save re-attach statuses
   * using indices that no longer exist.
   */
  async function persistSteps(): Promise<number> {
    const data = await post("retarget", {
      steps: draft.map((r) => ({
        text: r.text,
        status: r.status,
        ...(r.originalIndex !== null ? { originalIndex: r.originalIndex } : {}),
      })),
    });

    const saved: PlanStep[] = Array.isArray(data?.task?.steps)
      ? data.task.steps
      : [];
    if (saved.length > 0) {
      setDraft(toDraft(saved));
      setBaseline(saved);
    }
    setDirty(false);
    return saved.length || draft.filter((r) => r.text.trim()).length;
  }

  /** Throw the edits away and go back to what is on disk. */
  function handleCancelEdit() {
    setDraft(toDraft(baseline));
    setDirty(false);
    setEditing(false);
    setError(null);
  }

  async function handleSaveSteps() {
    if (draft.every((r) => !r.text.trim())) {
      setError(
        "A plan needs at least one step. Discard the task if that is the intent.",
      );
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const count = await persistSteps();
      setEditing(false);
      setSavedNote(`Plan saved — ${count} step${count === 1 ? "" : "s"}.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleApprove() {
    setBusy("approve");
    setError(null);
    try {
      /* Flush pending edits BEFORE approving. The execute pass reloads the
       * task from disk by id, so an unsaved edit here would mean the user
       * approves one checklist and the model executes another. */
      if (dirty) await persistSteps();
      await post("approve", { answers });
      setOutcome("approved");
      onApprove?.(plan.taskId, answers);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleRevise() {
    const note = reviseNote.trim();
    if (!note) {
      setError(
        "Say what should change, otherwise re-planning will repeat this.",
      );
      return;
    }
    setBusy("revise");
    setError(null);
    try {
      await post("revise", { note });
      setOutcome("revised");
      setReviseOpen(false);
      onRevise?.(plan.taskId, note);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleDiscard() {
    setBusy("discard");
    setError(null);
    try {
      await post("discard");
      setOutcome("discarded");
      onDiscard?.(plan.taskId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const stepIcon = (status: string) => {
    if (status === "done")
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
    if (status === "doing")
      return <Loader2 className="w-3.5 h-3.5 text-violet-300 shrink-0" />;
    if (status === "skipped")
      return <SkipForward className="w-3.5 h-3.5 text-zinc-500 shrink-0" />;
    return <CircleDashed className="w-3.5 h-3.5 text-zinc-500 shrink-0" />;
  };

  return (
    <div className="mt-3 rounded-2xl border border-violet-500/40 bg-violet-950/20 overflow-hidden shadow-lg ring-1 ring-violet-500/10">
      {/* header */}
      <div className="flex items-start justify-between gap-3 px-3.5 py-2.5 border-b border-violet-500/25 bg-violet-950/40">
        <div className="flex items-center gap-2 min-w-0">
          <Brain className="w-4 h-4 text-violet-300 shrink-0" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-violet-100 truncate">
              Plan ready for review
            </div>
            <div className="text-[10px] text-violet-300/70 truncate">
              {plan.title}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 text-[10px] font-mono text-violet-300/60">
          <FileText className="w-3 h-3" />
          <span className="truncate max-w-[180px]" title={plan.file}>
            {plan.file}
          </span>
        </div>
      </div>

      {/* steps — rendered from `draft`, not `plan.steps`, so a saved edit stays
          on screen. The `plan` prop arrives on an SSE event and is never
          refreshed, so reading from it would snap back to the model's original
          wording the moment the user saved. */}
      <div className="px-3.5 py-3 space-y-1.5">
        {draft.length === 0 && !editing ? (
          <p className="text-xs text-zinc-400 italic">
            The planning pass produced no checklist. Add a step by hand, revise
            with a more specific request, or run Deep Cowork without the plan
            gate.
          </p>
        ) : editing ? (
          <>
            {draft.map((row, i) => (
              <div key={row.key} className="flex items-start gap-1.5">
                <span className="text-violet-300/70 font-mono text-[11px] mt-2 w-4 shrink-0 text-right">
                  {i + 1}.
                </span>
                <textarea
                  value={row.text}
                  rows={1}
                  onChange={(e) => setText(row.key, e.target.value)}
                  placeholder="Describe this step, or clear it to delete"
                  className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-[11px] leading-relaxed text-zinc-200 focus:outline-none focus:border-violet-500/50 placeholder:text-zinc-600 resize-y"
                />
                <div className="flex items-center gap-0.5 shrink-0 mt-0.5">
                  {row.status !== "todo" && (
                    <span
                      title={`Currently ${row.status} — editing the text keeps this status`}
                      className="mr-0.5"
                    >
                      {stepIcon(row.status)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => moveStep(row.key, -1)}
                    disabled={i === 0}
                    title="Move up"
                    className="p-1 rounded-md text-zinc-500 hover:text-violet-200 hover:bg-violet-500/15 disabled:opacity-25 disabled:hover:bg-transparent transition-colors cursor-pointer"
                  >
                    <ChevronUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveStep(row.key, 1)}
                    disabled={i === draft.length - 1}
                    title="Move down"
                    className="p-1 rounded-md text-zinc-500 hover:text-violet-200 hover:bg-violet-500/15 disabled:opacity-25 disabled:hover:bg-transparent transition-colors cursor-pointer"
                  >
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeStep(row.key)}
                    title="Delete this step"
                    className="p-1 rounded-md text-zinc-500 hover:text-rose-300 hover:bg-rose-950/40 transition-colors cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}

            <button
              type="button"
              onClick={addStep}
              className="flex items-center gap-1.5 mt-1 px-2 py-1 rounded-lg text-[11px] text-violet-300 hover:text-violet-200 hover:bg-violet-500/15 transition-colors cursor-pointer"
            >
              <ListPlus className="w-3.5 h-3.5" />
              <span>Add step</span>
            </button>

            <p className="text-[10px] text-zinc-500 italic pt-1">
              Reordering here sets the order the model works in. Steps already
              marked done keep that status when you reword them.
            </p>
          </>
        ) : (
          draft.map((step, i) => (
            <div key={step.key} className="flex items-start gap-2">
              {stepIcon(step.status)}
              <span className="text-[11px] leading-relaxed text-zinc-200">
                <span className="text-violet-300/70 font-mono mr-1.5">
                  {i + 1}.
                </span>
                {step.text}
              </span>
            </div>
          ))
        )}
      </div>

      {/* questions */}
      {plan.questions.length > 0 && (
        <div className="px-3.5 pb-3 space-y-2 border-t border-violet-500/20 pt-3">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-300/90">
            <HelpCircle className="w-3.5 h-3.5" />
            <span>
              {plan.questions.length} question
              {plan.questions.length === 1 ? "" : "s"} before editing
            </span>
          </div>
          {plan.questions.map((q, i) => (
            <div key={i} className="space-y-1">
              <p className="text-[11px] text-zinc-300 leading-relaxed">{q}</p>
              <input
                type="text"
                value={answers[i] ?? ""}
                disabled={done}
                onChange={(e) => {
                  const next = [...answers];
                  next[i] = e.target.value;
                  setAnswers(next);
                }}
                placeholder="Your answer (blank = your call, decide as you see fit)"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-2.5 py-1.5 text-[11px] text-zinc-200 focus:outline-none focus:border-violet-500/50 disabled:opacity-50 placeholder:text-zinc-600"
              />
            </div>
          ))}
          {unanswered > 0 && (
            <p className="text-[10px] text-zinc-500 italic">
              {unanswered} left blank — those will be treated as “use your
              judgement”.
            </p>
          )}
        </div>
      )}

      {/* next action */}
      {plan.next && (
        <div className="px-3.5 pb-3 pt-2 border-t border-violet-500/20">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            First action on approval
          </span>
          <p className="text-[11px] text-zinc-300 mt-1 leading-relaxed">
            {plan.next}
          </p>
        </div>
      )}

      {/* revise box */}
      {reviseOpen && !done && (
        <div className="px-3.5 pb-3 space-y-2 border-t border-violet-500/20 pt-3">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            What should change about this plan?
          </span>
          <textarea
            value={reviseNote}
            onChange={(e) => setReviseNote(e.target.value)}
            rows={3}
            placeholder="e.g. don't touch the migration files; do it in two steps instead"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-2.5 py-2 text-[11px] text-zinc-200 focus:outline-none focus:border-violet-500/50 placeholder:text-zinc-600 resize-none"
          />
        </div>
      )}

      {/* saved confirmation */}
      {savedNote && !error && (
        <div className="mx-3.5 mb-3 flex items-center gap-1.5 text-[11px] text-emerald-300">
          <Check className="w-3.5 h-3.5 shrink-0" />
          <span>{savedNote}</span>
        </div>
      )}

      {/* error */}
      {error && (
        <div className="mx-3.5 mb-3 p-2 rounded-xl bg-rose-950/60 border border-rose-800/60 text-rose-200 text-[11px]">
          {error}
        </div>
      )}

      {/* footer */}
      <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 border-t border-violet-500/25 bg-zinc-950/60">
        {done ? (
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
            {outcome === "discarded" ? (
              <X className="w-3.5 h-3.5 text-zinc-500" />
            ) : (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            )}
            <span>
              {outcome === "approved" || resolved
                ? "Approved — executing."
                : outcome === "revised"
                  ? "Revision requested."
                  : "Plan discarded."}
            </span>
          </div>
        ) : editing ? (
          <>
            <div className="flex items-center gap-2">
              {/* "Save & run" is handleApprove, which flushes the unsaved draft
                  first — so the checklist on screen is the one that executes. */}
              <button
                type="button"
                onClick={handleApprove}
                disabled={busy !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-violet-500/20 hover:bg-violet-500/30 text-violet-200 border border-violet-500/40 text-[11px] font-semibold transition-all cursor-pointer disabled:opacity-40 active:scale-[0.98]"
              >
                {busy === "approve" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                <span>Save &amp; run</span>
              </button>

              <button
                type="button"
                onClick={handleSaveSteps}
                disabled={busy !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-800/80 hover:bg-zinc-700/80 text-zinc-200 border border-zinc-700 text-[11px] font-medium transition-all cursor-pointer disabled:opacity-40"
                title="Write the checklist to the task file without starting it"
              >
                {busy === "save" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                <span>Save</span>
              </button>
            </div>

            <button
              type="button"
              onClick={handleCancelEdit}
              disabled={busy !== null}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60 text-[11px] transition-all cursor-pointer disabled:opacity-40"
              title="Discard these edits"
            >
              <X className="w-3.5 h-3.5" />
              <span>Cancel</span>
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleApprove}
                disabled={busy !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-violet-500/20 hover:bg-violet-500/30 text-violet-200 border border-violet-500/40 text-[11px] font-semibold transition-all cursor-pointer disabled:opacity-40 active:scale-[0.98]"
              >
                {busy === "approve" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                <span>Approve &amp; run</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setReviseOpen(false);
                  setSavedNote(null);
                  setEditing(true);
                }}
                disabled={busy !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-800/80 hover:bg-zinc-700/80 text-zinc-200 border border-zinc-700 text-[11px] font-medium transition-all cursor-pointer disabled:opacity-40"
                title="Reword, reorder, add or delete steps — no model round needed"
              >
                <Pencil className="w-3.5 h-3.5" />
                <span>Edit steps</span>
              </button>

              <button
                type="button"
                onClick={() =>
                  reviseOpen ? handleRevise() : setReviseOpen(true)
                }
                disabled={busy !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-800/80 hover:bg-zinc-700/80 text-zinc-200 border border-zinc-700 text-[11px] font-medium transition-all cursor-pointer disabled:opacity-40"
                title="Ask the model to plan again with a note"
              >
                {busy === "revise" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Brain className="w-3.5 h-3.5" />
                )}
                <span>{reviseOpen ? "Send revision" : "Re-plan"}</span>
              </button>
            </div>

            <button
              type="button"
              onClick={handleDiscard}
              disabled={busy !== null}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-zinc-500 hover:text-rose-300 hover:bg-rose-950/40 text-[11px] transition-all cursor-pointer disabled:opacity-40"
              title="Mark this task abandoned"
            >
              {busy === "discard" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
              <span>Discard</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
