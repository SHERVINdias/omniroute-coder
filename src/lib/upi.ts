/**
 * src/lib/upi.ts
 * ---------------------------------------------------------------------------
 * UPI payment orders: creation, the payment link, UTR capture, reconciliation.
 *
 * READ THIS FIRST — WHAT UPI CAN AND CANNOT DO HERE
 *
 * A plain UPI collect/intent payment from a customer's app straight into a bank
 * account produces NO callback to this server. There is no webhook, no redirect
 * with a signature, nothing. That is a property of UPI itself, not a gap in this
 * code: without a payment aggregator (Razorpay, Cashfree, PhonePe PG and so on)
 * or a bank statement API, the only party that learns a payment happened is the
 * bank, and it tells the payee by SMS and passbook entry.
 *
 * So "verify the payment automatically" is not implementable as written. The
 * previous code pretended otherwise: it accepted any non-empty string as a
 * "UPI transaction ID" and immediately granted PRO. Typing a single character
 * bought a subscription.
 *
 * What replaces it is the pattern real Indian businesses use for direct-to-VPA
 * collection, and it is genuinely production-grade for that model:
 *
 *   1. The server issues an order with a UNIQUE amount — the configured price
 *      plus a per-order paise suffix, so ₹69.00 becomes ₹69.07 for one customer
 *      and ₹69.23 for the next. Amount alone then identifies the payer among
 *      everyone paying at the same time.
 *   2. The customer pays via a upi:// intent link carrying that exact amount,
 *      so they cannot accidentally pay the wrong figure.
 *   3. The customer submits the UTR their app shows them. It is format-checked
 *      and globally unique, so the same reference cannot be reused across
 *      accounts.
 *   4. An admin sees the order next to its exact amount and UTR, compares it to
 *      the bank credit, and approves or rejects. Approval is idempotent and
 *      atomic with the subscription grant.
 *
 * The manual step in (4) is honest work, not a shortcut: it is the only place
 * where a real bank credit is actually observed. To move it off a human you
 * need a PSP with webhooks, and that is a different integration.
 *
 * For localhost testing, UPI_AUTO_APPROVE=true (or the toggle in the admin
 * panel) skips step 4 so the whole flow can be exercised end to end.
 */

import crypto from "crypto";
import db from "./db";
import {
  getUpiId,
  getPayeeName,
  getProPricePaise,
  isAutoApproveEnabled,
} from "./appSettings";
import { grantProSubscription } from "./subscription";

/* -------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------- */

export type OrderStatus =
  | "CREATED"
  | "SUBMITTED"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED";

export interface PaymentOrder {
  id: string;
  userId: string;
  email: string;
  amountPaise: number;
  upiId: string;
  payeeName: string;
  note: string;
  status: OrderStatus;
  utr: string | null;
  createdAt: number;
  expiresAt: number;
  submittedAt: number | null;
  reviewedAt: number | null;
  reviewedBy: string | null;
  reviewNote: string | null;
}

/** An order plus everything the payment screen needs to render. */
export interface PaymentInstructions {
  order: PaymentOrder;
  amountRupees: string;
  upiLink: string;
  reference: string;
  expiresInSeconds: number;
  autoApprove: boolean;
}

/* How long an unpaid order holds its unique amount before being recycled. */
const DEFAULT_TTL_MINUTES = 30;

function ttlMs(): number {
  const raw = Number.parseInt(process.env.UPI_ORDER_TTL_MINUTES ?? "", 10);
  const minutes =
    Number.isFinite(raw) && raw >= 5 && raw <= 24 * 60 ? raw : DEFAULT_TTL_MINUTES;
  return minutes * 60_000;
}

/* -------------------------------------------------------------------------
 * Formatting helpers
 * ---------------------------------------------------------------------- */

/** Paise to a rupee string with exactly two decimals: 6907 -> "69.07". */
export function formatPaise(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(paise));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * The `tr` value carried in the UPI link.
 *
 * Payment apps are inconsistent about what they accept here — some reject
 * anything that is not alphanumeric, some truncate past 35 characters. Deriving
 * it from the order id keeps it unique without needing another column, and
 * stripping to A-Z0-9 keeps every app happy.
 */
