<!-- section file — index: [documents/requirements.md](../requirements.md) -->

# SRS AI IDE CLI — Core Requirements


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
  - [x] `RuntimeAdapter` interface with `id`, `capabilities`, `invoke()`.
    Evidence: `ai-ide-cli/runtime/types.ts:83-90`.
  - [x] `RuntimeCapabilities` flags: `permissionMode`, `hitl`, `transcript`.
    Evidence: `ai-ide-cli/runtime/types.ts:9-16`.
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
