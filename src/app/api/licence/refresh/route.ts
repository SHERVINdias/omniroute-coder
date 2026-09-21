/**
 * POST /api/licence/refresh
 * ---------------------------------------------------------------------------
 * In-app "re-check my licence now" for the desktop build. It uses the licence
 * KEY already stored on disk (the tester entered it at first launch — see
 * desktop/main.js), asks the cloud licence server for a fresh signed
 * entitlement, verifies and caches it, and returns the resulting verdict.
 *
 * The desktop MAIN process owns the primary refresh (launch + 12h timer). This
 * route is the equivalent a running session can call without relaunching.
 *
 * WHY skipEntitlement
 *
 * This route writes the cache the entitlement gate reads. Gating it behind that
 * same cache would be a deadlock, so it authenticates the session but skips the
 * entitlement gate.
 *
 * WHY IT IS A NO-OP OFF DESKTOP
 *
 * refreshEntitlement() returns "valid" immediately when this is not a desktop
 * build, so calling it on a server or in dev does nothing and costs nothing.
 */

import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/authGuard";
import { refreshEntitlement } from "@/lib/licence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  /* Session required, entitlement skipped — see the header. */
  const auth = requireUser(req, { skipEntitlement: true });
  if (!auth.ok) return auth.response;

  const verdict = await refreshEntitlement();
  return NextResponse.json(
    { verdict },
    { status: verdict.allowed ? 200 : 403, headers: { "cache-control": "no-store" } },
  );
}
