/**
 * src/app/api/extension/token/route.ts
 * ---------------------------------------------------------------------------
 * Pairing tokens for the VS Code extension: mint, list, revoke.
 *
 * WHAT CHANGED, AND WHY
 *
 * The previous handler was written for a single operator on a single laptop and
 * had three properties that each made remote pairing impossible:
 *
 *   1. `requireAdmin`. A beta tester is not an admin, so the endpoint that
 *      hands out the pairing token was unreachable by every person who needed
 *      it. Pairing is not an administrative act — it is a user connecting their
 *      own editor to their own account — so it needs `requireUser`.
 *
 *   2. `isLoopbackRequest`. It refused anything with an `x-forwarded-for` that
 *      was not loopback, which is precisely every request from an actual user
 *      once Caddy is in front. Worse, it opened with `if (!forwarded) return
 *      true;` — so the check failed *open* for any caller who reached the app
 *      without passing through the proxy at all. It blocked the legitimate case
 *      and waved through the one worth worrying about.
 *
 *   3. `const WS_URL = "ws://127.0.0.1:20129"`. See bridgeEndpoint.ts: telling
 *      a remote user to dial their own loopback is telling them to dial
 *      nothing.
 *
 * WHY THE FULL TOKEN IS RETURNED EXACTLY ONCE
 *
 * The store keeps only a sha256 of it, so this response is the sole moment the
 * plaintext exists server-side. That is a deliberate trade: it costs a user who
 * loses the token a re-mint (a button click), and it means a stolen chat.db
 * backup contains no usable credential. The UI must therefore say "copy this
 * now" and mean it — there is no endpoint that can show it again, by design.
 *
 * METHODS
 *   GET                    -> { tokens: [...], wsUrl, bridgeReady }
 *   POST   { label? }      -> { token, pairingCode, wsUrl, ... }  (plaintext, once)
 *   DELETE ?id=<id> | ?all=1 -> { revoked: n, disconnected: boolean }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/authGuard";
import { rateLimit, formatRetryAfter } from "@/lib/rateLimit";
import { bridgeConfigured, bridgePublicUrl, encodePairingCode } from "@/lib/bridgeEndpoint";
import {
  issueExtensionToken,
  listExtensionTokens,
  revokeAllExtensionTokens,
  revokeExtensionToken,
} from "@/lib/extensionTokenStore";
import { vscodeBridge, withWorkspaceOwner } from "@/lib/vscodeBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Minting is cheap for the server and expensive for nobody, but an unbounded
 * loop would still churn the table and fill the log. The store caps a user at
 * five live tokens regardless; this stops the churn that reaches that cap
 * several times a second.
 */
const MINT_LIMIT = { limit: 10, windowMs: 60_000 } as const;

/* -------------------------------------------------------------------------
 * GET — list this user's tokens
 * ---------------------------------------------------------------------- */

export async function GET(req: NextRequest) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;

  return NextResponse.json({
    tokens: listExtensionTokens(auth.user.id),
    wsUrl: bridgePublicUrl(req),
    bridgeReady: bridgeConfigured(),
  });
}

/* -------------------------------------------------------------------------
 * POST — mint a new token
 * ---------------------------------------------------------------------- */

export async function POST(req: NextRequest) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;

  const gate = rateLimit(`extension-token:${auth.user.id}`, MINT_LIMIT);
  if (!gate.ok) {
    return NextResponse.json(
      {
        error: `Too many pairing codes at once. Try again in ${formatRetryAfter(
          gate.retryAfterMs,
        )}.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  /* A label is a convenience for the person reading their own token list
   * ("work laptop"), never anything the server acts on. Truncated because it is
   * rendered in a table and a 10 kB string is a layout bug, not a threat. */
  const rawLabel = typeof body.label === "string" ? body.label : "";
  const label = rawLabel.replace(/[\r\n\t]/g, " ").trim().slice(0, 60);

  const issued = issueExtensionToken(auth.user.id, label);
  const wsUrl = bridgePublicUrl(req);

  return NextResponse.json({
    ...issued,
    wsUrl,
    /* The single string the user pastes into the extension. It contains the
     * plaintext token, so it is subject to exactly the same rule as `token`
     * above: shown once, never stored, never logged. */
    pairingCode: encodePairingCode(wsUrl, issued.token),
    bridgeReady: bridgeConfigured(),
    /* Said in the payload as well as in the UI, so anyone driving this endpoint
     * from a script learns the same thing without reading the source. */
    notice:
      "This is the only time the full code is shown. Store it in VS Code now; " +
      "if you lose it, revoke this one and create another.",
  });
}

/* -------------------------------------------------------------------------
 * DELETE — revoke
 * ---------------------------------------------------------------------- */

/**
 * WHY REVOKING ALSO CLOSES THE SOCKET
 *
 * The token is checked once, during the WebSocket upgrade. After that the
 * session is a live object in memory that never looks at the table again — so
 * deleting the row on its own would invalidate the *next* connection and leave
 * the current one running. That is precisely backwards for the case revocation
 * exists to serve: a laptop that was stolen, lost or lent out is already
 * connected, and the user pressing "revoke" means "stop it now", not "stop it
 * whenever that machine next reboots".
 *
 * The match is on token id, so revoking the code for a desktop does not kick a
 * laptop that is connected with a different one. `connectionInfo()` is scoped
 * by AsyncLocalStorage, hence the `withWorkspaceOwner` wrapper; `disconnectOwner`
 * takes the id directly and needs none.
 */
export async function DELETE(req: NextRequest) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;

  const params = new URL(req.url).searchParams;

  if (params.get("all") === "1") {
    const revoked = revokeAllExtensionTokens(auth.user.id);
    const disconnected = vscodeBridge.disconnectOwner(
      auth.user.id,
      "All pairing codes were revoked from the web app.",
    );
    return NextResponse.json({ revoked, disconnected });
  }

  const id = (params.get("id") || "").trim();
  if (!id) {
    return NextResponse.json(
      { error: "Specify which pairing code to revoke." },
      { status: 400 },
    );
  }

  /* Read the live session *before* revoking, so the comparison is against the
   * state the user was looking at when they pressed the button. */
  const live = withWorkspaceOwner(auth.user.id, () =>
    vscodeBridge.connectionInfo(),
  );

  /* `revokeExtensionToken` scopes on the user id as well as the row id, so a
   * caller guessing uuids revokes nothing but their own. A miss answers 404
   * rather than 403 for the same reason: "wrong owner" and "no such row" should
   * be indistinguishable from outside. */
  const done = revokeExtensionToken(auth.user.id, id);
  if (!done) {
    return NextResponse.json(
      { error: "That pairing code no longer exists." },
      { status: 404 },
    );
  }

  let disconnected = false;
  if (live.connected && live.tokenId === id) {
    disconnected = vscodeBridge.disconnectOwner(
      auth.user.id,
      "This pairing code was revoked from the web app.",
    );
  }

  return NextResponse.json({ revoked: 1, disconnected });
}
