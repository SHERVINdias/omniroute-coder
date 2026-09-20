/**
 * POST /api/ollama/control
 * ---------------------------------------------------------------------------
 * Load, unload or inspect models held in a local Ollama server's RAM.
 *
 * WHAT CHANGED AND WHY
 *
 * The first version of this route was the most dangerous endpoint in the app.
 * It took `baseUrl` straight from the request body, defaulted it to
 * `http://localhost:11434`, fetched it server-side, and returned the upstream
 * status and body to the caller. There was no session check and no rate limit.
 *
 * Put that on a public EC2 instance and anyone on the internet could:
 *
 *   - read the instance metadata service at 169.254.169.254 and walk away with
 *     the IAM role credentials attached to the box,
 *   - sweep the VPC for internal services by watching which addresses answer
 *     and how fast they fail,
 *   - read any internal HTTP endpoint outright, because the error path did
 *     `await response.text()` and put the result in the JSON it returned.
 *
 * Four things close that, and all four are needed:
 *
 *   1. A session is required, so this is no longer an anonymous primitive.
 *   2. The address is not taken from the caller. It must match a provider this
 *      specific user has already saved. An unauthenticated stranger cannot save
 *      one, and a signed-in user pointing it at their own machine is the
 *      feature working as intended.
 *   3. `guardUpstreamUrl` still runs on top, so even a saved credential cannot
 *      reach link-local or private space on a deployed server.
 *   4. No upstream body is ever echoed back. Status replies are rebuilt field by
 *      field from a fixed list; failures report a category, not the response.
 *
 * Request body:
 *   { "action": "status" | "load" | "unload", "model"?: string, "baseUrl"?: string }
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/authGuard";
import { listProvidersForDisplay } from "@/lib/credentialManager";
import { getProviderProfile } from "@/lib/providerProfiles";
import { guardUpstreamUrl } from "@/lib/upstreamRequest";
import { formatRetryAfter, rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ollama answers a load/unload almost immediately; a hang means unreachable. */
const UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * Generous, because the settings panel polls `status` while it is open, but
 * finite, because each call is an outbound connection the server makes on the
 * caller's behalf. Keyed per user, not per IP: the session is the scarce thing.
 */
const CONTROL_LIMIT = { limit: 60, windowMs: 60_000 } as const;

type Action = "status" | "load" | "unload";

function isAction(value: unknown): value is Action {
  return value === "status" || value === "load" || value === "unload";
}

/**
 * Ollama model references look like `llama3.1:8b-instruct-q4_K_M` or
 * `hf.co/user/repo:Q4_K_M`. Everything outside this set is refused rather than
 * escaped — the value is interpolated into a JSON body, so the risk is low, but
 * a name is a name and there is no reason to accept control characters or
 * whitespace in one.
 */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/\\@-]{0,190}$/;

/**
 * Compare two base URLs for "same server".
 *
 * The settings panel stores an OpenAI-compatible URL (`.../v1`) and strips the
 * suffix before calling here, so the two spellings must compare equal or the
 * ownership check below would reject the user's own server. Trailing slashes
 * likewise. Host and port are compared case-insensitively via the URL parser
 * rather than by string, so `http://LOCALHOST:11434` matches.
 */
function sameEndpoint(a: string, b: string): boolean {
  const norm = (raw: string): string | null => {
    try {
      const u = new URL(raw);
      const path = u.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
      return `${u.protocol}//${u.host}${path}`.toLowerCase();
    } catch {
      return null;
    }
  };
  const left = norm(a);
  const right = norm(b);
  return left !== null && left === right;
}

/**
 * The set of addresses this user is allowed to have us contact.
 *
 * Restricted to profiles registered as `local` — Ollama, LM Studio, llama.cpp,
 * vLLM. A saved OpenAI or gateway credential is not a licence to drive this
 * endpoint at somebody else's host.
 */
function allowedBaseUrls(userId: string): string[] {
  const { providers } = listProvidersForDisplay(userId);
  return providers
    .filter((p) => {
      if (!p.baseUrl) return false;
      return getProviderProfile(p.provider).kind === "local";
    })
    .map((p) => p.baseUrl.replace(/\/v1\/?$/, ""));
}

