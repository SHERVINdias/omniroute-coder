# Complete Implementation Plan: Phase-Based Agentic Coding System

## Codebase Audit Summary

After deep analysis of the entire project, here is the mapping of what exists, what is partial, and what is missing across all six layers of the specification.

---

## LAYER-BY-LAYER FEATURE MATRIX

### ✅ = Already Done | 🟡 = Partially Done | ❌ = Not Built

| Feature | Status | Location | Notes |
|---------|--------|----------|-------|
| Plan Approval UI | 🟡 | `PlanApprovalCard.tsx` | Single-task plan/approve exists; multi-phase sequencing, DAG visualization, dependency graphs, and "Advance to Next Phase" gate do NOT exist |
| Code Editor & Diff Viewer | ❌ | — | No in-browser file editor or side-by-side diff viewer; edits go directly via `vscodeBridge.ts` to disk |
| Interactive Terminal (xterm.js) | ❌ | — | No terminal at all; the agent cannot execute commands (`require_setup` tool explicitly states "you cannot run commands") |
| File Tree with Security Badges | 🟡 | `vscodeBridge.ts` | File listing exists (`list_files`, `walkWorkspace`); `.aiignore` support and lock badges do NOT exist |
| HITL Bypass Modal | ❌ | — | No human-in-the-loop interruption modal for rule violations |
| Phase Decomposition & DAG Engine | ❌ | — | No phase plan parser, no DAG, no phase-scoped LLM context restriction |
| ReAct State Machine | 🟡 | `deepCoworkPipeline.ts` | Has `PipelineStage` ("planning"/"executing"/"verifying"/"synthesizing") but NOT the full state machine (IDLE, PHASE_INITIALIZATION, AWAITING_PHASE_GATE, AWAITING_HITL, etc.) |
| Universal LLM Gateway | ✅ | `upstreamRequest.ts`, `providerProfiles.ts`, `anthropicAdapter.ts`, `omniroute.ts` | Normalizes across OpenAI, Anthropic, Azure, local gateways; tool-calling stream parsing works |
| Phase-Isolated Context Compactor | ❌ | — | Context isn't purged between phases; there's a `renderTaskForPrompt()` function but no token-budget-aware compaction or phase-level memory isolation |
| Checkpoint 1: Secret Masking | ❌ | — | No regex entropy scanner, no credential redaction on outgoing tool inputs |
| Checkpoint 1: Access Controller (.aiignore) | ❌ | — | `IGNORED_DIRS`/`IGNORED_FILE_EXT` exist as hardcoded sets in `vscodeBridge.ts`, but there is no `.aiignore` file parser or per-file exclusion toggles |
| Checkpoint 2: .agentrules Injector | ❌ | — | No `.agentrules` file parsing or system prompt injection of enterprise rules |
| Checkpoint 3: Pre-Completion Auditor | 🟡 | `deepCoworkPipeline.ts` (Ultra mode reviewer) | An independent reviewer pass exists in Ultra mode. It does a general code review with severity ratings. It does NOT cover the 5 specified security domains (Gitleaks, Bearer, ECC Production, Trail of Bits, Red Team) |
| Checkpoint 4: HITL Interruption Router | ❌ | — | No AWAITING_HITL state, no master locks, no bypass logic, no audit log |
| Checkpoint 5: Phase Gate Controller | 🟡 | `PlanApprovalCard.tsx` + `deepCoworkPipeline.ts` | Has plan → approve → execute for a SINGLE task. Does not have multi-phase gate with verification commands, auto-advance, or phase N → phase N+1 transitions |
| Tool Registry (fs_read_file, fs_apply_diff, etc.) | ✅ | `vscodeBridge.ts` | `read_file`, `replace_text`, `write_file`, `list_files` all exist. `workspace_search` (grep) does NOT exist. `terminal_run` does NOT exist. `phase_complete` / `task_complete` do NOT exist |
| Memory & Vector RAG | ❌ | — | Knowledge files exist on disk (`.omniroute/knowledge/`), but there is no in-browser vector store, no embedding, no re-indexing |
| Phase Trajectory Cache | 🟡 | `agentContext.ts` | Task artifacts record reads/edits/failures per run, but there is no per-phase purge of transient logs |
| WebContainers Sandbox | ❌ | — | No WebContainer, no in-browser Node.js; everything runs on the host filesystem directly |

