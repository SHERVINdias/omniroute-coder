/**
 * vscode-extension/src/pairing.ts
 * ---------------------------------------------------------------------------
 * Where the extension keeps the credential that identifies its owner, and how
 * it understands whatever the user pastes into the box.
 *
 * WHY NOT settings.json
 *
 * The original version read the token from `omniroute.pairingToken`, an
 * ordinary VS Code setting. Three things are wrong with that, in increasing
 * order of seriousness:
 *
 *   1. It is plain text in a JSON file that people screenshot, paste into
 *      issues, and commit to dotfiles repos.
 *   2. Settings Sync copies it to every machine signed in to the same GitHub
 *      or Microsoft account. A credential that grants read/write access to a
 *      workspace should not travel by itself.
 *   3. `settings.json` can be workspace-scoped (`.vscode/settings.json`), so a
 *      token written while a repo was open can end up committed to that repo.
 *
 * `context.secrets` is VS Code's own `SecretStorage`, backed by the OS
 * keychain (Keychain on macOS, libsecret on Linux, DPAPI on Windows). It is
 * not synced, not in any file the user edits, and not visible to other
 * extensions. Anything issued as a credential belongs there.
 *
 * WHAT A USER ACTUALLY PASTES
 *
 * The web app hands out one opaque string:
 *
 *     omr_link_<base64url(JSON {"u": "wss://host/vscode-bridge", "t": "omr_pair_…"})>
 *
 * One string carries both halves, so the user never has to get a URL and a
 * token into two different boxes in the right order — which is the step people
 * get wrong, and which fails with a timeout rather than an error. It is also
 * safe to send over WhatsApp or email: chat clients linkify anything starting
 * with a scheme, and a linkified `wss://…#omr_pair_…` loses its fragment as
 * often as not.
 *
 * The parser still accepts the other shapes, because people paste what they
 * have rather than what they were asked for:
 *
 *   - a bare `omr_pair_…` token (the URL is then asked for separately)
 *   - `wss://host/vscode-bridge#omr_pair_…`
 *   - `wss://host/vscode-bridge?token=omr_pair_…`
 *   - the raw JSON body of `POST /api/extension/token`
 *
 * Every one of those ends up in the same `{url, token}` pair.
 */

import * as vscode from "vscode";

/** The shape that gets stored, and the only thing `connect()` needs. */
export interface Pairing {
  /** A `ws://` or `wss://` URL. Never carries the token. */
  url: string;
  /** `omr_pair_` + 48 hex characters. */
  token: string;
}

/** SecretStorage key. Versioned so a future format change can migrate. */
const SECRET_KEY = "omniroute.pairing.v1";

/** The setting this file exists to replace. Read once, then deleted. */
const LEGACY_TOKEN_SETTING = "pairingToken";
const LEGACY_URL_SETTING = "serverUrl";

const TOKEN_PREFIX = "omr_pair_";
/** 24 random bytes, hex-encoded. Must match `extensionTokenStore.ts`. */
const TOKEN_BODY_LENGTH = 48;

const LINK_PREFIX = "omr_link_";

/** Where a local install listens when nothing else is known. */
export const LOCAL_BRIDGE_URL = "ws://127.0.0.1:20129";

/* ------------------------------ validation ------------------------------ */

/**
 * A structural check only — it says "this could be a token", never "this token
 * is valid". Only the server can answer the second question, and it does, by
 * refusing the upgrade with 401. The point of checking here is to give a
 * useful message for the overwhelmingly common paste accidents (half a token,
 * a token with a trailing quote, the wrong string entirely) instead of a
 * connection that fails a second later for reasons the user cannot see.
 */
export function looksLikeToken(value: string): boolean {
  if (!value.startsWith(TOKEN_PREFIX)) return false;
  const body = value.slice(TOKEN_PREFIX.length);
  return body.length === TOKEN_BODY_LENGTH && /^[0-9a-f]+$/i.test(body);
}

/**
 * Validate and tidy a bridge URL.
 *
 * Rejecting `http(s)://` rather than silently rewriting it is deliberate. The
 * web address and the bridge address differ by more than the scheme — the
 * bridge lives on a path the operator chose — so a rewrite would produce a URL
 * that looks plausible and connects to nothing. The message names the likely
 * correct value instead, which the user can check against what the app showed
 * them.
 */
