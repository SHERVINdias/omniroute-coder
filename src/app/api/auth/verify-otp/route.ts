/**
 * POST /api/auth/verify-otp
 * ---------------------------------------------------------------------------
 * Exchange a one-time code for a session.
 *
 * What changed from the previous version:
 *
 *   - Rate limited. There was no throttle at all, and a 6-digit code is only a
 *     million possibilities — trivially brute-forceable at HTTP speed. The
 *     per-code attempt cap in verifyOTP is the primary defence; this is the
 *     second layer, and it also covers guessing across many identifiers.
 *   - Sets an httpOnly session cookie. The token is still returned in the body
 *     so the existing localStorage/Bearer client keeps working, but the cookie
 *     is what new server-side guards read, and script on the page cannot read
 *     it.
 *   - Distinguishes failure reasons. "Invalid or expired OTP code" for every
 *     case gave no way to tell a typo from an expired code from a code that was
 *     never sent.
 *   - Admin status comes from the database role, re-asserted against the
 *     bootstrap allowlist on every login (see emailAuth.verifyOTP), not from a
 *     string comparison at the call site.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  classifyIdentifier,
  verifyOTP,
  createSession,
  OTP_MAX_ATTEMPTS,
} from "@/lib/emailAuth";
import {
  setSessionCookie,
  publicUser,
} from "@/lib/authGuard";
import {
  rateLimit,
  rateLimitByIp,
  resetRateLimit,
  formatRetryAfter,
} from "@/lib/rateLimit";
import { fileToolsEnabled } from "@/lib/fileToolsGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* Generous enough that a person fat-fingering the code twice is fine, tight
 * enough that scripted guessing dies immediately. */
const PER_IDENTIFIER = { limit: 10, windowMs: 15 * 60_000, blockMs: 15 * 60_000 };
const PER_IP = { limit: 40, windowMs: 15 * 60_000, blockMs: 10 * 60_000 };

/** Wording for each failure, so the person knows what to actually do next. */
function describeFailure(
  reason: "no_code" | "expired" | "mismatch" | "too_many_attempts",
  attemptsRemaining: number,
): { error: string; status: number } {
  switch (reason) {
    case "no_code":
      return {
        error:
          "No sign-in code is pending for this account. Request a new one.",
        status: 400,
      };
    case "expired":
      return {
        error: "That code has expired. Request a new one.",
        status: 401,
      };
    case "too_many_attempts":
      return {
        error: `Too many incorrect attempts, so that code has been cancelled. Request a new one.`,
        status: 429,
      };
    case "mismatch":
    default:
      return {
        error:
          attemptsRemaining > 0
            ? `That code is not correct. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? "" : "s"} remaining.`
            : "That code is not correct.",
        status: 401,
      };
  }
}

export async function POST(request: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Expected a JSON body." },
        { status: 400 },
      );
    }

    const payload = body as { email?: unknown; code?: unknown };
    const rawIdentifier = typeof payload?.email === "string" ? payload.email : "";
    /* Accept a code typed with spaces, as happens when it is pasted from an
     * SMS. Anything non-numeric is stripped rather than rejected. */
    const code =
      typeof payload?.code === "string"
        ? payload.code.replace(/\D/g, "")
        : "";

    const identifier = classifyIdentifier(rawIdentifier);
    if (!identifier || code.length !== 6) {
      return NextResponse.json(
        { error: "Enter your email or mobile number and the 6-digit code." },
        { status: 400 },
      );
    }

    const ipGate = rateLimitByIp("verify:ip", request, PER_IP);
    if (!ipGate.ok) {
      return NextResponse.json(
        {
          error: `Too many attempts from this device. Try again in ${formatRetryAfter(ipGate.retryAfterMs)}.`,
          retryAfterSeconds: Math.ceil(ipGate.retryAfterMs / 1000),
        },
        { status: 429 },
      );
    }

    const idGate = rateLimit(`verify:id:${identifier.value}`, PER_IDENTIFIER);
    if (!idGate.ok) {
      return NextResponse.json(
        {
          error: `Too many attempts for this account. Try again in ${formatRetryAfter(idGate.retryAfterMs)}.`,
          retryAfterSeconds: Math.ceil(idGate.retryAfterMs / 1000),
        },
        { status: 429 },
      );
    }

    const result = verifyOTP(identifier.value, code);

    if (!result.ok) {
      const { error, status } = describeFailure(
        result.reason,
        result.attemptsRemaining,
      );
      return NextResponse.json(
        {
          error,
          reason: result.reason,
          attemptsRemaining: result.attemptsRemaining,
          maxAttempts: OTP_MAX_ATTEMPTS,
        },
        { status },
      );
    }

    const user = result.user;
    const session = createSession(user.id);

    /* A correct code clears the penalty counters. Otherwise someone who
     * mistyped a few times would stay throttled after successfully signing in,
     * and a shared-IP household would penalise each other. */
    resetRateLimit(`verify:id:${identifier.value}`);
    resetRateLimit(`otp:id:${identifier.value}`);

    const response = NextResponse.json({
      success: true,
      /* Still returned for the existing Bearer-token client. The cookie below
       * is the path that does not expose the token to page script. */
      token: session.token,
      expiresAt: session.expiresAt,
      user: publicUser(user),
      /* Deployment capability, so the UI can grey out Cowork / Deep Cowork on
       * a server where file tools are switched off — without waiting for a
       * reload to learn it. Not per-user and not sensitive. */
      features: { fileTools: fileToolsEnabled() },
    });

    return setSessionCookie(response, session.token, session.expiresAt);
  } catch (error) {
    console.error("[verify-otp]", error);
    return NextResponse.json(
      { error: "Could not verify the code. Please try again." },
      { status: 500 },
    );
  }
}
