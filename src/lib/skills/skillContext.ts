/**
 * src/lib/skills/skillContext.ts
 * ---------------------------------------------------------------------------
 * Choosing which skills apply to a turn, and turning them into prompt text.
 *
 * WHAT `allowedTools` ACTUALLY DOES — AND WHAT IT DOES NOT
 *
 * Worth being exact about, because the honest answer is smaller than the name
 * suggests and a reader who assumes the larger one will trust it wrongly.
 *
 * The tool array on an outbound request is built once for the whole turn. There
 * is no per-message scoping in the OpenAI-compatible protocol every provider
 * here speaks, so a skill's allowlist cannot narrow the model's options
 * mid-conversation. Anything claiming otherwise would be a checkbox that
 * changes a label and nothing else.
 *
 * So `allowedTools` does exactly two real things:
 *
 *   1. CONSENT AT INSTALL. The panel shows it before you add the skill, and
 *      says plainly when a skill wants tools that can modify files. You are
 *      approving a stated surface, not discovering it later.
 *
 *   2. AN AVAILABILITY GATE, ENFORCED HERE. A skill whose declared tools are
 *      not actually on this turn's request — file tools switched off, no editor
 *      paired, search disabled — is NOT injected, and is reported back as
 *      inactive with the reason. That matters: a skill whose instructions are
 *      three paragraphs of "read the file, then patch it" injected into a turn
 *      with no file tools produces a model confidently describing edits it
 *      never made. Withholding it is better than letting it narrate.
 *
 * What it does NOT do is stop the model from calling a tool the skill did not
 * declare. The existing guards are what stop that — per-folder approval in the
 * editor, the ignore patterns that keep .env files and keys out of reach, and
 * the file-tools kill switch. Skills sit on top of those and do not weaken
 * them, because a skill is text and text cannot grant a permission.
 *
 * WHY THE TOOL CATALOG IS CHECKED AGAINST THE RUNTIME AT BOOT
 *
 * skillManifest.ts lists the tool names by hand — it has to, since importing
 * vscodeBridge there would start a WebSocket server inside the browser bundle.
 * Hand-copied lists drift. So this module, which is server-only and can import
 * the real thing, compares them at load and complains loudly if they disagree.
 * A comment reading "keep these in sync" would not have survived the first
 * rename; a failing check at boot will.
 *
 * SERVER ONLY.
 */

import { WORKSPACE_TOOLS } from "@/lib/vscodeBridge";
import { enabledSkills } from "./skillStore";
import { SKILL_TOOL_NAMES, type StoredSkill } from "./skillManifest";

/* -------------------------------------------------------------------------
 * Drift check
 * ---------------------------------------------------------------------- */

/** The search tool's function name, which is `searchWeb` and not `search_web`
 *  — it is declared inline in the chat route rather than in WORKSPACE_TOOLS, so
 *  it has to be named here to be checked at all. */
const SEARCH_TOOL_NAME = "searchWeb";

export function toolCatalogDrift(): string[] {
  const runtime = new Set<string>([
    ...WORKSPACE_TOOLS.map((t) => t.function.name),
    SEARCH_TOOL_NAME,
  ]);
  const declared = new Set(SKILL_TOOL_NAMES);

  const problems: string[] = [];
  for (const name of runtime) {
    if (!declared.has(name)) {
      problems.push(
        `the app exposes "${name}" but SKILL_TOOL_CATALOG does not list it — ` +
          `skills cannot ask for it`,
      );
    }
  }
  for (const name of declared) {
    if (!runtime.has(name)) {
      problems.push(
        `SKILL_TOOL_CATALOG lists "${name}" but the app no longer exposes it — ` +
          `skills declaring it will be permanently inactive`,
      );
    }
  }
  return problems;
}

