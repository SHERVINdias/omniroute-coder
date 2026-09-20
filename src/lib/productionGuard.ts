/**
 * src/lib/productionGuard.ts
 * ---------------------------------------------------------------------------
 * Refuses to boot a production deployment that is configured in a way that
 * silently removes authentication or gives the product away.
 *
 * WHY A BOOT CHECK RATHER THAN MORE DEFAULTS
 *
 * Every setting below is *safe by default* on localhost and dangerous the
 * moment the app has a public address. The failure is not a crash — it is a
 * working app that looks fine:
 *
 *   AUTH_DEV_SHOW_OTP=true   returns the sign-in code in the API response, so
 *                            anyone can log in as anyone. There is no
 *                            authentication left at all.
 *   UPI_AUTO_APPROVE=true    marks every payment order paid the instant it is
 *                            created, so typing twelve digits grants PRO for
 *                            free. Correct on localhost where you are testing
 *                            the flow; a giveaway in public.
 *   AUTH_SECRET unset        the signing and credential-encryption secret is
 *                            generated and stored in the same database it
 *                            protects, so one stolen database file is enough to
 *                            forge sessions and decrypt every saved API key.
 *   file tools enabled       was on this list, and is no longer. Cowork used to
 *                            write to the SERVER's disk, shared by every
 *                            signed-in user. It now routes every operation to
 *                            the calling user's own editor and refuses to touch
 *                            local disk in a production build, so enabling the
 *                            tools is the intended configuration rather than a
 *                            hazard. Left here as a note because "why is this
 *                            not fatal any more" is a fair question to ask of a
 *                            file that exists to be paranoid.
 *
 * None of these announce themselves — the app works perfectly, for everybody.
 * That is exactly the class of mistake a boot check exists to catch.
 *
 * Hard failures stop the process. Warnings are printed once and the app
 * continues, because a warning that blocks a deployment just trains people to
 * set the escape hatch and ignore all of it.
 *
 * ESCAPE HATCH: OMNIROUTE_ALLOW_UNSAFE_CONFIG=true downgrades every hard failure
 * to a warning. It exists so that a deliberate, understood choice is still
 * possible — not as a thing to set by default.
 *
 * THE SUMMARY BLOCK
 *
 * Alongside the checks, every boot prints the configuration it actually
 * resolved. That is there because the majority of "it worked locally" reports
 * are not logic errors at all — they are a variable that was set in the wrong
 * file, spelled slightly differently, or shadowed by `environment:` in
 * docker-compose.yml overriding `env_file:`. A line in the log saying which
 * database file is open and which mail provider was selected answers that in
 * seconds instead of an afternoon.
 *
 * It prints resolved *values*, never secrets. A secret appears only as "set
 * (44 chars)", which is enough to tell a real key from a blank line or a
 * stray quote and useless to anyone reading the log.
 */

import fs from "fs";
import os from "os";
import path from "path";
import {
  deliveryStatus,
  codeRevealEnabled,
  betaRevealEnabled,
  listBetaTesters,
} from "./otpDelivery";
import { isAutoApproveEnabled } from "./appSettings";
import { fileToolsEnabled } from "./fileToolsGate";
import { ipLimitsAreShared } from "./rateLimit";
import { listBootstrapAdmins } from "./emailAuth";
import { databasePath } from "./db";

