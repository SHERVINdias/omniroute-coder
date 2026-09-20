/**
 * src/lib/subscription.ts
 * ---------------------------------------------------------------------------
 * Tiers, usage limits, referral codes and subscription grants.
 *
 * WHAT WAS WRONG BEFORE
 *
 *   - `getOrCreateUser` looked accounts up by the raw string it was given. So
 *     `Foo@Example.com` and `foo@example.com` became two separate accounts with
 *     separate tiers and separate daily quotas — buy PRO on one, keep using the
 *     free quota on the other.
 *   - Referral codes came from `Math.random()`. That is not a random number
 *     generator in the security sense; its output is predictable from previous
 *     output. An 8-character code from a 36-character alphabet sounds
 *     unguessable, and would be, if it were actually random.
 *   - Redeeming a code was a read followed by a write with nothing between them.
 *     Two people submitting the same code at the same moment both read
 *     `usedBy IS NULL`, and both got unlimited access.
 *   - Every grant deactivated the existing subscription and started a fresh
 *     term, so renewing with time remaining silently threw that time away.
 *   - `getMidnightIST` built an IST-shifted Date and then called `setHours`,
 *     which works in the server's local timezone rather than IST. On any
 *     machine not set to UTC the daily quota reset at the wrong hour.
 *   - `updateAdminUpiId` ran `UPDATE admin_settings SET upiId = ?` with no WHERE
 *     clause against a table with no primary key.
 *
 * Identity note: every function here that takes an "email" runs it through
 * classifyIdentifier first, so phone-number accounts work identically and
 * casing can never fork an account. The parameter keeps its old name because
 * existing callers — including the chat route — pass `user.email`.
 */

import crypto from "crypto";
import db from "./db";
import {
  getOrCreateUserByEmail,
  getUserById,
  isAdmin,
  type AuthUser,
} from "./emailAuth";
import {
  getUpiId,
  setUpiId,
  getPayeeName,
  getProPricePaise,
  settingUpdatedAt,
  SettingKey,
} from "./appSettings";

export type SubscriptionTier = "FREE" | "PRO" | "SPECIAL";

export interface User {
  id: string;
  email: string;
  tier: SubscriptionTier;
  createdAt: number;
  referralCode?: string | null;
}

export interface Subscription {
  id: string;
  userId: string;
  tier: SubscriptionTier;
  startDate: number;
  endDate?: number | null;
  isActive: boolean;
  paymentId?: string | null;
  upiTransactionId?: string | null;
}

export interface ReferralCode {
  id: string;
  code: string;
  createdAt: number;
  createdBy: string;
  usedBy?: string | null;
  usedAt?: number | null;
  isActive: boolean;
}

export interface AdminSettings {
  upiId: string;
  updatedAt: number;
}

/* -------------------------------------------------------------------------
 * Pricing and limits
 * ---------------------------------------------------------------------- */

/** Kept for display continuity; the authoritative figure is in app_settings. */
export const SUBSCRIPTION_PRICE = 69;
export const SUBSCRIPTION_DURATION_MONTHS = 6.9;

/** 6.9 "months" at 30 days each — 207 days. Computed once, not per call. */
export const SUBSCRIPTION_DURATION_MS =
  SUBSCRIPTION_DURATION_MONTHS * 30 * 24 * 60 * 60 * 1000;

export const FREE_TIER_DAILY_LIMIT = 3;

/** Current price in rupees, from settings, for display. */
export function currentPriceRupees(): string {
  return (getProPricePaise() / 100).toFixed(2);
}

/* -------------------------------------------------------------------------
 * Identity
 * ---------------------------------------------------------------------- */

/**
 * Find or create the account for an email address or phone number.
 *
 * Thin wrapper over emailAuth.getOrCreateUserByEmail so there is exactly one
 * place in the codebase that decides what an account key looks like. Callers
 * here only need the subscription-facing subset of the user.
 */
export function getOrCreateUser(email: string): User {
  const user = getOrCreateUserByEmail(email);
  return toUser(user);
}

