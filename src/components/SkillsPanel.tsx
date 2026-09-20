"use client";

/**
 * src/components/SkillsPanel.tsx
 * ---------------------------------------------------------------------------
 * Where a user adds, edits and switches off their skills — and, more
 * importantly, where they find out what a skill is allowed to do here.
 *
 * WHY THE PANEL LEADS WITH THE LIMIT
 *
 * Most skill systems a user has met run code. This one does not, and if that is
 * discovered on the third failed upload it reads as a bug. So the first card
 * says it plainly, before the add button: a skill is instructions plus a list
 * of tools the app already has. Telling someone what a feature refuses to do is
 * part of the feature working.
 *
 * WHY VALIDATION HAPPENS AS YOU TYPE
 *
 * The validator is dependency-free and client-safe on purpose, so the exact
 * check the server runs also runs in the textarea. A user pasting a skill
 * written for another tool sees "this build does not run `entrypoint`" while
 * the text is still in front of them, not after a round trip that clears the
 * box. The server re-validates every request regardless — this is for the error
 * message, never for the decision.
 *
 * WHY EDITING IS INLINE AND NOT A SECOND SCREEN
 *
 * A skill is one object with six fields. Routing that through a separate editor
 * page would add navigation state, a dirty-check, and a way to lose work by
 * clicking the wrong thing, in exchange for more room than the content needs.
 * The card expands, the fields are there, save or cancel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Info,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Shapes,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import {
  readSkillDocument,
  SKILL_TOOL_CATALOG,
  SKILL_LIMITS,
  type SkillTrigger,
} from "@/lib/skills/skillManifest";
import { SKILL_TEMPLATES, type SkillTemplate } from "@/lib/skills/skillTemplates";

/* =========================================================================
 * Shapes
 * ====================================================================== */

interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  allowedTools: string[];
  triggerMode: SkillTrigger;
  triggers: string[];
  enabled: boolean;
  builtin: boolean;
  createdAt: number;
  updatedAt: number;
}

/** What the chat stream reports back about a turn. Rendered by
 *  {@link SkillRunSummary} so "why did it do that" has an answer on screen. */
export interface SkillRunReport {
  active: Array<{
    id: string;
    slug: string;
    name: string;
    reason: string;
    allowedTools: string[];
  }>;
  skipped: Array<{ id: string; name: string; reason: string; detail: string }>;
}

interface SkillsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Lets the rest of the app react when the set of skills changes — the pill
   *  in the header, for instance. */
  onChanged?: () => void;
}

/* =========================================================================
 * Small pieces
 * ====================================================================== */