export function orderReference(orderId: string): string {
  return orderId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(-24);
}

/**
 * Build the `upi://pay` intent link.
 *
 * On a phone this opens the UPI app chooser with everything pre-filled. On a
 * desktop browser it will not resolve to anything, which is why the UI also
 * shows the UPI ID and the exact amount as copyable text — that path always
 * works, and on localhost it is the only path that will.
 */
export function buildUpiLink(order: {
  id: string;
  amountPaise: number;
  upiId: string;
  payeeName: string;
  note: string;
}): string {
  const params = new URLSearchParams({
    pa: order.upiId,
    pn: order.payeeName,
    am: formatPaise(order.amountPaise),
    cu: "INR",
    tn: order.note,
    tr: orderReference(order.id),
  });
  /* URLSearchParams encodes spaces as "+", which some UPI apps pass through
   * literally into the note. %20 is understood everywhere. */
  return `upi://pay?${params.toString().replace(/\+/g, "%20")}`;
}

/* -------------------------------------------------------------------------
 * Row mapping
 * ---------------------------------------------------------------------- */

interface OrderRow {
  id: string;
  userId: string;
  email: string;
  amountPaise: number;
  upiId: string;
  payeeName: string;
  note: string;
  status: string;
  utr: string | null;
  createdAt: number;
  expiresAt: number;
  submittedAt: number | null;
  reviewedAt: number | null;
  reviewedBy: string | null;
  reviewNote: string | null;
}

function toOrder(row: OrderRow): PaymentOrder {
  return { ...row, status: row.status as OrderStatus };
}

/* -------------------------------------------------------------------------
 * Expiry
 * ---------------------------------------------------------------------- */

/**
 * Retire orders that were never paid.
 *
 * Only CREATED orders expire. Once a UTR has been submitted the customer
 * believes they have paid, and expiring that out from under them would destroy
 * the only record linking their money to their account. A SUBMITTED order waits
 * for a human indefinitely.
 */
export function expireStaleOrders(): number {
  const result = db
    .prepare(
      `UPDATE payment_orders SET status = 'EXPIRED'
       WHERE status = 'CREATED' AND expiresAt <= ?`,
    )
    .run(Date.now());
  return result.changes;
}

/* -------------------------------------------------------------------------
 * Amount allocation
 * ---------------------------------------------------------------------- */

/**
 * Choose an amount no other open order is currently using.
 *
 * The suffix is what makes a bank credit attributable to one specific customer:
 * two people paying ₹69.00 in the same minute are indistinguishable in a
 * passbook, but ₹69.07 and ₹69.23 are not. Only orders that are still open
 * reserve a suffix, so the hundred available values recycle continuously.
 *
 * The suffix is added to the price rather than carved out of it, so a customer
 * is never charged less than the listed price — at most 99 paise more, which is
 * disclosed on the payment screen.
 */
function allocateAmount(pricePaise: number): number {
  const taken = new Set(
    (
      db
        .prepare(
          `SELECT amountPaise FROM payment_orders
           WHERE status IN ('CREATED','SUBMITTED')`,
        )
        .all() as { amountPaise: number }[]
    ).map((r) => r.amountPaise),
  );

  /* Start at a random offset so consecutive customers do not get consecutive
   * amounts, which would make one person's amount guessable from another's. */
  const start = crypto.randomInt(0, 100);
  for (let i = 0; i < 100; i++) {
    const candidate = pricePaise + ((start + i) % 100);
    if (!taken.has(candidate)) return candidate;
  }

  throw new Error(
    "All payment slots are currently in use. Please try again in a few minutes.",
  );
}

/* -------------------------------------------------------------------------
 * Order creation
 * ---------------------------------------------------------------------- */

export type CreateOrderResult =
  | { ok: true; instructions: PaymentInstructions; reused: boolean }
  | { ok: false; error: string; code: "NOT_CONFIGURED" | "NO_SLOTS" | "FAILED" };

/**
 * Return the customer's live order, or open a new one.
 *
 * Reusing an existing open order matters: without it, every reload of the
 * payment panel would mint a fresh order with a fresh amount, so a customer who
 * refreshed after paying would be looking at a different figure than the one
 * they sent, and the amount pool would drain in minutes.
 */
