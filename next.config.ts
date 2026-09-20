import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/**
 * The only third-party origin the browser is allowed to load code from.
 *
 * PDF text extraction loads pdf.js from cdnjs at runtime (see
 * `ensurePdfJsLoaded` in src/app/page.tsx) rather than bundling it, because it
 * is only needed when someone actually attaches a PDF. The CSP below therefore
 * has to name that origin — a policy that forgot it would turn PDF upload into
 * a silent failure with only a console message to explain it.
 */
const PDFJS_ORIGIN = "https://cdnjs.cloudflare.com";

/**
 * Content Security Policy.
 *
 * WHAT THIS DOES AND DOES NOT BUY
 *
 * `script-src` still needs 'unsafe-inline' and 'unsafe-eval'. Next.js injects
 * an inline bootstrap script and, in development, evaluates code for hot
 * reloading. Removing either means moving the whole app to a nonce-based policy
 * generated in middleware, which is a real change and not one to make on the
 * way to a deploy. So this policy is NOT a defence against injected script.
 *
 * What it does buy is worth having on its own:
 *
 *   - `frame-ancestors 'none'` stops the app being framed, which is the
 *     clickjacking defence that actually applies to a chat UI with destructive
 *     buttons in it.
 *   - `form-action 'self'` and `base-uri 'self'` stop an injected <form> or
 *     <base> redirecting a submission or rewriting every relative URL.
 *   - `connect-src 'self'` keeps page script from exfiltrating to an arbitrary
 *     host. Nothing in the client talks to a third party directly: every
 *     provider call is made server-side, which is the whole point of the
 *     upstream request layer.
 *   - `object-src 'none'` removes the plugin surface entirely.
 *
 * The dev additions are listed explicitly rather than by widening the whole
 * policy: `ws:` for the hot-reload socket, and blob:/data: for the object URLs
 * used by file previews and the pdf.js worker.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${PDFJS_ORIGIN}`,
  `worker-src 'self' blob: ${PDFJS_ORIGIN}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' blob: data: ${PDFJS_ORIGIN}${isProd ? "" : " ws: wss:"}`,
  "media-src 'self' blob: data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  /**
   * Emit a self-contained server bundle at .next/standalone.
   *
   * Next traces every module the server actually imports and copies just those
   * into that folder, so the runtime image does not need node_modules. On a
   * small VPS that is the difference between a ~150 MB image and a ~1 GB one.
   *
   * It requires `node server.js` rather than `next start` — see the Dockerfile.
   * Deploying with `next start` instead still works and simply ignores this.
   */
  output: "standalone",

  /**
   * Security headers applied to every response.
   *
   * WHY Cross-Origin-Embedder-Policy IS GONE
   *
   * It used to be set to `require-corp` to enable SharedArrayBuffer for
   * WebContainers in Production Agent Mode. That mode is parked, so the header
   * bought nothing — and it was not free. COEP blocks every cross-origin
   * subresource that does not opt in with CORP or a crossorigin attribute, and
   * pdf.js is loaded from cdnjs with neither. Attaching a PDF therefore failed
   * with a console error and no visible cause. If WebContainers are ever
   * revived, the header comes back together with a crossorigin attribute on
   * that script tag, and both get tested against a real PDF upload.
   *
   * Cross-Origin-Opener-Policy stays: it severs window.opener between origins,
   * which prevents a page opened from here from reaching back into it, and it
   * costs nothing.
   *
   * Strict-Transport-Security is production-only on purpose. Browsers ignore it
   * over plain http, so sending it in development is merely noise — but the
   * moment it is honoured it is sticky for a year, and pinning a developer's
   * localhost to https would be a very annoying thing to have to undo.
   */
  async headers() {
    const common = [
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      /* Belt and braces with CSP frame-ancestors, which older browsers ignore. */
      { key: "X-Frame-Options", value: "DENY" },
      /* Stops a text/plain upload being sniffed into executable script. */
      { key: "X-Content-Type-Options", value: "nosniff" },
      /* Send the origin cross-site, the full path same-site. Keeps chat ids and
       * query strings out of third-party referer logs. */
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      /* Nothing here uses these, so refuse them for this origin and for frames. */
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
      },
      { key: "Content-Security-Policy", value: csp },
    ];

    if (isProd) {
      common.push({
        key: "Strict-Transport-Security",
        value: "max-age=31536000; includeSubDomains",
      });
    }

    return [{ source: "/:path*", headers: common }];
  },

  /**
   * Keep native and Node-only packages out of the server bundle.
   *
   * better-sqlite3 loads a compiled .node binary. Bundlers cannot follow a
   * native require, so when it is bundled the binding resolves against the
   * wrong path at runtime and the first database call throws
   * "Could not locate the bindings file" — usually on the very first request,
   * long after the build reported success. Listing it here makes Next require
   * it from node_modules at runtime instead.
   *
   * nodemailer is here for a related reason: it resolves transports and DNS
   * lookups dynamically, and bundling it produces "module not found" warnings
   * for optional dependencies it never actually loads.
   *
   * puppeteer is here for the same native-binary reason as better-sqlite3: it
   * resolves a downloaded Chrome binary from disk at runtime.
   */
  serverExternalPackages: ["better-sqlite3", "nodemailer", "puppeteer"],
};

export default nextConfig;
