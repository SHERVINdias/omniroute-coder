/**
 * vscode-extension/src/extension.ts
 * ---------------------------------------------------------------------------
 * Wiring. Everything with behaviour lives in pairing.ts, consent.ts,
 * wsClient.ts and fileOps.ts; this file connects them and owns the two pieces
 * of UI — the status bar item and the command palette entries.
 *
 * THE SHAPE OF THE THING
 *
 * Two independent decisions, kept independent:
 *
 *   - Pairing (who): a code from the web app, stored in the OS keychain. Owned
 *     by PairingStore, opened by OmniRouteWSClient.
 *   - Consent (where): per-folder, stored per-machine, prompted for in the
 *     editor. Owned by ConsentStore.
 *
 * A file operation only runs when both are satisfied, and the check for each
 * lives at exactly one choke point: the socket cannot open without a pairing,
 * and `getWorkspaceRoot()` cannot resolve without an approved folder. Adding a
 * new file tool later cannot bypass either, because every tool goes through
 * `getWorkspaceRoot()`.
 */

import * as vscode from "vscode";
import * as path from "path";
import { OmniRouteWSClient, type BridgeStatus } from "./wsClient";
import { ConsentStore } from "./consent";
import { PairingStore, parsePairingInput, normaliseBridgeUrl, isUnencryptedRemote, LOCAL_BRIDGE_URL } from "./pairing";
import {
  listFiles,
  readFile,
  writeFile,
  replaceText,
  getWorkspaceRoot,
  setRootResolver,
  setExclusionConfig,
} from "./fileOps";
import {
  attachConsent,
  isReferenceFolder,
  refListFiles,
  refReadFile,
  refSearch,
  setReferenceRoot,
} from "./referenceOps";

