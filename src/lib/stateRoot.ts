/**
 * src/lib/stateRoot.ts
 * ---------------------------------------------------------------------------
 * One writable directory, resolved in one place.
 *
 * WHY THIS EXISTS
 *
 * Several subsystems write beside the running process — the selected working
 * folder (vscodeBridge, workspaceConfig), generated documents and PDFs — using
 * `process.cwd()` as the base. On a server and on a laptop dev run that is a
 * writable directory, so it worked. On a packaged desktop app it is the install
 * directory, and both Windows install locations break it in opposite ways:
 *
 *   C:\Program Files\...      A standard user gets EPERM. The write fails and
 *                             the choice (e.g. the working folder) is silently
 *                             forgotten on next launch.
 *
 *   %LOCALAPPDATA%\Programs\  Writes succeed, then the auto-updater replaces
 *                             that whole tree on every update — so the folder
 *                             choice and every generated document vanish each
 *                             time a fix ships. Worse, because it works long
 *                             enough to be trusted.
 *
 * So writable state gets its own root, overridable with OMNIROUTE_STATE_DIR
 * (which the desktop app points at Electron's userData folder, the same place
 * chat.db lives). The fallback is process.cwd(), so every existing deployment —
 * server or laptop — behaves exactly as it does today; nothing moves unless the
 * variable is set.
 *
 * WHY A FUNCTION AND NOT A CONST
 *
 * Same reason as deploymentMode.ts: process.env is read at call time. A
 * module-level const is evaluated on first import, which in a bundled server
 * build can be before the runtime environment is fully populated — the value
 * would silently fall back to cwd for reasons nobody would think to look for.
 *
 * WHY IT TRIMS
 *
 * The variable is written by a Windows installer. A trailing \r is the CRLF
 * strict-equality trap that killed the bridge on AWS; a path with a stray \r on
 * the end does not exist, so trim before use.
 */

import path from "path";

/**
 * The base directory for writable app state. Absolute. Callers join their own
 * subdirectory onto it (e.g. `.omniroute`, `generated-documents`).
 */
export function stateRoot(): string {
  const override = process.env.OMNIROUTE_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  return process.cwd();
}

/** Convenience: an absolute path to `sub` inside the state root. */
export function stateDir(...sub: string[]): string {
  return path.join(stateRoot(), ...sub);
}
