# AWS deployment runbook — omniroute-coder on a t4g.small in Mumbai

This replaces an earlier version of this file that was written against an
imagined deployment rather than this one. Roughly a third of it was wrong in
ways that would have cost an afternoon each: it said the container publishes
port 80, that the database lives at `/app/chat.db` under a variable called
`DATABASE_PATH`, that Caddy should proxy to `localhost:80`, and that the app
"auto-backs up to `chat.db.backup-*` files". None of those are true of this
codebase. Every command below was checked against the actual source, and where
something could not be checked from here it says so.

`DEPLOYMENT.md` covers the architecture and the platform trade-offs. This file
is the sequence of commands for one specific target: **Ubuntu 22.04 LTS ARM64
on a `t4g.small` in `ap-south-1`, behind Caddy, with a DuckDNS name.**

---

## Read this before you start

**Four things in this app will refuse to start rather than run unsafely.**
`src/lib/productionGuard.ts` runs at boot and aborts if `AUTH_DEV_SHOW_OTP` is
true, if `UPI_AUTO_APPROVE` is true, if `AUTH_SECRET` is missing, or if
`AUTH_SECRET` or `CREDENTIALS_SECRET` is short enough to have been typed by a
person. That is deliberate. The first two produce an app that looks completely
normal and has no working authentication or no working paywall. If the container
exits immediately after `docker compose up`, read the logs before changing
anything — it will have printed exactly which value it objected to.

There used to be a fifth: `OMNIROUTE_ENABLE_FILE_TOOLS=true` was fatal, because
the file tools read and wrote *this server's* disk and every signed-in account
shared it. They no longer do — see the bridge note below — so it is now a
supported configuration rather than a refusal. §5.3 covers what to set.

**The container's port is bound to loopback on purpose.** `docker-compose.yml`
publishes `127.0.0.1:3005:3005`, not `3005:3005`. You will read advice telling
you to "expose 3005 so Caddy can reach it". Do not. Caddy runs on the host in
this layout, so the host's own loopback is exactly where it should look, and
changing the binding to `0.0.0.0` would put plaintext HTTP on the public
internet — where the session cookie, issued with `secure: true` in production,
is never sent back by the browser. The symptom is a site that loads fine and
where sign-in silently does not stick.

**Do not open port 20129 in the security group.** That has not changed, but the
reason has, and so has what the port is for.

Port 20129 is the VS Code bridge: a WebSocket that carries file reads, writes
and commands. An earlier draft of this file said it was authorised "by the
single test *is the TCP peer 127.0.0.1*", and that behind a reverse proxy every
caller on the internet would pass that test. Both were true, and that is exactly
why the check was replaced. The upgrade now requires a pairing token minted per
account, stored only as a hash, resolving to one user id; no token, an unknown
token or a revoked one is refused with 401 before a single RPC frame is read.
The caller's network position is no longer part of the decision.

And what an authenticated socket reaches is not this machine. Every file
operation is forwarded to *that user's own editor* and runs there. A production
build has no fallback to the server's filesystem: the call reaches their VS Code
or it fails. Testers' code never arrives here, and nothing on this box is
readable through the bridge.

So the port is still closed at the firewall — but it is published to the host's
loopback and proxied by Caddy at `wss://<your-host>/vscode-bridge`, which means
testers reach it over 443 with everything else. One certificate, one security
group rule, and no high port for a corporate network to block outbound. §4.2 has
the Caddy configuration.

The bridge **starts itself** — `src/lib/vscodeBridge.ts` calls `initialize()`
at import time on the server, and the chat route imports that module. In a
production build it then refuses to bind unless `OMNIROUTE_BRIDGE_ENABLE=true`.
Leave the variable unset and the listener never opens, the pairing UI says the
operator has not enabled it, and the file tools switch themselves off to match.
Set it and the bridge is accepting authenticated editor connections on the next
boot. (An even earlier draft said "nothing in the app currently starts it" —
that was wrong then and is still wrong.)

---

## Phase 0 — on your Windows machine, before AWS

### 0.1 Rotate the credentials that are already burned

These exist in plaintext in the working directory and must be treated as
compromised. Revoke and reissue each one at its provider before anything goes
public:

| Where | What |
|---|---|
| `providers.json` | an OmniRoute gateway key, an APINeX key, a Google API key |
| `user_local.env` | an OmniRoute gateway key |
| `.env.local` | `OMNIROUTE_API_KEY`, `TAVILY_API_KEY` |

None of these files reach the server: `.dockerignore` keeps them out of the
image and `.gitignore` keeps them out of a push. Rotating them is about the
copies that already exist on disk, not about the deployment.

While you are in there, delete any `ADMIN_PASSWORD` line you find. Nothing
reads it any more — admin is granted by the `ADMIN_EMAILS` / `ADMIN_PHONES`
allowlist at sign-in — and a dead secret in a config file is a thing someone
will one day assume is live.

### 0.2 Make the repository actually contain the app

This one will waste a whole evening if it is missed. The repository currently
has **one commit** ("Initial commit from Create Next App"), **no remote**, and
**19 tracked files, only 4 of them under `src/`**. Everything written since —
all of `src/lib`, all of `src/app/api`, the `Dockerfile`, `docker-compose.yml`
— is untracked. A `git clone` onto the EC2 box today would deliver a stock
Create-Next-App skeleton, build cleanly, and serve a page that is not this
product.

The ignore rules were tightened before writing this, and three real leaks were
closed in the process, so `git add -A` is now safe to run:

- `user_local.env` held a live 35-character `OMNIROUTE_API_KEY` and was matched
  by no rule. `.env*` does not match it — that pattern anchors on a name
  beginning `.env`, and this one begins `user`.
- `.omniroute/` is 121 files of agent task notes, journals and a
  `workspace.json` containing an absolute path from this machine.
- `vscode-extension/node_modules/` is 20 MB of vendored TypeScript. The old
  `/node_modules` rule is anchored to the repo root and never covered it.

With those closed, a full add goes from 543 files and 29 MB to 146 files and
2.5 MB. Verify before you push, do not take my word for it:

```powershell
git add -A
git status --short | findstr /I "user_local providers .env.local chat.db"   # expect no output
git commit -m "Deployable state: app source, Docker config, production guard"
```

If that `findstr` prints anything at all, stop and fix the ignore rules before
pushing anywhere.

**Use a private repository.** Public is fine for the code, but one mistake with
an env file is permanent — GitHub's search indexes commits, and scrapers act on
leaked keys within minutes.

