/**
 * src/app/api/skills/route.ts
 * ---------------------------------------------------------------------------
 * GET  — list this user's skills, plus the templates and the tool catalog.
 * POST — add one, from a pasted document or from a template.
 *
 * WHY THE SERVER VALIDATES AGAIN
 *
 * The panel validates before sending, so the user gets an error next to the
 * textarea instead of after a round trip. That is a convenience and nothing
 * more: the request is an ordinary HTTP POST and anything can send one. Every
 * check that matters — the refusal of `code` and `entrypoint`, the tool
 * allowlist, the size caps — runs here, on the parsed body, with the client's
 * opinion discarded. Client-side validation is for the error message; it is
 * never the decision.
 *
 * WHY THE WHOLE DOCUMENT IS PARSED SERVER-SIDE RATHER THAN THE FIELDS SENT
 *
 * The panel could parse the Markdown itself and POST clean JSON fields. Then
 * the frontmatter parser would exist in one place and the validator in another,
 * and the server would be trusting a client-side parse of user text. Sending
 * the raw document means the strict parser and the validator are the same code
 * path for the browser and for curl.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/authGuard";
import { rateLimit, formatRetryAfter } from "@/lib/rateLimit";
import {
  readSkillDocument,
  validateSkill,
  SKILL_LIMITS,
  SKILL_TOOL_CATALOG,
} from "@/lib/skills/skillManifest";
import { SKILL_TEMPLATES, findTemplate } from "@/lib/skills/skillTemplates";
import { createSkill, listSkills, countSkills } from "@/lib/skills/skillStore";
import { readJsonBody } from "@/lib/skills/readJsonBody";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Adding a skill writes a row and costs a validation pass over up to 64 KB of
 * text. Neither is expensive, but a scripted loop would fill the table to the
 * per-user cap and then keep hammering the cap check, so the limit is on the
 * attempt rather than on the success.
 */
const ADD_LIMIT = { limit: 20, windowMs: 60_000 } as const;

export async function GET(req: NextRequest) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;

  return NextResponse.json({
    skills: listSkills(auth.user.id),
    templates: SKILL_TEMPLATES,
    tools: SKILL_TOOL_CATALOG,
    limits: {
      maxSkills: SKILL_LIMITS.maxSkillsPerUser,
      maxInstructions: SKILL_LIMITS.maxInstructions,
      used: countSkills(auth.user.id),
    },
  });
}

export async function POST(req: NextRequest) {
  const auth = requireUser(req);
  if (!auth.ok) return auth.response;

  const gate = rateLimit(`skill-add:${auth.user.id}`, ADD_LIMIT);
  if (!gate.ok) {
    return NextResponse.json(
      {
        error: `Too many skills at once. Try again in ${formatRetryAfter(
          gate.retryAfterMs,
        )}.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      },
    );
  }

  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) {
    return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
  }
  const body = parsedBody.body;

  /* --- from a template -------------------------------------------------- */

  if (typeof body.template === "string") {
    const template = findTemplate(body.template);
    if (!template) {
      return NextResponse.json({ error: "No such template." }, { status: 404 });
    }
    /* Validated rather than trusted, even though it is our own text. If a
     * template is ever edited into something the schema rejects, the right
     * outcome is a clear failure here and not a row that no longer round-trips
     * through the validator. */
    const checked = validateSkill({
      slug: template.slug,
      name: template.name,
      description: template.description,
      instructions: template.instructions,
      allowedTools: template.allowedTools,
      triggerMode: template.triggerMode,
      triggers: template.triggers,
    });
    if (!checked.ok) {
      return NextResponse.json(
        { error: "That template is not valid.", errors: checked.errors },
        { status: 500 },
      );
    }
    const stored = createSkill(auth.user.id, checked.skill, { builtin: true });
    if (!stored.ok) {
      return NextResponse.json(
        { error: stored.error },
        { status: stored.conflict ? 409 : 400 },
      );
    }
    return NextResponse.json({ skill: stored.skill, warnings: checked.warnings });
  }

  /* --- from a pasted document ------------------------------------------- */

  const document = typeof body.document === "string" ? body.document : "";
  if (!document.trim()) {
    return NextResponse.json(
      { error: "Paste a skill, or pick a template." },
      { status: 400 },
    );
  }

  const result = readSkillDocument(document);
  if (!result.ok) {
    /* 422 rather than 400: the request was well-formed, the skill was not.
     * The panel distinguishes the two — a parse failure is the user's text to
     * fix, a 400 is a bug in the panel. */
    return NextResponse.json(
      { error: "That skill could not be added.", errors: result.errors },
      { status: 422 },
    );
  }

  const stored = createSkill(auth.user.id, result.skill);
  if (!stored.ok) {
    return NextResponse.json(
      { error: stored.error },
      { status: stored.conflict ? 409 : 400 },
    );
  }

  return NextResponse.json({ skill: stored.skill, warnings: result.warnings });
}
