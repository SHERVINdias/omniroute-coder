# AWS deployment — fixing the VS Code bridge and the local gateway

**Status:** written 2026-09-21, against the code actually in this repo today.
**Supersedes:** nothing. `AWS_DEPLOYMENT_CHECKLIST.md` is stale; ignore it and use this.
**Changes no code.** Everything here is configuration, commands, or things testers do on their own machines.

---

## 0. What actually went wrong

Two features assume *the app and the person using it are the same machine*. On your
laptop that was true, so neither assumption was ever tested. On EC2 it is false.

| Symptom | Real cause | Fixable on the server? |
|---|---|---|
| VS Code extension won't connect | Bridge listener never bound, or Caddy has no route to it, or the extension is still paired to `127.0.0.1` | Yes — §1–§4 |
| `localhost:20128` gateway fails | `/api/models` and `/api/chat` fetch the provider URL **server-side**, so `localhost` means EC2 | No — needs a tunnel, §5 |

Work through the sections in order. §1 is the most likely single cause.

---

## 1. The CRLF trap — check this before anything else

`src/lib/deploymentMode.ts:83` is a **strict** comparison with no trimming:

```ts
return process.env.OMNIROUTE_BRIDGE_ENABLE === "true";
```

You edit `.env.production` on Windows. If that file reached the server with CRLF
line endings, the value is `"true\r"` — which is not `"true"`, so the listener
silently never binds. Nothing logs an error, because from the app's point of view
you simply didn't opt in.

This fails *selectively*, which is why it's so confusing: `bridgePublicUrl()` and
`trustProxyHeaders()` both call `.trim()`, so they keep working. Only the bridge dies.

**Detect it.** On the EC2 box, in the directory holding `docker-compose.yml`:

```bash
docker compose exec app printenv OMNIROUTE_BRIDGE_ENABLE | cat -A
```

- `true$` — clean, this is not your problem, move to §2.
- `true^M$` — **found it.** The `^M` is the carriage return.

**Fix it.** Strip CRLF from the whole file and restart:

```bash
cp .env.production .env.production.bak
sed -i 's/\r$//' .env.production
docker compose up -d --force-recreate
```

Re-run the detect command. It should now print `true$`.

> Do this even if the check looked clean — every other variable in that file has the
> same problem, and some of them (secrets, Gmail app password) fail in quieter ways.

---

## 2. Confirm the listener is actually bound

Enablement and binding are different things. Check the socket, not the flag:

```bash
docker compose logs app | grep -i bridge

docker compose exec app node -e "require('net').connect(20129,'127.0.0.1').on('connect',()=>{console.log('OPEN');process.exit(0)}).on('error',e=>{console.log('CLOSED',e.code);process.exit(1)})"
```

`OPEN` means the listener is up inside the container. Then check it's reachable
from the host, since that's what Caddy will dial:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:20129/
```

Any HTTP response at all (including 400 or 426) means the port is published
correctly. Connection refused means the `"127.0.0.1:20129:20129"` publish line in
`docker-compose.yml` isn't in effect — re-run `docker compose up -d`.

> `nc` and `wget` are not installed in the slim image, which is why the in-container
> check uses `node -e`.

---

## 3. Give Caddy a route to the bridge

There is no Caddyfile in this repo — you wrote it on the server, and if it only
has a single catch-all then `wss://<your-domain>/vscode-bridge` lands on Next.js
at port 3005, which has no such route. The WebSocket upgrade fails.

Edit `/etc/caddy/Caddyfile`. The bridge block must come **before** the catch-all,
because Caddy evaluates `handle` blocks in order:

```
your-domain.example.com {
    encode gzip

    handle /vscode-bridge* {
        reverse_proxy 127.0.0.1:20129
    }

    handle {
        reverse_proxy 127.0.0.1:3005
    }
}
```

Then:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Two things worth knowing:

- **`handle_path` also works.** `vscodeBridge.ts:1358` accepts either `/` or
  `/vscode-bridge`, so it doesn't matter whether the prefix is stripped. Use
  whichever you prefer.
