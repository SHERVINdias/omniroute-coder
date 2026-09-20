# VS Code Extension - REQUIRED for Full Deep Cowork Mode

## ✅ Updated Documentation (2026-09-16)

This document clarifies the **VS Code Extension requirement** for OmniRoute Coder's core feature: **Deep Cowork Mode with file editing capabilities**.

---

## 🎯 The Truth About the Architecture

### Two Modes of Operation:

#### 1. **Chat-Only Mode (Without Extension)**
- ❌ AI **CANNOT** read files on user's machine
- ❌ AI **CANNOT** write/edit files on user's machine
- ❌ Deep Cowork Mode file operations **DISABLED**
- ✅ Chat mode still works (conversations, suggestions)
- ✅ Users manually copy/paste code suggestions

#### 2. **Full Deep Cowork Mode (WITH Extension) - THE CORE FEATURE**
- ✅ AI **CAN** read files on user's machine via WebSocket bridge
- ✅ AI **CAN** write/edit files on user's machine
- ✅ Full Deep Cowork Mode with file operations **ENABLED**
- ✅ Real-time workspace synchronization
- ✅ **This is the COMPLETE experience for beta testing**

---

## 🏗️ Architecture Diagram

```
User's Browser (Web UI)
         ↓
    AWS Web App (AI Brain)
         ↓
   WebSocket Bridge
         ↓
VS Code Extension (on user's PC)
         ↓
User's Local File System
```

**Without VS Code Extension:** The bridge is broken → No file access  
**With VS Code Extension:** Complete pipeline → Full Deep Cowork Mode

---

## 📝 What Was Updated

### 1. **User Guide (`src/components/UserGuide.tsx`)**

#### Overview Section - Step 4:
- **OLD:** "VS Code Extension (OPTIONAL)"
- **NEW:** "Install VS Code Extension (REQUIRED)"
- **Description:** "Required for Deep Cowork Mode file editing capabilities"

#### VS Code Extension Section:
- **OLD Title:** "VS Code Extension (OPTIONAL)"
- **NEW Title:** "VS Code Extension (REQUIRED for Full Features)"
- **Warning Banner:** Changed from amber "Optional" to RED "Required for Core Features"
- **Clear messaging:** Without Extension = Chat-only, With Extension = Full Deep Cowork Mode

#### Comparison Table Updated:
**Without Extension:**
- ✅ Chat with AI in browser
- ✅ Get code suggestions
- ✅ View Deep Cowork planning
- ❌ AI CANNOT edit files on your PC
- ❌ Manual copy/paste required

**With Extension (FULL FEATURES):**
- ✅ AI can READ files on your PC
- ✅ AI can WRITE/EDIT files directly
- ✅ Real-time workspace sync
- ✅ Full Deep Cowork Mode enabled
- ✅ WebSocket bridge for file ops

#### Deployment Section:
- Updated "What Requires Local Setup" to emphasize VS Code Extension is **REQUIRED** for full experience
- Clear messaging: Beta testers should install it for the core feature

---

## 🚀 For Beta Testers

### What They Need to Do:

1. **Visit your AWS-hosted website** in their browser (Chrome, Firefox, etc.)
2. **Sign up with email** (receive OTP code)
3. **Install VS Code Extension** on their PC:
   - Download the `.vsix` from the **Connect VS Code** panel in the web app
   - Open VS Code → `Ctrl+Shift+P` → "Install from VSIX"
   - Select the downloaded file
   - Reload VS Code
4. **Pair the extension with their account** — one click:
   - In the web app, open **Connect VS Code** → *Create code*
   - Click **Open in VS Code**. The browser hands the code straight to the
     editor over a `vscode://omniroute.omniroute-vscode/pair` link; VS Code asks
     once for confirmation and pairs itself
   - Nothing is copied, so there is no partial selection and no trailing newline
     to go wrong, and no chance of pasting into the wrong window
   - The code is stored in the OS keychain (Keychain / libsecret / DPAPI), never
     in `settings.json`
   - **Fallback** (Flatpak/Snap installs without a registered protocol handler,
     sandboxed browsers, remote desktop): click *Copy instead*, then in VS Code
     `Ctrl+Shift+P` → **OmniRoute: Connect (paste pairing code)**. The code
     carries the server address inside it, so there is still no URL to type
5. **Approve a folder** when VS Code asks. Nothing is readable until they do, and
   approval is per folder — an unapproved project stays private even with the
   extension running and connected.
6. **Add their provider API keys** in Settings
7. **Start using Deep Cowork Mode** with full file editing capabilities

A fresh install also shows a single notification explaining what to do next, so
someone who installs the extension before ever opening the web panel is not left
staring at an editor that appears to have done nothing. It appears once and is
never repeated, whether it is actioned or dismissed.

### What They Get:

✅ **Full Web Interface** - Beautiful UI with animations  
✅ **Chat with AI** - Multiple providers (AgentRouter, APINeX, OmniRoute AI Gateway)  
✅ **All Modes** - Chat, Cowork, Deep Cowork, Ultra  
✅ **File Editing** - AI can read/write files on their local machine (via extension)  
✅ **Document Export** - PDF, DOCX, Markdown  
✅ **Token Tracking** - Usage stats and monitoring  
✅ **Security** - Email OTP authentication, encrypted credentials  

---

## 🔧 Technical Details

### How the Bridge Works:

1. **User pairs the extension** — either by clicking *Open in VS Code* in the
   web panel (a `vscode://omniroute.omniroute-vscode/pair?code=…` link that the
   extension answers via `registerUriHandler`, confirming before it stores
   anything) or by pasting the code into `OmniRoute: Connect (paste pairing
   code)`. Both routes end in the same place: the code goes into SecretStorage
2. **Extension dials out** to `wss://<your-host>/vscode-bridge`, presenting that
   token. Caddy terminates TLS on 443 and proxies to the bridge on loopback port
   `20129` — that port is **never** opened in the AWS security group
3. **The server validates the token** during the WebSocket upgrade and files the
   socket under the owning user's id. An invalid or revoked token is refused
   with `401` before any session exists
4. **User approves a folder** in VS Code; until then every file request is
   refused, with a message naming the command that grants access
5. **User logs into the web app** in their browser and selects a workspace
6. **AI requests a file operation** (read/write)
7. **The request is routed to that user's own socket** — never to another
   user's editor, and never to the server's own disk
8. **Extension performs the operation** on the local file system, inside the
   approved folder only
9. **Result is sent back** to the web app, and the operation appears in the live
   activity feed in the Connect VS Code panel
10. **AI uses file content** for context/editing

### Security:

- Files **never stored** on the AWS server — the content passes through memory
  to answer one request and is not written to disk
- The WebSocket upgrade is **authenticated per user**. Tokens are `omr_pair_` +
  48 hex characters, stored **hashed (sha256)**, so a stolen database backup
  contains no usable credential
- Tokens **expire after 30 days**, are capped at **5 live per user**, and the
  plaintext is shown **exactly once** at creation
- **Per-folder consent**: access is granted to specific folders the user picks,
  not to the machine. Path traversal out of an approved folder is refused
- **Secrets are refused even inside an approved folder**: `.env*`, `*.pem`,
  `*.key`, `id_rsa`/`id_ed25519`, `credentials.json`, `secrets.*`,
  `providers.json` and `user_local.env` are blocked by a built-in floor that
  **cannot be switched off** and that a `!` rule cannot re-open. Placeholders
  whose whole purpose is to be read (`.env.example`, `.env.production.example`
  and the `.sample`/`.template` spellings) stay readable
- **Everything else is the user's call.** *File access* in the web app sidebar
  owns the rest: seven recommended groups (dependencies, VCS internals, build
  output, lockfiles, binaries and media, local databases, backups and editor
  junk), all on by default and each switchable, plus the user's own
  `.gitignore`-style rules. The panel can check any path against the rules
  before they are saved
- **One rule engine, three enforcement points.** The same matcher runs at the
  server's tool dispatcher, at directory listings and searches, and — from
  extension **v0.3.0** — inside VS Code itself, which is the process actually
  holding the file handle. The server pushes the user's rules over the bridge
  (`set_exclusions`) when the editor connects and again on every save. An
  extension older than 0.3.0 refuses that message and falls back to its
  built-in defaults, so the rules stay enforced server-side but the editor is
  out of step: **reinstall the .vsix after upgrading**
- **A refusal says it is final.** The message names the rule and where to
  change it, because a bare "access denied" reads like a transient failure and
  the model then retries the same file three more ways — each retry a full
  round trip at tens of thousands of input tokens
- **A read-only reference project (extension v0.4.0).** A second folder can be
  opened for reading only — to copy a feature out of one project into another
  without pasting files into chat. It is enforced read-only by shape, not by a
  flag: the reference folder is reachable through three RPCs (`ref_search`,
  `ref_read_file`, `ref_list_files`), none of which can write, and the write
  path resolves its root through a different function that never returns the
  reference. The extension reads it only if the user approved that folder in VS
  Code and re-checks consent on every call. Both projects must be in the **same
  VS Code window** (File → Add Folder to Workspace) — the bridge keeps one live
  editor per account, so two windows on one account evict each other. The same
  file-access exclusion rules apply to the reference folder as to the working
  one, and the writable-root resolver skips the reference folder so it can never
  become the folder being edited
- **Revocation is immediate.** Revoking a code closes the live socket then and
  there, rather than waiting for the next reconnect — which is the case
  revocation exists for (a laptop that is lost, stolen, or lent out)
- User has **full control** — disconnect from VS Code or revoke from the web app
- All file operations are **logged and visible in real time** in both the VS Code
  status bar and the web app's activity feed

