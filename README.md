# @korchasa/ai-ide-cli

Thin Deno/TypeScript wrapper around agent-CLI binaries — **Claude Code**,
**OpenCode**, **Cursor**, and **Codex**. Normalizes invocation, NDJSON event
parsing, retry, session resume, HITL tool wiring, streaming-input sessions,
and skill/slash-command enumeration. Runtime-neutral output shape
(`CliRunOutput`) lets downstream code treat all four runtimes
interchangeably.

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
adapter.capabilities; // { permissionMode, hitl, transcript, interactive,
                      //   toolUseObservation, session, capabilityInventory }
```

### Feature support matrix

| Feature              | claude         | opencode       | cursor            | codex          |
|----------------------|----------------|----------------|-------------------|----------------|
| permissionMode       | yes            | yes            | no (`--yolo` only)| yes            |
| hitl                 | yes (denials)  | yes (MCP)      | no                | yes (MCP)      |
| transcript path      | yes            | no             | no                | yes            |
| interactive TUI      | yes            | yes            | no                | yes            |
| toolUseObservation   | yes            | no             | no                | yes            |
| `openSession`        | yes (real)     | yes (`opencode serve`) | faux (per-send subprocess) | yes (app-server) |
| capabilityInventory  | yes            | yes            | yes               | yes            |
| skill loading        | yes (`~/.claude/skills/`) | yes (`.claude/skills/`) | no | yes (`~/.agents/skills/`) |
| model selection      | yes            | yes            | partial (dropped on `--resume`) | yes |
| session resume by id | `--resume`     | `--session`    | `--resume`        | `resume <id>`  |

Universal across all four runtimes: NDJSON event streaming, `AbortSignal`
+ timeout, custom `cwd` / `env`, `extraArgs` / `runtime_args` passthrough,
typed lifecycle `hooks`, raw `onEvent` escape hatch.

Notes:

- **claude hitl** — no dedicated MCP server; surfaced via
  `AskUserQuestion` permission denials in `CliRunOutput.permission_denials`.
- **opencode / codex hitl** — per-invocation stdio MCP server; consumer
  supplies `hitlMcpCommandBuilder` (see below).
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

- `onToolUseObserved` — Claude and Codex only
  (`capabilities.toolUseObservation`). OpenCode and Cursor silently
  ignore the callback.
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

## HITL MCP self-spawn contract

HITL support per runtime:

- **OpenCode, Codex** — run a stdio MCP server; consumer must supply
  `hitlMcpCommandBuilder` (described below).
- **Claude** — no MCP server; HITL surfaces via `AskUserQuestion`
  permission denials in `CliRunOutput.permission_denials`. No self-spawn
  setup needed.
- **Cursor** — no HITL support (`capabilities.hitl === false`). Any
  `hitlConfig` on a Cursor invocation is ignored.

For OpenCode and Codex, the library does NOT ship a binary — it exposes
the MCP handlers (`runOpenCodeHitlMcpServer`, `runCodexHitlMcpServer`)
and requires the consumer to supply a zero-argument callback returning
the `argv` that spawns that handler in a sub-process.

```ts
import { runOpenCodeHitlMcpServer } from "jsr:@korchasa/ai-ide-cli/opencode/hitl-mcp";
import { invokeOpenCodeCli } from "jsr:@korchasa/ai-ide-cli/opencode/process";

// 1. In your CLI entry point, dispatch the internal flag:
if (Deno.args.includes("--internal-opencode-hitl-mcp")) {
  await runOpenCodeHitlMcpServer();
  Deno.exit(0);
}

// 2. When invoking OpenCode with HITL enabled, pass the builder:
await invokeOpenCodeCli({
  taskPrompt: "...",
  timeoutSeconds: 60,
  maxRetries: 1,
  retryDelaySeconds: 1,
  hitlConfig: {
    ask_script: "ask.sh",
    check_script: "check.sh",
    poll_interval: 60,
    timeout: 7200,
  },
  hitlMcpCommandBuilder: () => [
    Deno.execPath(),
    "run",
    "-A",
    new URL("./my-cli.ts", import.meta.url).pathname,
    "--internal-opencode-hitl-mcp",
  ],
});
```

If `hitlConfig` is set but `hitlMcpCommandBuilder` is omitted, the library
throws at invocation time with an explicit error.

## Reference consumers

- [`@korchasa/flowai-workflow`](https://jsr.io/@korchasa/flowai-workflow) —
  a DAG workflow engine. Its `engine/agent.ts` wires
  `hitlMcpCommandBuilder` to the engine binary's own
  `--internal-opencode-hitl-mcp` flag and is the recommended reference for
  building a consumer binary.
- [`korchasa/tg-ide-bridge`](https://github.com/korchasa/tg-ide-bridge) —
  per-project Telegram-to-IDE daemon (Claude Code / OpenCode / Cursor).
  Polls Telegram, forwards messages as prompts via `invoke*Cli`, persists
  the `session_id` for `--resume`, and exposes runtime-scoped settings
  (`model`, `effort`, `permissionMode`, `timeoutSeconds`,
  `maxRetries`, `retryDelaySeconds`) as chat commands. Good reference for
  single-runtime consumers that do not need HITL or a workflow engine.

## Scope

This package is deliberately minimal:
- No DAG / workflow logic
- No git / GitHub / PR operations
- No configuration file parsing
- No domain-specific logic

Runtime-specific stream parsers, session openers, and HITL MCP handlers
are available via sub-path exports (`./claude/stream`, `./opencode/session`,
`./cursor/session`, `./codex/app-server`, etc.) for callers that need
typed access beyond the neutral `RuntimeAdapter` / `RuntimeSession`
interfaces.