---

## IMPLEMENTATION PHASES

Each phase below is scoped to ~1-2 weeks of focused work. Dependencies between phases are clearly stated.

---

### PHASE 1: Foundation — Config Schemas, .aiignore, .agentrules
**Dependencies:** None  
**Estimated effort:** 1 week  
**Files to create/modify:**

#### 1.1 Phase Plan Schema Parser ❌ NEW
**Create:** `src/lib/phasePlan.ts`

```
Purpose: Parse uploaded phase plans (.json, .yaml, .md) into a structured
DAG of phases and sub-tasks. Each phase has:
  - phase_id, name, target_files[], tasks[], verification_command
  - dependencies (edges in the DAG)

Implementation:
  - JSON parser (native)
  - YAML parser (use `js-yaml` — add as dependency)
  - Markdown parser (regex-based extraction of structured headings)
  - Validate against PhasePlan schema
  - Build adjacency list for DAG
  - Topological sort to determine execution order
  - Export: PhasePlan, Phase, PhaseTask, parsePhaseFile(), buildDAG(), nextExecutablePhase()
```

#### 1.2 .aiignore Parser ❌ NEW
**Create:** `src/lib/aiignore.ts`

```
Purpose: Parse .aiignore files (gitignore-compatible glob syntax) and
UI exclusion toggles into a matcher function.

Implementation:
  - Read .aiignore from workspace root
  - Parse glob patterns (use `minimatch` or `picomatch`)
  - Combine with hardcoded IGNORED_DIRS/IGNORED_FILE_EXT from vscodeBridge.ts
  - Export: loadAiIgnore(root), isExcluded(path), getExclusionList()
  - Integrate into executeWorkspaceTool() as a pre-check
```

**Modify:** `src/lib/vscodeBridge.ts`
```
- In executeWorkspaceTool(), before any file read/write, check isExcluded()
- If excluded, return { success: false, error: "Access denied: path is excluded by .aiignore" }
- In walkWorkspace(), annotate excluded entries with a `locked: true` flag
```

#### 1.3 .agentrules Loader ❌ NEW
**Create:** `src/lib/agentrules.ts`

```
Purpose: Load and parse .agentrules from workspace root.

Implementation:
  - Read .agentrules (JSON format) from workspace root
  - Validate against AgentRules schema
  - Extract company_rules, security_level, master_locks
  - Format as system prompt injection text
  - Export: loadAgentRules(root), formatRulesForPrompt(rules), AgentRules type
```

#### 1.4 Audit Log Infrastructure ❌ NEW
**Create:** `src/lib/auditLog.ts`

```
Purpose: Write structured audit entries to .agent/audit.log

Implementation:
  - Append-only JSONL file at <workspace>/.agent/audit.log
  - Schema: { timestamp, phase_id, rule_id, bypassed_by, scope, file, risk_summary }
  - Export: appendAuditEntry(), readAuditLog(), AuditEntry type
  - Rotation/size cap (max 1MB, rename to .audit.log.1)
```

---

### PHASE 2: Security Layer — Secret Scanner & Access Control
**Dependencies:** Phase 1 (aiignore parser, audit log)  
**Estimated effort:** 1 week

#### 2.1 Regex Entropy Scanner ❌ NEW
**Create:** `src/lib/secretScanner.ts`

```
Purpose: Scan outgoing tool inputs for raw credentials and redact them.

Checkpoint 1 implementation:
  - Regex patterns for:
    - AWS access keys (AKIA...)
    - RSA/SSH private keys (-----BEGIN ... KEY-----)
    - Database URIs (postgres://, mysql://, mongodb://)
    - API tokens (sk-..., ghp_..., glpat-..., etc.)
    - Generic high-entropy strings (Shannon entropy > 4.5 on 20+ char strings)
    - NEXT_PUBLIC_ prefixed secrets
  - Replace matches with [REDACTED_SECRET]
  - Export: scanAndRedact(text), findSecrets(text) -> SecretMatch[]
  - Log redactions to audit log
```

**Modify:** `src/lib/deepCoworkPipeline.ts`
```
- Before every postStream() call, run scanAndRedact() on all message contents
- Before returning tool results to the model, scanAndRedact() the result text
```

