/**
 * src/lib/authGuard.ts
 * ---------------------------------------------------------------------------
 * One way to answer "who is calling, and are they allowed to".
 *
 * WHY THIS EXISTS
 *
 * Authorization was previously decided independently in three places, with
 * three different answers:
 *
 *   /api/auth/*        read a Bearer token and validated it,
 *   /api/admin         compared a shared password — default "admin123" — that
 *                      the client sent in a GET query string,
 *   /api/subscription  checked nothing at all. It took an `email` field from
 *                      the request body and acted on that account. Anyone could
 *                      POST {email: someone@else.com, action: "upgrade"} and
 *                      change another person's tier, or their own.
 *
 * Every protected route now goes through requireUser or requireAdmin, and the
 * acting identity always comes from the session — never from a field the caller
 * controls.
 *
 * TOKEN TRANSPORT
 *
 * The session token is set as an httpOnly cookie, which script on the page
 * cannot read, so an XSS bug cannot exfiltrate it. The existing client also
 * keeps a copy in localStorage and sends `Authorization: Bearer`, so the cookie
 * is read first and the header is accepted as a fallback. That keeps the whole
 * app working during the transition rather than logging everyone out at once.
 */

import { NextResponse, type NextRequest } from "next/server";
import { validateSession, isAdmin, type AuthUser } from "./emailAuth";
import { cachedVerdict } from "./licence";

/**
 * Re-exported so a route can take its whole authorization surface from this one
 * module.
 *
 * /api/credits imported `isAdmin` from here and the production build stopped
 * with "Export isAdmin doesn't exist in target module": the name was imported
 * for internal use in `requireAdmin` and `publicUser` but never forwarded. This
 * file exists so that authorization is decided in exactly one place; making
 * callers reach past it into emailAuth would undo that.
 */
export { isAdmin };

/** Name of the httpOnly session cookie. */
export const SESSION_COOKIE = "omniroute_session";

export type GuardResult =
  | { ok: true; user: AuthUser }
  | { ok: false; response: NextResponse };

/**
 * Pull the session token from the request.
 *
 * Cookie first: it is the channel the server controls and the one that cannot
 * be read by injected script. The Authorization header is the compatibility
 * path for the current client.
 */
export function readSessionToken(request: NextRequest): string | null {
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (cookie) return cookie;

  const header = request.headers.get("authorization") ?? "";
  /* Case-insensitive scheme, tolerant of extra whitespace. */
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/** Resolve the caller, or null when there is no valid session. */
export function currentUser(request: NextRequest): AuthUser | null {
  const token = readSessionToken(request);
  return token ? validateSession(token) : null;
}

/**
 * Options for requireUser.
 *
 * `skipEntitlement` exists for the handful of routes that must run BEFORE the
 * desktop licence is settled: the licence refresh route (which writes the cache
 * the entitlement check reads — gating it would be a deadlock), and the auth
 * routes (sign-in must work so an install can be activated in the first place).
 */
export interface RequireUserOptions {
  skipEntitlement?: boolean;
}

/**
 * The cached-verdict reasons that block a request on the desktop build.
 *
 * `never-activated` and (transient) states are deliberately NOT blocked here:
 * a freshly signed-in user has no cached blob yet, and blocking them before the
 * first refresh completes would lock them out of the very routes that trigger
 * the refresh. Enforcement bites once a hard-negative verdict has been cached —
 * revoked, expired, past grace, or a tampered signature. Off the desktop build
 * cachedVerdict() always allows, so this is a no-op on servers and in dev.
 */
const ENTITLEMENT_BLOCKING = new Set([
  "revoked",
  "expired",
  "grace-expired",
  "no-signature",
]);

/**
 * Require any signed-in user.
 *
 * Returns a discriminated result rather than throwing, so route handlers stay
 * linear: `const auth = requireUser(req); if (!auth.ok) return auth.response;`
 *
 * On the desktop build this also enforces the licence: a revoked, expired, or
 * past-grace install is refused with 403 even though its session is valid, so a
 * revocation bites within one request for an already-running session. The coarse
 * launch-time check in desktop/main.js is the other half.
 */
export function requireUser(
  request: NextRequest,
  options: RequireUserOptions = {},
): GuardResult {
  const user = currentUser(request);
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Please sign in to continue.", code: "UNAUTHENTICATED" },
        { status: 401 },
      ),
    };
  }

  if (!options.skipEntitlement) {
    const verdict = cachedVerdict();
    if (!verdict.allowed && ENTITLEMENT_BLOCKING.has(verdict.reason)) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: verdict.detail,
            code: "LICENCE_BLOCKED",
            reason: verdict.reason,
          },
          { status: 403 },
        ),
      };
    }
  }

  return { ok: true, user };
}

/**
 * Require an admin.
 *
 * Deliberately answers 403 rather than 404 for a signed-in non-admin. This is a
 * single-operator app on localhost; hiding the existence of the admin API buys
 * nothing and makes a legitimate permission problem much harder to diagnose.
 */
export function requireAdmin(request: NextRequest): GuardResult {
  const auth = requireUser(request);
  if (!auth.ok) return auth;

  if (!isAdmin(auth.user)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "This action requires an admin account.", code: "FORBIDDEN" },
        { status: 403 },
      ),
    };
  }
  return auth;
}

/* -------------------------------------------------------------------------
 * Cookie helpers
 * ---------------------------------------------------------------------- */

/**
 * Attach the session cookie to a response.
 *
 * `secure` is set only outside development, because a cookie marked Secure is
 * not stored by the browser over plain http://localhost — setting it
 * unconditionally would mean the cookie silently never persists during local
 * development, and the whole thing would fall back to the header path without
 * anyone noticing.
 *
 * `sameSite: "lax"` lets the cookie ride normal top-level navigations while
 * still not being attached to cross-site POSTs, which is the CSRF case that
 * matters for these endpoints.
 */
export function setSessionCookie(
  response: NextResponse,
  token: string,
  expiresAt: number,
): NextResponse {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  });
  return response;
}

/** Remove the session cookie. */
export function clearSessionCookie(response: NextResponse): NextResponse {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}

/**
 * The user shape sent to the browser.
 *
 * Built in one place so a column added to `users` cannot leak to the client by
 * accident — anything not listed here simply does not cross the boundary.
 */
export function publicUser(user: AuthUser): {
  id: string;
  email: string;
  phone: string | null;
  tier: string;
  role: string;
  isAdmin: boolean;
  createdAt: number;
  referralCode: string | null;
} {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    tier: user.tier,
    role: user.role,
    isAdmin: isAdmin(user),
    createdAt: user.createdAt,
    referralCode: user.referralCode,
  };
}