export function createOrGetOrder(user: {
  id: string;
  email: string;
}): CreateOrderResult {
  expireStaleOrders();

  const upiId = getUpiId();
  if (!upiId) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      error:
        "Payments are not set up yet — an admin needs to add a UPI ID in the admin panel first.",
    };
  }

  const existing = db
    .prepare(
      `SELECT * FROM payment_orders
       WHERE userId = ? AND status IN ('CREATED','SUBMITTED')
       ORDER BY createdAt DESC LIMIT 1`,
    )
    .get(user.id) as OrderRow | undefined;

  if (existing) {
    return {
      ok: true,
      reused: true,
      instructions: describeOrder(toOrder(existing)),
    };
  }

  const now = Date.now();
  const payeeName = getPayeeName();

  try {
    const amountPaise = allocateAmount(getProPricePaise());
    const id = `ord_${now}_${crypto.randomBytes(6).toString("hex")}`;
    /* The note lands in the payer's statement, so it should be recognisable
     * there without exposing anything about the account. */
    const note = `OmniRoute PRO`;

    db.prepare(
      `INSERT INTO payment_orders
         (id, userId, email, amountPaise, upiId, payeeName, note, status,
          createdAt, expiresAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?)`,
    ).run(
      id,
      user.id,
      user.email,
      amountPaise,
      upiId,
      payeeName,
      note,
      now,
      now + ttlMs(),
    );

    const order = getOrderById(id);
    if (!order) {
      return { ok: false, code: "FAILED", error: "Could not open a payment order." };
    }
    return { ok: true, reused: false, instructions: describeOrder(order) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/payment slots/i.test(message)) {
      return { ok: false, code: "NO_SLOTS", error: message };
    }
    console.error("[upi] createOrGetOrder", err);
    return { ok: false, code: "FAILED", error: "Could not open a payment order." };
  }
}

/** Attach the derived, non-stored fields the payment screen needs. */
export function describeOrder(order: PaymentOrder): PaymentInstructions {
  return {
    order,
    amountRupees: formatPaise(order.amountPaise),
    upiLink: buildUpiLink(order),
    reference: orderReference(order.id),
    expiresInSeconds: Math.max(
      0,
      Math.ceil((order.expiresAt - Date.now()) / 1000),
    ),
    autoApprove: isAutoApproveEnabled(),
  };
}

/* -------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------- */

export function getOrderById(id: string): PaymentOrder | null {
  const row = db
    .prepare("SELECT * FROM payment_orders WHERE id = ?")
    .get(id) as OrderRow | undefined;
  return row ? toOrder(row) : null;
}

export function getOrdersForUser(userId: string, limit = 20): PaymentOrder[] {
  const rows = db
    .prepare(
      `SELECT * FROM payment_orders WHERE userId = ?
       ORDER BY createdAt DESC LIMIT ?`,
    )
    .all(userId, limit) as OrderRow[];
  return rows.map(toOrder);
}

/**
 * Orders for the admin queue.
 *
 * SUBMITTED first, because those are the ones with someone waiting on the other
 * end, then everything else newest-first.
 */
export function listOrders(
  status?: OrderStatus,
  limit = 100,
): PaymentOrder[] {
  expireStaleOrders();

  const rows = status
    ? (db
        .prepare(
          `SELECT * FROM payment_orders WHERE status = ?
           ORDER BY createdAt DESC LIMIT ?`,
        )
        .all(status, limit) as OrderRow[])
    : (db
        .prepare(
          `SELECT * FROM payment_orders
           ORDER BY (status = 'SUBMITTED') DESC, createdAt DESC LIMIT ?`,
        )
        .all(limit) as OrderRow[]);

  return rows.map(toOrder);
}

export function countPendingOrders(): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM payment_orders WHERE status = 'SUBMITTED'",
    )
    .get() as { count: number } | undefined;
  return row?.count ?? 0;
}

/* -------------------------------------------------------------------------
 * UTR
 * ---------------------------------------------------------------------- */

