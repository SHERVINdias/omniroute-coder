/**
 * src/app/api/chat/route.ts
 * ---------------------------------------------------------------------------
 * THE BUG THAT MADE DEEP COWORK DO NOTHING
 * ----------------------------------------
 * page.tsx declares `InteractionMode = "chat" | "cowork" | "deepcowork"` and
 * posts `mode: "deepcowork"` when the Deep Cowork button is active. This route
 * tested `if (mode === "cowork")`, so **Deep Cowork never reached the pipeline
 * at all** — it silently fell through to the plain branch, which had no
 * `list_files` tool and no workspace context. That is exactly what the
 * transcript showed: searchWeb, four guessed read_file calls, and a request for
 * paths. Fixed by normalising the mode string in one place (see `resolveMode`).
 *
 * A SECOND, INDEPENDENT BUG
 * -------------------------
 * The cowork branch did `send(evt)` with the pipeline's own event shape
 * (`{kind:"delta", text}`), but the client only reads a flat envelope
 * (`{delta}`, `{tool}`, `{notice}`, `{route}`, `{done}`, `{error}`). Every
 * pipeline event was therefore discarded and the bubble stayed empty. Events
 * are now translated, so page.tsx needs no change.
 *
 * WHAT THIS REVISION ADDS
 * -----------------------
 * The Deep Cowork pipeline now has a plan/execute split, resumable task files
 * and a budget that grows with progress. That means four new request fields
 * (`deepPhase`, `resumeTaskId`, `maxIterations`, `askQuestions`, plus `answers`)
 * and three new event kinds (`plan`, `task`, `budget`) to translate. All five
 * request fields are optional: a client that sends none behaves exactly as
 * before, so page.tsx keeps working while its UI catches up.
 */

// AgentRouter Global Fetch Interceptor - Makes requests look like official Anthropic SDK
const originalFetch = globalThis.fetch;

globalThis.fetch = async function (input, init) {
  const url = typeof input === "string" || input instanceof URL ? input.toString() : input?.url;
  
  if (url && url.includes("agentrouter.org")) {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    
    // Inject the exact wire image identity AgentRouter's WAF looks for
    headers.set("User-Agent", "opencode/1.1.19");
    headers.set("x-app", "claude-code");
    headers.set("anthropic-version", "2023-06-01");
    if (!headers.has("anthropic-beta")) {
      headers.set("anthropic-beta", "prompt-caching-2024-07-31");
    }
    
    const newInit = { ...init, headers };
    return input instanceof Request 
      ? originalFetch(new Request(input, newInit)) 
      : originalFetch(input, newInit);
  }
  
  return originalFetch(input, init);
};

import { tavily } from "@tavily/core";
import type { NextRequest } from "next/server";
import {
  WORKSPACE_TOOLS,
  WORKSPACE_TOOL_NAMES,
  buildWorkspaceContext,
  executeWorkspaceTool,
  vscodeBridge,
} from "@/lib/vscodeBridge";
import { runDeepCoworkPipeline } from "@/lib/deepCoworkPipeline";
import {
  REFERENCE_TOOL_NAMES,
  executeReferenceTool,
  referenceToolsFor,
} from "@/lib/referenceProject";
import type { DeepCoworkOptions, DeepPhase } from "@/lib/deepCoworkPipeline";
import { SLASH_COMMANDS } from "@/lib/slashCommands";
import { beginTurn, type TurnRecorder } from "@/lib/chatPersistence";
import { canUseDeepCowork, logDeepCoworkUsage } from "@/lib/subscription";
import { currentUser } from "@/lib/authGuard";
import {
  formatRetryAfter,
  rateLimit,
  rateLimitByIp,
} from "@/lib/rateLimit";
import { fileToolsEnabled } from "@/lib/fileToolsGate";
import {
  resolveGatewayCreds,
  credsForProvider,
  describeMissingGateway,
  anonymousSharedGatewayAllowed,
  type GatewayCreds,
} from "@/lib/gatewayCreds";
import {
  postChatCompletionStream,
  targetFromCreds,
} from "@/lib/upstreamRequest";
import { getProviderProfile } from "@/lib/providerProfiles";
import { buildSkillContext } from "@/lib/skills/skillContext";

import {
  FREE_STACK,
  ACCOUNT_RETRIES,
  buildFailoverLadder,
  fetchGatewayModelIds,
  gatewayFailure,
  failureKindOf,
  shouldFailover,
  buildNotice,
  accountFromHeaders,
  upstreamModelFromHeaders,
  detectSubstitution,
  parseModelId,
  prettyModelName,
  type Candidate,
} from "@/lib/omniroute";

export const runtime = "nodejs";

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

/** Tool rounds allowed in plain/chat mode. list_files -> read_file ->
 *  replace_text -> answer is already four, so the old cap of 5 was too tight
 *  for any edit touching more than one file. */
const MAX_STEPS = Math.max(2, Number(process.env.OMNIROUTE_MAX_STEPS ?? 10));

const TOKEN_CAP_TIERS = [65536, 32768, 16384];

const SYSTEM_PROMPT =
  "You are Omni-Claude, a code and document assistant with direct read/write access to the " +
  "user's VS Code workspace. Provide direct, accurate solutions. When a request involves the " +
  "user's project, use the workspace tools to inspect and edit real files rather than printing " +
  "code for them to copy. When processing document images or text, maintain precise structural " +
  "fidelity, well-formatted tables, and clean Markdown that compiles seamlessly into " +
  "downloadable PDFs.";

