"use client";

/**
 * src/components/ConnectEditorPanel.tsx
 * ---------------------------------------------------------------------------
 * The screen where a user connects their own VS Code to their account, and
 * watches what the assistant does with it.
 *
 * WHY A WHOLE PANEL AND NOT A SETTINGS FIELD
 *
 * Everything behind this file — per-user sockets, hashed pairing tokens, an
 * authenticated upgrade, per-folder consent in the editor — was invisible from
 * the app. A user signed in, asked the assistant to read a file, and got "no
 * editor is connected", with nothing on screen explaining what an editor
 * connection is or how to make one. Backend work nobody can see is backend work
 * nobody can use.
 *
 * So this panel owns the whole story in the order a person actually meets it:
 *
 *   1. What is the state right now, in one sentence at the top.
 *   2. Install the extension  (a real download, versioned and hashed)
 *   3. Create a pairing code  (shown once, copied in one click)
 *   4. Approve a folder       (happens in VS Code, explained here)
 *   then: live activity, the list of codes, and how to revoke them.
 *
 * WHY IT POLLS INSTEAD OF SUBSCRIBING
 *
 * The obvious design is a second WebSocket from the browser. It would be a
 * second authenticated socket, a second reconnect loop, and a second thing to
 * get wrong on the day the proxy configuration changes — to animate a dot.
 * A five-second poll of one small JSON endpoint costs almost nothing, degrades
 * to "slightly stale" instead of "silently dead", and needs no proxy support at
 * all. It quickens to 1.5 s in the moments the user is actually waiting for
 * something to change, which is the only time the difference is perceptible.
 *
 * THE POLLER IS MODULE-SCOPED ON PURPOSE. The header pill and the open panel
 * both need this state; two components each with their own interval would
 * double the traffic and disagree with each other for up to five seconds at a
 * time. One store, one timer, many subscribers — and the timer stops itself
 * when the last subscriber unmounts or the tab goes to the background.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Info,
  KeyRound,
  Loader2,
  Lock,
  Monitor,
  Pencil,
  Plug,
  PlugZap,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
  Trash2,
  Unplug,
  X,
  Zap,
} from "lucide-react";

/* =========================================================================
 * Shapes returned by the API. Kept narrow on purpose: a field that is not
 * rendered is a field that can change server-side without breaking this file.
 * ====================================================================== */

export interface BridgeActivityEntry {
  seq: number;
  at: number;
  method: string;
  target: string | null;
  state: "pending" | "ok" | "error" | "timeout";
  ms: number | null;
  detail: string | null;
}

export interface EditorLinkStatus {
  connected: boolean;
  since: number | null;
  tokenId: string | null;
  root: string | null;
  activity: BridgeActivityEntry[];
  bridgeReady: boolean;
  /* Optional because a browser tab left open across a deploy will still be
   * polling with the previous payload shape, and a missing field must not be
   * read as "not listening" — that would invent an outage on every deploy.
   * Every branch below therefore tests `=== false`, never falsiness. */
  bridgeListening?: boolean;
  wsUrl: string;
  multiTenant: boolean;
  fileToolsEnabled: boolean;
  now: number;
}

interface PairingCodeSummary {
  id: string;
  preview: string;
  label: string | null;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  expired: boolean;
}

interface ExtensionDownload {
  file: string;
  url: string;
  version: string;
  size: number;
  sha256: string;
  builtAt: string;
}

/* =========================================================================
 * The shared status store
 * ====================================================================== */

interface LinkSnapshot {
  status: EditorLinkStatus | null;
  /** Null when healthy. "auth" means signed out; anything else is a message. */
  error: string | null;
  loading: boolean;
}

const IDLE_POLL_MS = 5_000;
const EAGER_POLL_MS = 1_500;
/**
 * Used when the answer cannot change until the user does something the poll
 * cannot observe — signing in, or an operator restarting the server with the
 * bridge enabled. The header pill mounts for *every* visitor including signed
 * out ones, so without this the landing page would issue a request every five
 * seconds, forever, to be told 401 every time.
 */
const DORMANT_POLL_MS = 60_000;

const EMPTY_SNAPSHOT: LinkSnapshot = { status: null, error: null, loading: true };

let snapshot: LinkSnapshot = EMPTY_SNAPSHOT;
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let eagerUntil = 0;

function publish(next: LinkSnapshot): void {
  snapshot = next;
  subscribers.forEach((notify) => notify());
}

function nextDelay(): number {
  /* A backgrounded tab still re-arms the timer, just slowly: the visibility
   * listener is what actually resumes it, and this is the safety net for the
   * case where that event never arrives. */
  if (typeof document !== "undefined" && document.hidden) return DORMANT_POLL_MS;
  if (Date.now() < eagerUntil) return EAGER_POLL_MS;
  if (snapshot.error === "auth") return DORMANT_POLL_MS;
  if (snapshot.status && !snapshot.status.bridgeReady) return DORMANT_POLL_MS;
  /* Same reasoning as the line above: a port that failed to bind will not bind
   * because we asked again in two seconds. Both need a restart to change. */
  if (snapshot.status && snapshot.status.bridgeListening === false) return DORMANT_POLL_MS;
  return IDLE_POLL_MS;
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (subscribers.size === 0) return;
  timer = setTimeout(() => void poll(), nextDelay());
}

