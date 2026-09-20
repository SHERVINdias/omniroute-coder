/**
 * src/lib/localGatewayProbe.ts
 * ---------------------------------------------------------------------------
 * Finds an OmniRoute gateway on the user's own machine, from the user's own
 * browser.
 *
 * WHY THE BROWSER AND NOT THE SERVER
 *
 * "Is the gateway running?" is a question about the machine the person is
 * sitting at, and the server is frequently not that machine. A deployed
 * instance asking its own `localhost:20128` learns nothing about the user's
 * laptop, and that mismatch is the single most confusing thing about connecting
 * a gateway: the app reports a failure that describes the server's network while
 * the user is looking at a terminal that plainly says the gateway is running.
 *
 * The browser has no such problem. It is running on the user's machine by
 * definition, so it can reach `http://localhost:20128` whenever the gateway is
 * up — even when the page itself was served from a datacentre.
 *
 * WHY TWO REQUESTS
 *
 * Presence and readability are different questions with different failure
 * modes, and collapsing them produces a wrong answer in a common case.
 *
 * A normal cross-origin `fetch` to the gateway needs the gateway to send
 * `Access-Control-Allow-Origin`, and it is a local API server that has no
 * particular reason to. When those headers are missing the browser rejects the
 * request with an opaque `TypeError` that is indistinguishable from "nothing is
 * listening" — so a single CORS fetch would report a *running* gateway as
 * absent, which is exactly the false negative this module exists to avoid.
 *
 * `mode: "no-cors"` sidesteps it. The response is opaque — no status, no body —
 * but the promise resolves if anything at all answered on that port and rejects
 * if the connection could not be made. That is a liveness check that needs no
 * cooperation from the gateway, and a CORS read on top of it turns "something is
 * there" into "here is what it has".
 *
 * Neither is run as the gatekeeper for the other, because their blind spots do
 * not overlap. CORS blocks the read and not the no-cors probe;
 * `Cross-Origin-Resource-Policy: same-origin` — which helmet sets by default, so
 * plenty of Node servers send it without anyone choosing to — blocks the no-cors
 * probe and not the read. Gating the second request on the first therefore hid a
 * live gateway whenever the server happened to use that middleware. Both go out
 * together and either one succeeding means present.
 *
 * WHAT A NEGATIVE RESULT DOES NOT PROVE
 *
 * Both requests failing means the browser could not complete either one. The
 * likeliest reason is that nothing is listening, but it is not the only one: a
 * page served over https may refuse a plaintext subresource (Chromium exempts
 * `http://localhost` as a potentially-trustworthy origin, other engines are less
 * consistent), and extensions or enterprise policy can block it too. Callers must
 * present a negative as "not detected", never as "not running" — `detail` carries
 * wording that stays true either way.
 *
 * This is a hint, not an authority. Saving a gateway still goes through the
 * server-side test, because the server is the party that has to reach it.
 */

/** Where the `omniroute` CLI serves its API by default. */
export const DEFAULT_GATEWAY_PORT = 20128;

export interface LocalGatewayProbeResult {
  /** The origin that was probed, e.g. `http://localhost:20128`. */
  origin: string;
  /** Something answered on that origin. False means "not detected". */
  present: boolean;
  /** The response could be read — the gateway sent usable CORS headers. */
  readable: boolean;
  /** Model ids, when `readable`. Empty otherwise; never null, so callers can map. */
  models: string[];
  /**
   * Whether the supplied key was accepted. `null` when unknown, which covers
   * both "no key was given to try" and "the response could not be read".
   */
  authorized: boolean | null;
  /** One sentence fit to show a user, true regardless of which branch we took. */
  detail: string;
}

const PROBE_TIMEOUT_MS = 2500;

export function defaultGatewayOrigin(port: number = DEFAULT_GATEWAY_PORT): string {
  return `http://localhost:${port}`;
}

/**
 * Probe `origin` for a gateway. Never throws and never rejects: every failure is
 * a result, because every caller is rendering a status rather than handling an
 * exception.
 */
