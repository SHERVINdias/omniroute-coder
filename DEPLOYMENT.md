# Deploying omniroute-coder

Written for a budget of **₹1000 total across 3–6 months**. The path below costs
**₹0** if you can get an Oracle free-tier instance, and about **₹900–1100 for a
whole year** if you cannot.

Prices are the ones I know as of my training data and I could not reach the web
from this session to re-check them, so treat every number as "verify on the
signup page" rather than as a quote. The architecture advice does not depend on
the prices being exactly right.

---

## 0. Read this first — the one thing that cannot work

Your OmniRoute gateway runs on **your PC, at `http://localhost:20128/v1`**.

Once this app is on a server, `localhost` means *the server*. A hosted
omniroute-coder cannot reach the gateway on your desktop. No configuration
setting fixes this; it is what `localhost` means. The boot check warns about it
by design (see `src/lib/productionGuard.ts`).

You have three honest options:

**A. Each user brings their own gateway.** This is what the code now does and
what you already chose. A signed-in user opens Settings, enters their own base
URL and API key, and it is encrypted per-user in the database. Leave
`OMNIROUTE_ALLOW_SHARED_GATEWAY` unset. Users with no gateway get a clear
"connect your gateway" message rather than a broken chat.

**B. Publish your own gateway so that *you* can use the hosted app.** Run a
Cloudflare Tunnel on your PC pointing at `localhost:20128`, which gives you a
public HTTPS URL. Put that URL in your own Settings inside the deployed app.
Your PC must be on for your account to work. Anyone else still needs their own.
This is free and takes about ten minutes — see §7.

**C. Fund everyone from one key.** Set `OMNIROUTE_ALLOW_SHARED_GATEWAY=true`
plus `OMNIROUTE_BASE_URL` / `OMNIROUTE_API_KEY` to a gateway that is reachable
from the internet. Every stranger who signs up then spends your quota. Only do
this for a private deployment shared with people you trust.

Everything else in this guide works regardless of which you pick.

---

## 1. Choose a host

The app needs: Docker, a persistent disk (SQLite is a file — if the disk resets,
every account, chat and payment vanishes), and HTTPS. That last one is not
optional: the session cookie is issued `secure` in production, so **over plain
HTTP sign-in appears to succeed and then silently does not stick.**

This rules out the "free" platform tiers people usually reach for first. Render's
free web services have no persistent disk and sleep after inactivity; Vercel is
serverless with a read-only filesystem, so `better-sqlite3` cannot work there at
all. You need a real VPS or a free-tier VM.

### Tier 1 — ₹0/month: Oracle Cloud Always Free

Oracle's Always Free tier includes ARM (Ampere A1) capacity — up to 4 cores and
24 GB RAM — that does not expire. It is by far the best free option and is more
than enough.

Two real caveats. Free ARM capacity is often unavailable in popular regions and
you will see "Out of host capacity"; retry over several days, or pick a less busy
home region at signup, since the home region cannot be changed later. And Oracle
reclaims idle Always Free compute, so a server with almost no traffic can be
flagged — upgrading to Pay As You Go with a ₹0 balance stops the reclamation and
keeps the free resources free.

A card is required for identity verification.

### Tier 2 — ~₹900–1100 for a *year*: a budget annual VPS

Providers like RackNerd run annual deals in the ballpark of $11–13/year for
1 vCPU / 1 GB RAM / 20 GB SSD. Paid once, that is inside your budget for a full
year rather than three months. The trade-off is that these are usually US
datacentres, so expect roughly 200–300 ms latency from India. For a chat app
that streams tokens this is noticeable but usable.

If you prefer a mainstream provider, Hetzner's smallest shared-vCPU instance is
around €3.79/month (~₹360), which is ~₹1080 for three months — right at the edge
of your budget and over it for six.

### What I would do

Try Oracle first. It is free permanently and the 24 GB of RAM means you can build
directly on the server. If capacity refuses you after a few days of retrying, buy
a ₹1000-ish annual VPS and use the build-locally trick in §3, which makes 1 GB of
RAM perfectly sufficient.

### A note on CPU architecture

Oracle's free tier is **ARM64**. Budget VPSs are almost always **x86-64**. This
matters only if you build the Docker image on one machine and run it on another —
an image built for x86 will not run on ARM. If you build on the server itself
(§3, option A) you can ignore this entirely.

