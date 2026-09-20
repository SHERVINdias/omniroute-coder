/**
 * src/lib/otpDelivery.ts
 * ---------------------------------------------------------------------------
 * One place that knows how an OTP reaches a person.
 *
 * WHY THIS FILE EXISTS
 *
 * The previous implementation fell back to Ethereal when Gmail was not
 * configured. Ethereal is a *fake* mailbox: it accepts the message, returns
 * success, and prints a preview URL to the server console. Nothing is ever
 * delivered to the real address. Because the send "succeeded", the route
 * reported success too, and the only trace of the code was a line in a terminal
 * nobody was watching. With GMAIL_USER, GMAIL_APP_PASSWORD and every TWILIO_*
 * key present-but-empty in .env.local, that fallback was the only path any
 * login ever took — which is exactly why no OTP ever arrived.
 *
 * The rule here is: either a code is really delivered, or the caller is told
 * plainly that it was not and is handed the code directly. There is no third
 * state that looks like success and is not.
 *
 * CONFIGURATION (all optional; see the bottom of this comment for the
 * zero-config path)
 *
 *   Email, Resend:     RESEND_API_KEY
 *                      The recommended production path. It goes over HTTPS, so
 *                      it works on a VPS or container host that blocks outbound
 *                      SMTP ports 25/465/587 — which most of them do. Needs a
 *                      verified sending domain, or use the test sender
 *                      (onboarding@resend.dev) which can only mail the account
 *                      owner. Checked FIRST, before SMTP and Gmail.
 *
 *   Email, Gmail:      GMAIL_USER, GMAIL_APP_PASSWORD
 *                      The password must be a 16-character App Password from
 *                      https://myaccount.google.com/apppasswords, which needs
 *                      2-Step Verification switched on first. A normal account
 *                      password will be rejected by Google. This is the easiest
 *                      option for a small number of users: it needs no domain,
 *                      but Google caps it at roughly 500 messages a day.
 *
 *   Email, any SMTP:   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *                      Optional SMTP_SECURE=true for implicit TLS (port 465).
 *                      Takes precedence over the Gmail shorthand.
 *
 *   Email from/name:   MAIL_FROM (defaults to the authenticated user)
 *
 *   SMS, Twilio:       TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 *                      TWILIO_PHONE_NUMBER
 *                      OTP_SMS_COUNTRY_CODE defaults to +91; it is only applied
 *                      to bare national numbers, never to an E.164 number that
 *                      already carries a +.
 *
 *                      IMPORTANT for India: Twilio (and every other A2P sender)
 *                      requires DLT registration before it will deliver to an
 *                      Indian number. That is a regulatory filing with the
 *                      operator, not a code change — without it, messages are
 *                      rejected upstream no matter how correct the credentials
 *                      are. Email sign-in is unaffected.
 *
 *   Reveal switch:     AUTH_DEV_SHOW_OTP=true|false
 *                      Forces the code to be returned in the API response, or
 *                      forbids it. When unset the code is revealed only if no
 *                      provider is configured (or a configured provider failed)
 *                      AND NODE_ENV is not "production".
 *
 *                      This switch is all-or-nothing. `true` on a public server
 *                      hands a sign-in code to anyone who types an address into
 *                      the login box, which is the same thing as having no
 *                      authentication, so productionGuard refuses to boot with
 *                      it on. For the narrower "my three testers cannot receive
 *                      mail yet" problem, use the next entry instead.
 *
 *   Beta allowlist:    AUTH_BETA_TESTERS=a@example.com,b@example.com,9876543210
 *                      Named accounts that may be shown their own code in the
 *                      login dialog, but ONLY when a configured provider was
 *                      tried and genuinely failed. Empty (the default) means the
 *                      feature does not exist. See "THE BETA ALLOWLIST" below
 *                      for what it deliberately refuses to do.
 *
 * ZERO CONFIG: set nothing at all. On localhost the code comes back in the API
 * response and is shown in the login dialog, so sign-in works immediately. The
 * moment you fill in Gmail or Twilio credentials, real delivery takes over and
 * the code stops being revealed.
 *
 * THE BETA ALLOWLIST — WHAT IT IS AND WHAT IT COSTS
 *
 * The problem it solves is specific and temporary. A first deployment usually
 * runs on Resend's shared test sender, `onboarding@resend.dev`, which is only
 * permitted to deliver to the address that owns the Resend account. Every other
 * tester's request comes back HTTP 422 and they simply cannot sign in — not
 * because the password was wrong, but because the mail was never allowed to
 * leave. Waiting on a domain verification to let three people try the app is a
 * poor trade.
 *
 * Four conditions must all hold before a code is shown:
 *
 *   1. The identifier is named in AUTH_BETA_TESTERS. Not a pattern, not a
 *      domain — the exact account, canonicalised the same way the accounts
 *      table canonicalises it.
 *   2. A provider was actually configured and actually attempted the send.
 *      "Nothing is configured" is a different situation, governed by the rules
 *      above; a server with no mail set up does not get to call itself a beta.
 *   3. That attempt failed.
 *   4. The failure was not a rate-limit. This is the interesting one, and the
 *      reason for it is in the next paragraph.
 *
 * THE RESIDUAL RISK, STATED PLAINLY: this trades a little security for
 * reachability, and it is worth knowing exactly how much. Anyone who can make
 * the mail provider fail can make a listed account's code appear in the login
 * dialog — and at that point they have the code, so they are that person. The
 * single realistic way to force such a failure from outside is to burn the
 * account's send quota until the provider starts answering 429, which is why
 * condition 4 exists: a rate-limit failure never reveals, so the one lever an
 * attacker actually has is disconnected. What remains is an attacker who can
 * break Resend itself, or who already controls the server's outbound network.
 * Both of those defeat email sign-in outright, allowlist or no allowlist.
 *
 * Even so: this is a beta affordance, not a permanent one. Verify a sending
 * domain and empty the list. The boot check prints it on every start, masked,
 * so it cannot be left on and forgotten.
 */