If you would rather not use git at all, Phase 5 has an `scp` path.

### 0.3 Generate the secrets

Two 32-byte hex strings. Keep them somewhere you will still have in six months,
because losing `AUTH_SECRET` signs everyone out and losing `CREDENTIALS_SECRET`
makes every stored provider key permanently undecryptable.

```powershell
# Windows, with git-bash or WSL available:
openssl rand -hex 32     # -> AUTH_SECRET
openssl rand -hex 32     # -> CREDENTIALS_SECRET

# Pure PowerShell, if openssl is not on PATH:
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

The boot check rejects anything under 16 characters or with fewer than 8
distinct characters, and warns between 16 and 31. A hex-32 output is 64
characters and passes comfortably.

### 0.4 Decide how sign-in codes get delivered

This is the step that most often produces a deployment where *you* can sign in
and your testers cannot, so it is worth two minutes now rather than an evening
later. The choice comes down to one question: **do you own a domain yet?**

**If you do not own a domain — use a Gmail App Password.** It delivers to any
address, needs no DNS, and costs nothing. That makes it the right answer for a
beta whose testers you are recruiting over WhatsApp and LinkedIn, because you
cannot know their addresses in advance or add them to an allowlist.

1. Turn on 2-Step Verification at <https://myaccount.google.com/security>.
   App Passwords are not offered as an option until you do.
2. Create one at <https://myaccount.google.com/apppasswords>. You get 16
   characters, shown once.
3. Set `GMAIL_USER` to the full address and `GMAIL_APP_PASSWORD` to those 16
   characters with spaces removed. The normal account password is rejected by
   Google and shows up as a credentials error.

This works on EC2 without any extra configuration. AWS throttles outbound port
25 by default and leaves 465 and 587 alone; nodemailer uses 587 here. The
default security group allows all egress, so unless you have narrowed yours
there is nothing to open. Consumer Gmail caps around 500 recipients/day, which
is far more than a beta will use.

**If you do own a domain — use Resend and verify it.** Sign up at
<https://resend.com/api-keys>, verify the domain, and set `MAIL_FROM` to an
address on it. Resend is checked first in `src/lib/otpDelivery.ts` because it
delivers over HTTPS and needs no outbound SMTP at all. Free tier is 100
emails/day and 3,000/month; paid plans scale without a code change, since the
provider is chosen by environment variable.

**The combination to avoid** is the one that looks easiest: setting
`RESEND_API_KEY` while leaving `MAIL_FROM=onboarding@resend.dev`. That is
Resend's shared test sender and it will only deliver to the address that owns
the Resend account. Every other person's sign-in attempt comes back HTTP 422 and
they cannot get in. No amount of log-reading reveals it, because from the app's
side the send simply failed — and it works perfectly on your own account, which
is exactly why it survives testing.

If you are already in that gap and need people in today, list them in
`AUTH_BETA_TESTERS`. Each listed account — and only that account — sees its own
code in the sign-in dialog when a configured provider genuinely fails. Four
conditions must all hold: the account is named, a provider was configured, it
was tried, and it failed for a reason other than rate-limiting. That last
exclusion matters: burning the provider's quota until it answers 429 is the only
failure an outsider can force on demand, so a rate-limit failure never reveals
anything. Clear the list once real delivery works; the boot check prints it
(masked) on every start so it cannot be left on and forgotten.

### 0.5 If you want your existing local chat.db on the server

Skip this entirely for a fresh start — it is the better choice unless you have
real data to keep.

The database runs in WAL mode, which means `chat.db` on its own is **not** a
complete copy. Recent commits live in `chat.db-wal` until a checkpoint folds
them in. Copying just `chat.db` gives you a file that opens cleanly and is
missing your most recent work.

Stop the local app first, then:

```powershell
sqlite3 chat.db "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA integrity_check;"
```

`wal_checkpoint(TRUNCATE)` folds the WAL back into the main file and empties it.
`integrity_check` must answer exactly `ok` — if it reports anything else, do not
migrate the file; start fresh on the server and keep the damaged copy aside.

After a clean checkpoint, `chat.db` alone is the whole database, and
`chat.db-wal` / `chat.db-shm` can be left behind. Upload it in Phase 5.6.

---

## Phase 1 — launch the instance

EC2 Console → Launch Instance, in **Asia Pacific (Mumbai) `ap-south-1`**.

| Setting | Value | Why |
|---|---|---|
| Name | `omniroute-coder-beta` | |
| AMI | **Ubuntu Server 22.04 LTS**, architecture **64-bit (Arm)** | must match the instance family |
| Instance type | `t4g.small` (2 vCPU, 2 GiB) | Graviton; cheaper per unit of RAM than `t3.small` |
| Key pair | create `omniroute-key`, type **RSA**, format **.pem** | `.ppk` is PuTTY-only; OpenSSH on Windows wants `.pem` |
| Storage | **20 GiB gp3** | the default 8 GiB does not survive a Docker build |

The AMI architecture is the one selection people get wrong. Picking the x86_64
Ubuntu image with a `t4g` instance type is not offered as a valid combination,
but picking a `t3.small` after having planned for ARM is easy to do by muscle
memory and everything downstream still works — you just quietly pay more.

**Security group** — create a new one, `omniroute-sg`:

| Type | Port | Source |
|---|---|---|
| SSH | 22 | **My IP** |
| HTTP | 80 | `0.0.0.0/0` |
| HTTPS | 443 | `0.0.0.0/0` |

SSH restricted to your own address, because port 22 open to the world is a
continuous password-and-key-guessing load even when key-only auth makes it
futile. Your home IP will change; widening it later takes ten seconds.

Nothing else. Port 3005 is not listed here and must not be. Port 20129 likewise
— the bridge is reached through Caddy on 443, not directly, so opening it would
add an unencrypted path to the same service and nothing else.

### 1.1 Elastic IP

Still in EC2 → Network & Security → Elastic IPs → Allocate, then Actions →
Associate, to this instance.

Without one, the public IP changes on every stop/start, which breaks the DuckDNS
record and any TLS certificate issued against it. An Elastic IP is free while
associated with a running instance and billed hourly when it is not — so if you
ever stop the instance for a while, release the address too.

### 1.2 Lock down the metadata service

Do this now, while you are thinking about it.

```bash
aws ec2 modify-instance-metadata-options \
  --instance-id i-XXXXXXXXXXXXXXXXX \
  --http-tokens required \
  --http-put-response-hop-limit 1 \
  --http-endpoint enabled \
  --region ap-south-1
