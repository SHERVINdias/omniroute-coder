/**
 * POST /api/credentials/test
 * ---------------------------------------------------------------------------
 * "Test connection" for a gateway the user is about to save.
 *
 * WHAT CHANGED AND WHY
 *
 * This was unauthenticated and took an arbitrary `baseUrl` from the body, then
 * fetched it server-side and returned the status and body back to the caller.
 * That is a server-side request forgery primitive: on a VPS it would happily
 * fetch `http://169.254.169.254/...` (the cloud metadata endpoint, which on many
 * providers hands out instance credentials) and hand the response to whoever
 * asked. It also echoed 200 characters of the upstream body back verbatim.
 *
 * Now it requires a session, refuses to fetch private and link-local addresses
 * in production, and returns only a classification of what happened rather than
 * the raw response.
 *
 * An empty apiKey means "test the key already stored for this provider id",
 * so the settings form can re-test without the browser ever holding the key.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/authGuard";
import { getProviderById } from "@/lib/credentialManager";
import {
  allowsEmptyApiKey,
  getProviderProfile,
  incompatibleProviderWarning,
} from "@/lib/providerProfiles";
import {
  getModelList,
  guardUpstreamUrl,
  postChatCompletion,
} from "@/lib/upstreamRequest";
import { rateLimit, formatRetryAfter } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * This route exists to open a connection to an address the caller names, which
 * is the shape of a port scanner. `guardUpstreamUrl` already decides *where* it
 * may go; this decides *how often*. Ten a minute is generous for someone
 * clicking "Test connection" and useless for sweeping a range.
 */
