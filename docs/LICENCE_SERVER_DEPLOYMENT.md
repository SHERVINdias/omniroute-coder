# Cloud Licence Server — Deployment Runbook

**Goal:** stand up the small cloud "doorman" so the three features go live:
email sign-in for testers, your ability to **revoke** a tester, and **auto-updates**.

**What you'll use (all low-cost):**
- **AWS Lightsail** — a flat $5/month Linux box (your $80 credit ≈ 15 months).
- **DuckDNS** — a free `something.duckdns.org` address (no domain to buy).
- **Gmail App Password** — sends sign-in codes to anyone, no domain needed.
- **Docker + Caddy** — the same way your app already deployed; Caddy gets you HTTPS automatically.

**Time:** about 90 minutes the first time. Do the phases in order.

**One honest note up front:** minting/revoking keys is done with a short
browser-console command for now (there's no button in the admin panel yet). It's
copy-paste and I give you the exact text. Say the word later and I'll add proper
buttons.

---

## Phase 0 — Before you start

You need:
- An AWS account (you already have one).
- A Google account you'll send sign-in codes from.
- Your project on this PC (you have it).

Decide your address now. Pick a name like `omniroute-licence`. Your server will
live at **`https://omniroute-licence.duckdns.org`**. Write it down; it appears in
several places below.

---

## Phase 1 — Generate the licence keypair (on your PC, ~5 min)

This makes the secret that signs licences and the public half the app checks
them with.

1. Open PowerShell in your project:
   ```powershell
   cd "C:\Users\10csh\OneDrive\Desktop\omniroute-coder-external-provider-version6.9\omniroute-coder"
   node scripts/gen-licence-keys.mjs
   ```

2. It prints two blocks. Copy the **PUBLIC KEY** block (the `-----BEGIN PUBLIC
   KEY-----` … `-----END PUBLIC KEY-----` part).

3. Paste it — replacing the line `REPLACE_WITH_REAL_ED25519_PUBLIC_KEY` — in
   **both** files, keeping the BEGIN/END lines:
   - `src\lib\licence.ts`
   - `desktop\licence.js`

4. Take the **PRIVATE KEY** block and turn it into one line (base64), so it's
   easy to put in the server's settings. In PowerShell, paste the private key
   into a file first, then encode it:
   ```powershell
   # Paste the private key between the quotes, then run:
   $pem = @"
   -----BEGIN PRIVATE KEY-----
   ...your private key lines...
   -----END PRIVATE KEY-----
   "@
   [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pem)) | Out-File licence-signing-key.b64 -Encoding ascii
   notepad licence-signing-key.b64
   ```
   Keep that one-line value safe. It is the master key — never commit it, never
   put it in the desktop app. You'll paste it into the server in Phase 7.

---

## Phase 2 — Gmail App Password (~5 min)

This lets the server email sign-in codes to your testers.

1. Go to your Google Account → **Security**. Turn on **2-Step Verification** if
   it isn't already (App Passwords require it).
2. Search Google Account settings for **App passwords**.
3. Create one, name it "OmniRoute Licence". Google shows a **16-character**
   password like `abcd efgh ijkl mnop`. Copy it and **remove the spaces** →
   `abcdefghijklmnop`.
4. Note your Gmail address and that 16-char password. You'll use both in Phase 7.

> Why Gmail and not Resend here: Resend needs a real domain to email strangers,
> and DuckDNS can't be verified with Resend. Gmail App Password sends to anyone
> with no domain. It uses port 587, which AWS allows (the old failure was empty
> settings, not a blocked port — Phase 7 sets them cleanly).

---

## Phase 3 — Create the server on AWS Lightsail (~15 min)

1. Sign in to AWS. In the search bar type **Lightsail**, open it.
2. Click **Create instance**.
3. **Region:** pick the one closest to your testers (e.g. Mumbai `ap-south-1`).
4. **Platform:** Linux/Unix. **Blueprint:** choose **OS Only → Ubuntu 22.04 LTS**.
   (Not the "Node.js" blueprint — you'll install Docker yourself.)
5. **Instance plan:** the **$5/month** one (1 GB RAM). Enough for 10 testers.
6. Name it `omniroute-licence`. Click **Create instance**. Wait ~2 min until it
   says **Running**.
7. Click the instance → **Networking** tab → under **IPv4 Firewall**, click
   **Add rule** and add:
   - **HTTPS / TCP / 443**
   - **HTTP / TCP / 80** (Caddy needs 80 to get the certificate)
   (SSH/22 is already there.)
8. Still on the instance page, note the **Public IPv4 address** (e.g.
   `13.201.xx.xx`). Also click **Create static IP**, attach it to this instance,
   so the address never changes. Write the IP down.

---

## Phase 4 — Free domain with DuckDNS, pointed at the server (~10 min)

1. Go to **duckdns.org**, sign in (Google is fine).
2. In the **domains** box type your name, e.g. `omniroute-licence`, click **add
   domain**. You now own `omniroute-licence.duckdns.org`.
3. In the **current ip** field for that domain, paste the server's **static IP**
   from Phase 3, click **update ip**.
4. Verify it points there. In PowerShell:
   ```powershell
   nslookup omniroute-licence.duckdns.org
   ```
   The answer should show your server's IP. (DNS can take a few minutes.)

---

## Phase 5 — Connect to the server and install Docker (~10 min)

1. On the Lightsail instance page, click the orange **Connect using SSH** button.
   A terminal opens in your browser (no key setup needed).
2. Install Docker and the compose plugin — paste these one block at a time:
   ```bash
   sudo apt-get update
   sudo apt-get install -y ca-certificates curl git
   sudo install -m 0755 -d /etc/apt/keyrings
   curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
   sudo apt-get update
   sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
   sudo usermod -aG docker $USER
   ```
3. Log the group change in: type `exit`, then click **Connect using SSH** again.
   Test: `docker --version` should print a version.

---

## Phase 6 — Get your code onto the server (~10 min)

Your project is on GitHub (you mentioned it's deployed there). On the server:

1. Clone it (use your repo URL; if private, use a token or the `gh` CLI):
   ```bash
   cd ~
   git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git licence
   cd licence
   ```
   If the repo is private and git asks for a password, paste a GitHub **personal
   access token** as the password (github.com → Settings → Developer settings →
   Fine-grained tokens → repo read access).

2. Confirm the important files are there:
   ```bash
   ls Dockerfile src/middleware.ts src/lib/licenceAllowlist.json
   ```
   All three should list. (These are the licence-server pieces.)

> Make sure the code you push to GitHub includes the Phase 1 public-key paste.
> Commit and push from your PC first if you haven't: the server clones what's on
> GitHub, not what's on your laptop.

---

## Phase 7 — The server's settings file (~10 min)

Create the environment file that turns this box into a **licence server**. On the
server, inside `~/licence`:

```bash
nano licence.env
```

Paste this, filling in your real values:

```
NODE_ENV=production

# THIS is what makes it a licence server: only auth/admin/subscription/credits/
# health/licence routes are reachable; everything else is refused.
OMNIROUTE_ROLE=licence

# Two long random secrets. Generate each with: openssl rand -base64 32
AUTH_SECRET=paste-a-32+char-random-string
CREDENTIALS_SECRET=paste-a-different-32+char-random-string

# The base64 private key from Phase 1 (one long line).
LICENCE_SIGNING_KEY_B64=paste-the-one-line-base64-here

# Email (Phase 2). No spaces in the app password.
GMAIL_USER=you@gmail.com
GMAIL_APP_PASSWORD=abcdefghijklmnop
MAIL_FROM=you@gmail.com

# You, so you get the admin panel to mint keys.
ADMIN_EMAILS=you@gmail.com
```

Save (Ctrl+O, Enter) and exit (Ctrl+X). Generate the two secrets right there if
you like:
```bash
openssl rand -base64 32
openssl rand -base64 32
```

> Do NOT add `OMNIROUTE_ALLOW_PRIVATE_GATEWAY` and do NOT add
> `OMNIROUTE_BRIDGE_ENABLE` here. The licence server needs neither, and both
> would only widen its surface.

Lock the file down so only you can read it:
```bash
chmod 600 licence.env
```

---

## Phase 8 — docker-compose + Caddy for HTTPS (~10 min)

Two small files put the app behind Caddy, which fetches a real HTTPS certificate
for your DuckDNS name automatically.

1. The Caddy config. Create `Caddyfile`:
   ```bash
   nano Caddyfile
   ```
   Paste (replace the domain and your email):
   ```
   omniroute-licence.duckdns.org {
       reverse_proxy app:3005
   }
   ```

2. The compose file. Create `docker-compose.yml`:
   ```bash
   nano docker-compose.yml
   ```
   Paste:
   ```yaml
   services:
     app:
       build: .
       env_file: licence.env
       volumes:
         - licence-data:/data
       restart: unless-stopped
       expose:
         - "3005"

     caddy:
       image: caddy:2
       depends_on:
         - app
       ports:
         - "80:80"
         - "443:443"
       volumes:
         - ./Caddyfile:/etc/caddy/Caddyfile:ro
         - caddy-data:/data
         - caddy-config:/config
       restart: unless-stopped

   volumes:
     licence-data:
     caddy-data:
     caddy-config:
   ```
   Save and exit.

---

## Phase 9 — Launch and verify (~10 min)

1. Build and start (first build takes a few minutes):
   ```bash
   docker compose up -d --build
   ```
2. Watch it come up:
   ```bash
   docker compose logs -f app
   ```
   Look for the `[omniroute] resolved configuration` block. Confirm:
   - `NODE_ENV production`
   - `email provider gmail` (NOT "none")
   - `admin allowlist` shows your email
   Press Ctrl+C to stop watching (the app keeps running).
3. Test HTTPS from your PC browser: open
   `https://omniroute-licence.duckdns.org/api/health`
   You want `{"status":"ok","database":"ok"}`. (If the certificate isn't ready
   yet, wait a minute and retry — Caddy is fetching it.)
4. Confirm the doorman is closed to everything else — this should be **refused**:
   `https://omniroute-licence.duckdns.org/api/models`
   You want a 403 "not available on the licence server". That proves default-deny
   is working.

---

## Phase 10 — Point the desktop app at the server, rebuild (~10 min)

Back on your PC:

1. In `desktop\licence.js`, set the real URL (replace the placeholder):
   ```js
   const LICENCE_URL = (
     (process.env.OMNIROUTE_LICENCE_URL && process.env.OMNIROUTE_LICENCE_URL.trim()) ||
     "https://omniroute-licence.duckdns.org"
   ).replace(/\/+$/, "");
   ```
2. In `src\lib\licence.ts`, make sure the same URL is the fallback for
   `licenceServerUrl()` (or set `OMNIROUTE_LICENCE_URL` in `desktop\main.js`'s
   spawn env). Simplest: in `desktop\main.js`, add to the server `env` object:
   ```js
   OMNIROUTE_LICENCE_URL: "https://omniroute-licence.duckdns.org",
   ```
3. Rebuild the installer:
   ```powershell
   cd "C:\Users\10csh\OneDrive\Desktop\omniroute-coder-external-provider-version6.9\omniroute-coder"
   npm run build
   cd desktop
   npm run dist
   ```
   The `.exe` is in `desktop\dist\`.

---

## Phase 11 — Mint a key, activate, test revoke and update (~15 min)

**Sign in to your licence server as admin:**
1. Open `https://omniroute-licence.duckdns.org` in your browser.
2. Click **Sign in**, enter your admin Gmail, get the code by email, sign in.

**Mint a licence key (browser console, while signed in):**
3. Press F12 → **Console**, paste and Enter:
   ```js
   fetch('/api/admin', {method:'POST', headers:{'content-type':'application/json'},
     body: JSON.stringify({action:'generate-licence-key', label:'Rahul beta #1'})})
     .then(r=>r.json()).then(d=>console.log(d.licenceKey.key))
   ```
   It prints a key like `OMNI-A7K2-9XQF-M4TP`. That's what you send a tester.

**Activate the desktop app with it:**
4. Run your new installer, launch the app. On first run it asks for a licence
   key. Paste the key → it activates and the app opens.

**Test revoke:**
5. Back in the browser console:
   ```js
   fetch('/api/admin', {method:'POST', headers:{'content-type':'application/json'},
     body: JSON.stringify({action:'revoke-licence-key', key:'OMNI-A7K2-9XQF-M4TP'})})
     .then(r=>r.json()).then(console.log)
   ```
6. Reopen the desktop app (or wait up to 12h in a running session). It now
   refuses to run. Reinstate with `action:'reinstate-licence-key'` and it works
   again.

**See who's running it:**
   ```js
   fetch('/api/admin?action=licences').then(r=>r.json()).then(console.log)
   ```
   Shows every key and every install that has checked in.

---

## Phase 12 — Day to day

- **New tester:** mint a key (Phase 11 step 3), send them the key + the `.exe`.
- **Cut someone off:** revoke their key. Their app stops at its next check.
- **Ship an update:** rebuild the installer, and (updates feed) upload the new
  installer + `latest.yml` to the licence server's update folder — I'll give you
  the exact upload step when you first ship an update; it's a short addition.
- **Cost:** the $5/month Lightsail box. **Stop your old EC2 instance** (you're on
  desktop now) so it stops spending your credit.
- **Backups of the licence DB** (holds keys + accounts):
  ```bash
  docker compose exec -T app sqlite3 /data/chat.db ".backup '/data/backup.db'"
  docker compose cp app:/data/backup.db ./licence-backup-$(date +%F).db
  ```

---

## If something's wrong

- **Certificate won't issue / health check fails over HTTPS:** confirm ports 80
  and 443 are open in the Lightsail firewall (Phase 3.7) and DuckDNS points at
  the static IP (Phase 4.3). Caddy needs port 80 to validate.
- **Sign-in code never arrives:** check `docker compose logs app` for the email
  line; confirm `email provider gmail` in the config block and that the app
  password has no spaces.
- **App says "licence key not recognised":** the key wasn't minted on THIS server,
  or the public key pasted in Phase 1 doesn't match the server's private key.
  Re-check both halves came from the same `gen-licence-keys.mjs` run.
- **Everything 403s, even sign-in:** `OMNIROUTE_ROLE` is set but you're hitting a
  route that isn't on the allowlist — that's expected for app routes; sign-in
  (`/api/auth/*`) and admin (`/api/admin`) are allowed.
