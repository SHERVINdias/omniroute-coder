/**
 * src/lib/db.ts
 * ---------------------------------------------------------------------------
 * SQLite persistence for chats and messages.
 *
 * This is a rewrite of the original file. The schema is compatible — your
 * existing `chat.db` is migrated in place, no rows are dropped — but six real
 * defects are fixed:
 *
 *  1. ONE CONNECTION. Next.js dev re-evaluates modules on every hot reload, so
 *     `new Database()` at module scope opened a new handle each time and leaked
 *     them until the dev server restarted. The handle now lives on globalThis.
 *
 *  2. FOREIGN KEYS ARE ACTUALLY ON. The `ON DELETE CASCADE` in the original
 *     schema never fired: SQLite ignores foreign keys unless you enable them
 *     per connection. Deleting a chat left its messages orphaned in the table
 *     forever. `deleteChat` now also deletes explicitly, so it is correct even
 *     on a connection where the pragma failed.
 *
 *  3. DETERMINISTIC MESSAGE ORDER. `ORDER BY created_at` sorted by a
 *     CURRENT_TIMESTAMP with *one-second* resolution. A user message and its
 *     assistant reply written in the same second could come back in either
 *     order — reliably scrambling short conversations on reload. Ordering is
 *     now by `rowid`, which is monotonic insertion order.
 *
 *  4. UPSERT THAT KEEPS ITS PLACE. `INSERT OR REPLACE` deletes the row and
 *     re-inserts it, which assigns a *new* rowid and would have jumped an
 *     edited message to the end of the transcript. `ON CONFLICT DO UPDATE`
 *     keeps the original rowid, which is what makes fix 3 hold while an
 *     assistant message is written once at stream start and again at the end.
 *
 *  5. CREATING A CHAT IS IDEMPOTENT. `createChat` used a bare INSERT, so
 *     calling it twice with the same id threw SQLITE_CONSTRAINT_PRIMARYKEY.
 *     `ensureChat` is safe to call on every single turn.
 *
 *  6. A `metadata` COLUMN. Attachments, tool calls and route info had nowhere
 *     to live, so they silently vanished on reload. Added as JSON text.
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

/* -------------------------------------------------------------------------
 * Connection
 * ---------------------------------------------------------------------- */

/** Override with OMNIROUTE_DB_PATH to move the database off the repo root. */
const DB_PATH =
  process.env.OMNIROUTE_DB_PATH?.trim() || path.join(process.cwd(), "chat.db");

declare global {
  /* eslint-disable-next-line no-var */
  var __omnirouteDb: Database.Database | undefined;
}