const TEST_LIMIT = { limit: 10, windowMs: 60_000 } as const;

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;

  const gate = rateLimit(`credentials-test:${guard.user.id}`, TEST_LIMIT);
  if (!gate.ok) {
    return NextResponse.json(
      {
        success: false,
        error: `Too many connection tests. Try again in ${formatRetryAfter(
          gate.retryAfterMs,
        )}.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;

    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    const providerId = typeof body.id === "string" ? body.id.trim() : "";
    const providerType =
      typeof body.provider === "string" ? body.provider.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    let apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

    if (!baseUrl) {
      return NextResponse.json(
        { success: false, error: "Base URL is required" },
        { status: 400 },
      );
    }

    if (!isValidUrl(baseUrl)) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Base URL must be a plain http:// or https:// address with no username or password in it.",
        },
        { status: 400 },
      );
    }

    /* Fall back to the stored key so "Test" works on a saved provider whose key
     * the browser never received. Scoped to this user, so another account's id
     * resolves to nothing. */
    let stored = null;
    if (providerId) {
      stored = getProviderById(guard.user.id, providerId);
      if (!apiKey && stored?.apiKey) apiKey = stored.apiKey;
    }

    /* The provider type decides the auth header, the endpoint path and whether
     * a key is needed at all. Prefer what the form sent, fall back to what was
     * saved, default to the local gateway. */
    const profile = getProviderProfile(
      providerType || stored?.provider || "omniroute",
    );

    const incompatible = incompatibleProviderWarning(profile);
    if (incompatible) {
      return NextResponse.json({ success: false, error: incompatible });
    }

    /* Local servers legitimately take no key; everything hosted needs one. */
    if (!apiKey && !allowsEmptyApiKey(profile, baseUrl)) {
      return NextResponse.json(
        { success: false, error: "API key is required to test this connection." },
        { status: 400 },
      );
    }

    const blocked = await guardUpstreamUrl(baseUrl, profile);
    if (blocked) {
      return NextResponse.json(
        { success: false, error: blocked },
        { status: 400 },
      );
    }

    const target = { profile, baseUrl, apiKey };

    /* Providers with no catalogue endpoint (Azure names its model in the
     * deployment URL) cannot be probed with a GET. Send the smallest possible
     * completion instead, and say so rather than reporting a false failure. */
    if (!profile.supportsModelList) {
      if (!model) {
        return NextResponse.json({
          success: false,
          error: `${profile.label} has no model-list endpoint, so testing it needs a model name. Enter one and test again.`,
        });
      }

      const probe = await postChatCompletion(
        target,
        { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
        { signal: AbortSignal.timeout(15_000) },
      );

      if (probe.ok) {
        return NextResponse.json({
          success: true,
          message: `Connected. ${profile.label} accepted a test completion for "${model}".`,
          status: probe.status,
        });
      }
      return NextResponse.json({
        success: false,
        error: describeStatus(
          probe.status,
          profile.label,
          await probe.text().catch(() => ""),
        ),
        status: probe.status,
      });
    }

    const response = await getModelList(target, { timeoutMs: 10_000 });
    if (!response) {
      return NextResponse.json({
        success: false,
        error: `${profile.label} has no model-list endpoint to test.`,
      });
    }

    if (response.ok) {
      /* Report the shape, never the body: the catalogue can contain account
       * identifiers, and this response goes straight to a browser. */
      let modelCount: number | null = null;
      try {
        const parsed = (await response.json()) as { data?: unknown[] };
        if (Array.isArray(parsed?.data)) modelCount = parsed.data.length;
      } catch {
        /* Not JSON, or not the shape we expected. The 200 still counts. */
      }

      return NextResponse.json({
        success: true,
        message:
          modelCount === null
            ? `Connected. ${profile.label} responded but did not return a model list in the usual format.`
            : `Connected. ${profile.label} offers ${modelCount} model${modelCount === 1 ? "" : "s"}.`,
        status: response.status,
        ...(modelCount === null ? {} : { modelCount }),
      });
    }

    /* Classify rather than forward. A raw upstream error body can echo back part
     * of the credential that was rejected. */
    /* Read the body so the message can name the real problem. It is classified
     * here and never forwarded — a raw upstream error can echo the credential. */
    const failureBody = await response.text().catch(() => "");

    return NextResponse.json({
      success: false,
      error: describeStatus(response.status, profile.label, failureBody),
      status: response.status,
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const friendly = /abort|timeout/i.test(raw)
      ? "The provider did not respond within the timeout."
      : "Could not reach that address. If this is a local model server, check that it is running.";

    console.error("[credentials/test] failed:", raw);
    return NextResponse.json({ success: false, error: friendly });
  }
}

function describeStatus(status: number, label: string, body = ""): string {
  const text = body.toLowerCase();

  /* A 401 does not always mean the key is wrong. Some relays accept the token
   * and reject the *client* — Agent Router answers a valid key with
   * "unauthorized client detected". Saying "rejected that API key" here sent the
   * user off re-pasting a key that was working elsewhere. */
  if (status === 401 || status === 403) {
    if (/unauthorized client|unauthorized_client|invalid client|not an approved client/.test(text)) {
      return (
        `${label} accepted your key but rejected this app as a client. ` +
        `It expects requests shaped like a specific application's, and blocks others regardless of the key. ` +
        `Check the provider's dashboard for allowed clients, or point the Base URL at a relay that permits your app.`
      );
    }
    if (/no token|token not provided|missing token|未提供令牌/i.test(body)) {
      return `${label} received no API key at all. Save one in Settings and test again.`;
    }
    if (/insufficient|quota|balance|credit|余额/i.test(body)) {
      return `${label} accepted the key but the account has no remaining quota.`;
    }
    return `${label} rejected that API key. Check that it is complete and not expired.`;
  }
  if (status === 404) {
    return `${label} responded but has nothing at that path. Check the base URL — most providers need a /v1 suffix, Groq needs /openai/v1, and Google needs /v1beta/openai.`;
  }
  if (status >= 300 && status < 400) {
    return `${label} redirected the request, which usually means the base URL is missing a path segment.`;
  }
  if (status >= 500) {
    return `${label} returned a server error (${status}).`;
  }
  return `${label} returned ${status}.`;
}
