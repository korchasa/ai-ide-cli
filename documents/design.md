# SDS: AI IDE CLI

Design specification for `@korchasa/ai-ide-cli`.

## 1. Introduction

- **Purpose:** Design of the `@korchasa/ai-ide-cli` library — thin wrapper
  around agent-CLI binaries providing normalized invocation, stream parsing,
  retry, and HITL wiring.
- **Relation to SRS:** Implements FR-L1..FR-L20 from
  [requirements.md](requirements.md).

## 2. Architecture

```
ai-ide-cli/
  types.ts              — shared types (RuntimeId, CliRunOutput, HitlConfig, ...)
  process-registry.ts   — pure child-process tracker + shutdown callbacks
  mod.ts                — public API barrel (re-exports all sub-paths)
  runtime/
    types.ts            — RuntimeAdapter, RuntimeConfigSource, capabilities
    index.ts            — adapter registry + resolveRuntimeConfig()
    capabilities.ts     — CapabilityInventory types + shared LLM-probe driver
                          (fetchInventoryViaInvoke, parseCapabilityInventoryResponse)
    claude-adapter.ts   — Claude RuntimeAdapter (delegates to claude/process)
    opencode-adapter.ts — OpenCode RuntimeAdapter (delegates to opencode/process)
    cursor-adapter.ts   — Cursor RuntimeAdapter (delegates to cursor/process)
  claude/
    process.ts          — buildClaudeArgs, invokeClaudeCli, executeClaudeProcess
    stream.ts           — processStreamEvent, extractClaudeOutput, FileReadTracker,
                          formatEventForOutput, stampLines, formatFooter
    session.ts          — openClaudeSession, buildClaudeSessionArgs, ClaudeSession
                          (streaming-input session with piped stdin)
  opencode/
    process.ts          — buildOpenCodeArgs, invokeOpenCodeCli, extractOpenCodeOutput,
                          formatOpenCodeEventForOutput, buildOpenCodeConfigContent
    session.ts          — openOpenCodeSession, OpenCodeSession (streaming-input
                          session backed by `opencode serve` + HTTP + SSE)
    hitl-mcp.ts         — runOpenCodeHitlMcpServer (stdio MCP for HITL tool)
  cursor/
    process.ts          — buildCursorArgs, invokeCursorCli, extractCursorOutput,
                          formatCursorEventForOutput
    session.ts          — openCursorSession, createCursorChat,
                          buildCursorSendArgs, CursorSession (faux streaming
                          session: create-chat + resume-per-send)
  codex/
    process.ts          — buildCodexArgs, invokeCodexCli, applyCodexEvent,
                          extractCodexOutput, findCodexSessionFile,
                          permissionModeToCodexArgs, formatCodexEventForOutput
    hitl-mcp.ts         — runCodexHitlMcpServer (stdio MCP for HITL tool)
    app-server.ts       — CodexAppServerClient, CodexAppServerError,
                          CodexAppServerNotification (JSON-RPC transport for
                          `codex app-server --listen stdio://`)
    session.ts          — openCodexSession, CodexSession,
                          permissionModeToThreadStartFields,
                          expandCodexSessionExtraArgs, updateActiveTurnId
                          (streaming-input session over app-server)
  skill/
    types.ts            — SkillDef, SkillFrontmatter (union of all IDE fields)
    parser.ts           — parseSkill(dir) → SkillDef
    mod.ts              — barrel export for @korchasa/ai-ide-cli/skill
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
  `transcript`, `interactive`, `toolUseObservation`, `session`,
  `capabilityInventory`.
- `RuntimeInvokeOptions` — normalized invocation options: `taskPrompt`,
  `resumeSessionId`, `model`, `permissionMode`, `extraArgs`, `timeoutSeconds`,
  `maxRetries`, `retryDelaySeconds`, `onOutput`, `streamLogPath`, `verbosity`,
  `hitlConfig`, `hitlMcpCommandBuilder`, `cwd`, `agent`, `systemPrompt`,
  `env`, `onEvent`.
