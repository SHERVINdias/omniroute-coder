/**
 * src/app/api/pdf/generate/route.ts — RETIRED
 * ---------------------------------------------------------------------------
 * This endpoint rendered Markdown to PDF by launching headless Chrome through
 * Puppeteer on every request, with no session check. Two problems:
 *
 *   1. It was a public resource sink. Each call spawned a browser process; a
 *      handful of concurrent requests could exhaust the server's memory.
 *   2. Nothing in the app called it. `page.tsx` posts to
 *      /api/chat/generate-document, which renders in-process without a browser.
 *      This route was superseded and left behind, still reachable.
 *
 * It is kept as a tombstone rather than deleted so that an old client, a stale
 * tab or a bookmark gets a clear 410 and a reason — instead of the confusing
 * 404 that a missing route would give.
 *
 * Both GET and POST are exported and both answer 410. That is the tombstone:
 * the handlers exist so the reason is deliverable. Nothing here launches a
 * browser, so the resource-sink problem above is gone regardless of who calls
 * it — which is why these two are safe to leave unauthenticated.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      code: "GONE",
      error:
        "This endpoint has been retired. Use POST /api/chat/generate-document instead.",
    },
    { status: 410 },
  );
}

export async function GET() {
  return NextResponse.json(
    {
      success: false,
      code: "GONE",
      error:
        "This endpoint has been retired. Use POST /api/chat/generate-document instead.",
    },
    { status: 410 },
  );
}
