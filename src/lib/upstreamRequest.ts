/**
 * Upstream Request Layer
 *
 * Every outbound call to a model provider goes through here. Before this
 * module, four separate call sites each built their own URL and headers:
 *
 *   - `postStream` in deepCoworkPipeline.ts
 *   - `postOmniRouteStream` in app/api/chat/route.ts
 *   - `fetchGatewayModels` in omniroute.ts
 *   - the connection test in app/api/credentials/test/route.ts
 *
 * All four hardcoded `Authorization: Bearer` and `${baseUrl}/chat/completions`,
 * so adding a provider meant editing four places and forgetting one. They now
 * all call into this file.
 *
 * It also handles the two protocol details that differ across providers:
 *
 *   1. NON-SSE RESPONSES. We always send `stream: true`, but not every
 *      provider honours it — some return a single JSON object with
 *      `Content-Type: application/json`. The SSE parsers downstream look for
 *      `data:` lines, find none, and yield an empty message with no error.
 *      That is the worst kind of bug: a silent blank reply. `ensureEventStream`
 *      detects a JSON response and re-emits it as a one-shot SSE stream so
 *      every parser downstream sees the shape it expects.
 *
 *   2. SSRF. Every base URL here came from user input, so a server-side fetch
 *      must be guarded. `guardUpstreamUrl` runs inside `postChatCompletion`
 *      and `getModelList` rather than being left to call sites, because a call
 *      site that forgets it is indistinguishable from one that does not need
 *      it. Whether a local address is reachable is decided by the environment
 *      (`OMNIROUTE_ALLOW_PRIVATE_GATEWAY` / NODE_ENV), never by what the
 *      request claims the provider is — see `guardUpstreamUrl` below.
 */

import {
  buildUpstreamGetHeaders,
  buildUpstreamHeaders,
  getProviderProfile,
  resolveChatEndpoint,
  resolveModelsEndpoint,
  type ProviderProfile,
} from "./providerProfiles";
import { isPubliclyRoutable } from "./ssrfGuard";
import type { GatewayCreds } from "./gatewayCreds";
import {
  isAnthropicFlavor,
  resolveMessagesEndpoint,
  openAiToAnthropicBody,
  anthropicHeaders,
  anthropicStaticHeaders,
  anthropicResponseToOpenAi,
} from "./anthropicAdapter";

export interface UpstreamTarget {
  profile: ProviderProfile;
  baseUrl: string;
  apiKey: string;
}

/** Build a target from resolved credentials. */
export function targetFromCreds(creds: GatewayCreds): UpstreamTarget {
  return {
    profile: getProviderProfile(creds.provider),
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
  };
}

/**
 * Guard a user-supplied base URL before fetching it server-side.
 *
 * WHY THE PROFILE NO LONGER DECIDES
 *
 * This used to return early for `profile.kind === "local" | "gateway"`, and for
 * any URL that merely looked local. Both were bypasses, because the caller
 * chooses the kind: `provider` is a free string in the body of
 * POST /api/credentials, and `ollama`/`lmstudio`/`llamacpp`/`vllm` are all
 * registered as kind "local" while `omniroute` is kind "gateway". Saving a
 * credential as {"provider":"ollama","baseUrl":"http://169.254.169.254/..."}
 * therefore disabled the guard for every later request from that account — on
 * EC2 that address is the instance metadata service.
 *
 * The decision is now made entirely server-side by `isPubliclyRoutable`, which
 * allows loopback and private ranges only when OMNIROUTE_ALLOW_PRIVATE_GATEWAY
 * says so or we are not in production. So running the app on your own machine
 * still reaches a localhost gateway, and the deployed server never does,
 * whatever the request claims the provider is.
 *
 * `profile` is kept in the signature for call-site compatibility and is
 * deliberately unused.
 *
 * Returns null when allowed, or a reason string when refused.
 */
export async function guardUpstreamUrl(
  baseUrl: string,
  _profile?: ProviderProfile,
): Promise<string | null> {
  const verdict = await isPubliclyRoutable(baseUrl);
  return verdict.allowed ? null : verdict.reason;
}