- `RuntimeInvokeResult` — `{ output?: CliRunOutput; error?: string }`.
- `InteractiveOptions` — `{ skills?, systemPrompt?, cwd?, env? }`.
- `InteractiveResult` — `{ exitCode: number }`.
- `RuntimeSessionOptions` — streaming-session options: `agent`, `systemPrompt`,
  `resumeSessionId`, `extraArgs`, `permissionMode`, `model`, `signal`, `cwd`,
  `env`, `settingSources`, `onEvent`, `onStderr`. Omits one-shot-only fields
  (`taskPrompt`, retries, timeouts, hooks).
- `RuntimeSession` — live handle: `runtime`, `pid`, `send(content)`,
  `events: AsyncIterable<RuntimeSessionEvent>`, `endInput()`, `abort(reason?)`,
  `done: Promise<RuntimeSessionStatus>`.
- `RuntimeSessionEvent` — `{ runtime, type, raw }`; raw payload preserved for
  runtime-specific typed access.
- `RuntimeSessionStatus` — `{ exitCode, signal, stderr }`.
- `RuntimeAdapter` — interface: `id`, `capabilities`, `invoke(opts)`,
  `launchInteractive(opts)`, optional `openSession?(opts)` (only when
  `capabilities.session === true`), optional `fetchCapabilitiesSlow?(opts)`
  (only when `capabilities.capabilityInventory === true`).
- `CapabilityInventory` — `{ runtime, skills: CapabilityRef[], commands:
  CapabilityRef[] }`. `CapabilityRef` — `{ name: string; plugin?: string }`.
- `FetchCapabilitiesOptions` — `{ cwd?, signal?, timeoutSeconds?, env?,
  model? }`. See `capabilityInventory` specifics in §4 and FR-L20.
- `ResolvedRuntimeConfig` — effective config after cascade resolution.
- `RuntimeConfigSource` — structural shape for cascade input. No workflow
  type dependency.

**`runtime/index.ts`:**

- `ADAPTERS` record keyed by `RuntimeId`.
- `getRuntimeAdapter(id)` — lookup.
- `resolveRuntimeConfig({defaults, node, parent})` — merges map-shape
  `runtime_args` from all cascade levels last-writer-wins. `null` survives
  the merge and suppresses the flag at expansion time. Model and
  `permissionMode` use first-defined-wins (node > parent > defaults).
- `expandExtraArgs(map, reserved?)` — flattens `ExtraArgsMap` into argv.
  Value semantics: `""` → bare flag; any other string → `--key value`;
  `null` → drop. Throws synchronously on reserved keys.

**`runtime/setting-sources.ts`:**

- `SettingSource` = `'user' | 'project' | 'local'`.
- `prepareSettingSourcesDir(sources, realConfigDir, realCwd)` — builds a
  temp `CLAUDE_CONFIG_DIR` symlinking the user-level `settings.json` when
  `'user'` is selected. `'project'`/`'local'` are recognized but not yet
  isolated — they still come from CWD.

### 3.4 `claude/process.ts` — Claude Runner

`buildClaudeArgs(opts: ClaudeInvokeOptions)`: constructs argv.
Order: `--permission-mode` → `claudeArgs` → `--resume` → `-p` →
`--agent` → `--append-system-prompt` → `--model` → `--output-format
stream-json --verbose`. Resume skips `--agent`, `--append-system-prompt`,
`--model` (session inherits).

`invokeClaudeCli(opts)`: retry loop with exponential backoff. On `is_error`
result → retry. On exception → retry. Returns `RuntimeInvokeResult`.

`executeClaudeProcess(args, ...)`: spawns `Deno.Command("claude")` with
`{ CLAUDECODE: "", ...env }` env override. Optional `env` param merged on
top. Reads stdout as NDJSON lines, delegates to `processStreamEvent()` from
`claude/stream.ts`. Optional `onEvent` threaded into `StreamProcessorState`.
Collects stderr. Timeout via `setTimeout` → `SIGTERM`. Registered/unregistered
in process registry.

### 3.5 `claude/stream.ts` — Stream Processing

