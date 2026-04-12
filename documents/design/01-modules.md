<!-- section file — index: [documents/design.md](../design.md) -->

# SDS AI IDE CLI — Modules


## 1. Introduction

- **Purpose:** Design of the `@korchasa/ai-ide-cli` library — thin wrapper
  around agent-CLI binaries providing normalized invocation, stream parsing,
  retry, and HITL wiring.
- **Relation to SRS:** Implements FR-L1..FR-L8 from
  [requirements.md](../requirements.md).

## 2. Architecture

```
ai-ide-cli/
  types.ts              — shared types (RuntimeId, CliRunOutput, HitlConfig, ...)
  process-registry.ts   — pure child-process tracker + shutdown callbacks
  mod.ts                — public API barrel (re-exports all sub-paths)
  runtime/
    types.ts            — RuntimeAdapter, RuntimeConfigSource, capabilities
    index.ts            — adapter registry + resolveRuntimeConfig()
    claude-adapter.ts   — Claude RuntimeAdapter (delegates to claude/process)
    opencode-adapter.ts — OpenCode RuntimeAdapter (delegates to opencode/process)
    cursor-adapter.ts   — Cursor RuntimeAdapter (delegates to cursor/process)
  claude/
    process.ts          — buildClaudeArgs, invokeClaudeCli, executeClaudeProcess
    stream.ts           — processStreamEvent, extractClaudeOutput, FileReadTracker,
                          formatEventForOutput, stampLines, formatFooter
  opencode/
    process.ts          — buildOpenCodeArgs, invokeOpenCodeCli, extractOpenCodeOutput,
                          formatOpenCodeEventForOutput, buildOpenCodeConfigContent
    hitl-mcp.ts         — runOpenCodeHitlMcpServer (stdio MCP for HITL tool)
  cursor/
    process.ts          — buildCursorArgs, invokeCursorCli, extractCursorOutput,
                          formatCursorEventForOutput
```

**Dependency rule:** All arrows point inward. Runtime-specific modules import
from `types.ts` and `process-registry.ts`. Adapters import from their
runtime's `process.ts`. `mod.ts` re-exports everything. Zero imports from
engine or any external workflow package.


## 3. Components

### 3.1 `types.ts` — Shared Types

`RuntimeId` union: `"claude" | "opencode" | "cursor"`. `VALID_RUNTIME_IDS`
array for config validation.

`PermissionMode` — Claude Code `--permission-mode` values. Kept here because
multiple runtimes reference it for compatibility checks.

`CliRunOutput` — runtime-neutral output shape:
`result`, `session_id`, `total_cost_usd`, `duration_ms`, `duration_api_ms`,
`num_turns`, `is_error`, optional `permission_denials`, `hitl_request`,
`runtime`. All runtime extractors produce this shape.

`HitlConfig` — HITL configuration: `ask_script`, `check_script`,
`artifact_source`, `poll_interval`, `timeout`, `exclude_login`. Consumed by
OpenCode's MCP injection; Claude HITL handled engine-side via
`permission_denials`.

`HumanInputRequest` — normalized HITL question: `question`, `header`,
`options[]`, `multiSelect`.


### 3.2 `process-registry.ts` — Process Tracker

Pure tracker. No signal wiring. API: `register(p)`, `unregister(p)`,
`killAll()`, `onShutdown(cb)`.

`killAll()` sequence: SIGTERM all → `Promise.race([allSettled, 5s timeout])`
→ SIGKILL survivors → run shutdown callbacks.

Test helpers (`_reset`, `_getProcesses`, `_getShutdownCallbacks`) prefixed
with `_` for test isolation.


### 3.3 `runtime/` — Adapter Layer

**`runtime/types.ts`:**
- `RuntimeCapabilities` — feature flags per adapter: `permissionMode`, `hitl`,
  `transcript`.
- `RuntimeInvokeOptions` — normalized invocation options: `taskPrompt`,
  `resumeSessionId`, `model`, `permissionMode`, `extraArgs`, `timeoutSeconds`,
  `maxRetries`, `retryDelaySeconds`, `onOutput`, `streamLogPath`, `verbosity`,
  `hitlConfig`, `hitlMcpCommandBuilder`, `cwd`, `agent`, `systemPrompt`.
- `RuntimeInvokeResult` — `{ output?: CliRunOutput; error?: string }`.
- `RuntimeAdapter` — interface: `id`, `capabilities`, `invoke(opts)`.
- `ResolvedRuntimeConfig` — effective config after cascade resolution.
- `RuntimeConfigSource` — structural shape for cascade input. No workflow
  type dependency.

**`runtime/index.ts`:**
- `ADAPTERS` record keyed by `RuntimeId`.
- `getRuntimeAdapter(id)` — lookup.
- `resolveRuntimeConfig({defaults, node, parent})` — merges `runtime_args`
  from all cascade levels (defaults → parent → node). Model and
  permissionMode use first-defined-wins (node > parent > defaults).


