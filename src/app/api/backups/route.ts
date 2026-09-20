/**
 * src/app/api/backups/route.ts
 * ---------------------------------------------------------------------------
 * Lists the `.omniroute-backups` folder so the Backups panel can offer a
 * restore.
 *
 * The `?workspace=` query parameter used to be the search root. That made this
 * an unauthenticated directory walk: the caller chose where the server should
 * look, and the response handed back absolute paths and file sizes. The root now
 * comes from `vscodeBridge.workspaceRoot()` like every other file-touching
 * route; the parameter is still accepted so the existing client keeps working,
 * but it is ignored.
 *
 * GET ?workspace=<ignored> -> { backups: [{ path, timestamp, size, originalPath }] }
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { requireUser } from "@/lib/authGuard";
import {
  vscodeBridge,
  withWorkspaceOwner,
  isMultiTenantBridge,
} from "@/lib/vscodeBridge";
import { fileToolsEnabled, fileToolsDisabledMessage } from "@/lib/fileToolsGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Must match the folder the writer uses in /api/backups/restore. */
const BACKUP_DIR = ".omniroute-backups";

/**
 * Said in one place so the list route and the restore route cannot drift into
 * describing the feature differently.
 */
const NO_SERVER_BACKUPS =
  "Server-side backups are not available on this deployment. Your files live on " +
  "your own machine, so there is nothing here to restore from — use the VS Code " +
  "extension's checkpoints, or your own version control, to undo an edit.";

export async function GET(request: NextRequest) {
  const auth = requireUser(request);
  if (!auth.ok) return auth.response;

  if (!fileToolsEnabled()) {
    return NextResponse.json(
      {
        success: false,
        error: fileToolsDisabledMessage(),
        code: "FILE_TOOLS_DISABLED",
      },
      { status: 503 },
    );
  }

  /* On a shared deployment the edits were applied by the user's own editor and
   * `backup()` deliberately wrote nothing — see vscodeBridge.ts. Walking the
   * server's disk here would search the OPERATOR's `.omniroute-backups`, and
   * the two plausible outcomes are both wrong: an empty list that reads as "you
   * have no backups", or somebody else's filenames and sizes. Answer honestly
   * instead. */
  if (isMultiTenantBridge()) {
    return NextResponse.json({
      backups: [],
      available: false,
      notice: NO_SERVER_BACKUPS,
    });
  }

  try {
    /* The request's `workspace` value is deliberately not read. */
    const workspace = path.resolve(
      await withWorkspaceOwner(auth.user.id, () => vscodeBridge.workspaceRoot()),
    );
    const backupsDir = path.join(workspace, BACKUP_DIR);

    try {
      await fs.access(backupsDir);
    } catch {
      return NextResponse.json({ backups: [], available: true });
    }

    const backups = await getBackupFiles(backupsDir, workspace);

    return NextResponse.json({ backups, available: true });
  } catch (error) {
    console.error("Error reading backups:", error);
    return NextResponse.json(
      { error: "Failed to read backups" },
      { status: 500 }
    );
  }
}

async function getBackupFiles(
  dir: string,
  workspace: string,
  backups: any[] = []
): Promise<any[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await getBackupFiles(fullPath, workspace, backups);
    } else if (entry.name.endsWith(".bak")) {
      const stats = await fs.stat(fullPath);

      // Extract original path from backup filename
      // Format: filename.ext.YYYY-MM-DDTHH-MM-SS-mmmZ.bak
      const match = entry.name.match(/^(.+)\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak$/);
      const originalFilename = match ? match[1] : entry.name.replace(/\.\d{4}-\d{2}-\d{2}T.*\.bak$/, "");

      // Extract timestamp from filename
      // Format in filename: YYYY-MM-DDTHH-MM-SS-mmmZ
      // Need to convert to: YYYY-MM-DDTHH:MM:SS.mmmZ
      const timestampMatch = entry.name.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
      const timestamp = timestampMatch
        ? `${timestampMatch[1]}T${timestampMatch[2]}:${timestampMatch[3]}:${timestampMatch[4]}.${timestampMatch[5]}Z`
        : stats.mtime.toISOString();

      // Get relative path from backups directory
      const relativePath = path.relative(path.join(workspace, BACKUP_DIR), dir);
      const originalPath = relativePath
        ? path.join(relativePath, originalFilename).replace(/\\/g, "/")
        : originalFilename;

      backups.push({
        path: fullPath,
        timestamp,
        size: stats.size,
        originalPath,
      });
    }
  }

  return backups;
}