#### 2.2 Access Controller Integration ❌ NEW
**Modify:** `src/lib/vscodeBridge.ts`

```
- Import aiignore module from Phase 1.2
- Add getAccessController() that merges .aiignore + UI exclusions
- In executeWorkspaceTool() for read_file, replace_text, write_file:
  - Call isExcluded(path) before any I/O
  - If excluded: return authorization error
  - Log access denial to audit log
```

---

### PHASE 3: Expanded ReAct State Machine & Phase Sequencing Engine
**Dependencies:** Phase 1 (phase plan parser)  
**Estimated effort:** 2 weeks

#### 3.1 Full ReAct State Machine ❌ NEW
**Create:** `src/lib/phaseStateMachine.ts`

```
Purpose: Formal state machine governing the entire phase-based execution flow.

States:
  IDLE → PHASE_INITIALIZATION → PLANNING → TOOL_CALLING → OBSERVING →
  PHASE_VERIFICATION → AUDITING → AWAITING_PHASE_GATE → AWAITING_HITL →
  ALL_PHASES_COMPLETED

Transitions:
  - Each transition has guards (conditions) and effects (side effects)
  - AWAITING_HITL: entered when auditor finds violations
  - AWAITING_PHASE_GATE: entered when phase N passes verification

Implementation:
  - TypeScript discriminated union for states
  - transition(currentState, event) -> newState function
  - Side effects dispatched as events (not embedded in transitions)
  - Export: PhaseState, PhaseEvent, createStateMachine(), transition()
```

#### 3.2 Phase Decomposition & Sequencing Engine ❌ NEW
**Create:** `src/lib/phaseSequencer.ts`

```
Purpose: Orchestrate multi-phase execution using the DAG from phasePlan.ts

Implementation:
  - Takes a PhasePlan and manages execution of Phase N
  - Restricts active LLM context to Phase N's target_files and tasks
  - Builds phase-scoped system prompt:
    "You are working on Phase N: [name]. Your scope is limited to: [target_files].
     Tasks: [tasks]. Do NOT modify files outside this scope."
  - Runs verification_command after phase completion (via terminal_run when available,
    or records it as a setup step)
  - On phase completion: transitions state machine to AWAITING_PHASE_GATE
  - On gate approval: advances to Phase N+1, purges trajectory cache

  Export: PhaseSequencer class with methods:
    - loadPlan(plan: PhasePlan)
    - currentPhase(): Phase
    - phaseContext(): string (system prompt segment)
    - completeCurrentPhase(results)
    - advanceToNextPhase()
    - isAllComplete(): boolean
```

#### 3.3 Integrate into Deep Cowork Pipeline 🟡 MAJOR MODIFICATION
**Modify:** `src/lib/deepCoworkPipeline.ts`

```
Changes:
  - Add `phaseplan?: PhasePlan` to DeepCoworkOptions
  - When phaseplan is provided, wrap the existing pipeline loop in a phase loop:
    for each phase in topological order:
      1. Build phase-scoped context (target_files only)
      2. Inject .agentrules into system prompt
      3. Run existing tool loop (budget, failover, etc. all preserved)
      4. On completion: enter PHASE_VERIFICATION
      5. Run verification (or record it)
      6. Enter AUDITING (Phase 5 - security auditor)
      7. Enter AWAITING_PHASE_GATE
      8. Wait for gate signal (yielded as new event kind)
      9. Purge trajectory, advance

  - Add new event kinds:
    - { kind: "phase_status", phaseId, status, progress }
    - { kind: "phase_gate", phaseId, passed, awaitingApproval }
    - { kind: "hitl_request", ruleId, severity, description, file, line }

  - Add new tool definitions:
    - phase_complete(phase_id, summary)
    - task_complete(summary)
```

---

### PHASE 4: Security Auditor Agent (5 Domains)
**Dependencies:** Phase 1 (audit log), Phase 2 (secret scanner), Phase 3 (state machine)  
**Estimated effort:** 2 weeks

#### 4.1 Multi-Domain Security Auditor ❌ NEW
**Create:** `src/lib/securityAuditor.ts`

