"use strict";
/* AUTO-GENERATED FILE — DO NOT EDIT.
 *
 * Copied verbatim from src/lib/fileExclusions.ts by
 * scripts/sync-exclusions.mjs. Edit the original and re-run:
 *
 *     npm run extension:sync-engine
 *
 * scripts/package-vsix.mjs refuses to build if this copy is stale, so a
 * change made here instead of there will fail the next package step rather
 * than silently give the extension different rules from the server.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MATCHER = exports.ExclusionMatcher = exports.EMPTY_EXCLUSION_CONFIG = exports.MAX_WILDCARDS = exports.MAX_PATTERN_LENGTH = exports.MAX_USER_PATTERNS = exports.RECOMMENDED_GROUP_IDS = exports.RECOMMENDED_GROUPS = exports.ALWAYS_EXCEPTIONS = exports.ALWAYS_PATTERNS = void 0;
exports.normalizePath = normalizePath;
exports.compileRule = compileRule;
exports.validatePattern = validatePattern;
exports.sanitizeConfig = sanitizeConfig;
exports.matcherFrom = matcherFrom;
/* -------------------------------------------------------------------------
 * The non-negotiable floor
 * ---------------------------------------------------------------------- */
/**
 * Credentials. These cannot be switched off, and a "!" rule cannot re-open
 * them.
 *
 * The reasoning is not that the user should not be trusted with the choice —
 * it is that the cost of the choice is not theirs alone. A model that reads
 * `.env` puts that key in a prompt, which goes to a provider, which may log
 * it; on a shared deployment the blast radius reaches other people's accounts.
 * A toggle whose worst case is "a third party now has your production database
 * password" should not be one click away in a settings panel.
 *
 * Every entry is basename-style on purpose. See the PATH CONTRACT note above:
 * it means these still fire when a call site passes an absolute path.
 */
exports.ALWAYS_PATTERNS = [
    // Environment files. `*.env` catches the `user_local.env` spelling too.
    ".env",
    ".env.*",
    "*.env",
    ".envrc",
    // Private keys and certificate bundles.
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.jks",
    "*.keystore",
    "*.ppk",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    // Whole directories that exist to hold credentials.
    ".ssh/",
    ".aws/",
    ".gnupg/",
    // Conventional credential filenames.
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    "credentials",
    "credentials.json",
    "secret.json",
    "secrets.json",
    "secrets.yaml",
    "secrets.yml",
    "service-account*.json",
    "*serviceaccount*.json",
    /* This project's own two: `providers.json` has held live provider keys in
     * plaintext and `user_local.env` holds the gateway key. Named explicitly
     * because neither matches a generic secret convention — `providers.json`
     * reads like ordinary config, which is exactly why it got missed. */
    "providers.json",
    "user_local.env",
];
/**
 * The placeholder files whose entire purpose is to be committed and read.
 *
 * Without this carve-out `.env.*` would hide `.env.example`, and that file is
 * how a project documents which variables exist. The model would then have to
 * guess config names, or ask the user to paste the file in by hand — which is
 * a worse outcome for privacy than reading the placeholder, not a better one.
 *
 * Checked before ALWAYS, so it is the one thing that lifts the floor — but only
 * the floor. Group and user rules still apply afterwards, so a dependency's own
 * `.env.example` stays hidden with the dependencies group on, and a user who
 * wants their placeholder hidden can say so. See `decide`.
 *
 * THE COMPOUND SPELLINGS ARE NOT OPTIONAL
 *
 * The first version of this list held only the bare names, and `.env.*` in
 * ALWAYS quietly swallowed `.env.production.example` — a file whose entire
 * purpose is to be read, sitting in this repo, hidden with no way for the user
 * to unhide it, because "!" cannot negate an ALWAYS rule. An over-block the
 * user cannot undo is worse than one they can, so the environment-file
 * spellings are matched with a glob in the middle rather than enumerated.
 *
 * The globs stay anchored to the `.env` prefix and a placeholder suffix. A bare
 * `*.example` was considered and rejected: it would let any filename ending in
 * `.example` skip the credential floor, and filenames inside a repo are not
 * always written by the person the rules are protecting.
 */
