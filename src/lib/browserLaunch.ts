/**
 * src/lib/browserLaunch.ts
 * ---------------------------------------------------------------------------
 * Where the PDF/document renderer finds a Chromium to drive.
 *
 * THE PROBLEM THIS SOLVES
 *
 * `puppeteer.launch()` with no executablePath uses puppeteer's OWN downloaded
 * Chromium — a ~170MB browser kept in a cache directory (~/.cache/puppeteer or
 * %LOCALAPPDATA%\puppeteer). That download is fine in development and in the
 * Docker image, both of which run `puppeteer install`. It does NOT exist in the
 * packaged desktop app: Next's file tracer never sees the cache directory, so
 * it is not bundled, and the first PDF request would throw
 * "Could not find Chrome" — a crash that does not obviously point at "no
 * browser".
 *
 * THE FIX
 *
 * Every Windows machine already has Microsoft Edge, which is Chromium and which
 * puppeteer can drive unmodified. So on the desktop build we point puppeteer at
 * the installed Edge via executablePath rather than bundle a second ~170MB
 * browser. Free, no size cost, and it keeps export working.
 *
 * On a server or in development this returns no executablePath, so puppeteer
 * falls back to its downloaded Chromium exactly as before — nothing about the
 * existing deployments changes.
 *
 * WHY A SHARED HELPER
 *
 * Two call sites launch a browser (documentRender.ts and pdf-generator.ts). The
 * old "add --no-sandbox in one place, forget it in the other" is exactly how
 * they drift, so the launch options live here once.
 */

import fs from "fs";

import { isDesktopBuild } from "@/lib/deploymentMode";

/** The args every launch shares. --no-sandbox is required under Electron and in
 *  containers, and harmless on a desktop. */
const COMMON_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

/**
 * The well-known install locations of Microsoft Edge (stable) on Windows.
 * Checked in order; the first that exists wins. An explicit override via
 * OMNIROUTE_BROWSER_PATH takes precedence over all of them, so an unusual
 * install or a portable Edge can still be pointed at.
 */
function findEdge(): string | null {
  const override = process.env.OMNIROUTE_BROWSER_PATH?.trim();
  if (override) return fs.existsSync(override) ? override : null;

  const candidates = [
    `${process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles ?? "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* Unreadable path — treat as absent and try the next. */
    }
  }
  return null;
}

/** Puppeteer's LaunchOptions without importing the type (keeps this module free
 *  of a puppeteer import so anything can call it). */
export interface BrowserLaunchOptions {
  headless: boolean;
  args: string[];
  executablePath?: string;
}

/**
 * The options to pass to `puppeteer.launch()`.
 *
 * On the desktop build, resolves Edge and sets executablePath. If Edge cannot
 * be found (removed, or a locked-down machine), executablePath is left unset and
 * puppeteer falls back to its bundled Chromium — which will only work if one was
 * shipped, but failing that way is no worse than today and the error is
 * puppeteer's own clear "could not find browser".
 */
export function browserLaunchOptions(): BrowserLaunchOptions {
  const options: BrowserLaunchOptions = {
    headless: true,
    args: COMMON_ARGS,
  };

  if (isDesktopBuild()) {
    const edge = findEdge();
    if (edge) options.executablePath = edge;
  }

  return options;
}
