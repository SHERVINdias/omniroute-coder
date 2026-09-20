/**
 * vscode-extension/src/consent.ts
 * ---------------------------------------------------------------------------
 * Which folders on this machine the assistant is allowed to touch.
 *
 * WHY THIS EXISTS AT ALL
 *
 * Before this file, "what can the assistant read?" had exactly one answer:
 * the first folder open in VS Code, whatever that happened to be. Pairing was
 * a one-time act and the consequences were open-ended — pair once, and every
 * folder you ever open afterwards is readable and writable by a program
 * running on someone else's server, with no indication in the editor that this
 * is the case.
 *
 * That is the wrong shape for a permission. A permission should be granted
 * against a named thing, be visible after the fact, and be withdrawable. So
 * connecting an account and approving a folder are two separate decisions:
 *
 *   - The pairing code says *who you are*. It is issued by the web app and
 *     lives in the OS keychain (see pairing.ts).
 *   - Consent says *where*. It is given per folder, in the editor, and is
 *     remembered on this machine only.
 *
 * A connected extension with no approved folder is a normal, useful state: the
 * account is linked, the status bar says so, and the first file operation
 * fails with an error that says which button to press. Nothing is read in the
 * meantime.
 *
 * WHY globalState AND NOT settings.json
 *
 * `globalState` is per-machine and is not synced (unlike settings, and unlike
 * `globalState` keys explicitly passed to `setKeysForSync`, which this one is
 * not). A folder approval is a statement about *this* computer; syncing it to
 * a laptop that happens to have a folder at the same path would grant access
 * that nobody granted.
 */

import * as path from "path";
import * as vscode from "vscode";

/** Bumped if the record shape changes; unknown versions are ignored, not crashed on. */
const STATE_KEY = "omniroute.folderConsent.v1";

/**
 * Cap on remembered decisions. Approvals are small, but an unbounded map in
 * globalState is a slow leak, and nobody has an opinion about the ten-thousandth
 * folder they opened two years ago. Oldest decisions are dropped first.
 */
const MAX_RECORDS = 200;

export type ConsentState = "granted" | "denied" | "unknown";

interface ConsentRecord {
  /** The path as it was when the decision was made, for display. */
  path: string;
  /** Folder name, so the list is readable without re-resolving paths. */
  name: string;
  state: "granted" | "denied";
  /** ms since epoch. Used for display and for evicting the oldest. */
  at: number;
}

type ConsentMap = Record<string, ConsentRecord>;

/**
 * Normalise a path into a map key.
 *
 * Windows and macOS are case-insensitive, so `C:\Users\Me\Proj` and
 * `c:\users\me\proj` are the same folder and must not be two entries — the
 * user would approve one and be asked again about the other. Linux is
 * case-sensitive and must not be folded, or two genuinely different folders
 * would share one decision.
 */
function keyFor(fsPath: string): string {
  const resolved = path.resolve(fsPath);
  return process.platform === "linux" ? resolved : resolved.toLowerCase();
}

/**
 * Tracks and prompts for per-folder consent.
 *
 * Reads are synchronous (`globalState.get` is in-memory) so the RPC path can
 * check consent without awaiting; writes are async because they persist.
 */
export class ConsentStore {
  private readonly emitter = new vscode.EventEmitter<void>();

  /** Fires whenever a decision is added, changed or removed. */
  readonly onDidChange = this.emitter.event;

  /**
   * Folders already prompted about in this window, so a burst of tool calls
   * against an unapproved folder raises one notification rather than ten.
   */
  private readonly prompted = new Set<string>();

  /**
   * Last timestamp handed out, so `at` is strictly increasing within a run.
   *
   * `Date.now()` returns the same millisecond for approvals made in a tight
   * loop, and equal timestamps make eviction non-deterministic — a stable sort
   * then keeps insertion order, which is the *oldest* first, the opposite of
   * what "drop the oldest" wants. Forcing each stamp past the previous one
   * breaks the tie while staying within a millisecond of the real clock, and
   * because wall-clock time only moves forward the values still sort correctly
   * against records written in an earlier session.
   */
  private lastStamp = 0;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose(): void {
    this.emitter.dispose();
  }

  private stamp(): number {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return this.lastStamp;
  }

  private map(): ConsentMap {
    const raw = this.context.globalState.get<ConsentMap>(STATE_KEY);
    return raw && typeof raw === "object" ? raw : {};
  }

  private async save(map: ConsentMap): Promise<void> {
    const entries = Object.entries(map);
    if (entries.length > MAX_RECORDS) {
      entries.sort((a, b) => b[1].at - a[1].at);
      map = Object.fromEntries(entries.slice(0, MAX_RECORDS));
    }
    await this.context.globalState.update(STATE_KEY, map);
    this.emitter.fire();
  }

  /* ------------------------------- reading ------------------------------ */

  stateOf(fsPath: string): ConsentState {
    const record = this.map()[keyFor(fsPath)];
    return record?.state ?? "unknown";
  }

  isGranted(fsPath: string): boolean {
    return this.stateOf(fsPath) === "granted";
  }

  /** Open workspace folders that have been approved, in workspace order. */
  grantedFolders(): vscode.WorkspaceFolder[] {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.filter((folder) => this.isGranted(folder.uri.fsPath));
  }

