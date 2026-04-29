# Core Project Rules
- Follow your assigned role strictly — it defines scope and boundaries for your actions.
- After finishing a session, review all project documents (README.md, requirements.md, design.md, etc.) to ensure they reflect the current state. Stale docs mislead future sessions.
- Verify every change by running appropriate tests or scripts — never assume correctness without evidence.
- Keep the project in a clean state: no errors, warnings, or issues in formatter and linter output. A broken baseline blocks all future work.
- Follow the TDD flow described below. Skipping it leads to untested code and regressions.
- Write all documentation in English, compressed style. Brevity preserves context window.
- If you see contradictions in the request or context, raise them explicitly, ask clarifying questions, and stop. Do not guess which interpretation is correct.
- Code should follow "fail fast, fail clearly" — surface errors immediately with clear messages rather than silently propagating bad state. Unless the user requests otherwise.
- When editing CI/CD pipelines, always validate locally first — broken CI is visible to the whole team and slow to debug remotely.
- Provide evidence for your claims — link to code, docs, or tool output. Unsupported assertions erode trust.
- Use standard tools (jq, yq, jc) to process and manage structured output — they are portable and well-understood.
- Do not add fallbacks, default behaviors, or error recovery silently — if the user didn't ask for it, it's an assumption. If you believe a fallback is genuinely needed, ask the user first.
- Do not use tables in chat output — use two-level lists instead. Tables render poorly in terminal and are harder to scan.
- Solutions must not rely on mutating files under the user's home (`~/`) or on staging temporary workspace sandboxes (copies, symlink farms, rewrite-and-restore of user config) to work around missing runtime flags. If a feature would require either at runtime, keep it unsupported and document the reason — short-term capability is not worth the concurrency, crash-recovery, and auth-drift cost. Research and experiments are exempt (temp dirs are fine); touching `~/` for experiments is allowed only with an explicit backup-and-restore of anything you change, so a crash cannot corrupt user state.

---

# AGENTS.md — @korchasa/ai-ide-cli

