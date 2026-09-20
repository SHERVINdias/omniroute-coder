/**
 * Slash commands for the composer.
 *
 * These exist so the three things Ultra Mode is good at are reachable without
 * the user having to phrase them correctly in prose. `/review` in particular is
 * hard to trigger by asking: the reviewer normally only runs after the editor
 * has changed files, so there was no way to audit work that already exists.
 *
 * DESIGN: a command is DATA, not a code path. Each entry says which existing
 * pipeline knobs to set (`phase`, `readOnly`) and what objective to prepend.
 * Nothing here forks the agent loop — that is what made the rolled-back Extreme
 * Cowork build unmaintainable. Adding a command should mean adding an object to
 * `SLASH_COMMANDS`, nothing more.
 *
 * This module is deliberately dependency-free (no imports, no I/O, no React) so
 * it can be used from the client composer and the server route alike.
 */

/** The phase values the pipeline understands. Kept as a string union rather
 *  than imported so this module stays dependency-free; the route validates
 *  against its own resolver anyway. */
export type SlashPhase = "plan" | "execute" | "auto";

export interface SlashCommand {
  /** Command word without the slash. */
  name: string;
  /** One-line description, shown in the composer menu. */
  summary: string;
  /** What the argument means, shown as placeholder text. Empty = takes none. */
  argHint: string;
  /** Which half of the Deep Cowork flow to run. */
  phase: SlashPhase;
  /**
   * Physically remove file-writing tools for this command. This is enforcement,
   * not instruction — a prompt saying "do not edit" is a request the model can
   * decline, whereas a tool that is absent cannot be called.
   */
  readOnly: boolean;
  /** Ultra Mode only. A command that needs the Reviewer is not offered without it. */
  ultraOnly: boolean;
  /**
   * The objective injected into the system prompt. Receives whatever the user
   * typed after the command, already trimmed (empty string if nothing).
   */
  buildObjective: (args: string) => string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "plan",
    summary: "Draft a plan and stop for approval — no files are touched",
    argHint: "what to plan",
    phase: "plan",
    readOnly: true,
    ultraOnly: false,
    /* The plan phase already installs its own prompt and terminal action, so an
     * objective here would be a second, competing instruction. */
    buildObjective: () => "",
  },
  {
    name: "review",
    summary: "Audit existing code and report findings — read-only",
    argHint: "paths or area to audit",
    phase: "auto",
    readOnly: true,
    ultraOnly: false,
    buildObjective: (args) =>
      [
        "=== COMMAND: /review ===",
        args
          ? `Audit this specifically: ${args}`
          : "Audit the code most recently changed in this workspace. If a task " +
            "artifact lists applied edits, those files are the subject.",
        "",
        "You are reviewing, not fixing. File-writing tools are not available to",
        "you on this run, so do not plan edits or promise to make them.",
        "",
        "Read the actual files before judging them — an audit based on a guess",
        "about what the code probably says is worse than no audit, because it",
        "reads as authoritative. If you cannot find the relevant files, say so",
        "plainly and stop.",
        "",
        "Report findings worst-first. For each: the file and line, what is",
        "wrong, and why it matters. Distinguish a real defect from a stylistic",
        "preference, and say explicitly when you find nothing wrong in an area",
        "rather than padding the list. A short honest review beats a long one.",
        "=== END COMMAND ===",
      ].join("\n"),
  },
  {
    name: "init",
    summary: "Scan the project and record what you learn to knowledge files",
    argHint: "area to focus on",
    phase: "auto",
    readOnly: true,
    ultraOnly: false,
    buildObjective: (args) =>
      [
        "=== COMMAND: /init ===",
        args
          ? `Build up project knowledge, focusing on: ${args}`
          : "Build up project knowledge for this workspace.",
        "",
        "Read the real files: entry points, config, package manifest, routing,",
        "and the largest or most central modules. Source tools are read-only on",
        "this run; the remember tool is your output.",
        "",
        "Record what a new contributor could NOT infer in five minutes: the",
        "architecture and why it is shaped that way, conventions actually",
        "followed in the code, where the important logic lives, and any trap",
        "that would mislead someone (dead files, stale comments, config that",
        "must stay in sync). One remember call per coherent topic.",
        "",
        "Do not record what is already obvious from the file tree, and do not",
        "record a fact you have not verified by reading the file. A confident",
        "wrong note in a knowledge base is worse than a missing one, because it",
        "is trusted later without being rechecked.",
        "",
        "Finish with a short summary of what you recorded and what you skipped.",
        "=== END COMMAND ===",
      ].join("\n"),
  },
];

export interface ParsedSlashCommand {
  command: SlashCommand;
  /** Text after the command word, trimmed. */
  args: string;
  /** What to show as the user's message. Falls back to the raw text. */
  displayText: string;
}

/**
 * Pull a leading slash command off a composer message.
 *
 * Returns null for anything that is not a recognised command, which covers the
 * cases that matter: a bare "/" while typing, an unknown "/deploy", a path like
 * "/usr/bin", and a slash appearing mid-message rather than at the start. The
 * caller then sends the text through unchanged — an unrecognised command must
 * never be silently swallowed.
 */
export function parseSlashCommand(raw: string): ParsedSlashCommand | null {
  const text = raw.trimStart();
  if (!text.startsWith("/")) return null;

  /* Split on the first run of whitespace: everything before is the command
   * word, everything after is the argument (newlines included, so a multi-line
   * message after `/review` still works). */
  const match = /^\/([a-zA-Z][a-zA-Z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;

  const name = match[1].toLowerCase();
  const command = SLASH_COMMANDS.find((c) => c.name === name);
  if (!command) return null;

  const args = (match[2] ?? "").trim();
  return {
    command,
    args,
    /* Show the command as typed. Rewriting it to the expanded objective would
     * put words in the user's mouth in their own transcript. */
    displayText: text.trim(),
  };
}

/**
 * Commands whose name starts with the partial word after "/", for the composer
 * menu. An empty partial (just "/") lists everything.
 *
 * Returns [] once the user has typed a space, because at that point they are
 * writing arguments and a menu would be in the way.
 */
export function matchSlashCommands(
  raw: string,
  opts: { ultra?: boolean } = {},
): SlashCommand[] {
  /* Trim the leading side to match `parseSlashCommand`. Without this, "  /rev"
   * shows no menu but still executes as a command — the menu would be lying
   * about whether the thing you typed is a command. */
  const text = raw.trimStart();
  if (!text.startsWith("/")) return [];
  const afterSlash = text.slice(1);
  if (/\s/.test(afterSlash)) return [];
  const partial = afterSlash.toLowerCase();
  return SLASH_COMMANDS.filter(
    (c) =>
      c.name.startsWith(partial) && (opts.ultra || !c.ultraOnly),
  );
}