function toUser(user: AuthUser): User {
  return {
    id: user.id,
    email: user.email,
    tier: (user.tier as SubscriptionTier) ?? "FREE",
    createdAt: user.createdAt,
    referralCode: user.referralCode,
  };
}

/* -------------------------------------------------------------------------
 * Subscription state
 * ---------------------------------------------------------------------- */

interface SubscriptionRow {
  id: string;
  userId: string;
  tier: string;
  startDate: number;
  endDate: number | null;
  isActive: number;
  paymentId: string | null;
  upiTransactionId: string | null;
}

function toSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    userId: row.userId,
    tier: row.tier as SubscriptionTier,
    startDate: row.startDate,
    endDate: row.endDate,
    isActive: row.isActive === 1,
    paymentId: row.paymentId,
    upiTransactionId: row.upiTransactionId,
  };
}

/**
 * The user's live subscription, expiring it in passing if its term has ended.
 *
 * Lazy expiry rather than a scheduled job: there is no cron in a Next.js dev
 * server, and a subscription that is read is a subscription whose expiry
 * matters. The downgrade is wrapped in a transaction so a user can never be
 * observed with an inactive subscription and a PRO tier.
 */
export function getUserSubscription(userId: string): Subscription | null {
  const row = db
    .prepare(
      `SELECT * FROM subscriptions
       WHERE userId = ? AND isActive = 1
       ORDER BY startDate DESC LIMIT 1`,
    )
    .get(userId) as SubscriptionRow | undefined;

  if (!row) return null;
  const subscription = toSubscription(row);

  /* SPECIAL has no end date by design — it is the referral/comp tier. */
  if (
    subscription.tier === "PRO" &&
    subscription.endDate &&
    Date.now() > subscription.endDate
  ) {
    db.transaction(() => {
      db.prepare("UPDATE subscriptions SET isActive = 0 WHERE id = ?").run(
        subscription.id,
      );
      /* Only touch the tier if it still reflects this subscription, so an
       * upgrade that landed concurrently is not stomped back to FREE. */
      db.prepare(
        "UPDATE users SET tier = 'FREE' WHERE id = ? AND tier = 'PRO'",
      ).run(userId);
    })();
    return null;
  }

  return subscription;
}

/**
 * The tier actually in force, after expiry is accounted for.
 *
 * Reading `users.tier` alone is not enough: it is a denormalised cache that is
 * only correct until a term lapses.
 */
export function effectiveTier(userId: string): SubscriptionTier {
  const subscription = getUserSubscription(userId);
  if (subscription) return subscription.tier;

  const row = db.prepare("SELECT tier FROM users WHERE id = ?").get(userId) as
    | { tier: string }
    | undefined;
  const cached = (row?.tier as SubscriptionTier) ?? "FREE";

  /* No active subscription row but a paid tier cached on the user: the cache is
   * stale, most likely from data written before subscriptions were tracked.
   * SPECIAL is honoured because it is granted without an end date and some
   * older grants only ever wrote the user row. */
  return cached === "SPECIAL" ? "SPECIAL" : "FREE";
}

/* -------------------------------------------------------------------------
 * Usage limits
 * ---------------------------------------------------------------------- */

/**
 * Start of today in IST, as a UTC epoch.
 *
 * The previous version shifted a Date by +5:30 and then called `setHours(0)`,
 * which resets to midnight in the SERVER's timezone, not IST. Two wrongs that
 * only cancel out when the server runs in UTC. Doing the arithmetic on the
 * epoch directly has no timezone dependency at all.
 */
function getMidnightIST(): number {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const nowIst = Date.now() + IST_OFFSET_MS;
  const istMidnight = Math.floor(nowIst / DAY_MS) * DAY_MS;
  return istMidnight - IST_OFFSET_MS;
}

export interface UsageVerdict {
  allowed: boolean;
  reason?: string;
  usageToday?: number;
  limit?: number;
  user?: User;
  tier?: SubscriptionTier;
  unlimited?: boolean;
}