/**
 * Shape check for a UPI reference number.
 *
 * Bank references seen in the wild are a 12-digit RRN for UPI, and 16 to 22
 * alphanumeric characters for NEFT/IMPS/RTGS. Anything shorter is not a
 * reference at all. This cannot tell a real UTR from a well-formed invention —
 * only the bank statement can — but it stops the old behaviour where a single
 * keystroke was accepted as proof of payment.
 */
export function normalizeUtr(raw: string): string | null {
  /* People paste these with spaces and hyphens straight out of a payment app. */
  const cleaned = raw.replace(/[\s-]/g, "").toUpperCase();

  if (!/^[A-Z0-9]{12,22}$/.test(cleaned)) return null;

  /* "000000000000" and friends: well-formed, obviously not a reference. */
  if (/^(.)\1+$/.test(cleaned)) return null;

  return cleaned;
}

export type SubmitUtrResult =
  | { ok: true; order: PaymentOrder; autoApproved: boolean }
  | {
      ok: false;
      error: string;
      code:
        | "NOT_FOUND"
        | "BAD_UTR"
        | "DUPLICATE_UTR"
        | "EXPIRED"
        | "WRONG_STATE";
    };

/**
 * Record the reference the customer says they paid with.
 *
 * The unique index on `utr` is what stops one reference being submitted against
 * several accounts. It is a partial index (WHERE utr IS NOT NULL) so the many
 * unsubmitted orders, which all have NULL here, do not collide with each other.
 */
