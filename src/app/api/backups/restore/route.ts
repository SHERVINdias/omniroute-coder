/**
 * POST /api/backups/restore
 * ---------------------------------------------------------------------------
 * Puts a previously saved backup back over the file it came from.
 *
 * WHAT WAS WRONG
 *
 * This route was an unauthenticated arbitrary file write — the most serious
 * hole in the app. Three separate failures compounded:
 *
 *  1. No authentication at all.
 *  2. The containment check compared the caller's `backupPath` against the
 *     caller's own `workspace` value. Both came from the same request body, so
 *     `{"workspace": "C:\\", "backupPath": "C:\\anything"}` satisfied it
 *     trivially. It proved the two strings agreed, not that either was safe.
 *  3. `originalPath` was never checked at all before `path.join(workspace,
 *     originalPath)`, so `../../../../Windows/System32/drivers/etc/hosts`
 *     escaped whatever the first check had established.
 *
 * Net effect: any unauthenticated caller could write arbitrary content to any
 * path the Node process could reach.
 *
 * HOW IT IS FIXED
 *
 * The workspace root now comes from the server (vscodeBridge.workspaceRoot(),
 * i.e. OMNIROUTE_WORKSPACE_ROOT or the detected VS Code folder) and the body's
 * `workspace` is ignored entirely. Both paths are resolved and then checked
 * with path.relative, which is the containment test that actually holds:
 * a contained path yields a relative result that neither starts with ".." nor
 * is absolute. The backup must additionally sit inside the backup directory,
 * so this route can only ever restore things it wrote.
 *
 * It is also gated behind the same file-tools switch as Cowork, because it
 * touches the server's own disk and that only makes sense in a local install.
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { requireUser } from "@/lib/authGuard";
import {
  vscodeBridge,
  BACKUP_DIR,
  withWorkspaceOwner,
  isMultiTenantBridge,
} from "@/lib/vscodeBridge";
import { fileToolsEnabled } from "@/lib/fileToolsGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * True when `child` is inside `parent`.
 *
 * path.relative is the right primitive: a prefix string comparison says
 * "C:\workspace-evil" starts with "C:\workspace", which is a different
 * directory entirely.
 */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function POST(request: NextRequest) {
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;

  if (!fileToolsEnabled()) {
    return NextResponse.json(
      {
        error:
          "File restore works on the machine running this app, so it is only available in a local install.",
        code: "FILE_TOOLS_DISABLED",
      },
      { status: 503 },
    );
  }

  /* This handler copies a file from <root>/.omniroute-backups back over a file
   * under <root>, using the SERVER's filesystem for both halves. On a shared
   * deployment neither half is the user's: no backup was ever written there
   * (see vscodeBridge.backup), and the only writable tree is the operator's
   * own. A restore that "succeeds" by overwriting a file in the container is
   * strictly worse than one that refuses, so it refuses. */
  if (isMultiTenantBridge()) {
    return NextResponse.json(
      {
        error:
          "Restore is not available on this deployment. Your files are on your own " +
          "machine, so this server has no backup of them — use the VS Code " +
          "extension's checkpoints or your version control to undo an edit.",
        code: "BACKUPS_UNAVAILABLE",
      },
      { status: 503 },
    );
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;

    const backupPath =
      typeof body.backupPath === "string" ? body.backupPath.trim() : "";
    const originalPath =
      typeof body.originalPath === "string" ? body.originalPath.trim() : "";

    if (!backupPath || !originalPath) {
      return NextResponse.json(
        { error: "backupPath and originalPath are required." },
        { status: 400 },
      );
    }

    /* The root the server decided on. The request does not get a say. */
    const root = path.resolve(
      await withWorkspaceOwner(guard.user.id, () =>
        vscodeBridge.workspaceRoot(),
      ),
    );
    const backupRoot = path.join(root, BACKUP_DIR);

    const resolvedBackup = path.resolve(root, backupPath);
    const resolvedOriginal = path.resolve(root, originalPath);

    /* Restoring may only read from the backup directory. Without this a caller
     * could name any readable file as the "backup" and copy it into the
     * workspace. */
    if (!isInside(backupRoot, resolvedBackup)) {
      return NextResponse.json(
        { error: "That backup is not inside this workspace's backup folder." },
        { status: 403 },
      );
    }

    /* And may only write inside the workspace. */
    if (!isInside(root, resolvedOriginal)) {
      return NextResponse.json(
        { error: "The target file is outside the workspace." },
        { status: 403 },
      );
    }

    /* Never restore over the backup store itself. */
    if (isInside(backupRoot, resolvedOriginal)) {
      return NextResponse.json(
        { error: "Cannot restore over the backup folder." },
        { status: 403 },
      );
    }

    let backupContent: string;
    try {
      backupContent = await fs.readFile(resolvedBackup, "utf-8");
    } catch {
      return NextResponse.json(
        { error: "That backup file could not be read." },
        { status: 404 },
      );
    }

    await fs.mkdir(path.dirname(resolvedOriginal), { recursive: true });

    /* Save what is there now before overwriting it, so a restore is itself
     * undoable. A missing file is normal — the backup may predate it. */
    let hadExistingFile = false;
    try {
      const currentContent = await fs.readFile(resolvedOriginal, "utf-8");
      hadExistingFile = true;

      const timestamp = new Date()
        .toISOString()
        .replace(/:/g, "-")
        .replace(/\./g, "-");

      const relDir = path.dirname(path.relative(root, resolvedOriginal));
      const targetDir = path.join(backupRoot, relDir);
      await fs.mkdir(targetDir, { recursive: true });

      await fs.writeFile(
        path.join(
          targetDir,
          `${path.basename(resolvedOriginal)}.${timestamp}.bak`,
        ),
        currentContent,
        "utf-8",
      );
    } catch {
      /* No existing file, or it is not UTF-8 text. Either way there is nothing
       * meaningful to preserve and the restore should still proceed. */
    }

    await fs.writeFile(resolvedOriginal, backupContent, "utf-8");

    return NextResponse.json({
      success: true,
      message: hadExistingFile
        ? "File restored. The previous version was backed up first."
        : "File restored.",
      createdBackup: hadExistingFile,
    });
  } catch (error) {
    console.error(
      "[backups/restore] failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: "Failed to restore backup" },
      { status: 500 },
    );
  }
}
