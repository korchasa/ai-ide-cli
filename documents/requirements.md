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
  - Agent CLI binaries (`claude`, `opencode`, `cursor`) installed and on PATH.
  - Deno runtime available (library uses `Deno.Command` for subprocess spawn).
  - Consumers handle signal installation; library exposes `killAll()` but
    does not wire OS signals.

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
        `interactive`, `toolUseObservation`, `session`. Evidence:
        `ai-ide-cli/runtime/types.ts`.
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

- **Description:** Pure child-process tracker. `register(p)` / `unregister(p)`
  track spawned processes. `killAll()` sends SIGTERM, waits 5s, then SIGKILL.
  `onShutdown(cb)` registers cleanup callbacks. No OS signal wiring — consumers
  own that.
- **Motivation:** Centralized process lifecycle enables graceful shutdown
  across all runtimes without each adapter managing its own cleanup.
- **Acceptance:**
  - [x] `register`, `unregister`, `killAll`, `onShutdown` exported.
        Evidence: `ai-ide-cli/process-registry.ts`.
  - [x] `killAll()` SIGTERM → 5s wait → SIGKILL → callbacks.
        Evidence: `ai-ide-cli/process-registry.ts:36-80`.
  - [x] All runtime runners call `register`/`unregister` around subprocess
        lifecycle. Evidence: `ai-ide-cli/claude/process.ts:157-158,275`,
        `ai-ide-cli/opencode/process.ts:244,391`,
        `ai-ide-cli/cursor/process.ts:166-167,253`.

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
        `--model`, `--agent`, `--dangerously-skip-permissions`.
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
  - `events` is a single-consumer async iterable; re-iteration throws.
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
    + newline to stdin. `events` is a single-consumer async iterable of
    parsed `ClaudeStreamEvent`. `buildClaudeSessionArgs(opts)` is exported
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
    while a turn is active map to `turn/steer` with `expectedTurnId` taken
    from the latest `turn/started` notification (not the `turn/start`
    response — those can arrive in either order, the notification is
    authoritative). `turn/completed` clears the active turn. The
    underlying `CodexAppServerClient` is transport-only; thread/turn
    semantics live in `codex/session.ts`. Targets `codex-cli >= 0.121.0`.
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
    `ai-ide-cli/scripts/smoke.ts` `session` group.
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
    `ai-ide-cli/scripts/smoke.ts`.

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