/**
 * Whether this account may run another Deep Cowork session right now.
 *
 * Signature and return shape are unchanged from the version the chat route
 * calls — it reads `allowed`, `reason` and `usageToday`.
 */
export function canUseDeepCowork(email: string): UsageVerdict {
  let authUser: AuthUser;
  try {
    authUser = getOrCreateUserByEmail(email);
  } catch {
    /* An unparseable identifier reaching here means the caller did not come
     * through the auth layer. Refuse rather than creating a junk account. */
    return { allowed: false, reason: "Sign in to use Deep Cowork." };
  }

  const user = toUser(authUser);

  /* Admins are never metered. The operator hitting a quota on their own
   * install while trying to debug it is not a useful outcome. */
  if (isAdmin(authUser)) {
    return { allowed: true, user, tier: user.tier, unlimited: true };
  }

  const tier = effectiveTier(user.id);
  if (tier === "PRO" || tier === "SPECIAL") {
    return { allowed: true, user: { ...user, tier }, tier, unlimited: true };
  }

  const count = countUsageSince(user.id, getMidnightIST());

  if (count >= FREE_TIER_DAILY_LIMIT) {
    return {
      allowed: false,
      reason: `Daily limit reached (${FREE_TIER_DAILY_LIMIT} Deep Cowork runs). Upgrade to PRO for unlimited access, or try again after midnight IST.`,
      usageToday: count,
      limit: FREE_TIER_DAILY_LIMIT,
      user: { ...user, tier },
      tier,
      unlimited: false,
    };
  }

  return {
    allowed: true,
    usageToday: count,
    limit: FREE_TIER_DAILY_LIMIT,
    user: { ...user, tier },
    tier,
    unlimited: false,
  };
}

function countUsageSince(userId: string, since: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM usage_logs
       WHERE userId = ? AND action = 'deep_cowork' AND timestamp >= ?`,
    )
    .get(userId, since) as { count: number } | undefined;
  return row?.count ?? 0;
}

/** Record one Deep Cowork run. Never throws — metering must not break a chat. */
export function logDeepCoworkUsage(email: string): void {
  try {
    const user = getOrCreateUserByEmail(email);
    db.prepare(
      "INSERT INTO usage_logs (id, userId, timestamp, action) VALUES (?, ?, ?, ?)",
    ).run(crypto.randomUUID(), user.id, Date.now(), "deep_cowork");
  } catch (err) {
    console.error("[subscription] logDeepCoworkUsage", err);
  }
}

export function getTodayUsageCount(email: string): number {
  try {
    const user = getOrCreateUserByEmail(email);
    return countUsageSince(user.id, getMidnightIST());
  } catch {
    return 0;
  }
}

/* -------------------------------------------------------------------------
 * Grants
 * ---------------------------------------------------------------------- */

export interface GrantOptions {
  /** Duration in milliseconds. Defaults to the standard PRO term. */
  durationMs?: number;
  /** Add to the remaining term instead of restarting it. Defaults to true. */
  extend?: boolean;
  paymentId?: string;
  upiTransactionId?: string;
}

/**
 * Put a user on PRO.
 *
 * NOT wrapped in a transaction itself, so a caller can compose it with other
 * writes — upi.reviewOrder does exactly that, marking the order approved and
 * granting the subscription as one atomic unit. Call it inside a transaction if
 * you need that guarantee; for a standalone grant, use `activatePro`.
 *
 * Renewal extends rather than replaces. Paying again with two months left now
 * leaves you with two months plus a full term, instead of silently losing the
 * two months the way the previous implementation did.
 *
 * If the user already holds an active SPECIAL (unlimited, no expiry), the PRO
 * row is recorded as inactive and SPECIAL is left in place, because replacing it
 * would be a downgrade. The payment is not lost — the row is there, and can be
 * activated if SPECIAL is ever revoked.
 */
export function grantProSubscription(
  userId: string,
  options: GrantOptions = {},
): Subscription {
  const now = Date.now();
  const durationMs = options.durationMs ?? SUBSCRIPTION_DURATION_MS;
  const extend = options.extend ?? true;

  const current = db
    .prepare(
      `SELECT * FROM subscriptions WHERE userId = ? AND isActive = 1
       ORDER BY startDate DESC LIMIT 1`,
    )
    .get(userId) as SubscriptionRow | undefined;

  const holdsSpecial = current?.tier === "SPECIAL";

  /* Stack onto whatever term is left, if any. */
  let endDate = now + durationMs;
  if (
    extend &&
    current &&
    current.tier === "PRO" &&
    current.endDate &&
    current.endDate > now
  ) {
    endDate = current.endDate + durationMs;
  }

  const id = `sub_${now}_${crypto.randomBytes(5).toString("hex")}`;

  if (!holdsSpecial) {
    db.prepare("UPDATE subscriptions SET isActive = 0 WHERE userId = ?").run(
      userId,
    );
  }

  db.prepare(
    `INSERT INTO subscriptions
       (id, userId, tier, startDate, endDate, isActive, paymentId, upiTransactionId)
     VALUES (?, ?, 'PRO', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    now,
    endDate,
    holdsSpecial ? 0 : 1,
    options.paymentId ?? null,
    options.upiTransactionId ?? null,
  );

  if (!holdsSpecial) {
    db.prepare("UPDATE users SET tier = 'PRO' WHERE id = ?").run(userId);
  }

  return {
    id,
    userId,
    tier: "PRO",
    startDate: now,
    endDate,
    isActive: !holdsSpecial,
    paymentId: options.paymentId ?? null,
    upiTransactionId: options.upiTransactionId ?? null,
  };
}

