/**
 * src/middleware.ts
 * ---------------------------------------------------------------------------
 * Default-deny gate for the cloud licence server.
 *
 * WHY DEFAULT-DENY, NOT A BLOCKLIST
 *
 * The licence server runs the SAME codebase as the desktop app, selected by
 * OMNIROUTE_ROLE=licence, so all 31 API routes are physically deployed there —
 * chat, the agent, file tools, credentials, everything. Only a handful should
 * be reachable. A blocklist of "the dangerous ones" is the exact shape that bit
 * the file-exclusion work: the day someone adds a route and forgets to add it to
 * the blocklist, it is silently exposed. So this allows ONLY the named prefixes
 * and refuses everything else under /api. A new route is closed until someone
 * deliberately opens it in licenceAllowlist.json — and scripts/check-licence-
 * routes.mjs fails the build if a route exists that is classified neither way.
 *
 * SCOPE
 *
 * Only /api/* is gated, and only when OMNIROUTE_ROLE=licence. On the desktop app
 * and on the full server (no role, or role != licence) this middleware is a
 * pass-through — it changes nothing. Non-API pages are left alone; with the
 * dangerous APIs closed they have nothing to call, and the sign-in pages the
 * admin needs still work.
 */

import { NextResponse, type NextRequest } from "next/server";

import allowlist from "@/lib/licenceAllowlist.json";

const ALLOWED = new Set<string>(allowlist.allowedApiPrefixes);

function isLicenceServer(): boolean {
  return process.env.OMNIROUTE_ROLE?.trim() === "licence";
}

/** First path segment after /api, e.g. "/api/auth/send-otp" -> "auth". */
function topApiSegment(pathname: string): string | null {
  const m = /^\/api\/([^/]+)/.exec(pathname);
  return m?.[1] ?? null;
}

export function middleware(request: NextRequest) {
  if (!isLicenceServer()) return NextResponse.next();

  const { pathname } = request.nextUrl;
  const segment = topApiSegment(pathname);

  /* Not an /api route (or malformed) — leave pages alone. */
  if (segment === null) return NextResponse.next();

  if (ALLOWED.has(segment)) return NextResponse.next();

  return NextResponse.json(
    {
      error: "This endpoint is not available on the licence server.",
      code: "NOT_ON_LICENCE_SERVER",
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}

/* Run only for API routes; pages never enter the matcher, so the licence
 * server's own sign-in UI is untouched. */
export const config = {
  matcher: ["/api/:path*"],
};