```
Purpose: Pre-completion auditor covering 5 security domains.
Extends the existing Ultra mode reviewer with structured domain checks.

Domain 1: Secret Leak Prevention (Gitleaks-style)
  - Reuse secretScanner.ts patterns against the diff
  - Check for hardcoded passwords, API keys, DB connection strings
  - Check for NEXT_PUBLIC_ prefixed secrets
  - Check for un-redacted console.log of sensitive data

Domain 2: Personal Data Flow (Bearer-style)
  - Trace PII paths in changed files
  - Verify password hashing (bcrypt/argon2 usage, no plaintext)
  - Check for sensitive data in logs
  - Verify httpOnly/secure cookie flags

Domain 3: Pre-Deploy Production (ECC Production Audit)
  - Check for environment variable fallbacks
  - Detect debug endpoints (/test, /admin-backdoor, /debug)
  - Verify production error handling (no stack traces to client)
  - Check for security headers (helmet, CSP, HSTS)
  - Verify rate limiting presence
  - Check CORS configuration

Domain 4: Logic & Auth Audit (Trail of Bits-style)
  - Look for IDOR vulnerabilities in routes
  - Verify server-side payment verification
  - Check token invalidation on logout
  - Verify parameterized SQL queries (no string concatenation)

Domain 5: Attacker's Perspective (Red Team)
  - Check for privilege escalation paths
  - Look for authentication bypasses
  - Scan for XSS/injection vectors
  - Identify business logic flaws

Implementation approach:
  - Each domain is a separate function that takes the diff + file contents
  - Uses LLM-as-judge: constructs a domain-specific audit prompt
  - Sends to the reviewer model (reuses reviewModelCandidates from pipeline)
  - Parses structured findings with severity ratings
  - Aggregates across all 5 domains

  Export: runSecurityAudit(creds, model, changedFiles, workspaceContext) -> AuditResult
```

#### 4.2 HITL Interruption Router ❌ NEW
**Create:** `src/lib/hitlRouter.ts`

```
Purpose: Route audit violations to the UI for human decision.

Implementation:
  - Takes AuditResult from securityAuditor
  - For each violation:
    - Check if rule_id is in master_locks (from .agentrules)
    - If master lock: bypass is disabled, must fix
    - If not master lock: offer Fix/Bypass Once/Bypass Session/Bypass Permanent
  - Maintain sessionBypasses: Set<string> (in-memory per run)
  - On bypass: log to audit.log, inject inline code comment
  - Export: HITLRouter class, HITLDecision type, processViolations()

  Yield new pipeline event:
    { kind: "hitl_request", violations: [...], masterLocked: boolean }
  
  Accept incoming gate signal:
    { kind: "hitl_response", decisions: { ruleId: "fix" | "bypass_once" | ... }[] }
```

#### 4.3 Integrate Auditor into Pipeline
**Modify:** `src/lib/deepCoworkPipeline.ts`

```
- After phase completes and tests pass:
  1. Call runSecurityAudit() with the phase diff
  2. If violations found:
     a. Transition state machine to AWAITING_HITL
     b. Yield hitl_request event
     c. Wait for hitl_response (new generator input mechanism needed)
  3. If all passed or bypassed: proceed to AWAITING_PHASE_GATE
```

---

### PHASE 5: Presentation Layer — Phase Plan UI, HITL Modal, File Tree Badges
**Dependencies:** Phase 3 (sequencer), Phase 4 (HITL router)  
**Estimated effort:** 2 weeks

#### 5.1 Phase Plan Manager UI ❌ NEW
**Create:** `src/components/PhasePlanManager.tsx`

```
Purpose: Render uploaded phase plans with execution progress.

Features:
  - Upload phase plan file (.json, .yaml, .md)
  - Visual progress: Phase 1 ✅ Complete, Phase 2 🔄 In Progress, Phase 3 ⏳ Pending
  - Task checkboxes per phase
  - Phase dependency visualization (simple list, not full DAG graph initially)
  - "Approve & Advance to Next Phase" button
  - "Auto-Advance Phases" toggle in settings

Integration:
  - Rendered in page.tsx above the chat area when a plan is active
  - Receives phase_status and phase_gate events from the pipeline
  - Sends gate approval back via API
```

#### 5.2 HITL Bypass Modal ❌ NEW
**Create:** `src/components/HITLModal.tsx`

