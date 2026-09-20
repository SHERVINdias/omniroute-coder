/**
 * src/lib/documentRender.ts
 * ---------------------------------------------------------------------------
 * Markdown -> real PDF.
 *
 * THE THING WORTH UNDERSTANDING FIRST
 *
 * No language model API returns a PDF. Not this gateway, not Anthropic's, not
 * OpenAI's — they all return text and nothing else. So "the model can't make a
 * PDF" was never a model problem and picking a stronger model was never going
 * to fix it. The shape that actually works, and that every product doing this
 * uses, is:
 *
 *     model emits structured markdown  ->  app renders the binary  ->  download
 *
 * This file is the middle step. It needs no new dependency: `marked` and
 * `puppeteer` are already in package.json.
 *
 * WHY PUPPETEER RATHER THAN A PDF LIBRARY
 *
 * Chrome's print engine already solves pagination, widow/orphan control, table
 * splitting, page numbers and font fallback. A hand-rolled PDF library gives
 * you a blank page and a cursor position. The tradeoff is a ~200MB Chromium and
 * a slow first render, which the browser singleton below amortises.
 */

import { marked } from "marked";
import puppeteer, { type Browser } from "puppeteer";

/* -------------------------------------------------------------------------
 * Browser lifecycle
 * ---------------------------------------------------------------------- */

declare global {
  /* eslint-disable-next-line no-var */
  var __omniroutePdfBrowser: Promise<Browser> | undefined;
}

/** Puppeteer renamed `isConnected()` to a `connected` getter; support both. */
function isAlive(browser: Browser): boolean {
  const candidate = browser as unknown as {
    connected?: boolean;
    isConnected?: () => boolean;
  };
  if (typeof candidate.connected === "boolean") return candidate.connected;
  if (typeof candidate.isConnected === "function")
    return candidate.isConnected();
  return false;
}

/**
 * One Chromium for the process, relaunched if it dies.
 *
 * Cold start is 1–2 seconds; every render after that is well under a second.
 * Launching per request would make every "Generate PDF" click feel broken.
 *
 * The bookkeeping around the relaunch matters more than it looks. Awaiting the
 * cached promise yields, so two requests arriving together can both observe the
 * same dead browser and both call `launch()` — orphaning a ~200 MB Chromium
 * that nothing holds a reference to. Re-checking the slot after the await, and
 * closing the dead handle before replacing it, keeps exactly one alive.
 */
async function getBrowser(): Promise<Browser> {
  const existing = globalThis.__omniroutePdfBrowser;

  if (existing) {
    try {
      const browser = await existing;
      if (isAlive(browser)) return browser;

      /* Dead, but the OS process may still be lingering. Reap it. */
      await browser.close().catch(() => {
        /* Already gone. */
      });
    } catch {
      /* The previous launch itself rejected; fall through and try again. */
    }

    /* Someone relaunched while we were awaiting. Use theirs. */
    const replacement = globalThis.__omniroutePdfBrowser;
    if (replacement && replacement !== existing) {
      try {
        const browser = await replacement;
        if (isAlive(browser)) return browser;
      } catch {
        /* Their launch failed too; fall through. */
      }
    }
  }

  const launched = puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  /* Publish synchronously — before any await — so a concurrent caller sees this
   * launch rather than starting its own. Clear the slot if it rejects, so one
   * transient failure is not cached for the life of the process. */
  globalThis.__omniroutePdfBrowser = launched;
  launched.catch(() => {
    if (globalThis.__omniroutePdfBrowser === launched) {
      globalThis.__omniroutePdfBrowser = undefined;
    }
  });

  return launched;
}

/* -------------------------------------------------------------------------
 * Markdown -> HTML
 * ---------------------------------------------------------------------- */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Print stylesheet.
 *
 * The `break-*` rules are the difference between a document that looks
 * generated and one that looks written: headings never strand at the foot of a
 * page, and code blocks and tables are not sliced in half.
 */