exports.ALWAYS_EXCEPTIONS = [
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.dist",
    ".env.defaults",
    "env.example",
    "example.env",
    "sample.env",
    // `.env.production.example`, `.env.staging.sample`, and so on.
    ".env.*.example",
    ".env.*.sample",
    ".env.*.template",
    ".env.*.dist",
    ".env.*.defaults",
    // The reversed convention: `.env.example.production`.
    ".env.example.*",
    ".env.sample.*",
    ".env.template.*",
];
/* -------------------------------------------------------------------------
 * The recommended set — on by default, every one of them switchable
 * ---------------------------------------------------------------------- */
/**
 * These are noise, not secrets. Excluding them is mostly about cost and
 * attention: a listing that is 90% `node_modules` crowds the real files out of
 * the context window, and a model that reads a lockfile has spent thousands of
 * tokens learning nothing.
 *
 * All default ON, all switchable, because every one of them has a legitimate
 * "actually, today I do need that" case — debugging a dependency, reading a
 * build artefact, auditing a lockfile diff.
 */
exports.RECOMMENDED_GROUPS = [
    {
        id: "deps",
        label: "Dependencies",
        blurb: "Installed packages. Huge, and not your code.",
        patterns: [
            "node_modules/",
            "bower_components/",
            "vendor/",
            ".pnpm-store/",
            ".yarn/",
            "Pods/",
            ".venv/",
            "venv/",
            "__pycache__/",
            ".gradle/",
        ],
    },
    {
        id: "vcs",
        label: "Version control internals",
        blurb: "The .git object store — not your history, just the plumbing.",
        patterns: [".git/", ".hg/", ".svn/"],
    },
    {
        id: "build",
        label: "Build output",
        blurb: "Generated on every build. Editing it never survives.",
        patterns: [
            ".next/",
            "dist/",
            "build/",
            "out/",
            "target/",
            ".turbo/",
            ".cache/",
            ".parcel-cache/",
            "coverage/",
            ".nyc_output/",
            "*.tsbuildinfo",
        ],
    },
    {
        id: "lockfiles",
        label: "Lockfiles",
        blurb: "Thousands of lines a model cannot usefully act on.",
        patterns: [
            "package-lock.json",
            "yarn.lock",
            "pnpm-lock.yaml",
            "bun.lockb",
            "Cargo.lock",
            "poetry.lock",
            "composer.lock",
            "Gemfile.lock",
        ],
    },
    {
        id: "binaries",
        label: "Binaries and media",
        blurb: "Images, fonts, archives, compiled objects.",
        patterns: [
            "*.png",
            "*.jpg",
            "*.jpeg",
            "*.gif",
            "*.webp",
            "*.avif",
            "*.ico",
            "*.bmp",
            "*.tiff",
            "*.mp4",
            "*.mov",
            "*.avi",
            "*.webm",
            "*.mp3",
            "*.wav",
            "*.flac",
            "*.woff",
            "*.woff2",
            "*.ttf",
            "*.otf",
            "*.eot",
            "*.zip",
            "*.tar",
            "*.gz",
            "*.bz2",
            "*.7z",
            "*.rar",
            "*.exe",
            "*.dll",
            "*.so",
            "*.dylib",
            "*.class",
            "*.jar",
            "*.wasm",
            "*.psd",
            "*.sketch",
            "*.fig",
        ],
    },
    {
        id: "localdata",
        label: "Local databases and dumps",
        blurb: "SQLite files and dumps often hold real customer data.",
        patterns: [
            "*.sqlite",
            "*.sqlite3",
            "*.db",
            "*.db-wal",
            "*.db-shm",
            "*.mdb",
            "*.dump",
            "*.bak.sql",
        ],
    },
    {
        id: "backups",
        label: "Backups and editor junk",
        blurb: "Stale copies. Editing one is a change that goes nowhere.",
        patterns: [
            ".omniroute-backups/",
            "*_backup.*",
            "*backup_*",
            "smart-backup-*",
            "*.bak",
            "*.orig",
            "*.rej",
            "*~",
            ".DS_Store",
            "Thumbs.db",
            "*.log",
            "logs/",
        ],
    },
];
exports.RECOMMENDED_GROUP_IDS = exports.RECOMMENDED_GROUPS.map((g) => g.id);
/* -------------------------------------------------------------------------
 * Limits
 * ---------------------------------------------------------------------- */
