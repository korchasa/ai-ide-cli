# SRS: AI IDE CLI

Functional requirements for `@korchasa/ai-ide-cli` — thin wrapper around
agent-CLI binaries. FR-IDs use `FR-L<N>` prefix (L = library). IDs are
stable — never renumber on move.

## 0. Resolved Design Decisions

- **Scope boundary:** Library owns CLI subprocess management only. No DAG,
  workflow, config parsing, git, or domain logic.
- **One-way dependency:** Library has zero imports from engine
  (`@korchasa/flowai-workflow`). Engine depends on library, not vice versa.
- **No shipped binary:** Library exposes functions and types. Consumers
  (engine, standalone tools) own the binary entry point.
- **HITL MCP contract:** OpenCode HITL requires a consumer-provided
  `hitlMcpCommandBuilder` callback. Library ships the MCP handler
  (`runOpenCodeHitlMcpServer`) but NOT the subprocess argv — consumer
  supplies it. Fail-fast error if omitted.
- **claude_args removed:** Single universal `runtime_args` field for all
  runtimes. No runtime-specific arg fields.

## 1. Introduction

- **Purpose:** Normalize invocation of agent-CLI binaries (Claude Code,
  OpenCode, Cursor) behind a uniform interface. Parse NDJSON event streams,
  handle retry/backoff, session resume, and HITL tool wiring.
- **Scope:** Subprocess spawning, stream parsing, output normalization,
  process lifecycle tracking. No workflow orchestration.
- **Audience:** Engine developers, standalone CLI tool authors, MCP proxy
  builders.
- **Abbreviations:**
  - **NDJSON:** Newline-delimited JSON event stream.
  - **HITL:** Human-in-the-loop — agent requests human input mid-task.
  - **MCP:** Model Context Protocol — tool interface for agent runtimes.

## 2. General Description

- **Context:** Published as `@korchasa/ai-ide-cli` on JSR. Deno workspace
  member alongside `@korchasa/flowai-workflow`. Consumers import via sub-path
  specifiers (`/runtime`, `/claude/process`, `/cursor/process`, etc.).
- **Assumptions:**
  - Agent CLI binaries (`claude`, `opencode`, `cursor`, `codex`) installed and on PATH.
  - Deno runtime available (library uses `Deno.Command` for subprocess spawn).
  - Consumers handle signal installation; library exposes `killAll()` but
    does not wire OS signals.
  - Library is safe to embed in a host process that runs several
    independent runtimes side-by-side: every spawn point honours a
    caller-supplied `ProcessRegistry` (FR-L3) so the host can scope
    subprocess cleanup per subsystem.

## 3. Functional Requirements

### 3.1 FR-L1: Runtime Adapter Abstraction

- **Description:** Uniform `RuntimeAdapter` interface for dispatching agent
  invocations across runtimes. `getRuntimeAdapter(id)` returns the adapter;
  `resolveRuntimeConfig({defaults, node, parent})` resolves effective runtime,
  args, model, permissionMode using node > parent > defaults precedence.
  `RuntimeConfigSource` is a structural type — consumer types (`NodeConfig`,
  `WorkflowDefaults`) satisfy it without library depending on workflow types.
- **Motivation:** Engine code stays runtime-agnostic. Adding a new runtime
  requires only a new adapter + registration.
- **Acceptance:**
  - [x] `RuntimeAdapter` interface with `id`, `capabilities`, `invoke()`,
        `launchInteractive()`, optional `openSession()` (see FR-L19). Evidence:
        `ai-ide-cli/runtime/types.ts`.
  - [x] `RuntimeCapabilities` flags: `permissionMode`, `hitl`, `transcript`,
        `interactive`, `toolUseObservation`, `session`,
        `sessionFidelity?: "native" | "emulated"` (omitted ⇒ `"native"`;
        Cursor advertises `"emulated"`, every other adapter `"native"`).
        Evidence: `ai-ide-cli/runtime/types.ts`.
  - [x] `getRuntimeAdapter(id)` returns adapter from registry.
        Evidence: `ai-ide-cli/runtime/index.ts:18-20`.
  - [x] `resolveRuntimeConfig()` merges map-shape `runtime_args` across
        cascade levels last-writer-wins; `null` survives to suppress the flag
        at expansion time. Evidence: `ai-ide-cli/runtime/index.ts`,
        `ai-ide-cli/runtime/index_test.ts`.
  - [x] `RuntimeConfigSource` structural type — no workflow imports.
        Evidence: `ai-ide-cli/runtime/types.ts:112-121`.
  - [x] Four adapters registered: `claude`, `opencode`, `cursor`, `codex`.
        Evidence: `ai-ide-cli/runtime/index.ts:11-17`.

### 3.2 FR-L2: Normalized Output Shape (`CliRunOutput`)

- **Description:** All runtimes normalize their output into `CliRunOutput`:
  `result`, `session_id`, `total_cost_usd`, `duration_ms`, `duration_api_ms`,
  `num_turns`, `is_error`, optional `permission_denials`, `hitl_request`,
  `runtime`. Downstream code (engine state, logging, continuation) consumes
  this shape without runtime branching.
- **Motivation:** Runtime-neutral output enables uniform state persistence,
  cost aggregation, and log formatting.
- **Acceptance:**
  - [x] `CliRunOutput` interface with all listed fields.
        Evidence: `ai-ide-cli/types.ts:89-110`.
  - [x] Claude `extractClaudeOutput()` returns `CliRunOutput` with
        `runtime: "claude"`. Evidence: `ai-ide-cli/claude/stream.ts:115-130`.
  - [x] OpenCode `extractOpenCodeOutput()` returns `CliRunOutput` with
        `runtime: "opencode"`. Evidence: `ai-ide-cli/opencode/process.ts:90-145`.
  - [x] Cursor `extractCursorOutput()` returns `CliRunOutput` with
        `runtime: "cursor"`. Evidence: `ai-ide-cli/cursor/process.ts:62-74`.
  - [x] Codex `extractCodexOutput()` returns `CliRunOutput` with
        `runtime: "codex"`. Evidence: `ai-ide-cli/codex/process.ts`.

### 3.3 FR-L3: Process Registry

- **Description:** Pure child-process tracker exposed in two flavors:
  (a) the `ProcessRegistry` class for instance-scoped use — one registry
  per logical scope (e.g. one per active session in an embedder that hosts
  multiple independent runtimes in one process), and (b) a module-level
  default singleton plus `register`/`unregister`/`onShutdown`/`killAll`
  free functions that wrap it for backward compatibility. Both flavors
  expose `register(p)` / `unregister(p)` to track spawned processes,
  `killAll()` (SIGTERM, wait 5s, SIGKILL, then run callbacks), and
  `onShutdown(cb)` returning a disposer that removes the callback. No OS
  signal wiring — consumers own that.
- **Motivation:** Centralized process lifecycle enables graceful shutdown
  across all runtimes without each adapter managing its own cleanup. The
  instance-scoped flavor lets embedders (e.g. flowai-center) host several
  independent runtimes in one Deno process and reap their subprocesses
  without disturbing one another.
- **Acceptance:**
  - [x] `ProcessRegistry` class + free-function wrappers + default
        singleton exported. Evidence: `ai-ide-cli/process-registry.ts`.
  - [x] `killAll()` SIGTERM → 5s wait → SIGKILL → callbacks. Test:
        `ai-ide-cli/process-registry_test.ts::ProcessRegistry SIGKILL
        escalation`.
  - [x] All runtime runners route subprocess lifecycle through the
        caller-supplied registry — no implicit fallback to the default
        singleton. Evidence: `ai-ide-cli/claude/process.ts`,
        `ai-ide-cli/claude/session.ts`, `ai-ide-cli/opencode/process.ts`,
        `ai-ide-cli/opencode/session.ts`, `ai-ide-cli/cursor/process.ts`,
        `ai-ide-cli/cursor/session.ts`, `ai-ide-cli/codex/process.ts`,
        `ai-ide-cli/codex/app-server.ts`.
  - [x] `RuntimeInvokeOptions` and `RuntimeSessionOptions` (and every
        per-runtime invoke/session options type) carry a **required**
        `processRegistry` field that scopes the spawned subprocess to
        that registry. Standalone callers pass the module-level
        `defaultRegistry`; embedders pass per-scope instances. Test:
        `ai-ide-cli/runtime/process-registry-routing_test.ts::processRegistry
        routing — createCursorChat tracks subprocess on supplied registry,
        not default`.

### 3.4 FR-L4: Claude CLI Wrapper

- **Description:** `invokeClaudeCli(opts)` spawns `claude` with stream-json
  output, processes NDJSON events in real-time, extracts `CliRunOutput` from
  the `result` event. Retry with exponential backoff. `buildClaudeArgs(opts)`
  constructs CLI argv. Supports `--permission-mode`, `--agent`,
  `--append-system-prompt`, `--model`, `--resume`.
  Upstream reference — use this when porting additional flags or when the
  `stream-json` event shape evolves: Anthropic's Claude Agent SDK for
  TypeScript — https://github.com/anthropics/claude-agent-sdk-typescript
- **Acceptance:**
  - [x] `buildClaudeArgs()` emits correct flags for fresh and resume modes.
        Evidence: `ai-ide-cli/claude/process.ts:94-127`.
  - [x] `invokeClaudeCli()` with retry loop + exponential backoff.
        Evidence: `ai-ide-cli/claude/process.ts:52-91`.
  - [x] Real-time NDJSON processing via `processStreamEvent()`.
        Evidence: `ai-ide-cli/claude/stream.ts:63-112`.
  - [x] `CLAUDECODE=""` env override for nested invocations.
        Evidence: `ai-ide-cli/claude/process.ts:148`.

### 3.5 FR-L5: OpenCode CLI Wrapper

- **Description:** `invokeOpenCodeCli(opts)` spawns `opencode run --format json`,
  parses NDJSON events, normalizes to `CliRunOutput`. System prompt prepended
  to task prompt (no dedicated flag). HITL interception: detects
  `hitl_request_human_input` tool_use events, kills process, returns
  `hitl_request` in output. MCP injection via `OPENCODE_CONFIG_CONTENT` env.
  Surfaces a typed event union `OpenCodeStreamEvent` for consumers narrowing
  `RuntimeInvokeOptions.onEvent`. Observes tool invocations via FR-L16.
  Post-run transcript exported with `opencode export <sessionId>` and
  written to a temp file, path returned as `CliRunOutput.transcript_path`.
- **Acceptance:**
  - [x] `buildOpenCodeArgs()` emits `run`, `--format json`, `--session`,
        `--model`, `--agent`, `--dangerously-skip-permissions`, and a `--`
        separator immediately before the positional prompt so yargs does
        not misinterpret a `-`-prefixed prompt (typical when a system
        prompt begins with YAML frontmatter `---`) as an unknown flag.
        Evidence: `ai-ide-cli/opencode/process.ts:buildOpenCodeArgs`.
  - [x] `buildOpenCodeConfigContent()` injects MCP server when HITL configured;
        throws when `hitlMcpCommandBuilder` missing.
        Evidence: `ai-ide-cli/opencode/process.ts:buildOpenCodeConfigContent`.
  - [x] HITL request extraction from `tool_use` events.
        Evidence: `ai-ide-cli/opencode/process.ts:extractHitlRequestFromEvent`.
  - [x] `OpenCodeStreamEvent` union exported
        (`OpenCodeStepStartEvent | OpenCodeTextEvent | OpenCodeToolUseEvent
        | OpenCodeStepFinishEvent | OpenCodeErrorEvent`).
        Evidence: `ai-ide-cli/opencode/process.ts` discriminated union.
  - [x] `exportOpenCodeTranscript(sessionId, opts?)` spawns `opencode export`
        and writes stdout to a temp file; failures return `undefined`.
        Evidence: `ai-ide-cli/opencode/process.ts:exportOpenCodeTranscript`,
        `ai-ide-cli/opencode/process_test.ts` transcript-export cases.
  - [x] Tests: args, output extraction, HITL, config content, tool-use abort,
        transcript export. Evidence: `ai-ide-cli/opencode/process_test.ts`.

### 3.6 FR-L6: Cursor CLI Wrapper

- **Description:** `invokeCursorCli(opts)` spawns `cursor agent -p` with
  `--output-format stream-json`, processes NDJSON events, extracts
  `CliRunOutput`. System prompt prepended to task prompt. Session resume via
  `--resume <chatId>`. Permissions bypass via `--yolo`. `--trust` for headless
  workspace trust.
- **Acceptance:**
  - [x] `buildCursorArgs()` emits `agent`, `-p`, `--output-format stream-json`,
        `--trust`, `--resume`, `--model`, `--yolo`.
        Evidence: `ai-ide-cli/cursor/process.ts:30-54`.
  - [x] `extractCursorOutput()` normalizes result event to `CliRunOutput`.
        Evidence: `ai-ide-cli/cursor/process.ts:60-74`.
  - [x] `formatCursorEventForOutput()` formats events with semi-verbose
        filtering. Evidence: `ai-ide-cli/cursor/process.ts:83-113`.
  - [x] Tests: args, output extraction, event formatting.
        Evidence: `ai-ide-cli/cursor/process_test.ts`.

### 3.7 FR-L7: Stream Event Formatting

- **Description:** Each runtime provides a `format*EventForOutput(event,
  verbosity?)` function producing one-line summaries for terminal output.
  Semi-verbose mode suppresses `tool_use` blocks, emitting only text.
  Claude additionally provides `stampLines()` for timestamped log writes and
  `formatFooter()` for run summary.
- **Acceptance:**
  - [x] Claude: `formatEventForOutput()`, `stampLines()`, `tsPrefix()`,
        `formatFooter()`. Evidence: `ai-ide-cli/claude/stream.ts:180-252`.
  - [x] OpenCode: `formatOpenCodeEventForOutput()`.
        Evidence: `ai-ide-cli/opencode/process.ts:56-87`.
  - [x] Cursor: `formatCursorEventForOutput()`.
        Evidence: `ai-ide-cli/cursor/process.ts:83-113`.
  - [x] Semi-verbose filtering skips `tool_use` blocks.
        Evidence: tests in `process_test.ts` files.

### 3.8 FR-L8: Repeated File Read Warning

