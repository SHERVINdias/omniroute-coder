"use client";

/**
 * src/components/FileAccessPanel.tsx
 * ---------------------------------------------------------------------------
 * The settings surface for "which files may the model never read".
 *
 * WHY THIS IS A PANEL AND NOT A SECTION IN SettingsPanel
 *
 * SettingsPanel is one long scroll of provider credentials and round budgets,
 * and this is the one screen a user opens when they are worried. Burying a
 * privacy control four screenfuls below an API key form means the people most
 * likely to want it are the least likely to find it. It also keeps the two
 * concerns separable: nothing here needs a provider to exist.
 *
 * WHY THE ENGINE IS IMPORTED INTO THE CLIENT BUNDLE
 *
 * `@/lib/fileExclusions` has no imports at all — no `node:` anything, no db —
 * specifically so it can be evaluated in three places: the server, the VS Code
 * extension, and here. The live preview at the bottom of this panel answers
 * "would this path be blocked?" for rules the user has typed but NOT saved,
 * and the server cannot answer that question about a config it has never seen.
 * So this is not a round-trip being optimised away; it is the only place the
 * answer exists.
 *
 * The *displayed* lists (always-blocked patterns, recommended groups, limits)
 * still come from the GET response rather than from the import, because the
 * route is the contract and it is what the enforcement actually reads. The
 * imported copy is used for compiling a matcher, never as the source of truth
 * for what to render.
 *
 * WHAT THIS PANEL DELIBERATELY DOES NOT DO
 *
 * It does not list the user's real files. A "show me everything currently
 * hidden" view would need an endpoint that lists the workspace *unfiltered* —
 * the exact hole the exclusion work was done to close — and the value of
 * seeing filenames is small next to the cost of building a bypass and hoping
 * nobody calls it. The path tester covers the same need honestly: type or
 * paste a path, get the verdict and the rule that produced it.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Info,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Lock,
  ChevronDown,
  ChevronRight,
  Check,
  Search,
  RotateCcw,
  Plug,
  Ban,
  Save,
  AlertTriangle,
} from "lucide-react";
import {
  ExclusionConfig,
  ExclusionGroup,
  matcherFrom,
  validatePattern,
} from "@/lib/fileExclusions";

interface FileAccessPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Limits {
  maxPatterns: number;
  maxPatternLength: number;
}

interface LoadedState {
  config: ExclusionConfig;
  groups: ExclusionGroup[];
  alwaysPatterns: string[];
  alwaysExceptions: string[];
  limits: Limits;
}

interface RejectedPattern {
  pattern: string;
  error: string;
}

/** What the extension status endpoint tells us that matters here. */
interface EditorState {
  connected: boolean;
  root: string | null;
}

/* -------------------------------------------------------------------------
 * Text <-> patterns
 *
 * The stored shape is an ordered array; the edit shape is a textarea. Order is
 * load-bearing — "!" negations are last-match-wins — so a textarea is the
 * honest control: it shows the order and lets it be rearranged. A list of
 * chips would hide the one property that changes what the rules mean.
 * ---------------------------------------------------------------------- */

function textToPatterns(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function patternsToText(patterns: string[]): string {
  return patterns.join("\n");
}

/** Order-sensitive comparison — [a, b] and [b, a] are different rule sets. */
function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => entry === b[i]);
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((entry) => set.has(entry));
}