/** Enough for a pasted .gitignore with room to spare; small enough to compile
 *  on every request without thinking about it. */
exports.MAX_USER_PATTERNS = 300;
exports.MAX_PATTERN_LENGTH = 300;
/** A pattern is compiled to a RegExp. Runaway wildcard counts are the one way
 *  a user could hand themselves a pathological match cost. */
exports.MAX_WILDCARDS = 40;
exports.EMPTY_EXCLUSION_CONFIG = {
    patterns: [],
    disabledGroups: [],
    updatedAt: 0,
};
/* -------------------------------------------------------------------------
 * Glob -> RegExp
 * ---------------------------------------------------------------------- */
/** Escape one literal character for use inside a RegExp source string. */
function escapeLiteral(ch) {
    return /[.*+?^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
}
/**
 * Translate a glob body into a RegExp source fragment.
 *
 * Written as a character scan rather than a chain of `.replace()` calls
 * because the replace approach cannot tell a `*` that the user typed from a
 * `*` that an earlier replacement just emitted, which is how glob translators
 * usually end up matching across directory separators by accident.
 */
function compileGlobBody(glob) {
    let out = "";
    let i = 0;
    while (i < glob.length) {
        const ch = glob[i];
        if (ch === "*") {
            let stars = 0;
            while (glob[i] === "*") {
                stars++;
                i++;
            }
            if (stars >= 2) {
                if (glob[i] === "/") {
                    // Two stars followed by a slash means zero or more WHOLE segments,
                    // which is what lets a two-star prefix also match at the top level.
                    // Consuming the slash here is what makes the "zero" case work.
                    i++;
                    out += "(?:[^/]*/)*";
                }
                else {
                    out += ".*";
                }
            }
            else {
                out += "[^/]*";
            }
            continue;
        }
        if (ch === "?") {
            out += "[^/]";
            i++;
            continue;
        }
        if (ch === "[") {
            const end = glob.indexOf("]", i + 1);
            if (end === -1) {
                // Unclosed class: treat the bracket as a literal rather than throwing.
                out += "\\[";
                i++;
                continue;
            }
            let cls = glob.slice(i + 1, end);
            if (cls.startsWith("!"))
                cls = "^" + cls.slice(1);
            /* A backslash inside a class would escape our own closing bracket. */
            out += "[" + cls.replace(/\\/g, "\\\\") + "]";
            i = end + 1;
            continue;
        }
        out += escapeLiteral(ch);
        i++;
    }
    return out;
}
/**
 * Normalise a path for matching: forward slashes, no leading "./" or "/",
 * no trailing "/".
 *
 * Note what this does NOT do: it does not resolve "..". Path traversal is
 * `guardPath`'s job in vscodeBridge and `assertInsideRoot`'s in the extension,
 * and quietly collapsing segments here would paper over a caller that skipped
 * those — a bug worth keeping visible.
 */
function normalizePath(p) {
    return String(p ?? "")
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/^\/+/, "")
        .replace(/\/+$/, "")
        .trim();
}
/**
 * Compile one pattern. Returns null for blanks and comments, so a pasted
 * .gitignore can be fed in unfiltered.
 */
