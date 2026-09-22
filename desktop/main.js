/**
 * desktop/main.js
 * ---------------------------------------------------------------------------
 * The production Electron main process for OmniRoute Coder on Windows.
 *
 * This is NOT the throwaway spike (desktop-spike/). It is the real thing:
 * single-instance lock, ports that survive across launches, first-run secret
 * generation, a graceful shutdown that actually checkpoints the database on
 * Windows, a boot window, and the launch-time licence gate.
 *
 * WHAT IT SPAWNS, AND WHY LIKE THAT
 *
 * It spawns Electron's own binary with ELECTRON_RUN_AS_NODE=1, running
 * desktop/server-wrapper.js, which in turn requires the standalone Next server.
 * A packaged app has no system `node`, so the app must run the server on
 * Electron's bundled Node — which is also what puts better-sqlite3 under
 * Electron's ABI (a Node-API addon, so it just loads; see the napi memory). The
 * wrapper exists so the parent can trigger a graceful shutdown over stdin, which
 * is the only way to run db.ts's WAL checkpoint on Windows (SIGTERM is
 * unhandleable there).
 */

"use strict";

const { app, BrowserWindow, shell, dialog, Menu, net } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const { resolvePort } = require("./ports");
const { ensureSecrets } = require("./secrets");
const licence = require("./licence");

const IS_DEV = !app.isPackaged;
const SERVER_WRAPPER = path.join(__dirname, "server-wrapper.js");

/* The standalone server lives under desktop/payload/ in a packaged build (put
 * there by desktop/prepare.mjs, minus the database and secrets), and under the
 * repo's own .next/standalone when running unpackaged against a dev build. Try
 * the payload first, fall back to the repo. */
/* The standalone server is bundled as extraResources (see electron-builder.yml),
 * which copies it verbatim to <install>/resources/payload — NOT under files:,
 * because electron-builder prunes node_modules inside files: and would strip the
 * server's own dependencies, making the packaged server exit 1 on a require it
 * can no longer resolve. Resolve the packaged location first (process.resourcesPath),
 * then the dev payload (desktop/payload), then the repo build. */
const PACKAGED_PAYLOAD = path.join(process.resourcesPath, "payload", ".next", "standalone");
const DEV_PAYLOAD = path.join(__dirname, "payload", ".next", "standalone");
const REPO_STANDALONE = path.join(__dirname, "..", ".next", "standalone");
function firstStandaloneWithServer(...dirs) {
  for (const dir of dirs) {
    try {
      if (fs.existsSync(path.join(dir, "server.js"))) return dir;
    } catch {
      /* unreadable — try the next */
    }
  }
  return dirs[dirs.length - 1];
}
const STANDALONE = firstStandaloneWithServer(
  app.isPackaged ? PACKAGED_PAYLOAD : DEV_PAYLOAD,
  REPO_STANDALONE,
);
const SERVER_ENTRY = path.join(STANDALONE, "server.js");

const BRIDGE_PREFERRED_PORT = 20129;
const BOOT_TIMEOUT_MS = 90_000;

/* Licence enforcement master switch.
 *
 * false: the app runs with NO key prompt and NO revoke — anyone who installs the
 *        .exe can use it. Auto-updates and everything else are unaffected.
 * true:  the tester must enter a valid key at first launch, and a revoked key
 *        stops the app (the full licence-key model).
 *
 * Set to true and rebuild (npm run dist) to re-enable revocation later — the
 * cloud licence server, keys, and all the wiring remain in place; this is the
 * only line that has to change. */
const LICENCE_ENABLED = false;

/* userData is forced under %LOCALAPPDATA% (Local), NOT the default %APPDATA%
 * (Roaming): a roaming profile on a managed machine would try to sync a chat
 * database that grows without bound. Must be set before app is ready. */
if (process.platform === "win32" && process.env.LOCALAPPDATA) {
  app.setPath(
    "userData",
    path.join(process.env.LOCALAPPDATA, "OmniRouteCoder"),
  );
}