export async function probeLocalGateway(
  origin: string = defaultGatewayOrigin(),
  apiKey?: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<LocalGatewayProbeResult> {
  const base = origin.replace(/\/+$/, "");
  const modelsUrl = `${base}/v1/models`;

  const absent = (detail: string): LocalGatewayProbeResult => ({
    origin: base,
    present: false,
    readable: false,
    models: [],
    authorized: null,
    detail,
  });

  if (typeof fetch !== "function") {
    return absent("This browser cannot run the check.");
  }

  /* Both checks at once.
   *
   * They answer different questions and EITHER succeeding proves presence, so
   * there is nothing to gain by running them in sequence — and one real case
   * needs both tried. `Cross-Origin-Resource-Policy: same-origin` is a default
   * in common Node middleware (helmet sets it), and it rejects exactly the
   * no-cors request below while leaving a proper CORS request untouched. A
   * gateway configured that way is up, reachable, and was being reported as
   * absent by the liveness check alone.
   *
   * Running them together also halves the worst case: two 2.5s timeouts back to
   * back is five seconds of a spinner on a panel that polls every four. */
  const [alive, read] = await Promise.all([
    respondsAtAll(modelsUrl, timeoutMs),
    readModels(modelsUrl, apiKey, timeoutMs),
  ]);

  /* A readable response is itself proof of presence — a browser cannot parse
   * JSON from a port with nothing on it. */
  if (!alive && read.kind === "unreadable") {
    return absent(
      `Nothing answered on ${base}. Either the gateway is not running, or this browser would not let the page reach it.`,
    );
  }

  if (read.kind === "unreadable") {
    return {
      origin: base,
      present: true,
      readable: false,
      models: [],
      authorized: null,
      detail:
        "A gateway is running on this machine. Its responses cannot be read from this page because it does not send CORS headers, which is normal and does not stop the server using it.",
    };
  }

  if (read.kind === "unauthorized") {
    /* A 401 with no key sent is not a rejection, it is the gateway asking. The
     * wizard probes before the user has typed anything, so treating the two the
     * same told people their key was wrong while the field was still empty. */
    return {
      origin: base,
      present: true,
      readable: true,
      models: [],
      authorized: apiKey ? false : null,
      detail: apiKey
        ? "A gateway is running on this machine, but it rejected that API key. Copy the key from the gateway dashboard again."
        : "A gateway is running on this machine and is asking for an API key. Copy one from its dashboard.",
    };
  }

  return {
    origin: base,
    present: true,
    readable: true,
    models: read.models,
    authorized: apiKey ? true : null,
    detail:
      read.models.length > 0
        ? `A gateway is running on this machine and reported ${read.models.length} model${read.models.length === 1 ? "" : "s"}.`
        : "A gateway is running on this machine, but it has no models configured yet. Add a provider in its dashboard.",
  };
}

/**
 * Did anything answer? Opaque by design — see the header note on `no-cors`.
 *
 * A resolved promise here includes 401s, 404s and 500s, which is intended: any
 * HTTP response at all proves a server is on that port, and distinguishing which
 * one is the next function's job.
 */
async function respondsAtAll(url: string, timeoutMs: number): Promise<boolean> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeoutMs);
  try {
    await fetch(url, {
      mode: "no-cors",
      cache: "no-store",
      signal: stop.signal,
      /* No Authorization header: it would upgrade this into a preflighted
       * request and reintroduce the CORS dependency this call exists to avoid. */
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

type ReadResult =
  | { kind: "ok"; models: string[] }
  | { kind: "unauthorized" }
  | { kind: "unreadable" };

async function readModels(
  url: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<ReadResult> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: stop.signal,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    });

    if (response.status === 401 || response.status === 403) {
      return { kind: "unauthorized" };
    }
    if (!response.ok) return { kind: "unreadable" };

    const body: unknown = await response.json();
    return { kind: "ok", models: extractModelIds(body) };
  } catch {
    /* CORS refusal, abort, or a genuine drop — all mean the same thing to the
     * caller, and presence has already been established by this point. */
    return { kind: "unreadable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull model ids out of an OpenAI-shaped `/v1/models` body.
 *
 * Written defensively because the gateway is a separate product on its own
 * release cadence: a shape we do not recognise yields an empty list, which the
 * caller renders as "running, no models" rather than crashing the panel.
 */
function extractModelIds(body: unknown): string[] {
  const rows =
    body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data)
      : Array.isArray(body)
        ? body
        : [];

  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row === "string") {
      ids.push(row);
      continue;
    }
    const id = (row as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.trim()) ids.push(id.trim());
  }
  return ids;
}