/** Only the fields the settings panel renders. Anything else stays upstream. */
function projectModels(raw: unknown): Array<Record<string, unknown>> {
  const root = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.models) ? root.models : [];
  return list.slice(0, 100).map((entry) => {
    const m = (entry ?? {}) as Record<string, unknown>;
    return {
      name: typeof m.name === "string" ? m.name : "",
      model: typeof m.model === "string" ? m.model : "",
      size: typeof m.size === "number" ? m.size : null,
      size_vram: typeof m.size_vram === "number" ? m.size_vram : null,
      expires_at: typeof m.expires_at === "string" ? m.expires_at : null,
    };
  });
}

export async function POST(req: NextRequest) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;

  const gate = rateLimit(`ollama-control:${auth.user.id}`, CONTROL_LIMIT);
  if (!gate.ok) {
    return NextResponse.json(
      {
        error: `Too many Ollama control requests. Try again in ${formatRetryAfter(
          gate.retryAfterMs,
        )}.`,
      },
      { status: 429 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = body.action;
  if (!isAction(action)) {
    return NextResponse.json(
      { error: "Invalid action. Use 'status', 'load', or 'unload'." },
      { status: 400 },
    );
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (action !== "status") {
    if (!model) {
      return NextResponse.json(
        { error: "Missing 'model' parameter" },
        { status: 400 },
      );
    }
    if (!MODEL_NAME.test(model)) {
      return NextResponse.json(
        { error: "That does not look like an Ollama model name." },
        { status: 400 },
      );
    }
  }

  /* Ownership check. The requested address must be one this user saved; when
   * they send nothing, fall back to their first local provider rather than to
   * a hardcoded localhost, so the server never invents a destination. */
  const allowed = allowedBaseUrls(auth.user.id);
  if (allowed.length === 0) {
    return NextResponse.json(
      {
        error:
          "No local model server is set up on this account. Add Ollama (or another local server) in Settings first.",
      },
      { status: 400 },
    );
  }

  const requested = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  let baseUrl: string;
  if (!requested) {
    baseUrl = allowed[0];
  } else {
    const match = allowed.find((candidate) => sameEndpoint(candidate, requested));
    if (!match) {
      return NextResponse.json(
        {
          error:
            "That address is not one of the local model servers saved on this account.",
        },
        { status: 403 },
      );
    }
    baseUrl = match;
  }

  /* Second gate: a saved credential is still user input. On a deployed server
   * this refuses loopback, private space and the metadata address. */
  const blocked = await guardUpstreamUrl(baseUrl);
  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 403 });
  }

  try {
    if (action === "status") {
      const response = await fetch(`${baseUrl}/api/ps`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        redirect: "manual",
      });

      if (!response.ok) {
        return NextResponse.json(
          { error: `Ollama answered ${response.status}.` },
          { status: 502 },
        );
      }

      const data: unknown = await response.json();
      return NextResponse.json({ success: true, models: projectModels(data) });
    }

    /* keep_alive 0 evicts the model now; -1 pins it until Ollama restarts. */
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        keep_alive: action === "load" ? -1 : 0,
        prompt: "",
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: "manual",
    });

    if (!response.ok) {
      /* Deliberately not `await response.text()`. The body of a failed fetch is
       * exactly what an SSRF probe wants back. */
      return NextResponse.json(
        { error: `Ollama answered ${response.status}.` },
        { status: 502 },
      );
    }

    /* /api/generate streams even with an empty prompt; drain it so the
     * connection closes and the model state has actually settled before we
     * report success. */
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
    }

    return NextResponse.json({
      success: true,
      message:
        action === "load"
          ? `Model ${model} loaded into RAM`
          : `Model ${model} unloaded from RAM`,
    });
  } catch (error) {
    /* Logged server-side with detail, returned to the caller without it: a
     * timeout and a connection refusal are distinguishable signals about the
     * internal network, so the caller gets one flat message for both. */
    console.error(`[ollama/control] ${action} failed:`, error);
    return NextResponse.json(
      {
        error:
          "Could not reach the local model server. Check that it is running and reachable from this machine.",
      },
      { status: 502 },
    );
  }
}