export function normaliseBridgeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("The bridge address is empty.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `"${trimmed}" is not a URL. It should look like wss://your-host/vscode-bridge, ` +
        `or ${LOCAL_BRIDGE_URL} if OmniRoute is running on this machine.`,
    );
  }

  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    const suggested =
      (parsed.protocol === "https:" ? "wss://" : "ws://") +
      parsed.host +
      (parsed.pathname === "/" ? "/vscode-bridge" : parsed.pathname);
    throw new Error(
      `That is the web address of OmniRoute, not the bridge address. ` +
        `The bridge address starts with wss:// — probably ${suggested}. ` +
        `Open OmniRoute in your browser and use the "Connect VS Code" panel, which shows the exact value.`,
    );
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(
      `"${parsed.protocol}" is not a WebSocket scheme. The bridge address must start with wss:// or ws://.`,
    );
  }

  /* The token never belongs in the URL we keep: the query string ends up in
   * the reverse proxy's access log, and the fragment is not sent to the server
   * at all. Both are read by the parser and then dropped here. */
  parsed.hash = "";
  parsed.search = "";

  /* A trailing slash changes the path, and `verifyUpgrade` compares the path
   * exactly — "/vscode-bridge/" is a 404, not a bridge session. */
  const href = parsed.toString().replace(/\/+$/, "");
  return href || parsed.origin;
}

/**
 * True when a plain `ws://` URL points somewhere other than this machine.
 *
 * Worth a confirmation prompt: `ws://` is unencrypted, so a token sent to a
 * remote host that way is readable by anything between here and there. To
 * loopback it is fine and is the normal local-install case.
 */
export function isUnencryptedRemote(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:") return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return !(
      host === "localhost" ||
      host === "::1" ||
      host === "0:0:0:0:0:0:0:1" ||
      /^127\./.test(host)
    );
  } catch {
    return false;
  }
}

/* -------------------------------- parsing ------------------------------- */

/** What a paste resolved to. `url` is null when the paste carried only a token. */
export interface ParsedPairing {
  url: string | null;
  token: string;
}

function decodeBase64Url(value: string): string {
  /* Node has understood "base64url" since 16; VS Code 1.90 ships Node 20. The
   * padding/`-_` handling that everyone writes by hand is already in there. */
  return Buffer.from(value, "base64url").toString("utf8");
}

function fromJsonBody(raw: string): ParsedPairing | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;

  /* `POST /api/extension/token` replies `{token, wsUrl, …}`; the link payload
   * uses the short `{t, u}`. Both, plus the obvious spellings. */
  const token = [record.token, record.t, record.pairingToken].find(
    (v) => typeof v === "string" && v,
  ) as string | undefined;
  if (!token) return null;

  const url = [record.wsUrl, record.url, record.u, record.serverUrl].find(
    (v) => typeof v === "string" && v,
  ) as string | undefined;

  return { url: url ? normaliseBridgeUrl(url) : null, token: token.trim() };
}

/**
 * Decode the part after `omr_link_`, tolerating trailing prose.
 *
 * WHY THIS IS NOT JUST A DECODE
 *
 * Stripping every character outside `[A-Za-z0-9_-]` correctly rejoins a code
 * that an email client wrapped across lines. It does not help when the user
 * copied the surrounding sentence too, because ordinary words are made of
 * base64url characters: "lmk if it works" survives the strip as
 * "lmkifitworks" and is welded onto the payload. base64 decodes in groups of
 * four, so those extra characters do not merely append bytes — they change the
 * final group, corrupting the tail of the JSON. The result was an error
 * message telling the user their code was invalid when it was fine and their
 * copy was merely generous.
 *
 * There is no way to tell payload from prose by looking at the characters, so
 * this walks the end of the candidate inwards and returns the first length
 * that decodes to a well-formed payload. The correct length is always found
 * because the real payload is a prefix of the candidate, and a wrong length
 * essentially never yields parseable JSON carrying a valid token.
 */
function decodeLinkPayload(candidate: string): ParsedPairing | null {
  /* A payload contains a 57-character token plus JSON scaffolding, so nothing
   * shorter than this can be real. The floor just bounds the loop. */
  const FLOOR = 48;
  for (let end = candidate.length; end >= FLOOR; end--) {
    let decoded: string;
    try {
      decoded = decodeBase64Url(candidate.slice(0, end));
    } catch {
      continue;
    }
    /* Cheap reject before the JSON parser: every real payload is an object. */
    if (!decoded.startsWith("{")) continue;
    let parsed: ParsedPairing | null;
    try {
      parsed = fromJsonBody(decoded);
    } catch {
      /* `normaliseBridgeUrl` throws on a mangled url; that slice is wrong. */
      continue;
    }
    if (parsed && looksLikeToken(parsed.token)) return parsed;
  }
  return null;
}

