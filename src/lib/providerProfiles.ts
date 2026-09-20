/**
 * Provider Profiles
 *
 * One place that knows how each upstream provider wants to be talked to:
 * which auth header it expects, what path its OpenAI-compatible surface lives
 * under, and whether it needs a key at all.
 *
 * Why this exists: the app used to assume every upstream was the local
 * OmniRoute gateway — `Authorization: Bearer <key>` at `<baseUrl>/chat/completions`.
 * That assumption breaks in four specific ways once you point it at the open
 * internet, and each of those is encoded here:
 *
 *   1. Auth header is not always Bearer. Azure wants `api-key`. Anthropic's
 *      native API wants `x-api-key`. Local servers want no header at all.
 *   2. The OpenAI-compatible path is not always `/v1`. Google puts it at
 *      `/v1beta/openai`. Ollama puts it at `/v1` in front of its native API.
 *   3. Some providers are not reachable at `<base>/models` and must not be
 *      probed for a catalogue.
 *   4. Local providers need no key, which the credential layer previously
 *      treated as "not configured".
 *
 * IMPORTANT: this module must stay dependency-free (no node builtins, no db,
 * no server-only imports). SettingsPanel is a client component and imports the
 * presets from here, so anything server-only would break the client bundle.
 */

export type ProviderKind = "gateway" | "external" | "local";

export type AuthScheme =
  | "bearer" // Authorization: Bearer <key>   — OpenAI, Groq, OpenRouter, Google's compat layer
  | "x-api-key" // x-api-key: <key>             — Anthropic
  | "azure-api-key" // api-key: <key>             — Azure OpenAI
  | "none"; // no auth header at all        — Ollama, LM Studio, llama.cpp, vLLM

export type ApiFlavor =
  | "openai" // Standard OpenAI /v1/chat/completions format
  | "anthropic-messages"; // Anthropic Messages API format (different endpoint & body shape)

export interface ProviderProfile {
  /** Stable id, stored in the `user_providers.provider` column. */
  id: string;
  /** Human label for the settings dropdown and notices. */
  label: string;
  kind: ProviderKind;
  authScheme: AuthScheme;
  /**
   * Appended to the base URL when — and only when — the user supplied a bare
   * origin with no path of its own (e.g. `https://api.groq.com`).
   * If the user typed any path, we trust them and append nothing.
   */
  pathSuffix: string;
  /** True when the provider works with no API key (self-hosted servers). */
  keyOptional: boolean;
  /** False for providers whose API is not OpenAI-shaped; we warn instead of silently failing. */
  openAiCompatible: boolean;
  /** False when `<base>/models` is not a valid endpoint for this provider. */
  supportsModelList: boolean;
  /** Headers some providers need beyond auth (WAF bypass, required version pins). */
  extraHeaders?: Record<string, string>;
  /** Placeholder shown in the Base URL field. */
  baseUrlPlaceholder: string;
  /** Optional hint about what to put in the model field. */
  modelHint?: string;
  /** Shown in the settings panel to steer the user toward the right URL. */
  notes?: string;
  /** Which API protocol the provider expects: OpenAI or Anthropic Messages. */
  apiFlavor?: ApiFlavor;
}

/**
 * The registry. Order matters only for display; lookup is by id.
 */
