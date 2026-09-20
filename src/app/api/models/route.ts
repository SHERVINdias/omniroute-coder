/**
 * GET /api/models
 * ---------------------------------------------------------------------------
 * The model picker's catalogue, for the signed-in user's active provider.
 *
 * WHAT CHANGED
 *
 * This route was unauthenticated and read the process-wide provider list, so it
 * described whatever gateway was globally active — and `?provider=` let any
 * caller name any provider id in the system. It now requires a session and
 * resolves models through the caller's own credentials, so the picker shows the
 * models that account can actually reach.
 *
 * It also used to require every id to contain a `/`, which silently deleted the
 * catalogue of every provider that is not the OmniRoute gateway: `gpt-4o` and
 * `llama3.2` have no prefix to match. The prefix rule now applies only to the
 * gateway, whose ladder actually depends on it.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  toCatalogEntry,
  fetchGatewayModels,
} from "@/lib/omniroute";
import { requireUser } from "@/lib/authGuard";
import { getProviderById, getActiveProviderFor } from "@/lib/credentialManager";
import {
  credsForProvider,
  resolveGatewayCreds,
  type GatewayCreds,
} from "@/lib/gatewayCreds";
import {
  getProviderProfile,
  type ProviderKind,
  type ProviderProfile,
} from "@/lib/providerProfiles";
import { rateLimit, formatRetryAfter } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * There is no catalogue cache: every call here opens a connection to the
 * caller's provider. That is deliberate — a shared cache is what made the old
 * module-level provider cache serve one account's gateway to another — but it
 * does mean a signed-in caller can put the operator's gateway under load by
 * refreshing. 30/minute is far above what the picker needs (it loads on open
 * and on provider change) and far below what a script would want.
 *
 * Keyed on the user id, which cannot be changed without another valid session.
 */
const CATALOG_LIMIT = { limit: 30, windowMs: 60_000 } as const;

/** What to tell the user when a provider returned nothing usable. */
function emptyCatalogHint(profile: ProviderProfile): string {
  if (profile.kind === "local") {
    return `No models came back from ${profile.label}. Check the server is running and that you have pulled a model — for Ollama that is \`ollama pull llama3.2\`.`;
  }
  if (!profile.supportsModelList) {
    return `${profile.label} does not publish a model list. Type the model name into the "Model IDs" field in Settings.`;
  }
  if (profile.kind === "gateway") {
    return "The gateway returned no usable models. Check that the base URL and API key in Settings are right and that the gateway is running.";
  }
  return `${profile.label} returned no usable models. Check the base URL and API key in Settings — ${profile.baseUrlPlaceholder} is the expected shape.`;
}

/**
 * Which ids belong in the picker.
 *
 * For the OmniRoute gateway, a `provider/model` prefix is required: the
 * failover ladder is built by rotating that prefix across accounts, so a bare
 * name cannot be routed and would fail the moment it was chosen.
 *
 * For every other provider the opposite is true. `gpt-4o`, `llama3.2` and
 * `gemini-2.0-flash` are the real, complete model names — requiring a slash
 * dropped the entire catalogue of every third-party and local provider, which
 * is why external models never appeared in the picker.
 */
function isAllowedModel(id: string, kind: ProviderKind): boolean {
  const lower = id.toLowerCase().trim();
  if (!lower) return false;

  if (lower === "free stack") return true;

  if (kind === "gateway") return lower.includes("/");

  /* External and local providers: keep everything the provider reported.
   * Namespaced ids (meta-llama/Llama-3.3) are kept intact rather than being
   * read as a gateway account prefix. */
  return true;
}