import nodemailer from "nodemailer";
import { classifyIdentifier } from "./emailAuth";

export type OtpChannel = "email" | "sms";
export type OtpProvider = "resend" | "smtp" | "gmail" | "twilio" | "none";

/**
 * Why a send failed, classified rather than free-text.
 *
 * The message alone is for a human to read; this is for code to branch on. The
 * beta reveal below refuses on "ratelimit" specifically, and it cannot do that
 * by pattern-matching English.
 */
export type OtpFailureKind =
  | "credentials"
  | "recipient"
  | "ratelimit"
  | "network"
  | "server"
  | "unknown";

/** Why the code was handed back, when it was. */
export type RevealReason = "policy" | "beta";

export interface DeliveryResult {
  channel: OtpChannel;
  provider: OtpProvider;
  /** True only when a provider accepted the message for a real destination. */
  delivered: boolean;
  /** True when the route is permitted to return the code to the client. */
  revealCode: boolean;
  /**
   * Which rule permitted the reveal. "policy" is the unconfigured/dev path;
   * "beta" is the narrow allowlisted fallback. Absent when nothing is revealed.
   */
  revealReason?: RevealReason;
  /** Message intended for display to the person signing in. */
  message: string;
  /** Short failure reason, safe to show. Never contains credentials. */
  error?: string;
  /** Machine-readable form of `error`, for the admin panel and the logic above. */
  errorKind?: OtpFailureKind;
}

/** Internal shape returned by each sender. */
interface SendOutcome {
  provider: OtpProvider;
  error?: string;
  errorKind?: OtpFailureKind;
}

/* -------------------------------------------------------------------------
 * Configuration
 *
 * Read through a helper that treats "" and whitespace as absent. The bug this
 * guards against is real and is what broke logins here: `.env.local` declared
 * GMAIL_USER= with no value, so `process.env.GMAIL_USER` was the empty string
 * rather than undefined, and `||` fallbacks masked how thoroughly unset it was.
 * ---------------------------------------------------------------------- */

function env(name: string): string {
  const raw = process.env[name];
  return typeof raw === "string" ? raw.trim() : "";
}

function envBool(name: string): boolean | undefined {
  const raw = env(name).toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return undefined;
}

/**
 * Which email provider, if any, is fully configured.
 *
 * Order matters and is deliberate: Resend first, because an HTTPS API is the
 * only thing guaranteed to work from a hosted server. The SMTP paths stay for
 * local use and for anyone who already has Gmail working, and Gmail last
 * because of its daily cap.
 */
