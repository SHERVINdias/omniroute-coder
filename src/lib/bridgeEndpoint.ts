/**
 * src/lib/bridgeEndpoint.ts
 * ---------------------------------------------------------------------------
 * One answer to "what URL should the VS Code extension dial?"
 *
 * WHY THIS IS NOT A CONSTANT
 *
 * It used to be. `src/app/api/extension/token/route.ts` held:
 *
 *     const WS_URL = "ws://127.0.0.1:20129";
 *
 * and handed that string to whoever asked for a pairing token. That is the
 * right answer for exactly one person — the operator, running the app on the
 * same laptop as the editor — and a dead end for everybody else. A beta tester
 * in another city who pastes `ws://127.0.0.1:20129` into their extension is
 * telling it to dial *their own machine*, where nothing is listening. The
 * connection fails with ECONNREFUSED and nothing in the message hints that the
 * URL was the problem.
 *
 * So the endpoint is derived per request instead, and there are three cases:
 *
 *   1. OMNIROUTE_BRIDGE_PUBLIC_URL is set. The operator has told us what the
 *      public address is; nothing beats being told. This is what production
 *      should use, because only the operator knows whether Caddy terminates on
 *      a path, a subdomain or a separate port.
 *   2. The caller reached us over loopback. This is the laptop case — the app
 *      and the editor are on one machine — so the direct port is correct and
 *      needs no proxy at all.
 *   3. Anything else. The caller reached us over a real hostname, so the
 *      bridge must be reachable through the same hostname, over the same TLS,
 *      on the reverse-proxied path below.
 *
 * WHY PATH-PROXIED RATHER THAN A SECOND PORT
 *
 * `wss://omniroute-beta.duckdns.org/vscode-bridge` rather than
 * `wss://omniroute-beta.duckdns.org:20129`. A second public port means a
 * second security-group rule, a second certificate arrangement, and a port
 * number that corporate networks and cafe wifi very often block outbound.
 * Everything already has to work on 443; putting the bridge there too means it
 * works wherever the web app works, and the WebSocket upgrade is a normal HTTP
 * request until the moment the proxy hands the socket over, so Caddy needs no
 * special configuration beyond the reverse_proxy line.
 */

import type { NextRequest } from "next/server";
import { isBridgeEnabled } from "@/lib/deploymentMode";

/**
 * The path Caddy forwards to the bridge listener.
 *
 * Exported because three things must agree on it and a typo in any one of them
 * produces a connection that hangs rather than an error: this module (which
 * tells the extension where to dial), the Caddyfile (which routes it) and
 * `vscodeBridge.ts` (which refuses upgrades on any other path, so that a
 * misrouted request is rejected loudly instead of being accepted as a bridge
 * session).
 */
export const BRIDGE_PATH = "/vscode-bridge";

/** Same default as `vscodeBridge.ts`; both read the same variable. */
function bridgePort(): number {
  const raw = Number(process.env.OMNIROUTE_BRIDGE_PORT || 20129);
  return Number.isFinite(raw) && raw > 0 && raw < 65536 ? raw : 20129;
}

function trustProxyHeaders(): boolean {
  const raw = (process.env.OMNIROUTE_TRUST_PROXY ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/** Host with any port stripped, lowercased. Brackets on IPv6 are preserved. */
function hostOnly(value: string): string {
  const raw = value.trim().toLowerCase();
  if (raw.startsWith("[")) return raw.slice(0, raw.indexOf("]") + 1);
  const colon = raw.lastIndexOf(":");
  return colon > 0 ? raw.slice(0, colon) : raw;
}

function isLoopbackHost(host: string): boolean {
  const bare = hostOnly(host).replace(/^\[|\]$/g, "");
  return (
    bare === "localhost" ||
    bare === "::1" ||
    bare === "0:0:0:0:0:0:0:1" ||
    /^127\./.test(bare)
  );
}

/**
 * The address the extension should be given, for this caller, right now.
 *
 * Takes the request rather than reading a global because the correct answer
 * genuinely differs between two simultaneous callers: the operator poking the
 * endpoint from the server's own shell should get the direct port, and a beta
 * tester hitting the same endpoint through Caddy should get the wss URL. A
 * module-level constant cannot be right for both.
 */
export function bridgePublicUrl(req: NextRequest): string {
  const explicit = (process.env.OMNIROUTE_BRIDGE_PUBLIC_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  /* `x-forwarded-host` is caller-controlled unless a proxy overwrites it, and
   * believing it unconditionally would let someone hand a victim a pairing URL
   * pointing at a host they control. Same reasoning, and the same flag, as the
   * rate limiter's treatment of x-forwarded-for. */
  const trusted = trustProxyHeaders();
  const forwardedHost = trusted
    ? (req.headers.get("x-forwarded-host") || "").split(",")[0]?.trim()
    : "";
  const host = forwardedHost || req.headers.get("host") || "";

  if (!host || isLoopbackHost(host)) {
    return `ws://127.0.0.1:${bridgePort()}`;
  }

  const forwardedProto = trusted
    ? (req.headers.get("x-forwarded-proto") || "").split(",")[0]?.trim()
    : "";
  let proto = forwardedProto;
  if (!proto) {
    try {
      proto = new URL(req.url).protocol.replace(":", "");
    } catch {
      proto = "https";
    }
  }

  const scheme = proto === "http" ? "ws" : "wss";
  return `${scheme}://${host}${BRIDGE_PATH}`;
}

/**
 * Whether this deployment can actually accept an extension connection.
 *
 * The listener refuses to open in a production build unless
 * OMNIROUTE_BRIDGE_ENABLE is the literal string "true" (see vscodeBridge.ts),
 * so the pairing UI has to know that too — otherwise it hands out tokens for a
 * socket that will never answer, and the user spends an afternoon blaming
 * their firewall.
 */
export function bridgeConfigured(): boolean {
  return isBridgeEnabled();
}

/**
 * Pack the address and the token into the single string a user pastes.
 *
 * WHY ONE STRING RATHER THAN TWO FIELDS
 *
 * Pairing used to be two values that had to arrive in two different boxes in
 * the right order: a URL into `omniroute.serverUrl` and a token into
 * `omniroute.pairingToken`. That is the step people get wrong, and getting it
 * wrong fails by *timing out* rather than by erroring — the extension dials
 * 127.0.0.1 forever, which looks identical to a server being down. Carrying
 * both in one opaque blob removes the ordering, removes the second box, and
 * makes a truncated paste fail immediately and legibly.
 *
 * WHY base64url OF JSON, AND NOT A URL
 *
 * The obvious encoding is `wss://host/vscode-bridge#omr_pair_…`. It is worse
 * in two ways for a code that travels by WhatsApp, LinkedIn message or email:
 * chat clients linkify anything with a scheme, and a linkified URL very often
 * loses its fragment, so the token silently disappears. And a `?token=` in its
 * place would be a live credential in a link preview fetch. `omr_link_…` is
 * inert text that no client will turn into a link.
 *
 * It is NOT encryption and is not treated as any. Base64 is transport
 * packaging; the token inside is the secret, which is why this value is shown
 * exactly once and never stored.
 *
 * THE OTHER HALF OF THIS IS `vscode-extension/src/pairing.ts`. The two must
 * agree on the prefix and on the `{u, t}` key names; the extension's
 * `encodePairingLink` is the mirror of this function and its
 * `parsePairingInput` is the reader.
 */
export function encodePairingCode(wsUrl: string, token: string): string {
  const payload = JSON.stringify({ u: wsUrl, t: token });
  return `omr_link_${Buffer.from(payload, "utf8").toString("base64url")}`;
}