let client: OmniRouteWSClient | null = null;
let consentStore: ConsentStore | null = null;
let pairingStore: PairingStore | null = null;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  consentStore = new ConsentStore(context);
  pairingStore = new PairingStore(context);
  client = new OmniRouteWSClient(context);

  /* ---- file ops resolve their root through consent, from here on ---- */

  setRootResolver(() => resolveConsentedRoot(consentStore!));

  /* The read-only side needs the same consent store, and needs it by
   * reference: consent can be revoked while a chat is open, and every
   * reference read re-checks rather than trusting a decision made at
   * configuration time. */
  attachConsent(consentStore);

  /* ---------------------------- status bar ---------------------------- */

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.command = "omniroute.showMenu";
  context.subscriptions.push(statusBarItem);
  renderStatus({ kind: "unpaired" });
  statusBarItem.show();

  client.onStatusChange(renderStatus);

  /* Re-render when consent changes, so approving a folder while connected
   * flips the status bar from "approve a folder" to the folder name without a
   * reconnect. */
  context.subscriptions.push(
    consentStore.onDidChange(() => renderStatus(client!.currentStatus())),
  );

  /* ------------------------- the RPC dispatcher ------------------------ */

  client.setMessageHandler(async (message: any) => {
    const action = message.action || message.method || message.type;
    const payload = message.payload || message.params || message;

    switch (action) {
      /* ---------------------- workspace discovery ---------------------- */

      case "list_files": {
        const dir = payload?.path || payload?.dir || payload?.directory || "";
        const files = await listFiles(dir);
        return { files };
      }

      /* The bridge probes these on connect to learn the root. Answering with
       * the *approved* root — `getWorkspaceRoot()` now resolves through
       * consent — means an un-approved account learns nothing about the
       * machine, not even the folder name, until a folder is allowed. */
      case "get_workspace_root":
      case "workspace_root":
      case "get_workspace_info":
      case "workspace_info":
      case "get_workspace_path":
        return getWorkspaceRoot();

      /* Only granted folders are reported. An un-consented multi-root
       * workspace looks, to the server, like a window with one approved
       * folder or none — never like a directory listing of the user's disk. */
      case "get_workspace_folders":
      case "list_workspace_folders":
      case "workspace_folders": {
        const granted = consentStore!.grantedFolders();
        if (granted.length === 0) {
          /* Nudge the prompt onto the screen so the user's next attempt works,
           * then report the empty set rather than throwing — a probe is not a
           * file access, and a thrown probe would show up as a scary error. */
          nudgeConsent(consentStore!);
          return { folders: [] };
        }
        return {
          folders: granted.map((folder) => ({
            path: folder.uri.fsPath,
            name: folder.name,
          })),
        };
      }

      /* --------------------------- file access ------------------------- */

      case "read_file": {
        const filePath = payload?.path || payload?.file_path || payload?.filePath;
        if (!filePath) {
          throw new Error("Missing 'path' parameter for read_file operation.");
        }
        return await readFile(filePath);
      }

      case "write_file": {
        const filePath = payload?.path || payload?.file_path || payload?.filePath;
        if (!filePath || payload?.content === undefined) {
          throw new Error(
            "Missing 'path' or 'content' parameter for write_file operation.",
          );
        }
        return await writeFile(filePath, payload.content);
      }

      case "replace_text": {
        const filePath = payload?.path || payload?.file_path || payload?.filePath;
        const oldText =
          payload?.old_text ?? payload?.oldText ?? payload?.search ?? payload?.findText;
        const newText =
          payload?.new_text ?? payload?.newText ?? payload?.replace ?? payload?.replaceText;
        const replaceAll = payload?.replace_all === true || payload?.replaceAll === true;

        if (!filePath || oldText === undefined || newText === undefined) {
          throw new Error(
            "Missing 'path', 'old_text', or 'new_text' parameter for replace_text operation.",
          );
        }
        return await replaceText(filePath, oldText, newText, replaceAll);
      }

      /* ------------------------ access rules ------------------------- */

      /* The server pushes the user's file-exclusion rules here: once when the
       * session opens, and again whenever the settings are saved.
       *
       * IT HAS TO BE A REQUEST, NOT A NOTIFICATION
       *
       * `wsClient.handleMessage` returns early on any frame without an `id`,
       * so an unsolicited push would be silently dropped — the server would
       * believe it had delivered rules the editor never saw, which is the
       * worst of the possible failure modes because it looks like success.
       * Making it an ordinary id-bearing RPC also means the reply can report
       * what actually took effect.
       *
       * Note what this case does NOT do: it never relaxes anything on its own.
       * `setExclusionConfig` recompiles from the credential floor upward, so a
       * malformed or empty payload lands on the built-in defaults rather than
       * on "allow everything". A push that goes wrong costs a read; it cannot
       * open one. */
      case "set_exclusions":
      case "set_file_exclusions": {
        const config = payload?.config ?? payload?.exclusions ?? payload;
        return setExclusionConfig({
          patterns: Array.isArray(config?.patterns) ? config.patterns : [],
          disabledGroups: Array.isArray(config?.disabledGroups)
            ? config.disabledGroups
            : [],
          updatedAt:
            typeof config?.updatedAt === "number" ? config.updatedAt : 0,
        });
      }

      /* ------------------- the read-only reference project ------------- */

      /* Which folder, if any, the assistant may READ as project 1.
       *
       * A request rather than a notification, for the same reason as
       * set_exclusions: a frame without an `id` is dropped by
       * `wsClient.handleMessage`, and a silently dropped push would leave the
       * server believing it had opened a folder the editor never heard of.
       *
       * The reply reports whether the folder is open and approved. It is
       * stored either way — the user configures this in a browser, often
       * before the folder is open here — and nothing becomes readable as a
       * result: every ref_* call re-checks consent at the moment of use. */
      case "set_reference_root":
      case "set_reference_project":
        return setReferenceRoot({
          path: payload?.path ?? null,
          name: payload?.name ?? null,
        });

      case "ref_list_files":
        return await refListFiles({
          dir: payload?.path ?? payload?.dir ?? "",
          depth: payload?.depth,
          pattern: payload?.pattern,
        });

      case "ref_read_file":
        return await refReadFile({
          path: payload?.path ?? payload?.file_path ?? payload?.filePath,
          startLine: payload?.start_line ?? payload?.startLine,
          endLine: payload?.end_line ?? payload?.endLine,
        });

      case "ref_search":
        return await refSearch({
          query: payload?.query ?? payload?.q,
          pattern: payload?.pattern,
          maxResults: payload?.max_results ?? payload?.maxResults,
          caseSensitive: payload?.case_sensitive ?? payload?.caseSensitive,
        });

      /* ------------------------- window control ------------------------ */

      case "reload_window": {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
        return { success: true };
      }

      default:
        throw new Error(`Unsupported message action: ${action}`);
    }
  });

  /* ------------------------------ commands ---------------------------- */

  /* Registered one at a time, through a helper that survives a collision.
   *
   * `registerCommand` THROWS when an id is already taken, and a second copy of
   * this extension is an entirely realistic thing to have installed: the 0.1.0
   * build was packaged before this package.json had a `publisher`, so VS Code
   * filed it under `undefined_publisher.omniroute-vscode`. That is a different
   * extension id from `omniroute.omniroute-vscode`, so installing the new build
   * does not replace the old one — the two sit side by side and both activate,
   * and they both claim `omniroute.connect`, `omniroute.disconnect` and
   * `omniroute.reloadWindow`.
   *
   * As a single `push(a, b, c, …)` that was fatal, because the arguments
   * evaluate left to right: the throw on `omniroute.connect` aborted activate()
   * partway through. The status bar item was already created and shown further
   * up, but `omniroute.showMenu` below was never registered and `bootstrap()`
   * at the end never ran. The result on screen is an OmniRoute item that never
   * connects and answers a click with "command 'omniroute.showMenu' not found"
   * — a dead control with no hint that a stale install is the reason.
   *
   * The duplicate is still the real problem, and `reportDuplicateInstall` below
   * says so in as many words. But a second copy of ourselves should degrade
   * this extension, not decapitate it. */
  const collisions: string[] = [];
  const addCommand = (id: string, handler: (...args: any[]) => any): void => {
    try {
      context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    } catch {
      /* Already owned by the other copy. Its handler stays live, so the command
       * still does something — just not through this instance. */
      collisions.push(id);
    }
  };

  addCommand("omniroute.signIn", () => signInFlow());
  addCommand("omniroute.signOut", () => signOutFlow());
  addCommand("omniroute.connect", () => {
    void client?.connect();
  });
  addCommand("omniroute.disconnect", () => {
    client?.disconnect();
  });
  addCommand("omniroute.approveFolder", async () => {
    const approved = await consentStore!.promptToApproveSomething();
    if (approved && client?.currentStatus().kind !== "connected") {
      void client?.connect();
    }
  });
  addCommand("omniroute.manageFolders", () => manageFoldersFlow());
  addCommand("omniroute.showMenu", () => showMenu());
  addCommand("omniroute.reloadWindow", () => {
    void vscode.commands.executeCommand("workbench.action.reloadWindow");
  });

  void reportDuplicateInstall(context, collisions);

  /* ---------------------------- the deep link -------------------------- */

  /* `vscode://omniroute.omniroute-vscode/pair?code=omr_link_…`, fired by the
   * Connect VS Code panel. This is the whole one-click flow: the browser hands
   * the code straight to the editor, so nobody copies a 100-character string
   * between two windows and nobody discovers halfway through that they pasted
   * it with a trailing newline.
   *
   * `onUri` is in activationEvents, so a link arriving at a window where the
   * extension has not started yet activates it first and is then replayed —
   * without that the first click of a fresh install would silently do nothing. */
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => {
        void handlePairingUri(uri);
      },
    }),
  );

  /* -------------------- migrate, then connect if paired ------------------ */

  void bootstrap(context);
}

