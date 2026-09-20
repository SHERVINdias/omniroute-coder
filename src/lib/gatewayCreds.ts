/**
 * src/lib/gatewayCreds.ts
 * ---------------------------------------------------------------------------
 * Resolves which gateway a given request should talk to.
 *
 * THE PROBLEM THIS SOLVES
 *
 * `OMNIROUTE_BASE_URL()` and `OMNIROUTE_API_KEY()` used to read a process-wide
 * cache of "the active provider" — one global value for the whole server. On
 * localhost, with exactly one person using the app, that was invisible. Deployed,
 * it means every account shares one gateway key: one person's quota drains
 * everyone's, and whoever saves a provider last silently redirects everyone
 * else's traffic to their own endpoint.
 *
 * Credentials are now looked up per request, from the signed-in user's own row.
 *
 * THE SHARED FALLBACK
 *
 * When a user has configured nothing, there is still an env-level
 * OMNIROUTE_BASE_URL / OMNIROUTE_API_KEY. Using it is right on localhost — it is
 * how your own setup works today, and requiring you to re-enter credentials in a
 * UI to use your own machine would be silly. Using it in production is wrong:
 * it hands the operator's key to every stranger who signs up.
 *
 * So the shared fallback is allowed in development and refused in production,
 * unless OMNIROUTE_ALLOW_SHARED_GATEWAY says otherwise. Same three-state
 * env-with-a-sensible-default pattern as the file-tools gate in the chat route.
 */

import {
  getActiveProviderSync,
  getProviderById,
  type ProviderConfig,
} from "./credentialManager";
import {
  getProviderProfile,
  isLocalBaseUrl,
  type ProviderProfile,
} from "./providerProfiles";

export interface GatewayCreds {
  baseUrl: string;
  apiKey: string;
  /** Where these came from — used for diagnostics, never shown a raw key. */
  source: "user" | "shared" | "none";
  /** False when nothing usable was found and requests will fail. */
  configured: boolean;
  /**
   * Which provider profile these credentials belong to (the `provider` column
   * on user_providers). Drives the auth header, the endpoint path and whether
   * an empty API key is acceptable.
   *
   * Defaults to "omniroute" so any caller that constructs GatewayCreds by hand
   * keeps the original localhost-gateway behaviour.
   */
  provider: string;
  /**
   * Model ids the user typed by hand for this provider.
   *
   * Needed for providers with no catalogue endpoint — Azure names its model in
   * the deployment URL and has nothing to list — so without this the model
   * picker would be permanently empty for them.
   */
  modelIds?: string[];
}

const DEFAULT_BASE_URL = "http://localhost:20128/v1";

/** A key value that means "nothing real was configured". */
export const PLACEHOLDER_KEY = "dummy-key";

/** The profile for a set of creds. Central so callers never re-derive it. */
export function profileForCreds(creds: GatewayCreds): ProviderProfile {
  return getProviderProfile(creds.provider);
}

/**
 * True when these creds carry a real, usable key.
 *
 * Distinct from `configured`: a local Ollama server is `configured` with no key
 * at all, so "configured" cannot be inferred from the key alone.
 */
export function hasRealKey(creds: GatewayCreds): boolean {
  const key = (creds.apiKey || "").trim();
  return Boolean(key) && key !== PLACEHOLDER_KEY;
}

