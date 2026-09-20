/**
 * src/lib/appSettings.ts
 * ---------------------------------------------------------------------------
 * A small typed key/value store on top of the `app_settings` table.
 *
 * WHY THIS REPLACES `admin_settings`
 *
 * The old `admin_settings` table had a single `upiId` column and no primary
 * key, and it was written with `UPDATE admin_settings SET upiId = ?` — no WHERE
 * clause. With one row that happens to work; with two rows, ever, it silently
 * rewrites both. There was also no way to add a second setting without an
 * ALTER TABLE. A keyed table avoids both problems.
 *
 * db.ts migrates the newest legacy `admin_settings.upiId` into this table on
 * first run (see migrateAdminSettings), so an existing install keeps its UPI ID
 * without anyone having to re-enter it.
 *
 * Values are stored as TEXT and parsed on read. That keeps the schema stable as
 * settings are added, and every accessor below returns a usable default rather
 * than null so no caller has to handle "not configured yet" twice.
 */

import db from "./db";

/* -------------------------------------------------------------------------
 * Keys
 *
 * Declared as a const object rather than loose strings so a typo is a compile
 * error rather than a setting that silently reads as unset.
 * ---------------------------------------------------------------------- */

export const SettingKey = {
  UPI_ID: "upi_id",
  UPI_PAYEE_NAME: "upi_payee_name",
  PRO_PRICE_PAISE: "pro_price_paise",
  UPI_AUTO_APPROVE: "upi_auto_approve",
} as const;

export type SettingKeyName = (typeof SettingKey)[keyof typeof SettingKey];

/* Defaults. ₹69 in paise; the app has always quoted 69 rupees. */
export const DEFAULT_PRO_PRICE_PAISE = 6900;
export const DEFAULT_PAYEE_NAME = "OmniRoute";

/* -------------------------------------------------------------------------
 * Raw access
 * ---------------------------------------------------------------------- */

export function getSetting(key: SettingKeyName): string | null {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: SettingKeyName, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
  ).run(key, value, Date.now());
}

export function deleteSetting(key: SettingKeyName): void {
  db.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
}

/** When each setting was last written. Shown in the admin panel. */
export function settingUpdatedAt(key: SettingKeyName): number | null {
  const row = db
    .prepare("SELECT updatedAt FROM app_settings WHERE key = ?")
    .get(key) as { updatedAt: number } | undefined;
  return row?.updatedAt ?? null;
}

/* -------------------------------------------------------------------------
 * UPI ID
 * ---------------------------------------------------------------------- */

/**
 * Shape check for a UPI virtual payment address.
 *
 * This can only reject something that is not an address at all — whether
 * `someone@okhdfcbank` actually exists is not knowable without a PSP, and
 * nothing here pretends to know it. The point is to catch the phone number or
 * bare handle that someone will inevitably paste into this field, before it
 * ends up in a payment link that silently fails for every customer.
 *
 * Deliberately permissive on the handle: new PSP handles appear regularly and
 * an allowlist would go stale and start rejecting valid addresses.
 */
export function isValidUpiId(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 5 || trimmed.length > 100) return false;
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,63})@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/.test(
    trimmed,
  );
}

/** The configured payee address, or null when the operator has not set one. */
export function getUpiId(): string | null {
  const value = getSetting(SettingKey.UPI_ID);
  return value && value.trim() ? value.trim() : null;
}

/** Store the payee address. Throws on an obviously malformed value. */
export function setUpiId(value: string): string {
  const trimmed = value.trim();
  if (!isValidUpiId(trimmed)) {
    throw new Error(
      "That does not look like a UPI ID. Expected something in the form name@bank, for example 9876543210@ybl.",
    );
  }
  setSetting(SettingKey.UPI_ID, trimmed);
  return trimmed;
}

/**
 * Name shown in the payer's UPI app.
 *
 * UPI apps display this next to the amount at the moment of confirmation, so it
 * is the last thing a payer reads before authorising. Worth setting to
 * something recognisable.
 */
export function getPayeeName(): string {
  const value = getSetting(SettingKey.UPI_PAYEE_NAME);
  return value && value.trim() ? value.trim() : DEFAULT_PAYEE_NAME;
}

export function setPayeeName(value: string): string {
  /* Strip the characters that would break the query string or invite an
   * injection into the note field of the payment app. */
  const cleaned = value.replace(/[^\w \-.&]/g, "").trim().slice(0, 40);
  if (!cleaned) throw new Error("Enter a payee name.");
  setSetting(SettingKey.UPI_PAYEE_NAME, cleaned);
  return cleaned;
}

/* -------------------------------------------------------------------------
 * Price
 * ---------------------------------------------------------------------- */

/**
 * PRO price in paise.
 *
 * Held in paise, not rupees, because the reconciliation scheme in upi.ts
 * depends on being able to address individual paise, and because floating-point
 * rupees would accumulate error the moment anything is summed.
 */
export function getProPricePaise(): number {
  const raw = getSetting(SettingKey.PRO_PRICE_PAISE);
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PRO_PRICE_PAISE;
  return parsed;
}

export function setProPricePaise(paise: number): number {
  if (!Number.isInteger(paise) || paise < 100 || paise > 100_000_00) {
    throw new Error("Price must be a whole number of paise between ₹1 and ₹100,000.");
  }
  setSetting(SettingKey.PRO_PRICE_PAISE, String(paise));
  return paise;
}

/* -------------------------------------------------------------------------
 * Auto-approve
 * ---------------------------------------------------------------------- */

/**
 * Whether a submitted payment is approved without an admin looking at it.
 *
 * This exists so the whole purchase flow can be exercised on localhost without
 * a real payment. It is off unless explicitly switched on, and the admin panel
 * shows it prominently when it is on, because leaving it enabled anywhere real
 * means anyone can type twelve digits and receive PRO.
 *
 * The database setting wins over the environment variable, so it can be toggled
 * from the panel without a restart.
 */
export function isAutoApproveEnabled(): boolean {
  const stored = getSetting(SettingKey.UPI_AUTO_APPROVE);
  if (stored === "true") return true;
  if (stored === "false") return false;

  const env = (process.env.UPI_AUTO_APPROVE ?? "").trim().toLowerCase();
  return env === "true" || env === "1" || env === "yes";
}

export function setAutoApprove(enabled: boolean): void {
  setSetting(SettingKey.UPI_AUTO_APPROVE, enabled ? "true" : "false");
}

/* -------------------------------------------------------------------------
 * Bundle for the admin panel
 * ---------------------------------------------------------------------- */

export interface PaymentSettings {
  upiId: string | null;
  payeeName: string;
  pricePaise: number;
  priceRupees: string;
  autoApprove: boolean;
  configured: boolean;
  upiIdUpdatedAt: number | null;
}

export function getPaymentSettings(): PaymentSettings {
  const upiId = getUpiId();
  const pricePaise = getProPricePaise();
  return {
    upiId,
    payeeName: getPayeeName(),
    pricePaise,
    priceRupees: (pricePaise / 100).toFixed(2),
    autoApprove: isAutoApproveEnabled(),
    configured: upiId !== null,
    upiIdUpdatedAt: settingUpdatedAt(SettingKey.UPI_ID),
  };
}