/**
 * One-time-per-activation start-up: rescue a legacy token out of settings.json,
 * then connect if there is a pairing to connect with.
 *
 * Ordered so the migration finishes before the connect reads the keychain,
 * otherwise a user upgrading from the settings-based version would have their
 * token found a moment too late and sit "unpaired" until the next launch.
 */
async function bootstrap(context: vscode.ExtensionContext): Promise<void> {
  try {
    const rescued = await pairingStore!.migrateLegacySetting();
    if (rescued) {
      void vscode.window.showInformationMessage(
        "OmniRoute: your pairing code has been moved out of settings.json into secure storage.",
      );
    }
  } catch (err) {
    console.warn("[OmniRoute] legacy migration failed:", err);
  }

  const pairing = await pairingStore!.read();
  if (pairing) {
    void client!.connect();
  } else {
    renderStatus({ kind: "unpaired" });
    void offerFirstRunGuidanceOnce(context);
  }
}

const FIRST_RUN_KEY = "omniroute.introShown";

/**
 * Say something, once, to whoever just installed this.
 *
 * Until now a fresh install was completely silent: the extension activated,
 * found no pairing, set the status bar to "unpaired" and stopped. A status bar
 * item is a thing you notice once you know to look for it, which is exactly the
 * knowledge a first-time user does not have. So the install appeared to do
 * nothing, and "it installed but nothing happened" is indistinguishable from
 * "it installed broken".
 *
 * One notification, one button, never again. The flag is written *before* the
 * await rather than after the user answers, deliberately: dismissing a
 * notification with the X, or closing the window while it is up, has to count
 * as having seen it. Writing afterwards would re-prompt every launch until the
 * user happened to click a button, which turns a helpful nudge into nagging —
 * and nagging is how an extension gets uninstalled.
 */
