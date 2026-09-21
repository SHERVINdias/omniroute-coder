/**
 * desktop/prepare.mjs
 * ---------------------------------------------------------------------------
 * Assemble the packaged payload, and REFUSE to build if it contains a secret.
 *
 * Run after `next build`, before electron-builder:
 *   npm run build            (in the project root)
 *   node desktop/prepare.mjs
 *
 * WHAT IT COPIES (mirrors the Dockerfile's COPY lines — the three things Next's
 * standalone output does not carry itself):
 *   1. .next/standalone   -> payload/.next/standalone   (the server)
 *   2. .next/static       -> payload/.next/standalone/.next/static
 *   3. public             -> payload/.next/standalone/public
 * and prunes better-sqlite3's prebuilds to win32-x64 only (a 15 MB saving; the
 * module is Node-API, so the one flat binary is all Windows needs — no rebuild).
 *
 * WHAT IT REFUSES
 *
 * `next build` runs from the repo root, where chat.db and .env files live, and
 * the tracer sweeps them into .next/standalone. This script deletes them from
 * the payload and then ASSERTS none survived, failing the build on any hit. A
 * deny list you can forget is not a control; a failing assertion is. This is the
 * guard against shipping the developer's own conversations and live API keys
 * inside every tester's installer.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PAYLOAD = path.join(HERE, "payload");
const DEST_STANDALONE = path.join(PAYLOAD, ".next", "standalone");

/** Filenames/patterns that must NEVER appear in the payload. */
const FORBIDDEN = [
  /^chat\.db($|[.-])/i, // chat.db, chat.db-wal, chat.db.backup-*
  /^\.env($|\.)/i, // .env, .env.local, .env.production
  /^providers\.json$/i,
  /^user_local\.env$/i,
  /^\.omniroute(-|$)/i, // .omniroute, .omniroute-config.json, .omniroute-backups
];

function fail(message) {
  console.error(`\n[prepare] ${message}\n`);
  process.exit(1);
}

function copyDir(from, to, label) {
  if (!fs.existsSync(from)) fail(`missing ${label}: ${from}`);
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: true });
  console.log(`[prepare] copied ${label}`);
}

/* 1-3: assemble the payload. */
if (!fs.existsSync(path.join(ROOT, ".next", "standalone", "server.js"))) {
  fail("no standalone build found. Run `npm run build` in the project root first.");
}

copyDir(path.join(ROOT, ".next", "standalone"), DEST_STANDALONE, ".next/standalone");
copyDir(
  path.join(ROOT, ".next", "static"),
  path.join(DEST_STANDALONE, ".next", "static"),
  ".next/static",
);
copyDir(path.join(ROOT, "public"), path.join(DEST_STANDALONE, "public"), "public/");

/* Prune better-sqlite3 prebuilds to the one Windows binary. Node-API means the
 * flat file is all that is needed; the other seven platforms are dead weight in
 * a Windows installer. */
const prebuilds = path.join(DEST_STANDALONE, "node_modules", "better-sqlite3", "prebuilds");
if (fs.existsSync(prebuilds)) {
  for (const entry of fs.readdirSync(prebuilds)) {
    if (entry !== "win32-x64.node") {
      fs.rmSync(path.join(prebuilds, entry), { recursive: true, force: true });
    }
  }
  const win = path.join(prebuilds, "win32-x64.node");
  if (!fs.existsSync(win)) fail(`better-sqlite3 win32-x64.node missing at ${win}`);
  console.log("[prepare] pruned prebuilds to win32-x64 (Node-API — no rebuild)");
}

/* Delete any forbidden files the tracer swept in. */
let deleted = 0;
function scrub(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (FORBIDDEN.some((re) => re.test(entry.name))) {
      fs.rmSync(full, { recursive: true, force: true });
      deleted++;
      console.log(`[prepare] removed ${path.relative(PAYLOAD, full)}`);
      continue;
    }
    if (entry.isDirectory()) scrub(full);
  }
}
scrub(PAYLOAD);
console.log(`[prepare] scrubbed ${deleted} forbidden path(s)`);

/* Assert none survived. This is the hard gate. */
const survivors = [];
function assertClean(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (FORBIDDEN.some((re) => re.test(entry.name))) survivors.push(full);
    if (entry.isDirectory()) assertClean(full);
  }
}
assertClean(PAYLOAD);
if (survivors.length > 0) {
  fail(
    "REFUSING TO BUILD — the payload still contains secrets or a database:\n" +
      survivors.map((s) => `    ${path.relative(PAYLOAD, s)}`).join("\n"),
  );
}

/* Confirm the Windows binary the app will load is present. */
const target = path.join(DEST_STANDALONE, "node_modules", "better-sqlite3", "prebuilds", "win32-x64.node");
if (!fs.existsSync(target)) fail(`better-sqlite3 win32-x64 binary missing: ${target}`);

console.log("\n[prepare] payload clean and complete. Next: npm run dist (in desktop/).\n");
