# OmniRoute Coder — Windows Desktop App Design

**Status:** DESIGN — awaiting approval. No implementation until this spec is approved.
**Date:** 2026-09-21
**Scope:** Windows-only beta for ~10 testers. Electron wrapping the existing
Next.js standalone server, plus a cloud licence service.

---

## Decisions this spec is built on

These were settled with the user before writing. They are not open for
re-litigation inside the spec.

| # | Decision | Choice |
|---|---|---|
| 1 | Cloud service role | **Licence gate** — app checks in at launch; revoked/invalid accounts refuse to run |
| 2 | Data residency | **Local only** — chats, settings, provider keys stay in the user's app-data folder; cloud holds accounts + licences |
| 3 | Platforms | **Windows only** for the beta |
| 4 | Approach | **Approach A** — Electron wrapping the existing standalone server, spike first (spike PASSED) |
| 5 | Beta scope | **Installer + licence + auto-update** — a working update channel so testers get fixes without a re-sent installer |
| 6 | Offline policy | **Grace period, then refuse** — cache the last good check, keep working offline ~7 days, then block until it can verify |
| 7 | PDF/docx export | **Use Microsoft Edge** — point puppeteer at the Edge present on every Windows machine |
| 8 | Code signing | **Ship unsigned** for the beta with documented SmartScreen click-through |

Prior settled context: hybrid architecture (local app + small cloud service);
better-sqlite3 13.0.3 is a Node-API addon that needs **no** Electron rebuild and
**no** C++ toolchain (verified — see `omniroute-better-sqlite3-napi` memory).

---

## Section 1 — The desktop signal

### Problem

`src/lib/deploymentMode.ts` answers "does this process serve more than one
person?" with `NODE_ENV === "production"`. That has always tracked reality
because every optimised build so far has been a server. A desktop app is the
first optimised build that runs on one person's private disk, so the two facts
come apart. Visible symptom, already seen in the user's screenshot: the
read-only "Working folder" chip, emitted by `api/workspace/route.ts:83` via
`editable: !isMultiTenantBridge()`. The app refuses itself access to its own
machine.

### Design

Introduce an explicit, named deployment kind. `deploymentMode.ts` gains a
two-factor desktop detector and derives the existing booleans from it rather
than from a scattered negation:

```ts
function isDesktopBuild(): boolean {
  if (process.env.OMNIROUTE_DESKTOP?.trim() !== "true") return false;
  return typeof process.versions.electron === "string";
}
```

Two independent facts must both hold. The env var alone is the same trust level
as the existing overrides — fine on a laptop, dangerous if a `.env` file or a
copied systemd unit carried `OMNIROUTE_DESKTOP=true` onto a public server, where
it would unlock every signed-in user's access to the operator's disk. Requiring
the process to genuinely run on Electron's binary makes that mistake
unconfigurable. The `.trim()` is deliberate: this variable is written by a
Windows installer, exactly the CRLF-strict-equality shape that killed the bridge
on AWS.

### What flips on desktop

| Behaviour | Server today | Desktop | Site |
|---|---|---|---|
| Folder picker | read-only chip | real picker + native dialog | `api/workspace/route.ts:83` |
| File tools | require the bridge on | on, with or without VS Code | `fileToolsGate.ts:48-49` |
| `.omniroute` state | hashed per-user dir beside DB | back in the user's repo | `agentContext.ts:345` |
| Reference project | reads via the bridge | reads disk directly | `referenceProject.ts:59` |
| Backups/restore | refuse | work locally | `api/backups/route.ts:64`, `restore/route.ts:85` |
| Agent task errors | swallowed/rewritten | rethrown with real cause | `api/agent/tasks/route.ts:115,466` |

The `fileToolsGate` row is not merely a tenancy flip. In production
`fileToolsEnabled()` returns `isBridgeEnabled()`, so as written a packaged
desktop app would demand the user install and pair the VS Code extension before
editing a single local file. That pairing was correct for a shared host and is
nonsense on a desktop; it needs its own branch.

### What deliberately does NOT flip

- `NODE_ENV` stays `production` — `db.ts`, `authGuard.ts`, `productionGuard.ts`
  read it for reasons that remain correct.
- `assertProductionSafety()` keeps refusing to boot on missing `AUTH_SECRET` or
  on `UPI_AUTO_APPROVE=true`. A desktop build is not an excuse to relax it; the
  spike already proved the app can satisfy it by generating secrets on first run.
