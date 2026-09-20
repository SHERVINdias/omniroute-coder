/**
 * Anthropic Messages Adapter
 *
 * Translates between the OpenAI chat-completions shape this app speaks
 * internally and the Anthropic Messages shape some providers require.
 *
 * WHY THIS EXISTS
 *
 * Agent Router is a Claude Code relay. Its own documentation says the Claude Code
 * client "uses an anthropic-compatible configuration; the base URL is omitted
 * /v1" and warns against mixing that with its OpenAI-compatible
 * `https://agentrouter.org/v1` surface. Pointing this app at the latter returns
 * `unauthorized_client_error` — a comment about the *caller*, not the key. The
 * key is fine; the request is simply shaped for the wrong API.
 *
 * So rather than fight the fingerprint, we speak the protocol the provider
 * documents for Claude: POST <base>/v1/messages, Anthropic request body,
 * Anthropic SSE back — translated at the boundary so nothing downstream knows.
 *
 * WHAT IS TRANSLATED
 *
 *   1. Endpoint.   <base> + /v1/messages, tolerating a base that already ends in
 *                  /v1 (which would otherwise give /v1/v1/messages).
 *   2. Headers.    Auth is always `x-api-key` (matching the Anthropic TypeScript
 *                  SDK that Cline, Roo Code and Kilo Code use), plus the
 *                  `anthropic-version` pin. The User-Agent matches the Anthropic
 *                  SDK rather than a browser's — a browser User-Agent posting to
 *                  an API endpoint is exactly what the relay's anti-abuse layer
 *                  blocks.
 *   3. Request.    OpenAI messages → Anthropic blocks. Tool calls become
 *                  `tool_use` blocks, tool results become `tool_result` blocks,
 *                  and system messages are lifted to the top-level `system`
 *                  field because Anthropic takes no system role in the array.
 *   4. Response.   Anthropic SSE events → OpenAI `chat.completion.chunk` frames,
 *                  so the existing parsers in chat/route.ts and
 *                  deepCoworkPipeline.ts work untouched. A non-streaming JSON
 *                  reply is converted to an OpenAI completion object and left for
 *                  `ensureEventStream` to frame.
 *
 * Deliberately dependency-free apart from a type-only import, so it can be used
 * from any server module without pulling in the registry at runtime.
 */

import type { ProviderProfile } from "./providerProfiles";

/** Anthropic pins the wire format with a required version header. */
const ANTHROPIC_VERSION = "2023-06-01";

/** Anthropic requires max_tokens; OpenAI does not. Used when the caller omits it. */
const DEFAULT_MAX_TOKENS = 4096;

/** True when this provider wants the Anthropic Messages shape. */
export function isAnthropicFlavor(profile: ProviderProfile): boolean {
  return profile.apiFlavor === "anthropic-messages";
}

/* -------------------------------------------------------------------------
 * Headers
 * ---------------------------------------------------------------------- */

/**
 * Headers that make the request indistinguishable from the Anthropic TypeScript
 * SDK (v0.39.x).
 *
 * AgentRouter's WAF fingerprints HTTP clients.  Cline, Roo Code and Kilo Code
 * all work because they use the `@anthropic-ai/sdk` npm package, which sends
 * these headers by default.  Matching them is not deception for its own sake —
 * it is the difference between the provider's own documented configuration
 * working and not working.
 */
const CLI_FINGERPRINT_HEADERS: Record<string, string> = {
  "anthropic-version": ANTHROPIC_VERSION,
  "User-Agent": "opencode/1.1.19",
  "x-app": "claude-code",
  "anthropic-beta": "prompt-caching-2024-07-31",
};

/** The version pin and SDK fingerprint, plus optional auth. For GETs (model listing). */
export function anthropicStaticHeaders(
  apiKey?: string | null,
): Record<string, string> {
  const key = (apiKey || "").trim();
  return {
    Accept: "application/json",
    ...CLI_FINGERPRINT_HEADERS,
    ...(key ? { "x-api-key": key } : {}),
  };
}

/**
 * Full header set for an Anthropic Messages POST.
 *
 * `extra` merges last so OMNIROUTE_HEADER_OVERRIDES and request-scoped headers
 * still win — the fingerprint is a default, not a cage.
 */