/** Transactional wrapper for a standalone PRO grant. */
export function activatePro(
  userId: string,
  options: GrantOptions = {},
): Subscription {
  return db.transaction(() => grantProSubscription(userId, options))();
}

/**
 * Legacy entry point, kept so nothing that imports it breaks.
 *
 * The important difference from the original: this no longer IS the payment
 * verification. It records a grant that something else has already decided is
 * warranted. The old version was called directly from the subscription route
 * with a user-supplied string and granted PRO on the spot.
 */
export function createProSubscription(
  email: string,
  upiTransactionId: string,
): Subscription {
  const user = getOrCreateUserByEmail(email);
  return activatePro(user.id, { upiTransactionId });
}

/** Revoke whatever the user has and put them back on FREE. */
export function revokeSubscription(userId: string): void {
  db.transaction(() => {
    db.prepare("UPDATE subscriptions SET isActive = 0 WHERE userId = ?").run(
      userId,
    );
    db.prepare("UPDATE users SET tier = 'FREE' WHERE id = ?").run(userId);
  })();
}

/* -------------------------------------------------------------------------
 * Referral codes
 * ---------------------------------------------------------------------- */

/**
 * Alphabet without the characters that get misread when a code is copied off a
 * screen or read aloud: no O/0, no I/1/L, no U (which people hear as "you").
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 8;

/**
 * A referral code grants unlimited access for free, so it is a bearer credential
 * and has to be unguessable. `crypto.randomInt` draws from the OS entropy pool;
 * `Math.random()`, used before, is a fast PRNG whose future output can be
 * derived from past output.
 *
 * randomInt's upper bound is exclusive — worth stating, because an off-by-one
 * here silently biases or crashes depending on which direction it goes.
 */
function generateRandomCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Mint a referral code.
 *
 * Retries on collision rather than trusting that 30^8 makes one impossible —
 * the unique index on `code` is the real guarantee, and a retry loop turns a
 * 500 into a non-event.
 */