```

The hop limit is the interesting one. Docker containers reach the host through
an extra network hop, so a hop limit of 1 means a process inside a container
cannot reach `169.254.169.254` at all, while the host still can. If this
instance ever gets an IAM role attached, that single setting is what stops a
compromised app from reading its credentials.

Recent console launches default to IMDSv2-required with hop limit 1 already.
Verify rather than assume — the command above is idempotent, so just run it.

There is also a console path: Instance → Actions → Instance settings → Modify
instance metadata options.

---

## Phase 2 — connect

On Windows, a `.pem` with inherited permissions is rejected by OpenSSH with
"UNPROTECTED PRIVATE KEY FILE". Strip inheritance and grant only yourself:

```powershell
cd $HOME\Downloads
icacls "omniroute-key.pem" /inheritance:r
icacls "omniroute-key.pem" /grant:r "$($env:USERNAME):R"
```

```powershell
ssh -i "omniroute-key.pem" ubuntu@<ELASTIC_IP>
```

The username is `ubuntu` for Ubuntu AMIs (`ec2-user` is Amazon Linux). Accept
the host fingerprint on first connect.

---

## Phase 3 — prepare the host

### 3.1 Updates

```bash
sudo apt update && sudo apt upgrade -y
```

If it asks about a new `sshd_config`, keep the existing one — the AMI's version
already has key-only auth configured.

### 3.2 Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
```

The group change applies to *new* logins. `newgrp docker` opens a subshell with
the new group, which is fine for the next few commands; log out and back in if
you want it to stick properly.

```bash
newgrp docker
docker run --rm hello-world
docker compose version
```

`docker compose` with a space — the v2 plugin, installed by that script.
`docker-compose` with a hyphen is the old Python v1 and is not installed.

### 3.3 Swap — 4 GB, not 2

This is the one place I am deliberately departing from the original plan.

`next build` is by a wide margin the heaviest thing that will ever run on this
box: Turbopack compiling the whole app, plus a full TypeScript type-check,
inside a Docker build, on 2 GiB of RAM. 2 GiB of swap gets you to 4 GiB total
and is frequently not enough. 4 GiB gets you to 6 GiB and costs nothing but
disk that is otherwise idle.

I could not measure this build's actual peak here — see "What was not verified"
at the end — so this is headroom rather than a measured figure. Headroom is
cheap; a build that dies at 85% after twelve minutes is not.

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

`swapon` affects only the running kernel; the `fstab` line is what survives a
reboot. Confirm both:

```bash
free -m           # Swap: total should be ~4096
swapon --show     # /swapfile  file  4G
```

A 20 GiB volume with 4 GiB of swap leaves roughly 12 GiB after the OS and the
Docker images. That is the budget the storage caps in section 11 of
`.env.production.example` exist to defend.

### 3.4 Firewall

**Order matters.** Allow SSH before enabling, or you will lock yourself out and
need the EC2 serial console to get back in.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable        # answer y
sudo ufw status verbose
```

**A caveat worth understanding.** UFW does not filter Docker's published ports.
Docker writes its own NAT rules, and traffic to a published port is
DNAT'd before it reaches the chain UFW manages — so a container published as
`0.0.0.0:3005:3005` would be reachable from the internet even with UFW denying
3005, and `ufw status` would show a rule that is doing nothing.

This deployment is not exposed to that, because the port is published to
`127.0.0.1` and the NAT rule therefore only matches traffic already destined for
loopback. It is worth knowing anyway: it is the reason the loopback binding is
load-bearing and not merely tidy, and it is why "I added a UFW rule, so it is
closed" is not a safe assumption with Docker in the picture.

### 3.5 Unattended security updates

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

---

## Phase 4 — domain and TLS

Do DNS **before** Caddy. Caddy requests a certificate the moment it loads a
config with a hostname in it, and Let's Encrypt validates by connecting back to
the name. If the record does not resolve yet, the request fails and you are into
rate limits and retry backoff for no reason.

### 4.1 DuckDNS

At <https://www.duckdns.org>, sign in, create `omniroute-beta`, and set its IP
to your Elastic IP. Confirm from the instance:

```bash
dig +short omniroute-beta.duckdns.org    # must print your Elastic IP
```

Do not continue until it does. Propagation is usually seconds.

The DuckDNS auto-update cron exists for dynamic addresses. With an Elastic IP
the address does not change, so it is optional — but harmless, and it protects
you if the address is ever reassigned.

### 4.2 Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

```bash
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
omniroute-beta.duckdns.org {
	# Refuse oversized uploads at the edge, before they reach Node.
	# Route handlers read a request body into memory before anything can
	# inspect it, so without this a single large POST from any signed-in
	# account is an out-of-memory kill on a box with a 1.6 GiB app limit.
	# 12 MB is comfortably above the largest legitimate request (a file
	# attachment) and far below anything that threatens the container.
	request_body {
		max_size 12MB
	}

	# The VS Code bridge. Must come first: `handle` blocks are evaluated in
	# order and the catch-all below would otherwise swallow this path.
	handle /vscode-bridge* {
		reverse_proxy 127.0.0.1:20129
	}

	# Everything else — the app itself.
	handle {
		reverse_proxy 127.0.0.1:3005
	}
}
EOF

sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

**On `request_body`.** This is the only body-size limit in the stack that covers
every route. The skills endpoints cap themselves at 256 KB in code — they read
the request stream with a byte counter and abandon it past the cap, rather than
trusting `Content-Length`, which is a claim the client makes and can be wrong or
absent. Other routes still call `req.json()` directly and have no such cap, so
this Caddyfile line is what protects them. If you change the limit, raise it
rather than remove it: a WebSocket upgrade carries no body and is unaffected, but
a value below your largest real attachment will produce a 413 that looks like a
broken upload.

`127.0.0.1:3005` is correct and is the whole point of the loopback binding.
Caddy runs here as a **systemd service on the host**, so its `127.0.0.1` and the
host's published port are the same loopback interface.

The second upstream is the editor bridge, and it is what lets a tester's own VS
Code connect to this deployment. Three things have to agree on the path
`/vscode-bridge`: this file, `BRIDGE_PATH` in `src/lib/bridgeEndpoint.ts`, and
`OMNIROUTE_BRIDGE_PUBLIC_URL` in `.env.production`. The listener refuses an
upgrade on any other path, so a mismatch does not produce a 404 you would
notice — it produces a connection that appears to open and then closes, which
reads like a network fault. Change the path in one place and you must change it
in all three.