/**
 * The response returned in place of a refused fetch.
 *
 * A thrown error would unwind through call sites that expect a Response and
 * classify failures from its status and body. A 403 carrying the guard's own
 * explanation reaches the user as a readable message instead — which matters
 * here, because the most common refusal is the legitimate one: a localhost
 * gateway URL on a server that cannot reach the user's machine.
 */
function refusedUpstream(reason: string): Response {
  return new Response(
    JSON.stringify({ error: { message: reason, type: "upstream_blocked" } }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}

export interface ChatCompletionPayload {
  model: string;
  messages: unknown[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface PostChatOptions {
  signal?: AbortSignal;
  /** Extra headers merged last — used for request-scoped values only. */
  headers?: Record<string, string>;
}

/**
 * Per-provider header overrides, read from the environment.
 *
 * WHY THIS EXISTS
 *
 * Some relays accept a perfectly valid token and then reject the request on its
 * *client fingerprint*. Agent Router answers with "unauthorized client detected"
 * — a comment about the caller, not the credential. Which fingerprint such a
 * relay wants is undocumented and changes without notice, so hardcoding one
 * means editing source and redeploying every time it moves.
 *
 * Set OMNIROUTE_HEADER_OVERRIDES to a JSON object keyed by provider id:
 *
 *   OMNIROUTE_HEADER_OVERRIDES='{"agentrouter":{"User-Agent":"anthropic-typescript/0.39.0"}}'
 *
 * Read here rather than in providerProfiles.ts because that module is imported
 * by SettingsPanel: process.env does not exist in a browser bundle, and adding
 * it there would break the client build. Invalid JSON is ignored with a warning
 * rather than failing every request.
 */
let headerOverrideCache: Record<string, Record<string, string>> | null = null;

function headerOverridesFor(providerId: string): Record<string, string> {
  if (headerOverrideCache === null) {
    const table: Record<string, Record<string, string>> = {};
    const raw = process.env.OMNIROUTE_HEADER_OVERRIDES;
    if (raw && raw.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(
            parsed as Record<string, unknown>,
          )) {
            if (value && typeof value === "object" && !Array.isArray(value)) {
              table[key] = value as Record<string, string>;
            }
          }
        }
      } catch {
        console.warn(
          "[upstreamRequest] OMNIROUTE_HEADER_OVERRIDES is not valid JSON; ignoring it.",
        );
      }
    }
    headerOverrideCache = table;
  }
  return headerOverrideCache[providerId] ?? {};
}

/**
 * POST a chat completion to any provider.
 *
 * Azure is the one shape-shifter: its deployment URL already names the model,
 * and it rejects an unexpected `model` field on some API versions, so the field
 * is dropped there.
 *
 * Anthropic-flavored providers (AgentRouter) use the Messages API instead of
 * the OpenAI chat completions format.
 */
/**
 * Fetch, with a Chromium fallback for Cloudflare-blocked providers.
 *
 * Some gateways (e.g. justwoker.icu) sit behind Cloudflare bot protection that
 * blocks server-side clients by TLS fingerprint but lets real browsers through.
 * On the desktop build, the Electron main process runs a tiny proxy that makes
 * the request through Chromium's own network stack — a genuine browser
 * fingerprint that passes Cloudflare — and its URL is handed to the server in
 * OMNIROUTE_BROWSER_PROXY. When a normal fetch comes back as a Cloudflare block
 * AND that proxy exists, we retry through it.
 *
 * SAFETY — why this cannot affect working providers:
 *   - A SUCCESSFUL response (res.ok) is returned immediately, untouched and
 *     unbuffered, so streaming and every provider that works today are
 *     unaffected.
 *   - Only a 403/503/429 whose body actually looks like a Cloudflare block
 *     triggers the fallback. A normal 401/400/403 from a real provider is
 *     returned as-is.
 *   - Off the desktop build OMNIROUTE_BROWSER_PROXY is unset, so this is a plain
 *     fetch everywhere else.
 */
async function upstreamFetch(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.ok) return res;

  const proxy = process.env.OMNIROUTE_BROWSER_PROXY?.trim();
  if (!proxy) return res;
  if (res.status !== 403 && res.status !== 503 && res.status !== 429) return res;

  let sniff = "";
  try {
    sniff = await res.clone().text();
  } catch {
    return res;
  }
  if (!/cloudflare|attention required|cf-ray|cf-error|__cf|cf-mitigated/i.test(sniff)) {
    return res;
  }

  console.log(
    `[upstreamRequest] Cloudflare block on ${url} — retrying through the browser proxy`,
  );

  const headers: Record<string, string> = { "x-omni-proxy-target": url };
  const src = init.headers as Record<string, string> | undefined;
  if (src) for (const [k, v] of Object.entries(src)) headers[k] = v;

  try {
    return await fetch(proxy, {
      method: (init.method as string) || "GET",
      headers,
      body: init.body as BodyInit | undefined,
      signal: init.signal as AbortSignal | undefined,
    });
  } catch (err) {
    console.error("[upstreamRequest] browser-proxy fallback failed:", err);
    return res;
  }
}