export const PROVIDER_PROFILES: ProviderProfile[] = [
  {
    id: "omniroute",
    label: "OmniRoute (local gateway)",
    kind: "gateway",
    authScheme: "bearer",
    pathSuffix: "",
    keyOptional: true,
    openAiCompatible: true,
    supportsModelList: true,
    baseUrlPlaceholder: "http://localhost:20128/v1",
    notes:
      "The self-hosted gateway. Include /v1 in the URL. It will serve combos as well as concrete models.",
  },
  {
    id: "agentrouter",
    label: "Agent Router",
    kind: "external",
    authScheme: "x-api-key",
    pathSuffix: "",
    keyOptional: false,
    openAiCompatible: false,
    supportsModelList: false,
    apiFlavor: "anthropic-messages",
    baseUrlPlaceholder: "https://agentrouter.org",
    modelHint: "claude-opus-4-8",
    notes: "Uses Anthropic Messages API format. Manual model entry required: claude-opus-4-6, claude-opus-4-7, claude-opus-4-8, gpt-5.5, glm-5.2.",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "external",
    authScheme: "bearer",
    pathSuffix: "/v1",
    keyOptional: false,
    openAiCompatible: true,
    supportsModelList: true,
    baseUrlPlaceholder: "https://api.openai.com/v1",
    modelHint: "gpt-4o",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "external",
    authScheme: "bearer",
    pathSuffix: "/api/v1",
    keyOptional: false,
    openAiCompatible: true,
    supportsModelList: true,
    extraHeaders: { "HTTP-Referer": "https://localhost:3000", "X-Title": "Omni-Claude" },
    baseUrlPlaceholder: "https://openrouter.ai/api/v1",
    modelHint: "anthropic/claude-3.5-sonnet",
    notes: "Model ids are namespaced with a slash, e.g. meta-llama/llama-3.3-70b-instruct.",
  },
  {
    id: "groq",
    label: "Groq",
    kind: "external",
    authScheme: "bearer",
    pathSuffix: "/openai/v1",
    keyOptional: false,
    openAiCompatible: true,
    supportsModelList: true,
    baseUrlPlaceholder: "https://api.groq.com/openai/v1",
    modelHint: "llama-3.3-70b-versatile",
    notes: "Note the /openai/v1 path — a bare api.groq.com will not work.",
  },
  {
    id: "google",
    label: "Google (Gemini)",
    kind: "external",
    authScheme: "bearer",
    pathSuffix: "/v1beta/openai",
    keyOptional: false,
    openAiCompatible: true,
    supportsModelList: true,
    baseUrlPlaceholder: "https://generativelanguage.googleapis.com/v1beta/openai",
    modelHint: "gemini-2.0-flash",
    notes:
      "Uses Google's OpenAI-compatibility layer, which accepts a normal Bearer key. The native Google API is a different shape and is not used here.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "external",
    authScheme: "bearer",
    pathSuffix: "/v1",
    keyOptional: false,
    openAiCompatible: true,
    supportsModelList: true,
    baseUrlPlaceholder: "https://api.deepseek.com/v1",
    modelHint: "deepseek-chat",
  },
  {
    id: "azure",
    label: "Azure OpenAI",
    kind: "external",
    authScheme: "azure-api-key",
    pathSuffix: "",
    keyOptional: false,
    openAiCompatible: true,
    supportsModelList: false,
    baseUrlPlaceholder:
      "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT?api-version=2024-10-21",
    modelHint: "your-deployment-name",
    notes:
      "Paste the full deployment URL including ?api-version=... . Azure sends the key in an `api-key` header rather than Authorization, and has no model-list endpoint, so type the model name yourself.",
  },
  {
    id: "anthropic",
    label: "Anthropic (via proxy only)",
    kind: "external",
    authScheme: "x-api-key",
    pathSuffix: "/v1",
    keyOptional: false,
    openAiCompatible: false,
    supportsModelList: false,
    baseUrlPlaceholder: "http://localhost:8080/v1",
    modelHint: "claude-sonnet-4-5",
    notes:
      "Anthropic's native API is NOT OpenAI-compatible — it has no /chat/completions and uses a different body shape. Point this at an OpenAI-compatible proxy (LiteLLM, claude-code-router, etc.) rather than at api.anthropic.com. Against the native API this app will produce empty replies.",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    kind: "local",
    authScheme: "none",
    pathSuffix: "/v1",
    keyOptional: true,
    openAiCompatible: true,
    supportsModelList: true,
    baseUrlPlaceholder: "http://localhost:11434/v1",
    modelHint: "llama3.2",
    notes:
      "Runs on your machine and needs no API key. Ollama's OpenAI-compatible surface lives under /v1; its native /api/chat is a different shape and is not used here.",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    kind: "local",
    authScheme: "none",
    pathSuffix: "/v1",
    keyOptional: true,
    openAiCompatible: true,
    supportsModelList: true,
    baseUrlPlaceholder: "http://localhost:1234/v1",
    modelHint: "local-model",
    notes: "Start the LM Studio local server first; no key required.",
  },
  {
    id: "llamacpp",
    label: "llama.cpp (local)",
    kind: "local",
    authScheme: "none",
    pathSuffix: "/v1",
    keyOptional: true,
    openAiCompatible: true,
    supportsModelList: true,
    baseUrlPlaceholder: "http://localhost:8080/v1",
    modelHint: "local-model",
    notes: "`llama-server` exposes an OpenAI-compatible endpoint on port 8080 by default.",
  },
  {
    id: "vllm",
    label: "vLLM (local or LAN)",
    kind: "local",
    authScheme: "none",
    pathSuffix: "/v1",
    keyOptional: true,
    openAiCompatible: true,
    supportsModelList: true,
    baseUrlPlaceholder: "http://localhost:8000/v1",
    modelHint: "your-served-model",
    notes: "If you started vLLM with --api-key, put that key in the API key field.",
  },
  {
    id: "apinex",
    label: "APInex",
    kind: "external",
    authScheme: "bearer",
    pathSuffix: "/v1",
    keyOptional: false,
    openAiCompatible: true,
    supportsModelList: true,
    baseUrlPlaceholder: "https://api.apinex.bond/v1",
    modelHint: "free/gemini-3.8-flash",
    notes: "Free tier models are prefixed with 'free/', e.g. free/gemini-3.8-flash, free/glm-5.3-flash, free/deepseek-v4-flash.",
  },
  {
    id: "custom",
    label: "Custom (any OpenAI-compatible URL)",
    kind: "external",
    authScheme: "bearer",
    pathSuffix: "",
    keyOptional: true,
    openAiCompatible: true,
    supportsModelList: true,
    baseUrlPlaceholder: "https://api.provider.com/v1",
    notes:
      "Anything that speaks the OpenAI chat-completions protocol. Include the full path in the URL; it is used exactly as typed.",
  },
];