async function poll(): Promise<void> {
  /* A tab left open in the background for a week should not keep asking. The
   * visibility listener polls immediately on return, so nothing is stale by the
   * time anyone looks at it. */
  if (typeof document !== "undefined" && document.hidden) {
    schedule();
    return;
  }
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await fetch("/api/extension/status", { cache: "no-store" });
    if (res.status === 401 || res.status === 403) {
      publish({ status: null, error: "auth", loading: false });
    } else if (!res.ok) {
      publish({
        status: snapshot.status,
        error: `The server answered ${res.status}.`,
        loading: false,
      });
    } else {
      publish({ status: (await res.json()) as EditorLinkStatus, error: null, loading: false });
    }
  } catch {
    /* Keep the last known status rather than blanking the panel: a dropped
     * request usually means the user's own wifi, and showing "disconnected"
     * would blame the wrong machine. */
    publish({
      status: snapshot.status,
      error: "Could not reach OmniRoute. Retrying…",
      loading: false,
    });
  } finally {
    inFlight = false;
    schedule();
  }
}

function handleVisibility(): void {
  if (typeof document !== "undefined" && !document.hidden) void poll();
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  if (subscribers.size === 1) {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }
    void poll();
  }
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0) {
      if (timer) clearTimeout(timer);
      timer = null;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    }
  };
}

function getSnapshot(): LinkSnapshot {
  return snapshot;
}

/** Server render has no status and must not start a timer. */
function getServerSnapshot(): LinkSnapshot {
  return EMPTY_SNAPSHOT;
}

/** Poll quickly for a while — used when the user is waiting for something. */
function beEager(ms = 60_000): void {
  eagerUntil = Math.max(eagerUntil, Date.now() + ms);
  schedule();
}

/** Ask now, without waiting for the next tick. */
function refreshNow(): void {
  void poll();
}

/**
 * Subscribe to the shared editor-connection status.
 *
 * Exported so other parts of the app (a chat composer hint, an error card) can
 * show the same state without inventing a second source of truth.
 */
export function useEditorLink(): LinkSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/* =========================================================================
 * Small helpers
 * ====================================================================== */