function compileRule(pattern, origin, groupId) {
    let raw = String(pattern ?? "").trim();
    if (!raw || raw.startsWith("#"))
        return null;
    let negated = false;
    if (raw.startsWith("!")) {
        negated = true;
        raw = raw.slice(1).trim();
    }
    raw = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    let dirOnly = false;
    if (raw.endsWith("/")) {
        dirOnly = true;
        raw = raw.replace(/\/+$/, "");
    }
    if (!raw)
        return null;
    /* gitignore's rule: a slash anywhere but the end anchors the pattern to the
     * root. Without a slash it is a basename rule and applies at any depth. */
    const anchored = raw.includes("/");
    const prefix = anchored ? "" : "(?:.*/)?";
    const body = compileGlobBody(raw);
    return {
        pattern,
        negated,
        dirOnly,
        origin,
        groupId,
        reSelf: new RegExp("^" + prefix + body + "$", "i"),
        reUnder: new RegExp("^" + prefix + body + "/.*$", "i"),
    };
}
function compileList(patterns, origin, groupId) {
    const out = [];
    for (const p of patterns) {
        const rule = compileRule(p, origin, groupId);
        if (rule)
            out.push(rule);
    }
    return out;
}
/** Does this rule match this path? `isDir` only matters for "dir/" rules. */
function ruleMatches(rule, path, isDir) {
    if (rule.reUnder.test(path))
        return true;
    if (rule.dirOnly && !isDir)
        return false;
    return rule.reSelf.test(path);
}
/* -------------------------------------------------------------------------
 * The matcher
 * ---------------------------------------------------------------------- */
/**
 * Anything that is not an array of strings becomes an empty list.
 *
 * WHY THIS IS NOT PARANOIA
 *
 * `ExclusionMatcher` used to do `new Set(config.disabledGroups ?? [])` and
 * `compileList(config.patterns ?? [])` directly. Both are fine against a
 * well-formed config and both THROW against a malformed one — `new Set(42)` is
 * a TypeError, and so is iterating a string with `compileList`. `??` does not
 * help, because the wrong TYPE is not null.
 *
 * The server never sends a malformed config (SQLite rows go through
 * `parseArray`, HTTP bodies through `sanitizeConfig`), which is exactly why
 * this went unnoticed: it was only reachable from the extension, where the
 * config arrives over a WebSocket from another process. A constructor that
 * throws there aborts the RPC and leaves the editor on whatever rules it had
 * before — safe, but silent, and "my exclusions did not apply" with no visible
 * error is the least debuggable outcome this feature can produce.
 *
 * `matcherFrom` is documented as taking loose input. This makes that true.
 */
function asStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((entry) => typeof entry === "string");
}
class ExclusionMatcher {
    /**
     * CALL-SITE CONTRACT: pass `isDir` when the path came from a directory
     * listing.
     *
     * A trailing-slash rule ("node_modules/") is directory-only, so with
     * `isDir` left at false the row for `node_modules` itself is NOT hidden —
     * only its contents are. That is correct gitignore behaviour and it is kept
     * deliberately, because the alternative is guessing from the absence of a
     * file extension and then hiding a real file someone named `dist`. The cost
     * of the strict reading is one stray row in a listing; the cost of guessing
     * is a file the user cannot reach and cannot explain.
     */
    always;
    exceptions;
    /** Group rules then user rules, in that order. Last match wins. */
    rules;
    config;
    constructor(config) {
        /* Normalised once, here, and stored normalised. Every later reader —
         * `promptSummary`, the settings panel, the RPC reply that reports how many
         * rules took effect — then works on real arrays without repeating the
         * check, and `this.config` cannot disagree with the rules compiled from
         * it. */
        this.config = {
            patterns: asStringArray(config?.patterns),
            disabledGroups: asStringArray(config?.disabledGroups),
            updatedAt: typeof config?.updatedAt === "number" && Number.isFinite(config.updatedAt)
                ? config.updatedAt
                : 0,
        };
        this.always = compileList(exports.ALWAYS_PATTERNS, "always");
        this.exceptions = compileList(exports.ALWAYS_EXCEPTIONS, "always");
        const disabled = new Set(this.config.disabledGroups);
        const rules = [];
        for (const group of exports.RECOMMENDED_GROUPS) {
            if (disabled.has(group.id))
                continue;
            rules.push(...compileList(group.patterns, "group", group.id));
        }
        rules.push(...compileList(this.config.patterns, "user"));
        this.rules = rules;
    }
    /**
     * The whole decision, in the order that makes the floor a floor.
     *
     *   1. a placeholder exception  -> exempt from ALWAYS, but NOT from the rest
     *   2. an ALWAYS rule           -> excluded, and nothing below can undo it
     *   3. group + user rules       -> last match wins, "!" re-allows
     *
     * WHY AN EXCEPTION ONLY LIFTS THE FLOOR
     *
     * It used to return "allowed" outright, which made the exception list the
     * strongest thing in the engine — stronger than the user's own rules. Two
     * things were wrong with that. A user could not hide `.env.example` even by
     * naming it explicitly, in their own repo, which contradicts the promise
     * this feature is making. And a dependency shipping its own `.env.example`
     * got read out of `node_modules` even with the dependencies group on,
     * because the exception outranked the group.
     *
     * Exempting from ALWAYS and then continuing is what the list was actually
     * for: `.env.example` is not a credential, so the credential floor should
     * not claim it — but it is still an ordinary file, and ordinary rules still
     * decide.
     */
    decide(path, isDir = false) {
        const p = normalizePath(path);
        if (!p)
            return { excluded: false };
        let floorExempt = false;
        for (const rule of this.exceptions) {
            if (ruleMatches(rule, p, isDir)) {
                floorExempt = true;
                break;
            }
        }
        if (!floorExempt) {
            for (const rule of this.always) {
                if (ruleMatches(rule, p, isDir)) {
                    return {
                        excluded: true,
                        rule,
                        reason: `"${p}" is blocked by a built-in credential rule (${rule.pattern}). ` +
                            `This one cannot be switched off — reading it would put a secret into ` +
                            `a prompt. Paste the specific value you want used, or use ` +
                            `.env.example instead.`,
                    };
                }
            }
        }
        let verdict = null;
        for (const rule of this.rules) {
            if (ruleMatches(rule, p, isDir))
                verdict = rule;
        }
        if (!verdict || verdict.negated)
            return { excluded: false, rule: verdict ?? undefined };
        const where = verdict.origin === "user"
            ? "one of your own exclusion rules"
            : `the "${groupLabel(verdict.groupId)}" exclusion group`;
        return {
            excluded: true,
            rule: verdict,
            reason: `"${p}" is excluded by ${where} (${verdict.pattern}). ` +
                `Change this in Settings -> File access.`,
        };
    }
    /** The hot path: most callers only need the boolean. */
    test(path, isDir = false) {
        return this.decide(path, isDir).excluded;
    }
    /** Drop excluded entries from a listing. */
    filter(items, getPath, isDir) {
        return items.filter((item) => !this.test(getPath(item), isDir ? isDir(item) : false));
    }
    /**
     * A short description for the model's system prompt.
     *
     * Telling the model up front is not a security control — the enforcement is
     * the dispatcher refusing — but it stops a whole class of wasted turn where
     * the model reads a refusal, assumes a transient error, and tries the same
     * file three more ways.
     */
    promptSummary() {
        const groups = exports.RECOMMENDED_GROUPS.filter((g) => !(this.config.disabledGroups ?? []).includes(g.id)).map((g) => g.label.toLowerCase());
        const lines = [
            "FILE ACCESS LIMITS (enforced by the tool layer, not advisory):",
            "- Credential files (.env, private keys, credentials.json and similar) always refuse to open.",
        ];
        if (groups.length)
            lines.push(`- These are hidden from listings and reads: ${groups.join(", ")}.`);
        const userPatterns = (this.config.patterns ?? []).filter((p) => p.trim() && !p.trim().startsWith("#"));
        if (userPatterns.length) {
            const shown = userPatterns.slice(0, 20).join(", ");
            const more = userPatterns.length > 20 ? `, +${userPatterns.length - 20} more` : "";
            lines.push(`- The user has also excluded: ${shown}${more}.`);
        }
        lines.push("- A refusal here is final. Do not retry the same file by another tool or another spelling; ask the user for what you need instead.");
        return lines.join("\n");
    }
}
exports.ExclusionMatcher = ExclusionMatcher;
function groupLabel(id) {
    return exports.RECOMMENDED_GROUPS.find((g) => g.id === id)?.label ?? id ?? "recommended";
}
/* -------------------------------------------------------------------------
 * Validation, for the API route and the settings UI
 * ---------------------------------------------------------------------- */
