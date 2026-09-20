/**
 * src/lib/skills/skillTemplates.ts
 * ---------------------------------------------------------------------------
 * Four skills that ship with the app, as templates rather than rows.
 *
 * WHY TEMPLATES AND NOT SEEDED DATA
 *
 * The alternative is inserting these into every user's table at first sign-in.
 * That creates a small, annoying category of bug: a user deletes one, and the
 * next boot puts it back. Seeding also means every account starts carrying
 * ~30 KB of text it never asked for, and it makes "what have I installed"
 * ambiguous — the panel would open showing four things the user did not add.
 *
 * As templates they are inert until chosen. The panel offers them, one click
 * copies one into the user's own table as an ordinary editable skill, and from
 * that moment it belongs to the user: editable, deletable, and gone for good
 * when deleted. The `builtin` flag it is stored with is a display badge only —
 * it confers no privilege and gates nothing, which is worth saying because a
 * flag named "builtin" sitting next to a permission list invites the opposite
 * assumption.
 *
 * WHY THESE FOUR
 *
 * Each one demonstrates a different part of the model, so the set doubles as
 * documentation: two read-only skills, one that searches the web and cannot
 * touch files at all, and one that writes. Someone who installs all four has
 * seen every shape of tool declaration the schema allows.
 *
 * All four are keyword-triggered rather than always-on. A playbook this
 * specific injected into every message would be noise nine times out of ten,
 * and a user whose first experience of skills is "every answer got weirder"
 * does not go on to write their own. "Always" is the right mode for a short
 * personal style note, which is exactly the thing a template cannot guess.
 *
 * Dependency-free and client-safe, like skillManifest.ts — the panel renders
 * these directly.
 */

import type { SkillManifest } from "./skillManifest";

export interface SkillTemplate extends SkillManifest {
  /** One line under the title in the template list. */
  tagline: string;
}