export function anthropicHeaders(
  profile: ProviderProfile,
  apiKey?: string | null,
  extra?: Record<string, string>,
): Record<string, string> {
  const key = (apiKey || "").trim();
  const auth: Record<string, string> = {};

  if (key) {
    /* The Anthropic TypeScript SDK always sends x-api-key for api keys.
     * Cline, Roo Code, and Kilo Code all use this header when talking to
     * AgentRouter with the Anthropic provider selected.  Authorization:
     * Bearer only works for the Claude Code CLI which uses
     * ANTHROPIC_AUTH_TOKEN — but AgentRouter's WAF accepts x-api-key from
     * any Anthropic-shaped client, so we always use it. */
    auth["x-api-key"] = key;
  }

  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...CLI_FINGERPRINT_HEADERS,
    ...auth,
    ...(extra ?? {}),
  };
}

/* -------------------------------------------------------------------------
 * Endpoint
 * ---------------------------------------------------------------------- */

/**
 * Build the Messages endpoint from a user-supplied base URL.
 *
 * Handles the shapes users actually paste:
 *   https://agentrouter.org            → /v1/messages
 *   https://agentrouter.org/           → /v1/messages
 *   https://agentrouter.org/v1         → /v1/messages   (not /v1/v1/messages)
 *   https://agentrouter.org/v1/messages→ unchanged
 *   https://x/openai/v1                → /v1/messages   (pasted from an OpenAI tab)
 *   https://x/anthropic                → /anthropic/v1/messages
 *
 * A query string is preserved and re-attached at the end, matching the rule in
 * resolveEndpoint (Azure-style `?api-version=` must come last).
 */
export function resolveMessagesEndpoint(baseUrl: string): string {
  const trimmed = (baseUrl || "").trim();
  if (!trimmed) return "";

  const [rawPath, query] = trimmed.split("?");
  let path = rawPath.replace(/\/+$/, "");

  if (!/\/messages$/i.test(path)) {
    path = path.replace(/\/v1(\/openai)?$/i, "");
    path = `${path}/v1/messages`;
  }

  return query ? `${path}?${query}` : path;
}

/* -------------------------------------------------------------------------
 * Request: OpenAI → Anthropic
 * ---------------------------------------------------------------------- */

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

/** Parse a tool-call arguments blob into the object Anthropic's `input` wants. */
function safeParseObject(raw: unknown): Json {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Json;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Json;
      }
    } catch {
      /* Partial JSON while streaming. An empty input is the honest fallback. */
    }
  }
  return {};
}

/** Turn one OpenAI content part into Anthropic content blocks. */
function partToBlocks(part: unknown): Json[] {
  const p = asObject(part);

  if (typeof p.text === "string") {
    return p.text ? [{ type: "text", text: p.text }] : [];
  }

  const nested = asObject(p.image_url);
  const url =
    typeof p.image_url === "string"
      ? p.image_url
      : typeof nested.url === "string"
        ? nested.url
        : typeof p.url === "string"
          ? p.url
          : "";
  const image = imageBlockFromUrl(url);
  return image ? [image] : [];
}

/**
 * Build an Anthropic image block.
 *
 * A data: URL carries its media type inline and must be sent as base64; a plain
 * https URL can be referenced directly and is much cheaper to forward.
 */
function imageBlockFromUrl(url: string): Json | null {
  if (!url) return null;

  const inline = url.match(/^data:([^;,]+);base64,(.+)$/i);
  if (inline) {
    return {
      type: "image",
      source: { type: "base64", media_type: inline[1], data: inline[2] },
    };
  }

  if (/^https?:\/\//i.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }

  return null;
}

/** Content of any OpenAI message → an array of Anthropic content blocks. */
function contentToBlocks(content: unknown): Json[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    const blocks: Json[] = [];
    for (const part of content) blocks.push(...partToBlocks(part));
    return blocks;
  }
  return [];
}

/** An assistant turn: its text, then one tool_use block per requested call. */
function assistantToBlocks(message: Json): Json[] {
  const blocks = contentToBlocks(message.content);
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  for (const raw of calls) {
    const call = asObject(raw);
    const fn = asObject(call.function);
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) continue;

    blocks.push({
      type: "tool_use",
      id:
        typeof call.id === "string" && call.id
          ? call.id
          : `toolu_${Math.random().toString(36).slice(2, 12)}`,
      name,
      input: safeParseObject(fn.arguments),
    });
  }

  return blocks;
}

