/**
 * src/app/api/credits/route.ts
 * ---------------------------------------------------------------------------
 * Backs the quota panel: provider balances plus whatever the gateway reports.
 *
 * It used to read `process.env.OMNIROUTE_BASE_URL` / `OMNIROUTE_API_KEY` for
 * every caller and had no session check at all, so an anonymous request was
 * enough to make the server spend the operator's gateway credentials and report
 * back what they could see.
 *
 * The gateway probe now runs on the caller's own credentials, and the operator's
 * OpenRouter balance is only included for an admin — that key belongs to the
 * deployment, not to whoever happens to be signed in.
 *
 * WHY THE SSRF GUARD IS HERE TOO
 *
 * `creds.baseUrl` is a value the caller typed into Settings. This route is a
 * second place — besides /api/chat and /api/models — where the server fetches
 * it, and it was the one that had no guard. That mattered more here than the
 * usual "server as proxy" case, because the handler reads the reply and copies
 * `name`, `used`, `total` and `status` out of it into its own response: a host
 * on the server's private network that answers /api/quotas with JSON would have
 * had part of its answer reflected back to the caller, with the caller's
 * Authorization header attached on the way in. Guarded and `redirect: "manual"`
 * now, matching src/lib/upstreamRequest.ts.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireUser, isAdmin } from "@/lib/authGuard";
import { resolveGatewayCreds } from "@/lib/gatewayCreds";
import { guardUpstreamUrl } from "@/lib/upstreamRequest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreditRow {
  provider: string;
  used?: number;
  total?: number;
  unit?: string;
  status: string;
  resetInfo?: string;
  tracked: boolean;
}

export async function GET(req: NextRequest) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;

  const credits: CreditRow[] = [];

  /* Per-user gateway, so one account's quota panel never describes another's. */
  const creds = resolveGatewayCreds(auth.user.id);

  if (creds.configured) {
    try {
      const cleanBase = creds.baseUrl.replace(/\/$/, "");
      
      // Skip quota check for AgentRouter as it doesn't have /api/quotas endpoint
      if (creds.provider === "agentrouter") {
        console.log("Skipping quota check for AgentRouter - no quotas endpoint available");
        // Add a placeholder entry to show AgentRouter is configured
        credits.push({
          provider: "AgentRouter",
          status: "Connected (no quota info available)",
          tracked: false,
        });
      } else {
        /* Same refusal the chat path uses. On a deployed server this rejects
         * loopback, private space and the cloud metadata address before any
         * connection is opened; locally it allows them, which is what makes a
         * localhost gateway usable at all. */
        const blocked = await guardUpstreamUrl(cleanBase);
        if (blocked) {
          credits.push({
            provider: creds.provider || "Gateway",
            status: "Not reachable from this server",
            tracked: false,
          });
        } else {
          const res = await fetch(`${cleanBase}/api/quotas`, {
            headers: { Authorization: `Bearer ${creds.apiKey}` },
            cache: "no-store",
            signal: AbortSignal.timeout(8000),
            /* A 302 would otherwise walk the guard's decision straight past it —
             * the redirect target is never checked by the guard above. */
            redirect: "manual",
          });

          if (res.ok) {
            const data = await res.json();
            const items =
              data.accounts || data.quotas || (Array.isArray(data) ? data : []);

            items.forEach((acc: any) => {
              if (acc.name || acc.provider) {
                credits.push({
                  provider: acc.name || acc.provider,
                  used: acc.used ?? acc.usedCredits ?? acc.quota_used,
                  total: acc.total ?? acc.totalCredits ?? acc.quota_total,
                  unit: acc.unit || "Credits",
                  status: acc.status || "Live Sync",
                  resetInfo: acc.resetIn || acc.resets_at,
                  tracked: true,
                });
              }
            });
          }
        }
      }
    } catch (e) {
      console.error("Failed to query OmniRoute live quotas:", e);
    }
  }

  /* Operator-owned key: only an admin sees this balance. */
  if (isAdmin(auth.user) && process.env.OPENROUTER_API_KEY) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/credits", {
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json();
        const remaining = data.data?.total_credits;
        credits.push({
          provider: "OpenRouter",
          used: remaining !== undefined ? Number(remaining) : undefined,
          unit: "$",
          status: "Live Sync",
          tracked: true,
        });
      }
    } catch (e) {
      console.error("Failed to query OpenRouter balance:", e);
    }
  }

  return NextResponse.json({
    credits,
    gatewayConfigured: creds.configured,
    source: creds.source,
  });
}