async function offerFirstRunGuidanceOnce(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (context.globalState.get<boolean>(FIRST_RUN_KEY)) return;
  await context.globalState.update(FIRST_RUN_KEY, true);

  const choice = await vscode.window.showInformationMessage(
    "OmniRoute is installed but not connected yet. Open OmniRoute in your browser, " +
      'go to "Connect VS Code" and click "Open in VS Code" — it pairs this window for you.',
    "Paste a code instead",
  );

  if (choice === "Paste a code instead") {
    void vscode.commands.executeCommand("omniroute.signIn");
  }
}

const DUPLICATE_WARNED_KEY = "omniroute.duplicateInstallWarned";

/**
 * Notice a second copy of this extension and name it.
 *
 * Two installs is not a hypothetical. The 0.1.0 build had no `publisher` in its
 * package.json, so VS Code installed it as `undefined_publisher.omniroute-vscode`;
 * the current build declares `publisher: "omniroute"` and therefore installs as
 * `omniroute.omniroute-vscode`. Different ids, so "install the new version" does
 * not remove the old one — it runs both, and the older one holds settings-based
 * `omniroute.pairingToken` / `omniroute.serverUrl` values that this build has
 * deliberately moved into the OS keychain.
 *
 * Detection is belt and braces. `collisions` is the direct evidence — somebody
 * else already owns a command id we tried to claim — while scanning
 * `extensions.all` catches the case where we activated FIRST and the other copy
 * is the one that broke, which produces the same confusing pair of status bar
 * items with no collision on our side.
 *
 * Shown once per install, because the fix is a deliberate act the user performs
 * in the Extensions view; repeating it every launch would be nagging about
 * something they may have decided to live with.
 */
async function reportDuplicateInstall(
  context: vscode.ExtensionContext,
  collisions: string[],
): Promise<void> {
  const twins = vscode.extensions.all.filter(
    (ext) =>
      ext.id !== context.extension.id &&
      ext.id.toLowerCase().endsWith(".omniroute-vscode"),
  );

  if (twins.length === 0 && collisions.length === 0) return;
  if (context.globalState.get<boolean>(DUPLICATE_WARNED_KEY)) return;
  await context.globalState.update(DUPLICATE_WARNED_KEY, true);

  const names = twins.map((ext) => ext.id).join(", ") || "an older build";

  const choice = await vscode.window.showWarningMessage(
    `Another copy of the OmniRoute extension is installed (${names}). Two copies fight ` +
      "over the same commands, which is why the status bar item can spin forever or report " +
      "a missing command. Uninstall the older one, then reload the window.",
    "Show me",
  );

  if (choice === "Show me") {
    void vscode.commands.executeCommand("workbench.extensions.search", "@installed omniroute");
  }
}

/* ------------------------------ root resolver --------------------------- */