Nothing extra is needed to proxy a WebSocket. Until the moment the socket is
handed over, an upgrade is an ordinary HTTP request with two headers on it, and
Caddy forwards those by default; the `reverse_proxy` line above is the entire
configuration. If you skip the bridge entirely, leave `OMNIROUTE_BRIDGE_ENABLE`
blank in Phase 5 and drop the first `handle` block — the app is unaffected, and
the Connect VS Code panel tells users the operator has not enabled it.

The one case where this changes: if you later move Caddy into a container, then
`127.0.0.1` means *that container*, and the proxy targets become the app's
service name on a shared Docker network (`reverse_proxy app:3005` and
`reverse_proxy app:20129`). Claims that "Caddy cannot reach 127.0.0.1:3005" come
from assuming the containerised layout. In this layout it reaches it fine.

Caddy sets `X-Forwarded-For` automatically, which is what makes
`OMNIROUTE_TRUST_PROXY=true` correct in Phase 5. TLS certificates are obtained
and renewed with no further configuration; watch it happen with
`sudo journalctl -u caddy -f`.

Expect a redirect at this point, not a site — nothing is listening on 3005 yet.

---

## Phase 5 — deploy the app

### 5.1 Get the code across

```bash
mkdir -p ~/omniroute && cd ~/omniroute
```

**Option A — git** (requires Phase 0.2 to have been done):

```bash
git clone https://github.com/<you>/omniroute-coder.git .
```

For a private repo, generate a deploy key on the instance
(`ssh-keygen -t ed25519 -C omniroute-ec2`), add the public half to the repo's
Deploy Keys with read-only access, and clone over SSH. A read-only deploy key is
much better than a personal access token sitting in the shell history of a
server.

**Option B — scp**, from PowerShell on your PC:

```powershell
cd "C:\Users\10csh\OneDrive\Desktop\omniroute-coder-external-provider-version6.9"
scp -i "$HOME\Downloads\omniroute-key.pem" -r `
  .\omniroute-coder ubuntu@<ELASTIC_IP>:/home/ubuntu/omniroute/
```

`scp -r` copies *everything*, including `node_modules` (~400 MB of Windows
binaries that are useless on ARM), `.env.local`, `providers.json`, `chat.db` and
the backup files. `.dockerignore` keeps all of it out of the image, so the build
is still correct — but you will spend a long time uploading files the server
will never read, and secrets will be sitting on the instance regardless.
Prefer git. If you must use scp, delete `node_modules`, `.next` and the local
env files from a copy of the folder first.

### 5.2 Write .env.production

```bash
cd ~/omniroute/omniroute-coder    # or ~/omniroute if you cloned into .
cp .env.production.example .env.production
nano .env.production
chmod 600 .env.production
```

The template is long and every variable in it is one the code actually reads. To
get running, these are the ones that matter:

```bash
AUTH_SECRET=<the 64-char hex from 0.3>
CREDENTIALS_SECRET=<the other 64-char hex from 0.3>

ADMIN_EMAILS=10cshervindias45@gmail.com
ADMIN_PHONES=7264953257

# Sign-in code delivery. Gmail App Password from 0.4 — delivers to any
# address, which is what a beta with outside testers needs.
GMAIL_USER=10cshervindias45@gmail.com
GMAIL_APP_PASSWORD=<the 16 characters, spaces removed>

# When you have a domain, verify it with Resend and switch to these two
# instead. Resend is checked first, so uncommenting takes precedence over the
# Gmail values above without removing them.
# RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
# MAIL_FROM=OmniRoute <no-reply@yourdomain.com>

OMNIROUTE_TRUST_PROXY=true
AUTH_DEV_SHOW_OTP=false
UPI_AUTO_APPROVE=false

# The VS Code bridge. Omit all three if you are not offering it to testers.
OMNIROUTE_BRIDGE_ENABLE=true
OMNIROUTE_BRIDGE_PUBLIC_URL=wss://omniroute-beta.duckdns.org/vscode-bridge
OMNIROUTE_ENABLE_FILE_TOOLS=true
```

`OMNIROUTE_BRIDGE_ENABLE` must be the literal lowercase `true`; `TRUE` and `1`
leave the listener closed. `OMNIROUTE_BRIDGE_PUBLIC_URL` is what the extension is
told to dial — the app can guess it from the `Host` header, but the guess fails
in precisely the cases that are hardest to diagnose, so state it. The path must
match the `handle` block from §4.2 exactly. `OMNIROUTE_BRIDGE_HOST` is not listed
because compose already pins it to `0.0.0.0`, and `environment:` overrides this
file.

`OMNIROUTE_ENABLE_FILE_TOOLS=true` is what puts the Cowork UI in front of users.
It is redundant when the bridge is on — the gate defaults to following it — but
writing it down means the next person reading this file does not have to know
that. Set it to `false` to hide the feature while leaving the bridge running.

Deliberately left blank:

`OMNIROUTE_BASE_URL` / `OMNIROUTE_API_KEY` — these are a *shared fallback*, and
on a public sign-up they hand your gateway key to every stranger who registers,
on your quota. Each user connects their own gateway in Settings, which is the
intended model. `OMNIROUTE_ALLOW_SHARED_GATEWAY` defaults to false in production,
so even setting them by accident is not enough to share them.

`OMNIROUTE_WORKSPACE_ROOT` — ignored in production and must stay that way. It
used to name the one folder the file tools operated on. In a multi-tenant build
`workspaceRoot()` refuses before it is ever read, because "which folder" is a
question only the connected editor can answer. The boot check warns if it is set,
purely so nobody concludes from a working deployment that it took effect.

`OMNIROUTE_ALLOW_OUTSIDE_ROOT` — compose pins it to `false`. Also inert in
production: whether the model may read above the workspace root is not a
statement this process is in a position to make about somebody else's laptop.
The extension asks the user per folder instead.

`OMNIROUTE_PROXY_DEPTH` — blank is correct for a single Caddy in front.

`OMNIROUTE_DB_PATH` — set by compose to `/data/chat.db`. Leave it.

`OMNIROUTE_ALLOW_PRIVATE_GATEWAY` — **leave it unset, or set it to `false`.**
This is the switch that decides whether the server will fetch user-supplied URLs
that resolve to loopback and private ranges. A production build refuses them by
default, and that refusal is what stops somebody saving a base URL of
`http://169.254.169.254/…` and using your app to read the EC2 instance metadata
endpoint — which on a default IMDSv1 instance hands back the role credentials.
It also blocks `10.x`, `172.16–31.x`, `192.168.x` and `127.x`, i.e. anything else
sharing the box or the VPC.