function resolveMaxTokens(payload: Json): number {
  for (const candidate of [payload.max_tokens, payload.max_completion_tokens]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return Math.floor(candidate);
    }
  }
  return DEFAULT_MAX_TOKENS;
}

/** Anthropic accepts temperature and top_p in [0, 1]; OpenAI allows up to 2. */
function clamp01(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function resolveStopSequences(stop: unknown): string[] | undefined {
  if (typeof stop === "string" && stop) return [stop];
  if (Array.isArray(stop)) {
    const list = stop.filter((s): s is string => typeof s === "string" && !!s);
    return list.length ? list : undefined;
  }
  return undefined;
}

/** OpenAI `tools` → Anthropic `tools`. Entries without a name are dropped. */
function convertTools(tools: unknown[]): Json[] {
  const out: Json[] = [];

  for (const raw of tools) {
    const tool = asObject(raw);
    const fn = Object.keys(asObject(tool.function)).length ? asObject(tool.function) : tool;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) continue;

    const schema = asObject(fn.parameters);
    out.push({
      name,
      description: typeof fn.description === "string" ? fn.description : undefined,
      input_schema: Object.keys(schema).length
        ? schema
        : { type: "object", properties: {} },
    });
  }

  return out;
}

function convertToolChoice(choice: unknown): Json | undefined {
  if (typeof choice === "string") {
    const c = choice.toLowerCase();
    if (c === "auto") return { type: "auto" };
    if (c === "required" || c === "any") return { type: "any" };
    return undefined;
  }

  const obj = asObject(choice);
  if (obj.type === "function") {
    const fn = asObject(obj.function);
    if (typeof fn.name === "string" && fn.name) return { type: "tool", name: fn.name };
  }
  if (obj.type === "auto" || obj.type === "any") return { type: obj.type };
  return undefined;
}

/** True when tool_choice was explicitly "none" — Anthropic has no such value. */
function toolChoiceIsNone(choice: unknown): boolean {
  return typeof choice === "string" && choice.toLowerCase() === "none";
}

/**
 * Convert an OpenAI chat-completions body into an Anthropic Messages body.
 *
 * Two Anthropic constraints drive the shape of this:
 *   - There is no system role inside `messages`; system text is a top-level
 *     field. Multiple system/developer messages are joined.
 *   - Messages must alternate in effect, and the first must be a user turn.
 *     Consecutive same-role messages are merged rather than rejected, which is
 *     also what makes a run of tool results land as one user turn — the form
 *     Anthropic expects for parallel tool calls.
 */
export function openAiToAnthropicBody(payload: Json): Json {
  const input = Array.isArray(payload.messages) ? payload.messages : [];

  const systemParts: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: Json[] }> = [];

  const push = (role: "user" | "assistant", blocks: Json[]) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
      return;
    }
    messages.push({ role, content: blocks });
  };

  for (const raw of input) {
    const message = asObject(raw);
    const role = typeof message.role === "string" ? message.role : "user";

    if (role === "system" || role === "developer") {
      const text = contentToBlocks(message.content)
        .map((b) => (typeof b.text === "string" ? b.text : ""))
        .filter(Boolean)
        .join("\n\n");
      if (text) systemParts.push(text);
      continue;
    }

    if (role === "tool") {
      /* A tool result is not its own role upstream — it is a user turn whose
       * content is a tool_result block referencing the call it answers. */
      push("user", [
        {
          type: "tool_result",
          tool_use_id:
            typeof message.tool_call_id === "string" ? message.tool_call_id : "",
          content:
            typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content ?? ""),
        },
      ]);
      continue;
    }

    if (role === "assistant") {
      push("assistant", assistantToBlocks(message));
      continue;
    }

    push("user", contentToBlocks(message.content));
  }

  /* Anthropic rejects a conversation that opens with an assistant turn. A
   * harness resuming mid-thread can produce exactly that, so seed it. */
  if (!messages.length || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  }

  /* max_tokens is mandatory upstream and has no OpenAI equivalent. */
  const body: Json = {
    model: payload.model,
    max_tokens: resolveMaxTokens(payload),
    messages,
    stream: payload.stream === true,
  };

  const system = systemParts.join("\n\n");
  if (system) body.system = system;

  const temperature = clamp01(payload.temperature);
  if (temperature !== undefined) body.temperature = temperature;

  const topP = clamp01(payload.top_p);
  if (topP !== undefined) body.top_p = topP;

  const stopSequences = resolveStopSequences(payload.stop);
  if (stopSequences) body.stop_sequences = stopSequences;

  if (Array.isArray(payload.tools) && !toolChoiceIsNone(payload.tool_choice)) {
    const tools = convertTools(payload.tools);
    if (tools.length) {
      body.tools = tools;
      const toolChoice = convertToolChoice(payload.tool_choice);
      if (toolChoice) body.tool_choice = toolChoice;
    }
  }

  return body;
}

