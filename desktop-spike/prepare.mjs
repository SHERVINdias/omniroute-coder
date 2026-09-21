/**
 * desktop-spike/prepare.mjs
 * ---------------------------------------------------------------------------
 * THROWAWAY, part of the spike.
 *
 * `next build` with output:"standalone" produces a server that is *almost*
 * self-contained. Three things are missing, and the Dockerfile already
 * documents all three because the container hit each one:
 *
 *   1. .next/static  — not part of standalone output. Without it every CSS,
 *                      JS chunk and font 404s, and you get an unstyled page
 *                      that looks like a rendering bug rather than a missing
 *                      copy step.
 *   2. public/       — same story, for images and the downloadable .vsix.
 *   3. better-sqlite3 — Next's tracer cannot follow it. The loader in
 *                      lib/binding.js computes the filename at runtime from
 *                      process.platform and process.arch, so static analysis
 *                      sees no literal path to copy. The container hit this on
 *                      its first database call.
 *
 * On (3), a correction worth keeping. This project is on better-sqlite3
 * 13.0.3, which is a **Node-API** addon: package.json has "gypfile": false, no
 * `bindings` dependency, no `prebuild-install`, no install script, and
 * prebuilds/ holds one flat binary per platform (win32-x64.node, linux-x64.node,
 * …) rather than the ABI-versioned tarballs older versions used. Node-API is
 * ABI-stable across Node *and* Electron, so this module does NOT need an
 * Electron rebuild — copying it is the whole job. Older better-sqlite3 (v11 and
 * earlier) used the `bindings` package and build/Release/better_sqlite3.node,
 * and did need rebuilding; that is no longer the situation here.
 *
 * This mirrors the COPY lines in the Dockerfile. If the real desktop build
 * happens, this logic moves into the packaging config rather than a script
 * like this one.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");

function fail(message) {
  console.error(`\n[prepare] ${message}\n`);
  process.exit(1);
}

function copyDir(from, to, label) {
  if (!fs.existsSync(from)) fail(`missing ${label}: ${from}`);
  /* Clear the destination first. fs.cpSync merges into an existing tree rather
   * than replacing it, so anything already there survives — including the empty
   * build/ directory a failed node-gyp run leaves behind, and stale chunks from
   * an earlier build. Replacing outright keeps this script idempotent. */
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: true });
  console.log(`[prepare] copied ${label}`);
}

if (!fs.existsSync(path.join(STANDALONE, "server.js"))) {
  fail(
    "no standalone build found.\n" +
      "Run `npm run build` in the project root first, then try again.",
  );
}

copyDir(
  path.join(ROOT, ".next", "static"),
  path.join(STANDALONE, ".next", "static"),
  ".next/static",
);

copyDir(
  path.join(ROOT, "public"),
  path.join(STANDALONE, "public"),
  "public/",
);

copyDir(
  path.join(ROOT, "node_modules", "better-sqlite3"),
  path.join(STANDALONE, "node_modules", "better-sqlite3"),
  "better-sqlite3",
);

/* Sanity check: the binary this platform will actually load must be present.
 * Without this the failure surfaces much later, as a require() error deep in a
 * database call, which reads like an application bug rather than a bad copy. */
const target = `${process.platform}-${process.arch}.node`;
const prebuilt = path.join(STANDALONE, "node_modules", "better-sqlite3", "prebuilds", target);
if (!fs.existsSync(prebuilt)) {
  fail(`better-sqlite3 has no prebuilt binary for this platform: expected ${prebuilt}`);
}
console.log(`[prepare] verified ${target} (Node-API — no Electron rebuild needed)`);

console.log("\n[prepare] done. Next: `npm start` to launch.\n");
