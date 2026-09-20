/**
 * API Route: /api/admin
 * ---------------------------------------------------------------------------
 * Referral codes, payment settings, payment review, user management.
 *
 * WHY THE PASSWORD IS GONE
 *
 * Authentication here used to be a shared password compared against
 * `process.env.ADMIN_PASSWORD || 'admin123'`. Three separate problems:
 *
 *   1. The fallback. Any install that had not set ADMIN_PASSWORD accepted
 *      "admin123" — and since the value was baked in at module load, there was
 *      no indication anywhere that the default was in use.
 *   2. The transport. GET requests passed it as `?password=...`, so it landed in
 *      the browser's history, in the dev server's access log, and in the Referer
 *      header of anything the page subsequently loaded.
 *   3. The model. A shared secret cannot say *who* acted, so there was no way to
 *      attribute an approval or a revocation to a person.
 *
 * Admin is now a role on the user record, checked through requireAdmin against
 * the session. The bootstrap allowlist in emailAuth (ADMIN_EMAILS /
 * ADMIN_PHONES, defaulting to the operator's own email and phone) is what makes
 * the first admin exist, and it is re-asserted on every login so the role cannot
 * be locked out by a bad database edit.
 *
 * Every mutating action records the acting admin's id.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/authGuard";
import {
  generateReferralCode,
  generateReferralCodes,
  getReferralCodeViews,
  deactivateReferralCode,
  deleteReferralCode,
  getAllUsers,
  getAdminStats,
  activatePro,
  revokeSubscription,
} from "@/lib/subscription";
import {
  getPaymentSettings,
  setUpiId,
  setPayeeName,
  setProPricePaise,
  setAutoApprove,
} from "@/lib/appSettings";
import { listOrders, reviewOrder, countPendingOrders, describeOrder } from "@/lib/upi";
import { deliveryStatus } from "@/lib/otpDelivery";
import {
  setUserRole,
  getUserById,
  listBootstrapAdmins,
  type UserRole,
} from "@/lib/emailAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------
 * GET — reads
 * ---------------------------------------------------------------------- */