export const SKILL_TEMPLATES: readonly SkillTemplate[] = [
  {
    slug: "ui-ux-pro",
    name: "UI/UX Review",
    tagline: "Critiques interface work against real usability criteria, not vibes.",
    description:
      "Reviews UI code and designs for hierarchy, spacing, state coverage and accessibility before calling anything done.",
    allowedTools: ["list_files", "read_file"],
    triggerMode: "keyword",
    triggers: [
      "ui",
      "ux",
      "design",
      "layout",
      "styling",
      "css",
      "accessibility",
      "responsive",
    ],
    instructions: `When the work involves an interface, review it against these before saying it looks good.

**Read the actual code first.** Open the component and its styles. A review written from a description is a review of the description.

**Visual hierarchy.** What should the eye land on first? If everything is the same weight and size, nothing is emphasised and the user has to read all of it to find the one thing they came for. Check that the primary action is visually primary — not just labelled "primary".

**Spacing is a system, not a series of decisions.** Look for arbitrary values: 13px here, 15px there. Pick a scale (4/8/12/16/24/32) and name the deviations. Inconsistent spacing is the single most common reason work looks amateur while every individual screen looks fine.

**All four states, every time.** Loading, empty, error, and full. The empty state is the one that gets skipped and the one a new user sees first — if it is a blank panel, that is the product's first impression. An error state that says "Something went wrong" tells the user nothing they did not already know; say what failed and what to do.

**Interactive affordance.** Anything clickable needs hover and focus-visible styling and a cursor that says so. Focus rings are removed far more often than they are replaced; if \`outline: none\` appears anywhere, there had better be a \`:focus-visible\` rule nearby.

**Contrast and target size.** Body text at 4.5:1, large text at 3:1, tap targets at least 44px on touch. Grey-on-grey secondary text is the usual offender.

**Motion.** Transitions belong on transform and opacity. Animating width, height or top forces layout on every frame and turns a nice idea into jank on a cheap laptop. Respect \`prefers-reduced-motion\`.

**Semantics.** A \`div\` with an onClick is invisible to a keyboard and to a screen reader. Use the element that means what you mean; add \`aria-\` only when no element does.

Report findings in order of how much they hurt the user, not in the order you found them. Say which ones you would fix now and which are worth leaving. A review that lists twenty equal-weight nitpicks is a review nobody acts on.`,
  },

  {
    slug: "code-review",
    name: "Code Review",
    tagline: "A second pass that looks for the failure modes, not the typos.",
    description:
      "Reviews code for correctness, error handling and security rather than style, and says which findings actually matter.",
    allowedTools: ["list_files", "read_file"],
    triggerMode: "keyword",
    triggers: ["review", "code review", "refactor", "audit", "pull request", "diff"],
    instructions: `Review the code as someone who will be paged when it breaks.

**Read the surrounding code before judging the change.** Most review mistakes come from evaluating a diff against imagined context. Open the callers. Find out whether the pattern being "fixed" was load-bearing.

**Correctness first.** Off-by-one, the empty case, the single-element case, concurrent callers, and what happens on the second call. If there is state, ask what happens when two requests touch it at once.

**Error handling is a feature.** An empty \`catch {}\` converts a loud failure into a silent wrong answer, which is strictly worse. Every swallowed error needs a reason next to it. Check that error messages say what to do, not just what happened.

**Boundaries.** Anything crossing a trust boundary — user input, a network response, a database row written by an older version — needs validating on arrival, not on use. Values parsed from JSON are \`unknown\` no matter what the type annotation claims.

**Security, in proportion.** Authorisation checked on every path rather than most of them. Ids from the client never trusted alone — scope the query by owner. Secrets never logged. SQL parameterised. User-supplied paths never concatenated into a filesystem call.

**Resource lifetime.** Anything opened is closed on the error path too. Unbounded arrays, caches with no eviction, and listeners added without removal are the three that only show up in production.

**Then, and only then, style.** Naming that misleads is worth raising; naming you merely disagree with is not.

For each finding give the file and line, what breaks, and how to fix it. Separate "this is a bug" from "I would have done it differently" — mixing them is how the real bug gets lost in the list. If the code is fine, say so plainly instead of manufacturing findings to look thorough.`,
  },

  {
    slug: "geo-seo",
    name: "SEO & Content",
    tagline: "Writes and audits pages for search without turning them into keyword soup.",
    description:
      "Applies on-page SEO, structured data and local search practice to content, checking current guidance before asserting it.",
    allowedTools: ["searchWeb"],
    triggerMode: "keyword",
    triggers: [
      "seo",
      "meta description",
      "keywords",
      "search ranking",
      "structured data",
      "schema markup",
      "landing page",
    ],
    instructions: `Optimise for the reader first. Search rewards pages people stay on, and everything below is downstream of that.

**Check before you assert.** Search guidance changes and confidently-stated stale advice is worse than no advice. If a claim depends on what a search engine currently does, look it up rather than reciting it.

**One page, one intent.** Decide what question the page answers before writing. Pages trying to rank for several unrelated queries rank for none of them.

**Title and description.** Title around 50-60 characters, the distinguishing word first — a title that starts with the brand name wastes the part people actually read. Description around 150-160 characters, written as a reason to click rather than a summary. Every page gets its own; duplicated descriptions across a site are a missed opportunity repeated at scale.

**Heading structure.** One \`h1\` that matches the intent. \`h2\`s that would work as a table of contents. Headings chosen for size rather than level is the most common structural mistake.

**Content.** Answer the question in the first paragraph, then support it. Keyword density is not a thing to optimise; write the way someone would ask, and the phrasing follows. Short paragraphs. Specifics and numbers over adjectives.

**Structured data.** Add the schema.org type that actually matches — Article, Product, FAQPage, LocalBusiness — and make sure every field in it is also visible on the page. Markup describing content the user cannot see is a manual-action risk, not a shortcut.

**Local.** Name, address and phone identical everywhere they appear, character for character. Inconsistent formatting across listings quietly splits a business's signals in two.

**Technical.** Descriptive URLs, internal links with real anchor text rather than "click here", alt text that describes the image to someone who cannot see it, and canonical tags wherever the same content is reachable by more than one URL.

Say which changes are likely to move anything and which are hygiene. Most SEO advice is hygiene, and pretending otherwise sets up a disappointment.`,
  },

  {
    slug: "test-first",
    name: "Test First",
    tagline: "Writes the failing test before the fix, so the fix is provably a fix.",
    description:
      "Reproduces a bug as a failing test before changing any code, then verifies the test passes for the right reason.",
    allowedTools: ["list_files", "read_file", "write_file", "replace_text"],
    triggerMode: "keyword",
    triggers: ["bug", "failing", "regression", "reproduce", "broken", "fix this"],
    instructions: `For a bug fix, the order is: reproduce, then fix. Not the other way round.

**Write the failing test first.** Before touching the implementation, write a test that fails because of the bug. This is the step that gets skipped, and skipping it means the fix is unverified — you have changed code and observed that a symptom went away, which is not the same thing.

**Watch it fail, and check why.** A test that fails for the wrong reason — a typo in the import, a missing fixture — will pass the moment you fix the typo, and you will believe the bug is gone. Read the failure message and confirm it describes the actual bug.

**Now write the smallest fix that makes it pass.** Resist fixing the neighbouring things you noticed. They are a separate change with a separate test.

**Then check the test still fails without the fix.** Revert the implementation change mentally or actually, and confirm the test goes red again. A test that passes both ways is testing nothing, and is worse than no test because it will be trusted.

**Name the test after the bug, not the function.** \`returns_empty_array_when_user_has_no_projects\` tells the next reader what broke. \`testGetProjects\` tells them nothing.

**Cover the edges the bug revealed.** A bug found at a boundary usually means the boundary was never considered — check the other side of it too.

Before finishing, run the whole suite, not just the new test. The most common way a fix causes an outage is passing its own test while breaking one nobody re-ran.`,
  },
] as const;

export function findTemplate(slug: string): SkillTemplate | undefined {
  return SKILL_TEMPLATES.find((t) => t.slug === slug);
}
