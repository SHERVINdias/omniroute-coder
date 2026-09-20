"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Cpu,
  RefreshCw,
  Plus,
  Paperclip,
  Copy,
  Check,
  X,
  Loader2,
  Coins,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Zap,
  Search,
  Sparkles,
  Layers,
  Folder,
  SlidersHorizontal,
  PanelLeft,
  MessageSquare,
  Sparkle,
  Terminal,
  Send,
  Trash2,
  Edit2,
  Code2,
  AlertCircle,
  FileText,
  FileType,
  Printer,
  FileIcon,
  ArrowRightLeft,
  ShieldAlert,
  ShieldCheck,
  FolderTree,
  Globe,
  Pin,
  Square,
  Users,
  Brain,
  FolderArchive,
  LogIn,
  LogOut,
  Info,
  MonitorSmartphone,
} from "lucide-react";
import { WorkspaceSelector } from "@/components/WorkspaceSelector";
import {
  PlanApprovalCard,
  type PlanPayload,
} from "@/components/PlanApprovalCard";
import BackupsPanel from "@/components/BackupsPanel";
import SettingsPanel, {
  loadSettings,
  loadRoleModels,
  type RoundSettings,
  type RoleModelSettings,
} from "@/components/SettingsPanel";
import GatewaySetupWizard from "@/components/GatewaySetupWizard";
import {
  probeLocalGateway,
  type LocalGatewayProbeResult,
} from "@/lib/localGatewayProbe";
import { parseSlashCommand, matchSlashCommands } from "@/lib/slashCommands";
import {
  greetingName,
  resolveDisplayName,
  resolveInitial,
} from "@/lib/displayName";
import SubscriptionPanel from "@/components/SubscriptionPanel";
import AdminPanel from "@/components/AdminPanel";
import AuthModal from "@/components/AuthModal";
import ProductionAgentMode from "@/components/ProductionAgentMode";
import UserGuide from "@/components/UserGuide";
import ConnectEditorPanel, { EditorLinkPill } from "@/components/ConnectEditorPanel";
import SkillsPanel, {
  SkillRunSummary,
  type SkillRunReport,
} from "@/components/SkillsPanel";
import FileAccessPanel from "@/components/FileAccessPanel";
import ProjectsPanel from "@/components/ProjectsPanel";

declare global {
  interface Window {
    pdfjsLib: any;
  }
}

/**
 * A file sent alongside a chat message, as a data: URL.
 *
 * This used to be imported as `Attachment` from the `ai` package. That export
 * was removed in AI SDK v7 (package.json pins ^7.0.93), so the import resolved
 * to nothing and `next build` failed type checking on the very first line of
 * this file. Nothing here ever used the SDK at runtime — it was a type-only
 * import — so the type is declared locally instead of pinning the SDK back.
 *
 * The shape is the one the code actually builds and reads: see where
 * `allAttachments` is assembled from `attachedImages`/`attachedDocs`, and where
 * message attachments are rendered further down. `url` is a data: URL rather
 * than a remote link, which is why nothing needs to fetch it.
 */
interface Attachment {
  name?: string;
  contentType?: string;
  url: string;
}

interface DocumentAttachment {
  id: string;
  name: string;
  dataUrl: string;
  type: string;
  size: number;
}

interface FileAttachment {
  id: string;
  name: string;
  content: string;
  type: string;
  size: number;
  lineCount: number;
}

interface ProviderCredits {
  provider: string;
  status: string;
}

interface ModelMeta {
  provider: string;
  badgeColor: string;
}

interface ChatItem {
  id: string;
  title: string;
  updated_at: string;
}

interface GeneratedPdfInfo {
  pdfUrl: string;
  fileName: string;
  title: string;
}

type ChatRole = "user" | "assistant";
/**
 * "ultra" is Deep Cowork with the extra phases switched on. The server maps it
 * back onto "deepcowork" (see resolveMode in api/chat/route.ts) so it inherits
 * every gate that mode already has, rather than being a fourth code path.
 */
type InteractionMode = "chat" | "cowork" | "deepcowork" | "ultra" | "production";

/** Modes that drive filesystem tools and therefore need a signed-in user. */
const WORKSPACE_MODES: InteractionMode[] = ["cowork", "deepcowork", "ultra"];

/** Modes that get the plan/approve gate and the deep pipeline. */
const DEEP_MODES: InteractionMode[] = ["deepcowork", "ultra"];

/**
 * Everything the UI needs to describe a mode, in one place.
 *
 * The composer used to carry five buttons whose labels, icons, tooltips and
 * disabled-state copy were each written out by hand at the call site — about a
 * hundred and twenty lines of near-identical JSX in which the only way to tell
 * two branches apart was to read them character by character. Adding a sixth
 * mode meant copying a block and hoping every string got changed. Describing
 * the modes as data means the menu is a `.map`, and a new mode is one row here.
 *
 * `needsFiles` is not decoration: those modes read and write on the machine
 * running the app, so they are unavailable wherever the file tools are off, and
 * the menu has to say so instead of silently failing on send.
 */
interface ModeMeta {
  id: InteractionMode;
  label: string;
  Icon: typeof MessageSquare;
  /** One line, shown under the label in the menu. */
  blurb: string;
  /** The composer's placeholder while this mode is selected. */
  placeholder: string;
  needsFiles: boolean;
}

const MODE_META: ModeMeta[] = [
  {
    id: "chat",
    label: "Chat",
    Icon: MessageSquare,
    blurb: "Ask questions and think out loud. Nothing on disk is touched.",
    placeholder: "Ask anything — or drop in a PDF, DOCX, or image",
    needsFiles: false,
  },
  {
    id: "cowork",
    label: "Cowork",
    Icon: Users,
    blurb: "Read and edit files in your workspace, a step at a time.",
    placeholder: "Describe a change and I'll work through the files with you",
    needsFiles: true,
  },
  {
    id: "deepcowork",
    label: "Deep Cowork",
    Icon: Brain,
    blurb: "Plan first, then work the task through over many rounds.",
    placeholder: "Give me a task — I'll plan it, then carry it out over several rounds",
    needsFiles: true,
  },
  {
    id: "ultra",
    label: "Ultra",
    Icon: Sparkles,
    blurb: "Deep Cowork, plus a reviewer that audits every changed file.",
    placeholder: "Give me a task — I'll plan, build, then audit every file I changed",
    needsFiles: true,
  },
  {
    id: "production",
    label: "Production",
    Icon: Zap,
    blurb: "Six phases, security audit, and an approval gate before release.",
    placeholder: "Describe what to build — six phases, with approval gates",
    needsFiles: true,
  },
];

/** Never null: an unrecognised id falls back to Chat rather than blanking the button. */
function modeMeta(id: InteractionMode): ModeMeta {
  return MODE_META.find((mode) => mode.id === id) ?? MODE_META[0];
}

interface CatalogEntry {
  id: string;
  provider: string;
  providerLabel: string;
  model: string;
  line: string;
  isCombo: boolean;
  label: string;
}

interface ModelDiagnostics {
  baseUrl: string;
  url: string;
  ok: boolean;
  status: number | null;
  error: string | null;
  shape: string;
  rawCount: number;
  bodySample: string;
  extraFromEnv: string[];
  apiKeyConfigured: boolean;
}

interface ModelCounts {
  total: number;
  concrete: number;
  combos: number;
  fromGateway: number;
}

interface RouteNotice {
  kind: string;
  text: string;
  from: string;
  to: string | null;
  step: number;
  failure: string;
  account?: string | null;
}

interface RouteInfo {
  requested: string;
  dispatched: string;
  served: string | null;
  account: string | null;
  viaCombo: boolean;
  attempts: number;
  substituted: boolean;
}

/** Live round budget from Deep Cowork. It grows when edits land, so the
 *  numbers move during a run — that is the point of showing them. */
interface BudgetInfo {
  used: number;
  limit: number;
  ceiling: number;
  extendedBy?: number;
  reason?: string;
}

/** Pointer at the task artifact under <workspace>/.omniroute/tasks/. */
interface TaskInfo {
  id: string;
  file: string;
  status: string;
  roundsUsed: number;
  resumed?: boolean;
}

/** One finding from the Ultra mode reviewer. */
interface ReviewFindingInfo {
  severity: "blocker" | "major" | "minor" | "note";
  path?: string;
  text: string;
}

/** The verdict from one review cycle. A turn can produce several. */
interface ReviewInfo {
  cycle: number;
  maxCycles: number;
  passed: boolean;
  summary: string;
  model?: string;
  findings: ReviewFindingInfo[];
}

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  experimental_attachments?: Attachment[];
  notices?: RouteNotice[];
  toolCalls?: string[];
  route?: RouteInfo;
  error?: string;
  /** Set when the planning pass stopped for approval. */
  plan?: PlanPayload;
  task?: TaskInfo;
  budget?: BudgetInfo;
  stage?: string;
  stageLabel?: string;
  /** Ultra mode audit verdicts, in cycle order. */
  reviews?: ReviewInfo[];
  /** Which of the user's skills applied to this turn, and which did not. */
  skills?: SkillRunReport;
}

async function ensurePdfJsLoaded(): Promise<void> {
  if (typeof window === "undefined") return;
  if (window.pdfjsLib) return;

  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => {
      if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      }
      resolve();
    };
    script.onerror = () => reject(new Error("Failed to load PDF.js script"));
    document.head.appendChild(script);
  });
}

async function extractPdfDataAndImages(
  arrayBuffer: ArrayBuffer,
  maxScale = 1.5,
): Promise<{
  text: string;
  pageImages: { pageNumber: number; dataUrl: string }[];
}> {
  try {
    await ensurePdfJsLoaded();
    if (!window.pdfjsLib) return { text: "", pageImages: [] };

    const loadingTask = window.pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
    });
    const pdf = await loadingTask.promise;
    let fullText = "";
    const pageImages: { pageNumber: number; dataUrl: string }[] = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);

      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(" ");
      fullText += `\n--- Page ${pageNum} ---\n` + pageText;

      const viewport = page.getViewport({ scale: maxScale });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      if (context) {
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        await page.render({
          canvasContext: context,
          viewport: viewport,
        }).promise;

        pageImages.push({
          pageNumber: pageNum,
          dataUrl: canvas.toDataURL("image/png"),
        });
      }
    }

    return { text: fullText, pageImages };
  } catch (err) {
    console.error("PDF processing error:", err);
    return { text: "", pageImages: [] };
  }
}

const COMBO_PREFIX_RE = /^(auto|combo|mix|pool|smart)\//i;
const COMBO_FAMILY = "OmniRoute Combos";

function isComboModel(modelId: string): boolean {
  if (!modelId) return false;
  if (modelId.toLowerCase() === "free stack") return true;
  return COMBO_PREFIX_RE.test(modelId);
}

function getModelFamily(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id === "free stack" || id.includes("free stack")) return "Free Stack";
  if (isComboModel(modelId)) return COMBO_FAMILY;
  if (id.includes("claude")) return "Anthropic Omni-Claude";
  if (id.includes("gemini")) return "Google Gemini";
  if (
    id.includes("gpt") ||
    id.includes("o1") ||
    id.includes("o3") ||
    id.includes("openai")
  )
    return "OpenAI";
  if (id.includes("deepseek")) return "DeepSeek";
  if (id.includes("llama")) return "Meta Llama";
  if (id.includes("qwen")) return "Qwen";
  if (id.includes("glm")) return "Zhipu GLM";
  return "Other Models";
}

const UPPERCASE_WORDS = new Set(["gpt", "ai", "oss", "nim", "glm", "api"]);
const TITLECASE_WORDS = new Set([
  "sonnet",
  "opus",
  "haiku",
  "pro",
  "lite",
  "flash",
  "mini",
  "nano",
  "max",
  "ultra",
  "turbo",
  "thinking",
  "instruct",
  "chat",
  "coder",
  "vision",
  "preview",
]);

