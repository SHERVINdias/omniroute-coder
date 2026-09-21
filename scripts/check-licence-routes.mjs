/**
 * scripts/check-licence-routes.mjs
 * ---------------------------------------------------------------------------
 * Fail the build if any API route is not classified for the licence server.
 *
 *   node scripts/check-licence-routes.mjs
 *
 * Enumerates every route.ts under src/app/api, derives its /api path, and checks
 * each against licenceAllowlist.json: it must be in either allowedApiPrefixes
 * (reachable on the licence server) or appOnly (deliberately NOT reachable). A
 * route that is in neither means someone added an endpoint without deciding
 * whether the licence server should expose it — which is exactly how a
 * default-deny gate quietly grows a hole. Exit non-zero so CI catches it.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const API_DIR = path.join(ROOT, "src", "app", "api");

const allowlist = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src", "lib", "licenceAllowlist.json"), "utf8"),
);
const allowedPrefixes = new Set(allowlist.allowedApiPrefixes);
const appOnly = new Set(allowlist.appOnly);

/** Every route.ts under src/app/api, as an /api-relative path with no file. */
function findRoutes(dir, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findRoutes(full, path.posix.join(rel, entry.name)));
    } else if (entry.name === "route.ts" || entry.name === "route.js") {
      out.push(rel);
    }
  }
  return out;
}

if (!fs.existsSync(API_DIR)) {
  console.error(`[licence-routes] no API directory at ${API_DIR}`);
  process.exit(1);
}

const routes = findRoutes(API_DIR);
const unclassified = [];

for (const route of routes) {
  const segment = route.split("/")[0];
  const allowed = allowedPrefixes.has(segment);
  const isAppOnly = appOnly.has(route);
  if (!allowed && !isAppOnly) unclassified.push(route);
}

if (unclassified.length > 0) {
  console.error(
    "\n[licence-routes] These API routes are not classified in " +
      "src/lib/licenceAllowlist.json:\n",
  );
  for (const r of unclassified) console.error(`    /api/${r}`);
  console.error(
    "\nDecide for each: add its first segment to allowedApiPrefixes if the " +
      "licence server should expose it, or add the full path to appOnly if it " +
      "must NOT be reachable there. Then re-run.\n",
  );
  process.exit(1);
}

console.log(
  `[licence-routes] OK — ${routes.length} routes, all classified ` +
    `(${allowedPrefixes.size} allowed prefixes, ${appOnly.size} app-only).`,
);