const PROFILE_BY_ID: Record<string, ProviderProfile> = PROVIDER_PROFILES.reduce(
  (acc, profile) => {
    acc[profile.id] = profile;
    return acc;
  },
  {} as Record<string, ProviderProfile>,
);

const CUSTOM_PROFILE = PROFILE_BY_ID["custom"];

/** Look up a profile, falling back to `custom` for ids we do not recognise. */
export function getProviderProfile(id?: string | null): ProviderProfile {
  if (!id) return PROFILE_BY_ID["omniroute"];
  return PROFILE_BY_ID[id.trim().toLowerCase()] ?? CUSTOM_PROFILE;
}

/** True when a profile id is one we ship a preset for. */
export function isKnownProvider(id?: string | null): boolean {
  if (!id) return false;
  return Object.prototype.hasOwnProperty.call(PROFILE_BY_ID, id.trim().toLowerCase());
}

export function isLocalProvider(id?: string | null): boolean {
  return getProviderProfile(id).kind === "local";
}

export function isExternalProvider(id?: string | null): boolean {
  return getProviderProfile(id).kind === "external";
}

export function isGatewayProvider(id?: string | null): boolean {
  return getProviderProfile(id).kind === "gateway";
}

/**
 * Heuristic: does this base URL point at the user's own machine or LAN rather
 * than the public internet? Used to decide whether the SSRF guard should apply
 * and whether a missing key is acceptable.
 *
 * This is a *classification* helper only — it is not a security boundary. The
 * real boundary is `isPubliclyRoutable()` in ssrfGuard.ts, which resolves DNS
 * and inspects the actual IP.
 */
export function isLocalBaseUrl(baseUrl?: string | null): boolean {
  if (!baseUrl) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "::1" || host === "[::1]") return true;
  if (host === "host.docker.internal" || host === "gateway.docker.internal") return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true;

  // Bare hostname with no dot — e.g. http://myserver:8080. Not resolvable on
  // the public internet, so treat it as LAN.
  if (!host.includes(".") && !host.includes(":")) return true;

  // Private IPv4 ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
  }

  return false;
}

/** Trim whitespace and trailing slashes, leaving any query string intact. */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = (baseUrl || "").trim();
  if (!trimmed) return "";
  const [path, query] = trimmed.split("?");
  const stripped = path.replace(/\/+$/, "");
  return query ? `${stripped}?${query}` : stripped;
}

/**
 * Build the final request URL for an upstream call.
 *
 * Rules, in order:
 *   1. A query string on the base URL is preserved and re-attached at the end
 *      (Azure needs `?api-version=...` after the path, not before it).
 *   2. If the base URL is a bare origin, the profile's pathSuffix is appended.
 *      If the user typed any path, we use exactly what they typed.
 *   3. If the base URL already ends in the endpoint we are about to add, we do
 *      not add it twice — some users paste the full completions URL.
 */
