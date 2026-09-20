/**
 * GET /api/health
 * ---------------------------------------------------------------------------
 * Liveness probe for the container healthcheck and for uptime monitoring.
 *
 * DELIBERATELY UNAUTHENTICATED. `docker compose` healthchecks and external
 * uptime monitors have no session, so a probe behind `requireUser` would report
 * the container unhealthy forever. That means this endpoint must be safe to
 * expose to the public internet, which shapes every decision below:
 *
 *   - It reports a coarse status, not a diagnosis. No file paths, no versions,
 *     no configuration, no error strings from the database.
 *   - A failure logs the real reason to the server console, where only the
 *     operator can see it, and returns "degraded" to the caller.
 *   - It touches the database because a process that is up but cannot read its
 *     database is not actually serving anyone. See databaseHealthy().
 *
 * The status code is the point of the whole route: 200 lets traffic in, 503
 * takes the container out of rotation. So a degraded database returns 503.
 *
 * ONE HONEST LIMITATION
 *
 * `@/lib/db` opens the database at module scope, so if the file cannot be
 * opened at all the *import* throws and this handler never runs — Next answers
 * 500 and the `[health]` line below is never printed. The container is still
 * correctly marked unhealthy, because the probe checks `r.ok` and 500 fails it
 * just as 503 does. The 503 path below is what runs when the handle opened
 * successfully and the database later became unreadable.
 */

import { NextResponse } from "next/server";
import { databaseHealthy } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const database = databaseHealthy();

  if (!database.ok) {
    /* Details stay server-side. */
    console.error(`[health] database probe failed: ${database.error ?? "unknown error"}`);
    return NextResponse.json(
      { status: "degraded", database: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(
    { status: "ok", database: "ok" },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