- `ssrfGuard.ts:60` is handled in Section 7 on purpose, not folded in here — it
  is a deliberate capability, not a flag side effect.

### Unverified, flagged not asserted

`authGuard.ts:147,161` sets `secure: NODE_ENV === "production"` on the session
cookie, and the desktop serves over `http://127.0.0.1`, not https. Chromium
treats loopback as trustworthy, so the cookie *should* be set and sent — but this
is not confirmed. If wrong, the symptom is sign-in succeeding then being
forgotten on the next page load. **Must be confirmed on the spike before
packaging** (see Verification).

---

## Section 2 — Process and lifecycle

### The Windows shutdown bug (data loss)

`db.ts:522` registers `process.once("SIGTERM", flush)` to checkpoint the WAL
before exit. It works in Docker. **On Windows it never runs**: Node maps
`child.kill("SIGTERM")` onto `TerminateProcess`, which is unhandleable and
unwinds nothing — so neither the checkpoint nor the `exit` handler that closes
the handle fires. Not corruption (SQLite recovers the log on next start), but the
loss comes later, from anything that moves `chat.db` without `chat.db-wal` beside
it. An auto-updater is exactly such a thing. Every quit leaving an unmerged log,
plus an update channel that replaces files, is a data-loss path with a plausible
trigger.

### Fix: synthesise the signal, reuse the existing path

Electron spawns a thin wrapper instead of `server.js` directly. The wrapper
listens on stdin and, on a shutdown line, emits the signal the real handlers
already listen for:

```js
process.stdin.on("data", (chunk) => {
  if (!String(chunk).includes("shutdown")) return;
  process.emit("SIGTERM");                             // runs the real handlers
  setTimeout(() => process.exit(143), 8000).unref();   // watchdog only
});
require("./server.js");
```

Verified ordering: `next/dist/server/lib/start-server.js:389` registers
`process.on('SIGTERM', cleanup)`, whose cleanup drains and ends in
`process.exit(143)`; `db.ts:522` appends its checkpoint to the same event. Node
runs listeners synchronously in registration order; Next's cleanup is async and
yields at its first `await`, so better-sqlite3's synchronous checkpoint completes
first. Nothing in the app changes.

Consequences:
- Electron's `before-quit` must `preventDefault()`, write the line, wait for the
  child's `exit`, then `app.exit()` — with a hard cap of a few seconds so a
  wedged server cannot make the app un-quittable.
- **Exit 143 is a clean shutdown, not a crash.** The build must not show an error
  dialog on every window close.

Why stdin rather than `POST /api/shutdown`: the desktop server listens on
`127.0.0.1`, reachable by every process on the machine and by any web page the
user has open (CORS blocks reading the response, not sending the request). A
shutdown route would be a one-line DoS any website could fire. A stdin pipe is
private by construction.

### Single instance

`app.requestSingleInstanceLock()` before spawning anything; a second launch
focuses the existing window. Without it, both processes hit
`vscodeBridge.ts:1198` EADDRINUSE (the seven "port 20129 in use" lines the user
already saw) and both hold the same SQLite file — the loser throws `SQLITE_BUSY`
after `busy_timeout = 5000`.

### Ports must persist (localStorage survival)

27 `localStorage` call sites, including `auth_token`/`user`
(`page.tsx:2032-2033`, `AuthModal.tsx:216-217`) and the settings/router keys in
`SettingsPanel.tsx`. localStorage is scoped to origin **including port**. A fresh
random port every launch is a fresh origin — the user is signed out and every
setting is gone, every launch. Cookies survive this (port-agnostic);
localStorage does not.

So: pick a preferred port once, record it in `userData`, reuse it, fall back to a
fresh one only if genuinely taken (and persist that too). Same for the bridge
port, which is fixed at 20129 today and collides with `npm run dev`.

### Boot experience

Show a small window immediately; swap to the real UI once `/api/health` passes.
On child exit or timeout, show the last few stderr lines with Retry rather than a
blank frame. A crash later in the session surfaces as an in-window banner with a
restart action.

---

## Section 3 — State and secrets on disk

### `process.cwd()` is the install directory on a packaged app

Six writers assume the run directory is writable:

| What | Site |
|---|---|
| Selected working folder | `vscodeBridge.ts:238,2049` |
| Workspace config | `workspaceConfig.ts:22,89` |
| Generated documents | `api/chat/generate-document/route.ts:39` |
| Generated PDFs | `pdf-generator.ts:66` |
| Legacy provider keys (read) | `credentialManager.ts:40,373` |
| Security-audit root | `securityAuditor.ts:568` |