export interface GuardReport {
  fatal: string[];
  warnings: string[];
}

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function envFlag(name: string): boolean {
  const raw = env(name).toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/** True when the operator has explicitly accepted an unsafe configuration. */
function unsafeAllowed(): boolean {
  return envFlag("OMNIROUTE_ALLOW_UNSAFE_CONFIG");
}

/* -------------------------------------------------------------------------
 * Inspection helpers
 *
 * Each answers one question about the resolved environment and returns plain
 * data, so the checks below and the summary block can share them without either
 * one reaching into process.env a second time and disagreeing with the other.
 * ---------------------------------------------------------------------- */

interface SecretShape {
  set: boolean;
  length: number;
  /** Shorter than a generated 32-byte secret would be. */
  short: boolean;
  /** Dangerously short — closer to a word than to a key. */
  tooShort: boolean;
  /** Reads like a placeholder somebody meant to replace. */
  looksPlaceholder: boolean;
  /** Very few distinct characters, e.g. "aaaaaaaa..." */
  lowVariety: boolean;
}

/**
 * Judge a secret without ever revealing it.
 *
 * `openssl rand -base64 32` produces 44 characters and `-hex 32` produces 64,
 * so anything under 32 was not generated by the command the documentation
 * tells people to run. That is the signal being measured here — not entropy,
 * which cannot be estimated honestly from a single string.
 */
function inspectSecret(name: string): SecretShape {
  const value = env(name);
  if (!value) {
    return {
      set: false,
      length: 0,
      short: false,
      tooShort: false,
      looksPlaceholder: false,
      lowVariety: false,
    };
  }

  const lowered = value.toLowerCase();
  const placeholders = [
    "changeme",
    "change-me",
    "change_me",
    "yoursecret",
    "your-secret",
    "your_secret",
    "placeholder",
    "replaceme",
    "supersecret",
    "password",
    "secret123",
    "insecure",
    "example",
  ];

  return {
    set: true,
    length: value.length,
    short: value.length < 32,
    tooShort: value.length < 16,
    looksPlaceholder: placeholders.some((p) => lowered.includes(p)),
    lowVariety: new Set(value).size < 8,
  };
}

interface DatabaseLocation {
  path: string;
  /** Whether the file survives `docker compose down` and a rebuild. */
  persistent: boolean | null;
  detail: string;
}

/**
 * Work out whether the database is on something that outlives the container.
 *
 * The test is the device id. A Docker volume or bind mount is a separate
 * filesystem grafted into the tree, so `stat` reports a different `st_dev` for
 * it than for `/`. Matching `st_dev` means the file is in the container's own
 * writable layer, which `docker compose down` discards and a rebuild replaces —
 * every account, chat and saved API key with it.
 *
 * Only attempted inside a container. On a host there is no such distinction to
 * draw and guessing would produce a scary warning about a perfectly ordinary
 * setup.
 */
function inspectDatabaseLocation(): DatabaseLocation {
  const dbFile = databasePath();

  const inContainer =
    fs.existsSync("/.dockerenv") || env("OMNIROUTE_IN_CONTAINER") === "true";
  if (!inContainer) {
    return {
      path: dbFile,
      persistent: null,
      detail: "not running in a container; persistence is the host's business",
    };
  }

  try {
    const dir = path.dirname(dbFile);
    const target = fs.existsSync(dir) ? dir : path.dirname(dir);
    const onRoot = fs.statSync("/").dev === fs.statSync(target).dev;
    return {
      path: dbFile,
      persistent: !onRoot,
      detail: onRoot
        ? "on the container's writable layer — discarded on `docker compose down`"
        : "on a mounted volume",
    };
  } catch (error) {
    return {
      path: dbFile,
      persistent: null,
      detail: `could not be determined (${
        error instanceof Error ? error.message : String(error)
      })`,
    };
  }
}

interface MemoryBudget {
  /** What the process believes the machine has. */
  totalBytes: number;
  /** A cgroup ceiling, when the container runtime imposed one. */
  limitBytes: number | null;
  /** Effective ceiling: the lower of the two. */
  effectiveBytes: number;
  /** --max-old-space-size in MiB, if it was given. */
  heapCapMb: number | null;
}

/**
 * How much memory this process may use, and whether V8 has been told about it.
 *
 * `os.totalmem()` reads /proc/meminfo, which inside a container reports the
 * HOST's memory rather than the container's limit — so a 512 MB container on a
 * big machine sees gigabytes it will never be allowed to touch. V8 sizes its
 * default heap from that same number, which is how a container gets OOM-killed
 * while Node still believes it has room to grow. Reading the cgroup limit is
 * what makes the answer true.
 */
function inspectMemory(): MemoryBudget {
  const totalBytes = os.totalmem();

  let limitBytes: number | null = null;
  for (const file of [
    "/sys/fs/cgroup/memory.max", // cgroup v2
    "/sys/fs/cgroup/memory/memory.limit_in_bytes", // cgroup v1
  ]) {
    try {
      const raw = fs.readFileSync(file, "utf8").trim();
      if (raw && raw !== "max") {
        const parsed = Number(raw);
        /* v1 reports a sentinel near 2^63 when unlimited. Anything larger than
         * the machine itself is that sentinel, not a real limit. */
        if (Number.isFinite(parsed) && parsed > 0 && parsed < totalBytes * 2) {
          limitBytes = parsed;
        }
      }
      break;
    } catch {
      /* Not this cgroup version, or not readable. Try the next. */
    }
  }

  const nodeOptions = env("NODE_OPTIONS");
  const match = /--max-old-space-size[= ](\d+)/.exec(nodeOptions);
  const heapCapMb = match ? Number(match[1]) : null;

  return {
    totalBytes,
    limitBytes,
    effectiveBytes: limitBytes ?? totalBytes,
    heapCapMb,
  };
}

function formatMiB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}