/**
 * The function fileOps calls to learn where it may work.
 *
 * Returns the first approved folder, or throws a message that names the fix.
 * Throwing rather than returning a fallback is the whole point: there is no
 * "default folder" to fall back to, because falling back is precisely the bug
 * — reading a folder nobody approved.
 *
 * THE REFERENCE FOLDER IS SKIPPED, AND THAT IS NOT A DETAIL
 *
 * `activeRoot()` returns the FIRST approved folder in workspace order, and
 * "Add Folder to Workspace" appends — so a user who opens their reference
 * project first and adds the project they are editing second ends up with the
 * read-only folder at position zero. Without this skip the writable root would
 * silently become the folder the whole feature exists to protect, and the
 * first symptom would be an edit landing in the wrong repository.
 */
function resolveConsentedRoot(store: ConsentStore): string {
  const writable = store
    .grantedFolders()
    .map((folder) => path.resolve(folder.uri.fsPath))
    .filter((fsPath) => !isReferenceFolder(fsPath));

  if (writable.length > 0) return writable[0];

  /* Approved folders exist, but every one of them is the reference project.
   * Said plainly, because "no folder is approved" would be a lie that sends
   * the user to approve the folder they have already approved. */
  if (store.grantedFolders().length > 0) {
    throw new Error(
      "The only folder approved for OmniRoute is your read-only reference project, which can " +
        "never be written to. Add the project you want me to edit with File → Add Folder to " +
        "Workspace, in this same window, and approve it.",
    );
  }

  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    throw new Error(
      "No folder is open in the VS Code window connected to your account. " +
        "Open the project you want me to work in (File → Open Folder), then approve it for OmniRoute.",
    );
  }

  nudgeConsent(store);
  throw new Error(
    "OmniRoute is not approved to access this folder yet. A prompt should be visible in VS Code — " +
      'click "Allow", or run "OmniRoute: Approve a Folder for File Access" from the Command Palette.',
  );
}

/** Raise the consent prompt for any undecided open folder, without blocking. */
function nudgeConsent(store: ConsentStore): void {
  for (const folder of store.undecidedFolders()) {
    store.promptInBackground(folder);
  }
}

/* -------------------------------- flows -------------------------------- */

/**
 * Paste a pairing code, store it, connect.
 *
 * The whole point of a single pasted code is that the user does one thing.
 * When the code carries no URL (a bare token) they are asked for the address,
 * prefilled with the local default, because the only person who has a bare
 * token is running everything on one machine.
 */
async function signInFlow(): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: "Connect to OmniRoute",
    prompt: "Paste your pairing code from the OmniRoute “Connect VS Code” panel.",
    placeHolder: "omr_link_…",
    ignoreFocusOut: true,
    password: true,
  });
  if (input === undefined) return;

  let parsed: { url: string | null; token: string };
  try {
    parsed = parsePairingInput(input);
  } catch (err: any) {
    void vscode.window.showErrorMessage(`OmniRoute: ${err?.message || "That pairing code could not be read."}`);
    return;
  }

  await applyPairing(parsed, { confirmFirst: false });
}

/**
 * Handle `vscode://omniroute.omniroute-vscode/pair?code=…`.
 *
 * WHY THIS CONFIRMS BEFORE IT ACTS
 *
 * Any web page can fire a `vscode://` link at the editor — that is what the
 * scheme is for, and the editor has no way to tell which tab it came from. A
 * handler that silently stored whatever token arrived would let a page point
 * this window at a bridge server of its choosing, and the first sign would be
 * an assistant somebody else controls reading the open folder. So the link
 * fills in the code and the person approves the destination, which is the one
 * step that cannot be automated away without giving up the thing it protects.
 *
 * Note what is still true even without the prompt: a hostile pairing grants no
 * file access on its own, because consent is per folder and asked for
 * separately. The confirm is defence in depth, not the only lock.
 */