export async function GET(request: NextRequest) {
  try {
    const auth = requireAdmin(request);
    if (!auth.ok) return auth.response;

    const action = request.nextUrl.searchParams.get("action") ?? "overview";

    switch (action) {
      /* Single round trip for the panel's initial render. The old panel made
       * four requests on open, each of which could independently 401. */
      case "overview":
        return NextResponse.json({
          success: true,
          admin: { id: auth.user.id, email: auth.user.email },
          stats: getAdminStats(),
          settings: getPaymentSettings(),
          delivery: deliveryStatus(),
          bootstrapAdmins: listBootstrapAdmins(),
          pendingPayments: countPendingOrders(),
          codes: getReferralCodeViews(),
          users: getAllUsers(),
          orders: listOrders(undefined, 50).map((order) => describeOrder(order)),
        });

      /* Both spellings answer, because the panel has historically asked for
       * "referrals" while the route only implemented "referral-codes" — which is
       * why the referral list always came back empty. */
      case "referrals":
      case "referral-codes": {
        const codes = getReferralCodeViews();
        /* Served under both keys so neither the old nor the new client breaks. */
        return NextResponse.json({ success: true, codes, referralCodes: codes });
      }

      case "users":
        return NextResponse.json({ success: true, users: getAllUsers() });

      case "settings": {
        const settings = getPaymentSettings();
        return NextResponse.json({
          success: true,
          settings,
          /* Legacy shape: the old client read `data.upiId` directly. */
          upiId: settings.upiId,
          delivery: deliveryStatus(),
        });
      }

      case "stats":
        return NextResponse.json({ success: true, stats: getAdminStats() });

      case "orders": {
        const status = request.nextUrl.searchParams.get("status");
        const orders = listOrders(
          status === "CREATED" ||
            status === "SUBMITTED" ||
            status === "APPROVED" ||
            status === "REJECTED" ||
            status === "EXPIRED"
            ? status
            : undefined,
          100,
        );
        return NextResponse.json({
          success: true,
          orders: orders.map((order) => describeOrder(order)),
          pending: countPendingOrders(),
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }
  } catch (error) {
    console.error("[admin GET]", error);
    return NextResponse.json(
      { error: "Could not load admin data." },
      { status: 500 },
    );
  }
}

/* -------------------------------------------------------------------------
 * POST — writes
 * ---------------------------------------------------------------------- */

export async function POST(request: NextRequest) {
  try {
    const auth = requireAdmin(request);
    if (!auth.ok) return auth.response;

    const admin = auth.user;

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
       * Session probe
       *
       * The old panel posted {action:'login', password} and kept the result in
       * React state, which meant every subsequent request went out anonymous.
       * Now there is nothing to log into — being an admin is a property of the
       * session — but the action is kept so the panel can confirm it before
       * rendering.
       * -------------------------------------------------------------- */
      case "login":
      case "whoami":
        return NextResponse.json({
          success: true,
          admin: { id: admin.id, email: admin.email, role: admin.role },
          message: "Signed in as an admin.",
        });

      /* ---------------------------------------------------------------
       * Referral codes
       * -------------------------------------------------------------- */
      case "generate-referral": {
        const count =
          typeof body.count === "number" ? Math.trunc(body.count) : 1;

        if (count > 1) {
          const codes = generateReferralCodes(admin.id, count);
          return NextResponse.json({
            success: true,
            codes,
            referralCodes: codes,
            message: `Generated ${codes.length} referral codes.`,
          });
        }

        const referralCode = generateReferralCode(admin.id);
        return NextResponse.json({
          success: true,
          /* Three shapes, one value. The old panel read `data.code`, the old
           * route sent `referralCode`, and neither matched — so a generated
           * code never appeared in the UI. */
          referralCode,
          code: referralCode.code,
          codes: [referralCode],
          message: `Referral code ${referralCode.code} created.`,
        });
      }

      case "deactivate-referral": {
        const code = str("code");
        if (!code) {
          return NextResponse.json(
            { error: "Which code? Pass the code string." },
            { status: 400 },
          );
        }
        const done = deactivateReferralCode(code);
        return NextResponse.json({
          success: done,
          message: done
            ? `${code} deactivated.`
            : `No code matching ${code} was found.`,
        });
      }

      case "delete-referral": {
        const code = str("code");
        if (!code) {
          return NextResponse.json({ error: "Pass the code string." }, { status: 400 });
        }
        const done = deleteReferralCode(code);
        return NextResponse.json({
          success: done,
          message: done
            ? `${code} deleted.`
            : "That code has already been redeemed, so it was kept for the record. Deactivate it instead.",
        });
      }

      /* ---------------------------------------------------------------
       * Payment settings
       * -------------------------------------------------------------- */
      case "update-upi": {
        const upiId = str("upiId");
        if (!upiId) {
          return NextResponse.json({ error: "Enter a UPI ID." }, { status: 400 });
        }
        try {
          const saved = setUpiId(upiId);
          return NextResponse.json({
            success: true,
            settings: getPaymentSettings(),
            upiId: saved,
            message: `Payments will now go to ${saved}.`,
          });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "Invalid UPI ID." },
            { status: 400 },
          );
        }
      }

      case "update-payee": {
        try {
          const saved = setPayeeName(str("payeeName"));
          return NextResponse.json({
            success: true,
            settings: getPaymentSettings(),
            message: `Payees will see "${saved}".`,
          });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "Invalid payee name." },
            { status: 400 },
          );
        }
      }

      case "update-price": {
        /* Accepts rupees from the UI, stores paise. Parsing the rupee figure
         * here rather than in the client keeps the rounding in one place. */
        const rupees =
          typeof body.priceRupees === "number"
            ? body.priceRupees
            : Number.parseFloat(str("priceRupees"));

        if (!Number.isFinite(rupees) || rupees <= 0) {
          return NextResponse.json(
            { error: "Enter a price in rupees, for example 69." },
            { status: 400 },
          );
        }
        try {
          setProPricePaise(Math.round(rupees * 100));
          return NextResponse.json({
            success: true,
            settings: getPaymentSettings(),
            message: `PRO now costs ₹${rupees.toFixed(2)}.`,
          });
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "Invalid price." },
            { status: 400 },
          );
        }
      }

      case "set-auto-approve": {
        const enabled = body.enabled === true;
        setAutoApprove(enabled);
        return NextResponse.json({
          success: true,
          settings: getPaymentSettings(),
          message: enabled
            ? "Auto-approve is ON. Any well-formed UTR now grants PRO without review — only leave this on for local testing."
            : "Auto-approve is OFF. Payments need manual approval.",
        });
      }

      /* ---------------------------------------------------------------
       * Payment review
       * -------------------------------------------------------------- */
      case "approve-payment":
      case "reject-payment": {
        const orderId = str("orderId");
        if (!orderId) {
          return NextResponse.json({ error: "Pass the order id." }, { status: 400 });
        }

        const decision = action === "approve-payment" ? "APPROVE" : "REJECT";
        const result = reviewOrder(orderId, decision, admin.id, {
          note: str("note") || undefined,
        });

        if (!result.ok) {
          return NextResponse.json(
            { error: result.error, code: result.code },
            { status: result.code === "NOT_FOUND" ? 404 : 409 },
          );
        }

        return NextResponse.json({
          success: true,
          order: result.order,
          alreadyReviewed: result.alreadyReviewed,
          pending: countPendingOrders(),
          message: result.alreadyReviewed
            ? "Already recorded — nothing changed."
            : decision === "APPROVE"
              ? "Payment approved and PRO granted."
              : "Payment rejected.",
        });
      }

      /* ---------------------------------------------------------------
       * User management
       * -------------------------------------------------------------- */
      case "set-role": {
        const userId = str("userId");
        const role = str("role").toUpperCase();
        if (!userId || (role !== "ADMIN" && role !== "USER")) {
          return NextResponse.json(
            { error: "Pass a userId and a role of ADMIN or USER." },
            { status: 400 },
          );
        }

        /* Removing your own admin rights mid-session leaves the panel you are
         * looking at broken with no way back except the env allowlist. */
        if (userId === admin.id && role === "USER") {
          return NextResponse.json(
            {
              error:
                "You cannot remove your own admin access. Ask another admin, or change the allowlist.",
            },
            { status: 400 },
          );
        }

        const result = setUserRole(userId, role as UserRole);
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }

        const updated = getUserById(userId);
        return NextResponse.json({
          success: true,
          users: getAllUsers(),
          message: `${updated?.email ?? userId} is now ${role}.`,
        });
      }

      /* Comp a subscription without a payment — for support cases and refunds. */
      case "grant-pro": {
        const userId = str("userId");
        if (!userId) {
          return NextResponse.json({ error: "Pass a userId." }, { status: 400 });
        }
        if (!getUserById(userId)) {
          return NextResponse.json({ error: "No such user." }, { status: 404 });
        }
        const months =
          typeof body.months === "number" && body.months > 0
            ? body.months
            : undefined;

        const subscription = activatePro(userId, {
          ...(months ? { durationMs: months * 30 * 24 * 60 * 60 * 1000 } : {}),
          paymentId: `manual:${admin.id}`,
          extend: true,
        });
        return NextResponse.json({
          success: true,
          subscription,
          users: getAllUsers(),
          message: "PRO granted.",
        });
      }

      case "revoke-subscription": {
        const userId = str("userId");
        if (!userId) {
          return NextResponse.json({ error: "Pass a userId." }, { status: 400 });
        }
        revokeSubscription(userId);
        return NextResponse.json({
          success: true,
          users: getAllUsers(),
          message: "Subscription revoked; the account is back on FREE.",
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action || "(none)"}` },
          { status: 400 },
        );
    }
  } catch (error) {
    console.error("[admin POST]", error);
    return NextResponse.json(
      { error: "Could not complete that admin action." },
      { status: 500 },
    );
  }
}