/* -------------------------------------------------------------------------
 * Small pieces
 * ---------------------------------------------------------------------- */

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative w-9 h-5 shrink-0 rounded-full border transition-colors cursor-pointer ${
        on
          ? "bg-accent border-accent-line"
          : "bg-surface-sunken border-line hover:border-line-strong"
      }`}
    >
      <span
        className={`absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all ${
          on ? "left-[18px] bg-accent-ink" : "left-0.5 bg-ink-low"
        }`}
      />
    </button>
  );
}

function GroupRow({
  group,
  enabled,
  onToggle,
}: {
  group: ExclusionGroup;
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`rounded-lg border transition-colors ${
        enabled ? "border-line bg-surface-sunken" : "border-line-faint bg-transparent"
      }`}
    >
      <div className="flex items-start gap-3 p-3">
        <Toggle on={enabled} onChange={onToggle} label={`Hide ${group.label}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`text-sm font-medium ${
                enabled ? "text-ink-hi" : "text-ink-low"
              }`}
            >
              {group.label}
            </span>
            {!enabled && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-line text-ink-faint">
                visible to the model
              </span>
            )}
          </div>
          <p className="text-xs text-ink-low mt-0.5 leading-relaxed">{group.blurb}</p>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-ink-faint hover:text-ink-mid transition-colors cursor-pointer"
          >
            {expanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            {group.patterns.length} pattern{group.patterns.length === 1 ? "" : "s"}
          </button>
          {expanded && (
            <div className="mt-2 flex flex-wrap gap-1">
              {group.patterns.map((pattern) => (
                <code
                  key={pattern}
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-base border border-line-faint text-ink-mid"
                >
                  {pattern}
                </code>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * The panel
 * ---------------------------------------------------------------------- */

export default function FileAccessPanel({ isOpen, onClose }: FileAccessPanelProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [loaded, setLoaded] = useState<LoadedState | null>(null);

  /* Working copy. Kept separate from `loaded.config` so the panel can show
   * what is saved, what is being edited, and the difference between them. */
  const [text, setText] = useState("");
  const [disabledGroups, setDisabledGroups] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<RejectedPattern[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [editorSynced, setEditorSynced] = useState<boolean | null>(null);

  const [editor, setEditor] = useState<EditorState | null>(null);

  const [showAlways, setShowAlways] = useState(false);
  const [testPath, setTestPath] = useState("");
  const [testIsDir, setTestIsDir] = useState(false);

  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const testInputRef = useRef<HTMLInputElement | null>(null);

  /* ---- load ---------------------------------------------------------- */

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setSignedOut(false);
    try {
      const res = await fetch("/api/settings/file-exclusions");
      if (res.status === 401) {
        setSignedOut(true);
        return;
      }
      if (!res.ok) {
        throw new Error(`The server answered ${res.status}.`);
      }
      const data = (await res.json()) as LoadedState;
      setLoaded(data);
      setText(patternsToText(data.config.patterns || []));
      setDisabledGroups([...(data.config.disabledGroups || [])]);
      setRejected([]);
      setSaveError(null);
      setSavedAt(null);
      setEditorSynced(null);
      setConfirmDiscard(false);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void load();

    /* Whether an editor is attached changes what a save means: with one
     * connected the rules reach the process holding the file handles, without
     * one they are stored and applied server-side only. Saying which is true
     * is the difference between "saved" and "in force". */
    void (async () => {
      try {
        const res = await fetch("/api/extension/status");
        if (!res.ok) return;
        const data = await res.json();
        setEditor({ connected: !!data.connected, root: data.root ?? null });
      } catch {
        /* The chip just does not appear. Not worth an error surface. */
      }
    })();
  }, [isOpen, load]);

  /* ---- derived ------------------------------------------------------- */

  const patterns = useMemo(() => textToPatterns(text), [text]);

  const lineErrors = useMemo(() => {
    const out: { line: number; pattern: string; error: string }[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;
      const error = validatePattern(raw);
      if (error) out.push({ line: i + 1, pattern: raw, error });
    }
    return out;
  }, [text]);

  /* The matcher for the preview: built from the UNSAVED working copy, which is
   * exactly why it is built here and not asked for. */
  const liveMatcher = useMemo(
    () =>
      matcherFrom({
        patterns: patterns.filter((p) => !validatePattern(p)),
        disabledGroups,
        updatedAt: 0,
      }),
    [patterns, disabledGroups],
  );

  const verdict = useMemo(() => {
    const trimmed = testPath.trim();
    if (!trimmed) return null;
    return liveMatcher.decide(trimmed, testIsDir);
  }, [liveMatcher, testPath, testIsDir]);

  const dirty = useMemo(() => {
    if (!loaded) return false;
    return (
      !sameList(patterns, loaded.config.patterns || []) ||
      !sameSet(disabledGroups, loaded.config.disabledGroups || [])
    );
  }, [loaded, patterns, disabledGroups]);

  const overLimit = loaded ? patterns.length > loaded.limits.maxPatterns : false;

  /* ---- actions ------------------------------------------------------- */

  const requestClose = useCallback(() => {
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, requestClose]);

  const save = useCallback(async () => {
    if (!loaded) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/settings/file-exclusions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patterns, disabledGroups }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `The server answered ${res.status}.`);
      }

      /* Re-seed the editor from what came back, not from what was sent. The
       * server trims, drops duplicates and removes invalid lines; showing the
       * submitted text afterwards would leave the panel claiming rules that
       * were not stored. */
      const config = data.config as ExclusionConfig;
      setLoaded((prev) => (prev ? { ...prev, config } : prev));
      setText(patternsToText(config.patterns || []));
      setDisabledGroups([...(config.disabledGroups || [])]);
      setRejected(Array.isArray(data.rejected) ? data.rejected : []);
      setEditorSynced(typeof data.editorSynced === "boolean" ? data.editorSynced : null);
      setSavedAt(Date.now());
      setConfirmDiscard(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [loaded, patterns, disabledGroups]);

  const revert = useCallback(() => {
    if (!loaded) return;
    setText(patternsToText(loaded.config.patterns || []));
    setDisabledGroups([...(loaded.config.disabledGroups || [])]);
    setRejected([]);
    setSaveError(null);
    setConfirmDiscard(false);
  }, [loaded]);

  const toggleGroup = useCallback((id: string, enabled: boolean) => {
    setDisabledGroups((prev) =>
      enabled ? prev.filter((g) => g !== id) : prev.includes(id) ? prev : [...prev, id],
    );
  }, []);

  const tryPath = useCallback((path: string) => {
    setTestPath(path);
    setTestIsDir(path.endsWith("/"));
    testInputRef.current?.focus();
  }, []);

  if (!isOpen) return null;

  /* ---- render -------------------------------------------------------- */

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-access-title"
        className="w-full max-w-3xl max-h-[88vh] flex flex-col rounded-2xl border border-line bg-surface-raised shadow-2xl overflow-hidden animate-fade-rise"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-line bg-surface-overlay">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 shrink-0 rounded-xl grid place-items-center border border-accent-line bg-accent-soft">
              <ShieldCheck className="w-4 h-4 text-accent" />
            </div>
            <div className="min-w-0">
              <h2 id="file-access-title" className="text-sm font-semibold text-ink-hi truncate">
                File access
              </h2>
              <p className="text-xs text-ink-low truncate">
                Decide what the model is never allowed to open.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {editor && (
              <span
                className={`hidden sm:inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border ${
                  editor.connected
                    ? "border-positive-line bg-positive-soft text-positive"
                    : "border-line bg-surface-sunken text-ink-low"
                }`}
                title={
                  editor.connected
                    ? editor.root
                      ? `Rules are enforced inside ${editor.root}`
                      : "An editor is connected."
                    : "No editor is connected. Rules still apply on the server."
                }
              >
                <Plug className="w-3 h-3" />
                {editor.connected ? "VS Code connected" : "No editor"}
              </span>
            )}
            <button
              type="button"
              onClick={requestClose}
              aria-label="Close"
              className="p-2 rounded-lg text-ink-low hover:text-ink-hi hover:bg-surface-hover transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {signedOut ? (
          <div className="p-8 text-center space-y-2">
            <ShieldAlert className="w-8 h-8 text-accent mx-auto" />
            <p className="text-sm text-ink">Sign in first.</p>
            <p className="text-xs text-ink-low max-w-sm mx-auto leading-relaxed">
              Exclusion rules are stored against your account, so they need a session
              before anything can be saved.
            </p>
          </div>
        ) : loading ? (
          <div className="p-12 flex items-center justify-center gap-2 text-ink-low">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading your rules…</span>
          </div>
        ) : loadError ? (
          <div className="p-8 text-center space-y-3">
            <AlertTriangle className="w-8 h-8 text-danger mx-auto" />
            <p className="text-sm text-ink">Could not load your rules.</p>
            <p className="text-xs text-ink-low">{loadError}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="text-xs px-3 py-1.5 rounded-lg border border-line text-ink hover:bg-surface-hover transition-colors cursor-pointer"
            >
              Try again
            </button>
          </div>
        ) : loaded ? (
          <>
            <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-6">
              {/* ---- always blocked ---- */}
              <section>
                <div className="flex items-start gap-3 rounded-lg border border-line bg-surface-sunken p-3">
                  <Lock className="w-4 h-4 text-ink-mid shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink-hi">
                      Credentials are always blocked
                    </p>
                    <p className="text-xs text-ink-low mt-0.5 leading-relaxed">
                      {loaded.alwaysPatterns.length} built-in rules cover{" "}
                      <code className="font-mono text-ink-mid">.env</code> files, private
                      keys and credential stores. These cannot be switched off, and a{" "}
                      <code className="font-mono text-ink-mid">!</code> rule cannot re-open
                      them — a key that reaches a prompt reaches whoever hosts the model.
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowAlways((v) => !v)}
                      className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-ink-faint hover:text-ink-mid transition-colors cursor-pointer"
                    >
                      {showAlways ? (
                        <ChevronDown className="w-3 h-3" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      )}
                      {showAlways ? "Hide the list" : "See exactly what is covered"}
                    </button>
                    {showAlways && (
                      <div className="mt-2 space-y-2">
                        <div className="flex flex-wrap gap-1">
                          {loaded.alwaysPatterns.map((pattern) => (
                            <code
                              key={pattern}
                              className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-base border border-line-faint text-ink-mid"
                            >
                              {pattern}
                            </code>
                          ))}
                        </div>
                        <p className="text-[11px] text-ink-faint leading-relaxed">
                          Placeholder files stay readable, because hiding them would make
                          the model guess at config names:
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {loaded.alwaysExceptions.map((pattern) => (
                            <code
                              key={pattern}
                              className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-positive-soft border border-positive-line text-positive"
                            >
                              {pattern}
                            </code>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* ---- recommended groups ---- */}
              <section className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-mid">
                    Recommended
                  </h3>
                  <span className="text-[11px] text-ink-faint">
                    {loaded.groups.length - disabledGroups.length} of {loaded.groups.length}{" "}
                    on
                  </span>
                </div>
                <p className="text-xs text-ink-low leading-relaxed">
                  All on by default. Each one has a day where you need it back —
                  debugging a dependency, reading a build artefact — so each one can be
                  switched off.
                </p>
                <div className="space-y-1.5 pt-1">
                  {loaded.groups.map((group) => (
                    <GroupRow
                      key={group.id}
                      group={group}
                      enabled={!disabledGroups.includes(group.id)}
                      onToggle={(next) => toggleGroup(group.id, next)}
                    />
                  ))}
                </div>
              </section>

              {/* ---- user rules ---- */}
              <section className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-mid">
                    Your own rules
                  </h3>
                  <span
                    className={`text-[11px] ${
                      overLimit ? "text-danger" : "text-ink-faint"
                    }`}
                  >
                    {patterns.length} / {loaded.limits.maxPatterns}
                  </span>
                </div>
                <p className="text-xs text-ink-low leading-relaxed">
                  One per line, <code className="font-mono text-ink-mid">.gitignore</code>{" "}
                  syntax. A trailing{" "}
                  <code className="font-mono text-ink-mid">/</code> means the whole folder.
                  Start a line with{" "}
                  <code className="font-mono text-ink-mid">!</code> to make an exception to
                  a rule above it, and with{" "}
                  <code className="font-mono text-ink-mid">#</code> for a note to yourself.
                  Order matters: the last matching line wins.
                </p>

                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  spellCheck={false}
                  rows={8}
                  placeholder={
                    "# examples\nnotes/private/\n*.draft.md\ninvoices/\n!invoices/README.md"
                  }
                  className="w-full rounded-lg border border-line bg-surface-base px-3 py-2 font-mono text-xs text-ink-hi placeholder:text-ink-faint focus:outline-none focus:border-accent-line focus:ring-1 focus:ring-accent-line resize-y"
                />

                {overLimit && (
                  <p className="text-[11px] text-danger flex items-start gap-1.5">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                    Over the {loaded.limits.maxPatterns} rule cap — everything past that
                    will be dropped on save.
                  </p>
                )}

                {lineErrors.length > 0 && (
                  <div className="rounded-lg border border-danger-line bg-danger-soft p-2.5 space-y-1">
                    <p className="text-[11px] font-medium text-danger">
                      {lineErrors.length} line{lineErrors.length === 1 ? "" : "s"} will be
                      dropped:
                    </p>
                    {lineErrors.slice(0, 6).map((problem) => (
                      <p key={problem.line} className="text-[11px] text-danger/90">
                        Line {problem.line}{" "}
                        <code className="font-mono">{problem.pattern}</code> — {problem.error}
                      </p>
                    ))}
                    {lineErrors.length > 6 && (
                      <p className="text-[11px] text-danger/70">
                        …and {lineErrors.length - 6} more.
                      </p>
                    )}
                  </div>
                )}

                {rejected.length > 0 && (
                  <div className="rounded-lg border border-line bg-surface-sunken p-2.5 space-y-1">
                    <p className="text-[11px] font-medium text-ink-mid">
                      The last save dropped {rejected.length} rule
                      {rejected.length === 1 ? "" : "s"}:
                    </p>
                    {rejected.slice(0, 6).map((entry, i) => (
                      <p key={`${entry.pattern}-${i}`} className="text-[11px] text-ink-low">
                        <code className="font-mono">{entry.pattern}</code> — {entry.error}
                      </p>
                    ))}
                  </div>
                )}
              </section>

              {/* ---- tester ---- */}
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-mid">
                  Check a path
                </h3>
                <p className="text-xs text-ink-low leading-relaxed">
                  Answers against what is on screen right now, including edits you have
                  not saved yet.
                </p>

                <div className="flex items-center gap-2">
                  <div className="relative flex-1 min-w-0">
                    <Search className="w-3.5 h-3.5 text-ink-faint absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      ref={testInputRef}
                      value={testPath}
                      onChange={(e) => setTestPath(e.target.value)}
                      spellCheck={false}
                      placeholder="src/app/page.tsx"
                      className="w-full rounded-lg border border-line bg-surface-base pl-8 pr-3 py-2 font-mono text-xs text-ink-hi placeholder:text-ink-faint focus:outline-none focus:border-accent-line focus:ring-1 focus:ring-accent-line"
                    />
                  </div>
                  <label className="flex items-center gap-1.5 text-[11px] text-ink-low shrink-0 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={testIsDir}
                      onChange={(e) => setTestIsDir(e.target.checked)}
                      className="accent-accent cursor-pointer"
                    />
                    it is a folder
                  </label>
                </div>

                <div className="flex flex-wrap gap-1">
                  {[".env", "node_modules/", "src/app/page.tsx", "package-lock.json"].map(
                    (sample) => (
                      <button
                        key={sample}
                        type="button"
                        onClick={() => tryPath(sample)}
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-line-faint text-ink-faint hover:text-ink-mid hover:border-line transition-colors cursor-pointer"
                      >
                        {sample}
                      </button>
                    ),
                  )}
                </div>

                {verdict && (
                  <div
                    className={`rounded-lg border p-3 flex items-start gap-2.5 ${
                      verdict.excluded
                        ? "border-danger-line bg-danger-soft"
                        : "border-positive-line bg-positive-soft"
                    }`}
                  >
                    {verdict.excluded ? (
                      <Ban className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                    ) : (
                      <Check className="w-4 h-4 text-positive shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0">
                      <p
                        className={`text-xs font-medium ${
                          verdict.excluded ? "text-danger" : "text-positive"
                        }`}
                      >
                        {verdict.excluded
                          ? "Blocked — the model cannot open this."
                          : "Readable — the model can open this."}
                      </p>
                      <p className="text-[11px] text-ink-low mt-0.5 leading-relaxed">
                        {verdict.excluded
                          ? verdict.reason
                          : verdict.rule
                            ? `Nothing blocks it: the last matching rule is an exception (${verdict.rule.pattern}).`
                            : /* Deliberately "blocks" and not "matches". A
                                 placeholder like .env.example reaches here with
                                 no rule attached even though the built-in
                                 carve-out is what saved it, and claiming
                                 nothing matched would be wrong. */
                              "No rule blocks this path."}
                      </p>
                    </div>
                  </div>
                )}
              </section>

              {/* ---- where this is enforced ---- */}
              <section className="rounded-lg border border-line-faint bg-surface-sunken/50 p-3 flex items-start gap-2.5">
                <Info className="w-3.5 h-3.5 text-ink-faint shrink-0 mt-0.5" />
                <div className="text-[11px] text-ink-low leading-relaxed space-y-1">
                  <p>
                    Rules are refused at the tool layer, not suggested to the model — a
                    blocked file cannot be reached by renaming the request or asking a
                    different way.
                  </p>
                  <p>
                    They apply to every file tool, directory listing and search on the
                    server, and are pushed to VS Code on save so the editor holding your
                    files enforces the same list.{" "}
                    {editor?.connected === false && (
                      <span className="text-ink-faint">
                        No editor is connected right now, so only the server side is live.
                      </span>
                    )}
                  </p>
                </div>
              </section>
            </div>

            {/* Footer */}
            <div className="border-t border-line bg-surface-overlay px-5 py-3">
              {confirmDiscard ? (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-ink flex items-center gap-2 min-w-0">
                    <AlertTriangle className="w-3.5 h-3.5 text-danger shrink-0" />
                    <span className="truncate">Close without saving your changes?</span>
                  </p>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setConfirmDiscard(false)}
                      className="text-xs px-3 py-1.5 rounded-lg border border-line text-ink hover:bg-surface-hover transition-colors cursor-pointer"
                    >
                      Keep editing
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDiscard(false);
                        onClose();
                      }}
                      className="text-xs px-3 py-1.5 rounded-lg border border-danger-line bg-danger-soft text-danger hover:bg-danger-soft/70 transition-colors cursor-pointer"
                    >
                      Discard
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-[11px]">
                    {saveError ? (
                      <span className="text-danger flex items-center gap-1.5">
                        <AlertTriangle className="w-3 h-3 shrink-0" />
                        {saveError}
                      </span>
                    ) : dirty ? (
                      <span className="text-ink-low">Unsaved changes.</span>
                    ) : savedAt ? (
                      <span className="text-positive flex items-center gap-1.5">
                        <Check className="w-3 h-3 shrink-0" />
                        {editorSynced === true
                          ? "Saved and in force in VS Code."
                          : editorSynced === false
                            ? "Saved. No editor was connected, so it will pick these up when it reconnects."
                            : "Saved."}
                      </span>
                    ) : (
                      <span className="text-ink-faint">
                        {(loaded.config.patterns || []).length} of your own rules,{" "}
                        {loaded.groups.length - disabledGroups.length} groups on.
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {dirty && (
                      <button
                        type="button"
                        onClick={revert}
                        className="text-xs px-3 py-1.5 rounded-lg border border-line text-ink-low hover:text-ink hover:bg-surface-hover transition-colors cursor-pointer inline-flex items-center gap-1.5"
                      >
                        <RotateCcw className="w-3 h-3" />
                        Revert
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void save()}
                      disabled={!dirty || saving}
                      className="text-xs px-3.5 py-1.5 rounded-lg bg-accent text-accent-ink font-medium hover:bg-accent-hi transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer inline-flex items-center gap-1.5"
                    >
                      {saving ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Save className="w-3 h-3" />
                      )}
                      {saving ? "Saving…" : "Save rules"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
