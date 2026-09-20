/**
 * src/app/api/omniroute/debug/route.ts
 * ---------------------------------------------------------------------------
 * A diagnostic probe: it walks a long list of candidate gateway paths, reports
 * which ones answer, and can dump the raw /models response and a chat probe.
 *
 * This is the most talkative endpoint in the app — its whole job is to print
 * what the gateway says about the account. It was public, so anyone who found
 * the URL could read the operator's gateway layout, and the raw response
 * headers (which carry account and quota identifiers) along with it.
 *
 * It is now admin-only, and the header maps are redacted before they are
 * returned. Debug output stays useful without being a disclosure.
 *
 * ONE MORE GATE, AND WHY ADMIN-ONLY WAS NOT ENOUGH
 *
 * Admin-only limits who can call it; it does not limit where it points. The
 * origin comes from the admin's own saved provider, and this route's entire
 * purpose is to fan out across a list of candidate paths and hand back status
 * codes and body previews. That is a ready-made internal network scanner: on a
 * deployed instance, one compromised admin session would read whatever else is
 * on the host. So `guardUpstreamUrl` runs here too. In a local install it
 * allows loopback and changes nothing, which is exactly where this route is
 * meant to be used.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/authGuard";
import { resolveGatewayCreds, describeMissingGateway } from "@/lib/gatewayCreds";
import { guardUpstreamUrl } from "@/lib/upstreamRequest";
import {
  ALLOWED_PROVIDERS,
  toCatalogEntry,
  buildFailoverLadder,
  fetchGatewayModels,
  redact,
  EXTRA_MODELS,
} from "@/lib/omniroute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Header values can hold tokens, account ids and quota figures. `redact` only
 * understands key-shaped strings, so headers need their own pass: known-safe
 * protocol headers are kept, everything else is masked by name.
 */
const SAFE_HEADERS = new Set([
  "content-type",
  "content-length",
  "date",
  "server",
  "cache-control",
  "connection",
  "transfer-encoding",
  "x-request-id",
]);

function redactHeaders(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = SAFE_HEADERS.has(key.toLowerCase())
      ? value
      : redact(String(value)).slice(0, 80);
  }
  return out;
}

const CANDIDATE_PATHS = [
  "/api/endpoints",
  "/api/api-keys",
  "/api/api_keys",
  "/api/apikeys",
  "/api/keys",
  "/api/providers",
  "/api/provider-accounts",
  "/api/provider_accounts",
  "/api/combos",
  "/api/combo",
  "/api/combo-studio",
  "/api/engine-combos",
  "/api/engine_combos",
  "/api/provider-quota",
  "/api/provider_quota",
  "/api/quota-sharing",
  "/api/quota_sharing",
  "/api/embedded-services",
  "/api/embedded_services",
  "/api/accounts",
  "/api/account",
  "/api/provider",
  "/api/quota",
  "/api/quotas",
  "/api/usage",
  "/api/stats",
  "/api/credits",
  "/api/config",
  "/api/settings",
  "/api/models",
  "/api/dashboard",
  "/api/status",
  "/api/health",
  "/api/logs",
  "/api/requests",
  "/api/cutoffs",
  "/dashboard/api/quota",
  "/dashboard/api/providers",
  "/dashboard/api/accounts",
  "/dashboard/api/combos",
  "/v1/accounts",
  "/v1/quota",
  "/v1/usage",
  "/v1/credits",
  "/v1/models",
  "/accounts",
  "/providers",
  "/quota",
  "/usage",
  "/health",
];

const CANDIDATE_PAGES = [
  "/dashboard/quota",
  "/dashboard/providers",
  "/dashboard/combos",
  "/dashboard/endpoints",
  "/dashboard/api-keys",
  "/dashboard/quota-sharing",
  "/dashboard/engine-combos",
];

function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl.replace(/\/v1\/?$/, "");
  }
}

interface ProbeResult {
  url: string;
  status: number | "error";
  contentType: string | null;
  bytes: number;
  isJson: boolean;
  looksInteresting: boolean;
  preview: string;
}

async function probe(
  url: string,
  apiKey: string,
  previewBytes = 600,
): Promise<ProbeResult> {
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
      /* The guard in GET() judged one origin. Following a redirect would land
       * somewhere it never saw. */
      redirect: "manual",
    });
    const text = await res.text().catch(() => "");
    const contentType = res.headers.get("content-type");
    const isJson = /json/i.test(contentType || "") || /^[[{]/.test(text.trim());

    const looksInteresting =
      res.ok &&
      isJson &&
      /account|quota|credit|reset|cutoff|percent|remaining|limit/i.test(text);

    return {
      url,
      status: res.status,
      contentType,
      bytes: text.length,
      isJson,
      looksInteresting,
      preview: redact(text).slice(0, previewBytes),
    };
  } catch (err: unknown) {
    return {
      url,
      status: "error",
      contentType: null,
      bytes: 0,
      isJson: false,
      looksInteresting: false,
      preview: err instanceof Error ? err.message : String(err),
    };
  }
}

async function dumpModelsResponse(base: string, apiKey: string) {
  const url = `${base}/models`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      redirect: "manual",
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const text = await res.text().catch(() => "");
    return {
      url,
      status: res.status as number | "error",
      headers: redactHeaders(headers),
      bytes: text.length,
      body: redact(text).slice(0, 20000),
      truncated: text.length > 20000,
    };
  } catch (err) {
    return {
      url,
      status: "error" as const,
      headers: {} as Record<string, string>,
      bytes: 0,
      body: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      truncated: false,
    };
  }
}

