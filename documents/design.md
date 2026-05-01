# SDS: AI IDE CLI

Design specification for `@korchasa/ai-ide-cli`.

## 1. Introduction

- **Purpose:** Design of the `@korchasa/ai-ide-cli` library — thin wrapper
  around agent-CLI binaries providing normalized invocation, stream parsing,
  retry, and HITL wiring.
- **Relation to SRS:** Implements FR-L1..FR-L31 from
  [requirements.md](requirements.md).
- **Embedding-friendly:** every spawned subprocess is tracked through a
  `ProcessRegistry` that the caller can supply per-call (FR-L3). Standalone
  CLI use keeps the module-level default singleton; embedders that host
  several independent runtimes in one Deno process pass private registries
  to scope `killAll` per subsystem.

## 2. Architecture

```
ai-ide-cli/
  types.ts              — shared types (RuntimeId, CliRunOutput, HitlConfig, ...)
  process-registry.ts   — pure child-process tracker + shutdown callbacks
  mod.ts                — public API barrel (re-exports all sub-paths)
  runtime/
    types.ts            — barrel re-exporting from capability-types,
                          session-types, errors, adapter-types
    capability-types.ts — RuntimeCapabilities, RuntimeInitInfo,
                          RuntimeLifecycleHooks
    session-types.ts    — RuntimeSession, RuntimeSessionOptions,
                          RuntimeSessionEvent, RuntimeSessionStatus,
                          SYNTHETIC_TURN_END
    errors.ts           — SessionError + 3 typed subclasses
                          (InputClosed/Aborted/Delivery)
    adapter-types.ts    — RuntimeAdapter, RuntimeInvokeOptions,
                          RuntimeInvokeResult, ResolvedRuntimeConfig,
                          RuntimeConfigSource, ExtraArgsMap,
                          RuntimeToolUseInfo, InteractiveOptions
    index.ts            — adapter registry + resolveRuntimeConfig()
    capabilities.ts     — CapabilityInventory types + shared LLM-probe driver
                          (fetchInventoryViaInvoke, parseCapabilityInventoryResponse)
    event-queue.ts      — SessionEventQueue<T>: shared one-shot
                          AsyncIterableIterator FIFO used by every runtime's
                          `session.events`
    session-adapter.ts  — adaptRuntimeSession, adaptEventCallback: shared
                          helpers that translate runtime-specific sessions
                          into runtime-neutral RuntimeSession handles
    content.ts          — extractSessionContent(event) dispatcher +
                          NormalizedContent union: runtime-neutral content
                          extraction from RuntimeSessionEvent (FR-L23).
                          Per-runtime extraction lives in
                          <runtime>/content.ts.
    tool-filter.ts      — validateToolFilter(runtime, opts): shared typed
                          tool-filter validation used by every adapter
                          (FR-L24)
    reasoning-effort.ts — validateReasoningEffort(runtime, opts): shared
                          typed reasoning-effort validation + enum
                          (FR-L25)
    claude-adapter.ts   — Claude RuntimeAdapter (delegates to claude/process)
    opencode-adapter.ts — OpenCode RuntimeAdapter (delegates to opencode/process)
    cursor-adapter.ts   — Cursor RuntimeAdapter (delegates to cursor/process)
    codex-adapter.ts    — Codex RuntimeAdapter (delegates to codex/process + codex/session)
  claude/
    process.ts          — buildClaudeArgs, invokeClaudeCli, executeClaudeProcess
    stream.ts           — processStreamEvent, extractClaudeOutput, FileReadTracker,
                          formatEventForOutput, stampLines, formatFooter
    session.ts          — openClaudeSession, buildClaudeSessionArgs, ClaudeSession
                          (streaming-input session with piped stdin)
    content.ts          — extractClaudeContent (per-runtime extractor; FR-L23)
  opencode/
    process.ts          — invokeOpenCodeCli runner; re-exports helpers
                          from argv/events/transcript modules
    argv.ts             — buildOpenCodeArgs, buildOpenCodeConfigContent,
                          OPENCODE_RESERVED_FLAGS / POSITIONALS /
                          INTENTIONALLY_OPEN_FLAGS
    events.ts           — OpenCodeStreamEvent typed union (canonical
                          home), formatOpenCodeEventForOutput,
                          extractOpenCodeOutput, openCodeToolUseInfo,
                          extractHitlRequestFromEvent
    transcript.ts       — exportOpenCodeTranscript,
                          OpenCodeTranscriptResult
    session.ts          — openOpenCodeSession, OpenCodeSession (streaming-input
                          session backed by `opencode serve` + HTTP + SSE)
    hitl-mcp.ts         — runOpenCodeHitlMcpServer (stdio MCP for HITL tool)
    content.ts          — extractOpenCodeContent (per-runtime extractor; FR-L23)
  cursor/
    process.ts          — buildCursorArgs, invokeCursorCli, extractCursorOutput,
                          formatCursorEventForOutput
    session.ts          — openCursorSession, createCursorChat,
                          buildCursorSendArgs, CursorSession (faux streaming
                          session: create-chat + resume-per-send)
    content.ts          — extractCursorContent (per-runtime extractor; FR-L23/FR-L30)
  codex/
    process.ts          — invokeCodexCli runner; re-exports helpers from
                          argv/run-state/transcript modules
    argv.ts             — buildCodexArgs, permissionModeToCodexArgs,
                          buildCodexHitlConfigArgs, CODEX_RESERVED_FLAGS,
                          CODEX_RESERVED_POSITIONALS,
                          CODEX_INTENTIONALLY_OPEN_FLAGS
    run-state.ts        — CodexRunState, applyCodexEvent,
                          extractCodexOutput, extractCodexHitlRequest,
                          codexItemToToolUseInfo,
                          formatCodexEventForOutput
    transcript.ts       — defaultCodexSessionsDir, findCodexSessionFile
    exec-events.ts      — CodexExecEvent / CodexExecItem typed unions +
                          parseCodexExecEvent (snake_case NDJSON protocol
                          for `codex exec --experimental-json`)
    hitl-mcp.ts         — runCodexHitlMcpServer (stdio MCP for HITL tool)
    app-server.ts       — CodexAppServerClient, CodexAppServerError,
                          CodexAppServerNotification (JSON-RPC transport for
                          `codex app-server --listen stdio://`)
    session.ts          — openCodexSession, CodexSession,
                          permissionModeToThreadStartFields,
                          expandCodexSessionExtraArgs, updateActiveTurnId
                          (streaming-input session over app-server)
    content.ts          — extractCodexContent (per-runtime extractor; FR-L23)
  skill/
    types.ts            — SkillDef, SkillFrontmatter (union of all IDE fields)
    parser.ts           — parseSkill(dir) → SkillDef
    mod.ts              — barrel export for @korchasa/ai-ide-cli/skill
  e2e/                  — opt-in real-binary test suite (FR-L31)
    _helpers.ts         — detectBinary, e2eEnabled, resolveEnabledMap, ceiling,
                          ONE_WORD_OK/DONE, LONG_COUNT_PROMPT
    _matrix.ts          — SESSION_CONTRACT_MATRIX (9 scenarios incl.
                          codex-typed-notification-narrowing FR-L26),
                          RUNTIME_SPECS (per-runtime turn-end predicates),
                          DEFAULT_CEILING_MS, CURSOR_CEILING_MS
    session_matrix_e2e_test.ts — Deno.test generator: RuntimeId × matrix
    invoke_abort_e2e_test.ts   — Claude one-shot AbortSignal scenarios
    claude_settings_e2e_test.ts — Claude settingSources: [] cleanroom
    cursor_typed_stream_e2e_test.ts — Cursor --yolo + Read tool, asserts
                          parseCursorStreamEvent / unwrapCursorToolCall /
                          onToolUseObserved against live binary (FR-L30)