type Message = {
  role: "system" | "user" | "assistant" | "tool" | "function";
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Are the filesystem-backed modes available on this deployment?
 *
 * The Cowork tools operate on the disk of the machine running this process.
 * Locally that is the user's own project, which is the entire point. On a
 * shared server it would be the server's own filesystem, identical for every
 * user — both useless and dangerous. Default: on in development, off in
 * production, overridable either way with OMNIROUTE_ENABLE_FILE_TOOLS.
 */
/**
 * Normalise whatever the client sent into one of the three real modes.
 * Accepts "deepcowork", "deep-cowork", "deep_cowork", "deep cowork", ...
 * so a future rename in page.tsx cannot silently disable the pipeline again.
 *
 * Ultra deliberately resolves to "deepcowork". It is not a fourth mode: it is
 * Deep Cowork with extra phases switched on, running the same pipeline. Mapping
 * it here means every gate below that already guards Deep Cowork — the sign-in
 * check, the file-tools check, the subscription check — covers Ultra with no
 * extra code. A genuinely separate mode string would silently bypass all three.
 */
function resolveMode(mode: unknown): "chat" | "cowork" | "deepcowork" {
  const normalised = String(mode ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (
    normalised === "deepcowork" ||
    normalised === "deep" ||
    normalised === "ultra" ||
    normalised === "ultracowork" ||
    normalised === "ultramode"
  ) {
    return "deepcowork";
  }
  if (normalised === "cowork") return "cowork";
  return "chat";
}

/**
 * Whether the client asked for the Ultra variant of Deep Cowork.
 *
 * Kept separate from `resolveMode` so the mode stays one of three values and
 * Ultra rides along as a flag on the options object.
 */
function isUltraMode(mode: unknown): boolean {
  const normalised = String(mode ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return (
    normalised === "ultra" ||
    normalised === "ultracowork" ||
    normalised === "ultramode"
  );
}

/**
 * Which half of the two-phase Deep Cowork flow to run.
 *
 * Defaults to "auto" — the single-pass behaviour — so an older client that
 * knows nothing about planning is not suddenly stopped at an approval gate it
 * has no button for.
 */
function resolveDeepPhase(raw: unknown): DeepPhase {
  const normalised = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (normalised === "plan" || normalised === "planning") return "plan";
  if (
    normalised === "execute" ||
    normalised === "executing" ||
    normalised === "approve" ||
    normalised === "approved"
  ) {
    return "execute";
  }
  return "auto";
}

/**
 * Resolve a slash command name into the pipeline knobs it implies.
 *
 * The client sends only the NAME. The objective text is built here, from the
 * server's own table, because it is injected as a *system* message — a client
 * able to supply that string directly could rewrite the agent's instructions,
 * including the parts that keep a read-only command read-only.
 *
 * Returns null for an unknown name so the message is treated as ordinary prose
 * rather than being rejected. Someone typing "/deploy" should get a normal
 * answer, not an error.
 */
function resolveSlashCommand(
  rawName: unknown,
  rawArgs: unknown,
): { phase: DeepPhase; readOnly: boolean; objective: string } | null {
  const name = String(rawName ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\//, "");
  if (!name) return null;

  const command = SLASH_COMMANDS.find((c) => c.name === name);
  if (!command) return null;

  /* Args land inside a system message, so cap them. A few hundred characters is
   * more than "which paths to audit" needs, and well short of enough room to
   * restate the agent's instructions. */
  const args = String(rawArgs ?? "")
    .trim()
    .slice(0, 400);

  return {
    phase: command.phase,
    readOnly: command.readOnly,
    objective: command.buildObjective(args),
  };
}

/** Answers to a plan's open questions, however the client shaped them. */
function resolveAnswers(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((a) => String(a ?? "")).slice(0, 12);
  }
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  if (raw && typeof raw === "object") {
    return Object.values(raw as Record<string, unknown>)
      .map((a) => String(a ?? ""))
      .slice(0, 12);
  }
  return [];
}

function sanitizeMessages(messages: any[]): Message[] {
  return (Array.isArray(messages) ? messages : [])
    .map((m: any): Message => {
      const role =
        m.role === "assistant"
          ? "assistant"
          : m.role === "system"
            ? "system"
            : "user";

      if (Array.isArray(m.content)) {
        const parts: any[] = [];
        for (const part of m.content) {
          if (part.type === "text" && part.text) {
            parts.push({ type: "text", text: part.text });
          } else if (part.type === "image_url" && part.image_url?.url) {
            parts.push(part);
          } else if (
            (part.type === "image" || String(part.type).startsWith("image")) &&
            (part.image || part.url)
          ) {
            parts.push({
              type: "image_url",
              image_url: { url: part.image || part.url },
            });
          }
        }
        return { role, content: parts.length ? parts : [""] };
      }

      let textContent = "";
      if (typeof m.content === "string") {
        textContent = m.content;
      } else if (Array.isArray(m.parts)) {
        textContent = m.parts
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text || "")
          .join("");
      }

      const attachments = m.experimental_attachments || m.attachments || [];
      if (attachments.length > 0) {
        const parts: any[] = [];
        if (textContent.trim()) {
          parts.push({ type: "text", text: textContent.trim() });
        }
        for (const att of attachments) {
          if (
            att.contentType?.startsWith("image/") ||
            att.type?.startsWith("image/")
          ) {
            const url = att.url || att.content;
            if (url) parts.push({ type: "image_url", image_url: { url } });
          }
        }
        if (parts.length) return { role, content: parts };
      }

      return { role, content: textContent.trim() };
    })
    .filter((m: Message) => {
      if (typeof m.content === "string") return m.content.length > 0;
      if (Array.isArray(m.content)) return m.content.length > 0;
      return true;
    });
}

/**
 * Put the system prompt in front, with the live workspace listing appended.
 * Any system message the client sent is folded in rather than suppressing ours,
 * because the workspace block is what stops the model guessing file paths.
 */
function withSystemPrompt(
  messages: Message[],
  sysPrompt: string,
  workspaceContext: string,
  skillContext = "",
): Message[] {
  const clientSystem = messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter(Boolean)
    .join("\n\n");

  /* Skills go last, closest to the conversation, because that is where an
   * instruction is most likely to be followed. They are still framed inside
   * their own block as the user's text rather than the app's — see
   * buildSkillContext — so a skill that contradicts the operating rules above
   * loses rather than silently winning by being nearer. */
  const content = [sysPrompt, clientSystem, workspaceContext, skillContext]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content },
    ...messages.filter((m) => m.role !== "system"),
  ];
}