function env(name: string): string {
  const raw = process.env[name];
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * May a user with no provider of their own borrow the server's env credentials?
 *
 * Defaults to true in development and false in production, because the whole
 * point of per-user credentials is that a deployed stranger cannot spend the
 * operator's quota.
 */
export function sharedGatewayAllowed(): boolean {
  const raw = env("OMNIROUTE_ALLOW_SHARED_GATEWAY").toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return process.env.NODE_ENV !== "production";
}

/**
 * May a caller with NO SESSION AT ALL spend the shared credentials?
 *
 * This looks redundant next to `sharedGatewayAllowed()` and is not. That one
 * answers "does this server have a fallback key for users who haven't set one
 * up"; this one answers "does a stranger count as such a user". They were the
 * same question only because the first defaulted off in production, which made
 * the second moot — so an operator turning on the documented shared-gateway
 * feature was silently also opening the key to the whole internet.
 *
 * What that costs, concretely: `POST /api/chat` accepts an anonymous caller at
 * 10 req/min per source address, charges no quota (the Deep Cowork quota check
 * only runs for that mode) and writes no history (`beginTurn` is skipped when
 * there is no user), so the spend is both uncapped in aggregate and invisible
 * afterwards.
 *
 * Default: same as the rest of the app — permissive in development, closed in
 * production. So a local install keeps working signed-out exactly as before,
 * and a deployment has to say `OMNIROUTE_ALLOW_ANONYMOUS_CHAT=true` out loud
 * before it will serve a public demo.
 */
export function anonymousSharedGatewayAllowed(): boolean {
  const raw = env("OMNIROUTE_ALLOW_ANONYMOUS_CHAT").toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return process.env.NODE_ENV !== "production";
}

function normaliseBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Work out the gateway for one caller.
 *
 * `userId` may be null for unauthenticated paths; those only ever get the shared
 * fallback, and only where that is permitted.
 *
 * Never throws. A caller with nothing configured receives `configured: false`
 * and a placeholder key, so the calling route can produce a clear "set up your
 * gateway" message instead of a stack trace.
 */
export function resolveGatewayCreds(userId?: string | null): GatewayCreds {
  if (userId) {
    try {
      const provider = getActiveProviderSync(userId);
      if (provider?.baseUrl) {
        const profile = getProviderProfile(provider.provider);
        /* A key is required for hosted providers but meaningless for a local
         * server: Ollama, LM Studio and llama.cpp accept anonymous requests.
         * Requiring one here is what previously made local models
         * unconfigurable. */
        const keyOptional =
          profile.keyOptional || isLocalBaseUrl(provider.baseUrl);
        if (provider.apiKey || keyOptional) {
          return {
            baseUrl: normaliseBase(provider.baseUrl),
            apiKey: provider.apiKey || "",
            source: "user",
            configured: true,
            provider: profile.id,
            modelIds: provider.modelIds,
          };
        }
      }
    } catch {
      /* A database hiccup must not take out the request; fall through to the
       * shared credentials and let the normal "not configured" path handle it. */
    }
  }

  if (sharedGatewayAllowed()) {
    const baseUrl = normaliseBase(env("OMNIROUTE_BASE_URL") || DEFAULT_BASE_URL);
    const apiKey = env("OMNIROUTE_API_KEY");
    const provider = env("OMNIROUTE_PROVIDER") || "omniroute";
    const profile = getProviderProfile(provider);
    /* The env fallback points at the local gateway by default, which needs no
     * key, so treat a keyless local base URL as configured here too. */
    const keyOptional = profile.keyOptional || isLocalBaseUrl(baseUrl);
    return {
      baseUrl,
      apiKey: apiKey || (keyOptional ? "" : PLACEHOLDER_KEY),
      source: "shared",
      configured: Boolean(apiKey) || keyOptional,
      provider: profile.id,
    };
  }

  return {
    baseUrl: normaliseBase(env("OMNIROUTE_BASE_URL") || DEFAULT_BASE_URL),
    apiKey: PLACEHOLDER_KEY,
    source: "none",
    configured: false,
    provider: "omniroute",
  };
}

/**
 * Credentials for one specific saved provider rather than the active one.
 *
 * The models route needs this: it lists models per configured provider, not
 * only for whichever one happens to be active.
 */
export function credsForProvider(
  userId: string,
  providerId: string,
): GatewayCreds | null {
  let row: ProviderConfig | null;
  try {
    row = getProviderById(userId, providerId);
  } catch {
    return null;
  }
  if (!row?.baseUrl) return null;

  const profile = getProviderProfile(row.provider);
  const keyOptional = profile.keyOptional || isLocalBaseUrl(row.baseUrl);
  if (!row.apiKey && !keyOptional) return null;

  return {
    baseUrl: normaliseBase(row.baseUrl),
    apiKey: row.apiKey || "",
    source: "user",
    configured: true,
    provider: profile.id,
    modelIds: row.modelIds,
  };
}

/**
 * The message shown when `configured` is false.
 *
 * Deliberately different per cause: "you have not added a gateway" and "this
 * server has no gateway configured" need different actions from the reader.
 */
export function describeMissingGateway(creds: GatewayCreds): string {
  if (creds.source === "none") {
    return "No AI gateway is connected to your account yet. Open Settings and add your OmniRoute base URL and API key to start chatting.";
  }
  return "This server has no gateway API key configured. Add one in Settings, or set OMNIROUTE_API_KEY on the server.";
}
