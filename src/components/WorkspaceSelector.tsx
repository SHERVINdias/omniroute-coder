"use client";

/**
 * src/components/WorkspaceSelector.tsx
 * ---------------------------------------------------------------------------
 * Two components in one, chosen by the server.
 *
 * WHY
 *
 * This was a folder picker: Browse, a list of auto-discovered projects, and a
 * manual path field. On a laptop all three work. On a shared deployment all
 * three are refused by design, and the refusals are correct — browsing would
 * enumerate the OPERATOR's disk, the native dialog would open on a machine with
 * no screen, and a typed path would aim the agent at `/app`. The UI did not
 * know that, so it kept offering the choice: Browse returned a red error,
 * "Auto-Discovered Projects (0)" was empty because the server refuses to
 * enumerate rather than because nothing was found, and Set Path failed with a
 * sentence explaining that this is not how it works.
 *
 * Offering a control that cannot succeed is worse than not having one. So
 * `/api/workspace` now reports `editable`, and this renders either:
 *
 *   editable       the original picker, for a local install — where the Next
 *                  server, VS Code and the person are the same machine.
 *
 *   not editable   a read-only chip naming the folder the connected editor
 *                  reported, whose tooltip says where it comes from and that it
 *                  changes in VS Code. When nothing is paired the chip becomes
 *                  the way to start pairing.
 *
 * `editable` is `null` until the first response arrives; the chip renders inert
 * for that moment rather than guessing, because guessing means showing an
 * affordance and then taking it away.
 * ------------------------------------------------------------------------- */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Folder,
  FolderOpen,
  ChevronDown,
  Check,
  Search,
  RefreshCw,
  HardDrive,
  FolderSearch,
  X,
  AlertCircle,
  MonitorSmartphone,
} from "lucide-react";

export interface DiscoveredProject {
  name: string;
  path: string;
  hasPackageJson: boolean;
}

interface WorkspaceSelectorProps {
  onWorkspaceChange?: (newWorkspacePath: string) => void;
  /**
   * Open the Connect VS Code panel. Supplied by page.tsx.
   *
   * Only reachable in the read-only shape, and only useful there: on a shared
   * deployment the folder is chosen in the editor, so the one action this chip
   * can offer is "let me pair the editor".
   */
  onConnectEditor?: () => void;
}

