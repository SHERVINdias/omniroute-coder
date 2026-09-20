/**
 * GET /api/external-models — retired.
 * ---------------------------------------------------------------------------
 * WHY THIS IS GONE
 *
 * This route never worked. It imported `getSessionUser` from "@/lib/authGuard",
 * which that module does not export — the exports are `currentUser`,
 * `requireUser` and `requireAdmin`. Any call would fail at the import, so the
 * "fetch models from an external provider" path it was meant to provide had
 * been dead since it was written.
 *
 * It also hardcoded `authScheme: 'bearer'`, which is wrong for Azure (`api-key`)
 * and Anthropic (`x-api-key`), and assumed a `/models` endpoint exists — Azure
 * publishes none.
 *
 * GET /api/models now covers this. It accepts the same `?provider=<id>` query,
 * resolves the profile from src/lib/providerProfiles.ts so the right auth header
 * and path suffix are used, and falls back to the user's manually-entered model
 * ids when a provider has no catalogue endpoint.
 *
 * Kept as an explicit 410 so a stale client gets a readable answer.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      error:
        "/api/external-models has been removed. Use GET /api/models?provider=<id> — it handles gateway, third-party and local providers. See PROVIDERS.md.",
      code: "ROUTE_RETIRED",
    },
    { status: 410 },
  );
}
