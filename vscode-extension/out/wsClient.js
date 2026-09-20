"use strict";
/**
 * vscode-extension/src/wsClient.ts
 * ---------------------------------------------------------------------------
 * The socket that connects this editor to an OmniRoute account.
 *
 * WHAT CHANGED AND WHY
 *
 * The first version of this file was written for one machine: the app and the
 * editor on the same laptop, one token in `settings.json`, a five-second
 * retry forever. Three things about it do not survive contact with a hosted
 * deployment and a real user:
 *
 *   1. The token was sent as `?token=` on the URL. Query strings are written
 *      to the reverse proxy's access log — Caddy's default format records the
 *      full URI — so every connection put a live credential on disk in
 *      cleartext, on the server, where it stays until the logs rotate. It now
 *      goes in an `Authorization: Bearer` header, which is not logged.
 *
 *   2. A rejected token was indistinguishable from a network blip, so a
 *      revoked or mistyped credential was retried every five seconds forever.
 *      That is a login attempt every five seconds against someone else's
 *      server, from a client that will never succeed, with no message telling
 *      the user why. `ws` exposes the failed handshake through the
 *      `unexpected-response` event — the one place the refusal is still an
 *      HTTP status that can be read — so 401 and 403 now stop the loop and say
 *      what to do instead.
 *
 *   3. A fixed five-second retry is fine for a process that just restarted and
 *      cruel to a server that is down. Backoff is exponential with a ceiling
 *      and a little jitter, so a thousand extensions coming back after an
 *      outage do not arrive in lockstep.
 *
 * WHAT DELIBERATELY DID NOT CHANGE
 *
 * The frame format. The server replies to `{id, result}` / `{id, error}` and
 * ignores anything with an unknown id (see `handleMessage` in vscodeBridge.ts),
 * so this side stays exactly as it was: parse, dispatch, reply with the same
 * id. Changing both halves of an RPC protocol at once is how a protocol ends
 * up with two incompatible versions in the wild, and the .vsix is distributed
 * by hand over WhatsApp — there is no way to force an upgrade.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OmniRouteWSClient = void 0;
const ws_1 = __importDefault(require("ws"));
const vscode = __importStar(require("vscode"));
const pairing_1 = require("./pairing");
/** First retry delay; doubles per attempt. */
const BACKOFF_BASE_MS = 1_000;
/** Ceiling. Beyond about a minute the user will have clicked Reconnect anyway. */
const BACKOFF_MAX_MS = 60_000;
/** Give up on a handshake that has not completed in this long. */
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Keepalive interval. Idle WebSockets are dropped by proxies and NAT tables. */
const PING_INTERVAL_MS = 30_000;
/** No pong for this long means the path is dead even though the socket looks open. */
const PONG_GRACE_MS = 90_000;
class OmniRouteWSClient {
    context;
    ws = null;
    reconnectTimer = null;
    pingTimer = null;
    lastPongAt = 0;
    attempt = 0;
    isExplicitDisconnect = false;
    /** Set when the server refused the credential; cleared only by re-pairing. */
    authFailed = false;
    status = { kind: "unpaired" };
    listeners = [];
    messageHandler;
    pairingStore;
    constructor(context) {
        this.context = context;
        this.pairingStore = new pairing_1.PairingStore(context);
    }
    /* ------------------------------- status ------------------------------- */
    onStatusChange(cb) {
        this.listeners.push(cb);
    }
    currentStatus() {
        return this.status;
    }
    isConnected() {
        return this.status.kind === "connected";
    }
    setStatus(status) {
        this.status = status;
        for (const listener of this.listeners) {
            try {
                listener(status);
            }
            catch (err) {
                /* A broken status listener must not stop the socket from working. */
                console.warn("[OmniRoute] status listener threw:", err);
            }
        }
    }
    setMessageHandler(handler) {
        this.messageHandler = handler;
    }
    /* ----------------------------- connecting ----------------------------- */
    /**
     * Open the socket, reading the credential from the OS keychain.
     *
     * Async because `SecretStorage` is. Callers that do not care about the
     * outcome should `void` it rather than leaving a floating promise.
     */
    async connect() {
        this.isExplicitDisconnect = false;
        this.clearReconnectTimer();
        const pairing = await this.pairingStore.read();
        if (!pairing) {
            this.setStatus({ kind: "unpaired" });
            return;
        }
        /* Replacing an existing socket rather than opening a second one. The
         * server closes the older session for the same account when a new one
         * arrives, so two live sockets from one editor would fight. */
        if (this.ws) {
            const stale = this.ws;
            this.ws = null;
            try {
                stale.removeAllListeners();
                stale.close();
            }
            catch {
                /* Already gone. */
            }
        }
        this.setStatus({ kind: "connecting", url: pairing.url });
        let socket;
        try {
            socket = new ws_1.default(pairing.url, {
                /* The credential, in the header meant for credentials. `ws` is a Node
                 * client, so unlike a browser it can set this — which is exactly why
                 * the extension never needs the query-string transport the server
                 * still accepts for other clients. */
                headers: {
                    Authorization: `Bearer ${pairing.token}`,
                    "User-Agent": `OmniRoute-VSCode/${this.extensionVersion()}`,
                },
                handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
            });
        }
        catch (err) {
            /* Constructor throws only for a malformed URL, which re-pairing fixes;
             * retrying would loop on the same bad string. */
            this.setStatus({
                kind: "rejected",
                url: pairing.url,
                reason: err?.message || "That bridge address could not be used.",
            });
            return;
        }
        this.ws = socket;
        /* Held per-socket so the close handler can say what actually went wrong.
         *
         * `ws` reports a failed dial as an `error` carrying the Node errno and then
         * a `close` with code 1006 and an EMPTY reason — so the close handler on its
         * own could only ever say "The connection closed", which is what it used to
         * do. That sentence is true and useless: it reads as "you were connected and
         * the link dropped" when the usual cause is that the OmniRoute server is not
         * running at all, and it sent people looking for a network fault instead of
         * starting the app. */
        let lastTransportError = null;
        socket.on("open", () => {
            if (this.ws !== socket)
                return;
            this.attempt = 0;
            this.authFailed = false;
            this.lastPongAt = Date.now();
            this.startKeepalive(socket);
            this.setStatus({ kind: "connected", url: pairing.url, since: Date.now() });
        });
        socket.on("message", (data) => {
            if (this.ws !== socket)
                return;
            void this.handleMessage(socket, data.toString());
        });
        socket.on("pong", () => {
            this.lastPongAt = Date.now();
        });
        /**
         * The handshake was answered with an HTTP response instead of an upgrade.
         *
         * This is the only moment a refusal is still readable: once the socket is
         * open there are no status codes, and if nothing listens here `ws` turns
         * the whole thing into a generic `error` with the status buried in a
         * string. Listening makes the request ours to clean up, hence the
         * `destroy` calls — without them the socket leaks.
         */
        socket.on("unexpected-response", (req, res) => {
            const statusCode = res.statusCode || 0;
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
                /* The server's refusal is a short sentence. Cap it anyway — this is an
                 * unauthenticated response from a host that might not be ours. */
                if (body.length < 512)
                    body += chunk;
            });
            res.on("end", () => {
                try {
                    req.destroy();
                }
                catch {
                    /* Already torn down. */
                }
                if (this.ws !== socket)
                    return;
                this.ws = null;
                this.handleHandshakeRefusal(pairing.url, statusCode, body.trim());
            });
        });
        socket.on("close", (code, reasonBuf) => {
            if (this.ws !== socket)
                return;
            this.ws = null;
            this.stopKeepalive();
            const reason = reasonBuf?.toString() || "";
            /* 4001 is the server's own "Unauthorised" after an accepted upgrade, and
             * 1008 is the standard policy-violation close. Both mean the credential
             * is the problem, so neither is worth retrying. */
            if (code === 4001 || code === 1008) {
                this.authFailed = true;
                this.setStatus({
                    kind: "rejected",
                    url: pairing.url,
                    reason: reason || "The server refused this pairing code.",
                });
                this.reportAuthFailure(reason || "The server refused this pairing code.");
                return;
            }
            if (this.isExplicitDisconnect) {
                this.setStatus({ kind: "offline" });
                return;
            }
            this.scheduleReconnect(pairing.url, reason || this.describeTransportFailure(lastTransportError, pairing.url));
        });
        socket.on("error", (err) => {
            /* Not a status change on its own: `error` is always followed by `close`,
             * and the close handler decides what happens next. Kept here so that
             * handler can name the cause, and logged so it is visible in the
             * Extension Host output either way. */
            lastTransportError = err;
            console.warn("[OmniRoute] socket error:", err.message);
        });
    }
    extensionVersion() {
        const version = this.context.extension?.packageJSON
            ?.version;
        return version || "0.0.0";
    }
    /**
     * Turn a failed dial into a sentence that names the next thing to try.
     *
     * These are all transient by definition — the close handler has already ruled
     * out the permanent refusals (4001/1008 here, 401/403 in
     * `handleHandshakeRefusal`), so everything reaching this point is worth
     * retrying. The point is not to change the decision, it is to stop the
     * retrying state from being mute about WHY it is retrying.
     *
     * ECONNREFUSED is far and away the common one and it has a specific meaning
     * that is easy to act on: the address is right and reachable, and nothing is
     * listening on that port. For a default install that is the OmniRoute server
     * not running, not a network problem.
     */
    describeTransportFailure(err, url) {
        const code = err?.code;
        switch (code) {
            case "ECONNREFUSED":
                return `Nothing is listening at ${url}. Is the OmniRoute server running?`;
            case "ENOTFOUND":
            case "EAI_AGAIN":
                return `That address could not be looked up (${url}).`;
            case "ETIMEDOUT":
            case "EHOSTUNREACH":
            case "ENETUNREACH":
                return "The server did not answer in time.";
            case "ECONNRESET":
                return "The server closed the connection unexpectedly.";
            case "CERT_HAS_EXPIRED":
            case "DEPTH_ZERO_SELF_SIGNED_CERT":
            case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
                return "The server's HTTPS certificate could not be verified.";
            default:
                /* An error with no errno still beats the old blanket sentence, as long
                 * as it is short enough to sit in a tooltip. */
                return err?.message && err.message.length < 120
                    ? err.message
                    : "The connection closed.";
        }
    }
    /**
     * Decide what a refused handshake means.
     *
     * 401 and 403 are decisions, not failures: the server understood the request
     * and said no. Retrying cannot change the answer, so the loop stops and the
     * user is told. Everything else — 502 from a proxy with no backend, 404 from
     * a path that is not routed yet, 503 during a deploy — is a condition that
     * clears on its own, so those keep retrying.
     */
    handleHandshakeRefusal(url, statusCode, body) {
        const detail = body && body.length < 300 ? body : "";
        if (statusCode === 401 || statusCode === 403) {
            this.authFailed = true;
            const reason = detail ||
                (statusCode === 401
                    ? "That pairing code is not valid any more."
                    : "This server refused the connection.");
            this.setStatus({ kind: "rejected", url, reason });
            this.reportAuthFailure(reason);
            return;
        }
        if (statusCode === 404) {
            /* Worth its own message: 404 means the address is reaching a real web
             * server that is not routing the bridge path — an operator-side
             * misconfiguration that no amount of retrying fixes, but which the user
             * cannot distinguish from "offline" without being told. */
            this.setStatus({
                kind: "rejected",
                url,
                reason: `${url} answered "not found". The address is reaching a server, but that server is not ` +
                    `forwarding the bridge. Check the address in OmniRoute's Connect VS Code panel.`,
            });
            return;
        }
        this.scheduleReconnect(url, detail || `The server answered ${statusCode || "unexpectedly"} instead of accepting the connection.`);
    }
    reportAuthFailure(reason) {
        void vscode.window
            .showErrorMessage(`OmniRoute: ${reason}`, "Sign in again")
            .then((choice) => {
            if (choice === "Sign in again") {
                void vscode.commands.executeCommand("omniroute.signIn");
            }
        });
    }
    /* ---------------------------- disconnecting --------------------------- */
    /**
     * Close the socket and stop trying.
     *
     * `silent` exists for `deactivate()`: VS Code is shutting the extension host
     * down, and a notification raised at that moment either flashes past or is
     * never rendered at all.
     */
    disconnect(options = {}) {
        this.isExplicitDisconnect = true;
        this.clearReconnectTimer();
        this.stopKeepalive();
        this.attempt = 0;
        if (this.ws) {
            const socket = this.ws;
            this.ws = null;
            try {
                socket.removeAllListeners();
                socket.close(1000, "Disconnected by the user.");
            }
            catch {
                /* Already gone. */
            }
        }
        this.setStatus({ kind: "offline" });
        if (!options.silent) {
            void vscode.window.showInformationMessage("OmniRoute: disconnected. Your account stays paired — use “OmniRoute: Connect” to reconnect.");
        }
    }
    /** Drop and immediately reopen. Used after consent changes. */
    async reconnect() {
        this.disconnect({ silent: true });
        this.authFailed = false;
        this.attempt = 0;
        await this.connect();
    }
    /** Forget the retry state so a fresh pairing is not blocked by an old refusal. */
    resetAuthFailure() {
        this.authFailed = false;
        this.attempt = 0;
    }
    /* ------------------------------ retrying ------------------------------ */
    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
    scheduleReconnect(url, reason) {
        if (this.isExplicitDisconnect || this.authFailed)
            return;
        if (this.reconnectTimer)
            return;
        this.attempt += 1;
        /* Exponential, capped, with jitter. The jitter matters when a server comes
         * back after an outage: without it every extension that was retrying
         * reconnects in the same tick. */
        const exponential = Math.min(BACKOFF_BASE_MS * 2 ** (this.attempt - 1), BACKOFF_MAX_MS);
        const jitter = exponential * 0.2 * (Math.random() * 2 - 1);
        const delay = Math.max(500, Math.round(exponential + jitter));
        this.setStatus({ kind: "retrying", url, attempt: this.attempt, retryInMs: delay, reason });
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.isExplicitDisconnect || this.authFailed)
                return;
            void this.connect();
        }, delay);
    }
    /* ----------------------------- keepalive ------------------------------ */
    startKeepalive(socket) {
        this.stopKeepalive();
        this.pingTimer = setInterval(() => {
            if (this.ws !== socket || socket.readyState !== ws_1.default.OPEN) {
                this.stopKeepalive();
                return;
            }
            /* A TCP connection can be dead for minutes while the socket still reads
             * as OPEN — the classic silently-dropped-by-a-NAT-table case. Unanswered
             * pings are the only way this side finds out, and `terminate` rather
             * than `close` because a half-open socket will not complete a closing
             * handshake. */
            if (this.lastPongAt && Date.now() - this.lastPongAt > PONG_GRACE_MS) {
                console.warn("[OmniRoute] no pong within the grace period; restarting the connection.");
                try {
                    socket.terminate();
                }
                catch {
                    /* Ignore; the close handler will run either way. */
                }
                return;
            }
            try {
                socket.ping();
            }
            catch {
                /* Ignore; the close handler will run either way. */
            }
        }, PING_INTERVAL_MS);
    }
    stopKeepalive() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }
    /* ------------------------------ messages ------------------------------ */
    /**
     * One request in, one reply out, same id.
     *
     * Anything without an id is ignored rather than answered: the server only
     * ever matches replies by id (`handleMessage` in vscodeBridge.ts drops
     * unknown ids), so a reply to an id-less frame would be discarded anyway,
     * and answering unsolicited frames from whatever is on the other end of the
     * socket is not a habit worth having.
     */
    async handleMessage(socket, rawMessage) {
        let payload;
        try {
            payload = JSON.parse(rawMessage);
        }
        catch {
            return;
        }
        const id = payload?.id;
        if (!id)
            return;
        if (!this.messageHandler) {
            /* `activate()` installs the handler before connecting, so this is
             * unreachable in practice. It answers rather than hanging, because a
             * silent drop would cost the caller the full 15-second RPC timeout. */
            this.sendError(socket, id, "The OmniRoute extension is still starting up.");
            return;
        }
        try {
            const result = await this.messageHandler(payload);
            this.sendResponse(socket, id, result);
        }
        catch (err) {
            this.sendError(socket, id, err?.message || String(err));
        }
    }
    sendResponse(socket, id, result) {
        if (socket.readyState === ws_1.default.OPEN) {
            socket.send(JSON.stringify({ id, result }));
        }
    }
    sendError(socket, id, error) {
        if (socket.readyState === ws_1.default.OPEN) {
            socket.send(JSON.stringify({ id, error }));
        }
    }
}
exports.OmniRouteWSClient = OmniRouteWSClient;
//# sourceMappingURL=wsClient.js.map