function getCleanModelName(modelId: string): string {
  if (!modelId) return "";
  if (modelId.toLowerCase() === "free stack") return "Free Stack";

  const slash = modelId.indexOf("/");
  const bare = slash === -1 ? modelId : modelId.slice(slash + 1);

  const tokens = bare.split("-").filter(Boolean);
  let start = tokens.length;
  while (start > 1 && /^\d+$/.test(tokens[start - 1])) start -= 1;
  const head = tokens.slice(0, start);
  const version = tokens.slice(start).join(".");

  const words = head.map((word) => {
    const lower = word.toLowerCase();
    if (UPPERCASE_WORDS.has(lower)) return word.toUpperCase();
    if (TITLECASE_WORDS.has(lower))
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    if (/^\d+[a-z]$/i.test(word)) return word.toUpperCase();
    if (/^\d+(\.\d+)?$/.test(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  });

  return [...words, version].filter(Boolean).join(" ") || bare;
}

/**
 * The provider label shown beside a model in the picker.
 *
 * Every branch used to carry its own hue — emerald, violet, amber, sky, lime,
 * orange, zinc — so a scrolled list of models was a colour chart. The label
 * already names the provider, and the colours encoded nothing the text did not.
 * Only one distinction is kept, because it changes what the app does rather
 * than who hosts it: a combo id is routed across providers at request time.
 */
function getModelMeta(modelId: string): ModelMeta {
  const id = modelId.toLowerCase();

  const NEUTRAL = "bg-surface-hover text-ink-mid border-line";

  if (id === "free stack" || id.includes("free stack")) {
    return { provider: "Free Stack", badgeColor: NEUTRAL };
  }

  if (isComboModel(modelId)) {
    return {
      provider: "Auto-routed",
      badgeColor: "bg-accent-soft text-accent-ink border-accent-line",
    };
  }

  if (id.startsWith("kiro/") || id.startsWith("kr/")) {
    return { provider: "Kiro AI", badgeColor: NEUTRAL };
  }

  if (
    id.startsWith("antigravity/") ||
    id.startsWith("agy/") ||
    id.startsWith("ag/")
  ) {
    return { provider: "Antigravity", badgeColor: NEUTRAL };
  }

  if (id.startsWith("nvidia/") || id.startsWith("nim/")) {
    return { provider: "NVIDIA", badgeColor: NEUTRAL };
  }

  if (id.includes("groq")) {
    return { provider: "Groq Cloud", badgeColor: NEUTRAL };
  }

  return { provider: "OmniRoute", badgeColor: NEUTRAL };
}

function PdfDownloadCard({
  title,
  pdfUrl,
  fileName,
}: {
  title: string;
  pdfUrl: string;
  fileName?: string;
}) {
  const handleDownload = () => {
    const link = document.createElement("a");
    link.href = pdfUrl;
    link.download = fileName || `${title.replace(/\s+/g, "_")}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="my-3 flex items-center justify-between p-3.5 bg-surface-raised border border-line hover:border-line-strong rounded-2xl w-full max-w-md transition-colors group">
      <div className="flex items-center gap-3.5 min-w-0">
        <div className="w-10 h-10 rounded-xl bg-surface-hover border border-line flex items-center justify-center shrink-0">
          <FileIcon className="w-5 h-5 text-ink-mid stroke-[1.75]" />
        </div>

        <div className="flex flex-col min-w-0 pr-2">
          <span className="text-xs sm:text-sm font-semibold text-ink-hi truncate">
            {title}
          </span>
          <span className="text-[10px] text-ink-low font-medium mt-0.5 tracking-wide">
            Document · PDF
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={handleDownload}
        className="flex items-center justify-center px-3.5 py-1.5 bg-accent hover:bg-accent-hi text-black text-xs font-semibold rounded-xl border border-accent transition-colors cursor-pointer shrink-0"
      >
        Download
      </button>
    </div>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  /**
   * `navigator.clipboard` is undefined outside a secure context, and plain http
   * to a LAN address — which is exactly how someone reaches this app from a
   * second machine on the same network — is not one. The old code awaited it
   * unguarded, so on that path the promise rejected, nothing was copied, and
   * the button gave no sign either way. The textarea route is the pre-async
   * clipboard API: deprecated, but it works where the modern one is withheld.
   */
  const handleCopy = async () => {
    setCopyFailed(false);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const scratch = document.createElement("textarea");
        scratch.value = code;
        scratch.setAttribute("readonly", "");
        scratch.style.position = "fixed";
        scratch.style.opacity = "0";
        document.body.appendChild(scratch);
        scratch.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(scratch);
        if (!ok) throw new Error("execCommand copy returned false");
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 4000);
    }
  };

  return (
    <div className="relative my-4 rounded-xl border border-line bg-surface-sunken font-mono text-xs overflow-hidden">
      <div className="sticky top-0 z-20 flex items-center justify-between px-4 py-2 bg-surface-overlay border-b border-line text-ink-low">
        <span className="uppercase font-semibold tracking-wider text-[10px] text-ink-low">
          {language || "code"}
        </span>
        <button
          onClick={handleCopy}
          type="button"
          title="Copy this snippet"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-hover hover:bg-surface-active text-ink-mid hover:text-ink-hi transition-colors cursor-pointer border border-line"
        >
          {copyFailed ? (
            <span className="text-[11px] text-danger">
              Browser blocked copy
            </span>
          ) : copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-positive" />
              <span className="text-positive font-medium text-[11px]">
                Copied
              </span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span className="text-[11px]">Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-ink leading-relaxed max-h-[600px] [scrollbar-width:thin]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function MiniFileCard({
  file,
  onRemove,
}: {
  file: FileAttachment;
  onRemove?: () => void;
}) {
  const ext = file.name.split(".").pop()?.toUpperCase() || "TXT";

  return (
    <div className="group relative flex items-center gap-2.5 p-2 bg-surface-raised border border-line rounded-xl max-w-xs transition-colors hover:border-line-strong">
      <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-surface-hover border border-line text-ink-mid font-mono text-[10px] font-bold shrink-0">
        {ext.slice(0, 4)}
      </div>
      <div className="flex-1 min-w-0 pr-1">
        <p className="text-xs font-medium text-ink truncate">
          {file.name}
        </p>
        <p className="text-[10px] text-ink-faint font-mono mt-0.5">
          {file.lineCount} lines • {(file.size / 1024).toFixed(1)} KB
        </p>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove attachment"
          className="text-ink-faint hover:text-danger p-1 rounded-md hover:bg-surface-hover transition-colors cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

function MiniDocCard({
  doc,
  onRemove,
}: {
  doc: DocumentAttachment;
  onRemove?: () => void;
}) {
  const isPdf = doc.type.includes("pdf") || doc.name.endsWith(".pdf");

  return (
    <div className="group relative flex items-center gap-2.5 p-2 bg-surface-raised border border-line rounded-xl max-w-xs transition-colors hover:border-line-strong">
      <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-surface-hover border border-line text-ink-mid shrink-0">
        {isPdf ? (
          <FileText className="w-4 h-4" />
        ) : (
          <FileType className="w-4 h-4" />
        )}
      </div>
      <div className="flex-1 min-w-0 pr-1">
        <p className="text-xs font-medium text-ink truncate">{doc.name}</p>
        <p className="text-[10px] text-ink-faint font-mono mt-0.5">
          {isPdf ? "PDF document" : "Word document"} •{" "}
          {(doc.size / 1024).toFixed(1)} KB
        </p>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove attachment"
          className="text-ink-faint hover:text-danger p-1 rounded-md hover:bg-surface-hover transition-colors cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

/** One Ultra review verdict, rendered under the assistant's answer. */
function ReviewVerdictCard({ review }: { review: ReviewInfo }) {
  /* Pass and fail are the one place colour is doing real work here, so they
   * keep it — everything else in this card is neutral so the verdict reads at
   * a glance instead of competing with four severity hues. */
  const tone = review.passed
    ? "bg-positive-soft border-positive-line text-ink"
    : "bg-danger-soft border-danger-line text-ink";

  const severityTone: Record<ReviewFindingInfo["severity"], string> = {
    blocker: "text-danger",
    major: "text-danger",
    minor: "text-ink-mid",
    note: "text-ink-low",
  };

  return (
    <div className={`rounded-xl border px-3 py-2 text-[11px] leading-relaxed shadow-sm ${tone}`}>
      <div className="flex items-center gap-2">
        {review.passed ? (
          <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
        ) : (
          <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
        )}
        <span className="font-semibold">
          Review cycle {review.cycle}/{review.maxCycles} ·{" "}
          {review.passed ? "passed" : "changes rejected"}
        </span>
        {review.model && (
          <span className="ml-auto font-mono text-[10px] opacity-60 truncate">
            {review.model}
          </span>
        )}
      </div>

      {review.summary && (
        <p className="mt-1.5 opacity-90">{review.summary}</p>
      )}

      {review.findings.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {review.findings.map((f, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <span className={`font-mono uppercase text-[9px] mt-0.5 shrink-0 ${severityTone[f.severity]}`}>
                {f.severity}
              </span>
              <span className="min-w-0">
                {f.path && (
                  <span className="font-mono opacity-70">{f.path}: </span>
                )}
                {f.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* Two different producers feed this row, with two different shapes:
 * route notices from the failover ladder ({ kind, text, ... }) and pipeline
 * notices from deepCoworkPipeline ({ type, title, message }). The pipeline ones
 * have no `text`, so rendering `notice.text` alone drew an icon beside nothing —
 * every pipeline warning was invisible. Branch on which field is actually
 * present rather than trusting one shape. */
function FailoverNoticeRow({ notice }: { notice: RouteNotice }) {
  const n = notice as any;

  if (typeof n.text !== "string") {
    const isError = n.type === "error";
    const tone = isError
      ? "bg-danger-soft border-danger-line text-ink"
      : "bg-surface-raised border-line text-ink-mid";
    return (
      <div
        className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-[11px] leading-relaxed ${tone}`}
      >
        <Info className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${isError ? "text-danger" : "text-ink-low"}`} />
        <div className="min-w-0 space-y-1">
          {n.title && <div className="font-medium text-ink-hi">{n.title}</div>}
          {n.message && <div>{n.message}</div>}
          {Array.isArray(n.details) && n.details.length > 0 && (
            <ul className="space-y-0.5 pt-0.5">
              {n.details.map((d: string, i: number) => (
                <li key={i} className="font-mono text-[10px] break-all text-ink-low">
                  {d}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  const isSubstitution = notice.kind === "substituted";
  const isCombo = notice.kind === "combo-fallback";

  /* A substitution is the only one of these the user may need to act on —
   * they asked for one model and got another. The rest are the routing layer
   * narrating itself, and they are frequent, so they stay quiet. */
  const tone = isSubstitution
    ? "bg-danger-soft border-danger-line text-ink"
    : "bg-surface-raised border-line text-ink-mid";

  const Icon = isSubstitution
    ? ShieldAlert
    : isCombo
      ? Layers
      : notice.kind === "account-retry"
        ? RefreshCw
        : ArrowRightLeft;

  return (
    <div
      className={`flex items-start gap-2 rounded-xl border px-3 py-1.5 text-[11px] leading-relaxed ${tone}`}
    >
      <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <span className="min-w-0">{notice.text}</span>
    </div>
  );
}

function ServedByBadge({ route }: { route: RouteInfo }) {
  const servedLabel = route.served
    ? getCleanModelName(route.served)
    : getCleanModelName(route.dispatched);

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono">
      {/* Three states, three colours, on a badge that appears above every
          single answer. Only "substituted" is news — it means you did not get
          the model you asked for — so only it is coloured. */}
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border ${
          route.substituted
            ? "bg-danger-soft text-danger border-danger-line"
            : "bg-surface-raised text-ink-low border-line"
        }`}
        title={`requested: ${route.requested}\ndispatched: ${route.dispatched}${
          route.served ? `\nserved: ${route.served}` : ""
        }`}
      >
        {route.substituted ? (
          <ShieldAlert className="w-3 h-3" />
        ) : route.viaCombo ? (
          <Layers className="w-3 h-3" />
        ) : (
          <Pin className="w-3 h-3" />
        )}
        {servedLabel}
      </span>

      {route.account && (
        <span
          className="px-2 py-0.5 rounded-lg border bg-surface-raised text-ink-faint border-line"
          title="upstream account reported by OmniRoute"
        >
          {route.account}
        </span>
      )}

      {route.attempts > 1 && (
        <span
          className="px-2 py-0.5 rounded-lg border bg-surface-raised text-ink-faint border-line"
          title="gateway attempts before this reply succeeded"
        >
          {route.attempts} attempts
        </span>
      )}
    </div>
  );
}

interface ProviderInfo {
  id: string;
  name: string;
  provider: string;
}

/**
 * The signed-in user, as /api/auth/session and /api/auth/verify-otp return it.
 * `isAdmin` is what gates the Admin button — it is derived on the server from
 * the role on the user record plus the ADMIN_EMAILS / ADMIN_PHONES allowlist,
 * never from anything the browser can set.
 */
interface AuthedUser {
  id: string;
  email: string;
  phone?: string | null;
  tier: string;
  role?: string;
  isAdmin?: boolean;
  referralCode?: string | null;
}

/**
 * Reads the cached user out of localStorage.
 *
 * This is wrapped because JSON.parse throws on malformed input, and it is being
 * called from a useState initialiser — an exception there happens during render
 * and takes down the entire page. One stale or hand-edited localStorage entry
 * should not produce a blank screen with no way to recover; a corrupt entry is
 * dropped and the session is restored from the cookie instead.
 */
function readStoredUser(): AuthedUser | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem('user');
    if (!stored) return null;
    const parsed = JSON.parse(stored) as AuthedUser;
    return parsed && typeof parsed.email === 'string' ? parsed : null;
  } catch {
    try {
      localStorage.removeItem('user');
    } catch {
      /* Storage unavailable entirely; nothing to clean up. */
    }
    return null;
  }
}