---

## 📊 Messaging Strategy

### Clear Positioning:

**Primary Message:**  
"OmniRoute Coder is a web-based AI development environment. For the full Deep Cowork Mode experience with file editing, install the VS Code extension."

**For Marketing:**  
- "Access from any browser - no installation needed"
- "Add the VS Code extension for full file editing capabilities"
- "Complete Deep Cowork Mode - AI that reads and writes your code"

**For Documentation:**  
- "Required for full features" (not "optional")
- "Core feature: Deep Cowork Mode file editing"
- Clear comparison: with vs. without extension

---

## ✅ Files Modified

1. **`src/components/UserGuide.tsx`**
   - Updated Overview section step 4
   - Updated VS Code Extension section title and warning
   - Updated comparison table (without vs. with extension)
   - Updated Deployment section emphasis

---

## 🎯 Next Steps

For successful beta testing, ensure testers understand:

1. ✅ The web app runs in their browser (no installation)
2. ✅ VS Code extension is **REQUIRED** for Deep Cowork Mode file editing
3. ✅ Without extension = Chat-only mode (limited functionality)
4. ✅ With extension = Full experience (the core feature)

**Bottom Line:** The VS Code extension is NOT optional if users want the complete OmniRoute Coder experience. It's the bridge that enables AI to interact with their local file system.

---

## 🛠️ Building the Extension (for the operator)

From the repo root:

```bash
npm run extension:build
```

That compiles the TypeScript, packages a `.vsix`, and copies it into
`public/downloads/` with a manifest the Connect VS Code panel reads. It needs
**no network access and no `@vscode/vsce`** — `scripts/package-vsix.mjs` writes
the zip using only the Node standard library. The individual steps are also
available as `extension:compile`, `extension:package` and `extension:sync`.

Two checks run before anything is published, and both exist because they have
already caught real breakage:

- **Stale build.** The command ids in the packed `package.json` are compared
  against the source. A `.vsix` that predates the current source is refused.
- **Deep-link drift.** `VSCODE_EXTENSION_ID` in
  `src/components/ConnectEditorPanel.tsx` must equal `<publisher>.<name>` from
  `vscode-extension/package.json`. If they disagree, *Open in VS Code* launches
  the editor and then does nothing at all — no error anywhere — so the mismatch
  fails the build instead.

**Bump `version` in `vscode-extension/package.json` whenever the extension
changes.** VS Code will not replace an installed extension with a `.vsix` of the
same version, so testers would keep running the old code while believing they
had updated.

---

## 📞 Support

If beta testers have issues:
- Check User Guide → VS Code Extension section
- **"Nothing happens after installing"** — the extension does not connect on its
  own. Click **Open in VS Code** in the Connect VS Code panel, or paste a code:
  `Ctrl+Shift+P` → **OmniRoute: Connect (paste pairing code)**
- **"I clicked Open in VS Code and nothing happened"** — VS Code is not
  registered as the handler for `vscode://` links on that machine (common with
  Flatpak and Snap installs, and inside sandboxed browsers). Use *Copy instead*
  and the Command Palette. If the palette has no **OmniRoute: Connect (paste
  pairing code)** entry, the installed extension is older than the web app —
  uninstall it and install the current download
- **"It shows `undefined_publisher`"** — that is a build from before `publisher`
  was set (v0.1.0). Deep links cannot work on it at all. Uninstall and reinstall
  from the panel
- **Repeated `socket hang up` in the Extension Host log** — almost always a
  stale install rather than a network or protocol fault. The server now
  authenticates the WebSocket upgrade and destroys unauthenticated sockets,
  which a pre-authentication client reports as exactly this, on every retry.
  Check the installed version against the one the panel offers; if it is older,
  reinstall
- **"Connected, but it cannot see my files"** — no folder has been approved yet.
  `Ctrl+Shift+P` → **OmniRoute: Manage Folder Access**
- **"It stopped working"** — the code may have been revoked or passed its 30-day
  expiry. The Connect VS Code panel shows the status and expiry of each one
- **"The code says it is invalid"** — prefer *Open in VS Code*, which cannot
  mis-copy it; otherwise copy with the panel's button rather than out of a chat
  message, and generate a fresh one if it was already used up
- **"My skill says it did not run"** — a skill that declares file tools
  (`read_file`, `write_file`, `list_files`, `replace_text`) is deliberately held
  back when no editor is paired, and the chat says so underneath the answer. It
  is not broken; connect the editor and send the message again. Holding it back
  is the intended behaviour: a skill whose instructions are "read the file, then
  patch it", injected into a turn with no file access, produces an assistant
  confidently describing edits that never happened
- Check the live activity feed in the web app — refusals are shown there with the
  file and the reason
- Check browser console for connection errors

---

**Last Updated:** 2026-09-20  
**Version:** 6.9 (extension v0.4.0)  
**Status:** Ready for Beta Testing
