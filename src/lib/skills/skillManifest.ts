/**
 * src/lib/skills/skillManifest.ts
 * ---------------------------------------------------------------------------
 * What a skill is, and what it is refused for being.
 *
 * WHAT A SKILL IS HERE
 *
 * A skill is *instructions plus a declared tool allowlist*. That is the whole
 * data model. It carries no code, no entrypoint, no command to run, and no URL
 * fetched at runtime. Installing one adds text that may be placed in front of
 * the model, and permission for that text to use tools THIS APP ALREADY HAS.
 * It cannot add a capability; it can only narrow and direct the existing ones.
 *
 * WHY IT IS NOT THE OTHER KIND
 *
 * The obvious design — upload a zip, it has an index.js, we require() it — is
 * remote code execution with extra steps. On a single-tenant desktop tool that
 * is a defensible trade. This app is multi-tenant: one Node process serves every
 * signed-in account, and that process owns the SQLite file containing every
 * user's hashed pairing tokens and encrypted provider keys, the vscodeBridge
 * singleton and therefore every connected tester's editor, and (on EC2) the
 * instance metadata endpoint and therefore the machine's IAM role. Code from an
 * uploaded file running in that process is not "a skill with a bug", it is the
 * end of the security model for everyone on the box at once.
 *
 * The usual answer to that is "we sandbox it". Node has nothing that qualifies.
 * `vm` shares the heap and is escapable by design — its own documentation says
 * so. `worker_threads` is an isolation boundary for *crashes*, not for
 * *intent*: a worker still has fs, net and process. Real isolation means a
 * separate process under seccomp or a container per user, which on the target
 * instance (t4g.small, 2 GB) is not something you run one of per skill
 * invocation. So the honest options were "declarative" or "not yet", and this
 * is the declarative one.
 *
 * Skills that genuinely need to execute belong on the user's own machine,
 * through the VS Code bridge, under the per-folder consent that already exists.
 * That path is deliberately left open by this design rather than closed off:
 * `allowedTools` is how a skill reaches it.
 *
 * REJECTED, NOT IGNORED
 *
 * The validator refuses a manifest that carries `code`, `entrypoint`, `command`,
 * `url` and friends, instead of quietly dropping those fields. This matters more
 * than it looks. Someone will paste a skill written for an ecosystem where those
 * keys mean something; if we silently ignored them the skill would install,
 * appear to work, and do half of what its author intended, with the missing half
 * being precisely the half they thought was doing the work. A loud refusal
 * naming the key is the difference between "this build does not support that"
 * and a bug report nobody can reproduce.
 *
 * WHAT THIS MODULE MAY IMPORT
 *
 * Nothing. No `node:` builtins, no database, no bridge — the same rule
 * providerProfiles.ts follows, and for the same reason: the Skills panel in the
 * browser validates a manifest before sending it, and an accidental import of
 * vscodeBridge here would drag a WebSocket server into the client bundle. The
 * server re-validates anyway; client-side validation is for the error message,
 * never for the decision.
 */

/* -------------------------------------------------------------------------
 * The tool surface a skill may ask for
 *
 * These are the tools the chat pipeline actually exposes today: the four
 * workspace tools from WORKSPACE_TOOLS (src/lib/vscodeBridge.ts) plus the web
 * search tool. The names are duplicated here rather than imported because
 * importing vscodeBridge would (a) start the bridge as a side effect and (b)
 * make this module unusable from the browser.
 *
 * Duplication that drifts is a bug, so it is checked rather than trusted:
 * assertToolCatalogMatchesRuntime() in skillContext.ts compares this list to the
 * live one at boot and complains loudly if they diverge. A comment saying "keep
 * these in sync" would not have survived the first rename.
 * ---------------------------------------------------------------------- */

export interface SkillToolInfo {
  name: string;
  /** Shown in the panel next to the checkbox. */
  label: string;
  /** What granting it actually permits, in the user's terms. */
  effect: string;
  /** Whether it can change anything, which is what the UI warns about. */
  mutating: boolean;
}