Good news either way: `better-sqlite3` ships prebuilt binaries for both
`linux-x64` and `linux-arm64`, so no compiler is needed in the image and ARM is
not a problem. I verified this in `node_modules/better-sqlite3/package.json`
(`gypfile: false`, no install script).

---

## 2. Prepare the server

SSH in, then:

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Log out and back in so the group membership applies. Check it:

```bash
docker run --rm hello-world
```

**Oracle-specific:** Oracle instances ship with restrictive iptables rules *and*
a separate cloud firewall, and forgetting the second one is the classic reason a
site is unreachable while everything looks fine on the server. You need both:

```bash
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

and then, in the Oracle web console, add ingress rules for TCP 80 and 443 to the
security list of your instance's subnet.

Do **not** open port 3005. Compose binds it to `127.0.0.1` deliberately, so the
only way in is through the TLS proxy.

### If your server has 2 GB of RAM or less

`next build` will likely run out of memory. Either build locally (§3 option A) or
add swap first. 4 GB, not 2: the build is the single heaviest thing that ever
runs on this box, and swap costs nothing but disk while it is unused.

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Note that `swapon` only affects the running kernel; the `fstab` line is what
brings it back after a reboot. Check both with `free -m` and `swapon --show`.

---

## 3. Get the code onto the server

**Option A — build locally, ship the image (best for a small server).** Build on
your Windows PC, where RAM is plentiful, and the server only ever runs the
finished image. Requires Docker Desktop locally.

```powershell
# On your PC, in the project folder.
# --platform matters: use linux/arm64 for Oracle, linux/amd64 for a normal VPS.
docker build --platform linux/amd64 -t omniroute-coder:latest .
docker save omniroute-coder:latest | gzip > omniroute.tar.gz
scp omniroute.tar.gz user@your-server:~
```

```bash
# On the server
gunzip -c omniroute.tar.gz | docker load
```

Then copy `docker-compose.yml` and your filled-in `.env.production` to the server
and comment out the `build:` block in the compose file so it uses the loaded
image instead of rebuilding.

**Option B — build on the server (simplest, needs ~2 GB RAM).** Push the project
to a private GitHub repo, then:

```bash
git clone https://github.com/you/omniroute-coder.git
cd omniroute-coder
```

Confirm `.env` and `.env.local` did **not** come along — `.gitignore` excludes
them, and they hold your gateway key.

One caveat: `package-lock.json` was generated on Windows, and npm sometimes omits
platform-specific optional dependencies from a lockfile made on another OS. If
`npm ci` fails inside the Docker build with a missing optional package, change
the Dockerfile's `RUN npm ci --include=dev` to `RUN npm install` and rebuild.

---

## 4. Fill in the environment file

```bash
cp .env.production.example .env.production
nano .env.production
```

The template documents all forty-odd variables. The ones you must not skip:

```bash
# Generate a real one. openssl rand -hex 32
AUTH_SECRET=<64 hex characters>

# Your admin accounts. These are promoted to admin on sign-in.
ADMIN_EMAILS=10cshervindias45@gmail.com
ADMIN_PHONES=7264953257

# Email delivery — see §5. Gmail App Password: reaches any address.
GMAIL_USER=10cshervindias45@gmail.com
GMAIL_APP_PASSWORD=...

# Switch to these once you own a domain and have verified it with Resend.
# RESEND_API_KEY=re_...
# MAIL_FROM=OmniRoute <no-reply@yourdomain.com>

# You are behind a TLS proxy, so this is correct.
OMNIROUTE_TRUST_PROXY=true

# Leave blank for the setup in this guide (one proxy). Set to 2 only if you put
# Cloudflare's orange-cloud proxy in front of Caddy as well.
OMNIROUTE_PROXY_DEPTH=

# Must stay false. The boot check refuses to start if either is true.
AUTH_DEV_SHOW_OTP=false
UPI_AUTO_APPROVE=false