export async function GET(req: NextRequest) {
  const auth = requireAdmin(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const modelParam = url.searchParams.get("model");
  const probeChat = url.searchParams.get("probeChat") === "1";
  const raw = url.searchParams.get("raw") === "1";

  /* The admin's own gateway, falling back to the shared one when the operator
   * is running locally. Probing with a credential the caller does not own would
   * describe someone else's account. */
  const creds = resolveGatewayCreds(auth.user.id);

  if (!creds.configured) {
    return NextResponse.json(
      {
        error: describeMissingGateway(creds),
        code: "GATEWAY_NOT_CONFIGURED",
        source: creds.source,
      },
      { status: 503 },
    );
  }

  const base = creds.baseUrl;
  const apiKey = creds.apiKey;
  const origin = originOf(base);

  /* Every probe below derives from this origin, so refusing once here covers
   * all of them — the model dump, the candidate-path sweep, the page sweep and
   * the chat probe. */
  const blocked = await guardUpstreamUrl(base);
  if (blocked) {
    return NextResponse.json(
      {
        error: blocked,
        code: "UPSTREAM_BLOCKED",
        hint: "This server will not probe private or loopback addresses. Diagnose a local gateway from a local install.",
      },
      { status: 403 },
    );
  }

  const { ids, diagnostics } = await fetchGatewayModels(creds);

  const catalog = ids.map(toCatalogEntry);
  const combos = catalog.filter((c) => c.isCombo);
  const concrete = catalog.filter((c) => !c.isCombo);

  const byLine: Record<string, string[]> = {};
  for (const c of concrete) {
    (byLine[c.line] ||= []).push(c.id);
  }
  const linesWithSiblings = Object.fromEntries(
    Object.entries(byLine).filter(([, list]) => list.length > 1),
  );

  const modelsResponse = raw ? await dumpModelsResponse(base, apiKey) : null;

  const apiTargets = Array.from(
    new Set(CANDIDATE_PATHS.map((p) => `${origin}${p}`)),
  );
  const pageTargets = Array.from(
    new Set(CANDIDATE_PAGES.map((p) => `${origin}${p}`)),
  );

  const [apiProbes, pageProbes] = await Promise.all([
    Promise.all(apiTargets.map((t) => probe(t, apiKey))),
    Promise.all(pageTargets.map((t) => probe(t, apiKey, 160))),
  ]);

  const reachable = apiProbes.filter(
    (p) => typeof p.status === "number" && p.status < 400,
  );
  const interesting = apiProbes.filter((p) => p.looksInteresting);
  const pagesPresent = pageProbes
    .filter((p) => typeof p.status === "number" && p.status < 400)
    .map((p) => ({ url: p.url, status: p.status, bytes: p.bytes }));

  let chatProbe: {
    model: string | undefined;
    status: number | "error";
    headers: Record<string, string>;
    accountishHeaders: Record<string, string>;
    bodyPreview: string;
  } | null = null;

  if (probeChat) {
    const model = modelParam || concrete[0]?.id || combos[0]?.id;
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
        redirect: "manual",
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const accountish = Object.fromEntries(
        Object.entries(headers).filter(([k]) =>
          /account|upstream|provider|key|model|quota|credit|remaining|limit/i.test(
            k,
          ),
        ),
      );
      const body = await res.text().catch(() => "");
      chatProbe = {
        model,
        status: res.status,
        headers: redactHeaders(headers),
        accountishHeaders: redactHeaders(accountish),
        bodyPreview: redact(body).slice(0, 800),
      };
    } catch (err) {
      chatProbe = {
        model,
        status: "error",
        headers: {},
        accountishHeaders: {},
        bodyPreview: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const ladder = modelParam
    ? buildFailoverLadder(modelParam, ids).map((c) => ({
        step: c.step,
        id: c.id,
        kind: c.kind,
        attempt: `${c.attempt}/${c.attemptsForId}`,
        omnirouteMayChangeModel: c.yieldsControl,
      }))
    : null;

  const verdict: string[] = [];
  if (!diagnostics.apiKeyConfigured) {
    verdict.push(
      "No gateway API key is configured for this account — requests would carry a placeholder key.",
    );
  }
  if (diagnostics.status === null) {
    verdict.push(
      `The gateway did not respond at ${base}. Confirm OmniRoute is running.`,
    );
  } else if (!diagnostics.ok) {
    verdict.push(
      `${diagnostics.url} returned ${diagnostics.status}. Check API key and base URL.`,
    );
  } else if (diagnostics.rawCount === 0) {
    verdict.push("The gateway replied 200 but no ids could be parsed.");
  } else {
    verdict.push(
      `Gateway reported ${diagnostics.rawCount} model(s). Filtered down to ${catalog.length} model(s) matching allowed providers [${ALLOWED_PROVIDERS.join(", ")}].`,
    );
  }

  return NextResponse.json(
    {
      gateway: {
        base,
        origin,
        apiKeyConfigured: diagnostics.apiKeyConfigured,
        credentialSource: creds.source,
      },
      verdict,
      catalog: {
        error: diagnostics.error,
        allowedProviders: ALLOWED_PROVIDERS,
        total: catalog.length,
        concreteCount: concrete.length,
        comboCount: combos.length,
        comboIds: combos.map((c) => c.id),
        concreteIds: concrete.map((c) => c.id),
        linesWithSiblings,
        extraFromEnv: EXTRA_MODELS,
      },
      modelsDiagnostics: diagnostics,
      modelsResponse,
      discovery: {
        probed: apiTargets.length + pageTargets.length,
        reachable: reachable.map((p) => ({
          url: p.url,
          status: p.status,
          bytes: p.bytes,
          isJson: p.isJson,
        })),
        interesting,
        pagesPresent,
      },
      chatProbe,
      ladderFor: modelParam,
      ladder,
    },
    { status: 200 },
  );
}
