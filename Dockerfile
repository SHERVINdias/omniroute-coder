# ---------------------------------------------------------------------------
# omniroute-coder — production image
# ---------------------------------------------------------------------------
# Three stages, so the final image carries the compiled app and nothing else.
#
# WHY node:22-bookworm-slim AND NOT alpine
#
# better-sqlite3 loads a prebuilt native binary. This package ships binaries for
# both glibc (linux-x64 / linux-arm64) and musl (linuxmusl-x64 / linuxmusl-arm64),
# so alpine would technically work — but it selects the musl build at runtime by
# probing `process.report`, and every other native dependency in this project
# would need to agree. bookworm is the same libc the prebuilds are tested
# against, so the binary that gets loaded here is the one the package authors
# validated. Node 22 is required by the package's own `engines` field.
#
# WHY A SEPARATE deps STAGE
#
# `npm ci` is the slowest step and it changes least often. Splitting it means
# editing a source file rebuilds only the builder stage, not the whole
# node_modules tree.
#
# PUPPETEER_SKIP_DOWNLOAD: puppeteer is a dependency of this project (the PDF
# render path imports it), and by default its postinstall fetches a ~170 MB
# Chromium build plus its system libraries. This image skips that download:
# headless Chrome is not installed here, so the PDF route returns an error at
# runtime and the client falls back to the browser's own print dialog. That is a
# deliberate trade — a smaller image and a much larger free-tier disk budget, in
# exchange for one export format that the UI can already produce client-side.
# To enable real PDF rendering, see the note at the bottom of this file.
#
# No secrets are baked in. Everything sensitive is supplied at `docker run` time
# via env_file, so the image itself is safe to keep in a registry.
# ---------------------------------------------------------------------------

# ------------------------------------------------------------------ deps ---
FROM node:22-bookworm-slim AS deps

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Only the manifests, so this layer is cached until dependencies actually change.
# The lockfile is required: `npm ci` refuses to run without it, and that is the
# point — it installs exactly the tree that was tested, not a fresh resolution.
COPY package.json package-lock.json ./

# `--include=dev` is explicit because NODE_ENV is not yet production in this
# stage; typescript and tailwind are needed to build. `--ignore-scripts` is NOT
# used: better-sqlite3 and puppeteer both rely on postinstall, and both are
# neutralised above by the prebuilds (sqlite) and the skip flag (chromium).
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm ci --include=dev

# --------------------------------------------------------------- builder ---
FROM node:22-bookworm-slim AS builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Produces .next/standalone (see next.config.ts). The build reads no runtime
# secrets: the production safety check in src/instrumentation.ts skips the
# build phase precisely so that a missing deployment variable cannot fail the
# build. Any NEXT_PUBLIC_* value must be passed here as a build arg, because
# those are inlined into the client bundle at compile time.
RUN npm run build

# ---------------------------------------------------------------- runner ---
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3005 \
    HOSTNAME=0.0.0.0 \
    OMNIROUTE_DB_PATH=/data/chat.db

# The standalone output contains server.js plus a minimal node_modules holding
# only what Next traced. static/ and public/ are not part of it and must be
# copied separately or every CSS, JS and image request 404s.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# better-sqlite3 needs its native binary, and Next cannot trace it.
#
# The binding is resolved at runtime, not at build time: lib/binding.js builds a
# path from process.platform/arch, checks it with fs.existsSync, and only then
# calls require() on it. Static analysis sees a dynamic require of a variable and
# cannot know about the prebuilds/ directory, so it is not copied into the
# standalone bundle — the container starts, and the first database call dies with
# "Could not locate the bindings file". Copying the whole package is the fix, and
# copying the whole package rather than just the .node file means the lib/ code
# that loads it stays in step with it.
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3

# The sqlite3 command-line tool, purely so that backups can be taken correctly.
#
# This is the one apt package in the runner and it earns its ~2 MB. The database
# runs in WAL mode, which means chat.db is NOT a complete copy of the data on
# its own — recent commits live in chat.db-wal until a checkpoint folds them in.
# `cp /data/chat.db backup.db` therefore produces a file that looks right, opens
# cleanly, and is missing everything written since the last checkpoint. It is
# the kind of backup you discover is wrong on the day you need it.
#
#   docker compose exec -T app sqlite3 /data/chat.db ".backup '/data/backup.db'"
#
# `.backup` uses SQLite's online backup API: it takes a read lock, copies pages
# including everything in the WAL, and produces a single consistent file while
# the server keeps serving. No downtime, no partial write, one file to restore.
#
# Installed as root, before USER node below. The apt lists are removed in the
# same layer — deleting them in a later step would leave them in this one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends sqlite3 \
 && rm -rf /var/lib/apt/lists/*

# SQLite writes here. Declared as a volume in docker-compose.yml, so the file
# survives `docker compose up --build` — without that, every redeploy wipes
# every account, chat and payment order.
RUN mkdir -p /data && chown -R node:node /data

# Run unprivileged. The image ships a `node` user (uid 1000); the app needs no
# elevated access and a compromise here should not be able to modify its own
# binary or the database's ownership.
USER node

EXPOSE 3005

# The VS Code bridge listener. EXPOSE is documentation, not a firewall — it
# opens nothing on its own — but it records that this image has a second port
# worth knowing about, which is otherwise only discoverable by reading
# src/lib/vscodeBridge.ts. Whether anything is actually listening depends on
# OMNIROUTE_BRIDGE_ENABLE, and whether anything can reach it depends on
# OMNIROUTE_BRIDGE_HOST plus the publish rule in docker-compose.yml.
EXPOSE 20129

# Probes /api/health, which does a real database read — a process that is up but
# cannot reach its database is not serving anyone, and compose would otherwise
# report it healthy. `node -e` is used instead of curl/wget because neither is
# installed in a slim image and adding one just for this is not worth the layer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3005)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `node server.js`, not `next start`. With output: "standalone" the server is a
# self-contained file that does not consult .next at runtime; `next start` would
# expect a full build directory and a `next` binary that is not installed in this
# image.
CMD ["node", "server.js"]

# ---------------------------------------------------------------------------
# To enable server-side PDF rendering later, add these lines and give the
# container about 1 GB more disk:
#
#   FROM ... AS runner
#   ENV PUPPETEER_SKIP_DOWNLOAD=false
#   RUN apt-get update \
#    && apt-get install -y --no-install-recommends \
#         chromium fonts-liberation ca-certificates \
#    && rm -rf /var/lib/apt/lists/*
#   ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
#
# and remove the PUPPETEER_SKIP_DOWNLOAD from the deps/builder stages. Verify the
# version that matches puppeteer's bundled Chromium expectations before relying
# on it; a mismatched system Chromium fails at launch, not at build.
# ---------------------------------------------------------------------------