# The VS Code bridge, which is how Cowork reaches a user's own files. All three
# together, or all three blank — see §8. The URL's path must match the Caddy
# `handle` block in §6.
OMNIROUTE_BRIDGE_ENABLE=true
OMNIROUTE_BRIDGE_PUBLIC_URL=wss://yourdomain/vscode-bridge
OMNIROUTE_ENABLE_FILE_TOOLS=true
```

`AUTH_SECRET` deserves a note: if you leave it blank the app generates one and
stores it in the database, which works — but if you ever lose the volume, every
stored provider credential becomes permanently undecryptable. Set it explicitly
and keep a copy somewhere safe.

Four settings the app **refuses to start** with in production.
`AUTH_DEV_SHOW_OTP=true` returns the sign-in code in the API response, so anyone
could sign in as anyone; `UPI_AUTO_APPROVE=true` marks every payment order paid
on creation, so PRO becomes free. A missing `AUTH_SECRET`, or an `AUTH_SECRET`
or `CREDENTIALS_SECRET` short enough to have been typed by hand, are the other
two — a guessable session-signing key means forged admin sessions.

There was a fifth. `OMNIROUTE_ENABLE_FILE_TOOLS=true` used to be fatal, because
the file tools read and wrote *this server's* disk and every signed-in account
shared it. They now run inside each user's own editor over the VS Code bridge,
with no fallback to this machine's filesystem in a production build, so enabling
them is the intended configuration rather than a mistake. §8 has the details.

Also check the admin panel's auto-approve toggle — it writes to the database and
takes precedence over the env var. Your earlier screenshot showed it switched
**on**, so turn it off before or immediately after deploying.

---

## 5. Email (this is what makes login work)

Your OTP problem was never the code — it was that `GMAIL_USER` and every
`TWILIO_*` key were present but empty, so the app had no way to send anything.
`src/lib/otpDelivery.ts` tries Resend, then SMTP, then Gmail, and reports
clearly when none is configured. Filling in any one of them switches the app
from showing the code in the browser to actually mailing it; there is no code
change involved, and no flag to flip.

**Pick by whether you own a domain.**

**No domain — use a Gmail App Password.** Turn on 2-Step Verification at
myaccount.google.com/security, create an App Password at
myaccount.google.com/apppasswords, then set `GMAIL_USER` to the full address and
`GMAIL_APP_PASSWORD` to the 16 characters it gives you, spaces removed. The
normal account password is rejected by Google. This delivers to **any** address,
which is the thing that matters when your testers are people you met on LinkedIn
and whose addresses you cannot know in advance. It caps around 500
recipients/day and the sender is visibly a personal Gmail, so it is a beta
answer rather than a launch one.

On EC2 this needs no extra setup: AWS throttles outbound port 25 and leaves 587
alone, and the default security group allows all egress. The general warning
that VPS hosts block SMTP is real but does not apply to the port this uses on
the target in `AWS_DEPLOYMENT_CHECKLIST.md`.

**Have a domain — use Resend.** Sign up at resend.com, create an API key, put it
in `RESEND_API_KEY`, verify your domain, and set
`MAIL_FROM="OmniRoute <no-reply@yourdomain.com>"`. It delivers over ordinary
HTTPS so no outbound SMTP is needed at all, the free tier covers 100/day and
3,000/month, and paid plans scale without touching code. Resend is checked
first, so adding it later overrides Gmail without removing those values.

**What not to do:** set `RESEND_API_KEY` and leave
`MAIL_FROM=onboarding@resend.dev`. That is Resend's shared test sender and it
**only delivers to the address that owns the Resend account.** It will look like
a complete success while you test it on yourself, and every other person gets
HTTP 422 and cannot sign in. If you are already stuck there, `AUTH_BETA_TESTERS`
lets named accounts see their own code when a send genuinely fails — read what
that costs in `.env.production.example` §5 before switching it on.

### SMS: do not spend money here yet

Phone login to Indian numbers requires **DLT registration with TRAI** — entity
registration, sender ID, and pre-approved templates, filed through an operator
portal. This is a regulatory filing, not a code change. Without it, perfectly
valid Twilio credentials are rejected upstream and messages are filtered before
delivery. Buying Twilio credit now would waste it.

With no SMS provider configured, phone sign-in tells the user it is unavailable
and points them at email. Email-only is the right launch configuration, which is
what you chose.

---

## 6. Domain and HTTPS

HTTPS is mandatory — see §1.

### Free: DuckDNS + Caddy (₹0)

Get a free subdomain at duckdns.org (e.g. `omniroute.duckdns.org`), point it at
your server's IP, then:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

Replace `/etc/caddy/Caddyfile` with:

```
omniroute.duckdns.org {
    # Cap request bodies at the edge. Route handlers buffer a body into memory
    # before anything can check its size, so without this one large POST from a
    # signed-in account can take the process down. Raise it if your users attach
    # bigger files; do not remove it.
    request_body {
        max_size 12MB
    }

    # The VS Code bridge, first — `handle` blocks match in order and the
    # catch-all below would otherwise take this path too.
    handle /vscode-bridge* {
        reverse_proxy 127.0.0.1:20129
    }

    handle {
        reverse_proxy 127.0.0.1:3005
    }
}
```

```bash
sudo systemctl reload caddy
```

Caddy obtains and renews a Let's Encrypt certificate automatically and sets
`X-Forwarded-For` correctly, which is what makes `OMNIROUTE_TRUST_PROXY=true`
the right value.

The second upstream is the editor bridge — the WebSocket a tester's VS Code
extension dials so that file tools run on *their* machine rather than on this
server. Putting it on the same hostname and the same port 443 means it works
wherever the web app works: no second security-group rule, no second
certificate, and no high port for a cafe or office network to block outbound.
Proxying an upgrade needs no special directives, because until the socket is
handed over it is an ordinary HTTP request.

The path `/vscode-bridge` appears in three places and they must match:
this file, `BRIDGE_PATH` in `src/lib/bridgeEndpoint.ts`, and
`OMNIROUTE_BRIDGE_PUBLIC_URL` in `.env.production`. The listener rejects an
upgrade on any other path, so a typo shows up as a connection that opens and
immediately closes rather than as a 404.

If you are not offering the bridge, leave `OMNIROUTE_BRIDGE_ENABLE` blank and
drop the first `handle` block; everything else is unchanged.

### Paid: your own domain (~₹200–900/year)

A `.in` or `.xyz` domain is often ₹200–500 for the first year at Namecheap,
Cloudflare Registrar or Hostinger. This is the one line item likely to use your
budget, and it buys two things worth having: a professional URL, and a domain you
can verify with Resend so email actually reaches your users. Point an A record at
the server IP and use the same Caddyfile with your domain in place of the DuckDNS
one.

---

## 7. Optional: expose your own gateway to the hosted app

So that *your* account on the deployed site can use the OmniRoute instance on
your PC. Free, and nothing is opened on your router.

On your Windows machine, install `cloudflared`, then:

```powershell
cloudflared tunnel --url http://localhost:20128
```

It prints a `https://something-random.trycloudflare.com` URL. In the deployed
app, open Settings and enter `https://that-url/v1` as your base URL along with
your gateway API key. The credential is encrypted per-user, so it stays yours.

