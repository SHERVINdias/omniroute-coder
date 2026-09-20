#!/usr/bin/env node
/**
 * scripts/sync-extension.mjs
 * ---------------------------------------------------------------------------
 * Copy the packaged VS Code extension into `public/downloads/` and write a
 * manifest describing it.
 *
 * WHY THIS SCRIPT EXISTS
 *
 * The .vsix is built in `vscode-extension/`, but nothing under that folder is
 * served: `next build` with `output: "standalone"` copies `public/` into the
 * container and leaves the rest of the repo behind. So a "Download the
 * extension" button that pointed at the build location would work on the
 * developer's laptop and 404 for every beta tester — the worst possible split,
 * because it is invisible until someone else tries it.
 *
 * Copying by hand solves that exactly once. The second build produces
 * `0.1.1.vsix` next to a stale `0.1.0.vsix` in public/, users download whichever
 * one the UI happens to name, and the bug reports are from a version that no
 * longer exists. Hence a script: it copies the *newest* build, deletes the old
 * copies, and records what it did in a manifest the UI reads, so the version
 * shown to the user is the version on disk by construction rather than by
 * somebody remembering.
 *
 * RUN IT after packaging, i.e. `npm run extension:sync` from the repo root, or
 * `npm run extension:build` to compile, package and sync in one go. The pairing
 * panel degrades to "ask the operator for the file" when the manifest is
 * absent, so forgetting is visible rather than silent.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(repoRoot, "vscode-extension");
const targetDir = join(repoRoot, "public", "downloads");
const manifestPath = join(targetDir, "extension.json");

function fail(message) {
  console.error(`\n  extension:sync failed — ${message}\n`);
  process.exit(1);
}

/* -------------------------------------------------------------------------
 * Reading one file out of the .vsix
 *
 * A .vsix is a zip. This pulls a single entry out using nothing but stdlib,
 * because the whole point of the check below is that it runs on a machine that
 * may have no registry access — a check that needs `npm install` to work is a
 * check that is skipped exactly when it is needed.
 * ---------------------------------------------------------------------- */

