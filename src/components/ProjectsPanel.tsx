"use client";

/**
 * src/components/ProjectsPanel.tsx
 * ---------------------------------------------------------------------------
 * "Work with two folders at once." Pick a second project the assistant may
 * READ — to copy a feature across, to match an existing pattern — while it
 * keeps writing only to the project you have open.
 *
 * WHY A SEPARATE PANEL FROM File access
 *
 * File access is about taking things AWAY (never read these). This is about
 * granting one thing: a read-only window into a second repository. Bolting the
 * two together would put "make the model see less" and "make it see one more
 * folder" behind the same door, and the mental models pull in opposite
 * directions.
 *
 * WHY THE FOLDER CHOICES COME FROM THE EDITOR
 *
 * A browser cannot name a path on your disk, and this server cannot see it
 * either. VS Code is the one participant that knows which folders are open and
 * which you have approved, so those are offered as one-click choices. Typing a
 * path still works and is the only route with no editor connected — but the
 * list is why the common case is a click, not a copy-paste from a file
 * manager.
 *
 * WHAT SAVING HERE DOES AND DOES NOT DO
 *
 * Saving stores a path. It does not grant access to anything: the extension
 * reads the reference folder only if you approved it in VS Code, and re-checks
 * that on every single call. So the worst a wrong value here can do is produce
 * a refusal the assistant will report and move past — never a read of a folder
 * you did not offer.
 *
 * ONE WINDOW, TWO FOLDERS — NOT TWO WINDOWS
 *
 * The bridge keeps one live editor per account, so two VS Code windows on the
 * same account evict each other and flap. Both projects belong in a SINGLE
 * window (File → Add Folder to Workspace). The panel says so wherever the
 * reference folder is configured but not currently reachable, because that is
 * the mistake this feature invites.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  X,
  FolderTree,
  Loader2,
  Plug,
  Check,
  Save,
  AlertTriangle,
  BookOpen,
  FolderOpen,
  Power,
  RotateCcw,
} from "lucide-react";

interface ProjectsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ReferenceConfig {
  path: string;
  name: string;
  enabled: boolean;
  updatedAt: number;
}

interface GrantedFolder {
  path: string;
  name: string;
}

interface Reachability {
  configured: boolean;
  reachable: boolean;
  reason: string | null;
}

interface LoadedState {
  config: ReferenceConfig;
  folders: GrantedFolder[];
  activeRoot: string | null;
  editorConnected: boolean;
  reachability: Reachability;
  limits: { maxPathLength: number };
}

/** Last path segment, both separators, for a display name. */
function folderName(fsPath: string): string {
  const parts = String(fsPath ?? "")
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : fsPath;
}

