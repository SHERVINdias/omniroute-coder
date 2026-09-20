/**
 * src/app/api/skills/[id]/route.ts
 * ---------------------------------------------------------------------------
 * PATCH  — edit a skill, or switch it on and off.
 * DELETE — remove one.
 *
 * THE ID IN THE URL IS NOT AUTHORISATION
 *
 * Skill ids are UUIDs, which makes them hard to guess but does not make them
 * secret — they appear in this URL, in the panel's markup, and in anything a
 * user copies out of their browser. So the owner is passed into every store
 * call and appears in the WHERE clause, and a request for somebody else's skill
 * finds nothing and gets a 404 rather than a 403. A 403 would confirm the id
 * exists, which is a small thing to leak but a free one not to.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/authGuard";
import { rateLimit, formatRetryAfter } from "@/lib/rateLimit";
import { validateSkill, type SkillTrigger } from "@/lib/skills/skillManifest";
import { getSkill, updateSkill, deleteSkill } from "@/lib/skills/skillStore";
import { readJsonBody } from "@/lib/skills/readJsonBody";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Editing cannot grow the table — the per-user cap already bounds that — but it
 * can be looped, and each iteration is a write of up to 20 KB. Sixty a minute is
 * far above what a person toggling switches and saving edits will ever reach,
 * and far below what would make the database work hard.
 */
const EDIT_LIMIT = { limit: 60, windowMs: 60_000 } as const;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;

  const gate = rateLimit(`skill-edit:${auth.user.id}`, EDIT_LIMIT);
  if (!gate.ok) {
    return NextResponse.json(
      { error: `Too many changes at once. Try again in ${formatRetryAfter(gate.retryAfterMs)}.` },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  const { id } = await params;
  const existing = getSkill(auth.user.id, id);
  if (!existing) {
    return NextResponse.json({ error: "That skill does not exist." }, { status: 404 });
  }

  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) {
    return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
  }
  const body = parsedBody.body;

  /* A bare enable/disable toggle is the common case and does not need the
   * whole skill re-validated — there is nothing in a boolean to validate, and
   * requiring the panel to round-trip 20 KB of instructions to flip a switch
   * would be a good way to lose someone's edits to a race. */
  if (
    typeof body.enabled === "boolean" &&
    Object.keys(body).length === 1
  ) {
    const result = updateSkill(auth.user.id, id, { enabled: body.enabled });
    return result.ok
      ? NextResponse.json({ skill: result.skill })
      : NextResponse.json({ error: result.error }, { status: 400 });
  }

  /* Any content change goes through the same validator an upload does. The
   * merge is against the stored row, so a partial edit cannot bypass a check by
   * omitting the field it would have failed on. */
  const merged = {
    slug: existing.slug,
    name: typeof body.name === "string" ? body.name : existing.name,
    description:
      typeof body.description === "string" ? body.description : existing.description,
    instructions:
      typeof body.instructions === "string" ? body.instructions : existing.instructions,
    allowedTools: Array.isArray(body.allowedTools)
      ? body.allowedTools
      : existing.allowedTools,
    triggerMode:
      typeof body.triggerMode === "string" ? body.triggerMode : existing.triggerMode,
    triggers: Array.isArray(body.triggers) ? body.triggers : existing.triggers,
  };

  const checked = validateSkill(merged);
  if (!checked.ok) {
    return NextResponse.json(
      { error: "Those changes are not valid.", errors: checked.errors },
      { status: 422 },
    );
  }

  const result = updateSkill(auth.user.id, id, {
    name: checked.skill.name,
    description: checked.skill.description,
    instructions: checked.skill.instructions,
    allowedTools: checked.skill.allowedTools,
    triggerMode: checked.skill.triggerMode as SkillTrigger,
    triggers: checked.skill.triggers,
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
  });

  return result.ok
    ? NextResponse.json({ skill: result.skill, warnings: checked.warnings })
    : NextResponse.json({ error: result.error }, { status: 400 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const removed = deleteSkill(auth.user.id, id);

  return removed
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "That skill does not exist." }, { status: 404 });
}
