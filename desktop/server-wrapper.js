/**
 * desktop/server-wrapper.js
 * ---------------------------------------------------------------------------
 * The entry point Electron spawns instead of `.next/standalone/server.js`
 * directly. Its whole job is to give Windows a way into the graceful-shutdown
 * path that Linux gets for free.
 *
 * THE BUG THIS EXISTS FOR
 *
 * src/lib/db.ts checkpoints the SQLite write-ahead log on SIGTERM before the
 * process exits. On Linux/Docker that fires. On Windows it never does: Node maps
 * child.kill("SIGTERM") onto TerminateProcess, which is unhandleable and unwinds
 * nothing — so the checkpoint is skipped and the process dies with its WAL
 * unmerged. That is not corruption (SQLite recovers on next start), but the loss
 * comes later, from the auto-updater replacing chat.db without chat.db-wal
 * beside it.
 *
 * THE FIX
 *
 * The parent (main.js) cannot deliver a real SIGTERM on Windows, so instead it
 * writes a line to this process's stdin. We turn that line into an in-process
 * `process.emit("SIGTERM")`, which runs the exact handlers db.ts and Next
 * already registered — no second shutdown path, no app change. A watchdog timer
 * is the only addition, so a wedged server cannot hang the quit forever.
 *
 * WHY STDIN AND NOT AN HTTP ROUTE
 *
 * The server listens on 127.0.0.1, reachable by every process on the machine
 * and by any web page the user has open (CORS blocks reading the response, not
 * sending the request). A POST /api/shutdown would be a one-line denial of
 * service any website could fire. A stdin pipe between parent and child is
 * private by construction and needs no token.
 *
 * ORDERING, VERIFIED
 *
 * next/dist/server/lib/start-server.js registers process.on("SIGTERM", cleanup)
 * whose cleanup drains connections and ends in process.exit(143). db.ts appends
 * its checkpoint to the same event. Node runs listeners synchronously in
 * registration order; Next's cleanup is async and yields at its first await, so
 * better-sqlite3's fully synchronous checkpoint completes before Next reaches
 * its exit. 143 is therefore a CLEAN shutdown, not a crash — main.js treats it
 * as success.
 */

"use strict";

const path = require("path");

const SERVER_ENTRY = process.env.OMNIROUTE_SERVER_ENTRY
  ? path.resolve(process.env.OMNIROUTE_SERVER_ENTRY)
  : path.join(__dirname, "..", ".next", "standalone", "server.js");

/* How long to allow the graceful drain before forcing exit. Long enough for a
 * WAL checkpoint and an in-flight request to finish, short enough that a hung
 * server does not make the app un-quittable. */
const SHUTDOWN_WATCHDOG_MS = 8000;

let shuttingDown = false;

function beginShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  /* Runs the real SIGTERM handlers (db.ts checkpoint + Next drain). */
  process.emit("SIGTERM");

  /* Watchdog only: if the handlers above have not already exited the process,
   * force it. unref() so this timer itself never keeps the process alive. */
  setTimeout(() => process.exit(143), SHUTDOWN_WATCHDOG_MS).unref();
}

/* The parent writes "shutdown\n" here when the window is closing. We read lines
 * rather than assume one chunk == one message. */
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (String(chunk).includes("shutdown")) beginShutdown();
});
/* If the parent dies and closes the pipe, treat that as a shutdown too so we do
 * not leave an orphan holding the port and the database lock. */
process.stdin.on("end", beginShutdown);
process.stdin.on("close", beginShutdown);

/* Boot the real server in this same process. It reads PORT, HOSTNAME, NODE_ENV
 * and the OMNIROUTE_* variables main.js placed in the environment. */
require(SERVER_ENTRY);
