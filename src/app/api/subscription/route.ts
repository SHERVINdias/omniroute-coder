/**
 * API Route: /api/subscription
 * ---------------------------------------------------------------------------
 * Subscription status, payment orders, and referral redemption — for the signed
 * in user, and only for the signed in user.
 *
 * THE HOLE THIS CLOSES
 *
 * The previous version authenticated nothing. It read `email` from the query
 * string or the request body and acted on that account:
 *
 *     POST /api/subscription
 *     { "email": "someone@else.com", "action": "upgrade",
 *       "upiTransactionId": "x" }
 *
 * That single request granted PRO to an arbitrary account, from an arbitrary
 * unauthenticated caller, with a one-character payment reference. There was no
 * check that the caller owned the address, and no check that any money had
 * moved. Admin controls are meaningless while this exists, so it is fixed here
 * rather than left for later.
 *
 * Now: the acting user comes from the session, every write is scoped to that
 * user's own id, and `email` in the request body is ignored entirely.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/authGuard";
import {
  getSubscriptionStatus,
  canUseDeepCowork,
  useReferralCode,
  getPaymentTarget,
  currentPriceRupees,
} from "@/lib/subscription";
import {
  createOrGetOrder,
  submitUtr,
  getOrdersForUser,
  getOrderById,
  describeOrder,
  cancelOrder,
} from "@/lib/upi";
import { rateLimit, rateLimitByIp, formatRetryAfter } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* Redemption is a guessing game if left unthrottled: a referral code is a
 * bearer credential, and unlimited attempts turn 30^8 into a matter of time. */
const REDEEM_LIMIT = { limit: 10, windowMs: 10 * 60_000, blockMs: 30 * 60_000 };
/* UTR submission is cheap to get wrong honestly, but is also the obvious place
 * to probe for another customer's reference. */
const SUBMIT_LIMIT = { limit: 15, windowMs: 10 * 60_000, blockMs: 10 * 60_000 };