/* Run once, at import. Not a throw: a catalog mismatch makes skills wrong, not
 * the app unusable, and taking sign-in down over it would be a worse outcome
 * than a degraded feature. The message is written to be findable in `docker
 * compose logs` by someone who has just renamed a tool and is wondering why. */
{
  const drift = toolCatalogDrift();
  if (drift.length > 0) {
    console.error(
      "[skills] tool catalog is out of sync with the live tools:\n  - " +
        drift.join("\n  - ") +
        "\n  Fix SKILL_TOOL_CATALOG in src/lib/skills/skillManifest.ts.",
    );
  }
}

/* -------------------------------------------------------------------------
 * Selection
 * ---------------------------------------------------------------------- */

export type SkillSkipReason =
  | "no-trigger-match"
  | "tools-unavailable"
  | "budget-exceeded";

export interface ActiveSkill {
  id: string;
  slug: string;
  name: string;
  /** Why it is on this turn, phrased for the UI: "it is set to apply to every
   *  message", or "your message mentioned \"refactor\"". The user asked for
   *  visibility into what the backend is doing; an active skill with no stated
   *  reason is the opposite. */
  reason: string;
  allowedTools: string[];
}

export interface SkippedSkill {
  id: string;
  name: string;
  reason: SkillSkipReason;
  detail: string;
}

export interface SkillContextResult {
  /** The block to append to the system prompt. Empty string when nothing
   *  applies, so the caller can drop it with `.filter(Boolean)`. */
  context: string;
  active: ActiveSkill[];
  skipped: SkippedSkill[];
}

/**
 * Total characters of skill instruction allowed into one turn.
 *
 * A single skill may be 20 KB. Three of those would be 60 KB of prompt in front
 * of the user's actual question — enough to push the conversation itself out of
 * a smaller model's window, and enough to be noticeable on the bill. Skills are
 * taken in order until the budget is spent and the rest are reported as
 * dropped, which is visible, rather than truncated mid-sentence, which is not.
 */
const SKILL_CONTEXT_BUDGET = 24_000;

/** Regex-escape, so a trigger keyword containing `.` or `+` matches literally
 *  instead of becoming a wildcard. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does this message mention the keyword?
 *
 * Word-boundary matched rather than plain `includes`, because a substring match
 * on a short keyword is how "css" fires on "success" and the user concludes the
 * triggers are random. Multi-word keywords fall back to a boundary-wrapped
 * phrase match, which behaves the same way.
 */