Setting it to `true` removes that protection for **every** provider URL **every**
user saves, not just your own. It is the right switch only for a private
single-operator install where the app and the gateway sit on the same host or
LAN. On a deployment strangers can sign up to, it is a server-side request
forgery primitive you enabled on purpose. The tunnel path below exists so you
never need it.

**A warning about the gateway URL.** Do not point `OMNIROUTE_BASE_URL` at a
`localhost` address. On this server `localhost` is this server, so nothing
reaches an OmniRoute instance running on your PC. The same applies to every
user: `/api/models` and `/api/chat` fetch provider base URLs **server-side**, so
a tester's `http://localhost:20128` is fetched by the EC2 box and resolves to the
EC2 box. The boot check warns if it sees this.

What it does *not* mean is that a tester's own gateway is unusable from a hosted
deployment — an earlier version of this runbook said so, and that was wrong. It
is unusable *at a localhost address*. Give the gateway a public address of its
own and the server can reach it like any other provider. That is what the
in-app wizard sets up; see "Onboarding testers" in Phase 7.

### 5.3 Build and start

```bash
docker compose up -d --build
```

First build is 8–15 minutes on a t4g.small: `npm ci`, then `next build`
compiling and type-checking the whole app. Watch it rather than wondering:

```bash
docker compose logs -f
```

If the build is killed without an error message, that is the OOM killer and
Phase 3.3 was skipped or the swap did not persist. `free -m` and
`dmesg | tail -20` will confirm.

### 5.4 Read the boot report

This is the highest-value thirty seconds in the whole deployment. In production
the app prints its **resolved** configuration — what it actually computed, not
what you think you wrote:

```
  [omniroute] resolved configuration:
    NODE_ENV               production
    database               /data/chat.db — on a mounted volume
    AUTH_SECRET            set (64 chars)
    CREDENTIALS_SECRET     set (64 chars)
    email provider         gmail (from 10cshervindias45@gmail.com)
    sms provider           none
    admin allowlist        10cshervindias45@gmail.com, 7264953257
    beta OTP fallback      off
    code reveal            off
    file tools             ENABLED
    trust proxy            on — per-IP limits use the forwarded client address
    memory                 1600 MiB available (cgroup limit), V8 heap cap 896 MiB
    shared gateway         not configured — each user brings their own
```

Check it line by line:

- **database** must say *on a mounted volume*. If it says *on the container's
  writable layer*, the volume is not mounted and the next rebuild wipes every
  account.
- **admin allowlist** is printed in full, unmasked, on purpose. This is the line
  that catches a typo in your own address — and `10***5@gmail.com` looks
  identical whether the middle is right or wrong, so masking it would catch
  nothing while looking responsible. It is your address, in your log, from a
  file you wrote. Getting it wrong means locking yourself out of the admin panel
  of a deployed app, recoverable only by editing the database by hand.
- **beta OTP fallback** *is* masked — those are other people's contact details,
  and a typo there costs one person one convenience rather than all
  administrative access.
- **email provider** must name a provider, not `none`. `none` means no sign-in
  code can ever be delivered and every account is locked out — and it is the
  silent result of a typo'd variable name, because a blank value and a
  misspelled one look the same to the app. If it says `gmail`, check the address
  after it is yours.
- **code reveal** must be `off`.
- **file tools** should be `ENABLED` if you are offering the VS Code bridge —
  that is the intended configuration now, and it is what the sample env above
  sets. It no longer means "this server's disk is writable": every operation is
  routed to the calling user's own editor, and a production build refuses to
  fall back to this machine's filesystem. It says `disabled` if
  `OMNIROUTE_ENABLE_FILE_TOOLS` is unset or false, in which case testers get
  chat without file editing.
- **trust proxy** must be `on` behind Caddy.
- **memory** should show the cgroup limit, not 2048 MiB. If it shows the host's
  full memory, `mem_limit` is not being applied and V8 is sizing its heap
  against memory the cgroup will not give it.

Warnings print after it. They do not stop the server, because a warning that
blocks a deploy just trains people to bypass warnings — but each one is a real
finding, so read them.

### 5.5 Verify

```bash
curl http://localhost:3005/api/health
# {"status":"ok","database":"ok"}

docker compose ps            # State: running (healthy)
docker stats --no-stream     # MEM USAGE well under the 1.6 GiB limit
```

`/api/health` does a real database read, not just a liveness ping — a process
that is up but cannot reach its database is not serving anyone, and compose
would otherwise report it healthy.

When that read fails the route answers **503** with a different body,
`{"status":"degraded","database":"unavailable"}`. If you point an external
monitor at this endpoint, match on the HTTP status or on the exact string
`"status":"ok"` — a check that greps for `status` alone matches both states and
will never fire. The health script under Phase 7 → Monitoring uses `curl -fsS`,
which fails on any 4xx/5xx, so it is already correct on this point.

Then, from a browser: **https://omniroute-beta.duckdns.org**. Sign in, confirm
the code arrives, confirm the session survives a refresh (if it does not, TLS or
the proxy headers are wrong, not the app), and confirm the admin panel appears
for your allowlisted address.

Note there is no "test HTTP access at `http://<elastic-ip>`" step. There cannot
be: nothing is published on 80 or 3005 to the outside except Caddy, and Caddy
redirects to HTTPS. A guide that tells you to check the raw IP is a guide
written for a different port layout.

**Skills need nothing from you here.** The `skills` table is created on first
boot by the module that owns it, so there is no migration step and no new
environment variable. It lives inside `chat.db`, which means the backup in
Phase 7 already covers it and the restore in 5.6 already restores it. Nothing
listens on a new port, because nothing about a skill executes — a skill is text
that gets added to a prompt, and an uploaded file containing `code`,
`entrypoint`, or a URL to fetch is rejected at validation rather than stored.
Worth knowing when someone asks whether letting testers upload skills widens
the attack surface of the box: it does not, and that was the reason for
building it declaratively.

To confirm after deploying, sign in and open **Skills** in the sidebar, add one
template, and send a message containing one of its keywords. The answer should
carry a line underneath saying which skill applied and why.

### 5.6 Restoring an existing database (only if you did 0.5)

```powershell
scp -i "$HOME\Downloads\omniroute-key.pem" chat.db ubuntu@<ELASTIC_IP>:/home/ubuntu/
```

