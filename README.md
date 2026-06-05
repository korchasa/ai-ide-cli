# @korchasa/ai-ide-cli

Thin Deno/TypeScript wrapper around agent-CLI binaries — **Claude Code**,
**OpenCode**, **Cursor**, and **Codex**. Normalizes invocation, NDJSON event
parsing, retry, session resume, streaming-input sessions, and
skill/slash-command enumeration. Runtime-neutral output shape
(`CliRunOutput`) lets downstream code treat all four runtimes
interchangeably.

Human-in-the-loop (HITL) is **out of scope** — see
[ADR-0002](documents/adr/2026-05-02-remove-hitl.md). Build it on top of
`extraArgs`, `env`, or stream-event observers in your own consumer
package.

Split out from [`@korchasa/flowai-workflow`](https://jsr.io/@korchasa/flowai-workflow)
so consumers that need only the CLI wrapper can depend on a small, focused
package without pulling the full DAG workflow engine.

## Install

```sh
deno add jsr:@korchasa/ai-ide-cli
```

## Usage — Runtime Adapter (uniform dispatch)

Recommended entry point. Same call shape across Claude, OpenCode, Cursor,
and Codex.

```ts
import { getRuntimeAdapter } from "jsr:@korchasa/ai-ide-cli/runtime";

const adapter = getRuntimeAdapter("claude"); // or "opencode" | "cursor" | "codex"

const { output, error } = await adapter.invoke({
  taskPrompt: "Explain React hooks in two sentences.",
  timeoutSeconds: 60,
  maxRetries: 1,
  retryDelaySeconds: 1,
});

if (error) throw new Error(error);
console.log(output?.result);
```

### Capabilities

Each adapter declares a `capabilities` record so consumers can branch on
support without guessing:

```ts
const adapter = getRuntimeAdapter("codex");
adapter.capabilities; // { permissionMode, transcript, interactive,
                      //   toolUseObservation, session, capabilityInventory,
                      //   toolFilter, reasoningEffort }
```

Capabilities reflect the CLI transport (the historical default). When
selecting a non-default transport, query `capabilitiesFor(transport)`
to see which surfaces actually round-trip on that wire:

```ts
adapter.capabilitiesFor?.("acp");
// e.g. claude/codex/opencode pilots downgrade `transcript`,
// `interactive`, `toolFilter`, and `capabilityInventory` to false
// on ACP. See "Alternate Transport (ACP)" below.
```

### Feature support matrix

| Feature              | claude         | opencode       | cursor            | codex          |
|----------------------|----------------|----------------|-------------------|----------------|
| permissionMode       | yes            | yes            | no (`--yolo` only)| yes            |
| transcript path      | yes            | yes (via `opencode export`) | no  | yes            |
| interactive TUI      | yes            | yes            | no                | yes            |
| toolUseObservation   | yes            | yes            | yes (FR-L30, fires on `tool_call/started`) | yes |
| `openSession`        | yes (real)     | yes (`opencode serve`) | faux (per-send subprocess) | yes (app-server) |
| capabilityInventory  | yes            | yes            | yes               | yes            |
| skill loading        | yes (`~/.claude/skills/`) | yes (`.claude/skills/`) | no | yes (`~/.agents/skills/`) |
| model selection      | yes            | yes            | partial (dropped on `--resume`) | yes |
| session resume by id | `--resume`     | `--session`    | `--resume`        | `resume <id>`  |
| toolFilter (FR-L24)  | yes (`--allowedTools` / `--disallowedTools`) | warn-only | warn-only | warn-only |
| reasoningEffort (FR-L25) | yes (`--effort`, `minimal` warn-mapped to `low`) | yes (`--variant` / `body.variant`, provider-specific warn) | warn-only | yes (`--config model_reasoning_effort`) |
| typed event union    | yes (`ClaudeStreamEvent` over stream-json) | partial (`OpenCodeStreamEvent` for `run --format json` only; SSE session events are untyped — FR-L27 pending) | yes (`CursorStreamEvent` over stream-json: system / user / thinking / assistant / tool_call / result, FR-L30) | yes (`CodexNotification` + `isCodexNotification` type guard, FR-L26) |
| typed assistant content blocks | yes (`ClaudeAssistantBlock`: `text` / `tool_use` / `thinking` discriminator) | partial (`OpenCodeToolUseEvent` from `run --format json`; `Part` union from `@opencode-ai/sdk` not re-exported yet — FR-L27 pending) | partial (`CursorAssistantBlock`: text-only — Cursor does NOT inline tool blocks; tool calls are sibling `tool_call/{started,completed}` events with a `tool_call.<name>ToolCall.{args\|result}` wrapper unflattened by `unwrapCursorToolCall`, FR-L30) | yes (`CodexThreadItem` 10-variant union: `agentMessage` / `reasoning` / `plan` / `commandExecution` / `fileChange` / `mcpToolCall` / `dynamicToolCall` / `webSearch` / …, FR-L26) |
| structured init w/ capabilities | yes (`ClaudeSystemEvent` carries `tools[]` / `skills[]` / `agents[]` / `mcp_servers[]` / `slash_commands[]` / `plugins[]`) | no in event stream (capability inventory available out-of-band via the `/agent` and `/config` server endpoints) | no (init only carries `model` / `cwd` / `permissionMode` / `apiKeySource`) | no in event stream (`thread/start` response carries `instructionSources[]` only — no tool enum) |
| per-assistant-turn lifecycle hook | yes (`ClaudeLifecycleHooks.onAssistant` fires once per assistant turn with the typed `ClaudeAssistantEvent`) | no (cross-runtime `RuntimeLifecycleHooks.onInit` / `onResult` only) | yes (`CursorLifecycleHooks.onAssistant` fires once per assistant turn with the typed `CursorAssistantEvent`, FR-L30) | no (cross-runtime hooks only — FR-L29 pending: `onCodexTurnCompleted` bound to `turn/completed`) |
| settingSources cleanroom | yes (`CLAUDE_CONFIG_DIR` redirect, FR-L18) | silent ignore | silent ignore | silent ignore (FR-L28 pending — `CODEX_HOME` redirect) |

Universal across all four runtimes: NDJSON event streaming, `AbortSignal`
+ timeout, custom `cwd` / `env`, `extraArgs` / `runtime_args` passthrough,
typed lifecycle `hooks` (`onInit` / `onResult`), raw `onEvent` escape
hatch (`Record<string, unknown>`), normalized session-event content
extraction via `extractSessionContent` (FR-L23).

Notes:

- **cursor `openSession`** — faux: one `cursor agent -p --resume <id>`
  subprocess per `send()`; emits a synthetic `system.init` event.
- **codex `openSession`** — uses experimental `codex app-server --listen
  stdio://` JSON-RPC transport (NOT `codex exec`). Targets
  `codex-cli >= 0.121.0`.

## Usage — Streaming-Input Sessions (`openSession`)

Long-lived sessions for push-based multi-turn workflows: open once, stream
additional user messages into the running runtime, consume normalized
events, close gracefully or forcefully.

**Uniform contract across all four runtimes**
(verified by `runtime/session_contract_test.ts`):

- `send(content)` resolves when the runtime has accepted the input —
  never waits for turn completion. Errors during turn processing surface
  via `events` and `done`, not via the `send` promise.
- `endInput()` is **signal-only**: flips "no more input" and returns
  promptly. Full shutdown is observable via `await session.done`.
- `abort(reason?)` is idempotent SIGTERM (or transport equivalent).
- `events` is a single-consumer async iterable of
  `{runtime, type, raw}` events; re-iteration throws.
- `done` always resolves (never rejects) with `{exitCode, signal, stderr}`.

```ts
import { getRuntimeAdapter } from "jsr:@korchasa/ai-ide-cli/runtime";

const adapter = getRuntimeAdapter("claude");
if (!adapter.capabilities.session) throw new Error("no session support");

const session = await adapter.openSession!({
  systemPrompt: "You are a careful assistant.",
});

await session.send("Draft a haiku about TypeScript.");
await session.send("Now make it about Rust instead.");
await session.endInput(); // signal: no more input
for await (const event of session.events) {
  if (event.type === "result") console.log(event.raw);
}
const status = await session.done; // {exitCode, signal, stderr}
```

Per-runtime transport (all implement the same contract):

- **Claude** — real streaming-input via `claude -p --input-format stream-json
  --output-format stream-json --verbose` with piped stdin/stdout.
- **OpenCode** — dedicated `opencode serve` subprocess + `POST /session`,
  `GET /event` SSE, `POST /session/:id/prompt_async`.
- **Cursor** — faux session: `cursor agent create-chat` + one
  `cursor agent -p --resume <id> <msg>` subprocess per queued send,
  serialized through a worker queue. `send()` enqueues and returns
  immediately; per-turn failures emit a synthetic
  `{type:"error", subtype:"send_failed"}` event.
- **Codex** — experimental `codex app-server --listen stdio://` JSON-RPC
  transport. First `send` → `turn/start`; subsequent sends during an
  active turn → `turn/steer` for mid-turn steering.

Runtime-specific handles (`ClaudeSession`, `CursorSession`,
`OpenCodeSession`, `CodexSession`) add extra fields like `pid`,
`chatId`/`threadId`/`sessionId`. Import from the runtime sub-path
(e.g. `jsr:@korchasa/ai-ide-cli/claude/session`) when you need them.

## Usage — Per-runtime one-shot invocation

```ts
import { invokeClaudeCli } from "jsr:@korchasa/ai-ide-cli/claude/process";

const { output } = await invokeClaudeCli({
  taskPrompt: "Write a haiku about TypeScript.",
  timeoutSeconds: 60,
  maxRetries: 3,
  retryDelaySeconds: 5,
  onOutput: (line) => console.log(line),
});
console.log(output?.result);
```

Identical call shape for the other runtimes:
`invokeOpenCodeCli` (`jsr:@korchasa/ai-ide-cli/opencode/process`),
`invokeCursorCli` (`jsr:@korchasa/ai-ide-cli/cursor/process`),
`invokeCodexCli` (`jsr:@korchasa/ai-ide-cli/codex/process`).

## Custom environment, raw events, and lifecycle hooks

Universal across all four runtimes: `env`, `onEvent` (raw NDJSON escape
hatch), `hooks` (typed lifecycle).

Runtime-scoped (check `capabilities` before using):

- `onToolUseObserved` — Claude, Codex, OpenCode, and Cursor (FR-L30)
  (`capabilities.toolUseObservation`). Cursor fires the callback on
  every `tool_call/started` event with the flattened tool name from
  `unwrapCursorToolCall`.
- `settingSources` — Claude only (cleanroom `CLAUDE_CONFIG_DIR` setup).
  Other runtimes have no equivalent; the option is ignored.

```ts
await invokeClaudeCli({
  taskPrompt: "...",
  timeoutSeconds: 60,
  maxRetries: 1,
  retryDelaySeconds: 1,
  env: { CLAUDE_CONFIG_DIR: "/tmp/cleanroom" },
  onEvent: (event) => {
    if (event.type === "system") console.log("init:", event);
  },
  hooks: {
    onInit: (info) => console.log("session", info.sessionId),
    onResult: (output) => console.log("cost", output.total_cost_usd),
  },
  settingSources: ["user"], // symlink host ~/.claude/settings.json only
});
```

## Runtime error analysis

`analyzeRuntimeErrorSignal()` classifies captured CLI failure fragments
without spawning a runtime. It is useful when a consumer has stderr, logs,
raw events, or an error string and wants a conservative signal such as
`quota`, `rate_limit`, `context_window`, `token_budget`, `auth`, `policy`,
`plan_limit`, or the generic `runtime_error`.

```ts
import { analyzeRuntimeErrorSignal } from "jsr:@korchasa/ai-ide-cli";

const runtimeError = analyzeRuntimeErrorSignal({
  runtime: "opencode",
  source: "log",
  text:
    `INFO {"statusCode":429,"data":{"error":{"message":"Usage limit reached. Your limit will reset at 2026-05-09 04:56:07"}}}`,
});
console.log(runtimeError?.kind, runtimeError?.resetAt);
```

`RuntimeInvokeResult.runtime_error` is populated from trusted adapter
failure paths. Known cases get typed subtypes: OpenCode upstream HTTP
401 / 402 / 403 / 429 log detections and Cursor's Free-plan named-model
restriction. Cursor process failures that have no safe subtype are returned
as `kind: "runtime_error"`. The existing human-readable `error` string is
preserved.

## Scoping subprocesses (`ProcessRegistry`)

Every adapter call (`invoke`, `openSession`) spawns one or more child
processes. Two ways to track them for graceful shutdown:

- **Default singleton.** Standalone CLI use and existing consumers do
  nothing — the package's module-level `defaultRegistry` tracks every
  spawn, and the free functions
  `register`/`unregister`/`onShutdown`/`killAll` operate on it. Importing
  `installSignalHandlers()` from a downstream package (e.g.
  `@korchasa/flowai-workflow`) wires `SIGINT`/`SIGTERM` to
  `killAll()` + `Deno.exit(130|143)`.
- **Instance-scoped (`ProcessRegistry`).** When one Deno process hosts
  several independent runtimes (e.g. a workflow engine and a chat
  bridge in the same binary), pass a private `ProcessRegistry` to each
  subsystem so `killAll()` on one does not touch the others.

```ts
import {
  getRuntimeAdapter,
  ProcessRegistry,
} from "jsr:@korchasa/ai-ide-cli";

const engineRegistry = new ProcessRegistry();
const bridgeRegistry = new ProcessRegistry();

const adapter = getRuntimeAdapter("claude");
const result = await adapter.invoke({
  taskPrompt: "...",
  timeoutSeconds: 60,
  maxRetries: 1,
  retryDelaySeconds: 1,
  processRegistry: engineRegistry, // scope this spawn to engineRegistry
});

// Reaps engine-spawned subprocesses only. Bridge-spawned subprocesses
// stay alive.
await engineRegistry.killAll();
```

Both `RuntimeInvokeOptions` and `RuntimeSessionOptions` accept the
optional `processRegistry` field; when omitted, the default singleton is
used (backward-compatible with all earlier consumers).

For one-shot Claude invocations, `RuntimeInvokeOptions.systemPromptFile`
maps to `--append-system-prompt-file <path>`. It is mutually exclusive
with `systemPrompt`; OpenCode, Cursor, and Codex reject it until they
gain native file-prompt support.

## Alternate Transport (ACP)

Opt into the [Agent Client Protocol](https://agentclientprotocol.com)
JSON-RPC stdio transport instead of the hand-rolled per-runtime
subprocess wrapper. Same `RuntimeAdapter` API, same
`RuntimeSessionEvent` shape, same `analyzeRuntimeErrorSignal` retry
classification — only the wire dialect changes (FR-L39).

Three pilots validated end-to-end against real binaries:

- **claude** — `@agentclientprotocol/claude-agent-acp@0.37.0` via `npx`.
- **codex** — `@zed-industries/codex-acp@0.15.0` via `npx`.
- **opencode** — `opencode acp` subcommand of the locally-installed
  binary.

Cursor (`cursor-agent acp`) is wired in `runtime/acp/fronts.ts` but
flagged `pilot: false`; passing `transport: "acp"` to the Cursor
adapter throws a "not piloted yet" error until its local IDE binary
joins the validation matrix.

```ts
import { getRuntimeAdapter } from "jsr:@korchasa/ai-ide-cli/runtime";

const adapter = getRuntimeAdapter("claude");
const { output, error } = await adapter.invoke({
  taskPrompt: "Reply with the word: ok",
  timeoutSeconds: 60,
  maxRetries: 1,
  retryDelaySeconds: 1,
  transport: "acp", // default is "cli"
});
```

What's preserved across the ACP wire:

- `cwd`, `env`, `permissionMode`, `reasoningEffort`, `model`, MCP
  injection (`mcpServers`), tool-use observation, and streaming-input
  sessions (`openSession`) all round-trip natively.
- Synthetic `SYNTHETIC_TURN_END` is emitted after each
  `session/prompt` completes (same cross-runtime invariant as the CLI
  path).
- `analyzeRuntimeErrorSignal` classifies three ACP failure surfaces:
  `AcpRpcError` envelope, `PromptResponse.stopReason` (e.g.
  `max_tokens → token_budget`), and stderr tail. Retries follow the
  same kind-based policy as CLI (terminal on `auth` / `policy` /
  `context_window` / `token_budget` / `plan_limit`).

What downgrades on the ACP path:

- `transcript`, `interactive` (TUI), `toolFilter` (`allowedTools` /
  `disallowedTools`), and `capabilityInventory` are unavailable.
- ACP-lossy fields (`allowedTools`, `disallowedTools`,
  `settingSources`, `systemPrompt`) are surfaced as structured
  `degradedOptions` diagnostics routed through `onCallbackError`
  (FR-L32) so consumers can monitor coverage gaps.

Override the resolved front when you need a local fork or a
test stub (`acpFront` bypasses the `pilot` guard):

```ts
import type { AcpFrontLauncher } from "jsr:@korchasa/ai-ide-cli";

const customFront: AcpFrontLauncher = {
  cmd: "/path/to/local/claude-agent-acp",
  args: ["--stdio"],
  pilot: true,
};
await adapter.invoke({
  taskPrompt: "...",
  timeoutSeconds: 60,
  maxRetries: 0,
  retryDelaySeconds: 1,
  transport: "acp",
  acpFront: customFront,
});
```

Discovery-sensitive paths (e.g. `npx` resolution against a
misconfigured `acpFront`) classify as unclassified spawn errors and
will be retried up to `maxRetries`. Prefer `maxRetries: 0` when you
do not trust the launcher binary.

> **OS signals:** the library never installs `SIGINT`/`SIGTERM` handlers
> itself. Downstream `installSignalHandlers()` helpers typically reap
> only the **default singleton**. Subprocesses tracked by a private
> `ProcessRegistry` will NOT be killed on signal unless the embedder
> wires its own handler (e.g. `Deno.addSignalListener("SIGINT", () =>
> Promise.all([engineRegistry.killAll(), bridgeRegistry.killAll()]))`).

## Capability inventory (`fetchCapabilitiesSlow`)

Probe a runtime for the skills and slash commands it currently exposes in
a given working directory — useful for dashboards, IDE pickers, and
workflow planners that need to know what's actually available.

```ts
const adapter = getRuntimeAdapter("claude");
if (!adapter.capabilities.capabilityInventory) throw new Error("unsupported");
const inventory = await adapter.fetchCapabilitiesSlow!({ cwd: Deno.cwd() });
console.log(inventory.skills);   // [{name, plugin?}, ...]
console.log(inventory.commands); // [{name, plugin?}, ...]
```

**Expensive**: one full LLM turn per call, seconds-to-minutes, model-priced.
Callers should cache results — hence the `Slow` suffix.

## Commands fast-channel (`fetchCommands`)

Zero-LLM-cost discovery of the live slash-command list, complementary to
the expensive `fetchCapabilitiesSlow`. Backed today by the ACP
`available_commands_update` push, so it is gated on the **ACP transport**
and the transport-scoped `commandsFastChannel` capability. Commands only
— skills stay on the slow path.

```ts
const adapter = getRuntimeAdapter("claude");
if (!adapter.capabilitiesFor?.("acp").commandsFastChannel) {
  throw new Error("no commands fast-channel for this transport");
}
const snapshot = await adapter.fetchCommands!({
  transport: "acp",
  cwd: Deno.cwd(),
  timeoutMs: 15_000, // ceiling on the wait for the first push (default 10s)
});
console.log(snapshot.commands); // [{ name, description, input?: { hint? } }, ...]
```

`transport: "cli"` rejects with
`CommandsUnavailableError(reason: "no_fast_channel")` (no CLI fast-path
yet); a non-piloted front rejects with `reason: "front_not_piloted"`; a
front that never pushes before the ceiling rejects with
`reason: "timeout"`. There is **no** auto-fallback into
`fetchCapabilitiesSlow` — pick the channel explicitly.

Per-transport support (read it at runtime via `capabilitiesFor`):

- `transport: "acp"`
  - `claude` — ✓ pushes commands shortly after `session/new`.
  - `codex` / `opencode` — capability advertised; whether the pinned
    front actually pushes the variant today is front-version-dependent
    (a no-push front surfaces as `reason: "timeout"`).
  - `cursor` — ✗ (ACP front not piloted; method left undefined).
- `transport: "cli"` — ✗ for every runtime (rejects `no_fast_channel`).

## Reference consumers

- [`@korchasa/flowai-workflow`](https://jsr.io/@korchasa/flowai-workflow) —
  a DAG workflow engine. Owns its own HITL pipeline on top of this
  library's stream-event observers.
- [`korchasa/tg-ide-bridge`](https://github.com/korchasa/tg-ide-bridge) —
  per-project Telegram-to-IDE daemon (Claude Code / OpenCode / Cursor).
  Polls Telegram, forwards messages as prompts via `invoke*Cli`, persists
  the `session_id` for `--resume`, and exposes runtime-scoped settings
  (`model`, `effort`, `permissionMode`, `timeoutSeconds`,
  `maxRetries`, `retryDelaySeconds`) as chat commands. Good reference for
  single-runtime consumers.

## Development

- `deno task check` — authoritative verification: fmt, lint, type check,
  unit tests (PATH-stubbed binaries, zero tokens), doc-lint, publish
  dry-run. Runs in CI on every push / PR.
- `deno task test` — unit tests only; use during TDD iterations.
- `deno task e2e` — opt-in real-binary suite under `e2e/` (FR-L31).
  Requires Claude / OpenCode / Cursor / Codex CLIs on `$PATH`,
  authenticated (logged in or API key configured), and spends real
  tokens. Guarded by `E2E=1`; narrow to one runtime with
  `deno task e2e:<claude|opencode|cursor|codex>` (sets `E2E_RUNTIMES`),
  or to the ACP transport smoke suite with `deno task e2e:acp`
  (claude + codex + opencode pilots, FR-L39).
  Missing binaries surface as ignored tests instead of ENOENT.
  Installed-but-unauthenticated binaries fail loudly via the FR-L34
  auth-probe at load time — no spurious assertion failures. Not wired
  into `deno task check`. E2E does not run automatically in CI;
  `.github/workflows/e2e.yml` is a manual `workflow_dispatch` for
  ad-hoc runs from a repo with API key secrets configured (and the
  only Cursor surface — Cursor has no headless Linux CLI, so the
  Cursor cell of the matrix is run from a macOS workstation).

Iteration tip: for fast fmt/lint/JSDoc feedback, run the cheap sub-steps
individually first (`deno fmt --check`, `deno lint .`,
`deno doc --lint mod.ts`) and only invoke `deno task check` once those
pass.

## Scope

This package is deliberately minimal:
- No DAG / workflow logic
- No git / GitHub / PR operations
- No configuration file parsing
- No domain-specific logic

Runtime-specific stream parsers and session openers are available via
sub-path exports (`./claude/stream`, `./cursor/stream`,
`./opencode/session`, `./cursor/session`, `./codex/app-server`, etc.)
for callers that need typed access beyond the neutral
`RuntimeAdapter` / `RuntimeSession` interfaces.
