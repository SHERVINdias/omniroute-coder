"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.setExclusionConfig = setExclusionConfig;
exports.getExclusionMatcher = getExclusionMatcher;
exports.hasServerExclusions = hasServerExclusions;
exports.buildPruneGlob = buildPruneGlob;
exports.setRootResolver = setRootResolver;
exports.getWorkspaceRoot = getWorkspaceRoot;
exports.createSmartBackup = createSmartBackup;
exports.listFiles = listFiles;
exports.readFile = readFile;
exports.writeFile = writeFile;
exports.replaceText = replaceText;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const fileExclusions_1 = require("./fileExclusions");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
// 3-minute active window to prevent overwriting the backup during multi-tool
// execution chains. The backup is stored ONCE per file per window.
const SESSION_BACKUP_WINDOW_MS = 3 * 60 * 1000;
/* ---------------------------------------------------------------------------
 * Which files the model is allowed to touch
 *
 * This used to be two hardcoded regex arrays right here — BLOCKED_DIRECTORY_
 * PATTERNS and BLOCKED_FILE_PATTERNS. They were one of three denylists in the
 * product that disagreed with each other, and the only one the user could not
 * change at all, because changing it meant editing this file and rebuilding
 * the .vsix.
 *
 * The rules now come from the server. `fileExclusions.ts` next to this file is
 * a generated copy of the server's engine (scripts/sync-exclusions.mjs writes
 * it; the packager refuses to build if it has drifted), so both ends compile
 * the same patterns with the same matcher and reach the same verdict. The
 * server pushes the user's config over the bridge with a `set_exclusions` RPC
 * when a session opens and again whenever the settings are saved.
 *
 * WHY THE DEFAULT IS NOT "ALLOW EVERYTHING"
 *
 * Between activation and the first push there is a window. It is short, but it
 * is longer than zero whenever the server is mid-restart, and a matcher that
 * started empty would turn that window into a hole in the floor. So it starts
 * at DEFAULT_MATCHER, which already enforces the credential rules and every
 * recommended group; a push only ever refines it. The failure mode of this
 * choice is a file the model temporarily cannot read. The failure mode of the
 * other choice is a credential in a prompt.
 *
 * WHY THE EXTENSION ENFORCES AT ALL, GIVEN THE SERVER ALREADY DOES
 *
 * Because this is the process holding the file handle. The server checks a
 * request; this checks the action. Anything that reaches the extension by some
 * other route — a stale server build, a second client, a future tool that
 * skips the dispatcher — still cannot read the file.
 * ------------------------------------------------------------------------ */
let activeMatcher = fileExclusions_1.DEFAULT_MATCHER;
/** False until the server has pushed a config at least once. */
let serverPushed = false;
/**
 * Install the rules the server sent.
 *
 * Returns a summary rather than void so the RPC reply can tell the server what
 * the editor actually ended up with. "I sent it" and "it took effect" are
 * different claims, and only the second one is worth logging.
 */
function setExclusionConfig(config) {
    const next = (0, fileExclusions_1.matcherFrom)(config ?? null);
    activeMatcher = next;
    serverPushed = true;
    return {
        applied: true,
        patterns: next.config.patterns.length,
        disabledGroups: next.config.disabledGroups.length,
        updatedAt: next.config.updatedAt ?? 0,
    };
}
/** The rules currently in force. */
function getExclusionMatcher() {
    return activeMatcher;
}
/**
 * Whether these are the user's rules or the built-in fallback.
 *
 * Deliberately not `updatedAt > 0`: a user who has never opened the settings
 * panel has a stored `updatedAt` of 0, and that is a perfectly real config the
 * server did push. Conflating the two would report "not configured" forever.
 */
function hasServerExclusions() {
    return serverPushed;
}
/** Backups go into ONE ignored folder at the workspace root instead of the
 *  `smart-backup-page.tsx`-next-to-the-file scheme that polluted the source
 *  tree and got picked up by tsconfig / the running dev server. */
const BACKUP_DIR = ".omniroute-backups";
/**
 * The verdict for one path, plus the sentence explaining it.
 *
 * `isDir` is part of the engine's call-site contract: a trailing-slash rule
 * ("node_modules/") is directory-only, so a caller that has a directory in
 * hand must say so or the directory's own entry survives the filter. Reads and
 * writes always name a file, so they leave it false.
 *
 * The old `smart-backup-` special case is gone because it is now an ordinary
 * rule in the "Backups and editor junk" group, alongside `*_backup.*` and
 * `.omniroute-backups/` — which means the user can see it listed in the
 * settings panel and switch it off, instead of it being a surprise baked into
 * a binary.
 */