export function resolveEndpoint(
  profile: ProviderProfile,
  baseUrl: string,
  endpointPath: string,
): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return "";

  const [rawPath, query] = normalized.split("?");

  // Users sometimes paste the full completions URL as their base. Strip any
  // endpoint we recognise so appending a different one still lands correctly.
  const path = rawPath.replace(/\/(chat\/completions|completions|models)$/i, "");

  // Does the URL carry a path of its own beyond the origin?
  let hasPath: boolean;
  try {
    // pathname is "/" for a bare origin, "/v1" or deeper when the user typed a path.
    hasPath = new URL(path).pathname.replace(/\/+$/, "").length > 0;
  } catch {
    // Not a parseable absolute URL (e.g. "localhost:11434"). Strip any scheme,
    // then a path exists if there is a slash after the host.
    hasPath = path.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").includes("/");
  }

  let resolved = path;
  if (!hasPath && profile.pathSuffix) {
    resolved = `${path}${profile.pathSuffix}`;
  }

  const cleanEndpoint = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
  if (!resolved.endsWith(cleanEndpoint)) {
    resolved = `${resolved}${cleanEndpoint}`;
  }

  return query ? `${resolved}?${query}` : resolved;
}

/** The chat-completions URL for a provider. */
export function resolveChatEndpoint(profile: ProviderProfile, baseUrl: string): string {
  return resolveEndpoint(profile, baseUrl, "/chat/completions");
}

/** The model-list URL for a provider, or "" when the provider has none. */
export function resolveModelsEndpoint(profile: ProviderProfile, baseUrl: string): string {
  if (!profile.supportsModelList) return "";
  return resolveEndpoint(profile, baseUrl, "/models");
}

/**
 * Auth headers for a provider. An empty key produces no auth header for
 * key-optional providers, so local servers are not sent a bogus Bearer token.
 */
export function buildAuthHeaders(
  profile: ProviderProfile,
  apiKey?: string | null,
): Record<string, string> {
  const key = (apiKey || "").trim();

  if (!key) {
    // No key at all. Fine for local servers; for keyed providers the request
    // will 401 upstream and the failure classifier reports it.
    return {};
  }

  switch (profile.authScheme) {
    case "none":
      // Local server with a key configured anyway (e.g. vLLM --api-key).
      // Ollama and friends ignore unknown headers; vLLM reads Bearer.
      return { Authorization: `Bearer ${key}` };
    case "x-api-key":
      return { "x-api-key": key };
    case "azure-api-key":
      return { "api-key": key };
    case "bearer":
    default:
      return { Authorization: `Bearer ${key}` };
  }
}

/** Full header set for an upstream call: content type + auth + provider extras. */
export function buildUpstreamHeaders(
  profile: ProviderProfile,
  apiKey?: string | null,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...buildAuthHeaders(profile, apiKey),
    ...(profile.extraHeaders ?? {}),
    ...(extra ?? {}),
  };
}

/** Header set for a GET (model listing) — same as above without a JSON body type. */
export function buildUpstreamGetHeaders(
  profile: ProviderProfile,
  apiKey?: string | null,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Accept: "application/json",
    ...buildAuthHeaders(profile, apiKey),
    ...(profile.extraHeaders ?? {}),
    ...(extra ?? {}),
  };
}

/**
 * Providers whose API is not OpenAI-shaped will not work through this app no
 * matter how they are configured. Surface that at save time and at request time
 * instead of letting the user discover it as an empty reply.
 */
export function incompatibleProviderWarning(profile: ProviderProfile): string | null {
  if (profile.openAiCompatible) return null;
  return (
    `${profile.label} does not expose an OpenAI-compatible /chat/completions endpoint, ` +
    `so this app cannot call it directly. Point the Base URL at an OpenAI-compatible proxy ` +
    `(LiteLLM, claude-code-router, one-api) instead.`
  );
}

/** Whether a provider can be saved with an empty API key. */
export function allowsEmptyApiKey(profile: ProviderProfile, baseUrl?: string): boolean {
  return profile.keyOptional || isLocalBaseUrl(baseUrl);
}