function emailProvider(): OtpProvider {
  if (env("RESEND_API_KEY")) return "resend";
  if (env("SMTP_HOST") && env("SMTP_USER") && env("SMTP_PASS")) return "smtp";
  if (env("GMAIL_USER") && env("GMAIL_APP_PASSWORD")) return "gmail";
  return "none";
}

function smsConfigured(): boolean {
  return !!(
    env("TWILIO_ACCOUNT_SID") &&
    env("TWILIO_AUTH_TOKEN") &&
    env("TWILIO_PHONE_NUMBER")
  );
}

/**
 * Decide whether the code may be handed back to the client.
 *
 * `providerWorked` is false both when nothing is configured and when a
 * configured provider threw. The second case matters: a typo in an App Password
 * would otherwise lock you out of your own app on localhost with no way in.
 */
function shouldReveal(providerWorked: boolean): boolean {
  const explicit = envBool("AUTH_DEV_SHOW_OTP");
  if (explicit !== undefined) return explicit;
  if (providerWorked) return false;
  return process.env.NODE_ENV !== "production";
}

/* -------------------------------------------------------------------------
 * Beta allowlist
 *
 * Parsed once at module load, for the same reason the admin allowlist is: a
 * per-request `process.env` read and re-parse is work done thousands of times
 * to answer a question whose answer cannot change without a restart, and doing
 * it once means a malformed entry is reported at boot instead of silently
 * failing to match at 2am.
 *
 * Entries go through the same classifyIdentifier the accounts table uses, so
 * "Tester@Example.COM", "+91 98765 43210" and "9876543210" all land on the key
 * that the login request will actually be carrying.
 * ---------------------------------------------------------------------- */

const BETA_TESTERS: ReadonlySet<string> = (() => {
  const raw = env("AUTH_BETA_TESTERS");
  if (!raw) return new Set<string>();

  const canonical = new Set<string>();
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const parsed = classifyIdentifier(entry);
    if (parsed) canonical.add(parsed.value);
    else {
      /* Loud, because a typo here does not break anything visibly — it just
       * quietly fails to help the person it was added for, who then reports
       * "I still cannot log in" and is told the feature is enabled. */
      console.warn(
        `[auth] Ignoring unparseable AUTH_BETA_TESTERS entry: ${JSON.stringify(entry)}`,
      );
    }
  }

  if (canonical.size > 0) {
    console.warn(
      `[auth] Beta OTP fallback is ON for ${canonical.size} account(s). ` +
        "Those accounts will be shown their sign-in code in the browser if a " +
        "configured mail provider fails. Clear AUTH_BETA_TESTERS once the " +
        "sending domain is verified.",
    );
  }
  return canonical;
})();

function isBetaTester(identifier: string): boolean {
  if (BETA_TESTERS.size === 0) return false;
  const parsed = classifyIdentifier(identifier);
  return parsed ? BETA_TESTERS.has(parsed.value) : false;
}

/**
 * The allowlist, masked, for the boot check and the admin panel.
 *
 * Masked rather than raw because this ends up in a server log and in an HTTP
 * response, and the list is a set of real people's contact details. Masked is
 * enough to answer the only question being asked of it — "is that still on
 * there?" — without printing an inbox anyone could then target.
 */
export function listBetaTesters(): string[] {
  return [...BETA_TESTERS].map((value) =>
    value.includes("@") ? maskEmail(value) : maskPhone(value),
  );
}

/** Whether the narrow beta fallback is armed at all. */
export function betaRevealEnabled(): boolean {
  return BETA_TESTERS.size > 0;
}

/* -------------------------------------------------------------------------
 * Transport
 *
 * Held on globalThis so a hot reload does not open a new SMTP connection pool
 * on every file save. Keyed by the resolved config so changing .env.local and
 * restarting picks up the new settings rather than reusing a stale transport.
 *
 * Each branch below calls createTransport itself instead of building a shared
 * options object typed with Parameters<typeof createTransport>[0]. That utility
 * type collapses an overload set to its last member, which here is a bare
 * generic `transport: T` — it would have compiled while checking nothing.
 * ReturnType is safe in the opposite direction: every createTransport overload
 * returns the same Transporter<SMTPTransport.SentMessageInfo, SMTPTransport.Options>.
 * ---------------------------------------------------------------------- */