async function handlePairingUri(uri: vscode.Uri): Promise<void> {
  const route = (uri.path || "").replace(/^\/+/, "").toLowerCase();
  if (route && route !== "pair") {
    void vscode.window.showWarningMessage(
      `OmniRoute: that link asked for “/${route}”, which this extension does not handle.`,
    );
    return;
  }

  /* URLSearchParams is safe for this payload specifically: a pairing code is
   * `omr_link_` followed by base64url, whose alphabet is A–Z a–z 0–9 `-` `_`
   * and therefore contains no `+` for the form decoder to turn into a space. */
  const params = new URLSearchParams(uri.query || "");
  const code = (params.get("code") || params.get("token") || "").trim();

  if (!code) {
    void vscode.window.showErrorMessage(
      "OmniRoute: that link did not carry a pairing code. Open the “Connect VS Code” panel in OmniRoute and try again.",
    );
    return;
  }

  let parsed: { url: string | null; token: string };
  try {
    parsed = parsePairingInput(code);
  } catch (err: any) {
    void vscode.window.showErrorMessage(
      `OmniRoute: ${err?.message || "the pairing code in that link could not be read."}`,
    );
    return;
  }

  await applyPairing(parsed, { confirmFirst: true });
}

/**
 * Store a pairing and bring the connection up.
 *
 * Shared by the paste flow and the deep link so the two cannot drift: the
 * unencrypted-address warning, the folder-approval offer and the auth-failure
 * reset are written once and both entry points get all three.
 *
 * `confirmFirst` is the only difference between them, and it reflects a real
 * difference in provenance — a pasted code was typed into this window by the
 * person sitting at it, a linked one arrived from a browser.
 */
async function applyPairing(
  parsed: { url: string | null; token: string },
  opts: { confirmFirst: boolean },
): Promise<void> {
  let url = parsed.url;
  if (!url) {
    const entered = await vscode.window.showInputBox({
      title: "OmniRoute bridge address",
      prompt: "That code did not include an address. Enter the bridge address OmniRoute showed you.",
      value: LOCAL_BRIDGE_URL,
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          normaliseBridgeUrl(value);
          return null;
        } catch (err: any) {
          return err?.message || "Not a valid bridge address.";
        }
      },
    });
    if (entered === undefined) return;
    try {
      url = normaliseBridgeUrl(entered);
    } catch (err: any) {
      void vscode.window.showErrorMessage(`OmniRoute: ${err?.message}`);
      return;
    }
  }

  /* One dialog, not two. When a linked code also points somewhere unencrypted
   * both facts belong in front of the person at the same moment — stacking two
   * modals trains them to dismiss the second without reading it. */
  const risky = isUnencryptedRemote(url);
  if (opts.confirmFirst || risky) {
    const detail = [
      opts.confirmFirst
        ? "A link from your browser asked to connect this window. Continue only if you just clicked “Open in VS Code” in the OmniRoute web app."
        : "",
      risky
        ? `${url} is unencrypted (ws://) and is not on this machine, so your pairing code would travel in the clear. Continue only if you trust this network.`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const proceed = await vscode.window.showWarningMessage(
      `Connect this editor to OmniRoute at ${describeTarget(url)}?`,
      { modal: true, detail },
      "Connect",
    );
    if (proceed !== "Connect") return;
  }

  await pairingStore!.write({ url, token: parsed.token });
  client!.resetAuthFailure();

  /* Offer to approve a folder right away, while the user is here and paying
   * attention — a connected extension with no approved folder is a valid but
   * confusing state to leave someone in. Non-blocking: the connection proceeds
   * regardless. */
  void offerFolderApprovalOnce();

  await client!.connect();

  /* Only on the link path, and only on success. The paste flow already has the
   * user's attention, and a failure is reported by the client itself — saying
   * "connected" here regardless would be the kind of cheerful lie that makes
   * the status bar untrustworthy. */
  if (opts.confirmFirst && client!.currentStatus().kind === "connected") {
    void vscode.window.showInformationMessage(
      "OmniRoute: this editor is paired and connected.",
    );
  }
}

/** Host of a bridge URL, for a dialog. Falls back to the whole string. */
function describeTarget(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

async function offerFolderApprovalOnce(): Promise<void> {
  if (!consentStore) return;
  if (consentStore.grantedFolders().length > 0) return;
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) return;
  await consentStore.promptToApproveSomething();
}

/**
 * Forget the pairing entirely.
 *
 * Distinct from Disconnect: disconnect closes the socket but keeps the
 * credential, so Connect reopens it; sign-out deletes the credential, so the
 * next connection needs a fresh code. Consent is deliberately NOT cleared —
 * folder approvals are about this machine, not about who is signed in, and a
 * user signing back into the same account should not have to re-approve every
 * folder.
 */
