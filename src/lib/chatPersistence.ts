/**
 * src/lib/chatPersistence.ts
 * ---------------------------------------------------------------------------
 * Server-side persistence for one conversational turn.
 *
 * WHY THIS EXISTS
 *
 * Nothing in the app ever wrote a chat. page.tsx had GET /api/chats, GET
 * /api/chats/[id] and DELETE /api/chats/[id] but no POST anywhere, and
 * /api/chat/route.ts contained no reference to `chatId` at all even though the
 * client was faithfully sending one in the request body. So the sidebar was
 * reading a table that had no writer, and "a new chat is never created" was the
 * exact, literal truth.
 *
 * WHY SERVER-SIDE RATHER THAN IN page.tsx
 *
 * Saving from the client means a closed tab, a crashed render or a lost network
 * connection loses the turn. The server already has the whole stream passing
 * through one `send()` choke point, so it can record the user message before a
 * single token is generated and the assistant message even if the client walks
 * away mid-stream. That is the difference between "it saves" and the
 * "production grade" that was asked for.
 *
 * DESIGN NOTE
 *
 * `observe()` takes the flat SSE envelope the route already emits, so wiring
 * this into the route is a single line inside `send()` rather than a dozen call
 * sites. It also means every future event kind is captured for free — which is
 * what the "show the full updated files" feature will read later.
 *
 * Nothing here is allowed to throw. A persistence failure must degrade the app
 * to its current behaviour (chat works, history does not), never break a live
 * stream.
 */

import {
  saveUserTurn,
  saveMessage,
  updateChatTimestamp,
  enforceRetention,
  type MessageRecord,
} from "@/lib/db";

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Coerce whatever the model/client sent into the plain text we store. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

interface IncomingMessage {
  role?: unknown;
  content?: unknown;
  experimental_attachments?: unknown;
}

/**
 * The turn being persisted is always the *last* user message in the payload.
 * The client resends the entire history on every request, so anything earlier
 * is already on disk and re-saving it would be wasted writes at best and
 * duplicate rows at worst.
 */
function lastUserMessage(messages: unknown): IncomingMessage | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i] as IncomingMessage | null;
    if (entry && typeof entry === "object" && entry.role === "user") {
      return entry;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------
 * TurnRecorder
 * ---------------------------------------------------------------------- */

export class TurnRecorder {
  readonly chatId: string;
  readonly assistantId: string;

  private text = "";
  private meta: Record<string, unknown> = {};
  private settled = false;

  constructor(
    chatId: string,
    assistantId: string,
    seed: Record<string, unknown>,
  ) {
    this.chatId = chatId;
    this.assistantId = assistantId;
    this.meta = { ...seed };
  }

  /**
   * Feed the flat SSE envelope in as it is sent to the client.
   *
   * The branch order mirrors the client's own handler in page.tsx, so what gets
   * stored and what gets rendered can never drift apart.
   */
  observe(event: unknown): void {
    if (this.settled || !event || typeof event !== "object") return;
    const evt = event as Record<string, unknown>;

    try {
      if (typeof evt.delta === "string") {
        this.text += evt.delta;
      } else if (evt.notice) {
        const notices = (this.meta.notices as unknown[]) ?? [];
        notices.push(evt.notice);
        this.meta.notices = notices;
      } else if (typeof evt.tool === "string") {
        const tools = (this.meta.toolCalls as string[]) ?? [];
        tools.push(evt.tool);
        this.meta.toolCalls = tools;
      } else if (evt.route) {
        this.meta.route = evt.route;
      } else if (evt.plan) {
        this.meta.plan = evt.plan;
      } else if (evt.task) {
        this.meta.task = evt.task;
      } else if (evt.budget) {
        this.meta.budget = evt.budget;
      } else if (typeof evt.error === "string") {
        this.meta.error = evt.error;
      }
    } catch {
      /* Observation must never disturb the stream. */
    }
  }

  /** Attach anything the envelope does not carry. */
  annotate(patch: Record<string, unknown>): void {
    this.meta = { ...this.meta, ...patch };
  }

  /**
   * Persist the assistant half. Safe to call more than once; only the first
   * call writes.
   *
   * An assistant turn that produced no text at all is deliberately *not*
   * stored: a failed request should leave the user's message in the history to
   * retry from, not an empty bubble underneath it. The chat timestamp is still
   * bumped so the sidebar order stays honest.
   */
  finish(): void {
    if (this.settled) return;
    this.settled = true;

    try {
      const content = this.text.trim();
      if (!content) {
        updateChatTimestamp(this.chatId);
        return;
      }
      saveMessage(
        this.assistantId,
        this.chatId,
        "assistant",
        this.text,
        this.meta,
      );
    } catch (err) {
      console.error(
        "[chatPersistence] could not save assistant message:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/* -------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------- */

export interface BeginTurnArgs {
  chatId: unknown;
  messages: unknown;
  model?: string | null;
  mode?: string | null;
  /**
   * Who this turn belongs to. Required: chats are owned now, and a turn saved
   * without an owner would be invisible to the person who just sent it in
   * production, where unowned rows are filtered out.
   */
  userId: string;
}

/**
 * Record the user message (creating the chat if needed) and hand back a
 * recorder for the assistant half.
 *
 * Returns null — never throws — when there is nothing sane to persist or the
 * database is unavailable. The caller treats null as "history is off for this
 * request" and carries on streaming.
 */
export function beginTurn(args: BeginTurnArgs): TurnRecorder | null {
  try {
    const chatId =
      typeof args.chatId === "string" && args.chatId.trim()
        ? args.chatId.trim()
        : null;
    if (!chatId) return null;

    if (!args.userId) return null;

    const incoming = lastUserMessage(args.messages);
    if (!incoming) return null;

    const content = textOf(incoming.content);

    const attachments = incoming.experimental_attachments;
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    /* An image dropped in with no caption is a real turn. Requiring text here
     * would silently drop it — and then the assistant's reply would be saved
     * under it with nothing to explain what it was replying to. */
    if (!content.trim() && !hasAttachments) return null;

    const userMetadata = hasAttachments
      ? { experimental_attachments: attachments }
      : undefined;

    saveUserTurn({
      chatId,
      messageId: randomId("usr"),
      content,
      metadata: userMetadata,
      model: args.model ?? null,
      mode: args.mode ?? null,
      userId: args.userId,
    });

    /* Apply the per-account storage caps, once per turn, here rather than
     * inside saveUserTurn.
     *
     * Two reasons it is outside that transaction. Retention swallows its own
     * errors so housekeeping can never fail a chat turn — and an error caught
     * *inside* an open transaction leaves the enclosing statement half-applied
     * rather than rolled back, which is the opposite of what swallowing it was
     * meant to achieve. And the chat must already exist and be the most
     * recently updated row before the chat-count cap runs, or the cap would
     * consider the conversation being started right now a candidate for
     * deletion.
     *
     * With neither OMNIROUTE_MAX_CHATS_PER_USER nor
     * OMNIROUTE_MAX_MESSAGES_PER_CHAT set this returns immediately without
     * issuing a query, so the default install pays nothing for it. */
    enforceRetention(args.userId, chatId);

    return new TurnRecorder(chatId, randomId("ast"), {
      model: args.model ?? null,
      mode: args.mode ?? null,
    });
  } catch (err) {
    console.error(
      "[chatPersistence] could not begin turn:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export type { MessageRecord };