- **Description:** `FileReadTracker` class tracks per-path file read counts
  within a single agent invocation. Returns warning string when count exceeds
  threshold (default 2). Warning written to log file only (not terminal).
  Pure-logic class, unit-testable without I/O.
- **Acceptance:**
  - [x] `FileReadTracker` with `track(path)`, `reset()`, configurable
        threshold. Evidence: `ai-ide-cli/claude/stream.ts:16-38`.
  - [x] `processStreamEvent()` calls tracker on `Read` tool_use blocks.
        Evidence: `ai-ide-cli/claude/stream.ts:80-89`.
  - [x] Tests: threshold boundary, per-path independence, custom threshold,
        integration with log file.
        Evidence: `ai-ide-cli/claude/stream.ts` tests (in engine test suite).

### 3.9 FR-L9: Custom Subprocess Environment

- **Description:** `RuntimeInvokeOptions.env` and `ClaudeInvokeOptions.env`
  accept `Record<string, string>` merged into the subprocess environment.
  Enables isolation scenarios (e.g. `CLAUDE_CONFIG_DIR=<cleanroom>` to avoid
  global `~/.claude/CLAUDE.md` contamination). Claude merges with
  `{ CLAUDECODE: "", ...env }`, Cursor passes env directly, OpenCode merges
  with `OPENCODE_CONFIG_CONTENT` when present.
- **Motivation:** Experiments and benchmarks require isolated agent configs
  without polluting or depending on the host's global state.
- **Acceptance:**
  - [x] `env?: Record<string, string>` on `RuntimeInvokeOptions`.
        Evidence: `ai-ide-cli/runtime/types.ts`.
  - [x] `env?: Record<string, string>` on `ClaudeInvokeOptions`.
        Evidence: `ai-ide-cli/claude/process.ts`.
  - [x] Claude: merged as `{ CLAUDECODE: "", ...env }`.
        Evidence: `ai-ide-cli/claude/process.ts` `executeClaudeProcess`.
  - [x] Cursor: passed to `Deno.Command` when present.
        Evidence: `ai-ide-cli/cursor/process.ts` `executeCursorProcess`.
  - [x] OpenCode: merged with `OPENCODE_CONFIG_CONTENT`.
        Evidence: `ai-ide-cli/opencode/process.ts` `executeOpenCodeProcess`.
  - [x] Claude adapter forwards `env` field.
        Evidence: `ai-ide-cli/runtime/claude-adapter.ts`.
  - [x] Type-level test: env accepted without affecting CLI args.
        Evidence: `ai-ide-cli/claude/process_test.ts`.

### 3.10 FR-L10: Raw NDJSON Event Callback

- **Description:** `RuntimeInvokeOptions.onEvent` and
  `ClaudeInvokeOptions.onEvent` accept
  `(event: Record<string, unknown>) => void`. Invoked with every raw NDJSON
  event object **before** any filtering or extraction. Consumer decides what
  to keep (init metadata, cache token stats, tool lists, etc.).
- **Motivation:** Enables experiments like `context-anatomy` to extract
  `init` event metadata (tools, skills, agents, MCP servers) and `result`
  event cache token counts without modifying `CliRunOutput`.
- **Acceptance:**
  - [x] `onEvent` on `RuntimeInvokeOptions`.
        Evidence: `ai-ide-cli/runtime/types.ts`.
  - [x] `onEvent` on `ClaudeInvokeOptions`.
        Evidence: `ai-ide-cli/claude/process.ts`.
  - [x] `onEvent` on `StreamProcessorState`, called at top of
        `processStreamEvent()` before any filtering.
        Evidence: `ai-ide-cli/claude/stream.ts`.
  - [x] Cursor: `onEvent` called on each parsed event.
        Evidence: `ai-ide-cli/cursor/process.ts`.
  - [x] OpenCode: `onEvent` called in `processOpenCodeLine()`.
        Evidence: `ai-ide-cli/opencode/process.ts`.
  - [x] Claude adapter forwards `onEvent` field.
        Evidence: `ai-ide-cli/runtime/claude-adapter.ts`.
  - [x] Test: onEvent receives all events in order.
        Evidence: `ai-ide-cli/claude/stream_test.ts`.
  - [x] Backward-compat: omitting onEvent causes no errors.
        Evidence: `ai-ide-cli/claude/stream_test.ts`.

### 3.11 FR-L11: Skill Model

- **Description:** Typed representation of SKILL.md files — the de facto skill
  standard across AI IDEs. `SkillFrontmatter` is a union of known fields across
  Claude Code, OpenCode, and Cursor. `SkillDef` holds parsed frontmatter, body,
  rootPath, and additional files list. `parseSkill(dir)` reads `SKILL.md`,
  extracts YAML frontmatter, scans for additional files.
- **Motivation:** Skills must be first-class objects (not plain text) for
  injection into runtimes. Parser enables bundled and project-level skills.
- **Acceptance:**
  - [x] `SkillFrontmatter` with required `name`, `description` and optional
        IDE-specific fields. Evidence: `ai-ide-cli/skill/types.ts:8-57`.
  - [x] `SkillDef` with `frontmatter`, `body`, `rootPath`, `files`.
        Evidence: `ai-ide-cli/skill/types.ts:63-72`.
  - [x] `parseSkill(dir)` reads SKILL.md, extracts frontmatter, scans files.
        Evidence: `ai-ide-cli/skill/parser.ts:28-57`.
  - [x] Error cases: missing SKILL.md, invalid YAML, missing name/description.
        Evidence: `ai-ide-cli/skill/parser_test.ts`.
  - [x] Sub-path export `@korchasa/ai-ide-cli/skill`.
        Evidence: `ai-ide-cli/deno.json` exports.

### 3.12 FR-L12: Interactive Mode

- **Description:** `RuntimeAdapter.launchInteractive(opts)` launches an
  interactive CLI session with injected skills. `InteractiveOptions` carries
  `skills`, `systemPrompt`, `cwd`, `env`. `InteractiveResult` returns
  `exitCode`. Per-runtime skill injection: Claude uses temp `CLAUDE_CONFIG_DIR`
  with symlinked auth + copied skills; OpenCode copies to temp
  `.claude/skills/`; Cursor throws (no interactive CLI). `interactive`
  capability flag advertises support.
- **Motivation:** REPL needs to launch agent sessions with bundled management
  skills. Injection strategy is runtime-specific — belongs in adapter layer.
- **Acceptance:**
  - [x] `InteractiveOptions` and `InteractiveResult` types.
        Evidence: `ai-ide-cli/runtime/types.ts:90-108`.
  - [x] `launchInteractive()` on `RuntimeAdapter` interface.
        Evidence: `ai-ide-cli/runtime/types.ts:120-123`.
  - [x] `interactive` flag on `RuntimeCapabilities`.
        Evidence: `ai-ide-cli/runtime/types.ts:18`.
  - [x] Claude adapter: temp config dir with skills, stdin inherit.
        Evidence: `ai-ide-cli/runtime/claude-adapter.ts:17-49,78-120`.
  - [x] OpenCode adapter: temp .claude/skills/, stdin inherit.
        Evidence: `ai-ide-cli/runtime/opencode-adapter.ts:22-63`.
  - [x] Cursor adapter: throws UnsupportedError.
        Evidence: `ai-ide-cli/runtime/cursor-adapter.ts:16-20`.

### 3.13 FR-L13: Codex CLI Wrapper

- **Description:** `invokeCodexCli(opts)` spawns `codex exec
  --experimental-json`, writes the merged `systemPrompt`+`taskPrompt` to the
  child's stdin (codex does not accept the prompt as argv), processes NDJSON
  events in real-time, and returns normalized `CliRunOutput`. Session resume
  via the positional subcommand `resume <threadId>`. Permission bypass via
  `--sandbox danger-full-access` plus `--config approval_policy="never"` when
  `permissionMode === "bypassPermissions"`. `buildCodexArgs(opts)` constructs
  CLI argv (no prompt); `applyCodexEvent()` folds each event into a
  `CodexRunState` accumulator; `extractCodexOutput()` finalizes the
  accumulator into `CliRunOutput`. `formatCodexEventForOutput()` produces
  one-line summaries with `semi-verbose` filtering that suppresses reasoning,
  tool, and patch items. Modeled after `@openai/codex-sdk` but implemented as
  a direct subprocess wrapper to keep the package dependency-free for Deno.
  Upstream reference — use this when porting additional features (images,
  `--output-schema`, `--add-dir`, reasoning effort, web search, `AbortSignal`,
  etc.): https://github.com/openai/codex/tree/main/sdk/typescript (see
  `src/exec.ts` for argv/env wiring, `src/thread.ts` for event aggregation,
  `src/events.ts` and `src/items.ts` for the event/item type union).
- **Motivation:** Add OpenAI's Codex CLI as a first-class runtime alongside
  Claude Code / OpenCode / Cursor, without bundling an npm SDK.
- **Acceptance:**
  - [x] `buildCodexArgs()` emits `exec`, `--experimental-json`, `--model`,
        `--cd`, `--sandbox`, `--config`, `resume <id>`; prompt is NOT in argv.
        Evidence: `ai-ide-cli/codex/process.ts`,
        `ai-ide-cli/codex/process_test.ts`.
  - [x] `invokeCodexCli()` writes prompt to stdin, closes stdin, then reads
        NDJSON from stdout. Evidence: `ai-ide-cli/codex/process.ts`.
  - [x] Event aggregation: `thread.started` → `session_id`,
        `item.completed`/`agent_message` → `result`, `turn.completed` →
        `num_turns` + token counts, `turn.failed`/`error` → `is_error`.
        Evidence: `ai-ide-cli/codex/process.ts`,
        `ai-ide-cli/codex/process_test.ts`.
  - [x] Retry loop with exponential backoff (same policy as other runtimes).
        Evidence: `ai-ide-cli/codex/process.ts`.
  - [x] Adapter registered with capabilities
        `{ permissionMode: true, hitl: true, transcript: true, interactive: true, toolUseObservation: true }`;
        `launchInteractive()` spawns the Codex TUI with skill injection at
        `~/.agents/skills/<name>/`. Evidence:
        `ai-ide-cli/runtime/codex-adapter.ts`, `ai-ide-cli/runtime/index.ts`.
  - [x] `permissionMode` mapping covers `default` / `plan` / `acceptEdits` /
        `bypassPermissions` (mapped to `--sandbox` + `approval_policy`) and
        Codex-native pass-through values. Evidence:
        `ai-ide-cli/codex/process.ts:permissionModeToCodexArgs`,
        `ai-ide-cli/codex/process_test.ts`.
  - [x] HITL via `--config mcp_servers.hitl.command/args` overrides;
        `mcp_tool_call` items targeting `hitl.request_human_input` are
        intercepted and surfaced as `CliRunOutput.hitl_request`. Evidence:
        `ai-ide-cli/codex/process.ts:buildCodexHitlConfigArgs`,
        `ai-ide-cli/codex/hitl-mcp.ts`.
  - [x] Transcript path resolved post-run from
        `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl` and
        surfaced as `CliRunOutput.transcript_path`. Evidence:
        `ai-ide-cli/codex/process.ts:findCodexSessionFile`.
  - [x] `onToolUseObserved` fires for `command_execution`, `file_change`,
        `mcp_tool_call`, `web_search` items; `"abort"` SIGTERMs Codex and
        synthesizes `permission_denials[]`. Evidence:
        `ai-ide-cli/codex/process.ts:codexItemToToolUseInfo` and
        `executeCodexProcess`.
  - [x] Sub-path exports `@korchasa/ai-ide-cli/codex/process` and
        `@korchasa/ai-ide-cli/codex/hitl-mcp`. Evidence:
        `ai-ide-cli/deno.json` exports.

### 3.14 FR-L14: Map-shaped `extraArgs` / `runtime_args`

- **Description:** Extra CLI arguments are expressed as
  `Record<string, string | null>`. An empty string emits a bare flag; a
  non-empty string emits `--key value`; `null` suppresses the flag (used
  by downstream cascade levels to override a parent-supplied value).
  `expandExtraArgs(map, reserved?)` flattens the map into argv and throws
  synchronously if any reserved key is present. Each runtime declares its
  reserved-flag list (`CLAUDE_RESERVED_FLAGS`, `OPENCODE_RESERVED_FLAGS`,
  `CURSOR_RESERVED_FLAGS`, `CODEX_RESERVED_FLAGS`).
- **Motivation:** Map shape makes cascading overrides trivial (`{flag:
  null}` suppresses a parent value) and matches the shape of Anthropic's
  Claude Agent SDK `extraArgs` option.
- **Acceptance:**
  - [x] `ExtraArgsMap` type exported from `runtime/types.ts`.
        Evidence: `ai-ide-cli/runtime/types.ts`.
  - [x] `expandExtraArgs` helper with empty/null/reserved semantics.
        Evidence: `ai-ide-cli/runtime/index.ts`,
        `ai-ide-cli/runtime/index_test.ts`.
  - [x] Each `build*Args` expands `extraArgs` via `expandExtraArgs` with
        its reserved list. Evidence: `ai-ide-cli/claude/process.ts`,
        `ai-ide-cli/opencode/process.ts`, `ai-ide-cli/cursor/process.ts`,
        `ai-ide-cli/codex/process.ts`.
  - [x] Cascade merge preserves `null` for flag suppression. Evidence:
        `ai-ide-cli/runtime/index_test.ts`.

### 3.15 FR-L15: `AbortSignal` Cancellation

- **Description:** `RuntimeInvokeOptions.signal` and
  `ClaudeInvokeOptions.signal` accept an external `AbortSignal`. Each
  runtime composes the caller's signal with its internal timeout via
  `AbortSignal.any`; on abort the subprocess receives `SIGTERM` and the
  retry loop exits immediately with
  `{ error: "Aborted: <reason>" }` (no further attempts). A signal that
  is already aborted on entry returns `Aborted before start` without
  spawning the subprocess. The retry sleep is abortable — it rejects
  with `DOMException("Aborted", "AbortError")` when the signal fires.
- **Motivation:** Composable cancellation for callers that coordinate
  multiple long-running runtimes (e.g. workflow engines, benchmarks,
  orchestrators).