export default function OmniClaudeStyleChat() {
  const [availableModels, setAvailableModels] = useState<string[]>([
    "Free Stack",
  ]);
  const [selectedModel, setSelectedModel] = useState("Free Stack");
  const [activeMode, setActiveMode] = useState<InteractionMode>("chat");
  /* Deep Cowork only. `planFirst` runs the read-only planning pass and stops
   * for approval; `askQuestions` lets that pass raise blocking questions. */
  const [planFirst, setPlanFirst] = useState(true);
  const [askQuestions, setAskQuestions] = useState(true);
  const [maxIterations, setMaxIterations] = useState(15);
  const [maxIterationsLoaded, setMaxIterationsLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [fetchingModels, setFetchingModels] = useState(true);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  /* The mode picker. Five segmented buttons collapsed into one dropdown, which
   * also hosts the Plan first / Ask first gates so they stop occupying the row
   * whenever a deep mode happens to be selected. */
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false);
  const [isCreditsOpen, setIsCreditsOpen] = useState(false);
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isBackupsPanelOpen, setIsBackupsPanelOpen] = useState(false);
  const [isSettingsPanelOpen, setIsSettingsPanelOpen] = useState(false);
  /* The guided gateway setup, reachable from the empty state as well as from
   * Settings. Someone with no providers has nothing to chat with, so the offer
   * belongs on the screen they are actually looking at. */
  const [isGatewayWizardOpen, setIsGatewayWizardOpen] = useState(false);
  const [isSubscriptionPanelOpen, setIsSubscriptionPanelOpen] = useState(false);
  const [isAdminPanelOpen, setIsAdminPanelOpen] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isUserGuideOpen, setIsUserGuideOpen] = useState(false);
  const [isConnectEditorOpen, setIsConnectEditorOpen] = useState(false);
  const [isSkillsOpen, setIsSkillsOpen] = useState(false);
  const [isFileAccessOpen, setIsFileAccessOpen] = useState(false);
  const [isProjectsOpen, setIsProjectsOpen] = useState(false);
  /* These three start empty on purpose.
   *
   * This is a client component, but Next still prerenders it on the server,
   * where localStorage does not exist. Reading localStorage in the useState
   * initialiser therefore produced server HTML with a "Login" button and a
   * first client render with "email + Logout" — a hydration mismatch, which
   * React 19 resolves by throwing away the server markup for that subtree.
   * The restore effect below fills all three in from the cache on mount and
   * then reconciles with the server, which costs one frame and keeps the two
   * renders identical. */
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthedUser | null>(null);
  const [userEmail, setUserEmail] = useState<string>('');

  /* Whether Cowork / Deep Cowork file tools are available on this server.
   *
   * These write to the real filesystem of whatever machine runs the app, with
   * no per-user isolation, so a hosted deployment switches them off — see
   * src/lib/fileToolsGate.ts. The server already rejects the request, but
   * discovering that after writing a prompt and waiting is a bad experience for
   * a limitation that is knowable before the user starts.
   *
   * Defaults to true and is only ever set from the session payload, so on
   * localhost nothing changes and on a restricted deployment the modes grey out
   * once the flag arrives. The default matters: assuming "off" would disable
   * working buttons for the fraction of a second before the session resolves,
   * and the server enforces the real answer either way. */
  const [fileToolsAvailable, setFileToolsAvailable] = useState<boolean>(true);
  const [roundSettings, setRoundSettings] = useState<RoundSettings>(loadSettings());
  /* Ultra's reviewer overrides. Both fields are "unset means automatic", so the
   * default costs nothing and the server decides. */
  const [roleModels, setRoleModels] = useState<RoleModelSettings>(loadRoleModels());
  const [workspacePath, setWorkspacePath] = useState<string>("");
  const [modelSearch, setModelSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [collapsedFamilies, setCollapsedFamilies] = useState<
    Record<string, boolean>
  >({ [COMBO_FAMILY]: true });
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(
    new Set(),
  );
  
  // Provider management
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [isProviderSelectorOpen, setIsProviderSelectorOpen] = useState(false);
  const providerMenuRef = useRef<HTMLDivElement>(null);

  const [modelCatalog, setModelCatalog] = useState<CatalogEntry[]>([]);
  const [modelDiagnostics, setModelDiagnostics] =
    useState<ModelDiagnostics | null>(null);
  const [modelCounts, setModelCounts] = useState<ModelCounts | null>(null);
  const [modelHint, setModelHint] = useState<string | null>(null);
  /**
   * What the browser can see of a gateway on the user's own machine.
   *
   * Only consulted when the model list failed, and only to tell two very
   * different failures apart. The server's own error says which address it
   * could not use; it cannot say whether a gateway exists, because on a
   * deployed instance its `localhost` is a datacentre machine. The browser is
   * the one party here that is definitely on the user's computer, so it is the
   * only thing that can answer "is it even running".
   *
   * "Start your gateway" and "your gateway is fine, the address is wrong" send
   * a person to opposite ends of the problem, and guessing between them is how
   * someone ends up restarting a gateway that was never at fault.
   */
  const [gatewayProbe, setGatewayProbe] =
    useState<LocalGatewayProbeResult | null>(null);
  const [showModelDiagnostics, setShowModelDiagnostics] = useState(false);

  const [allowComboFallback, setAllowComboFallback] = useState(true);
  const [allowVersionDrift, setAllowVersionDrift] = useState(true);

  const [attachedFiles, setAttachedFiles] = useState<FileAttachment[]>([]);
  const [attachedImages, setAttachedImages] = useState<DocumentAttachment[]>(
    [],
  );
  const [attachedDocs, setAttachedDocs] = useState<DocumentAttachment[]>([]);

  const [creditsData, setCreditsData] = useState<ProviderCredits[]>([]);
  const [loadingCredits, setLoadingCredits] = useState(false);

  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editInputText, setEditInputText] = useState<string>("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [generatingPdfId, setGeneratingPdfId] = useState<string | null>(null);

  const [generatedPdfs, setGeneratedPdfs] = useState<
    Record<string, GeneratedPdfInfo[]>
  >({});

  const [chatList, setChatList] = useState<ChatItem[]>([]);
  const [pinnedChats, setPinnedChats] = useState<Set<string>>(new Set());
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameChatTitle, setRenameChatTitle] = useState("");
  const [activeChatId, setActiveChatId] = useState<string>(
    () => `chat-${Date.now()}`,
  );

  interface ChatSession {
    messages: ChatMessage[];
    streamingId: string | null;
    error: string | null;
    abortController: AbortController | null;
  }
  const [sessions, setSessions] = useState<Record<string, ChatSession>>({});

  /* How many messages the storage cap has deleted from each chat, keyed by chat
   * id. Populated by loadChat from the `chats.trimmed_messages` column.
   *
   * Deliberately a SEPARATE map rather than a field on ChatSession: `messages`
   * is spread into new session objects in about a dozen places, and widening
   * that shape means every one of them has to carry the new field or silently
   * drop it. A parallel map cannot be dropped by a spread that does not know
   * about it.
   *
   * Non-zero only when OMNIROUTE_MAX_MESSAGES_PER_CHAT is set, which is off by
   * default — so on a personal instance this stays empty and renders nothing.
   * It exists so a long conversation that starts mid-thread after a reload
   * explains itself instead of looking like data loss. */
  const [trimmedCounts, setTrimmedCounts] = useState<Record<string, number>>({});

  const activeSession = sessions[activeChatId] || { messages: [], streamingId: null, error: null, abortController: null };
  const messages = activeSession.messages;
  const streamingId = activeSession.streamingId;
  const error = activeSession.error;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const creditsRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const categoryScrollRef = useRef<HTMLDivElement>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isLoading = streamingId !== null;

  const getSessionMessages = useCallback((chatId: string) => {
    return sessions[chatId]?.messages || [];
  }, [sessions]);

  // Update a single chat session, preserving others
  const updateSession = useCallback((chatId: string, updater: (prev: ChatSession) => ChatSession) => {
    setSessions((prev) => {
      const current = prev[chatId] || { messages: [], streamingId: null, error: null, abortController: null };
      return { ...prev, [chatId]: updater(current) };
    });
  }, []);

  const addStreamingDelta = useCallback((chatId: string, asstId: string, delta: string) => {
    updateSession(chatId, (s) => ({
      ...s,
      messages: s.messages.map((m) =>
        m.id === asstId ? { ...m, content: m.content + delta } : m,
      ),
    }));
  }, [updateSession]);

  const finishStreaming = useCallback((chatId: string, asstId: string, finalText: string) => {
    updateSession(chatId, (s) => ({
      ...s,
      messages: s.messages.map((m) => (m.id === asstId ? { ...m, content: finalText } : m)),
      streamingId: null
    }));
  }, [updateSession]);

  const failStreaming = useCallback((chatId: string, asstId: string, message: string) => {
    updateSession(chatId, (s) => {
      const msgs = s.messages.flatMap((m) => {
        if (m.id !== asstId) return [m];
        const worthKeeping =
          (m.notices?.length ?? 0) > 0 ||
          (m.toolCalls?.length ?? 0) > 0 ||
          m.content.length > 0;
        return worthKeeping ? [{ ...m, error: message }] : [];
      });
      return { ...s, messages: msgs, error: message, streamingId: null };
    });
  }, [updateSession]);

  const addRouteNotice = useCallback((chatId: string, asstId: string, notice: RouteNotice) => {
    updateSession(chatId, (s) => ({
      ...s,
      messages: s.messages.map((m) =>
        m.id === asstId ? { ...m, notices: [...(m.notices || []), notice] } : m,
      ),
    }));
  }, [updateSession]);

  const setRouteInfo = useCallback((chatId: string, asstId: string, route: RouteInfo) => {
    updateSession(chatId, (s) => ({
      ...s,
      messages: s.messages.map((m) => (m.id === asstId ? { ...m, route } : m)),
    }));
  }, [updateSession]);

  const addToolCall = useCallback((chatId: string, asstId: string, tool: string) => {
    updateSession(chatId, (s) => ({
      ...s,
      messages: s.messages.map((m) =>
        m.id === asstId
          ? { ...m, toolCalls: [...(m.toolCalls || []), tool] }
          : m,
      ),
    }));
  }, [updateSession]);

  const attachPlan = useCallback((chatId: string, asstId: string, plan: PlanPayload) => {
    updateSession(chatId, (s) => ({
      ...s,
      messages: s.messages.map((m) => (m.id === asstId ? { ...m, plan } : m)),
    }));
  }, [updateSession]);

  const attachTask = useCallback((chatId: string, asstId: string, task: TaskInfo) => {
    updateSession(chatId, (s) => ({
      ...s,
      messages: s.messages.map((m) => (m.id === asstId ? { ...m, task } : m)),
    }));
  }, [updateSession]);

  const attachBudget = useCallback((chatId: string, asstId: string, budget: BudgetInfo) => {
    updateSession(chatId, (s) => ({
      ...s,
      messages: s.messages.map((m) => (m.id === asstId ? { ...m, budget } : m)),
    }));
  }, [updateSession]);

  /**
   * Which skills applied to this turn, and which were held back.
   *
   * Attached to the message rather than held in panel state so it survives
   * scrolling away and coming back: "why did that answer look like that" is a
   * question asked about an old message far more often than a current one.
   */
  const attachSkills = useCallback(
    (chatId: string, asstId: string, skills: SkillRunReport) => {
      updateSession(chatId, (s) => ({
        ...s,
        messages: s.messages.map((m) => (m.id === asstId ? { ...m, skills } : m)),
      }));
    },
    [updateSession],
  );

  /**
   * Append an Ultra review verdict. Unlike task/budget this accumulates: a turn
   * can run several review -> fix cycles and seeing only the last one would
   * hide the fact that the first attempt was rejected. Keyed by cycle so a
   * resent event replaces rather than duplicates.
   */
  const attachReview = useCallback((chatId: string, asstId: string, review: ReviewInfo) => {
    updateSession(chatId, (s) => ({
      ...s,
      messages: s.messages.map((m) => {
        if (m.id !== asstId) return m;
        const existing = m.reviews ?? [];
        const next = existing.filter((r) => r.cycle !== review.cycle);
        next.push(review);
        next.sort((a, b) => a.cycle - b.cycle);
        return { ...m, reviews: next };
      }),
    }));
  }, [updateSession]);

  const setStage = useCallback((chatId: string, asstId: string, stage: string, stageLabel?: string) => {
    updateSession(chatId, (s) => ({
      ...s,
      messages: s.messages.map((m) =>
        m.id === asstId ? { ...m, stage, stageLabel } : m,
      ),
    }));
  }, [updateSession]);

  const abortStream = useCallback((chatId: string = activeChatId) => {
    updateSession(chatId, (s) => {
      s.abortController?.abort();
      return { ...s, streamingId: null, abortController: null };
    });
  }, [activeChatId, updateSession]);

  /**
   * Restore the session on load.
   *
   * Two things changed here. The old version only ran when localStorage held
   * both a token and a user, so clearing site data logged you out even though
   * the httpOnly session cookie was still perfectly valid. And it treated
   * `res.ok` as "signed in" — but /api/auth/session deliberately answers 200
   * with `authenticated: false` for a signed-out visitor, because being signed
   * out is not an error, so that check passed for everyone and an expired
   * session was never cleared.
   *
   * It now always asks the server and believes the answer. The server's copy of
   * the user also carries the current `isAdmin`, which is what keeps a stale
   * localStorage entry from showing an Admin button that will only 403.
   */
  useEffect(() => {
    const token = localStorage.getItem('auth_token');

    const clearLocalAuth = () => {
      setAuthToken(null);
      setCurrentUser(null);
      setUserEmail('');
      try {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('user');
      } catch {
        /* Storage unavailable; the state reset above is what matters. */
      }
    };

    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    /* Paint the cached identity immediately so the header does not flash
     * "Login" while the round trip is in flight. The server still gets the
     * last word a moment later. */
    if (token) setAuthToken(token);
    const cached = readStoredUser();
    if (cached) {
      setCurrentUser(cached);
      setUserEmail(cached.email);
    }

    fetch('/api/auth/session', { headers, credentials: 'include' })
      /* A 5xx says nothing about whether the session is valid — the route
       * returns 200 with authenticated:false for a genuinely signed-out
       * visitor. Reading an error body as a negative answer would sign people
       * out over a transient server fault, so bail out instead. */
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;

        /* Deployment capability, reported whether or not anyone is signed in.
         * It is not per-user — the server either has file access switched on or
         * it does not — so one read on load is enough and it is never stale. */
        if (typeof data.features?.fileTools === 'boolean') {
          setFileToolsAvailable(data.features.fileTools);
        }

        if (data.authenticated && data.user) {
          const user = data.user as AuthedUser;
          setCurrentUser(user);
          setUserEmail(user.email);
          try {
            localStorage.setItem('user', JSON.stringify(user));
          } catch {
            /* Cookie already carries the session; the cache is optional. */
          }
        } else {
          clearLocalAuth();
        }
      })
      .catch(() => {
        /* The server is unreachable — again, that says nothing about whether
         * the session is valid, so leave the cached user alone rather than
         * logging someone out over a dropped request. */
      });
  }, []);

  const fetchChats = useCallback(async () => {
    try {
      const res = await fetch("/api/chats");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.chats)) {
          setChatList(data.chats);
        }
      }
    } catch (err) {
      console.error("Failed to load chat list", err);
    }
  }, []);

  const loadChat = async (id: string) => {
    setActiveChatId(id);
    // If a session already exists and is actively streaming, don't overwrite it
    if (sessions[id]?.streamingId) {
      return;
    }
    try {
      const res = await fetch(`/api/chats/${id}`);
      if (res.ok) {
        const data = await res.json();

        /* Read before the messages check: the count is a property of the chat
         * row, and it is worth recording even for a transcript that came back
         * empty. Coerced because SQLite hands back a number but the column was
         * added by migration, so an old row can still answer null. */
        const trimmed = Number(data?.chat?.trimmed_messages ?? 0);
        setTrimmedCounts((prev) => ({
          ...prev,
          [id]: Number.isFinite(trimmed) && trimmed > 0 ? trimmed : 0,
        }));

        if (Array.isArray(data.messages)) {
          const loadedMessages = data.messages.map(
            (m: {
              id: string;
              role: ChatRole;
              content: string;
              experimental_attachments?: Attachment[];
            }) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              experimental_attachments: m.experimental_attachments,
            }),
          );
          setSessions((prev) => ({
            ...prev,
            [id]: {
              messages: loadedMessages,
              streamingId: null,
              error: null,
              abortController: null,
            },
          }));
        }
      }
    } catch (err) {
      console.error("Failed to load chat messages", err);
    }
  };

  const handleNewChat = () => {
    const newId = `chat-${Date.now()}`;
    setActiveChatId(newId);
    setSessions((prev) => ({
      ...prev,
      [newId]: { messages: [], streamingId: null, error: null, abortController: null },
    }));
  };

  const handleDeleteChat = async (id: string) => {
    try {
      const res = await fetch(`/api/chats/${id}`, { method: "DELETE" });
      if (res.ok) {
        setChatList((prev) => prev.filter((c) => c.id !== id));
        setSessions((prev) => {
          const newState = { ...prev };
          delete newState[id];
          return newState;
        });
        /* Drop the retention note with the chat. New chat ids are
         * `chat-${Date.now()}`, so a stale entry left behind here could in
         * principle be inherited by a chat created in the same millisecond. */
        setTrimmedCounts((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        if (activeChatId === id) {
          handleNewChat();
        }
      }
    } catch (err) {
      console.error("Failed to delete chat", err);
    }
  };

  const groupedModels = useMemo(() => {
    const groups: Record<string, string[]> = {};
    availableModels.forEach((m) => {
      const family = getModelFamily(m);
      if (!groups[family]) groups[family] = [];
      groups[family].push(m);
    });
    return groups;
  }, [availableModels]);

  const categoriesList = useMemo(() => {
    return ["All", ...Object.keys(groupedModels)];
  }, [groupedModels]);

  const filteredGroupedModels = useMemo(() => {
    const result: Record<string, string[]> = {};
    const query = modelSearch.toLowerCase().trim();

    Object.entries(groupedModels).forEach(([family, models]) => {
      if (selectedCategory !== "All" && family !== selectedCategory) return;

      const matchedModels = models.filter((m) => {
        const cleanName = getCleanModelName(m).toLowerCase();
        const rawId = m.toLowerCase();
        const famName = family.toLowerCase();
        return (
          cleanName.includes(query) ||
          rawId.includes(query) ||
          famName.includes(query)
        );
      });

      if (matchedModels.length > 0) {
        result[family] = matchedModels;
      }
    });

    return result;
  }, [groupedModels, selectedCategory, modelSearch]);

  const failoverDepth = useMemo(() => {
    const perLine: Record<string, number> = {};
    for (const entry of modelCatalog) {
      if (entry.isCombo) continue;
      perLine[entry.line] = (perLine[entry.line] || 0) + 1;
    }
    const out: Record<string, number> = {};
    for (const entry of modelCatalog) {
      if (entry.isCombo) continue;
      out[entry.id] = Math.max(0, (perLine[entry.line] || 1) - 1);
    }
    return out;
  }, [modelCatalog]);

  const scrollCategoryBar = (direction: "left" | "right") => {
    if (categoryScrollRef.current) {
      const scrollAmount = direction === "left" ? -140 : 140;
      categoryScrollRef.current.scrollBy({
        left: scrollAmount,
        behavior: "smooth",
      });
    }
  };

  const toggleFamilyCollapse = (family: string) => {
    setCollapsedFamilies((prev) => ({
      ...prev,
      [family]: !prev[family],
    }));
  };

  const fetchCredits = useCallback(async () => {
    try {
      setLoadingCredits(true);
      const res = await fetch("/api/credits");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.credits)) {
          setCreditsData(data.credits);
        }
      }
    } catch (err) {
      console.error("Failed to load credits", err);
    } finally {
      setLoadingCredits(false);
    }
  }, []);

  const loadProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/credentials");
      const data = await res.json();
      if (data.success && data.data) {
        const providerInfos: ProviderInfo[] = data.data.providers.map((p: any) => ({
          id: p.id,
          name: p.name,
          provider: p.provider,
        }));
        setProviders(providerInfos);
        
        // Set the active provider or default to omniroute
        if (data.data.activeProviderId) {
          setSelectedProviderId(data.data.activeProviderId);
        } else if (providerInfos.length > 0) {
          // Find omniroute provider or use first one
          const omnirouteProvider = providerInfos.find(p => p.provider === "omniroute");
          setSelectedProviderId(omnirouteProvider?.id || providerInfos[0].id);
        }
      }
    } catch (err) {
      console.error("Failed to load providers:", err);
    }
  }, []);

  const loadModels = useCallback(async (providerId?: string) => {
    try {
      setFetchingModels(true);
      const url = providerId ? `/api/models?provider=${providerId}` : "/api/models";
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();

      if (data.models && Array.isArray(data.models) && data.models.length > 0) {
        setAvailableModels(data.models);
        
        // Auto-select default model based on provider
        if (providerId) {
          const provider = providers.find(p => p.id === providerId);
          const isLocalProvider = provider?.provider && 
            ['ollama', 'lm-studio', 'llama.cpp', 'vllm'].includes(provider.provider.toLowerCase());
          const isThirdPartyProvider = provider?.provider &&
            ['apinex'].includes(provider.provider.toLowerCase());
          
          if (isLocalProvider || isThirdPartyProvider) {
            // For local/third-party providers, never use combo models - select first non-combo model
            if (isComboModel(selectedModel) || !data.models.includes(selectedModel)) {
              // Find first non-combo model
              const firstNonCombo = data.models.find((m: string) => !isComboModel(m));
              if (firstNonCombo) {
                setSelectedModel(firstNonCombo);
                console.log(`Auto-selected model "${firstNonCombo}" for provider "${provider?.name}"`);
              } else {
                // Fallback to first model if all are somehow combo models
                setSelectedModel(data.models[0]);
              }
            }
          } else if (provider?.provider === "omniroute" || provider?.provider === "agentrouter") {
            // For omniroute or agentrouter, keep Free Stack as default
            if (!data.models.includes(selectedModel)) {
              setSelectedModel("Free Stack");
            }
          } else {
            // For other providers, select first model if current isn't available
            if (!data.models.includes(selectedModel)) {
              setSelectedModel(data.models[0] || "Free Stack");
            }
          }
        }
      }
      if (Array.isArray(data.catalog) && data.catalog.length > 0) {
        setModelCatalog(data.catalog as CatalogEntry[]);
      }
      setModelDiagnostics(
        data.diagnostics ? (data.diagnostics as ModelDiagnostics) : null,
      );
      setModelCounts(data.counts ? (data.counts as ModelCounts) : null);
      setModelHint(typeof data.hint === "string" ? data.hint : null);
    } catch (err) {
      console.error("Failed to load models list:", err);
      setModelHint("Could not connect to /api/models.");
    } finally {
      setFetchingModels(false);
    }
  }, [providers, selectedModel]);

  /**
   * When the model list is broken and the picker is open, ask the browser
   * whether a gateway is running on this machine.
   *
   * Gated on both conditions on purpose. `modelHint` is null whenever the list
   * loaded, so a working setup never fires this at all, and a closed picker has
   * nowhere to show the answer — a probe nobody reads is just a request to a
   * port for no reason.
   */
  useEffect(() => {
    if (!isModelSelectorOpen || !modelHint) return;

    let cancelled = false;
    void probeLocalGateway().then((result) => {
      if (!cancelled) setGatewayProbe(result);
    });

    return () => {
      cancelled = true;
    };
  }, [isModelSelectorOpen, modelHint]);

  const handleProviderChange = useCallback(async (providerId: string) => {
    setSelectedProviderId(providerId);
    
    // Update the active provider in the backend
    try {
      await fetch("/api/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeProviderId: providerId }),
      });
    } catch (err) {
      console.error("Failed to set active provider:", err);
    }
    
    // Check if switching to a local or third-party provider while a combo model is selected
    const provider = providers.find(p => p.id === providerId);
    const isLocalProvider = provider?.provider && 
      ['ollama', 'lm-studio', 'llama.cpp', 'vllm'].includes(provider.provider.toLowerCase());
    const isThirdPartyProvider = provider?.provider &&
      ['apinex'].includes(provider.provider.toLowerCase());
    
    if ((isLocalProvider || isThirdPartyProvider) && isComboModel(selectedModel)) {
      // Automatically switch away from combo models for local/third-party providers
      // The loadModels function will handle selecting an appropriate default
      console.log(`Switching from routing model "${selectedModel}" to provider-specific model for provider "${provider?.name}"`);
    }
    
    // Reload models for the new provider
    await loadModels(providerId);
  }, [loadModels, providers, selectedModel]);

  const handleProvidersUpdated = useCallback(async () => {
    await loadProviders();
    if (selectedProviderId) {
      await loadModels(selectedProviderId);
    }
  }, [loadProviders, loadModels, selectedProviderId]);

  useEffect(() => {
    loadProviders();
    fetchCredits();
    fetchChats();
  }, [loadProviders, fetchCredits, fetchChats]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('omniroute-user-email', userEmail);
    }
  }, [userEmail]);

  useEffect(() => {
    if (selectedProviderId) {
      loadModels(selectedProviderId);
    }
  }, [selectedProviderId, loadModels]);

  useEffect(() => {
    const fetchWorkspace = async () => {
      try {
        const res = await fetch("/api/workspace");
        if (res.ok) {
          const data = await res.json();
          if (data.activeWorkspace) {
            setWorkspacePath(data.activeWorkspace);
          }
        }
      } catch (err) {
        console.error("Failed to fetch workspace path", err);
      }
    };
    fetchWorkspace();
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("omniroute_max_iterations");
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed > 0) {
        setMaxIterations(parsed);
      }
    }
    setMaxIterationsLoaded(true);
  }, []);

  useEffect(() => {
    if (maxIterationsLoaded) {
      localStorage.setItem("omniroute_max_iterations", maxIterations.toString());
    }
  }, [maxIterations, maxIterationsLoaded]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
      if (
        creditsRef.current &&
        !creditsRef.current.contains(event.target as Node)
      ) {
        setIsCreditsOpen(false);
      }
      if (
        modelMenuRef.current &&
        !modelMenuRef.current.contains(event.target as Node)
      ) {
        setIsModelSelectorOpen(false);
      }
      if (
        providerMenuRef.current &&
        !providerMenuRef.current.contains(event.target as Node)
      ) {
        setIsProviderSelectorOpen(false);
      }
      if (
        modeMenuRef.current &&
        !modeMenuRef.current.contains(event.target as Node)
      ) {
        setIsModeMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const getMessageText = (m: {
    content?: string;
    parts?: Array<{ type: string; text?: string }>;
  }): string => {
    if (typeof m.content === "string" && m.content.length > 0) return m.content;
    if (Array.isArray(m.parts)) {
      return m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text || "")
        .join("");
    }
    return m.content || "";
  };

  const handleCopyMessage = async (text: string, msgId: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedMessageId(msgId);
    setTimeout(() => setCopiedMessageId(null), 2000);
  };

  const triggerServerPdfCompile = async (
    msgId: string,
    content: string,
    customTitle?: string,
  ) => {
    setGeneratingPdfId(msgId);
    try {
      const title =
        customTitle ||
        content.split("\n")[0].replace(/[#*`]/g, "").trim().slice(0, 32) ||
        "Document";

      const res = await fetch("/api/chat/generate-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, title }),
      });

      const data = await res.json();
      if (data.success && data.pdfUrl) {
        const newPdfCard: GeneratedPdfInfo = {
          pdfUrl: data.pdfUrl,
          fileName: data.fileName || `${title}.pdf`,
          title: data.title || title,
        };

        setGeneratedPdfs((prev) => ({
          ...prev,
          [msgId]: [...(prev[msgId] || []), newPdfCard],
        }));
      } else {
        exportResponseToPDF(msgId, content);
      }
    } catch (err) {
      console.error("PDF generation failed:", err);
      exportResponseToPDF(msgId, content);
    } finally {
      setGeneratingPdfId(null);
    }
  };

  const exportResponseToPDF = (msgId: string, content: string) => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Export (${msgId.slice(0, 6)})</title>
          <style>
            body { font-family: system-ui, sans-serif; padding: 40px; color: #111; line-height: 1.6; }
            pre { background: #f4f4f5; padding: 12px; border-radius: 8px; font-family: monospace; }
          </style>
        </head>
        <body>
          <div>${content.replace(/\n/g, "<br/>")}</div>
          <script>
            window.onload = function() { window.print(); window.close(); };
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  const exportResponseToDOCX = (msgId: string, content: string) => {
    const header =
      "<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'></head><body>";
    const footer = "</body></html>";
    const html =
      header +
      "<div style='font-family: Arial, sans-serif; font-size: 11pt;'>" +
      content.replace(/\n/g, "<br/>") +
      "</div>" +
      footer;

    const blob = new Blob(["\ufeff", html], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `response-${msgId.slice(0, 6)}.doc`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const processFileToAttachment = async (file: File) => {
    const fileType = file.type;
    const fileName = file.name;

    if (fileType.startsWith("image/")) {
      return new Promise<void>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          if (reader.result) {
            setAttachedImages((prev) => [
              ...prev,
              {
                id: Math.random().toString(36).substring(2, 9),
                name: fileName,
                dataUrl: reader.result as string,
                type: fileType || "image/png",
                size: file.size,
              },
            ]);
          }
          resolve();
        };
        reader.readAsDataURL(file);
      });
    } else if (fileType === "application/pdf" || fileName.endsWith(".pdf")) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const { text: pdfText, pageImages } =
          await extractPdfDataAndImages(arrayBuffer);

        if (pageImages.length > 0) {
          pageImages.forEach((img) => {
            setAttachedImages((prev) => [
              ...prev,
              {
                id: Math.random().toString(36).substring(2, 9),
                name: `${fileName} - Page ${img.pageNumber}`,
                dataUrl: img.dataUrl,
                type: "image/png",
                size: Math.round(img.dataUrl.length * 0.75),
              },
            ]);
          });
        }

        if (pdfText && pdfText.trim().length > 0) {
          setAttachedFiles((prev) => [
            ...prev,
            {
              id: Math.random().toString(36).substring(2, 9),
              name: fileName,
              content: `[PDF Content extracted from ${fileName}]:\n${pdfText}`,
              type: "application/pdf",
              size: file.size,
              lineCount: pdfText.split("\n").length,
            },
          ]);
        }
      } catch (err) {
        console.error("PDF read error:", err);
      }
    } else if (
      fileType.includes("word") ||
      fileName.endsWith(".doc") ||
      fileName.endsWith(".docx")
    ) {
      return new Promise<void>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          if (reader.result) {
            setAttachedDocs((prev) => [
              ...prev,
              {
                id: Math.random().toString(36).substring(2, 9),
                name: fileName,
                dataUrl: reader.result as string,
                type:
                  fileType ||
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                size: file.size,
              },
            ]);
          }
          resolve();
        };
        reader.readAsDataURL(file);
      });
    } else {
      const text = await file.text();
      const lines = text.split("\n").length;
      setAttachedFiles((prev) => [
        ...prev,
        {
          id: Math.random().toString(36).substring(2, 9),
          name: fileName,
          content: text,
          type: fileType || "text/plain",
          size: file.size,
          lineCount: lines,
        },
      ]);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const filesArray = Array.from(e.target.files);
      await Promise.all(filesArray.map(processFileToAttachment));
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    for (const item of items) {
      if (item.type.startsWith("image/") || item.type === "application/pdf") {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) await processFileToAttachment(file);
      }
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const filesArray = Array.from(e.dataTransfer.files);
      await Promise.all(filesArray.map(processFileToAttachment));
    }
  };

  // Auth handlers
  const handleAuthSuccess = (token: string, user: AuthedUser) => {
    setAuthToken(token);
    setCurrentUser(user);
    setUserEmail(user.email);
    try {
      localStorage.setItem('auth_token', token);
      localStorage.setItem('user', JSON.stringify(user));
    } catch {
      /* Private browsing or a full quota. The session cookie is already set,
       * so the sign-in still holds — do not fail the login over the cache. */
    }
    setIsAuthModalOpen(false);
  };

  const handleLogout = async () => {
    /* Always call the endpoint, with credentials, even when there is no token
     * in localStorage: the session that actually needs revoking lives in the
     * httpOnly cookie, and skipping the call left it valid on the server while
     * the UI showed a signed-out state. The route is idempotent. */
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
    } catch {
      /* Network failure. Clear locally anyway — the session expires on its
       * own, and leaving the user apparently signed in is worse. */
    }

    setAuthToken(null);
    setCurrentUser(null);
    setUserEmail('');
    setIsAdminPanelOpen(false);
    setIsSubscriptionPanelOpen(false);
    try {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('user');
    } catch {
      /* Storage unavailable; the state reset above is what matters. */
    }
  };

  const sendMessage = useCallback(
    async (
      userMSG: { content: string; experimental_attachments?: Attachment[] },
      options?: {
        model?: string;
        chatId?: string;
        mode?: InteractionMode;
        /** Override the plan/execute phase for this one send. */
        deepPhase?: "plan" | "execute" | "auto";
        /** Continue a task artifact instead of starting fresh. */
        resumeTaskId?: string;
        answers?: string[];
        maxIterations?: number;
        /**
         * The raw text the user typed, when `content` has been augmented with
         * attachment dumps. Slash commands parse from this — otherwise an
         * attached file's contents become the command's arguments.
         */
        commandText?: string;
      },
    ) => {
      const model = options?.model || selectedModel;
      const chatId = options?.chatId || activeChatId;
      const currentMode = options?.mode || activeMode;

      /* Validate that combo/routing models like "Free Stack" are not used with
       * local providers or third-party providers. Local providers (Ollama, LM Studio, etc.) 
       * and third-party providers (APInex) need actual model names, not routing identifiers. */
      if (isComboModel(model)) {
        const currentProvider = providers.find(p => p.id === selectedProviderId);
        const isLocalProvider = currentProvider?.provider && 
          ['ollama', 'lm-studio', 'llama.cpp', 'vllm'].includes(currentProvider.provider.toLowerCase());
        
        const isThirdPartyProvider = currentProvider?.provider &&
          ['apinex'].includes(currentProvider.provider.toLowerCase());
        
        if (isLocalProvider) {
          const cleanName = getCleanModelName(model);
          throw new Error(
            `"${cleanName}" is a routing model that only works with gateway providers like OmniRoute. ` +
            `With local provider "${currentProvider?.name || 'local'}", please select an actual model name ` +
            `from your installed models (e.g., llama3.2, dolphin-llama3:latest).`
          );
        }
        
        if (isThirdPartyProvider) {
          const cleanName = getCleanModelName(model);
          throw new Error(
            `"${cleanName}" is a routing model that only works with gateway providers like OmniRoute. ` +
            `With "${currentProvider?.name || 'external'}" provider, please select an actual model name ` +
            `from the available models (e.g., free/gemini-3.8-flash, free/glm-5.3-flash).`
          );
        }
      }

      /* A leading slash command retargets the run: `/plan` stops at the
       * approval gate, `/review` and `/init` run with write tools removed.
       * Parsed only in the deep modes, matching the server — which ignores the
       * field otherwise, since these commands need file tools. */
      const slash = DEEP_MODES.includes(currentMode)
        ? parseSlashCommand(options?.commandText ?? userMSG.content)
        : null;

      /* The plan gate applies to Deep Cowork and Ultra. An explicit deepPhase
       * from the Approve button always wins; then a slash command, which is a
       * deliberate per-message choice; then the standing planFirst toggle. */
      const deepPhase =
        options?.deepPhase ??
        slash?.command.phase ??
        (DEEP_MODES.includes(currentMode) && planFirst ? "plan" : "auto");

      const currentMessages = getSessionMessages(chatId);
      
      const userMsg: ChatMessage = {
        id: `usr-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        role: "user",
        content: userMSG.content,
        experimental_attachments: userMSG.experimental_attachments,
      };
      const asstId = `ast-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const asstMsg: ChatMessage = {
        id: asstId,
        role: "assistant",
        content: "",
      };

      const controller = new AbortController();
      
      updateSession(chatId, (s) => ({
        ...s,
        messages: [...(s.messages || currentMessages), userMsg, asstMsg],
        error: null,
        streamingId: asstId,
        abortController: controller,
      }));

      /* Gate Cowork on the user, not on the localStorage token. The session
       * now lives in an httpOnly cookie, which is sent with this same-origin
       * request automatically — so a signed-in visitor whose localStorage was
       * cleared has a perfectly valid session and no `authToken`, and keying
       * off the token would lock them out of a feature they can use. */
      if (WORKSPACE_MODES.includes(currentMode) && !currentUser) {
        throw new Error('Please login to use Cowork and Deep Cowork features');
      }

      let acc = "";
      try {
        const headers: Record<string, string> = { 
          "Content-Type": "application/json"
        };
        
        // Add auth token if available
        if (authToken) {
          headers['Authorization'] = `Bearer ${authToken}`;
        }

        /* Per-provider UI preferences (auth scheme, proxy, discovery toggles).
         * These are display settings only — never a key. */
        let agentRouterSettings = undefined;

        if (selectedProviderId) {
          try {
            const stored = localStorage.getItem(`agent_router_${selectedProviderId}`);
            if (stored) {
              agentRouterSettings = JSON.parse(stored);
            }
          } catch (e) {
            console.error("Failed to parse agent router settings:", e);
          }
        }

        /* Every provider — gateway, third-party and local — goes through
         * /api/chat. This branch used to divert agentrouter/openrouter to
         * /api/external-chat, which meant first GETting the provider's
         * decrypted apiKey into browser memory and posting it back up with
         * every message. The key now stays on the server: the client sends
         * only the provider id, and the route looks the credentials up itself. */
        const requestBody = {
          messages: [...currentMessages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
            experimental_attachments: m.experimental_attachments,
          })),
          model,
          chatId,
          mode: currentMode,
          deepPhase,
          resumeTaskId: options?.resumeTaskId,
          maxIterations: options?.maxIterations ?? maxIterations,
          askQuestions: deepPhase === "plan" && askQuestions,
          answers: options?.answers,
          routing: { allowComboFallback, allowVersionDrift },
          roundSettings,
          /* Ultra only. Blank/zero are omitted so the server keeps its own
           * defaults rather than receiving "" as a model id. */
          reviewModel: roleModels.reviewModel || undefined,
          maxReviewCycles: roleModels.maxReviewCycles || undefined,
          /* Name and args only. The server builds the objective from its own
           * table — the objective is a system prompt, so a client that could
           * send it directly could rewrite the agent's instructions. */
          slashCommand: slash?.command.name,
          slashArgs: slash?.args || undefined,
          providerId: selectedProviderId,
          agentRouterSettings,
        };

        const res = await fetch("/api/chat", {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify(requestBody),
        });

        if (!res.ok || !res.body) {
          let msg = `Request failed: status ${res.status}`;
          try {
            const j = await res.json();
            if (j?.error) msg = j.error;
          } catch {
            /* non-json */
          }
          throw new Error(msg);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finished = false;

        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const jsonLine = part
              .split("\n")
              .find((l) => l.startsWith("data:"));
            if (!jsonLine) continue;

            const data = jsonLine.slice(5).trim();
            if (!data) continue;

            let evt: any;
            try {
              evt = JSON.parse(data);
            } catch {
              continue;
            }

            if (typeof evt.delta === "string") {
              acc += evt.delta;
              addStreamingDelta(chatId, asstId, evt.delta);
            } else if (evt.stage) {
              setStage(chatId, asstId, evt.stage, evt.stageLabel);
            } else if (evt.notice) {
              addRouteNotice(chatId, asstId, evt.notice as RouteNotice);
            } else if (typeof evt.tool === "string") {
              addToolCall(chatId, asstId, evt.tool);
            } else if (evt.route) {
              setRouteInfo(chatId, asstId, evt.route as RouteInfo);
            } else if (evt.plan) {
              attachPlan(chatId, asstId, evt.plan as PlanPayload);
            } else if (evt.task) {
              attachTask(chatId, asstId, evt.task as TaskInfo);
            } else if (evt.review) {
              attachReview(chatId, asstId, evt.review as ReviewInfo);
            } else if (evt.budget) {
              attachBudget(chatId, asstId, evt.budget as BudgetInfo);
            } else if (evt.skills) {
              attachSkills(chatId, asstId, evt.skills as SkillRunReport);
            } else if (typeof evt.error === "string") {
              throw new Error(evt.error);
            } else if (evt.done) {
              finished = true;
              break;
            }
          }
        }

        finishStreaming(chatId, asstId, acc);
        fetchCredits();
        fetchChats();
      } catch (err: any) {
        if (err?.name === "AbortError") {
          updateSession(chatId, (s) => ({ ...s, streamingId: null }));
          return;
        }
        console.error("Failed to send message:", err);
        failStreaming(chatId, asstId, err?.message || String(err));
      } finally {
        updateSession(chatId, (s) => ({ ...s, abortController: null }));
      }
    },
    [
      selectedModel,
      activeChatId,
      activeMode,
      planFirst,
      askQuestions,
      maxIterations,
      allowComboFallback,
      allowVersionDrift,
      roundSettings,
      roleModels,
      selectedProviderId,
      userEmail,
      /* Both were read inside sendMessage but missing from this list, so the
       * callback captured whatever they were when it was last rebuilt. It only
       * ever worked because `userEmail` changes at the same moment as these
       * two and forced a rebuild — naming them removes the coincidence. */
      authToken,
      currentUser,
      getSessionMessages,
      updateSession,
      addStreamingDelta,
      setStage,
      addRouteNotice,
      addToolCall,
      setRouteInfo,
      attachPlan,
      attachTask,
      attachReview,
      attachBudget,
      attachSkills,
      finishStreaming,
      failStreaming,
      fetchCredits,
      fetchChats,
    ],
  );

  /**
   * Approve a plan and run it.
   *
   * The card has already written `status: "executing"` to the task file, so the
   * approval survives even if this request fails. `resumeTaskId` is what makes
   * the execute pass cheap: the pipeline injects the plan, the files already
   * read and the calls already known to fail, instead of rediscovering them.
   */
  const handleApprovePlan = useCallback(
    (taskId: string, answers: string[]) => {
      void sendMessage(
        { content: "Approved. Execute the plan." },
        {
          /* Carry the live mode, NOT a hardcoded "deepcowork". `sendMessage`
           * lets an explicit option win over `activeMode`, so hardcoding it
           * here silently downgraded Ultra to Deep Cowork on the execute pass —
           * the exact pass that writes the files, and so the one the reviewer
           * exists to audit. Approving a plan must not change the mode. */
          mode: DEEP_MODES.includes(activeMode) ? activeMode : "deepcowork",
          deepPhase: "execute",
          resumeTaskId: taskId,
          answers,
          maxIterations,
        },
      );
    },
    [sendMessage, maxIterations, activeMode],
  );

  /** Revise: re-plan with the note the user typed as the steer. */
  const handleRevisePlan = useCallback(
    (taskId: string, note: string) => {
      void sendMessage(
        { content: `Revise the plan: ${note}` },
        {
          mode: DEEP_MODES.includes(activeMode) ? activeMode : "deepcowork",
          deepPhase: "plan",
          resumeTaskId: taskId,
        },
      );
    },
    [sendMessage, activeMode],
  );

  const handleFormSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (
      (!input.trim() &&
        attachedFiles.length === 0 &&
        attachedImages.length === 0 &&
        attachedDocs.length === 0) ||
      isLoading
    )
      return;

    const userText = input;
    const filesBackup = [...attachedFiles];
    const imagesBackup = [...attachedImages];
    const docsBackup = [...attachedDocs];

    let fileTextPayload = "";
    if (attachedFiles.length > 0) {
      const fileContents = attachedFiles.map((file) => {
        const ext = file.name.split(".").pop() || "txt";
        return `\n\n--- Attachment File: ${file.name} ---\n\`\`\`${ext}\n${file.content}\n\`\`\``;
      });
      fileTextPayload += fileContents.join("");
    }

    const allAttachments: Attachment[] = [
      ...attachedImages.map((img) => ({
        name: img.name,
        contentType: img.type,
        url: img.dataUrl,
      })),
      ...attachedDocs.map((doc) => ({
        name: doc.name,
        contentType: doc.type,
        url: doc.dataUrl,
      })),
    ];

    const fullTextContent = (userText.trim() + fileTextPayload).trim();

    setInput("");
    setAttachedFiles([]);
    setAttachedImages([]);
    setAttachedDocs([]);

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    try {
      await sendMessage(
        {
          content: fullTextContent,
          experimental_attachments:
            allAttachments.length > 0 ? allAttachments : undefined,
        },
        {
          model: selectedModel,
          chatId: activeChatId,
          mode: activeMode,
          commandText: userText,
        },
      );
    } catch (err) {
      console.error("Failed to send message:", err);
      setInput(userText);
      setAttachedFiles(filesBackup);
      setAttachedImages(imagesBackup);
      setAttachedDocs(docsBackup);
    }
  };

  const handleSaveEdit = async (msgId: string) => {
    if (!editInputText.trim() || isLoading) return;

    const targetIdx = messages.findIndex((m) => m.id === msgId);
    if (targetIdx === -1) return;

    const truncated = messages.slice(0, targetIdx);
    updateSession(activeChatId, (s) => ({ ...s, messages: truncated }));
    setEditingMessageId(null);

    const editedText = editInputText.trim();
    setEditInputText("");

    try {
      await sendMessage(
        { content: editedText },
        { model: selectedModel, chatId: activeChatId, mode: activeMode },
      );
    } catch (err) {
      console.error("Failed to resubmit edited message:", err);
    }
  };

  const handlePillClick = (promptText: string) => {
    setInput(promptText);
  };

  const renderModelDiagnosticsBanner = () => {
    const d = modelDiagnostics;
    const concreteCount =
      modelCounts?.concrete ?? modelCatalog.filter((c) => !c.isCombo).length;
    const comboCount =
      modelCounts?.combos ?? modelCatalog.filter((c) => c.isCombo).length;

    const broken = !fetchingModels && (!d || !!d.error || concreteCount === 0);

    /* The headline names what happened; `modelHint` below it carries the
     * specific reason from the server. "OmniRoute reported a problem" used to be
     * the catch-all, which was wrong twice over: the active provider is often
     * not OmniRoute at all, and the most common case is not the provider
     * reporting anything but this server declining to make the request — a
     * deployed app cannot reach a gateway on your laptop. Blaming a provider for
     * that sends people to restart a gateway that was never the problem. */
    const headline = !d
      ? "Could not load model list"
      : d.error
        ? "Model list unavailable"
        : concreteCount === 0
          ? "No specific model available — combos only"
          : "The provider reported a problem";

    /* Two states share this strip, and only one of them is news. When the list
     * loaded, "14 models · 3 combos" is a count — it had an emerald icon, which
     * read as a success notification sitting permanently above the list it was
     * describing. Counts are neutral here; the red is kept for the case where
     * there is nothing to pick from. */
    return (
      <div
        className={`px-3.5 py-2 border-b text-[10px] ${
          broken
            ? "border-danger-line bg-danger-soft"
            : "border-line bg-surface-sunken"
        }`}
      >
        <div className="flex items-center gap-2">
          {broken ? (
            <AlertCircle className="w-3.5 h-3.5 text-danger shrink-0" />
          ) : (
            <Layers className="w-3.5 h-3.5 text-ink-low shrink-0" />
          )}
          <span
            className={broken ? "font-semibold text-danger" : "text-ink-mid"}
          >
            {broken
              ? headline
              : `${concreteCount} model${
                  concreteCount === 1 ? "" : "s"
                } · ${comboCount} combo${comboCount === 1 ? "" : "s"}`}
          </span>

          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowModelDiagnostics((v) => !v)}
              className="px-2 py-0.5 rounded-lg bg-surface-hover hover:bg-surface-active text-ink-mid hover:text-ink-hi border border-line cursor-pointer transition-colors"
            >
              {showModelDiagnostics ? "Hide" : "Details"}
            </button>
            <button
              type="button"
              /* Wrapped, not passed directly. React calls an onClick handler with
               * the click event as its first argument, so `onClick={loadModels}`
               * meant `loadModels(syntheticEvent)` — and the event object is
               * truthy, so the `providerId ? ... : ...` branch inside built the
               * URL `/api/models?provider=[object Object]`. The refresh button
               * therefore always fetched models for a provider that does not
               * exist and the picker reported that it could not load the list.
               * Reloading for the currently selected provider is what the button
               * means, and matches the effect that populates the list initially. */
              onClick={() => loadModels(selectedProviderId ?? undefined)}
              disabled={fetchingModels}
              className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-surface-hover hover:bg-surface-active text-ink-mid hover:text-ink-hi border border-line cursor-pointer disabled:opacity-50 transition-colors"
            >
              <RefreshCw
                className={`w-2.5 h-2.5 ${fetchingModels ? "animate-spin" : ""}`}
              />
              Retry
            </button>
          </div>
        </div>

        {broken && modelHint && (
          <p className="mt-1.5 leading-relaxed text-danger/80">{modelHint}</p>
        )}

        {/* The server's message above says which address failed. This says
          * whether a gateway exists to be addressed — a question the server
          * cannot answer about the user's machine, and the difference between
          * "start it" and "point at it properly". */}
        {broken && gatewayProbe && (
          <div className="mt-2 flex items-start gap-2 rounded-xl border border-line bg-surface-sunken px-2.5 py-2">
            {gatewayProbe.present ? (
              <Globe className="w-3.5 h-3.5 text-accent shrink-0 mt-px" />
            ) : (
              <Terminal className="w-3.5 h-3.5 text-ink-low shrink-0 mt-px" />
            )}
            <div className="min-w-0 space-y-1.5">
              <p className="leading-relaxed text-ink-mid">
                {gatewayProbe.present
                  ? "A gateway is answering on this machine, so the gateway is not the problem — the address this server was given is. That is a setup step, not an outage."
                  : "Your browser could not find a gateway on this machine either. If you meant to use one, start it and load the list again."}
              </p>
              <button
                type="button"
                onClick={() => {
                  setIsModelSelectorOpen(false);
                  setIsGatewayWizardOpen(true);
                }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-accent-soft hover:bg-accent/20 text-accent-ink border border-accent-line cursor-pointer transition-colors"
              >
                <Terminal className="w-2.5 h-2.5" />
                {gatewayProbe.present
                  ? "Fix the address"
                  : "Set up the gateway"}
              </button>
            </div>
          </div>
        )}

        {showModelDiagnostics && (
          <div className="mt-2 space-y-1 rounded-xl border border-line bg-surface-sunken p-2.5 font-mono text-ink-low shadow-inner">
            {d ? (
              <>
                <div className="break-all">GET {d.url}</div>
                <div>
                  status {d.status ?? "no response"} · shape {d.shape} · ids{" "}
                  {d.rawCount}
                </div>
                <div>
                  key{" "}
                  {d.apiKeyConfigured
                    ? "configured"
                    : "MISSING — set OMNIROUTE_API_KEY"}
                </div>
                {d.error && <div className="text-danger">{d.error}</div>}
              </>
            ) : (
              <div>No diagnostics available.</div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderModelDropdownMenu = () => (
    <div className="absolute right-0 bottom-full mb-3 w-80 sm:w-96 bg-surface-overlay border border-line rounded-2xl shadow-2xl backdrop-blur-2xl z-50 overflow-hidden text-sans animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="p-3 border-b border-line bg-surface-sunken">
        <div className="flex items-center gap-2 bg-surface-raised border border-line rounded-xl px-3 py-2 focus-within:border-line-strong transition-colors">
          {/* The magnifier was amber — the same colour as Send. A search icon is
              a label for the field next to it, not something to act on. */}
          <Search className="w-3.5 h-3.5 text-ink-low shrink-0" />
          <input
            value={modelSearch}
            onChange={(e) => setModelSearch(e.target.value)}
            placeholder="Search models or providers..."
            className="w-full bg-transparent text-xs text-ink-hi focus:outline-none placeholder:text-ink-faint"
            autoFocus
          />
        </div>

        <div className="relative flex items-center mt-2.5">
          <button
            type="button"
            onClick={() => scrollCategoryBar("left")}
            aria-label="Scroll categories left"
            className="p-1 rounded-lg bg-surface-hover hover:bg-surface-active text-ink-low hover:text-ink-hi border border-line shrink-0 z-10 cursor-pointer mr-1"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>

          <div
            ref={categoryScrollRef}
            className="flex items-center gap-1.5 overflow-x-auto scroll-smooth py-0.5 scrollbar-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {categoriesList.map((cat) => {
              const isActive = selectedCategory === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCategory(cat)}
                  className={`text-[10px] font-medium px-2.5 py-1 rounded-lg transition-all shrink-0 cursor-pointer ${
                    isActive
                      ? "bg-surface-active text-ink-hi border border-line-strong"
                      : "bg-surface-raised hover:bg-surface-hover text-ink-mid border border-line"
                  }`}
                >
                  {cat}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => scrollCategoryBar("right")}
            aria-label="Scroll categories right"
            className="p-1 rounded-lg bg-surface-hover hover:bg-surface-active text-ink-low hover:text-ink-hi border border-line shrink-0 z-10 cursor-pointer ml-1"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {renderModelDiagnosticsBanner()}

      <div className="max-h-72 overflow-y-auto p-2 space-y-2 [scrollbar-width:thin]">
        {Object.entries(filteredGroupedModels).map(([family, models]) => {
          const isCollapsed = collapsedFamilies[family];
          const isComboFamily = family === COMBO_FAMILY;

          return (
            <div
              key={family}
              className={`rounded-xl border overflow-hidden transition-colors ${
                isComboFamily
                  ? "bg-accent-soft border-accent-line"
                  : "bg-surface-sunken border-line"
              }`}
            >
              <button
                type="button"
                onClick={() => toggleFamilyCollapse(family)}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-semibold cursor-pointer transition-colors ${
                  isComboFamily
                    ? "bg-accent-soft hover:bg-accent/15 text-accent-ink"
                    : "bg-surface-raised hover:bg-surface-hover text-ink"
                }`}
              >
                <div className="flex items-center gap-2">
                  {/* Combos are the one family that behaves differently — they
                      pick a model for you — so they keep the accent. Every other
                      family had an amber Sparkles too, which meant the accent
                      appeared once per family and stopped distinguishing them. */}
                  {isComboFamily ? (
                    <Layers className="w-3.5 h-3.5 text-accent-ink" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5 text-ink-low" />
                  )}
                  <span>{family}</span>
                  <span
                    className={`text-[10px] px-2 py-0.2 rounded-full font-mono ${
                      isComboFamily
                        ? "bg-accent/15 text-accent-ink"
                        : "bg-surface-hover text-ink-mid"
                    }`}
                  >
                    {models.length}
                  </span>
                </div>
                <ChevronDown
                  className={`w-3.5 h-3.5 transition-transform duration-200 ${
                    isComboFamily ? "text-accent-ink" : "text-ink-low"
                  } ${isCollapsed ? "-rotate-90" : ""}`}
                />
              </button>

              {!isCollapsed && (
                <div className="p-1 space-y-1">
                  {models.map((m) => {
                    const meta = getModelMeta(m);
                    const cleanName = getCleanModelName(m);
                    const isSelected = m === selectedModel;
                    
                    // Check if this is a combo/routing model and if current provider is local
                    const isCombo = isComboModel(m);
                    const currentProvider = providers.find(p => p.id === selectedProviderId);
                    const isLocalProvider = currentProvider?.provider && 
                      ['ollama', 'lm-studio', 'llama.cpp', 'vllm'].includes(currentProvider.provider.toLowerCase());
                    const isThirdPartyProvider = currentProvider?.provider &&
                      ['apinex'].includes(currentProvider.provider.toLowerCase());
                    const isDisabled = isCombo && (isLocalProvider || isThirdPartyProvider);

                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          if (isDisabled) return;
                          setSelectedModel(m);
                          setIsModelSelectorOpen(false);
                        }}
                        disabled={!!isDisabled}
                        title={
                          isDisabled && isLocalProvider
                            ? `"${cleanName}" is a routing model that only works with gateway providers. Select an actual model name from your local provider's installed models.`
                            : isDisabled && isThirdPartyProvider
                            ? `"${cleanName}" is a routing model that only works with gateway providers. Select an actual model name from ${currentProvider?.name || 'the provider'} (e.g., free/gemini-3.8-flash).`
                            : undefined
                        }
                        className={`w-full text-left p-2 rounded-xl transition-all flex items-center justify-between gap-2 ${
                          isDisabled
                            ? "opacity-40 cursor-not-allowed"
                            : "cursor-pointer"
                        } ${
                          isSelected
                            ? "bg-surface-active border border-line-strong"
                            : "hover:bg-surface-hover border border-transparent"
                        }`}
                      >
                        <div className="flex flex-col min-w-0 pr-2">
                          <div className="flex items-center gap-1.5">
                            {isSelected && (
                              <Check className="w-3.5 h-3.5 text-accent shrink-0" />
                            )}
                            <span
                              className={`text-xs font-medium truncate ${
                                isSelected
                                  ? "text-ink-hi font-semibold"
                                  : "text-ink"
                              }`}
                            >
                              {cleanName}
                            </span>
                          </div>
                          <span className="text-[10px] text-ink-faint font-mono truncate pl-0.5">
                            {m}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {!isComboModel(m) && (failoverDepth[m] ?? 0) > 0 && (
                            <span
                              className="text-[9px] px-1.5 py-0.5 rounded-md border font-mono bg-surface-hover text-ink-mid border-line inline-flex items-center gap-0.5"
                              title={`${failoverDepth[m]} alternate provider(s) found.`}
                            >
                              <RefreshCw className="w-2.5 h-2.5" />
                              {failoverDepth[m] + 1}
                            </span>
                          )}
                          <span
                            className={`text-[9px] px-2 py-0.5 rounded-md border font-mono ${meta.badgeColor}`}
                          >
                            {meta.provider}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-line bg-surface-sunken px-3 py-2.5 space-y-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-mid">
          <SlidersHorizontal className="w-3 h-3 text-ink-low" />
          <span>Failover Settings</span>
        </div>

        <label className="flex items-start gap-2 cursor-pointer group/opt">
          <input
            type="checkbox"
            checked={allowVersionDrift}
            onChange={(e) => setAllowVersionDrift(e.target.checked)}
            className="mt-0.5 accent-[var(--color-accent)] cursor-pointer rounded"
          />
          <span className="text-[10px] leading-relaxed text-ink-mid group-hover/opt:text-ink">
            Allow version fallbacks (e.g. Opus 4.5 → Opus 4.1).
          </span>
        </label>

        <label className="flex items-start gap-2 cursor-pointer group/opt">
          <input
            type="checkbox"
            checked={allowComboFallback}
            onChange={(e) => setAllowComboFallback(e.target.checked)}
            /* Was violet while the one above it was amber. Two checkboxes in the
             * same group, doing the same kind of thing, should not be different
             * colours — the difference implied a distinction that isn't there. */
            className="mt-0.5 accent-[var(--color-accent)] cursor-pointer rounded"
          />
          <span className="text-[10px] leading-relaxed text-ink-mid group-hover/opt:text-ink">
            Allow auto-routed combo fallback as last resort.
          </span>
        </label>
      </div>
    </div>
  );

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const textarea = e.target;
    textarea.style.height = "auto";
    const newHeight = Math.min(textarea.scrollHeight, 220);
    textarea.style.height = `${newHeight}px`;
  };

  const togglePromptExpansion = (msgId: string) => {
    setExpandedPrompts((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(msgId)) {
        newSet.delete(msgId);
      } else {
        newSet.add(msgId);
      }
      return newSet;
    });
  };

  /* Slash command menu. Only offered in the deep modes, because that is where
   * the server honours the commands — advertising them elsewhere would be a
   * menu of things that silently do nothing. */
  const slashMatches = DEEP_MODES.includes(activeMode)
    ? matchSlashCommands(input, { ultra: activeMode === "ultra" })
    : [];

  const completeSlashCommand = (name: string) => {
    setInput(`/${name} `);
    textareaRef.current?.focus();
  };

  /* Resolved once, so the trigger and the menu cannot disagree about which mode
   * is lit. `ActiveModeIcon` is capitalised because JSX reads a lowercase tag as
   * an HTML element name, not a component. */
  const activeModeMeta = modeMeta(activeMode);
  const ActiveModeIcon = activeModeMeta.Icon;

  const renderInputForm = () => (
    <form
      onSubmit={handleFormSubmit}
      onPaste={handlePaste}
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      className="w-full bg-surface-raised border border-line focus-within:border-line-strong transition-colors rounded-2xl p-3 shadow-xl"
    >
      {slashMatches.length > 0 && (
        <div className="mb-2 overflow-hidden rounded-xl border border-line bg-surface-overlay">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-ink-low border-b border-line-faint">
            Commands — Tab to complete
          </div>
          {slashMatches.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => completeSlashCommand(c.name)}
              className="w-full text-left px-3 py-2 hover:bg-surface-hover transition-colors flex items-baseline gap-2 cursor-pointer"
            >
              <span className="font-mono text-xs text-ink-hi">
                /{c.name}
                {c.argHint && (
                  <span className="text-ink-faint"> [{c.argHint}]</span>
                )}
              </span>
              <span className="text-xs text-ink-low truncate">
                {c.summary}
              </span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={input}
        onChange={handleTextareaChange}
        onKeyDown={(e) => {
          /* Tab completes the command rather than moving focus. Only while the
           * menu is open, so tabbing out of an ordinary message still works. */
          if (e.key === "Tab" && slashMatches.length > 0) {
            e.preventDefault();
            completeSlashCommand(slashMatches[0].name);
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            if (e.nativeEvent.isComposing) return;
            /* A bare "/rev" with the menu open is a half-typed command, not a
             * message. Complete it instead of sending it. */
            if (slashMatches.length > 0 && /^\/\S*$/.test(input.trim())) {
              e.preventDefault();
              completeSlashCommand(slashMatches[0].name);
              return;
            }
            e.preventDefault();
            handleFormSubmit();
          }
        }}
        placeholder={activeModeMeta.placeholder}
        className="w-full bg-transparent text-sm text-ink-hi focus:outline-none resize-none placeholder:text-ink-faint p-1.5 leading-relaxed overflow-y-auto"
        style={{ minHeight: "40px", maxHeight: "220px" }}
      />

      {(attachedFiles.length > 0 ||
        attachedImages.length > 0 ||
        attachedDocs.length > 0) && (
        <div className="mb-2.5 flex items-center gap-2 flex-wrap p-1 border-t border-line-faint pt-2">
          {attachedFiles.map((file) => (
            <MiniFileCard
              key={file.id}
              file={file}
              onRemove={() =>
                setAttachedFiles((prev) =>
                  prev.filter((item) => item.id !== file.id),
                )
              }
            />
          ))}

          {attachedDocs.map((doc) => (
            <MiniDocCard
              key={doc.id}
              doc={doc}
              onRemove={() =>
                setAttachedDocs((prev) =>
                  prev.filter((item) => item.id !== doc.id),
                )
              }
            />
          ))}

          {attachedImages.map((img) => (
            <div
              key={img.id}
              className="relative group w-16 h-16 rounded-xl border border-line overflow-hidden bg-surface-overlay"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.dataUrl}
                alt={img.name || "Attachment"}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
              />
              <button
                type="button"
                onClick={() =>
                  setAttachedImages((prev) =>
                    prev.filter((item) => item.id !== img.id),
                  )
                }
                className="absolute top-1 right-1 bg-surface-sunken/90 hover:bg-surface-overlay text-ink-mid hover:text-danger rounded-full p-1 border border-line transition-colors cursor-pointer"
                title="Remove attachment"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-2 border-t border-line-faint">
        <div className="flex items-center gap-2">
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => {
                setIsMenuOpen(!isMenuOpen);
                setIsModeMenuOpen(false);
              }}
              title="Attach a file"
              className="p-2 rounded-xl bg-surface-hover hover:bg-surface-active text-ink-mid hover:text-ink-hi border border-line transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" />
            </button>

            {isMenuOpen && (
              <div className="absolute left-0 bottom-11 w-60 bg-surface-overlay border border-line rounded-2xl shadow-2xl p-1.5 z-50 text-xs animate-in fade-in slide-in-from-bottom-2 duration-150">
                <button
                  type="button"
                  onClick={() => {
                    setIsMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-ink-mid hover:text-ink-hi hover:bg-surface-hover rounded-xl cursor-pointer transition-colors"
                >
                  <Paperclip className="w-4 h-4" />
                  <span className="font-medium">Upload PDF, DOCX, code</span>
                </button>
              </div>
            )}
          </div>

          {/* One control, not five.
           *
           * This row used to hold five mode buttons in a segmented strip, then a
           * second strip with Plan first / Ask first that appeared and
           * disappeared depending on which mode was chosen — so the controls
           * either side of it moved under the cursor. Seven targets competing
           * for the same 300px, none of them able to say what they do.
           *
           * A dropdown trades one click for room to explain. Each row gets its
           * name, a sentence of what it actually does, and an honest line when
           * it cannot be used here. The plan/approve gates live inside the same
           * menu, under the mode they belong to, so nothing in the row shifts
           * position when the mode changes. The trigger still states the answer
           * to the only question you need at a glance — which mode am I in. */}
          <div ref={modeMenuRef} className="relative">
            <button
              type="button"
              onClick={() => {
                /* One menu at a time: these panels overlap, and two of them
                 * open at once reads as a rendering bug. */
                setIsModeMenuOpen((open) => !open);
                setIsMenuOpen(false);
                setIsModelSelectorOpen(false);
                setIsProviderSelectorOpen(false);
              }}
              title={`${activeModeMeta.label} — ${activeModeMeta.blurb}`}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-line bg-surface-hover hover:bg-surface-active text-xs text-ink hover:text-ink-hi transition-colors cursor-pointer"
            >
              <ActiveModeIcon className="w-3.5 h-3.5" />
              <span className="font-semibold">{activeModeMeta.label}</span>
              {DEEP_MODES.includes(activeMode) && planFirst && (
                <span className="hidden sm:inline text-[10px] text-ink-faint">
                  {askQuestions ? "plan + ask" : "plan"}
                </span>
              )}
              <ChevronDown className="w-3.5 h-3.5 text-ink-low" />
            </button>

            {isModeMenuOpen && (
              <div className="absolute left-0 bottom-11 w-[20rem] max-w-[calc(100vw-3rem)] bg-surface-overlay border border-line rounded-2xl shadow-2xl p-1.5 z-50 animate-in fade-in slide-in-from-bottom-2 duration-150">
                <div className="px-2.5 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-ink-faint">
                  Mode
                </div>

                {MODE_META.map((mode) => {
                  const Icon = mode.Icon;
                  const locked = mode.needsFiles && !fileToolsAvailable;
                  const selected = mode.id === activeMode;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      disabled={locked}
                      onClick={() => {
                        setActiveMode(mode.id);
                        setIsModeMenuOpen(false);
                      }}
                      className={`w-full flex items-start gap-2.5 px-2.5 py-2 rounded-xl text-left transition-colors cursor-pointer disabled:cursor-not-allowed ${
                        locked
                          ? "opacity-40"
                          : selected
                            ? "bg-accent-soft text-ink-hi"
                            : "text-ink-mid hover:bg-surface-hover hover:text-ink-hi"
                      }`}
                    >
                      <Icon className="w-4 h-4 mt-0.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold">
                          {mode.label}
                        </span>
                        <span className="block text-[11px] leading-snug text-ink-faint">
                          {/* The disabled reason has to be specific. "Unavailable"
                              on its own reads as a bug in the app rather than a
                              property of where it is running. */}
                          {locked
                            ? "Needs workspace access, which this server does not have. Chat works normally."
                            : mode.blurb}
                        </span>
                      </span>
                      {selected && (
                        <Check className="w-3.5 h-3.5 mt-0.5 shrink-0 text-accent-ink" />
                      )}
                    </button>
                  );
                })}

                {DEEP_MODES.includes(activeMode) && (
                  <div className="mt-1 pt-1.5 border-t border-line-faint">
                    <div className="px-2.5 pb-1 text-[10px] uppercase tracking-wider text-ink-faint">
                      Before it starts
                    </div>
                    <button
                      type="button"
                      onClick={() => setPlanFirst((value) => !value)}
                      className="w-full flex items-start gap-2.5 px-2.5 py-2 rounded-xl text-left text-ink-mid hover:bg-surface-hover hover:text-ink-hi transition-colors cursor-pointer"
                    >
                      <span
                        className={`mt-0.5 w-3.5 h-3.5 shrink-0 rounded-[4px] border flex items-center justify-center transition-colors ${
                          planFirst
                            ? "bg-accent border-accent text-black"
                            : "border-line-strong"
                        }`}
                      >
                        {planFirst && <Check className="w-2.5 h-2.5" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold">
                          Plan first
                        </span>
                        <span className="block text-[11px] leading-snug text-ink-faint">
                          Write a plan and wait for your approval before editing
                          anything.
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      /* Ask-first is meaningless without a planning pass to ask
                       * during, so it follows planFirst rather than standing on
                       * its own. */
                      disabled={!planFirst}
                      onClick={() => setAskQuestions((value) => !value)}
                      className="w-full flex items-start gap-2.5 px-2.5 py-2 rounded-xl text-left text-ink-mid hover:bg-surface-hover hover:text-ink-hi transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                    >
                      <span
                        className={`mt-0.5 w-3.5 h-3.5 shrink-0 rounded-[4px] border flex items-center justify-center transition-colors ${
                          askQuestions && planFirst
                            ? "bg-accent border-accent text-black"
                            : "border-line-strong"
                        }`}
                      >
                        {askQuestions && planFirst && (
                          <Check className="w-2.5 h-2.5" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold">
                          Ask first
                        </span>
                        <span className="block text-[11px] leading-snug text-ink-faint">
                          {planFirst
                            ? "Let the plan raise questions it cannot answer from the code."
                            : "Turn on Plan first to use this."}
                        </span>
                      </span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Provider Selector */}
          <div ref={providerMenuRef} className="relative">
            <button
              type="button"
              onClick={() => {
                setIsProviderSelectorOpen(!isProviderSelectorOpen);
                setIsModeMenuOpen(false);
              }}
              className="flex items-center gap-2 px-3 py-1.5 bg-surface-hover hover:bg-surface-active border border-line rounded-xl text-xs text-ink-mid hover:text-ink-hi cursor-pointer transition-colors"
            >
              <Globe className="w-3.5 h-3.5" />
              <span className="font-medium truncate max-w-[100px]">
                {providers.find(p => p.id === selectedProviderId)?.name || "Select provider"}
              </span>
              <ChevronDown className="w-3.5 h-3.5" />
            </button>

            {isProviderSelectorOpen && (
              <div className="absolute bottom-full mb-2 right-0 w-64 bg-surface-overlay border border-line rounded-xl shadow-2xl overflow-hidden z-50">
                <div className="p-3 border-b border-line-faint">
                  <h4 className="text-xs font-semibold text-ink-mid uppercase tracking-wide">
                    Select provider
                  </h4>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {providers.length === 0 ? (
                    <div className="p-4 text-center">
                      <p className="text-xs text-ink-low mb-2">No providers configured</p>
                      <button
                        onClick={() => {
                          setIsProviderSelectorOpen(false);
                          setIsGatewayWizardOpen(true);
                        }}
                        className="text-xs text-accent-ink hover:text-accent-hi underline cursor-pointer"
                      >
                        Set up my gateway
                      </button>
                    </div>
                  ) : (
                    providers.map((provider) => (
                      <button
                        key={provider.id}
                        onClick={() => {
                          handleProviderChange(provider.id);
                          setIsProviderSelectorOpen(false);
                        }}
                        className={`w-full px-4 py-2.5 text-left hover:bg-surface-hover transition-colors flex items-center justify-between cursor-pointer ${
                          provider.id === selectedProviderId ? "bg-surface-hover" : ""
                        }`}
                      >
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-ink">
                            {provider.name}
                          </span>
                          <span className="text-xs text-ink-faint capitalize">
                            {provider.provider}
                          </span>
                        </div>
                        {provider.id === selectedProviderId && (
                          <div className="w-2 h-2 rounded-full bg-accent shrink-0" />
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Model Selector */}
          <div ref={modelMenuRef} className="relative">
            <button
              type="button"
              onClick={() => {
                setIsModelSelectorOpen(!isModelSelectorOpen);
                setIsModeMenuOpen(false);
              }}
              className="flex items-center gap-2 px-3 py-1.5 bg-surface-hover hover:bg-surface-active border border-line rounded-xl text-xs text-ink-mid hover:text-ink-hi cursor-pointer transition-colors"
            >
              <Cpu className="w-3.5 h-3.5" />
              <span className="font-medium truncate max-w-[120px] sm:max-w-[150px]">
                {getCleanModelName(selectedModel)}
              </span>
              <ChevronDown className="w-3.5 h-3.5" />
            </button>

            {isModelSelectorOpen && renderModelDropdownMenu()}
          </div>

          {isLoading ? (
            <button
              type="button"
              /* Same defect as the model-refresh button, with a worse symptom.
               * `abortStream(chatId: string = activeChatId)` uses a DEFAULT
               * parameter, and a default only applies when the argument is
               * `undefined` — a click event is not undefined, so the event object
               * was used as the chat id, the in-flight controller lookup missed,
               * and Stop Generation did nothing at all. */
              onClick={() => abortStream()}
              className="p-2.5 rounded-xl bg-danger-soft hover:bg-danger/25 text-danger border border-danger-line cursor-pointer transition-colors"
              title="Stop generating"
            >
              <Square className="w-4 h-4 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              title="Send message"
              disabled={
                !input.trim() &&
                attachedFiles.length === 0 &&
                attachedImages.length === 0 &&
                attachedDocs.length === 0
              }
              className="p-2.5 rounded-xl bg-accent hover:bg-accent-hi disabled:opacity-30 disabled:hover:bg-accent text-black font-bold cursor-pointer disabled:cursor-not-allowed transition-colors"
            >
              <Send className="w-4 h-4 fill-current" />
            </button>
          )}
        </div>
      </div>
    </form>
  );

  return (
    <div className="flex h-screen bg-surface-base text-ink font-sans overflow-hidden antialiased">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileUpload}
        className="hidden"
      />

      {/* The sidebar is a companion, not a destination: it sits next to the text
          the user is actually reading, so it stays quieter than the chat surface
          (surface-raised against surface-base) and spends no accent of its own.
          Amber appears exactly once here — on New chat, the only action in this
          column that starts something. */}
      <aside
        className={`${
          isSidebarOpen ? "w-64" : "w-0 hidden"
        } transition-all duration-300 bg-surface-raised border-r border-line flex flex-col justify-between shrink-0 z-20`}
      >
        <div className="p-3.5 space-y-4">
          <div className="flex items-center justify-between px-2 pt-1">
            <span className="font-serif text-xl tracking-tight text-ink-hi font-semibold flex items-center gap-2 relative">
              {/* Four stacked animated blur layers used to sit behind this mark,
                  pulsing on two different intervals. One static glow reads as a
                  logo; four that breathe read as a notification. */}
              <div className="relative">
                <div className="absolute inset-0 -m-5 rounded-full bg-accent/20 blur-xl pointer-events-none" />
                <div className="relative p-1 rounded-lg bg-accent-soft border border-accent-line">
                  <Sparkle className="w-4 h-4 text-accent fill-accent" />
                </div>
              </div>
              Omni-Claude
            </span>
            <button
              onClick={() => setIsSidebarOpen(false)}
              className="p-1.5 text-ink-low hover:text-ink-hi rounded-lg hover:bg-surface-hover cursor-pointer transition-colors"
              title="Hide sidebar"
            >
              <PanelLeft className="w-4 h-4" />
            </button>
          </div>

          <button
            onClick={handleNewChat}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-accent hover:bg-accent-hi text-black text-xs font-semibold border border-accent transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>New chat</span>
          </button>

          {/* These rows were <div onClick> — invisible to the keyboard and to a
              screen reader, which is a real bug and not only a styling one.
              Projects and Artifacts have never had a handler at all, so they are
              marked disabled rather than left looking clickable: a row that
              highlights on hover and then does nothing reads as a broken app. */}
          <div className="space-y-0.5 text-xs">
            <button
              type="button"
              disabled
              title="Not available yet"
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-ink-faint cursor-not-allowed"
            >
              <Folder className="w-4 h-4" />
              <span>Projects</span>
              <span className="ml-auto text-[10px] uppercase tracking-wider">Soon</span>
            </button>
            <button
              type="button"
              disabled
              title="Not available yet"
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-ink-faint cursor-not-allowed"
            >
              <Layers className="w-4 h-4" />
              <span>Artifacts</span>
              <span className="ml-auto text-[10px] uppercase tracking-wider">Soon</span>
            </button>
            <button
              type="button"
              onClick={() => setIsBackupsPanelOpen(true)}
              className="group w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-ink-mid hover:bg-surface-hover hover:text-ink-hi cursor-pointer transition-colors"
            >
              <FolderArchive className="w-4 h-4 text-ink-low group-hover:text-ink-mid transition-colors" />
              <span>Backups</span>
            </button>
            <button
              type="button"
              onClick={() => setIsConnectEditorOpen(true)}
              className="group w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-ink-mid hover:bg-surface-hover hover:text-ink-hi cursor-pointer transition-colors"
            >
              <MonitorSmartphone className="w-4 h-4 text-ink-low group-hover:text-ink-mid transition-colors" />
              <span>Connect VS Code</span>
            </button>
            <button
              type="button"
              onClick={() => setIsSkillsOpen(true)}
              className="group w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-ink-mid hover:bg-surface-hover hover:text-ink-hi cursor-pointer transition-colors"
            >
              <Sparkles className="w-4 h-4 text-ink-low group-hover:text-ink-mid transition-colors" />
              <span>Skills</span>
            </button>
            {/* Sits in the nav rather than inside Settings on purpose: this is
                the control a user goes looking for when they are uneasy about
                what the model can see, and burying it under provider
                credentials means the people who most want it never find it. */}
            <button
              type="button"
              onClick={() => setIsFileAccessOpen(true)}
              className="group w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-ink-mid hover:bg-surface-hover hover:text-ink-hi cursor-pointer transition-colors"
            >
              <ShieldCheck className="w-4 h-4 text-ink-low group-hover:text-ink-mid transition-colors" />
              <span>File access</span>
            </button>
            {/* A second, read-only project to draw features from. Sits beside
                File access because both answer "what can the model see": one
                takes folders away, this one grants a second folder to read. */}
            <button
              type="button"
              onClick={() => setIsProjectsOpen(true)}
              className="group w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-ink-mid hover:bg-surface-hover hover:text-ink-hi cursor-pointer transition-colors"
            >
              <FolderTree className="w-4 h-4 text-ink-low group-hover:text-ink-mid transition-colors" />
              <span>Reference project</span>
            </button>
          </div>

          <div className="pt-3 border-t border-line">
            <span className="px-3 text-[10px] font-semibold text-ink-low uppercase tracking-wider">
              Chats
            </span>
            <div className="mt-2 space-y-0.5 text-xs max-h-60 overflow-y-auto [scrollbar-width:thin]">
              {chatList.length === 0 ? (
                <p className="px-3 text-[11px] text-ink-faint py-1">
                  No saved conversations yet
                </p>
              ) : (
                chatList.map((c) => {
                  const isActive = c.id === activeChatId;
                  return (
                    <div
                      key={c.id}
                      onClick={() => loadChat(c.id)}
                      className={`group flex items-center justify-between px-3 py-2 rounded-xl cursor-pointer transition-colors ${
                        isActive
                          ? "bg-surface-active text-ink-hi font-medium"
                          : "hover:bg-surface-hover text-ink-mid hover:text-ink-hi"
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate pr-1 min-w-0">
                        {/* The active row already carries a lighter surface and
                            brighter text. A coloured icon on top of that is a
                            third signal for one piece of state. */}
                        <MessageSquare
                          className={`w-3.5 h-3.5 shrink-0 ${
                            isActive ? "text-ink-mid" : "text-ink-faint"
                          }`}
                        />
                        <span className="truncate text-xs">{c.title}</span>
                      </div>
                      <button
                        type="button"
                        title="Delete chat"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteChat(c.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 text-ink-faint hover:text-danger hover:bg-surface-hover rounded-lg transition-all cursor-pointer shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div className="p-3.5 border-t border-line flex items-center justify-between gap-2 text-xs text-ink-mid bg-surface-sunken">
          {/* Identity comes from the session, never from a literal. This footer
              read "S / Shervin" for every visitor — including signed-out ones,
              who were greeted by name before they had an account. */}
          {currentUser ? (
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-7 h-7 shrink-0 rounded-full bg-accent-soft border border-accent-line text-accent-ink flex items-center justify-center font-bold text-xs">
                {resolveInitial(currentUser)}
              </div>
              <span
                className="font-medium text-ink truncate"
                title={currentUser.email || undefined}
              >
                {resolveDisplayName(currentUser)}
              </span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsAuthModalOpen(true)}
              className="flex items-center gap-2.5 min-w-0 cursor-pointer hover:text-ink-hi transition-colors"
              title="Sign in"
            >
              <div className="w-7 h-7 shrink-0 rounded-full bg-surface-hover border border-line text-ink-low flex items-center justify-center">
                <LogIn className="w-3.5 h-3.5" />
              </div>
              <span className="font-medium">Sign in</span>
            </button>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsSettingsPanelOpen(true)}
              className="p-1 cursor-pointer text-ink-low hover:text-ink-hi transition-colors"
              title="Settings"
            >
              <SlidersHorizontal className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* The chat surface. Was a radial gradient from amber-950/20 through
        * neutral-950 to black, plus two 140-160px-blurred amber discs the size
        * of the viewport. Three separate orange washes over the area where the
        * text lives — which is the one part of a chat app that has to stay
        * legible for hours. A flat near-black reads as deliberate, and leaves
        * the accent free to mean something. */}
      <div className="flex-1 flex flex-col h-full min-w-0 bg-surface-base relative overflow-hidden">
        {/* Beta notice. Was a three-stop amber→orange→red gradient with a
          * pulsing icon: the loudest element on the page, permanently, for a
          * message you only need to read once. */}
        <div className="w-full bg-surface-raised border-b border-line px-6 py-2">
          <div className="flex items-center justify-center gap-2 text-xs">
            <AlertCircle className="w-3.5 h-3.5 text-accent shrink-0" />
            <span className="text-ink-mid">
              <span className="font-semibold text-ink">Beta</span> — some
              features are still under development.
            </span>
            <button
              onClick={() => setIsUserGuideOpen(true)}
              className="ml-1 px-2 py-0.5 rounded-md text-accent-ink hover:bg-accent-soft border border-transparent hover:border-accent-line transition-colors cursor-pointer"
            >
              View guide
            </button>
          </div>
        </div>

        <header className="sticky top-0 flex items-center justify-between px-6 py-3.5 border-b border-line bg-surface-raised/85 backdrop-blur-xl z-10 shrink-0">
          <div className="flex items-center gap-3">
            {!isSidebarOpen && (
              <button
                onClick={() => setIsSidebarOpen(true)}
                className="p-1.5 text-ink-low hover:text-ink-hi rounded-lg bg-surface-hover border border-line cursor-pointer transition-colors hover:bg-surface-active"
              >
                <PanelLeft className="w-4 h-4" />
              </button>
            )}
            <div className="flex items-center gap-2.5">
              <div className="flex items-center gap-2">
                {/* Was an `animate-ping` ring running forever. A pulse is how a
                  * UI says "something is happening"; this says "still on",
                  * which is true for the entire session — so the motion never
                  * stopped and never meant anything. A static dot with a ring
                  * reads the same and stops competing for attention. */}
                <span className="h-2 w-2 rounded-full bg-positive ring-4 ring-positive-soft" />
                <span className="text-xs text-ink-mid font-mono tracking-wide">
                  OmniRoute Active
                </span>
              </div>
              {/* One chip, three labels. These were three differently-coloured
                * badges (amber, violet, fuchsia) for three modes, which put a
                * second and third "accent" in the header while the icon and the
                * word beside it were already doing the distinguishing.
                *
                * Listed explicitly rather than as `!== "chat"` because the mode
                * union also contains "production", which had no badge before
                * and must not inherit another mode's label by falling through a
                * ternary. */}
              {(activeMode === "cowork" ||
                activeMode === "deepcowork" ||
                activeMode === "ultra") && (
                <span className="text-[10px] bg-accent-soft text-accent-ink border border-accent-line px-2.5 py-0.5 rounded-full font-mono font-semibold flex items-center gap-1.5">
                  {activeMode === "cowork" && <Users className="w-3 h-3" />}
                  {activeMode === "deepcowork" && <Brain className="w-3 h-3" />}
                  {activeMode === "ultra" && <Sparkles className="w-3 h-3" />}
                  {activeMode === "cowork"
                    ? "Cowork"
                    : activeMode === "deepcowork"
                      ? "Deep Cowork"
                      : "Ultra"}
                </span>
              )}
            </div>
            {/* On a shared deployment this renders as a read-only chip naming
              * the folder the connected editor reported, and the only thing it
              * can offer is pairing — hence the same handler as the pill. */}
            <WorkspaceSelector
              onConnectEditor={() => setIsConnectEditorOpen(true)}
            />
            {/* Sits next to the workspace picker because the two answer halves
              * of the same question: which folder, and on whose machine. */}
            <EditorLinkPill onClick={() => setIsConnectEditorOpen(true)} />
          </div>

          <div className="flex items-center gap-3">
            {/* Was four stacked blurred radial gradients, two of them animating
              * on independent loops, behind a 20px icon. Layered blur at that
              * scale is expensive to composite and the net effect was a
              * permanent orange haze over the top-right corner of the app,
              * which is where every button in the header lives. One soft static
              * glow is enough to lift the mark off the surface. */}
            <div className="relative flex items-center">
              <div className="absolute inset-0 -m-6 rounded-full bg-accent/20 blur-2xl pointer-events-none" />
              <div className="relative p-2 rounded-xl bg-accent-soft border border-accent-line">
                <Sparkle className="w-5 h-5 text-accent fill-accent" />
              </div>
            </div>

            <div ref={creditsRef} className="relative">
            <button
              type="button"
              onClick={() => setIsCreditsOpen(!isCreditsOpen)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-hover hover:bg-surface-active border border-line text-xs text-ink-mid hover:text-ink-hi transition-colors cursor-pointer"
            >
              <Coins className="w-3.5 h-3.5 text-accent" />
              <span className="font-mono text-[11px]">
                {creditsData.length > 0
                  ? `${creditsData.length} Tracked`
                  : "Quotas"}
              </span>
            </button>

            {isCreditsOpen && (
              <div className="absolute right-0 mt-2 w-80 bg-surface-overlay border border-line rounded-2xl shadow-2xl p-4 z-50 space-y-3 font-sans animate-in fade-in slide-in-from-top-2 duration-150">
                <div className="flex items-center justify-between border-b border-line pb-2.5">
                  <span className="font-semibold text-xs text-ink-hi flex items-center gap-2">
                    <Zap className="w-4 h-4 text-ink-low" /> Provider quotas
                  </span>
                  <button
                    onClick={fetchCredits}
                    title="Refresh quotas"
                    className="p-1 text-ink-low hover:text-ink-hi transition-colors cursor-pointer"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${
                        loadingCredits ? "animate-spin" : ""
                      }`}
                    />
                  </button>
                </div>
                <div className="space-y-2">
                  {creditsData.length === 0 ? (
                    <div className="p-3 text-center text-xs text-ink-mid bg-surface-sunken rounded-xl border border-line-faint">
                      No live quota APIs detected.
                    </div>
                  ) : (
                    creditsData.map((cred, i) => (
                      <div
                        key={cred.provider || i}
                        className="p-2.5 rounded-xl bg-surface-sunken border border-line-faint flex items-center justify-between text-xs"
                      >
                        <span className="text-ink font-medium">
                          {cred.provider}
                        </span>
                        <span className="text-[10px] text-ink-mid bg-surface-hover px-2 py-0.5 rounded-md border border-line font-mono">
                          {cred.status}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
            </div>

            <button
              type="button"
              onClick={() =>
                currentUser
                  ? setIsSubscriptionPanelOpen(true)
                  : setIsAuthModalOpen(true)
              }
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-hover hover:bg-surface-active border border-line text-xs text-ink-mid hover:text-ink-hi transition-colors cursor-pointer"
              title="Subscription & Usage"
            >
              <Zap className="w-3.5 h-3.5 text-accent" />
              {/* Was the literal "Pro" for everyone, including signed-out
                  visitors and every FREE account — a plan badge that advertised
                  a plan nobody was on. */}
              <span className="font-medium">
                {currentUser
                  ? (currentUser.tier || "free").charAt(0).toUpperCase() +
                    (currentUser.tier || "free").slice(1).toLowerCase()
                  : "Plans"}
              </span>
            </button>

            {/* Admin is a server-side role, so this button is only a shortcut —
                the route re-checks on every request and the panel says so if
                the account is not allowlisted. Hiding it keeps a button that
                can only 403 out of everyone else's toolbar. */}
            {currentUser?.isAdmin && (
              <button
                type="button"
                onClick={() => setIsAdminPanelOpen(true)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-hover hover:bg-surface-active border border-line text-xs text-ink-mid hover:text-ink-hi transition-colors cursor-pointer"
                title="Admin Panel"
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                <span className="font-medium">Admin</span>
              </button>
            )}

            {/* Login/Logout Button — keyed on the user, not the token. The
                session lives in an httpOnly cookie, so someone who cleared
                localStorage is still signed in; gating on `authToken` showed
                them a Login button and no way to sign out. */}
            {currentUser ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-ink-low">{currentUser.email}</span>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-hover hover:bg-surface-active border border-line text-xs text-ink-mid hover:text-ink-hi transition-colors cursor-pointer"
                  title="Logout"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span className="font-medium">Logout</span>
                </button>
              </div>
            ) : (
              /* The one filled button in the header. For a signed-out visitor
                 this is the only action that leads anywhere, so it gets the
                 accent and everything around it stays neutral — which is the
                 whole point of having a single accent. It was previously
                 emerald, sitting beside a violet button and a rose one, none of
                 which agreed about what mattered. */
              <button
                type="button"
                onClick={() => setIsAuthModalOpen(true)}
                className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-accent hover:bg-accent-hi border border-accent text-xs font-semibold text-black transition-colors cursor-pointer"
                title="Login"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>Sign in</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setIsBackupsPanelOpen(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-surface-hover hover:bg-surface-active border border-line text-xs text-ink-mid hover:text-ink-hi transition-colors cursor-pointer"
              title="Backups"
            >
              <FolderArchive className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => setIsUserGuideOpen(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-surface-hover hover:bg-surface-active border border-line text-xs text-ink-mid hover:text-ink-hi transition-colors cursor-pointer"
              title="User Guide - Learn how to use OmniRoute Coder"
            >
              <Info className="w-3.5 h-3.5" />
              <span className="font-medium">Guide</span>
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto w-full px-4 py-6 [scrollbar-width:thin]">
          <div className="max-w-3xl mx-auto w-full min-h-full flex flex-col justify-between">
            {error && (
              <div className="mb-4 p-3.5 rounded-2xl bg-danger-soft border border-danger-line text-danger text-xs flex items-center gap-2.5">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {activeMode === "production" ? (
              <ProductionAgentMode
                isEnabled={true}
                onToggle={() => setActiveMode("chat")}
                currentProvider={providers.find(p => p.id === selectedProviderId)}
                projectRoot={workspacePath}
                selectedModel={selectedModel}
                authToken={authToken ?? undefined}
                selectedProviderId={selectedProviderId ?? undefined}
              />
            ) : (
              <>
              {messages.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center space-y-6 my-auto py-12 animate-fade-rise">
                <div className="flex flex-col items-center gap-4 relative">
                  {/* One glow, not three, and none of them animating. The mark
                    * sits above an empty screen — it does not need to compete
                    * with anything, and a pulse here reads as "loading". */}
                  <div className="absolute inset-0 -m-16 rounded-full bg-accent/10 blur-[80px] pointer-events-none" />

                  <div className="relative p-3 rounded-2xl bg-accent-soft border border-accent-line">
                    <Sparkle className="w-7 h-7 text-accent fill-accent" />
                  </div>
                  <h1 className="font-serif text-3xl sm:text-4xl text-ink-hi font-normal tracking-tight relative">
                    {/* Three states, because "Welcome back, <name>" is wrong in
                        two of them: a signed-out visitor has not been here, and
                        an account whose email carries no name has nothing to
                        put after the comma. */}
                    {(() => {
                      if (!currentUser) return "What are we building?";
                      const name = greetingName(currentUser);
                      return name ? `Welcome back, ${name}` : "Welcome back";
                    })()}
                  </h1>
                </div>

                {/* The blocking problem, stated where it blocks.
                  *
                  * With no provider there is nothing to send a message to, and
                  * the only previous sign of that was an empty model picker —
                  * which reads as "the app is loading", not as "you have a
                  * setup step left". Shown only to signed-in accounts because a
                  * signed-out visitor cannot save a provider anyway; their next
                  * step is the sign-in button, not this. */}
                {currentUser && providers.length === 0 && (
                  <div className="w-full max-w-2xl rounded-xl border border-accent-line bg-accent-soft px-4 py-3.5 flex items-start gap-3 text-left">
                    <Terminal className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink-hi">
                        No AI provider connected yet
                      </p>
                      <p className="text-xs text-ink-mid mt-1 leading-relaxed">
                        Run the OmniRoute gateway on your own machine and point
                        this app at it. Takes about two minutes.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsGatewayWizardOpen(true)}
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hi text-black text-xs font-semibold transition-colors cursor-pointer"
                    >
                      Set up
                    </button>
                  </div>
                )}

                <div className="w-full max-w-2xl">{renderInputForm()}</div>

                <div className="flex items-center justify-center gap-2.5 flex-wrap max-w-xl">
                  <button
                    type="button"
                    onClick={() =>
                      handlePillClick(
                        "Keep only the important questions, and give me the updated pdf",
                      )
                    }
                    className="group flex items-center gap-2 px-3.5 py-2 rounded-lg bg-surface-raised hover:bg-surface-hover border border-line hover:border-line-strong text-xs text-ink-mid hover:text-ink-hi cursor-pointer transition-colors"
                  >
                    <FileText className="w-3.5 h-3.5 text-ink-low group-hover:text-accent transition-colors" />
                    <span className="font-medium">Extract Questions & PDF</span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      handlePillClick(
                        "Draft a professional .DOCX format report on...",
                      )
                    }
                    className="group flex items-center gap-2 px-3.5 py-2 rounded-lg bg-surface-raised hover:bg-surface-hover border border-line hover:border-line-strong text-xs text-ink-mid hover:text-ink-hi cursor-pointer transition-colors"
                  >
                    <FileType className="w-3.5 h-3.5 text-ink-low group-hover:text-accent transition-colors" />
                    <span className="font-medium">Generate Report</span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      handlePillClick(
                        "Build an interactive React canvas for...",
                      )
                    }
                    className="group flex items-center gap-2 px-3.5 py-2 rounded-lg bg-surface-raised hover:bg-surface-hover border border-line hover:border-line-strong text-xs text-ink-mid hover:text-ink-hi cursor-pointer transition-colors"
                  >
                    <Code2 className="w-3.5 h-3.5 text-ink-low group-hover:text-accent transition-colors" />
                    <span className="font-medium">Code</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-6 pb-48">
                {/* Retention notice.
                  *
                  * Rendered only when this deployment sets a per-chat message
                  * cap AND this chat has actually hit it, so on a personal
                  * instance it never appears. Without it a reloaded long
                  * conversation simply starts in the middle, which reads as
                  * lost data rather than as a policy. Muted and inline rather
                  * than a banner: it is a footnote about history, not a
                  * warning about the present. */}
                {(trimmedCounts[activeChatId] ?? 0) > 0 && (
                  <div className="flex items-center justify-center gap-2 pt-2">
                    <Info className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                    <p className="text-xs text-ink-low">
                      {trimmedCounts[activeChatId] === 1
                        ? "1 earlier message was removed to stay within this account's storage limit."
                        : `${trimmedCounts[activeChatId]} earlier messages were removed to stay within this account's storage limit.`}
                    </p>
                  </div>
                )}
                {messages.map((m, idx) => {
                  const isUser = m.role === "user";
                  const text = getMessageText(m);
                  const isLastMessage = idx === messages.length - 1;
                  const isStreamingAssistant =
                    !isUser && isLastMessage && isLoading;

                  const msgAttachments = (
                    m as { experimental_attachments?: Attachment[] }
                  ).experimental_attachments;

                  const pdfListForMessage = generatedPdfs[m.id] || [];
                  const isPromptExpanded = expandedPrompts.has(m.id);

                  return (
                    <div key={m.id || idx} className="space-y-2 group relative">
                      <div className="flex items-center justify-between text-xs font-semibold text-ink-low">
                        {isUser ? (
                          <div className="flex items-center justify-between w-full">
                            <span className="text-ink-mid">You</span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => togglePromptExpansion(m.id)}
                                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-ink-low hover:text-ink-hi flex items-center gap-1 text-[11px] font-normal cursor-pointer"
                                title={isPromptExpanded ? "Minimize" : "Expand"}
                              >
                                <ChevronDown
                                  className={`w-3.5 h-3.5 transition-transform duration-200 ${
                                    isPromptExpanded ? "" : "-rotate-90"
                                  }`}
                                />
                                <span>
                                  {isPromptExpanded ? "Minimize" : "Expand"}
                                </span>
                              </button>
                              {!isLoading && editingMessageId !== m.id && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingMessageId(m.id);
                                    setEditInputText(text);
                                  }}
                                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-ink-low hover:text-ink-hi flex items-center gap-1 text-[11px] font-normal cursor-pointer"
                                >
                                  <Edit2 className="w-3 h-3" />
                                  <span>Edit</span>
                                </button>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between w-full">
                            <div className="flex items-center gap-2 flex-wrap">
                              {/* The serif face is what marks this line as the
                                  assistant. It used to be amber as well, once
                                  per message — in a long thread that turned the
                                  accent into background texture, which is the
                                  opposite of what an accent is for. */}
                              <span className="text-ink-hi font-serif flex items-center gap-1.5 font-semibold">
                                <Sparkle className="w-3.5 h-3.5 text-ink-low fill-current" />
                                Omni-Claude
                              </span>
                              {m.route ? (
                                <ServedByBadge route={m.route} />
                              ) : (
                                <span className="text-[11px] text-ink-faint font-mono">
                                  {getCleanModelName(selectedModel)}
                                </span>
                              )}
                            </div>

                            {/* Save PDF, Export DOCX and Copy do the same kind of
                                thing — take this answer somewhere else — so they
                                look the same. They were amber, sky and grey,
                                which implied a hierarchy that does not exist.

                                They now also fade in on hover, like the controls
                                on a user message. Three bordered buttons above
                                every single reply meant a long thread was half
                                chrome; the answers are the content and the
                                export controls are available, not announced.
                                `md:` guarded, because a touch device has no
                                hover and would simply lose them. */}
                            {!isLoading && text && (
                              <div className="flex items-center gap-1.5 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                                <button
                                  type="button"
                                  onClick={() =>
                                    triggerServerPdfCompile(m.id, text)
                                  }
                                  disabled={generatingPdfId === m.id}
                                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-hover hover:bg-surface-active text-ink-mid hover:text-ink-hi border border-line cursor-pointer text-[10px] disabled:opacity-50 transition-colors"
                                >
                                  {generatingPdfId === m.id ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <Printer className="w-3 h-3" />
                                  )}
                                  <span>Save PDF</span>
                                </button>

                                <button
                                  type="button"
                                  onClick={() =>
                                    exportResponseToDOCX(m.id, text)
                                  }
                                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-hover hover:bg-surface-active text-ink-mid hover:text-ink-hi border border-line cursor-pointer text-[10px] transition-colors"
                                >
                                  <FileType className="w-3 h-3" />
                                  <span>Export DOCX</span>
                                </button>

                                <button
                                  type="button"
                                  title={
                                    copiedMessageId === m.id
                                      ? "Copied"
                                      : "Copy this answer"
                                  }
                                  onClick={() => handleCopyMessage(text, m.id)}
                                  className="flex items-center gap-1 px-2 py-1 rounded-lg bg-surface-hover hover:bg-surface-active text-ink-mid hover:text-ink-hi border border-line cursor-pointer text-[10px] transition-colors"
                                >
                                  {copiedMessageId === m.id ? (
                                    <Check className="w-3 h-3 text-positive" />
                                  ) : (
                                    <Copy className="w-3 h-3" />
                                  )}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {msgAttachments && msgAttachments.length > 0 && (
                        <div className="flex gap-2 flex-wrap my-2">
                          {msgAttachments.map((att, attIdx) => {
                            const isPdf = att.contentType === "application/pdf";
                            return (
                              <div
                                key={attIdx}
                                className="relative group rounded-xl overflow-hidden border border-line bg-surface-raised max-w-xs p-2 flex items-center gap-2"
                              >
                                {isPdf ? (
                                  <>
                                    <FileText className="w-5 h-5 text-ink-low shrink-0" />
                                    <span className="text-xs font-mono text-ink truncate">
                                      {att.name || "PDF Document"}
                                    </span>
                                  </>
                                ) : (
                                  /* eslint-disable-next-line @next/next/no-img-element */
                                  <img
                                    src={att.url}
                                    alt={att.name || "Attached image"}
                                    className="max-h-60 object-contain rounded-lg"
                                  />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Both roles used to get the same card: same fill, same
                          border, same 2xl shadow. In a long thread that gives
                          the eye nothing to scan by — you have to read the
                          label above each block to know who is speaking.
                          The answer is the page now, and only what the user
                          typed sits on a raised surface. */}
                      <div
                        className={`text-sm leading-relaxed ${
                          isUser
                            ? `rounded-2xl bg-surface-raised border border-line text-ink ${
                                !isPromptExpanded ? "p-3" : "p-5"
                              }`
                            : "text-ink py-1"
                        }`}
                      >
                        {!isUser && isStreamingAssistant && (m.stage || !text) && (
                          <div className="mb-4 inline-flex items-center gap-2.5 px-3.5 py-2 rounded-full bg-surface-hover border border-line">
                            <Loader2 className="w-3.5 h-3.5 text-accent animate-spin shrink-0" />
                            <span className="text-ink-mid font-mono text-xs font-medium tracking-wide">
                              {m.stageLabel || m.stage || "Analyzing request…"}
                            </span>
                          </div>
                        )}

                        {isUser && editingMessageId === m.id ? (
                          <div className="space-y-3">
                            <textarea
                              value={editInputText}
                              onChange={(e) => setEditInputText(e.target.value)}
                              className="w-full bg-surface-sunken border border-line rounded-xl p-3 text-xs text-ink-hi focus:outline-none focus:border-accent-line resize-y min-h-[80px]"
                            />
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setEditingMessageId(null)}
                                className="px-3 py-1.5 rounded-xl bg-surface-hover hover:bg-surface-active border border-line text-xs text-ink-mid hover:text-ink-hi font-medium cursor-pointer transition-colors"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => handleSaveEdit(m.id)}
                                disabled={isLoading || !editInputText.trim()}
                                className="px-3 py-1.5 rounded-xl bg-accent hover:bg-accent-hi border border-accent text-xs text-black font-semibold cursor-pointer disabled:opacity-40 transition-colors"
                              >
                                Save &amp; submit
                              </button>
                            </div>
                          </div>
                        ) : isUser && !isPromptExpanded ? (
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-xs text-ink-mid truncate font-medium">
                              {text.slice(0, 80)}
                              {text.length > 80 ? "…" : ""}
                            </span>
                            <button
                              type="button"
                              onClick={() => togglePromptExpansion(m.id)}
                              className="shrink-0 px-2 py-1 rounded-lg bg-surface-hover hover:bg-surface-active text-ink-mid hover:text-ink-hi text-[10px] font-medium cursor-pointer transition-colors"
                            >
                              View full
                            </button>
                          </div>
                        ) : (
                          <>
                            {isStreamingAssistant && !text && !m.stage ? (
                              <div className="flex items-center gap-2 text-ink-mid font-mono text-xs py-1">
                                <Loader2 className="w-4 h-4 animate-spin shrink-0 text-accent" />
                                <span>Generating response…</span>
                              </div>
                            ) : null}
                            {text ? (
                              /* `.md-body` carries the typography for rendered
                               * markdown — see globals.css. It lives on a
                               * wrapper rather than on <ReactMarkdown>, which
                               * dropped its `className` prop in v9. */
                              <div className="md-body">
                                <ReactMarkdown
                                  remarkPlugins={[remarkGfm]}
                                  components={{
                                    code({ className, children, ...props }: any) {
                                      const match = /language-(\w+)/.exec(
                                        className || "",
                                      );
                                      const isMultiline =
                                        String(children).includes("\n");
                                      if (match || isMultiline) {
                                        return (
                                          <CodeBlock
                                            language={match ? match[1] : ""}
                                            code={String(children).replace(
                                              /\n$/,
                                              "",
                                            )}
                                          />
                                        );
                                      }
                                      return (
                                        <code
                                          className="bg-surface-hover border border-line px-1.5 py-0.5 rounded-md text-ink-hi font-mono text-[0.85em]"
                                          {...props}
                                        >
                                          {children}
                                        </code>
                                      );
                                    },
                                  }}
                                >
                                  {text}
                                </ReactMarkdown>
                              </div>
                            ) : null}

                            {pdfListForMessage.length > 0 && (
                              <div className="mt-4 space-y-2">
                                {pdfListForMessage.map((pdf, pIdx) => (
                                  <PdfDownloadCard
                                    key={pIdx}
                                    title={pdf.title}
                                    pdfUrl={pdf.pdfUrl}
                                    fileName={pdf.fileName}
                                  />
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>

                      {m.notices && m.notices.length > 0 && (
                        <div className="space-y-1.5 pt-1">
                          {m.notices.map((n, nIdx) => (
                            <FailoverNoticeRow key={nIdx} notice={n} />
                          ))}
                        </div>
                      )}

                      {m.toolCalls && m.toolCalls.length > 0 && (
                        <div className="flex items-center gap-1.5 pt-1 flex-wrap">
                          {m.toolCalls.map((tc, tIdx) => (
                            <span
                              key={tIdx}
                              className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-surface-raised border border-line text-[11px] font-mono text-ink-mid"
                            >
                              <Globe className="w-3 h-3 text-ink-low" />
                              <span>Tool used: {tc}</span>
                            </span>
                          ))}
                        </div>
                      )}

                      {m.budget && m.budget.used > 0 && (
                        <div className="flex items-center gap-1.5 pt-1 flex-wrap">
                          <span
                            className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-surface-raised border border-line text-[10px] font-mono text-ink-low"
                            title={
                              m.budget.reason
                                ? `Budget extended: ${m.budget.reason}`
                                : "Rounds used / current budget. The budget grows when edits land."
                            }
                          >
                            round {m.budget.used}/{m.budget.limit}
                            {m.budget.extendedBy
                              ? ` (+${m.budget.extendedBy})`
                              : ""}
                          </span>
                          {m.task && (
                            <span
                              className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-surface-raised border border-line text-[10px] font-mono text-ink-low"
                              title={m.task.file}
                            >
                              {m.task.resumed ? "resumed" : "task"} ·{" "}
                              {m.task.status}
                            </span>
                          )}
                        </div>
                      )}

                      {m.skills && <SkillRunSummary report={m.skills} />}

                      {m.reviews && m.reviews.length > 0 && (
                        <div className="space-y-1.5 pt-1">
                          {m.reviews.map((r) => (
                            <ReviewVerdictCard key={r.cycle} review={r} />
                          ))}
                        </div>
                      )}

                      {m.plan && (
                        <PlanApprovalCard
                          plan={m.plan}
                          onApprove={handleApprovePlan}
                          onRevise={handleRevisePlan}
                        />
                      )}

                      {m.error && (
                        <div className="flex items-center gap-2 p-3 rounded-xl bg-danger-soft border border-danger-line text-danger text-xs mt-2">
                          <AlertCircle className="w-4 h-4 shrink-0" />
                          <span>{m.error}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
                <div ref={chatBottomRef} />
              </div>
            )}

            {/* The fade under the composer has to match the pane it sits on.
                It was faded to zinc-950 while the pane behind it is
                surface-base, so the last line of every long answer passed
                through a band of the wrong colour on its way out of view. */}
            {messages.length > 0 && (
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-surface-base via-surface-base/95 to-transparent pt-8 pb-5 px-4 z-20 pointer-events-none">
                <div className="max-w-3xl mx-auto w-full pointer-events-auto">
                  {renderInputForm()}
                </div>
              </div>
            )}
          </>
          )}
          </div>
        </div>
      </div>

      <BackupsPanel
        isOpen={isBackupsPanelOpen}
        onClose={() => setIsBackupsPanelOpen(false)}
        workspacePath={workspacePath}
      />

      <SettingsPanel
        isOpen={isSettingsPanelOpen}
        onClose={() => setIsSettingsPanelOpen(false)}
        onSave={(newSettings) => {
          setRoundSettings(newSettings);
          console.log("Round settings updated:", newSettings);
        }}
        onProviderChange={handleProvidersUpdated}
        modelCatalog={modelCatalog}
        onRoleModelsSave={setRoleModels}
      />

      <GatewaySetupWizard
        isOpen={isGatewayWizardOpen}
        onClose={() => setIsGatewayWizardOpen(false)}
        onConnected={handleProvidersUpdated}
      />

      <SubscriptionPanel
        isOpen={isSubscriptionPanelOpen}
        onClose={() => setIsSubscriptionPanelOpen(false)}
        userEmail={userEmail}
        authToken={authToken}
        onTierChange={(tier) => {
          /* Keep the cached user in step with a tier change made inside the
             panel, so the rest of the UI does not keep showing FREE after a
             successful upgrade until the next reload. */
          setCurrentUser((prev) => {
            if (!prev || prev.tier === tier) return prev;
            const next = { ...prev, tier };
            try {
              localStorage.setItem('user', JSON.stringify(next));
            } catch {
              /* Cache only. */
            }
            return next;
          });
        }}
      />

      <AdminPanel
        isOpen={isAdminPanelOpen}
        onClose={() => setIsAdminPanelOpen(false)}
        authToken={authToken}
      />

      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        onSuccess={handleAuthSuccess}
      />

      <ConnectEditorPanel
        isOpen={isConnectEditorOpen}
        onClose={() => setIsConnectEditorOpen(false)}
      />

      <SkillsPanel
        isOpen={isSkillsOpen}
        onClose={() => setIsSkillsOpen(false)}
      />

      <FileAccessPanel
        isOpen={isFileAccessOpen}
        onClose={() => setIsFileAccessOpen(false)}
      />

      <ProjectsPanel
        isOpen={isProjectsOpen}
        onClose={() => setIsProjectsOpen(false)}
      />

      {isUserGuideOpen && (
        <UserGuide onClose={() => setIsUserGuideOpen(false)} />
      )}
    </div>
  );
}