Installed under `C:\Program Files\`, a standard user gets `EPERM` — the working
folder choice silently fails and is forgotten. Installed per-user under
`%LOCALAPPDATA%\Programs\`, writes succeed and the auto-updater replaces that
tree on every update — folder choice and generated documents vanish each ship.
The second is worse: it works long enough to be trusted.

### Fix: one writable state root

A `stateRoot()` helper reading `OMNIROUTE_STATE_DIR` with `process.cwd()` as the
fallback — same shape `db.ts:49` already got right for `OMNIROUTE_DB_PATH`. The
five writers repoint at it. Every existing deployment behaves exactly as now;
the desktop build gets a legitimate place to write. Optional net (only if the
standalone server resolves `.next` from `__dirname`, not cwd — unverified): also
set the child's `cwd` to the state dir.

### `providers.json` must not ship — asserted, not just excluded

`credentialManager.ts:373` reads it from cwd; `importLegacyProvidersFor()` copies
it into the first account to sign in. If packaged, every tester's first sign-in
silently imports the three live plaintext keys. `electron-builder`'s default glob
invites this. Beyond a deny list (`providers.json`, `.env*`, `user_local.env`,
`chat.db*`, `.omniroute*`), a build step greps the packaged output for those
names and **fails the build** on a hit. A deny list you can forget is not a
control; a failing assertion is.

### Secrets are user data, not config

`crypto.ts:60-80` prefers `CREDENTIALS_SECRET`, then `AUTH_SECRET`, else a
DB-persisted generated secret. But `assertProductionSafety()` refuses to boot
without `AUTH_SECRET`, so the desktop app supplies one and the DB fallback never
runs — making `AUTH_SECRET` the key to every stored provider API key. If that
file is lost/regenerated, every saved key becomes undecryptable. So the two
secret files (as the spike's `persistentSecret()` already writes them) must:
be created before the server spawns; live in the same `userData` folder as
`chat.db`; and be included in whatever the desktop backup feature copies.

### Two smaller calls

- Override `userData` to `%LOCALAPPDATA%`, not Electron's default `%APPDATA%`
  (Roaming) — a roaming profile would try to sync an unbounded chat database.
- The uninstaller leaves `userData` alone by default, with an opt-in checkbox to
  remove it.

---

## Section 4 — Licence client + grace period

### What is already built

`users.tier` and `subscriptions(tier, startDate, endDate, isActive)` with
`/api/subscription` and `/api/admin` on top **is** a licence model. `isActive` is
the revocation switch from decision 1. This section is mostly the client.

### Binding

Account, not machine. A licence means "this email is entitled"; revoking is
flipping `isActive`. No hardware fingerprint (breaks on disk swap / OS upgrade,
support load out of proportion to 10 testers, collects data with no use). A
random per-install UUID is generated on first run and sent with each check,
recorded server-side with a last-seen timestamp — that gives the "running on N
machines" signal without learning anything about any machine.

### Check cadence

On launch, and every 12 hours while open: send the OTP session token, the
install UUID, and the app version. Server answers with a signed entitlement blob
(tier, active flag, optional expiry, server timestamp).

### Signing — and its honest limit

Cache sits on the user's disk; without a signature grace is extended by editing
JSON. Server signs with **Ed25519**, public key compiled into the app, client
verifies before trusting cache. Limit stated plainly: this stops casual
tampering, not determined tampering — an `app.asar` is unpack/repackable, so
anyone editing the app's own code removes the check. Against 10 known testers who
accepted a threat warning, raising the bar from "edit a date in Notepad" to
"patch the binary" is the right spend. Anything stronger is a losing arms race.

### Clock rollback defence

Grace is measured from the last successful check, so trusting the system clock
lets a backwards date extend grace forever. Two cheap rules:
- Elapsed = `max(0, now - lastSuccessAt)`, using the **server's** timestamp from
  the signed blob as `lastSuccessAt` (backwards clock → zero elapsed, not
  negative).
- A launch counter beside the timestamp bounds grace by both 7 days **and** a
  launch count (a frozen clock still runs out).

### Five outcomes

| Outcome | Behaviour |
|---|---|
| Valid | run normally, refresh cache |
| Revoked (server says no) | refuse immediately, ignore cache (explicit revocation outranks cached approval), show contact path |
| Unreachable, within grace | run normally, silent until ~2 days remain, then a quiet indicator |
| Unreachable, past grace | refuse, Retry button, one-sentence explanation |
| Never activated | no grace (grace is only earned by a prior success) |

### Refusal never touches user data

No deletion, no DB lock, no cleared settings. Chats stay in `userData`; a
reinstated user gets everything back. **Open question:** allow data export even
when refused? Flagged as a nicety, not in beta scope unless requested.

### Where the gate lives (the one real decision) — recommend BOTH

- **Electron main**, before the window loads the app: stronger (renderer never
  runs), needs a narrow preload channel to hand the session token from UI to
  main. Makes revocation bite within one launch.
- **`requireUser` in `authGuard.ts`**: less plumbing, reuses a guard on every
  protected route, but in-process JS and easier to defeat. Makes revocation bite
  within one request for a running session.

Together they cost little more than either. Server-side additions are small: an
`installs` table, a signing keypair, one endpoint. No change to the subscription
model.

---

## Section 5 — The cloud licence service

### Built by subtraction

Of 31 API routes, the licence server needs 8: the four `auth/*`, plus `admin`,
`subscription`, `credits`, `health`. The other 23 (chat, agent tasks, production
agent, backups/restore, workspace, credentials, extension endpoints, skills,
models, ollama, gateway debug, both document generators, chat CRUD) are switched
off. Consequence: the bridge never binds, file tools never load, no provider key
is ever stored there, the SSRF surface disappears with the routes that had it.

### Not a fork

Same repo, same schema, same auth, selected by `OMNIROUTE_ROLE=licence`. A solo
maintainer with two diverging auth systems fixes a bug in one copy only. The gate
lives in `middleware.ts` as a **default-deny allowlist** — anything not named is
refused — the same lesson the file-exclusion work learned: a denylist someone
forgets to extend fails open, silently. Paired with a test that enumerates every
`route.ts` and fails the build if one is unclassified, so a new route can't
quietly widen the service.

Honest downside: all 23 routes are still deployed though unreachable, so a gate
bug exposes more than a purpose-built service would. Default-deny + the
enumeration test makes that acceptable at this size. Revisit past beta.

### OTP email (the part that bit us on AWS)

`otpDelivery.ts:203` already checks `RESEND_API_KEY` before SMTP/Gmail — an HTTPS
API is the one path guaranteed to work from a hosted server, and the code is
written and unused. Resend needs a verified domain to send to arbitrary
recipients. That converges with the TLS need: buy a domain (~$10-12/yr), point it
at the box, let Caddy issue the cert (as the runbook already does), verify the
same domain with Resend. One purchase solves TLS and email. Gmail is not *proven*
broken (the documented root cause was CRLF-mangled empty vars, not a blocked
port), but a service whose purpose is to be reachable should not depend on SMTP
from a cloud IP.

### What the $80 covers

10 people, a handful of requests/day, plus serving the installer. Size at a
~$5/mo Lightsail instance (flat price includes transfer, one bill) rather than
EC2 + EBS + Elastic IP — ~15 months runway (figures approximate; current pricing
not checked from here). Serving the ~150 MB installer from the same box is fine;
a few GB/mo of tester downloads fits Lightsail's included transfer. S3/CloudFront
is the grown-up answer and not worth it for 10 people. **Immediate saving:** stop
the existing full-app EC2 instance — it's sized for the whole app and earning
nothing.

The licence server stores no provider keys, never calls a provider, and must NOT
set `OMNIROUTE_ALLOW_PRIVATE_GATEWAY`.

---

## Section 6 — Packaging + update channel

### The database is in your build output (most urgent finding)

`.next/standalone/` currently contains **eight `chat.db*` files (~70 MB)** — the
real database, its WAL, and five backups — swept in because `next build` runs
from the repo root. If packaging copies the standalone folder as-is, every
installer ships the user's conversations AND the app opens a pre-populated
database on first launch, defeating the local-per-user decision. The Section 3
build assertion must also fail on any `chat.db*` in the packaged output.

### Puppeteer breaks export silently → use Edge (decision 7)

`pdf-generator.ts` and `documentRender.ts` call `puppeteer.launch()` with no
`executablePath`, relying on puppeteer's downloaded Chromium (~170 MB) that is
not in the build tree and not traced by Next. On desktop that download doesn't
exist, so the first PDF request throws. **Resolution: point puppeteer at Microsoft
Edge** (present on every Windows machine) via `executablePath`/`channel`. Free,
no size cost, keeps export working.

### Size

Payload: standalone server minus the databases (~76 MB real code) + `.next/static`
(1.8 MB) + `public/` (140 KB) + better-sqlite3 **Windows binary only**. Prebuilds
are 17 MB across 8 platforms; Windows x64 needs one 2 MB file — prune the other
seven for a clean 15 MB saving. Electron ~285 MB uncompressed. NSIS installer
compresses to ~100-150 MB (normal; set the expectation with testers).

### Code signing → unsigned for beta (decision 8)

Unsigned installers trigger SmartScreen's "Windows protected your PC" wall, and a
fresh certificate doesn't clear it immediately (reputation accrues over
downloads). Given the accepted threat warning, ship unsigned and document the
exact path ("More info → Run anyway") in the install instructions. Revisit for
public release.

### Update channel — gated on the licence server, not GitHub

electron-updater reads `latest.yml` + the installer. The standard tutorial hosts
these on public GitHub Releases — exactly what we don't want (downloadable by
anyone, awkward with a private repo). Host the feed on the licence server behind
the same entitlement check: the client sends its session token when polling;
unlicensed/revoked → 403, no download. "Revoked" therefore also means "cut off
from updates". Wrinkle: electron-updater's generic provider wants a static file
server, so the gate is a small authenticating proxy in front of the two files.

---

## Section 7 — Bridge + gateway on desktop

### The local gateway just works

`ssrfGuard.ts` refuses loopback base URLs (`isBlockedAddress` true for `127.0.0.1`
at :71; `localhost` rejected at :118) unless `privateGatewayAllowed()`. On AWS
that refusal was correct and unfixable — the server *is* the fetcher, so
`localhost:20128` meant "EC2 talking to its own loopback". On desktop the server
and gateway are the same machine, so `localhost:20128` genuinely reaches the
user's gateway.

`privateGatewayAllowed()` returns true for a desktop build — gated by the
two-factor `isDesktopBuild()` from Section 1, **never** by a bare
`OMNIROUTE_ALLOW_PRIVATE_GATEWAY=true`, which stays the SSRF primitive it is and
stays off everywhere. Safe here because a desktop server fetches URLs the local
user typed for themselves; the SSRF threat model ("a signed-in stranger makes the
operator's server hit its own metadata endpoint") has no stranger and no shared
operator on a single-user desktop. This is why it's a separate deliberate
capability, not a Section 1 flag flip.

Corollary: the gateway-detection work (browser probe, four reach-states,
container advice) becomes near-moot on desktop — the answer is always good. The
wizard should detect desktop and say "your local gateway is reachable directly"
rather than walking through a tunnel.

### The bridge becomes optional, not load-bearing

Section 1 makes `fileToolsEnabled()` true on desktop without a bridge; file tools
read/write the user's disk directly, which is right when the disk is theirs. The
extension is no longer the file-access mechanism. Keep it as an **enhancement**:
if an editor is paired, route through it for edits in VS Code's undo history and
visible diffs; if not, use the disk directly and never force pairing to get work
done. Needs the port-persistence fix (Section 2). Pairing UI reframes from
"connect to enable file tools" to "connect for live diffs in your editor".

Security floor unchanged: direct disk access is still bounded by the
writable-root and the file-exclusion engine's ALWAYS floor — `.env`,
`providers.json`, `chat.db` remain unreadable to the model. Desktop widens
*where* the tools work, not *what* they may touch.

---

## Verification (must pass before packaging)

1. **`chat.db` exists** at the `[spike] database:` path — the outstanding
   evidence for the SQLite claim. (Spike.)
2. **Cookie survives reload** — sign in, Ctrl+R, still signed in? Settles the
   `secure`-cookie-over-loopback question from Section 1.
3. **Health from renderer** — DevTools console:
   `fetch('/api/health').then(r=>r.text()).then(console.log)`.
4. `process.versions.electron` is truthy inside the spawned server (proves the
   two-factor desktop signal).
5. `tsc --noEmit` clean after each implementation section.
6. Packaged output contains no `chat.db*`, `.env*`, `providers.json`,
   `user_local.env` (build assertion).
7. Edge launches for a PDF export end-to-end.

## Explicitly out of scope for the beta

macOS/Linux builds; hardware-bound licences; code signing; S3/CloudFront for
updates; bundled Chromium; data export on refusal (open question); the
aggressive token-reduction mode (tracked separately as task #53).

## Teardown

`desktop-spike/` is throwaway and can be deleted once these verification items
are confirmed — it has answered its question (the app boots in Electron and
serves the real UI).