/**
 * Turn whatever was pasted into `{url, token}`, or throw something a human can
 * act on.
 *
 * Leading/trailing junk is stripped first. People paste with a trailing
 * newline, wrapped in quotes or backticks, or with the word the app used
 * ("Pairing code: omr_link_…") still attached; none of that should be an
 * error, because the fix is obvious to us and invisible to them.
 *
 * Each format is located by searching rather than by `startsWith`, so a label
 * in front of the credential ("Pairing code: …") is tolerated, and — the case
 * that actually bites — a long `omr_link_` code that an email client wrapped
 * across lines is rejoined instead of being truncated at the first newline.
 */
export function parsePairingInput(input: string): ParsedPairing {
  let raw = (input || "").trim();
  raw = raw.replace(/^["'`<(\[]+/, "").replace(/["'`>)\].,;]+$/, "");

  if (!raw) {
    throw new Error("Nothing was pasted.");
  }

  /* --- 1. the format the app hands out --- */
  const linkAt = raw.indexOf(LINK_PREFIX);
  if (linkAt !== -1) {
    /* base64url is exactly [A-Za-z0-9_-], so discarding everything else after
     * the prefix rejoins a line-wrapped code and drops trailing quotes without
     * ever removing a character that belonged to the payload. Trailing *words*
     * survive this strip, which is what decodeLinkPayload then handles. */
    const encoded = raw.slice(linkAt + LINK_PREFIX.length).replace(/[^A-Za-z0-9_-]/g, "");
    if (!encoded) {
      throw new Error("That pairing code is empty after the prefix. Copy it again from OmniRoute.");
    }
    const parsed = decodeLinkPayload(encoded);
    if (!parsed) {
      throw new Error(
        "That pairing code could not be read. Copy it again from the \"Connect VS Code\" panel in " +
          "OmniRoute — and if you copied it out of a chat message, select just the code itself.",
      );
    }
    return parsed;
  }

  /* --- 2. someone pasted the API response --- */
  if (raw.startsWith("{")) {
    const parsed = fromJsonBody(raw);
    if (parsed && looksLikeToken(parsed.token)) return parsed;
    throw new Error(
      "That looks like JSON, but it has no `token` field containing an omr_pair_… value.",
    );
  }

  /* --- 3. a URL carrying the token in the fragment or query --- */
  const urlMatch = /wss?:\/\/\S+/i.exec(raw);
  if (urlMatch) {
    const rawUrl = urlMatch[0];
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`"${rawUrl}" is not a valid URL.`);
    }
    const fragment = parsed.hash.replace(/^#/, "").trim();
    const fromFragment = fragment.startsWith(TOKEN_PREFIX)
      ? fragment
      : new URLSearchParams(fragment).get("token") || "";
    const token = (fromFragment || parsed.searchParams.get("token") || "").trim();

    if (!token) {
      throw new Error(
        "That address has no pairing token in it. Use the full pairing code from OmniRoute " +
          "(it starts with omr_link_), or paste the token on its own.",
      );
    }
    if (!looksLikeToken(token)) {
      throw new Error("The token in that address is not in the expected format.");
    }
    return { url: normaliseBridgeUrl(rawUrl), token };
  }

  /* --- 4. a bare token --- */
  const tokenAt = raw.indexOf(TOKEN_PREFIX);
  if (tokenAt !== -1) {
    /* Rejoin a wrapped token, then keep the prefix plus the run of hex that
     * follows it — which ends at the first character that cannot be part of a
     * token, so a trailing quote, period or comment is dropped. */
    const compact = raw.slice(tokenAt).replace(/\s+/g, "");
    const cleaned = /^omr_pair_[0-9a-fA-F]*/.exec(compact)?.[0] ?? compact;
    if (!looksLikeToken(cleaned)) {
      const body = cleaned.slice(TOKEN_PREFIX.length);
      throw new Error(
        `That token is ${body.length} characters after the prefix; a whole one is ${TOKEN_BODY_LENGTH}. ` +
          `It was probably cut short when it was copied.`,
      );
    }
    return { url: null, token: cleaned };
  }

  throw new Error(
    "That does not look like an OmniRoute pairing code. A pairing code starts with omr_link_ " +
      "and comes from the “Connect VS Code” panel in the OmniRoute web app.",
  );
}

/**
 * Build the string the web app hands out.
 *
 * Kept next to the parser on purpose: the two have to agree, and a format that
 * is written in one file and read in another drifts. The extension itself only
 * needs this for the "copy my pairing code" path, but having it here means the
 * round trip can be exercised without a server.
 */
export function encodePairingLink(pairing: Pairing): string {
  const payload = JSON.stringify({ u: pairing.url, t: pairing.token });
  return LINK_PREFIX + Buffer.from(payload, "utf8").toString("base64url");
}

/* --------------------------------- store -------------------------------- */

/**
 * Read/write the credential. One instance per activation.
 *
 * Every method is async because `SecretStorage` is — it talks to the OS
 * keychain, which can prompt, be locked, or be missing entirely on a bare
 * Linux box without libsecret. Callers must handle "no pairing" as a normal
 * state rather than an error, because a fresh install is exactly that.
 */
export class PairingStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async read(): Promise<Pairing | null> {
    let raw: string | undefined;
    try {
      raw = await this.context.secrets.get(SECRET_KEY);
    } catch (err) {
      /* A locked or unavailable keychain must not take the extension down —
       * it should look exactly like "not paired yet" and say so. */
      console.warn("[OmniRoute] SecretStorage unavailable:", err);
      return null;
    }
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as Partial<Pairing>;
      if (typeof parsed.token !== "string" || !parsed.token) return null;
      if (typeof parsed.url !== "string" || !parsed.url) return null;
      return { url: parsed.url, token: parsed.token };
    } catch {
      return null;
    }
  }

  async write(pairing: Pairing): Promise<void> {
    await this.context.secrets.store(SECRET_KEY, JSON.stringify(pairing));
  }

  async clear(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
  }

  /**
   * Move a token out of settings.json and delete it from there.
   *
   * Runs on every activation, not just the first, because a user can paste a
   * token back into settings at any time — the setting still exists, marked
   * deprecated, precisely so that doing so is recoverable rather than a silent
   * no-op. Whatever is found is moved and then removed, so the credential
   * spends as little time as possible in a synced file.
   *
   * Returns the pairing it rescued, or null if there was nothing to rescue.
   */
  async migrateLegacySetting(): Promise<Pairing | null> {
    const config = vscode.workspace.getConfiguration("omniroute");
    const legacyToken = (config.get<string>(LEGACY_TOKEN_SETTING) || "").trim();
    if (!legacyToken) return null;

    const legacyUrl = (config.get<string>(LEGACY_URL_SETTING) || "").trim();

    let pairing: Pairing;
    try {
      const parsed = parsePairingInput(legacyToken);
      pairing = {
        token: parsed.token,
        url: parsed.url || (legacyUrl ? normaliseBridgeUrl(legacyUrl) : LOCAL_BRIDGE_URL),
      };
    } catch {
      /* Unparseable. Still clear it — leaving a bad credential in a synced
       * file has no upside — but do not overwrite a good stored pairing. */
      await this.clearLegacySetting();
      return null;
    }

    const existing = await this.read();
    if (!existing) {
      await this.write(pairing);
    }
    await this.clearLegacySetting();
    return existing ? null : pairing;
  }

  /**
   * Remove the setting from every scope that defines it.
   *
   * `update(key, undefined, target)` only clears the scope named, so a token
   * written to both the user and the workspace file needs two calls, and the
   * workspace ones throw when no folder is open. Each is attempted
   * independently so one failure cannot leave the others behind.
   */
  private async clearLegacySetting(): Promise<void> {
    const config = vscode.workspace.getConfiguration("omniroute");
    const inspected = config.inspect<string>(LEGACY_TOKEN_SETTING);
    const targets: Array<[unknown, vscode.ConfigurationTarget]> = [
      [inspected?.globalValue, vscode.ConfigurationTarget.Global],
      [inspected?.workspaceValue, vscode.ConfigurationTarget.Workspace],
      [inspected?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
    ];

    for (const [value, target] of targets) {
      if (value === undefined) continue;
      try {
        await config.update(LEGACY_TOKEN_SETTING, undefined, target);
      } catch (err) {
        console.warn("[OmniRoute] Could not clear the legacy pairingToken setting:", err);
      }
    }
  }
}