The URL changes each time you restart the tunnel. For a stable address you need a
named tunnel, which requires a domain on Cloudflare — worth doing if you bought
one in §6. And your PC must be running for your account to work; that is inherent
to the gateway living on your desktop.

---

## 8. Launch

```bash
docker compose up -d --build
docker compose logs -f
```

Startup runs the production safety check. It prints warnings and refuses to boot
on a genuinely dangerous configuration; if it exits, the log line says exactly
which setting is at fault.

Verify:

```bash
curl -s localhost:3005/api/health     # {"status":"ok","database":"ok"}
curl -sI https://yourdomain/          # HTTP/2 200
```

If the database read fails the route answers **503** with a different body —
`{"status":"degraded","database":"unavailable"}`. Worth knowing if you point an
external monitor at it: match on the HTTP status, or on the exact string
`"status":"ok"`, because a check that merely greps for `status` matches both.

Then in a browser: sign in with your admin email, confirm the code arrives, and
confirm you land with admin controls. Open the admin panel and check that
auto-approve is **off**.

### Cowork and the VS Code bridge

This section used to say Cowork and Deep Cowork would be greyed out, that they
read and write real files on the server with no per-user isolation, and that
turning them on would give you an agent editing `/app` — the compiled bundle
rather than anyone's source. All of that was accurate and none of it is any
more.

File operations no longer happen on this machine. Each user installs the
OmniRoute VS Code extension, pairs it with a token minted for their account, and
every read, write and command is forwarded to *their* editor and executed there.
A production build has no fallback to the server's filesystem: the call reaches
their VS Code or it fails with a message saying so. Their code never leaves their
machine, and nothing on this server is reachable through the feature.

With `OMNIROUTE_BRIDGE_ENABLE=true` and the Caddy `handle` block from §6 in
place, Cowork is available to anyone who has connected an editor and shows a
"connect VS Code" prompt to anyone who has not. Leave the variable blank and the
whole feature is hidden, cleanly — the listener never binds and the file tools
switch themselves off to match, so there is no state where the UI is offered and
every action fails.

