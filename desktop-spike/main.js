/**
 * desktop-spike/main.js
 * ---------------------------------------------------------------------------
 * THROWAWAY. This is a spike, not a foundation. Delete the whole
 * desktop-spike/ folder once it has answered its question.
 *
 * THE ONE QUESTION
 *
 * Does `.next/standalone/server.js` — the same server the Docker image runs —
 * boot inside Electron on Windows, load better-sqlite3 against Electron's
 * native ABI, and serve the real app in a window?
 *
 * Everything else about the desktop build is ordinary engineering. This is the
 * part that could genuinely fail, so it gets answered first and cheaply.
 *
 * WHY IT SPAWNS process.execPath WITH ELECTRON_RUN_AS_NODE
 *
 * Not for convenience — this is the actual test. A packaged app has no system
 * `node` to call, so the real desktop build will have to run the server on
 * Electron's own bundled Node. That runtime has a different native module ABI
 * than stock Node, which is what makes native modules the risky part of this
 * plan. Spawning the system `node` here would sidestep the ABI question and
 * report a pass that means nothing.
 *
 * On that ABI question specifically: this project's only native dependency is
 * better-sqlite3 13.0.3, which is a Node-API addon and therefore ABI-stable
 * across Node *and* Electron — see the note in prepare.mjs. So the expected
 * outcome is that it simply loads. This spawn is what proves it.
 *
 * WHY THE SERVER IS A CHILD PROCESS AND NOT require()'d
 *
 * Crash isolation. If the server dies we want to see its exit code and its
 * stderr, not take the window down with it. It also mirrors what the real build
 * should do.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No licence check, no auto-update, no single-instance lock, no tray icon, no
 * menu, no packaging config. Those are design questions, not feasibility
 * questions, and adding them would make a failure ambiguous.
 */

const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");
const SERVER_ENTRY = path.join(STANDALONE, "server.js");

/** How long to wait for /api/health before calling it a failure. */
const BOOT_TIMEOUT_MS = 90_000;

let serverProcess = null;
let mainWindow = null;
let shuttingDown = false;

/* ----------------------------------------------------------------- utils -- */

function banner(text) {
  console.log(`\n${"=".repeat(72)}\n${text}\n${"=".repeat(72)}\n`);
}

/**
 * Ask the OS for a port nobody is using.
 *
 * Hard-coding 3005 would collide with the user's own dev server, and the
 * resulting EADDRINUSE would look like the spike failing rather than like a
 * port clash.
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A stable per-install secret, generated once and kept in userData.
 *
 * src/lib/productionGuard.ts refuses to boot a production build without
 * AUTH_SECRET, and warns if it is shorter than 32 characters. Generating one
 * here is exactly what the real desktop app will have to do on first run, so
 * this doubles as a rehearsal of that step.
 */
function persistentSecret(filename) {
  const file = path.join(app.getPath("userData"), filename);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* not written yet */
  }
  const generated = crypto.randomBytes(32).toString("base64");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, generated, "utf8");
  return generated;
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
      const body = await res.text();
      if (res.ok) return { ok: true, body };
      lastError = `HTTP ${res.status}: ${body.slice(0, 200)}`;
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, reason: `timed out after ${BOOT_TIMEOUT_MS / 1000}s — last: ${lastError}` };
}

/* ---------------------------------------------------------------- startup -- */

async function startServer() {
  const port = await findFreePort();
  const userData = app.getPath("userData");

  const env = {
    ...process.env,

    /* Run Electron's binary as plain Node. This is what makes the child a
     * Node process instead of a second Electron app. */
    ELECTRON_RUN_AS_NODE: "1",

    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",

    /* Database outside the repo, where the real app will keep it. */
    OMNIROUTE_DB_PATH: path.join(userData, "chat.db"),

    /* Required by the production boot guard. */
    AUTH_SECRET: persistentSecret("spike-auth-secret"),
    CREDENTIALS_SECRET: persistentSecret("spike-credentials-secret"),

    /* We want the bridge listener to attempt a bind, because "does the
     * WebSocket server come up inside Electron" is part of the question. */
    OMNIROUTE_BRIDGE_ENABLE: "true",
    OMNIROUTE_BRIDGE_HOST: "127.0.0.1",
  };

  console.log(`[spike] userData:   ${userData}`);
  console.log(`[spike] database:   ${env.OMNIROUTE_DB_PATH}`);
  console.log(`[spike] server cwd: ${STANDALONE}`);
  console.log(`[spike] port:       ${port}`);
  console.log(`[spike] spawning:   ${process.execPath} (as node)\n`);

  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: STANDALONE,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  /* The boot summary printed by productionGuard.ts goes to stdout, and it is
   * the single most useful diagnostic here — it reports which database opened
   * and which settings actually resolved. Forward both streams verbatim. */
  serverProcess.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  serverProcess.on("exit", (code, signal) => {
    if (shuttingDown) return;
    banner(`SPIKE RESULT: FAIL — server exited early (code ${code}, signal ${signal})`);
  });

  return port;
}

function openWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#18181b",
    show: false,
    webPreferences: {
      /* The renderer only ever loads our own loopback origin and needs no
       * Node access. A spike is still not an excuse to disable isolation. */
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  /* External links should not hijack the app window. */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

async function main() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    banner(
      "SPIKE RESULT: FAIL — no standalone build found.\n\n" +
        `Expected: ${SERVER_ENTRY}\n\n` +
        "Run this first, from the project root:\n" +
        "    npm run build\n" +
        "then, from desktop-spike/:\n" +
        "    npm run spike",
    );
    app.quit();
    return;
  }

  let port;
  try {
    port = await startServer();
  } catch (err) {
    banner(`SPIKE RESULT: FAIL — could not spawn the server.\n\n${err && err.stack}`);
    app.quit();
    return;
  }

  const health = await waitForHealth(port);

  if (!health.ok) {
    banner(
      "SPIKE RESULT: FAIL — the server never became healthy.\n\n" +
        `Reason: ${health.reason}\n\n` +
        "Scroll up for the [server] lines — the real cause is almost always there.\n" +
        "If it mentions better-sqlite3, copy the message to me verbatim rather than\n" +
        "reaching for a rebuild: this project's copy is a Node-API addon and should\n" +
        "load in Electron unmodified, so a failure there would be a real finding.",
    );
    return;
  }

  banner(
    `SPIKE RESULT: SERVER OK — /api/health answered ${health.body}\n\n` +
      "Opening the window. The spike passes only if the app actually renders\n" +
      "and you can reach the sign-in screen. A blank window is still a failure.",
  );

  openWindow(port);
}

/* -------------------------------------------------------------- lifecycle -- */

app.whenReady().then(main);

app.on("window-all-closed", () => app.quit());

/* Kill the server with the app. Without this the child survives, holds the
 * port and keeps a write lock on the database. */
app.on("before-quit", () => {
  shuttingDown = true;
  if (serverProcess && serverProcess.exitCode === null) {
    /* SIGTERM so the checkpoint handler in src/lib/db.ts gets to run. On
     * Windows this is delivered as a hard terminate, which is one of the
     * things the real build will need to handle properly. */
    serverProcess.kill("SIGTERM");
  }
});
