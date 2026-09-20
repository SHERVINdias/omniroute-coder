# Writing a skill

A skill is a set of instructions you write once and reuse. Instead of re-explaining
your review checklist or your house writing style at the start of every chat, you
save it once and the assistant follows it.

You do not need this file to use skills — the **Skills** panel in the sidebar has
templates and a paste box that validates as you type. This is the reference for
when you want to write one in a file, keep it in version control, or share it.

## The one thing to understand first

**A skill is instructions, not a program. Nothing in it is ever executed.**

That is not a limitation that will be lifted later. It is the design. A skill is
text that gets added to the assistant's instructions for a message, which means a
skill you copied off the internet can do exactly as much as something you typed
yourself, and no more. There is no install step, no script, and nothing that runs
on the server.

So a file containing any of these is **rejected**, with a message naming the field:

```
code  script  scripts  exec  execute  command  commands  entrypoint  entry_point
entryPoint  run  bin  install  preinstall  postinstall  hooks  dockerfile  wasm
binary  native  eval  shell  runtime  sandbox  mcpServers  mcp_servers
url  fetch  endpoint  repository  git  download  registry
```

Rejected, not ignored. That distinction is the whole point: a file that quietly
dropped its `entrypoint` field would leave you believing something runs when it
does not, and would leave the next person to read the code believing there is a
sandbox somewhere holding it back. There isn't one, because there is nothing to
hold back.

Unrecognised fields are refused for the same reason — a typo'd `triggerz:` that
was silently dropped would look exactly like a skill whose triggers do not work.

## Format

Markdown with a frontmatter block, or plain JSON. Markdown is easier to read:

```markdown
---
name: Release Notes
description: Turns a list of changes into notes a customer can read
triggerMode: keyword
triggers: [changelog, release notes, what's new]
allowedTools:
  - read_file
  - list_files
---

Write release notes for the person using the product, not the person who built it.

**Lead with what they can now do.** "Exports now include images" beats "fixed the
export pipeline". Someone reading this wants to know whether to care.

**Group by outcome, not by commit.** Five commits that add one feature are one
line. One commit that changes three unrelated things is three lines.

**Name the breaking changes first and say what to do about them.** A breaking
change discovered in paragraph six has already cost someone their afternoon.

Skip anything invisible to a user — refactors, dependency bumps, internal renames
— unless it changes behaviour they will notice.
```

The same skill as JSON:

```json
{
  "name": "Release Notes",
  "description": "Turns a list of changes into notes a customer can read",
  "triggerMode": "keyword",
  "triggers": ["changelog", "release notes", "what's new"],
  "allowedTools": ["read_file", "list_files"],
  "instructions": "Write release notes for the person using the product..."
}
```

In Markdown the body below the closing `---` becomes `instructions`.

## Fields

| Field | Required | What it does |
|---|---|---|
| `name` | yes | Shown in the panel and in the chat readout. Up to 80 characters. |
| `description` | yes | One line explaining what it is for. Up to 300 characters. |
| `instructions` | yes | The actual content. Up to 20,000 characters. In Markdown this is the body, not a field. |
| `triggerMode` | no | `always` or `keyword`. Defaults to `always`. |
| `triggers` | if `keyword` | Words that switch it on. Up to 20. |
| `allowedTools` | no | Which tools the skill expects. See below. |
| `slug` | no | The stable id. Derived from the name if you leave it out. |

`version`, `author`, `license`, `tags` and `title` are accepted and ignored, so a
skill written for another tool usually imports without editing. `title` is used
as the name if `name` is absent, and `allowed_tools`, `tools` and `trigger_mode`
are accepted as aliases for their camelCase spellings.

The frontmatter parser is deliberately small — it handles `key: value`,
`key: [a, b]`, and `- item` lists, and nothing else. A line it cannot read is
reported back to you rather than skipped. If you want full YAML, use JSON.

## `always` or `keyword`

**`always`** applies to every message. Right for something short and general: a
style note, a stack detail, a convention. If it is more than a paragraph or two,
it is probably the wrong mode — a long playbook in front of every message is noise
nine times out of ten, and the answers get worse in ways that are hard to trace
back.

**`keyword`** applies only when one of its words appears in your message. Right
for anything long or specific. Matching is on whole words and is case-insensitive,
so `css` does not fire on `success` and `c++` matches literally rather than being
treated as a pattern. Multi-word triggers match as a phrase.

## `allowedTools`

Be exact about what this does, because the name suggests more than it delivers.

The available tools are `list_files`, `read_file`, `replace_text`, `write_file`
(all four need a paired VS Code editor) and `searchWeb`.

Listing a tool does **two** things:

1. **It tells you what the skill expects before you add it.** The panel shows the
   list, and marks the ones that can modify files.
2. **It gates the skill on availability.** If a declared tool is not on the
   current request — no editor paired, file tools switched off, search disabled —
   the skill is held back and the chat says why. This is the useful half. A skill
   that says "read the file, then patch it", injected into a turn with no file
   access, yields an assistant narrating edits that never happened.

It does **not** stop the assistant from using a tool the skill did not list. Tool
access is controlled by the per-folder approval you give in the editor and by the
file-tools switch — a skill is text, and text cannot grant a permission. If you
want the assistant to have less reach, change those, not this.

Leave `allowedTools` out entirely for a guidance-only skill. That is the most
common case and it never gets held back.

## Limits

Up to 50 skills per account, 20,000 characters of instructions each, and a
combined budget of roughly 24,000 characters of skill text per message. Past that
budget, further skills are dropped for that message and reported as dropped — not
silently truncated halfway through a sentence, which would leave the assistant
following half an instruction.

## When a skill does not run

The chat shows a line under the answer listing which skills applied and why, and
which were held back and why. The reasons are:

- **no keyword matched** — the message did not contain any of its triggers.
- **tools unavailable** — it needs something not on this request. Usually a
  missing editor connection.
- **not enough room** — earlier skills used the per-message budget.

A skill that is switched off in the panel is not considered at all.

## A note on skills from the internet

Paste them in. The validator is the security boundary and it runs on the same
rules described above, so the worst case for a hostile skill file is that it is
rejected with a list of reasons.

The realistic risk is not code execution, it is a skill whose *instructions* tell
the assistant to do something you would not want — exfiltrate a file it can read,
or ignore your other rules. Two things reduce that: skill text is wrapped so it
cannot break out and impersonate the app, and the framing tells the assistant
that a skill adds to its operating rules rather than replacing them, and that the
rules win where they conflict. Neither is a substitute for reading a skill before
you add it. It is instructions you are agreeing to follow — read them like you
would read a script before running it, even though this one never runs.