```
Purpose: Intercept rule violations and present to user.

Features:
  - Non-technical risk description
  - Affected code line (file:line)
  - Severity badge (blocker/major/minor)
  - Action buttons:
    - "Fix Automatically" → sends fix command back to pipeline
    - "Bypass Once" → this instance only
    - "Bypass Session" → all instances of this rule this session
    - "Bypass Permanent" → add to session bypasses
  - Master lock indicator (🔒 Fix Required — bypass disabled)
  - Audit trail shown at bottom

Integration:
  - Triggered by hitl_request pipeline events
  - Rendered as a modal overlay
  - Sends hitl_response back via API or direct callback
```

#### 5.3 File Tree with Security Badges 🟡 ENHANCEMENT
**Modify:** `src/components/WorkspaceSelector.tsx` and create `src/components/FileTree.tsx`

```
Enhancement:
  - Show file tree with 🔒 badges for .aiignore-excluded files
  - Toggle exclusion per file from UI
  - Visual distinction: excluded files are grayed out with lock icon
  - Persist UI exclusions to localStorage
  - Send exclusion list to backend with requests
```

#### 5.4 Phase Plan Event Handling in page.tsx 🟡 ENHANCEMENT
**Modify:** `src/app/page.tsx`

```
- Add phase plan upload UI (file input accepting .json, .yaml, .md)
- Handle new event kinds: phase_status, phase_gate, hitl_request
- Render PhasePlanManager when plan is active
- Render HITLModal on hitl_request events
- Add gate approval handler
- Add "Auto-Advance" setting to SettingsPanel
```

---

### PHASE 6: Tool Registry Expansion
**Dependencies:** Phase 3 (state machine)  
**Estimated effort:** 1 week

#### 6.1 workspace_search Tool ❌ NEW
**Modify:** `src/lib/vscodeBridge.ts`

```
Add workspace_search tool:
  - name: "workspace_search"
  - description: "Search across non-ignored files using regex"
  - parameters: { query: string, path?: string, max_results?: number }
  - Implementation: recursive file walk + regex match
  - Respects .aiignore exclusions
  - Returns: Array of { file, line, match, context }
  - Add to WORKSPACE_TOOLS array
```

#### 6.2 phase_complete & task_complete Tools ❌ NEW
**Modify:** `src/lib/vscodeBridge.ts` or `src/lib/deepCoworkPipeline.ts`

```
phase_complete(phase_id, summary):
  - Signals Phase N objectives are met
  - Triggers verification command
  - Triggers security audit
  - Transitions to PHASE_VERIFICATION state
  - Only offered when a phase plan is active

task_complete(summary):
  - Final signal when all phases are done
  - Triggers ALL_PHASES_COMPLETED state
  - Only offered in last phase
```

#### 6.3 terminal_run Tool (Limited) 🟡 PARTIAL
**Decision point:** The current architecture explicitly avoids command execution.
`require_setup` records commands for the developer. Full `terminal_run` requires
either WebContainers (Phase 8) or host shell access.

```
Option A (Safe): Keep require_setup as-is, add verification_command execution
  - Only runs the verification_command from the phase plan
  - Uses child_process.exec with strict sandboxing
  - Timeout, output cap, no interactive stdin
  - Only npm test/build/lint commands allowed (whitelist)

Option B (Full): Defer to Phase 8 (WebContainers)
```

**Recommended:** Option A for now, with WebContainers as a future phase.

---

### PHASE 7: Context Management & Phase-Isolated Memory
**Dependencies:** Phase 3 (sequencer, state machine)  
**Estimated effort:** 1.5 weeks

#### 7.1 Phase-Isolated Context Compactor ❌ NEW
**Create:** `src/lib/contextCompactor.ts`

```
Purpose: At the end of each phase, purge short-term memory and prepare
clean context for Phase N+1.

Implementation:
  - Takes the conversation history (activeMessages array)
  - Strips: terminal logs, intermediate thinking, tool call/result pairs
  - Preserves: final summary of Phase N, list of files changed
  - Creates a compact "Phase N Summary" message
  - Resets round budget for Phase N+1
  - Indexes code changes for retrieval

  Export: compactPhaseContext(messages, phaseResult) -> Message[]
```