- **No extra security group rule is needed.** The bridge rides on 443 with
  everything else. If you opened port 20129 in your EC2 security group, close it —
  that would be an unencrypted filesystem RPC port facing the internet.

---

## 4. The one-request diagnosis, and re-pairing

### 4a. Ask the server what it thinks

Sign in to your deployed site in a browser, then visit:

```
https://your-domain.example.com/api/extension/token
```

You get JSON with two fields that settle everything:

- **`bridgeReady`** — `false` means §1 or §2 is still wrong. Go back.
- **`wsUrl`** — the address the extension will be told to dial. It must read
  `wss://your-domain.example.com/vscode-bridge`.

If `wsUrl` says `ws://127.0.0.1:20129`, the server thinks the request arrived over
loopback. Set the address explicitly rather than relying on forwarded headers — in
`.env.production` (line 514, currently empty):

```
OMNIROUTE_BRIDGE_PUBLIC_URL=wss://your-domain.example.com/vscode-bridge
```

Then `docker compose up -d --force-recreate` and re-check.

### 4b. Re-pair every tester's extension

**A pairing code carries the server address inside it.** A code minted by your
laptop contains `ws://127.0.0.1:20129`, and `pairing.ts:438` falls back to that
same local address when a stored pairing has no URL. So an extension paired
against your local instance keeps dialling the tester's own machine — and fails by
*timing out*, which is indistinguishable from the server being down.

Every tester must, in VS Code:

1. Run **`OmniRoute: Sign Out`** from the command palette. This is not optional —
   it clears the stale address.
2. On the deployed site, open the sidebar → **Connect VS Code** → generate a code.
3. Run **`OmniRoute: Connect (paste pairing code)`** and paste the fresh code.

The shipped `public/downloads/omniroute-vscode-0.4.0.vsix` is current (verified
0.4.0), so no rebuild is needed — but confirm testers installed *that* file and not
an older copy still sitting in their Downloads folder.

---

## 5. The local gateway — why no server setting can fix it

`/api/models` and `/api/chat` fetch the provider base URL **from the EC2 box**, not
from the browser. So `http://localhost:20128/v1` tells EC2 to dial its own
loopback. Nothing is there.

It worked in local Docker because two things lined up that don't exist on AWS:
`extra_hosts` provided `host.docker.internal`, and `.env.production:287` sets
`OMNIROUTE_ALLOW_PRIVATE_GATEWAY=true`.

### 5a. SECURITY — turn that flag off on the server

```bash
docker compose exec app printenv OMNIROUTE_ALLOW_PRIVATE_GATEWAY
```

If this prints `true`, fix it now. Set line 287 of `.env.production` to:

```
OMNIROUTE_ALLOW_PRIVATE_GATEWAY=false
```

and `docker compose up -d --force-recreate`.

Two reasons, and the second is the important one:

1. **It would not help anyway.** Your testers' laptops are behind NAT. There is no
   route from EC2 to them regardless of what the guard permits.
2. **It disables `src/lib/ssrfGuard.ts` for every URL every user saves.** That guard
   is the only thing stopping a signed-in tester from pointing a provider at
   `169.254.169.254`, `10.x`, or anything else inside your VPC. If your instance
   enforces IMDSv2 the credential-theft path is blunted, but "any beta tester can
   make my server issue arbitrary requests into my private network" is not a
   property you want during a public beta.

### 5b. What testers actually do

Send them this verbatim:

> Your OmniRoute gateway runs on your computer, but OmniRoute Coder runs on a
> server — it can't see your machine. Give your gateway a temporary public address:
>
> 1. Install cloudflared: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>
> 2. Start your OmniRoute gateway as usual (it listens on port 20128).
> 3. In a second terminal, run:
>
>    ```
>    cloudflared tunnel --url http://localhost:20128
>    ```
>
> 4. It prints a URL like `https://random-words-here.trycloudflare.com`.
> 5. In OmniRoute Coder → Settings → your provider, set the **Base URL** to that
>    address **with `/v1` on the end**:
>    `https://random-words-here.trycloudflare.com/v1`
>
> Leave that terminal open — closing it kills the tunnel. The address changes each
> time you restart it, so paste the new one into Settings when it does.

