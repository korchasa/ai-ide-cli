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
    `launchInteractive()`. Evidence: `ai-ide-cli/runtime/types.ts:113-124`.
  - [x] `RuntimeCapabilities` flags: `permissionMode`, `hitl`, `transcript`,
    `interactive`. Evidence: `ai-ide-cli/runtime/types.ts:9-19`.
  - [x] `getRuntimeAdapter(id)` returns adapter from registry.
    Evidence: `ai-ide-cli/runtime/index.ts:18-20`.
  - [x] `resolveRuntimeConfig()` merges `runtime_args` across cascade levels.
    Evidence: `ai-ide-cli/runtime/index.ts:30-53`.
  - [x] `RuntimeConfigSource` structural type — no workflow imports.
    Evidence: `ai-ide-cli/runtime/types.ts:112-121`.
  - [x] Three adapters registered: `claude`, `opencode`, `cursor`.
    Evidence: `ai-ide-cli/runtime/index.ts:11-15`.


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
- **Acceptance:**
  - [x] `buildOpenCodeArgs()` emits `run`, `--format json`, `--session`,
    `--model`, `--agent`, `--dangerously-skip-permissions`.
    Evidence: `ai-ide-cli/opencode/process.ts:26-53`.
  - [x] `buildOpenCodeConfigContent()` injects MCP server when HITL configured;
    throws when `hitlMcpCommandBuilder` missing.
    Evidence: `ai-ide-cli/opencode/process.ts:148-172`.
  - [x] HITL request extraction from `tool_use` events.
    Evidence: `ai-ide-cli/opencode/process.ts:424-455`.
  - [x] Tests: args, output extraction, HITL, config content.
    Evidence: `ai-ide-cli/opencode/process_test.ts`.


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