Typed `ClaudeStreamEvent` discriminated union:
`ClaudeSystemEvent | ClaudeAssistantEvent | ClaudeUserEvent |
ClaudeResultEvent | ClaudeUnknownEvent`. Assistant message content is a
tagged union of `ClaudeTextBlock | ClaudeToolUseBlock |
ClaudeThinkingBlock`. Index signatures `[key: string]: unknown` on every
event preserve forward-compat upstream fields without casts.

`parseClaudeStreamEvent(line)`: pure function returning
`ClaudeStreamEvent | null`. Returns `null` on empty input, invalid JSON,
non-object payloads, or a missing string `type`.

`processStreamEvent(event, state)`: mutable state bag
(`StreamProcessorState`). Fixed dispatch order:

1. `state.onEvent?.(event)` — raw escape hatch.
2. Typed lifecycle hook (`hooks.onInit` / `onAssistant` / `onResult`)
   with the narrowed event.
3. For each `tool_use` block inside `assistant`, `onToolUseObserved` is
   awaited; `"abort"` sets `state.denied` and calls
   `state.abortController?.abort()`.
4. Internal state mutations — `turnCount++`, `FileReadTracker`,
   `extractClaudeOutput()` on `result`, log writes, terminal forwarding.

`extractClaudeOutput(event: ClaudeResultEvent)`: maps result event fields
to `CliRunOutput` with `runtime: "claude"`.

`formatEventForOutput(event, verbosity?)`: one-line summaries.
`system/init` → model info. `assistant` → text preview + tool names.
Semi-verbose skips `tool_use` blocks.

`FileReadTracker`: per-path read counter with configurable threshold.
`track(path)` → warning string or null. Pure class.

`stampLines(text)`: prepend `[HH:MM:SS]` to each non-empty line.
`formatFooter(output)`: `status=<ok|error> duration=<X>s cost=$<Y>
turns=<N>`.

### 3.6 `claude/session.ts` — Streaming-Input Session

`buildClaudeSessionArgs(opts)`: constructs argv.
Order: `--permission-mode` → expanded `claudeArgs` → `--resume` → `-p`
(bare, no value) → `--agent` → `--append-system-prompt` → `--model` →
`--output-format stream-json --verbose --input-format stream-json`.
Resume skips `--agent`, `--append-system-prompt`, `--model`. `--input-format`
is reserved (added to `CLAUDE_RESERVED_FLAGS`).

`openClaudeSession(opts)`: spawns `Deno.Command("claude")` with
`stdin: "piped"`, `stdout: "piped"`, `stderr: "piped"`. Applies optional
`settingSources` isolation (shared with one-shot path via
`prepareSettingSourcesDir`). Returns `ClaudeSession`:

- `send(content)` — writes `{"type":"user","message":{"role":"user","content":…}}\n`
  to stdin. Accepts string or pre-built `ClaudeSessionUserInput`.
- `events` — single-consumer async iterable backed by a local `EventQueue`
  (FIFO, resolver-pending pattern). Background stdout pump decodes NDJSON,
  parses via `parseClaudeStreamEvent`, enqueues events and fires `onEvent`.
- `endInput()` — closes stdin writer; CLI finishes turn and exits.
- `abort(reason?)` — idempotent SIGTERM; `forceCloseStdin()` in parallel.
- `done` — resolves with `ClaudeSessionStatus { exitCode, signal, stderr }`
  after stdout/stderr pumps drain and process exits. Always force-closes
  stdin in the finalizer to satisfy Deno's leak detector.

External `AbortSignal` composed via listener; process-registry
(`register`/`unregister`) wraps the subprocess lifecycle.

### 3.7 `opencode/process.ts` — OpenCode Runner

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

### 3.8 `opencode/session.ts` — OpenCode Streaming-Input Session

