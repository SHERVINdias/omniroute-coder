/**
 * src/app/api/chat/generate-document/route.ts
 * ---------------------------------------------------------------------------
 * The endpoint page.tsx has been calling all along.
 *
 * `triggerServerPdfCompile` in page.tsx POSTs { content, title } here and reads
 * back { success, pdfUrl, fileName, title }. That route did not exist, so every
 * call 404'd, `res.json()` threw, and the catch quietly fell back to
 * `exportResponseToPDF` — the window.print() popup. That fallback is why the
 * output looked like a printed web page instead of a document.
 *
 * The response shape below is exactly what page.tsx already expects, so PDF
 * export starts working with no client change at all.
 *
 * POST  { content, title?, format? }  -> { success, pdfUrl, fileName, ... }
 * GET   ?file=<name>                  -> the stored binary
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { renderPdf } from "@/lib/documentRender";
import { requireUser } from "@/lib/authGuard";
import { rateLimit, formatRetryAfter } from "@/lib/rateLimit";
import { stateRoot } from "@/lib/stateRoot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A session stops an anonymous caller filling the volume; it does not stop a
 * signed-in one. Each render is CPU work plus a file on disk, and the sweep
 * below only deletes files older than a week — so a loop can still outrun the
 * cleanup. 20/minute is more documents than anyone generates by hand.
 */
const RENDER_LIMIT = { limit: 20, windowMs: 60_000 } as const;

/** Rendered files live outside `public/` so nothing is served by accident, and
 *  under the writable state root so a packaged desktop app writes somewhere it
 *  is actually allowed to (see stateRoot). OMNIROUTE_STATE_DIR is exported by
 *  the desktop main process before the server spawns, so it is populated by the
 *  time this module evaluates. */
const OUTPUT_DIR = path.join(stateRoot(), "generated-documents");

/** Delete rendered files older than this on each new render. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/* -------------------------------------------------------------------------
 * Naming and path safety
 * ---------------------------------------------------------------------- */

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48)
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return slug || "document";
}

/**
 * A short, stable label for one account, used as the filename prefix.
 *
 * WHY THE FILENAME CARRIES AN OWNER AT ALL
 *
 * Every rendered document lands in one shared directory and GET serves
 * anything in it to any signed-in caller. The name used to be
 * `<title-slug>-<Date.now() in base36>`, which is not a secret: the slug comes
 * straight from a title the user picked (often something like "project-plan")
 * and the suffix is a timestamp. One account could read another's rendered
 * documents by guessing. The prefix makes ownership a property of the name, so
 * GET can check it without a database lookup, and the random tail below makes
 * the name unguessable even for the right owner's own files.
 *
 * Not a secret and not meant to be — it is an equality check, not a password.
 * Truncated to 16 hex characters because it only has to distinguish accounts.
 *
 * KEYED, because an unkeyed hash of the user id is only unguessable if the user
 * id is. A bare `sha256(userId)` moves the secrecy requirement onto a value the
 * app treats as an identifier rather than as a credential — fine while ids are
 * random, silently broken the day someone keys accounts by email or by a
 * sequential integer, because then anyone can compute another account's prefix
 * offline. HMAC-ing it under the server secret means the tag cannot be derived
 * without the server, whatever user ids turn out to be.
 *
 * Falls back to a plain hash when no secret is configured, rather than to a
 * per-process random: a random key would invalidate every document already on
 * disk at each restart. That fallback only happens with AUTH_SECRET unset,
 * which `productionGuard.ts` already refuses to let a production boot get away
 * with.
 */
function ownerTag(userId: string): string {
  const secret = (
    process.env.AUTH_SECRET ||
    process.env.CREDENTIALS_SECRET ||
    ""
  ).trim();
  const digest = secret
    ? crypto.createHmac("sha256", secret).update(userId).digest("hex")
    : crypto.createHash("sha256").update(userId).digest("hex");
  return digest.slice(0, 16);
}

/**
 * The only thing standing between `?file=` and the rest of the disk.
 *
 * Whitelist the character set, take the basename, and require the result to be
 * byte-identical to the input — so `..%2Fetc%2Fpasswd`, a nested path or an
 * absolute path are all rejected outright rather than normalised into
 * something that happens to resolve.
 */
function safeFileName(raw: string): string | null {
  const candidate = raw.trim();
  if (!candidate || candidate.length > 200) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(candidate)) return null;
  if (path.basename(candidate) !== candidate) return null;

  const ext = path.extname(candidate).slice(1).toLowerCase();
  if (!CONTENT_TYPES[ext]) return null;

  return candidate;
}

