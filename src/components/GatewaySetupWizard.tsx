"use client";

/**
 * src/components/GatewaySetupWizard.tsx
 * ---------------------------------------------------------------------------
 * The guided path from "nothing installed" to "a working provider".
 *
 * WHY THIS EXISTS
 *
 * Connecting the gateway took four pieces of knowledge that lived nowhere in the
 * product: that you install it with `npm i -g omniroute`, that you run it with
 * `omniroute`, that its own dashboard is password-protected with a default of
 * CHANGEME, and that the base URL this app wants is the gateway's port with /v1
 * on the end. Every one of those was folklore, carried in a .bat file on one
 * machine. Settings offered an empty "Base URL" box and no indication of what
 * was supposed to go in it.
 *
 * THE PART THAT IS NOT A DOCUMENTATION PROBLEM
 *
 * Provider requests are made by the SERVER (src/lib/upstreamRequest.ts), never
 * by the browser. On a local install that is invisible — the server and the
 * gateway are the same machine, so `localhost:20128` resolves correctly from
 * both sides and everything works. Deploy the same app and `localhost` starts
 * meaning the server's own loopback, so the gateway becomes unreachable in a way
 * that looks exactly like a gateway that is switched off.
 *
 * No amount of wording fixes that; the address genuinely has to change. So this
 * wizard *detects* which case it is in and asks for a different thing in each:
 *
 *   direct    — this page is served from loopback and the server is a plain
 *               process on this machine. http://localhost:20128/v1 is correct
 *               and is filled in for the user.
 *   container — loopback page, but the server is inside Docker. This looks
 *               identical to `direct` from the browser and is not: the
 *               container's `localhost` is its own, and nothing is on port
 *               20128 there. The address has to become host.docker.internal.
 *   tunnel    — this page came from somewhere else, so the gateway needs a
 *               public address. We give the exact cloudflared command and take
 *               the URL it prints.
 *   blocked   — loopback page, uncontainerized server, but private fetches are
 *               refused (a production build running locally). One env var away.
 *
 * WHY THE BROWSER PROBES TOO
 *
 * Every one of those cases is about *addressing*, and none of them answers the
 * question the user actually has on step one: is the gateway running? The server
 * cannot answer it — on a deployed instance its `localhost` is a datacentre
 * machine — so the browser asks, because the browser is the only party here that
 * is definitely sitting on the user's computer. See lib/localGatewayProbe.ts.
 * That result is a *hint* shown to the user; the authoritative check is still
 * the server-side test on the last step, since the server is what has to
 * connect.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It adds no API surface. Everything here goes through the same
 * /api/credentials and /api/credentials/test endpoints the settings form uses,
 * which means it inherits their auth, their rate limit and their SSRF guard
 * rather than getting its own second-best copy of each.
 *
 * It also does not try to run anything on the user's machine. The commands are
 * text with a copy button; the browser cannot spawn processes and pretending
 * otherwise would be the wrong shape of promise.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  CheckCircle,
  Copy,
  ExternalLink,
  Globe,
  Key,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Terminal,
  Wifi,
  WifiOff,
  X,
  XCircle,
} from "lucide-react";
import {
  probeLocalGateway,
  type LocalGatewayProbeResult,
} from "@/lib/localGatewayProbe";

/** The port the gateway binds by default. Used to build every example command. */
const GATEWAY_PORT = 20128;
const GATEWAY_ORIGIN = `http://localhost:${GATEWAY_PORT}`;
const GATEWAY_DASHBOARD = `${GATEWAY_ORIGIN}/dashboard/quota`;
const GATEWAY_LOCAL_BASE_URL = `${GATEWAY_ORIGIN}/v1`;
const TUNNEL_COMMAND = `cloudflared tunnel --url ${GATEWAY_ORIGIN}`;

/**
 * How often step one re-checks for a gateway while it has not found one.
 *
 * The expected user behaviour on that step is "read the command, alt-tab, run
 * it, come back", so the check has to keep running or it would report a stale
 * absence at exactly the moment the answer changed. It stops the instant a
 * gateway answers — the modal is not a monitor.
 */
const PROBE_POLL_MS = 4000;

/** The name a gateway provider is saved under when the wizard creates one. */
const PROVIDER_NAME = "OmniRoute Gateway";

interface WizardProvider {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
}

export interface GatewaySetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Fired once a provider has been saved, so the host can refresh its model
   * list. The wizard does not know how models are loaded and should not.
   */
  onConnected?: () => void;
}

/**
 * Which connection story applies to this session.
 *
 * "unknown" is the honest initial value: it depends on a server response and on
 * `window`, neither of which exists during the first render.
 *
 * "container" is not a variant of "direct". It is the case where the browser's
 * evidence is actively misleading — the page came from 127.0.0.1, so everything
 * the client can see says "same machine", while the process that will make the
 * request lives in a network namespace where that address means itself.
 */
type Reach = "unknown" | "direct" | "container" | "tunnel" | "blocked";

/** Hosts that mean "the machine this browser is running on". */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\./.test(host)
  );
}

