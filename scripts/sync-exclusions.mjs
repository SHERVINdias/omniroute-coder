#!/usr/bin/env node
/**
 * scripts/sync-exclusions.mjs
 * ---------------------------------------------------------------------------
 * Keep `vscode-extension/src/fileExclusions.ts` byte-identical to
 * `src/lib/fileExclusions.ts`, apart from a generated banner.
 *
 * WHY A COPY AT ALL
 *
 * The rule engine has to run in two places that cannot share a module:
 *
 *   - the Next.js server, which enforces at the bridge's tool dispatcher, and
 *   - the VS Code extension, which is the thing actually touching the disk.
 *
 * They are separate npm projects with separate tsconfigs and separate build
 * outputs. The extension has no bundler — it is plain `tsc` to CommonJS, and
 * `require("../../src/lib/fileExclusions")` from inside `out/` would reach a
 * file that is not in the .vsix. A path alias would not help either: aliases
 * are compile-time only, and the emitted `require` still has to resolve at
 * runtime on the user's machine.
 *
 * So: a copy. The danger of a copy is obvious — someone tightens a rule on the
 * server, the extension keeps the old one, and the two layers disagree about
 * which files are protected. That disagreement is the exact bug the single
 * engine was built to remove, so it cannot be left to discipline.
 *
 * HOW DRIFT IS PREVENTED
 *
 * This script writes the copy. `scripts/package-vsix.mjs` regenerates the same
 * bytes in memory and refuses to build a .vsix if the file on disk differs.
 * The check is byte equality, not "looks similar", because anything fuzzier
 * ends up tolerating the one-character change that matters.
 *
 * Usage:
 *   node scripts/sync-exclusions.mjs          write the copy
 *   node scripts/sync-exclusions.mjs --check  exit 1 if it is stale
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SOURCE = join(repoRoot, "src", "lib", "fileExclusions.ts");
export const TARGET = join(
  repoRoot,
  "vscode-extension",
  "src",
  "fileExclusions.ts",
);

const BANNER = [
  "/* AUTO-GENERATED FILE — DO NOT EDIT.",
  " *",
  " * Copied verbatim from src/lib/fileExclusions.ts by",
  " * scripts/sync-exclusions.mjs. Edit the original and re-run:",
  " *",
  " *     npm run extension:sync-engine",
  " *",
  " * scripts/package-vsix.mjs refuses to build if this copy is stale, so a",
  " * change made here instead of there will fail the next package step rather",
  " * than silently give the extension different rules from the server.",
  " */",
  "",
];

/** The exact bytes the target file should contain. */
export function renderCopy() {
  const source = readFileSync(SOURCE, "utf8");
  /* Match the source's own line endings so the comparison is not defeated by
   * a checkout that normalised one file and not the other. */
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return BANNER.join(eol) + eol + source;
}

/** null when the copy is current, otherwise a sentence saying what is wrong. */
export function checkCopy() {
  if (!existsSync(TARGET)) {
    return "vscode-extension/src/fileExclusions.ts is missing.";
  }
  const want = renderCopy();
  const have = readFileSync(TARGET, "utf8");
  if (want === have) return null;

  /* Point at the first difference. "The files differ" sends people to a diff
   * tool; a line number usually ends the investigation immediately. */
  const w = want.split("\n");
  const h = have.split("\n");
  let line = 0;
  while (line < w.length && line < h.length && w[line] === h[line]) line++;
  return (
    `vscode-extension/src/fileExclusions.ts has drifted from src/lib/fileExclusions.ts ` +
    `(first difference at line ${line + 1}).\n` +
    `      server: ${JSON.stringify((w[line] ?? "<end of file>").slice(0, 80))}\n` +
    `      ext:    ${JSON.stringify((h[line] ?? "<end of file>").slice(0, 80))}`
  );
}

/* Only act when run directly, so package-vsix.mjs can import checkCopy. */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes("--check")) {
    const problem = checkCopy();
    if (problem) {
      console.error(`\n  exclusion engine out of sync — ${problem}\n`);
      console.error(`  Fix: npm run extension:sync-engine\n`);
      process.exit(1);
    }
    console.log("  exclusion engine in sync");
  } else {
    const bytes = renderCopy();
    writeFileSync(TARGET, bytes);
    console.log(
      `  wrote vscode-extension/src/fileExclusions.ts (${(bytes.length / 1024).toFixed(1)} KB)`,
    );
  }
}