export const SKILL_TOOL_CATALOG: readonly SkillToolInfo[] = [
  {
    name: "list_files",
    label: "List files",
    effect: "See the names of files in a folder you have approved in VS Code.",
    mutating: false,
  },
  {
    name: "read_file",
    label: "Read a file",
    effect: "Read the contents of a file in an approved folder.",
    mutating: false,
  },
  {
    name: "replace_text",
    label: "Replace text in a file",
    effect: "Change part of an existing file in an approved folder.",
    mutating: true,
  },
  {
    name: "write_file",
    label: "Write a file",
    effect: "Create or overwrite a file in an approved folder.",
    mutating: true,
  },
  {
    name: "searchWeb",
    label: "Search the web",
    effect: "Look things up online. Never used to find files in your project.",
    mutating: false,
  },
] as const;

export const SKILL_TOOL_NAMES: readonly string[] = SKILL_TOOL_CATALOG.map(
  (t) => t.name,
);

/* -------------------------------------------------------------------------
 * Limits
 *
 * Every one of these is a bound on something a user controls that ends up in a
 * prompt, a database row, or a loop. Unbounded instructions are a token bill;
 * unbounded trigger lists are a matcher run on every message.
 * ---------------------------------------------------------------------- */

export const SKILL_LIMITS = {
  /** Roughly 5k tokens. Long enough for a real playbook, short enough that two
   *  active skills cannot crowd out the conversation itself. */
  maxInstructions: 20_000,
  maxDescription: 300,
  maxName: 80,
  maxSlug: 64,
  minSlug: 2,
  maxTriggers: 20,
  maxTriggerLength: 60,
  minTriggerLength: 2,
  /** Per user. High enough to never be hit in normal use, low enough that a
   *  scripted loop cannot grow the table without bound. */
  maxSkillsPerUser: 50,
  /** A whole document, before parsing. Guards the JSON/frontmatter parsers from
   *  being handed a megabyte of text to scan. */
  maxDocumentBytes: 64 * 1024,
} as const;

/* -------------------------------------------------------------------------
 * Shape
 * ---------------------------------------------------------------------- */

/** How a skill gets in front of the model, once it is switched on. */
export type SkillTrigger =
  /** Every message. The right choice for a skill that describes how you want
   *  the assistant to behave generally — a house style, a review standard. */
  | "always"
  /** Only when one of its keywords appears in your message. Transparent,
   *  because the matched keyword is reported back to the UI, so "why did it do
   *  that" always has an answer. The right choice for a skill that is excellent
   *  at one job and noise the rest of the time. */
  | "keyword";

/** A validated skill, before it has been given an id and an owner. */
export interface SkillManifest {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  allowedTools: string[];
  triggerMode: SkillTrigger;
  triggers: string[];
}

/** A skill as stored, with everything the store adds. */
export interface StoredSkill extends SkillManifest {
  id: string;
  userId: string;
  enabled: boolean;
  builtin: boolean;
  createdAt: number;
  updatedAt: number;
}

export type SkillValidation =
  | { ok: true; skill: SkillManifest; warnings: string[] }
  | { ok: false; errors: string[] };

/* -------------------------------------------------------------------------
 * Keys that mean "this is the other kind of skill"
 *
 * Split into two groups purely so the error message can say something true
 * about why. Neither group is ignored.
 * ---------------------------------------------------------------------- */

const EXECUTION_KEYS = [
  "code",
  "script",
  "scripts",
  "exec",
  "execute",
  "command",
  "commands",
  "entrypoint",
  "entry_point",
  "entryPoint",
  "run",
  "bin",
  "install",
  "preinstall",
  "postinstall",
  "hooks",
  "dockerfile",
  "wasm",
  "binary",
  "native",
  "eval",
  "shell",
  "runtime",
  "sandbox",
  "mcpServers",
  "mcp_servers",
];

const REMOTE_KEYS = ["url", "fetch", "endpoint", "repository", "git", "download", "registry"];

const KNOWN_KEYS = [
  "slug",
  "name",
  "description",
  "instructions",
  "allowedTools",
  "allowed_tools",
  "tools",
  "triggerMode",
  "trigger_mode",
  "triggers",
  /* Tolerated and dropped: these are metadata that says nothing about
   * behaviour, and rejecting them would make perfectly good skills from other
   * formats fail for no safety reason. */
  "version",
  "author",
  "license",
  "tags",
  "title",
];