let serverProcess = null;
let mainWindow = null;
let bootWindow = null;
let shuttingDown = false;
let browserProxyPort = null;

/* ------------------------------------------------------- browser proxy -- */

/**
 * A tiny loopback proxy that forwards requests through Electron's `net`
 * (Chromium's network stack). Chromium carries a real browser TLS fingerprint,
 * so providers behind Cloudflare bot protection that block Node's fetch — like
 * justwoker.icu — let these requests through. The server child is told this
 * proxy's URL (OMNIROUTE_BROWSER_PROXY) and, in src/lib/upstreamRequest.ts, only
 * retries through it when a provider actually returns a Cloudflare block. So
 * working providers never touch it.
 *
 * The real target rides in the x-omni-proxy-target header. Method, headers and
 * body are forwarded; the response (including SSE streams) is piped straight
 * back. content-encoding/length are dropped because Electron's net already
 * decodes the body.
 */
function startBrowserProxy() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const target = req.headers["x-omni-proxy-target"];
      if (!target || typeof target !== "string") {
        res.writeHead(400);
        res.end("missing target");
        return;
      }
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        let preq;
        try {
          preq = net.request({ method: req.method || "GET", url: target, redirect: "follow" });
        } catch {
          res.writeHead(502);
          res.end("bad target");
          return;
        }
        /* Chromium's net stack is far stricter than Node's fetch: it rejects the
         * whole request with ERR_INVALID_ARGUMENT if ANY header value contains a
         * control character (a trailing newline on a pasted API key is the
         * classic one) — where fetch would silently tolerate it. So rather than
         * forward every auto-header undici attaches, we forward only the ones a
         * provider actually reads, and we sanitise each value: drop CR/LF/other
         * control chars and trim. This is what makes justwoker (Cloudflare) work
         * without tripping ERR_INVALID_ARGUMENT. */
        const ALLOW = new Set([
          "content-type",
          "authorization",
          "x-api-key",
          "anthropic-version",
          "anthropic-beta",
          "openai-organization",
          "openai-project",
          "http-referer",
          "x-title",
        ]);
        const clean = (val) =>
          String(Array.isArray(val) ? val.join(",") : val)
            /* strip anything below 0x20 (CR, LF, tab, etc.) and DEL */
            .replace(/[\x00-\x1f\x7f]/g, "")
            .trim();
        for (const [k, v] of Object.entries(req.headers)) {
          if (!ALLOW.has(k.toLowerCase())) continue;
          const value = clean(v);
          if (!value) continue;
          try { preq.setHeader(k, value); } catch { /* skip header Chromium refuses */ }
        }
        /* The point of this proxy is a real browser fingerprint, so present
         * real-browser headers rather than undici's Node ones. Chromium supplies
         * the TLS/JA3 fingerprint Cloudflare checks; these make the HTTP layer
         * match. We do NOT forward the incoming user-agent (it was Node's). */
        try {
          preq.setHeader(
            "user-agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          );
          preq.setHeader("accept", "*/*");
          preq.setHeader("accept-language", "en-US,en;q=0.9");
        } catch { /* headers optional */ }
        preq.on("response", (presp) => {
          const outHeaders = {};
          for (const [k, v] of Object.entries(presp.headers || {})) {
            const lk = k.toLowerCase();
            if (lk === "content-encoding" || lk === "content-length" || lk === "transfer-encoding") continue;
            outHeaders[k] = v;
          }
          res.writeHead(presp.statusCode || 502, outHeaders);
          presp.on("data", (d) => res.write(d));
          presp.on("end", () => res.end());
          presp.on("error", () => { try { res.end(); } catch { /* already ended */ } });
        });
        preq.on("error", (e) => {
          const msg = String(e && e.message ? e.message : e);
          console.error(`[desktop] browser proxy error for ${target}: ${msg}`);
          try { res.writeHead(502); res.end(msg); } catch { /* already sent */ }
        });
        if (body.length) preq.write(body);
        preq.end();
      });
    });
    server.on("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => {
      browserProxyPort = server.address().port;
      console.log(`[desktop] browser proxy (Chromium) on 127.0.0.1:${browserProxyPort}`);
      resolve(browserProxyPort);
    });
  });
}

