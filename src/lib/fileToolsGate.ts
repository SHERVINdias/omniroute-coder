/**
 * src/lib/fileToolsGate.ts
 * ---------------------------------------------------------------------------
 * One switch for everything that touches files.
 *
 * WHY THIS EXISTS
 *
 * Cowork and Deep Cowork edit files. Originally that meant files on whatever
 * machine ran the server — exactly right for a local install, where it is the
 * whole feature, and unacceptable once deployed, where "the workspace" was the
 * operator's disk and every signed-in user would be reading and writing it. The
 * same reasoning applied to the backup and restore routes and the workspace
 * browser, so they share one gate rather than each inventing their own.
 *
 * WHAT CHANGED
 *
 * The bridge now routes every file operation to the calling user's OWN editor,
 * and in multi-tenant mode there is no fallback to the server's disk: a tool
 * call reaches that person's VS Code or it fails. The danger this gate was built
 * to contain is handled at its source, so the gate's job has narrowed to "is
 * this deployment set up to do file work at all".
 *
 * THE DEFAULT
 *
 * Explicit true/false still wins, because an operator who wants the tools off
 * should be able to say so in one variable and be done.
 *
 * Otherwise: on in development, and in production on exactly when the bridge is
 * enabled. That pairing is the point. Leaving the old "off in production" rule
 * in place would mean an operator could enable the bridge, publish the port,
 * hand a tester a pairing code, watch the extension connect — and then have
 * every single tool call answer "this feature is only available in a local
 * install". Every piece of that is configured correctly and the product still
 * does not work, with nothing in the message pointing at the cause. A deployment
 * with no bridge still fails closed, which is the case the rule was written for.
 */

import {
  isBridgeEnabled,
  isDesktopBuild,
  isMultiTenantBridge,
} from "@/lib/deploymentMode";

export function fileToolsEnabled(): boolean {
  const raw = (process.env.OMNIROUTE_ENABLE_FILE_TOOLS ?? "")
    .trim()
    .toLowerCase();

  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;

  if (process.env.NODE_ENV !== "production") return true;

  /* Desktop is a production build, but the disk belongs to the one person
   * using it, so the tools work directly — with or without a paired editor.
   * Without this branch the packaged app would fall through to the server rule
   * below and demand the user pair the VS Code extension before it could edit a
   * single file on their own laptop, which is nonsense on a desktop. The bridge
   * remains an optional enhancement (live diffs in the editor), never a
   * precondition for file work. */
  if (isDesktopBuild()) return true;

  return isBridgeEnabled();
}

/**
 * The message shown wherever a file tool has been switched off.
 *
 * Two messages, because there are two genuinely different situations and one
 * sentence cannot describe both without misleading somebody. On a server the
 * tools are off because the operator has not turned the bridge on, and telling
 * that user to "use a local install" would send them off to install Node and
 * clone a repository they do not have. The local wording is kept for the case it
 * was written for.
 *
 * A function, not a const, for the same reason as everything in
 * deploymentMode.ts: a const is evaluated when the module is first imported,
 * which in a bundled server build can happen before the runtime environment is
 * populated. Getting it wrong here would only produce a misleading sentence
 * rather than a security hole, but a misleading sentence is the entire cost of
 * this function existing, so there is nothing to trade away.
 */
export function fileToolsDisabledMessage(): string {
  return isMultiTenantBridge()
    ? "File tools are switched off on this deployment. They work by connecting to your own VS Code, so nothing is read from or written to this server — ask the operator to enable the editor bridge."
    : "This feature reads and writes files on the machine running the app, so it is only available in a local install. Chat works normally here.";
}

/** A ready-made 503 body for a disabled file-tool route. */
export function fileToolsDisabledResponse(): {
  error: string;
  code: string;
} {
  return {
    error: fileToolsDisabledMessage(),
    code: "FILE_TOOLS_DISABLED",
  };
}