async function signOutFlow(): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    "Sign out of OmniRoute? Your pairing code will be removed from this machine and you will need a new one to reconnect.",
    { modal: true },
    "Sign out",
  );
  if (confirm !== "Sign out") return;

  client?.disconnect({ silent: true });
  await pairingStore!.clear();
  client?.resetAuthFailure();
  renderStatus({ kind: "unpaired" });
  void vscode.window.showInformationMessage("OmniRoute: signed out.");
}

/**
 * Review and revoke folder approvals.
 *
 * Shows open folders first (the ones that matter now) then any remembered
 * decision for folders not currently open, so a folder approved months ago
 * can still be found and revoked.
 */
async function manageFoldersFlow(): Promise<void> {
  if (!consentStore) return;

  const open = vscode.workspace.workspaceFolders || [];
  const openKeys = new Set(open.map((f) => f.uri.fsPath.toLowerCase()));

  type Item = vscode.QuickPickItem & { action: "toggle" | "revoke" | "approve" | "revokeAll"; fsPath?: string; name?: string };
  const items: Item[] = [];

  for (const folder of open) {
    const granted = consentStore.isGranted(folder.uri.fsPath);
    items.push({
      label: `${granted ? "$(check)" : "$(circle-slash)"} ${folder.name}`,
      description: granted ? "approved — select to revoke" : "not approved — select to allow",
      detail: folder.uri.fsPath,
      action: granted ? "revoke" : "approve",
      fsPath: folder.uri.fsPath,
      name: folder.name,
    });
  }

  const remembered = consentStore
    .allRecords()
    .filter((record) => !openKeys.has(record.path.toLowerCase()));
  if (remembered.length > 0) {
    items.push({ label: "Not currently open", kind: vscode.QuickPickItemKind.Separator, action: "toggle" });
    for (const record of remembered) {
      items.push({
        label: `${record.state === "granted" ? "$(check)" : "$(circle-slash)"} ${record.name}`,
        description: `${record.state} — select to forget`,
        detail: record.path,
        action: "revoke",
        fsPath: record.path,
        name: record.name,
      });
    }
  }

  if (items.length > 0) {
    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator, action: "toggle" });
  }
  items.push({ label: "$(trash) Revoke all folder access", action: "revokeAll" });

  const picked = await vscode.window.showQuickPick(items, {
    title: "OmniRoute — folder access",
    placeHolder: "Approved folders can be read and written by the assistant while connected",
  });
  if (!picked) return;

  if (picked.action === "revokeAll") {
    const n = await consentStore.revokeAll();
    void vscode.window.showInformationMessage(
      n > 0 ? `OmniRoute: cleared ${n} folder approval${n === 1 ? "" : "s"}.` : "OmniRoute: nothing to clear.",
    );
    return;
  }

  if (picked.action === "approve" && picked.fsPath) {
    await consentStore.grant(picked.fsPath, picked.name);
    if (client?.currentStatus().kind !== "connected") void client?.connect();
    return;
  }

  if (picked.action === "revoke" && picked.fsPath) {
    await consentStore.revoke(picked.fsPath);
    void vscode.window.showInformationMessage(`OmniRoute: access to “${picked.name}” withdrawn.`);
  }
}

/**
 * The status-bar click target: a context-sensitive action list.
 *
 * What it offers depends on the current state, so the one obviously-useful
 * next step is always near the top instead of buried in a fixed menu.
 */