/* --------------------------------------------------------------- utilities -- */

function banner(text) {
  console.log(`\n${"=".repeat(72)}\n${text}\n${"=".repeat(72)}\n`);
}

async function waitForHealth(port) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastError = "no response yet";
  while (Date.now() < deadline) {
    if (serverProcess && serverProcess.exitCode !== null) {
      return { ok: false, reason: `server exited with code ${serverProcess.exitCode}` };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { ok: true };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, reason: `timed out after ${BOOT_TIMEOUT_MS / 1000}s — last: ${lastError}` };
}

/* ------------------------------------------------------------------ server -- */

async function startServer() {
  const userData = app.getPath("userData");
  const port = await resolvePort(userData, "app");
  const bridgePort = await resolvePort(userData, "bridge", BRIDGE_PREFERRED_PORT);
  const secrets = ensureSecrets(userData);

  const env = {
    ...process.env,

    /* Run Electron's binary as plain Node so the child is the server, not a
     * second Electron app. */
    ELECTRON_RUN_AS_NODE: "1",

    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",

    /* The two-factor desktop signal. deploymentMode.ts also checks
     * process.versions.electron, which is present because we spawn Electron's
     * own binary — so this cannot be faked onto a plain-Node server. */
    OMNIROUTE_DESKTOP: "true",

    /* The cloud licence server, so the in-app refresh route (src/lib/licence.ts)
     * reaches the same place desktop/licence.js does. */
    OMNIROUTE_LICENCE_URL: "https://omniroute-licence.duckdns.org",

    /* The Chromium fallback proxy for Cloudflare-blocked providers (justwoker,
     * etc.). Only set on desktop; upstreamRequest.ts uses it solely as a retry
     * when a provider returns a Cloudflare block, so working providers are
     * untouched. */
    ...(browserProxyPort
      ? { OMNIROUTE_BROWSER_PROXY: `http://127.0.0.1:${browserProxyPort}` }
      : {}),

    /* All writable state — chat.db, the two secrets, the workspace choice,
     * generated documents — goes here, where the app is allowed to write and
     * the updater does not wipe it. */
    OMNIROUTE_STATE_DIR: userData,
    OMNIROUTE_DB_PATH: path.join(userData, "chat.db"),

    AUTH_SECRET: secrets.AUTH_SECRET,
    CREDENTIALS_SECRET: secrets.CREDENTIALS_SECRET,

    /* The editor bridge — an optional enhancement on desktop (live diffs in VS
     * Code). Enabled so the extension can connect; it binds 127.0.0.1 only and
     * is auth-gated by the pairing token, so on a single-user machine it exposes
     * nothing. File tools work with or without it. */
    OMNIROUTE_BRIDGE_ENABLE: "true",
    OMNIROUTE_BRIDGE_HOST: "127.0.0.1",
    OMNIROUTE_BRIDGE_PORT: String(bridgePort),

    /* Where server-wrapper.js finds the real server. */
    OMNIROUTE_SERVER_ENTRY: SERVER_ENTRY,
  };

  /* A log file in userData so a packaged build (which has no visible console)
   * still records why the server started or crashed. This is the file to read
   * when the app shows "server stopped unexpectedly". */
  const logPath = path.join(userData, "server.log");
  const log = (line) => {
    try {
      fs.appendFileSync(logPath, line);
    } catch {
      /* best effort */
    }
  };
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(
      logPath,
      `\n===== launch ${new Date().toISOString()} =====\n` +
        `execPath: ${process.execPath}\n` +
        `wrapper:  ${SERVER_WRAPPER}\n` +
        `entry:    ${SERVER_ENTRY}\n` +
        `cwd:      ${STANDALONE}\n` +
        `port:     ${port}  bridge: ${bridgePort}\n\n`,
    );
  } catch {
    /* best effort */
  }

  console.log(`[desktop] userData: ${userData}`);
  console.log(`[desktop] db:       ${env.OMNIROUTE_DB_PATH}`);
  console.log(`[desktop] port:     ${port}  bridge: ${bridgePort}`);
  console.log(`[desktop] log:      ${logPath}`);

  serverProcess = spawn(process.execPath, [SERVER_WRAPPER], {
    cwd: STANDALONE,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  serverProcess.on("error", (err) => {
    log(`[spawn error] ${err && err.stack ? err.stack : err}\n`);
  });
  serverProcess.stdout.on("data", (d) => {
    process.stdout.write(`[server] ${d}`);
    log(`[out] ${d}`);
  });
  serverProcess.stderr.on("data", (d) => {
    process.stderr.write(`[server] ${d}`);
    log(`[err] ${d}`);
  });

  serverProcess.on("exit", (code, signal) => {
    log(`[exit] code=${code} signal=${signal}\n`);
    /* 143 == clean SIGTERM shutdown. Anything else while we are not shutting
     * down is a real crash and the user should see it, not a blank window. */
    if (shuttingDown || code === 143) return;
    showServerCrashed(code, signal);
  });

  return port;
}

/** Ask the server to shut down gracefully, then wait for it to exit. */
function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess || serverProcess.exitCode !== null) return resolve();
    const done = () => resolve();
    serverProcess.once("exit", done);
    try {
      serverProcess.stdin.write("shutdown\n");
    } catch {
      serverProcess.kill();
      return resolve();
    }
    /* Hard cap so a wedged server cannot make the app un-quittable. */
    setTimeout(() => {
      if (serverProcess && serverProcess.exitCode === null) serverProcess.kill();
      resolve();
    }, 9000);
  });
}