export async function postChatCompletion(
  target: UpstreamTarget,
  payload: ChatCompletionPayload,
  options: PostChatOptions = {},
): Promise<Response> {
  /* Guard before any fetch. This is the only outbound path to a provider, so
   * checking here covers chat, Deep Cowork, Ultra and the failover ladder at
   * once — and it must run before the Anthropic branch below, which fetches
   * a different endpoint on the same attacker-supplied host. */
  const refusal = await guardUpstreamUrl(target.baseUrl, target.profile);
  if (refusal) return refusedUpstream(refusal);

  /* Anthropic Messages API providers need different endpoint, headers, and body. */
  if (isAnthropicFlavor(target.profile)) {
    const url = resolveMessagesEndpoint(target.baseUrl);
    const headers = anthropicHeaders(target.profile, target.apiKey, {
      ...headerOverridesFor(target.profile.id),
      ...(options.headers ?? {}),
    });
    const body = openAiToAnthropicBody(payload as Record<string, unknown>);

    return upstreamFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
      redirect: "manual",
    });
  }

  /* Standard OpenAI chat completions path. */
  const url = resolveChatEndpoint(target.profile, target.baseUrl);
  /* Env overrides merge last so they win over the profile's built-in headers
   * without having to edit and redeploy the registry. */
  const headers = buildUpstreamHeaders(target.profile, target.apiKey, {
    ...headerOverridesFor(target.profile.id),
    ...(options.headers ?? {}),
  });

  const body: ChatCompletionPayload = { ...payload };
  if (target.profile.id === "azure") {
    delete (body as Record<string, unknown>).model;
  }

  try {
    /* Do NOT log `headers` here. buildUpstreamHeaders has already put the
     * decrypted API key into `Authorization: Bearer ...`, so printing the
     * object writes every user's key to the server log in plaintext — and on
     * a deployed box those logs go to journald / CloudWatch and are retained.
     * Log the URL and status only; both are useful and neither is a secret. */
    const response = await upstreamFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
      /* A 302 to an internal address would sidestep the SSRF check entirely. */
      redirect: "manual",
    });

    return response;
  } catch (err) {
    console.error(`[upstreamRequest] Fetch failed for ${target.profile.id}:`, err);
    console.error(`[upstreamRequest] URL was: ${url}`);
    console.error(`[upstreamRequest] Error details:`, {
      name: (err as Error).name,
      message: (err as Error).message,
      cause: (err as { cause?: unknown }).cause,
    });
    throw err;
  }
}

/**
 * GET the provider's model list.
 *
 * Returns null when the provider has no models endpoint at all — that is a
 * "nothing to ask" answer, not a failure. A blocked URL is different: it comes
 * back as a 403 Response so the reason reaches the model picker instead of
 * being flattened into an empty list.
 */
