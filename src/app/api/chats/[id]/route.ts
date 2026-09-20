/**
 * /api/chats/[id] — one transcript, scoped to its owner.
 *
 * WHAT CHANGED AND WHY
 *
 * All three methods took an id straight from the URL and acted on it with no
 * authentication and no ownership check. Chat ids are guessable (`chat-` plus a
 * timestamp), so this was enough to read, rename or delete anyone's
 * conversation by iterating plausible ids.
 *
 * Every method now requires a session and goes through the ownership-aware
 * accessors. A chat that exists but belongs to someone else returns the same
 * 404 as one that does not exist — distinguishing them would confirm the id is
 * real, which is a small disclosure worth avoiding.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getMessagesForUser,
  getChatForUser,
  deleteChat,
  renameChat,
  parseMetadata,
} from "@/lib/db";
import { requireUser } from "@/lib/authGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = { error: "No such chat." };

/**
 * GET /api/chats/[id] — the transcript.
 *
 * The response keeps the original `{ messages }` shape so page.tsx keeps
 * working unchanged, and adds two things:
 *
 *  - `experimental_attachments`, lifted out of the stored metadata. page.tsx
 *    already reads this field when loading a chat; until it was written, images
 *    silently disappeared on reload.
 *  - `metadata`, the full blob (tool calls, route info, and the list of files an
 *    agent run touched).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;

  try {
    const { id } = await params;

    const chat = getChatForUser(id, guard.user.id);
    const rows = getMessagesForUser(id, guard.user.id);

    /* null means "not yours or not there" — same answer either way. */
    if (!chat || rows === null) {
      return NextResponse.json({ ...NOT_FOUND, messages: [] }, { status: 404 });
    }

    const messages = rows.map((row) => {
      const meta = parseMetadata(row.metadata);
      return {
        id: row.id,
        role: row.role,
        content: row.content,
        created_at: row.created_at,
        ...(meta.experimental_attachments
          ? { experimental_attachments: meta.experimental_attachments }
          : {}),
        metadata: meta,
      };
    });

    return NextResponse.json({ chat, messages });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[chats/:id] GET failed:", message);
    return NextResponse.json({ error: message, messages: [] }, { status: 500 });
  }
}

/**
 * PATCH /api/chats/[id] — rename.
 *
 * Titles are auto-derived from the first user message, which is right most of
 * the time and wrong often enough to need an override.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;

  try {
    const { id } = await params;
    const body = await request
      .json()
      .catch(() => ({}) as Record<string, unknown>);
    const title = typeof body.title === "string" ? body.title.trim() : "";

    if (!title) {
      return NextResponse.json(
        { error: "A non-empty title is required." },
        { status: 400 },
      );
    }

    /* renameChat returns undefined when the row is not the caller's, so the
     * ownership check and the write are one statement — no gap in between for
     * the row to change hands. */
    const chat = renameChat(id, title, guard.user.id);
    if (!chat) return NextResponse.json(NOT_FOUND, { status: 404 });

    return NextResponse.json({ chat });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[chats/:id] PATCH failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/chats/[id].
 *
 * `deleteChat` removes the messages explicitly rather than trusting
 * ON DELETE CASCADE, which never fired before because SQLite disables foreign
 * keys unless the connection turns them on.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;

  try {
    const { id } = await params;

    const removed = deleteChat(id, guard.user.id);
    if (!removed) return NextResponse.json(NOT_FOUND, { status: 404 });

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[chats/:id] DELETE failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