function ToolChip({ name }: { name: string }) {
  const info = SKILL_TOOL_CATALOG.find((t) => t.name === name);
  const mutating = info?.mutating ?? false;
  return (
    <span
      title={info?.effect ?? name}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-mono border ${
        mutating
          ? "bg-amber-500/10 border-amber-500/30 text-amber-200"
          : "bg-zinc-800/60 border-zinc-700/50 text-zinc-300"
      }`}
    >
      {mutating && <Pencil className="w-2.5 h-2.5" />}
      {name}
    </span>
  );
}

function ModeBadge({ mode }: { mode: SkillTrigger }) {
  return mode === "always" ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-semibold bg-sky-500/15 border border-sky-500/30 text-sky-200">
      <Zap className="w-2.5 h-2.5" />
      Every message
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-semibold bg-violet-500/15 border border-violet-500/30 text-violet-200">
      <Search className="w-2.5 h-2.5" />
      On keywords
    </span>
  );
}

function Toggle({
  on,
  busy,
  onClick,
  label,
}: {
  on: boolean;
  busy: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={onClick}
      className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 ${
        on ? "bg-emerald-500/80" : "bg-zinc-700"
      }`}
    >
      <span
        className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-all ${
          on ? "left-[21px]" : "left-[3px]"
        }`}
      />
    </button>
  );
}

/* =========================================================================
 * One skill
 * ====================================================================== */

function SkillCard({
  skill,
  onToggle,
  onSave,
  onDelete,
  busy,
}: {
  skill: Skill;
  onToggle: (enabled: boolean) => void;
  onSave: (patch: Partial<Skill>) => Promise<string[] | null>;
  onDelete: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const [draft, setDraft] = useState({
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    allowedTools: skill.allowedTools,
    triggerMode: skill.triggerMode,
    triggers: skill.triggers.join(", "),
  });

  /* Re-seed the draft whenever the stored skill changes underneath us — after
   * a save, or after a refresh. Without this the form keeps showing the values
   * the user typed before a failed save, which reads as the save having worked. */
  useEffect(() => {
    if (!editing) {
      setDraft({
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        allowedTools: skill.allowedTools,
        triggerMode: skill.triggerMode,
        triggers: skill.triggers.join(", "),
      });
    }
  }, [skill, editing]);

  const toggleTool = (tool: string) => {
    setDraft((d) => ({
      ...d,
      allowedTools: d.allowedTools.includes(tool)
        ? d.allowedTools.filter((t) => t !== tool)
        : [...d.allowedTools, tool],
    }));
  };

  const save = async () => {
    setSaving(true);
    setErrors([]);
    const problems = await onSave({
      name: draft.name,
      description: draft.description,
      instructions: draft.instructions,
      allowedTools: draft.allowedTools,
      triggerMode: draft.triggerMode,
      triggers: draft.triggers
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
    setSaving(false);
    if (problems) {
      setErrors(problems);
      return;
    }
    setEditing(false);
  };

  return (
    <div
      className={`rounded-2xl border transition-colors ${
        skill.enabled
          ? "bg-zinc-800/40 border-zinc-700/50"
          : "bg-zinc-900/40 border-zinc-800/60"
      }`}
    >
      <div className="flex items-start gap-3 p-4">
        <Toggle
          on={skill.enabled}
          busy={busy}
          label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
          onClick={() => onToggle(!skill.enabled)}
        />

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 min-w-0 text-left"
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`text-sm font-semibold ${
                skill.enabled ? "text-zinc-100" : "text-zinc-400"
              }`}
            >
              {skill.name}
            </span>
            <ModeBadge mode={skill.triggerMode} />
            {skill.builtin && (
              <span className="px-2 py-0.5 rounded-lg text-[10px] font-semibold bg-zinc-700/50 border border-zinc-600/50 text-zinc-300">
                From a template
              </span>
            )}
          </div>
          <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed line-clamp-2">
            {skill.description}
          </p>
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            {skill.allowedTools.length === 0 ? (
              <span className="text-[10px] text-zinc-500">
                No tools — guidance only
              </span>
            ) : (
              skill.allowedTools.map((t) => <ToolChip key={t} name={t} />)
            )}
          </div>
        </button>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              setEditing(true);
            }}
            title="Edit"
            className="p-2 rounded-xl hover:bg-zinc-700/50 text-zinc-400 hover:text-zinc-100 transition-all active:scale-95"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
            onBlur={() => setConfirmDelete(false)}
            title={confirmDelete ? "Click again to delete" : "Delete"}
            className={`p-2 rounded-xl transition-all active:scale-95 ${
              confirmDelete
                ? "bg-rose-500/20 text-rose-300"
                : "hover:bg-zinc-700/50 text-zinc-400 hover:text-rose-300"
            }`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="p-2 rounded-xl hover:bg-zinc-700/50 text-zinc-500 transition-all"
          >
            {open ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-zinc-700/40 pt-3">
          {skill.triggerMode === "keyword" && (
            <div className="flex items-start gap-2 flex-wrap">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold pt-1">
                Fires on
              </span>
              {skill.triggers.map((t) => (
                <span
                  key={t}
                  className="px-2 py-0.5 rounded-lg text-[10px] bg-violet-500/10 border border-violet-500/25 text-violet-200"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          {!editing ? (
            <pre className="text-[11px] text-zinc-300/90 leading-relaxed whitespace-pre-wrap font-sans max-h-72 overflow-y-auto rounded-xl bg-zinc-900/50 border border-zinc-700/40 p-3 [scrollbar-width:thin]">
              {skill.instructions}
            </pre>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                    Name
                  </span>
                  <input
                    value={draft.name}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, name: e.target.value }))
                    }
                    className="mt-1 w-full rounded-xl bg-zinc-900/60 border border-zinc-700/50 px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:ring-2 focus:ring-sky-400/50"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                    When it applies
                  </span>
                  <select
                    value={draft.triggerMode}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        triggerMode: e.target.value as SkillTrigger,
                      }))
                    }
                    className="mt-1 w-full rounded-xl bg-zinc-900/60 border border-zinc-700/50 px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:ring-2 focus:ring-sky-400/50"
                  >
                    <option value="always">Every message</option>
                    <option value="keyword">Only on keywords</option>
                  </select>
                </label>
              </div>

              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                  Description — the model reads this to judge relevance
                </span>
                <input
                  value={draft.description}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, description: e.target.value }))
                  }
                  className="mt-1 w-full rounded-xl bg-zinc-900/60 border border-zinc-700/50 px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:ring-2 focus:ring-sky-400/50"
                />
              </label>

              {draft.triggerMode === "keyword" && (
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                    Keywords, comma separated
                  </span>
                  <input
                    value={draft.triggers}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, triggers: e.target.value }))
                    }
                    placeholder="refactor, code review, audit"
                    className="mt-1 w-full rounded-xl bg-zinc-900/60 border border-zinc-700/50 px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:ring-2 focus:ring-sky-400/50"
                  />
                </label>
              )}

              <div>
                <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                  Tools this skill may use
                </span>
                <div className="mt-1.5 grid gap-1.5">
                  {SKILL_TOOL_CATALOG.map((tool) => (
                    <label
                      key={tool.name}
                      className="flex items-start gap-2.5 rounded-xl bg-zinc-900/40 border border-zinc-700/40 px-3 py-2 cursor-pointer hover:border-zinc-600/60 transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={draft.allowedTools.includes(tool.name)}
                        onChange={() => toggleTool(tool.name)}
                        className="mt-0.5 accent-sky-500"
                      />
                      <span className="min-w-0">
                        <span className="block text-[11px] font-semibold text-zinc-200">
                          {tool.label}
                          {tool.mutating && (
                            <span className="ml-1.5 text-amber-300/90 font-normal">
                              can change files
                            </span>
                          )}
                        </span>
                        <span className="block text-[10px] text-zinc-500 leading-relaxed">
                          {tool.effect}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                  Instructions ({draft.instructions.length.toLocaleString()} /{" "}
                  {SKILL_LIMITS.maxInstructions.toLocaleString()})
                </span>
                <textarea
                  value={draft.instructions}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, instructions: e.target.value }))
                  }
                  rows={12}
                  className="mt-1 w-full rounded-xl bg-zinc-900/60 border border-zinc-700/50 px-3 py-2 text-[11px] font-mono text-zinc-100 leading-relaxed focus:outline-none focus:ring-2 focus:ring-sky-400/50 [scrollbar-width:thin]"
                />
              </label>

              {errors.length > 0 && (
                <div className="rounded-xl bg-rose-500/10 border border-rose-500/30 px-3 py-2 space-y-1">
                  {errors.map((e, i) => (
                    <p
                      key={i}
                      className="text-[11px] text-rose-200/90 leading-relaxed"
                    >
                      {e}
                    </p>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 border border-sky-500/40 text-xs font-semibold transition-all active:scale-95 disabled:opacity-50"
                >
                  {saving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Check className="w-3.5 h-3.5" />
                  )}
                  Save changes
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setErrors([]);
                  }}
                  className="px-4 py-2 rounded-xl hover:bg-zinc-700/50 text-zinc-400 text-xs font-semibold transition-all active:scale-95"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* =========================================================================
 * The panel
 * ====================================================================== */

export default function SkillsPanel({
  isOpen,
  onClose,
  onChanged,
}: SkillsPanelProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tab, setTab] = useState<"templates" | "paste">("templates");
  const [document_, setDocument_] = useState("");
  const [adding, setAdding] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/skills");
      if (!res.ok) {
        setError(
          res.status === 401
            ? "Sign in to manage your skills."
            : "Could not load your skills.",
        );
        return;
      }
      const data = await res.json();
      setSkills(data.skills ?? []);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) void load();
  }, [isOpen, load]);

  /* Live validation of the pasted text. The same function the server calls, so
   * what is shown here is what will happen there — not an approximation of it. */
  const pasteCheck = useMemo(() => {
    if (!document_.trim()) return null;
    return readSkillDocument(document_);
  }, [document_]);

  const installedSlugs = useMemo(
    () => new Set(skills.map((s) => s.slug)),
    [skills],
  );

  const mutate = async (
    url: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; errors?: string[] }> => {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      });
      if (res.ok) {
        await load();
        onChanged?.();
        return { ok: true };
      }
      const data = await res.json().catch(() => ({}));
      return {
        ok: false,
        errors: data.errors ?? [data.error ?? "That did not work."],
      };
    } catch {
      return { ok: false, errors: ["Could not reach the server."] };
    }
  };

  const addTemplate = async (template: SkillTemplate) => {
    setAdding(true);
    setServerErrors([]);
    const result = await mutate("/api/skills", {
      method: "POST",
      body: JSON.stringify({ template: template.slug }),
    });
    setAdding(false);
    if (!result.ok) setServerErrors(result.errors ?? []);
  };

  const addPasted = async () => {
    setAdding(true);
    setServerErrors([]);
    const result = await mutate("/api/skills", {
      method: "POST",
      body: JSON.stringify({ document: document_ }),
    });
    setAdding(false);
    if (result.ok) setDocument_("");
    else setServerErrors(result.errors ?? []);
  };

  const enabledCount = skills.filter((s) => s.enabled).length;

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 transition-opacity"
        onClick={onClose}
      />

      <div className="fixed right-0 top-0 h-full w-full max-w-[820px] bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-950 border-l border-zinc-700/50 shadow-2xl z-50 flex flex-col animate-slide-in">
        {/* header */}
        <div className="flex items-center justify-between p-6 border-b border-zinc-800/80 bg-zinc-800/30 backdrop-blur-sm">
          <div className="flex items-center gap-4 min-w-0">
            <div className="p-3 rounded-xl bg-gradient-to-br from-violet-500/20 to-violet-600/10 border-2 border-violet-500/30 shadow-lg shadow-violet-500/10">
              <Sparkles className="w-6 h-6 text-violet-400" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-zinc-100 tracking-tight">
                Skills
              </h2>
              <p className="text-xs text-zinc-400 mt-1 font-medium truncate">
                {skills.length === 0
                  ? "Nothing added yet"
                  : `${skills.length} skill${skills.length === 1 ? "" : "s"}, ${enabledCount} switched on`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              title="Refresh"
              className="p-2.5 rounded-xl hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-all active:scale-95"
            >
              <RefreshCw
                className={`w-4 h-4 ${loading ? "animate-spin" : ""}`}
              />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2.5 rounded-xl hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-all hover:scale-105 active:scale-95"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5 [scrollbar-width:thin]">
          {/* what a skill is, before anything else */}
          <div className="rounded-2xl bg-gradient-to-br from-violet-500/10 to-transparent border border-violet-500/20 p-4">
            <div className="flex items-start gap-4">
              <div className="p-2.5 rounded-xl bg-zinc-900/40 border border-white/5 shrink-0">
                <ShieldCheck className="w-6 h-6 text-violet-300" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-bold text-zinc-100">
                  A skill is instructions, not a program
                </h3>
                <p className="text-xs text-zinc-300/80 mt-1.5 leading-relaxed">
                  Each one is a piece of writing that goes in front of the model,
                  plus a list of the tools it is allowed to lean on. Nothing you
                  add here executes — there is no code, no install step and
                  nothing fetched later. A skill can direct what the assistant
                  already does; it cannot give it a new capability, and it cannot
                  reach past the folders you have approved in VS Code.
                </p>
                <p className="text-xs text-zinc-400/80 mt-2 leading-relaxed">
                  That is a deliberate limit rather than a missing feature. This
                  app runs every account in one process, so code from an uploaded
                  file would be running next to everyone else&apos;s data.
                </p>
              </div>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-xl bg-amber-500/10 border border-amber-500/30 px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span className="text-[11px] text-amber-200/90">{error}</span>
            </div>
          )}

          {/* installed */}
          <div className="space-y-2.5">
            <div className="flex items-center gap-2">
              <Shapes className="w-4 h-4 text-zinc-500" />
              <h3 className="text-xs uppercase tracking-wider text-zinc-500 font-bold">
                Your skills
              </h3>
            </div>

            {loading && skills.length === 0 ? (
              <div className="flex items-center gap-2 rounded-2xl bg-zinc-800/40 border border-zinc-700/50 px-4 py-6">
                <Loader2 className="w-4 h-4 text-zinc-500 animate-spin" />
                <span className="text-xs text-zinc-500">Loading…</span>
              </div>
            ) : skills.length === 0 ? (
              <div className="rounded-2xl bg-zinc-800/30 border border-dashed border-zinc-700/60 px-4 py-8 text-center">
                <Wand2 className="w-6 h-6 text-zinc-600 mx-auto" />
                <p className="text-xs text-zinc-400 mt-2 font-medium">
                  No skills yet
                </p>
                <p className="text-[11px] text-zinc-500 mt-1 max-w-sm mx-auto leading-relaxed">
                  Start with a template below to see how one is put together,
                  then write your own — a skill is just the instructions you keep
                  finding yourself repeating.
                </p>
              </div>
            ) : (
              skills.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  busy={busyId === skill.id}
                  onToggle={async (enabled) => {
                    setBusyId(skill.id);
                    await mutate(`/api/skills/${skill.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ enabled }),
                    });
                    setBusyId(null);
                  }}
                  onSave={async (patch) => {
                    const result = await mutate(`/api/skills/${skill.id}`, {
                      method: "PATCH",
                      body: JSON.stringify(patch),
                    });
                    return result.ok ? null : (result.errors ?? []);
                  }}
                  onDelete={async () => {
                    setBusyId(skill.id);
                    await mutate(`/api/skills/${skill.id}`, { method: "DELETE" });
                    setBusyId(null);
                  }}
                />
              ))
            )}
          </div>

          {/* add */}
          <div className="space-y-2.5">
            <div className="flex items-center gap-2">
              <Plus className="w-4 h-4 text-zinc-500" />
              <h3 className="text-xs uppercase tracking-wider text-zinc-500 font-bold">
                Add a skill
              </h3>
            </div>

            <div className="flex gap-1 p-1 rounded-xl bg-zinc-900/60 border border-zinc-700/40 w-fit">
              {(
                [
                  ["templates", "Templates", Sparkles],
                  ["paste", "Paste your own", FileText],
                ] as const
              ).map(([id, label, Icon]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors ${
                    tab === id
                      ? "bg-zinc-700/70 text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              ))}
            </div>

            {serverErrors.length > 0 && (
              <div className="rounded-xl bg-rose-500/10 border border-rose-500/30 px-3 py-2 space-y-1">
                {serverErrors.map((e, i) => (
                  <p
                    key={i}
                    className="text-[11px] text-rose-200/90 leading-relaxed"
                  >
                    {e}
                  </p>
                ))}
              </div>
            )}

            {tab === "templates" ? (
              <div className="grid gap-2.5">
                {SKILL_TEMPLATES.map((template) => {
                  const installed = installedSlugs.has(template.slug);
                  return (
                    <div
                      key={template.slug}
                      className="rounded-2xl bg-zinc-800/40 border border-zinc-700/50 p-4"
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-zinc-100">
                              {template.name}
                            </span>
                            <ModeBadge mode={template.triggerMode} />
                          </div>
                          <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed">
                            {template.tagline}
                          </p>
                          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                            {template.allowedTools.map((t) => (
                              <ToolChip key={t} name={t} />
                            ))}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={installed || adding}
                          onClick={() => void addTemplate(template)}
                          className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[11px] font-semibold transition-all active:scale-95 disabled:active:scale-100 ${
                            installed
                              ? "bg-zinc-800/60 text-zinc-500 border border-zinc-700/50 cursor-default"
                              : "bg-violet-500/15 hover:bg-violet-500/25 text-violet-200 border border-violet-500/40"
                          }`}
                        >
                          {installed ? (
                            <>
                              <Check className="w-3.5 h-3.5" />
                              Added
                            </>
                          ) : (
                            <>
                              <Plus className="w-3.5 h-3.5" />
                              Add
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="flex items-start gap-2 rounded-xl bg-zinc-800/40 border border-zinc-700/50 px-3 py-2.5">
                  <Info className="w-3.5 h-3.5 text-zinc-400 mt-0.5 shrink-0" />
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    Paste a JSON object, or a Markdown file starting with a{" "}
                    <span className="font-mono text-zinc-300">---</span>{" "}
                    frontmatter block containing{" "}
                    <span className="font-mono text-zinc-300">name</span>,{" "}
                    <span className="font-mono text-zinc-300">description</span>{" "}
                    and optionally{" "}
                    <span className="font-mono text-zinc-300">allowedTools</span>
                    , with the instructions written underneath it.
                  </p>
                </div>

                <textarea
                  ref={textareaRef}
                  value={document_}
                  onChange={(e) => setDocument_(e.target.value)}
                  rows={14}
                  spellCheck={false}
                  placeholder={`---\nname: Release Notes\ndescription: Turns a list of merged changes into notes a customer can read\ntriggerMode: keyword\ntriggers: [release notes, changelog]\nallowedTools: [read_file, list_files]\n---\n\nGroup changes by what the reader gets, not by which module moved…`}
                  className="w-full rounded-xl bg-zinc-900/60 border border-zinc-700/50 px-3 py-2.5 text-[11px] font-mono text-zinc-100 leading-relaxed focus:outline-none focus:ring-2 focus:ring-violet-400/50 [scrollbar-width:thin]"
                />

                {pasteCheck && !pasteCheck.ok && (
                  <div className="rounded-xl bg-rose-500/10 border border-rose-500/30 px-3 py-2 space-y-1.5">
                    {pasteCheck.errors.map((e, i) => (
                      <p
                        key={i}
                        className="text-[11px] text-rose-200/90 leading-relaxed"
                      >
                        {e}
                      </p>
                    ))}
                  </div>
                )}

                {pasteCheck?.ok && (
                  <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-3 py-2.5 space-y-2">
                    <div className="flex items-center gap-2">
                      <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span className="text-[11px] text-emerald-200 font-semibold">
                        {pasteCheck.skill.name} — ready to add
                      </span>
                      <ModeBadge mode={pasteCheck.skill.triggerMode} />
                    </div>
                    {pasteCheck.skill.allowedTools.length > 0 && (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] text-zinc-400">
                          It asked for:
                        </span>
                        {pasteCheck.skill.allowedTools.map((t) => (
                          <ToolChip key={t} name={t} />
                        ))}
                      </div>
                    )}
                    {pasteCheck.warnings.map((w, i) => (
                      <p
                        key={i}
                        className="text-[11px] text-amber-200/90 leading-relaxed flex items-start gap-1.5"
                      >
                        <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                        {w}
                      </p>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  disabled={!pasteCheck?.ok || adding}
                  onClick={() => void addPasted()}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-violet-500/15 hover:bg-violet-500/25 text-violet-200 border border-violet-500/40 text-xs font-semibold transition-all active:scale-95 disabled:opacity-40 disabled:active:scale-100"
                >
                  {adding ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4" />
                  )}
                  Add this skill
                </button>
              </div>
            )}
          </div>

          {/* tool reference */}
          <div className="rounded-2xl bg-zinc-800/30 border border-zinc-700/40 p-4">
            <h3 className="text-xs uppercase tracking-wider text-zinc-500 font-bold">
              What a skill can ask for
            </h3>
            <p className="text-[11px] text-zinc-500 mt-1.5 leading-relaxed">
              These are the tools this app has. A skill can declare any of them,
              and declaring one is what you are approving when you add it — but a
              skill that asks for a tool which is switched off or needs an editor
              you have not connected is held back for that message rather than
              applied half-working. You will see it listed as skipped, with the
              reason.
            </p>
            <div className="mt-3 grid gap-1.5">
              {SKILL_TOOL_CATALOG.map((tool) => (
                <div
                  key={tool.name}
                  className="flex items-start gap-2.5 rounded-xl bg-zinc-900/40 border border-zinc-700/40 px-3 py-2"
                >
                  <ToolChip name={tool.name} />
                  <span className="text-[10px] text-zinc-400 leading-relaxed min-w-0">
                    {tool.effect}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* =========================================================================
 * The in-chat readout
 * ====================================================================== */

/**
 * Renders what the stream said about skills for one turn.
 *
 * This exists because a skill that silently applied is indistinguishable from a
 * model that happened to answer that way, and a skill that silently did not
 * apply is indistinguishable from a skill that did nothing. Both turn a useful
 * feature into folklore. Showing the reason — "your message mentioned
 * 'refactor'" — makes the behaviour checkable.
 */
export function SkillRunSummary({ report }: { report: SkillRunReport }) {
  const [open, setOpen] = useState(false);
  if (report.active.length === 0 && report.skipped.length === 0) return null;

  return (
    <div className="my-2 rounded-xl bg-violet-500/[0.07] border border-violet-500/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-violet-500/10 transition-colors"
      >
        <Sparkles className="w-3.5 h-3.5 text-violet-300 shrink-0" />
        <span className="text-[11px] text-violet-200 font-semibold">
          {report.active.length === 0
            ? "No skills applied"
            : report.active.map((s) => s.name).join(", ")}
        </span>
        {report.skipped.length > 0 && (
          <span className="text-[10px] text-zinc-500">
            · {report.skipped.length} skipped
          </span>
        )}
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-violet-300/60 ml-auto shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-violet-300/60 ml-auto shrink-0" />
        )}
      </button>

      {open && (
        <div className="px-3 pb-2.5 space-y-1.5">
          {report.active.map((s) => (
            <div key={s.id} className="flex items-start gap-2">
              <Check className="w-3 h-3 text-emerald-400 mt-0.5 shrink-0" />
              <span className="text-[10px] text-zinc-300 leading-relaxed">
                <span className="font-semibold">{s.name}</span> — {s.reason}
                {s.allowedTools.length > 0 && (
                  <span className="text-zinc-500">
                    {" "}
                    · {s.allowedTools.join(", ")}
                  </span>
                )}
              </span>
            </div>
          ))}
          {report.skipped.map((s) => (
            <div key={s.id} className="flex items-start gap-2">
              <X className="w-3 h-3 text-zinc-600 mt-0.5 shrink-0" />
              <span className="text-[10px] text-zinc-500 leading-relaxed">
                <span className="font-semibold text-zinc-400">{s.name}</span> —{" "}
                {s.detail}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