/** Same-folder test that tolerates separator and (on Windows-looking paths) case. */
function samePath(a: string, b: string): boolean {
  const norm = (v: string) => v.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const left = norm(String(a ?? ""));
  const right = norm(String(b ?? ""));
  if (!left || !right) return false;
  /* A drive letter or backslash anywhere means treat it case-insensitively —
   * Windows and macOS are case-preserving but not case-sensitive, and the only
   * place a false "different" bites is the user picking a folder they typed in
   * a different case. */
  const windowsish = /^[A-Za-z]:/.test(left) || /^[A-Za-z]:/.test(right);
  return windowsish ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export default function ProjectsPanel({ isOpen, onClose }: ProjectsPanelProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [loaded, setLoaded] = useState<LoadedState | null>(null);

  /* Working copy, kept apart from what is saved so the panel can show the
   * difference and offer to discard it. */
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [editorSynced, setEditorSynced] = useState<boolean | null>(null);
  const [postSaveReach, setPostSaveReach] = useState<Reachability | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setSignedOut(false);
    try {
      const res = await fetch("/api/settings/reference-project");
      if (res.status === 401) {
        setSignedOut(true);
        return;
      }
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      const data = (await res.json()) as LoadedState;
      setLoaded(data);
      setPath(data.config.path || "");
      setName(data.config.name || "");
      setEnabled(Boolean(data.config.enabled && data.config.path));
      setSaveError(null);
      setSavedAt(null);
      setEditorSynced(null);
      setPostSaveReach(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void load();
  }, [isOpen, load]);

  /* ---- derived ------------------------------------------------------- */

  const trimmedPath = path.trim();

  const dirty = useMemo(() => {
    if (!loaded) return false;
    return (
      trimmedPath !== (loaded.config.path || "") ||
      name.trim() !== (loaded.config.name || "") ||
      enabled !== Boolean(loaded.config.enabled && loaded.config.path)
    );
  }, [loaded, trimmedPath, name, enabled]);

  /* The one validation the client can do usefully: pointing the reference at
   * the folder being edited is never dangerous — the tools still cannot write
   * through it — but it is certainly a mistake, and it wastes a round every
   * time the model searches a folder it can already list. */
  const collidesWithWorkingRoot = useMemo(() => {
    if (!loaded?.activeRoot || !trimmedPath) return false;
    return samePath(trimmedPath, loaded.activeRoot);
  }, [loaded, trimmedPath]);

  const overLimit = loaded
    ? trimmedPath.length > loaded.limits.maxPathLength
    : false;

  const canSave =
    !saving && dirty && !collidesWithWorkingRoot && !overLimit;

  /* ---- actions ------------------------------------------------------- */

  const choose = useCallback((folder: GrantedFolder) => {
    setPath(folder.path);
    setName(folder.name || folderName(folder.path));
    setEnabled(true);
  }, []);

  const clearSelection = useCallback(() => {
    setPath("");
    setName("");
    setEnabled(false);
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSavedAt(null);
    setEditorSynced(null);
    setPostSaveReach(null);
    try {
      const res = await fetch("/api/settings/reference-project", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: trimmedPath,
          name: name.trim() || undefined,
          enabled: trimmedPath ? enabled : false,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `The server answered ${res.status}.`);
      }
      setLoaded((prev) =>
        prev
          ? { ...prev, config: data.config, reachability: data.reachability }
          : prev,
      );
      setPath(data.config.path || "");
      setName(data.config.name || "");
      setEnabled(Boolean(data.config.enabled && data.config.path));
      setSavedAt(Date.now());
      setEditorSynced(
        typeof data.editorSynced === "boolean" ? data.editorSynced : null,
      );
      setPostSaveReach(data.reachability ?? null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [trimmedPath, name, enabled]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const reach = postSaveReach ?? loaded?.reachability ?? null;
  const editorConnected = loaded?.editorConnected ?? false;

  /* Which of the reported folders is the writable one, so it can be labelled
   * rather than offered as a reference choice. */
  const activeRoot = loaded?.activeRoot ?? null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="projects-title"
        className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl border border-line bg-surface-raised shadow-2xl overflow-hidden animate-fade-rise"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-line bg-surface-overlay">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 shrink-0 rounded-xl grid place-items-center border border-accent-line bg-accent-soft">
              <FolderTree className="w-4 h-4 text-accent" />
            </div>
            <div className="min-w-0">
              <h2
                id="projects-title"
                className="text-sm font-semibold text-ink-hi truncate"
              >
                Reference project
              </h2>
              <p className="text-xs text-ink-low truncate">
                A second folder the assistant can read but never change.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`hidden sm:inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border ${
                editorConnected
                  ? "border-positive-line bg-positive-soft text-positive"
                  : "border-line bg-surface-sunken text-ink-low"
              }`}
              title={
                editorConnected
                  ? "A VS Code editor is connected."
                  : "No editor is connected. Connect VS Code to read a reference project."
              }
            >
              <Plug className="w-3 h-3" />
              {editorConnected ? "VS Code connected" : "No editor"}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="p-2 rounded-lg text-ink-low hover:text-ink-hi hover:bg-surface-hover transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {signedOut ? (
          <div className="p-8 text-center space-y-2">
            <FolderTree className="w-8 h-8 text-accent mx-auto" />
            <p className="text-sm text-ink">Sign in first.</p>
            <p className="text-xs text-ink-low max-w-sm mx-auto leading-relaxed">
              The reference project is stored against your account, so it needs a
              session before anything can be saved.
            </p>
          </div>
        ) : loading ? (
          <div className="p-12 flex items-center justify-center gap-2 text-ink-low">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : loadError ? (
          <div className="p-8 text-center space-y-3">
            <AlertTriangle className="w-8 h-8 text-danger mx-auto" />
            <p className="text-sm text-ink">Could not load this setting.</p>
            <p className="text-xs text-ink-low">{loadError}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-line text-ink-mid hover:text-ink-hi hover:bg-surface-hover transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto [scrollbar-width:thin] px-5 py-4 space-y-5">
            {/* What the assistant writes to */}
            <section className="rounded-xl border border-line bg-surface-sunken p-3.5">
              <div className="flex items-center gap-2 mb-1.5">
                <FolderOpen className="w-4 h-4 text-ink-low" />
                <h3 className="text-xs font-semibold text-ink-hi uppercase tracking-wide">
                  Working folder (read / write)
                </h3>
              </div>
              <p className="text-[13px] text-ink break-all">
                {activeRoot || (
                  <span className="text-ink-low">
                    No writable folder resolved yet. Connect VS Code and approve
                    the project you want to edit.
                  </span>
                )}
              </p>
              <p className="text-[11px] text-ink-low mt-1.5 leading-relaxed">
                This is the only folder the assistant changes. The reference
                project below is read-only, always.
              </p>
            </section>

            {/* The reference project */}
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-accent" />
                <h3 className="text-xs font-semibold text-ink-hi uppercase tracking-wide">
                  Reference folder (read-only)
                </h3>
              </div>

              {/* Approved folders offered as choices */}
              {loaded && loaded.folders.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-[11px] text-ink-low">
                    Folders approved in your VS Code window. Pick one to read
                    from:
                  </p>
                  <div className="space-y-1">
                    {loaded.folders.map((folder) => {
                      const isWorking = activeRoot
                        ? samePath(folder.path, activeRoot)
                        : false;
                      const isChosen = samePath(folder.path, trimmedPath);
                      return (
                        <button
                          key={folder.path}
                          type="button"
                          disabled={isWorking}
                          onClick={() => choose(folder)}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-colors ${
                            isWorking
                              ? "border-line bg-surface-sunken text-ink-low cursor-not-allowed"
                              : isChosen
                                ? "border-accent-line bg-accent-soft text-ink-hi cursor-pointer"
                                : "border-line bg-surface-raised text-ink-mid hover:bg-surface-hover hover:text-ink-hi cursor-pointer"
                          }`}
                          title={folder.path}
                        >
                          <FolderTree
                            className={`w-4 h-4 shrink-0 ${
                              isChosen ? "text-accent" : "text-ink-low"
                            }`}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-medium truncate">
                              {folder.name || folderName(folder.path)}
                            </span>
                            <span className="block text-[11px] text-ink-low truncate">
                              {folder.path}
                            </span>
                          </span>
                          {isWorking ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded border border-line text-ink-low shrink-0">
                              working folder
                            </span>
                          ) : isChosen ? (
                            <Check className="w-4 h-4 text-accent shrink-0" />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <p className="text-[11px] text-ink-low leading-relaxed">
                  {editorConnected
                    ? "No approved folders to offer yet. Add the folder you want to reference to this VS Code window (File → Add Folder to Workspace) and approve it, or type its path below."
                    : "No editor is connected, so there are no folders to offer. Type the full path below, then connect VS Code and add that folder to the window."}
                </p>
              )}

              {/* Manual path entry */}
              <div className="space-y-1.5">
                <label className="text-[11px] text-ink-low">
                  Or type the full folder path
                </label>
                <input
                  type="text"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="C:\Users\you\projects\project-one"
                  spellCheck={false}
                  className="w-full px-3 py-2 rounded-lg border border-line bg-surface-sunken text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent-line font-mono"
                />
                {overLimit && (
                  <p className="text-[11px] text-danger">
                    That path is longer than the {loaded?.limits.maxPathLength}
                    -character limit.
                  </p>
                )}
              </div>

              {/* Enable toggle + clear */}
              {trimmedPath && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <Power
                      className={`w-4 h-4 shrink-0 ${
                        enabled ? "text-positive" : "text-ink-low"
                      }`}
                    />
                    <span className="text-[12px] text-ink-mid truncate">
                      {enabled
                        ? "The assistant may read this folder"
                        : "Kept, but switched off — the assistant will not read it"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setEnabled((v) => !v)}
                      role="switch"
                      aria-checked={enabled}
                      className={`relative w-9 h-5 rounded-full transition-colors cursor-pointer ${
                        enabled ? "bg-accent" : "bg-surface-hover"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                          enabled ? "translate-x-4" : ""
                        }`}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={clearSelection}
                      className="text-[11px] px-2 py-1 rounded border border-line text-ink-low hover:text-ink-hi hover:bg-surface-hover transition-colors cursor-pointer"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}

              {collidesWithWorkingRoot && (
                <p className="flex items-start gap-1.5 text-[11px] text-danger">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    This is the same folder the assistant is editing. Pick a
                    different one — a reference project only helps when it is a{" "}
                    <em>second</em> codebase.
                  </span>
                </p>
              )}

              {/* Reachability, once configured */}
              {reach?.configured && reach.reason && (
                <p className="flex items-start gap-1.5 text-[11px] text-ink-low leading-relaxed rounded-lg border border-line bg-surface-sunken px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-ink-low" />
                  <span>{reach.reason}</span>
                </p>
              )}
              {reach?.configured && reach.reachable && (
                <p className="flex items-center gap-1.5 text-[11px] text-positive">
                  <Check className="w-3.5 h-3.5 shrink-0" />
                  Reachable now — the assistant can search and read it.
                </p>
              )}
            </section>

            <p className="text-[11px] text-ink-low leading-relaxed border-t border-line pt-3">
              Both folders must live in the <strong>same</strong> VS Code window
              (File → Add Folder to Workspace). Two separate windows on one
              account disconnect each other. The assistant reads the reference
              folder only when you ask it to draw on the other project — it does
              not load it into every message.
            </p>
          </div>
        )}

        {/* Footer */}
        {!signedOut && !loading && !loadError && (
          <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-t border-line bg-surface-overlay">
            <div className="text-[11px] min-w-0">
              {saveError ? (
                <span className="text-danger">{saveError}</span>
              ) : savedAt ? (
                <span className="inline-flex items-center gap-1.5 text-positive">
                  <Check className="w-3.5 h-3.5" />
                  Saved.
                  {editorSynced === true
                    ? " Sent to your editor."
                    : editorSynced === false
                      ? " It applies as soon as an editor connects."
                      : ""}
                </span>
              ) : dirty ? (
                <span className="text-ink-low">Unsaved changes.</span>
              ) : (
                <span className="text-ink-faint">
                  {trimmedPath ? "Up to date." : "No reference project set."}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!canSave}
              className={`inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-lg border transition-colors ${
                canSave
                  ? "border-accent-line bg-accent-soft text-accent hover:bg-accent hover:text-white cursor-pointer"
                  : "border-line bg-surface-sunken text-ink-faint cursor-not-allowed"
              }`}
            >
              {saving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