/* ------------------------------------------------------------------ windows -- */

function makeMenu() {
  /* Electron's default menu links to electronjs.org under Help and exposes
   * devtools reload items that look alarming in a shipped app. Replace it with
   * a minimal, honest one. */
  const template = [
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showBootWindow() {
  bootWindow = new BrowserWindow({
    width: 420,
    height: 240,
    frame: false,
    resizable: false,
    backgroundColor: "#0b0b0f",
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  bootWindow.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#e4e4e7;font:15px system-ui">
           <div style="text-align:center">
             <div style="font-weight:600;margin-bottom:8px">OmniRoute Coder</div>
             <div style="opacity:.6">Starting…</div>
           </div>
         </body>`,
      ),
  );
}

function openMainWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#0b0b0f",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.once("ready-to-show", () => {
    if (bootWindow) { bootWindow.close(); bootWindow = null; }
    mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

function showServerCrashed(code, signal) {
  const target = mainWindow || bootWindow;
  const message =
    `The OmniRoute server stopped unexpectedly (code ${code}, signal ${signal}).`;
  if (target && !target.isDestroyed()) {
    dialog.showMessageBox(target, {
      type: "error",
      title: "OmniRoute Coder",
      message,
      buttons: ["Restart", "Quit"],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) app.relaunch();
      app.exit(1);
    });
  } else {
    banner(`SERVER CRASHED — ${message}`);
    app.exit(1);
  }
}

function showLicenceRefusal(reason) {
  const target = bootWindow || mainWindow;
  const html =
    `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#e4e4e7;font:15px system-ui">
       <div style="max-width:420px;text-align:center;padding:24px">
         <div style="font-weight:600;margin-bottom:10px">Licence check failed</div>
         <div style="opacity:.7;line-height:1.5">${reason}</div>
       </div>
     </body>`;
  if (target && !target.isDestroyed()) {
    target.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  } else {
    banner(`LICENCE REFUSED — ${reason}`);
    app.exit(1);
  }
}

/* --------------------------------------------------------- licence gate -- */

/** The key-entry form, rendered as a data: URL. `error` shows a red note. */
function keyFormHtml(error) {
  const note = error
    ? `<div style="color:#f87171;margin-top:12px;font-size:13px">${error}</div>`
    : "";
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#e4e4e7;font:15px system-ui">
         <form style="max-width:420px;width:80%;text-align:center;padding:24px"
               onsubmit="location.href='https://omni-activate/?key='+encodeURIComponent(document.getElementById('k').value);return false;">
           <div style="font-weight:600;font-size:18px;margin-bottom:6px">Activate OmniRoute Coder</div>
           <div style="opacity:.6;margin-bottom:18px">Enter the licence key you were given.</div>
           <input id="k" autofocus placeholder="OMNI-XXXX-XXXX-XXXX"
                  style="width:100%;padding:12px;border-radius:10px;border:1px solid #333;background:#151519;color:#fff;text-align:center;letter-spacing:1px;font-size:16px" />
           <button type="submit"
                   style="margin-top:14px;width:100%;padding:12px;border:0;border-radius:10px;background:#f59e0b;color:#111;font-weight:600;cursor:pointer">Activate</button>
           ${note}
         </form>
       </body>`,
    )
  );
}

/**
 * Show the key-entry window and resolve true once a valid key activates, false
 * if the user gives up (closes the window). No IPC/preload: the form navigates
 * to a sentinel https URL carrying the key, which we intercept with
 * will-navigate — so the renderer stays fully sandboxed.
 */
function promptForKey(userDataDir) {
  return new Promise((resolve) => {
    const win = bootWindow && !bootWindow.isDestroyed()
      ? bootWindow
      : new BrowserWindow({
          width: 480,
          height: 360,
          resizable: false,
          backgroundColor: "#0b0b0f",
          webPreferences: { contextIsolation: true, nodeIntegration: false },
        });

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    win.webContents.on("will-navigate", async (event, url) => {
      if (!url.startsWith("https://omni-activate/")) return;
      event.preventDefault();
      let key = "";
      try {
        key = new URL(url).searchParams.get("key") || "";
      } catch {
        /* malformed — treat as empty */
      }
      win.loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(
            `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#e4e4e7;font:15px system-ui">Checking…</body>`,
          ),
      );
      const result = await licence.activateWithKey(userDataDir, key);
      if (result.ok) {
        finish(true);
      } else {
        win.loadURL(keyFormHtml(result.reason));
      }
    });

    win.on("closed", () => finish(false));
    win.loadURL(keyFormHtml(""));
  });
}

/**
 * Decide whether the app may run, prompting for a key when needed. Returns
 * { ok } or { ok:false, reason } for a hard refusal (revoked / expired / past
 * grace with no way forward).
 */
async function ensureLicensed(userDataDir) {
  /* Master switch off: no key, no check, just run. */
  if (!LICENCE_ENABLED) return { ok: true };

  /* Best-effort online re-check first, so a revocation on the server is seen at
   * launch. Offline this falls back to the cached grace verdict. */
  let verdict = await licence.refreshFromCloud(userDataDir);

  if (verdict.allowed) return { ok: true };

  /* Never activated, or the key is no longer recognised — ask for a key. */
  if (verdict.reason === "never-activated" || /not recognised|no longer recognised/i.test(verdict.reason)) {
    const activated = await promptForKey(userDataDir);
    if (!activated) return { ok: false, reason: "OmniRoute Coder needs a valid licence key to run." };
    /* Re-evaluate from the freshly written cache. */
    verdict = licence.evaluateAtLaunch(userDataDir);
    return verdict.allowed
      ? { ok: true }
      : { ok: false, reason: verdict.reason };
  }

  /* Revoked / expired / past grace — a hard refusal. */
  return { ok: false, reason: verdict.reason };
}

/* -------------------------------------------------------------------- boot -- */

async function main() {
  makeMenu();
  showBootWindow();

  /* Launch-time licence gate. The fine-grained per-request check lives in the
   * server (authGuard.requireUser); this decides whether to load the app at all,
   * so a revocation bites within one launch. See desktop/licence.js. */
  const licensed = await ensureLicensed(app.getPath("userData"));
  if (!licensed.ok) {
    showLicenceRefusal(licensed.reason);
    return;
  }

  /* Start the Chromium fallback proxy before the server, so its port is in the
   * server's environment. Best-effort: if it fails, the app still runs; only
   * Cloudflare-blocked providers would be unavailable. */
  await startBrowserProxy();

  if (!fs.existsSync(SERVER_ENTRY)) {
    showLicenceRefusal(
      "This build is missing its server payload (.next/standalone). " +
        "Reinstall OmniRoute Coder.",
    );
    return;
  }

  let port;
  try {
    port = await startServer();
  } catch (err) {
    showLicenceRefusal(`Could not start the local server: ${err && err.message}`);
    return;
  }

  const health = await waitForHealth(port);
  if (!health.ok) {
    showServerCrashed("health-timeout", health.reason);
    return;
  }

  openMainWindow(port);
  startUpdater();
  startLicenceWatch();
}

/**
 * Re-check the licence every 12 hours while the app stays open, so a revocation
 * bites a long-running session rather than only at the next launch. If the
 * server says revoked/expired, replace the window with the refusal screen.
 */
function startLicenceWatch() {
  if (!LICENCE_ENABLED) return;
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  setInterval(async () => {
    if (shuttingDown) return;
    const verdict = await licence.refreshFromCloud(app.getPath("userData"));
    if (!verdict.allowed && verdict.reason !== "never-activated") {
      showLicenceRefusal(verdict.reason);
    }
  }, TWELVE_HOURS).unref();
}

/* ---------------------------------------------------------------- updater -- */

/**
 * Check the gated update feed on the licence server. Deliberately best-effort:
 * an update failure must never stop the app the user already has from running,
 * so every path here is wrapped and non-fatal.
 *
 * The feed is served by an authenticating proxy in front of latest.yml + the
 * installer (see electron-builder.yml `publish`), NOT public GitHub Releases —
 * so the download is not available to anyone with the URL. For the beta the
 * proxy checks a shared build-time bearer (OMNIROUTE_UPDATE_TOKEN) rather than a
 * per-user token, which is enough: a revoked user who somehow updated still
 * cannot RUN, because the licence gate refuses them.
 */
function startUpdater() {
  if (IS_DEV) return; // never auto-update a dev run
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    return; // electron-updater not installed in this build — skip quietly
  }
  try {
    const token = process.env.OMNIROUTE_UPDATE_TOKEN?.trim();
    if (token) autoUpdater.requestHeaders = { Authorization: `Bearer ${token}` };
    autoUpdater.autoDownload = true;
    autoUpdater.on("error", (err) =>
      console.warn(`[updater] ${err && err.message ? err.message : err}`),
    );
    autoUpdater.checkForUpdatesAndNotify().catch((err) =>
      console.warn(`[updater] check failed: ${err && err.message}`),
    );
  } catch (err) {
    console.warn(`[updater] disabled: ${err && err.message}`);
  }
}

/* --------------------------------------------------------------- lifecycle -- */

/* Single-instance lock. Without it a second launch starts a second server that
 * loses the bridge-port race and, worse, opens the same SQLite file — the loser
 * throws SQLITE_BUSY after busy_timeout. A second launch focuses the existing
 * window instead. */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = mainWindow || bootWindow;
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  app.whenReady().then(main);

  app.on("window-all-closed", () => app.quit());

  /* The graceful-shutdown handshake. preventDefault, ask the server to
   * checkpoint and drain over stdin, wait for it, then exit. Capped inside
   * stopServer so a hung server cannot block the quit forever. */
  app.on("before-quit", async (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    event.preventDefault();
    await stopServer();
    app.exit(0);
  });
}