function exclusionVerdict(relativePath, isDir = false) {
    return activeMatcher.decide(String(relativePath ?? "").replace(/\\/g, "/"), isDir);
}
/**
 * A findFiles `exclude` glob built from the rules currently in force.
 *
 * This is a PERFORMANCE device, not the enforcement — every returned path is
 * still checked individually afterwards. It exists because `findFiles` is
 * capped at 5000 results and `node_modules` alone is tens of thousands of
 * files: without pruning whole directories up front the cap is spent entirely
 * on entries that are about to be filtered out, and the listing comes back
 * containing none of the user's actual source.
 *
 * It used to be a hardcoded string, which quietly re-created the very
 * disagreement this work removes — a user who switched the dependencies group
 * OFF still saw no `node_modules`, because the pruning had never heard of
 * their choice. Deriving it from the matcher makes the two agree by
 * construction.
 *
 * Only plain directory names are taken. A pattern containing a comma or a
 * brace would corrupt the brace expression, and anchored or wildcard rules are
 * cheap enough to leave to the per-entry filter.
 *
 * Exported for referenceOps, which searches a second folder and would
 * otherwise need its own copy — and a second copy of a denylist-shaped thing
 * is the exact bug this codebase spent a day removing.
 */
function buildPruneGlob(matcher) {
    const names = new Set();
    for (const rule of [...matcher.always, ...matcher.rules]) {
        if (!rule.dirOnly || rule.negated)
            continue;
        const body = rule.pattern.trim().replace(/\/+$/, "");
        if (!/^[A-Za-z0-9._+-]+$/.test(body))
            continue;
        names.add(body);
    }
    if (names.size === 0)
        return null;
    const list = [...names].sort();
    return list.length === 1 ? `**/${list[0]}/**` : `**/{${list.join(",")}}/**`;
}
let rootResolver = null;
/** Install the consent-aware resolver. Called once from `activate()`. */
function setRootResolver(resolver) {
    rootResolver = resolver;
}
/** The single source of truth for the root that every path resolves against. */
function getWorkspaceRoot() {
    if (rootResolver) {
        return rootResolver();
    }
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error("No open workspace folder found in VS Code.");
    }
    return path.resolve(workspaceFolders[0].uri.fsPath);
}
async function createGitCheckpoint(workspaceDir) {
    try {
        const gitDir = path.join(workspaceDir, ".git");
        if (!fs.existsSync(gitDir))
            return;
        await execAsync("git add -A", { cwd: workspaceDir });
        await execAsync('git commit -m "omniroute: pre-edit checkpoint"', {
            cwd: workspaceDir,
        });
    }
    catch {
        // Silently skip if git fails or repo isn't clean
    }
}
/**
 * Copies the pre-edit file into `.omniroute-backups/` at the workspace root,
 * preserving its relative path. Within the active session window an existing
 * backup is reused so a long multi-edit chain does not create a folder full of
 * snapshots; after the window a fresh one is taken.
 */
async function createSmartBackup(filePath, rootPath) {
    try {
        if (!fs.existsSync(filePath))
            return null;
        const relative = path.relative(rootPath, filePath);
        const safeRelative = relative.startsWith("..")
            ? path.basename(filePath)
            : relative;
        const backupPath = path.join(rootPath, BACKUP_DIR, `${safeRelative}.bak`);
        if (fs.existsSync(backupPath)) {
            const stats = await fs.promises.stat(backupPath);
            const ageMs = Date.now() - stats.mtimeMs;
            if (ageMs < SESSION_BACKUP_WINDOW_MS) {
                return backupPath;
            }
        }
        await fs.promises.mkdir(path.dirname(backupPath), { recursive: true });
        await fs.promises.copyFile(filePath, backupPath);
        return backupPath;
    }
    catch {
        return null;
    }
}
function assertInsideRoot(rootPath, targetPath) {
    const relative = path.relative(rootPath, targetPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Path traversal attempt detected: Access outside workspace root is forbidden.");
    }
    const rel = relative.replace(/\\/g, "/");
    const verdict = exclusionVerdict(rel);
    if (verdict.excluded) {
        /* The reason travels back verbatim because it is the only thing that says
         * WHICH rule stopped the call. A bare "access denied" reads like a
         * transient failure, so the model retries the same file two or three more
         * ways — and every retry is a full round trip at tens of thousands of
         * input tokens. Saying "final, and here is why" ends it in one. */
        throw new Error(`File access blocked: ${verdict.reason ?? `"${rel}" is excluded.`} ` +
            `This is enforced inside the editor, so no other tool or spelling will ` +
            `reach it. Ask the user for what you need instead.`);
    }
}
/**
 * List files, optionally scoped to a sub-directory.
 *
 * `dir` is relative to the workspace root ("" or "/" = the whole workspace).
 * Returned paths are ALWAYS relative to the workspace root, never to `dir`, so
 * the bridge's re-anchoring logic is a no-op and cannot invent paths. When no
 * `dir` is given the whole workspace is listed.
 */