```bash
cd ~/omniroute/omniroute-coder
docker compose stop app
docker compose cp /home/ubuntu/chat.db app:/data/chat.db

# Fix ownership and clear the old WAL sidecars. Both halves matter — see below.
docker compose run --rm --user root --entrypoint sh app -c \
  'chown node:node /data/chat.db && rm -f /data/chat.db-wal /data/chat.db-shm'

docker compose start app
docker compose logs --tail=50      # watch the migrations run
```

Two details that are easy to skip and both bite later.

**Ownership.** `docker compose cp` writes the destination as `root:root` unless
you pass `--archive`, but the container runs as `node` (uid 1000, set in the
`Dockerfile`). Skip the `chown` and the app opens a database it cannot write to;
the first sign-in fails with `SQLITE_READONLY`, which reads like corruption and
sends you looking in entirely the wrong place.

**The sidecars.** You are replacing `/data/chat.db` while `/data/chat.db-wal`
and `/data/chat.db-shm` from the *previous* database are still sitting next to
it. A clean `docker compose stop` should have checkpointed and truncated that
WAL — the SIGTERM handler in `src/lib/db.ts` does exactly that — but if the stop
timed out, frames survive, and nothing in the file format ties a WAL to the
database it came from. SQLite would apply it to the restored file without being
able to tell it does not belong. Deleting the two sidecars costs nothing and
removes the question.

Migrations are additive (`addColumnIfMissing`), so an older schema is brought
forward on open rather than rejected. Take a backup with 6.1 immediately
afterwards, before anyone signs in.

---

## Phase 6 — backups

**Nothing backs this database up automatically.** The old version of this file
claimed the app "auto-backs up to `chat.db.backup-*` files"; it does not. There
is a `.omniroute-backups` folder in the code, but that is the Cowork file-editing
tools keeping copies of *source files they edit*, it is gated behind
`fileToolsEnabled()`, and file tools are off. The database has no automatic
backup at all until you create the cron below.

### 6.1 The backup script

The image now ships the `sqlite3` CLI specifically so this works. It was not
there before, and `docker compose exec app sqlite3` would have failed with
"executable file not found" — which is what makes the version below run
verbatim.

```bash
mkdir -p /home/ubuntu/backups

cat > /home/ubuntu/backup.sh <<'EOF'
#!/bin/bash
set -euo pipefail

STAMP=$(date +%F-%H%M)
DEST=/home/ubuntu/backups
cd /home/ubuntu/omniroute/omniroute-coder

# SQLite's online backup API. Copies every page INCLUDING the write-ahead log,
# while the server keeps serving. `cp` would produce a file that opens cleanly
# and is missing everything written since the last checkpoint.
docker compose exec -T app sqlite3 /data/chat.db ".backup '/data/backup-$STAMP.db'"
docker compose cp "app:/data/backup-$STAMP.db" "$DEST/chat-$STAMP.db"
docker compose exec -T app rm -f "/data/backup-$STAMP.db"

gzip -f "$DEST/chat-$STAMP.db"

# Keep the 7 most recent. `|| true` because `set -e` plus `pipefail` would
# otherwise abort the script the one time there is nothing to delete.
(ls -1t "$DEST"/chat-*.db.gz 2>/dev/null | tail -n +8 | xargs -r rm --) || true

echo "$(date -Is) backup ok: chat-$STAMP.db.gz ($(du -h "$DEST/chat-$STAMP.db.gz" | cut -f1))"
EOF

chmod +x /home/ubuntu/backup.sh
/home/ubuntu/backup.sh      # run once now, do not wait for the cron to tell you it is broken
```

Adjust the `cd` if you cloned into `~/omniroute` directly rather than into a
subfolder. `set -euo pipefail` matters: without it a failed `exec` still leaves
a cheerful "backup ok" in the log and an empty file in the directory.

### 6.2 Schedule it

```bash
crontab -e
```

```
0 2 * * 0 /home/ubuntu/backup.sh >> /home/ubuntu/backup.log 2>&1
```

Weekly at 02:00 Sunday. Cron runs in UTC on this AMI unless you have changed the
system timezone, so that is 07:30 IST.

Weekly is thin for anything with real users in it — a failure on a Saturday
costs six days. Once you have testers, change the `0` to `*` for daily and raise
the retention from 7.

### 6.3 Get a copy off the instance

A backup on the same EBS volume as the database protects you from a bad
migration and from nothing else. Periodically:

```powershell
scp -i "$HOME\Downloads\omniroute-key.pem" `
  ubuntu@<ELASTIC_IP>:/home/ubuntu/backups/chat-*.db.gz .\backups\
```

An EBS snapshot of the whole volume, scheduled through AWS Backup, is the
lower-effort version and also captures `.env.production`.

### 6.4 Test a restore before you need one

An untested backup is a belief, not a backup.

```bash
gunzip -c /home/ubuntu/backups/chat-<stamp>.db.gz > /tmp/restore-test.db
sqlite3 /tmp/restore-test.db "PRAGMA integrity_check; SELECT COUNT(*) FROM users;"
```

Expect `ok` and a plausible count. (`sqlite3` on the host needs
`sudo apt install -y sqlite3`; it is installed in the container, not on the
instance.)

---

## Phase 7 — after it is live

### Onboarding testers — how they connect a gateway

This is the first thing every new sign-in hits, and the one most likely to be
reported to you as "the site is broken". A fresh account has no providers, so
the model picker is empty and the composer says so. Send testers this, or point
them at **Settings → Set up gateway**, which walks the same path with a
Test Connection at the end.

**Testers who already have a hosted key** (OpenAI, Groq, OpenRouter, Google,
APINeX, AgentRouter) have the easy path: Settings → Add Provider, pick the
provider from the dropdown so the base URL is filled in for them, paste the key,
Test, Save. Nothing else is needed and nothing runs on their machine.

**Testers who want to use their own OmniRoute gateway** need four things, and
the fourth is the one that surprises people:

1. `npm install -g omniroute`, then `omniroute` in a terminal they leave open.
2. Sign in to `http://localhost:20128/dashboard`. The factory password is
   `CHANGEME` unless they set `INITIAL_PASSWORD` before first launch. This is
   the gateway's own password and has nothing to do with their account on your
   deployment — expect this to confuse people at least once.