export async function GET(request: NextRequest) {
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;
  const { user } = guard;

  const gate = rateLimit(`models:${user.id}`, CATALOG_LIMIT);
  if (!gate.ok) {
    return NextResponse.json(
      {
        error: `Too many model-list refreshes. Try again in ${formatRetryAfter(
          gate.retryAfterMs,
        )}.`,
        models: ["Free Stack"],
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  const { searchParams } = new URL(request.url);
  const providerId = searchParams.get("provider");

  try {
    let creds: GatewayCreds;

    if (providerId) {
      /* Scoped to this user: a provider id belonging to someone else resolves
       * to null here rather than quietly selecting their gateway. */
      const provider = getProviderById(user.id, providerId);
      if (!provider) {
        return NextResponse.json(
          {
            error: "That provider does not exist on your account.",
            models: ["Free Stack"],
            catalog: [],
            counts: null,
            diagnostics: null,
            hint: "Pick a provider you have added in Settings.",
          },
          { status: 404 },
        );
      }
      /* credsForProvider carries the provider type and treats a keyless local
       * server as configured, which a hand-built object here did not. */
      const resolved = credsForProvider(user.id, providerId);
      if (!resolved) {
        return NextResponse.json({
          models: ["Free Stack"],
          catalog: [],
          diagnostics: null,
          counts: { total: 0, concrete: 0, combos: 0, fromGateway: 0 },
          hint: "That provider has no API key saved. Re-enter it in Settings.",
          providerId,
        });
      }
      creds = resolved;
    } else {
      creds = resolveGatewayCreds(user.id);
    }

    const profile = getProviderProfile(creds.provider);

    if (!creds.configured) {
      const hasAny = getActiveProviderFor(user.id) !== null;
      return NextResponse.json({
        models: ["Free Stack"],
        catalog: [],
        diagnostics: null,
        counts: { total: 0, concrete: 0, combos: 0, fromGateway: 0 },
        hint: hasAny
          ? "The active provider has no API key saved. Re-enter it in Settings."
          : "No provider is connected yet. Add one in Settings — a hosted API key, or a local server like Ollama — to load models.",
        providerId: providerId || null,
      });
    }

    // HARDCODED: APInex free models only (skip API call to avoid paid models)
    if (creds.provider === "apinex" || profile.id === "apinex") {
      console.log("[Models API] APInex detected - returning hardcoded free models only");
      const freeApinexModels = [
        "free/gemini-3.8-flash",
        "free/muse-spark-1.3",
        "free/glm-5.3-flash",
        "free/gemini-3.1-pro",
        "free/deepseek-v4-flash",
        "free/deepseek-v4-pro-0",
        "free/gpt-5.6-luna",
        "free/qwen-3.8-max",
        "free/deepseek-v4.1-fla",
        "free/mimo-v2.5",
        "free/kimi-k3",
        "free/nano-banana-2",
      ];
      
      const catalog = freeApinexModels.map(toCatalogEntry);
      const cleanModels = ["Free Stack", ...freeApinexModels];
      
      return NextResponse.json({
        models: cleanModels,
        catalog,
        diagnostics: { message: "Showing only free APInex models (hardcoded)" },
        counts: {
          total: catalog.length,
          concrete: catalog.length,
          combos: 0,
          fromGateway: 0,
        },
        hint: null,
        providerId: providerId || null,
      });
    }

    const { ids, diagnostics } = await fetchGatewayModels(creds);

    const filtered = ids.filter((id) => isAllowedModel(id, profile.kind));

    const catalog = filtered.map(toCatalogEntry);
    const concrete = catalog.filter((c) => !c.isCombo);
    const combos = catalog.filter((c) => c.isCombo);

    const cleanModels = Array.from(new Set(["Free Stack", ...filtered]));

    return NextResponse.json({
      models: cleanModels,
      catalog,
      diagnostics,
      counts: {
        total: catalog.length,
        concrete: concrete.length,
        combos: combos.length,
        fromGateway: ids.length,
      },
      /* `diagnostics.error` wins when there is one.
       *
       * It carries the specific reason the fetch did not happen — most usefully
       * the SSRF guard's explanation that a deployed server cannot reach a
       * localhost gateway. `emptyCatalogHint` can only guess from the profile,
       * so it would answer "check the gateway is running" to someone whose
       * gateway is running perfectly well on a machine this server will never be
       * able to see. That mismatch is what produced a bare "Could not load model
       * list" with no way forward. */
      hint:
        concrete.length === 0
          ? (diagnostics.error ?? emptyCatalogHint(profile))
          : null,
      providerId: providerId || null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Models API] Error fetching models:", message);
    return NextResponse.json(
      {
        error: message,
        models: ["Free Stack"],
        catalog: [],
        counts: null,
        diagnostics: null,
        hint: message,
      },
      { status: 500 },
    );
  }
}