async function listFiles(dir) {
    const rootPath = getWorkspaceRoot();
    const relDir = (dir || "")
        .replace(/\\/g, "/")
        .replace(/^\.?\/+/, "")
        .replace(/\/+$/, "");
    const matcher = activeMatcher;
    /* An excluded directory refuses as a whole rather than returning an empty
     * list. An empty list is indistinguishable from "this folder has nothing in
     * it", which teaches the model the wrong thing and invites it to create the
     * files it thinks are missing. */
    if (relDir) {
        const dirVerdict = matcher.decide(relDir, true);
        if (dirVerdict.excluded) {
            throw new Error(`File access blocked: ${dirVerdict.reason ?? `"${relDir}" is excluded.`} ` +
                `Nothing inside this directory can be listed or read.`);
        }
    }
    const rootUri = vscode.Uri.file(rootPath);
    const include = relDir ? `${relDir}/**/*` : "**/*";
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(rootUri, include), buildPruneGlob(matcher), 5000);
    const results = [];
    for (const fileUri of files) {
        const relPath = path.relative(rootPath, fileUri.fsPath).replace(/\\/g, "/");
        /* findFiles only ever returns files, so isDir stays false. Passing true
         * here would hide a file the user happens to have named "dist". */
        if (matcher.test(relPath, false)) {
            continue;
        }
        results.push({ path: relPath });
    }
    return results.sort((a, b) => a.path.localeCompare(b.path));
}
async function readFile(relativePath) {
    const rootPath = getWorkspaceRoot();
    const targetPath = path.resolve(rootPath, relativePath);
    assertInsideRoot(rootPath, targetPath);
    const fileUri = vscode.Uri.file(targetPath);
    const fileBytes = await vscode.workspace.fs.readFile(fileUri);
    const content = Buffer.from(fileBytes).toString("utf-8");
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    return {
        path: relativePath.replace(/\\/g, "/"),
        content,
        hash,
        size: fileBytes.byteLength,
    };
}
async function writeFile(relativePath, newContent) {
    const rootPath = getWorkspaceRoot();
    const targetPath = path.resolve(rootPath, relativePath);
    assertInsideRoot(rootPath, targetPath);
    const rawBackupPath = await createSmartBackup(targetPath, rootPath);
    await createGitCheckpoint(rootPath);
    const uri = vscode.Uri.file(targetPath);
    const wsEdit = new vscode.WorkspaceEdit();
    const existed = fs.existsSync(targetPath);
    if (existed) {
        const document = await vscode.workspace.openTextDocument(uri);
        const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        wsEdit.replace(uri, fullRange, newContent);
    }
    else {
        wsEdit.createFile(uri, { ignoreIfExists: true });
        wsEdit.insert(uri, new vscode.Position(0, 0), newContent);
    }
    // `applyEdit` can resolve to `true` while the change is only applied to the
    // in-memory buffer and the save silently does nothing (read-only file, stale
    // buffer, refused edit). So we never trust `applyEdit` alone: we confirm the
    // save AND that the bytes actually reached disk.
    let persisted = false;
    const applied = await vscode.workspace.applyEdit(wsEdit);
    if (applied) {
        const doc = await vscode.workspace.openTextDocument(uri);
        const saved = (await doc.save()) === true;
        if (saved) {
            try {
                const onDisk = await fs.promises.readFile(targetPath, "utf-8");
                persisted = onDisk === newContent;
            }
            catch {
                persisted = false;
            }
        }
    }
    if (!persisted) {
        // Last-resort fallback the extension can always perform: write straight to
        // disk. This guarantees the edit is never silently dropped.
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.promises.writeFile(targetPath, newContent, "utf-8");
        persisted = true;
    }
    const hash = crypto.createHash("sha256").update(newContent).digest("hex");
    const backupPath = rawBackupPath
        ? path.relative(rootPath, rawBackupPath).replace(/\\/g, "/")
        : null;
    return {
        path: relativePath.replace(/\\/g, "/"),
        success: persisted,
        hash,
        backupPath,
    };
}
async function replaceText(relativePath, oldText, newText, replaceAll = false) {
    const current = await readFile(relativePath);
    const occurrences = current.content.split(oldText).length - 1;
    if (occurrences === 0) {
        throw new Error(`Target text '${oldText.split("\n")[0].slice(0, 40)}...' not found in ${relativePath}. ` +
            `read_file the region again and copy the text verbatim, including indentation.`);
    }
    if (occurrences > 1 && !replaceAll) {
        throw new Error(`Target text appears ${occurrences} times in ${relativePath}; refusing to guess. ` +
            `Extend old_text until it is unique, or set replace_all: true if every occurrence should change.`);
    }
    const updatedContent = replaceAll
        ? current.content.split(oldText).join(newText)
        : current.content.replace(oldText, newText);
    return await writeFile(relativePath, updatedContent);
}
//# sourceMappingURL=fileOps.js.map