`openOpenCodeSession(opts)`: spawns `Deno.Command("opencode")` with
`["serve", "--hostname", <host>, "--port", <free>]`, `stdin: "null"`,
`stdout/stderr: "piped"`. `pickFreePort()` allocates via ephemeral
`Deno.listen({port:0})` then closes — accepts a small race window. Stdout
pump parses lines until `"listening on "` is seen, resolving a ready latch.
Stderr pump forwards decoded lines to `onStderr` and retains bytes for
terminal aggregation. If the subprocess exits before ready, the latch
rejects and the registry is cleaned up.

Once ready, either reuses `opts.resumeSessionId` or `POST /session → {id}`.
Returns `OpenCodeSession { pid, sessionId, baseUrl, send, events, endInput,
abort, done }`:
- `send(content)` — `POST /session/:id/prompt_async` with body
  `{ parts: [{type:"text", text:content}], agent?, model?, system? }`.
  `model` string of shape `"<providerID>/<modelID>"` is split into
  `{providerID, modelID}`; any other string passes through. Throws
  `OpenCodeSession: aborted` after `abort()` and `OpenCodeSession: input
  already closed` after `endInput()`.
- `events` — single-consumer async iterable backed by a local `EventQueue`
  (same FIFO, resolver-pending pattern as `claude/session.ts`). SSE pump
  reads `GET /event`, splits on `\n\n`, delegates each frame to
  `parseOpenCodeSseFrame`, dispatches session-scoped events (by
  `extractOpenCodeSessionId`) onto the queue, fires `onEvent` for every
  frame (including global). Tracks `isIdle` from `session.status` and
  `session.idle` events for graceful-close gating.
- `endInput()` — if a send was issued within the last 500 ms, races a
  short wait on the next `session.status | session.idle` event before
  checking `isIdle`; loops on `waitForNext(idle)` until idle; then aborts
  the SSE fetch and SIGTERMs the server. Idempotent.
- `abort(reason?)` — sets `aborted=true`, fires-and-forgets
  `POST /session/:id/abort`, aborts the SSE fetch, SIGTERMs the server.
  Idempotent.
- `done` — resolves with
  `OpenCodeSessionStatus { exitCode, signal, stderr }` after stdout/stderr/
  SSE pumps drain and process exits. External `AbortSignal` composed via
  listener; process-registry (`register`/`unregister`) wraps the
  subprocess lifecycle.

`parseOpenCodeSseFrame(frame)` and `extractOpenCodeSessionId(event)` are
exported for unit testing. `extractOpenCodeSessionId` checks
`properties.sessionID`, then nested `properties.part.sessionID` and
`properties.info.sessionID` where the server places it for
`message.part.*` / `message.updated` variants.


### 3.9 `opencode/hitl-mcp.ts` — HITL MCP Server

`runOpenCodeHitlMcpServer()`: stdio MCP server exposing
`request_human_input` tool. Tool schema: `question` (required string),
`header`, `options[]`, `multiSelect`. Tool handler returns
`{ok: true}` — actual question delivery/polling handled by engine's
HITL pipeline after process termination.

Constants: `OPENCODE_HITL_MCP_SERVER_NAME = "hitl"`,
`OPENCODE_HITL_MCP_TOOL_NAME = "hitl_request_human_input"`.

### 3.10 `cursor/process.ts` — Cursor Runner

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

### 3.10.1 `cursor/session.ts` — Cursor Faux Session

Cursor CLI has no streaming-input transport, so the session is emulated.

`createCursorChat(opts)`: runs `cursor agent create-chat`, trims stdout,
returns the chat ID. Throws on non-zero exit or empty output. 30 s default
timeout via `AbortSignal.timeout`.

`buildCursorSendArgs({chatId, message, permissionMode?, cursorArgs?})`:
`agent -p --resume <chatId>` → optional `--yolo` → expanded `cursorArgs`
→ `--output-format stream-json` → `--trust` → message. Reuses
`CURSOR_RESERVED_FLAGS` from `cursor/process.ts`.