`OMNIROUTE_WORKSPACE_ROOT` is ignored in production. It named the single folder
the old server-side tools operated on; "which folder" is now a question only the
connected editor can answer, and the extension asks its user per folder. The boot
check warns if the variable is set, so that a working deployment is not mistaken
for evidence that it took effect.

### Updating later

```bash
git pull
docker compose up -d --build
```

The database is on a named volume, so it survives rebuilds. **Back it up before
any update.** The image now ships the `sqlite3` CLI for exactly this, so the
backup can be taken online, with no downtime:

```bash
docker compose exec -T app sqlite3 /data/chat.db ".backup '/data/backup.db'"
docker compose cp app:/data/backup.db ./backup-$(date +%F).db
docker compose exec -T app rm -f /data/backup.db
```

`.backup` uses SQLite's online backup API: it takes a read lock, copies every
page *including the contents of the write-ahead log*, and writes one consistent
file while the server keeps serving.

Do not substitute `cp`. WAL mode keeps recent commits in `chat.db-wal` until a
checkpoint folds them in, so a plain copy of `chat.db` produces a file that looks
right, opens cleanly, and is silently missing everything written since the last
checkpoint — the kind of backup you discover is wrong on the day you need it.

Stopping the container first also works (`docker compose stop app`, copy,
`docker compose start app`), because the SIGTERM handler in `src/lib/db.ts`
checkpoints the WAL on the way down. It just costs a few seconds of downtime for
no extra safety now that `.backup` is available.

---

## 9. What still will not work after deploying

Honest list, so nothing surprises you later.

**Your localhost gateway is unreachable from the server.** §0. Cloudflare Tunnel
is the workaround for your own account.

**Cowork / Deep Cowork need the user's editor to be open.** This entry used to
read "cannot edit files on a user's computer — that is the VS Code extension's
job, and a separate piece of work". That work is done; the extension is the
mechanism. The remaining limitation is smaller but real: file tools do nothing
for a user who has not installed and paired the extension, or who has it closed.
There is no server-side substitute, by design.

**SMS OTP to Indian numbers.** Blocked by DLT registration, not by code.

**UPI payments are confirmed manually.** There is no callback from UPI without a
payment gateway (Razorpay et al., which require a registered business). The
current design is as good as it gets without one: each order gets a unique paise
suffix so transfers are individually identifiable, the user submits their UTR,
and you approve it in the admin panel. Approval is atomic and idempotent, so a
double-click cannot grant two subscriptions.

**Server-side PDF export.** The image deliberately skips Chromium's ~170 MB
download to stay inside a free-tier disk budget, so that route fails and the UI
falls back to the browser's own print dialog. The Dockerfile has a commented
block showing how to enable it if you ever want it.

**One server only.** SQLite is a file; two containers sharing it over a network
filesystem will corrupt it. Scale up, not out. For the traffic this will realistically
see, a single small VPS is not the bottleneck.

---

## 10. Quick reference

| Item | Choice | Cost |
|---|---|---|
| Host | Oracle Cloud Always Free (ARM) | ₹0 |
| Host (fallback) | Budget annual VPS, ~$11–13/yr | ~₹1000/yr |
| TLS + domain | DuckDNS + Caddy | ₹0 |
| TLS + domain (nicer) | `.in`/`.xyz` + Caddy | ~₹200–900/yr |
| Email | Resend free tier | ₹0 |
| SMS | Not viable yet (DLT) | — |
| Gateway | Per-user, or Cloudflare Tunnel | ₹0 |

Free path: **₹0.** With your own domain: **₹200–900 for a year**, inside budget.

---

## Appendix: files added for deployment

`Dockerfile` (3-stage build on `node:22-bookworm-slim`, non-root, healthcheck),
`docker-compose.yml` (one service, named volume, loopback-bound port, log
rotation), `.dockerignore` (keeps `.env*`, `chat.db` and backups out of the
image), `.env.production.example` (every variable the code actually reads, taken
from the source), and `src/app/api/health/route.ts` (unauthenticated liveness
probe that does a real database read).

Also changed: `next.config.ts` gained `output: "standalone"`;
`src/instrumentation.ts` runs the safety check at boot but skips it during
`next build`; `src/lib/db.ts` gained `databaseHealthy()`; `src/lib/rateLimit.ts`
gained `rateLimitByIp()` so that per-IP limits behind an unknown proxy degrade to
a generous shared ceiling instead of locking out every user at once.