3. Add their provider accounts there, optionally build a combo, generate a key.
4. **Give the gateway a public address.** `http://localhost:20128/v1` cannot
   work here. Your EC2 box makes that request, so `localhost` is your EC2 box.
   The fix is a tunnel on their machine:

   ```bash
   cloudflared tunnel --url http://localhost:20128
   ```

   It prints an `https://….trycloudflare.com` address. That address **plus
   `/v1`** is the Base URL they paste into Settings.

Three things to warn them about, because each one looks like your app failing:

- Both the gateway and the tunnel have to stay running, and their PC has to stay
  awake. Closing either terminal takes their models offline.
- A free `trycloudflare` address is regenerated on every tunnel restart. "It
  worked yesterday" almost always means a stale Base URL. A named Cloudflare
  tunnel on a domain they own is the stable version of this.
- That tunnel address is public while it is up. Anyone who finds it reaches
  their gateway dashboard, so `CHANGEME` must be changed before they tunnel,
  not after.

Do **not** solve this for them by setting `OMNIROUTE_ALLOW_PRIVATE_GATEWAY=true`
on the server. It would not help — the server still has no route to their
laptop — and it would switch off the SSRF guard for every URL every user saves.
See the note in Phase 5.2.

### Monitoring

```bash
df -h                          # disk; the 20 GiB volume is the binding constraint
free -m                        # memory and swap
docker stats --no-stream       # container memory against the 1600 MiB limit
docker compose logs --tail=100
sudo journalctl -u caddy -f    # TLS renewals
```

A health cron, if you want one:

```bash
cat > /home/ubuntu/health-check.sh <<'EOF'
#!/bin/bash
NOW=$(date -Is)

curl -fsS http://localhost:3005/api/health >/dev/null \
  || echo "$NOW app health check FAILED"

USED=$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
[ "$USED" -gt 80 ] && echo "$NOW disk at ${USED}%"
exit 0
EOF
chmod +x /home/ubuntu/health-check.sh
/home/ubuntu/health-check.sh     # silence means healthy
```

```
*/15 * * * * /home/ubuntu/health-check.sh >> /home/ubuntu/health.log 2>&1
```

Two small things that are easy to get wrong here. `df -P` forces POSIX
single-line output, because a long device name makes plain `df` wrap onto two
lines and `NR==2` then reads the wrong row. And the timestamp comes from
`date`, not from awk's `strftime` — Ubuntu's default `awk` is mawk, not gawk,
and relying on a gawk extension in a monitoring script is how you get a monitor
that silently does nothing.

Note what is *not* in it: a `nc -z localhost 20129` check for the VS Code bridge.
An earlier version of this file said such a check "would fail every single time
by design — nothing starts the bridge". That was already wrong (the bridge starts
itself), and if you set `OMNIROUTE_BRIDGE_ENABLE=true` it is wrong twice over.

Add the line if you run the bridge:

```bash
nc -z 127.0.0.1 20129 || echo "$(date '+%F %T') bridge listener down"
```

Leave it out if you do not. A monitor that always reports failure is worse than
no monitor, because it teaches you to ignore the one alert you have. Note that
this only proves the port is accepting TCP — it says nothing about whether any
tester's editor is currently paired, which is not a server-side condition and not
something to alert on.

### Updating

```bash
cd ~/omniroute/omniroute-coder
/home/ubuntu/backup.sh          # always, before anything else
git pull
docker compose up -d --build
docker compose logs -f          # re-read the resolved-configuration block
```

`stop_grace_period: 30s` in compose gives Next time to drain in-flight requests
and gives the SIGTERM handler in `src/lib/db.ts` time to checkpoint the WAL back
into `chat.db`. The default 10s could cut a long model stream short mid-write.

### Disk filling up

```bash
docker system df
docker image prune -a           # old build layers; safe
docker builder prune            # build cache; safe
```

Never `docker system prune --volumes` on this box. `--volumes` removes the
`omniroute-data` volume, which is the entire database. The old version of this
file recommended exactly that command as a disk-cleanup step.

When users rather than images are filling the disk, the storage caps in section
11 of `.env.production.example` are the lever:
`OMNIROUTE_MAX_CHATS_PER_USER` and `OMNIROUTE_MAX_MESSAGES_PER_CHAT`. Both are
off by default, which is right for a personal instance and wrong for an open
one. Trimming is a delete, not a summarisation; a trimmed chat records the count
and the transcript shows a one-line note when it is reopened.

### Costs

| Item | Approx / month |
|---|---|
| `t4g.small`, on-demand, ap-south-1 | ~$12 |
| 20 GiB gp3 | ~$1.80 |
| Elastic IP (associated, running) | $0 |
| Data transfer out | $0–3 at beta volumes |
| DuckDNS, Caddy TLS | free |
| Resend | free to 3,000/month |

Roughly **$14–17/month**. A 1-year Compute Savings Plan takes about 30% off the
instance if this outlives the beta. AI usage costs nothing here because each
user brings their own key.

---

## Troubleshooting, by symptom

**Container exits immediately.** `docker compose logs app`. Almost always the
boot check refusing a configuration; it names the variable. Do not reach for
`OMNIROUTE_ALLOW_UNSAFE_CONFIG` — it downgrades the refusal to a warning and
deploys the problem.

**Site loads, sign-in does not stick.** The session cookie is `secure`, so it is
only sent over HTTPS. You are on `http://`, or Caddy is not terminating TLS.

**Everyone rate-limited together.** `OMNIROUTE_TRUST_PROXY` is false behind
Caddy, so every request appears to come from the proxy and shares one bucket.
The boot check's `trust proxy` line tells you which way it resolved.

**No sign-in codes.** Almost certainly Resend's unverified-domain restriction
(0.4), not the app. `docker compose logs | grep -i "otp\|resend\|mail"`. The
resolved-config block shows whether a provider was detected at all.

**Build killed with no error.** OOM. `free -m`, then Phase 3.3.

**502 from Caddy.** The app is not listening. `docker compose ps`, then
`curl http://localhost:3005/api/health` from the host to see which side is down.

**Certificate will not issue.** `dig +short omniroute-beta.duckdns.org` must
return the Elastic IP, and port 80 must be open to `0.0.0.0/0` — Let's Encrypt
validates over HTTP. `sudo journalctl -u caddy -n 100`.

**The extension says "connected" and then drops, or never connects.** Work
outward from the app:

```bash
docker compose logs app | grep -i bridge   # did the listener bind, and on what?
nc -z 127.0.0.1 20129 && echo "port open"  # is it reachable from the host?
```