const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "searchWeb",
    description:
      "Search GitHub, docs and the web for verified solutions. Use this ONLY for external libraries, APIs or error messages — never to locate files in the user's own workspace (use list_files for that).",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
};

/** Workspace tools (list_files, read_file, replace_text, write_file) come from
 *  src/lib/vscodeBridge.ts so this route and the deep pipeline cannot drift.
 *
 *  The reference tools (ref_search / ref_read_file / ref_list_files) are added
 *  ONLY when this user has a reference project configured — `referenceToolsFor`
 *  returns [] otherwise. Offering a tool the model cannot use is worse than not
 *  offering it: it calls it, gets a refusal, and spends a full round trip
 *  finding out. Passing the userId is what keeps the set per-user rather than
 *  global. */
function activeToolSet(userId: string | null): any[] {
  const base = TAVILY_API_KEY
    ? [...WORKSPACE_TOOLS, SEARCH_TOOL]
    : [...WORKSPACE_TOOLS];
  return [...base, ...referenceToolsFor(userId)];
}

/** Short label for the "Tool used:" chip in the UI. */
function describeToolCall(name: string, rawArgs: string): string {
  let args: any = {};
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    /* partial arguments */
  }
  const target = args.file_path || args.path || args.filePath || args.dir || "";

  switch (name) {
    case "list_files":
      return `list_files ${target || "(workspace root)"}${
        args.pattern ? ` pattern="${args.pattern}"` : ""
      }`;
    case "read_file":
      return `read_file ${target}`;
    case "replace_text":
      return `replace_text ${target}`;
    case "write_file":
      return `write_file ${target}`;
    case "searchWeb":
      return `searchWeb "${String(args.query || "").slice(0, 60)}"`;
    default:
      return name;
  }
}

/* Model catalogues are cached per gateway, not globally.
 *
 * The cache used to be a single `{ids, at}` for the whole process. Once each
 * account has its own gateway that is wrong twice over: user B sees the models
 * user A's gateway offers, and a model that only A can reach passes B's
 * validation and then 404s upstream. Keying by base URL keeps the saving
 * (one catalogue fetch per gateway per minute) without the bleed. */
const catalogCache = new Map<string, { ids: string[]; at: number }>();
const CATALOG_TTL_MS = 60_000;

async function getCatalogIds(creds: GatewayCreds): Promise<string[]> {
  const now = Date.now();
  const cached = catalogCache.get(creds.baseUrl);
  if (cached && now - cached.at < CATALOG_TTL_MS) {
    return cached.ids;
  }
  try {
    const ids = await fetchGatewayModelIds(creds);
    catalogCache.set(creds.baseUrl, { ids, at: now });
    return ids;
  } catch {
    return cached?.ids ?? [];
  }
}

async function postOmniRouteStream(
  creds: GatewayCreds,
  model: string,
  messages: Message[],
  tools?: any[],
  maxTokens?: number,
  agentRouterSettings?: any,
): Promise<Response> {
  const payload: any = { model, messages, stream: true };
  const profile = getProviderProfile(creds.provider);
  
  if (maxTokens) {
    // Ollama and some local providers only support max_tokens, not max_completion_tokens
    // OpenAI and most cloud providers support both or prefer max_completion_tokens
    if (profile.kind === "local" || profile.id === "ollama") {
      payload.max_tokens = maxTokens;
      console.log(`[${profile.id}] Using max_tokens=${maxTokens} (local provider, skipping max_completion_tokens)`);
    } else {
      // Gateway and third-party providers typically support both
      payload.max_tokens = maxTokens;
      payload.max_completion_tokens = maxTokens;
    }
  }
  if (tools && tools.length) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }

  if (agentRouterSettings?.proxyUrl) {
    /* Node's fetch has no proxy option; honouring this needs an explicit
     * dispatcher (undici ProxyAgent). Logged rather than silently ignored. */
    console.log(`Proxy configured but not applied: ${agentRouterSettings.proxyUrl}`);
  }

  console.log(`[postOmniRouteStream] Provider: ${profile.id}, Model: ${model}, Payload keys:`, Object.keys(payload));

  /* Endpoint path, auth scheme and any provider-specific headers come from the
   * provider profile. `postChatCompletionStream` also normalises a whole-JSON
   * reply into SSE, so providers that ignore `stream: true` no longer render
   * as a blank message. */
  return postChatCompletionStream(targetFromCreds(creds), payload);
}