/**
 * Evaluate the current configuration.
 *
 * Split out from `assertProductionSafety` so it can be called and inspected
 * without side effects — during testing, or from an admin diagnostics view.
 */
export function evaluateProductionSafety(): GuardReport {
  const fatal: string[] = [];
  const warnings: string[] = [];

  const isProduction = process.env.NODE_ENV === "production";

  if (!isProduction) {
    return { fatal, warnings };
  }

  /* ---------------------------------------------------------------- fatal */

  if (codeRevealEnabled()) {
    fatal.push(
      "Sign-in codes are being returned in the API response (AUTH_DEV_SHOW_OTP). " +
        "Anyone who can reach this server can sign in as any account. " +
        "Unset AUTH_DEV_SHOW_OTP, or set it to false.",
    );
  }

  if (isAutoApproveEnabled()) {
    fatal.push(
      "UPI auto-approve is ON (UPI_AUTO_APPROVE, or the toggle in the admin panel). " +
        "Every payment order is marked paid on creation, so PRO is free to anyone who asks. " +
        "Turn it off in the admin panel and reconcile payments by UTR instead.",
    );
  }

  /* AUTH_SECRET and CREDENTIALS_SECRET both fall back to a value generated and
   * stored in app_settings. That is genuinely fine on a laptop, and wrong on a
   * server, for a reason that is easy to miss: the fallback secret lives in the
   * SAME SQLite file as the ciphertext it protects. One stolen database file —
   * a mis-scoped backup, a snapshot, a volume left behind — is then enough to
   * decrypt every user's provider API key. Supplying the secret from the
   * environment separates the key from the data, which is the entire point of
   * encrypting the column.
   *
   * The second-order problem is sessions: on ephemeral storage the generated
   * secret is new on every restart, so every session and every pending sign-in
   * code is invalidated by a routine redeploy. */
  if (!env("AUTH_SECRET")) {
    fatal.push(
      "AUTH_SECRET is not set. Without it the signing secret is generated and stored in the " +
        "same database it protects, so anyone who obtains a copy of the database can forge " +
        "sessions — and on ephemeral storage every restart signs everyone out. " +
        "Generate one with `openssl rand -base64 32` and set it in .env.production.",
    );
  }

  /* A secret that is set but weak is worse than one that is missing, because
   * the missing case is caught above and this one looks configured. Both
   * thresholds below are about provenance rather than entropy: a value under 16
   * characters was typed by a person, and a person-typed session-signing key is
   * guessable in a way that a generated one is not. Forging a session cookie
   * gets an attacker in as any account, including an admin. */
  const authSecret = inspectSecret("AUTH_SECRET");
  if (authSecret.set && (authSecret.tooShort || authSecret.lowVariety)) {
    fatal.push(
      `AUTH_SECRET is set but weak (${authSecret.length} characters` +
        `${authSecret.lowVariety ? ", and only a handful of distinct ones" : ""}). ` +
        "It signs session cookies and, unless CREDENTIALS_SECRET is set, encrypts every " +
        "stored provider API key — a guessable value there means forged sessions and " +
        "readable credentials. Replace it with `openssl rand -base64 32`.",
    );
  } else if (
    authSecret.set &&
    authSecret.looksPlaceholder &&
    authSecret.short
  ) {
    fatal.push(
      "AUTH_SECRET still looks like the placeholder it was copied from. Replace it with " +
        "`openssl rand -base64 32`.",
    );
  }

  const credentialsSecret = inspectSecret("CREDENTIALS_SECRET");
  if (
    credentialsSecret.set &&
    (credentialsSecret.tooShort || credentialsSecret.lowVariety)
  ) {
    fatal.push(
      `CREDENTIALS_SECRET is set but weak (${credentialsSecret.length} characters). ` +
        "It is the AES key for every provider API key users have saved. " +
        "Replace it with `openssl rand -base64 32` — note that changing it makes existing " +
        "stored credentials undecryptable, so users will have to re-enter their keys.",
    );
  }

  /* File tools in production: no longer fatal, and the reason it changed is
   * worth stating precisely rather than trusting to memory.
   *
   * This was fatal because the tools reached the SERVER's disk and every
   * signed-in user shared it — "read .env" through a chat box returned the auth
   * secret. That is not what they do now. In a production build every file
   * operation is routed to the calling user's own editor, and there is no
   * fallback to this machine's filesystem: read, write, replace, list, backup
   * and project discovery each refuse rather than touch local disk when no
   * editor is attached. Keeping the fatal would mean refusing to start the
   * configuration this deployment is built around.
   *
   * What remains is a way to get it wrong that produces no danger and no
   * working product: tools switched on with no bridge to carry them, so every
   * call fails with "connect VS Code" and the button is there anyway. That is a
   * warning, because it is a mistake rather than a hazard. */
  if (fileToolsEnabled() && !envFlag("OMNIROUTE_BRIDGE_ENABLE")) {
    warnings.push(
      "File tools are enabled but OMNIROUTE_BRIDGE_ENABLE is not set, so there is no editor " +
        "bridge for them to reach. The Cowork UI will be offered and every file operation will " +
        "fail with a message asking the user to connect VS Code. Either set " +
        "OMNIROUTE_BRIDGE_ENABLE=true, or set OMNIROUTE_ENABLE_FILE_TOOLS=false to hide the " +
        "feature rather than advertise a broken one.",
    );
  }

  /* OMNIROUTE_WORKSPACE_ROOT in production: a warning, not a hard stop, and the
   * first draft of this check had it the other way round.
   *
   * The instinct is that pinning a directory on THIS machine reintroduces the
   * original hole. Following the code says otherwise: `workspaceRoot()` in
   * multi-tenant mode throws before it ever consults ENV_ROOT — with no session
   * it throws NOT_CONNECTED, and with a session whose editor did not answer it
   * throws "no folder is open". The env branch below those is unreachable, and
   * `setActiveWorkspace`, which is the other place ENV_ROOT is read, refuses
   * outright in this mode. So the variable is inert here rather than dangerous,
   * and a fatal would have refused to boot over a setting that does nothing.
   *
   * It is still worth saying out loud, because an operator who set it believes
   * something is happening that is not — and will reasonably conclude the
   * product is broken when the agent asks them to open a folder in VS Code
   * instead of using the one they carefully configured. */
  if (env("OMNIROUTE_WORKSPACE_ROOT")) {
    warnings.push(
      `OMNIROUTE_WORKSPACE_ROOT is set to "${env("OMNIROUTE_WORKSPACE_ROOT")}", and in a ` +
        "production build it is ignored. The workspace always comes from the folder open in " +
        "the connected user's own VS Code, because a directory on this server is not something " +
        "the agent may touch on anyone's behalf. Remove the variable to avoid the impression " +
        "that it is doing something.",
    );
  }

  /* ------------------------------------------------------------ warnings */

  const mail = deliveryStatus();

  if (!mail.email.configured) {
    warnings.push(
      "No email provider is configured, so sign-in codes cannot be delivered. " +
        "Set RESEND_API_KEY (easiest on a VPS — it works over HTTPS and is not blocked), " +
        "or GMAIL_USER + GMAIL_APP_PASSWORD for a small number of users.",
    );
  }

  if (!mail.sms.configured) {
    warnings.push(
      "No SMS provider is configured. Phone sign-in will report that it is unavailable " +
        "and suggest email. For Indian numbers this is not just a credentials problem — " +
        "A2P SMS needs DLT registration with the operator before anything will deliver.",
    );
  }

  /* Not fatal, because a listed account only sees its own code and only after a
   * real provider failure that was not a rate-limit. Warned every boot anyway,
   * because it is meant to be temporary and nothing else will ever remind
   * anyone that it is still on. */
  if (betaRevealEnabled()) {
    warnings.push(
      `The beta OTP fallback is ON for ${listBetaTesters().length} account(s) ` +
        `(AUTH_BETA_TESTERS: ${listBetaTesters().join(", ")}). Those accounts are shown ` +
        "their sign-in code in the browser when a configured mail provider fails, which " +
        "is one factor fewer than everyone else has. Verify a sending domain and clear " +
        "AUTH_BETA_TESTERS once real delivery works.",
    );
  }

  if (authSecret.set && authSecret.short && !authSecret.tooShort) {
    warnings.push(
      `AUTH_SECRET is ${authSecret.length} characters. \`openssl rand -base64 32\` produces ` +
        "44 and `-hex 32` produces 64, so this was probably not generated. It is above the " +
        "refusal threshold, but there is no reason to run a shorter key than the command " +
        "in the documentation gives you.",
    );
  }

  /* Not fatal, because CREDENTIALS_SECRET falls back to AUTH_SECRET, which is
   * already required above. Separate secrets are still better: rotating the
   * session secret then does not make every stored API key undecryptable. */
  if (!env("CREDENTIALS_SECRET")) {
    warnings.push(
      "CREDENTIALS_SECRET is not set, so stored provider API keys are encrypted with " +
        "AUTH_SECRET instead. That works, but it means the session secret and the " +
        "credential-encryption key are the same value — rotating one rotates the other, and " +
        "every saved API key becomes undecryptable. Set a separate CREDENTIALS_SECRET.",
    );
  }

  if (!env("ADMIN_EMAILS") && !env("ADMIN_EMAIL") && !env("ADMIN_PHONES")) {
    warnings.push(
      "Neither ADMIN_EMAILS nor ADMIN_PHONES is set, so no account is on the permanent admin " +
        "allowlist. Admin then depends entirely on the role column in the database; if that " +
        "is ever lost there is no way back into the admin panel.",
    );
  } else if (listBootstrapAdmins().length === 0) {
    /* Set, but nothing survived parsing. Without this the operator sees only
     * the per-entry warning emailAuth prints at import time, which scrolls past
     * in a container log — and then discovers at the worst possible moment that
     * the admin panel will not let them in. */
    warnings.push(
      "ADMIN_EMAILS / ADMIN_PHONES are set but no entry could be parsed, so the permanent " +
        "admin allowlist is empty. Check for a missing @, a stray quote, or a phone number " +
        "that is not 10 digits. The resolved list is printed in the summary above.",
    );
  }

  /* Where the data actually lives. Not fatal — an intentionally ephemeral
   * instance is a legitimate thing to run — but this is the single most
   * expensive mistake available here, because nothing goes wrong until the
   * first redeploy and by then the accounts are gone. */
  const database = inspectDatabaseLocation();
  if (database.persistent === false) {
    warnings.push(
      `The database is at ${database.path}, which is on the container's own writable layer. ` +
        "`docker compose down` and every rebuild discard it — all accounts, chats and saved " +
        "provider keys with it. Set OMNIROUTE_DB_PATH to a path under a mounted volume " +
        "(docker-compose.yml already mounts one at /data and sets OMNIROUTE_DB_PATH=/data/chat.db, " +
        "so seeing this means that value is being overridden somewhere).",
    );
  }

  /* Memory. A t4g.small is 2 GiB, shared with the OS, and V8 sizes its default
   * heap from what /proc/meminfo reports — which in a container is the host's
   * memory, not the container's share. Left alone, Node happily grows past what
   * the box can give it and the kernel kills the process; from the outside that
   * looks like the app randomly restarting under load. */
  const memory = inspectMemory();
  const smallBox = memory.effectiveBytes <= 2.5 * 1024 * 1024 * 1024;
  if (smallBox && memory.heapCapMb === null) {
    const suggested = Math.max(
      256,
      Math.floor((memory.effectiveBytes * 0.6) / (1024 * 1024)),
    );
    warnings.push(
      `This machine has ${formatMiB(memory.effectiveBytes)} available and NODE_OPTIONS does ` +
        "not set --max-old-space-size, so V8 will size its heap from the machine's total " +
        "memory and can grow into territory the kernel will not allow. Set " +
        `NODE_OPTIONS=--max-old-space-size=${suggested} to leave room for the OS, the SQLite ` +
        "page cache and any build running alongside.",
    );
  } else if (
    memory.heapCapMb !== null &&
    memory.heapCapMb * 1024 * 1024 > memory.effectiveBytes * 0.9
  ) {
    warnings.push(
      `NODE_OPTIONS caps the V8 heap at ${memory.heapCapMb} MiB, which is almost all of the ` +
        `${formatMiB(memory.effectiveBytes)} this process can use. The heap is not the only ` +
        "thing consuming memory — buffers, native modules and the OS need their share — so a " +
        "cap this high does not actually prevent the OOM killer. Around 60% of available " +
        "memory is a more useful ceiling.",
    );
  }

  if (memory.limitBytes !== null && memory.limitBytes < 768 * 1024 * 1024) {
    warnings.push(
      `The container memory limit is ${formatMiB(memory.limitBytes)}. A Next.js server plus ` +
        "better-sqlite3 needs more headroom than that under real traffic; expect restarts.",
    );
  }

  /* The bridge. NOT inert: vscodeBridge.ts calls initialize() at import time
   * when there is no `window`, and src/app/api/chat/route.ts imports from that
   * module — so the only thing keeping the port shut in production is the
   * OMNIROUTE_BRIDGE_ENABLE check inside initialize() itself.
   *
   * This used to be a warning telling the operator to unset the variable and
   * never to reverse-proxy the port, because the bridge authorised callers by
   * peer address and a proxy makes every internet caller look like localhost.
   * That was true and is no longer: the upgrade now requires a pairing token
   * that resolves to exactly one account, and a session can only ever reach the
   * folder open in that account's editor. Proxying it is the intended setup.
   *
   * The warning stays, at a lower temperature, because "a port that grants
   * filesystem access to whoever holds a token" is still worth seeing in a boot
   * log — and because the two things it now asks about (a strong AUTH_SECRET
   * and a public URL that is actually reachable) are the difference between a
   * working beta and an afternoon of blaming a firewall. */
  if (envFlag("OMNIROUTE_BRIDGE_ENABLE")) {
    const bridgePort = env("OMNIROUTE_BRIDGE_PORT") || "20129";
    const bridgeHost = env("OMNIROUTE_BRIDGE_HOST") || "127.0.0.1";
    const publicUrl = env("OMNIROUTE_BRIDGE_PUBLIC_URL");

    warnings.push(
      `The VS Code bridge is enabled and listening on ${bridgeHost}:${bridgePort}. Every ` +
        "connection must present a pairing token that maps to one account, and that account " +
        "can only reach the folder open in its own editor — nothing on this server. Revoke a " +
        "tester's access from the Connect VS Code panel, which also drops their live socket.",
    );

    /* In a container 127.0.0.1 is the CONTAINER's loopback, so a published port
     * reaches nothing. This is the single most likely way for a correctly
     * configured deployment to appear broken, and the symptom — a healthy
     * container that refuses every WebSocket — points nowhere near the cause. */
    if (bridgeHost === "127.0.0.1" || bridgeHost === "localhost") {
      warnings.push(
        "OMNIROUTE_BRIDGE_HOST is loopback. Inside a container that is the CONTAINER's " +
          "loopback, so a published port reaches nothing and every extension connection is " +
          'refused while the service still reports healthy. Set OMNIROUTE_BRIDGE_HOST="0.0.0.0" ' +
          'and publish the port as "127.0.0.1:20129:20129" so only the local proxy can dial it.',
      );
    }

    if (publicUrl) {
      if (/^ws:\/\//i.test(publicUrl) && !/127\.0\.0\.1|localhost/i.test(publicUrl)) {
        warnings.push(
          `OMNIROUTE_BRIDGE_PUBLIC_URL is "${publicUrl}" — plain ws://, not wss://. File ` +
            "contents and the pairing token would cross the network in the clear. Use wss:// " +
            "and let the same TLS terminator that fronts the web app proxy it.",
        );
      }
    } else {
      warnings.push(
        "OMNIROUTE_BRIDGE_PUBLIC_URL is not set. The app will guess the address from each " +
          "request's Host header, which is usually right behind a proxy and wrong in every " +
          "other case. Set it explicitly, e.g. wss://your-domain/vscode-bridge.",
      );
    }
  }

  /* The shared gateway fallback is the operator's own quota. On a public
   * deployment every user without their own provider would spend it. */
  const hasSharedGateway =
    !!env("OMNIROUTE_BASE_URL") && !!env("OMNIROUTE_API_KEY");
  if (hasSharedGateway) {
    warnings.push(
      "OMNIROUTE_BASE_URL and OMNIROUTE_API_KEY are set, so users who have not connected " +
        "their own provider will share this gateway and spend this quota. " +
        "That is the intended fallback only if you accept the cost.",
    );
    if (/localhost|127\.0\.0\.1|::1/i.test(env("OMNIROUTE_BASE_URL"))) {
      warnings.push(
        "OMNIROUTE_BASE_URL points at localhost. From a hosted server that resolves to the " +
          "server itself, not to your machine — no user's requests will reach your gateway. " +
          "Each user needs to set their own reachable gateway URL.",
      );
    }
  }

  /* Behind a proxy the per-source rate limits key on the real client address.
   * Without one, every visitor shares a single bucket. The limits scale up in
   * that case (see rateLimitByIp) so it degrades rather than locks everyone
   * out — but the protection is coarser, and saying so is the honest thing. */
  if (ipLimitsAreShared()) {
    warnings.push(
      "OMNIROUTE_TRUST_PROXY is not set, so per-IP rate limits share one bucket for all " +
        "visitors (limits are scaled up 25x to compensate). When this runs behind a reverse " +
        "proxy or tunnel that overwrites x-forwarded-for, set OMNIROUTE_TRUST_PROXY=true to " +
        "count each client separately. Do NOT set it if the app is exposed directly — the " +
        "header is client-controlled and forging it would bypass the limit.",
    );
  }

  return { fatal, warnings };
}