- **Acceptance:**
  - [x] `signal?: AbortSignal` on `RuntimeInvokeOptions` and
        `ClaudeInvokeOptions`. Evidence: `ai-ide-cli/runtime/types.ts`,
        `ai-ide-cli/claude/process.ts`.
  - [x] Aborted-before-start returns `"Aborted before start"` without
        spawning. Evidence: `ai-ide-cli/claude/process_test.ts`.
  - [x] AbortSignal composed with timeout via `AbortSignal.any`.
        Evidence: `ai-ide-cli/claude/process.ts`,
        `ai-ide-cli/opencode/process.ts`, `ai-ide-cli/cursor/process.ts`,
        `ai-ide-cli/codex/process.ts`.
  - [x] Retry loop treats abort as terminal. Evidence:
        `ai-ide-cli/claude/process.ts` retry loop error-mapping.

### 3.16 FR-L16: Observed-Tool-Use Hook

- **Description:** `RuntimeInvokeOptions.onToolUseObserved(info)` (and the
  Claude-specific `ClaudeInvokeOptions.onToolUseObserved(info)`) fire for
  every tool invocation surfaced by the runtime's event stream. The hook
  runs **post-dispatch but pre-next-turn** — by the time it fires, the
  CLI has already invoked the tool, so returning `"abort"` terminates
  the run but cannot un-execute the tool. Hook-driven aborts synthesize
  a `CliRunOutput` with `is_error: true`, `result: "Aborted by
  onToolUseObserved callback"`, and a single `permission_denials[]`
  entry `{tool_name, tool_input: {id, reason}}`. Supported on Claude,
  Codex, and OpenCode; Cursor's CLI does not surface tool events, so
  the hook is a no-op there. Per-runtime trigger:
  - **Claude** — fires for every `tool_use` block inside an `assistant` event.
  - **Codex** — fires for `item.completed` items of kind
    `command_execution` / `file_change` / `mcp_tool_call` / `web_search`.
  - **OpenCode** — fires for every non-HITL `tool_use` event once the
    tool reaches a terminal `state.status` (`completed` or `failed`).
  Capability advertised via `RuntimeCapabilities.toolUseObservation`.
- **Motivation:** First-class audit / HITL pre-hook that the SDK inspired.
- **Acceptance:**
  - [x] `onToolUseObserved` callback receives `{id, name, input, turn}`.
        Evidence: `ai-ide-cli/claude/stream.ts`,
        `ai-ide-cli/claude/stream_test.ts`,
        `ai-ide-cli/codex/process.ts:codexItemToToolUseInfo`,
        `ai-ide-cli/opencode/process.ts:openCodeToolUseInfo`.
  - [x] Sync `"abort"` synthesizes `permission_denials[]` and terminates
        the run. Evidence: `ai-ide-cli/claude/stream_test.ts`,
        `ai-ide-cli/opencode/process_test.ts`
        (`invokeOpenCodeCli — onToolUseObserved abort synthesizes …`).
  - [x] Async `"abort"` (awaited decision) also aborts cleanly.
        Evidence: `ai-ide-cli/claude/stream_test.ts`.
  - [x] `"allow"` is a no-op (run continues). Evidence:
        `ai-ide-cli/claude/stream_test.ts`,
        `ai-ide-cli/opencode/process_test.ts`
        (`invokeOpenCodeCli — onToolUseObserved allow does not abort`).
  - [x] `RuntimeCapabilities.toolUseObservation` advertises support
        (Claude `true`, Codex `true`, OpenCode `true`, Cursor `false`).
        Evidence: `ai-ide-cli/runtime/claude-adapter.ts`,
        `ai-ide-cli/runtime/opencode-adapter.ts`,
        `ai-ide-cli/runtime/cursor-adapter.ts`,
        `ai-ide-cli/runtime/codex-adapter.ts`.

### 3.17 FR-L17: Typed Lifecycle Hooks

- **Description:** Claude exposes `ClaudeLifecycleHooks` with
  `onInit(ClaudeSystemEvent)`, `onAssistant(ClaudeAssistantEvent)`,
  `onResult(ClaudeResultEvent)` — each fires with the narrowed event
  _before_ internal state mutations (turn counter, file-read tracker, log
  writes). Runtime-neutral `RuntimeLifecycleHooks` exposes `onInit(info)`
  and `onResult(output)` honored by all four adapters, which translate
  their native init events into the minimal `RuntimeInitInfo` shape.
  Dispatch order is fixed: `onEvent(raw)` → typed hook →
  `onToolUseObserved` (for `tool_use` blocks) → internal mutations.
- **Motivation:** Typed hooks remove casts in consumer code and give
  callers a predictable observation point without subscribing to every
  raw event.
- **Acceptance:**
  - [x] `ClaudeLifecycleHooks` on `StreamProcessorState` and
        `ClaudeInvokeOptions`. Evidence: `ai-ide-cli/claude/stream.ts`,
        `ai-ide-cli/claude/process.ts`.
  - [x] `RuntimeLifecycleHooks` on `RuntimeInvokeOptions`. Evidence:
        `ai-ide-cli/runtime/types.ts`.
  - [x] Dispatch order onEvent → typed hook → internal mutation.
        Evidence: `ai-ide-cli/claude/stream_test.ts`.
  - [x] Typed hook sees pre-increment `turnCount`. Evidence:
        `ai-ide-cli/claude/stream_test.ts`.

### 3.18 FR-L18: Setting-Source Isolation (Claude)

- **Description:** `ClaudeInvokeOptions.settingSources` (and the
  runtime-neutral `RuntimeInvokeOptions.settingSources`) selects which
  Claude configuration sources (`'user'` / `'project'` / `'local'`)
  apply. When provided, the Claude adapter builds a temporary
  `CLAUDE_CONFIG_DIR` via `prepareSettingSourcesDir()` and redirects the
  subprocess env for the run, then removes the tmp dir in `finally`.
  `'user'` symlinks the host `settings.json` into the tmp dir if it
  exists; `'project'` / `'local'` are recognized but not yet isolated
  (they still come from CWD). Other adapters ignore `settingSources`
  silently.
- **Motivation:** Reproducible cleanroom runs for benchmarks and
  experiments — pairs naturally with FR-L9 `env` isolation.
- **Acceptance:**
  - [x] `settingSources?: SettingSource[]` on `RuntimeInvokeOptions`
        and `ClaudeInvokeOptions`. Evidence: `ai-ide-cli/runtime/types.ts`,
        `ai-ide-cli/claude/process.ts`.
  - [x] `['user']` with existing `settings.json` symlinks into tmp dir.
        Evidence: `ai-ide-cli/runtime/setting-sources_test.ts`.
  - [x] `['project']` / `[]` yield an empty tmp dir. Evidence:
        `ai-ide-cli/runtime/setting-sources_test.ts`.
  - [x] `undefined` leaves env untouched and skips tmp-dir setup.
        Evidence: `ai-ide-cli/claude/process.ts`.
  - [x] Cleanup runs on success and failure and is idempotent. Evidence:
        `ai-ide-cli/runtime/setting-sources_test.ts`.

### 3.19 FR-L19: Streaming-Input Session

- **Description:** Long-lived agent session with push-based user input:
  caller opens a session, streams zero or more user messages into the
  running subprocess, consumes normalized events, and closes the session
  gracefully (`endInput`) or forcefully (`abort`).

  **Uniform contract (all four runtimes):**
  - `send(content)` resolves once the runtime has **accepted** the input.
    It never waits for turn completion. Transport/runtime errors during
    turn processing surface via `events` and `done`, not via the `send`
    promise. `send` rejects with a typed `SessionError` subclass:
    `SessionInputClosedError` (after `endInput`), `SessionAbortedError`
    (after `abort`), or `SessionDeliveryError` (HTTP non-2xx for
    OpenCode, closed stdin for Claude, JSON-RPC failure for Codex — the
    underlying transport error is attached as `cause`).
  - `endInput()` signals "no more sends will come" and returns
    **promptly**. Full-shutdown observation is `await session.done`.
  - `abort(reason?)` is a best-effort forceful stop. Idempotent.
  - `events` is a single-consumer async iterator
    (`AsyncIterableIterator<RuntimeSessionEvent>`, one-shot at the type
    layer); the runtime guard in `SessionEventQueue` throws on a second
    `[Symbol.asyncIterator]()` call as a belt-and-suspenders fallback.
    Completes when the underlying transport terminates. Emits exactly
    one {@link SYNTHETIC_TURN_END} synthetic event per completed turn,
    immediately after the runtime's native terminator (see FR-L21).
  - `done` always resolves (never rejects) with `RuntimeSessionStatus`
    once the backing transport has fully terminated.
  - `sessionId: string` is part of the neutral contract (suitable as
    `resumeSessionId` on a later `openSession`). Populated synchronously
    for OpenCode/Cursor/Codex; for Claude, returns `""` until the first
    `system/init` event is parsed, then updates in place.
  - `RuntimeSession` does NOT expose `pid`. Runtime-specific handles
    (`ClaudeSession`, `CursorSession`, `OpenCodeSession`, `CodexSession`)
    may expose `pid` / native id aliases (`chatId`, `threadId`) as their
    own fields.

  **Out of scope (by design):** `RuntimeSessionOptions` omits
  `timeoutSeconds`/`maxRetries`/`retryDelaySeconds` — a session is a
  caller-owned stream. Implement per-turn timeouts and retries via
  `AbortSignal` + reopen with `resumeSessionId`. Mid-session model /
  permissionMode / extraArgs changes likewise require reopening: the
  flags are bound to the subprocess at spawn time.

  Five layers:
  - **Claude-specific.** `openClaudeSession(opts)` spawns `claude -p
    --input-format stream-json --output-format stream-json --verbose` with
    piped stdin. Returns `ClaudeSession { pid, send, events, endInput,
    abort, done }`. `send` accepts a string or a `ClaudeSessionUserInput`
    object and writes `{"type":"user","message":{"role":"user","content":…}}`
    + newline to stdin. `events` is a one-shot async iterator
    (`AsyncIterableIterator<ClaudeStreamEvent>`). `buildClaudeSessionArgs(opts)` is exported
    for testing. `--input-format` is reserved in `CLAUDE_RESERVED_FLAGS`.
    `settingSources` isolation (FR-L18) is honored.
  - **OpenCode-specific.** `openOpenCodeSession(opts)` spawns a dedicated
    `opencode serve --hostname 127.0.0.1 --port <free>` subprocess, parses
    the `listening on …` line from stdout, creates (or resumes) a session
    via `POST /session`, subscribes to `GET /event` (SSE), and forwards
    `send(content)` to `POST /session/:id/prompt_async` with body
    `{ parts: [{type:"text", text}], agent?, model?, system? }`. `model` of
    shape `"<providerID>/<modelID>"` is split into
    `{ providerID, modelID }`; any other string passes through.
    `endInput()` waits for the next session-scoped `session.idle` event and
    SIGTERMs the server; `abort()` issues a best-effort
    `POST /session/:id/abort` then SIGTERMs. Returns `OpenCodeSession` with
    the same `{ pid, send, events, endInput, abort, done }` shape plus
    `sessionId` and `baseUrl`. Each call spawns its own server — sessions
    do not share subprocesses.
  - **Cursor-specific (faux).** Cursor CLI has no streaming-input transport,
    so `openCursorSession(opts)` emulates a session by obtaining a chat ID
    via `cursor agent create-chat` once (or accepting `resumeSessionId`)
    and then spawning one short-lived `cursor agent -p --resume <chatId>
    <message> --output-format stream-json --trust` subprocess per queued
    send. Sends are serialized through an internal worker queue;
    `send(content)` **enqueues and returns immediately** — it does not
    wait for the subprocess to spawn or complete. A synthetic
    `{type:"system",subtype:"init",synthetic:true,session_id:<chatId>}`
    event is pushed at open time so consumers see the chat ID before the
    first turn; per-turn subprocess failures emit a synthetic
    `{type:"error",subtype:"send_failed"}` event instead of rejecting the
    send promise. Returns `CursorSession { runtime, pid, chatId, send,
    events, endInput, abort, done }`; `pid` is a getter reflecting the
    currently-active subprocess (or `0` while idle). `systemPrompt` is
    merged into the first user message of newly created chats and
    suppressed on resume. Model selection is silently dropped (Cursor's
    `--resume` rejects `--model`). `createCursorChat()` and
    `buildCursorSendArgs()` are exported for advanced callers and tests.
  - **Codex-specific.** `openCodexSession(opts)` spawns `codex app-server
    --listen stdio://` (the **experimental** bidirectional JSON-RPC
    transport — NOT `codex exec`, which closes stdin after the first
    prompt). Performs `initialize`/`initialized` handshake, then
    `thread/start` (fresh) or `thread/resume` (on `resumeSessionId`).
    Returns `CodexSession { pid, threadId, send, events, endInput, abort,
    done }`. First `send` maps to `turn/start`; subsequent `send` calls
    while a turn is active map to `turn/steer` with `expectedTurnId` set
    to `activeTurnId`. `activeTurnId` is set synchronously from the RPC
    response (`TurnStartResponse.turn.id` /
    `TurnSteerResponse.turnId`) the moment `client.request()` resolves,
    and reconciled asynchronously from `turn/started` notifications;
    `turn/completed` clears it. Setting from the response closes the
    race where two back-to-back `send()` calls would both route through
    `turn/start` while the notification is still queued. The wire
    payload only includes fields present in the upstream-generated
    schemas (`v2/{ThreadStartParams,ThreadResumeParams,TurnStartParams,
    TurnSteerParams,UserInput}.ts`); orphan fields
    (`experimentalRawEvents`) and no-op duplicates of server defaults
    (`persistExtendedHistory: false`) are not emitted. The underlying
    `CodexAppServerClient` is transport-only; thread/turn semantics
    live in `codex/session.ts`. Targets `codex-cli >= 0.121.0`.
  - **Runtime-neutral.** `RuntimeAdapter.openSession?(opts):
    Promise<RuntimeSession>` is optional; callers check
    `capabilities.session` before invoking. Claude, OpenCode, Cursor, and
    Codex adapters all implement it by delegating to their runtime-specific
    opener and translating native events into `RuntimeSessionEvent
    { runtime, type, raw }` (raw payload preserved for consumers that need
    runtime-specific typing). Event conversion and `onEvent` wrapping go
    through `runtime/session-adapter.ts` (`adaptRuntimeSession` +
    `adaptEventCallback`) so every adapter emits the same shape with no
    duplicated boilerplate. All four `events` iterables share a single
    `runtime/event-queue.ts` (`SessionEventQueue<T>`) implementation.