async function pruneOldDocuments(): Promise<void> {
  try {
    const entries = await fs.readdir(OUTPUT_DIR);
    const cutoff = Date.now() - MAX_AGE_MS;
    await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(OUTPUT_DIR, entry);
        try {
          const stat = await fs.stat(full);
          if (stat.isFile() && stat.mtimeMs < cutoff) await fs.unlink(full);
        } catch {
          /* Raced with another prune; nothing to do. */
        }
      }),
    );
  } catch {
    /* Directory does not exist yet. */
  }
}

/** Fall back to the first meaningful line of the content when no title is given. */
function resolveTitle(rawTitle: unknown, content: string): string {
  const provided = typeof rawTitle === "string" ? rawTitle.trim() : "";
  if (provided) return provided.slice(0, 120);

  const firstLine = content
    .split("\n")
    .map((line) => line.replace(/^[#>\s*-]+/, "").trim())
    .find((line) => line.length > 0);

  return (firstLine || "Document").slice(0, 120);
}

/* -------------------------------------------------------------------------
 * POST — render
 * ---------------------------------------------------------------------- */

export async function POST(req: NextRequest) {
  /* Rendering writes a file to disk on every call, so an anonymous caller could
   * fill the volume. A session is required — the owner is unaffected. */
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;

  const gate = rateLimit(`generate-document:${auth.user.id}`, RENDER_LIMIT);
  if (!gate.ok) {
    return NextResponse.json(
      {
        success: false,
        error: `Too many documents at once. Try again in ${formatRetryAfter(
          gate.retryAfterMs,
        )}.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  try {
    const body = await req.json().catch(() => ({}) as Record<string, unknown>);

    const content = typeof body.content === "string" ? body.content : "";
    if (!content.trim()) {
      return NextResponse.json(
        { success: false, error: "No content to render." },
        { status: 400 },
      );
    }

    const requested = String(body.format ?? "pdf").toLowerCase();
    const format = requested === "docx" ? "docx" : "pdf";
    const title = resolveTitle(body.title, content);

    let bytes: Buffer;
    if (format === "docx") {
      /* Loaded on demand so a PDF request never pays to parse the docx package.
       * (It is a hard dependency either way — see the header of docxRender.ts
       * for why "optional at runtime" does not work for a bundled import.) */
      const { renderDocx } = await import("@/lib/docxRender");
      bytes = await renderDocx(content, title);
    } else {
      bytes = await renderPdf(content, title);
    }

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    void pruneOldDocuments();

    /* `<owner>-<slug>-<random>.<ext>`. The owner prefix is what GET checks; the
     * random tail is what stops the name being derived from the title. The old
     * `Date.now().toString(36)` suffix did neither. */
    const nonce = crypto.randomBytes(8).toString("hex");
    const fileName = `${ownerTag(auth.user.id)}-${slugify(title)}-${nonce}.${format}`;
    await fs.writeFile(path.join(OUTPUT_DIR, fileName), bytes);

    const url = `/api/chat/generate-document?file=${encodeURIComponent(fileName)}`;

    return NextResponse.json({
      success: true,
      title,
      format,
      fileName,
      /* page.tsx reads `pdfUrl`; `url` is the format-neutral name for later. */
      pdfUrl: url,
      url,
      bytes: bytes.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[generate-document] render failed:", message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}

/* -------------------------------------------------------------------------
 * GET — serve
 * ---------------------------------------------------------------------- */

export async function GET(req: NextRequest) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;

  try {
    const requested = new URL(req.url).searchParams.get("file") ?? "";
    const fileName = safeFileName(requested);
    if (!fileName) {
      return NextResponse.json(
        { error: "Invalid file name." },
        { status: 400 },
      );
    }

    const full = path.join(OUTPUT_DIR, fileName);

    /* Ownership. Everything rendered by every account shares one directory, so
     * "the file exists" is not authorisation to read it. Answering 404 rather
     * than 403 keeps this from confirming that someone else's document is
     * there.
     *
     * Note for anyone upgrading: documents generated before this check was
     * added have no owner prefix and will 404. They expire within a week
     * anyway, and regenerating is one click. */
    if (!fileName.startsWith(`${ownerTag(auth.user.id)}-`)) {
      return NextResponse.json(
        { error: "That document has expired or was never created." },
        { status: 404 },
      );
    }

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(full);
    } catch {
      return NextResponse.json(
        { error: "That document has expired or was never created." },
        { status: 404 },
      );
    }

    const ext = path.extname(fileName).slice(1).toLowerCase();

    /* PDFs preview in the browser's viewer, which is what you want after
     * clicking "Generate PDF". Word documents have no viewer, so `inline` just
     * produces a tab that immediately downloads anyway — ask for it directly. */
    const disposition = ext === "pdf" ? "inline" : "attachment";

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": CONTENT_TYPES[ext],
        "Content-Length": String(bytes.length),
        "Content-Disposition": `${disposition}; filename="${fileName}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[generate-document] serve failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