export async function getModelList(
  target: UpstreamTarget,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Response | null> {
  const url = resolveModelsEndpoint(target.profile, target.baseUrl);
  if (!url) return null;

  const refusal = await guardUpstreamUrl(target.baseUrl, target.profile);
  if (refusal) return refusedUpstream(refusal);

  /* Anthropic-flavored providers need their own headers for model listing. */
  const headers = isAnthropicFlavor(target.profile)
    ? {
        ...anthropicStaticHeaders(target.apiKey),
        ...headerOverridesFor(target.profile.id),
      }
    : buildUpstreamGetHeaders(
        target.profile,
        target.apiKey,
        headerOverridesFor(target.profile.id),
      );

  const signal =
    options.signal ??
    (options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined);

  return upstreamFetch(url, {
    method: "GET",
    headers,
    signal,
    redirect: "manual",
  });
}

/* -------------------------------------------------------------------------
 * Non-SSE → SSE normalisation
 * ---------------------------------------------------------------------- */

function sseChunk(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

const SSE_DONE = new TextEncoder().encode("data: [DONE]\n\n");

/**
 * Turn a whole-JSON chat completion into the streaming shape.
 *
 * The delta carries `content`, `reasoning_content` and `tool_calls` because all
 * three are read downstream; anything omitted here silently disappears from the
 * assistant's reply. `finish_reason` is preserved so a `tool_calls` stop is
 * still distinguishable from a normal one.
 */
function jsonToSseStream(parsed: unknown): ReadableStream<Uint8Array> {
  const root = (parsed ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first.message ?? {}) as Record<string, unknown>;

  const delta: Record<string, unknown> = {};
  if (typeof message.content === "string" && message.content) {
    delta.content = message.content;
  } else if (Array.isArray(message.content)) {
    /* Some providers return content as an array of parts. */
    const text = message.content
      .map((part) => {
        const p = (part ?? {}) as Record<string, unknown>;
        return typeof p.text === "string" ? p.text : "";
      })
      .join("");
    if (text) delta.content = text;
  }
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    delta.reasoning_content = message.reasoning_content;
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    /* Streaming tool calls carry an index; whole-JSON ones do not. Add it so
     * index-keyed accumulators downstream do not collapse every call into one. */
    delta.tool_calls = message.tool_calls.map((call, index) => {
      const c = (call ?? {}) as Record<string, unknown>;
      return { index, ...c };
    });
  }

  const frame = {
    id: typeof root.id === "string" ? root.id : "chatcmpl-normalised",
    object: "chat.completion.chunk",
    created:
      typeof root.created === "number"
        ? root.created
        : Math.floor(Date.now() / 1000),
    model: typeof root.model === "string" ? root.model : undefined,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: first.finish_reason ?? "stop",
      },
    ],
    usage: root.usage,
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sseChunk(frame));
      controller.enqueue(SSE_DONE);
      controller.close();
    },
  });
}

/**
 * Guarantee an SSE-shaped response body.
 *
 * A response that is already `text/event-stream` passes through untouched — no
 * buffering, so streaming stays incremental. Only a JSON response is rewritten,
 * and that one is already fully buffered by definition.
 *
 * Error responses are returned as-is: the caller's failure classifier wants the
 * real status and body, not a synthesised stream.
 */
export async function ensureEventStream(response: Response): Promise<Response> {
  if (!response.ok) return response;

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/event-stream")) return response;
  if (!response.body) return response;

  /* Not declared as JSON and not SSE — could be an unlabelled stream. Read the
   * text and decide from its content rather than trusting the header. */
  const raw = await response.text();
  const trimmed = raw.trimStart();

  if (trimmed.startsWith("data:") || trimmed.startsWith("event:")) {
    return new Response(raw, {
      status: response.status,
      statusText: response.statusText,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    /* Neither SSE nor JSON. Hand it back unchanged so the caller can report the
     * body in its error message instead of us hiding it. */
    return new Response(raw, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Response(raw, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  return new Response(jsonToSseStream(parsed), {
    status: response.status,
    statusText: response.statusText,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * POST a chat completion and guarantee an SSE body back.
 * This is the function call sites should use.
 *
 * Anthropic-flavored providers have their responses translated from Anthropic
 * Messages format to OpenAI format before being passed to ensureEventStream.
 */
export async function postChatCompletionStream(
  target: UpstreamTarget,
  payload: ChatCompletionPayload,
  options: PostChatOptions = {},
): Promise<Response> {
  const response = await postChatCompletion(target, payload, options);
  
  /* Anthropic Messages responses need translation before normalisation. */
  if (isAnthropicFlavor(target.profile)) {
    const translated = await anthropicResponseToOpenAi(response);
    return ensureEventStream(translated);
  }
  
  return ensureEventStream(response);
}