function triggerMatches(message: string, keyword: string): boolean {
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(keyword)}([^a-z0-9]|$)`, "i");
  return pattern.test(message);
}

function missingTools(skill: StoredSkill, availableTools: string[]): string[] {
  const available = new Set(availableTools);
  return skill.allowedTools.filter((t) => !available.has(t));
}

export interface SelectSkillsInput {
  userId: string | null;
  /** The user's latest message, for `auto` trigger matching. */
  message: string;
  /** Ids the user explicitly switched on for this request, from the UI. */
  explicitSkillIds?: string[];
  /**
   * The tool names actually on this turn's outbound request.
   *
   * Passed in rather than recomputed here on purpose: the caller already built
   * the tool array, and deriving it a second time from the same env flags is
   * how the two quietly disagree. If it is on the request, it is available; if
   * it is not, it is not.
   */
  availableTools: string[];
}

export function selectSkills(input: SelectSkillsInput): {
  active: StoredSkill[];
  activeMeta: ActiveSkill[];
  skipped: SkippedSkill[];
} {
  const { userId, message, explicitSkillIds = [], availableTools } = input;

  if (!userId) return { active: [], activeMeta: [], skipped: [] };

  const explicit = new Set(explicitSkillIds);
  const candidates = enabledSkills(userId);

  const active: StoredSkill[] = [];
  const activeMeta: ActiveSkill[] = [];
  const skipped: SkippedSkill[] = [];

  for (const skill of candidates) {
    let reason: string | null = null;

    if (explicit.has(skill.id)) {
      reason = "you picked it for this message";
    } else if (skill.triggerMode === "always") {
      reason = "it is set to apply to every message";
    } else {
      const hit = skill.triggers.find((t) => triggerMatches(message, t));
      if (hit) reason = `your message mentioned "${hit}"`;
    }

    if (!reason) {
      skipped.push({
        id: skill.id,
        name: skill.name,
        reason: "no-trigger-match",
        detail: "none of its keywords appeared in your message",
      });
      continue;
    }

    const missing = missingTools(skill, availableTools);
    if (missing.length > 0) {
      skipped.push({
        id: skill.id,
        name: skill.name,
        reason: "tools-unavailable",
        detail:
          `it needs ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} ` +
          `not available right now — connect your editor, or turn file tools back on`,
      });
      continue;
    }

    active.push(skill);
    activeMeta.push({
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      reason,
      allowedTools: skill.allowedTools,
    });
  }

  return { active, activeMeta, skipped };
}

/* -------------------------------------------------------------------------
 * Rendering
 * ---------------------------------------------------------------------- */

/**
 * Strip anything that would let a skill's text end the skill block and start
 * giving instructions as if it were the app.
 *
 * A skill is written by the person who installed it, so this is not a trust
 * boundary in the way an untrusted document would be — but skills get copied
 * from the internet and pasted in, and the cost of the guard is one replace.
 * The delimiter is unusual enough that removing it from the body has no effect
 * on any real instruction text.
 */
function sanitiseInstructions(text: string): string {
  return text.replace(/<\/?user_skill\b[^>]*>/gi, "");
}

function renderSkill(skill: StoredSkill): string {
  const tools =
    skill.allowedTools.length > 0
      ? skill.allowedTools.join(", ")
      : "none — this skill is guidance only";

  return [
    `<user_skill name="${skill.name}" id="${skill.slug}">`,
    `Purpose: ${skill.description}`,
    `Tools this skill declared: ${tools}`,
    "",
    sanitiseInstructions(skill.instructions),
    `</user_skill>`,
  ].join("\n");
}

/**
 * Build the prompt block.
 *
 * The framing paragraph matters more than it looks. Without it a skill reads as
 * though it came from the app itself, which means a badly-written one can
 * appear to override the operating rules the system prompt establishes. Stating
 * where the text came from, and that it is additive rather than replacing,
 * keeps a skill in the role of "extra instructions the user wrote" — which is
 * what it is.
 */
export function buildSkillContext(input: SelectSkillsInput): SkillContextResult {
  const { active, activeMeta, skipped } = selectSkills(input);

  if (active.length === 0) {
    return { context: "", active: activeMeta, skipped };
  }

  const rendered: string[] = [];
  const kept: ActiveSkill[] = [];
  let used = 0;

  for (let i = 0; i < active.length; i += 1) {
    const skill = active[i];
    const block = renderSkill(skill);
    if (used + block.length > SKILL_CONTEXT_BUDGET && rendered.length > 0) {
      skipped.push({
        id: skill.id,
        name: skill.name,
        reason: "budget-exceeded",
        detail:
          "there was not enough room left in this turn — the skills before it " +
          "used the space. Turn one of them off to make room.",
      });
      continue;
    }
    rendered.push(block);
    kept.push(activeMeta[i]);
    used += block.length;
  }

  const header =
    kept.length === 1
      ? "The user has one skill active for this message."
      : `The user has ${kept.length} skills active for this message.`;

  const context = [
    "# Active skills",
    "",
    `${header} A skill is instructions the user wrote or installed. Follow it ` +
      "as if the user had included it in their message, and treat it as adding " +
      "to your operating rules rather than replacing them — where a skill and " +
      "those rules disagree, the rules win and it is worth saying so briefly " +
      "rather than silently picking one.",
    "",
    rendered.join("\n\n"),
  ].join("\n");

  return { context, active: kept, skipped };
}
