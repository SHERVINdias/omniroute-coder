/**
 * src/lib/omniroute.ts
 * Shared helpers for talking to the OmniRoute gateway and any other
 * OpenAI-compatible provider the user configures.
 */

import { resolveGatewayCreds, type GatewayCreds } from "./gatewayCreds";
import {
  resolveModelsEndpoint,
  type ProviderKind,
} from "./providerProfiles";
import {
  getModelList,
  guardUpstreamUrl,
  targetFromCreds,
} from "./upstreamRequest";

export type { GatewayCreds };

/* The module-level provider cache that used to live here has been removed.
 *
 * It held "the active provider" for the whole process behind a 5-second TTL.
 * With one user on localhost that was a harmless optimisation; with two
 * accounts it is a credential leak — whoever's provider happened to populate
 * the cache served everyone else's requests for the next five seconds,
 * including the Authorization header sent upstream.
 *
 * Credentials are now passed in per call. better-sqlite3 reads are synchronous
 * and served from the OS page cache, so the lookup this replaces was never the
 * expensive part. */

export const OMNIROUTE_BASE_URL = (creds?: GatewayCreds): string =>
  (creds ?? resolveGatewayCreds(null)).baseUrl;

export const OMNIROUTE_API_KEY = (creds?: GatewayCreds): string =>
  (creds ?? resolveGatewayCreds(null)).apiKey;

/** The app's own pseudo-model. Treated as a combo: it is not a real upstream id. */
export const FREE_STACK = "Free Stack";

/**
 * Allowed provider prefixes for the UI model picker & routing.
 */
