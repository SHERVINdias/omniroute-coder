/**
 * POST /api/external-chat — retired.
 * ---------------------------------------------------------------------------
 * WHY THIS IS GONE
 *
 * This route predates the provider registry. It took `providerConfig` straight
 * from the request body — including a plaintext `apiKey` — and posted it to
 * whatever `baseUrl` the caller named. Two problems, both serious:
 *
 *   1. The browser had to hold a real, usable API key in memory and send it up
 *      with every message. Everything else in this app treats the key as
 *      write-only: it is encrypted at rest and never serialised back to a
 *      client. This route undid that for the exact providers it served.
 *
 *   2. There was no SSRF guard on the URL. Any signed-in user could point it at
 *      an internal address and use the server as a request proxy, with an
 *      attacker-chosen Authorization header attached.
 *
 * /api/chat now handles every provider — gateway, third-party and local —
 * through src/lib/upstreamRequest.ts, which resolves the endpoint and auth
 * scheme from the provider profile and runs the SSRF guard. The client sends a
 * provider id; the server looks up the credentials itself.
 *
 * Kept as an explicit 410 rather than deleted so that a stale browser tab or a
 * bookmarked script gets a readable answer instead of Next's HTML 404 page.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GONE = {
  error:
    "/api/external-chat has been removed. All providers now go through POST /api/chat — send { providerId } and the server resolves the credentials. See PROVIDERS.md.",
  code: "ROUTE_RETIRED",
} as const;

export async function POST() {
  return NextResponse.json(GONE, { status: 410 });
}

export async function GET() {
  return NextResponse.json(GONE, { status: 410 });
}