function readZipEntry(buf, wanted) {
  /* Find the End Of Central Directory record. It is at the very end unless
   * there is a zip comment, so scan backwards for its signature. */
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65_557; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (name === wanted) {
      /* The local header repeats the name and extra fields, and its extra
       * length can differ from the central one — so read it from the local
       * header rather than reusing the value above. */
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compressedSize);
      try {
        return method === 0 ? raw.toString("utf8") : inflateRawSync(raw).toString("utf8");
      } catch {
        return null;
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/**
 * Refuse to publish a .vsix that predates the source it is supposed to be a
 * build of.
 *
 * WHY THIS CHECK EARNS ITS KEEP
 *
 * This script picks the newest .vsix by mtime and copies it. It has no way of
 * knowing whether that file was built from the current source or from the
 * source as it stood three weeks ago — and a `package` step that was never
 * re-run leaves a .vsix sitting there looking perfectly healthy. That is not
 * hypothetical: this repo shipped a manifest whose `syncedAt` was today and
 * whose build was from 2026-09-08, missing the entire pairing flow. The
 * manifest was internally consistent, the size and hash matched, and the file
 * downloaded fine. It simply did not contain the command the instructions told
 * people to run.
 *
 * Comparing declared command ids catches precisely that, because a stale build
 * is stale in the way that matters: the contributions differ. It compares
 * against `contributes.commands` rather than a version string because the
 * version is bumped by hand and therefore lies in exactly the case of interest.
 */
function assertBuildMatchesSource(vsixPath, sourcePkg) {
  const packed = readZipEntry(readFileSync(vsixPath), "extension/package.json");
  if (!packed) {
    console.warn("  warning: could not read package.json out of the .vsix; skipping the freshness check");
    return;
  }

  let packedPkg;
  try {
    packedPkg = JSON.parse(packed);
  } catch {
    console.warn("  warning: the .vsix has an unparseable package.json; skipping the freshness check");
    return;
  }

  const idsOf = (pkg) =>
    new Set(((pkg.contributes || {}).commands || []).map((c) => c.command).filter(Boolean));

  const wanted = idsOf(sourcePkg);
  const got = idsOf(packedPkg);
  const missing = [...wanted].filter((id) => !got.has(id));

  if (missing.length > 0) {
    fail(
      `the .vsix in vscode-extension/ was built from older source.\n\n` +
        `  It is missing ${missing.length} command(s) the current extension declares:\n` +
        missing.map((id) => `      ${id}`).join("\n") +
        `\n\n  Publishing it would hand beta testers an installer that cannot pair:\n` +
        `  the guide tells them to run "OmniRoute: Connect (paste pairing code)",\n` +
        `  and that command would not exist in the build they installed.\n\n` +
        `  Rebuild first — this needs no network access:\n` +
        `      npm run extension:build`,
    );
  }
}

/**
 * Refuse to publish when the web app's deep link points at an extension id the
 * build does not have.
 *
 * The "Open in VS Code" button sends the browser to
 * `vscode://<publisher>.<name>/pair?code=…`. VS Code resolves that id against
 * installed extensions; if it matches nothing, it opens the editor and does
 * precisely nothing else — no error dialog, no output-channel line, no hint
 * that a link was even received. The user sees their editor come to the front
 * and then sits there waiting.
 *
 * Two strings in two different projects have to agree for that not to happen,
 * and nothing in the type system relates them. So compare them here, where a
 * mismatch costs a failed build instead of a support conversation that starts
 * with "it just does nothing".
 */
function assertDeepLinkIdMatches(sourcePkg) {
  const panel = join(repoRoot, "src", "components", "ConnectEditorPanel.tsx");
  if (!existsSync(panel)) return;

  const source = readFileSync(panel, "utf8");
  const found = source.match(/VSCODE_EXTENSION_ID\s*=\s*["']([^"']+)["']/);
  if (!found) {
    console.warn("  warning: no VSCODE_EXTENSION_ID in ConnectEditorPanel.tsx; skipping the deep-link check");
    return;
  }

  const expected = `${sourcePkg.publisher}.${sourcePkg.name}`;
  if (found[1] !== expected) {
    fail(
      `the web app's deep link does not match the extension it is meant to open.\n\n` +
        `      src/components/ConnectEditorPanel.tsx  ${found[1]}\n` +
        `      vscode-extension/package.json          ${expected}\n\n` +
        `  Clicking "Open in VS Code" would launch the editor and then do nothing,\n` +
        `  with no error shown anywhere. Set VSCODE_EXTENSION_ID to "${expected}".`,
    );
  }
}

if (!existsSync(sourceDir)) {
  fail(`no vscode-extension/ folder at ${sourceDir}`);
}

const builds = readdirSync(sourceDir)
  .filter((name) => name.toLowerCase().endsWith(".vsix"))
  .map((name) => {
    const full = join(sourceDir, name);
    return { name, full, mtime: statSync(full).mtimeMs, size: statSync(full).size };
  })
  /* Newest build wins. Sorting on filename would put 0.10.0 before 0.9.0, which
   * is the classic version-sort bug; mtime has no such trap and answers the
   * question actually being asked ("which one did I just build?"). */
  .sort((a, b) => b.mtime - a.mtime);

if (builds.length === 0) {
  fail(
    "no .vsix found in vscode-extension/. Build one first — this needs no network access:\n" +
      "    npm run extension:build",
  );
}

const chosen = builds[0];

/* Read the version from package.json rather than parsing it out of the
 * filename, because the filename is whatever `--out` was given and need not
 * contain a version at all. */
let version = "unknown";
let sourcePkg = null;
try {
  sourcePkg = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8"));
  version = sourcePkg.version || "unknown";
} catch {
  /* A missing or malformed package.json is not worth aborting a copy over; the
   * manifest just says "unknown" and the UI omits the version line. */
}

/* Before anything is copied: is this build actually of this source? Running it
 * here means a stale build stops the publish rather than reaching users. */
if (sourcePkg) {
  assertBuildMatchesSource(chosen.full, sourcePkg);
  assertDeepLinkIdMatches(sourcePkg);
}

mkdirSync(targetDir, { recursive: true });

/* Remove previous copies so the folder cannot accumulate versions that the
 * manifest no longer points at — a stale .vsix in public/ is a live download
 * link to a build nobody is supporting.
 *
 * A failure here is reported and then ignored. On Windows a file that Explorer
 * has open cannot be unlinked, and aborting would mean the *new* build never
 * gets published — trading a cosmetic problem (an extra file nothing links to)
 * for a real one (users downloading yesterday's extension). The manifest, not
 * the directory listing, decides what the UI offers. */
for (const name of readdirSync(targetDir)) {
  if (!name.toLowerCase().endsWith(".vsix")) continue;
  if (name === chosen.name) continue;
  try {
    rmSync(join(targetDir, name), { force: true });
  } catch (err) {
    console.warn(`  warning: could not remove stale ${name} (${err.code || err.message})`);
  }
}

copyFileSync(chosen.full, join(targetDir, chosen.name));

const bytes = readFileSync(join(targetDir, chosen.name));
const sha256 = createHash("sha256").update(bytes).digest("hex");

writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      file: chosen.name,
      /* Root-relative so it works behind any hostname, which matters because
       * the app is reached at localhost during development and at a DuckDNS
       * name in production. */
      url: `/downloads/${chosen.name}`,
      version,
      size: bytes.length,
      /* Published so a cautious user can verify the file they were sent over
       * WhatsApp is byte-for-byte the one this deployment serves. */
      sha256,
      builtAt: new Date(chosen.mtime).toISOString(),
      syncedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

console.log(`\n  Extension published for download:`);
console.log(`    file     public/downloads/${chosen.name}`);
console.log(`    version  ${version}`);
console.log(`    size     ${(bytes.length / 1024).toFixed(1)} KB`);
console.log(`    sha256   ${sha256}\n`);
