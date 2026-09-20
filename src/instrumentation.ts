/**
 * src/instrumentation.ts
 * ---------------------------------------------------------------------------
 * Next.js calls `register()` once per server process, before the first request.
 *
 * That timing is what makes it the right place for the production safety check:
 * a misconfigured deployment should be refused at boot, with the reason in the
 * logs, rather than discovered later by someone who noticed they could sign in
 * as anyone.
 *
 * The runtime guard matters — `register()` is invoked for the edge runtime too,
 * where `process.env` is a much smaller set and the database is unreachable.
 * The check only means anything in the Node server, so everything else returns
 * immediately.
 *
 * The build-phase guard matters for a different reason. `next build` bootstraps
 * a server to prerender pages, so this hook runs there too — with
 * NODE_ENV=production, but with none of the deployment's runtime secrets, since
 * those are supplied by the container at `docker run`, not at `docker build`.
 * Without the guard the build would evaluate the production checks against an
 * empty environment: it would open and migrate a database inside the image
 * layer, and fail the build over configuration that will be present when it
 * actually matters. A build is not a deployment, so there is nothing to verify
 * yet.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  try {
    /* Imported lazily so the edge build never tries to pull in better-sqlite3
     * through the settings modules this check depends on. */
    const { assertProductionSafety } = await import("./lib/productionGuard");
    assertProductionSafety();
  } catch (err) {
    /* A thrown error here is the intended refusal, not a crash to swallow. */
    console.error(
      err instanceof Error ? err.message : "[omniroute] startup check failed.",
    );
    throw err;
  }
}