/** Returns an error sentence, or null when the pattern is usable. */
function validatePattern(pattern) {
    const raw = String(pattern ?? "");
    if (raw.length > exports.MAX_PATTERN_LENGTH) {
        return `Too long (max ${exports.MAX_PATTERN_LENGTH} characters).`;
    }
    if (raw.includes("\0"))
        return "Contains a null byte.";
    if ((raw.match(/[*?]/g) || []).length > exports.MAX_WILDCARDS) {
        return `Too many wildcards (max ${exports.MAX_WILDCARDS}).`;
    }
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#"))
        return null; // blank/comment: dropped, not an error
    if (trimmed === "!")
        return "A rule cannot be just \"!\".";
    try {
        compileRule(raw, "user");
    }
    catch {
        return "Not a valid pattern.";
    }
    return null;
}
/**
 * Take whatever the client sent and return something safe to store.
 *
 * Bad patterns are dropped and reported rather than rejecting the whole
 * request: a user pasting a 200-line .gitignore should not lose all of it
 * because line 84 has a stray null byte.
 */
function sanitizeConfig(input) {
    const obj = (input ?? {});
    const errors = [];
    const rawPatterns = Array.isArray(obj.patterns) ? obj.patterns : [];
    const patterns = [];
    const seen = new Set();
    for (const entry of rawPatterns) {
        if (typeof entry !== "string")
            continue;
        if (patterns.length >= exports.MAX_USER_PATTERNS) {
            errors.push({
                pattern: entry,
                error: `Dropped — the list is capped at ${exports.MAX_USER_PATTERNS} rules.`,
            });
            continue;
        }
        const error = validatePattern(entry);
        if (error) {
            errors.push({ pattern: entry, error });
            continue;
        }
        const key = entry.trim();
        if (!key)
            continue;
        /* Comments are kept verbatim (they carry the user's own notes) but are not
         * deduplicated, since two identical "# secrets" headers are meaningful. */
        if (!key.startsWith("#")) {
            if (seen.has(key.toLowerCase()))
                continue;
            seen.add(key.toLowerCase());
        }
        patterns.push(key);
    }
    const rawGroups = Array.isArray(obj.disabledGroups) ? obj.disabledGroups : [];
    const disabledGroups = rawGroups
        .filter((g) => typeof g === "string")
        .filter((g) => exports.RECOMMENDED_GROUP_IDS.includes(g));
    return {
        config: {
            patterns,
            disabledGroups: Array.from(new Set(disabledGroups)),
            updatedAt: Date.now(),
        },
        errors,
    };
}
/** Convenience for callers that just want a matcher from loose input. */
function matcherFrom(config) {
    return new ExclusionMatcher({
        patterns: config?.patterns ?? [],
        disabledGroups: config?.disabledGroups ?? [],
        updatedAt: config?.updatedAt ?? 0,
    });
}
/**
 * The matcher used when there is no user context at all — a background job, a
 * single-user install before anyone has saved settings.
 *
 * Defaults to the full recommended set rather than to nothing, because the
 * failure modes are not symmetrical: over-excluding wastes a turn, and
 * under-excluding leaks.
 */
exports.DEFAULT_MATCHER = matcherFrom(exports.EMPTY_EXCLUSION_CONFIG);
//# sourceMappingURL=fileExclusions.js.map