export async function GET(request: NextRequest) {
  try {
    const auth = requireUser(request);
    if (!auth.ok) return auth.response;

    const user = auth.user;
    const action = request.nextUrl.searchParams.get("action") ?? "status";

    if (action === "check") {
      /* Kept for the existing caller: "may I run Deep Cowork right now". */
      const verdict = canUseDeepCowork(user.email);
      return NextResponse.json({
        user: { id: user.id, email: user.email, tier: user.tier },
        canUse: verdict,
        usageToday: verdict.usageToday ?? 0,
        status: getSubscriptionStatus(user.id),
      });
    }

    if (action === "orders") {
      return NextResponse.json({
        orders: getOrdersForUser(user.id).map((order) => describeOrder(order)),
      });
    }

    if (action === "payment-target") {
      const target = getPaymentTarget();
      return NextResponse.json({
        configured: target.upiId !== null,
        upiId: target.upiId,
        payeeName: target.payeeName,
        priceRupees: currentPriceRupees(),
      });
    }

    /* Default: full status bundle. */
    const status = getSubscriptionStatus(user.id);
    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        tier: status?.tier ?? user.tier,
      },
      status,
      subscription: status?.subscription ?? null,
      usageToday: status?.usageToday ?? 0,
    });
  } catch (error) {
    console.error("[subscription GET]", error);
    return NextResponse.json(
      { error: "Could not load subscription details." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = requireUser(request);
    if (!auth.ok) return auth.response;

    const user = auth.user;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
    }

    const action = typeof body.action === "string" ? body.action : "";
    const str = (key: string): string =>
      typeof body[key] === "string" ? (body[key] as string).trim() : "";

    switch (action) {
      /* ---------------------------------------------------------------
       * Start (or resume) a payment
       * -------------------------------------------------------------- */
      case "create-order": {
        const result = createOrGetOrder({ id: user.id, email: user.email });
        if (!result.ok) {
          return NextResponse.json(
            { error: result.error, code: result.code },
            { status: result.code === "NOT_CONFIGURED" ? 503 : 409 },
          );
        }
        return NextResponse.json({
          success: true,
          reused: result.reused,
          ...result.instructions,
          /* Spelled out because the surcharge is real money and the customer
           * should never discover it only in their bank statement. */
          amountNotice:
            "The amount includes a few extra paise that identify your payment. Pay the exact amount shown.",
        });
      }

      /* ---------------------------------------------------------------
       * Submit the bank reference
       * -------------------------------------------------------------- */
      case "submit-utr":
      case "upgrade": {
        const gate = rateLimit(`utr:${user.id}`, SUBMIT_LIMIT);
        if (!gate.ok) {
          return NextResponse.json(
            {
              error: `Too many submissions. Try again in ${formatRetryAfter(gate.retryAfterMs)}.`,
            },
            { status: 429 },
          );
        }

        /* `upiTransactionId` is the field name the existing panel sends. */
        const utr = str("utr") || str("upiTransactionId");
        if (!utr) {
          return NextResponse.json(
            { error: "Enter the UTR / transaction reference from your payment app." },
            { status: 400 },
          );
        }

        /* Resolve which order this is for. An explicit id wins; otherwise use
         * the customer's one open order. */
        let orderId = str("orderId");
        if (!orderId) {
          const open = getOrdersForUser(user.id, 5).find(
            (o) => o.status === "CREATED",
          );
          if (!open) {
            return NextResponse.json(
              {
                error:
                  "There is no open payment to attach that reference to. Start a payment first.",
                code: "NO_OPEN_ORDER",
              },
              { status: 409 },
            );
          }
          orderId = open.id;
        }

        const result = submitUtr(orderId, user.id, utr);
        if (!result.ok) {
          const status =
            result.code === "NOT_FOUND"
              ? 404
              : result.code === "DUPLICATE_UTR"
                ? 409
                : 400;
          return NextResponse.json(
            { error: result.error, code: result.code },
            { status },
          );
        }

        return NextResponse.json({
          success: true,
          autoApproved: result.autoApproved,
          order: result.order,
          status: getSubscriptionStatus(user.id),
          message: result.autoApproved
            ? "Payment approved — your account is now PRO."
            : "Reference received. An admin will confirm the payment against the bank credit, usually within a few hours.",
        });
      }

      /* ---------------------------------------------------------------
       * Abandon an unpaid order
       * -------------------------------------------------------------- */
      case "cancel-order": {
        const orderId = str("orderId");
        if (!orderId) {
          return NextResponse.json({ error: "Order id is required." }, { status: 400 });
        }
        const cancelled = cancelOrder(orderId, user.id);
        return NextResponse.json({
          success: cancelled,
          message: cancelled
            ? "Payment cancelled."
            : "That payment could not be cancelled — it may already be submitted.",
        });
      }

      /* ---------------------------------------------------------------
       * Poll one order
       * -------------------------------------------------------------- */
      case "order-status": {
        const orderId = str("orderId");
        const order = orderId ? getOrderById(orderId) : null;
        if (!order || order.userId !== user.id) {
          return NextResponse.json({ error: "Payment order not found." }, { status: 404 });
        }
        return NextResponse.json({
          success: true,
          ...describeOrder(order),
          status: getSubscriptionStatus(user.id),
        });
      }

      /* ---------------------------------------------------------------
       * Referral redemption
       * -------------------------------------------------------------- */
      case "apply-referral": {
        const gate = rateLimit(`referral:${user.id}`, REDEEM_LIMIT);
        const ipGate = rateLimitByIp("referral:ip", request, REDEEM_LIMIT);
        if (!gate.ok || !ipGate.ok) {
          const wait = Math.max(gate.retryAfterMs, ipGate.retryAfterMs);
          return NextResponse.json(
            {
              error: `Too many referral attempts. Try again in ${formatRetryAfter(wait)}.`,
            },
            { status: 429 },
          );
        }

        const code = str("referralCode") || str("code");
        if (!code) {
          return NextResponse.json({ error: "Enter a referral code." }, { status: 400 });
        }

        const result = useReferralCode(user.email, code);
        if (!result.success) {
          return NextResponse.json({ error: result.message }, { status: 400 });
        }

        return NextResponse.json({
          success: true,
          message: result.message,
          tier: result.tier,
          status: getSubscriptionStatus(user.id),
        });
      }

      /* ---------------------------------------------------------------
       * Payee details (legacy action name kept)
       * -------------------------------------------------------------- */
      case "get-upi": {
        const target = getPaymentTarget();
        if (!target.upiId) {
          return NextResponse.json(
            { error: "Payments are not set up yet. Ask the admin to add a UPI ID." },
            { status: 503 },
          );
        }
        return NextResponse.json({
          upiId: target.upiId,
          payeeName: target.payeeName,
          priceRupees: currentPriceRupees(),
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action || "(none)"}` },
          { status: 400 },
        );
    }
  } catch (error) {
    console.error("[subscription POST]", error);
    return NextResponse.json(
      { error: "Could not process that request." },
      { status: 500 },
    );
  }
}