### 3.4 `claude/process.ts` — Claude Runner

`buildClaudeArgs(opts: ClaudeInvokeOptions)`: constructs argv.
Order: `--permission-mode` → `claudeArgs` → `--resume` → `-p` →
`--agent` → `--append-system-prompt` → `--model` → `--output-format
stream-json --verbose`. Resume skips `--agent`, `--append-system-prompt`,
`--model` (session inherits).

`invokeClaudeCli(opts)`: retry loop with exponential backoff. On `is_error`
result → retry. On exception → retry. Returns `RuntimeInvokeResult`.

`executeClaudeProcess(args, ...)`: spawns `Deno.Command("claude")` with
`CLAUDECODE=""` env override. Reads stdout as NDJSON lines, delegates to
`processStreamEvent()` from `claude/stream.ts`. Collects stderr. Timeout
via `setTimeout` → `SIGTERM`. Registered/unregistered in process registry.


### 3.5 `claude/stream.ts` — Stream Processing

`processStreamEvent(event, state)`: mutable state bag
(`StreamProcessorState`). Handles:
- `assistant` → increment turn count, write separator to log, track Read
  tool_use via `FileReadTracker`
- `result` → `extractClaudeOutput()`, write footer to log
- All events → `formatEventForOutput()` for log + terminal

`extractClaudeOutput(event)`: maps result event fields to `CliRunOutput`
with `runtime: "claude"`.

`formatEventForOutput(event, verbosity?)`: one-line summaries. `system/init`
→ model info. `assistant` → text preview + tool names.
Semi-verbose skips `tool_use` blocks.

`FileReadTracker`: per-path read counter with configurable threshold.
`track(path)` → warning string or null. Pure class.

`stampLines(text)`: prepend `[HH:MM:SS]` to each non-empty line.
`formatFooter(output)`: `status=<ok|error> duration=<X>s cost=$<Y>
turns=<N>`.


### 3.6 `opencode/process.ts` — OpenCode Runner

`buildOpenCodeArgs(opts)`: `run` → `--session` → `--model` → `--agent` →
`--dangerously-skip-permissions` → `extraArgs` → `--format json` → prompt.

`extractOpenCodeOutput(lines)`: parses collected NDJSON lines. Event types:
`step_start` (increment steps), `text` (accumulate result), `tool_use`
(HITL detection), `step_finish` (cost), `error` (error message). Returns
`CliRunOutput` with `runtime: "opencode"`.

`buildOpenCodeConfigContent(opts)`: when HITL configured, builds
`OPENCODE_CONFIG_CONTENT` JSON with local MCP server entry. Requires
`hitlMcpCommandBuilder` — throws if missing.

HITL interception: `extractHitlRequestFromEvent()` detects
`hitl_request_human_input` tool_use with `status: "completed"`. Normalizes
to `HumanInputRequest`. On detection → SIGTERM process → return output with
`hitl_request` populated.


### 3.7 `opencode/hitl-mcp.ts` — HITL MCP Server

`runOpenCodeHitlMcpServer()`: stdio MCP server exposing
`request_human_input` tool. Tool schema: `question` (required string),
`header`, `options[]`, `multiSelect`. Tool handler returns
`{ok: true}` — actual question delivery/polling handled by engine's
HITL pipeline after process termination.

Constants: `OPENCODE_HITL_MCP_SERVER_NAME = "hitl"`,
`OPENCODE_HITL_MCP_TOOL_NAME = "hitl_request_human_input"`.


### 3.8 `cursor/process.ts` — Cursor Runner

`buildCursorArgs(opts)`: `agent` → `-p` → `--resume` → `--model` →
`--yolo` → `extraArgs` → `--output-format stream-json` → `--trust` →
prompt. Resume skips `--model`.

`extractCursorOutput(event)`: maps result event to `CliRunOutput` with
`runtime: "cursor"`. Same stream-json format as Claude.

`formatCursorEventForOutput(event, verbosity?)`: one-line summaries.
Same event shape as Claude stream-json. Semi-verbose filtering supported.

`invokeCursorCli(opts)`: prepends system prompt to task prompt (no
dedicated flag). Retry loop with exponential backoff. Real-time NDJSON
processing with log file + terminal output forwarding.


## 4. Data

### Runtime capability matrix

| Runtime  | permissionMode | hitl  | transcript |
|----------|----------------|-------|------------|
| claude   | true           | true  | true       |
| opencode | false          | false | false      |
| cursor   | false          | false | false      |


## 5. Constraints

- **No domain logic:** Library MUST NOT contain git, GitHub, workflow, DAG,
  or any domain-specific code.
- **No engine imports:** Zero imports from `@korchasa/flowai-workflow`.
- **Structural typing:** `RuntimeConfigSource` uses structural shape, not
  imported workflow types.
- **Publish order:** `ai-ide-cli` published before `engine` — engine's
  workspace imports auto-pin to ide-cli version at publish time.