const DOCUMENT_CSS = `
  @page { size: A4; margin: 20mm 18mm 22mm 18mm; }

  * { box-sizing: border-box; }

  body {
    font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue",
                 Arial, "Noto Sans", sans-serif;
    font-size: 10.5pt;
    line-height: 1.65;
    color: #1a1a1a;
    margin: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  h1, h2, h3, h4, h5, h6 {
    line-height: 1.25;
    margin: 1.4em 0 0.5em;
    font-weight: 650;
    color: #0f172a;
    break-after: avoid-page;
    page-break-after: avoid;
  }
  h1 { font-size: 21pt; margin-top: 0; letter-spacing: -0.01em; }
  h2 { font-size: 15.5pt; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.25em; }
  h3 { font-size: 12.5pt; }
  h4, h5, h6 { font-size: 11pt; }

  p { margin: 0 0 0.85em; orphans: 3; widows: 3; }

  a { color: #1d4ed8; text-decoration: none; }

  ul, ol { margin: 0 0 0.9em; padding-left: 1.5em; }
  li { margin-bottom: 0.3em; }
  li > ul, li > ol { margin-top: 0.3em; }

  blockquote {
    margin: 0 0 1em;
    padding: 0.15em 0 0.15em 1em;
    border-left: 3px solid #cbd5e1;
    color: #475569;
  }

  code {
    font-family: "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace;
    font-size: 0.88em;
    background: #f1f5f9;
    padding: 0.12em 0.35em;
    border-radius: 4px;
    color: #0f172a;
  }

  pre {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 0.85em 1em;
    overflow-wrap: break-word;
    white-space: pre-wrap;
    break-inside: avoid-page;
    page-break-inside: avoid;
    margin: 0 0 1em;
  }
  pre code { background: none; padding: 0; font-size: 0.86em; line-height: 1.5; }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 0 0 1.1em;
    font-size: 0.94em;
    break-inside: avoid-page;
    page-break-inside: avoid;
  }
  th, td { border: 1px solid #e2e8f0; padding: 0.45em 0.6em; text-align: left; vertical-align: top; }
  th { background: #f8fafc; font-weight: 600; }

  img { max-width: 100%; }

  hr { border: none; border-top: 1px solid #e2e8f0; margin: 1.6em 0; }

  .doc-title {
    font-size: 22pt;
    font-weight: 680;
    letter-spacing: -0.015em;
    color: #0f172a;
    margin: 0 0 0.15em;
  }
  .doc-meta {
    font-size: 8.5pt;
    color: #64748b;
    margin: 0 0 1.8em;
    padding-bottom: 0.9em;
    border-bottom: 2px solid #0f172a;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
`;

/**
 * Wrap rendered markdown in a full document.
 *
 * `<base href="about:blank">` plus the request interception in `renderPdf`
 * means a stray `<img src="http://…">` in model output cannot reach the
 * network from your machine.
 */
export async function markdownToHtml(
  markdown: string,
  title: string,
): Promise<string> {
  const body = await marked.parse(markdown ?? "", {
    gfm: true,
    breaks: false,
  });

  const stamp = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <base href="about:blank" />
    <title>${escapeHtml(title)}</title>
    <style>${DOCUMENT_CSS}</style>
  </head>
  <body>
    <div class="doc-title">${escapeHtml(title)}</div>
    <div class="doc-meta">${escapeHtml(stamp)}</div>
    ${body}
  </body>
</html>`;
}

/* -------------------------------------------------------------------------
 * HTML -> PDF
 * ---------------------------------------------------------------------- */

export interface PdfOptions {
  /** Printed at the foot of every page. Defaults to the document title. */
  footerLabel?: string;
}

export async function renderPdf(
  markdown: string,
  title: string,
  options: PdfOptions = {},
): Promise<Buffer> {
  const html = await markdownToHtml(markdown, title);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    /* Model output is not trusted input. Scripts off, network off — the page
     * can only ever render the string we handed it.
     *
     * The allowance is deliberately just `about:blank` and `data:`. An earlier
     * draft also continued `request.isNavigationRequest()`, which is a
     * server-side SSRF: that predicate is true for sub-frame document loads
     * too, so an `<iframe src="http://169.254.169.254/...">` in model output
     * would have had *this server* fetch it — cloud metadata, localhost
     * services, the OmniRoute gateway itself. Nothing is lost by removing it:
     * `setContent` writes into the existing document and issues no navigation
     * request of its own. */
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      if (url === "about:blank" || url.startsWith("data:")) {
        void request.continue();
      } else {
        void request.abort();
      }
    });

    await page.setContent(html, { waitUntil: "load", timeout: 20_000 });

    const label = escapeHtml(options.footerLabel ?? title);
    const bytes = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: `
        <div style="width:100%;font-size:7.5pt;color:#94a3b8;
                    font-family:'Segoe UI',Arial,sans-serif;
                    padding:0 18mm;display:flex;justify-content:space-between;">
          <span>${label}</span>
          <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
        </div>`,
    });

    /* Puppeteer 23+ resolves a Uint8Array here, older versions a Buffer.
     * Buffer.from handles both without copying twice in the Buffer case. */
    return Buffer.from(bytes);
  } finally {
    await page.close().catch(() => {
      /* Closing a page that already died is not an error worth surfacing. */
    });
  }
}

/** Release the shared Chromium — useful from a shutdown hook or a test. */
export async function closeRenderer(): Promise<void> {
  const existing = globalThis.__omniroutePdfBrowser;
  globalThis.__omniroutePdfBrowser = undefined;
  if (!existing) return;
  try {
    const browser = await existing;
    await browser.close();
  } catch {
    /* Already gone. */
  }
}
