/**
 * /api/credentials
 * ---------------------------------------------------------------------------
 * Each account's own gateway providers.
 *
 * WHAT CHANGED AND WHY
 *
 * Every method here was unauthenticated, and GET returned the full provider
 * list — including each `apiKey` in cleartext — to anyone who asked. Combined
 * with the single global store, that meant one request returned every key the
 * app knew about.
 *
 * Now: a session is required, every operation is scoped to the caller's own
 * rows, and no response ever contains a usable key. The UI receives a masked
 * preview (`••••••••abcd`) which is enough to confirm *which* key is saved
 * without being enough to use it.
 *
 * THE WRITE-ONLY KEY FIELD
 *
 * On update, an omitted or blank apiKey keeps the stored one. That is what lets
 * the settings form work without ever holding a real key in browser memory: it
 * can rename a provider or change its URL while sending no key at all.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  listProvidersForDisplay,
  upsertProvider,
  removeProvider,
  setActiveProvider,
  getProviderById,
  generateProviderId,
  importLegacyProvidersFor,
} from "@/lib/credentialManager";
import { requireUser } from "@/lib/authGuard";
import {
  allowsEmptyApiKey,
  getProviderProfile,
  incompatibleProviderWarning,
} from "@/lib/providerProfiles";
import { privateGatewayAllowed } from "@/lib/ssrfGuard";
import { isContainerized, sameMachineHostAlias } from "@/lib/runtimeEnvironment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Accept only http(s) and reject anything with credentials embedded in it.
 *
 * The userinfo check matters: `https://user:pass@host` would otherwise be
 * stored and later replayed, leaking whatever was in it into request logs.
 */
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
}

function bad(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

/** GET — the caller's providers, keys masked. */
export async function GET(request: NextRequest) {
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;

  try {
    /* One-time carry-over of a pre-existing providers.json. No-op after the
     * first run, and skipped entirely for users who already have providers. */
    importLegacyProvidersFor(guard.user.id);

    return NextResponse.json({
      success: true,
      data: listProvidersForDisplay(guard.user.id),
      /* Whether this deployment can reach loopback/private addresses at all.
       * Sent so the settings form can warn about a localhost base URL while the
       * user is typing it, instead of letting them save something that will
       * only fail later, at the point where the failure looks like a broken
       * gateway rather than a deployment property. Not a secret: it is
       * observable by saving such a URL and reading the error. */
      privateGatewayAllowed: privateGatewayAllowed(),
      /* Whether the server is inside a container, which decides what "the same
       * machine" is called. The browser cannot work this out: `docker compose`
       * publishes the app on 127.0.0.1, so the page looks local while the fetch
       * originates somewhere with its own loopback. Without this the wizard told
       * containerized users to flip the private-gateway guard and stop there,
       * which trades a self-explaining refusal for a bare connection error.
       *
       * Not a secret, and not a capability: it changes which address the UI
       * suggests, never what the server is willing to fetch. */
      containerized: isContainerized(),
      /* The host to substitute for `localhost` so it means the user's machine
       * from where this server sits, or null when `localhost` is already right
       * (or when nothing local can work and the answer is a tunnel). */
      sameMachineHost: sameMachineHostAlias(),
    });
  } catch (error) {
    console.error(
      "[credentials] read failed:",
      error instanceof Error ? error.message : String(error),
    );
    return bad("Failed to read providers", 500);
  }
}

/** POST — add or update one provider belonging to the caller. */
export async function POST(request: NextRequest) {
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;
  const userId = guard.user.id;

  try {
    const body = (await request.json()) as Record<string, unknown>;

    const id = typeof body.id === "string" ? body.id.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const provider =
      typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    const modelIds = Array.isArray(body.modelIds)
      ? body.modelIds
          .filter((m): m is string => typeof m === "string")
          .map((m) => m.trim())
          .filter(Boolean)
      : undefined;

    if (!name) return bad("Provider name is required");
    if (!provider) return bad("Provider type is required");
    if (!baseUrl) return bad("Base URL is required");
    if (!isValidUrl(baseUrl)) {
      return bad(
        "Base URL must be a plain http:// or https:// address with no username or password in it.",
      );
    }

    /* An id the caller does not own must not be updatable — without this check
     * a crafted id would let one account overwrite another's credentials. */
    const existing = id ? getProviderById(userId, id) : null;
    if (id && !existing) {
      return bad("That provider does not exist on your account.", 404);
    }

    /* A key is mandatory when creating, optional when updating.
     *
     * The exception is a local model server: Ollama, LM Studio and llama.cpp
     * accept anonymous requests, so demanding a key here would make local
     * open-source models impossible to configure at all. */
    const profile = getProviderProfile(provider);
    if (!existing && !apiKey && !allowsEmptyApiKey(profile, baseUrl)) {
      return bad(
        `An API key is required for ${profile.label}. Local servers (Ollama, LM Studio, llama.cpp) can be saved without one.`,
      );
    }

    const targetId = existing ? existing.id : generateProviderId(userId, provider);

    upsertProvider(userId, {
      id: targetId,
      name,
      provider,
      ...(apiKey ? { apiKey } : {}),
      baseUrl: baseUrl.replace(/\/+$/, ""),
      ...(modelIds && modelIds.length > 0 ? { modelIds } : {}),
      makeActive: body.makeActive === true,
    });

    return NextResponse.json({
      success: true,
      message: existing ? "Provider updated" : "Provider added",
      /* Saving a non-OpenAI-compatible provider succeeds but will not work at
       * request time. Say so now rather than letting it fail as a blank reply. */
      ...(incompatibleProviderWarning(profile)
        ? { warning: incompatibleProviderWarning(profile) }
        : {}),
      data: listProvidersForDisplay(userId),
    });
  } catch (error) {
    console.error(
      "[credentials] save failed:",
      error instanceof Error ? error.message : String(error),
    );
    return bad("Failed to save provider", 500);
  }
}

/** PUT — choose which of the caller's providers is active. */
export async function PUT(request: NextRequest) {
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;

  try {
    const body = (await request.json()) as { activeProviderId?: unknown };
    const activeProviderId =
      typeof body.activeProviderId === "string" ? body.activeProviderId.trim() : "";

    if (!activeProviderId) return bad("activeProviderId is required");

    const ok = setActiveProvider(guard.user.id, activeProviderId);
    if (!ok) return bad("That provider does not exist on your account.", 404);

    return NextResponse.json({
      success: true,
      message: "Active provider updated",
      activeProviderId,
      data: listProvidersForDisplay(guard.user.id),
    });
  } catch (error) {
    console.error(
      "[credentials] set active failed:",
      error instanceof Error ? error.message : String(error),
    );
    return bad("Failed to set active provider", 500);
  }
}

/** DELETE — remove one of the caller's providers. */
export async function DELETE(request: NextRequest) {
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;

  try {
    const { searchParams } = new URL(request.url);
    const providerId = (searchParams.get("id") || "").trim();

    if (!providerId) return bad("Provider ID is required");

    const ok = removeProvider(guard.user.id, providerId);
    if (!ok) return bad("That provider does not exist on your account.", 404);

    return NextResponse.json({
      success: true,
      message: "Provider deleted",
      data: listProvidersForDisplay(guard.user.id),
    });
  } catch (error) {
    console.error(
      "[credentials] delete failed:",
      error instanceof Error ? error.message : String(error),
    );
    return bad("Failed to delete provider", 500);
  }
}