- **Motivation:** SDK-parity bidirectional sessions — callers can push
  follow-up messages without respawning the CLI from scratch or losing
  context; fits interactive use cases (`/compact`-style flows, human
  correction loops, multi-turn orchestrators). The Cursor faux path gives
  consumers a uniform `openSession` API despite the CLI's lack of a real
  streaming-input transport; Codex adds mid-turn steering, which the
  one-shot `codex exec` transport cannot express.
- **Acceptance:**
  - [x] `openClaudeSession()`, `ClaudeSession`, `ClaudeSessionOptions`,
        `ClaudeSessionStatus`, `ClaudeSessionUserInput`,
        `buildClaudeSessionArgs()` exported. Evidence:
        `ai-ide-cli/claude/session.ts`, `ai-ide-cli/mod.ts`,
        `ai-ide-cli/deno.json` (`./claude/session` sub-path).
  - [x] Claude transport flags: `-p --input-format stream-json
    --output-format stream-json --verbose`; empirically verified against
    real binary. Evidence:
    `ai-ide-cli/claude/session.ts:buildClaudeSessionArgs`,
    `ai-ide-cli/e2e/_matrix.ts:scenarioTwoTurns` (FR-L31).
  - [x] Claude `send()` emits JSONL user-message shape; `endInput()`
    closes stdin gracefully and returns promptly (signal-only);
    `abort()` SIGTERMs and is idempotent; `done` resolves with exit code +
    signal + stderr. Evidence: `ai-ide-cli/claude/session_test.ts`.
  - [x] Uniform `RuntimeSession` contract: `send` resolves on input
    acceptance (never blocks for turn completion); `endInput` is
    signal-only (full-shutdown observable via `done`); `events` is
    single-consumer; `done` always resolves; `pid` is NOT on the neutral
    interface. Evidence: `ai-ide-cli/runtime/session_contract_test.ts`.
  - [x] Shared `SessionEventQueue<T>` and adapter wrappers
    (`adaptRuntimeSession`, `adaptEventCallback`) — no per-adapter
    EventQueue copy-paste. Evidence: `ai-ide-cli/runtime/event-queue.ts`,
    `ai-ide-cli/runtime/session-adapter.ts`.
  - [x] `capabilities.session: true` on Claude, OpenCode, Cursor, and
    Codex; `openSession?` implemented on every adapter;
    `RuntimeSession`, `RuntimeSessionOptions`, `RuntimeSessionEvent`,
    `RuntimeSessionStatus` exported from `mod.ts`. Evidence:
    `ai-ide-cli/runtime/types.ts`,
    `ai-ide-cli/runtime/{claude,opencode,cursor,codex}-adapter.ts`,
    `ai-ide-cli/mod.ts`.
  - [x] `openOpenCodeSession()`, `OpenCodeSession`, `OpenCodeSessionOptions`,
    `OpenCodeSessionStatus`, `OpenCodeSessionEvent` exported. Evidence:
    `ai-ide-cli/opencode/session.ts`, `ai-ide-cli/mod.ts`,
    `ai-ide-cli/deno.json` (`./opencode/session` sub-path).
  - [x] OpenCode transport: spawns `opencode serve`, creates a session via
    `POST /session`, consumes `GET /event` SSE, forwards `send()` to
    `POST /session/:id/prompt_async`, `abort()` to
    `POST /session/:id/abort`. `endInput()` is signal-only — schedules
    the wait-idle-then-SIGTERM in a background task; `done` is the source
    of truth for full shutdown. Evidence:
    `ai-ide-cli/opencode/session.ts:openOpenCodeSession`.
  - [x] `openCursorSession()`, `createCursorChat()`, `buildCursorSendArgs()`,
    `CursorSession`, `CursorSessionOptions`, `CursorSessionStatus`,
    `CursorStreamEvent` exported. Faux session obtains a chat ID via
    `cursor agent create-chat` when `resumeSessionId` is omitted, then
    spawns `cursor agent -p --resume <id> <msg>` once per queued send;
    `send()` enqueues and returns immediately; `endInput()` is
    signal-only; serialized worker queue; synthetic `system.init` emits
    chat ID; per-turn failures surface as synthetic
    `{type:"error",subtype:"send_failed"}` events. Evidence:
    `ai-ide-cli/cursor/session.ts`,
    `ai-ide-cli/cursor/session_test.ts`, `ai-ide-cli/mod.ts`.
  - [x] `openCodexSession()`, `CodexSession`,
    `permissionModeToThreadStartFields()`, `expandCodexSessionExtraArgs()`,
    `updateActiveTurnId()`, `CODEX_SESSION_CLIENT_VERSION` exported.
    Evidence: `ai-ide-cli/codex/session.ts`, `ai-ide-cli/mod.ts`,
    `ai-ide-cli/deno.json` (`./codex/session` sub-path).
  - [x] `CodexAppServerClient`, `CodexAppServerError`,
    `CODEX_APP_SERVER_RESERVED_FLAGS` exported. Transport reserves
    `app-server` and `--listen` flags. Evidence:
    `ai-ide-cli/codex/app-server.ts`, `ai-ide-cli/mod.ts`,
    `ai-ide-cli/deno.json` (`./codex/app-server` sub-path).
  - [x] Codex session `send()` routes first call → `turn/start`,
    subsequent calls during an active turn → `turn/steer`;
    `endInput()` closes the JSON-RPC stdin (signal-only — returns after
    the EOF is flushed, does not wait for subprocess exit);
    `abort()` SIGTERMs and is idempotent; post-`endInput` `send` throws.
    Evidence: `ai-ide-cli/codex/session_test.ts` (stub-binary integration
    tests), `ai-ide-cli/codex/app-server.ts:CodexAppServerClient.closeStdin`.
  - [x] Adapter-level tests for all four runtimes use a PATH-stubbed
    binary: Claude stub emits NDJSON on stdout; OpenCode stub execs a Deno
    fake HTTP+SSE server; Cursor stub dispatches on `create-chat`/`-p` and
    `exec`s the send script so SIGTERM propagates; Codex stub speaks
    JSON-RPC (app-server protocol) on stdio. Claude additionally has a
    smoke test running two live turns + mid-session abort against the
    real binary. Evidence:
    `ai-ide-cli/runtime/claude-adapter_test.ts`,
    `ai-ide-cli/runtime/opencode-adapter_test.ts`,
    `ai-ide-cli/opencode/session_test.ts`,
    `ai-ide-cli/cursor/session_test.ts`,
    `ai-ide-cli/codex/session_test.ts`,
    `ai-ide-cli/e2e/` (real-binary matrix, FR-L31).

### 3.20 FR-L20: Capability Inventory (LLM-probed)

- **Description:** Enumerate every skill and slash command the runtime
  currently exposes in a given `cwd`, without scanning the filesystem.
  Implementation is uniform across all four adapters: issue one LLM turn
  via `adapter.invoke` with a fixed system + task prompt, then parse the
  JSON reply into a {runtime, skills, commands} shape. Method is
  advertised as **expensive** (full LLM turn per call, seconds-to-minutes,
  model-priced) via the `Slow` suffix, and callers should cache results.
  - **Runtime-neutral.** `RuntimeAdapter.fetchCapabilitiesSlow?(opts):
    Promise<CapabilityInventory>` is optional; callers check
    `capabilities.capabilityInventory` before invoking.
    `CapabilityInventory = { runtime, skills: CapabilityRef[], commands:
    CapabilityRef[] }`. `CapabilityRef = { name: string; plugin?: string }`.
    Skills and slash commands are kept as separate arrays even where a
    runtime (Claude) conceptually conflates them.
  - **Schema enforcement.** Claude passes
    `--json-schema <inline-json>` + `--max-turns 1`; Codex writes
    `CAPABILITY_INVENTORY_SCHEMA` to a temp file and passes
    `--output-schema <path>`; OpenCode and Cursor have no schema flag and
    rely on the prompt alone (parser tolerates pure JSON, markdown-fenced
    JSON, and prose-embedded JSON via first/last-brace slice).
- **Motivation:** Consumers (dashboards, IDE selectors, workflow planners)
  need to know what is actually available in a given project without
  replicating per-IDE filesystem/plugin discovery logic (skills may live
  on disk, in plugin caches, or in cloud-hosted plugin scopes). Probing
  the agent itself keeps the library OS- and storage-agnostic.
- **Acceptance:**
  - [x] `fetchCapabilitiesSlow?` implemented on all four adapters; each
    advertises `capabilities.capabilityInventory: true`. Evidence:
    `ai-ide-cli/runtime/{claude,codex,cursor,opencode}-adapter.ts`.
  - [x] Shared driver `fetchInventoryViaInvoke(runtime, invoke, opts,
    extraArgs?)` routes the fixed prompt through the adapter's own
    `invoke` and parses `CliRunOutput.result`. Evidence:
    `ai-ide-cli/runtime/capabilities.ts:fetchInventoryViaInvoke`.
  - [x] Tolerant JSON parser `parseCapabilityInventoryResponse(text,
    runtime)` accepts pure JSON, markdown-fenced JSON, and prose-embedded
    JSON; throws a descriptive error with truncated raw payload when no
    shape matches. Evidence:
    `ai-ide-cli/runtime/capabilities_test.ts` (8 unit tests).
  - [x] `CapabilityInventory`, `CapabilityRef`, `FetchCapabilitiesOptions`,
    `CAPABILITY_INVENTORY_{SYSTEM_PROMPT, PROMPT, SCHEMA}`,
    `parseCapabilityInventoryResponse`, `fetchInventoryViaInvoke`
    exported from `mod.ts`. Evidence: `ai-ide-cli/mod.ts`.

### 3.21 FR-L21: Neutral Turn-End Signal

- **Description:** Every session adapter emits exactly one synthetic
  `RuntimeSessionEvent` with `type === SYNTHETIC_TURN_END` (value
  `"turn-end"`) and `synthetic: true` per completed assistant turn,
  immediately **after** the runtime's native turn-terminator. `raw`
  carries the native payload so consumers who need per-runtime detail
  (success/error subtype, cost, error fields) can reach through. Per-
  runtime source signal:
  - **Claude** — native `event.type === "result"`.
  - **OpenCode** — edge-triggered busy → idle transition in the session
    dispatcher (covers `session.idle` and `session.status { status:
    idle }` uniformly, emits one event per transition).
  - **Cursor** — per-turn subprocess's native `result` event (one
    subprocess per `send`, so one turn-end per send).
  - **Codex** — `turn/completed` JSON-RPC notification.
  Honesty note: turn-end marks "runtime is ready for the next input",
  not a success verdict. Detecting failure still requires inspecting
  prior events or the `raw` payload per runtime (OpenCode's idle does
  not carry a success/error flag, only Claude/Cursor/Codex do).
- **Motivation:** Give downstream session-consumers (e.g. Telegram
  bridges, TUI renderers, live-edit UIs) a single cross-runtime hook for
  "finalize the current turn UI" instead of four per-runtime branches.
- **Acceptance:**
  - [x] `SYNTHETIC_TURN_END` exported from `runtime/types.ts` (and
    re-exported via `mod.ts`). Evidence: `ai-ide-cli/runtime/types.ts`,
    `ai-ide-cli/mod.ts`.
  - [x] `RuntimeSessionEvent.synthetic?: true` documented; present on
    adapter-injected events only. Evidence: `ai-ide-cli/runtime/types.ts`.
  - [x] Claude / Cursor adapters drive turn-end via an `isTurnEnd`
    predicate threaded through `adaptRuntimeSession` +
    `adaptEventCallback`. Evidence:
    `ai-ide-cli/runtime/{claude,cursor}-adapter.ts`,
    `ai-ide-cli/runtime/session-adapter.ts`.
  - [x] OpenCode adapter emits turn-end from an edge-triggered transition
    inside `opencode/session.ts` dispatch (one event per busy → idle).
    Evidence: `ai-ide-cli/opencode/session.ts` `dispatch` function.
  - [x] Codex adapter emits turn-end inside `notificationPump` after each
    `turn/completed` notification. Evidence:
    `ai-ide-cli/codex/session.ts:notificationPump`.
  - [x] Contract test asserts exactly one turn-end per turn, ordered
    after the native terminator, with `synthetic: true` and native
    `raw`. Evidence: `ai-ide-cli/runtime/session_contract_test.ts`
    (`synthetic turn-end is emitted after native result`).

### 3.22 FR-L22: Typed Session Errors

- **Description:** `RuntimeSession.send` rejects with a `SessionError`
  subclass rather than a plain `Error` with a prefixed message. Three
  concrete classes distinguish recoverable states for consumers:
  - `SessionInputClosedError` — `send` called after `endInput`.
    Consumer should reopen the session if it needs to keep sending.
  - `SessionAbortedError` — `send` called after `abort` or an external
    `AbortSignal` tore the session down. Consumer should reopen with
    the preserved `sessionId` as `resumeSessionId` to continue the
    conversation.
  - `SessionDeliveryError` — transport failure (HTTP non-2xx, broken
    stdin, JSON-RPC failure). The underlying error is attached as
    `cause`. Consumer should inspect `cause` to decide whether to retry
    on the same handle or reopen.
  All three descend from `SessionError` so consumers can catch one
  class for generic session failures. `runtime: RuntimeId` is exposed
  on the base class for attribution.
- **Motivation:** Consumers currently match `err.message.startsWith("…
  aborted")` — brittle across runtime-specific wording and future
  refactors. Typed classes give a stable contract with `instanceof`.