#### 7.2 Phase Trajectory Cache ❌ NEW
**Modify:** `src/lib/agentContext.ts`

```
Add per-phase tracking:
  - TaskState gets new field: phases: PhaseProgress[]
  - PhaseProgress: { phaseId, status, reads, edits, failures, summary }
  - On phase completion: move current reads/edits/failures into phase record
  - Reset transient tracking for Phase N+1
  - Serialize/deserialize in task artifacts
```

#### 7.3 Knowledge Indexing (Non-Vector, Phase 1) 🟡 ENHANCEMENT
**Modify:** `src/lib/agentContext.ts`

```
Add file-change indexing at phase boundaries:
  - Record which files were changed in each phase
  - buildKnowledgeContext() pulls relevant knowledge for Phase N+1
    based on target_files overlap
  - This is the non-vector-store version; true RAG comes in Phase 9
```

---

### PHASE 8: WebContainers Execution Sandbox (OPTIONAL / FUTURE)
**Dependencies:** All previous phases  
**Estimated effort:** 3+ weeks  
**This is the most architecturally disruptive phase and may be deferred.**

#### 8.1 WebContainer Integration ❌ NEW (FUTURE)
```
This requires fundamental architectural changes:
  - Currently: Next.js server runs on host, edits host filesystem
  - WebContainers: In-browser WASM Node.js with virtual filesystem

Major considerations:
  - The current VS Code bridge model (WebSocket to extension) is incompatible
  - Would need to port the entire file operation layer
  - Would lose direct VS Code integration
  
RECOMMENDATION: Defer this to a separate project milestone. The current
host-based architecture with VS Code bridge is the more valuable product
for IDE-integrated coding assistants. WebContainers would be a separate
"web-only" mode.
```

#### 8.2 Alternative: Host Process Sandbox (Recommended) ❌ NEW
**Create:** `src/lib/processSandbox.ts`

```
Instead of WebContainers, add safe host process execution:
  - Whitelist of allowed commands (npm test, npm run build, npx eslint, etc.)
  - Timeout (30s default, configurable)
  - Output capture (stdout + stderr, capped at 50KB)
  - Working directory locked to workspace root
  - No interactive stdin
  - Uses child_process.spawn with constraints

  Export: runSandboxedCommand(command, cwd, options) -> ProcessResult
```

---

### PHASE 9: Client-Side Vector RAG (OPTIONAL / FUTURE)
**Dependencies:** Phase 7  
**Estimated effort:** 2 weeks

#### 9.1 In-Browser Vector Store ❌ NEW (FUTURE)
```
Purpose: Embed repository files for semantic retrieval.

Implementation:
  - Use Orama (MIT, TypeScript, WASM-compatible)
  - Index all non-ignored files on workspace load
  - Re-index modified files at phase boundaries
  - Query for relevant context when building phase prompts
  - Runs entirely client-side (no server dependency)

Alternative for server-side: Use SQLite FTS5 (already have better-sqlite3)
  - Lower latency, simpler implementation
  - No embedding model needed
  - Full-text search with ranking
```

---

## IMPLEMENTATION ORDER & CRITICAL PATH

```
Phase 1 ──────────────────────┐
  (Schemas, .aiignore,        │
   .agentrules, audit log)    │
          │                   │
          ▼                   │
Phase 2 ─────────┐           │
  (Secret scanner,│           │
   access control) │          │
          │        │          │
          ▼        ▼          ▼
Phase 3 ──────────────────────── (CRITICAL PATH — largest change)
  (State machine,
   phase sequencer,
   pipeline integration)
          │
          ├──────────────────────────────┐
          ▼                              ▼
Phase 4                            Phase 5
  (Security auditor,                (UI: Plan Manager,
   HITL router)                      HITL Modal, badges)
          │                              │
          └──────────┬───────────────────┘
                     ▼
               Phase 6
          (Tool expansion:
           workspace_search,
           phase_complete,
           terminal_run)
                     │
                     ▼
               Phase 7
          (Context compactor,
           trajectory cache)
                     │
                     ▼
            Phase 8 (OPTIONAL)
          (Process sandbox or
           WebContainers)
                     │
                     ▼
            Phase 9 (OPTIONAL)
          (Vector RAG)
```

---

## API ROUTE CHANGES REQUIRED

