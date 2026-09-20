/**
 * src/app/api/extension/status/route.ts
 * ---------------------------------------------------------------------------
 * "Is my editor connected right now?" — the one question the pairing UI has to
 * answer continuously.
 *
 * WHY THIS IS SEPARATE FROM /api/extension/token
 *
 * The token endpoint lists rows in a table; this one reports a live in-memory
 * socket. They change on completely different schedules: the token list only
 * changes when the user mints or revokes something, while the connection can
 * drop at any moment because a laptop closed. The panel therefore polls this
 * one every few seconds and refetches the token list only after a mutation.
 * Folding them together would mean re-reading the database on every poll to
 * learn something the database does not know.
 *
 * WHY THE OWNER CONTEXT WRAPPER IS NOT OPTIONAL
 *
 * `vscodeBridge.connectionInfo()` reports on *the account the current call
 * belongs to*, which it reads from an AsyncLocalStorage store — not from an
 * argument. Outside `withWorkspaceOwner` that store is empty and the call
 * reports on the local-operator session instead, which on a shared deployment
 * is the wrong account. The wrapper is the whole security boundary here, so it
 * is applied at the only line that needs it and never skipped.
 *
 * WHAT IT DELIBERATELY DOES NOT REPORT
 *
 * Anything about anyone else. Not a count of connected editors, not whether
 * some other account is paired. `connectionInfo()` is already scoped to the
 * caller; this route adds nothing that widens it.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/authGuard";
import { bridgeConfigured, bridgePublicUrl } from "@/lib/bridgeEndpoint";
import { isMultiTenantBridge } from "@/lib/deploymentMode";
import { fileToolsEnabled } from "@/lib/fileToolsGate";
import { vscodeBridge, withWorkspaceOwner } from "@/lib/vscodeBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;

  /* One wrapper, two reads: entering the owner context twice would work but
   * would also let the two halves of the answer come from different moments. */
  const snapshot = withWorkspaceOwner(auth.user.id, () => ({
    info: vscodeBridge.connectionInfo(),
    activity: vscodeBridge.recentActivity(),
  }));
  const { info, activity } = snapshot;

  return NextResponse.json({
    connected: info.connected,
    /* ms since epoch, not a duration: the client renders "connected 4 minutes
     * ago" against its own clock, so a cached response cannot make the number
     * drift. */
    since: info.since,
    /* Lets the panel highlight which row in the token list is the live one. It
     * is a row id, not a credential. */
    tokenId: info.tokenId,
    /* The folder the extension reported — the user's proof that the approval
     * they gave in VS Code is the one in effect here. Null until a folder is
     * approved, which is the normal state for a freshly paired editor. */
    root: info.root,
    /* Newest last. Paths and method names only; see BridgeActivity for what is
     * deliberately absent. */
    activity,
    /* False means the operator has not set OMNIROUTE_BRIDGE_ENABLE=true, so no
     * pairing code can ever connect. The panel says so rather than letting the
     * user debug their own firewall. */
    bridgeReady: bridgeConfigured(),
    /* Whether the port is bound *right now*, which is not the same question.
     * `bridgeReady` is policy — was this deployment allowed to open the bridge.
     * This is fact. They disagree when the bridge was enabled but the bind
     * failed, almost always because something else already holds the port, and
     * the two need opposite advice: one is an env file to edit, the other is a
     * process to go and stop. Reported outside the owner wrapper deliberately —
     * a listening socket is a property of the process, not of the caller. */
    bridgeListening: vscodeBridge.isListening(),
    wsUrl: bridgePublicUrl(req),
    /* True on a deployed server, where a file operation reaches the user's own
     * editor or it fails. The panel uses it to choose between "connect your
     * editor to enable file access" and the laptop wording, where the server's
     * own disk is still a legitimate fallback. */
    multiTenant: isMultiTenantBridge(),
    /* Independently switchable: an operator can turn the file tools off without
     * touching the bridge. Without this the panel would show a healthy
     * connection next to tools that refuse to run. */
    fileToolsEnabled: fileToolsEnabled(),
    /* The server's clock, so the client can render durations correctly even
     * when the two machines disagree about the time. */
    now: Date.now(),
  });
}
