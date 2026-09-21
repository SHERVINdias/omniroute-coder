/**
 * desktop/ports.js
 * ---------------------------------------------------------------------------
 * Stable ports across launches, and why that is not a nicety.
 *
 * THE TRAP
 *
 * The app stores auth_token, the signed-in user, and every settings/router
 * choice in localStorage (27 call sites in src/). localStorage is scoped to the
 * ORIGIN, and the origin includes the port. A fresh random port every launch is
 * therefore a fresh origin: the user is signed out and all their settings are
 * gone, every single time they open the app. Cookies survive this (they ignore
 * ports); localStorage does not.
 *
 * So we pick a preferred port ONCE, remember it in userData, and reuse it. We
 * only move to a new one if the remembered port is genuinely taken — and we
 * persist that new choice too, so the move happens at most once.
 *
 * The bridge port gets the same treatment: it is fixed at 20129 in the app and
 * would collide with a dev server (npm run dev) running alongside a packaged
 * build. Remembering it avoids the seven "port 20129 in use" lines and the
 * silently-disabled bridge that follows.
 */

"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");

/** Ask the OS for a currently-free port. */
function freePort() {
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

/** True if nothing is listening on this loopback port right now. */
function isFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve(true));
    });
  });
}

function fileFor(userDataDir) {
  return path.join(userDataDir, "ports.json");
}

function read(userDataDir) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(userDataDir), "utf8"));
  } catch {
    return {};
  }
}

function write(userDataDir, data) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(fileFor(userDataDir), JSON.stringify(data, null, 2), "utf8");
  } catch {
    /* If we cannot persist, we still return a usable port for this launch; the
     * only cost is that the next launch may pick a different one. */
  }
}

/**
 * Resolve a port for `key` ("app" or "bridge"): reuse the remembered one if it
 * is still free, otherwise allocate a fresh one and remember it. Persisted per
 * userData folder so two installs (unlikely, but possible) do not fight.
 */
async function resolvePort(userDataDir, key, fallbackPreferred) {
  const store = read(userDataDir);
  const remembered = store[key];

  if (typeof remembered === "number" && (await isFree(remembered))) {
    return remembered;
  }

  /* Try the caller's preferred fixed port first (the bridge's 20129), so the
   * common case keeps a friendly, documented number. */
  let chosen;
  if (
    typeof fallbackPreferred === "number" &&
    (await isFree(fallbackPreferred))
  ) {
    chosen = fallbackPreferred;
  } else {
    chosen = await freePort();
  }

  store[key] = chosen;
  write(userDataDir, store);
  return chosen;
}

module.exports = { resolvePort };
