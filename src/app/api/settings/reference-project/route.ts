/**
 * src/app/api/settings/reference-project/route.ts
 * ---------------------------------------------------------------------------
 * GET — the user's reference project, plus what the panel needs to help them
 *       choose one: the folders VS Code has actually approved, the folder the
 *       agent is writing to, and whether an editor is connected at all.
 * PUT — save it, then tell the connected editor.
 *
 * WHY THE FOLDER LIST COMES FROM THE EDITOR AND NOT FROM A FILE PICKER
 *
 * A browser cannot name a path on the user's disk — a file input hands over
 * contents and a bare filename, never a location — and this server has no view
 * of the user's machine either. The editor is the one participant that knows
 * both what folders are open and which of them the user has approved, so the
 * panel offers those and nothing else. Typing a path by hand still works, and
 * is the only route when no editor is connected, but the list exists so the
 * common case is one click instead of a path the user has to go and copy.
 *
 * WHY A SAVE HERE CANNOT GRANT ACCESS TO ANYTHING
 *
 * Storing a path is not permission to read it. The extension answers reference
 * calls only for a folder the user approved in VS Code, and re-checks that on
 * every call. So the worst a bad value in this table can do is produce a
 * refusal — which is why the route can afford to accept a path it has no way
 * to verify.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/authGuard";
import { rateLimit, formatRetryAfter } from "@/lib/rateLimit";
import { readJsonBody } from "@/lib/skills/readJsonBody";
import {
  MAX_PATH_LENGTH,
  getReferenceProject,
  saveReferenceProject,
} from "@/lib/referenceProjectStore";
import { referenceReachability } from "@/lib/referenceProject";
import { vscodeBridge, withWorkspaceOwner } from "@/lib/vscodeBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAVE_LIMIT = { limit: 30, windowMs: 60_000 } as const;

/** One path and a name. 8 KB is already absurdly generous. */
const MAX_BODY = 8 * 1024;

export async function GET(req: NextRequest) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;

  const config = getReferenceProject(auth.user.id);

  /* Both of these need the owner context: the bridge resolves a session from
   * the ambient owner, and an unwrapped call would ask about the wrong account
   * — or, on a local install, about nobody. */
  const { folders, connection } = await withWorkspaceOwner(
    auth.user.id,
    async () => ({
      folders: await vscodeBridge.grantedFolders(),
      connection: vscodeBridge.connectionInfo(),
    }),
  );

  /* The writable root is sent so the panel can do the one piece of validation
   * that matters and that the user cannot easily do in their head: refuse a
   * reference project that IS the working project. Pointing both at the same
   * folder is not dangerous — the tools still cannot write through the
   * reference path — but it is certainly a mistake, and it wastes a round
   * every time the model searches a folder it can already list. */
  return NextResponse.json({
    config,
    folders,
    activeRoot: connection.root,
    editorConnected: connection.connected,
    reachability: referenceReachability(auth.user.id),
    limits: { maxPathLength: MAX_PATH_LENGTH },
  });
}

export async function PUT(req: NextRequest) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;

  const gate = rateLimit(`reference-project:${auth.user.id}`, SAVE_LIMIT);
  if (!gate.ok) {
    return NextResponse.json(
      {
        error: `Too many saves at once. Try again in ${formatRetryAfter(
          gate.retryAfterMs,
        )}.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  const parsed = await readJsonBody(req, MAX_BODY);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }

  const result = saveReferenceProject(auth.user.id, parsed.body);

  /* A rejected path is a 400 here, unlike the exclusions route.
   *
   * The difference is that there is only one value in this request. Exclusions
   * are a list where some entries can be kept and some dropped, so a 200 with
   * a `rejected` array describes what really happened. Here, "rejected" means
   * nothing was saved, and answering 200 would leave the panel rendering a
   * config the database does not contain. */
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  /* Hand the new root to the editor immediately.
   *
   * Without this, a user who picks a reference project and asks a question in
   * the same breath gets refusals: the extension is still holding whatever it
   * was told when the socket opened, which for a first-time setup is "none".
   * Awaited so the reply can say whether the editor is in step — false is
   * ordinary and means no editor is connected, not that the save failed. */
  let editorSynced = false;
  try {
    editorSynced = await vscodeBridge.refreshReferenceRoot(auth.user.id);
  } catch {
    /* Logged inside the bridge. A save must not fail because an editor
     * disconnected mid-request. */
  }

  return NextResponse.json({
    config: result.config,
    editorSynced,
    reachability: referenceReachability(auth.user.id),
  });
}