/**
 * Cheap textual test for "this string names a private host".
 *
 * Only used to decide whether a scheme-less paste should be assumed http or
 * https. The authoritative check is isPubliclyRoutable() in ssrfGuard.ts, which
 * actually resolves the name.
 */
function looksPrivateHostString(value: string): boolean {
  const host = value.split("/")[0].split(":")[0].toLowerCase();
  return (
    isLoopbackHostname(host) ||
    host.endsWith(".local") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * Turn whatever was pasted into a base URL the app can actually use.
 *
 * cloudflared prints a bare origin (`https://foo-bar.trycloudflare.com`) and the
 * OpenAI-compatible API lives one path segment below it. Appending that segment
 * by hand is the single most common way this gets set up wrong, and the failure
 * is a 404 that reads as "the gateway is broken".
 */
export function normalizeGatewayUrl(raw: string): string {
  let value = raw.trim();
  if (!value) return "";

  /* Strip anything after whitespace: people paste the whole cloudflared banner
   * line, box-drawing characters and all. */
  value = value.split(/\s/)[0];
  value = value.replace(/\/+$/, "");

  if (!/^https?:\/\//i.test(value)) {
    /* A bare host. Loopback and LAN addresses are served over plain http far
     * more often than not, and forcing https onto them produces a TLS error
     * that reads like the gateway is down. */
    value = `${looksPrivateHostString(value) ? "http" : "https"}://${value}`;
  }

  /* Already versioned — /v1, /v1beta/openai, /openai/v1. Leave it alone rather
   * than producing /v1/v1. */
  if (/\/v\d+[a-z]*(\/|$)/i.test(value)) return value;

  return `${value}/v1`;
}

/**
 * Copy that works outside a secure context.
 *
 * navigator.clipboard is undefined on plain http to a LAN address, which is
 * precisely how someone reaches this app from a second machine on their own
 * network. Silently doing nothing there would make every copy button in this
 * wizard look broken.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Fall through to the legacy path. */
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** A command line with a copy button. */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const handleCopy = async () => {
    const ok = await copyText(command);
    setCopied(ok);
    setFailed(!ok);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 2000);
  };

  return (
    <div className="space-y-1">
      <div className="flex items-stretch gap-2">
        <code className="flex-1 min-w-0 rounded-lg border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-ink-hi overflow-x-auto whitespace-pre">
          <span className="select-none text-ink-faint">$ </span>
          {command}
        </code>
        <button
          type="button"
          onClick={handleCopy}
          title="Copy to clipboard"
          aria-label={`Copy command: ${command}`}
          className="shrink-0 px-3 rounded-lg border border-line bg-surface-hover hover:bg-surface-active text-ink-mid hover:text-ink-hi transition-colors cursor-pointer"
        >
          {copied ? (
            <Check className="w-4 h-4 text-positive" />
          ) : (
            <Copy className="w-4 h-4" />
          )}
        </button>
      </div>
      {failed && (
        <p className="text-[11px] text-ink-low">
          Copying was blocked by the browser — select the text above and copy it
          manually.
        </p>
      )}
    </div>
  );
}

