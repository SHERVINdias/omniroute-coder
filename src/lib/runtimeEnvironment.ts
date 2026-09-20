/**
 * src/lib/runtimeEnvironment.ts
 * ---------------------------------------------------------------------------
 * Facts about the process this server is running inside, for the one question
 * the gateway setup UI cannot answer from the browser: *where is "localhost"
 * from the server's point of view?*
 *
 * WHY THIS EXISTS
 *
 * The wizard used to classify the user's situation from two signals — is the
 * page served from a loopback address, and does this build allow private
 * gateways. That is enough for two of the three real cases and silently wrong
 * for the third:
 *
 *   dev on the laptop      loopback page, private allowed  -> works
 *   deployed on a server   public page                     -> needs a tunnel
 *   CONTAINER on the laptop loopback page, private refused -> advice was wrong
 *
 * The third case is the common one for anyone testing the production build
 * before deploying it. `docker compose` publishes the app on 127.0.0.1:3005, so
 * the page *is* served from loopback and the browser concludes "same machine,
 * just flip the guard". But the fetch is made by the server, and the server is
 * inside a container whose loopback is its own — nothing is on port 20128 there.
 * Setting OMNIROUTE_ALLOW_PRIVATE_GATEWAY=true removes the refusal and replaces
 * it with a connection error, which is a strictly worse place to be debugging
 * from: the guard at least explained itself.
 *
 * The container needs a different address for the same machine —
 * `host.docker.internal` — so the UI has to know it is in one. Only the server
 * can know that, hence this module.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not make the SSRF guard allow `host.docker.internal` implicitly.
 * Inside a container that name resolves to the host, and on a deployed instance
 * the host is the EC2 box — so auto-allowing it would hand every user a
 * documented route to services bound on the instance's own interfaces. It stays
 * behind the same explicit flag as every other private address; this module only
 * makes the instructions correct, never more permissive.
 */

import fs from "fs";

/** The name a container uses to mean "the machine running me". */
export const CONTAINER_HOST_ALIAS = "host.docker.internal";

/* Resolved once. The answer cannot change while the process lives, and the
 * checks touch the filesystem — this is read on every settings page load. */
let cached: boolean | null = null;

/**
 * Whether this process is running inside a container.
 *
 * Three independent signals, because no single one is reliable across runtimes:
 * Docker writes `/.dockerenv` and has since forever; cgroup v1 names the
 * container runtime in `/proc/1/cgroup`, while cgroup v2 often shows a bare
 * `0::/` and gives nothing away; and `/proc/self/mountinfo` mentions the
 * runtime's overlay paths in most setups either way. Any hit is treated as a
 * container, since a false positive only changes which *advice* is printed and
 * the advice for a container is harmless elsewhere.
 *
 * Windows and macOS hosts have none of these paths, so the reads throw and the
 * answer is false — which is correct for `npm run dev` on the user's laptop.
 */
export function isContainerized(): boolean {
  if (cached !== null) return cached;
  cached = detectContainer();
  return cached;
}

function detectContainer(): boolean {
  /* An explicit answer wins. Compose sets this so the detection never has to be
   * right for the deployment to give correct instructions. */
  const declared = (process.env.OMNIROUTE_IN_CONTAINER ?? "").trim().toLowerCase();
  if (declared === "true" || declared === "1" || declared === "yes") return true;
  if (declared === "false" || declared === "0" || declared === "no") return false;

  if (readableExists("/.dockerenv")) return true;
  if (readableExists("/run/.containerenv")) return true; // podman

  const runtimeNames = /docker|containerd|kubepods|podman|lxc|garden/i;

  const cgroup = readTextOrNull("/proc/1/cgroup");
  if (cgroup && runtimeNames.test(cgroup)) return true;

  const mountinfo = readTextOrNull("/proc/self/mountinfo");
  if (mountinfo && runtimeNames.test(mountinfo)) return true;

  return false;
}

function readableExists(path: string): boolean {
  try {
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

function readTextOrNull(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The host this server should use to mean "the machine the user is sitting at",
 * given where this server is running.
 *
 * Returns null when there is nothing useful to say — either the process is not
 * containerized, in which case `localhost` already means the right machine, or
 * the deployment is remote, in which case no local name can work and the honest
 * answer is a tunnel.
 */
export function sameMachineHostAlias(): string | null {
  return isContainerized() ? CONTAINER_HOST_ALIAS : null;
}
