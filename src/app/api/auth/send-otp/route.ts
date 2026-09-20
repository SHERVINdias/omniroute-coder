/**
 * POST /api/auth/send-otp
 * ---------------------------------------------------------------------------
 * Issue a one-time sign-in code.
 *
 * THE BUG THIS FIXES
 *
 * `.env.local` declares GMAIL_USER, GMAIL_APP_PASSWORD and all three TWILIO_*
 * keys with empty values. The old handler therefore computed
 * EMAIL_CONFIGURED === false and SMS_CONFIGURED === false, and every single
 * request took the Ethereal branch — a fake mailbox that accepts the message,
 * returns success, and delivers to nobody. The response said
 * "Development mode: Check console", the code went to the server terminal, and
 * from the browser it looked exactly like a code had been sent. That is why no
 * OTP ever arrived for anyone.
 *
 * Now: if a provider is configured the code is really sent. If none is, the
 * code comes back in this response and the dialog shows it, so sign-in works on
 * a fresh clone with no configuration at all. Delivery decisions live in
 * lib/otpDelivery.ts; see that file for the environment variables.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  classifyIdentifier,
  generateOTP,
  storeOTP,
  otpCooldownRemaining,
  OTP_EXPIRY_MINUTES,
} from "@/lib/emailAuth";
import { deliverOtp } from "@/lib/otpDelivery";
import { rateLimit, rateLimitByIp, formatRetryAfter } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sending a code costs the operator real money on SMS and real reputation on
 * email, and an unthrottled endpoint is a free way to spam someone else's
 * inbox. Two dimensions: per destination, so one address cannot be flooded, and
 * per source, so one client cannot walk a list of addresses.
 */
const PER_IDENTIFIER = { limit: 5, windowMs: 15 * 60_000, blockMs: 15 * 60_000 };
const PER_IP = { limit: 20, windowMs: 15 * 60_000, blockMs: 10 * 60_000 };

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

    /* The field is still called `email` because that is what the existing
     * client sends; it carries either an address or a phone number. */
    const raw =
      typeof (body as { email?: unknown })?.email === "string"
        ? (body as { email: string }).email
        : "";

    const identifier = classifyIdentifier(raw);
    if (!identifier) {
      return NextResponse.json(
        {
          error:
            "Enter a valid email address, or a 10-digit mobile number.",
        },
        { status: 400 },
      );
    }

    /* A short per-identifier cooldown stops the Resend button from firing a
     * burst of codes, each of which invalidates the last — which used to make
     * impatient double-clicking look like the code was simply wrong. */
    const cooldown = otpCooldownRemaining(identifier.value);
    if (cooldown > 0) {
      return NextResponse.json(
        {
          error: `A code was just sent. You can request another in ${cooldown} second${cooldown === 1 ? "" : "s"}.`,
          retryAfterSeconds: cooldown,
        },
        { status: 429 },
      );
    }

    const ipGate = rateLimitByIp("otp:ip", request, PER_IP);
    if (!ipGate.ok) {
      return NextResponse.json(
        {
          error: `Too many sign-in attempts from this device. Try again in ${formatRetryAfter(ipGate.retryAfterMs)}.`,
          retryAfterSeconds: Math.ceil(ipGate.retryAfterMs / 1000),
        },
        { status: 429 },
      );
    }

    const idGate = rateLimit(`otp:id:${identifier.value}`, PER_IDENTIFIER);
    if (!idGate.ok) {
      return NextResponse.json(
        {
          error: `Too many codes requested for this account. Try again in ${formatRetryAfter(idGate.retryAfterMs)}.`,
          retryAfterSeconds: Math.ceil(idGate.retryAfterMs / 1000),
        },
        { status: 429 },
      );
    }

    const code = generateOTP();

    /* Store before sending. If delivery fails after the code is stored the user
     * simply never uses it and it expires; storing after a successful send
     * would open a window where a delivered code does not yet exist here. */
    storeOTP(identifier.value, code, identifier.kind);

    const result = await deliverOtp(
      identifier.value,
      code,
      identifier.kind === "phone" ? "sms" : "email",
      OTP_EXPIRY_MINUTES,
    );

    /* When nothing could deliver and we are not permitted to reveal the code,
     * the request genuinely failed. Say so with a 502 instead of reporting
     * success for a code the person will never see. */
    if (!result.delivered && !result.revealCode) {
      return NextResponse.json(
        {
          error:
            result.error ??
            "No email or SMS provider is configured, so the code could not be delivered.",
          code: "DELIVERY_FAILED",
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      channel: result.channel,
      delivered: result.delivered,
      provider: result.provider,
      message: result.message,
      expiresInMinutes: OTP_EXPIRY_MINUTES,
      /* The code itself, when and only when otpDelivery decided it may be
       * shown. Two separate rules can permit this and they mean different
       * things to whoever is looking at the screen, so the reason travels with
       * it: "policy" is the zero-config / non-production path, "beta" is the
       * narrow AUTH_BETA_TESTERS allowlist after a real delivery failure. See
       * the header of lib/otpDelivery.ts. */
      devCode: result.revealCode ? code : undefined,
      revealReason: result.revealReason,
      developmentMode: result.revealReason === "policy",
      deliveryError: result.error,
    });
  } catch (error) {
    console.error("[send-otp]", error);
    return NextResponse.json(
      { error: "Could not send a sign-in code. Please try again." },
      { status: 500 },
    );
  }
}