function relativeTime(ts: number | null, now: number): string {
  if (!ts) return "never";
  const diff = Math.max(0, now - ts);
  const s = Math.round(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function durationSince(ts: number | null, now: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(ts).toISOString();
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Last two path segments — enough to recognise a folder, short enough to fit. */
function shortPath(value: string | null): string {
  if (!value) return "";
  const parts = value.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return value;
  return `…${value.includes("\\") ? "\\" : "/"}${parts.slice(-2).join(value.includes("\\") ? "\\" : "/")}`;
}

/**
 * Copy, with a fallback.
 *
 * `navigator.clipboard` is unavailable on any page not served over HTTPS or
 * localhost — which includes the perfectly ordinary case of a beta tester
 * reaching the server by IP before TLS is set up. Losing the copy button
 * exactly when the pairing code is on screen, and can never be shown again,
 * would be a bad way to find that out.
 */
async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to the textarea path */
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

const METHOD_ICONS: Record<string, typeof FileText> = {
  read_file: FileText,
  write_file: Pencil,
  replace_text: Pencil,
  list_files: FolderOpen,
  search_files: Search,
  run_command: Terminal,
};

function iconForMethod(method: string): typeof FileText {
  for (const [key, icon] of Object.entries(METHOD_ICONS)) {
    if (method.includes(key)) return icon;
  }
  if (method.includes("workspace") || method.includes("folder")) return FolderOpen;
  if (method.includes("search") || method.includes("grep")) return Search;
  if (method.includes("write") || method.includes("edit") || method.includes("replace")) return Pencil;
  if (method.includes("read") || method.includes("file")) return FileText;
  return Zap;
}

/** "read_file" -> "Read file". Method names are a wire detail, not a label. */
function humaniseMethod(method: string): string {
  const words = method.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* =========================================================================
 * Shared bits of chrome
 * ====================================================================== */

function CopyButton({
  value,
  label = "Copy",
  className = "",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await copyText(value);
        setCopied(ok);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 2200);
      }}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all active:scale-95 ${
        copied
          ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/40"
          : "bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700/60"
      } ${className}`}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

/* =========================================================================
 * The one-click handoff
 * ====================================================================== */

/**
 * The id VS Code routes `vscode://` links by.
 *
 * It is `<publisher>.<name>` from vscode-extension/package.json — exactly, and
 * nothing else. If the two ever disagree, clicking the button opens VS Code and
 * then silently does nothing at all: no error, no toast, no log. That is the
 * most expensive kind of broken, because it looks like it worked and the user
 * spends the next ten minutes wondering what they did wrong. Changing either
 * half of the extension identity means changing this line too.
 */
const VSCODE_EXTENSION_ID = "omniroute.omniroute-vscode";

function pairingDeepLink(code: string, insiders: boolean): string {
  /* encodeURIComponent is belt-and-braces here: a pairing code is `omr_link_`
   * followed by base64url, which is already URL-safe. It costs nothing and
   * means a future change to the code format cannot quietly corrupt the link. */
  return `${insiders ? "vscode-insiders" : "vscode"}://${VSCODE_EXTENSION_ID}/pair?code=${encodeURIComponent(code)}`;
}

/**
 * Hand the pairing code to the editor without anyone copying anything.
 *
 * The copy-paste flow has three places to go wrong that are invisible from
 * here: a partial selection, a trailing newline picked up from the code block,
 * and pasting into the wrong VS Code window. A `vscode://` link removes all
 * three — the browser hands the string to the editor intact and the editor
 * knows which window asked.
 *
 * Copy-paste stays visible next to it rather than being hidden behind a
 * "having trouble?" link, because the deep link genuinely cannot work in some
 * ordinary situations: VS Code installed via Flatpak or Snap without the
 * protocol handler registered, a browser sandbox that blocks custom schemes, a
 * remote-desktop session where the browser and the editor are on different
 * machines. In all of those the failure is silent, so the alternative has to be
 * already on screen rather than one discovery away.
 */
function OpenInVsCode({ code }: { code: string }) {
  const [launched, setLaunched] = useState(false);

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={pairingDeepLink(code, false)}
          onClick={() => setLaunched(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 text-sky-100 border border-sky-400/50 text-xs font-semibold transition-all active:scale-95 no-underline"
        >
          <ExternalLink className="w-4 h-4" />
          Open in VS Code
        </a>
        <CopyButton value={code} label="Copy instead" />
      </div>

      {launched ? (
        <p className="text-[10px] text-zinc-400 leading-relaxed">
          Your browser will ask permission to open VS Code, and VS Code will then ask you to
          confirm the connection — say yes to both. If nothing happened, VS Code is probably not
          registered to handle these links on this machine; use{" "}
          <span className="font-semibold text-zinc-300">Copy instead</span> and follow step 3.
        </p>
      ) : (
        <p className="text-[10px] text-zinc-500 leading-relaxed">
          Opens your editor and pairs it in one step. Nothing is read from your computer until you
          approve a folder there.
        </p>
      )}

      <a
        href={pairingDeepLink(code, true)}
        onClick={() => setLaunched(true)}
        className="inline-block text-[10px] text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors"
      >
        Use VS Code Insiders instead
      </a>
    </div>
  );
}

function Step({
  index,
  title,
  subtitle,
  done,
  open,
  onToggle,
  children,
}: {
  index: number;
  title: string;
  subtitle: string;
  done: boolean;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-2xl border transition-colors ${
        done
          ? "border-emerald-500/25 bg-emerald-500/[0.04]"
          : "border-zinc-700/50 bg-zinc-800/30"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-4 text-left"
      >
        <span
          className={`flex items-center justify-center w-7 h-7 rounded-lg text-[11px] font-bold shrink-0 border ${
            done
              ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
              : "bg-zinc-800 text-zinc-300 border-zinc-700"
          }`}
        >
          {done ? <Check className="w-3.5 h-3.5" /> : index}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-zinc-100">{title}</span>
          <span className="block text-[11px] text-zinc-400 mt-0.5">{subtitle}</span>
        </span>
        {open ? (
          <ChevronDown className="w-4 h-4 text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />
        )}
      </button>
      {open && <div className="px-4 pb-4 pt-0 space-y-3">{children}</div>}
    </div>
  );
}

/* =========================================================================
 * The header pill
 * ====================================================================== */

/**
 * The always-visible indicator.
 *
 * It exists so that "can this thing touch my files right now?" is answerable at
 * a glance, from anywhere in the app, without opening anything — the same role
 * the status bar item plays inside VS Code, and deliberately the same wording,
 * so the two halves of the feature describe themselves the same way.
 */
export function EditorLinkPill({ onClick }: { onClick: () => void }) {
  const { status, loading } = useEditorLink();
  const [tick, setTick] = useState(() => Date.now());

  /* A local clock so "3m" becomes "4m" without waiting for a poll. */
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const busy = !!status?.activity?.some((a) => a.state === "pending");

  let tone = "border-zinc-700/60 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700/60";
  let Icon: typeof Plug = Plug;
  let text = "Connect VS Code";
  let dot = "bg-zinc-500";

  if (loading && !status) {
    text = "Checking…";
  } else if (status && !status.bridgeReady) {
    tone = "border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/15";
    Icon = Unplug;
    text = "Editor link off";
    dot = "bg-rose-400";
  } else if (status && status.bridgeListening === false) {
    /* Enabled, but the port did not bind. Worth its own label: the pill above
     * sends you to an env file, and this one sends you to look for the process
     * that already owns the port. Same colour, different instruction. */
    tone = "border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/15";
    Icon = Unplug;
    text = "Editor port blocked";
    dot = "bg-rose-400";
  } else if (status?.connected && status.root) {
    tone = "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15";
    Icon = PlugZap;
    text = shortPath(status.root);
    dot = "bg-emerald-400";
  } else if (status?.connected) {
    tone = "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15";
    Icon = PlugZap;
    text = "Approve a folder";
    dot = "bg-amber-400";
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={
        status?.connected
          ? `VS Code connected${status.root ? ` — ${status.root}` : " — no folder approved yet"}${
              status.since ? ` · ${durationSince(status.since, Math.max(tick, status.now))}` : ""
            }`
          : "Connect your VS Code so OmniRoute can read and write files on your computer"
      }
      className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-[11px] font-semibold transition-all max-w-[220px] ${tone}`}
    >
      <span className="relative flex items-center justify-center w-2 h-2 shrink-0">
        {/* A second ring, only while a call is actually in flight. Tailwind's
         * `animate-ping` expands and fades, so it has to sit behind a solid dot
         * rather than replace it — otherwise the indicator disappears for half
         * of every cycle, which reads as "flickering offline". */}
        {busy && (
          <span className="absolute inline-flex w-2 h-2 rounded-full bg-emerald-400 opacity-75 animate-ping" />
        )}
        <span className={`relative inline-flex w-2 h-2 rounded-full ${dot}`} />
      </span>
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">{text}</span>
    </button>
  );
}

/* =========================================================================
 * The panel
 * ====================================================================== */

export default function ConnectEditorPanel({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { status, error, loading } = useEditorLink();

  const [codes, setCodes] = useState<PairingCodeSummary[]>([]);
  const [codesLoading, setCodesLoading] = useState(false);
  const [download, setDownload] = useState<ExtensionDownload | null>(null);
  const [downloadChecked, setDownloadChecked] = useState(false);

  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [freshCode, setFreshCode] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [revoking, setRevoking] = useState<string | null>(null);

  const [openStep, setOpenStep] = useState<number | null>(1);
  const [tick, setTick] = useState(() => Date.now());

  /* The panel renders durations every second while it is open; the status
   * itself still arrives on the poll interval. Separating the two means the
   * clock looks alive without the network being busy. */
  useEffect(() => {
    if (!isOpen) return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isOpen]);

  const loadCodes = useCallback(async () => {
    setCodesLoading(true);
    try {
      const res = await fetch("/api/extension/token", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setCodes(Array.isArray(data.tokens) ? data.tokens : []);
      }
    } catch {
      /* The status strip already reports connectivity trouble; a second red
       * banner for the same cause is noise. */
    } finally {
      setCodesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void loadCodes();
    refreshNow();

    if (!downloadChecked) {
      setDownloadChecked(true);
      fetch("/downloads/extension.json", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data && typeof data.url === "string") setDownload(data as ExtensionDownload);
        })
        .catch(() => {
          /* No manifest means the operator has not run `npm run extension:sync`.
           * Step 1 falls back to "ask for the file", which is honest and still
           * actionable, rather than offering a link that 404s. */
        });
    }
  }, [isOpen, loadCodes, downloadChecked]);

  /* While the panel is open and nothing is connected, the user is by definition
   * waiting for a connection, so poll at the faster rate. */
  useEffect(() => {
    if (isOpen && !status?.connected) beEager(120_000);
  }, [isOpen, status?.connected]);

  /* Once the editor connects, the setup steps have served their purpose. */
  useEffect(() => {
    if (status?.connected && status.root) setOpenStep(null);
  }, [status?.connected, status?.root]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const mint = async () => {
    setMinting(true);
    setMintError(null);
    try {
      const res = await fetch("/api/extension/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMintError(data.error || `Could not create a pairing code (HTTP ${res.status}).`);
        return;
      }
      setFreshCode(data.pairingCode || null);
      setLabel("");
      setOpenStep(3);
      await loadCodes();
      /* The interesting moment starts now: the user is about to paste this into
       * VS Code, and the panel should show the connection the second it lands. */
      beEager(120_000);
      refreshNow();
    } catch {
      setMintError("Could not reach OmniRoute. Check your connection and try again.");
    } finally {
      setMinting(false);
    }
  };

  const revoke = async (id: string | "all") => {
    const isAll = id === "all";
    const confirmed = window.confirm(
      isAll
        ? "Revoke every pairing code?\n\nAny VS Code window using one will be disconnected immediately and will need a new code."
        : "Revoke this pairing code?\n\nIf a VS Code window is connected with it, it will be disconnected immediately.",
    );
    if (!confirmed) return;

    setRevoking(id);
    try {
      const res = await fetch(
        isAll ? "/api/extension/token?all=1" : `/api/extension/token?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (res.ok) {
        await loadCodes();
        refreshNow();
      }
    } catch {
      /* Swallowed: the list reloads either way, so a failure shows up as the
       * code still being present rather than as a modal the user must dismiss. */
    } finally {
      setRevoking(null);
    }
  };

  const activity = useMemo(
    () => (status?.activity ? [...status.activity].reverse() : []),
    [status?.activity],
  );

  const liveTokenId = status?.connected ? status.tokenId : null;
  const hasCodes = codes.some((c) => !c.expired);
  const now = Math.max(tick, status?.now ?? 0);

  if (!isOpen) return null;

  /* ---------------------------------------------------------------- hero */

  let heroTone = "from-zinc-800/60 to-zinc-800/20 border-zinc-700/50";
  let heroIcon = <Plug className="w-6 h-6 text-zinc-300" />;
  let heroTitle = "No editor connected";
  let heroBody =
    "OmniRoute cannot see any files on your computer yet. Follow the three steps below — it takes about a minute.";

  if (status && !status.bridgeReady) {
    heroTone = "from-rose-500/15 to-rose-500/5 border-rose-500/30";
    heroIcon = <Unplug className="w-6 h-6 text-rose-300" />;
    heroTitle = "Editor connections are switched off";
    heroBody =
      "This deployment was started without OMNIROUTE_BRIDGE_ENABLE=true, so no extension can connect to it. Pairing codes created now will not work until the operator turns it on. If VS Code is already retrying, it will report that the server closed the connection — under Docker the published port is accepted by the forwarder and then reset, so the refusal arrives as a dropped link rather than a refused one.";
  } else if (status && status.bridgeListening === false) {
    heroTone = "from-rose-500/15 to-rose-500/5 border-rose-500/30";
    heroIcon = <Unplug className="w-6 h-6 text-rose-300" />;
    heroTitle = "Editor connections are on, but the port did not open";
    heroBody =
      "The bridge is enabled, yet nothing is bound to its port — almost always because another process already holds it, such as a second server still running from an earlier start. Stop the other process and restart this one, or set OMNIROUTE_BRIDGE_PORT to a free port and re-pair. The server log line beginning [VSCodeBridge] names the port.";
  } else if (status?.connected && status.root) {
    heroTone = "from-emerald-500/15 to-emerald-500/5 border-emerald-500/30";
    heroIcon = <PlugZap className="w-6 h-6 text-emerald-300" />;
    heroTitle = "Connected to your VS Code";
    heroBody = "File operations run in your editor, on your machine, inside the folder you approved.";
  } else if (status?.connected) {
    heroTone = "from-amber-500/15 to-amber-500/5 border-amber-500/30";
    heroIcon = <ShieldCheck className="w-6 h-6 text-amber-300" />;
    heroTitle = "Connected — waiting for you to approve a folder";
    heroBody =
      "Your editor is linked to this account, but it has not been given access to any folder yet. Switch to VS Code and click Allow on the OmniRoute prompt.";
  } else if (error === "auth") {
    heroTone = "from-amber-500/15 to-amber-500/5 border-amber-500/30";
    heroIcon = <KeyRound className="w-6 h-6 text-amber-300" />;
    heroTitle = "Sign in to connect an editor";
    heroBody = "Pairing codes belong to an account, so you need to be signed in to create one.";
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 transition-opacity"
        onClick={onClose}
      />

      <div className="fixed right-0 top-0 h-full w-full max-w-[720px] bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-950 border-l border-zinc-700/50 shadow-2xl z-50 flex flex-col animate-slide-in">
        {/* ------------------------------------------------------- header */}
        <div className="flex items-center justify-between p-6 border-b border-zinc-800/80 bg-zinc-800/30 backdrop-blur-sm">
          <div className="flex items-center gap-4 min-w-0">
            <div className="p-3 rounded-xl bg-gradient-to-br from-sky-500/20 to-sky-600/10 border-2 border-sky-500/30 shadow-lg shadow-sky-500/10">
              <Monitor className="w-6 h-6 text-sky-400" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-zinc-100 tracking-tight">Connect VS Code</h2>
              <p className="text-xs text-zinc-400 mt-1 font-medium truncate">
                {status?.connected ? (
                  <>
                    <span className="text-emerald-400">●</span>{" "}
                    {status.root ? status.root : "connected — no folder approved yet"}
                  </>
                ) : (
                  "Let OmniRoute read and write files on your own computer"
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                refreshNow();
                void loadCodes();
              }}
              className="p-2.5 rounded-xl hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-all active:scale-95"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              onClick={onClose}
              className="p-2.5 rounded-xl hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-all hover:scale-105 active:scale-95"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* ------------------------------------------------------ content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 [scrollbar-width:thin]">
          {/* hero */}
          <div className={`rounded-2xl border bg-gradient-to-br p-5 ${heroTone}`}>
            <div className="flex items-start gap-4">
              <div className="p-2.5 rounded-xl bg-zinc-900/40 border border-white/5 shrink-0">
                {heroIcon}
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-bold text-zinc-100">{heroTitle}</h3>
                <p className="text-xs text-zinc-300/80 mt-1.5 leading-relaxed">{heroBody}</p>

                {status?.connected && (
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <div className="rounded-xl bg-zinc-900/50 border border-zinc-700/40 px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                        Connected for
                      </div>
                      <div className="text-sm font-mono text-zinc-200 mt-0.5">
                        {durationSince(status.since, now) || "—"}
                      </div>
                    </div>
                    <div className="rounded-xl bg-zinc-900/50 border border-zinc-700/40 px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                        Approved folder
                      </div>
                      <div
                        className="text-sm font-mono text-zinc-200 mt-0.5 truncate"
                        title={status.root || ""}
                      >
                        {status.root ? shortPath(status.root) : "none yet"}
                      </div>
                    </div>
                  </div>
                )}

                {status && status.bridgeReady && !status.fileToolsEnabled && (
                  <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-500/10 border border-amber-500/30 px-3 py-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-[11px] text-amber-200/90 leading-relaxed">
                      File tools are switched off for this deployment, so the connection will be
                      idle until <span className="font-mono">OMNIROUTE_ENABLE_FILE_TOOLS</span> is
                      enabled.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {error && error !== "auth" && (
            <div className="flex items-center gap-2 rounded-xl bg-zinc-800/50 border border-zinc-700/50 px-3 py-2">
              <Loader2 className="w-3.5 h-3.5 text-zinc-400 animate-spin shrink-0" />
              <span className="text-[11px] text-zinc-400">{error}</span>
            </div>
          )}

          {/* ------------------------------------------------------ steps */}
          <div className="space-y-2.5">
            <Step
              index={1}
              title="Install the OmniRoute extension in VS Code"
              subtitle="A 58 KB extension. Nothing else to install."
              done={!!status?.connected}
              open={openStep === 1}
              onToggle={() => setOpenStep(openStep === 1 ? null : 1)}
            >
              {download ? (
                <>
                  <a
                    href={download.url}
                    download
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 border border-sky-500/40 text-xs font-semibold transition-all active:scale-95"
                  >
                    <Download className="w-4 h-4" />
                    Download {download.file}
                  </a>
                  <p className="text-[11px] text-zinc-500">
                    Version {download.version} · {formatBytes(download.size)} · built{" "}
                    {formatDate(Date.parse(download.builtAt))}
                  </p>
                </>
              ) : (
                <div className="flex items-start gap-2 rounded-xl bg-zinc-800/40 border border-zinc-700/50 px-3 py-2.5">
                  <Info className="w-3.5 h-3.5 text-zinc-400 mt-0.5 shrink-0" />
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    No extension file is published on this server yet. Ask for the{" "}
                    <span className="font-mono text-zinc-300">.vsix</span> file directly — it is
                    the same file either way.
                  </p>
                </div>
              )}

              <ol className="text-[11px] text-zinc-400 space-y-1.5 leading-relaxed list-decimal pl-4 marker:text-zinc-600">
                <li>Open VS Code.</li>
                <li>
                  Open the Command Palette — <span className="font-mono text-zinc-300">Ctrl+Shift+P</span>{" "}
                  (<span className="font-mono text-zinc-300">Cmd+Shift+P</span> on a Mac).
                </li>
                <li>
                  Run <span className="font-mono text-zinc-300">Extensions: Install from VSIX…</span>{" "}
                  and choose the file you downloaded.
                </li>
                <li>Reload VS Code when it offers to.</li>
              </ol>

              {download && (
                <details className="group">
                  <summary className="text-[11px] text-zinc-500 cursor-pointer hover:text-zinc-400 select-none">
                    Verify the file you received
                  </summary>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="flex-1 text-[10px] font-mono text-zinc-400 bg-zinc-900/60 border border-zinc-800 rounded-lg px-2.5 py-2 break-all">
                      {download.sha256}
                    </code>
                    <CopyButton value={download.sha256} label="SHA-256" />
                  </div>
                  <p className="text-[10px] text-zinc-600 mt-1.5 leading-relaxed">
                    If someone sent you this extension over chat or email, compare this checksum with{" "}
                    <span className="font-mono">Get-FileHash</span> (Windows) or{" "}
                    <span className="font-mono">shasum -a 256</span> (Mac/Linux).
                  </p>
                </details>
              )}
            </Step>

            <Step
              index={2}
              title="Create a pairing code"
              subtitle="Links that VS Code window to this account. Shown once."
              done={hasCodes}
              open={openStep === 2}
              onToggle={() => setOpenStep(openStep === 2 ? null : 2)}
            >
              {freshCode ? (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/[0.07] p-3.5 space-y-3">
                  <div className="flex items-center gap-2">
                    <Lock className="w-3.5 h-3.5 text-amber-400" />
                    <span className="text-[11px] font-bold text-amber-200 uppercase tracking-wider">
                      Shown once — send it to your editor now
                    </span>
                  </div>

                  <OpenInVsCode code={freshCode} />

                  <details className="group">
                    <summary className="text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer select-none transition-colors">
                      Show the code itself
                    </summary>
                    <code className="mt-2 block text-[10px] font-mono text-zinc-200 bg-zinc-950/70 border border-zinc-800 rounded-lg px-3 py-2.5 break-all leading-relaxed max-h-28 overflow-y-auto">
                      {freshCode}
                    </code>
                  </details>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setFreshCode(null)}
                      className="px-3 py-1.5 rounded-lg text-[11px] font-semibold text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-all"
                    >
                      Done — hide this code
                    </button>
                  </div>
                  <p className="text-[10px] text-amber-200/70 leading-relaxed">
                    Treat it like a password. Anyone holding it can connect an editor to your
                    account — though they would still have to approve a folder on their own
                    machine, and you can revoke it below at any time.
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder="Name this device (optional) — e.g. work laptop"
                      maxLength={60}
                      className="flex-1 bg-zinc-900/60 border border-zinc-700/60 rounded-xl px-3 py-2.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-sky-500/50 transition-colors"
                    />
                    <button
                      type="button"
                      onClick={mint}
                      disabled={minting}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-sky-500/15 hover:bg-sky-500/25 disabled:opacity-50 text-sky-200 border border-sky-500/40 text-xs font-semibold transition-all active:scale-95 shrink-0"
                    >
                      {minting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <KeyRound className="w-4 h-4" />
                      )}
                      Create code
                    </button>
                  </div>
                  {mintError && (
                    <p className="text-[11px] text-rose-300 flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      {mintError}
                    </p>
                  )}
                  <p className="text-[11px] text-zinc-500 leading-relaxed">
                    The code carries the address of this server as well as the secret, so there is
                    only one thing to paste. It expires after 30 days.
                  </p>
                </>
              )}
            </Step>

            <Step
              index={3}
              title="Approve a folder in VS Code"
              subtitle="One click in the editor. Nothing is read until you approve."
              done={!!status?.connected && !!status.root}
              open={openStep === 3}
              onToggle={() => setOpenStep(openStep === 3 ? null : 3)}
            >
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                After the editor accepts the pairing it asks whether OmniRoute may read and write
                files in the folder you have open. Click{" "}
                <span className="font-semibold text-zinc-300">Allow</span> and you are done — this
                panel will switch to connected on its own.
              </p>
              <div className="flex items-start gap-2 rounded-xl bg-zinc-800/40 border border-zinc-700/50 px-3 py-2.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  Approval is per folder and stays on that computer. A folder you never approve is
                  never read, and the OmniRoute item in the VS Code status bar shows which folder
                  is currently approved — and lets you withdraw it.
                </p>
              </div>

              {/* The manual route. Folded away because most people will never
                * need it, but present rather than linked, because the person
                * who needs it is by definition the person for whom the button
                * did nothing and who has no reason to trust a second button. */}
              <details className="group">
                <summary className="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer select-none transition-colors">
                  If &ldquo;Open in VS Code&rdquo; did nothing
                </summary>
                <ol className="mt-2 text-[11px] text-zinc-400 space-y-1.5 leading-relaxed list-decimal pl-4 marker:text-zinc-600">
                  <li>
                    Copy the pairing code from step 2 (use{" "}
                    <span className="font-semibold text-zinc-300">Copy instead</span>).
                  </li>
                  <li>
                    In VS Code press{" "}
                    <span className="font-mono text-zinc-300">Ctrl+Shift+P</span> (
                    <span className="font-mono text-zinc-300">Cmd+Shift+P</span> on a Mac) and run{" "}
                    <span className="font-mono text-zinc-300">
                      OmniRoute: Connect (paste pairing code)
                    </span>
                    .
                  </li>
                  <li>Paste the code when it asks, then approve the folder.</li>
                </ol>
                <p className="mt-2 text-[10px] text-zinc-500 leading-relaxed">
                  If that command is not in the list, the installed extension is older than this
                  page. Uninstall{" "}
                  <span className="font-mono text-zinc-400">OmniRoute AI Bridge</span> in the
                  Extensions view, then install the download from step 1 again.
                </p>
              </details>

              {status && (
                <p className="text-[10px] text-zinc-600 font-mono break-all">
                  This server: {status.wsUrl}
                </p>
              )}
            </Step>
          </div>

          {/* --------------------------------------------------- activity */}
          <div className="rounded-2xl border border-zinc-700/50 bg-zinc-800/20 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/80">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-sky-400" />
                <h3 className="text-sm font-semibold text-zinc-100">Live file activity</h3>
              </div>
              <span className="text-[10px] text-zinc-500 font-medium">
                {activity.length > 0 ? `last ${activity.length}` : "this session"}
              </span>
            </div>

            {activity.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-[11px] text-zinc-500 leading-relaxed max-w-sm mx-auto">
                  {status?.connected
                    ? "Nothing yet. Every file the assistant opens, reads or changes will appear here as it happens."
                    : "Once an editor is connected, every file operation shows up here in real time — what it touched, whether it worked, and how long it took."}
                </p>
              </div>
            ) : (
              <div className="max-h-72 overflow-y-auto [scrollbar-width:thin] divide-y divide-zinc-800/60">
                {activity.map((entry) => {
                  const Icon = iconForMethod(entry.method);
                  const tone =
                    entry.state === "ok"
                      ? "text-emerald-400"
                      : entry.state === "pending"
                        ? "text-sky-400"
                        : "text-rose-400";
                  return (
                    <div key={entry.seq} className="flex items-start gap-3 px-4 py-2.5">
                      <div className={`mt-0.5 shrink-0 ${tone}`}>
                        {entry.state === "pending" ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Icon className="w-3.5 h-3.5" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-semibold text-zinc-200">
                            {humaniseMethod(entry.method)}
                          </span>
                          {entry.state !== "ok" && entry.state !== "pending" && (
                            <span className="text-[9px] uppercase tracking-wider font-bold text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded px-1.5 py-0.5">
                              {entry.state}
                            </span>
                          )}
                        </div>
                        {entry.target && (
                          <div
                            className="text-[10px] font-mono text-zinc-500 truncate mt-0.5"
                            title={entry.target}
                          >
                            {entry.target}
                          </div>
                        )}
                        {entry.detail && (
                          <div className="text-[10px] text-rose-300/70 mt-0.5 leading-relaxed">
                            {entry.detail}
                          </div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-[10px] text-zinc-500">{relativeTime(entry.at, now)}</div>
                        {entry.ms !== null && (
                          <div className="text-[10px] font-mono text-zinc-600">{entry.ms}ms</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ------------------------------------------------------ codes */}
          <div className="rounded-2xl border border-zinc-700/50 bg-zinc-800/20 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/80">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-amber-400" />
                <h3 className="text-sm font-semibold text-zinc-100">Pairing codes</h3>
              </div>
              {codes.length > 0 && (
                <button
                  type="button"
                  onClick={() => revoke("all")}
                  disabled={revoking === "all"}
                  className="text-[10px] font-semibold text-rose-300/80 hover:text-rose-300 transition-colors disabled:opacity-50"
                >
                  Revoke all
                </button>
              )}
            </div>

            {codesLoading && codes.length === 0 ? (
              <div className="px-4 py-8 flex justify-center">
                <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
              </div>
            ) : codes.length === 0 ? (
              <p className="px-4 py-8 text-[11px] text-zinc-500 text-center">
                No pairing codes yet.
              </p>
            ) : (
              <div className="divide-y divide-zinc-800/60">
                {codes.map((code) => {
                  const isLive = code.id === liveTokenId;
                  return (
                    <div key={code.id} className="flex items-center gap-3 px-4 py-3">
                      <div
                        className={`p-2 rounded-lg border shrink-0 ${
                          isLive
                            ? "bg-emerald-500/10 border-emerald-500/30"
                            : code.expired
                              ? "bg-zinc-800/60 border-zinc-700/50"
                              : "bg-zinc-800/60 border-zinc-700/50"
                        }`}
                      >
                        <Monitor
                          className={`w-3.5 h-3.5 ${isLive ? "text-emerald-400" : "text-zinc-500"}`}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-zinc-200 truncate">
                            {code.label || "Unnamed device"}
                          </span>
                          {isLive && (
                            <span className="text-[9px] uppercase tracking-wider font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded px-1.5 py-0.5 shrink-0">
                              connected
                            </span>
                          )}
                          {code.expired && (
                            <span className="text-[9px] uppercase tracking-wider font-bold text-zinc-500 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 shrink-0">
                              expired
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2.5 mt-0.5 text-[10px] text-zinc-500">
                          <span className="font-mono">{code.preview}</span>
                          <span className="flex items-center gap-1">
                            <Clock className="w-2.5 h-2.5" />
                            used {relativeTime(code.lastUsedAt, now)}
                          </span>
                          <span>expires {formatDate(code.expiresAt)}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => revoke(code.id)}
                        disabled={revoking === code.id}
                        className="p-2 rounded-lg text-zinc-500 hover:text-rose-300 hover:bg-rose-500/10 transition-all disabled:opacity-50 shrink-0"
                        title="Revoke this code"
                      >
                        {revoking === code.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ----------------------------------------------------- safety */}
          <div className="rounded-2xl border border-zinc-700/50 bg-zinc-800/20 p-4 space-y-2.5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-zinc-100">What this can and cannot do</h3>
            </div>
            <ul className="space-y-2 text-[11px] text-zinc-400 leading-relaxed">
              <li className="flex gap-2">
                <Check className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
                <span>
                  Reads and writes files <span className="text-zinc-300">only inside folders you
                  approved</span>, and only while that VS Code window is open and connected.
                </span>
              </li>
              <li className="flex gap-2">
                <Check className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
                <span>
                  Skips secrets by default — <span className="font-mono">.env</span> files, private
                  keys, credential stores and{" "}
                  <span className="font-mono">node_modules</span> are refused by the extension
                  before anything leaves your machine.
                </span>
              </li>
              <li className="flex gap-2">
                <Check className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
                <span>
                  Backs up every file before it changes it, into{" "}
                  <span className="font-mono">.omniroute-backups</span> in your own folder.
                </span>
              </li>
              <li className="flex gap-2">
                <Info className="w-3.5 h-3.5 text-sky-400 mt-0.5 shrink-0" />
                <span>
                  File contents pass through this server on their way to the model. They are held
                  in memory for the length of the request and are not written to the server&apos;s
                  disk.
                </span>
              </li>
              <li className="flex gap-2">
                <Info className="w-3.5 h-3.5 text-sky-400 mt-0.5 shrink-0" />
                <span>
                  Closing VS Code, revoking the code above, or withdrawing folder access in the
                  editor each end it immediately.
                </span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}