export const ALLOWED_PROVIDERS: string[] = (
  process.env.OMNIROUTE_ALLOWED_PROVIDERS || "kiro,antigravity,kr,agy,ag,agentrouter"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** Prefixes that mark an id as an OmniRoute combo. */
const COMBO_PREFIXES: string[] = (
  process.env.OMNIROUTE_COMBO_PREFIXES || "auto,combo,mix,pool,smart"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** How many times the SAME concrete model is retried for account rotation. */
export const ACCOUNT_RETRIES = Math.max(
  0,
  Number(process.env.OMNIROUTE_ACCOUNT_RETRIES ?? 2),
);

/** Optional preferred provider order for the provider-swap tier. */
const PROVIDER_PRIORITY: string[] = (
  process.env.OMNIROUTE_PROVIDER_PRIORITY || ""
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** Manually-added model ids, merged into whatever /v1/models returns. */
export const EXTRA_MODELS: string[] = (process.env.OMNIROUTE_EXTRA_MODELS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/* ------------------------------ provider filtering ----------------------- */

export function isAllowedProvider(rawId: string): boolean {
  if (!ALLOWED_PROVIDERS.length) return true;
  const p = parseModelId(rawId);
  if (p.model === FREE_STACK || p.id === FREE_STACK) return true;
  if (p.isCombo) return true;
  if (!p.provider) return true;
  return ALLOWED_PROVIDERS.includes(p.provider.toLowerCase());
}

/* ------------------------------ model id parsing -------------------------- */

export interface ParsedModel {
  id: string;
  provider: string;
  model: string;
  line: string;
  isCombo: boolean;
}

const VERSION_TOKEN =
  /^(v?\d+(?:\.\d+)*|\d+[a-z]?|latest|preview|exp|experimental|beta|stable|free|paid)$/i;

const MODIFIER_TOKEN =
  /^(thinking|nonthinking|nothinking|agentic|agent|reasoning|reason)$/i;

export function modelLine(model: string): string {
  const tokens = model.split("-").filter(Boolean);

  let end = tokens.length;
  while (end > 1 && MODIFIER_TOKEN.test(tokens[end - 1])) {
    end -= 1;
  }

  const kept = tokens.slice(0, end).filter((t) => !VERSION_TOKEN.test(t));
  const line = (kept.length > 0 ? kept : tokens.slice(0, end)).join("-");
  return (line || model).toLowerCase();
}

export function parseModelId(rawId: string): ParsedModel {
  const id = String(rawId ?? "").trim();

  if (!id || id.toLowerCase() === FREE_STACK.toLowerCase()) {
    return {
      id: id || FREE_STACK,
      provider: "",
      model: FREE_STACK,
      line: "free stack",
      isCombo: true,
    };
  }

  const slash = id.indexOf("/");
  const provider = slash === -1 ? "" : id.slice(0, slash).toLowerCase();
  const model = slash === -1 ? id : id.slice(slash + 1);

  return {
    id,
    provider,
    model,
    line: modelLine(model),
    isCombo: COMBO_PREFIXES.includes(provider),
  };
}

export function isComboId(rawId: string): boolean {
  return parseModelId(rawId).isCombo;
}

/* ------------------------------ display naming --------------------------- */

const UPPERCASE_WORDS = new Set([
  "gpt",
  "ai",
  "oss",
  "nim",
  "glm",
  "api",
  "hd",
  "xl",
]);

const CAPITALISED_MODEL_WORDS = new Set([
  "sonnet",
  "opus",
  "haiku",
  "pro",
  "lite",
  "flash",
  "mini",
  "nano",
  "max",
  "ultra",
  "turbo",
  "thinking",
  "instruct",
  "chat",
  "coder",
  "vision",
  "preview",
]);

export function prettyModelName(rawId: string): string {
  const p = parseModelId(rawId);
  if (p.model === FREE_STACK) return FREE_STACK;

  const tokens = p.model.split("-").filter(Boolean);

  let start = tokens.length;
  while (start > 1 && /^\d+$/.test(tokens[start - 1])) start -= 1;
  const head = tokens.slice(0, start);
  const version = tokens.slice(start).join(".");

  const words = head.map((word) => {
    const lower = word.toLowerCase();
    if (UPPERCASE_WORDS.has(lower)) return word.toUpperCase();
    if (CAPITALISED_MODEL_WORDS.has(lower))
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    if (/^\d+[a-z]$/i.test(word)) return word.toUpperCase();
    if (/^\d+(\.\d+)?$/.test(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  });

  return [...words, version].filter(Boolean).join(" ");
}

const PROVIDER_LABELS: Record<string, string> = {
  antigravity: "Antigravity",
  agy: "Antigravity",
  ag: "Antigravity",
  kiro: "Kiro AI",
  kr: "Kiro AI",
  auto: "OmniRoute combo",
  combo: "OmniRoute combo",
  mix: "OmniRoute combo",
  pool: "OmniRoute combo",
  smart: "OmniRoute combo",
};

export function providerLabel(rawId: string): string {
  const p = parseModelId(rawId);
  if (p.model === FREE_STACK) return "Free Stack";
  return PROVIDER_LABELS[p.provider] || (p.provider ? p.provider : "OmniRoute");
}

/* ------------------------------ the catalog ------------------------------ */

export interface CatalogEntry {
  id: string;
  provider: string;
  providerLabel: string;
  model: string;
  line: string;
  isCombo: boolean;
  label: string;
}

export function toCatalogEntry(rawId: string): CatalogEntry {
  const p = parseModelId(rawId);
  return {
    id: p.id,
    provider: p.provider,
    providerLabel: providerLabel(p.id),
    model: p.model,
    line: p.line,
    isCombo: p.isCombo,
    label: prettyModelName(p.id),
  };
}

/* --------------------------- gateway model listing ----------------------- */

export interface ModelsDiagnostics {
  baseUrl: string;
  url: string;
  ok: boolean;
  status: number | null;
  error: string | null;
  shape: string;
  rawCount: number;
  bodySample: string;
  extraFromEnv: string[];
  allowedProviders: string[];
  apiKeyConfigured: boolean;
}

export function redact(text: string): string {
  return text
    .replace(/\b(sk|omr|or)[-_][A-Za-z0-9_-]{8,}\b/gi, "$1-***")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "***");
}

function extractIds(payload: unknown): { ids: string[]; shape: string } {
  const fromArray = (arr: unknown[]): string[] =>
    arr
      .map((m) => {
        if (typeof m === "string") return m;
        if (m && typeof m === "object") {
          const o = m as Record<string, unknown>;
          for (const k of ["id", "model", "name", "slug"]) {
            if (typeof o[k] === "string" && o[k]) return o[k] as string;
          }
        }
        return "";
      })
      .filter(Boolean);

  if (Array.isArray(payload)) {
    const ids = fromArray(payload);
    if (ids.length) return { ids, shape: "top-level array" };
  }

  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;

    if (Array.isArray(o.data)) {
      const ids = fromArray(o.data);
      if (ids.length) return { ids, shape: "data[] (OpenAI standard)" };
    }
    if (Array.isArray(o.models)) {
      const ids = fromArray(o.models);
      if (ids.length) return { ids, shape: "models[]" };
    }
    if (o.data && typeof o.data === "object") {
      const d = o.data as Record<string, unknown>;
      if (Array.isArray(d.models)) {
        const ids = fromArray(d.models);
        if (ids.length) return { ids, shape: "data.models[]" };
      }
    }
    for (const [key, value] of Object.entries(o)) {
      if (Array.isArray(value)) {
        const ids = fromArray(value);
        if (ids.length) return { ids, shape: `${key}[] (inferred)` };
      }
    }
  }

  return { ids: [], shape: "none" };
}

export async function fetchGatewayModels(creds?: GatewayCreds): Promise<{
  ids: string[];
  diagnostics: ModelsDiagnostics;
}> {
  const resolved = creds ?? resolveGatewayCreds(null);
  const target = targetFromCreds(resolved);
  const profile = target.profile;

  /* Path and auth now come from the provider profile rather than from an
   * inline agentrouter check: Google needs /v1beta/openai, Groq needs
   * /openai/v1, Azure has no model list at all. */
  const url = resolveModelsEndpoint(profile, target.baseUrl);
  const baseUrl = target.baseUrl;

  const diagnostics: ModelsDiagnostics = {
    baseUrl,
    url,
    ok: false,
    status: null,
    error: null,
    shape: "none",
    rawCount: 0,
    bodySample: "",
    extraFromEnv: EXTRA_MODELS,
    allowedProviders: ALLOWED_PROVIDERS,
    apiKeyConfigured: resolved.configured,
  };

  let ids: string[] = [];

  if (!url) {
    /* Azure and other deployment-scoped providers have no catalogue endpoint.
     * That is not an error — the user names the deployment themselves. */
    diagnostics.error = `${profile.label} does not publish a model list; enter the model name manually in Settings.`;
    const manual = Array.from(
      new Set([...(resolved.modelIds ?? []), ...EXTRA_MODELS]),
    );
    return { ids: manual, diagnostics };
  }

  /* Refuse server-side fetches aimed at this server's own network.
   *
   * This used to say the check was "skipped for local and gateway providers,
   * which are legitimately on loopback". It no longer is, and that exemption was
   * the bug: `provider` is a free-form string chosen by whoever saves the
   * credential, so anyone could label a record "ollama" and point baseUrl at the
   * cloud metadata endpoint to opt out of the guard entirely. Loopback is now
   * allowed or refused by environment — see privateGatewayAllowed() — not by
   * what the record claims to be. On a laptop that still permits Ollama and a
   * local gateway; on a deployed server it does not, and `blocked` carries the
   * sentence explaining why so the UI can show it rather than "no models". */
  const blocked = await guardUpstreamUrl(baseUrl, profile);
  if (blocked) {
    diagnostics.error = blocked;
    return { ids: EXTRA_MODELS.slice(), diagnostics };
  }

  try {
    const res = await getModelList(target, { timeoutMs: 10000 });
    if (!res) {
      diagnostics.error = "This provider has no model list endpoint.";
      return { ids: EXTRA_MODELS.slice(), diagnostics };
    }
    diagnostics.status = res.status;
    diagnostics.ok = res.ok;

    const text = await res.text();
    diagnostics.bodySample = redact(text).slice(0, 500);

    if (res.status >= 300 && res.status < 400) {
      diagnostics.error = `GET ${url} was redirected (${res.status}). Check the base URL — it is probably missing or has the wrong path.`;
    } else if (!res.ok) {
      diagnostics.error = `GET ${url} returned ${res.status}`;
    } else {
      try {
        const parsed = extractIds(JSON.parse(text));
        ids = parsed.ids;
        diagnostics.shape = parsed.shape;
        diagnostics.rawCount = ids.length;
        if (ids.length === 0) {
          diagnostics.error =
            "The provider replied 200 but no model ids could be read from the body.";
        }
      } catch {
        diagnostics.error =
          "The provider replied 200 but the body was not JSON.";
      }
    }
  } catch (err) {
    diagnostics.error =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  const merged = Array.from(
    new Set([...ids, ...(resolved.modelIds ?? []), ...EXTRA_MODELS]),
  );

  /* ALLOWED_PROVIDERS names the OmniRoute gateway's own upstreams (kiro,
   * antigravity, ...). Applying it to a third-party provider would delete its
   * entire catalogue — every OpenRouter id is namespaced under a vendor that
   * is not in that list. So it only gates the gateway. */
  const filtered =
    profile.kind === "gateway" ? merged.filter(isAllowedProvider) : merged;

  return { ids: filtered, diagnostics };
}

export async function fetchGatewayModelIds(
  creds?: GatewayCreds,
): Promise<string[]> {
  const { ids, diagnostics } = await fetchGatewayModels(creds);
  if (diagnostics.error && ids.length === 0) throw new Error(diagnostics.error);
  return ids;
}

/* --------------------------- failure classification ---------------------- */

export type FailureKind = "quota" | "auth" | "client" | "missing" | "server" | "other";

export interface GatewayFailure extends Error {
  status: number;
  kind: FailureKind;
  body: string;
}

const QUOTA_TEXT =
  /quota|exhaust|insufficient|out of credit|no credit|credit limit|limit reach|limit exceed|rate.?limit|too many request|all (?:accounts|keys|upstreams)|no (?:available|healthy|usable) (?:account|key|upstream)|cutoff|throttl/i;

const MISSING_TEXT =
  /unknown model|model not found|no such model|unsupported model/i;

/**
 * Known upstream rejections that are NOT a bad API key, even though they arrive
 * as a 401. Agent Router in particular answers a perfectly valid token with
 * "unauthorized client detected" when it dislikes the *client* rather than the
 * credential — the token is fine, the request signature is not.
 *
 * Matched against the response body so the message shown to the user names the
 * real problem instead of sending them to re-check a working key.
 */
const CLIENT_REJECTION_TEXT =
  /unauthorized client|unauthorized_client|client (?:detected|not allowed|forbidden)|invalid client|not an approved client/i;

export function classifyFailure(status: number, body: string): FailureKind {
  const text = body || "";

  if (status === 429) return "quota";
  if (status === 401) {
    /* The distinction matters: a 401 that names the client is not the user's
     * key being wrong, and re-pasting the key will never fix it. */
    return CLIENT_REJECTION_TEXT.test(text) ? "client" : "auth";
  }
  if (MISSING_TEXT.test(text)) return "missing";
  if (status === 404) return "missing";
  if (QUOTA_TEXT.test(text)) return "quota";
  if (status === 402 || status === 403) return "quota";
  if (status >= 500) return "server";
  if (status === 0) return "server";
  return "other";
}

/**
 * Build the error surfaced to the client.
 *
 * `providerLabel` names whoever actually answered. This used to be hardcoded to
 * "OmniRoute", so a failure from Agent Router or OpenAI still read
 * "OmniRoute 401" — actively misleading when the localhost gateway was not
 * involved at all.
 */
export function gatewayFailure(
  status: number,
  body: string,
  providerLabel = "OmniRoute",
): GatewayFailure {
  const kind = classifyFailure(status, body);
  const err = new Error(
    `${providerLabel} ${status || "network"} [${kind}]: ${String(body).slice(0, 400)}`,
  ) as GatewayFailure;
  err.status = status;
  err.kind = kind;
  err.body = String(body);
  return err;
}

export function failureKindOf(err: unknown): FailureKind {
  const kind = (err as GatewayFailure | undefined)?.kind;
  return kind ?? "other";
}

export function shouldFailover(kind: FailureKind): boolean {
  return kind === "quota" || kind === "server" || kind === "missing";
}

/* ----------------------------- failover ladder --------------------------- */

export type CandidateKind =
  | "primary"
  | "account-retry"
  | "provider-swap"
  | "version-drift"
  | "combo-fallback";

export interface Candidate {
  id: string;
  kind: CandidateKind;
  step: number;
  attempt: number;
  attemptsForId: number;
  yieldsControl: boolean;
}

export interface LadderOptions {
  accountRetries?: number;
  allowVersionDrift?: boolean;
  allowComboFallback?: boolean;
  /**
   * Which sort of provider the ladder is being built for.
   *
   * The gateway multiplexes several upstream accounts behind one model id, so
   * retrying the same id can land on a different account. A third-party or
   * local provider is a single key, so the retry budget is capped and the
   * gateway's account allow-list is not applied.
   */
  providerKind?: ProviderKind;
}

function providerRank(provider: string): number {
  if (!PROVIDER_PRIORITY.length) return 0;
  const idx = PROVIDER_PRIORITY.indexOf(provider);
  return idx === -1 ? PROVIDER_PRIORITY.length : idx;
}

export function buildFailoverLadder(
  requestedId: string,
  catalogIds: string[],
  opts: LadderOptions = {},
): Candidate[] {
  const {
    allowVersionDrift = true,
    allowComboFallback = true,
    providerKind = "gateway",
  } = opts;

  /* "Account retry" means the gateway rotating to another upstream account
   * behind the same model id. A third-party provider has exactly one account —
   * the key the user pasted — so repeating the identical request cannot reach a
   * different quota pool. One retry is kept for genuinely transient 429s and
   * 5xxs; more than that is just hammering a provider that already said no. */
  const requestedRetries =
    opts.accountRetries ?? ACCOUNT_RETRIES;
  const accountRetries =
    providerKind === "gateway" ? requestedRetries : Math.min(requestedRetries, 1);

  /* ALLOWED_PROVIDERS names the gateway's own upstreams (kiro, antigravity...).
   * Applied to a third-party catalogue it deletes every namespaced id —
   * `meta-llama/Llama-3.3` is not a gateway account — leaving no alternates to
   * fail over to. */
  const validCatalogIds =
    providerKind === "gateway"
      ? catalogIds.filter(isAllowedProvider)
      : catalogIds.slice();
  const requested = parseModelId(requestedId);

  interface Group {
    id: string;
    kind: CandidateKind;
    yieldsControl: boolean;
    attempts: number;
  }

  const groups: Group[] = [];
  const seen = new Set<string>();
  const addGroup = (
    id: string,
    kind: CandidateKind,
    yieldsControl: boolean,
    attempts: number,
  ) => {
    if (seen.has(id)) return;
    seen.add(id);
    groups.push({ id, kind, yieldsControl, attempts: Math.max(1, attempts) });
  };

  addGroup(
    requested.id,
    "primary",
    requested.isCombo,
    requested.isCombo ? 1 : 1 + accountRetries,
  );

  if (requested.isCombo) {
    return groups.map((g, i) => ({
      id: g.id,
      kind: g.kind,
      step: i + 1,
      attempt: 1,
      attemptsForId: 1,
      yieldsControl: g.yieldsControl,
    }));
  }

  const parsed = validCatalogIds
    .map((id) => parseModelId(id))
    .filter((p) => p.id !== requested.id);

  const swapAttempts = 1 + Math.min(accountRetries, 1);

  parsed
    .filter(
      (p) =>
        !p.isCombo &&
        p.model.toLowerCase() === requested.model.toLowerCase() &&
        p.provider !== requested.provider,
    )
    .sort((a, b) => providerRank(a.provider) - providerRank(b.provider))
    .forEach((p) => addGroup(p.id, "provider-swap", false, swapAttempts));

  if (allowVersionDrift) {
    parsed
      .filter((p) => !p.isCombo && p.line === requested.line)
      .sort((a, b) => {
        const rank = providerRank(a.provider) - providerRank(b.provider);
        if (rank !== 0) return rank;
        return b.model.localeCompare(a.model, undefined, { numeric: true });
      })
      .forEach((p) => addGroup(p.id, "version-drift", false, swapAttempts));
  }

  if (allowComboFallback) {
    parsed
      .filter((p) => p.isCombo && p.line === requested.line)
      .forEach((p) => addGroup(p.id, "combo-fallback", true, 1));
  }

  const out: Candidate[] = [];
  for (const g of groups) {
    for (let attempt = 1; attempt <= g.attempts; attempt++) {
      out.push({
        id: g.id,
        kind: attempt === 1 ? g.kind : "account-retry",
        step: out.length + 1,
        attempt,
        attemptsForId: g.attempts,
        yieldsControl: g.yieldsControl,
      });
    }
  }
  return out;
}

/* ------------------------- notice text ----------------------- */

export interface NoticePayload {
  kind: CandidateKind;
  text: string;
  from: string;
  to: string;
  step: number;
  failure: FailureKind;
  account?: string | null;
}

function reason(failure: FailureKind, account?: string | null): string {
  const where = account ? `account ${account}` : "the account OmniRoute picked";
  switch (failure) {
    case "quota":
      return `quota exhausted on ${where}`;
    case "server":
      return `the upstream errored on ${where}`;
    case "missing":
      return "the gateway does not expose that model";
    case "auth":
      return "the gateway rejected the API key";
    case "client":
      return "the provider rejected this app as a client, not the API key";
    default:
      return `the request failed on ${where}`;
  }
}

export function buildNotice(
  from: string,
  next: Candidate,
  failure: FailureKind,
  account?: string | null,
): NoticePayload {
  const fromName = prettyModelName(from);
  const toName = prettyModelName(next.id);
  const why = reason(failure, account);
  let text: string;

  switch (next.kind) {
    case "account-retry":
      text = `${fromName}: ${why} — retrying ${toName} so OmniRoute rotates to another account (attempt ${next.attempt} of ${next.attemptsForId}).`;
      break;
    case "provider-swap":
      text = `${fromName}: ${why} — switching to ${providerLabel(next.id)} for the same model (${toName}).`;
      break;
    case "version-drift":
      text = `${fromName}: ${why} — no accounts left for this version, trying ${toName} instead.`;
      break;
    case "combo-fallback":
      text = `Every account for ${fromName} is out of quota — handing routing to OmniRoute's "${next.id}" combo. It may answer with a different model.`;
      break;
    default:
      text = `${fromName}: ${why} — retrying.`;
  }

  return {
    kind: next.kind,
    text,
    from,
    to: next.id,
    step: next.step,
    failure,
    account: account ?? null,
  };
}

/* --------------------------- served-by extraction ------------------------ */

export function accountFromHeaders(headers: Headers): string | null {
  const direct = [
    "x-omniroute-account",
    "x-account",
    "x-account-id",
    "x-account-email",
    "x-upstream-account",
    "x-upstream-key",
    "x-provider-account",
  ];
  for (const name of direct) {
    const v = headers.get(name);
    if (v) return v;
  }
  for (const [name, value] of headers.entries()) {
    if (/account|upstream[-_]?key|api[-_]?key[-_]?label/i.test(name) && value) {
      return value;
    }
  }
  return null;
}

export function upstreamModelFromHeaders(headers: Headers): string | null {
  for (const name of [
    "x-omniroute-model",
    "x-model",
    "x-upstream-model",
    "x-resolved-model",
  ]) {
    const v = headers.get(name);
    if (v) return v;
  }
  return null;
}

export interface RouteInfo {
  requested: string;
  served: string | null;
  account: string | null;
  viaCombo: boolean;
  attempts: number;
  substituted: boolean;
}

export function detectSubstitution(
  requestedId: string,
  servedModel: string | null,
): boolean {
  if (!servedModel) return false;
  const want = parseModelId(requestedId);
  if (want.isCombo) return false;
  const got = parseModelId(servedModel);
  return got.line !== want.line;
}