type Transport = ReturnType<typeof nodemailer.createTransport>;

declare global {
  /* eslint-disable-next-line no-var */
  var __omnirouteMailTransport: { key: string; transport: Transport } | undefined;
}

function getTransport(provider: OtpProvider): Transport | null {
  let key: string;
  let transportFactory: () => Transport;

  if (provider === "smtp") {
    const host = env("SMTP_HOST");
    const port = Number(env("SMTP_PORT")) || 587;
    const secure = envBool("SMTP_SECURE") ?? port === 465;
    const user = env("SMTP_USER");
    const pass = env("SMTP_PASS");
    key = `smtp:${host}:${port}:${secure}:${user}`;
    transportFactory = () =>
      nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
      });
  } else if (provider === "gmail") {
    const user = env("GMAIL_USER");
    const pass = env("GMAIL_APP_PASSWORD");
    key = `gmail:${user}`;
    transportFactory = () =>
      nodemailer.createTransport({
        service: "gmail",
        auth: { user, pass },
      });
  } else {
    return null;
  }

  const cached = globalThis.__omnirouteMailTransport;
  if (cached && cached.key === key) return cached.transport;

  /* Close the previous pool before replacing it, or the old sockets leak. */
  if (cached) {
    try {
      cached.transport.close();
    } catch {
      /* Already closed or never opened. Nothing to do. */
    }
  }

  const transport = transportFactory();
  globalThis.__omnirouteMailTransport = { key, transport };
  return transport;
}

/* -------------------------------------------------------------------------
 * Message bodies
 * ---------------------------------------------------------------------- */

function emailHtml(code: string, expiryMinutes: number): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0b0b0f;">
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#e4e4e7;">
      <h2 style="margin:0 0 4px;font-size:18px;font-weight:600;color:#fb7185;">OmniRoute</h2>
      <p style="margin:0 0 24px;font-size:13px;color:#a1a1aa;">Your one-time sign-in code</p>
      <div style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:24px;text-align:center;">
        <div style="font-size:34px;font-weight:700;letter-spacing:10px;color:#fafafa;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${code}</div>
      </div>
      <p style="margin:20px 0 0;font-size:13px;color:#a1a1aa;">This code expires in ${expiryMinutes} minutes and can be used once.</p>
      <p style="margin:8px 0 0;font-size:12px;color:#71717a;">If you did not try to sign in, you can ignore this message — no one can use the code without access to this inbox.</p>
    </div>
  </body>