/** One row in the left-hand step rail. */
function StepRail({
  steps,
  current,
  onJump,
}: {
  steps: string[];
  current: number;
  onJump: (index: number) => void;
}) {
  return (
    <ol className="space-y-1">
      {steps.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={label}>
            <button
              type="button"
              /* Only backwards. Jumping ahead would skip the field the next
               * step needs, and an empty required field presented as "your
               * fault" is a worse experience than a disabled button. */
              onClick={() => done && onJump(index)}
              disabled={!done}
              className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                active
                  ? "bg-accent-soft text-accent-ink"
                  : done
                    ? "text-ink-mid hover:bg-surface-hover cursor-pointer"
                    : "text-ink-faint cursor-default"
              }`}
            >
              <span
                className={`shrink-0 w-5 h-5 rounded-full grid place-items-center text-[10px] font-semibold border ${
                  active
                    ? "border-accent-line bg-accent-soft text-accent-ink"
                    : done
                      ? "border-positive-line bg-positive-soft text-positive"
                      : "border-line text-ink-faint"
                }`}
              >
                {done ? <Check className="w-3 h-3" /> : index + 1}
              </span>
              <span className="truncate">{label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The live "is it running?" panel on step one.
 *
 * Deliberately three states and not two. "Detected" and "not detected yet" are
 * the obvious ones; the third is "something is there but this page cannot read
 * it", which happens whenever the gateway does not send CORS headers to this
 * origin. Folding that into a failure would tell a user with a perfectly
 * working gateway that it is not running, which is the exact false negative
 * this whole panel exists to prevent.
 */
function GatewayPresence({
  probe,
  probing,
  onRecheck,
}: {
  probe: LocalGatewayProbeResult | null;
  probing: boolean;
  onRecheck: () => void;
}) {
  const found = probe?.present === true;

  const tone = found
    ? "border-positive-line bg-positive-soft"
    : probe === null
      ? "border-line bg-surface-sunken"
      : "border-line-strong bg-surface-sunken";

  return (
    <div className={`rounded-xl border px-3.5 py-3 ${tone}`}>
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">
          {probing && !found ? (
            <Loader2 className="w-4 h-4 text-ink-mid animate-spin" />
          ) : found ? (
            <Wifi className="w-4 h-4 text-positive" />
          ) : (
            <WifiOff className="w-4 h-4 text-ink-low" />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <p
            className={`text-xs font-medium ${found ? "text-positive" : "text-ink"}`}
          >
            {found
              ? "Gateway detected on this machine"
              : probe === null
                ? "Looking for a gateway on this machine…"
                : "No gateway detected yet"}
          </p>

          <p className="text-[11px] text-ink-low leading-relaxed">
            {probe
              ? probe.detail
              : `Checking ${GATEWAY_ORIGIN} from your browser.`}
          </p>

          {found && probe.models.length > 0 && (
            <p className="text-[11px] text-ink-faint font-mono truncate">
              {probe.models.slice(0, 4).join(", ")}
              {probe.models.length > 4 ? ` +${probe.models.length - 4} more` : ""}
            </p>
          )}

          {/* Said plainly rather than implied, because the alternative is a user
            * who trusts a negative, goes looking for a gateway bug, and finds
            * nothing — their gateway was fine and their browser declined the
            * request. */}
          {probe && !probe.present && (
            <p className="text-[11px] text-ink-faint leading-relaxed">
              This check runs from your browser, so a strict browser or an
              extension can block it even when the gateway is up. It is a
              convenience — the real test is on the last step.
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onRecheck}
          disabled={probing}
          className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-line bg-surface-hover hover:bg-surface-active text-[11px] text-ink-mid hover:text-ink-hi disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          <RefreshCw className={`w-3 h-3 ${probing ? "animate-spin" : ""}`} />
          Check
        </button>
      </div>
    </div>
  );
}

/** The one-line verdict in the header, so the current story is always visible. */
function ReachBadge({ reach }: { reach: Reach }) {
  if (reach === "unknown") return null;

  const map: Record<
    Exclude<Reach, "unknown">,
    { label: string; icon: React.ReactNode; className: string }
  > = {
    direct: {
      label: "Same machine",
      icon: <Terminal className="w-3 h-3" />,
      className: "border-positive-line bg-positive-soft text-positive",
    },
    container: {
      label: "Server in a container",
      icon: <Box className="w-3 h-3" />,
      className: "border-accent-line bg-accent-soft text-accent-ink",
    },
    tunnel: {
      label: "Server is remote",
      icon: <Globe className="w-3 h-3" />,
      className: "border-info-line bg-info-soft text-info",
    },
    blocked: {
      label: "Local addresses refused",
      icon: <ShieldAlert className="w-3 h-3" />,
      className: "border-accent-line bg-accent-soft text-accent-ink",
    },
  };

  const entry = map[reach];
  return (
    <span
      className={`hidden md:inline-flex items-center gap-1.5 shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium ${entry.className}`}
    >
      {entry.icon}
      {entry.label}
    </span>
  );
}

export default function GatewaySetupWizard({
  isOpen,
  onClose,
  onConnected,
}: GatewaySetupWizardProps) {
  const [step, setStep] = useState(0);
  const [reach, setReach] = useState<Reach>("unknown");
  /* What detection concluded, kept separate from `reach` so the user can
   * override to a tunnel and still get back. Overriding matters: `container`
   * and `blocked` both require an env change and a server restart, and someone
   * who cannot do that — a managed host, a locked-down box — needs the tunnel
   * escape hatch rather than a dead end. */
  const [detectedReach, setDetectedReach] = useState<Reach>("unknown");
  /* Whether the server will fetch private addresses at all. The container case
   * needs this *and* the right hostname, so the step has to know which of the
   * two is still missing instead of always printing both. */
  const [privateAllowed, setPrivateAllowed] = useState(true);
  /* What this server must call "the machine the user is on" — null when
   * `localhost` already means that. */
  const [sameMachineHost, setSameMachineHost] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [signedOut, setSignedOut] = useState(false);

  /* Browser-side detection. Separate from everything above: that is about
   * addressing, this is about whether anything is listening. */
  const [probe, setProbe] = useState<LocalGatewayProbeResult | null>(null);
  const [probing, setProbing] = useState(false);

  /* An existing gateway provider, so a second run updates it instead of
   * stacking up duplicates named "OmniRoute Gateway". */
  const [existing, setExisting] = useState<WizardProvider | null>(null);

  const [apiKey, setApiKey] = useState("");
  const [pastedUrl, setPastedUrl] = useState("");

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [done, setDone] = useState(false);

  const steps = [
    "Run the gateway",
    "Unlock the dashboard",
    reach === "tunnel" ? "Give it a public URL" : "Point this app at it",
    "Test and save",
  ];

  /**
   * The address that means "the gateway on the user's machine" *from where this
   * server is standing*.
   *
   * Derived from a server-reported fact rather than from `window.location`,
   * because the two disagree in exactly the case that used to be broken: a
   * containerized app is published on 127.0.0.1, so the browser sees loopback
   * while the fetch will originate inside a namespace whose loopback is empty.
   */
  const localBaseUrl = sameMachineHost
    ? `http://${sameMachineHost}:${GATEWAY_PORT}/v1`
    : GATEWAY_LOCAL_BASE_URL;

  /* The base URL that will actually be saved. Derived rather than stored so the
   * preview the user reads and the value that gets POSTed cannot drift. */
  const resolvedBaseUrl =
    reach === "tunnel" ? normalizeGatewayUrl(pastedUrl) : localBaseUrl;

  /**
   * Check for a gateway from the browser. Returns whether one answered so the
   * poller can stop; never throws, so neither caller needs a try block.
   */
  const runProbe = useCallback(async (): Promise<boolean> => {
    setProbing(true);
    try {
      const result = await probeLocalGateway(GATEWAY_ORIGIN);
      setProbe(result);
      return result.present;
    } finally {
      setProbing(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setSignedOut(false);
    try {
      const response = await fetch("/api/credentials");
      if (response.status === 401) {
        setSignedOut(true);
        return;
      }
      const data = await response.json();
      if (!data?.success) return;

      const allowsPrivate = data.privateGatewayAllowed !== false;
      const containerized = data.containerized === true;
      const hostAlias =
        typeof data.sameMachineHost === "string" && data.sameMachineHost
          ? data.sameMachineHost
          : null;
      const onLoopback = isLoopbackHostname(window.location.hostname);

      setPrivateAllowed(allowsPrivate);
      /* Only meaningful when the server is on this machine. On a remote
       * deployment the alias would name the *host's* loopback, which is a
       * different computer from the user's and would send them chasing a
       * connection that cannot exist. */
      setSameMachineHost(onLoopback ? hostAlias : null);

      /* Three questions in priority order.
       *
       * 1. Did this page come from loopback? If not, the server is elsewhere
       *    and no local address can work — tunnel, and nothing else matters.
       * 2. Is the server in a container? Then it is on this machine but in its
       *    own network namespace, so the address changes and the guard is also
       *    in the way. That is its own case, not a flavour of the next two.
       * 3. Otherwise it is a plain local process, and the only question left is
       *    whether this build will fetch a private address.
       *
       * Container is tested before the guard on purpose. Both need the flag,
       * but telling a container user *only* about the flag — which is what this
       * did before — swaps a refusal that explains itself for a bare connection
       * error that does not. */
      const verdict: Reach = !onLoopback
        ? "tunnel"
        : containerized
          ? "container"
          : allowsPrivate
            ? "direct"
            : "blocked";

      setReach(verdict);
      setDetectedReach(verdict);

      const list: WizardProvider[] = data.data?.providers || [];
      setExisting(
        list.find((p) => p.provider === "omniroute") ||
          list.find((p) => p.name === PROVIDER_NAME) ||
          null,
      );
    } catch (error) {
      console.error("[gateway-wizard] could not read providers:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setStep(0);
    setTestResult(null);
    setSaveError("");
    setDone(false);
    setApiKey("");
    setPastedUrl("");
    /* Cleared rather than kept: a stale "detected" from a previous session
     * would be the one piece of state on screen that nobody re-verified. */
    setProbe(null);
    void load();
  }, [isOpen, load]);

  /**
   * Keep checking for a gateway while step one is open and none has answered.
   *
   * Chained timeouts, not an interval: an interval would stack requests if one
   * hangs to its timeout, and the point is a quiet background check rather than
   * a pile of in-flight fetches. Stops on the first success — a gateway does not
   * stop being detected while a modal is open, and a poll that runs forever is
   * console noise on a page the user may leave sitting there.
   */
  useEffect(() => {
    if (!isOpen || step !== 0) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const found = await runProbe();
      if (cancelled || found) return;
      timer = setTimeout(() => void tick(), PROBE_POLL_MS);
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isOpen, step, runProbe]);

  /* Escape closes. A modal that traps you is worse than no modal, and this one
   * can be reopened from Settings at any time. */
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const handleTest = async () => {
    if (!resolvedBaseUrl) {
      setTestResult({ ok: false, message: "Enter your gateway URL first." });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch("/api/credentials/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "omniroute",
          baseUrl: resolvedBaseUrl,
          apiKey,
          /* Passing the existing id lets a blank key fall back to the stored
           * one, so re-testing a saved gateway does not require re-pasting a
           * key the browser never received. */
          ...(existing && !apiKey ? { id: existing.id } : {}),
        }),
      });
      const data = await response.json();
      setTestResult({
        ok: Boolean(data?.success),
        message:
          data?.message ||
          data?.error ||
          (response.ok ? "Connected." : `Request failed (${response.status}).`),
      });
    } catch {
      setTestResult({
        ok: false,
        message:
          "Could not reach the app's own API. Check that the dev server is still running.",
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!resolvedBaseUrl) {
      setSaveError("Enter your gateway URL first.");
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      const response = await fetch("/api/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(existing ? { id: existing.id } : {}),
          name: existing?.name || PROVIDER_NAME,
          provider: "omniroute",
          apiKey,
          baseUrl: resolvedBaseUrl,
          /* The point of the wizard is to end with a gateway you can use, not
           * one you then have to go and select. */
          makeActive: true,
        }),
      });
      const data = await response.json();
      if (!data?.success) {
        setSaveError(data?.error || `Could not save (${response.status}).`);
        return;
      }
      setDone(true);
      if (onConnected) onConnected();
    } catch {
      setSaveError("Could not save the provider. Check your connection.");
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const canAdvance =
    step < 2 || (step === 2 && (reach !== "tunnel" || pastedUrl.trim() !== ""));

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gateway-wizard-title"
        className="w-full max-w-3xl max-h-[88vh] flex flex-col rounded-2xl border border-line bg-surface-raised shadow-2xl overflow-hidden animate-fade-rise"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-line bg-surface-overlay">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 shrink-0 rounded-xl grid place-items-center border border-accent-line bg-accent-soft">
              <Terminal className="w-4 h-4 text-accent" />
            </div>
            <div className="min-w-0">
              <h2
                id="gateway-wizard-title"
                className="text-sm font-semibold text-ink-hi truncate"
              >
                Connect your OmniRoute gateway
              </h2>
              <p className="text-xs text-ink-low truncate">
                Runs on your machine. Your provider keys never leave it.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <ReachBadge reach={reach} />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="p-2 rounded-lg text-ink-low hover:text-ink-hi hover:bg-surface-hover transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {signedOut ? (
          <div className="p-8 text-center space-y-2">
            <ShieldAlert className="w-8 h-8 text-accent mx-auto" />
            <p className="text-sm text-ink">Sign in first.</p>
            <p className="text-xs text-ink-low max-w-sm mx-auto">
              Providers are saved against your account, so this wizard needs a
              session before it can store anything.
            </p>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex">
            {/* Step rail */}
            <div className="hidden sm:block w-48 shrink-0 border-r border-line bg-surface-overlay/50 p-3">
              <StepRail steps={steps} current={step} onJump={setStep} />
            </div>

            {/* Step body */}
            <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-4">
              {loading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="w-5 h-5 text-accent animate-spin" />
                </div>
              ) : done ? (
                <div className="py-10 text-center space-y-3">
                  <CheckCircle className="w-10 h-10 text-positive mx-auto" />
                  <h3 className="text-base font-semibold text-ink-hi">
                    Gateway connected
                  </h3>
                  <p className="text-xs text-ink-mid max-w-sm mx-auto leading-relaxed">
                    Saved as{" "}
                    <span className="text-ink">{existing?.name || PROVIDER_NAME}</span>{" "}
                    and set as your active provider. Its models will appear in
                    the model picker.
                  </p>
                  {reach === "tunnel" && (
                    <div className="mx-auto max-w-md text-left flex items-start gap-2 rounded-lg border border-accent-line bg-accent-soft px-3 py-2">
                      <AlertTriangle className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                      <p className="text-[11px] text-accent-ink leading-relaxed">
                        Quick tunnels are temporary. When you stop cloudflared —
                        closing the terminal, rebooting, sleeping the machine —
                        the next one gets a <em>different</em> address and this
                        saved URL stops working. Come back here and paste the new
                        one.
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {/* ---------------- Step 1: run the gateway ------------- */}
                  {step === 0 && (
                    <div className="space-y-4">
                      <div>
                        <h3 className="text-sm font-semibold text-ink-hi">
                          Install and start the gateway
                        </h3>
                        <p className="text-xs text-ink-mid mt-1 leading-relaxed">
                          OmniRoute is a separate program that runs on your own
                          computer and holds your provider accounts. This app
                          talks to it; it never sees the keys inside it.
                        </p>
                      </div>

                      <div className="space-y-3">
                        <div>
                          <p className="text-xs text-ink-low mb-1.5">
                            Install it once (needs Node.js 18 or newer):
                          </p>
                          <CommandLine command="npm install -g omniroute" />
                        </div>
                        <div>
                          <p className="text-xs text-ink-low mb-1.5">
                            Then start it, and leave this window running:
                          </p>
                          <CommandLine command="omniroute" />
                        </div>
                      </div>

                      <GatewayPresence
                        probe={probe}
                        probing={probing}
                        onRecheck={() => void runProbe()}
                      />

                      <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
                        <p className="text-[11px] text-ink-mid leading-relaxed">
                          It listens on port {GATEWAY_PORT}. If the terminal says
                          the port is already in use, the gateway is probably
                          already running — the check above will say so.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* ---------------- Step 2: unlock the dashboard -------- */}
                  {step === 1 && (
                    <div className="space-y-4">
                      <div>
                        <h3 className="text-sm font-semibold text-ink-hi">
                          Open the gateway dashboard
                        </h3>
                        <p className="text-xs text-ink-mid mt-1 leading-relaxed">
                          This is the gateway&apos;s own control panel, with its
                          own login — separate from your account here.
                        </p>
                      </div>

                      <a
                        href={GATEWAY_DASHBOARD}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface-hover hover:bg-surface-active px-3 py-2 text-xs text-ink hover:text-ink-hi transition-colors"
                      >
                        <Globe className="w-3.5 h-3.5 text-accent" />
                        <span className="font-mono">{GATEWAY_DASHBOARD}</span>
                        <ExternalLink className="w-3 h-3 text-ink-low" />
                      </a>

                      <div className="rounded-lg border border-accent-line bg-accent-soft px-3 py-2.5 space-y-1.5">
                        <p className="text-xs text-accent-ink leading-relaxed">
                          The default password is{" "}
                          <code className="px-1.5 py-0.5 rounded bg-black/40 font-mono text-accent-ink">
                            CHANGEME
                          </code>{" "}
                          unless you set{" "}
                          <code className="px-1 rounded bg-black/40 font-mono">
                            INITIAL_PASSWORD
                          </code>{" "}
                          when starting it.
                        </p>
                        <p className="text-[11px] text-accent-ink/80 leading-relaxed">
                          Change it once you are in. A default password on a
                          service holding every one of your provider keys is
                          worth thirty seconds.
                        </p>
                      </div>

                      <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
                        <p className="text-[11px] text-ink-mid leading-relaxed">
                          While you are there, add the upstream accounts you want
                          to route through — that is what gives this app models to
                          choose from. If the gateway issues its own API key, copy
                          it; you will paste it in a moment.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* ---------------- Step 3: reachability --------------- */}
                  {step === 2 && (
                    <div className="space-y-4">
                      {reach === "direct" && (
                        <>
                          <div>
                            <h3 className="text-sm font-semibold text-ink-hi">
                              This app is running on the same machine
                            </h3>
                            <p className="text-xs text-ink-mid mt-1 leading-relaxed">
                              So it can reach the gateway directly. Nothing to
                              configure here.
                            </p>
                          </div>
                          <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5 font-mono text-xs text-ink-hi">
                            {localBaseUrl}
                          </div>
                        </>
                      )}

                      {reach === "container" && (
                        <>
                          <div>
                            <h3 className="text-sm font-semibold text-ink-hi">
                              This app is on your machine, but inside a container
                            </h3>
                            <p className="text-xs text-ink-mid mt-1 leading-relaxed">
                              That changes the address, and it is the one case
                              where the obvious answer is wrong. Inside a
                              container{" "}
                              <code className="px-1 rounded bg-surface-sunken font-mono text-ink">
                                localhost
                              </code>{" "}
                              means{" "}
                              <span className="text-ink-hi font-medium">
                                the container
                              </span>
                              , not your computer — so port {GATEWAY_PORT} looks
                              empty from in there even with the gateway running
                              happily beside it.
                            </p>
                          </div>

                          <div className="rounded-xl border border-accent-line bg-accent-soft px-3.5 py-3 space-y-3">
                            <div className="flex items-center gap-2">
                              <Box className="w-4 h-4 text-accent shrink-0" />
                              <p className="text-xs font-medium text-accent-ink">
                                {privateAllowed
                                  ? "One thing to change"
                                  : "Two things to change"}
                              </p>
                            </div>

                            <div className="space-y-1.5">
                              <p className="text-[11px] text-accent-ink leading-relaxed">
                                Use the name a container uses for its host. That
                                is the address filled in below, and it is what
                                makes the request land on your machine:
                              </p>
                              <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-ink-hi break-all">
                                {localBaseUrl}
                              </div>
                            </div>

                            {!privateAllowed && (
                              <div className="space-y-1.5">
                                <p className="text-[11px] text-accent-ink leading-relaxed">
                                  That name resolves to a private address, which
                                  this build refuses by default. Allow it and
                                  restart the container:
                                </p>
                                <CommandLine command="OMNIROUTE_ALLOW_PRIVATE_GATEWAY=true" />
                                <p className="text-[11px] text-accent-ink/80 leading-relaxed">
                                  Set it only where you control the network. On a
                                  public host it re-opens exactly what the guard
                                  is there to close — every provider URL any user
                                  saves, including the cloud metadata address.
                                </p>
                              </div>
                            )}
                          </div>

                          <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5 space-y-1.5">
                            <p className="text-[11px] text-ink-mid leading-relaxed">
                              On Docker Desktop (Windows and macOS) that hostname
                              already resolves. On a Linux host it does not unless
                              the compose file asks for it — this project&apos;s
                              already does, but a hand-written{" "}
                              <code className="font-mono text-ink">docker run</code>{" "}
                              needs the flag:
                            </p>
                            <CommandLine command="--add-host=host.docker.internal:host-gateway" />
                          </div>
                        </>
                      )}

                      {reach === "blocked" && (
                        <>
                          <div>
                            <h3 className="text-sm font-semibold text-ink-hi">
                              This build refuses local addresses
                            </h3>
                            <p className="text-xs text-ink-mid mt-1 leading-relaxed">
                              You are on localhost, but the server is running in
                              production mode, where it will not fetch loopback
                              or private addresses at all. That guard is what
                              stops a deployed instance being used to reach its
                              own internal network.
                            </p>
                          </div>
                          <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5 space-y-2">
                            <p className="text-[11px] text-ink-mid leading-relaxed">
                              Since the gateway really is on this machine, allow
                              it explicitly and restart the server:
                            </p>
                            <CommandLine command="OMNIROUTE_ALLOW_PRIVATE_GATEWAY=true" />
                            <p className="text-[11px] text-ink-low leading-relaxed">
                              Only set this where you control the network. On a
                              public host it re-opens exactly what the guard is
                              there to close.
                            </p>
                          </div>
                          <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5 font-mono text-xs text-ink-hi">
                            {localBaseUrl}
                          </div>
                        </>
                      )}

                      {reach === "tunnel" && (
                        <>
                          <div>
                            <h3 className="text-sm font-semibold text-ink-hi">
                              Give your gateway a public address
                            </h3>
                            <p className="text-xs text-ink-mid mt-1 leading-relaxed">
                              This app is not running on your computer, and the
                              request to your gateway is made by{" "}
                              <span className="text-ink-hi font-medium">
                                the server
                              </span>
                              , not by your browser. So{" "}
                              <code className="px-1 rounded bg-black/40 font-mono">
                                localhost
                              </code>{" "}
                              would point the server at itself. A tunnel gives
                              your gateway an address the server can actually
                              reach.
                            </p>
                          </div>

                          <div>
                            <p className="text-xs text-ink-low mb-1.5">
                              In a second terminal, alongside the one running the
                              gateway:
                            </p>
                            <CommandLine command={TUNNEL_COMMAND} />
                            <p className="text-[11px] text-ink-low mt-1.5 leading-relaxed">
                              No cloudflared yet? Install it from{" "}
                              <a
                                href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-accent-ink underline underline-offset-2"
                              >
                                Cloudflare&apos;s downloads page
                              </a>
                              . No account is needed for a quick tunnel.
                            </p>
                          </div>

                          <div className="space-y-1.5">
                            <label className="block text-xs font-medium text-ink">
                              Paste the https URL it prints
                            </label>
                            <input
                              type="text"
                              value={pastedUrl}
                              onChange={(e) => {
                                setPastedUrl(e.target.value);
                                setTestResult(null);
                              }}
                              placeholder="https://something-random-here.trycloudflare.com"
                              spellCheck={false}
                              className="w-full px-3 py-2 rounded-lg border border-line bg-surface-sunken text-ink-hi text-xs font-mono placeholder:text-ink-faint focus:outline-none focus:border-accent-line"
                            />
                            {pastedUrl.trim() !== "" && (
                              <p className="text-[11px] text-ink-low">
                                Will be saved as{" "}
                                <span className="font-mono text-ink-mid">
                                  {resolvedBaseUrl}
                                </span>{" "}
                                — the{" "}
                                <code className="font-mono text-ink-mid">/v1</code>{" "}
                                is added for you.
                              </p>
                            )}
                          </div>

                          <div className="flex items-start gap-2 rounded-lg border border-accent-line bg-accent-soft px-3 py-2.5">
                            <AlertTriangle className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                            <p className="text-[11px] text-accent-ink leading-relaxed">
                              A quick tunnel gets a new random address every time
                              you start it. Stop cloudflared and this URL is dead
                              until you come back and paste the next one. For
                              something permanent, use a named Cloudflare tunnel
                              or any host with a fixed address.
                            </p>
                          </div>
                        </>
                      )}

                      {reach === "unknown" && (
                        <p className="text-xs text-ink-low">
                          Working out how this app can reach your gateway…
                        </p>
                      )}

                      {/* An escape hatch, because both env-var cases assume the
                        * reader can edit a file on the server and restart it.
                        * On a managed host or a machine someone else controls
                        * that is not true, and a tunnel works without touching
                        * the server at all — it should not be a dead end. */}
                      {reach !== "unknown" && reach !== "tunnel" && (
                        <button
                          type="button"
                          onClick={() => {
                            setReach("tunnel");
                            setTestResult(null);
                          }}
                          className="text-[11px] text-ink-low hover:text-ink underline underline-offset-2 transition-colors cursor-pointer"
                        >
                          Cannot change the server&apos;s configuration? Use a
                          public URL instead
                        </button>
                      )}

                      {reach === "tunnel" &&
                        detectedReach !== "tunnel" &&
                        detectedReach !== "unknown" && (
                          <button
                            type="button"
                            onClick={() => {
                              setReach(detectedReach);
                              setTestResult(null);
                            }}
                            className="text-[11px] text-ink-low hover:text-ink underline underline-offset-2 transition-colors cursor-pointer"
                          >
                            Go back to the local address
                          </button>
                        )}
                    </div>
                  )}

                  {/* ---------------- Step 4: key, test, save ------------- */}
                  {step === 3 && (
                    <div className="space-y-4">
                      <div>
                        <h3 className="text-sm font-semibold text-ink-hi">
                          Test and save
                        </h3>
                        <p className="text-xs text-ink-mid mt-1 leading-relaxed">
                          This asks the gateway for its model list. A success
                          here means the whole path works.
                        </p>
                      </div>

                      <div className="space-y-1.5">
                        <label className="block text-xs font-medium text-ink">
                          Gateway API key
                          <span className="ml-2 font-normal text-ink-faint">
                            {existing
                              ? "optional — leave blank to keep the saved one"
                              : "optional if your gateway has no key"}
                          </span>
                        </label>
                        <div className="relative">
                          <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-faint pointer-events-none" />
                          <input
                            type="password"
                            value={apiKey}
                            onChange={(e) => {
                              setApiKey(e.target.value);
                              setTestResult(null);
                            }}
                            placeholder="sk-…"
                            autoComplete="off"
                            spellCheck={false}
                            className="w-full pl-9 pr-3 py-2 rounded-lg border border-line bg-surface-sunken text-ink-hi text-xs font-mono placeholder:text-ink-faint focus:outline-none focus:border-accent-line"
                          />
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <span className="block text-xs font-medium text-ink">
                          Base URL
                        </span>
                        <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-ink-hi break-all">
                          {resolvedBaseUrl || "—"}
                        </div>
                        <p className="text-[11px] text-ink-faint leading-relaxed">
                          {reach === "tunnel"
                            ? "The public address of your gateway, as the server will see it."
                            : reach === "container"
                              ? "Your machine, named the way a container has to name it."
                              : "Your machine, reached directly."}
                        </p>
                      </div>

                      {/* Shown before the test, not after it, so a failure that
                        * was always going to happen is explained in advance
                        * rather than arriving as a bare connection error. */}
                      {probe && !probe.present && (
                        <div className="flex items-start gap-2 rounded-lg border border-accent-line bg-accent-soft px-3 py-2.5">
                          <AlertTriangle className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                          <p className="text-[11px] text-accent-ink leading-relaxed">
                            Your browser could not find a gateway on this machine
                            a moment ago. If it is not running, start it with{" "}
                            <code className="px-1 rounded bg-surface-sunken font-mono">
                              omniroute
                            </code>{" "}
                            first — the test below will fail otherwise.
                          </p>
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleTest}
                          disabled={testing || !resolvedBaseUrl}
                          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-line bg-surface-hover hover:bg-surface-active text-xs font-medium text-ink hover:text-ink-hi disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                        >
                          {testing ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Globe className="w-3.5 h-3.5" />
                          )}
                          Test connection
                        </button>
                      </div>

                      {testResult && (
                        <div
                          className={`flex items-start gap-2 rounded-lg px-3 py-2.5 border ${
                            testResult.ok
                              ? "border-positive-line bg-positive-soft"
                              : "border-danger-line bg-danger-soft"
                          }`}
                        >
                          {testResult.ok ? (
                            <CheckCircle className="w-4 h-4 text-positive shrink-0 mt-0.5" />
                          ) : (
                            <XCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                          )}
                          <p
                            className={`text-[11px] leading-relaxed ${
                              testResult.ok ? "text-positive" : "text-danger"
                            }`}
                          >
                            {testResult.message}
                          </p>
                        </div>
                      )}

                      {saveError && (
                        <div className="flex items-start gap-2 rounded-lg border border-danger-line bg-danger-soft px-3 py-2.5">
                          <XCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                          <p className="text-[11px] text-danger leading-relaxed">
                            {saveError}
                          </p>
                        </div>
                      )}

                      {/* Saving without testing stays possible on purpose: a
                        * gateway can be up while its model list is empty, and
                        * refusing to save would leave that user stuck. */}
                      <p className="text-[11px] text-ink-faint leading-relaxed">
                        You can save without testing, but an untested gateway
                        shows up as an empty model picker rather than as an
                        error.
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        {!signedOut && !loading && (
          <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-t border-line bg-surface-overlay">
            {done ? (
              <>
                <span className="text-[11px] text-ink-low">
                  You can reopen this from Settings at any time.
                </span>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-lg bg-accent hover:bg-accent-hi text-black text-xs font-semibold transition-colors cursor-pointer"
                >
                  Done
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setStep((s) => Math.max(0, s - 1))}
                  disabled={step === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-ink-mid hover:text-ink-hi hover:bg-surface-hover disabled:opacity-0 disabled:pointer-events-none transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back
                </button>

                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-ink-faint sm:hidden">
                    Step {step + 1} of {steps.length}
                  </span>
                  {step < steps.length - 1 ? (
                    <button
                      type="button"
                      onClick={() => setStep((s) => s + 1)}
                      disabled={!canAdvance}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent hover:bg-accent-hi text-black text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    >
                      Next
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={saving || !resolvedBaseUrl}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent hover:bg-accent-hi text-black text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    >
                      {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      Save and activate
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