/**
 * The configuration this process actually resolved, as printable lines.
 *
 * ON PRINTING THE ADMIN ALLOWLIST IN FULL
 *
 * The addresses are shown unmasked, and that is a deliberate reversal of the
 * usual instinct. The failure this line exists to catch is a typo in
 * ADMIN_EMAILS — and `10***5@gmail.com` is identical whether the middle of the
 * address is right or wrong, so a masked version catches nothing at all while
 * looking responsible. What is being printed is the operator's own address, in
 * the operator's own server log, from a file the operator wrote. Weigh that
 * against locking yourself out of the admin panel of a deployed app, which is
 * recoverable only by editing the database by hand.
 *
 * The beta-tester list, immediately below it, IS masked — those are other
 * people's contact details, a typo there costs one person one convenience
 * rather than all administrative access, and the count is what matters.
 *
 * Nothing here prints a secret. Keys appear as "set (44 chars)".
 */
export function describeResolvedConfig(): string[] {
  const lines: string[] = [];
  const mail = deliveryStatus();
  const database = inspectDatabaseLocation();
  const memory = inspectMemory();
  const authSecret = inspectSecret("AUTH_SECRET");
  const credentialsSecret = inspectSecret("CREDENTIALS_SECRET");

  const describeSecret = (shape: SecretShape) =>
    shape.set ? `set (${shape.length} chars)` : "NOT SET";

  lines.push(`NODE_ENV               ${process.env.NODE_ENV ?? "(unset)"}`);
  lines.push(`database               ${database.path} — ${database.detail}`);
  lines.push(`AUTH_SECRET            ${describeSecret(authSecret)}`);
  lines.push(`CREDENTIALS_SECRET     ${describeSecret(credentialsSecret)}`);
  lines.push(
    `email provider         ${mail.email.configured ? mail.email.provider : "none"}` +
      `${env("MAIL_FROM") ? ` (from ${env("MAIL_FROM")})` : ""}`,
  );
  lines.push(
    `sms provider           ${mail.sms.configured ? mail.sms.provider : "none"}`,
  );

  const admins = listBootstrapAdmins();
  lines.push(
    `admin allowlist        ${admins.length ? admins.join(", ") : "(empty)"}`,
  );

  const betaTesters = listBetaTesters();
  lines.push(
    `beta OTP fallback      ${
      betaTesters.length ? `ON — ${betaTesters.join(", ")}` : "off"
    }`,
  );

  lines.push(`code reveal            ${codeRevealEnabled() ? "ON" : "off"}`);
  lines.push(`file tools             ${fileToolsEnabled() ? "ENABLED" : "disabled"}`);
  lines.push(
    `trust proxy            ${
      ipLimitsAreShared()
        ? "off — per-IP limits share one bucket"
        : "on — per-IP limits use the forwarded client address"
    }`,
  );
  lines.push(
    `memory                 ${formatMiB(memory.effectiveBytes)} available` +
      `${memory.limitBytes !== null ? " (cgroup limit)" : ""}` +
      `, V8 heap cap ${memory.heapCapMb !== null ? `${memory.heapCapMb} MiB` : "default"}`,
  );
  lines.push(
    `shared gateway         ${
      env("OMNIROUTE_BASE_URL") && env("OMNIROUTE_API_KEY")
        ? `${env("OMNIROUTE_BASE_URL")} (operator's quota)`
        : "not configured — each user brings their own"
    }`,
  );

  return lines;
}

/**
 * Print the report and stop the process if anything is fatal.
 *
 * Called once from the instrumentation hook. Throwing here aborts server
 * startup, which is the point: a deployment that hands out sign-in codes to
 * anonymous callers is worse than one that refuses to start and says why.
 */
export function assertProductionSafety(): void {
  const { fatal, warnings } = evaluateProductionSafety();

  const prefix = "\n  [omniroute] ";

  /* The summary goes first, and only in production. On a laptop it is noise on
   * every hot reload; on a server it is the first thing anyone reads when
   * something does not behave the way the .env file says it should. */
  if (process.env.NODE_ENV === "production") {
    console.log("\n  [omniroute] resolved configuration:");
    for (const line of describeResolvedConfig()) {
      console.log(`    ${line}`);
    }
    console.log("");
  }

  for (const warning of warnings) {
    console.warn(`${prefix}warning: ${warning}\n`);
  }

  if (fatal.length === 0) return;

  const relaxed = unsafeAllowed();

  if (relaxed) {
    console.warn(
      `${prefix}OMNIROUTE_ALLOW_UNSAFE_CONFIG is set, so these are warnings rather than a refusal:\n`,
    );
    for (const problem of fatal) {
      console.warn(`${prefix}  - ${problem}\n`);
    }
    return;
  }

  const lines = fatal.map((problem) => `${prefix}  - ${problem}`).join("\n");
  throw new Error(
    `\n${prefix}Refusing to start with an unsafe production configuration:\n` +
      `${lines}\n\n` +
      `${prefix}Fix the settings above, or set OMNIROUTE_ALLOW_UNSAFE_CONFIG=true ` +
      `to start anyway.\n`,
  );
}