/* -------------------------------------------------------------------------
 * Parsing a pasted document
 *
 * Two accepted shapes, because people arrive with both: a JSON object, or a
 * Markdown file with a frontmatter block (the SKILL.md convention) where the
 * body after the frontmatter is the instructions.
 *
 * The frontmatter reader below is a deliberately tiny key/value parser, NOT
 * YAML. Real YAML is a large language with a history of parser CVEs, and
 * accepting it here would mean either a new dependency or a hand-rolled
 * approximation that disagrees with every other YAML reader in confusing ways.
 * What is supported is: `key: value`, `key: [a, b]`, and a `- item` block under
 * a key. Anything else is reported as unreadable rather than guessed at.
 * ---------------------------------------------------------------------- */

interface RawObject {
  [key: string]: unknown;
}

function parseFrontmatterScalar(raw: string): string {
  let value = raw.trim();
  /* Strip one layer of matching quotes, which people add out of habit. */
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function parseInlineList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1);
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((part) => parseFrontmatterScalar(part))
    .filter(Boolean);
}

/**
 * Split `---\n…\n---\nbody` into an object and the body.
 * Returns null when the text has no frontmatter block at all, which the caller
 * treats as "not a Markdown skill" rather than as an error.
 */
function parseMarkdownSkill(text: string): RawObject | null {
  const normalised = text.replace(/\r\n/g, "\n");
  if (!normalised.startsWith("---\n")) return null;

  const end = normalised.indexOf("\n---", 3);
  if (end === -1) return null;

  const block = normalised.slice(4, end);
  const body = normalised.slice(end + 4).replace(/^\n+/, "");

  const out: RawObject = {};
  let listKey: string | null = null;
  let listItems: string[] = [];

  const flushList = () => {
    if (listKey) {
      out[listKey] = listItems;
      listKey = null;
      listItems = [];
    }
  };

  for (const line of block.split("\n")) {
    if (!line.trim()) continue;

    /* A `- item` line continues the list opened by the previous key. */
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && listKey) {
      listItems.push(parseFrontmatterScalar(listItem[1]));
      continue;
    }

    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      /* Unreadable line. Recorded so validation can refuse with the line
       * itself rather than a vague "bad frontmatter". */
      flushList();
      out.__unparsed = [
        ...((out.__unparsed as string[] | undefined) ?? []),
        line.trim(),
      ];
      continue;
    }

    flushList();
    const [, key, rest] = kv;
    const value = rest.trim();

    if (!value) {
      /* `key:` alone opens a `- item` list. */
      listKey = key;
      listItems = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      out[key] = parseInlineList(value);
    } else {
      out[key] = parseFrontmatterScalar(value);
    }
  }
  flushList();

  if (body.trim() && !out.instructions) out.instructions = body.trim();
  return out;
}

/**
 * Turn pasted text into a raw object, whichever of the two formats it is in.
 * Deliberately separate from validation so the UI can report "that is not
 * valid JSON" differently from "that is valid but not a usable skill".
 */