export function WorkspaceSelector({
  onWorkspaceChange,
  onConnectEditor,
}: WorkspaceSelectorProps) {
  const [activeWorkspace, setActiveWorkspace] = useState<string>("");
  const [discoveredProjects, setDiscoveredProjects] = useState<
    DiscoveredProject[]
  >([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [customPathInput, setCustomPathInput] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /** null = the server has not answered yet. See the header note. */
  const [editable, setEditable] = useState<boolean | null>(null);
  const [connected, setConnected] = useState(false);
  const [source, setSource] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);

  const fetchWorkspaceInfo = useCallback(async () => {
    try {
      setLoading(true);
      setErrorMsg(null);
      const res = await fetch("/api/workspace", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data.activeWorkspace) {
          setActiveWorkspace(data.activeWorkspace);
          setCustomPathInput(data.activeWorkspace);
        }
        if (Array.isArray(data.discoveredProjects)) {
          setDiscoveredProjects(data.discoveredProjects);
        }
        /* Absent means an older server that predates the field. Treating that
         * as editable keeps the previous behaviour rather than silently
         * removing the picker from a local install. */
        setEditable(data.editable !== false);
        setConnected(Boolean(data.connected));
        if (typeof data.source === "string") setSource(data.source);
      } else if (res.status === 503) {
        /* File tools are off on this server. Nothing about a workspace applies,
         * and the picker's controls would all fail. */
        setEditable(false);
      }
    } catch (err) {
      console.error("Failed to fetch workspace info:", err);
      setErrorMsg("Failed to connect to workspace API.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorkspaceInfo();
  }, [fetchWorkspaceInfo]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelectProject = async (targetPath: string) => {
    try {
      setLoading(true);
      setErrorMsg(null);
      const res = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeWorkspace: targetPath }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setActiveWorkspace(data.activeWorkspace);
        setCustomPathInput(data.activeWorkspace);
        if (Array.isArray(data.discoveredProjects)) {
          setDiscoveredProjects(data.discoveredProjects);
        }
        setIsOpen(false);
        if (onWorkspaceChange) onWorkspaceChange(data.activeWorkspace);
      } else {
        setErrorMsg(data.error || "Failed to set active workspace.");
      }
    } catch (err) {
      console.error("Error setting workspace:", err);
      setErrorMsg("Failed to update workspace path.");
    } finally {
      setLoading(false);
    }
  };

  const handleBrowseNativeFolder = async () => {
    try {
      setLoading(true);
      setErrorMsg(null);
      const res = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "browse" }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setActiveWorkspace(data.activeWorkspace);
        setCustomPathInput(data.activeWorkspace);
        if (Array.isArray(data.discoveredProjects)) {
          setDiscoveredProjects(data.discoveredProjects);
        }
        setIsOpen(false);
        if (onWorkspaceChange) onWorkspaceChange(data.activeWorkspace);
      } else if (
        data.error &&
        data.error !== "No folder was selected or browser dialog was closed."
      ) {
        setErrorMsg(data.error);
      }
    } catch (err) {
      console.error("Native browse error:", err);
      setErrorMsg("Error triggering folder browser.");
    } finally {
      setLoading(false);
    }
  };

  const handleCustomPathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (customPathInput.trim()) {
      handleSelectProject(customPathInput.trim());
    }
  };

  const folderName = activeWorkspace
    ? activeWorkspace.split(/[/\\]/).filter(Boolean).pop() || activeWorkspace
    : "";

  const filteredProjects = discoveredProjects.filter((p) => {
    const q = searchQuery.toLowerCase().trim();
    return p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q);
  });

  /* -------------------------------------------------------------------------
   * Read-only shape: a shared deployment, or the server has not answered yet.
   *
   * Everything the picker could do is refused here, so there is nothing to
   * drop down to. What is left is worth keeping though — which folder the
   * agent will touch is the single most load-bearing fact on this screen, and
   * before this change it was only discoverable by opening a menu whose other
   * controls did not work.
   * ---------------------------------------------------------------------- */
  if (editable !== true) {
    const unknown = editable === null;
    const paired = connected && Boolean(activeWorkspace);

    const label = unknown
      ? "Working folder"
      : paired
        ? folderName
        : connected
          ? "No folder open"
          : "No editor connected";

    /* Newlines survive in a native tooltip, so the path gets a line of its own
     * — these are long and a wrapped single paragraph buries it. */
    const tooltip = unknown
      ? "Checking which folder the agent is working in…"
      : paired
        ? `${activeWorkspace}\n\nThis is the folder open in the VS Code window connected to your account (${source || "reported by the VS Code extension"}).\n\nTo work somewhere else, open that folder in VS Code. This server does not browse its own disk.`
        : connected
          ? "Your editor is connected but has no folder open. Open a folder in that VS Code window and the agent will work there."
          : "No VS Code window is connected to your account, so the agent has no folder to work in yet. Click to pair your editor.";

    const chipInner = (
      <>
        {paired ? (
          <Folder className="w-3.5 h-3.5 text-ink-low shrink-0" />
        ) : (
          <MonitorSmartphone className="w-3.5 h-3.5 text-ink-low shrink-0" />
        )}
        <span className="font-mono truncate max-w-[140px] sm:max-w-[200px]">
          {label}
        </span>
        {paired && (
          <span className="w-1.5 h-1.5 rounded-full bg-positive shrink-0" />
        )}
      </>
    );

    /* A button only when there is somewhere to go. A clickable-looking chip
     * with no handler is the same mistake as the picker that could not pick. */
    if (onConnectEditor && !unknown) {
      return (
        <button
          type="button"
          onClick={onConnectEditor}
          title={tooltip}
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-surface-hover hover:bg-surface-active border border-line text-xs text-ink-mid hover:text-ink-hi transition-colors cursor-pointer font-sans"
        >
          {chipInner}
        </button>
      );
    }

    return (
      <div
        title={tooltip}
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-surface-hover border border-line text-xs text-ink-mid cursor-default font-sans"
      >
        {chipInner}
      </div>
    );
  }

  /* -------------------------------------------------------------------------
   * Editable shape: a local install, where all of this genuinely works.
   *
   * Re-skinned onto the design tokens. It previously carried amber on the
   * trigger, on the Browse button, on the selected row, on the heading icon and
   * on the active-path readout — five amber elements in one small panel, which
   * is five things claiming to be the most important. Amber is now spent once,
   * on Browse, which is the action that actually changes something.
   * ---------------------------------------------------------------------- */
  return (
    <div
      ref={containerRef}
      className="relative inline-block text-left font-sans"
    >
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-surface-hover hover:bg-surface-active border border-line text-xs text-ink-mid hover:text-ink-hi transition-colors cursor-pointer"
        title={activeWorkspace || "Choose the folder the agent works in"}
      >
        <FolderOpen className="w-3.5 h-3.5 text-ink-low shrink-0" />
        <span className="font-mono max-w-[140px] sm:max-w-[200px] truncate">
          {folderName || "Select workspace"}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-ink-low transition-transform duration-200 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {isOpen && (
        <div className="absolute left-0 mt-2 w-80 sm:w-96 bg-surface-overlay border border-line rounded-2xl shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150">
          <div className="p-3 border-b border-line-faint space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold text-ink-hi">
                <HardDrive className="w-3.5 h-3.5 text-ink-low" />
                <span>Working folder</span>
              </div>
              <button
                type="button"
                onClick={fetchWorkspaceInfo}
                disabled={loading}
                className="p-1 rounded-lg bg-surface-hover hover:bg-surface-active text-ink-low hover:text-ink-hi transition-colors disabled:opacity-50 cursor-pointer"
                title="Rescan projects"
              >
                <RefreshCw
                  className={`w-3 h-3 ${loading ? "animate-spin" : ""}`}
                />
              </button>
            </div>

            <div className="p-2 rounded-xl bg-surface-sunken border border-line-faint text-[11px] font-mono break-all text-ink">
              <span className="text-ink-faint block text-[9px] uppercase tracking-wider font-sans font-medium mb-0.5">
                Current
              </span>
              {activeWorkspace || "Not configured"}
            </div>

            <button
              type="button"
              onClick={handleBrowseNativeFolder}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-accent hover:bg-accent-hi text-black border border-accent text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40"
            >
              <FolderSearch className="w-4 h-4" />
              <span>Browse for a folder</span>
            </button>
          </div>

          <div className="p-3 border-b border-line-faint space-y-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-low">
              Projects found nearby ({discoveredProjects.length})
            </span>

            <div className="flex items-center gap-2 bg-surface-sunken border border-line-faint rounded-xl px-2.5 py-1.5">
              <Search className="w-3.5 h-3.5 text-ink-low shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter by name or path…"
                className="w-full bg-transparent text-xs text-ink-hi focus:outline-none placeholder:text-ink-faint"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="text-ink-low hover:text-ink-hi cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {errorMsg && (
            <div className="p-2.5 mx-3 mt-2 rounded-xl bg-danger-soft border border-danger-line text-danger text-xs flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {/* Was `truncate`, which cut these off mid-sentence — and the
                  useful part of a workspace error is usually the end of it. */}
              <span className="min-w-0">{errorMsg}</span>
            </div>
          )}

          <div className="max-h-56 overflow-y-auto p-2 space-y-1 [scrollbar-width:thin]">
            {filteredProjects.length === 0 ? (
              <p className="p-3 text-center text-xs text-ink-faint">
                {searchQuery
                  ? "Nothing matches that filter."
                  : "No folders with a package.json were found in the usual places. Use Browse above."}
              </p>
            ) : (
              filteredProjects.map((proj) => {
                const isSelected = proj.path === activeWorkspace;
                return (
                  <button
                    key={proj.path}
                    type="button"
                    onClick={() => handleSelectProject(proj.path)}
                    className={`w-full text-left p-2 rounded-xl transition-colors flex items-center justify-between gap-2 cursor-pointer ${
                      isSelected
                        ? "bg-surface-active"
                        : "hover:bg-surface-hover"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Folder
                        className={`w-4 h-4 shrink-0 ${
                          isSelected ? "text-ink-mid" : "text-ink-faint"
                        }`}
                      />
                      <div className="flex flex-col min-w-0">
                        <span
                          className={`text-xs truncate ${
                            isSelected
                              ? "text-ink-hi font-semibold"
                              : "text-ink font-medium"
                          }`}
                        >
                          {proj.name}
                        </span>
                        <span className="text-[10px] text-ink-faint font-mono truncate">
                          {proj.path}
                        </span>
                      </div>
                    </div>

                    {isSelected && (
                      <Check className="w-4 h-4 text-accent-ink shrink-0" />
                    )}
                  </button>
                );
              })
            )}
          </div>

          <form
            onSubmit={handleCustomPathSubmit}
            className="p-3 border-t border-line-faint space-y-2"
          >
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-low">
              Or type a path
            </span>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={customPathInput}
                onChange={(e) => setCustomPathInput(e.target.value)}
                placeholder="/absolute/path/to/folder"
                className="flex-1 bg-surface-sunken border border-line-faint rounded-xl px-2.5 py-1.5 text-xs text-ink-hi font-mono focus:outline-none focus:border-line-strong"
              />
              <button
                type="submit"
                disabled={loading || !customPathInput.trim()}
                className="px-3 py-1.5 bg-surface-hover hover:bg-surface-active text-ink-hi border border-line rounded-xl text-xs font-semibold cursor-pointer disabled:opacity-40 transition-colors shrink-0"
              >
                Set
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