export function generateReferralCode(adminId: string): ReferralCode {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateRandomCode();
    const id = `ref_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const now = Date.now();
    try {
      db.prepare(
        `INSERT INTO referral_codes (id, code, createdAt, createdBy, isActive)
         VALUES (?, ?, ?, ?, 1)`,
      ).run(id, code, now, adminId);
      return { id, code, createdAt: now, createdBy: adminId, isActive: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/UNIQUE|constraint/i.test(message)) throw err;
      /* Collision — draw again. */
    }
  }
  throw new Error("Could not generate an unused referral code. Try again.");
}

/** Mint several codes at once, which is how they are usually handed out. */
export function generateReferralCodes(
  adminId: string,
  count: number,
): ReferralCode[] {
  const n = Math.max(1, Math.min(50, Math.trunc(count)));
  const created: ReferralCode[] = [];
  for (let i = 0; i < n; i++) created.push(generateReferralCode(adminId));
  return created;
}

interface ReferralRow {
  id: string;
  code: string;
  createdAt: number;
  createdBy: string;
  usedBy: string | null;
  usedAt: number | null;
  isActive: number;
}

function toReferral(row: ReferralRow): ReferralCode {
  return { ...row, isActive: row.isActive === 1 };
}

export function getAllReferralCodes(): ReferralCode[] {
  const rows = db
    .prepare("SELECT * FROM referral_codes ORDER BY createdAt DESC")
    .all() as ReferralRow[];
  return rows.map(toReferral);
}

/**
 * Referral codes annotated with who redeemed them.
 *
 * A separate query rather than `SELECT r.*, u.email` — in a join like that,
 * duplicate column names collapse to the last one that appears, so `id` would
 * be the user's id rather than the code's, which is exactly the kind of bug
 * that surfaces as a delete hitting the wrong row.
 */
export interface ReferralCodeView extends ReferralCode {
  usedByEmail: string | null;
}

export function getReferralCodeViews(): ReferralCodeView[] {
  const rows = db
    .prepare(
      `SELECT r.id AS id, r.code AS code, r.createdAt AS createdAt,
              r.createdBy AS createdBy, r.usedBy AS usedBy, r.usedAt AS usedAt,
              r.isActive AS isActive, u.email AS usedByEmail
       FROM referral_codes r
       LEFT JOIN users u ON u.id = r.usedBy
       ORDER BY r.createdAt DESC`,
    )
    .all() as (ReferralRow & { usedByEmail: string | null })[];

  return rows.map((row) => ({ ...toReferral(row), usedByEmail: row.usedByEmail }));
}

export function deactivateReferralCode(code: string): boolean {
  const result = db
    .prepare("UPDATE referral_codes SET isActive = 0 WHERE code = ?")
    .run(normalizeCode(code));
  return result.changes > 0;
}

export function deleteReferralCode(code: string): boolean {
  /* Only unredeemed codes can be deleted outright — removing a redeemed one
   * would erase the record of why that account has unlimited access. */
  const result = db
    .prepare("DELETE FROM referral_codes WHERE code = ? AND usedBy IS NULL")
    .run(normalizeCode(code));
  return result.changes > 0;
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Redeem a code for unlimited (SPECIAL) access.
 *
 * The claim is a single conditional UPDATE guarded on `usedBy IS NULL`, and the
 * whole redemption runs in one transaction. Previously this was read-then-write:
 * two simultaneous submissions of the same code both saw it unused and both
 * succeeded, so one code could grant unlimited access to any number of accounts.
 */
export function useReferralCode(
  email: string,
  code: string,
): { success: boolean; message: string; tier?: SubscriptionTier } {
  let user: AuthUser;
  try {
    user = getOrCreateUserByEmail(email);
  } catch {
    return { success: false, message: "Sign in before redeeming a code." };
  }

  const normalized = normalizeCode(code);
  if (!normalized) {
    return { success: false, message: "Enter a referral code." };
  }

  const existing = db
    .prepare("SELECT * FROM referral_codes WHERE code = ?")
    .get(normalized) as ReferralRow | undefined;

  if (!existing) {
    return { success: false, message: "That referral code does not exist." };
  }
  if (existing.isActive !== 1) {
    return { success: false, message: "That referral code is no longer active." };
  }
  if (existing.usedBy) {
    return {
      success: false,
      message:
        existing.usedBy === user.id
          ? "You have already redeemed this code — your account already has unlimited access."
          : "That referral code has already been used.",
    };
  }

  try {
    const claimed = db.transaction((): boolean => {
      /* The guard is what makes this safe under concurrency: whoever's UPDATE
       * lands first is the only one that sees changes === 1. */
      const claim = db
        .prepare(
          `UPDATE referral_codes SET usedBy = ?, usedAt = ?
           WHERE code = ? AND usedBy IS NULL AND isActive = 1`,
        )
        .run(user.id, Date.now(), normalized);

      if (claim.changes === 0) return false;

      const now = Date.now();
      db.prepare("UPDATE subscriptions SET isActive = 0 WHERE userId = ?").run(
        user.id,
      );
      db.prepare(
        `INSERT INTO subscriptions (id, userId, tier, startDate, endDate, isActive)
         VALUES (?, ?, 'SPECIAL', ?, NULL, 1)`,
      ).run(`sub_${now}_${crypto.randomBytes(5).toString("hex")}`, user.id, now);
      db.prepare(
        "UPDATE users SET tier = 'SPECIAL', referralCode = ? WHERE id = ?",
      ).run(normalized, user.id);

      return true;
    })();

    if (!claimed) {
      return {
        success: false,
        message: "That referral code was just used by someone else.",
      };
    }

    return {
      success: true,
      message: "Referral code applied. Your account now has unlimited access.",
      tier: "SPECIAL",
    };
  } catch (err) {
    console.error("[subscription] useReferralCode", err);
    return {
      success: false,
      message: "Could not redeem that code. Nothing was changed.",
    };
  }
}

/* -------------------------------------------------------------------------
 * Settings (compatibility shims over appSettings)
 * ---------------------------------------------------------------------- */

/**
 * Kept so existing imports keep resolving. Reads from `app_settings` now; see
 * appSettings.ts for why the single-row `admin_settings` table was replaced.
 */
export function getAdminSettings(): AdminSettings | null {
  const upiId = getUpiId();
  if (!upiId) return null;
  return {
    upiId,
    updatedAt: settingUpdatedAt(SettingKey.UPI_ID) ?? 0,
  };
}

/** Throws on a malformed UPI ID rather than storing something unusable. */
export function updateAdminUpiId(upiId: string): void {
  setUpiId(upiId);
}

/** Everything the payment screen needs about the payee. */
export function getPaymentTarget(): {
  upiId: string | null;
  payeeName: string;
  pricePaise: number;
} {
  return {
    upiId: getUpiId(),
    payeeName: getPayeeName(),
    pricePaise: getProPricePaise(),
  };
}

/* -------------------------------------------------------------------------
 * Admin reporting
 * ---------------------------------------------------------------------- */

export interface AdminUserView {
  id: string;
  email: string;
  phone: string | null;
  tier: SubscriptionTier;
  role: string;
  createdAt: number;
  lastLoginAt: number | null;
  referralCode: string | null;
  subscriptionTier: SubscriptionTier | null;
  subscriptionStart: number | null;
  subscriptionEnd: number | null;
  upiTransactionId: string | null;
  usageToday: number;
}

/**
 * Every account with its live subscription, for the admin panel.
 *
 * Columns are aliased explicitly. `SELECT u.*, s.*` was the previous approach,
 * and in SQLite duplicate output names resolve to the LAST occurrence — so
 * `row.id` was the subscription id, and `row.tier` was the subscription tier
 * masking the user's. Naming every column removes the ambiguity.
 */
export function getAllUsers(): AdminUserView[] {
  const since = getMidnightIST();
  const rows = db
    .prepare(
      `SELECT
         u.id AS id, u.email AS email, u.phone AS phone, u.tier AS tier,
         u.role AS role, u.createdAt AS createdAt, u.lastLoginAt AS lastLoginAt,
         u.referralCode AS referralCode,
         s.tier AS subscriptionTier, s.startDate AS subscriptionStart,
         s.endDate AS subscriptionEnd, s.upiTransactionId AS upiTransactionId,
         (SELECT COUNT(*) FROM usage_logs l
           WHERE l.userId = u.id AND l.action = 'deep_cowork'
             AND l.timestamp >= ?) AS usageToday
       FROM users u
       LEFT JOIN subscriptions s ON s.userId = u.id AND s.isActive = 1
       ORDER BY u.createdAt DESC`,
    )
    .all(since) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: String(row.id),
    email: String(row.email),
    phone: (row.phone as string | null) ?? null,
    tier: ((row.tier as string) ?? "FREE") as SubscriptionTier,
    role: (row.role as string) ?? "USER",
    createdAt: Number(row.createdAt ?? 0),
    lastLoginAt: row.lastLoginAt === null ? null : Number(row.lastLoginAt),
    referralCode: (row.referralCode as string | null) ?? null,
    subscriptionTier: (row.subscriptionTier as SubscriptionTier | null) ?? null,
    subscriptionStart:
      row.subscriptionStart === null ? null : Number(row.subscriptionStart),
    subscriptionEnd:
      row.subscriptionEnd == null ? null : Number(row.subscriptionEnd),
    upiTransactionId: (row.upiTransactionId as string | null) ?? null,
    usageToday: Number(row.usageToday ?? 0),
  }));
}

export interface AdminStats {
  totalUsers: number;
  freeUsers: number;
  proUsers: number;
  specialUsers: number;
  deepCoworkToday: number;
  referralCodesTotal: number;
  referralCodesUnused: number;
}

export function getAdminStats(): AdminStats {
  const since = getMidnightIST();
  const one = <T>(sql: string, ...params: unknown[]): T =>
    db.prepare(sql).get(...params) as T;

  const tiers = db
    .prepare("SELECT tier, COUNT(*) AS count FROM users GROUP BY tier")
    .all() as { tier: string; count: number }[];

  const byTier = new Map(tiers.map((t) => [t.tier, t.count]));

  return {
    totalUsers: one<{ count: number }>("SELECT COUNT(*) AS count FROM users")
      .count,
    freeUsers: byTier.get("FREE") ?? 0,
    proUsers: byTier.get("PRO") ?? 0,
    specialUsers: byTier.get("SPECIAL") ?? 0,
    deepCoworkToday: one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM usage_logs
       WHERE action = 'deep_cowork' AND timestamp >= ?`,
      since,
    ).count,
    referralCodesTotal: one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM referral_codes",
    ).count,
    referralCodesUnused: one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM referral_codes WHERE usedBy IS NULL AND isActive = 1",
    ).count,
  };
}

