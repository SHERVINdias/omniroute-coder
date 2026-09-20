/**
 * src/lib/skills/readJsonBody.ts
 * ---------------------------------------------------------------------------
 * Read a JSON request body with a hard byte cap.
 *
 * WHY THIS EXISTS
 *
 * `await req.json()` reads the entire body into memory before anything gets to
 * inspect it. The skill routes cap a *document* at 64 KB, but that check runs
 * on a string that has already been allocated — so a POST carrying 500 MB is
 * accepted, buffered, and only then rejected for being too long. On this
 * deployment the container is capped at 1.6 GiB, which makes that an
 * out-of-memory kill rather than a 400.
 *
 * Authentication does not fix it: the caller is a signed-in user, and the rate
 * limit on the route allows twenty attempts a minute, which is nineteen more
 * than are needed. The skills routes are the ones that invite a large paste, so
 * the cap goes here.
 *
 * WHY NOT JUST CHECK `content-length`
 *
 * It is a claim by the client, it is absent on chunked uploads, and a body can
 * simply be longer than it says. Reading the stream and counting the bytes that
 * actually arrive is the only version that holds: the read is abandoned the
 * moment the cap is passed, so the peak allocation is the cap and not whatever
 * the sender decided to send.
 *
 * NOTE: this is a per-route guard, not an app-wide one. Other routes still use
 * `req.json()` directly and have the same exposure. Fixing that properly means
 * a body limit at the proxy (Caddy's `request_body max_size`) or in middleware,
 * which is a deployment change rather than a code change — it is written up in
 * the hardening notes rather than fixed silently here.
 */

import type { NextRequest } from "next/server";

export type BodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 413 | 400; error: string };

/** 256 KB. Comfortably above the 64 KB document cap plus JSON escaping
 *  overhead, comfortably below anything that threatens the container. */
export const MAX_BODY_BYTES = 256 * 1024;

export async function readJsonBody(
  req: NextRequest,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<BodyResult> {
  const stream = req.body;
  if (!stream) return { ok: true, body: {} };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        /* Stop pulling. Without this the sender keeps streaming into a socket
         * we have already given up on. */
        await reader.cancel().catch(() => {});
        return {
          ok: false,
          status: 413,
          error: `That is larger than the ${Math.floor(maxBytes / 1024)} KB limit for this request.`,
        };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: "The request body could not be read." };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(merged);
  } catch {
    return { ok: false, status: 400, error: "The request body was not valid text." };
  }

  if (!text.trim()) return { ok: true, body: {} };

  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: "Expected a JSON object." };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, error: "The request body was not valid JSON." };
  }
}