export function submitUtr(
  orderId: string,
  userId: string,
  rawUtr: string,
): SubmitUtrResult {
  const utr = normalizeUtr(rawUtr);
  if (!utr) {
    return {
      ok: false,
      code: "BAD_UTR",
      error:
        "That does not look like a UPI reference number. It is usually 12 digits, shown in your payment app as the UTR or transaction ID.",
    };
  }

  const order = getOrderById(orderId);
  if (!order || order.userId !== userId) {
    /* Same answer for "no such order" and "someone else's order", so this
     * cannot be used to discover which order ids exist. */
    return { ok: false, code: "NOT_FOUND", error: "Payment order not found." };
  }

  if (order.status === "SUBMITTED" && order.utr === utr) {
    /* Double-tapped submit. Report the existing state rather than an error. */
    return { ok: true, order, autoApproved: false };
  }

  if (order.status !== "CREATED") {
    return {
      ok: false,
      code: "WRONG_STATE",
      error:
        order.status === "APPROVED"
          ? "This payment has already been approved."
          : order.status === "REJECTED"
            ? "This payment was rejected. Start a new payment."
            : "This payment order is no longer open. Start a new payment.",
    };
  }

  if (order.expiresAt <= Date.now()) {
    db.prepare("UPDATE payment_orders SET status = 'EXPIRED' WHERE id = ?").run(
      order.id,
    );
    return {
      ok: false,
      code: "EXPIRED",
      error:
        "This payment order expired before the reference was submitted. Start a new one — if you already paid, contact the admin with your UTR.",
    };
  }

  const now = Date.now();
  try {
    const result = db
      .prepare(
        `UPDATE payment_orders
         SET utr = ?, status = 'SUBMITTED', submittedAt = ?
         WHERE id = ? AND status = 'CREATED'`,
      )
      .run(utr, now, order.id);

    if (result.changes === 0) {
      /* Lost a race with a concurrent submit. Re-read and report the truth. */
      const fresh = getOrderById(order.id);
      if (fresh && fresh.status === "SUBMITTED" && fresh.utr === utr) {
        return { ok: true, order: fresh, autoApproved: false };
      }
      return {
        ok: false,
        code: "WRONG_STATE",
        error: "This payment order is no longer open.",
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|constraint/i.test(message)) {
      return {
        ok: false,
        code: "DUPLICATE_UTR",
        error:
          "That reference number has already been submitted. Each payment has its own UTR — check that you copied the right one.",
      };
    }
    console.error("[upi] submitUtr", err);
    return {
      ok: false,
      code: "WRONG_STATE",
      error: "Could not record that reference. Please try again.",
    };
  }

  if (isAutoApproveEnabled()) {
    const approved = reviewOrder(order.id, "APPROVE", "system:auto-approve", {
      note: "Auto-approved (UPI_AUTO_APPROVE is on).",
    });
    if (approved.ok) {
      return { ok: true, order: approved.order, autoApproved: true };
    }
  }

  const fresh = getOrderById(order.id);
  return {
    ok: true,
    order: fresh ?? { ...order, status: "SUBMITTED", utr, submittedAt: now },
    autoApproved: false,
  };
}

/* -------------------------------------------------------------------------
 * Review
 * ---------------------------------------------------------------------- */

export type ReviewResult =
  | { ok: true; order: PaymentOrder; alreadyReviewed: boolean }
  | { ok: false; error: string; code: "NOT_FOUND" | "WRONG_STATE" | "FAILED" };

/**
 * Approve or reject a submitted payment.
 *
 * The status change and the subscription grant happen in one transaction, so
 * there is no window where an order reads as approved but the customer is still
 * on FREE — the case that produces a furious support message and no way to tell
 * what went wrong.
 *
 * Idempotent by design. Admin panels get double-clicked, and two approvals must
 * not extend a subscription twice: the UPDATE is guarded on the current status,
 * and a zero-row result means someone else already handled it.
 */
export function reviewOrder(
  orderId: string,
  decision: "APPROVE" | "REJECT",
  reviewerId: string,
  options: { note?: string } = {},
): ReviewResult {
  const existing = getOrderById(orderId);
  if (!existing) {
    return { ok: false, code: "NOT_FOUND", error: "Payment order not found." };
  }

  if (existing.status === "APPROVED" || existing.status === "REJECTED") {
    const matches =
      (decision === "APPROVE" && existing.status === "APPROVED") ||
      (decision === "REJECT" && existing.status === "REJECTED");
    if (matches) {
      return { ok: true, order: existing, alreadyReviewed: true };
    }
    return {
      ok: false,
      code: "WRONG_STATE",
      error: `This order was already ${existing.status.toLowerCase()} and cannot be changed. Issue a refund or a new order instead.`,
    };
  }

  /* Rejecting an unpaid or expired order is fine — it is just closing it out.
   * Approving one is not: there is no reference to reconcile against. */
  if (decision === "APPROVE" && existing.status !== "SUBMITTED") {
    return {
      ok: false,
      code: "WRONG_STATE",
      error:
        "This order has no payment reference submitted against it, so there is nothing to approve.",
    };
  }

  const now = Date.now();
  const nextStatus = decision === "APPROVE" ? "APPROVED" : "REJECTED";

  try {
    const run = db.transaction((): PaymentOrder | null => {
      const updated = db
        .prepare(
          `UPDATE payment_orders
           SET status = ?, reviewedAt = ?, reviewedBy = ?, reviewNote = ?
           WHERE id = ? AND status = ?`,
        )
        .run(
          nextStatus,
          now,
          reviewerId,
          options.note ?? null,
          orderId,
          existing.status,
        );

      /* Guarded on the status we read a moment ago: zero rows means a
       * concurrent reviewer got there first. Abort rather than double-grant. */
      if (updated.changes === 0) return null;

      if (decision === "APPROVE") {
        grantProSubscription(existing.userId, {
          upiTransactionId: existing.utr ?? undefined,
          paymentId: existing.id,
          extend: true,
        });
      }

      return getOrderById(orderId);
    });

    const order = run();
    if (!order) {
      const fresh = getOrderById(orderId);
      if (fresh && fresh.status === nextStatus) {
        return { ok: true, order: fresh, alreadyReviewed: true };
      }
      return {
        ok: false,
        code: "WRONG_STATE",
        error: "This order was changed by someone else. Reload and try again.",
      };
    }

    return { ok: true, order, alreadyReviewed: false };
  } catch (err) {
    console.error("[upi] reviewOrder", err);
    return {
      ok: false,
      code: "FAILED",
      error: "Could not record that decision. Nothing was changed.",
    };
  }
}

/** Let a customer abandon an order they are not going to pay. */
export function cancelOrder(orderId: string, userId: string): boolean {
  const result = db
    .prepare(
      `UPDATE payment_orders SET status = 'EXPIRED'
       WHERE id = ? AND userId = ? AND status = 'CREATED'`,
    )
    .run(orderId, userId);
  return result.changes > 0;
}