export function parseSkillDocument(
  text: string,
): { ok: true; raw: RawObject } | { ok: false; errors: string[] } {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, errors: ["The document is empty."] };
  }
  if (text.length > SKILL_LIMITS.maxDocumentBytes) {
    return {
      ok: false,
      errors: [
        `That document is ${Math.round(text.length / 1024)} KB. The limit is ` +
          `${SKILL_LIMITS.maxDocumentBytes / 1024} KB — a skill is instructions, ` +
          `not an attachment.`,
      ],
    };
  }

  const trimmed = text.trim();

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, errors: ["The JSON must be a single object."] };
      }
      return { ok: true, raw: parsed as RawObject };
    } catch (err) {
      return {
        ok: false,
        errors: [
          `That is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }
  }

  const md = parseMarkdownSkill(trimmed);
  if (md) return { ok: true, raw: md };

  return {
    ok: false,
    errors: [
      "Could not read that as a skill. Paste either a JSON object, or a " +
        "Markdown file that starts with a --- frontmatter block containing at " +
        "least `name:` and `description:`, with the instructions below it.",
    ],
  };
}

/* -------------------------------------------------------------------------
 * Validation
 * ---------------------------------------------------------------------- */

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.every((v) => typeof v === "string") ? (value as string[]) : null;
  }
  /* A comma-separated string is what the frontmatter format produces for a
   * single-line list, and what people type by hand. */
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return null;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_LIMITS.maxSlug);
}

/**
 * Decide whether a raw object is a usable skill.
 *
 * Returns every problem at once rather than the first one. Someone pasting a
 * skill they wrote elsewhere usually has two or three things to fix, and a
 * validator that reveals them one reload at a time is its own small punishment.
 */
export function validateSkill(raw: unknown): SkillValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["A skill must be a single object."] };
  }
  const obj = raw as RawObject;

  /* --- the refusals that are the point of this file --------------------- */

  const presentExecution = EXECUTION_KEYS.filter((k) => k in obj);
  if (presentExecution.length > 0) {
    errors.push(
      `This build runs declarative skills only, and that manifest carries ` +
        `${presentExecution.map((k) => `\`${k}\``).join(", ")}. ` +
        `Skills here are instructions plus a list of tools they may use — there ` +
        `is nowhere for code to run, so rather than install it and silently do ` +
        `half of what you intended, it is refused. If the skill needs to execute ` +
        `something, have it drive the file tools through your VS Code instead.`,
    );
  }

  const presentRemote = REMOTE_KEYS.filter((k) => k in obj);
  if (presentRemote.length > 0) {
    errors.push(
      `Remove ${presentRemote.map((k) => `\`${k}\``).join(", ")}. Nothing is ` +
        `fetched at runtime: a skill is stored whole when you add it, so a field ` +
        `pointing somewhere else would either do nothing or become a way to ` +
        `change a skill's behaviour after you approved it.`,
    );
  }

  const unknown = Object.keys(obj).filter(
    (k) =>
      !KNOWN_KEYS.includes(k) &&
      !EXECUTION_KEYS.includes(k) &&
      !REMOTE_KEYS.includes(k) &&
      k !== "__unparsed",
  );
  if (unknown.length > 0) {
    errors.push(
      `Unrecognised field(s): ${unknown.map((k) => `\`${k}\``).join(", ")}. ` +
        `Allowed: name, description, instructions, allowedTools, triggerMode, ` +
        `triggers, slug.`,
    );
  }

  if (Array.isArray(obj.__unparsed) && obj.__unparsed.length > 0) {
    errors.push(
      `Could not read these frontmatter line(s): ` +
        (obj.__unparsed as string[]).map((l) => `"${l}"`).join(", ") +
        `. Supported forms are \`key: value\`, \`key: [a, b]\`, and a \`- item\` ` +
        `list under a key.`,
    );
  }

  /* --- name ------------------------------------------------------------- */

  const name = (asString(obj.name) ?? asString(obj.title) ?? "").trim();
  if (!name) errors.push("`name` is required.");
  else if (name.length > SKILL_LIMITS.maxName) {
    errors.push(`\`name\` is longer than ${SKILL_LIMITS.maxName} characters.`);
  }

  /* --- slug ------------------------------------------------------------- */

  /* Whether the slug was written down or derived from the name decides how the
   * failure is phrased. Telling someone their `slug` is too short when they
   * never typed one sends them looking for a field that is not in their file;
   * the thing they can actually act on is the name. */
  const suppliedSlug = asString(obj.slug);
  const slug = (suppliedSlug ?? slugify(name)).trim();
  const slugSource = suppliedSlug !== null ? "supplied" : "derived";

  if (!slug) {
    errors.push("Could not derive a slug — give the skill a name with letters in it.");
  } else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    errors.push(
      slugSource === "supplied"
        ? `\`slug\` must be lowercase letters, digits and single hyphens (got "${slug}").`
        : `The name "${name}" does not produce a usable id (got "${slug}"). ` +
            `Use letters and digits, or set \`slug\` yourself.`,
    );
  } else if (slug.length < SKILL_LIMITS.minSlug || slug.length > SKILL_LIMITS.maxSlug) {
    errors.push(
      slugSource === "supplied"
        ? `\`slug\` must be ${SKILL_LIMITS.minSlug}–${SKILL_LIMITS.maxSlug} characters.`
        : `The name "${name}" is too short — it becomes the id "${slug}", and an ` +
            `id needs at least ${SKILL_LIMITS.minSlug} characters. Use a longer ` +
            `name, or set \`slug\` yourself.`,
    );
  }

  /* --- description ------------------------------------------------------ */

  const description = (asString(obj.description) ?? "").trim();
  if (!description) {
    errors.push(
      "`description` is required — it is what the model reads to decide whether " +
        "the skill is relevant, so it does real work.",
    );
  } else if (description.length > SKILL_LIMITS.maxDescription) {
    errors.push(
      `\`description\` is longer than ${SKILL_LIMITS.maxDescription} characters.`,
    );
  }

  /* --- instructions ----------------------------------------------------- */

  const instructions = (asString(obj.instructions) ?? "").trim();
  if (!instructions) {
    errors.push(
      "`instructions` is required. In a Markdown skill this is everything below " +
        "the frontmatter block.",
    );
  } else if (instructions.length > SKILL_LIMITS.maxInstructions) {
    errors.push(
      `\`instructions\` is ${instructions.length} characters; the limit is ` +
        `${SKILL_LIMITS.maxInstructions}.`,
    );
  }

  /* --- tools ------------------------------------------------------------ */

  const rawTools =
    obj.allowedTools ?? obj.allowed_tools ?? obj.tools ?? ([] as unknown);
  const toolList = asStringArray(rawTools);
  let allowedTools: string[] = [];

  if (toolList === null) {
    errors.push("`allowedTools` must be a list of tool names.");
  } else {
    const seen = new Set<string>();
    for (const entry of toolList) {
      const tool = entry.trim();
      if (!tool) continue;
      if (!SKILL_TOOL_NAMES.includes(tool)) {
        errors.push(
          `Unknown tool "${tool}". A skill can only ask for tools this app ` +
            `already has: ${SKILL_TOOL_NAMES.join(", ")}. It cannot bring a new one.`,
        );
        continue;
      }
      seen.add(tool);
    }
    allowedTools = [...seen];
  }

  /* --- triggers --------------------------------------------------------- */

  const modeRaw = (asString(obj.triggerMode) ?? asString(obj.trigger_mode) ?? "always")
    .trim()
    .toLowerCase();
  /* "manual" and "auto" were the names in an earlier draft of this schema and
   * still appear in skills people wrote against it. Mapping them is a one-line
   * kindness that stops a valid skill failing over a renamed enum. */
  const modeAliased =
    modeRaw === "manual" ? "always" : modeRaw === "auto" ? "keyword" : modeRaw;
  if (modeAliased !== "always" && modeAliased !== "keyword") {
    errors.push(`\`triggerMode\` must be "always" or "keyword" (got "${modeRaw}").`);
  }
  const triggerMode: SkillTrigger = modeAliased === "keyword" ? "keyword" : "always";

  const triggerList = asStringArray(obj.triggers ?? []) ?? null;
  let triggers: string[] = [];
  if (triggerList === null) {
    errors.push("`triggers` must be a list of keywords.");
  } else {
    const seen = new Set<string>();
    for (const entry of triggerList) {
      const keyword = entry.trim().toLowerCase();
      if (!keyword) continue;
      if (
        keyword.length < SKILL_LIMITS.minTriggerLength ||
        keyword.length > SKILL_LIMITS.maxTriggerLength
      ) {
        errors.push(
          `Trigger "${entry}" must be ${SKILL_LIMITS.minTriggerLength}–` +
            `${SKILL_LIMITS.maxTriggerLength} characters.`,
        );
        continue;
      }
      seen.add(keyword);
    }
    triggers = [...seen];
    if (triggers.length > SKILL_LIMITS.maxTriggers) {
      errors.push(
        `${triggers.length} triggers; the limit is ${SKILL_LIMITS.maxTriggers}.`,
      );
    }
  }

  if (triggerMode === "keyword" && triggers.length === 0) {
    errors.push(
      'A skill set to "keyword" needs at least one trigger keyword, otherwise ' +
        "there is nothing for it to match on and it would never fire.",
    );
  }

  /* --- warnings (not refusals) ------------------------------------------ */

  if (triggerMode === "always" && triggers.length > 0) {
    warnings.push(
      'The triggers are stored but unused while this skill is set to "always" — ' +
        'switch it to "keyword" if you want it to apply only when they match.',
    );
  }

  const mutating = allowedTools.filter(
    (t) => SKILL_TOOL_CATALOG.find((c) => c.name === t)?.mutating,
  );
  if (mutating.length > 0) {
    warnings.push(
      `This skill can change files (${mutating.join(", ")}). It still only ` +
        `reaches folders you have approved in VS Code, and it still cannot ` +
        `touch .env files, keys or certificates — but it can edit your code.`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    warnings,
    skill: {
      slug,
      name,
      description,
      instructions,
      allowedTools,
      triggerMode,
      triggers,
    },
  };
}

/**
 * Parse and validate in one step — what both the API route and the panel
 * actually want.
 */
export function readSkillDocument(text: string): SkillValidation {
  const parsed = parseSkillDocument(text);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  return validateSkill(parsed.raw);
}
