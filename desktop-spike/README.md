# Desktop spike — THROWAWAY

This folder exists to answer **one question**, then be deleted:

> Does `.next/standalone/server.js` boot inside Electron on Windows, load
> `better-sqlite3` against Electron's native ABI, and serve the real app in a
> window?

It is not the desktop app. It has no licence check, no auto-update, no
installer, no tray icon and no packaging config, because those are design
decisions and including them would make a failure ambiguous. Delete
`desktop-spike/` once it has reported.

## Run it

From the **project root**, build the app the same way the Docker image does:

```
npm run build
```

Then:

```
cd desktop-spike
npm install
npm run spike
```

`npm run spike` chains two steps, and you can run them individually if one
fails:

| Step | What it does |
|---|---|
| `npm run prepare-standalone` | Copies `.next/static`, `public/` and `better-sqlite3` into the standalone folder — the three things Next does not put there itself (same as the Dockerfile's `COPY` lines) |
| `npm start` | Launches Electron, spawns the server, waits for `/api/health`, opens the window |

Nothing here writes to your main `node_modules` and nothing is compiled, so
`npm run dev` keeps working normally afterwards.

### Why there is no rebuild step

An earlier version of this spike ran `@electron/rebuild` to build
`better-sqlite3` against Electron's ABI. That step was unnecessary and has been
removed.

`better-sqlite3` 13.0.3 is a **Node-API** addon: `"gypfile": false`, no
`bindings` dependency, no `prebuild-install`, no install script, and
`prebuilds/` holds one flat binary per platform — `win32-x64.node`,
`linux-x64.node`, and so on. Node-API is ABI-stable across Node *and* Electron,
so the same `.node` file works in both and there is nothing to rebuild. The
loader in `lib/binding.js` tries `prebuilds/<platform>-<arch>.node` first and
only falls back to `build/Release` if no prebuilt binary is found.

`@electron/rebuild` 3.7.2 misreads this. Its prebuildify detector looks for
`prebuilds/win32-x64/` as a *directory*, whereas v13 ships
`prebuilds/win32-x64.node` as a *file*. All three of its prebuilt-module
detectors miss, so it falls through to compiling from source — which is the
only reason it asked for Visual Studio and a Windows SDK. No C++ toolchain is
required, on this machine or on a tester's.

## What counts as a pass

The terminal prints a banner. **`SPIKE RESULT: SERVER OK`** means the server
booted and answered its health check — but that is only half. The spike passes
only if the window then **renders your actual app and reaches the sign-in
screen**. A blank or white window is a failure, not a pass.

## What to send me

Copy back:

1. The **banner line** (`SPIKE RESULT: ...`).
2. Every **`[server]`** line, especially the boot summary that
   `src/lib/productionGuard.ts` prints — it reports which database opened and
   which settings actually resolved.
3. What the window did: real app, blank, error page, or never appeared.

## Failures I already expect, and what they mean

**Anything at all mentioning `better-sqlite3`**
Send me the message verbatim rather than trying to fix it. Given the Node-API
finding above, the binary should load inside Electron unmodified, so trouble
here would be genuinely surprising and worth understanding before working
around. Do not install a C++ toolchain.

**Electron won't install, or its Node is too old for Next 16**
Check with `npx electron -v`. Next 16 needs Node 20.9+; Electron 35 ships Node
22. If `^35.0.0` won't resolve, try `npm install --save-dev electron@latest`
and tell me which version you got.

**The boot guard refuses to start**
Shouldn't happen — `main.js` generates a proper `AUTH_SECRET` and
`CREDENTIALS_SECRET` on first run and keeps them in Electron's `userData`
folder, which is a rehearsal of what the real app will do. If it still refuses,
the message will say which check failed; send it to me verbatim.

**Unstyled page**
`prepare-standalone` didn't run, or `.next/static` didn't copy.

## Notes

- The database goes to Electron's `userData` folder, **not** your repo, so the
  spike cannot touch your existing `chat.db`. The path is printed at startup.
- A free port is chosen at random, so this won't collide with a dev server on
  3005.
- The server runs as a child process using Electron's own binary with
  `ELECTRON_RUN_AS_NODE=1`. That is deliberate: a packaged app has no system
  `node`, so this is what the real build must do — and it is what puts
  `better-sqlite3` under Electron's ABI, which is the thing being tested.