### New API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/agent/phases` | POST | Upload/parse a phase plan file |
| `/api/agent/phases` | GET | Get current phase plan status |
| `/api/agent/phases/[phaseId]/gate` | POST | Approve/reject phase gate |
| `/api/agent/phases/[phaseId]/advance` | POST | Auto-advance to next phase |
| `/api/agent/hitl` | POST | Submit HITL decision (fix/bypass) |
| `/api/agent/audit-log` | GET | Read audit log entries |
| `/api/agent/aiignore` | GET/PUT | Read/update .aiignore rules |
| `/api/agent/agentrules` | GET | Read .agentrules configuration |

### Modified API Routes

| Route | Changes |
|-------|---------|
| `/api/chat/route.ts` | Accept `phasePlan` in request body; translate new pipeline events (phase_status, phase_gate, hitl_request) |
| `/api/agent/tasks/route.ts` | Add phase-level task tracking |

---

## DATABASE SCHEMA CHANGES

No new tables are strictly required. All phase state is stored in:
1. Task artifacts on disk (`.omniroute/tasks/`)
2. Audit log on disk (`.agent/audit.log`)
3. In-memory state machine during execution

If persistence across server restarts is needed for active phase plans:
```sql
CREATE TABLE IF NOT EXISTS phase_plans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  plan_json TEXT NOT NULL,  -- serialized PhasePlan
  current_phase TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase_gate_decisions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  decision TEXT NOT NULL,  -- 'approved' | 'rejected' | 'tweaked'
  user_id TEXT NOT NULL,
  decided_at TEXT DEFAULT (datetime('now'))
);
```

---

## NEW DEPENDENCIES TO ADD

```json
{
  "js-yaml": "^4.1.0",          // Phase 1: YAML phase plan parsing
  "picomatch": "^4.0.0",        // Phase 1: .aiignore glob matching
  "orama": "^3.0.0"             // Phase 9 (optional): Vector search
}
```

---

## SETTINGS PANEL ADDITIONS

**Modify:** `src/components/SettingsPanel.tsx`

New settings section: "Phase Execution"
```
- Auto-Advance Phases: toggle (default: off)
- Show Security Audit Details: toggle (default: on)
- Security Level: dropdown (strict / moderate / permissive)
- Master Lock Rules: read-only display from .agentrules
```

---

## RISK ASSESSMENT

| Risk | Mitigation |
|------|------------|
| Phase 3 (pipeline refactor) is the riskiest change — the existing pipeline is 2137 lines and deeply intertwined | Write the phase sequencer as a wrapper AROUND the existing pipeline, not replacing it. Each phase invocation calls `runDeepCoworkPipeline()` as-is with modified context. |
| WebContainers (Phase 8) would break VS Code bridge integration | Defer WebContainers; use host process sandbox instead |
| Security auditor (Phase 4) using LLM-as-judge may be slow and expensive | Make it opt-in (tied to Ultra mode), cache results per file hash, run domains in parallel |
| HITL interruption requires bidirectional communication mid-pipeline | Use the existing SSE stream for outbound events + new API route for inbound decisions; the pipeline generator yields and waits |
| Multi-phase plans could exhaust token budgets fast | Phase-Isolated Context Compactor (Phase 7) is essential; prioritize it if budget issues emerge |

---

## TOTAL ESTIMATED EFFORT

| Phase | Effort | Priority |
|-------|--------|----------|
| Phase 1: Schemas & Config | 1 week | P0 (foundation) |
| Phase 2: Security Scanner | 1 week | P0 (security) |
| Phase 3: State Machine & Sequencer | 2 weeks | P0 (core feature) |
| Phase 4: Security Auditor & HITL | 2 weeks | P1 (enterprise) |
| Phase 5: UI Components | 2 weeks | P0 (user-facing) |
| Phase 6: Tool Expansion | 1 week | P1 (completeness) |
| Phase 7: Context Management | 1.5 weeks | P1 (quality) |
| Phase 8: Process Sandbox | 1 week (sandbox), 3+ weeks (WebContainers) | P2 (optional) |
| Phase 9: Vector RAG | 2 weeks | P2 (optional) |
| **Total (P0 + P1)** | **~10.5 weeks** | |
| **Total (all phases)** | **~13.5+ weeks** | |