- **Acceptance:**
  - [x] `SessionError`, `SessionInputClosedError`,
    `SessionAbortedError`, `SessionDeliveryError` exported from
    `runtime/types.ts` (and `mod.ts`). Evidence:
    `ai-ide-cli/runtime/types.ts`, `ai-ide-cli/mod.ts`.
  - [x] All four session implementations throw the typed classes in
    their `send()` methods (input-closed / aborted / delivery). Evidence:
    `ai-ide-cli/claude/session.ts`, `ai-ide-cli/opencode/session.ts`,
    `ai-ide-cli/cursor/session.ts`, `ai-ide-cli/codex/session.ts`.
  - [x] Codex wraps `CodexAppServerError` from `turn/start`/`turn/steer`
    failures as `SessionDeliveryError` with the original error attached
    as `cause`. Evidence: `ai-ide-cli/codex/session.ts` `send`.
  - [x] Contract tests assert `instanceof` for
    `SessionInputClosedError` and `SessionAbortedError`. Evidence:
    `ai-ide-cli/runtime/session_contract_test.ts`.


### 3.23 FR-L23: Normalized Session Event Content

- **Description:** Pure runtime-neutral helper
  `extractSessionContent(event)` returns
  `NormalizedContent[]` from a `RuntimeSessionEvent`. Union covers
  three shapes: `NormalizedTextContent` (streaming assistant text,
  with `cumulative` flag), `NormalizedToolContent` (tool/command
  invocation — id, name, optional input map), `NormalizedFinalContent`
  (complete assistant reply for the just-ended turn). Envelope
  (`RuntimeSessionEvent`) unchanged; `raw` untouched. Extractor never
  throws — malformed or unrecognized events return `[]`. Synthetic
  events (including `SYNTHETIC_TURN_END`, Cursor's open-time init /
  `send_failed`) return `[]` so consumers observe turn boundaries via
  the existing synthetic-event flag, not via content.