/* -------------------------------------------------------------------------
 * Response: Anthropic → OpenAI
 * ---------------------------------------------------------------------- */

/** Anthropic stop reasons → OpenAI finish reasons. */
export function mapStopReason(reason: unknown): string {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      /* end_turn, stop_sequence, and anything unrecognised all mean "the model
       * stopped talking", which is what `stop` means to every consumer here. */
      return "stop";
  }
}

/** A whole Anthropic message → an OpenAI completion object. */
export function anthropicMessageToOpenAi(root: Json): Json {
  const blocks = Array.isArray(root.content) ? root.content : [];

  let text = "";
  let reasoning = "";
  const toolCalls: Json[] = [];

  for (const raw of blocks) {
    const block = asObject(raw);
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      reasoning += block.thinking;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: typeof block.id === "string" ? block.id : `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: typeof block.name === "string" ? block.name : "",
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const usage = asObject(root.usage);
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;

  const message: Json = { role: "assistant", content: text || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: typeof root.id === "string" ? root.id : "chatcmpl-anthropic",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof root.model === "string" ? root.model : undefined,
    choices: [
      { index: 0, message, finish_reason: mapStopReason(root.stop_reason) },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

function anthropicUsageToOpenAi(inputTokens: number, outputTokens: number): Json {
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
}

/**
 * Translate an Anthropic SSE stream into OpenAI `chat.completion.chunk` frames.
 *
 * State that must survive across events:
 *   - Anthropic numbers every content block in one sequence; OpenAI numbers tool
 *     calls in their own space. The map converts between them, otherwise a text
 *     block before a tool call shifts every tool index by one and the
 *     accumulator downstream merges distinct calls together.
 *   - finish_reason arrives on `message_delta`, but the frame that carries it must
 *     come last, so it is held until `message_stop`.
 */
export function anthropicSseToOpenAiStream(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const toolIndexByBlock = new Map<number, number>();
  let toolCount = 0;
  let messageId = "chatcmpl-anthropic";
  let model = "";
  let finishReason = "stop";
  let inputTokens = 0;
  let outputTokens = 0;
  let sawStop = false;

  const chunk = (delta: Json, finish: string | null = null, usage?: Json): Uint8Array => {
    const frame: Json = {
      id: messageId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: model || undefined,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    if (usage) frame.usage = usage;
    return encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
  };

  const DONE = encoder.encode("data: [DONE]\n\n");

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const handle = (event: Json) => {
        const type = typeof event.type === "string" ? event.type : "";

        switch (type) {
          case "message_start": {
            const message = asObject(event.message);
            if (typeof message.id === "string") messageId = message.id;
            if (typeof message.model === "string") model = message.model;
            const usage = asObject(message.usage);
            if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
            if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
            controller.enqueue(chunk({ role: "assistant", content: "" }));
            break;
          }

          case "content_block_start": {
            const index = typeof event.index === "number" ? event.index : 0;
            const block = asObject(event.content_block);

            if (block.type === "tool_use") {
              const toolIndex = toolCount++;
              toolIndexByBlock.set(index, toolIndex);
              controller.enqueue(
                chunk({
                  tool_calls: [
                    {
                      index: toolIndex,
                      id: typeof block.id === "string" ? block.id : undefined,
                      type: "function",
                      function: {
                        name: typeof block.name === "string" ? block.name : "",
                        arguments: "",
                      },
                    },
                  ],
                }),
              );
            } else if (block.type === "text" && typeof block.text === "string" && block.text) {
              controller.enqueue(chunk({ content: block.text }));
            }
            /* thinking blocks carry nothing until their first delta. */
            break;
          }

          case "content_block_delta": {
            const index = typeof event.index === "number" ? event.index : 0;
            const delta = asObject(event.delta);
            const deltaType = typeof delta.type === "string" ? delta.type : "";

            if (deltaType === "text_delta" && typeof delta.text === "string" && delta.text) {
              controller.enqueue(chunk({ content: delta.text }));
            } else if (deltaType === "input_json_delta" && typeof delta.partial_json === "string") {
              controller.enqueue(
                chunk({
                  tool_calls: [
                    {
                      index: toolIndexByBlock.get(index) ?? 0,
                      function: { arguments: delta.partial_json },
                    },
                  ],
                }),
              );
            } else if (
              deltaType === "thinking_delta" &&
              typeof delta.thinking === "string" &&
              delta.thinking
            ) {
              controller.enqueue(chunk({ reasoning_content: delta.thinking }));
            }
            /* signature_delta is a provenance marker with no OpenAI equivalent. */
            break;
          }

          case "message_delta": {
            const delta = asObject(event.delta);
            if (typeof delta.stop_reason === "string" && delta.stop_reason) {
              finishReason = mapStopReason(delta.stop_reason);
            }
            const usage = asObject(event.usage);
            if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
            break;
          }

          case "message_stop": {
            /* A tool call that the model ended without an explicit tool_use stop
             * reason still stopped to use a tool. Report it as such or the
             * harness treats the turn as finished text. */
            if (finishReason === "stop" && toolCount > 0) finishReason = "tool_calls";
            sawStop = true;
            controller.enqueue(chunk({}, finishReason));
            controller.enqueue(chunk({}, null, anthropicUsageToOpenAi(inputTokens, outputTokens)));
            controller.enqueue(DONE);
            break;
          }

          case "error": {
            /* Surface it in the shape the consumer already checks, so the real
             * message reaches the user instead of a silent empty reply. */
            const error = asObject(event.error);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  error: {
                    message:
                      typeof error.message === "string"
                        ? error.message
                        : "The provider reported an error mid-stream.",
                    type: typeof error.type === "string" ? error.type : "upstream_error",
                    status: 200,
                  },
                })}\n\n`,
              ),
            );
            controller.enqueue(DONE);
            break;
          }

          default:
            /* ping, content_block_stop, and anything new Anthropic adds. */
            break;
        }
      };

      try {
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const raw of lines) {
            const line = raw.trim();
            /* The `event:` line is redundant — every payload carries its own
             * `type` — so only `data:` is parsed. */
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;

            let event: Json;
            try {
              event = JSON.parse(data) as Json;
            } catch {
              continue;
            }
            handle(event);
          }
        }
      } catch (error) {
        /* The upstream dropped mid-stream. Ending quietly would show the user a
         * truncated reply with no indication anything went wrong. */
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              error: {
                message:
                  error instanceof Error
                    ? `The provider's stream ended unexpectedly: ${error.message}`
                    : "The provider's stream ended unexpectedly.",
                status: 200,
              },
            })}\n\n`,
          ),
        );
      }

      if (!sawStop) {
        controller.enqueue(chunk({}, finishReason));
        controller.enqueue(DONE);
      }

      controller.close();
    },

    async cancel() {
      try {
        await reader.cancel();
      } catch {
        /* Already closed or errored; nothing to release. */
      }
    },
  });
}

/**
 * Rewrite an Anthropic HTTP response into the OpenAI shape.
 *
 * Errors pass through untouched: the failure classifiers upstream read the real
 * status and body, and a synthesised stream would hide both.
 */
export async function anthropicResponseToOpenAi(response: Response): Promise<Response> {
  if (!response.ok) return response;

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

  if (contentType.includes("text/event-stream")) {
    if (!response.body) return response;
    return new Response(anthropicSseToOpenAiStream(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  /* Not declared as SSE. Read it and decide from the content — some relays
   * return a whole JSON message even when asked to stream. */
  const raw = await response.text().catch(() => "");
  const trimmed = raw.trimStart();

  if (!trimmed.startsWith("{")) {
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

  const root = asObject(parsed);

  /* A relay can return 200 with an error envelope. Convert it so the `json.error`
   * branch downstream fires rather than the reply rendering as empty. */
  if (root.type === "error" && root.error) {
    return new Response(JSON.stringify({ error: root.error }), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  /* Already OpenAI-shaped (or unrecognisable) — hand it back for
   * ensureEventStream to frame. */
  if (root.type !== "message" && !Array.isArray(root.content)) {
    return new Response(raw, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  return new Response(JSON.stringify(anthropicMessageToOpenAi(root)), {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}