The `/v1` suffix is the step people skip, and omitting it produces a 404 that reads
like an authentication failure.

> **Caveat worth setting expectations on:** free `trycloudflare.com` tunnels get a
> new hostname on every restart. For ten testers over a short beta that's tolerable.
> If it becomes painful, a named Cloudflare tunnel gives a stable hostname for free
> but needs a domain on Cloudflare.

---

## 6. End-to-end verification

Run these in order. Each one should pass before you try the next.

```bash
# 1. App alive and database readable
curl -sS https://your-domain.example.com/api/health
# expect: {"status":"ok","database":"ok"}

# 2. No CRLF anywhere in the env file
docker compose exec app printenv | grep -c $'\r'
# expect: 0

# 3. Private-gateway guard is ON
docker compose exec app printenv OMNIROUTE_ALLOW_PRIVATE_GATEWAY
# expect: false   (or no output at all)

# 4. Bridge listener bound
docker compose exec app node -e "require('net').connect(20129,'127.0.0.1').on('connect',()=>{console.log('OPEN');process.exit(0)}).on('error',e=>{console.log('CLOSED',e.code);process.exit(1)})"
# expect: OPEN

# 5. Caddy routes the bridge path
curl -sS -o /dev/null -w '%{http_code}\n' https://your-domain.example.com/vscode-bridge
# expect: 426   — NOT 404, NOT 502
```

**426 is the answer you want, and it is a strong signal.** The bridge is a
`ws` `WebSocketServer` bound to its own internal HTTP server, and that server
replies `426 Upgrade Required` to any request that isn't a WebSocket handshake.
So a 426 proves the request travelled all the way through Caddy and was answered
*by the bridge itself*. A 404 means Next.js answered instead (no Caddy route);
a 502 means Caddy has the route but nothing is listening behind it.

Note that the token check does **not** run here — `verifyClient` only fires on a
real upgrade — so a 426 says nothing about whether pairing works. It only proves
the path is wired.

Then in a browser, signed in: `GET /api/extension/token` shows
`bridgeReady: true` and a `wss://` `wsUrl`. Then in VS Code: sign out, re-pair,
approve a folder, and ask the model to read a file.

---

## 7. Symptom → cause lookup

| What you see | Look at |
|---|---|
| Extension: "connection refused", instantly | §1 (CRLF) or §2 — listener not bound |
| Extension: hangs, then times out | §4b — still paired to `127.0.0.1` |
| Extension: connects then immediately drops | §3 — Caddy routing `/vscode-bridge` to port 3005 |
| `/vscode-bridge` returns 404 | §3 — no `handle` block, or it's after the catch-all |
| `/vscode-bridge` returns 502 | §2 — Caddy found the route, nothing is listening behind it |
| Sign-in appears to work but doesn't stick | TLS isn't terminating; the session cookie is `secure` in production |
| Gateway: "connection refused" from the app | §5 — expected. Use a tunnel. |
| Gateway: 404 from the tunnel URL | Missing `/v1` on the Base URL |
| App restarts under load | `mem_limit` / `NODE_OPTIONS` pair in `docker-compose.yml` |

---

## 8. Note for later — this class of bug goes away on desktop

Every failure in this document exists because the server and the user are different
machines. A desktop build (Electron or Tauri wrapping the existing
`.next/standalone` server on `127.0.0.1`) removes the cause rather than patching
the symptoms: the gateway is genuinely local, the bridge needs no Caddy and no TLS,
`http://127.0.0.1` is a secure context so the session cookie behaves, and there is
no EC2 bill.

The agreed direction is a **hybrid**: desktop app for chat, files and the VS Code
bridge; a small cloud service retaining sign-in/OTP, the admin panel, payments and
licensing. That keeps the Gmail app password server-side — shipping it inside a
desktop binary would let any user extract it and send mail as you.

Not scoped yet. This section exists so the reasoning isn't lost.
