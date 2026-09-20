/**
 * src/app/api/settings/file-exclusions/route.ts
 * ---------------------------------------------------------------------------
 * GET — this user's exclusion rules, plus everything the panel needs to render
 *       itself: the recommended groups, the always-on list, and the limits.
 * PUT — replace the rules.
 *
 * WHY THE BUILT-IN LISTS ARE SENT TO THE CLIENT
 *
 * The panel has to show the user what is already blocked, otherwise "complete
 * control over what the model reads" means a text box and a promise. Sending
 * ALWAYS_PATTERNS and the recommended groups from the server — rather than
 * importing them into the bundle — keeps one source of truth: if a pattern is
 * added to the engine and the panel is not redeployed, the panel still shows
 * the real list.
 *
 * WHY PUT REPLACES RATHER THAN PATCHES
 *
 * Order is load-bearing: "!" negations are last-match-wins, so a rule's
 * meaning depends on what sits above it. A PATCH that appends or removes one
 * entry would silently change what the other entries do. The panel owns the
 * whole ordered list and sends it back intact.
 *
 * WHAT THIS ROUTE CANNOT DO
 *
 * It cannot weaken the floor. `sanitizeConfig` drops nothing from
 * ALWAYS_PATTERNS, there is no field here that disables them, and a "!" rule
 * aimed at one is accepted, stored, and then ignored by the engine — see the
 * ordering in ExclusionMatcher.decide. A client that sends
 * `{"disabledGroups":["always"]}` gets it filtered out by the group allowlist.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/authGuard";
import { rateLimit, formatRetryAfter } from "@/lib/rateLimit";
import { readJsonBody } from "@/lib/skills/readJsonBody";
import {
  ALWAYS_PATTERNS,
  ALWAYS_EXCEPTIONS,
  RECOMMENDED_GROUPS,
  MAX_USER_PATTERNS,
  MAX_PATTERN_LENGTH,
} from "@/lib/fileExclusions";
import {
  getExclusionConfig,
  saveExclusionConfig,
} from "@/lib/fileExclusionStore";
import { vscodeBridge } from "@/lib/vscodeBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A save is one small upsert. The cap is here so a stuck client cannot spin. */
const SAVE_LIMIT = { limit: 30, windowMs: 60_000 } as const;

/** Rules are short. 64 KB is a generous pasted .gitignore. */
const MAX_BODY = 64 * 1024;

export async function GET(req: NextRequest) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;

  return NextResponse.json({
    config: getExclusionConfig(auth.user.id),
    groups: RECOMMENDED_GROUPS,
    alwaysPatterns: ALWAYS_PATTERNS,
    alwaysExceptions: ALWAYS_EXCEPTIONS,
    limits: {
      maxPatterns: MAX_USER_PATTERNS,
      maxPatternLength: MAX_PATTERN_LENGTH,
    },
  });
}

export async function PUT(req: NextRequest) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;

  const gate = rateLimit(`file-exclusions:${auth.user.id}`, SAVE_LIMIT);
  if (!gate.ok) {
    return NextResponse.json(
      {
        error: `Too many saves at once. Try again in ${formatRetryAfter(
          gate.retryAfterMs,
        )}.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  const parsed = await readJsonBody(req, MAX_BODY);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }

  const result = saveExclusionConfig(auth.user.id, parsed.body);

  /* Push the new rules straight to a connected editor.
   *
   * Without this the extension keeps enforcing whatever it was handed when the
   * socket opened, so a user who adds an exclusion and immediately asks a
   * question would see the old rules in force at the one layer that actually
   * holds the file handle — and would reasonably conclude the setting does
   * nothing. Awaited so the panel's reply can say whether the editor is in
   * step; it resolves false when nothing is connected, which is ordinary.
   *
   * It cannot weaken anything on the way: a push that fails leaves the
   * extension on its built-in defaults, which are stricter than any saved
   * config, never looser. */
  let editorSynced = false;
  try {
    editorSynced = await vscodeBridge.refreshExclusions(auth.user.id);
  } catch {
    /* Already swallowed and logged inside the bridge; a save must not fail
     * because an editor went away mid-request. */
  }

  /* 200 even when some patterns were dropped. The save succeeded for
   * everything valid, and the complaints are per-pattern — a 400 would tell
   * the panel to discard a result it is about to render. */
  return NextResponse.json({
    config: result.config,
    rejected: result.errors,
    editorSynced,
  });
}