`openCursorSession(opts)`: resolves chat ID (create-chat or
`resumeSessionId`), pushes a synthetic `{type:"system", subtype:"init",
synthetic:true, session_id:<chatId>, runtime:"cursor"}` event, starts an
internal worker loop. `send(content)` queues a message; the worker
spawns one `cursor agent -p --resume <id> <msg>` subprocess per dequeued
item, streams its NDJSON output into the shared event queue, waits for
exit, and resolves the send's promise. `pid` is a getter returning the
active subprocess PID or `0` while idle. `endInput()` closes the queue
gracefully after drain. `abort(reason?)` SIGTERMs the active subprocess,
rejects pending sends, closes the queue; idempotent. External
`AbortSignal` is wired to `abort()`. `done` resolves with
`{exitCode, signal, stderr}` (last subprocess exit + concatenated
stderr across all turns). `systemPrompt` is merged into the **first**
user message of a newly created chat; silently suppressed on resume.
Model selection is ignored (Cursor's `--resume` rejects `--model`).

### 3.11 `skill/` — Skill Model

**`skill/types.ts`:**

- `SkillFrontmatter` — union of all known SKILL.md frontmatter fields across
  IDEs. Required: `name`, `description`. Optional Claude Code fields:
  `argument-hint`, `when_to_use`, `allowed-tools`, `model`, `effort`,
  `context`, `agent`, `paths`, `hooks`, `shell`, `type`,
  `disable-model-invocation`, `user-invocable`, `hide-from-slash-command-tool`,
  `version`. Optional OpenCode: `license`, `compatibility`, `metadata`.
  Index signature `[key: string]: unknown` for forward compatibility.
- `SkillDef` — parsed skill directory: `frontmatter`, `body` (markdown after
  `---`), `rootPath` (absolute), `files[]` (relative, excludes SKILL.md).

**`skill/parser.ts`:**

- `parseSkill(skillDir)` — reads `SKILL.md`, extracts YAML frontmatter via
  `@std/yaml`, validates required `name` and `description`, recursively scans
  directory for additional files. Error on: missing SKILL.md, invalid YAML,
  unterminated frontmatter, missing required fields.


### 3.11 `codex/app-server.ts` — JSON-RPC Transport

`CodexAppServerClient.spawn(opts)` starts `codex app-server --listen
stdio://` with piped stdin/stdout/stderr. Pure transport layer — knows
nothing about threads or turns. Line-delimited JSON-RPC 2.0:

- `request<T>(method, params)` — monotonic numeric id, registers a
  resolver, rejects with `CodexAppServerError` on server error response,
  or a generic Error when the stream closes before a response arrives.
- `notify(method, params)` — fire-and-forget; used for `initialized`.
- `notifications: AsyncIterable<CodexAppServerNotification>` — inbound
  messages without an `id`, delivered via a single-consumer async FIFO
  queue that closes when stdout EOFs.
- `close()` — graceful: EOF stdin, await exit. Pending-but-unanswered
  requests reject when the stream closes.
- `abort(reason?)` — SIGTERM; idempotent.
- `done: Promise<CodexAppServerStatus>` — resolves with exit code,
  signal, and captured stderr after stdout/stderr drain.

External `AbortSignal` composed via listener; process registry
(`register`/`unregister`) wraps the subprocess lifecycle. Reserved argv
flags: `app-server`, `--listen` (set in `CODEX_APP_SERVER_RESERVED_FLAGS`).

**Experimental upstream.** Method names, param shapes, and notification
payloads can shift between `codex-cli` versions; client targets
`codex-cli >= 0.121.0`. Generate current TS bindings with `codex
app-server generate-ts --out <dir>` when protocol drift is suspected.


### 3.12 `codex/session.ts` — Streaming-Input Session

`openCodexSession(opts)` spawns a `CodexAppServerClient`, performs the
`initialize`/`initialized` handshake, then starts (`thread/start`) or
resumes (`thread/resume`) a thread and returns `CodexSession extends
RuntimeSession` with `threadId`, `send`, `events`, `endInput`, `abort`,
`done`.

Thread/turn semantics:

- First `send(content)` issues `turn/start` with `input: [{type:"text",
  text, text_elements: []}]` (the sibling `text_elements` array is
  required by the protocol due to serde Rust conventions — omitting it
  yields `-32602` "invalid params").
- Subsequent `send(content)` calls while a turn is active issue
  `turn/steer` with `expectedTurnId` taken from the most recent
  `turn/started` notification. The `turn/start` response can arrive
  before or after the matching notification; only the notification path
  drives `activeTurnId` to avoid a race where `expectedTurnId` points at
  a turn the server hasn't yet acknowledged.
- Inbound notifications are mapped to `RuntimeSessionEvent
  { runtime: "codex", type: lastPathSegment(method), raw: {method,
  params} }` and pushed into a single-consumer FIFO `EventQueue`.
- `activeTurnId` tracking is a single-writer side-channel in the
  notification pump; `updateActiveTurnId(current, note)` is exported as
  a pure helper.

Permission-mode mapping mirrors `permissionModeToCodexArgs` in
`codex/process.ts` but emits structured `{approvalPolicy?, sandbox?}`
params for `thread/start`/`thread/resume`:

- `plan` → `approvalPolicy: "never"`, `sandbox: "read-only"`.
- `acceptEdits` → `approvalPolicy: "never"`, `sandbox: "workspace-write"`.
- `bypassPermissions` → `approvalPolicy: "never"`,
  `sandbox: "danger-full-access"`.
- Native pass-through modes (`read-only`/`workspace-write`/
  `danger-full-access`/`never`/`on-request`/`on-failure`/`untrusted`) emit
  a single matching field.

`expandCodexSessionExtraArgs(map)` converts an `ExtraArgsMap` to the
`--config key=value` argv list the app-server subprocess accepts;
`null` values drop the flag. `CODEX_SESSION_CLIENT_VERSION` is advertised
via the `initialize` handshake (visible in Codex logs).

Handshake failure tears down the subprocess (`abort` → `await done`) so
callers never see a zombie process on rejection.


## 4. Data

### Runtime capability matrix

| Runtime  | permissionMode | hitl  | transcript | interactive | toolUseObservation | session | capabilityInventory |
|----------|----------------|-------|------------|-------------|--------------------|---------|---------------------|
| claude   | true           | true  | true       | true        | true               | true    | true                |
| opencode | true           | true  | false      | true        | false              | true    | true                |
| cursor   | false          | false | false      | false       | false              | true    | true                |
| codex    | true           | true  | true       | true        | true               | true    | true                |

**`session` specifics:**

- When `true`, adapter implements `openSession(opts)` returning a long-lived
  `RuntimeSession` with push-based `send()`, async-iterable `events`,
  graceful `endInput()`, SIGTERM `abort()`. See FR-L19 and §3.6 / §3.8 /
  §3.10.1 / §3.11-3.12.
- **Claude** — real streaming-input transport backed by `claude/session.ts`
  (`claude -p --input-format stream-json --output-format stream-json
  --verbose`); one long-lived subprocess with piped stdin/stdout.
- **OpenCode** — `opencode/session.ts` spawns a dedicated `opencode serve`
  subprocess, creates a session via `POST /session`, and consumes
  `GET /event` SSE — each `openSession` call spawns its own server
  (no pooling).
- **Cursor** — _faux_ session backed by `cursor/session.ts`. Cursor CLI has
  no streaming-input mode, so `openCursorSession` obtains a chat ID via
  `cursor agent create-chat` (or accepts `resumeSessionId`) and spawns a
  fresh `cursor agent -p --resume <chatId> <message>` subprocess for every
  `send()`. Sends are serialized through a worker queue; `events` yields a
  synthetic `system.init` carrying the chat ID followed by the raw NDJSON
  events from each turn. `pid` is a getter — reflects the currently active
  subprocess (or `0` while idle). Model selection is silently dropped
  (Cursor's `--resume` rejects `--model`); `systemPrompt` is merged into
  the first user message of newly created chats.
- **Codex** — `codex/session.ts` + `codex/app-server.ts`. Spawns the
  experimental `codex app-server --listen stdio://` JSON-RPC transport
  (NOT `codex exec`, which closes stdin immediately and cannot accept
  follow-ups), does `initialize`/`initialized` handshake, then
  `thread/start` (fresh) or `thread/resume` (on `resumeSessionId`). First
  `send` → `turn/start`; subsequent sends during an active turn →
  `turn/steer` with `expectedTurnId` from the most recent `turn/started`
  notification. Targets `codex-cli >= 0.121.0`.
- Callers MUST check `adapter.capabilities.session` before invoking
  `openSession`; the method is optional on `RuntimeAdapter`.

**`capabilityInventory` specifics:**
- When `true`, adapter implements `fetchCapabilitiesSlow(opts)` which spawns
  the IDE CLI via `adapter.invoke`, sends a fixed system + task prompt
  (`CAPABILITY_INVENTORY_SYSTEM_PROMPT` / `CAPABILITY_INVENTORY_PROMPT`),
  and parses the JSON reply through `parseCapabilityInventoryResponse`.
  Returns `CapabilityInventory = { runtime, skills, commands }`. See FR-L20.
- Schema enforcement per runtime:
  - Claude — `--json-schema <inline-json>` + `--max-turns 1` (strict).
  - Codex — writes `CAPABILITY_INVENTORY_SCHEMA` to a temp file and passes
    `--output-schema <path>`; temp file cleaned in `finally` (strict).
  - OpenCode — no schema flag; relies on the prompt alone.
  - Cursor — no schema flag; relies on the prompt alone.
- Parser tolerates pure minified JSON, markdown-fenced JSON, and
  prose-embedded JSON (first/last-brace slice); throws a descriptive error
  with truncated raw payload when no shape matches.
- **Expensive.** One full LLM turn per call, seconds-to-minutes latency,
  model-priced. The `Slow` suffix is intentional; callers should cache.
- Callers MUST check `adapter.capabilities.capabilityInventory` before
  invoking `fetchCapabilitiesSlow`; the method is optional on
  `RuntimeAdapter`.

**Codex specifics:**

- `permissionMode` — normalized values (`default` / `plan` / `acceptEdits` /
  `bypassPermissions`) map to `--sandbox` + `approval_policy` overrides;
  Codex-native pass-through values (`read-only` / `workspace-write` /
  `danger-full-access` / `never` / `on-request` / `on-failure` / `untrusted`)
  emit a single matching flag. See `permissionModeToCodexArgs` in
  `codex/process.ts`.
- `hitl` — the runner registers a per-invocation local stdio MCP server via
  `--config mcp_servers.hitl.command/args` overrides and intercepts
  `mcp_tool_call` items targeting `hitl.request_human_input`. Same engine
  flow as OpenCode; the consumer supplies `hitlMcpCommandBuilder` whose
  argv must dispatch into `runCodexHitlMcpServer` (alias of the shared
  NDJSON MCP runner in `hitl-mcp.ts`).
- `transcript` — Codex persists each session as
  `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl`; the runner
  resolves the matching path post-run via `findCodexSessionFile` and
  surfaces it as `CliRunOutput.transcript_path`.
- `interactive` — `launchInteractive` spawns the `codex` TUI with
  `stdin/stdout/stderr` inherited; bundled skills are copied into
  `~/.agents/skills/<name>/` for the duration of the session and removed
  on exit. `systemPrompt` is forwarded via `--config base_instructions=…`.
- `toolUseObservation` — fires `onToolUseObserved` once per
  `item.completed` for `command_execution`, `file_change`, `mcp_tool_call`,
  and `web_search` items; an `"abort"` decision SIGTERMs Codex and the
  runner synthesizes a `permission_denials[]` entry for the observed item.

## 5. Constraints

- **No domain logic:** Library MUST NOT contain git, GitHub, workflow, DAG,
  or any domain-specific code.
- **No engine imports:** Zero imports from `@korchasa/flowai-workflow`.
- **Structural typing:** `RuntimeConfigSource` uses structural shape, not
  imported workflow types.
- **Publish order:** `ai-ide-cli` published before `engine` — engine's
  workspace imports auto-pin to ide-cli version at publish time.
