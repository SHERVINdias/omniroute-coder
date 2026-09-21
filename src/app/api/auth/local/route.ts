/**
 * POST /api/auth/local
 * ---------------------------------------------------------------------------
 * Silent sign-in for the desktop build.
 *
 * A packaged desktop install is single-user and has no way to email a sign-in
 * code (we deliberately do not ship email credentials inside the app). So on
 * the desktop build this route signs the user in as a fixed LOCAL account with
 * no OTP: it finds-or-creates that account, issues a real session, and sets the
 * session cookie. The desktop preload calls it once on first launch, so the
 * user never sees a sign-in screen.
 *
 * SAFETY
 *
 * Gated on isDesktopBuild() — on a server or in dev it returns 404, so it can
 * never be used to mint an account elsewhere. On a single-user desktop this
 * grants no access the person at the keyboard does not already have: they
 * installed and launched the app. Each install has its own local database, so
 * "the local account" is isolated per machine.
 */

import { NextResponse } from "next/server";

import { isDesktopBuild } from "@/lib/deploymentMode";
import { getOrCreateUserByEmail, createSession } from "@/lib/emailAuth";
import { setSessionCookie, publicUser } from "@/lib/authGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The single local identity every desktop install signs in as. */
const LOCAL_USER_EMAIL = "local@omniroute.app";

export async function POST() {
  if (!isDesktopBuild()) {
    return NextResponse.json({ error: "Not available." }, { status: 404 });
  }

  const user = getOrCreateUserByEmail(LOCAL_USER_EMAIL);
  const session = createSession(user.id);

  const res = NextResponse.json(
    { token: session.token, user: publicUser(user) },
    { headers: { "cache-control": "no-store" } },
  );
  return setSessionCookie(res, session.token, session.expiresAt);
}