- **Per-runtime source mapping** (keep in sync with the upstream
  protocols — the Codex session path uses app-server v2 camelCase
  types, NOT the snake_case NDJSON types used by `codex exec`):
  - **Claude / Cursor** (stream-json, same shape): `assistant` event
    fans out `raw.message.content[]` (one entry per text or tool_use
    block, order preserved; `thinking` skipped); `result` event
    emits `{kind:"final", text:raw.result}` (empty string included).
  - **Codex** (app-server JSON-RPC notifications):
    `item/agentMessage/delta` → `{kind:"text", cumulative:false}`;
    `item/completed` with `item.type === "agentMessage"` →
    `{kind:"final", text:item.text}`; `commandExecution` / `fileChange`
    / `webSearch` / `mcpToolCall` / `dynamicToolCall` →
    `{kind:"tool", …}` with name mapping documented in
    `runtime/CLAUDE.md`.
  - **OpenCode** (SSE): `message.part.updated` with text part →
    `{kind:"text", cumulative:true}`; with tool part at terminal
    state (`completed`/`failed`), non-HITL → `{kind:"tool", …}`
    (mirrors `openCodeToolUseInfo`'s filtering rule, FR-L16).
- **Documented gaps:**
  - OpenCode has no native final-text event — consumers build `final`
    by keeping the last `cumulative:true` text and flushing on
    `SYNTHETIC_TURN_END`.
  - Claude `thinking` blocks are skipped (reserved for a future
    `kind` variant).
  - Claude `user` events carrying tool results are skipped (reserved
    for a future `kind:"tool-result"` variant).
  - Timing asymmetry: Claude / Cursor emit tool content at
    assistant-decision time (before execution); OpenCode / Codex emit
    at completion time. Documented in `runtime/CLAUDE.md`.
- **Motivation:** Consumers (Telegram bridges, TUI renderers, live-edit
  UIs) need a single rendering path for assistant text chunks, tool
  invocations, and final replies without writing N-way `raw.*`
  branches that break silently on every upstream CLI bump. Extends the
  envelope-level normalization (`SYNTHETIC_TURN_END`, FR-L21) one
  layer deeper into event content.
- **Acceptance:**
  - [x] `NormalizedContent`, `NormalizedTextContent`,
        `NormalizedToolContent`, `NormalizedFinalContent` exported
        from `mod.ts` and `./runtime/content` sub-path. Evidence:
        `ai-ide-cli/runtime/content.ts`, `ai-ide-cli/mod.ts`,
        `ai-ide-cli/deno.json` (`./runtime/content` export).
  - [x] `extractSessionContent(event)` exported with explicit
        `NormalizedContent[]` return type. Evidence:
        `ai-ide-cli/runtime/content.ts:extractSessionContent`.
  - [x] Dispatcher handles all four runtimes (Claude, OpenCode,
        Cursor, Codex) exhaustively via `switch` on `event.runtime`.
        Evidence: `ai-ide-cli/runtime/content.ts`.
  - [x] Pure: no I/O, no state, never throws on malformed payloads.
        Evidence: `ai-ide-cli/runtime/content_dispatch_test.ts`
        (`malformed raw never throws` case).
  - [x] Synthetic events return `[]`. Evidence:
        `ai-ide-cli/runtime/content_dispatch_test.ts`
        (`synthetic turn-end` case);
        `ai-ide-cli/cursor/content_test.ts`
        (`cursor synthetic init`, `cursor synthetic send_failed` cases).
  - [x] Unit tests cover each runtime × each content kind, including
        edge cases (empty final, mixed blocks, HITL filter, non-terminal
        OpenCode tool states, Codex item types without ids). Evidence:
        `ai-ide-cli/claude/content_test.ts`,
        `ai-ide-cli/cursor/content_test.ts`,
        `ai-ide-cli/codex/content_test.ts`,
        `ai-ide-cli/opencode/content_test.ts`.
  - [x] Contract test asserts the normalized stream on a scripted
        event sequence through the Claude stub adapter. Evidence:
        `ai-ide-cli/runtime/session_contract_test.ts`
        (`extractSessionContent surfaces normalized stream` test).
  - [x] Real-binary cross-runtime uniformity: `extractSessionContent`
        applied to every event in a live single-word-reply turn on
        each of the four adapters yields a non-empty
        `NormalizedContent[]` whose joined text/final entries contain
        the reply word, without ever throwing. Evidence:
        `ai-ide-cli/e2e/_matrix.ts:scenarioContentNormalization`
        (FR-L31 matrix entry).
  - [x] `// FR-L23` traceability comment on the
        `extractSessionContent` dispatcher. Evidence:
        `ai-ide-cli/runtime/content.ts`.

### 3.24 FR-L24: Typed Tool Filter on Runtime Options

- **Description:** `RuntimeInvokeOptions` and `RuntimeSessionOptions`
  expose `allowedTools?: string[]` and `disallowedTools?: string[]` as
  first-class typed fields. Each adapter translates them into its
  runtime-native CLI flag (Claude: `--allowedTools` /
  `--disallowedTools`, emitted as exactly two argv tokens with the
  array comma-joined into a single value). Adapters without native
  tool filtering advertise `capabilities.toolFilter === false`, run
  the shared validator (so malformed input throws uniformly across
  runtimes), and emit one `console.warn` on first set-value use per
  process; subsequent calls stay silent. `RuntimeCapabilities.toolFilter`
  is a new boolean capability — Claude `true`, OpenCode / Cursor /
  Codex `false`.
- **Validation contract** (runs on every adapter):
  - Setting both typed fields on the same call → synchronous throw
    (`mutually exclusive`).
  - Empty array or empty-string members → synchronous throw
    (`non-empty`).
  - Typed field set AND any of `--allowedTools`, `--allowed-tools`,
    `--disallowedTools`, `--disallowed-tools`, `--tools` in
    `extraArgs` → synchronous throw (`extraArgs key "..." collides`).
  - Legacy path preserved: `extraArgs` carrying the raw flags
    without a typed field still works (backwards compatible).
- **Motivation:** Downstream consumer
  [`@korchasa/flowai-workflow`](https://github.com/korchasa/flowai-workflow/issues/188)
  needs engine-level YAML `allowed_tools` / `disallowed_tools`
  without reinventing per-runtime `extraArgs` mapping, without
  bypassing the reserved-key guard, and without branching on runtime
  name. Mirrors the existing `permissionMode` pattern.
- **Acceptance:**
  - [x] `RuntimeInvokeOptions.allowedTools` / `.disallowedTools`
    accept non-empty string arrays. Evidence:
    `ai-ide-cli/runtime/types.ts`.
  - [x] `RuntimeSessionOptions.allowedTools` / `.disallowedTools`
    accept non-empty string arrays. Evidence:
    `ai-ide-cli/runtime/types.ts`.
  - [x] `RuntimeCapabilities.toolFilter: boolean` — Claude `true`,
    others `false`. Evidence: all four adapters in
    `ai-ide-cli/runtime/*-adapter.ts`.
  - [x] Claude `invoke` and `openSession` emit
    `--allowedTools <comma-joined>` OR
    `--disallowedTools <comma-joined>` (at most one) when the typed
    field is set, on both initial and `--resume` paths. Evidence:
    `ai-ide-cli/claude/process.ts:buildClaudeArgs`,
    `ai-ide-cli/claude/session.ts:buildClaudeSessionArgs`.
  - [x] Mutual exclusion, empty-array / empty-string rejection, and
    `extraArgs` reserved-key collision enforced synchronously via
    the shared `validateToolFilter` helper. Evidence:
    `ai-ide-cli/runtime/tool-filter.ts`,
    `ai-ide-cli/runtime/tool-filter_test.ts`.
  - [x] Non-Claude adapters run the validator and emit exactly one
    `console.warn` on first set-value occurrence per process.
    Evidence: `ai-ide-cli/runtime/opencode-adapter.ts`,
    `ai-ide-cli/runtime/cursor-adapter.ts`,
    `ai-ide-cli/runtime/codex-adapter.ts` (module-level
    `warnedToolFilter` latch + `_resetToolFilterWarning` test
    helper); `ai-ide-cli/runtime/opencode-adapter_test.ts`
    (warn-once + reset coverage).
  - [x] `// FR-L24` traceability comments at the argv-emission
    sites. Evidence: `ai-ide-cli/claude/process.ts:buildClaudeArgs`,
    `ai-ide-cli/claude/session.ts:buildClaudeSessionArgs`.

### 3.25 FR-L25: Abstract Reasoning-Effort on Runtime Options

- **Description:** `RuntimeInvokeOptions` and `RuntimeSessionOptions`
  expose `reasoningEffort?: "minimal" | "low" | "medium" | "high"` as a
  first-class typed field. The value is a runtime-neutral dial; each
  adapter maps it to its closest native control (Claude `--effort`,
  Codex `--config model_reasoning_effort=…`, OpenCode `--variant` /
  `body.variant`). Cursor has no native control and accepts the field
  with a one-time `console.warn`. Every adapter also emits a one-time
  warn when the mapping is lossy (Claude's `"minimal"` degrades to
  `"low"`; OpenCode's `--variant` is provider-specific and may or may
  not honour the requested depth). `RuntimeCapabilities.reasoningEffort`
  is a new boolean capability — Claude / Codex / OpenCode `true`,
  Cursor `false`.
- **Validation contract** (runs on every adapter via shared
  `validateReasoningEffort` in `runtime/reasoning-effort.ts`):
  - Value outside the 4-level enum → synchronous throw
    (`reasoningEffort must be one of …`).
  - Typed field set AND either `--effort` or `--variant` present in
    `extraArgs` → synchronous throw (`extraArgs key "..." collides`).
  - Legacy path preserved: `extraArgs: {"--effort": …}` or
    `{"--variant": …}` without the typed field still works
    (backwards-compatible — reserved flag lists are **not** extended).
- **Scenario:** A consumer iterates the same config against all four
  runtimes and wants the model to "think harder" for a hard task
  without branching on runtime name. Setting
  `reasoningEffort: "high"` produces `--effort high` on Claude,
  `--config model_reasoning_effort="high"` on Codex, and
  `--variant high` (plus `body.variant = "high"` on the session
  transport) on OpenCode; Cursor logs one warning and runs unchanged.
- **Acceptance:**
  - [x] `RuntimeInvokeOptions.reasoningEffort` accepts the 4-level
    enum. Evidence: `ai-ide-cli/runtime/types.ts`.
  - [x] `RuntimeSessionOptions.reasoningEffort` accepts the 4-level
    enum. Evidence: `ai-ide-cli/runtime/types.ts`.
  - [x] `RuntimeCapabilities.reasoningEffort: boolean` — Claude /
    Codex / OpenCode `true`, Cursor `false`. Evidence: all four
    adapters in `ai-ide-cli/runtime/*-adapter.ts`.
  - [x] Claude `invoke` and `openSession` emit `--effort <value>`
    with `"minimal"` degraded to `"low"` plus a one-time console
    warning. Evidence: `ai-ide-cli/claude/process.ts:buildClaudeArgs`,
    `ai-ide-cli/claude/session.ts:buildClaudeSessionArgs`,
    `mapReasoningEffortToClaude`.
  - [x] Codex `invoke` emits `--config model_reasoning_effort="<value>"`
    and `openSession` prepends the same `--config` override to the
    `codex app-server` argv. Evidence:
    `ai-ide-cli/codex/process.ts:buildCodexArgs`,
    `ai-ide-cli/codex/session.ts:openCodexSession`.
  - [x] OpenCode `invoke` emits `--variant <value>` and `openSession`
    sets `body.variant = <value>` on every `POST /session/:id/prompt_async`.
    Evidence: `ai-ide-cli/opencode/process.ts:buildOpenCodeArgs`,
    `ai-ide-cli/opencode/session.ts`.
  - [x] Non-exact mappings trigger exactly one `console.warn` per
    process (Claude `"minimal"` → `"low"`; OpenCode any value —
    provider-specific). Cursor warns once on any value. Evidence:
    `_resetClaudeReasoningEffortWarning` in
    `ai-ide-cli/claude/process.ts`;
    `_resetReasoningEffortWarning` in
    `ai-ide-cli/runtime/{opencode,cursor}-adapter.ts`; tests in
    `ai-ide-cli/runtime/cursor-adapter_test.ts`,
    `ai-ide-cli/runtime/opencode-adapter_test.ts`,
    `ai-ide-cli/claude/process_test.ts`.
  - [x] Out-of-enum values and `--effort`/`--variant` collisions in
    `extraArgs` throw synchronously through `validateReasoningEffort`.
    Evidence: `ai-ide-cli/runtime/reasoning-effort.ts`,
    `ai-ide-cli/runtime/reasoning-effort_test.ts`.
  - [x] `// FR-L25` traceability comments at the argv / body
    emission sites. Evidence:
    `ai-ide-cli/claude/process.ts:buildClaudeArgs`,
    `ai-ide-cli/claude/session.ts:buildClaudeSessionArgs`,
    `ai-ide-cli/codex/process.ts:buildCodexArgs`,
    `ai-ide-cli/codex/session.ts:openCodexSession`,
    `ai-ide-cli/opencode/process.ts:buildOpenCodeArgs`,
    `ai-ide-cli/opencode/session.ts`.
  - [x] `RuntimeConfigSource.effort?: ReasoningEffort` cascades through
    `resolveRuntimeConfig` (`node` → `parent` → `defaults`) and is exposed
    on `ResolvedRuntimeConfig.reasoningEffort`. Mirrors the `model`
    precedence rule on `runtime/index.ts:97`. Evidence:
    `ai-ide-cli/runtime/index.ts:resolveRuntimeConfig`,
    `ai-ide-cli/runtime/types.ts:RuntimeConfigSource,ResolvedRuntimeConfig`,
    `ai-ide-cli/runtime/index_test.ts` (4 tests under
    "reasoning effort cascade").
  - [x] Claude `buildClaudeArgs` suppresses `--effort` emission when
    `resumeSessionId` is set, mirroring `--model` semantics on
    `claude/process.ts:290`. The session inherits its original
    reasoning-effort level on resume. Evidence:
    `ai-ide-cli/claude/process.ts:buildClaudeArgs`,
    `ai-ide-cli/claude/process_test.ts`
    ("buildClaudeArgs — resume path suppresses --effort").

### 3.26 FR-L26: Typed Codex App-Server Notifications

- **Description:** Library exposes a sharp discriminated union over the
  Codex `app-server` JSON-RPC notification stream so consumers narrow
  `note.params` to a typed payload instead of casting `Record<string,
  unknown>`. Hand-mirrored from `codex app-server generate-ts
  --experimental` output (variants the library actively narrows on);
  unrecognized methods remain accessible through the raw
  `CodexUntypedNotification` shape preserved by the transport client.
- **Scenario:** Embedding application iterates
  `CodexAppServerClient.notifications` to render a turn's lifecycle.
  Without typed events, every consumer rewrites the same `(note.params as
  any).turn.id` casts. With FR-L26, `isCodexNotification(note,
  "turn/started")` narrows the variable to `CodexTurnStartedNotification`
  and `note.params.turn` is typed as `CodexTurn`.
- **Acceptance:**
  - [x] `codex/events.ts` exposes the typed union `CodexNotification`
    covering `thread/started`, `turn/started`, `turn/completed`,
    `item/started`, `item/completed`, `item/agentMessage/delta`,
    `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`,
    `item/commandExecution/outputDelta`, `error`. Evidence:
    `ai-ide-cli/codex/events.ts`.
  - [x] `CodexThreadItem` discriminated union over `item.type` covers
    `userMessage`, `agentMessage`, `reasoning`, `plan`,
    `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`,
    `webSearch`, `contextCompaction`. Evidence:
    `ai-ide-cli/codex/events.ts`.
  - [x] `isCodexNotification(note, method)` is a working type guard:
    after the check, `note.params` narrows to the variant's typed shape
    without explicit casts. Evidence:
    `ai-ide-cli/codex/events_test.ts` (6 tests covering `turn/started`,
    `turn/completed`, `item/agentMessage/delta`, `item/completed` →
    `commandExecution`, `item/started` → `mcpToolCall`, unknown method
    fallthrough).
  - [x] `CodexAppServerNotification` continues to type the
    `client.notifications` iterator as the runtime shape
    (`CodexUntypedNotification`) — no breaking change at the transport
    layer; consumers still iterate the raw form and apply the type
    guard to narrow. Evidence:
    `ai-ide-cli/codex/app-server.ts:CodexAppServerNotification`.
  - [x] `updateActiveTurnId` uses `isCodexNotification` instead of
    manual casts. Evidence:
    `ai-ide-cli/codex/session.ts:updateActiveTurnId`.
  - [x] All public types are barrel-exported from `mod.ts`. Evidence:
    `ai-ide-cli/mod.ts` (codex events block).
  - [x] `// FR-L26` traceability comments at the narrowing sites.
    Evidence: `ai-ide-cli/codex/session.ts:updateActiveTurnId`,
    `ai-ide-cli/codex/events.ts` (module JSDoc).
  - [x] Real-binary verification: live `codex app-server` notification
    stream surfaces `turn/started` and `turn/completed` notifications
    that narrow via `isCodexNotification` to `CodexTurnStartedNotification`
    / `CodexTurnCompletedNotification`; field access uses
    `note.params.turn.id` / `note.params.turn.status` directly without
    casts (a schema rename breaks the access). Evidence:
    `ai-ide-cli/e2e/_matrix.ts:scenarioCodexTypedNotifications`
    (FR-L31 matrix entry `codex-typed-notification-narrowing`).

### 3.27 FR-L27: Typed OpenCode SSE Session Events

- **Description:** Library exposes a sharp discriminated union over the
  OpenCode `/event` SSE stream consumed by `openOpenCodeSession`,
  matching the `Event` and `Part` unions published by
  `@opencode-ai/sdk`. The legacy `OpenCodeStreamEvent` (which currently
  models the `opencode run --format json` schema, not the SSE schema)
  is renamed to a more accurate name and kept as a deprecated alias for
  one minor cycle to preserve JSR backward compatibility.
- **Scenario:** Embedding application iterates
  `OpenCodeSession.events` and wants to render `message.part.updated`
  with typed `Part` payloads (`text`/`tool`/`reasoning`/`file`/
  `step-start`/`step-finish`/`patch`/`agent`/`retry`/`compaction`/
  `subtask`). Without typed events, every consumer rewrites
  `(raw.properties.part as any).type` casts; with FR-L27,
  `isOpenCodeEvent(note, "message.part.updated")` narrows the variant
  and `event.properties.part` becomes `OpenCodePart` (a sharp
  discriminated union over `part.type`).
- **Acceptance:**
  - [ ] `opencode/events.ts` exposes the typed union `OpenCodeEvent`
    covering at minimum the SSE variants the library and downstream
    consumers narrow on: `server.connected`, `session.created`,
    `session.updated`, `session.idle`, `session.status`,
    `session.error`, `message.updated`, `message.part.updated`,
    `message.part.removed`, `permission.updated`, `permission.replied`,
    `file.edited`. Forward-compat fallback is the runtime shape
    `OpenCodeUntypedEvent` (mirrors the FR-L26 split between sharp
    `CodexNotification` and runtime `CodexUntypedNotification`).
    Evidence: `ai-ide-cli/opencode/events.ts`.
  - [ ] `OpenCodePart` discriminated union over `part.type` covers
    `text`, `reasoning`, `file`, `tool`, `step-start`, `step-finish`,
    `snapshot`, `patch`, `agent`, `retry`, `compaction`, `subtask`.
    `OpenCodeToolState` further narrows `ToolPart.state.status` to
    `pending` / `running` / `completed` / `error`. Evidence:
    `ai-ide-cli/opencode/events.ts`.
  - [ ] `isOpenCodeEvent(event, type)` is a working type guard:
    after the check, `event.properties` narrows to the variant's typed
    shape without explicit casts. Evidence:
    `ai-ide-cli/opencode/events_test.ts` (≥ 6 tests covering the
    common narrowing paths and the unknown-event fallback).
  - [ ] The legacy `OpenCodeStreamEvent` (modelling `opencode run
    --format json` events `step_start` / `text` / `tool_use` /
    `step_finish` / `error`) is renamed to `OpenCodeRunStreamEvent`
    and re-exported under the legacy name as a deprecated type
    alias (`@deprecated` JSDoc, alias kept for one minor cycle).
    Evidence: `ai-ide-cli/opencode/process.ts`,
    `ai-ide-cli/CHANGELOG.md`.
  - [ ] `opencode/session.ts` dispatcher consumes the typed
    `OpenCodeEvent` union (no `Record<string, unknown>` casts in the
    busy/idle / `message.part.updated` branches). Evidence:
    `ai-ide-cli/opencode/session.ts`.
  - [ ] `runtime/content.ts` OpenCode branch consumes
    `OpenCodePart` / `OpenCodeToolState` types instead of stringly-typed
    field access (no behaviour change; types-only). Evidence:
    `ai-ide-cli/runtime/content.ts:extractOpenCodeContent`.
  - [ ] Public types are barrel-exported from `mod.ts`. Evidence:
    `ai-ide-cli/mod.ts`.
  - [ ] `// FR-L27` traceability comments at narrowing sites in
    `opencode/session.ts` and `runtime/content.ts`.
  - [ ] `deno publish --dry-run` continues to pass — no JSR slow-types
    regression. Evidence: green CI run / local `deno task check`.

### 3.28 FR-L28: `CODEX_HOME` Setting-Source Isolation

- **Description:** Codex adapter honors `RuntimeInvokeOptions.settingSources` /
  `RuntimeSessionOptions.settingSources` by populating a temp directory
  with the listed sources and pointing the spawned `codex` subprocess at
  it via the `CODEX_HOME` environment variable. Mirrors the Claude
  adapter's FR-L18 behaviour for cleanroom / per-invocation config
  isolation. `capabilities.settingSources` becomes runtime-aware (Claude
  / Codex `true`; OpenCode / Cursor `false`).
- **Scenario:** Pipeline runs three Codex turns with different effective
  configs (different `~/.codex/config.toml`, different
  `~/.codex/instructions.md`). Without isolation each run pollutes the
  global home; with FR-L28 each run sees a fresh `CODEX_HOME` populated
  from `settingSources`.
- **Acceptance:**
  - [ ] `runtime/setting-sources.ts` (or a new
    `codex/setting-sources.ts`) exposes
    `prepareCodexSettingSourcesDir(sources, opts)` that builds a temp
    directory under `Deno.makeTempDir()` and returns the path. Evidence:
    `ai-ide-cli/runtime/setting-sources.ts` /
    `ai-ide-cli/codex/setting-sources.ts`.
  - [ ] `codex/process.ts:invokeCodexCli` and
    `codex/session.ts:openCodexSession` set `env.CODEX_HOME = <tempdir>`
    on the spawned subprocess when `settingSources` is provided. Cleanup
    runs in a `finally` block. Evidence:
    `ai-ide-cli/codex/process.ts`, `ai-ide-cli/codex/session.ts`.
  - [ ] New `RuntimeCapabilities.settingSources: boolean` capability
    flag (Claude / Codex `true`; OpenCode / Cursor `false`). Existing
    `settingSources` field stays on options (already there) — only the
    capability metadata changes. Evidence:
    `ai-ide-cli/runtime/types.ts:RuntimeCapabilities`,
    `ai-ide-cli/runtime/{claude,codex,opencode,cursor}-adapter.ts`.
  - [ ] Tests verify the populated `CODEX_HOME` directory contents
    match the listed sources, env var lands on the subprocess, and
    cleanup succeeds. Evidence:
    `ai-ide-cli/codex/setting-sources_test.ts`,
    `ai-ide-cli/codex/process_test.ts`,
    `ai-ide-cli/codex/session_test.ts`.
  - [ ] `// FR-L28` traceability comments at the env-emission sites.
  - [ ] OpenCode / Cursor adapters with `capabilities.settingSources
    === false` emit one `console.warn` on first set-value call per
    process when `settingSources` is provided (mirrors the FR-L24 /
    FR-L25 warn-once latch pattern). Evidence:
    `ai-ide-cli/runtime/{cursor,opencode}-adapter.ts`.

### 3.29 FR-L29: Codex Per-Turn Lifecycle Hook

- **Description:** Codex session and one-shot invocation adapters fire a
  per-turn lifecycle hook on the `turn/completed` JSON-RPC notification
  (session) and the corresponding `turn.completed` NDJSON event
  (one-shot). Surfaces a typed `CodexTurn` payload to consumers that
  want a "one event per turn" handle without iterating the full event
  stream. Mirrors the Claude `onAssistant` ergonomics on a per-turn
  granularity instead of per-assistant-message — Codex emits multiple
  agent-message items per turn so per-turn is the closer analogue.
- **Scenario:** Embedding application wants to log turn cost / status /
  error after each turn. Today consumers must filter
  `RuntimeSessionEvent.type === "turn-end"` and read `raw.params.turn`.
  With FR-L29 they pass `hooks.onCodexTurnCompleted: (turn: CodexTurn,
  threadId: string) => void` and skip the filtering layer.
- **Acceptance:**
  - [ ] `codex/session.ts` and `codex/process.ts` fire
    `hooks.onCodexTurnCompleted?(turn, threadId)` on the
    `turn/completed` notification path; `turn` is typed as
    {@link CodexTurn} (FR-L26). Evidence:
    `ai-ide-cli/codex/session.ts`, `ai-ide-cli/codex/process.ts`.
  - [ ] New optional Codex-specific hook field on
    `CodexSessionOptions` and `RuntimeInvokeOptions` (or a Codex-only
    options interface, mirroring `ClaudeLifecycleHooks`); does NOT
    appear on the cross-runtime `RuntimeLifecycleHooks` (which stays
    `onInit` / `onResult` only). Evidence:
    `ai-ide-cli/codex/session.ts`, `ai-ide-cli/codex/process.ts`.
  - [ ] Tests cover hook firing exactly once per `turn/completed`,
    not on `turn/started`, and pass-through of `turn.error` /
    `turn.durationMs`. Evidence: `ai-ide-cli/codex/session_test.ts`,
    `ai-ide-cli/codex/process_test.ts`.
  - [ ] `// FR-L29` traceability comments at the hook-fire sites.

### 3.30 FR-L30: Typed Cursor Stream-JSON Event Union & Tool-Call Lifecycle

- **Description:** Cursor adapter emits a discriminated union
  `CursorStreamEvent` over `cursor agent -p --output-format stream-json`,
  parses tool-call events as a separate event class (Cursor wraps tool
  calls in `tool_call.<name>ToolCall.{args|result}`, distinct from
  Claude's inline `tool_use` blocks), surfaces them through the
  cross-runtime `onToolUseObserved` callback, exposes a typed
  per-assistant-turn lifecycle hook, and forks the
  `extractSessionContent` cursor branch from the shared Claude branch so
  tool invocations stop being silently dropped.
- **Scenario:** Empirical capture of `cursor agent -p` stream-json
  output (`scripts/smoke.ts cursor-events`, dump
  `/tmp/cursor-events-*.ndjson`) revealed six distinct event types
  (`system/init`, `user`, `thinking/{delta,completed}`, `assistant`,
  `tool_call/{started,completed}`, `result/success`). The previous
  shared Claude/Cursor extractor in `runtime/content.ts` only handled
  `assistant` and `result`, so every Cursor `tool_call/*` event
  collapsed to `[]`, producing the false matrix entry "no
  toolUseObservation" — the bug was on the consumer side, not Cursor.
  Consumers using `extractSessionContent` saw zero tool blocks for
  Cursor sessions while the runtime emitted them on every read / grep /
  edit. After this FR, consumers receive
  `NormalizedToolContent` for Cursor tool calls, and adapters hosting an
  `onToolUseObserved` hook receive `RuntimeToolUseInfo` for each
  Cursor tool dispatch.
- **Acceptance:**
  - [x] `cursor/stream.ts` exports a discriminated union
    `CursorStreamEvent` covering `system`, `user`, `thinking`,
    `assistant`, `tool_call`, `result`, and a forward-compat
    `CursorUnknownEvent` fallback. Includes `parseCursorStreamEvent`
    NDJSON parser (mirrors `parseClaudeStreamEvent`). Evidence:
    `// FR-L30` comments at the union and parser definitions; tests
    `ai-ide-cli/cursor/stream_test.ts`.
  - [x] Tool-call events typed as
    `CursorToolCallStartedEvent | CursorToolCallCompletedEvent` with
    `subtype` discriminator, `call_id`, and a `tool_call` wrapper
    payload. Helper `unwrapCursorToolCall(raw)` flattens the
    `<name>ToolCall` wrapper into `{name, args, result?,
    errorMessage?}` so consumers do not enumerate per-tool keys
    themselves. Evidence: `// FR-L30` traceability at the helper.
  - [x] `runtime/content.ts` forks the cursor extractor from the shared
    Claude path: `extractCursorContent` handles `assistant` (text
    blocks only — Cursor never inlines tool blocks), `tool_call` with
    `subtype === "started"` → `NormalizedToolContent` (via
    `unwrapCursorToolCall`), and `result` → `NormalizedFinalContent`.
    Tests cover at least one `tool_call/started` event yielding a
    tool entry. Evidence: `// FR-L30` comments at the cursor case;
    tests in `ai-ide-cli/runtime/content_test.ts`.
  - [x] `cursor/process.ts` fires `onToolUseObserved` on every
    `tool_call/started` event with a flattened `RuntimeToolUseInfo`
    (`runtime: "cursor"`, `id: call_id`, `name: <unwrapped>`,
    `input: <args>`, `turn: <turn count>`). Returning `"abort"`
    triggers SIGTERM and the adapter synthesizes a `CliRunOutput`
    with `is_error: true` and a `permission_denials[]` entry
    describing the observed tool — symmetric with Claude's behaviour.
    Evidence: stub-based unit tests in
    `ai-ide-cli/cursor/process_test.ts` plus `// FR-L30`
    traceability.
  - [x] `runtime/cursor-adapter.ts` flips
    `capabilities.toolUseObservation` from `false` to `true` and
    propagates `opts.onToolUseObserved` into the cursor invocation,
    translating the Cursor-specific info shape into
    `RuntimeToolUseInfo` (mirrors the Claude-adapter wiring).
  - [x] `cursor/stream.ts` exports `CursorLifecycleHooks` with
    `onInit` / `onAssistant` / `onResult`; `onAssistant` fires once
    per `assistant` event with the typed `CursorAssistantEvent`.
    Surfaced through `cursor/process.ts` to close the
    "per-assistant-turn lifecycle hook: cursor: no" matrix row.
  - [x] README feature matrix flips for Cursor: `toolUseObservation`,
    `typed event union`, `typed assistant content blocks` (partial —
    text-only blocks; tool calls are sibling events not inline
    blocks), and `per-assistant-turn lifecycle hook`. Evidence:
    `README.md` matrix section.
  - [x] Real-binary smoke verification: `deno run -A scripts/smoke.ts
    cursor-events` against installed `cursor agent -p` captures NDJSON
    histogram (system/user/thinking/assistant/tool_call/result), confirms
    typed parser handles the actual wire format. Evidence:
    `scripts/smoke.ts:cursor-events` scenario.
  - [x] Real-binary e2e regression: `invokeCursorCli` against installed
    `cursor agent -p --yolo` with a Read-tool prompt surfaces a typed
    `tool_call/started` event via `parseCursorStreamEvent`, that
    `unwrapCursorToolCall` flattens into a non-empty `{name, args?}`,
    and that `onToolUseObserved` fires with `runtime: "cursor"` plus
    non-empty `id`/`name`. Evidence:
    `ai-ide-cli/e2e/cursor_typed_stream_e2e_test.ts` (FR-L31 standalone).

### 3.31 FR-L31: Real-Binary E2E Suite

- **Description:** Opt-in `deno test`–based suite under `e2e/` that
  exercises the four runtime adapters against their real CLI binaries
  (Claude Code, OpenCode, Cursor, Codex). Driven by a shared
  session-contract matrix (`e2e/_matrix.ts` — `SESSION_CONTRACT_MATRIX`)
  so every session-capable adapter is asserted against the same
  invariants (`sessionId` population, `SYNTHETIC_TURN_END` cardinality,
  `SessionInputClosedError` / `SessionAbortedError` typing, mid-turn
  `abort()`, two-turn flow, content normalization across all four
  runtimes, codex-typed JSON-RPC notification narrowing). Adapter-specific
  non-matrix scenarios (Claude `invokeClaudeCli` AbortSignal, Claude
  `settingSources: []` cleanroom, Cursor typed stream-json + tool-call
  observation under `--yolo`) live next to the matrix generator as
  standalone `*_e2e_test.ts` files. All tests guard with `ignore: !enabled[runtime]`
  where `enabled` is pre-resolved at test-file load time via
  `e2eEnabled(runtime)` — gate requires `E2E=1` and (optionally) a
  comma-separated `E2E_RUNTIMES` allow-list, plus the runtime's CLI
  binary on PATH. Missing binaries surface as ignored tests, never
  ENOENT.
- **Motivation:** Unit tests use PATH-stub binaries (e.g.
  `claude/session_test.ts`) which catch logic regressions but not
  upstream CLI drift (argv renames, event-shape changes, protocol bumps).
  Before FR-L31 only Claude had real-binary coverage via the bespoke
  `scripts/smoke.ts` runner. FR-L31 turns that coverage into a uniform,
  Deno-native, opt-in suite with enforced per-runtime symmetry.
  `scripts/smoke.ts` retains its role as an ad-hoc capture script for
  typing new runtime stream events (FR-L30 cursor-events workflow).
- **Acceptance:**
  - [x] `e2e/` directory with `_helpers.ts`, `_matrix.ts`,
        `session_matrix_e2e_test.ts`, `invoke_abort_e2e_test.ts`,
        `claude_settings_e2e_test.ts`,
        `cursor_typed_stream_e2e_test.ts`. Evidence:
        `ai-ide-cli/e2e/`.
  - [x] `e2eEnabled(runtime)` gate combines `E2E=1`, optional
        `E2E_RUNTIMES` allow-list, and `detectBinary(runtime)` probe
        (cached per runtime). Evidence:
        `ai-ide-cli/e2e/_helpers.ts`.
  - [x] `Deno.test#ignore` receives a synchronous boolean — gate is
        pre-resolved via top-level `await resolveEnabledMap()`.
        Evidence: `ai-ide-cli/e2e/session_matrix_e2e_test.ts`,
        `ai-ide-cli/e2e/invoke_abort_e2e_test.ts`,
        `ai-ide-cli/e2e/claude_settings_e2e_test.ts`.
  - [x] Session-contract matrix covers 9 scenarios: `sessionId-sync`
        (opencode/cursor/codex), `sessionId-after-first-event`
        (claude), `synthetic-turn-end-once-per-turn`,
        `send-after-endInput-throws-SessionInputClosedError`,
        `send-after-abort-throws-SessionAbortedError`,
        `abort-mid-turn-terminates`, `two-turns`,
        `content-normalization` (FR-L23 cross-runtime),
        `codex-typed-notification-narrowing` (FR-L26 codex-only).
        Evidence: `ai-ide-cli/e2e/_matrix.ts:SESSION_CONTRACT_MATRIX`.
  - [x] `content-normalization` scenario — `extractSessionContent`
        applied to every event in a live single-word-reply turn:
        never throws, synthetic events return `[]`, non-synthetic
        events yield ≥1 `NormalizedContent`, joined `text`/`final`
        entries contain the reply word (case-insensitive). Evidence:
        `ai-ide-cli/e2e/_matrix.ts:scenarioContentNormalization`.
  - [x] `MatrixScenario.ceilingMs` per-runtime override; Cursor
        receives 90 s, others 60 s. Evidence:
        `ai-ide-cli/e2e/_matrix.ts`.
  - [x] `// FR-L31` traceability comment next to the matrix
        definition. Evidence: `ai-ide-cli/e2e/_matrix.ts`.
  - [x] `deno.json` tasks `e2e`, `e2e:claude`, `e2e:opencode`,
        `e2e:cursor`, `e2e:codex`. Evidence:
        `ai-ide-cli/deno.json` tasks section.
  - [x] `deno.json` `publish.exclude` covers `e2e` and `e2e/**`.
        Evidence: `ai-ide-cli/deno.json` publish section.
  - [x] `.github/workflows/e2e.yml` with `workflow_dispatch` trigger,
        installs Claude / OpenCode / Codex on Ubuntu, runs
        `deno test -A --no-check e2e/` with `E2E=1`. Cursor is
        Linux-headless-unsupported and is expected to skip. Evidence:
        `ai-ide-cli/.github/workflows/e2e.yml`.
  - [x] E2E does not run in CI (FR-L34). The
        `.github/workflows/ci-e2e.yml` soak workflow was removed —
        running the suite without authenticated CLI sessions
        produced spurious failures (`"Not logged in"` masquerading
        as session output) that hid real regressions instead of
        surfacing them. Manual `workflow_dispatch` trigger via
        `.github/workflows/e2e.yml` remains for ad-hoc runs from a
        repo with the appropriate API key secrets configured.
        Evidence: `ai-ide-cli/.github/workflows/` (no `ci-e2e.yml`).
  - [x] Cross-runtime `invoke()` abort symmetry (FR-L15): one
        triple of `pre-start abort` / `mid-run abort` /
        `timeout-without-signal` per runtime drives
        `getRuntimeAdapter(runtime).invoke(...)` against every
        binary, so the `"Aborted before start"` /
        `"Aborted: <reason>"` contract is asserted on Claude,
        OpenCode, Cursor, and Codex live binaries — not just
        Claude. Evidence:
        `ai-ide-cli/e2e/invoke_abort_e2e_test.ts`.
  - [x] Cross-runtime `onToolUseObserved` symmetry (FR-L16): one
        scenario per runtime in the Claude / OpenCode / Codex
        triple invokes a tool-emitting prompt under
        `permissionMode: "bypassPermissions"` in a
        `Deno.makeTempDir()` cwd and asserts the observer fires
        with non-empty `id`, `name`, and a `runtime` field
        matching the dispatching adapter. Cursor is excluded —
        covered by the dedicated FR-L30 test
        (`cursor_typed_stream_e2e_test.ts`). Evidence:
        `ai-ide-cli/e2e/tool_use_observed_e2e_test.ts`.
  - [x] `allowedTools` / `disallowedTools` argv-propagation
        smoke on Claude (FR-L24): `allowedTools: ["Read"]` +
        `disallowedTools: ["WebSearch"]` plus a one-word prompt
        complete without a flag-parse error from the binary,
        confirming the typed fields reach `--allowedTools` /
        `--disallowedTools` argv intact. Behavioural blocking
        depends on `--permission-mode` and Claude's internal
        policy and is deliberately NOT asserted (Claude-CLI
        concern, not an adapter concern; covered in unit tests
        of `runtime/tool-filter.ts`). Evidence:
        `ai-ide-cli/e2e/tool_filter_e2e_test.ts`.

### 3.32 FR-L33: Sync `PWD` Env Var With Subprocess `cwd`

- **Description:** Every adapter spawn site that accepts `cwd` routes
  the subprocess `env` through `withSyncedPWD(env, cwd)` from
  `runtime/env-cwd-sync.ts`. The helper returns a new env with
  `PWD = resolve(cwd)` whenever `cwd` is supplied and the caller did
  not pre-populate `env.PWD`. When `cwd` is absent, `env` is returned
  unchanged (inherited `PWD` is correct by definition). When the
  caller explicitly passed `env.PWD`, caller intent wins. Pure: never
  mutates the input env, never throws.
- **Motivation:** `Deno.Command({cwd, env})` updates the kernel-level
  cwd via `chdir(2)` but leaves `env.PWD` inherited from the parent
  process. Tools inside spawned IDE binaries that resolve relative
  paths against `$PWD` (instead of `getcwd(2)`) then operate on the
  wrong directory. In `@korchasa/flowai-workflow` runs this surfaces
  as cross-worktree file leaks: the engine spawns opencode with
  `cwd = <per-run worktree>` while `PWD = <consumer repo root>` flows
  in from the user shell. opencode's file-write tools resolve against
  `$PWD` and write into the consumer repo; `git add && git commit`
  (which uses `getcwd(2)`) operates on the worktree. The FR-E50 leak
  guardrail then fires on diverged state. POSIX leaves `$PWD` ↔
  kernel-cwd consistency to the shell — anyone calling `posix_spawn`
  must keep them in sync explicitly.
- **Scenario:** A consumer invokes any adapter with
  `opts.cwd = "/some/worktree"` and no `opts.env.PWD`. The spawned
  child process observes `PWD=/some/worktree` (absolute, even if
  `opts.cwd` was relative). If the consumer instead passes
  `opts.env.PWD = "/explicit/override"`, the child observes that
  exact value. If the consumer passes no `cwd`, no `PWD` is injected.
- **Acceptance:**
  - [x] `runtime/env-cwd-sync.ts` exports
        `withSyncedPWD(env, cwd): env` with the four documented
        branches (cwd undefined → no-op; env.PWD set → no-op;
        env undefined + cwd set → `{PWD}`; env set + cwd set →
        merged). Evidence: `// FR-L33` traceability comment above
        the export.
  - [x] Every `new Deno.Command(...)` site that takes `cwd` in the
        adapter dirs (`claude/`, `opencode/`, `codex/`, `cursor/`)
        and the runtime dispatchers (`runtime/claude-adapter.ts`,
        `runtime/opencode-adapter.ts`, `runtime/codex-adapter.ts`)
        routes `env` through `withSyncedPWD`. Evidence: `// FR-L33`
        traceability comments at every call site.
  - [x] `runtime/env-cwd-sync_test.ts` covers all four branches
        plus a relative-cwd → absolute-PWD case, an integration
        smoke that spawns `bash -c 'echo "$PWD"'` and asserts the
        child observes the resolved tmpDir. Evidence:
        `ai-ide-cli/runtime/env-cwd-sync_test.ts`.

### 3.33 FR-L34: Auth-Probe Gate For E2E Suite

- **Description:** `e2eEnabled(runtime)` runs an authentication probe
  after the binary-presence check. The probe issues a one-shot
  `adapter.invoke({ taskPrompt: "Reply with exactly the word: ok",
  timeoutSeconds: 25, ... })` and scans the JSON-serialized
  `CliRunOutput` for known auth-failure substrings (`"not logged in"`,
  `"please run /login"`, `"invalid api key"`, `"401 unauthorized"`,
  …). On match the probe **throws** a loud `Error` carrying the
  runtime, matched pattern, and a 400-byte truncated payload. The
  throw propagates through `e2eEnabled` (and therefore
  `resolveEnabledMap`), failing every test file at top-level await
  time. Probe result is cached per runtime for the lifetime of the
  Deno process so the four-runtime fan-out in
  `resolveEnabledMap` pays the cost at most once per runtime.
- **Motivation:** Before FR-L34 the e2e gate proved only that the
  binary existed on PATH. An installed-but-unauthenticated CLI (no
  OAuth login, no API key) returned an error message inside the
  normal `CliRunOutput.result` envelope (e.g. Claude
  `"Not logged in · Please run /login"`); session-contract tests
  treated it as a valid response, so 9 of 11 scenarios passed
  spuriously while only the two that asserted on assistant text
  failed — a textbook false-positive layout that hid real
  regressions. The auth-probe makes "not logged in" a single,
  loud, actionable error per runtime instead of a noisy mix.
- **Scope:** E2E does not run in CI (the soak workflow
  `.github/workflows/ci-e2e.yml` was removed in the same change).
  Manual `workflow_dispatch` via `.github/workflows/e2e.yml`
  remains for ad-hoc runs from a repo with API key secrets
  configured. Locally, every `deno task e2e` / `deno task
  e2e:<runtime>` invocation depends on a logged-in CLI on the
  developer machine.
- **Acceptance:**
  - [x] `e2e/_auth.ts` exports `assertAuthenticated(runtime)` —
        cached per runtime via `Map<RuntimeId, Promise<void>>`,
        runs a one-shot `adapter.invoke("Reply with: ok")` with a
        25 s `timeoutSeconds` plus a 30 s belt-and-suspenders
        `AbortSignal.timeout`, then JSON-stringifies and
        lowercases the result for substring scan against
        `AUTH_FAIL_PATTERNS`. Evidence: `// FR-L34` traceability
        comment above the `assertAuthenticated` export.
  - [x] `AUTH_FAIL_PATTERNS` covers Claude / OpenCode / Codex
        common auth-failure phrasings (`"not logged in"`,
        `"please run /login"`, `"please run \`<cli> login\`"`,
        `"invalid api key"`, `"missing api key"`,
        `"no api key"`, `"authentication failed"`,
        `"401 unauthorized"`, `"unauthorized"`,
        `"api key not found"`). Evidence:
        `ai-ide-cli/e2e/_auth.ts`.
  - [x] `e2eEnabled(runtime)` invokes `assertAuthenticated` after
        the binary probe passes; on auth failure the throw
        propagates through `resolveEnabledMap` (top-level await
        in every `*_e2e_test.ts` test file), so a missing login
        fails the suite at load time instead of producing dozens
        of spurious assertion failures. Evidence:
        `ai-ide-cli/e2e/_helpers.ts`.
  - [x] `_resetAuthProbeCache()` exported for unit-test
        isolation. Evidence: `ai-ide-cli/e2e/_auth.ts`.
  - [x] `.github/workflows/ci-e2e.yml` removed (CI no longer
        runs e2e on PR/push). Evidence:
        `ai-ide-cli/.github/workflows/` listing.

## 4. Non-Functional Requirements

- **Zero engine dependency:** `rg "from.*@korchasa/flowai-workflow" ai-ide-cli/`
  must return 0 matches.
- **Publish independently:** `deno publish --dry-run` from `ai-ide-cli/`
  must pass without engine co-publication.
- **No slow types:** All public API exports have explicit types (JSR
  `no-slow-types` rule).

## 5. Interfaces

### CLI Invocation Contracts

Each runtime adapter spawns a CLI binary with specific flags. Contracts:

- **`claude`:**
  - Binary: `claude`
  - `--output-format stream-json` — NDJSON event stream
  - `--resume <session-id>` — session continuation
  - `-p "<prompt>"` — task prompt
  - `--model <model>` — model selection (fresh only)
  - `--permission-mode <mode>` — permission control
  - `--agent <name>` — agent selection (fresh only)
  - `--append-system-prompt <text>` — system context (fresh only)
  - `--verbose` — full streaming
  - `runtime_args` forwarded as extra CLI flags
  - Env override: `CLAUDECODE=""` (allow nested invocations)

- **`opencode`:**
  - Binary: `opencode`
  - `run --format json` — NDJSON event stream
  - `run --session <id>` — session resume
  - `run --model <provider/model>` — model (fresh only)
  - `run --agent <name>` — agent (fresh only)
  - `--dangerously-skip-permissions` — bypass (when `bypassPermissions`)
  - No system-prompt flag; prepended to task prompt
  - `runtime_args` forwarded as extra flags
  - Env: `OPENCODE_CONFIG_CONTENT` for per-invocation MCP injection

- **`cursor`:**
  - Binary: `cursor`
  - `agent -p` — headless mode (subcommand + flag)
  - `--output-format stream-json` — NDJSON event stream
  - `--resume <chatId>` — session resume
  - `--model <model>` — model (fresh only)
  - `--yolo` — bypass permissions (when `bypassPermissions`)
  - `--trust` — skip workspace trust prompt
  - No system-prompt flag; prepended to task prompt
  - `runtime_args` forwarded as extra flags

### Event Mapping Contracts

The four adapters speak four different wire protocols (Claude & Cursor
`stream-json` NDJSON, OpenCode SSE, Codex JSON-RPC camelCase). This
subsection is the normative mapping from each native event shape to
the runtime-neutral primitives consumers actually program against:
`RuntimeSessionEvent` (FR-L19), `SYNTHETIC_TURN_END` (FR-L21), and
`NormalizedContent` (FR-L23). If any cell drifts from the code, the
code is authoritative and the SRS row is a bug; the e2e scenarios
`synthetic-turn-end-once-per-turn` and `content-normalization`
(FR-L31) assert the invariants against the live binaries.

#### Envelope: native event → `RuntimeSessionEvent`

Every adapter yields `{ runtime, type, raw, synthetic? }` where
`raw` preserves the full native payload for consumers who need
runtime-specific typed access.

| Runtime  | Wire protocol                      | `type` source                             | `raw` shape                               |
|----------|------------------------------------|-------------------------------------------|-------------------------------------------|
| claude   | `stream-json` NDJSON over stdout   | native `event.type` string (falls back to `"unknown"`) | top-level stream-json object verbatim |
| cursor   | `stream-json` NDJSON (per-turn)    | native `event.type` string (falls back to `"unknown"`) | top-level stream-json object verbatim |
| opencode | SSE frames from `GET /event`       | SSE frame's `type` field (falls back to `"unknown"`)   | `{ type, properties?, raw }` of the SSE frame |
| codex    | JSON-RPC 2.0 notifications         | last `/`-separated segment of `method`    | `{ method, params }`                      |

Codex note: the last-segment mapping collapses `thread/started`,
`turn/started`, and `item/started` to the same `type === "started"`;
consumers that need to distinguish must read `raw.method`.

#### Synthetic event catalogue

Adapter-injected events — never originate from the CLI. All carry
`synthetic: true`.

| Runtime | Synthetic event                                                    | Trigger                                                                 | Rationale                                                                                        |
|---------|--------------------------------------------------------------------|-------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------|
| all     | `{ type: SYNTHETIC_TURN_END, raw: <native terminator>, synthetic: true }` | emitted once per completed turn, immediately after the native terminator (FR-L21) | single cross-runtime turn-boundary hook                                                          |
| cursor  | `{ type: "system", subtype: "init", session_id: <chatId>, synthetic: true }` | emitted at `openSession()` time                                         | surfaces the `chatId` before the first per-turn subprocess runs (Cursor has no open-time native init) |
| cursor  | `{ type: "error", subtype: "send_failed", error, synthetic: true }`  | a per-turn subprocess fails to spawn or exits non-zero before streaming | per-send failures surface as events instead of rejecting the `send()` promise (`send()` enqueues) |

#### Turn-end source (`SYNTHETIC_TURN_END` trigger)

Per-runtime native signal that drives the synthetic turn-end emission
and the `raw` payload carried on it.

| Runtime  | Native terminator                                         | `raw.type` / `raw.method` carried on the synthetic | Honesty note                                                |
|----------|-----------------------------------------------------------|----------------------------------------------------|-------------------------------------------------------------|
| claude   | stream-json event with `type === "result"`                | `"result"`                                         | carries per-run cost / error fields for consumers           |
| cursor   | per-turn subprocess's `type === "result"` event           | `"result"`                                         | one subprocess per send → one turn-end per send             |
| opencode | edge-triggered busy → idle dispatcher transition          | `"session.idle"` or `"session.status"`              | native signal can be either; both are valid                 |
| codex    | JSON-RPC notification `method === "turn/completed"`       | `raw.method === "turn/completed"` (type segment: `"completed"`) | notification path is authoritative, not the `turn/start` RPC reply |

Turn-end marks "runtime is ready for the next input", not "turn
succeeded". Failure detection still requires inspecting `raw` or
prior events.

#### Content extraction (`extractSessionContent` — FR-L23)

Native events are mapped to a `NormalizedContent[]` union:
`{kind:"text", text, cumulative}` (streaming text),
`{kind:"tool", id, name, input?}` (tool invocation),
`{kind:"final", text}` (complete reply for the just-ended turn).
Synthetic events and unrecognised types return `[]`. The extractor
never throws on malformed payloads.

| Runtime        | Native event (→ sub-shape)                                | NormalizedContent output                                     | Notes                                                                     |
|----------------|-----------------------------------------------------------|--------------------------------------------------------------|---------------------------------------------------------------------------|
| claude, cursor | `assistant` → `raw.message.content[i].type === "text"`    | `{kind:"text", text, cumulative: true}`                      | order preserved; whole running message per event                           |
| claude, cursor | `assistant` → `raw.message.content[i].type === "tool_use"` | `{kind:"tool", id, name, input?}`                            | fires at assistant-decision time (before execution)                        |
| claude, cursor | `assistant` → `raw.message.content[i].type === "thinking"` | — (skipped)                                                 | reserved for a future `kind:"reasoning"` variant                           |
| claude, cursor | `user` events carrying tool results                       | — (skipped)                                                 | reserved for a future `kind:"tool-result"` variant                         |
| claude, cursor | `result`                                                  | `{kind:"final", text: raw.result}`                           | empty string included                                                     |
| codex          | `item/agentMessage/delta` notification                    | `{kind:"text", text: <delta>, cumulative: false}`            | Codex emits deltas, not cumulative snapshots                               |
| codex          | `item/completed` with `item.type === "agentMessage"`       | `{kind:"final", text: item.text}`                            | text taken directly from `item.text`, not from `content[]`                 |
| codex          | `item/completed` with `item.type ∈ {commandExecution, fileChange, webSearch}` | `{kind:"tool", name: item.type, input: item \ {id,type}}` | fires at completion time (after execution)                               |
| codex          | `item/completed` with `item.type === "mcpToolCall"`        | `{kind:"tool", name: "<server>.<tool>", input}`              | `server.tool` composed from `item.server`/`item.tool`                      |
| codex          | `item/completed` with `item.type === "dynamicToolCall"`    | `{kind:"tool", name: item.tool, input}`                      | dynamic tool name comes from `item.tool`                                   |
| opencode       | `message.part.updated` with `part.type === "text"`         | `{kind:"text", text: part.text, cumulative: true}`            | OpenCode has no native `final` — consumer flushes last cumulative text on `SYNTHETIC_TURN_END` |
| opencode       | `message.part.updated` with `part.type === "tool"` at terminal `state.status` (`completed`/`failed`), non-HITL | `{kind:"tool", id, name, input?}` | mirrors FR-L16 terminal-state rule; id falls back `part.id → part.callID` |
| opencode       | HITL tool (`OPENCODE_HITL_MCP_TOOL_NAME`)                 | — (skipped)                                                 | HITL detection uses its own dedicated path                                |
| opencode       | non-terminal tool states (`part.type === "tool"` mid-run)  | — (skipped)                                                 | only terminal states surface to `kind:"tool"`                             |
| all            | any synthetic event (`synthetic: true`)                   | `[]`                                                         | consumers observe turn boundaries via the envelope flag, not content      |
| all            | unrecognised `type` / malformed `raw`                     | `[]`                                                         | extractor is stateless and never throws                                   |

Timing asymmetry (documented in code as well): Claude and Cursor
dispatch tool content at assistant-decision time (before the tool
runs); OpenCode and Codex dispatch at completion time.