</html>`;
}

function emailText(code: string, expiryMinutes: number): string {
  return `Your OmniRoute sign-in code is ${code}.\n\nIt expires in ${expiryMinutes} minutes and can be used once.\nIf you did not try to sign in, you can ignore this message.`;
}

function smsText(code: string, expiryMinutes: number): string {
  return `${code} is your OmniRoute sign-in code. It expires in ${expiryMinutes} minutes. Do not share it with anyone.`;
}

/* -------------------------------------------------------------------------
 * Phone formatting
 * ---------------------------------------------------------------------- */

/**
 * Turn a stored national number into E.164.
 *
 * The old code did `+91${number}` unconditionally, which corrupts any number
 * that already had a country code and hardcodes India for everyone. The country
 * code is now configuration, and an E.164 number is passed through untouched.
 */
export function toE164(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith("+")) return "+" + trimmed.slice(1).replace(/\D/g, "");

  const digits = trimmed.replace(/\D/g, "");
  const cc = env("OTP_SMS_COUNTRY_CODE") || "+91";
  const ccDigits = cc.replace(/\D/g, "");

  /* Already carries the country code without the plus. */
  if (ccDigits && digits.length > 10 && digits.startsWith(ccDigits)) {
    return "+" + digits;
  }
  return `+${ccDigits}${digits}`;
}

/* -------------------------------------------------------------------------
 * Senders
 * ---------------------------------------------------------------------- */

/**
 * Send through Resend's HTTPS API.
 *
 * No dependency is added for this: it is one POST with a bearer token and a
 * JSON body, and pulling in an SDK to do that would be more code to keep
 * current than the request itself.
 *
 * `onboarding@resend.dev` is Resend's shared test sender, usable before a
 * domain is verified but only able to deliver to the address that owns the
 * account. That is genuinely useful for a single-operator deploy, so it is the
 * default rather than an error.
 */
async function sendViaResend(
  to: string,
  code: string,
  expiryMinutes: number,
): Promise<SendOutcome> {
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) return { provider: "none" };

  const from = env("MAIL_FROM") || "onboarding@resend.dev";

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `OmniRoute <${from}>`,
        to: [to],
        subject: `${code} is your OmniRoute sign-in code`,
        text: emailText(code, expiryMinutes),
        html: emailHtml(code, expiryMinutes),
      }),
      /* Same reasoning as Twilio below: a hanging provider must not hang the
       * login request. */
      signal: AbortSignal.timeout(15_000),
    });

    if (response.ok) return { provider: "resend" };

    /* Read the status and a *classified* reason. The raw body is not echoed:
     * it is generated by a third party and has no business appearing in a
     * user-facing error. */
    let detail = `Resend refused the message (HTTP ${response.status}).`;
    let kind: OtpFailureKind = "unknown";
    if (response.status === 401 || response.status === 403) {
      detail =
        "Resend rejected the API key. Check RESEND_API_KEY is a sending-enabled key and has no stray whitespace.";
      kind = "credentials";
    } else if (response.status === 422) {
      detail =
        "Resend rejected the sender or recipient. Verify MAIL_FROM's domain, or send to the account owner's address while using the test sender.";
      /* The shared test sender refusing to mail anyone but the account owner
       * arrives here. It is the exact case the beta allowlist exists for. */
      kind = "recipient";
    } else if (response.status === 429) {
      detail = "Resend is rate-limiting this account. Try again in a minute.";
      kind = "ratelimit";
    } else if (response.status >= 500) {
      detail = "Resend had a server error. Try again shortly.";
      kind = "server";
    }
    return { provider: "resend", error: detail, errorKind: kind };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (/abort|timeout/i.test(raw)) {
      return {
        provider: "resend",
        error: "Resend did not respond in time.",
        errorKind: "network",
      };
    }
    return {
      provider: "resend",
      error: "Could not reach the Resend API. Check outbound network access.",
      errorKind: "network",
    };
  }
}

async function sendEmail(
  to: string,
  code: string,
  expiryMinutes: number,
): Promise<SendOutcome> {
  const provider = emailProvider();
  if (provider === "none") return { provider: "none" };

  /* Resend is an API call, not an SMTP transport, so it branches before the
   * transport pool is touched. */
  if (provider === "resend") {
    return sendViaResend(to, code, expiryMinutes);
  }

  const transport = getTransport(provider);
  if (!transport) return { provider: "none" };

  const from =
    env("MAIL_FROM") ||
    (provider === "gmail" ? env("GMAIL_USER") : env("SMTP_USER"));

  try {
    await transport.sendMail({
      from: from ? `"OmniRoute" <${from}>` : undefined,
      to,
      subject: `${code} is your OmniRoute sign-in code`,
      text: emailText(code, expiryMinutes),
      html: emailHtml(code, expiryMinutes),
    });
    return { provider };
  } catch (err) {
    const { error, kind } = describeMailError(err);
    return { provider, error, errorKind: kind };
  }
}

/**
 * Translate the usual SMTP failures into something actionable.
 *
 * Deliberately does not include the raw error, which for Gmail can echo back
 * part of the credential that was rejected.
 */
function describeMailError(err: unknown): {
  error: string;
  kind: OtpFailureKind;
} {
  const raw = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";

  if (/invalid login|535|BadCredentials/i.test(raw) || code === "EAUTH") {
    return {
      error:
        "The mail server rejected the credentials. For Gmail this usually means GMAIL_APP_PASSWORD is a normal account password rather than a 16-character App Password.",
      kind: "credentials",
    };
  }
  if (code === "ECONNECTION" || code === "ETIMEDOUT" || /ENOTFOUND/.test(raw)) {
    return {
      error:
        "Could not reach the mail server. Check the host, the port, and whether outbound SMTP is blocked.",
      kind: "network",
    };
  }
  if (/self.signed|certificate/i.test(raw)) {
    return {
      error: "The mail server's TLS certificate was not accepted.",
      kind: "network",
    };
  }
  /* Gmail's daily cap and most providers' throttles surface as a 4xx SMTP
   * reply rather than a distinct error code, so match the wording. Getting
   * this branch right is what keeps the beta reveal from firing when someone
   * is simply hammering the login form. */
  if (/4\.7\.0|rate limit|too many|quota|throttl/i.test(raw) || code === "EENVELOPE") {
    return {
      error:
        "The mail server is throttling this account, or its daily send limit has been reached. Try again later.",
      kind: "ratelimit",
    };
  }
  return { error: "The mail server refused the message.", kind: "unknown" };
}

async function sendSms(
  to: string,
  code: string,
  expiryMinutes: number,
): Promise<SendOutcome> {
  if (!smsConfigured()) return { provider: "none" };

  const sid = env("TWILIO_ACCOUNT_SID");
  const token = env("TWILIO_AUTH_TOKEN");
  const from = env("TWILIO_PHONE_NUMBER");

  const body = new URLSearchParams();
  body.append("To", toE164(to));
  body.append("From", from);
  body.append("Body", smsText(code, expiryMinutes));

  try {
    /* Twilio can hang; without a deadline the login request hangs with it. */
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      let kind: OtpFailureKind =
        response.status === 429
          ? "ratelimit"
          : response.status === 401 || response.status === 403
            ? "credentials"
            : response.status >= 500
              ? "server"
              : "unknown";
      try {
        const payload = (await response.json()) as { message?: string; code?: number };
        if (payload?.message) detail = payload.message;
        /* 21608: unverified number on a Twilio trial account. By far the most
         * common reason a trial SMS silently never arrives. */
        if (payload?.code === 21608) {
          detail =
            "This Twilio account is a trial, and the destination number is not on its verified caller list. Verify the number in the Twilio console, or upgrade the account.";
          kind = "recipient";
        }
      } catch {
        /* Non-JSON error body; the status alone will have to do. */
      }
      return { provider: "twilio", error: detail, errorKind: kind };
    }

    return { provider: "twilio" };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (/abort|timeout/i.test(raw)) {
      return {
        provider: "twilio",
        error: "Twilio did not respond in time.",
        errorKind: "network",
      };
    }
    return {
      provider: "twilio",
      error: "Could not reach Twilio.",
      errorKind: "network",
    };
  }
}

/* -------------------------------------------------------------------------
 * Public entry point
 * ---------------------------------------------------------------------- */

/**
 * Attempt to deliver `code` to `identifier`, and report honestly what happened.
 *
 * Never throws. A delivery failure is a returned result, not an exception,
 * because the caller has already written the code to the database and needs to
 * respond either way.
 */
export async function deliverOtp(
  identifier: string,
  code: string,
  channel: OtpChannel,
  expiryMinutes: number,
): Promise<DeliveryResult> {
  const outcome =
    channel === "sms"
      ? await sendSms(identifier, code, expiryMinutes)
      : await sendEmail(identifier, code, expiryMinutes);

  const delivered = outcome.provider !== "none" && !outcome.error;

  /* The two reveal rules, evaluated separately because they answer different
   * questions and must not be allowed to blur into each other.
   *
   * `revealByPolicy` is the blanket rule: no provider configured, or a failure
   * on a machine that is not production. It applies to every identifier.
   *
   * `revealForBeta` is the narrow one. All four conditions from the header
   * comment are here: a configured provider (`!== "none"`), which was tried
   * and failed (`outcome.error`), for a failure that is not a rate-limit (the
   * one an outsider could induce), for an account named in the allowlist.
   *
   * Note that an explicit AUTH_DEV_SHOW_OTP=false does not switch this off,
   * and that is deliberate rather than an oversight. The two settings say
   * different things: "do not reveal to everyone" and "reveal to these three
   * named people when the mail genuinely bounces" are compatible positions,
   * and the recommended production configuration holds both at once. The kill
   * switch for this path is emptying AUTH_BETA_TESTERS, which is the setting
   * whose whole purpose is to control it. */
  const revealByPolicy = shouldReveal(delivered);
  const revealForBeta =
    !delivered &&
    outcome.provider !== "none" &&
    !!outcome.error &&
    outcome.errorKind !== "ratelimit" &&
    isBetaTester(identifier);

  const revealCode = revealByPolicy || revealForBeta;
  const revealReason: RevealReason | undefined = revealByPolicy
    ? "policy"
    : revealForBeta
      ? "beta"
      : undefined;

  /* The console line is a convenience for whoever is watching the dev server,
   * not the delivery mechanism. It is suppressed when a provider really sent
   * the message, so production logs never accumulate live codes — and it is
   * suppressed for the beta path too, which by definition runs on a server
   * whose logs are written to disk, shipped off the box, and read by people
   * who are not the account holder. The code goes to the browser that asked
   * for it and nowhere else. */
  if (!delivered && revealByPolicy) {
    const where = channel === "sms" ? "phone" : "email";
    console.log(
      `\n  OmniRoute sign-in code for ${where} ${identifier}: ${code}  (expires in ${expiryMinutes} min)\n`,
    );
  }

  if (revealForBeta) {
    /* No code, but the event itself is worth a line: it is an authentication
     * factor being bypassed, and if it starts happening in volume that is the
     * signal that someone is probing rather than that Resend is having a bad
     * afternoon. */
    console.warn(
      `[auth] Beta OTP reveal used for ${
        channel === "sms" ? maskPhone(identifier) : maskEmail(identifier)
      } after a ${outcome.provider} failure (${outcome.errorKind ?? "unknown"}).`,
    );
  }

  let message: string;
  if (delivered) {
    message =
      channel === "sms"
        ? `Code sent by SMS to ${maskPhone(identifier)}.`
        : `Code sent to ${maskEmail(identifier)}.`;
  } else if (channel === "sms" && outcome.provider === "none") {
    /* The honest answer for a hosted deploy. Indian A2P traffic additionally
     * needs DLT registration before any provider will deliver it, so pointing
     * at email is the only guidance that actually unblocks someone. */
    message =
      "SMS sign-in is not available on this server. Please sign in with your email address instead.";
  } else if (revealReason === "beta") {
    message =
      "We could not deliver your code, so it is shown below. This account is on the beta-tester list while the sending domain is being verified.";
  } else if (revealCode) {
    message = outcome.error
      ? "Delivery failed, so the code is shown below instead."
      : "No delivery provider is configured, so the code is shown below.";
  } else {
    message = "Could not send the code. Please try again shortly.";
  }

  return {
    channel,
    provider: outcome.provider,
    delivered,
    revealCode,
    ...(revealReason ? { revealReason } : {}),
    message,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.errorKind ? { errorKind: outcome.errorKind } : {}),
  };
}

/**
 * What is configured right now. Used by the admin panel so the operator can see
 * at a glance why codes are or are not going out. Reports only booleans and
 * provider names — never a credential.
 */
export function deliveryStatus(): {
  email: { provider: OtpProvider; configured: boolean };
  sms: { provider: OtpProvider; configured: boolean };
  revealsCodeWhenUnconfigured: boolean;
  betaReveal: { enabled: boolean; accounts: string[] };
} {
  const mail = emailProvider();
  const sms = smsConfigured();
  return {
    email: { provider: mail, configured: mail !== "none" },
    sms: { provider: sms ? "twilio" : "none", configured: sms },
    revealsCodeWhenUnconfigured: shouldReveal(false),
    betaReveal: { enabled: betaRevealEnabled(), accounts: listBetaTesters() },
  };
}

/**
 * Whether the code is ever handed back in the API response.
 *
 * Exposed so the production boot check can refuse to start with it on: a
 * deployment that returns sign-in codes to whoever asks has no authentication
 * at all, however good the rest of it looks.
 */
export function codeRevealEnabled(): boolean {
  return shouldReveal(false);
}

/* -------------------------------------------------------------------------
 * Masking — used in user-facing confirmations so a typo is visible without
 * printing the whole address back at whoever typed it.
 * ---------------------------------------------------------------------- */

export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return email;
  const name = email.slice(0, at);
  const domain = email.slice(at);
  if (name.length <= 2) return `${name[0] ?? ""}***${domain}`;
  return `${name.slice(0, 2)}***${name.slice(-1)}${domain}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return phone;
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}