/* -------------------------------------------------------------------------
 * Per-user status bundle
 * ---------------------------------------------------------------------- */

export interface SubscriptionStatus {
  tier: SubscriptionTier;
  unlimited: boolean;
  usageToday: number;
  dailyLimit: number;
  remainingToday: number | null;
  subscription: Subscription | null;
  expiresAt: number | null;
  daysRemaining: number | null;
  isAdmin: boolean;
  priceRupees: string;
  paymentsConfigured: boolean;
}

/**
 * Everything the subscription panel shows, derived from a session user rather
 * than from an email in the request body.
 */
export function getSubscriptionStatus(userId: string): SubscriptionStatus | null {
  const user = getUserById(userId);
  if (!user) return null;

  const admin = isAdmin(user);
  const subscription = getUserSubscription(userId);
  const tier: SubscriptionTier = subscription?.tier ?? effectiveTier(userId);
  const unlimited = admin || tier === "PRO" || tier === "SPECIAL";
  const usageToday = countUsageSince(userId, getMidnightIST());
  const expiresAt = subscription?.endDate ?? null;

  return {
    tier,
    unlimited,
    usageToday,
    dailyLimit: FREE_TIER_DAILY_LIMIT,
    remainingToday: unlimited
      ? null
      : Math.max(0, FREE_TIER_DAILY_LIMIT - usageToday),
    subscription,
    expiresAt,
    daysRemaining:
      expiresAt === null
        ? null
        : Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000)),
    isAdmin: admin,
    priceRupees: currentPriceRupees(),
    paymentsConfigured: getUpiId() !== null,
  };
}