If the port is shut, `OMNIROUTE_BRIDGE_ENABLE` is not the literal `true`. If it
is open from the host but the extension cannot reach it, the Caddy `handle`
block is missing or its path does not match — the listener rejects an upgrade on
any other path, which looks like a connection that opens and closes rather than
a 404. If both look right, compare the URL the pairing panel shows against the
`handle` path character by character; the three places that have to agree are
this Caddyfile, `OMNIROUTE_BRIDGE_PUBLIC_URL`, and `BRIDGE_PATH` in
`src/lib/bridgeEndpoint.ts`.

**Every connection refused, but the container is healthy.** `OMNIROUTE_BRIDGE_HOST`
is loopback. Inside a container that is the *container's* loopback, so the
published port forwards to nothing. Compose pins it to `0.0.0.0`; check nothing
in `.env.production` is fighting it, and remember `environment:` wins.

**File tools say "only available in a local install".** The gate follows the
bridge, so this means `OMNIROUTE_BRIDGE_ENABLE` is unset — or
`OMNIROUTE_ENABLE_FILE_TOOLS=false` is overriding it. The boot check warns about
the mismatch either way.

**Locked out of SSH.** EC2 → Instance → Connect → EC2 Serial Console, or detach
the volume and attach it to another instance to edit `/etc/ufw/`.

---

## Final checklist

Phase 0 — credentials rotated · `git add -A` verified clean of secrets · repo
contains `src/lib` and `src/app/api` · both secrets generated and stored ·
Resend key obtained and its domain restriction understood.

Phase 1 — `t4g.small`, **ARM64** Ubuntu 22.04 · 20 GiB gp3 · SG allows only
22/80/443 with 22 restricted to your IP · Elastic IP associated · IMDSv2
required, hop limit 1.

Phase 2 — `.pem` permissions stripped · SSH works.

Phase 3 — packages updated · Docker installed, `hello-world` runs as `ubuntu` ·
**4 GiB swap, in fstab, confirmed by `free -m`** · UFW allows 22 *before*
`enable` · unattended-upgrades on.

Phase 4 — DuckDNS record resolves to the Elastic IP *before* Caddy is
configured · Caddyfile proxies `/vscode-bridge*` to `127.0.0.1:20129` and
everything else to `127.0.0.1:3005` · `systemctl status caddy` is active ·
certificate issued.

Phase 5 — `.env.production` written and `chmod 600` · `AUTH_DEV_SHOW_OTP=false` ·
`UPI_AUTO_APPROVE=false` · bridge variables either all set or all blank ·
`OMNIROUTE_BRIDGE_PUBLIC_URL` is `wss://` and its path matches the Caddyfile ·
build completed · **resolved-configuration block read line by line** · database
says *on a mounted volume* · `/api/health` returns ok · HTTPS sign-in works and
survives a refresh · admin panel appears.

Phase 6 — `backup.sh` created and **run once manually** · cron installed ·
restore tested with `integrity_check` · at least one copy off the instance.

Ongoing — port 3005 still loopback-only · port 20129 still closed *in the
security group* and reached only through Caddy · beta-tester list cleared once
Resend's domain is verified · storage caps set before opening sign-ups.

---

## What was not verified

Stated plainly, because a runbook that hides its gaps is worse than one that
does not.

**A full `next build` was never run while preparing this.** `tsc --noEmit`
passes with zero errors across the project, which catches every type error. It
does not exercise bundling, prerendering, or Next's generated route-signature
checks. The build could not be run here because `node_modules` was installed on
Windows, so only the Windows SWC binary is present, and fetching the Linux one
needs network access this environment does not have. **Phase 5.3 is therefore
the first real build. Expect to iterate there, and do not treat the first
failure as a sign something is deeply wrong.**

**Build memory on ARM is an estimate.** The 4 GiB swap recommendation is
headroom, not a measurement.

**The instance has never been launched.** Every AWS command follows current
documented behaviour; console layouts change.

**No CSS was ever compiled.** The interface was rebuilt on a design-token layer
(`@theme` in `src/app/globals.css`) and every colour in the chat surface,
sidebar, composer, model picker and gateway wizard is now a token class —
`bg-surface-raised`, `text-ink-mid`, `border-line` and so on. Tailwind could not
be run here for the same reason `next build` could not, so those class names
were checked by matching each one against a declared `--color-*` token rather
than by rendering a page. Every one of the 25 distinct tokens in use resolves to
a declaration inside the `@theme` block; none is a typo. But a token that
resolves is not the same as a layout that looks right, so **look at the app once
after the first successful build** rather than assuming.

**The gateway wizard has never run against a live gateway or a live tunnel.**
Its URL normaliser was checked against 13 hand-written cases including a pasted
cloudflared banner, and it reuses `/api/credentials` and `/api/credentials/test`
rather than adding new server surface. What is untested is the human path: a
real `omniroute` install, a real `CHANGEME` sign-in, a real
`trycloudflare.com` address. Walk it yourself once before sending it to testers.

**Costs are list prices for ap-south-1** at the time of writing, excluding tax.

### Corrected after review

An independent pass over this file against the source found four claims that
were wrong. They are fixed above; they are listed here because knowing *what
kind* of error got through is useful when you are deciding how much to trust the
rest.

The serious one: this file, `src/lib/vscodeBridge.ts`, `src/lib/productionGuard.ts`
and `.env.production.example` all stated that nothing in the app starts the VS
Code bridge. It starts itself at module import. The production gate is real and
the port is genuinely shut by default, so the *conclusion* was right — but the
reason given for it was false, and one copy of that false reason appeared in the
warning shown to an operator who had just enabled the bridge, telling them no
port was open when one had in fact just opened. The wording now says what the
code does.

The other three: the number of settings that abort the boot was given as three
here and two in `.env.production.example` (it was five at the time, and the
file-tools one was the one people hit by accident — it is four now, because that
refusal was removed once the file tools stopped touching this machine's disk);
the restore in 5.6 left the database owned by `root` and the previous WAL in
place; and `/api/health` was documented only in its success shape.

A fifth, found later: Phase 5.2 stated that "a user's own local gateway can only
ever work when they are running the app locally". The premise was right — the
server fetches provider URLs, so `localhost` means the server — but the
conclusion did not follow. A tunnel gives the gateway a public address and the
server reaches it like any other provider. The app now ships a wizard for
exactly that path, and the paragraph has been rewritten. This is worth noting
because the error was a plausible-sounding inference from a true fact, which is
the kind that survives review.
