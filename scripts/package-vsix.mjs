#!/usr/bin/env node
/**
 * scripts/package-vsix.mjs
 * ---------------------------------------------------------------------------
 * Build `vscode-extension/*.vsix` using nothing but the Node standard library.
 *
 * WHY THIS EXISTS
 *
 * The normal way to package a VS Code extension is `npx @vscode/vsce package`,
 * which downloads a ~30 MB tool from the npm registry. That is fine on a laptop
 * with a working connection and impossible everywhere else — including the
 * sandbox this repo is often edited from, and including a beta operator on a
 * metered connection who just wants to hand three people an installer.
 *
 * The consequence of "packaging needs the network" is not that packaging gets
 * skipped. It is that packaging gets *deferred*, and the stale .vsix from three
 * weeks ago keeps being the one people install. That already happened here: the
 * extension was rewritten to authenticate its WebSocket upgrade, the .vsix was
 * not rebuilt, and the old client spent a day failing against the new server
 * with `socket hang up` — a symptom that looks like a protocol bug and is
 * actually a build-freshness bug.
 *
 * A .vsix is an ordinary zip with two extra files in it. Node can write a zip.
 * So the packaging step becomes `npm run extension:package`, works offline,
 * finishes in under a second, and stops being the thing that gets put off.
 *
 * WHAT IT DOES NOT DO
 *
 * No marketplace assets: no icon, no README/Details asset, no license asset, no
 * translations, no `--pre-release` channel, no signing. Those matter when you
 * publish to the Marketplace; this produces the file you send to testers and
 * install with "Install from VSIX...". If you ever do publish, use the real
 * vsce — this is deliberately the smaller tool for the smaller job, not a
 * reimplementation of it.
 *
 * It also does not compile. Run `npm run compile` in vscode-extension/ first,
 * or use `npm run extension:build` from the repo root, which does both.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { checkCopy } from "./sync-exclusions.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extRoot = join(repoRoot, "vscode-extension");

function fail(message) {
  console.error(`\n  extension:package failed — ${message}\n`);
  process.exit(1);
}

/* =========================================================================
 * 1. Read and check the manifest
 * ====================================================================== */

if (!existsSync(extRoot)) fail(`no vscode-extension/ folder at ${extRoot}`);

let pkg;
try {
  pkg = JSON.parse(readFileSync(join(extRoot, "package.json"), "utf8"));
} catch (err) {
  fail(`could not read vscode-extension/package.json — ${err.message}`);
}

/* A missing publisher is not cosmetic. vsce writes `Publisher="undefined"` into
 * the manifest, VS Code shows the extension as `undefined_publisher.<name>`,
 * and — the part that actually breaks — `vscode://<publisher>.<name>/…` deep
 * links have no id to route to, so the one-click pairing button silently does
 * nothing. Refusing here is much kinder than shipping that. */
for (const field of ["name", "version", "publisher", "engines"]) {
  if (!pkg[field]) {
    fail(
      `vscode-extension/package.json has no "${field}".` +
        (field === "publisher"
          ? `\n\n  Without it VS Code installs the extension as "undefined_publisher.${pkg.name || "…"}"` +
            `\n  and the vscode:// pairing link has no extension id to reach.`
          : ""),
    );
  }
}
if (!pkg.engines.vscode) fail(`vscode-extension/package.json has no "engines.vscode"`);

/* The file-exclusion engine exists twice — once for the server, once inside the
 * extension — because the two are separate builds with no shared module
 * resolution. A copy that has fallen behind means the editor is enforcing
 * different rules from the server, which is precisely the split-brain the
 * single engine was written to remove, and it would be invisible until someone
 * noticed a file being read that the settings panel says is blocked.
 *
 * Checked here rather than left to discipline, and checked BEFORE the compile
 * output is looked at, so the message is about the real problem instead of a
 * confusing type error downstream. */
const drift = checkCopy();
if (drift) {
  fail(`${drift}\n\n  Fix: npm run extension:sync-engine`);
}

if (!existsSync(join(extRoot, pkg.main || "out/extension.js"))) {
  fail(
    `${pkg.main || "out/extension.js"} does not exist — compile first:\n` +
      `      cd vscode-extension && npm run compile`,
  );
}

/* =========================================================================
 * 2. Decide which files go in
 *
 * .vscodeignore uses .gitignore syntax. This implements the subset that file
 * actually uses — `**`, `*`, `?`, a leading `!` to re-include, and the rule
 * that a pattern with no slash matches at any depth. It is not a complete
 * gitignore engine, and the assertion at the end of this section is what makes
 * that acceptable: if the matcher ever silently stops working, the build fails
 * instead of quietly shipping the sources.
 * ====================================================================== */

