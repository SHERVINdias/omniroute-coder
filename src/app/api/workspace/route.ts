/**
 * src/app/api/workspace/route.ts
 * ---------------------------------------------------------------------------
 * Backs the WorkspaceSelector dropdown. This route did not exist before —
 * that was the actual bug: the selector called fetch("/api/workspace") and
 * got a 404, so there was no way for the UI to ever change the working
 * directory. vscodeBridge.ts owns the persisted override; this route is a
 * thin wrapper over it.
 *
 * It was also open to the world, which meant an anonymous caller could read the
 * server's absolute filesystem paths, enumerate the projects sitting beside
 * them, and — via `action: "browse"` — pop a native folder dialog on the
 * operator's desktop. It is now a signed-in, file-tools-gated endpoint.
 *
 * GET  -> { activeWorkspace, discoveredProjects, source, connected, editable }
 * POST -> { activeWorkspace: "<path>" }   set an explicit path
 *      -> { action: "browse" }            open a native OS folder dialog
 *    both return { success, activeWorkspace, discoveredProjects, error? }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/authGuard";
import { vscodeBridge, withWorkspaceOwner } from "@/lib/vscodeBridge";
import { isMultiTenantBridge } from "@/lib/deploymentMode";
import { fileToolsEnabled, fileToolsDisabledMessage } from "@/lib/fileToolsGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fileToolsOff() {
  return NextResponse.json(
    { success: false, error: fileToolsDisabledMessage(), code: "FILE_TOOLS_DISABLED" },
    { status: 503 },
  );
}

export async function GET(req: NextRequest) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;
  if (!fileToolsEnabled()) return fileToolsOff();

  /* Every bridge read below is answered from the session belonging to THIS
   * user. Without the wrapper they would all fall through to the single-user
   * path and this endpoint would report the server's own cwd as the signed-in
   * user's "active workspace" — a path on a machine they have never seen,
   * which the selector would then display as theirs. */
  return withWorkspaceOwner(auth.user.id, async () => {
    const connected = vscodeBridge.isConnected();

    /* `workspaceRoot()` throws when nobody is connected, and on a shared
     * deployment that is the ordinary state, not a fault: the user has not
     * opened their editor yet. A 500 here would light up the selector with an
     * error for something that is just "not paired yet", so it is reported as
     * data instead. */
    let activeWorkspace = "";
    let rootError: string | null = null;
    try {
      activeWorkspace = await vscodeBridge.workspaceRoot();
    } catch (err: any) {
      rootError = err?.message || "No workspace is available.";
    }

    return NextResponse.json({
      activeWorkspace,
      discoveredProjects: await vscodeBridge.discoverProjects(),
      source: vscodeBridge.rootSourceLabel(),
      connected,
      /* Whether the caller may change this at all.
       *
       * On a shared host all three of the picker's actions refuse — browsing is
       * the operator's disk, the native dialog opens on a machine with no
       * screen, and an explicit path would point the agent at /app — and
       * `discoverProjects()` deliberately returns an empty array. The client had
       * no way to know that, so it rendered a full folder picker whose every
       * control failed: a Browse button that errored, an empty "discovered
       * projects" list, and a path field that rejected whatever was typed into
       * it. The UI cannot present a choice the server will not honour, so it is
       * told here which of the two shapes to render.
       *
       * Sent as its own field rather than inferred from `discoveredProjects`
       * being empty — a laptop with no package.json folders nearby is also
       * empty, and it can still browse. */
      editable: !isMultiTenantBridge(),
      ...(rootError ? { notice: rootError } : {}),
    });
  });
}

export async function POST(req: NextRequest) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;
  if (!fileToolsEnabled()) return fileToolsOff();

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  return withWorkspaceOwner(auth.user.id, async () => {
    try {
      let targetPath: string | null = null;

      if (body?.action === "browse") {
        /* Refuses outright on a shared deployment — see refuseServerBrowsing.
         * A native folder dialog opens on the SERVER's desktop, which is
         * either nothing at all (headless) or the operator's screen. */
        targetPath = await vscodeBridge.browseForFolder();
        if (!targetPath) {
          // Cancelling the OS dialog is routine, not an error — the selector
          // treats this exact message as a silent no-op.
          return NextResponse.json(
            {
              success: false,
              error: "No folder was selected or browser dialog was closed.",
            },
            { status: 200 },
          );
        }
      } else if (typeof body?.activeWorkspace === "string") {
        /* The assertion is what the `typeof` guard on this very line already
         * proved. It is needed because `body` is `any`: assigning an `any` to a
         * `string | null` variable re-widens it to the declared type instead of
         * narrowing, so without this `targetPath` still reads as possibly-null at
         * the call below and the build fails. */
        targetPath = body.activeWorkspace as string;
      } else {
        return NextResponse.json(
          {
            success: false,
            error: "Provide either { activeWorkspace } or { action: 'browse' }.",
          },
          { status: 400 },
        );
      }

      const activeWorkspace = await vscodeBridge.setActiveWorkspace(targetPath);
      const discoveredProjects = await vscodeBridge.discoverProjects();

      return NextResponse.json({
        success: true,
        activeWorkspace,
        discoveredProjects,
        source: vscodeBridge.rootSourceLabel(),
      });
    } catch (err: any) {
      return NextResponse.json(
        {
          success: false,
          error: err?.message || "Failed to set active workspace.",
        },
        { status: 400 },
      );
    }
  });
}