Thin Deno/TypeScript wrapper library around agent-CLI runtimes
(Claude Code, OpenCode, Cursor, Codex) plus a HITL MCP server and skill parser.
Published on JSR as [`@korchasa/ai-ide-cli`](https://jsr.io/@korchasa/ai-ide-cli).

## Scope

Library-only. No engine, no workflow, no domain logic. Consumers
(e.g. [`@korchasa/flowai-workflow`](https://jsr.io/@korchasa/flowai-workflow))
import this package to invoke IDE CLIs uniformly.

## Layout

- `mod.ts` — barrel export for the default entry.
- `types.ts` — shared runtime identifiers and value types.
- `runtime/` — runtime adapter abstraction (`getRuntimeAdapter`, per-runtime
  adapters for Claude / OpenCode / Cursor / Codex), plus:
  - `runtime/event-queue.ts` — shared `SessionEventQueue<T>` backing every
    `session.events` iterable.
  - `runtime/session-adapter.ts` — shared `adaptRuntimeSession` /
    `adaptEventCallback` helpers that translate runtime-specific sessions
    into runtime-neutral `RuntimeSession` handles.
  - `runtime/session_contract_test.ts` — backend-agnostic contract tests +
    compile-time negative-type assertion that `pid` is absent from
    `RuntimeSession`.
  - `runtime/capabilities.ts` — `CapabilityInventory` types + shared
    LLM-probe driver behind `fetchCapabilitiesSlow` (FR-L20).
  - `runtime/content.ts` — `extractSessionContent(event)` →
    `NormalizedContent[]` (text / tool / final), runtime-neutral content
    extraction (FR-L23).
  - `runtime/tool-filter.ts` — shared typed `allowedTools` /
    `disallowedTools` validation used by every adapter (FR-L24).
  - `runtime/setting-sources.ts` — Claude `settingSources` cleanroom
    isolation (FR-L18).
  - `runtime/reasoning-effort.ts` — abstract `reasoningEffort` enum +
    `validateReasoningEffort` mapped per-runtime (FR-L25).
- `claude/process.ts`, `claude/stream.ts`, `claude/session.ts` — Claude CLI
  invocation, streaming output parser, and streaming-input session.
- `opencode/process.ts`, `opencode/session.ts`, `opencode/hitl-mcp.ts` —
  OpenCode invocation (with `onToolUseObserved` dispatch and
  `opencode export` transcript surfacing), server-backed streaming-input
  session, HITL MCP handler.
- `cursor/process.ts`, `cursor/session.ts` — Cursor CLI invocation and the
  faux streaming-input session (`create-chat` + per-send subprocess).
- `codex/process.ts`, `codex/hitl-mcp.ts`, `codex/app-server.ts`,
  `codex/session.ts` — Codex (`codex exec --experimental-json`) invocation,
  event-stream aggregator (mirrors `@openai/codex-sdk`), HITL MCP server,
  plus streaming-input session backed by the experimental
  `codex app-server --listen stdio://` JSON-RPC transport (`openCodexSession`).
- `skill/` — SKILL.md parser and typed skill model.
- `hitl-mcp.ts` — top-level shared HITL MCP request/response NDJSON runner
  reused by Codex and OpenCode adapters.
- `process-registry.ts` — cross-runtime child-process registry with graceful
  shutdown hooks. Exports the `ProcessRegistry` class for instance-scoped
  use plus a module-level default singleton with backward-compatible free
  functions (`register`/`unregister`/`onShutdown`/`killAll`).
- `documents/` — SRS (`requirements.md`) and SDS (`design.md`).
  FR numbering: `FR-L<N>`.
- `scripts/check.ts` — self-contained verification (fmt, lint, type check,
  tests, doc-lint, publish dry-run).
- `scripts/smoke.ts` — behavioural checks against real agent CLI binaries
  (AbortSignal SIGTERM, timeout, `settingSources`, streaming sessions). Not
  part of `deno task check`; invoke manually via `deno run -A
  scripts/smoke.ts [abort|settings|session|session-cursor|session-opencode|session-codex]`.
- `scripts/generate-release-notes.ts` — release-notes generator invoked
  from CI.

## Deno Tasks

- `deno task check` — run the full local verification suite.
- `deno task test` — run tests only.
- `deno task fmt` — format in place.
- `deno task release` — bump version via `standard-version` (CI invokes).

## JSR / Deno Gotchas

- `publish.include` cannot reference files outside the package directory
  (JSR rejects `../*`). Keep everything shippable inside this repo root.
- JSR slow-types lints (`no-slow-types`, `missing-jsdoc`, `private-type-ref`)
  fire only on `deno publish --dry-run` — `deno task check` runs the dry-run
  last to catch these locally.
- `private-type-ref` checklist: when adding a parameter or return type to an
  exported function, every type referenced in its public signature must
  itself be re-exported from `mod.ts` (and any sub-path entry declared in
  `deno.json` `exports`). Symptom: `error[private-type-ref]: public type
  '<fn>' references private type '<T>'` on `deno publish --dry-run`. Fix:
  add `export type { T } from "./<module>.ts"` to the same entry-point.
- `deno doc --lint <entry>` validates only symbols reachable from `<entry>`.
  Public symbols reachable via other barrels stay invisible without a
  publish dry-run — `scripts/check.ts` runs both.
- Exported top-level `const` with a literal initializer needs an explicit
  type annotation (`missing-explicit-type`), even when TS can infer it:
  `export const FOO: string = "..."` — not `export const FOO = "..."`. The
  rule only fires on `deno publish --dry-run`; `deno task check` runs the
  dry-run last.

## JSR Trusted Publisher

Linked to `korchasa/ai-ide-cli` on JSR. If publishing starts failing with
an authorization error, check https://jsr.io/@korchasa/ai-ide-cli/settings.

## Project Information

- Project Name: `@korchasa/ai-ide-cli`
- Registry: JSR (`jsr:@korchasa/ai-ide-cli`)
- License: MIT

## Project Vision

Thin Deno/TypeScript wrapper for agent-CLI runtimes so consumers treat
Claude Code, OpenCode, Cursor, and Codex interchangeably through a single
runtime-neutral output shape (`CliRunOutput`). Split out from
`@korchasa/flowai-workflow` to keep the CLI-wrapper concern small and
focused — downstream tools that need only the wrapper pull a small
dependency instead of the full DAG workflow engine.

## Project Tooling Stack

- Deno + TypeScript
- JSR (OIDC trusted publisher) for distribution
- `standard-version` for Conventional-Commits-driven releases
- GitHub Actions CI (`.github/workflows/ci.yml`)

## Architecture

Runtime-neutral adapter pattern:

- `runtime/index.ts` exposes `getRuntimeAdapter(name)` returning a uniform
  `invoke(...)` API with the same `CliRunOutput` shape for every backend.
- Per-runtime directories (`claude/`, `opencode/`, `cursor/`, `codex/`) own
  process invocation, event streaming, session resume, and HITL MCP wiring.
- `process-registry.ts` tracks spawned children for graceful shutdown on
  SIGINT/SIGTERM. Embedders that host multiple independent runtimes in
  one process can pass a private `ProcessRegistry` via
  `RuntimeInvokeOptions.processRegistry` /
  `RuntimeSessionOptions.processRegistry` to scope `killAll()` per
  subsystem. Standalone use keeps the module-level default singleton.
- `skill/` parses SKILL.md files into a typed skill model.
- HITL MCP servers (`opencode/hitl-mcp.ts`, `codex/hitl-mcp.ts`,
  `hitl-mcp.ts`) are exposed as handlers; consumers supply a
  `hitlMcpCommandBuilder` to re-spawn them as a sub-process. The library
  does not ship a binary.

## Key Decisions

- Deno-native; no Node runtime. Published on JSR, not npm.
- Runtime-neutral `CliRunOutput` — consumers never branch on runtime name.
- HITL MCP via consumer-provided `hitlMcpCommandBuilder` (fail-fast if a
  `hitlConfig` is set but the builder is omitted).
- Module-level `AGENTS.md` allowed (e.g. `runtime/AGENTS.md`) for
  adapter-specific guidance.
- FR numbering scoped to library: `FR-L<N>`.
- `deno task check` is authoritative; `publish --dry-run` runs last to
  catch JSR slow-type lints that only fire there.
- Borrowed SDK patterns (AbortSignal, typed events, `settingSources`,
  hooks) from `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` —
  see upstream repo links in the per-adapter source.

## Documentation Hierarchy

1. **`AGENTS.md`**: Project vision, constraints, mandatory rules. READ-ONLY reference.
2. **SRS** (`documents/requirements.md`): "What" & "Why". Source of truth for requirements.
3. **SDS** (`documents/design.md`): "How". Architecture and implementation. Depends on SRS.
4. **Tasks** (`documents/tasks/<YYYY-MM-DD>-<slug>.md`): Temporary plans/notes per task.
5. **`README.md`**: Public-facing overview. Installation, usage, quick start. Derived from AGENTS.md + SRS + SDS.

## Documentation Map

Default mapping (no overrides):

- New/changed exports, classes, types → SDS (component section)
- New feature, CLI command, skill, adapter → SRS (new FR) + SDS (new component)
- Removed feature/component → remove from SRS + SDS
- Changed behavior → SDS (update description)
- Renamed/moved modules → SDS (update paths)
- README.md → only for user-facing changes

## Documentation Rules

Your memory resets between sessions. Documentation is the only link to past decisions and context. Keeping it accurate is not optional — stale docs actively mislead future sessions.

- Follow AGENTS.md, SRS, and SDS strictly — they define what the project is and how it works.
- Workflow for changes: new or updated requirement → update SRS → update SDS → implement. Skipping steps leads to docs-code drift.
- Status markers: `[x]` = implemented, `[ ]` = pending.
- **Traceability**: Every `[x]` criterion requires evidence. Placement depends on evidence type:
  1. **Code-evidenced**: Source files contain `// FR-<ID>` (TS/JS) or `# FR-<ID>` (YAML/shell) comments near implementing logic. No paths in SRS — the code comment IS the evidence.
  2. **Non-code evidence** (benchmarks, URLs, config files without comment support, file/dir existence): Placed directly in SRS/SDS next to the criterion.
  Without evidence of either type, the criterion stays `[ ]`.

### SRS Format (`documents/requirements.md`)
```markdown
# SRS
## 1. Intro
- **Desc:**
- **Def/Abbr:**
## 2. General
- **Context:**
- **Assumptions/Constraints:**
## 3. Functional Reqs
### 3.1 FR-L1
- **Desc:**
- **Scenario:**
- **Acceptance:**
---

## 4. Non-Functional

- **Perf/Reliability/Sec/Scale/UX:**

## 5. Interfaces

- **API/Proto/UI:**

## 6. Acceptance

- **Criteria:**
```

### SDS Format (`documents/design.md`)
```markdown
# SDS
## 1. Intro
- **Purpose:**
- **Rel to SRS:**
## 2. Arch
- **Diagram:**
- **Subsystems:**
## 3. Components
### 3.1 Comp A
- **Purpose:**
- **Interfaces:**
- **Deps:**
## 4. Data
- **Entities:**
- **ERD:**
- **Migration:**
## 5. Logic
- **Algos:**
- **Rules:**
## 6. Non-Functional
- **Scale/Fault/Sec/Logs:**
## 7. Constraints
- **Simplified/Deferred:**
```

### Tasks (`documents/tasks/`)

- One file per task or session: `<YYYY-MM-DD>-<slug>.md` (kebab-case slug, max 40 chars).
- Examples: `2026-03-24-add-dark-mode.md`, `2026-03-24-fix-auth-bug.md`.
- Do not reuse another session's task file — create a new file. Old tasks provide context but may contain outdated decisions.
- Use GODS format (see below) for issues and plans.
- Directory is gitignored. Files accumulate — this is expected.

### GODS Format

```markdown
---
implements:
  - FR-XXX
---
# [Task Title]

## Goal

[Why? Business value.]

## Overview

### Context

[Full problematics, pain points, operational environment, constraints, tech debt, external URLs, @-refs to relevant files/docs.]

### Current State

[Technical description of existing system/code relevant to task.]

### Constraints

[Hard limits, anti-patterns, requirements (e.g., "Must use Deno", "No external libs").]

## Definition of Done

- [ ] [Criteria 1]
- [ ] [Criteria 2]

## Solution

[Detailed step-by-step for SELECTED variant only. Filled AFTER user selects variant.]
```

### Compressed Style Rules (All Docs)

- No changelogs — docs reflect current state, not history.
- English only (except tasks, which may use the user's language).
- Summarize by extracting facts and compressing — no loss of information, just fewer words.
- Every word must carry meaning — no filler, no fluff, no stopwords where a shorter synonym works.
- Prefer compact formats: lists, tables, YAML, Mermaid diagrams.
- Abbreviate terms after first use — define once, abbreviate everywhere.
- Use symbols and numbers to replace words where unambiguous (e.g., `→` instead of "leads to").

## Planning Rules

- **Environment Side-Effects**: When changes touch infra, databases, or external services, the plan must include migration, sync, or deploy steps — otherwise the change works locally but breaks in production.
- **Verification Steps**: Every plan must include specific verification commands (tests, validation tools, connectivity checks) — a plan without verification is just a wish.
- **Functionality Preservation**: Before editing any file for refactoring, run existing tests and confirm they pass — this is a prerequisite, not a suggestion. Without a green baseline you cannot detect regressions. Run tests again after all edits. Add new tests if coverage is missing.
- **Data-First**: When integrating with external APIs or processes, inspect the actual protocol and data formats before planning — assumptions about data shape are the #1 source of integration bugs.
- **Architectural Validation**: For complex logic changes, visualize the event sequence (sequence diagram or pseudocode) — it catches race conditions and missing edges that prose descriptions miss.
- **Variant Analysis**: When the path is non-obvious, propose variants with Pros/Cons/Risks per variant and trade-offs across them. Quality over quantity — one well-reasoned variant is fine if the path is clear.
- **Plan Persistence**: After variant selection, save the detailed plan to `documents/tasks/<YYYY-MM-DD>-<slug>.md` using GODS format — chat-only plans are lost between sessions.
- **Proactive Resolution**: Before asking the user, exhaust available resources (codebase, docs, web) to find the answer autonomously — unnecessary questions slow the workflow and signal lack of initiative.

## TDD Flow

0. **BASELINE (hard gate)**: Before your first edit, run `deno task check` (or at minimum `deno task test`) to confirm the baseline is green. If it fails, stop and report — do not layer new changes on top of pre-existing failures, because any subsequent red test will be ambiguous. Add this as the first item of your session TodoWrite.
1. **RED**: Write a failing test (`deno task test <path>`) for new or changed logic.
2. **GREEN**: Write minimal code to pass the test.
3. **REFACTOR**: Improve code and tests without changing behavior. Re-run the failing test.
4. **CHECK**: Run `deno task check` (fmt, lint, type check, tests, publish --dry-run). You are NOT done after GREEN — skipping CHECK leaves formatting errors, slow-type lints, and regressions undetected. This step is mandatory.

### Adding Typed Stream Events for a Runtime

Before declaring a `<Runtime>StreamEvent` discriminated union, capture real
NDJSON from the binary — never type by analogy with another runtime or upstream
docs alone (binaries diverge from documentation).

1. Add a smoke scenario in `scripts/smoke.ts` that runs the real binary with a
   prompt exercising the events you want to type (text + tool + thinking).
2. Run `deno run -A scripts/smoke.ts <runtime>-events`; dump events to
   `/tmp/<runtime>-events-*.ndjson` and print a `type` histogram.
3. Inspect distinct shapes in the dump. Note wrapper conventions, sibling vs.
   inline placement, completion-vs-decision-time emission.
4. Write the union from captured shapes. Place it in `<runtime>/stream.ts` (or
   `<runtime>/events.ts` for codex-style). Re-export from companion modules,
   never redeclare.

Rationale: cursor's `tool_call/{started,completed}` are sibling top-level
events with a `tool_call.<name>ToolCall.{args|result}` wrapper, not inline
`tool_use` blocks like Claude. The divergence was invisible until empirical
capture (FR-L30).

### Test Rules

- Test logic and behavior only — do not test constants or templates, they change without breaking anything.
- Tests live in the same package, co-located next to the code (`*_test.ts`). Testing private methods is acceptable when it improves coverage of complex internals.
- Write code only to fix failing tests or reported issues — no speculative implementations.
- No stubs or mocks for internal code. Use real implementations — stubs hide integration bugs.
- Real-binary behavioural checks live in `scripts/smoke.ts` and are invoked manually; `deno task test` only runs unit tests.
- Run all tests before finishing, not just the ones you changed.
- When a test fails, fix the source code — not the test. Do not modify a failing test to make it pass, do not add error swallowing or skip logic.
- Do not create source files with guessed or fabricated data to satisfy imports — if the data source is missing, that is a blocker (see Diagnosing Failures).

### Autonomous Test Execution

Run tests and safe real-IDE experiments proactively — do not ask permission for reads, dry-runs, or stubbed probes. Specifically authorized without prompting:

- **Deno verification suite:** `deno task check`, `deno task test [path]`, `deno task fmt`, `deno lint .`, `deno doc --lint <entry>`, `deno check <file>`, `deno publish --dry-run`.
- **Real-binary smoke tests** against installed CLIs (Claude, OpenCode, Cursor, Codex) via `scripts/smoke.ts` or ad-hoc scripts, provided the scenario is **safe**:
  - Short test prompts (e.g. "Reply with the word: ok") — token cost is negligible.
  - `settingSources: []` cleanroom runs.
  - `permissionMode: "plan"` or unspecified (read-only/no-write).
  - `cwd` pointing to the repo worktree or a `Deno.makeTempDir()` scratch dir.
  - `AbortSignal` with a ceiling (e.g. 60s) so a misconfigured backend cannot hang.
- **Stub-based integration probes:** PATH-override bash stubs for adapter tests (the pattern in `claude/session_test.ts`, `opencode/session_test.ts`, etc.). Always safe — no real binary, no tokens.

**Ask first** before running:
- `permissionMode: "bypassPermissions"` / `--yolo` / `--sandbox danger-full-access` against a real binary.
- Any scenario that spawns writes outside the project worktree (`cwd: "/"`, `$HOME`, system paths).
- Long-running benchmarks (> ~30s real-binary time, heavy token spend).
- Anything that touches shared state (git push, JSR publish, posting to external APIs).

The goal is fast iteration: if a check is read-only and reversible, just run it and report the result. Do not narrate "should I run X?" — run X, then narrate.

## Diagnosing Failures

The goal is to identify the root cause, not to suppress the symptom. A quick workaround that hides the root cause is worse than an unresolved issue with a correct diagnosis.

1. Read the relevant code and error output before making any changes.
2. Apply "5 WHY" analysis to find the root cause.
3. Root cause is fixable → apply the fix, retry.
4. Second fix attempt failed → STOP. Output "STOP-ANALYSIS REPORT" (state, expected, 5-why chain, root cause, hypotheses). Wait for user help.

When the root cause is outside your control (missing API keys/URLs, missing generator scripts, unavailable external services, wrong environment configuration) → STOP immediately and ask the user for the correct values. Do not guess, do not invent replacements, do not create workarounds.

## Development Commands

### Shell Environment
- Always use `NO_COLOR=1` when running shell commands — ANSI escape codes waste tokens and clutter output.
- When writing scripts, respect the `NO_COLOR` env var (https://no-color.org/) — disable ANSI colors when it is set.

### Standard Interface
- `check` — the main command for comprehensive project verification. Runs the following steps in order:
  - build the project
  - comment-scan: "TODO", "FIXME", "HACK", "XXX", debugger calls, linter and formatter suppression markers
  - code formatting check
  - static code analysis
  - all project tests
- `test <path>` — runs a single test file or test suite.
- `dev` — runs the application in development mode with watch mode enabled. N/A for this library.
- `prod` — runs the application in production mode. N/A for this library.

### Detected Commands

- `deno task check` — full verification (fmt, lint, type check, **full test suite**, doc-lint, `deno publish --dry-run`). Authoritative. **Supersedes `deno task test`** — the pipeline already invokes `deno test -A`, so running both back-to-back duplicates ~40s of work.
- `deno task test` — unit tests only (`deno test -A --no-check .`). Use during TDD RED/GREEN iterations on specific files; `check` subsumes it for final verification.
- `deno task fmt` — format in place.
- `deno task release` — `standard-version` version bump (CI-invoked).
- `deno run -A scripts/smoke.ts [abort|settings|session|session-cursor|session-opencode|session-codex]` — real-binary behavioural checks against installed CLIs. Manual; not part of `deno task check`.

**Iteration tip — avoid the big-bang pipeline loop.** `deno task check` takes ~40s because it runs the full suite. For fast fmt/lint/JSDoc iteration, run the cheap sub-steps individually first:

- `deno fmt --check` — format issues (~1s)
- `deno lint .` — style/lint issues (~2s, catches `prefer-as-const` and similar)
- `deno doc --lint mod.ts` — JSR slow-types + `missing-jsdoc` (~3s)

Only invoke the full `deno task check` once those three pass.

**JSDoc quirk (`deno doc --lint`):** exported class constructors need a *leading summary line* before any `@param` tags. A docblock with only `@param` lines fails `missing-jsdoc`. Use this shape:

```ts
/**
 * One-line summary of what the constructor is for.
 *
 * @param foo ...
 */
constructor(foo: string) { ... }
```

### Command Scripts

- `scripts/check.ts` — drives `deno task check`. Runs fmt, lint, type check, tests, `deno doc --lint`, and `deno publish --dry-run` last.
- `scripts/smoke.ts` — real-binary smoke checks, manual invocation.
- `scripts/generate-release-notes.ts` — release-notes generator invoked from CI.

## Code Documentation

- **Module level**: each module gets an `AGENTS.md` describing its responsibility and key decisions (e.g. `runtime/AGENTS.md`).
- **Code level**: JSDoc for exported classes, methods, and functions — JSR slow-types enforces this on public API. Focus on *why* and *how*, not *what*. Skip trivial comments — they add noise without value.
- **Requirement traceability**: when code implements a requirement from SRS (`documents/requirements.md`), add a `// FR-L<N>` comment next to the implementing logic. Code references requirements, not the reverse — SRS must not contain file paths. Exceptions: requirements verified by benchmarks or proven by file existence need no comment.

> **Before you start:** read `documents/requirements.md` (SRS) and `documents/design.md` (SDS) if you haven't in this session. They contain project requirements and architecture that inform every task.
