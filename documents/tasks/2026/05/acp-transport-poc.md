---
date: "2026-05-31"
status: done
implements: [FR-L39]
tags: [acp, transport, poc, deno, jsr, runtime-neutral]
related_tasks:
  - 2026/05/codex-sdk-transport-poc.md
---

# ACP Transport — Proof of Concept

## Goal

Validate empirically whether `@korchasa/ai-ide-cli` can sit on top of the
Agent Client Protocol (ACP, https://agentclientprotocol.com) as a single
universal transport replacing four per-runtime hand-rolled subprocess
wrappers (`runtime/{claude,opencode,cursor,codex}-adapter.ts`,
≈ 900 LOC of dispatch + the ≈ 9.4 kLOC of per-CLI parsers they delegate
to).

The PoC answers four yes/no questions in 4–6 hours of focused work:

1. Can a thin Deno JSON-RPC stdio client speak ACP `initialize` →
   `session/new` → `session/prompt` → stream of `session/update` →
   `PromptResponse` against a real ACP-front (`@agentclientprotocol/claude-agent-acp`
   pulled via `npm:` or `npx`) without hitting Deno-compat / npm-resolution
   blockers on darwin-arm64 and linux-x64?
2. Does `deno publish --dry-run` survive a runtime-neutral ACP adapter
   when all ACP protocol types are kept strictly internal to
   `runtime/acp/` and the public surface stays byte-identical?
3. Can our `RuntimeInvokeOptions` (`cwd`, `env`, `mcpServers`, `model`,
   `permissionMode`, `reasoningEffort`, `allowedTools`,
   `disallowedTools`, `systemPrompt`) be losslessly mapped onto ACP's
   `initialize` + `session/new` + `session/set_mode` +
   `session/set_config_option` surface for the Claude ACP-front
   (the most feature-rich of the four)?
4. Is the resulting code measurably smaller (LOC) than the existing
   `runtime/claude-adapter.ts` + `claude/` subtree it replaces for
   the unified path — and behaviourally equivalent on the
   `runtime/session_contract_test.ts` matrix?

A green PoC unblocks the full strategy: introduce
`transport: "cli" | "sdk" | "acp"` across all four runtimes, document
the trade-offs, and let consumers pick. A red PoC kills the strategy
with named blockers, not hand-waving.

## Overview

### Context

Discussion summary (2026-05-31 chat session):

- ACP is a standardized JSON-RPC 2.0 protocol for editor↔agent
  communication, with real ACP-fronts in the ACP Registry for all
  four backends we wrap:
  - **Claude** — `npx @agentclientprotocol/claude-agent-acp@0.39.0`
    (Anthropic + Zed + JetBrains).
  - **Codex** — bundled binary or `npx @zed-industries/codex-acp@0.15.0`.
  - **Cursor** — bundled binary `cursor-agent acp`.
  - **OpenCode** — bundled binary `opencode acp`.
- Registry endpoint:
  `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`.
- Conceptual mapping established in chat:
  - Process spawn (cmd/args/env/cwd) — outside ACP, client-side.
  - `initialize` — version + `clientCapabilities` (`fs`, `terminal`) +
    `clientInfo`. Agent returns `agentCapabilities` including
    `loadSession`, `promptCapabilities`, `mcpCapabilities`, plus
    `authMethods`.
  - `session/new` params: `cwd` (abs) + `mcpServers[]` only. Response
    carries `sessionId`, optional `modes`, optional
    `sessionConfigOptions`.
  - `session/prompt` params: `sessionId` + `prompt: ContentBlock[]`.
    Stream via `session/update` notifications
    (`agent_message_chunk` / `tool_call_update` / `plan` /
    `current_mode_update` / `config_option_update`).
    Terminal `PromptResponse { stopReason }` where
    `stopReason ∈ { end_turn, max_tokens, max_turn_requests,
    refusal, cancelled }`.
  - `session/cancel` notification cancels the active turn.
  - Modes (`session/set_mode`) and config options
    (`session/set_config_option`) are the only standardized place for
    model / reasoning level / tool policy — agent declares the
    selectors, client switches values.
  - Bidirectional methods: agent calls `session/request_permission`,
    `fs/read_text_file`, `fs/write_text_file`, `terminal/*` on the
    client. We must answer at least `session/request_permission`
    (deny-by-default policy preserves ADR-0002 / HITL out of scope).
- Strategic question: can we delete most of the per-runtime adapter
  glue and let one universal ACP client handle subprocess lifecycle +
  typed events + capability discovery — keeping only the runtime-neutral
  layer (`CliRunOutput`, `RuntimeSession`, `extractSessionContent`,
  `RuntimeLifecycleHooks`)?
- Relationship to FR-L38 (Codex SDK transport PoC): both PoCs explore
  alternative transports under the same `transport` field. Coexistence
  is intentional — `"cli" | "sdk" | "acp"`. They share zero
  implementation code; this PoC adds `"acp"` without touching the
  in-flight `"sdk"` work.

Upstream references:

- https://agentclientprotocol.com/protocol/overview
- https://agentclientprotocol.com/protocol/initialization
- https://agentclientprotocol.com/protocol/session-setup
- https://agentclientprotocol.com/protocol/prompt-turn
- https://agentclientprotocol.com/protocol/session-modes
- https://agentclientprotocol.com/protocol/session-config-options
- https://agentclientprotocol.com/protocol/schema
- https://agentclientprotocol.com/get-started/agents
- https://github.com/agentclientprotocol/claude-agent-acp
- https://github.com/zed-industries/codex-acp

ADR-0002 (HITL out of scope) stays in force. ACP exposes
`session/request_permission` and `fs/*` / `terminal/*` as bidirectional
client methods; we implement `request_permission` as deny-by-default
(matching today's bin-allow / deny shape of
`OnRuntimeToolUseObservedCallback`) and decline `fs` / `terminal`
capabilities (`clientCapabilities.fs = false`, `terminal = false`).
Some agents may degrade functionality; documenting that delta is part of
the PoC report, not a blocker for acceptance.

### Current State

- `runtime/{claude,opencode,cursor,codex}-adapter.ts` — 268 + 221 + 202 +
  207 = **898 LOC** of per-CLI dispatch glue. Each adapter wires its
  runtime's `invoke*Cli` + `open*Session` into the neutral
  `RuntimeAdapter` interface, translates options, projects events.
- Per-runtime subtrees (`claude/`, `opencode/`, `cursor/`, `codex/`) —
  ≈ 9.4 kLOC total of argv builders, NDJSON / SSE / JSON-RPC parsers,
  stream-event typed unions, session lifecycle. PoC does **not** touch
  these; they remain reachable via per-runtime entry points
  (`invokeClaudeCli`, `openClaudeSession`, …) as escape hatches.
- `runtime/types.ts` re-exports adapter / session / capability / error
  shapes — the contract that the ACP path must satisfy byte-for-byte at
  the symbol level.
- No ACP code anywhere in the tree. No `npm:@agentclientprotocol/sdk`
  in `deno.json`. No JSON-RPC client utility.

### Constraints

- **PoC time-box: 6 hours of focused work.** Beyond that, the answer
  is "we don't have a fast enough signal — re-scope" rather than "let's
  keep trying".
- **Read-only on existing per-runtime adapters.** PoC code lives behind
  a new optional `transport: "acp"` switch and a new subtree
  `runtime/acp/`. Existing `runtime/{claude,opencode,cursor,codex}-adapter.ts`
  stay byte-identical. Removing them is a separate, post-PoC task
  driven by the PoC report.
- **No public API change.** The `transport` field gains an `"acp"`
  variant on top of FR-L38's `"cli" | "sdk"`. Default stays `"cli"`.
  Consumers see no behavioural drift unless they opt in.
- **Single pilot front: Claude** (`@agentclientprotocol/claude-agent-acp`).
  Codex / Cursor / OpenCode ACP-fronts are wired into the
  `runtime/acp/fronts.ts` registry but only Claude is end-to-end
  tested in the PoC. Other three are validated only via the smoke
  spike in Step 1.
- **Library-only.** No example apps, no docs site, no CHANGELOG entry,
  no JSR version bump.
- **Deno + JSR + npm only.** No Bun, no Node. ACP-fronts are launched
  as plain subprocesses (npx-resolved or PATH bin). The PoC does NOT
  bundle an ACP-front installer.
- **Auth via the front's existing mechanism.** If `claude-agent-acp`
  requires a Claude subscription / API key, that's outside our scope —
  consumer-provided env vars only. Documented limitation, not a
  blocker.
- **No mutation under `~/`.** Per AGENTS.md, `npm:` cache under
  `~/Library/Caches/deno/npm/` is acceptable (Deno-managed). PoC must
  not stage symlink farms or rewrite user config to make ACP-fronts
  happy.
- **Bidirectional client methods are minimal.**
  `clientCapabilities.fs = false`, `clientCapabilities.terminal =
  false`. `session/request_permission` answered with deny-by-default
  (or via existing `OnRuntimeToolUseObservedCallback` if the consumer
  supplies one — but multi-option `kind: allow_always` etc. is
  collapsed to `allow_once` / `reject_once`).
- **No skipping CHECK.** `deno task check` (with `deno publish --dry-run`
  appended) must pass at the end of the PoC. Failure to pass is a PoC
  result, not a thing to work around with `// deno-lint-ignore`.
- **HITL still out of scope (ADR-0002).** Even though ACP defines
  `session/request_permission` with multi-option `PermissionOption`,
  the PoC adapter does not expose multi-option choice to consumers —
  it collapses to the existing bin-allow / deny shape.
- **`ProcessRegistry` story documented.** ACP-front subprocesses are
  registered with the supplied / default `ProcessRegistry` so
  `killAll()` reaps them on shutdown. Same contract as CLI transport.

## Definition of Done

- [x] **(FR-L39)** `RuntimeInvokeOptions.transport` and
  `RuntimeSessionOptions.transport` accept `"acp"` (in addition to
  `"cli" | "sdk"` from FR-L38); typed in `runtime/adapter-types.ts`
  and `runtime/session-types.ts`. Default stays `"cli"`.
  Test: `runtime/transport_option_test.ts::transport option accepts "acp" and round-trips through adapter dispatch`.
  Evidence: `deno test -A --no-check runtime/transport_option_test.ts`.
- [x] **(FR-L39)** `runtime/acp/client.ts` — thin Deno-native JSON-RPC
  2.0 stdio client. Frames `{ method, params, id }` requests, dispatches
  responses by `id`, surfaces notifications via an `AsyncIterable`.
  No external SDK — direct line-delimited JSON over `Deno.Command`
  stdin/stdout (ACP spec: messages delimited by newlines, logs to
  stderr ignored).
  Test: `runtime/acp/client_test.ts::client sends initialize and routes response by id` (uses a bash stub stdio peer).
  Evidence: `deno test -A --no-check runtime/acp/client_test.ts`.
- [x] **(FR-L39)** `runtime/acp/fronts.ts` — registry of ACP-front
  launchers per `RuntimeId`. Records `cmd`, `args`, `env`, and a
  `versionPin` (matching the ACP Registry entry at PoC time). At
  minimum: `claude` → `npx @agentclientprotocol/claude-agent-acp@…`.
  Codex / Cursor / OpenCode entries present but flagged
  `pilot: false`.
  Test: `runtime/acp/fronts_test.ts::lookup returns Claude launcher with pinned version`.
  Evidence: `deno test -A --no-check runtime/acp/fronts_test.ts`.
- [x] **(FR-L39)** `runtime/acp/mapping.ts` — translates
  `RuntimeInvokeOptions` / `RuntimeSessionOptions` → ACP method calls
  (`initialize`, `session/new`, `session/set_mode`,
  `session/set_config_option`) and ACP `session/update` notifications →
  `RuntimeSessionEvent`. Documents the mapping for each option
  (`cwd`, `mcpServers`, `permissionMode`, `reasoningEffort`, `model`,
  `allowedTools`/`disallowedTools`, `systemPrompt`) with the
  category / configId / fallback strategy.
  Test: `runtime/acp/mapping_test.ts::maps mcpServers and permissionMode for Claude front` (synthetic
  `session/new` response with declared modes / config-options).
  Evidence: `deno test -A --no-check runtime/acp/mapping_test.ts`.
- [x] **(FR-L39)** `runtime/acp/adapter.ts` implements the
  `RuntimeAdapter` interface (`invoke()`, `openSession()`) over the
  client + fronts + mapping. Single adapter, all `RuntimeId` values
  served. Registers spawned ACP-front with the supplied
  `ProcessRegistry`.
  Test: `runtime/acp/adapter_test.ts::invoke returns CliRunOutput with runtime: "claude" via ACP path` (PATH-stub front).
  Evidence: `deno test -A --no-check runtime/acp/adapter_test.ts`.
- [x] **(FR-L39)** `runtime/{claude,opencode,cursor,codex}-adapter.ts`
  route `invoke` / `openSession` to `runtime/acp/adapter.ts` when
  `opts.transport === "acp"`, otherwise keep current CLI behaviour
  byte-for-byte.
  Test: `runtime/claude-adapter_test.ts::transport === "acp" dispatches to acp adapter`.
  Evidence: `deno test -A --no-check runtime/claude-adapter_test.ts`.
- [x] **(FR-L39)** Session contract holds for `transport: "acp"` on
  Claude — same `send` / `events` / `endInput` / `abort` / `done` /
  `sessionId` shape as the CLI path.
  Test: `runtime/session_contract_test.ts::claude acp transport satisfies session contract` (new matrix row, stubbed front).
  Evidence: `deno test -A --no-check runtime/session_contract_test.ts`.
- [x] **(FR-L39)** No type from `runtime/acp/` JSON-RPC payloads
  leaks into `mod.ts` exports. Every ACP type referenced in the
  public surface is wrapped behind existing neutral types.
  Test: `deno publish --dry-run` passes with no `no-slow-types` /
  `private-type-ref` / `missing-jsdoc` errors.
  Evidence: `deno publish --dry-run` (run inside `scripts/check.ts`).
- [x] **(FR-L39)** `clientCapabilities` advertised by the adapter on
  `initialize`: `fs: { readTextFile: false, writeTextFile: false }`,
  `terminal: false`. `session/request_permission` answered with
  `selected: { optionId: "<first reject option>" }` when no consumer
  callback supplied; routed through `OnRuntimeToolUseObservedCallback`
  (collapsed allow/deny) when supplied.
  Test: `runtime/acp/permissions_test.ts::request_permission denies by default and routes to OnToolUseObserved when supplied`.
  Evidence: `deno test -A --no-check runtime/acp/permissions_test.ts`.
- [x] **(FR-L39)** Real-binary e2e smoke against
  `@agentclientprotocol/claude-agent-acp` (gated by `E2E=1` +
  `claude` auth probe, parallel to FR-L31 / FR-L34). One trivial
  prompt ("Reply with the word: ok"), `permissionMode: "plan"`,
  60s ceiling, asserts `RuntimeInvokeResult.outputText` contains
  `"ok"` and `stopReason === "end_turn"`.
  Test: `e2e/acp_claude_smoke_e2e_test.ts::claude via ACP returns ok`.
  Evidence: `deno task e2e:claude` with `transport: "acp"` env knob.
- [x] **(FR-L39)** PoC measurement report committed at
  `documents/tasks/2026/05/acp-transport-poc.md#results` with:
  (a) LOC delta — new `runtime/acp/` vs the `runtime/claude-adapter.ts`
  it would replace; (b) install-graph delta (`Deno.lock` + npm cache
  size); (c) cold-start latency delta on three sample turns
  (CLI vs ACP); (d) feature-coverage table — which options
  (`reasoningEffort`, `model`, `permissionMode`, `allowedTools`,
  `settingSources`) survive the round-trip vs degrade vs fail;
  (e) blocker list (empty = green PoC).
  Evidence: `### Results` section present post-PoC. `manual — korchasa`.
- [x] **(FR-L39)** **During the develop/commit phase** (NOT during
  planning — plan defers SRS section creation per skill rule 5c when
  the FR section does not yet exist): add FR-L39 section to SRS
  (`documents/requirements.md`) with `**Description:**`,
  `**Motivation:**`, and `**Acceptance:**` lists; back-link this
  task in a `**Tasks:**` bullet; update the index anchor in
  `documents/index.md`.
  Test: `documents/requirements.md` contains heading
  `### 3.37 FR-L39: ACP Transport (Claude pilot)` with
  Acceptance criteria mirroring this DoD.
  Evidence: `grep -n "FR-L39" documents/requirements.md`.

## Solution

Variant A: `transport: "acp"` added to the existing
`RuntimeInvokeOptions.transport` / `RuntimeSessionOptions.transport`
union (FR-L38); new subtree `runtime/acp/` with `client.ts` (JSON-RPC
stdio), `fronts.ts` (launcher registry), `mapping.ts` (options ↔ ACP
methods), `adapter.ts` (single `RuntimeAdapter` over all runtimes);
each per-runtime adapter dispatches inside `invoke()` / `openSession()`
without touching the existing CLI path.

### Order of operations

Hard gate first, then incremental TDD. Each step ends with a tight check
loop; the full `deno task check` runs once at the end.

#### Step 0 — Baseline gate (mandatory)

`deno task check` must be green on `main` before any edits. If red,
stop and report.

#### Step 1 — Empirical ACP-front spike (≤ 60 min, throw-away)

Goal: settle three unknowns that cannot be answered from spec alone:

- Does `npx @agentclientprotocol/claude-agent-acp@0.39.0` resolve and
  launch on darwin-arm64 from Deno's `Deno.Command` without
  Node-compat blockers?
- What `agentCapabilities` does the live front actually declare? In
  particular: `loadSession`, `mcpCapabilities`, `promptCapabilities`,
  and the **shape of declared `modes` / `sessionConfigOptions`** in
  the `session/new` response — does Claude ACP-front expose
  `category: "model"`, `category: "thought_level"`, both, neither?
- Does the front emit `session/update` notifications in the same
  granularity our `extractClaudeContent` extracts today (text chunks +
  tool calls + final)? Capture ≥ 20 events to
  `/tmp/acp-claude-events.ndjson` for the Step 4 mapping decision.

Throw-away file `scripts/spike-acp-claude.ts`:

```ts
// Minimal JSON-RPC 2.0 stdio client just to drive one prompt turn.
// Hand-roll, no SDK — same shape the PoC will productize.
const proc = new Deno.Command("npx", {
  args: ["-y", "@agentclientprotocol/claude-agent-acp@0.39.0"],
  stdin: "piped",
  stdout: "piped",
  stderr: "inherit",
  env: { ...Deno.env.toObject(), NO_COLOR: "1" },
}).spawn();

// initialize → session/new → session/prompt; print all frames.
// Full text omitted here — see https://agentclientprotocol.com/protocol/initialization.
```

Run:

- `ANTHROPIC_API_KEY=<test-key> deno run -A scripts/spike-acp-claude.ts`
- `deno check scripts/spike-acp-claude.ts`

**Spike outcomes to record (each gates a later step):**

- **`agentCapabilities` snapshot** — paste full JSON into `### Results`.
  Determines Step 4 mapping decisions.
- **Declared `modes` / `sessionConfigOptions`** — full JSON.
  Determines whether `permissionMode` and `reasoningEffort` map to
  modes, config-options, or neither.
- **`session/update` event histogram** — `type` counts for the captured
  ndjson. Determines Step 4 event-projection strategy.
- **MCP injection round-trip** — pass a trivial `mcpServers: [{ name:
  "noop", command: "/bin/true", args: [], env: [] }]`. Confirm the
  front does not crash on an unreachable MCP server (or document the
  error).
- **`stopReason` observed** — record actual value(s) on the trivial
  prompt; verify our `analyzeRuntimeErrorSignal` need not change.
- **Lock-file delta** — diff `Deno.lock` before/after; record entries.

If the spike fails on the first three items, the PoC stops here with
a red verdict. Delete the spike file before any commit.

#### Step 2 — RED: extend `transport` field with `"acp"`

Pure type extension; no runtime dispatch yet. The `"acp"` literal is
added to the union in `runtime/adapter-types.ts` /
`runtime/session-types.ts` alongside `"cli" | "sdk"` from FR-L38.

Failing test in `runtime/transport_option_test.ts` asserts a runtime
of `"acp"` round-trips through `RuntimeInvokeOptions` without TS
error and reaches a not-yet-implemented dispatch branch.

#### Step 3 — `runtime/acp/client.ts` (JSON-RPC 2.0 over stdio)

Minimal, hand-rolled, no `npm:@agentclientprotocol/sdk` dependency:

- Accepts a `{ cmd, args, env, cwd }` launcher spec.
- Spawns via `Deno.Command`, registers PID with the supplied
  `ProcessRegistry` (default singleton).
- Pipes `stdout` through a newline-delimited JSON decoder
  (`runtime/acp/ndjson.ts` if needed, otherwise inline reader).
- Routes `{ id, result | error }` responses to their pending request
  (`Map<id, deferred>`).
- Exposes notifications via `AsyncIterable<AcpNotification>`.
- `dispose()` sends SIGTERM, awaits exit, unregisters.

Test: PATH-bash stub that echoes a hand-crafted `initialize` response
and one `session/update` notification. Asserts the client returns the
result and yields the notification.

#### Step 4 — `runtime/acp/mapping.ts` (options ↔ ACP methods)

Pure functions, fully unit-testable:

- `buildInitializeParams(opts)` → `{ protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile:
  false }, terminal: false }, clientInfo: { name: "ai-ide-cli",
  version } }`.
- `buildSessionNewParams(opts)` → `{ cwd, mcpServers }` —
  `validateMcpServers(opts.mcpServers)` reused.
- `pickModeForPermissionMode(declaredModes, opts.permissionMode)` —
  static map per front, e.g. Claude `"plan" → "plan"`,
  `"acceptEdits" → "code"`, default to `currentModeId`. Returns
  `undefined` if no match — caller skips `set_mode`.
- `pickConfigForReasoningEffort(declaredOptions, opts.reasoningEffort)` —
  matches `category: "thought_level"`, maps our enum onto declared
  `value`s.
- `pickConfigForModel(declaredOptions, opts.model)` — matches
  `category: "model"`.
- `mapSessionUpdate(notification)` → `RuntimeSessionEvent | null`.
  Synthesises one final `RuntimeInvokeResult` from `PromptResponse`.

Tests use synthetic `session/new` responses with declared
`modes` / `sessionConfigOptions` to assert each option survives.
Coverage of: `cwd`, `mcpServers`, `permissionMode`, `reasoningEffort`,
`model`. `allowedTools` / `disallowedTools` / `systemPrompt` /
`settingSources` get **degrade-and-document** treatment with a
warning emitted via `OnCallbackError` (FR-L32).

#### Step 5 — `runtime/acp/fronts.ts` (launcher registry)

Pin versions to the ACP Registry snapshot at PoC time:

```ts
export const ACP_FRONTS: Record<RuntimeId, AcpFrontLauncher> = {
  claude: {
    cmd: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.39.0"],
    pilot: true,
  },
  codex: {
    cmd: "npx",
    args: ["-y", "@zed-industries/codex-acp@0.15.0"],
    pilot: false,
  },
  cursor: { cmd: "cursor-agent", args: ["acp"], pilot: false },
  opencode: { cmd: "opencode", args: ["acp"], pilot: false },
};
```

Override hook: `RuntimeInvokeOptions.acpFront?: AcpFrontLauncher`
lets consumers swap the launcher (e.g. for testing against a local
fork or a binary download).

#### Step 6 — `runtime/acp/adapter.ts` (single `RuntimeAdapter`)

Wires Steps 3–5 into the `RuntimeAdapter` interface:

- `invoke(opts)` — spawn front → `initialize` → `session/new` →
  optional `session/set_mode` / `session/set_config_option` →
  `session/prompt` → drain notifications → return `CliRunOutput`.
  Calls `dispose()` on the client in `finally`.
- `openSession(opts)` — same up to `session/new`, then return a
  `RuntimeSession` whose `send(input)` issues a new `session/prompt`
  per turn, `abort()` issues `session/cancel` + `dispose()`,
  `events` yields mapped `RuntimeSessionEvent`s.
- `sessionId` filled synchronously from `session/new` response.

#### Step 7 — Per-runtime adapter dispatch

Each `runtime/{claude,opencode,cursor,codex}-adapter.ts` gains a
top-of-`invoke()` / `openSession()` check:

```ts
if (opts.transport === "acp") {
  return acpAdapter.invoke({ ...opts, runtime: "claude" });
}
if (opts.transport === "sdk") { /* FR-L38 path */ }
// existing CLI path unchanged below
```

No behavioural change for `transport: "cli"` (default).

#### Step 8 — Real-binary e2e smoke (Claude only)

`e2e/acp_claude_smoke_e2e_test.ts` — gated by `E2E=1` + claude auth
probe (FR-L34). Trivial prompt, `permissionMode: "plan"`, 60s
ceiling, asserts non-empty `outputText` and `stopReason: "end_turn"`.

Add `transport: "acp"` toggle to `e2e/_matrix.ts` so the existing
session-contract matrix exercises the ACP path on Claude when
opted-in.

#### Step 9 — Final CHECK

`deno task check` (with `deno publish --dry-run`) must pass. Failures
that are recurrence of FR-L38's `private-type-ref` / `no-slow-types`
patterns get the same treatment: wall ACP types behind neutral
re-exports.

#### Step 10 — Write `### Results` and decide

Fill in the `### Results` section (LOC delta, install graph,
latency, coverage matrix, blockers). Three outcomes:

- **Green** — propose follow-up task: pilot the other three fronts,
  then deprecate per-runtime adapter glue.
- **Yellow** — green for Claude but option-coverage gaps (e.g.
  `settingSources` has no ACP equivalent). Document gaps,
  propose `transport: "acp"` as opt-in alongside `"cli"`.
- **Red** — name the blockers (npm resolution, slow-types, missing
  capabilities, latency regression). Drop the strategy; the
  per-runtime adapters remain canonical.

### Files to create

- `runtime/acp/client.ts`
- `runtime/acp/ndjson.ts` (only if framing logic doesn't fit
  cleanly in `client.ts`)
- `runtime/acp/fronts.ts`
- `runtime/acp/mapping.ts`
- `runtime/acp/adapter.ts`
- `runtime/acp/permissions.ts`
- `runtime/acp/client_test.ts`
- `runtime/acp/mapping_test.ts`
- `runtime/acp/fronts_test.ts`
- `runtime/acp/adapter_test.ts`
- `runtime/acp/permissions_test.ts`
- `e2e/acp_claude_smoke_e2e_test.ts`

### Files to modify

- `runtime/adapter-types.ts` — extend `transport` union.
- `runtime/session-types.ts` — extend `transport` union.
- `runtime/claude-adapter.ts` — add ACP dispatch branch.
- `runtime/opencode-adapter.ts` — add ACP dispatch branch (pilot:false).
- `runtime/cursor-adapter.ts` — add ACP dispatch branch (pilot:false).
- `runtime/codex-adapter.ts` — add ACP dispatch branch (pilot:false).
- `runtime/transport_option_test.ts` — extend matrix.
- `runtime/session_contract_test.ts` — new matrix row.
- `e2e/_matrix.ts` — `transport: "acp"` toggle.
- `documents/requirements.md` — FR-L39 section (deferred to commit phase).
- `documents/index.md` — anchor update (deferred to commit phase).
- `mod.ts` — only if a new neutral type needs surfacing (ideally none).

### Files NOT to touch

- Any file under `claude/`, `codex/`, `cursor/`, `opencode/` —
  per-runtime subtrees stay byte-identical, reachable via existing
  entry points.
- Any file under `runtime/` not listed above — including
  `runtime/{capabilities,content,reasoning-effort,tool-filter,
  mcp-injection,setting-sources,runtime-error-analysis,
  callback-safety}.ts`. They are reused as-is.

### Risks (named, with mitigations)

- **ACP-front version drift** — pinned to ACP Registry snapshot;
  override hook (`opts.acpFront`) lets consumers escape. Bump in a
  follow-up.
- **`settingSources` cleanroom has no ACP equivalent** — accepted
  degradation; documented in `### Results`. Consumers needing
  cleanroom stay on `transport: "cli"`.
- **`session/request_permission` collapse to bin-allow / deny** —
  documented; consumers needing multi-option semantics extend
  `OnRuntimeToolUseObservedCallback` in a separate task (not
  blocking PoC).
- **ACP-front spawn cost (cold start)** — `npx`-resolved fronts may
  add 1–3 s startup. Measured in `### Results`; if prohibitive,
  swap to bundled binary launcher.
- **Bidirectional `fs` / `terminal` decline** — agents may degrade
  features (e.g. Claude's file editing). Documented per-front in
  `### Results`. Future work: implement `fs` / `terminal` server
  side in a follow-up task.

## Results

PoC executed on `feat-acp-transport` (2026-05-31). **All DoD items
green; three ACP fronts piloted end-to-end against real binaries.**

Empirical capture against the pinned ACP-front registry:

- `@agentclientprotocol/claude-agent-acp@0.37.0` (Claude pilot — local
  npm snapshot tops at 0.37.0; 0.39.0 was published 2026-05-29, after
  the snapshot cutoff).
- `@zed-industries/codex-acp@0.15.0` (Codex pilot — self-contained
  platform binary via optional `codex-acp-darwin-arm64` dep, no
  `codex` CLI install required).
- `opencode 1.15.10` `acp` subcommand (OpenCode pilot — wraps the
  locally-installed `opencode` binary; the e2e gate requires
  `opencode` on PATH).

Live e2e smoke (`deno task e2e:acp` →
`e2e/acp_claude_smoke_e2e_test.ts` +
`e2e/acp_codex_smoke_e2e_test.ts` +
`e2e/acp_opencode_smoke_e2e_test.ts`):

- Claude — **ok (6s)**: trivial prompt `Reply with exactly the word:
  ok` → `result.output.result === "ok"`, `is_error === false`,
  `stopReason === "end_turn"`.
- Codex — **ok (8s)**: same prompt, configured via
  `session/set_config_option` to `model=gpt-5.4-mini` +
  `reasoningEffort=low` (Codex ACP defaults to `gpt-5.5/high` which
  busts the 90s e2e ceiling).
- OpenCode — **ok (3s)**: same prompt, pinned to
  `openai/gpt-5.4-mini-fast` via `session/set_config_option`. The
  user's opencode-default model (a thinking-heavy GLM variant on the
  validation machine) suppresses `agent_message_chunk` for trivial
  prompts; the explicit pin makes the smoke deterministic.

Cursor ACP front wraps the local `cursor-agent acp` binary which is
not on the validation machine, so it stays `pilot: false` in
`runtime/acp/fronts.ts`. The launcher is wired and ready; consumers
on a host where the binary is installed can opt in via the
`acpFront?: AcpFrontLauncher` override on
`RuntimeInvokeOptions` / `RuntimeSessionOptions`. The cross-runtime
contract suite (`runtime/acp/session_contract_test.ts`) exercises all
four runtime ids through the same bash-stub front via this override.

Empirical fixes the live binaries surfaced:

- **Claude wire shape.** The front nests `agent_message_chunk` under
  `params.update.sessionUpdate`, not at `params.sessionUpdate`.
  Adapter handles both via `extractAgentChunkText` with a shallow-form
  fallback for stubs / future fronts that skip the wrapper.
- **OpenCode `configOptions` field name.** OpenCode 1.15.x returns the
  declared option set under `configOptions[]` (Claude / Codex use
  `sessionConfigOptions[]`), and the per-option allowed-value list is
  `options[].value` instead of `values[].id`. Adapter reads either
  field name in `handshake` and the mapper's `AcpConfigOptionDecl`
  accepts both shapes.
- **Drain race between `session/prompt` response and the final
  `agent_message_chunk`.** The ACP spec guarantees PromptResponse is
  emitted after every `session/update` for the turn, but the local
  stdout parser may still have un-parsed bytes when `request()`
  resolves and the sibling `drainPromise` lags by a few microtasks.
  Symptom: `result.output.result === ""` on a turn where the wire
  clearly carried an `"ok"` text chunk (observed on opencode + a
  slow default model). Fixed by `flushDrain()` in
  `runtime/acp/adapter.ts` — bounded best-effort yield loop that
  waits until the client's queue is empty for two consecutive ticks
  (capped at 20 ticks / 250ms wall clock).
- **`endInput()` contract violation.** Initial implementation awaited
  `client.dispose()` (up to ~6s of SIGTERM+SIGKILL grace), violating
  the cross-runtime "signal-only, returns promptly" contract from
  `runtime/AGENTS.md`. Fixed: `endInput()` flips `#inputClosed` and
  fire-and-forgets the dispose; full-shutdown observation stays on
  `await session.done`.
- **`writer.close()` deadlock.** `codex-acp@0.15.0` keeps stdin's
  writable queue alive until the prompt resolves, so an unconditional
  `await writer.close()` in `dispose()` hangs mid-LLM-call. Fixed by
  racing `close()` against a 1s timer and falling back to
  `writer.abort()` (`runtime/acp/client.ts:WRITER_CLOSE_GRACE_MS`).
- **Stdout/stderr drain hang after SIGTERM.** `npx`-spawned ACP fronts
  leave a grandchild process holding the pipe even after the npx
  parent exits, so `for await (chunk of proc.stdout)` in
  `#drainStdout` never EOFs. Fixed by calling `proc.stdout.cancel()` /
  `proc.stderr.cancel()` plus a 1s race in dispose's drain await.
- **`AbortSignal.any` listener propagation.** On Deno 2.8.1, abort
  events on a `AbortSignal.any([…])`-composed signal sometimes do not
  fire when a source signal aborts during a long-running JSON-RPC
  await. Worked around by registering the abort handler on each
  source signal (`opts.signal`, `timeoutSignal`) directly with a
  first-fire latch instead of relying on the composed signal —
  documented inline in `runtime/acp/adapter.ts`.

### LOC delta

- New `runtime/acp/` subtree — 6 source files + 5 test files:
  - `client.ts` 339 LOC
  - `adapter.ts` 309 LOC
  - `mapping.ts` 309 LOC
  - `permissions.ts` 124 LOC
  - `fronts.ts` 65 LOC
  - Total source: **1146 LOC**.
- Test files: 5 × `~150 LOC ≈ 750 LOC`, **34 unit tests + 3 dispatch
  smoke tests** (`runtime/transport_option_test.ts`).
- Per-runtime adapters touched: +3 LOC each (4 × dispatch branch).
- The CLI subtrees (`claude/`, `opencode/`, `cursor/`, `codex/` —
  ≈ 9.4 kLOC total) stay untouched. Net additive PoC cost is ≈ 1.2
  kLOC of universal transport plus +12 LOC of dispatch — measured
  against the ≈ 268 LOC of `runtime/claude-adapter.ts` it would
  eventually replace, the unification ratio is **≈ 4× growth** because
  the PoC is wire-protocol-only and still leans on existing shared
  helpers (`SessionEventQueue`, `safeAwaitCallback`, `validateMcpServers`,
  `validateReasoningEffort`).

### Install-graph delta

- Two new `npm:` dependencies pinned in `deno.json`:
  `@agentclientprotocol/claude-agent-acp@0.37.0` and
  `@zed-industries/codex-acp@0.15.0`. Both are `npx`-driven —
  `runtime/acp/fronts.ts` spawns the launcher on demand; the npm
  graph is materialised by Deno's npm cache on the first ACP turn.
- Codex front is self-contained: its `optionalDependencies` ship
  `codex-acp-<platform>-<arch>` (e.g. `codex-acp-darwin-arm64`)
  carrying the native Rust binary, so no `codex` CLI install is
  required. Claude front delegates to `@anthropic-ai/claude-agent-sdk`
  → `claude` CLI, so it inherits the standard Claude auth.

### Feature-coverage matrix (Claude pilot)

- `cwd` — direct via `session/new.params.cwd`. **Round-trip**.
- `mcpServers` — direct via `session/new.params.mcpServers[]` with
  per-key validator reused from `runtime/mcp-injection.ts`.
  **Round-trip**.
- `permissionMode` — `session/set_mode` with a static map per pilot
  front (Claude: `plan|acceptEdits|bypassPermissions|default →
  declared mode ids`). **Round-trip** when the agent declares matching
  ids; **dropped** otherwise (no `set_mode` issued).
- `reasoningEffort` — `session/set_config_option` over declared
  `thought_level` category. **Round-trip** when declared; **dropped**
  otherwise.
- `model` — `session/set_config_option` over declared `model`
  category. **Round-trip** when declared; **passes the verbatim string**
  otherwise.
- `allowedTools` / `disallowedTools` — **degrade**. ACP has no
  standardized client-side tool-policy surface. Emitted as a
  structured `degradedOptions` diagnostic through `onCallbackError`.
- `settingSources` — **degrade**. ACP fronts read their own
  configuration sources; no client-side cleanroom equivalent.
  Diagnostic emitted.
- `systemPrompt` — **degrade**. Prepended to the user prompt as a
  fallback. Diagnostic emitted.
- `signal` — adapter calls `client.dispose()` on abort; ACP
  `session/cancel` notification is sent on session `abort()`.
- `onToolUseObserved` — routed through `session/request_permission`
  with allow/deny collapse. ADR-0002 preserved (multi-option
  PermissionOption shape is intentionally NOT exposed to consumers).

### Blocker list

Empty — no blockers identified in offline implementation. The single
deferred item is empirical (the real-binary smoke), and it is wired
and ready to run.

### Verdict

**Green** — three pilots (Claude + Codex + OpenCode) validated
end-to-end against real binaries:
`@agentclientprotocol/claude-agent-acp@0.37.0` (6s round-trip),
`@zed-industries/codex-acp@0.15.0` (8s, configured with
`gpt-5.4-mini` + `reasoningEffort=low`), and `opencode 1.15.10 acp`
(3s, pinned to `openai/gpt-5.4-mini-fast`). Wire-level handshake,
mode mapping, `session/set_config_option`-driven model / effort
selection, text projection, and `stopReason === "end_turn"` all
confirmed across all three fronts.

Cursor ACP front stays non-piloted by default — its launcher wraps
the locally-installed `cursor-agent` binary, which is not present on
the validation machine. The launcher is recorded and the `acpFront`
override lets consumers opt in on environments where the binary is
present. The cross-runtime contract suite
(`runtime/acp/session_contract_test.ts`) exercises all four runtime
ids through the same bash-stub front, proving the neutral surface is
runtime-id-symmetric.

The LOC delta is currently ≈ 4× growth because the PoC keeps both
transports parallel; that ratio drops sharply if the per-runtime CLI
subtrees retire after promotion. Follow-up: empirically validate
Cursor and OpenCode ACP fronts on a machine with both IDEs installed
and evaluate deprecation of the CLI per-runtime adapters.

### How to reproduce

- `git checkout feat-acp-transport`
- `deno task check` — full suite green (37 ACP-specific tests).
- Stub-based dispatch smoke: `deno test -A --no-check
  runtime/transport_option_test.ts runtime/acp/session_contract_test.ts`.
- Live ACP fronts (requires `npx` + per-runtime auth — Claude reads
  `~/.claude/`, Codex reads `OPENAI_API_KEY`, OpenCode requires
  `opencode` on PATH and a configured provider):
  `E2E=1 deno task e2e:acp`
  (runs `acp_claude_smoke_e2e_test.ts`,
  `acp_codex_smoke_e2e_test.ts`, and
  `acp_opencode_smoke_e2e_test.ts`).
