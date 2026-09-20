/**
 * /api/chats — the sidebar list, scoped to the signed-in user.
 *
 * WHAT CHANGED AND WHY
 *
 * Both methods were unauthenticated and unscoped: GET returned every chat in
 * the database to anyone who asked, including the title and a preview of the
 * last message. With one local user that was the whole feature; with two
 * accounts it is a disclosure of one person's conversations to another.
 *
 * Both now require a session and pass the user id through to the store, which
 * fixes the ownership predicate into the prepared statement rather than
 * assembling it per request.
 */

import { NextRequest, NextResponse } from "next/server";
import { getChats, ensureChat, pruneEmptyChats, deriveTitle } from "@/lib/db";
import { requireUser } from "@/lib/authGuard";

export const runtime = "nodejs";

/* A chat list must never be cached — it changes on every turn. */
export const dynamic = "force-dynamic";

/**
 * GET /api/chats — the sidebar list.
 *
 * Each row carries `message_count` and a `preview` of the last message, so the
 * sidebar can show something more useful than a bare title.
 *
 * The prune clears rows left by a client that created chats but never wrote
 * messages. It only touches empty chats older than an hour — POST below
 * deliberately creates an empty chat, and without that grace window this GET
 * would delete the row its own POST created moments earlier.
 */
export async function GET(request: NextRequest) {
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;

  try {
    pruneEmptyChats();
    const chats = getChats(guard.user.id);
    return NextResponse.json({ chats });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[chats] GET failed:", message);
    return NextResponse.json({ error: message, chats: [] }, { status: 500 });
  }
}

/**
 * POST /api/chats — create a chat, idempotently.
 *
 * Safe to call repeatedly with the same id, which is what makes it usable from
 * a "New chat" button the user may click twice.
 *
 * The normal path does not need this at all — /api/chat creates the chat as it
 * saves the first user message. This endpoint stays for explicit creation and
 * for clients that want the row to exist up front.
 */
export async function POST(request: NextRequest) {
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;

  try {
    const body = await request
      .json()
      .catch(() => ({}) as Record<string, unknown>);
    const rawId = typeof body.id === "string" ? body.id.trim() : "";
    const rawTitle = typeof body.title === "string" ? body.title.trim() : "";

    const id =
      rawId || `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const title = rawTitle ? deriveTitle(rawTitle) : "New Conversation";

    /* ensureChat adopts an existing unowned row and otherwise refuses to touch
     * a chat belonging to someone else, so a guessed id cannot be hijacked. */
    const chat = ensureChat(id, title, guard.user.id);
    return NextResponse.json({ chat });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[chats] POST failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