function patternToRegExp(pattern) {
  const anchoredAnywhere = !pattern.includes("/");
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        /* A globstar followed by a slash spans zero or more directories; a
         * bare globstar spans anything, slashes included. */
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${anchoredAnywhere ? "(?:.*/)?" : ""}${out}$`);
}

const ignoreRules = (() => {
  const file = join(extRoot, ".vscodeignore");
  const lines = existsSync(file)
    ? readFileSync(file, "utf8").split(/\r?\n/)
    : [];
  const rules = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const body = negated ? line.slice(1) : line;
    rules.push({ negated, re: patternToRegExp(body), source: line });
  }
  /* Always excluded, whatever the file says. The .vsix being written must not
   * try to include itself, .git would leak the whole history, and the various
   * tooling dotfiles are noise in a package meant for end users. */
  for (const builtin of [
    "**/.git/**",
    "*.vsix",
    "node_modules/.bin/**",
    ".vscodeignore",
    ".vscode/**",
    ".editorconfig",
    ".npmrc",
    "**/.DS_Store",
  ]) {
    rules.push({ negated: false, re: patternToRegExp(builtin), source: "<builtin>" });
  }
  return rules;
})();

function isIgnored(relPath) {
  /* package.json is the manifest the whole format is built around; no ignore
   * rule may remove it. vsce has the same exception. */
  if (relPath === "package.json") return false;
  let ignored = false;
  for (const rule of ignoreRules) {
    if (rule.re.test(relPath)) ignored = !rule.negated;
  }
  return ignored;
}

function walk(absDir, out = []) {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    const rel = relative(extRoot, abs).split(sep).join("/");
    if (entry.isDirectory()) {
      /* node_modules is walked separately and selectively — the dev
       * dependencies in there are 20 MB of TypeScript nobody needs at runtime. */
      if (rel === "node_modules") continue;
      if (isIgnored(`${rel}/`) || isIgnored(rel)) continue;
      walk(abs, out);
    } else if (entry.isFile()) {
      if (!isIgnored(rel)) out.push(rel);
    }
  }
  return out;
}

/**
 * Production dependencies, transitively.
 *
 * VS Code does not run `npm install` on an installed extension, so anything
 * `require`d at runtime has to be inside the .vsix. Walking `dependencies`
 * (never `devDependencies`) is what vsce does and is why the package is 60 KB
 * rather than 20 MB.
 */
function collectDependencies(pkgDir, seen = new Set(), out = []) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  } catch {
    return out;
  }
  for (const dep of Object.keys(manifest.dependencies || {})) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    const depDir = join(extRoot, "node_modules", dep);
    if (!existsSync(depDir)) {
      fail(
        `the extension depends on "${dep}" but node_modules/${dep} is missing.\n` +
          `      cd vscode-extension && npm install`,
      );
    }
    for (const entry of walkAll(depDir)) out.push(entry);
    collectDependencies(depDir, seen, out);
  }
  return out;
}

function walkAll(absDir, out = []) {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) walkAll(abs, out);
    else if (entry.isFile()) out.push(relative(extRoot, abs).split(sep).join("/"));
  }
  return out;
}

const payload = [...walk(extRoot), ...collectDependencies(extRoot)].sort();

/* The check the .vscodeignore header is really about. Superseded drafts of the
 * file-access code must not travel to strangers in a zip they can open, and a
 * broken matcher is exactly the failure that would not otherwise be noticed. */
const leaked = payload.filter(
  (p) => /(^|\/)src\//.test(p) || /_backup\.|_claude\./.test(p) || p.endsWith(".js.map"),
);
if (leaked.length > 0) {
  fail(
    `the ignore rules did not exclude files that must never ship:\n` +
      leaked.map((p) => `      ${p}`).join("\n") +
      `\n\n  Check vscode-extension/.vscodeignore.`,
  );
}

/* =========================================================================
 * 3. The two files that make a zip a .vsix
 * ====================================================================== */

const xmlEscape = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
	<Metadata>
		<Identity Language="en-US" Id="${xmlEscape(pkg.name)}" Version="${xmlEscape(pkg.version)}" Publisher="${xmlEscape(pkg.publisher)}" />
		<DisplayName>${xmlEscape(pkg.displayName || pkg.name)}</DisplayName>
		<Description xml:space="preserve">${xmlEscape(pkg.description || "")}</Description>
		<Tags>${xmlEscape((pkg.keywords || []).join(","))}</Tags>
		<Categories>${xmlEscape((pkg.categories || []).join(","))}</Categories>
		<GalleryFlags>Public</GalleryFlags>
		<Properties>
			<Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xmlEscape(pkg.engines.vscode)}" />
			<Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
			<Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
			<Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
			<Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
		</Properties>
	</Metadata>
	<Installation>
		<InstallationTarget Id="Microsoft.VisualStudio.Code"/>
	</Installation>
	<Dependencies/>
	<Assets>
		<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
	</Assets>
</PackageManifest>`;

/* ExtensionKind "workspace" is deliberate: this extension reads the files in
 * the open folder and talks to a bridge on the same machine as those files. In
 * a Remote-SSH or WSL window a UI-side extension would see the wrong disk. */

const CONTENT_TYPES = {
  ".json": "application/json",
  ".vsixmanifest": "text/xml",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".cjs": "application/javascript",
  ".map": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ts": "video/mp2t",
  ".yml": "text/plain",
  ".yaml": "text/plain",
};

function contentTypesXml(names) {
  const extensions = new Set([".vsixmanifest"]);
  for (const name of names) {
    const dot = name.lastIndexOf(".");
    const slash = name.lastIndexOf("/");
    if (dot > slash) extensions.add(name.slice(dot).toLowerCase());
  }
  const defaults = [...extensions]
    .sort()
    .map(
      (ext) =>
        `<Default Extension="${xmlEscape(ext)}" ContentType="${
          CONTENT_TYPES[ext] || "application/octet-stream"
        }"/>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}</Types>`;
}

/* =========================================================================
 * 4. A zip writer
 *
 * Deflate comes from zlib; the container around it is a few fixed-layout
 * records. CRC-32 is written by hand rather than using `zlib.crc32` because
 * that was added in Node 20.12 and this script should run on any Node the app
 * itself supports.
 * ====================================================================== */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** MS-DOS date/time. The format cannot represent anything before 1980. */
function dosStamp(date) {
  const d = date.getFullYear() >= 1980 ? date : new Date(1980, 0, 1);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = entry.data;
    const crc = crc32(raw);

    /* Store rather than deflate when compression does not help — true for the
     * handful of tiny files here, and it keeps the reader's job simpler. */
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosStamp(entry.mtime || new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: unix, zip 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // unix mode 0644
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* =========================================================================
 * 5. Write it
 * ====================================================================== */

const entries = [
  {
    name: "extension.vsixmanifest",
    data: Buffer.from(vsixManifest, "utf8"),
    mtime: new Date(),
  },
  {
    name: "[Content_Types].xml",
    data: Buffer.from(contentTypesXml(payload), "utf8"),
    mtime: new Date(),
  },
  ...payload.map((rel) => {
    const abs = join(extRoot, rel);
    return {
      name: `extension/${rel}`,
      data: readFileSync(abs),
      mtime: statSync(abs).mtime,
    };
  }),
];

const outName = `${pkg.name}-${pkg.version}.vsix`;
const outPath = join(extRoot, outName);

/* Delete previous builds in this folder before writing the new one.
 *
 * scripts/sync-extension.mjs picks the newest .vsix by mtime, so an old build
 * left lying around is only ever one clock skew away from being the one that
 * gets published — and "the stale .vsix got shipped" is the exact failure this
 * whole script exists to make unlikely. */
for (const name of readdirSync(extRoot)) {
  if (!name.toLowerCase().endsWith(".vsix")) continue;
  if (name === outName) continue;
  try {
    rmSync(join(extRoot, name), { force: true });
    console.log(`  removed stale build ${name}`);
  } catch (err) {
    console.warn(`  warning: could not remove stale ${name} (${err.code || err.message})`);
  }
}

mkdirSync(dirname(outPath), { recursive: true });
const zip = buildZip(entries);
writeFileSync(outPath, zip);

const sha256 = createHash("sha256").update(zip).digest("hex");
const kb = (zip.length / 1024).toFixed(1);

console.log(`\n  ${pkg.publisher}.${pkg.name}  v${pkg.version}`);
console.log(`  ${entries.length} files, ${kb} KB`);
console.log(`  sha256 ${sha256}`);
console.log(`  -> vscode-extension/${outName}`);
console.log(`\n  Next: npm run extension:sync   (copies it into public/downloads)\n`);