function addColumnIfMissing(
  database: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (columns.some((c) => c.name === column)) return;
try {
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
} catch {
  /* ignore duplicate column errors from parallel build workers */
}
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL DEFAULT 'FREE',
      createdAt INTEGER NOT NULL,
      referralCode TEXT
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      tier TEXT NOT NULL,
      startDate INTEGER NOT NULL,
      endDate INTEGER,
      isActive INTEGER NOT NULL DEFAULT 1,
      paymentId TEXT,
      upiTransactionId TEXT,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS usage_logs (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      action TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS referral_codes (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL,
      createdBy TEXT NOT NULL,
      usedBy TEXT,
      usedAt INTEGER,
      isActive INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS admin_settings (
      upiId TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expiresAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS otp_codes (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0
    );

    /* Generic key/value settings. Replaces admin_settings, which had no primary
     * key at all — every UPDATE ran without a WHERE and rewrote every row, and
     * reads relied on an arbitrary LIMIT 1. Values are opaque TEXT; callers are
     * responsible for parsing. See migrateAdminSettings() below for the
     * one-time copy of the old upiId. */
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    /* Desktop installs, recorded by the licence server (OMNIROUTE_ROLE=licence).
     * A random per-install UUID the app generates on first run, tied to the
     * account that activated it, with a last-seen timestamp and the version it
     * last reported. This is the "this account is running on N machines" signal
     * — it deliberately learns nothing ABOUT any machine (no fingerprint), only
     * that a distinct install checked in. On the desktop app's own database this
     * table simply stays empty. */
    CREATE TABLE IF NOT EXISTS installs (
      installId TEXT PRIMARY KEY,
      licenceKey TEXT,
      userId TEXT,
      firstSeen INTEGER NOT NULL,
      lastSeen INTEGER NOT NULL,
      appVersion TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_installs_user ON installs(userId);

    /* Desktop licence keys. Each tester gets one key string; the desktop app
     * sends it (with its install UUID) to /api/licence/check on launch. The
     * revoked column is the cut-off switch: flip it and the app refuses to run
     * within moments. The label column is a human note (e.g. a tester name) so
     * the admin panel is readable. On a non-licence deployment this table
     * simply stays empty. */
    CREATE TABLE IF NOT EXISTS licence_keys (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      revoked INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      revokedAt INTEGER,
      lastSeen INTEGER
    );

    /* A UPI payment is a bank-to-bank transfer that never touches this server,
     * so there is no callback to trust. The order row is the reconciliation
     * record: the server fixes an amount that is unique among open orders, the
     * payer reports the UTR their bank issued, and an admin matches the two
     * against the real bank statement before the tier is granted.
     *
     * status: CREATED -> SUBMITTED -> APPROVED | REJECTED, or -> EXPIRED. */
    CREATE TABLE IF NOT EXISTS payment_orders (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      email TEXT NOT NULL,
      amountPaise INTEGER NOT NULL,
      upiId TEXT NOT NULL,
      payeeName TEXT NOT NULL,
      note TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'CREATED',
      utr TEXT,
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL,
      submittedAt INTEGER,
      reviewedAt INTEGER,
      reviewedBy TEXT,
      reviewNote TEXT,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    /* Partial unique index: a UTR identifies exactly one real bank transfer, so
     * it may back at most one order. NULLs are excluded so unsubmitted orders
     * do not collide with each other. */
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_utr
      ON payment_orders(utr) WHERE utr IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(userId);
    CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status);

    CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(userId);
    CREATE INDEX IF NOT EXISTS idx_usage_logs_user ON usage_logs(userId);
    CREATE INDEX IF NOT EXISTS idx_usage_logs_timestamp ON usage_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(userId);
    CREATE INDEX IF NOT EXISTS idx_otp_codes_email ON otp_codes(email);

    /* Per-user gateway credentials.
     *
     * These used to live in a single providers.json at the process working
     * directory: one global list, shared by everyone, served in cleartext by an
     * unauthenticated GET. That made "my settings" mean "everyone's settings" —
     * one user changing a base URL redirected every other user's traffic.
     *
     * apiKey holds a v1: AES-256-GCM record from lib/crypto.ts, never a raw
     * key. Rows written before encryption existed are read back verbatim, so an
     * upgrade does not strand anyone's existing credential.
     *
     * The UNIQUE(userId, id) pair is what scopes the namespace: two users may
     * each own a provider called "omniroute-1" without collision, and a DELETE
     * must match on both columns so one user cannot remove another's row by
     * guessing its id. */
    CREATE TABLE IF NOT EXISTS user_providers (
      rowId INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      apiKey TEXT NOT NULL,
      baseUrl TEXT NOT NULL,
      modelIds TEXT,
      isActive INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      UNIQUE(userId, id),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_providers_user ON user_providers(userId);

    /* At most one active provider per user. A partial index rather than an
     * application-level check, so a concurrent write cannot leave two rows
     * active and make "which gateway am I using" ambiguous. */
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_providers_active
      ON user_providers(userId) WHERE isActive = 1;
  `);

  /* Databases created by the previous version of this file predate these
   * columns. CREATE TABLE IF NOT EXISTS above is a no-op for them, so the
   * columns have to be added explicitly. */
  addColumnIfMissing(database, "messages", "metadata", "TEXT");
  addColumnIfMissing(database, "chats", "model", "TEXT");
  addColumnIfMissing(database, "chats", "mode", "TEXT");

  /* The installs table gained a licenceKey column when the desktop licence
   * moved to the key model. A database created between then and now has the
   * table without that column, so add it before the index that needs it — a
   * CREATE INDEX inside the schema block above would throw "no such column" on
   * exactly those databases. */
  addColumnIfMissing(database, "installs", "licenceKey", "TEXT");
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_installs_key ON installs(licenceKey)",
  );

  /* Ownership. Chats used to be a single global list with no user column at
   * all, so on any multi-user deployment every account would see, rename and
   * delete every other account's conversations.
   *
   * Existing rows get NULL rather than a guessed owner. NULL means "created
   * before ownership existed"; see `chatOwnerClause` for how that is treated —
   * visible to a local single-user install, invisible once the app is
   * deployed, which is the only reading that is safe in both cases. */
  addColumnIfMissing(database, "chats", "user_id", "TEXT");

  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, updated_at DESC);",
  );

  /* Authorization used to be a string comparison against a hardcoded address
   * inside isAdmin(). Roles now live on the row so they can be granted and
   * revoked at runtime. Existing rows default to USER; the bootstrap
   * allowlist in emailAuth.ts promotes the configured accounts on next login. */
  addColumnIfMissing(database, "users", "role", "TEXT NOT NULL DEFAULT 'USER'");
  /* Phone logins were stored in the `email` column, which made a phone account
   * and an email account for the same person indistinguishable. The digits are
   * now mirrored here so they can be matched and displayed as a phone. */
  addColumnIfMissing(database, "users", "phone", "TEXT");
  addColumnIfMissing(database, "users", "lastLoginAt", "INTEGER");

  /* A 6-digit code has a million possibilities, which is minutes of brute force
   * against an endpoint with no attempt cap. Failures are counted per code and
   * the row is burned once the cap is hit. */
  addColumnIfMissing(database, "otp_codes", "attempts", "INTEGER NOT NULL DEFAULT 0");
  /* Distinguishes an email OTP from an SMS OTP for auditing; not load-bearing. */
  addColumnIfMissing(database, "otp_codes", "channel", "TEXT");

  /* How many messages retention has removed from this chat, so the transcript
   * can say "12 earlier messages were removed" instead of quietly starting in
   * the middle. See enforceRetention() below. */
  addColumnIfMissing(
    database,
    "chats",
    "trimmed_messages",
    "INTEGER NOT NULL DEFAULT 0",
  );

  migrateAdminSettings(database);
}

/**
 * One-time copy of the legacy `admin_settings.upiId` into `app_settings`.
 *
 * The old table has no primary key, so it may hold several rows that disagree.
 * The most recently updated one wins. Runs only when `app_settings` has no
 * `upi_id` yet, so a value edited through the new admin panel is never
 * clobbered by a stale legacy row.
 */
function migrateAdminSettings(database: Database.Database): void {
  try {
    const already = database
      .prepare("SELECT 1 FROM app_settings WHERE key = 'upi_id'")
      .get();
    if (already) return;

    const legacy = database
      .prepare(
        "SELECT upiId, updatedAt FROM admin_settings WHERE upiId IS NOT NULL AND TRIM(upiId) <> '' ORDER BY updatedAt DESC LIMIT 1",
      )
      .get() as { upiId: string; updatedAt: number } | undefined;
    if (!legacy) return;

    database
      .prepare(
        "INSERT OR IGNORE INTO app_settings (key, value, updatedAt) VALUES ('upi_id', ?, ?)",
      )
      .run(legacy.upiId.trim(), legacy.updatedAt || Date.now());
  } catch {
    /* admin_settings may not exist on a fresh database. Nothing to migrate. */
  }
}

function openDatabase(): Database.Database {
  const dir = path.dirname(DB_PATH);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const database = new Database(DB_PATH);

  /* busy_timeout FIRST. This ordering is the fix for a build that failed with
   * "database is locked", and the reason is that the very next pragma is the
   * one most likely to contend.
   *
   * Switching journal mode takes a brief EXCLUSIVE lock. `next build` collects
   * page data in a pool of worker processes — fifteen of them on this machine —
   * and every worker that imports a route importing this module opens its own
   * connection and runs this same line. One wins, the rest get SQLITE_BUSY.
   * With busy_timeout set afterwards, they got it with a zero-length timeout:
   * SQLite returned immediately instead of retrying, and the build died on a
   * lock that would have cleared in milliseconds.
   *
   * Setting the timeout first costs nothing and applies to everything below it,
   * including the migration, which is also a write and also races. */
  database.pragma("busy_timeout = 5000");

  /* WAL lets a read (the sidebar) and a write (a streaming turn) happen at the
   * same time instead of throwing SQLITE_BUSY. busy_timeout covers the rest. */
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");

  /* In WAL mode `synchronous = FULL` (the default) fsyncs the log on every
   * commit. NORMAL fsyncs only at a checkpoint, which is the setting SQLite's
   * own documentation recommends for WAL: the guarantee that is lost is
   * durability of the last few commits across an *operating system* crash or
   * power cut, not across a process crash — a WAL commit that reached the OS
   * page cache is still replayed if only the app dies. On a single small EC2
   * instance doing a write per streamed token, the fsync per commit is the
   * dominant cost of a chat turn, and the thing being risked is the tail of one
   * conversation. */
  database.pragma("synchronous = NORMAL");

  /* Bound the WAL instead of letting it grow without limit.
   *
   * THIS IS THE FIX FOR THE 4.6 GB chat.db-wal IN THE WORKING DIRECTORY.
   *
   * Automatic checkpointing already runs when the log passes 1000 pages, but a
   * checkpoint can only copy back the frames that no reader still needs, and it
   * does not shrink the file afterwards. Two things were defeating it here:
   * every hot reload used to leak a connection (fix 1 at the top of this file),
   * and each leaked handle pinned an old snapshot — so the log kept being
   * appended to and never reclaimed. A 10 MB database ended up with a log
   * 460 times its size, which is also why a plain `cp chat.db` to a server
   * loses data: everything recent is in the log, not the database.
   *
   * Restating the threshold here is deliberate. It documents the intent, and it
   * pairs with the TRUNCATE checkpoint on shutdown below, which is what
   * actually returns the space. */
  database.pragma("wal_autocheckpoint = 1000");

  migrate(database);
  return database;
}

/**
 * Reuse the cached handle, but re-run the migration on it first.
 *
 * A hot reload that swaps in a *newer* version of this file would otherwise
 * keep a connection opened by the older one, whose schema predates any columns
 * added since — and every prepared statement below would fail on a missing
 * column. `migrate` is idempotent, so running it on the cached handle costs
 * nothing and removes the need to restart the dev server after a schema change.
 */
function resolveDatabase(): Database.Database {
  const cached = globalThis.__omnirouteDb;
  if (cached) {
    try {
      migrate(cached);
      return cached;
    } catch {
      /* Handle is unusable (closed, or the file moved). Drop it before opening
       * a replacement — otherwise the old one leaks for the life of the dev
       * server, holding a WAL lock nothing will ever release. */
      try {
        cached.close();
      } catch {
        /* Already closed. */
      }
      globalThis.__omnirouteDb = undefined;
    }
  }
  return openDatabase();
}

const db: Database.Database = resolveDatabase();

/* Only cache in dev. In production the module is evaluated once anyway, and
 * holding the handle on globalThis would keep it alive across a hot swap. */
if (process.env.NODE_ENV !== "production") {
  globalThis.__omnirouteDb = db;
}

/* -------------------------------------------------------------------------
 * Durability on shutdown
 * ---------------------------------------------------------------------- */

/**
 * Fold the write-ahead log back into the database file and shrink it.
 *
 * TRUNCATE rather than PASSIVE: PASSIVE copies what it can and leaves the file
 * at its current size, which is fine for routine housekeeping and useless for
 * the two cases this function exists for.
 *
 *   BEFORE A BACKUP. `chat.db` on its own is not a complete copy while a log
 *   exists beside it. Copying only that file — which is what `docker cp`, `scp`
 *   and a naive rsync all do — silently produces a database missing every
 *   recent conversation. Checkpointing first is what makes the copy whole.
 *
 *   BEFORE THE PROCESS EXITS. See the signal handler below.
 *
 * Returns the outcome rather than throwing. A failed checkpoint is not a reason
 * to fail the request that asked for it, and during shutdown there is nobody
 * left to catch an exception.
 */
export function checkpointWal(): { ok: boolean; error?: string } {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

declare global {
  /* eslint-disable-next-line no-var */
  var __omnirouteDbShutdownHooked: boolean | undefined;
}

/**
 * Checkpoint and close when the container is asked to stop.
 *
 * WHAT GOES WRONG WITHOUT THIS
 *
 * `docker compose down` sends SIGTERM and then, ten seconds later, SIGKILL.
 * SIGKILL cannot be handled, so the process disappears with its log unmerged.
 * SQLite is crash-safe and will recover the log on the next start, so this is
 * not corruption — but recovery only happens if the log is still there, and the
 * two operations people actually perform after stopping a container are
 * "copy chat.db somewhere" and "rebuild the image", both of which routinely
 * leave `chat.db-wal` behind. That is where the data loss comes from: not from
 * the kill, but from a copy taken afterwards that omits the log.
 *
 * WHY THESE HANDLERS DO NOT EXIT
 *
 * Next's standalone server installs its own SIGTERM handler to stop accepting
 * connections and drain in-flight requests. `process.on` appends rather than
 * replaces, so both run; calling `process.exit()` here would cut that drain
 * short and abort whatever turns were streaming. better-sqlite3 is fully
 * synchronous, so the checkpoint has completed by the time this handler
 * returns, and Next is then free to finish shutting down on its own schedule.
 *
 * `once` per signal, plus a global flag, because this module is re-evaluated on
 * every hot reload in development and a listener per reload would eventually
 * trip Node's MaxListenersExceededWarning.
 *
 * WHY THE HANDLE IS CLOSED IN `exit` AND NOT HERE
 *
 * Closing it in the signal handler looked tidier and was wrong: Next is still
 * draining at that point, so a turn that was mid-stream would find its
 * connection shut and fail with SQLITE_MISUSE — turning a clean shutdown into
 * a lost reply. The checkpoint is the part that has to happen while the process
 * is alive; the close is only about releasing the lock and the -shm file, and
 * `exit` is the one moment when nothing can still be running.
 */
if (
  process.env.NEXT_RUNTIME !== "edge" &&
  !globalThis.__omnirouteDbShutdownHooked
) {
  globalThis.__omnirouteDbShutdownHooked = true;

  const flush = (signal: string) => {
    const result = checkpointWal();
    if (result.ok) {
      console.log(`[db] ${signal}: write-ahead log checkpointed into ${DB_PATH}`);
    } else {
      console.warn(`[db] ${signal}: checkpoint failed — ${result.error}`);
    }
  };

  process.once("SIGTERM", () => flush("SIGTERM"));
  process.once("SIGINT", () => flush("SIGINT"));

  process.once("exit", () => {
    try {
      /* Closing runs a final checkpoint of its own and releases the lock, so a
       * replacement container starting while this one is still exiting does not
       * meet a stale -shm file. */
      db.close();
    } catch {
      /* Already closed, or the process is exiting from an uncaught error with a
       * statement still on the stack. The checkpoint above is what mattered. */
    }
  });
}

/**
 * Cheap liveness probe for the container healthcheck.
 *
 * A health endpoint that only returns 200 proves the HTTP server is accepting
 * connections — it stays green while the database is unreadable, which is the
 * failure that actually matters here: every sign-in, chat and payment reads and
 * writes this file.
 *
 * WHY IT READS A REAL TABLE
 *
 * The obvious probe, `SELECT 1`, is answered entirely inside SQLite's virtual
 * machine: it never opens a page, never touches the filesystem, and therefore
 * proves nothing beyond "the handle object still exists". Reading a row from a
 * table the schema guarantees is present forces an actual page read, so a file
 * that has been deleted, unmounted or corrupted underneath a live process is
 * detected instead of reported healthy.
 *
 * `PRAGMA quick_check` would be stronger still, but it reads the whole
 * database, and this runs every 30 seconds. Counting a tiny settings table is
 * a single page read and enough to distinguish the failure that matters.
 */
export function databaseHealthy(): { ok: boolean; error?: string } {
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM app_settings")
      .get() as { n?: number } | undefined;
    return typeof row?.n === "number"
      ? { ok: true }
      : { ok: false, error: "unexpected probe result" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Absolute path of the SQLite file in use, for diagnostics. */
export function databasePath(): string {
  return DB_PATH;
}

/* -------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------- */

export interface ChatRecord {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  model?: string | null;
  mode?: string | null;
  /** Messages removed from this chat by the retention cap. 0 on most rows. */
  trimmed_messages?: number | null;
}

/** What the sidebar needs: the chat plus enough to render a useful row. */
export interface ChatSummary extends ChatRecord {
  message_count: number;
  preview: string | null;
}

export interface MessageRecord {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  created_at: string;
  metadata: string | null;
}

/* -------------------------------------------------------------------------
 * Titles
 * ---------------------------------------------------------------------- */

/**
 * Turn the first user message into a sidebar title.
 *
 * Strips fenced code, inline markdown punctuation and collapses whitespace, so
 * a message that opens with a code block does not produce a title of "```ts".
 */
export function deriveTitle(text: string): string {
  const cleaned = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "New Conversation";
  return cleaned.length > 60 ? `${cleaned.slice(0, 57).trimEnd()}…` : cleaned;
}

/* -------------------------------------------------------------------------
 * Chats
 *
 * Every read and write below is scoped to an owner. The previous version had no
 * owner at all: `getChats()` returned the entire table and `deleteChat(id)`
 * deleted anyone's row, which is invisible on a single-user localhost install
 * and catastrophic the moment a second person signs in.
 *
 * Rows created before the `user_id` column existed hold NULL. Those are shown
 * to a signed-in user only outside production — locally there is exactly one
 * person and hiding their own history would look like data loss, whereas on a
 * deployment an unowned row must never be handed to whoever asks first.
 * ---------------------------------------------------------------------- */

/** Whether NULL-owned legacy chats are visible to a signed-in user. */
function legacyChatsVisible(): boolean {
  return process.env.NODE_ENV !== "production";
}

const CHAT_COLUMNS = `
    c.id,
    c.title,
    c.created_at,
    c.updated_at,
    c.model,
    c.mode,
    c.trimmed_messages,
    (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count,
    (SELECT m.content FROM messages m WHERE m.chat_id = c.id
       ORDER BY m.rowid DESC LIMIT 1) AS preview`;

/* Two statements rather than one with an interpolated clause: the predicate is
 * a security boundary, so it is fixed at prepare time and never assembled from
 * anything that could vary per request. */
const selectChatsOwnedStmt = db.prepare(`
  SELECT ${CHAT_COLUMNS}
  FROM chats c
  WHERE c.user_id = ?
  ORDER BY c.updated_at DESC, c.rowid DESC
`);

const selectChatsOwnedOrLegacyStmt = db.prepare(`
  SELECT ${CHAT_COLUMNS}
  FROM chats c
  WHERE c.user_id = ? OR c.user_id IS NULL
  ORDER BY c.updated_at DESC, c.rowid DESC
`);

export function getChats(userId: string): ChatSummary[] {
  const stmt = legacyChatsVisible()
    ? selectChatsOwnedOrLegacyStmt
    : selectChatsOwnedStmt;

  const rows = stmt.all(userId) as ChatSummary[];
  return rows.map((row) => ({
    ...row,
    preview: row.preview
      ? row.preview.replace(/\s+/g, " ").trim().slice(0, 140)
      : null,
  }));
}

const selectChatByIdStmt = db.prepare("SELECT * FROM chats WHERE id = ?");

/**
 * Fetch a chat without any ownership test.
 *
 * Internal helper. Route handlers must use `getChatForUser`; this exists for
 * the write paths that have already established ownership.
 */
export function getChatById(id: string): ChatRecord | undefined {
  return selectChatByIdStmt.get(id) as ChatRecord | undefined;
}

/**
 * True when `userId` may read or modify `chatId`.
 *
 * A chat that does not exist returns false rather than throwing, so a caller
 * cannot distinguish "not yours" from "not there" — that difference would let
 * anyone enumerate which chat ids exist.
 */
export function userOwnsChat(chatId: string, userId: string): boolean {
  const row = db
    .prepare("SELECT user_id FROM chats WHERE id = ?")
    .get(chatId) as { user_id: string | null } | undefined;

  if (!row) return false;
  if (row.user_id === userId) return true;
  return row.user_id === null && legacyChatsVisible();
}

/** Ownership-checked read. Returns undefined when the chat is not the user's. */
export function getChatForUser(
  id: string,
  userId: string,
): ChatRecord | undefined {
  if (!userOwnsChat(id, userId)) return undefined;
  return getChatById(id);
}

const insertChatStmt = db.prepare(
  "INSERT INTO chats (id, title, user_id) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
);

/**
 * Create the chat if it does not exist, and return it either way.
 *
 * Safe to call on every turn — that is the point. The original `createChat`
 * threw on the second call, which is why nothing ever persisted once the
 * client did start sending an id.
 *
 * Insert and read run in one transaction so the return value cannot be
 * `undefined`: without it, a concurrent `deleteChat` (or a prune) landing
 * between the two statements would return nothing where the signature promises
 * a record, and the route would serialise `{}` to the client.
 *
 * A legacy row with NULL user_id is adopted by the first signed-in user who
 * writes to it, so history created before ownership existed stops being
 * ownerless as soon as it is touched.
 */
export const ensureChat = db.transaction(
  (id: string, title: string | undefined, userId: string): ChatRecord => {
    insertChatStmt.run(id, title?.trim() || "New Conversation", userId);

    db.prepare(
      "UPDATE chats SET user_id = ? WHERE id = ? AND user_id IS NULL",
    ).run(userId, id);

    const row = getChatById(id);
    if (row) return row;

    /* Only reachable if the row vanished inside the transaction, which SQLite's
     * write lock makes impossible. Return a well-formed record rather than
     * throwing into the middle of a turn. */
    const now = new Date().toISOString();
    return {
      id,
      title: title?.trim() || "New Conversation",
      created_at: now,
      updated_at: now,
    };
  },
) as (id: string, title: string | undefined, userId: string) => ChatRecord;

/** Kept for source compatibility with the previous export surface. */
export function createChat(
  id: string,
  title: string,
  userId: string,
): ChatRecord {
  return ensureChat(id, title, userId);
}

export function renameChat(
  id: string,
  title: string,
  userId: string,
): ChatRecord | undefined {
  if (!userOwnsChat(id, userId)) return undefined;

  const next = title.trim();
  if (!next) return getChatById(id);

  db.prepare(
    "UPDATE chats SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(next, id);
  return getChatById(id);
}

/**
 * Set the title only if the chat is still using the placeholder, so a title
 * the user chose is never overwritten by a later auto-derived one.
 */
export function titleChatIfUnset(id: string, title: string): void {
  const next = title.trim();
  if (!next) return;
  db.prepare(
    `UPDATE chats SET title = ?
       WHERE id = ? AND (title IS NULL OR title = '' OR title = 'New Conversation')`,
  ).run(next, id);
}

const touchChatStmt = db.prepare(
  "UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
);

export function updateChatTimestamp(id: string): void {
  touchChatStmt.run(id);
}

export function setChatContext(
  id: string,
  model?: string | null,
  mode?: string | null,
): void {
  db.prepare(
    `UPDATE chats
        SET model = COALESCE(?, model),
            mode  = COALESCE(?, mode)
      WHERE id = ?`,
  ).run(model ?? null, mode ?? null, id);
}

/**
 * Delete a chat and its messages.
 *
 * Returns false when the chat is not the caller's, so the route can answer 404
 * instead of reporting a successful delete that never happened.
 */
export function deleteChat(id: string, userId: string): boolean {
  if (!userOwnsChat(id, userId)) return false;

  const run = db.transaction((chatId: string) => {
    /* Explicit, not relying on the cascade: correct even if the pragma above
     * failed on this connection, and it makes the intent obvious. */
    db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
    db.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
  });
  run(id);
  return true;
}

/**
 * Drop chats that have no messages *and* are older than a grace period.
 *
 * The grace period is not decoration. `POST /api/chats` deliberately creates an
 * empty chat — the client asks for a row up front and fills it on the first
 * turn — so an unconditional "delete every empty chat" would have the sidebar's
 * own GET delete the row its POST had just created, one request earlier. An
 * hour is far longer than that gap and far shorter than any chat you would miss.
 *
 * What this is actually for: the rows left behind by the build that never
 * persisted messages. Those are days old and will go on the first load.
 */
const PRUNE_GRACE = "-1 hour";

const pruneEmptyChatsStmt = db.prepare(
  `DELETE FROM chats
    WHERE id NOT IN (SELECT DISTINCT chat_id FROM messages)
      AND COALESCE(updated_at, created_at) < datetime('now', ?)`,
);

export function pruneEmptyChats(): number {
  return pruneEmptyChatsStmt.run(PRUNE_GRACE).changes;
}

/* -------------------------------------------------------------------------
 * Retention
 *
 * WHY THIS EXISTS
 *
 * SQLite never gives space back on its own. The working copy of this database
 * is 10 MB of rows behind a 4.6 GB write-ahead log, and on a 20 GB EBS volume
 * shared with the OS, Docker images and backups, unbounded history is a server
 * that stops being able to write — including its own database — some weeks after
 * launch. That failure arrives as 500s from every endpoint at once, with the
 * cause several layers away from the symptom.
 *
 * WHAT THIS IS NOT
 *
 * It is not summarisation. Condensing a dropped transcript into a paragraph
 * means an LLM call at prune time: inside a write path, spending the operator's
 * quota, able to fail or hang, and unable to be rolled back once the originals
 * are gone. What happens instead is deterministic and inspectable — the opening
 * of the conversation is kept, the most recent turns are kept, the middle is
 * removed, and the number removed is recorded on the chat so the UI can say so.
 * If real summarisation is wanted later it belongs on its own path, running
 * *before* this one, writing its output as a message.
 *
 * BOTH LIMITS DEFAULT TO OFF
 *
 * Deleting someone's history is not a thing to start doing because they pulled
 * a new build. Set the two variables below to switch it on.
 *
 *   OMNIROUTE_MAX_CHATS_PER_USER     keep the N most recently updated chats per
 *                                    account, delete the rest. 0 or unset =
 *                                    unlimited.
 *   OMNIROUTE_MAX_MESSAGES_PER_CHAT  keep at most N messages in one chat. 0 or
 *                                    unset = unlimited. Values below 4 are
 *                                    raised to 4, because the head plus one
 *                                    exchange is the smallest transcript that
 *                                    still reads as a conversation.
 * ---------------------------------------------------------------------- */

function positiveIntEnv(name: string, minimum = 1): number {
  const raw = Number.parseInt((process.env[name] ?? "").trim(), 10);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.max(minimum, raw);
}

/** How many chats one account may keep. 0 means unlimited. */
export function maxChatsPerUser(): number {
  return positiveIntEnv("OMNIROUTE_MAX_CHATS_PER_USER");
}

/** How many messages one chat may keep. 0 means unlimited. */
export function maxMessagesPerChat(): number {
  return positiveIntEnv("OMNIROUTE_MAX_MESSAGES_PER_CHAT", 4);
}

/**
 * Delete the account's least recently updated chats beyond the cap.
 *
 * Ordered by `updated_at` and not `created_at`: a long-running conversation
 * someone keeps returning to is the one they care about, and creation order
 * would throw it away in favour of three chats they opened and abandoned.
 *
 * The messages are deleted explicitly in the same transaction rather than left
 * to ON DELETE CASCADE, for the reason given at the top of this file — the
 * cascade is silently inert on a connection where the pragma did not take, and
 * a retention pass that removed chat rows while leaving their messages behind
 * would reclaim almost nothing while looking like it worked.
 */
const enforceChatLimit = db.transaction((userId: string, keep: number): number => {
  const doomed = db
    .prepare(
      `SELECT id FROM chats
        WHERE user_id = ?
        ORDER BY COALESCE(updated_at, created_at) DESC, rowid DESC
        LIMIT -1 OFFSET ?`,
    )
    .all(userId, keep) as { id: string }[];

  if (doomed.length === 0) return 0;

  const deleteMessages = db.prepare("DELETE FROM messages WHERE chat_id = ?");
  const deleteChat = db.prepare("DELETE FROM chats WHERE id = ?");
  for (const row of doomed) {
    deleteMessages.run(row.id);
    deleteChat.run(row.id);
  }
  return doomed.length;
}) as (userId: string, keep: number) => number;

/**
 * Trim one chat down to the cap, keeping the beginning and the end.
 *
 * HOW THE KEEP SET IS CHOSEN
 *
 * The first two rows are kept unconditionally: the opening question and its
 * answer are what make the chat recognisable in the sidebar and what the title
 * was derived from. Everything else kept is taken from the most recent end,
 * because that is the part still being talked about. The removed span is
 * therefore always contiguous and always in the middle, which is the only shape
 * that leaves a readable transcript.
 *
 * `rowid` is the ordering key throughout, for the same reason `getMessages`
 * uses it: `created_at` has one-second resolution and cannot separate a user
 * message from the reply written in the same second.
 */
const trimChatMessages = db.transaction((chatId: string, keep: number): number => {
  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?").get(chatId) as {
      n: number;
    }
  ).n;
  if (total <= keep) return 0;

  const headCount = Math.min(2, keep - 1);
  const tailCount = keep - headCount;

  const removed = db
    .prepare(
      `DELETE FROM messages
        WHERE chat_id = @chatId
          AND rowid NOT IN (
            SELECT rowid FROM messages WHERE chat_id = @chatId
             ORDER BY rowid ASC LIMIT @headCount
          )
          AND rowid NOT IN (
            SELECT rowid FROM messages WHERE chat_id = @chatId
             ORDER BY rowid DESC LIMIT @tailCount
          )`,
    )
    .run({ chatId, headCount, tailCount }).changes;

  if (removed > 0) {
    db.prepare(
      "UPDATE chats SET trimmed_messages = COALESCE(trimmed_messages, 0) + ? WHERE id = ?",
    ).run(removed, chatId);
  }
  return removed;
}) as (chatId: string, keep: number) => number;

/**
 * Apply both caps for one account. Cheap and safe to call on every turn: with
 * neither variable set it does nothing at all and never touches the database.
 *
 * Never throws. Retention is housekeeping — a chat turn must not fail because a
 * cleanup query did.
 */
export function enforceRetention(
  userId: string,
  chatId?: string,
): { chatsDeleted: number; messagesTrimmed: number } {
  const chatCap = maxChatsPerUser();
  const messageCap = maxMessagesPerChat();
  if (chatCap === 0 && messageCap === 0) {
    return { chatsDeleted: 0, messagesTrimmed: 0 };
  }

  let chatsDeleted = 0;
  let messagesTrimmed = 0;

  try {
    if (chatCap > 0) chatsDeleted = enforceChatLimit(userId, chatCap);
  } catch (error) {
    console.warn(
      "[db] chat retention pass failed:",
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    /* Only the chat just written to. Sweeping every chat on every turn would
     * scan the whole table for a result that cannot have changed. */
    if (messageCap > 0 && chatId) {
      messagesTrimmed = trimChatMessages(chatId, messageCap);
    }
  } catch (error) {
    console.warn(
      "[db] message retention pass failed:",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (chatsDeleted > 0 || messagesTrimmed > 0) {
    console.log(
      `[db] retention: removed ${chatsDeleted} chat(s) and ${messagesTrimmed} message(s) for user ${userId}`,
    );
  }

  return { chatsDeleted, messagesTrimmed };
}

/* -------------------------------------------------------------------------
 * Messages
 * ---------------------------------------------------------------------- */

/**
 * All messages in a chat.
 *
 * Unscoped by design — every caller reaches it through a route that has already
 * proved ownership. `getMessagesForUser` is the checked form and is what route
 * handlers should use.
 */
export function getMessages(chatId: string): MessageRecord[] {
  return db
    .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY rowid ASC")
    .all(chatId) as MessageRecord[];
}

/** Ownership-checked read. Returns null when the chat is not the user's. */
export function getMessagesForUser(
  chatId: string,
  userId: string,
): MessageRecord[] | null {
  if (!userOwnsChat(chatId, userId)) return null;
  return getMessages(chatId);
}

export function countMessages(chatId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?")
    .get(chatId) as { n: number };
  return row.n;
}

const upsertMessageStmt = db.prepare(`
  INSERT INTO messages (id, chat_id, role, content, metadata)
  VALUES (@id, @chatId, @role, @content, @metadata)
  ON CONFLICT(id) DO UPDATE SET
    content  = excluded.content,
    metadata = excluded.metadata
`);

export function saveMessage(
  id: string,
  chatId: string,
  role: string,
  content: string,
  metadata?: unknown,
): void {
  upsertMessageStmt.run({
    id,
    chatId,
    role,
    content,
    metadata: metadata == null ? null : JSON.stringify(metadata),
  });
  updateChatTimestamp(chatId);
}

/**
 * Write the user half of a turn, creating the chat in the same transaction.
 *
 * Atomicity matters for one specific reason: it removes any moment where a
 * chat row exists with no messages, which is what lets `pruneEmptyChats` be
 * unconditionally safe.
 */
export const saveUserTurn = db.transaction(
  (args: {
    chatId: string;
    messageId: string;
    content: string;
    metadata?: unknown;
    model?: string | null;
    mode?: string | null;
    userId: string;
  }) => {
    ensureChat(args.chatId, undefined, args.userId);
    titleChatIfUnset(args.chatId, deriveTitle(args.content));
    setChatContext(args.chatId, args.model ?? null, args.mode ?? null);
    saveMessage(
      args.messageId,
      args.chatId,
      "user",
      args.content,
      args.metadata,
    );
  },
);

/** Parse a stored metadata blob without ever throwing on bad JSON. */
export function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Get database instance for use in other modules
 */
export async function getDb(): Promise<Database.Database> {
  return db;
}

export default db;