  /** Open workspace folders with no decision yet — the ones worth prompting about. */
  undecidedFolders(): vscode.WorkspaceFolder[] {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.filter((folder) => this.stateOf(folder.uri.fsPath) === "unknown");
  }

  /**
   * The folder file operations resolve against, or null.
   *
   * The *first approved* folder, not the first folder. In a multi-root
   * workspace that means approving a second folder does not silently move the
   * assistant out of the first one; the order is the user's own, visible in
   * the explorer.
   */
  activeRoot(): string | null {
    const granted = this.grantedFolders();
    if (granted.length === 0) return null;
    return path.resolve(granted[0].uri.fsPath);
  }

  /** Every remembered decision, newest first. For the management quick pick. */
  allRecords(): ConsentRecord[] {
    return Object.values(this.map()).sort((a, b) => b.at - a.at);
  }

  /* ------------------------------- writing ------------------------------ */

  async grant(fsPath: string, name?: string): Promise<void> {
    const map = this.map();
    const resolved = path.resolve(fsPath);
    map[keyFor(resolved)] = {
      path: resolved,
      name: name || path.basename(resolved) || resolved,
      state: "granted",
      at: this.stamp(),
    };
    this.prompted.delete(keyFor(resolved));
    await this.save(map);
  }

  async deny(fsPath: string, name?: string): Promise<void> {
    const map = this.map();
    const resolved = path.resolve(fsPath);
    map[keyFor(resolved)] = {
      path: resolved,
      name: name || path.basename(resolved) || resolved,
      state: "denied",
      at: this.stamp(),
    };
    await this.save(map);
  }

  /** Forget a decision entirely, so the folder is asked about again. */
  async revoke(fsPath: string): Promise<void> {
    const map = this.map();
    const key = keyFor(fsPath);
    if (!(key in map)) return;
    delete map[key];
    this.prompted.delete(key);
    await this.save(map);
  }

  async revokeAll(): Promise<number> {
    const count = Object.keys(this.map()).length;
    this.prompted.clear();
    await this.context.globalState.update(STATE_KEY, {});
    this.emitter.fire();
    return count;
  }

  /* ------------------------------ prompting ----------------------------- */

  /**
   * Ask about one folder and record the answer.
   *
   * `modal` is for the moments the user is already looking at the editor and
   * waiting — just after pasting a pairing code, or after explicitly running
   * the approve command. It must NOT be used from the RPC path: a modal blocks
   * until answered, and `callTool` on the server gives up after 15 seconds, so
   * the request would fail anyway and the answer would arrive too late to do
   * anything with.
   */
  async promptFor(
    folder: vscode.WorkspaceFolder,
    options: { modal?: boolean } = {},
  ): Promise<boolean> {
    const message = `Allow OmniRoute to read and write files in “${folder.name}”?`;
    const detail =
      `Folder: ${folder.uri.fsPath}\n\n` +
      `The assistant in your OmniRoute browser tab will be able to list, read, create and ` +
      `modify files in this folder while VS Code is open and connected. Files are changed on ` +
      `this computer; nothing is uploaded except the contents of files it opens.\n\n` +
      `Secrets such as .env files, private keys and credentials are never sent, and you can ` +
      `withdraw this at any time from the OmniRoute status bar item.`;

    const choice = await vscode.window.showInformationMessage(
      message,
      { modal: options.modal === true, detail: options.modal ? detail : undefined },
      "Allow",
      "Don't allow",
    );

    if (choice === "Allow") {
      await this.grant(folder.uri.fsPath, folder.name);
      return true;
    }
    if (choice === "Don't allow") {
      await this.deny(folder.uri.fsPath, folder.name);
      return false;
    }
    /* Dismissed. Deliberately NOT recorded as a denial — a notification that
     * timed out or was swept away is not an answer, and recording it as one
     * would mean the folder is never asked about again. */
    return false;
  }

  /**
   * Raise a prompt without waiting for it, at most once per folder per window.
   *
   * This is what the RPC path calls. The tool call itself fails immediately
   * with an explanation; this puts the button that fixes it on screen at the
   * same moment, so the user's next attempt succeeds.
   */
  promptInBackground(folder: vscode.WorkspaceFolder): void {
    const key = keyFor(folder.uri.fsPath);
    if (this.prompted.has(key)) return;
    this.prompted.add(key);
    void this.promptFor(folder, { modal: false });
  }

  /**
   * Let the user pick a folder to approve.
   *
   * With one open folder there is nothing to choose, so it asks about that one
   * directly rather than showing a list of length one.
   */
  async promptToApproveSomething(): Promise<boolean> {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 0) {
      const open = await vscode.window.showWarningMessage(
        "No folder is open in this VS Code window, so there is nothing for OmniRoute to work on.",
        "Open Folder…",
      );
      if (open) {
        await vscode.commands.executeCommand("vscode.openFolder");
      }
      return false;
    }

    if (folders.length === 1) {
      return await this.promptFor(folders[0], { modal: true });
    }

    const picked = await vscode.window.showQuickPick(
      folders.map((folder) => ({
        label: folder.name,
        description: this.isGranted(folder.uri.fsPath) ? "already approved" : undefined,
        detail: folder.uri.fsPath,
        folder,
      })),
      {
        title: "OmniRoute — approve a folder for file access",
        placeHolder: "The assistant will be able to read and write files in the folder you choose",
      },
    );
    if (!picked) return false;
    return await this.promptFor(picked.folder, { modal: true });
  }
}
