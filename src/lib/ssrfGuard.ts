/**
 * src/lib/ssrfGuard.ts
 * ---------------------------------------------------------------------------
 * Refuses server-side fetches aimed at the server's own network.
 *
 * THE ATTACK THIS BLOCKS
 *
 * Any endpoint that takes a URL from a request body and fetches it turns the
 * server into a proxy that sits *inside* the trust boundary. On a cloud VPS the
 * classic target is the instance metadata service at 169.254.169.254, which on
 * several providers returns credentials to anything that asks from the instance
 * itself. Private ranges (10/8, 172.16/12, 192.168/16) reach whatever else runs
 * on the host or its LAN — databases, admin panels, other containers.
 *
 * THE LOCALHOST EXCEPTION
 *
 * This app's whole premise is a gateway on localhost:20128. Blocking loopback
 * outright would break the primary use case. So the rule is environment-shaped:
 * in development everything is allowed, and in production loopback and private
 * ranges are refused unless OMNIROUTE_ALLOW_PRIVATE_GATEWAY says otherwise —
 * which is the right switch for someone running this app and the gateway on the
 * same private network.
 *
 * WHAT THIS IS NOT
 *
 * DNS rebinding is not addressed here: a hostname that resolves to a public
 * address at check time can resolve to 127.0.0.1 when fetch runs moments later.
 * Closing that requires pinning the resolved address into the connection, which
 * Node's fetch does not expose. Callers also pass `redirect: "manual"`, since a
 * 302 would otherwise bypass this check entirely.
 */

import dns from "dns/promises";
import net from "net";

import { isDesktopBuild } from "@/lib/deploymentMode";

export interface GuardResult {
  allowed: boolean;
  reason: string;
}

const ALLOWED: GuardResult = { allowed: true, reason: "" };

/**
 * Whether this deployment will fetch user-supplied URLs that resolve to
 * private or loopback addresses.
 *
 * Exported so the settings UI can say so BEFORE a user saves a gateway that
 * cannot work. On a hosted instance this is false, which means a base URL of
 * `http://localhost:20128/v1` is refused — and from the user's side that looks
 * identical to a broken gateway, because the request they are thinking of
 * ("my PC talking to my gateway") is not the request being made ("the server
 * talking to its own loopback").
 */
export function privateGatewayAllowed(): boolean {
  const raw = (process.env.OMNIROUTE_ALLOW_PRIVATE_GATEWAY ?? "")
    .trim()
    .toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;

  /* The desktop app may reach loopback, and this is the whole reason the local
   * gateway works there when it could not on AWS. On a hosted instance the
   * server IS the fetcher, so `http://localhost:20128/v1` means "the box
   * talking to its own loopback" and the refusal is correct and unfixable. On
   * the desktop the server and the gateway are the same machine, so localhost
   * genuinely reaches the user's own gateway.
   *
   * This is gated by the two-factor desktop signal — NOT by the env override
   * above, which stays the SSRF primitive it is and stays off everywhere. Safe
   * here because a desktop server only ever fetches URLs the local user typed
   * for themselves: the SSRF threat model ("a signed-in stranger makes the
   * operator's server hit its own metadata endpoint") has no stranger and no
   * shared operator on a single-user desktop. */
  if (isDesktopBuild()) return true;

  return process.env.NODE_ENV !== "production";
}

/** True for addresses that must never be reachable from a user-supplied URL. */
export function isBlockedAddress(ip: string): boolean {
  const version = net.isIP(ip);

  if (version === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts as [number, number, number, number];

    if (a === 127) return true;                    // loopback
    if (a === 10) return true;                     // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;       // private
    if (a === 169 && b === 254) return true;       // link-local, incl. metadata
    if (a === 0) return true;                      // "this network"
    if (a >= 224) return true;                     // multicast and reserved
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    return false;
  }

  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80")) return true;     // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    /* IPv4-mapped (::ffff:127.0.0.1) — judge the embedded v4 address. */
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isBlockedAddress(mapped[1]);
    return false;
  }

  /* Not an IP literal at all. */
  return false;
}

/**
 * Resolve `url`'s host and decide whether the server may fetch it.
 *
 * Never throws. A hostname that does not resolve is refused with a plain
 * message, because a fetch would fail anyway and the reason is useful.
 */
export async function isPubliclyRoutable(url: string): Promise<GuardResult> {
  if (privateGatewayAllowed()) return ALLOWED;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { allowed: false, reason: "That is not a valid URL." };
  }

  /* Strip the brackets IPv6 literals carry in URLs. */
  const bare = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;

  if (bare.toLowerCase() === "localhost") {
    return {
      allowed: false,
      reason:
        "This server cannot reach localhost gateways. A deployed app has no access to the machine you are browsing from — run the app locally to use a localhost gateway, or expose the gateway at a public address.",
    };
  }

  if (net.isIP(bare)) {
    if (isBlockedAddress(bare)) {
      return {
        allowed: false,
        reason:
          "That address is on a private or loopback network, which this server will not fetch.",
      };
    }
    return ALLOWED;
  }

  try {
    const resolved = await dns.lookup(bare, { all: true });
    if (resolved.length === 0) {
      return { allowed: false, reason: "That hostname did not resolve." };
    }
    /* Every resolved address must be acceptable: one private answer among
     * several is enough for the connection to land somewhere internal. */
    for (const entry of resolved) {
      if (isBlockedAddress(entry.address)) {
        return {
          allowed: false,
          reason:
            "That hostname resolves to a private or loopback address, which this server will not fetch.",
        };
      }
    }
    return ALLOWED;
  } catch {
    return {
      allowed: false,
      reason: "That hostname could not be resolved from this server.",
    };
  }
}
