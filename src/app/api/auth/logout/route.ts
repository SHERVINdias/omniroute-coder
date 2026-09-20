/**
 * POST /api/auth/logout
 * ---------------------------------------------------------------------------
 * End the current session.
 *
 * Two changes worth noting:
 *
 *   - It reads the token from the cookie as well as the header. The previous
 *     version returned 400 when no Authorization header was present, which
 *     would leave a cookie-only client permanently signed in with no way to
 *     sign out.
 *   - Logging out is idempotent. An unknown or already-deleted token still
 *     answers 200 and still clears the cookie, because the caller's intent —
 *     "I want to be signed out" — is satisfied either way. Returning an error
 *     here only ever produces a UI that refuses to let go of a dead session.
 *
 * `?all=true` (or `{ allDevices: true }`) revokes every session for the user,
 * which is the thing to reach for if a token is believed to be compromised.
 */

import { NextResponse, type NextRequest } from "next/server";
import { deleteSession, deleteAllSessionsForUser } from "@/lib/emailAuth";
import {
  readSessionToken,
  currentUser,
  clearSessionCookie,
} from "@/lib/authGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const token = readSessionToken(request);

    /* Resolve the user before deleting the session, since deleting it makes
     * the token unresolvable. */
    const user = token ? currentUser(request) : null;

    let allDevices = request.nextUrl.searchParams.get("all") === "true";
    if (!allDevices) {
      try {
        const body = (await request.json()) as { allDevices?: unknown };
        allDevices = body?.allDevices === true;
      } catch {
        /* No body, or not JSON. The common case — logout usually posts empty. */
      }
    }

    if (user && allDevices) {
      deleteAllSessionsForUser(user.id);
    } else if (token) {
      deleteSession(token);
    }

    const response = NextResponse.json({
      success: true,
      allDevices: Boolean(user && allDevices),
      message: allDevices
        ? "Signed out on all devices."
        : "Signed out.",
    });

    return clearSessionCookie(response);
  } catch (error) {
    console.error("[auth/logout]", error);
    /* Even on an unexpected failure, clear the cookie. Being unable to sign out
     * is a worse outcome than a half-completed cleanup. */
    return clearSessionCookie(
      NextResponse.json({ success: true, message: "Signed out." }),
    );
  }
}