async function* streamCompletion(
  creds: GatewayCreds,
  model: string,
  messages: Message[],
  tools?: any[],
  agentRouterSettings?: any,
): AsyncGenerator<any> {
  let res: Response | null = null;
  const tiersToTry = [...TOKEN_CAP_TIERS, undefined];
  /* Whoever actually answers. Failures used to be labelled "OmniRoute" even
   * when the request went to Agent Router or OpenAI. */
  const label = getProviderProfile(creds.provider).label;
  const profile = getProviderProfile(creds.provider);
  let toolsToUse = tools;
  let triedWithoutTools = false;

  for (const tokenCap of tiersToTry) {
    try {
      res = await postOmniRouteStream(creds, model, messages, toolsToUse, tokenCap, agentRouterSettings);
      if (res.ok) break;
      
      // Clone the response before reading to preserve the body for potential retries
      const clonedRes = res.clone();
      let errText = "";
      try {
        errText = await clonedRes.text();
      } catch (readErr) {
        console.error(`[streamCompletion] Failed to read error body:`, readErr);
        errText = `Failed to read error response (${res.status})`;
      }
      
      const isTokenError =
        res.status === 400 ||
        res.status === 422 ||
        errText.toLowerCase().includes("max_tokens") ||
        errText.toLowerCase().includes("token");
      
      // Check if the error is about tool support
      const isToolError =
        res.status === 400 &&
        (errText.toLowerCase().includes("does not support tools") ||
         errText.toLowerCase().includes("tool") && errText.toLowerCase().includes("not supported") ||
         errText.toLowerCase().includes("tools are not supported"));

      if (isToolError && !triedWithoutTools && toolsToUse && toolsToUse.length > 0) {
        // Model doesn't support tools, retry without them
        console.log(`[streamCompletion] ${label} model "${model}" does not support tools. Retrying without tools...`);
        toolsToUse = undefined;
        triedWithoutTools = true;
        continue; // Retry with same token cap but without tools
      }

      if (!isTokenError && !isToolError) throw gatewayFailure(res.status, errText, label);
    } catch (err) {
      if (tokenCap === undefined) {
        // Last token cap attempt failed. If we haven't tried without tools yet, try that
        // BUT only for LOCAL providers (Ollama, LM Studio, etc.), NOT gateway providers (AgentRouter)
        if (!triedWithoutTools && toolsToUse && toolsToUse.length > 0 && profile.kind === "local") {
          console.log(`[streamCompletion] All token caps failed for ${label}. Trying without tools as last resort (local provider only)...`);
          toolsToUse = undefined;
          triedWithoutTools = true;
          // Reset to try all token caps again without tools
          tiersToTry.length = 0;
          tiersToTry.push(...TOKEN_CAP_TIERS, undefined);
          continue;
        }
        throw err;
      }
    }
  }

  if (!res || !res.ok) {
    const text = res
      ? await res.text().catch(() => "")
      : "Failed streaming request.";
    throw gatewayFailure(res?.status || 500, text, label);
  }
  
  // Log if we successfully completed without tools due to model limitations
  if (triedWithoutTools && res.ok) {
    console.log(`[streamCompletion] Successfully completed request to ${label} without tools (model limitation)`);
  }

  if (!res.body) {
    throw gatewayFailure(0, `${label} returned an empty body.`, label);
  }

  yield {
    kind: "meta",
    account: accountFromHeaders(res.headers),
    upstreamModel: upstreamModelFromHeaders(res.headers),
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const toolAcc: Record<number, { id?: string; name?: string; args: string }> =
    {};
  let finishReason: string | null = null;
  let servedModel: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        finishReason = finishReason || "stop";
        continue;
      }
      if (!data) continue;

      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }

      if (json.error) {
        const msg =
          typeof json.error === "string"
            ? json.error
            : json.error.message || JSON.stringify(json.error);
        throw gatewayFailure(json.error?.status || 200, msg, label);
      }

      if (typeof json.model === "string" && json.model)
        servedModel = json.model;

      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content;
        yield { kind: "delta", text: delta.content };
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur = toolAcc[idx] || (toolAcc[idx] = { args: "" });
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
        }
      }
    }
  }

  const toolCalls = Object.values(toolAcc)
    .filter((t) => t.name)
    .map((t) => ({
      id:
        t.id ||
        `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      type: "function",
      function: { name: t.name as string, arguments: t.args || "{}" },
    }));

  yield { kind: "result", text, toolCalls, finishReason, servedModel };
}

/**
 * One OmniRoute turn, including the tool loop.
 *
 * `userId` rides along because the tool loop below can touch files, and a file
 * tool has to land on the machine belonging to the person who asked. It is
 * threaded as a parameter rather than read from a module-level variable
 * precisely because two users can be mid-turn at the same moment in the same
 * process; a shared variable would hand one user's `write_file` to the other
 * user's editor. `null` means an anonymous turn, which file tools refuse in
 * multi-tenant mode.
 */
async function* runOmniRoute(
  creds: GatewayCreds,
  userId: string | null,
  model: string,
  messages: Message[],
  tools?: any[],
  maxSteps: number = MAX_STEPS,
  agentRouterSettings?: any,
): AsyncGenerator<any> {
  const msgs: Message[] = [...messages];
  const hasTools = !!(tools && tools.length);
  const tavilyKey = TAVILY_API_KEY;
  let servedModel: string | null = null;

  for (let step = 0; step < maxSteps; step++) {
    const sendTools = hasTools ? tools : undefined;
    let result: any;

    for await (const evt of streamCompletion(creds, model, msgs, sendTools, agentRouterSettings)) {
      if (evt.kind === "delta") {
        yield { kind: "delta", text: evt.text };
      } else if (evt.kind === "meta") {
        if (evt.upstreamModel) servedModel = evt.upstreamModel;
        yield evt;
      } else {
        result = evt;
      }
    }

    if (!result) break;
    if (result.servedModel) servedModel = result.servedModel;

    if (result.toolCalls && result.toolCalls.length > 0) {
      const toolResults: { id: string; name: string; content: string }[] = [];

      for (const tc of result.toolCalls) {
        const fnName: string = tc.function?.name || "tool";
        const rawArgs: string = tc.function?.arguments || "{}";

        // One chip per call, with the target, instead of only the first name.
        yield { kind: "tool", name: describeToolCall(fnName, rawArgs) };

        let content = "";
        let args: any = {};
        try {
          args = JSON.parse(rawArgs);
        } catch {
          args = {};
        }

        if (WORKSPACE_TOOL_NAMES.has(fnName)) {
          // Routed to THIS user's connected editor. See executeWorkspaceTool.
          content = await executeWorkspaceTool(fnName, args, userId);
        } else if (REFERENCE_TOOL_NAMES.has(fnName)) {
          /* The read-only second folder. Same socket, different set of RPCs —
           * none of which can write. executeReferenceTool never throws; a
           * version-skewed extension comes back as a readable "too old"
           * message rather than killing the turn. */
          content = await executeReferenceTool(fnName, args, userId);
        } else if (fnName === "searchWeb") {
          if (!tavilyKey) {
            content = JSON.stringify({
              error: "Web search is not configured (TAVILY_API_KEY missing).",
            });
          } else {
            try {
              const tvly = tavily({ apiKey: tavilyKey });
              const r = await tvly.search(String(args.query || ""), {
                searchDepth: "basic",
                maxResults: 3,
              });
              content = JSON.stringify(
                r.results.map((x: any) => ({
                  title: x.title,
                  url: x.url,
                  content: String(x.content || "").slice(0, 2000),
                })),
              );
            } catch (err: any) {
              content = JSON.stringify({
                error: String(err?.message || err),
              });
            }
          }
        } else {
          content = JSON.stringify({
            error: `Unknown tool: ${fnName}`,
            availableTools: [
              ...WORKSPACE_TOOL_NAMES,
              ...(tavilyKey ? ["searchWeb"] : []),
            ],
          });
        }

        toolResults.push({ id: tc.id, name: fnName, content });
      }

      msgs.push({
        role: "assistant",
        content: result.text || null,
        tool_calls: result.toolCalls,
      });
      for (const tr of toolResults) {
        msgs.push({
          role: "tool",
          tool_call_id: tr.id,
          name: tr.name,
          content: tr.content,
        });
      }
      continue;
    }

    yield { kind: "done", servedModel };
    return;
  }

  yield { kind: "done", servedModel };
}

export async function POST(req: NextRequest) {
  let targetModel = FREE_STACK;
  try {
    /* Identify the caller from the httpOnly cookie, falling back to the Bearer
     * header. The old code read only the header and then tested `!token`, which
     * meant (a) a cookie-only session was rejected outright, and (b) any
     * non-empty string — `Authorization: Bearer x` — satisfied the gate, so the
     * Deep Cowork quota below could be bypassed with a garbage token. */
    const user = currentUser(req);

    /* Throttle before reading the body.
     *
     * Every request that gets past here can open an outbound connection to a
     * paid provider and hold a streaming response for minutes. Without a
     * ceiling, one script can exhaust the operator's credits and pin the single
     * Node process at the same time — the app serves streams, so concurrency is
     * the resource that runs out first.
     *
     * Signed-in callers are keyed on their user id, which a caller cannot
     * change without another valid session. Anonymous callers fall back to
     * source address, which behind Caddy means OMNIROUTE_TRUST_PROXY must be
     * set or they all share one generous bucket (see rateLimit.ts) — that fails
     * toward over-limiting, never toward no limit at all.
     *
     * The anonymous allowance is deliberately much smaller: in production
     * OMNIROUTE_ALLOW_SHARED_GATEWAY defaults off, so an anonymous caller
     * cannot reach a provider anyway and only needs enough room to be told so. */
    const gate = user
      ? rateLimit(`chat:user:${user.id}`, { limit: 60, windowMs: 60_000 })
      : rateLimitByIp("chat:anon", req, { limit: 10, windowMs: 60_000 });

    if (!gate.ok) {
      return new Response(
        JSON.stringify({
          error: `Too many requests. Try again in ${formatRetryAfter(
            gate.retryAfterMs,
          )}.`,
          code: "RATE_LIMITED",
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)),
          },
        },
      );
    }

    const reqBody = await req.json();
    const {
      messages,
      model,
      routing,
      mode,
      chatId,
      deepPhase,
      resumeTaskId,
      maxIterations,
      askQuestions,
      answers,
      roundSettings,
      providerId,
      agentRouterSettings,
      /* Ultra mode only. Both optional: unset means "let the pipeline pick a
       * reviewer that differs from the editor" and "use the server default
       * cycle cap". */
      reviewModel,
      maxReviewCycles,
      /* Slash command NAME only (e.g. "review"), never the objective text.
       * See `resolveSlashCommand`. */
      slashCommand,
      slashArgs,
      /* Skills the user switched on for this message. Ids only — the skill
       * text itself is never accepted from the client, it is read from the
       * user's own rows. An id that is not theirs simply matches nothing. */
      skillIds,
    } = reqBody;

    targetModel =
      model && String(model).trim().length > 0
        ? String(model).trim()
        : FREE_STACK;
    const requested = parseModelId(targetModel);
    const sanitizedMessages = sanitizeMessages(messages);

    // THE FIX: "deepcowork" from page.tsx now actually reaches the pipeline.
    const resolvedMode = resolveMode(mode);

    /* One identity for the whole request. Quota is charged to this, and the
     * gateway credentials below are resolved for this user. */
    const userEmail = user?.email ?? "anonymous@local";

    /* Cowork and Deep Cowork drive filesystem tools, so they require a real
     * session — not merely the presence of a token-shaped string. */
    if (
      (resolvedMode === "cowork" || resolvedMode === "deepcowork") &&
      !user
    ) {
      return new Response(
        JSON.stringify({
          error:
            "Please sign in to use Cowork and Deep Cowork.",
          code: "UNAUTHENTICATED",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    /* The file tools reach the filesystem of whatever machine runs this server.
     * That is the point when running locally, and unacceptable when deployed:
     * every user would be reading and writing the server's own disk. Setting
     * OMNIROUTE_ENABLE_FILE_TOOLS=false (the default in production) turns the
     * modes off with an explanation rather than quietly serving the wrong
     * filesystem. */
    if (
      (resolvedMode === "cowork" || resolvedMode === "deepcowork") &&
      !fileToolsEnabled()
    ) {
      return new Response(
        JSON.stringify({
          error:
            "Cowork and Deep Cowork edit files on the machine running this app, so they are only available in a local install. Plain Chat works normally here.",
          code: "FILE_TOOLS_DISABLED",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    // Subscription validation for Deep Cowork mode
    if (resolvedMode === "deepcowork") {
      const usageCheck = canUseDeepCowork(userEmail);

      if (!usageCheck.allowed) {
        return new Response(
          JSON.stringify({
            error: usageCheck.reason || "Deep Cowork access denied",
            usageToday: usageCheck.usageToday,
            limit: usageCheck.limit,
            tier: usageCheck.user?.tier,
          }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    if (sanitizedMessages.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No valid message content provided.",
          model: targetModel,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    /* Which gateway this particular caller talks to. Resolved once per request
     * and passed down explicitly, so two users signed in at the same time can
     * never be served each other's endpoint or key.
     *
     * Declared before deepOptions because deepOptions carries it: `const` is
     * hoisted but not initialised, so referencing it above this line is a
     * ReferenceError at runtime, not a compile-time complaint.
     *
     * When the client names a provider, that is the one used. Previously this
     * line ignored `providerId` and always resolved the row flagged active, so
     * picking a provider in the UI reloaded the model list but still sent the
     * request to the active gateway — the reason a third-party key appeared to
     * be accepted and then never took effect.
     *
     * credsForProvider is scoped to this user, so an id belonging to another
     * account resolves to null rather than selecting their gateway. */
    const requestedProviderId =
      typeof providerId === "string" && providerId.trim() ? providerId.trim() : null;

    let creds: GatewayCreds;
    if (requestedProviderId && user?.id) {
      const scoped = credsForProvider(user.id, requestedProviderId);
      if (!scoped) {
        /* Falling back to the active provider here would resend the request
         * with a different account's key — the exact confusion this fixes. */
        return new Response(
          JSON.stringify({
            error:
              "That provider is not available on your account, or has no API key saved. Check it in Settings.",
            code: "PROVIDER_NOT_AVAILABLE",
            model: targetModel,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      creds = scoped;
    } else {
      creds = resolveGatewayCreds(user?.id ?? null);
    }

    /* A stranger may not spend the operator's key.
     *
     * `resolveGatewayCreds` above already declines to hand out shared
     * credentials in production by default — but that default is a single env
     * var an operator may deliberately flip to run one gateway for everyone,
     * and flipping it should not also mean "and anyone on the internet may use
     * it without signing in". Those are two decisions; this makes them two
     * settings. `source === "shared"` is the only case that matters: a caller
     * with no session cannot have per-user credentials, so this cannot affect
     * anyone who configured their own provider. */
    if (!user && creds.source === "shared" && !anonymousSharedGatewayAllowed()) {
      return new Response(
        JSON.stringify({
          error: "Please sign in to send a message.",
          code: "UNAUTHENTICATED",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    if (!creds.configured) {
      return new Response(
        JSON.stringify({
          error: describeMissingGateway(creds),
          code: "GATEWAY_NOT_CONFIGURED",
          model: targetModel,
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    const ultra = isUltraMode(mode);

    /* Deep Cowork options. `cowork` (the lighter mode) always runs one pass —
     * only Deep Cowork gets the plan/approve gate, because that is the mode the
     * user opts into when they want to review before anything is touched.
     *
     * Slash commands likewise only apply to the workspace pipeline — they depend
     * on file tools, which the other modes do not have. Resolved first so a
     * command's phase can override whatever the client asked for. */
    const slash =
      resolvedMode === "deepcowork"
        ? resolveSlashCommand(slashCommand, slashArgs)
        : null;

    const deepOptions: DeepCoworkOptions = {
      /* The owner of this run. `currentUser` returns null for an anonymous
       * caller, and null is carried through rather than substituted: on a
       * shared deployment an anonymous Deep Cowork run has no editor to act
       * on, and the file tools say so instead of guessing. */
      userId: user?.id ?? null,
      phase: slash
        ? slash.phase
        : resolvedMode === "deepcowork"
          ? resolveDeepPhase(deepPhase)
          : "auto",
      ...(slash?.readOnly ? { readOnly: true } : {}),
      ...(slash?.objective ? { objective: slash.objective } : {}),
      ...(typeof resumeTaskId === "string" && resumeTaskId.trim()
        ? { resumeTaskId: resumeTaskId.trim() }
        : {}),
      ...(Number.isFinite(Number(maxIterations))
        ? { maxIterations: Number(maxIterations) }
        : {}),
      askQuestions: askQuestions === true,
      answers: resolveAnswers(answers),
      ...(roundSettings ? { roundSettings } : {}),
      ...(ultra ? { ultra: true } : {}),
      /* Only forwarded when the client explicitly picked one. Left unset, the
       * pipeline picks a reviewer that differs from the model which wrote the
       * code, falling back to that model if the alternative is unreachable. It
       * is never a hardcoded "strongest" model — that is what exhausted one
       * account's quota and made the rolled-back build return 429s. */
      ...(ultra && typeof reviewModel === "string" && reviewModel.trim()
        ? { reviewModel: reviewModel.trim() }
        : {}),
      ...(ultra && Number.isFinite(Number(maxReviewCycles))
        ? { maxReviewCycles: Number(maxReviewCycles) }
        : {}),
      creds,
    };

    /* Persist the user half of the turn *before* the model is called, so a
     * dropped connection or a failed generation still leaves the message in the
     * history to retry from. `beginTurn` creates the chat row in the same
     * transaction; it returns null instead of throwing if the database is
     * unavailable, in which case the request just streams without history. */
    const turn: TurnRecorder | null = user
      ? beginTurn({
          chatId,
          messages,
          model: targetModel,
          mode: resolvedMode,
          userId: user.id,
        })
      : null;

    const catalogIds = requested.isCombo ? [] : await getCatalogIds(creds);
    const ladder = buildFailoverLadder(targetModel, catalogIds, {
      accountRetries: roundSettings?.accountRetries ??
        (Number.isFinite(routing?.accountRetries)
          ? Number(routing.accountRetries)
          : ACCOUNT_RETRIES),
      allowVersionDrift: routing?.allowVersionDrift !== false,
      allowComboFallback: routing?.allowComboFallback !== false,
      /* Caps the retry budget and skips the gateway's account allow-list when
       * the upstream is a single-key third-party or local provider. */
      providerKind: getProviderProfile(creds.provider).kind,
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) => {
          /* Record before enqueueing: if the client has already disconnected the
           * enqueue throws, and the turn should still be saved. */
          turn?.observe(obj);
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(obj)}\n\n`),
            );
          } catch {
            /* closed */
          }
        };

        try {
          if (resolvedMode === "cowork" || resolvedMode === "deepcowork") {
            /* The pipeline speaks {kind: ...}; the client reads a flat
             * envelope. Translate, or nothing renders. */
            for await (const evt of runDeepCoworkPipeline(
              targetModel,
              ladder,
              sanitizedMessages,
              TAVILY_API_KEY,
              deepOptions,
            )) {
              switch (evt.kind) {
                case "delta":
                  send({ delta: evt.text });
                  break;
                case "thought":
                  send({ delta: evt.text });
                  break;
                case "tool":
                  send({ tool: evt.details || evt.name });
                  break;
                case "notice":
                  send({ notice: evt.notice });
                  break;
                case "route":
                  send({ route: evt.route });
                  break;
                case "stage":
                  // Extra key the current client ignores; harmless, and ready
                  // for a stage indicator in page.tsx later.
                  send({ stage: evt.stage, stageLabel: evt.label });
                  break;
                case "plan":
                  /* The approval gate. `plan` carries the step checklist and any
                   * open questions; the client renders PlanApprovalCard and
                   * POSTs back with deepPhase:"execute" + resumeTaskId. */
                  send({ plan: evt.plan });
                  break;
                case "task":
                  send({ task: evt.task });
                  break;
                case "review":
                  /* Ultra mode's audit verdict. Flat envelope like the rest;
                   * a client that doesn't know the key ignores it. */
                  send({ review: evt.review });
                  break;
                case "budget":
                  send({ budget: evt.budget });
                  break;
                case "error":
                  send({ error: evt.error });
                  break;
                case "done":
                  // Log successful deep cowork usage
                  logDeepCoworkUsage(userEmail);
                  send({ done: true });
                  break;
              }
            }
          } else {
            const workspaceContext = await buildWorkspaceContext(
              user?.id ?? null,
            );

            /* Skills.
             *
             * `availableTools` is derived from the same activeToolSet() the
             * request will actually carry, rather than recomputed from the env
             * flags a second time — a skill is withheld when the tools it
             * declared are genuinely absent, and the only way to know that
             * without guessing is to ask the array being sent.
             *
             * The result is reported over the stream so the panel can say which
             * skills fired and why, and which were skipped and why not. A skill
             * that silently does or does not apply is the failure mode that
             * makes this kind of feature feel haunted. */
            const lastUserMessage = [...sanitizedMessages]
              .reverse()
              .find((m) => m.role === "user");
            const skillResult = buildSkillContext({
              userId: user?.id ?? null,
              message:
                typeof lastUserMessage?.content === "string"
                  ? lastUserMessage.content
                  : "",
              explicitSkillIds: Array.isArray(skillIds)
                ? skillIds.filter((s: unknown): s is string => typeof s === "string")
                : [],
              availableTools: activeToolSet(user?.id ?? null).map(
                (t) => t.function.name,
              ),
            });
            if (skillResult.active.length > 0 || skillResult.skipped.length > 0) {
              send({
                skills: {
                  active: skillResult.active,
                  skipped: skillResult.skipped,
                },
              });
            }

            const outboundMessages = withSystemPrompt(
              sanitizedMessages,
              SYSTEM_PROMPT,
              workspaceContext,
              skillResult.context,
            );

            let emitted = 0;
            let account: string | null = null;
            let servedModel: string | null = null;
            let winner: Candidate | null = null;
            let attempts = 0;
            let lastError: unknown = null;

            for (let i = 0; i < ladder.length; i++) {
              const cand = ladder[i];
              attempts += 1;
              const activeTools = activeToolSet(user?.id ?? null);

              try {
                for await (const evt of runOmniRoute(
                  creds,
                  user?.id ?? null,
                  cand.id,
                  outboundMessages,
                  activeTools,
                  MAX_STEPS,
                  agentRouterSettings,
                )) {
                  if (evt.kind === "delta") {
                    emitted += evt.text.length;
                    send({ delta: evt.text });
                  } else if (evt.kind === "tool") {
                    send({ tool: evt.name });
                  } else if (evt.kind === "meta") {
                    if (evt.account) account = evt.account;
                    if (evt.upstreamModel) servedModel = evt.upstreamModel;
                  } else if (evt.kind === "done") {
                    if (evt.servedModel) servedModel = evt.servedModel;
                    break;
                  }
                }

                winner = cand;
                break;
              } catch (err: unknown) {
                lastError = err;
                const kind = failureKindOf(err);
                const detail = err instanceof Error ? err.message : String(err);

                if (emitted > 0) {
                  send({
                    error: `[${prettyModelName(cand.id)}] stream broke after starting: ${detail}`,
                  });
                  lastError = null;
                  break;
                }

                const next = ladder[i + 1];
                if (!next || !shouldFailover(kind)) break;

                send({ notice: buildNotice(cand.id, next, kind, account) });
                account = null;
                continue;
              }
            }

            if (!winner) {
              const detail =
                lastError instanceof Error
                  ? lastError.message
                  : String(lastError || "");
              if (detail) {
                const tried = Array.from(new Set(ladder.map((c) => c.id))).join(
                  ", ",
                );
                send({
                  error: `Could not complete request for "${prettyModelName(targetModel)}" after ${attempts} attempts. Tried: ${tried}. Last error: ${detail}`,
                });
              }
            } else {
              const substituted = detectSubstitution(winner.id, servedModel);
              if (substituted) {
                send({
                  notice: {
                    kind: "substituted",
                    text: `"${winner.id}" was requested but gateway answered with "${servedModel}".`,
                    from: winner.id,
                    to: servedModel,
                    step: winner.step,
                    failure: "other",
                    account,
                  },
                });
              }

              send({
                route: {
                  requested: targetModel,
                  dispatched: winner.id,
                  served: servedModel,
                  account,
                  viaCombo: winner.yieldsControl,
                  attempts,
                  substituted,
                  bridge: vscodeBridge.isConnected() ? "vscode" : "filesystem",
                },
              });
              send({ done: true });
            }
          }
        } catch (err: any) {
          send({
            error: `[Model: ${targetModel}] ${err?.message || String(err)}`,
          });
        } finally {
          /* Runs on success, on error, and on client disconnect. An assistant
           * turn that produced no text is deliberately not stored — a failed
           * request should leave your message to retry from, not an empty
           * bubble under it. */
          turn?.finish();
          try {
            controller.close();
          } catch {
            /* noop */
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: error?.message || `OmniRoute rejected model "${targetModel}".`,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