```

**Dependency rule:** All arrows point inward. Runtime-specific modules import
from `types.ts` and `process-registry.ts`. Adapters import from their
runtime's `process.ts`. `mod.ts` re-exports everything. Zero imports from
engine or any external workflow package.

## 3. Components

### 3.1 `types.ts` — Shared Types

`RuntimeId` union: `"claude" | "opencode" | "cursor" | "codex"`.
`VALID_RUNTIME_IDS` array for config validation.

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

Pure tracker. No signal wiring. Two flavors share one implementation:

- **`ProcessRegistry` class** — instance-scoped. Each instance owns a
  private `Set<Deno.ChildProcess>` and a private shutdown-callback array.
  `killAll()` is scoped to the instance. Constructor accepts
  `{ graceMs }` (default 5000). API: `register(p)`, `unregister(p)`,
  `onShutdown(cb)` (returns disposer), `killAll()`. Test helpers
  `_reset` / `_getProcesses` / `_getShutdownCallbacks` prefixed with `_`.
- **Default singleton + free functions.** Module-level `defaultRegistry`
  is a `ProcessRegistry` instance; `register`, `unregister`,
  `onShutdown`, `killAll`, `_reset`, `_getProcesses`,
  `_getShutdownCallbacks` are thin wrappers over it for backward
  compatibility and standalone CLI use.

`killAll()` sequence (both flavors): SIGTERM all →
`Promise.race([allSettled, graceMs timeout])` → SIGKILL survivors →
run shutdown callbacks.

Adapters resolve the active registry as
`opts.processRegistry ?? defaultRegistry` at the spawn site. Embedders
that host multiple independent runtimes in one process pass a private
`ProcessRegistry` through `RuntimeInvokeOptions.processRegistry` /
`RuntimeSessionOptions.processRegistry` so `killAll` is scoped to the
embedder.

### 3.3 `runtime/` — Adapter Layer

**`runtime/types.ts`:**

- `RuntimeCapabilities` — feature flags per adapter: `permissionMode`, `hitl`,
  `transcript`, `interactive`, `toolUseObservation`, `session`,
  `capabilityInventory`, `toolFilter`, `reasoningEffort`,
  `sessionFidelity?: "native" | "emulated"` (omitted ⇒ `"native"`).
  Cursor advertises `"emulated"` because `openCursorSession` spawns a
  fresh subprocess per send; every other adapter advertises `"native"`.
- `RuntimeInvokeOptions` — normalized invocation options: `taskPrompt`,
  `resumeSessionId`, `model`, `permissionMode`, `extraArgs`, `timeoutSeconds`,
  `maxRetries`, `retryDelaySeconds`, `onOutput`, `streamLogPath`, `verbosity`,
  `hitlConfig`, `hitlMcpCommandBuilder`, `cwd`, `agent`, `systemPrompt`,
  `env`, `onEvent`, `allowedTools`, `disallowedTools` (FR-L24),
  `processRegistry` (FR-L3 — optional `ProcessRegistry` instance for
  scoping the spawned subprocess; falls back to the module default).
- `RuntimeInvokeResult` — `{ output?: CliRunOutput; error?: string }`.
- `InteractiveOptions` — `{ skills?, systemPrompt?, cwd?, env? }`.
- `InteractiveResult` — `{ exitCode: number }`.
- `RuntimeSessionOptions` — streaming-session options: `agent`, `systemPrompt`,
  `resumeSessionId`, `extraArgs`, `permissionMode`, `model`, `signal`, `cwd`,
  `env`, `settingSources`, `allowedTools`, `disallowedTools` (FR-L24),
  `onEvent`, `onStderr`, `processRegistry` (FR-L3 — same semantics as
  on `RuntimeInvokeOptions`). Omits one-shot-only fields
  (`taskPrompt`, retries, timeouts, hooks). **Out of scope by design:**
  per-turn `timeoutSeconds`/`maxRetries`/`retryDelaySeconds` — caller-owned
  via `AbortSignal` + reopen with `resumeSessionId`; mid-session model /
  permissionMode / extraArgs changes likewise require reopening (flags are
  bound to the subprocess at spawn time).
- `RuntimeSession` — live handle: `runtime`, `sessionId` (readonly string;
  `""` on Claude until first `system/init` event, synchronous for other
  three adapters), `send(content)`,
  `events: AsyncIterableIterator<RuntimeSessionEvent>` (one-shot — see
  FR-L21 / FR-L22), `endInput()`, `abort(reason?)`,
  `done: Promise<RuntimeSessionStatus>`. The neutral interface deliberately
  omits `pid` — it's a leaky implementation detail that cannot be stable
  across runtimes (Cursor has no long-lived backing process). Runtime-specific
  handles may expose `pid` and native id aliases (`chatId`, `threadId`).
- **Uniform session contract:** `send` resolves on input acceptance (never
  blocks for turn completion); rejects with a `SessionError` subclass
  (`SessionInputClosedError` / `SessionAbortedError` /
  `SessionDeliveryError` — see FR-L22). `endInput` is signal-only and
  returns promptly (full shutdown observed via `done`); `abort` is
  idempotent; `events` is single-consumer and includes one
  {@link SYNTHETIC_TURN_END} event per completed turn (FR-L21); `done`
  always resolves. Verified by `runtime/session_contract_test.ts`.
- `RuntimeSessionEvent` — `{ runtime, type, raw, synthetic? }`; raw payload
  preserved for runtime-specific typed access. `synthetic: true` marks
  adapter-injected events (the shipped synthetics are turn-end from every
  adapter and Cursor's open-time `system.init` / `send_failed` events).
- `SYNTHETIC_TURN_END` — `"turn-end"` constant; uniform turn-boundary
  marker emitted once per completed turn by every adapter.
- `SessionError` / `SessionInputClosedError` / `SessionAbortedError` /
  `SessionDeliveryError` — typed `send()` failures so consumers branch on
  `instanceof` rather than message prefixes. Transport-level causes
  attached via standard `Error.cause`.
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
- Re-exports `expandExtraArgs` from `runtime/argv.ts` to preserve the
  long-standing public API surface in `mod.ts`.

**`runtime/argv.ts`:**

- `expandExtraArgs(map, reserved?)` — flattens `ExtraArgsMap` into argv.
  Value semantics: `""` → bare flag; any other string → `--key value`;
  `null` → drop. Throws synchronously on reserved keys.
- Cycle-free leaf module: imports only `ExtraArgsMap` from `./types.ts`,
  nothing from `<runtime>/*` or `*-adapter.ts`. Exists so adapter
  `process.ts` / `session.ts` modules can pull the helper without
  re-entering `runtime/index.ts` and tripping a TDZ on `ADAPTERS` when
  any `*-adapter.ts` is loaded as the direct entry point.

**`runtime/setting-sources.ts`:**

- `SettingSource` = `'user' | 'project' | 'local'`.
- `prepareSettingSourcesDir(sources, realConfigDir, realCwd)` — builds a
  temp `CLAUDE_CONFIG_DIR` symlinking the user-level `settings.json` when
  `'user'` is selected. `'project'`/`'local'` are recognized but not yet
  isolated — they still come from CWD.
- **Host-auth caveat.** Only `settings.json` is symlinked; Claude CLI's
  `.credentials.json` (where `/login`-authenticated hosts store their
  session token) is **not** carried into the cleanroom. Hosts with
  `ANTHROPIC_API_KEY` in the environment survive `settingSources: []`;
  login-based hosts fail with
  `"Claude CLI returned error: Not logged in · Please run /login"`
  until they set an API key. Tests and benchmarks that depend on auth
  must either assume an API-key host or assert only that the CLI
  returned within the timeout (see `e2e/claude_settings_e2e_test.ts`
  for the portable shape).

**`runtime/content.ts` — Normalized Content Extraction (FR-L23):**

- `NormalizedContent` discriminated union: `NormalizedTextContent`
  (streaming text with `cumulative` flag), `NormalizedToolContent`
  (tool invocation — id, name, optional input), `NormalizedFinalContent`
  (complete assistant reply).
- `extractSessionContent(event): NormalizedContent[]` — pure
  dispatcher keyed on `event.runtime`. Synthetic events and
  unrecognized types return `[]`. Never throws on malformed payloads.
- Per-runtime extractor functions live in `<runtime>/content.ts`
  (`claude/content.ts:extractClaudeContent`,
  `cursor/content.ts:extractCursorContent`,
  `codex/content.ts:extractCodexContent`,
  `opencode/content.ts:extractOpenCodeContent`). The dispatcher in
  `runtime/content.ts` is the only allowed `runtime/ → <runtime>/`
  consumer (mirrors the `runtime/index.ts` adapter aggregation).
- Per-runtime extractors:
  - **Claude / Cursor** (shared — stream-json): `assistant` event
    fans out `raw.message.content[]` preserving source order
    (`text` → text content, `tool_use` → tool content, `thinking`
    skipped); `result` event with string `result` → final content.
  - **Codex** (app-server v2 JSON-RPC, **camelCase**):
    `item/agentMessage/delta` → delta text;
    `item/completed` with `item.type === "agentMessage"` → final
    text (from `item.text` — direct, not `content[]`); tool items
    (`commandExecution` / `fileChange` / `webSearch` /
    `mcpToolCall` / `dynamicToolCall`) lift via
    `codex/items.ts:parseAppServerItem` (see §3.10.2) and render as
    `{kind:"tool", id, name, input}`. The parallel snake_case NDJSON
    parser `parseExecItem` is the exec-side counterpart (also in
    `codex/items.ts`); both lift into the shared `CodexConceptualItem`
    so adding a kind only touches the two parsers.
  - **OpenCode** (SSE): `message.part.updated` with text part → text
    content; with tool part at terminal state (`completed`/`failed`),
    non-HITL, with resolvable id → tool content. Mirrors
    `openCodeToolUseInfo`'s FR-L16 filtering rule.
- **Documented gaps** (kept visible in `runtime/CLAUDE.md` too):
  - OpenCode has no native final-text event → consumers flush the
    last `cumulative:true` text on `SYNTHETIC_TURN_END`.
  - Claude `thinking` blocks → skipped; reserved for a future
    `kind:"reasoning"` variant.
  - Claude `user` events carrying tool results → skipped; reserved
    for a future `kind:"tool-result"` variant.
  - Timing asymmetry: Claude / Cursor dispatch tools at
    assistant-decision time; OpenCode / Codex at completion time.

### 3.4 `claude/process.ts` — Claude Runner

`buildClaudeArgs(opts: ClaudeInvokeOptions)`: constructs argv.
Order: `--permission-mode` → tool-filter flag (FR-L24, see below) →
`claudeArgs` → `--resume` → `-p` → `--agent` → `--append-system-prompt`
→ `--model` → `--output-format stream-json --verbose`. Resume skips
`--agent`, `--append-system-prompt`, `--model` (session inherits) but
**does** re-emit the tool-filter flag (filtering is not part of
session state).

**`PermissionMode` enum (canonical home: `claude/permission-mode.ts`).**
Narrowed Claude `--permission-mode` values: `"acceptEdits" |
"bypassPermissions" | "default" | "plan"`. Re-exported from `mod.ts` as
`@deprecated` for one release; consumers should switch to
`@korchasa/ai-ide-cli/claude/permission-mode`. `validateClaudePermissionMode`
runs in `buildClaudeArgs` and `buildClaudeSessionArgs` before the flag is
emitted; throws synchronously on unknown values, mirroring
`validateToolFilter` and `validateReasoningEffort`. Other runtimes
(`opencode`, `cursor`, `codex`) keep `permissionMode: string` and apply
their own per-adapter mappings (no shared enum).

**FR-L24 tool filter.** `buildClaudeArgs` (and
`buildClaudeSessionArgs`) calls the shared `validateToolFilter("claude",
opts)` from `runtime/tool-filter.ts` **before** `expandExtraArgs`. The
validator throws synchronously on (a) both `allowedTools` and
`disallowedTools` set, (b) empty array or empty-string members, or (c)
typed field set AND any of `--allowedTools` / `--allowed-tools` /
`--disallowedTools` / `--disallowed-tools` / `--tools` present in
`claudeArgs`. On success it returns `"allowed"` / `"disallowed"` /
`undefined`; the builder emits `--allowedTools <comma-joined>` OR
`--disallowedTools <comma-joined>` as exactly two argv tokens (comma
join matches the CLI's "comma or space-separated" grammar). The
legacy path — `extraArgs` carrying the raw flags without a typed
field — stays untouched, so `CLAUDE_RESERVED_FLAGS` is **not**
extended with the tool-filter keys.

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

- `sessionId` — getter returning the latest `session_id` observed in
  stream events (`""` until the first `system/init`; then populated for
  the session's lifetime). `adaptRuntimeSession` re-exports it as
  `RuntimeSession.sessionId` through a pass-through getter so the neutral
  handle reflects late population without re-wrapping.
- `send(content)` — writes `{"type":"user","message":{"role":"user","content":…}}\n`
  to stdin. Accepts string or pre-built `ClaudeSessionUserInput`. Resolves
  as soon as the JSONL envelope is flushed (the CLI processes it
  asynchronously; turn completion is observable via `events`). Rejects
  with typed `SessionError` subclasses: `SessionAbortedError` /
  `SessionInputClosedError` / `SessionDeliveryError` (FR-L22).
- `events` — single-consumer async iterator (`AsyncIterableIterator<T>`,
  one-shot) backed by the shared `SessionEventQueue<T>` from
  `runtime/event-queue.ts`. Background stdout
  pump decodes NDJSON, parses via `parseClaudeStreamEvent`, enqueues events
  and fires `onEvent`. The neutral adapter layer injects one synthetic
  `{type: "turn-end", synthetic: true, raw: <native result>}` event after
  each `result` event via the shared `isTurnEnd` predicate threaded
  through `adaptRuntimeSession` / `adaptEventCallback` (FR-L21).
- `endInput()` — closes the stdin writer and returns promptly
  (signal-only). The CLI finishes the current turn and exits on its own;
  full shutdown is observable via `done`.
- `abort(reason?)` — idempotent SIGTERM; `forceCloseStdin()` in parallel.
- `done` — resolves with `ClaudeSessionStatus { exitCode, signal, stderr }`
  after stdout/stderr pumps drain and process exits. Always force-closes
  stdin in the finalizer to satisfy Deno's leak detector.

External `AbortSignal` composed via listener; process-registry
(`register`/`unregister`) wraps the subprocess lifecycle.

### 3.7 `opencode/process.ts` — OpenCode Runner

Module split: `argv.ts` owns the argv builder + config-content builder,
`events.ts` owns the typed `OpenCodeStreamEvent` union + formatter +
output extractor + HITL extractor + tool-use info, `transcript.ts` owns
`exportOpenCodeTranscript`. The runner in `process.ts` re-exports every
helper so existing imports keep working.

`buildOpenCodeArgs(opts)` (`opencode/argv.ts`): `run` → `--session` →
`--model` → `--agent` → `--dangerously-skip-permissions` → `extraArgs` →
`--format json` → `--` → prompt. The `--` separator forces yargs to
treat the merged `systemPrompt + taskPrompt` as positional even when it
begins with `-` (e.g. YAML frontmatter `---` from an agent markdown
file); without it opencode prints usage and exits with code 1.

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
  `{providerID, modelID}`; any other string passes through. Resolves on
  HTTP 204 (input accepted); turn completion is observable via `events`.
  Rejects with typed `SessionError` subclasses: `SessionAbortedError` /
  `SessionInputClosedError` / `SessionDeliveryError` — the last wraps the
  non-2xx response text and any network-level `fetch` failure (FR-L22).
- `events` — single-consumer async iterator (`AsyncIterableIterator<T>`,
  one-shot) backed by the shared `SessionEventQueue<T>` from
  `runtime/event-queue.ts`. SSE pump reads
  `GET /event`, splits on `\n\n`, delegates each frame to
  `parseOpenCodeSseFrame`, dispatches session-scoped events (by
  `extractOpenCodeSessionId`) onto the queue, fires `onEvent` for every
  frame (including global). Tracks `isIdle` from `session.status` and
  `session.idle` events for graceful-close gating. On every busy → idle
  transition (edge-triggered) the dispatcher injects a synthetic
  `{type: "turn-end", synthetic: true, raw: <native>}` event into the
  queue — works uniformly whether the server emitted `session.idle`, a
  `session.status { status: idle }` frame, or both (FR-L21).
- `endInput()` — signal-only: flips the `inputClosed` flag and returns
  promptly. A background task (`waitForIdleAndTeardown`) waits for the
  next session-scoped `session.idle` event (with a 500 ms grace for a
  just-issued send) and then aborts the SSE fetch and SIGTERMs the
  server. Full shutdown is observable via `done`. Idempotent.
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
`runtime: "cursor"`. Cursor's stream-json shape is **NOT** identical to
Claude — see `cursor/stream.ts` (FR-L30) for the empirically captured
taxonomy.

`formatCursorEventForOutput(event, verbosity?)`: one-line summaries.
Handles `system/init`, `assistant` (text blocks only — Cursor does not
inline tool blocks; tool calls are sibling `tool_call/*` events) and
`result/success`.

`invokeCursorCli(opts)`: prepends system prompt to task prompt (no
dedicated flag). Retry loop with exponential backoff. Real-time NDJSON
processing with log file + terminal output forwarding. Fires
`onToolUseObserved` (FR-L30) on every `tool_call/started` event;
`"abort"` decision triggers SIGTERM and synthesizes a `CliRunOutput`
with `is_error: true` plus a single `permission_denials[]` entry —
symmetric with Claude. Cursor-specific lifecycle hooks (`cursorHooks`)
expose typed `onInit` / `onAssistant` / `onResult` callbacks.

Tool filter (FR-L24): `capabilities.toolFilter === false`.
`allowedTools` / `disallowedTools` are validated (same rules as Claude
via `validateToolFilter`) and ignored in argv; first set-value call
emits one `console.warn` per process.

### 3.10.0 `cursor/stream.ts` — Typed Stream-JSON Events (FR-L30)

Discriminated union `CursorStreamEvent` mirroring the empirically
captured taxonomy of `cursor agent -p --output-format stream-json`:

- `CursorSystemInitEvent` (`type: "system", subtype: "init"`) — carries
  `apiKeySource`, `cwd`, `session_id`, `model`, `permissionMode`.
- `CursorUserEvent` (`type: "user"`) — echoed user message.
- `CursorThinkingDeltaEvent` (`type: "thinking", subtype: "delta"`) —
  streaming reasoning chunk with `text`. **Very high volume** (~90% of
  events for a typical prompt).
- `CursorThinkingCompletedEvent` (`type: "thinking", subtype:
  "completed"`) — end-of-reasoning marker.
- `CursorAssistantEvent` (`type: "assistant"`) — `message.content[]` of
  `{type:"text", text}` blocks **only**. Cursor does NOT inline tool
  blocks (unlike Claude's `tool_use` blocks).
- `CursorToolCallStartedEvent` / `CursorToolCallCompletedEvent` (`type:
  "tool_call"`, `subtype: "started" | "completed"`) — separate top-level
  events with `call_id`, `model_call_id`, and a wrapper payload
  `tool_call: {<name>ToolCall: {args | result}}` (e.g. `readToolCall`,
  `grepToolCall`). The single key encodes the tool name; `args` on
  `started`, `result` (or `result.error.errorMessage` on failure) on
  `completed`.
- `CursorResultEvent` (`type: "result", subtype: "success"`) — terminal
  event with `result`, `duration_ms`, `duration_api_ms`, `is_error`,
  `request_id`, and `usage: {inputTokens, outputTokens, cacheReadTokens,
  cacheWriteTokens}`. Note: cursor does **not** emit `total_cost_usd`.
- `CursorUnknownEvent` — forward-compat fallback.

`parseCursorStreamEvent(line)`: NDJSON → typed event or `null` (mirrors
`parseClaudeStreamEvent`). `unwrapCursorToolCall(toolCall)`: flattens
the `<name>ToolCall` wrapper into `{name, args?, result?,
errorMessage?}` (strips trailing `ToolCall` suffix from the wrapper key).

`CursorLifecycleHooks`: `onInit(event)` / `onAssistant(event)` /
`onResult(event)` typed counterparts to `RuntimeLifecycleHooks` for
consumers that import the cursor sub-path directly. `onAssistant`
fires once per `assistant` event, closing the matrix row
"per-assistant-turn lifecycle hook: cursor: no".

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
internal worker loop. Both `chatId` and the neutral-named `sessionId`
alias are exposed on the concrete `CursorSession` handle. `send(content)`
**enqueues and returns immediately** — it does not wait for the
subprocess to spawn or complete. Rejects with typed `SessionError`
subclasses: `SessionAbortedError` / `SessionInputClosedError` (no
`SessionDeliveryError` from `send` itself — per-turn subprocess failures
are surfaced asynchronously, not as rejected sends). The worker spawns
one `cursor agent -p --resume <id> <msg>` subprocess per dequeued item,
streams its NDJSON output into the shared event queue, and waits for exit
before processing the next. Per-turn subprocess failures surface three
ways: (a) a synthetic `{type:"error", subtype:"send_failed",
runtime:"cursor", error:…, synthetic:true}` event on the event stream;
(b) the last exit code reflected on `done`; (c) the typed
`onSendFailed?: (err: SessionDeliveryError, message: string) => void`
callback on `CursorSessionOptions` — fired once per failed subprocess
with a `SessionDeliveryError` whose `cause` carries the underlying error
and whose `runtime` is `"cursor"`. The callback runs before the
synthetic event is pushed; consumer exceptions are swallowed (mirrors
the contract of `onEvent` / `onStderr`). The session advertises
`capabilities.sessionFidelity = "emulated"` so cross-runtime consumers
can branch on the deviation listed under "Emulated session caveat" on
`RuntimeSession`'s JSDoc (synchronous `send` enqueue, dropped `model`,
first-message `systemPrompt` only). The neutral `adaptRuntimeSession` wrapper adds one
synthetic `turn-end` event after each per-turn subprocess's native
`result` via the shared `isTurnEnd` predicate (FR-L21). `pid` is a
getter returning the active subprocess PID or `0` while idle (concrete
`CursorSession` only — not on the neutral `RuntimeSession`).
`endInput()` is signal-only: flips `inputClosed`, wakes the worker, and
returns. The worker drains any remaining queued sends and closes the
event stream; full shutdown is observable via `done`. `abort(reason?)`
SIGTERMs the active subprocess, closes the queue; idempotent. External
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


### 3.10.1 `codex/permission-mode.ts` — Shared Permission-Mode Decision

Single source of truth for the runtime-neutral `permissionMode` →
`{sandbox?, approvalPolicy?}` decision shared by both Codex transports.

- `SandboxMode` literal union
  (`"read-only" | "workspace-write" | "danger-full-access"`).
- `ApprovalPolicy` literal union
  (`"never" | "on-request" | "on-failure" | "untrusted"`).
- `CODEX_SANDBOX_MODES`, `CODEX_APPROVAL_MODES` typed sets used for
  pass-through detection.
- `decidePermissionMode(mode?: string): CodexPermissionDecision` —
  pure mapping; normalizes `plan`/`acceptEdits`/`bypassPermissions`
  into `{sandbox, approvalPolicy}` pairs, passes through native
  Codex-specific modes verbatim, returns `{}` for `default` /
  `undefined` / unknown.

Consumers are thin serializers:

- `permissionModeToCodexArgs(mode)` in `codex/process.ts` →
  `--sandbox <mode>` + `--config approval_policy="<mode>"` argv
  (one-shot exec transport).
- `permissionModeToThreadStartFields(mode)` in `codex/session.ts` →
  `{approvalPolicy?, sandbox?}` fields for `thread/start` /
  `thread/resume` (app-server transport).

Cross-serializer-equivalence is enforced by
`codex/permission-mode_test.ts`.

### 3.10.2 `codex/items.ts` — Conceptual Tool-Item Layer

Runtime-neutral, wire-format-agnostic view of Codex tool items shared
between the snake_case NDJSON exec protocol and the camelCase
app-server JSON-RPC protocol.

- `CodexConceptualKind` union: `command_execution | file_change |
  mcp_tool_call | web_search | dynamic_tool_call`.
- `CodexConceptualItem`: `{id, kind, name, input, status?}`. `name`
  is wire-specific (`<server>.<tool>` for `mcpToolCall`/`mcp_tool_call`,
  `item.tool` for `dynamicToolCall`, the discriminator verbatim
  otherwise).
- `parseExecItem(snake)` lifts a snake_case `CodexExecItem` (returns
  `undefined` for `agent_message` / `reasoning` / `error` /
  `todo_list`).
- `parseAppServerItem(camel)` lifts a camelCase JSON-RPC item; drops
  `id` / `type` and preserves every other field under `input` so the
  parser survives upstream field additions. Items without a stable
  `id` are rejected (mirrors the historical `extractCodexContent`
  invariant).

Consumers are thin wrappers:

- `codexItemToToolUseInfo` in `codex/process.ts` → discards `kind` /
  `status`, returns `{id, name, input}` for the tool-observation hook.
- `extractCodexContent` in `codex/content.ts` → wraps each conceptual
  item in `{kind:"tool", id, name, input}`. The `agentMessage` final
  branch and the `agentMessage/delta` text branch stay inline because
  they are not tool items.

Cross-parser equivalence (id / kind / status) is enforced by
`codex/items_test.ts`.

### 3.10.3 `codex/exec-events.ts` — Typed `codex exec` NDJSON Events

Discriminated union `CodexExecEvent` over the snake_case NDJSON
protocol consumed by `codex/process.ts` (entirely separate from the
camelCase JSON-RPC `CodexNotification` union in `codex/events.ts`):

- `CodexExecThreadStartedEvent` (`type: "thread.started"`) — `thread_id`.
- `CodexExecTurnCompletedEvent` (`type: "turn.completed"`) — `usage`
  (`CodexExecUsage`: `input_tokens`, `cached_input_tokens`,
  `output_tokens`).
- `CodexExecTurnFailedEvent` (`type: "turn.failed"`) — `error`
  (`CodexExecErrorPayload`: `message`).
- `CodexExecErrorEvent` (`type: "error"`) — top-level transport
  error with `message`.
- `CodexExecItemCompletedEvent` (`type: "item.completed"`) — wraps
  `item: CodexExecItem`.
- `CodexExecUnknownEvent` — forward-compat fallback.

`CodexExecItem` covers eight item kinds plus an unknown fallback:
`agent_message` (`text`), `command_execution` (`command`, `status`,
`exit_code`, `aggregated_output`), `file_change` (`status`,
`changes: CodexExecFileChange[]`), `mcp_tool_call` (`server`, `tool`,
`status`, `arguments`), `web_search` (`query`), `reasoning` (`text`),
`todo_list` (`items: CodexExecTodoEntry[]`), `error` (`message`),
`CodexExecUnknownItem`.

Every interface carries `[key: string]: unknown` for forward-compat
with `codex-cli >= 0.121.0` minor bumps. `parseCodexExecEvent(line):
CodexExecEvent | null` mirrors `parseClaudeStreamEvent` /
`parseCursorStreamEvent` — pure NDJSON-line → typed event, returns
`null` on invalid JSON, missing/non-string `type`, or JSON arrays.
Consumers in `codex/process.ts` (`applyCodexEvent`,
`formatCodexEventForOutput`) cast inside narrowed switch branches to
the precise variant, mirroring the `claude/stream.ts:processStreamEvent`
pattern. The tool-item lifting (`codexItemToToolUseInfo`) is delegated
to `parseExecItem` in `codex/items.ts` (§3.10.2).

### 3.10.4 `codex/process.ts` — Codex Runner (modular split)

`codex/process.ts` is the runner: `invokeCodexCli` (retry loop, abort
handling) + `executeCodexProcess` (subprocess driver with stdin prompt
piping, NDJSON parsing, HITL detection, denial synthesis). Pure helpers
moved out:

- `codex/argv.ts` — `buildCodexArgs`, `permissionModeToCodexArgs`,
  `buildCodexHitlConfigArgs`, reserved-flag sets
  (`CODEX_RESERVED_FLAGS`, `CODEX_RESERVED_POSITIONALS`,
  `CODEX_INTENTIONALLY_OPEN_FLAGS`).
- `codex/run-state.ts` — `CodexRunState`, `createCodexRunState`,
  `applyCodexEvent` (snake_case event aggregator),
  `extractCodexHitlRequest`, `extractCodexOutput`,
  `codexItemToToolUseInfo`, `formatCodexEventForOutput`.
- `codex/transcript.ts` — `defaultCodexSessionsDir`,
  `findCodexSessionFile` (walks
  `<sessionsDir>/YYYY/MM/DD/rollout-*-<thread_id>.jsonl`).

`codex/process.ts` re-exports every helper for backwards compatibility
— existing imports `from "../codex/process.ts"` keep working in
production code, tests, and `mod.ts`.

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

**FR-L26 typed events.** The `CodexAppServerNotification` type returned
by `client.notifications` is a *runtime* shape (`{method: string,
params: Record<string, unknown>}` — re-exported as
`CodexUntypedNotification` from `codex/events.ts`) — `method` is
arbitrary because new Codex CLI versions can emit notifications the
library has not narrowed yet. Sharp narrowing is opt-in via
`isCodexNotification(note, method)` in `codex/events.ts`, which acts as
a TypeScript type guard:

```ts
for await (const note of client.notifications) {
  if (isCodexNotification(note, "turn/started")) {
    // note.params.turn is `CodexTurn` here — no cast required.
  }
}
```

`codex/events.ts` hand-mirrors the variants from
`codex app-server generate-ts --experimental` output. Today it covers
`thread/started`, `turn/started`, `turn/completed`, `item/started`,
`item/completed`, `item/agentMessage/delta`, `item/reasoning/textDelta`,
`item/reasoning/summaryTextDelta`,
`item/commandExecution/outputDelta`, `error`. The `CodexThreadItem`
sub-union covers `userMessage`, `agentMessage`, `reasoning`, `plan`,
`commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`,
`webSearch`, `contextCompaction`. Both unions deliberately omit a
fallback `type: string` variant — including one would break literal
discriminator narrowing on every `if (event.type === "X")` check.
Future variants surface at the runtime layer (`CodexUntypedNotification`
/ `CodexUntypedItem`) where consumers can assert manually.


### 3.12 `codex/session.ts` — Streaming-Input Session

`openCodexSession(opts)` spawns a `CodexAppServerClient`, performs the
`initialize`/`initialized` handshake, then starts (`thread/start`) or
resumes (`thread/resume`) a thread and returns `CodexSession extends
RuntimeSession` with `threadId`, neutral `sessionId` alias (= threadId),
`send`, `events`, `endInput`, `abort`, `done`.

Thread/turn semantics:

- First `send(content)` issues `turn/start` with `input: [{type:"text",
  text, text_elements: []}]` (the sibling `text_elements` array is
  required by the protocol due to serde Rust conventions — omitting it
  yields `-32602` "invalid params"). Resolves on the RPC ack (input
  accepted by the server); turn completion is observable via events.
- Subsequent `send(content)` calls while a turn is active issue
  `turn/steer` with `expectedTurnId` set to the current `activeTurnId`.
  Both RPC methods' failures are wrapped in `SessionDeliveryError`
  (the original `CodexAppServerError` is attached via standard
  `Error.cause`) so consumers catch a single typed class across
  runtimes (FR-L22).
- `send` rejects with `SessionAbortedError` / `SessionInputClosedError`
  for the closed-input / aborted states — same contract as other
  runtimes.
- `endInput()` is signal-only — calls
  `CodexAppServerClient.closeStdin()` (EOFs stdin and returns after
  flush) and resolves. Full shutdown is observable via `done`. The
  legacy `CodexAppServerClient.close()` (EOF + await done) is retained
  for callers that want to block until the process has exited.
- Inbound notifications are mapped to `RuntimeSessionEvent
  { runtime: "codex", type: lastPathSegment(method), raw: {method,
  params} }` and pushed into the shared `SessionEventQueue<T>` from
  `runtime/event-queue.ts`. Immediately after each `turn/completed`
  notification, the notification pump injects a synthetic `{type:
  "turn-end", synthetic: true, raw: {method: "turn/completed", params}}`
  event into the same queue (FR-L21) — same contract as the other three
  adapters so consumers can write one turn-boundary handler.
- `activeTurnId` tracking has two writers, ordered to close the
  response-vs-notification race:
  1. **Synchronous (RPC response)** — `send()` promotes `result.turn.id`
     from the `TurnStartResponse` (and `result.turnId` from
     `TurnSteerResponse`) into `activeTurnId` immediately after the RPC
     ack returns. Without this, two `send()` calls back-to-back would
     both route through `turn/start` because the asynchronous
     `turn/started` notification has not yet been drained from the
     event queue.
  2. **Asynchronous (notifications)** — the notification pump applies
     `updateActiveTurnId(current, note)` per inbound notification:
     `turn/started` overwrites with the authoritative id (no-op when
     it matches the value already set from the response);
     `turn/completed` clears the field so the next `send` starts a new
     turn. The pure helper is exported for testing.

Wire shape — only the fields actually accepted by the upstream
generated schemas (`v2/ThreadStartParams.ts`,
`v2/ThreadResumeParams.ts`, `v2/UserInput.ts`) are emitted:

- `thread/start` sends `model?`, `cwd?`, `approvalPolicy?`, `sandbox?`,
  `baseInstructions?`. Earlier drafts also sent
  `experimentalRawEvents: false` (orphaned — never present in the
  upstream schema, silently ignored by the server) and
  `persistExtendedHistory: false` (a no-op duplicating the server
  default; the field is gated by `capabilities.experimentalApi: true`
  and only meaningful when set to `true`). Both were removed.
- `thread/resume` sends `threadId`, plus the same overrides as
  `thread/start`.
- `turn/start` / `turn/steer` send `threadId` + `input` (variant
  `{type:"text", text, text_elements: []}` from `v2/UserInput.ts`),
  plus `expectedTurnId` for the `turn/steer` precondition.

Permission-mode mapping is a thin serializer over the shared
`decidePermissionMode` (see §3.10.1). `permissionModeToThreadStartFields`
returns `{approvalPolicy?, sandbox?}` for `thread/start` /
`thread/resume`; the one-shot exec transport renders the same decision
as argv via `permissionModeToCodexArgs`. Same conceptual decision in
both places — drift between the two is prevented by the
cross-serializer-equivalence test in `codex/permission-mode_test.ts`.

`expandCodexSessionExtraArgs(map)` converts an `ExtraArgsMap` to the
`--config key=value` argv list the app-server subprocess accepts;
`null` values drop the flag. `CODEX_SESSION_CLIENT_VERSION` is advertised
via the `initialize` handshake (visible in Codex logs).

Handshake failure tears down the subprocess (`abort` → `await done`) so
callers never see a zombie process on rejection.

### 3.13 `e2e/` — Real-Binary Test Suite (FR-L31)

Opt-in Deno-native suite; does not run under `deno task check`. Layered:

**`e2e/_helpers.ts`:**

- `detectBinary(runtime): Promise<BinaryProbe>` — `sh -c "command -v
  <bin>"` probe, cached per runtime in a module-level `Map`. Returns
  `{ present, path?, reason? }`.
- `e2eEnabled(runtime): Promise<boolean>` — composes `E2E=1`,
  `E2E_RUNTIMES` allow-list, and the binary probe.
- `resolveEnabledMap(): Promise<EnabledMap>` — one-shot `Promise.all` of
  all four gates for use at test-file top level (`Deno.test#ignore` is
  boolean-only; the generator pre-resolves once).
- `ceiling(ms, onFire): cancel` — installs a single-shot timer used as a
  per-scenario hard ceiling.
- `ONE_WORD_OK`, `ONE_WORD_DONE`, `LONG_COUNT_PROMPT` — canonical
  token-minimal prompts shared across scenarios.

**`e2e/_matrix.ts`:**

- `SESSION_CONTRACT_MATRIX: MatrixScenario[]` — 7 shared scenarios
  driven by the generator. Each `MatrixScenario` carries `id`,
  `run(runtime)`, optional `only`/`skip` lists, and an optional
  per-runtime `ceilingMs` override. Cursor uses `CURSOR_CEILING_MS =
  90_000` ms (cold start + `create-chat` + `--resume`); others use
  `DEFAULT_CEILING_MS = 60_000` ms.
- `RUNTIME_SPECS: Record<RuntimeId, RuntimeMatrixSpec>` — per-runtime
  `turnEndRaw` predicate. Claude/Cursor accept `raw.type === "result"`;
  Codex accepts `raw.method` ending in `/completed`; OpenCode accepts
  either `session.idle` or `session.status` (dispatcher is
  edge-triggered on busy→idle).
- Scenario coverage:
  1. `sessionId-sync` (`only: opencode/cursor/codex`) — `sessionId`
     non-empty synchronously after `openSession()`.
  2. `sessionId-after-first-event` (`only: claude`) — `""` before the
     first event; populated after `system/init`.
  3. `synthetic-turn-end-once-per-turn` — exactly one
     `SYNTHETIC_TURN_END`, `synthetic: true`, raw passes the runtime's
     predicate.
  4. `send-after-endInput-throws-SessionInputClosedError`.
  5. `send-after-abort-throws-SessionAbortedError`.
  6. `abort-mid-turn-terminates` — `done` resolves within the runtime's
     ceiling; exit-form assertion (non-zero exit or signal) applies only
     to Claude / Cursor, which propagate SIGTERM. Codex app-server and
     OpenCode serve catch SIGTERM and exit cleanly (`0`, null signal),
     so the portable invariant is the elapsed-time bound.
  7. `two-turns` — two sends, two turn-ends, clean `endInput` + `done`.
  8. `content-normalization` — cross-runtime FR-L23 check: every
     event in a single-word-reply turn passes through
     `extractSessionContent` without throwing, synthetic events map
     to `[]`, non-synthetic events yield ≥1 `NormalizedContent`, and
     the concatenation of `kind:"text"` + `kind:"final"` entries
     contains the reply word on every adapter. Closes the loop
     between the stub-based contract test in
     `runtime/session_contract_test.ts` and real CLI behaviour.
  9. `codex-typed-notification-narrowing` (codex-only) — FR-L26
     check: live `codex app-server` notification stream surfaces
     `turn/started` and `turn/completed` notifications that narrow
     via `isCodexNotification` to typed payloads; field access uses
     `note.params.turn.id` / `.status` directly without casts so an
     upstream schema rename breaks the access site.

**`e2e/session_matrix_e2e_test.ts`:** iterates `RuntimeId ×
SESSION_CONTRACT_MATRIX`, filters via `only`/`skip`, and registers one
`Deno.test({ ignore: !enabled[runtime] })` per allowed pair. `enabled`
is pre-resolved via top-level `await resolveEnabledMap()` — the
`ignore` field must be a synchronous boolean.

**`e2e/invoke_abort_e2e_test.ts`:** Claude-only `invokeClaudeCli`
scenarios — pre-start abort (`"Aborted before start"`), mid-run abort
(< 15 s), short-timeout without external signal.

**`e2e/claude_settings_e2e_test.ts`:** Claude-only `settingSources: []`
cleanroom scenario.

**`e2e/cursor_typed_stream_e2e_test.ts`:** Cursor-only FR-L30 check.
One-shot `invokeCursorCli` with `permissionMode: "bypassPermissions"`
(maps to `--yolo`) in a `Deno.makeTempDir()` scratch dir holding a
single `hello.txt` file; prompts Cursor to read it. Asserts the
captured raw NDJSON re-parses through `parseCursorStreamEvent` into a
typed `CursorToolCallStartedEvent`, that `unwrapCursorToolCall`
flattens the `<name>ToolCall` wrapper into a non-empty `{name, args?}`,
and that `onToolUseObserved` fires with `runtime: "cursor"` plus
non-empty `id`/`name`. Stays out of the matrix because the matrix is
session-only and does not surface `permissionMode`.

Finalizer discipline: every session scenario wraps the body in
`try/finally` that calls `session.abort("e2e-cleanup")` and
`await session.done` so the next `Deno.test` starts with the
process-registry empty. The outer hard-ceiling timer is cleared in
`finally` regardless of failure.

Publish exclusion: `deno.json:publish.exclude` covers both `e2e` and
`e2e/**` so the suite is absent from the JSR tarball. CI wiring:

- `.github/workflows/e2e.yml` — manual `workflow_dispatch`,
  selectable runtime list. Used for ad-hoc runs and Cursor (the only
  surface where Cursor verification is practical, run from a macOS
  workstation that has the proprietary CLI installed).
- `.github/workflows/ci-e2e.yml` — automatic on PR + push to main.
  One parallel job per runtime (claude / opencode / codex), each on
  `ubuntu-latest`. `continue-on-error: true` during the soak window
  (~1 week) — checks appear as advisory-only in the PR UI and do
  NOT block merge. Promotion to a required check is a branch-
  protection change in the repo admin UI, not a code change.
  Cursor excluded: no headless Linux CLI, no documented release
  binary safe to script; an enabled stub job would fail with
  "binary not found" on every run. The TODO comment in
  `ci-e2e.yml` documents the rationale.


## 4. Data

### Runtime capability matrix

| Runtime  | permissionMode | hitl  | transcript | interactive | toolUseObservation | session | capabilityInventory | toolFilter |
|----------|----------------|-------|------------|-------------|--------------------|---------|---------------------|------------|
| claude   | true           | true  | true       | true        | true               | true    | true                | true       |
| opencode | true           | true  | true       | true        | true               | true    | true                | false      |
| cursor   | false          | false | false      | false       | false              | true    | true                | false      |
| codex    | true           | true  | true       | true        | true               | true    | true                | false      |

**`session` specifics:**

- When `true`, adapter implements `openSession(opts)` returning a long-lived
  `RuntimeSession` with push-based `send()`, async-iterable `events`,
  signal-only `endInput()`, SIGTERM `abort()`. Uniform contract:
  `send` resolves on input acceptance; `endInput` returns promptly; `done`
  is the source of truth for full shutdown; `pid` is NOT on the neutral
  interface. See FR-L19 and §3.6 / §3.8 / §3.10.1 / §3.11-3.12, and
  `runtime/session_contract_test.ts` for the backend-independent
  invariants.
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
- `toolFilter` — `capabilities.toolFilter === false`.
  `allowedTools` / `disallowedTools` are validated (same rules as
  Claude via `validateToolFilter`) and ignored in argv; first
  set-value call emits one `console.warn` per process. See FR-L24.

**OpenCode specifics:**

- `transcript` — OpenCode persists sessions in a local SQLite DB
  (`~/.local/share/opencode/opencode.db`); there is no per-session file
  path to copy. The adapter instead invokes `opencode export <sessionId>`
  post-run, captures stdout, writes it to a temp file via
  `Deno.makeTempFile`, and surfaces the path as
  `CliRunOutput.transcript_path`. See `exportOpenCodeTranscript` in
  `opencode/process.ts`; failures (missing binary, non-zero exit) are
  swallowed best-effort so transcript export never masks the primary
  invocation result.
- `toolUseObservation` — fires `onToolUseObserved` once per non-HITL
  `tool_use` event whose `state.status` reaches `completed` or `failed`;
  an `"abort"` decision SIGTERMs the subprocess and the runner synthesizes
  a `permission_denials[]` entry for the observed tool. Tool id is taken
  from `part.id`, falling back to `part.callID`. HITL tool events stay on
  their dedicated detection path (no double-dispatch). See
  `openCodeToolUseInfo` and `executeOpenCodeProcess` in
  `opencode/process.ts`.
- `OpenCodeStreamEvent` — exported discriminated union
  (`OpenCodeStepStartEvent | OpenCodeTextEvent | OpenCodeToolUseEvent
  | OpenCodeStepFinishEvent | OpenCodeErrorEvent`) for consumers that
  want typed narrowing of `RuntimeInvokeOptions.onEvent`. Each member
  keeps `[key: string]: unknown` for forward-compat with upstream CLI
  field additions.
- `toolFilter` — `capabilities.toolFilter === false`.
  `allowedTools` / `disallowedTools` are validated (same rules as
  Claude via `validateToolFilter`) and ignored in argv; first
  set-value call emits one `console.warn` per process. See FR-L24.

### 3.x Reasoning-effort mapping (FR-L25)

Abstract enum on `RuntimeInvokeOptions.reasoningEffort` /
`RuntimeSessionOptions.reasoningEffort`:
`"minimal" | "low" | "medium" | "high"`. `runtime/reasoning-effort.ts`
owns the enum + shared `validateReasoningEffort(runtime, opts)` that
every adapter invokes before dispatch.

- **Claude (`capabilities.reasoningEffort: true`)** —
  `buildClaudeArgs` / `buildClaudeSessionArgs` emit
  `--effort <value>` via `mapReasoningEffortToClaude`. Claude's
  native enum is `low | medium | high | xhigh | max`; the abstract
  `"minimal"` has no equivalent and degrades to `"low"` with a
  one-time `console.warn` (latch in `claude/process.ts`;
  `_resetClaudeReasoningEffortWarning` for tests).
- **Codex (`capabilities.reasoningEffort: true`)** — `buildCodexArgs`
  emits `--config model_reasoning_effort="<value>"` for the
  `codex exec` transport. `openCodexSession` prepends the same
  `--config` override to the `codex app-server` argv via
  `expandCodexSessionExtraArgs`, so the effort applies across turns.
  1:1 mapping; no warning.
- **OpenCode (`capabilities.reasoningEffort: true`)** — invoke path
  (`opencode run`) emits `--variant <value>`; session path sets
  `body.variant = <value>` on every
  `POST /session/:id/prompt_async`. OpenCode's `--variant` is
  provider-specific (the value is forwarded to the active model
  provider's reasoning-effort dial, whose enum may differ from the
  abstract 4-level ladder), so the adapter emits a one-time
  `console.warn` on first set-value use
  (`_resetReasoningEffortWarning` for tests).
- **Cursor (`capabilities.reasoningEffort: false`)** — no native
  control. The typed field is validated (so malformed input still
  throws uniformly) and ignored in argv / subprocess args; first
  set-value call emits one `console.warn` per process.

**Validation contract** (uniform across adapters):

- Value outside the 4-level enum → synchronous throw.
- Typed field set AND either `--effort` or `--variant` present in
  `extraArgs` → synchronous throw (collision).
- Legacy `extraArgs: {"--effort": …}` / `{"--variant": …}` without
  the typed field still works — reserved-flag lists are NOT extended.

**Reserved-flag coverage** — every adapter exports two paired
constants: `<RUNTIME>_RESERVED_FLAGS` (extraArgs key collision throws)
and `<RUNTIME>_INTENTIONALLY_OPEN_FLAGS` (flags the builder emits but
which stay legacy-extraArgs-routable on purpose, e.g. `--allowedTools`,
`--effort`, `--variant`, `--config`). The cross-runtime test
`runtime/reserved-flag-coverage_test.ts` asserts both directions: every
emitted flag is reserved-or-open, and every reserved entry shows up in
some scenario's argv (catches stale reservations after refactors).
Adding a flag to a builder without updating one of the two lists fails
the test loudly.

## 5. Constraints

- **No domain logic:** Library MUST NOT contain git, GitHub, workflow, DAG,
  or any domain-specific code.
- **No engine imports:** Zero imports from `@korchasa/flowai-workflow`.
- **Structural typing:** `RuntimeConfigSource` uses structural shape, not
  imported workflow types.
- **Publish order:** `ai-ide-cli` published before `engine` — engine's
  workspace imports auto-pin to ide-cli version at publish time.