async function showMenu(): Promise<void> {
  if (!client) return;
  const status = client.currentStatus();

  type Item = vscode.QuickPickItem & { command: string };
  const items: Item[] = [];

  const paired = (await pairingStore!.read()) !== null;

  if (!paired) {
    items.push({ label: "$(key) Connect to OmniRoute…", description: "paste a pairing code", command: "omniroute.signIn" });
  } else {
    switch (status.kind) {
      case "connected":
        items.push({ label: "$(debug-disconnect) Disconnect", description: "keep the pairing, close the socket", command: "omniroute.disconnect" });
        break;
      case "connecting":
      case "retrying":
        items.push({ label: "$(debug-disconnect) Stop trying", command: "omniroute.disconnect" });
        break;
      default:
        items.push({ label: "$(plug) Connect", command: "omniroute.connect" });
        break;
    }
    items.push({ label: "$(folder) Manage folder access…", command: "omniroute.manageFolders" });
    items.push({ label: "$(add) Approve a folder…", command: "omniroute.approveFolder" });
    items.push({ label: "$(key) Re-enter pairing code…", command: "omniroute.signIn" });
    items.push({ label: "$(sign-out) Sign out", description: "remove the pairing from this machine", command: "omniroute.signOut" });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "OmniRoute",
    placeHolder: describeStatus(status, paired),
  });
  if (picked) {
    void vscode.commands.executeCommand(picked.command);
  }
}

/* ------------------------------ status bar ----------------------------- */

/**
 * Render one BridgeStatus as the status-bar item.
 *
 * The connected state additionally reflects consent, because "connected" with
 * no approved folder is a real state the user needs to see and act on — the
 * account is linked but nothing can be read until a folder is allowed.
 */
function renderStatus(status: BridgeStatus): void {
  if (!statusBarItem) return;
  const warnBg = new vscode.ThemeColor("statusBarItem.warningBackground");

  switch (status.kind) {
    case "unpaired":
      statusBarItem.text = "$(key) OmniRoute";
      statusBarItem.tooltip = "OmniRoute is not connected. Click to paste a pairing code.";
      statusBarItem.backgroundColor = undefined;
      break;

    case "connecting":
      statusBarItem.text = "$(sync~spin) OmniRoute";
      statusBarItem.tooltip = `Connecting to ${status.url}…`;
      statusBarItem.backgroundColor = undefined;
      break;

    case "retrying":
      statusBarItem.text = "$(sync~spin) OmniRoute";
      statusBarItem.tooltip =
        `OmniRoute lost the connection and is retrying (attempt ${status.attempt}). ${status.reason}`;
      statusBarItem.backgroundColor = warnBg;
      break;

    case "rejected":
      statusBarItem.text = "$(error) OmniRoute";
      statusBarItem.tooltip = `OmniRoute connection refused: ${status.reason}. Click for options.`;
      statusBarItem.backgroundColor = warnBg;
      break;

    case "connected": {
      const granted = consentStore?.grantedFolders() ?? [];
      if (granted.length === 0) {
        statusBarItem.text = "$(shield) OmniRoute: approve a folder";
        statusBarItem.tooltip =
          "Connected to your OmniRoute account, but no folder is approved yet. Click to allow one.";
        statusBarItem.backgroundColor = warnBg;
      } else {
        const primary = granted[0].name;
        const extra = granted.length > 1 ? ` +${granted.length - 1}` : "";
        statusBarItem.text = `$(check) OmniRoute: ${primary}${extra}`;
        statusBarItem.tooltip =
          `Connected. The assistant can work in: ${granted.map((f) => f.name).join(", ")}. Click for options.`;
        statusBarItem.backgroundColor = undefined;
      }
      break;
    }

    case "offline":
      statusBarItem.text = "$(circle-slash) OmniRoute";
      statusBarItem.tooltip = "OmniRoute is paired but disconnected. Click to connect.";
      statusBarItem.backgroundColor = undefined;
      break;
  }
}

function describeStatus(status: BridgeStatus, paired: boolean): string {
  if (!paired) return "Not connected to any OmniRoute account.";
  switch (status.kind) {
    case "connected":
      return "Connected.";
    case "connecting":
      return "Connecting…";
    case "retrying":
      return `Reconnecting (attempt ${status.attempt}).`;
    case "rejected":
      return status.reason;
    case "offline":
      return "Paired but disconnected.";
    default:
      return "Paired.";
  }
}

export function deactivate(): void {
  client?.disconnect({ silent: true });
  consentStore?.dispose();
  setRootResolver(null);
  /* Drop the reference module's handle on the disposed consent store. Without
   * this it would keep answering `isGranted` from an object whose subscriptions
   * are gone — a stale "yes" is the one answer a consent check must never
   * give. */
  attachConsent(null);
}
