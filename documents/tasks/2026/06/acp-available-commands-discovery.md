---
date: "2026-06-02"
status: in progress
implements: [FR-L39, FR-L42]
tags: [acp, discovery, commands, capability-inventory, fast-channel]
related_tasks:
  - 2026/05/acp-transport-poc.md
  - 2026/06/acp-surface-parity.md
  - 2026/06/acp-parity-closeouts.md
  - 2026/06/acp-unsupported-option-error.md
---

# ACP — Available-Commands Discovery (Commands Fast-Channel)

## Goal

Expose the slash-commands an agent advertises at runtime via a uniform
`fetchCommands(runtime, opts)` fast-channel on `RuntimeAdapter`, so
consumers building UIs (REPL pickers, IDE selectors, dashboards) can
render the live command list without spawning an LLM turn or
hardcoding per-front tables.

The first piloted backing is the ACP `session/update` notification with
`update.sessionUpdate === "available_commands_update"`, carrying an
`availableCommands: AvailableCommand[]` array (`name`, `description`,
optional `input.hint`). Today the library silently drops the
notification — both `runtime/acp/content.ts:extractAcpContent` and the
adapter's notification pump ignore the variant, so the data never
reaches consumers. CLI-transport runtimes get a typed
`CommandsUnavailableError` (no behavioural change for CLI — slow path
`fetchCapabilitiesSlow` already exists for that route).

## Overview

### Context

Prior research (this session) confirmed the discovery model in ACP:

- No `commands/list` / `skills/list` RPC method. The spec uses a single
  `available_commands_update` push notification (schema verified in
  `zed-industries/agent-client-protocol/schema/schema.json`).
- Each entry: `{ name: string, description: string, input?: { hint?:
  string }, _meta? }`.
- Push frequency is front-defined — typically once shortly after
  `session/new` (initial snapshot) and again when the agent's plugin /
  skill set mutates mid-session.
- Skills are NOT in this notification — the FR-L20 LLM-probed path
  remains the cross-runtime answer for skills. This task covers
  **commands only**.

Three pilots (`claude` / `codex` / `opencode`) are already wired in
`runtime/acp/fronts.ts`; the new channel piggybacks on the existing
`AcpStdioClient.notifications` iterator without touching the JSON-RPC
client core.

Existing related FRs:

- **FR-L20** — LLM-probed `fetchCapabilitiesSlow` (expensive, returns
  `{skills, commands}`). The new channel is a complementary fast path:
  zero-LLM-cost, ACP-pilot-only at MVP. Does NOT replace FR-L20 — both
  co-exist; helper choice is explicit, no auto-fallback.
- **FR-L23** — `extractSessionContent` over ACP `session/update`. The
  current dispatcher matches `agent_message_chunk` and
  `tool_call_update`; `available_commands_update` is a documented
  "future kinds gain dedicated branches" extension point.
- **FR-L39** — ACP transport pilots. This task extends the transport's
  user-visible surface; no protocol-level work.

### Current State

- `runtime/acp/content.ts:extractAcpContent` (lines 50–82) handles
  `agent_message_chunk` and `tool_call_update` only; every other
  variant returns `[]`.
- `runtime/acp/adapter.ts:invokeViaAcp` drain loop iterates
  `client.notifications()` and forwards each note to `opts.onEvent`
  raw; `openSessionViaAcp` wraps via `mapSessionUpdate`. The
  `available_commands_update` payload already reaches `onEvent` raw,
  but `extractSessionContent` returns `[]` for it and no typed
  accessor exists.
- `RuntimeAdapter` already has `fetchCapabilitiesSlow?(opts)` (FR-L20)
  as an optional method gated by `capabilities.capabilityInventory`.
  The new `fetchCommands?(opts)` slots in symmetrically.
- `RuntimeAdapter.capabilitiesFor(transport)` already returns
  transport-scoped capabilities (FR-L39); the new
  `commandsFastChannel: boolean` flag uses the same per-transport
  vector — `true` for ACP-piloted runtimes, `false` for CLI.
- No public type for neutral `Command` / `CommandsSnapshot` or for
  `CommandsUnavailableError` exists in `mod.ts`.
- No fast helper exists; consumers wanting commands today must either
  call `fetchCapabilitiesSlow` (LLM turn, seconds-to-minutes, $$) or
  hand-parse `raw` from `onEvent`.

### Constraints

- **Commands only — skills stay on the slow path.** ACP does not push
  skills natively; conflating the two channels would mislead the
  consumer.
- **Cross-pilot uniformity.** The neutral `Command` / `CommandsSnapshot`
  shape must be identical across claude / codex / opencode ACP fronts;
  any per-front quirk (variant casing, wrapper layer) is normalised
  inside `runtime/acp/`.
- **Transport-scoped capability.** `commandsFastChannel: boolean` lives
  on `RuntimeCapabilities` and is read through
  `adapter.capabilitiesFor(transport)`. `transport: "cli"` → `false`
  for every runtime (Claude `system/init` fast-path is a deliberate
  follow-up — see `## Follow-ups`); `transport: "acp"` → `true` for the
  three piloted runtimes, `false` for `cursor` (front not piloted).
- **No new wire surface in the JSON-RPC client.** `AcpStdioClient`
  stays protocol-generic; new typed surfaces live in
  `runtime/acp/content.ts`, `runtime/acp/commands.ts` (internal
  helper), and `runtime/commands.ts` (neutral dispatcher + types).
- **Empirical capture before declaring the shape.** Per AGENTS.md
  "Adding Typed Stream Events for a Runtime" — capture real
  `available_commands_update` NDJSON from at least one pilot (Claude)
  via `scripts/smoke.ts` before locking the typed union. Variant casing
  (`available_commands_update` vs `availableCommandsUpdate`) and
  wrapper depth differ across fronts and the schema alone cannot be
  trusted (FR-L30 lesson).
- **Surface must compose with FR-L23.** `extractSessionContent`
  returns content for `available_commands_update` events (so the
  cross-runtime renderer keeps a single dispatch point), but the kind
  is non-text/non-tool — a new `NormalizedContent` kind (`"commands"`)
  is introduced. This is an additive change; consumers branching on
  `kind === "text" | "tool" | "final"` stay sound (default branch).
- **No public API breakage.** New types and methods are additive. JSR
  `no-slow-types` enforced by `deno publish --dry-run`.
- **TDD on stub-driven tests; one real-binary e2e per pilot under
  `E2E=1`.** Stubs simulate the notification deterministically; live
  smoke proves the wire actually carries the variant for each pilot
  (any pilot that does NOT push commands surfaces as an ignored e2e,
  not a failure — gated by `e2eAcpEnabled`).
- **`fetchCapabilitiesSlow` interaction.** The fast helper does NOT
  shadow or auto-fallback into the slow one. Consumers explicitly
  pick: fast-commands-only via `fetchCommands(runtime, {transport:
  "acp", ...})`, or full skills+commands via `fetchCapabilitiesSlow`.
- **No mutation of `~/`.** ACP-front spawning honours the existing
  registry (npx for claude/codex; local binary for opencode); no
  staging, no symlinks, no rewrite-and-restore.
- **No duplicate spawn-and-handshake code path.** `fetchAcpCommands`
  MUST reuse `spawnClient` + `handshake` from `runtime/acp/
  adapter.ts`; any RPC call that's redundant for a one-shot
  notification capture (`session/set_mode`,
  `session/set_config_option`) is made conditional in `handshake`
  via an opts flag (`skipModeAndConfig?: boolean`) rather than
  forked into a parallel spawn-helper. Rationale: avoids drift in
  abort / FR-L37 classification / process-registry handling.
- **Invoke-path semantics for the commands kind.** The new
  `NormalizedCommandsContent` kind reaches
  `extractSessionContent`, but `invokeViaAcp`'s `collectedText`
  filter (`if (c.kind === "text")`) intentionally keeps it out of
  `output.result`. Documented in `runtime/CLAUDE.md` so consumers
  don't expect a stringified command list in invoke output.
- **Helper does NOT auto-send a noop-prompt.** If the front emits
  `available_commands_update` only after the first
  `session/prompt`, `fetchAcpCommands` will time out and throw —
  the helper does not silently inject a hidden prompt. Adding an
  `autoPrompt?: boolean` opt is a Follow-up gated on empirical
  evidence.
- **Branch target.** Lands on `main`.

## Definition of Done

> Test files named below DO NOT exist yet — the develop phase creates
> them in the RED step. The plan fixes the test paths; nothing here
> claims existing coverage.

- [ ] **SRS FR-L42 section added** — `documents/requirements.md` gains
  `### 3.40 FR-L42: Commands Fast-Channel Discovery` with
  `**Description:**`, `**Motivation:**`, `**Acceptance:**` matching
  the DoD bullets below. (FR-L42. Test: `manual — korchasa` (doc
  review). Evidence: `git diff documents/requirements.md`.)

- [ ] **Empirical NDJSON capture** — `scripts/smoke.ts` gains an
  `acp-commands` scenario that drives `claude-agent-acp` through
  `initialize` → `session/new` → `session/prompt` with a trivial
  prompt and dumps every notification to `/tmp/acp-commands-*.ndjson`
  with a `update.sessionUpdate` histogram. Confirms the variant
  string and wrapper depth used by the pinned pilot. (FR-L42. Test:
  `manual — korchasa` (capture artifact reviewed). Evidence:
  `deno run -A scripts/smoke.ts acp-commands`.)

- [x] **Neutral `Command` / `CommandsSnapshot` /
  `CommandsUnavailableError` surface** — `runtime/commands.ts`
  exports `Command { name: string; description: string; input?: {
  hint?: string } }`, `CommandsSnapshot { runtime: RuntimeId;
  sessionId?: string; commands: Command[] }`, and
  `CommandsUnavailableError extends Error { runtime: RuntimeId;
  transport: TransportOption; reason: "no_fast_channel" | "timeout" |
  "front_not_piloted" }`. Re-exported from `mod.ts` and the
  `./runtime/commands` sub-path (added to `deno.json#exports`).
  (FR-L42. Test:
  `runtime/commands_test.ts::neutral types compile and re-export`.
  Evidence: `deno publish --dry-run`.)

- [ ] **`commandsFastChannel` capability flag** —
  `runtime/capability-types.ts:RuntimeCapabilities` gains
  `commandsFastChannel: boolean` (JSDoc explains transport-scoped
  semantics and absence of CLI fast-path). Every adapter's CLI
  capability vector sets `false`; every ACP-piloted adapter's
  `capabilitiesFor("acp")` returns `true` (Claude / Codex /
  OpenCode), `false` for Cursor (front not piloted). (FR-L42 +
  FR-L39. Test: `runtime/index_test.ts::commandsFastChannel reflects
  transport-scoped support per runtime`. Evidence: `deno test -A
  --no-check runtime/`.)

- [x] **`NormalizedCommandsContent` union widened additively** —
  `runtime/content.ts` adds `NormalizedCommandsContent { kind:
  "commands"; commands: Command[] }` to the `NormalizedContent`
  union with explicit `kind: "commands"` discriminator + JSDoc.
  Existing consumers branching on `text | tool | final` keep working
  via default branch. (FR-L42 + FR-L23. Test:
  `runtime/content_dispatch_test.ts::commands kind is exhaustive in
  union and ACP-event surfaces it`. Evidence: `deno test -A --no-check
  runtime/`.)

- [x] **Content-extractor branch** —
  `runtime/acp/content.ts:extractAcpContent` gains an
  `available_commands_update` arm that maps `update.availableCommands`
  → `Command[]` via `runtime/acp/commands.ts:parseAvailableCommands`.
  Unknown command entries (missing or non-string `name` /
  `description`) are skipped without throwing. (FR-L42 + FR-L23.
  Test: `runtime/acp/content_test.ts::extractAcpContent surfaces
  available_commands_update entries and skips malformed`. Evidence:
  `deno test -A --no-check runtime/acp/`.)

- [ ] **Internal ACP-side helper** — `runtime/acp/commands.ts` exports
  internal `fetchAcpCommands(runtime, opts):
  Promise<CommandsSnapshot>` that opens an ACP session, awaits the
  first `available_commands_update` notification (or a configurable
  `timeoutMs` ceiling defaulting to 10 000 ms), disposes the session,
  and returns the snapshot. On timeout throws `new
  CommandsUnavailableError(runtime, "acp", "timeout")` with the
  elapsed wait + pilot name in the message. On a non-piloted ACP
  front throws `CommandsUnavailableError("acp",
  "front_not_piloted")` synchronously before spawn. The error is
  honoured by `AbortSignal` — caller-supplied signal aborts the wait
  cleanly. (FR-L42 + FR-L39. Test:
  `runtime/acp/commands_test.ts::fetchAcpCommands captures first
  available_commands_update and disposes`,
  `runtime/acp/commands_test.ts::fetchAcpCommands throws
  CommandsUnavailableError(timeout) on timeout`,
  `runtime/acp/commands_test.ts::fetchAcpCommands aborts on signal`.
  Evidence: `deno test -A --no-check runtime/acp/`.)

- [ ] **`RuntimeAdapter.fetchCommands` method (canonical entry
  point)** — `RuntimeAdapter` (in `runtime/adapter-types.ts`) gains
  `fetchCommands?(opts: FetchCommandsOptions):
  Promise<CommandsSnapshot>` symmetric to `fetchCapabilitiesSlow?`.
  No top-level `fetchCommands(runtime, opts)` is exported — the
  adapter method is the only public surface (rationale: avoids
  `runtime` parameter duplication and dual-style API; symmetric to
  FR-L20). `opts.transport` selects route: `"acp"` → delegates to
  internal `fetchAcpCommands(runtimeId, opts)`; `"cli"` (or unset)
  → throws `CommandsUnavailableError(runtimeId, "cli",
  "no_fast_channel")` synchronously (before any I/O). Every
  ACP-piloted runtime adapter (Claude / Codex / OpenCode)
  implements it; Cursor leaves the method undefined (capability
  `false` on both transports). Callers MUST check
  `capabilitiesFor(transport).commandsFastChannel` before invoking.
  (FR-L42 + FR-L39. Test:
  `runtime/index_test.ts::ACP-piloted adapters expose fetchCommands
  delegating to ACP helper`, `runtime/index_test.ts::fetchCommands
  throws CommandsUnavailableError(no_fast_channel) on cli transport`.
  Evidence: `deno test -A --no-check runtime/`.)

- [ ] **Real-binary e2e (Claude pilot, hard)** —
  `e2e/acp_commands_e2e_test.ts` calls
  `fetchCommands("claude", { transport: "acp", timeoutMs: 15_000,
  ... })` against the pinned `@agentclientprotocol/claude-agent-acp`
  and asserts `snapshot.commands.length > 0` with at least one entry
  whose `name` is a non-empty string. Gated by `E2E=1` +
  `e2eAcpEnabled("claude")`. (FR-L42. Test:
  `e2e/acp_commands_e2e_test.ts::fetchCommands returns non-empty
  command list against claude-agent-acp`. Evidence: `E2E=1
  E2E_RUNTIMES=claude deno test -A --no-check
  e2e/acp_commands_e2e_test.ts`.)

- [ ] **Real-binary e2e (Codex + OpenCode pilots, soft)** — same
  scenario for `codex` and `opencode` pilots; one `t.step` per pilot
  with **typed branching**: `CommandsUnavailableError` with
  `reason === "timeout"` → log skip and return (front does not push
  the variant); ANY other error (RPC error, spawn failure,
  `front_not_piloted`, etc.) → re-throw and fail the step. Result:
  matrix visibility on which pilots advertise commands today, with
  regressions surfaced not masked. (FR-L42. Test:
  `e2e/acp_commands_e2e_test.ts::fetchCommands soft-probe codex &
  opencode pilots`. Evidence: `E2E=1 deno task e2e:acp`.)

- [ ] **FR-comment markers** — every new exported symbol carries a
  leading `// FR-L42` comment (per AGENTS.md "Requirement
  traceability"). At minimum: `runtime/commands.ts` (3 symbols),
  `runtime/acp/commands.ts` (2 symbols), `runtime/content.ts`
  (`NormalizedCommandsContent`),
  `runtime/capability-types.ts:commandsFastChannel`. (FR-L42. Test:
  `manual — korchasa` (grep audit). Evidence: `grep -rE "// FR-L42"
  runtime/ e2e/ | wc -l` returns ≥ 6.)

- [ ] **README feature matrix updated** — README gains a row noting
  "Commands fast-channel (FR-L42)" with the pilot support matrix
  derived from the soft e2e run: claude ✓, codex ?, opencode ?,
  cursor ✗ (pilot not yet). (FR-L42. Test: `manual — korchasa` (doc
  review). Evidence: `git diff README.md`.)

- [ ] **`deno task check` green** (fmt, lint, type check, full test
  suite, doc-lint, `deno publish --dry-run`). Includes `deno doc
  --lint` on the new `./runtime/commands` sub-path. (FR-L23 +
  FR-L39 + FR-L42. Test: implicit. Evidence: `deno run -A
  scripts/check.ts`.)

- [ ] **SDS component section** — `documents/design.md` gains
  `### 3.X runtime/commands.ts — Commands Fast-Channel` under
  `## 3. Components` describing the dispatcher, the neutral types,
  and the transport-scoped capability semantics. (FR-L42. Test:
  `manual — korchasa` (doc review). Evidence: `git diff
  documents/design.md`.)

- [ ] **`runtime/CLAUDE.md` describes the new channel** — adds:
  (a) a bullet under "Normalized content" covering the
  `available_commands_update` arm with the explicit note that
  `invokeViaAcp`'s `collectedText` filter intentionally excludes
  the `commands` kind from `output.result` (consumers wanting the
  list use `extractSessionContent` on `onEvent`);
  (b) a bullet under "Key decisions" covering the
  `commandsFastChannel` capability + `adapter.fetchCommands`
  contract (transport-scoped; CLI throws synchronously);
  (c) a bullet under "Gotchas" noting the `handshake`
  `skipModeAndConfig` flag and why it exists (one-shot capture
  needs neither). (FR-L42. Test: `manual — korchasa` (doc review).
  Evidence: `git diff runtime/CLAUDE.md`.)

## Solution

Implement Variant **C** (best long-term): neutral
`fetchCommands(runtime, opts)` dispatcher on the public API +
transport-scoped `commandsFastChannel` capability flag + ACP-backed
implementation today, CLI runtimes throw typed
`CommandsUnavailableError`. Ships in 6 commits, each its own RED →
GREEN → REFACTOR → CHECK cycle, ordered so every commit is
independently mergeable and `deno task check` green.

### Files

Created:

- `runtime/commands.ts` — public `Command`, `CommandsSnapshot`,
  `CommandsUnavailableError`, `FetchCommandsOptions`,
  `fetchCommands(runtime, opts)` dispatcher.
- `runtime/commands_test.ts` — dispatcher unit tests.
- `runtime/acp/commands.ts` — internal `parseAvailableCommands`
  (pure) + `fetchAcpCommands(runtime, opts)` (session-helper).
- `runtime/acp/commands_test.ts` — PATH-stub-driven unit tests for
  `fetchAcpCommands` happy path / timeout / abort.
- `runtime/content_dispatch_test.ts` — only if it doesn't already
  exist; otherwise extended with the `commands` kind exhaustiveness
  check.
- `e2e/acp_commands_e2e_test.ts` — claude (hard) + codex/opencode
  (soft `t.step`) real-binary smoke.

Modified:

- `runtime/capability-types.ts` — add
  `commandsFastChannel: boolean`.
- `runtime/adapter-types.ts` — add optional
  `fetchCommands?(opts)` method.
- `runtime/content.ts` — add `NormalizedCommandsContent` to union +
  JSDoc.
- `runtime/acp/content.ts` — add `available_commands_update` arm.
- `runtime/index.ts` — wire `fetchCommands` on each adapter via the
  dispatcher; update `capabilitiesFor("acp")` for the three pilots.
- Per-runtime `<runtime>/process.ts` capability vectors —
  `commandsFastChannel: false` on every CLI vector (one-line
  additions per file).
- `mod.ts` — re-export `Command`, `CommandsSnapshot`,
  `CommandsUnavailableError`, `FetchCommandsOptions`,
  `fetchCommands`, `NormalizedCommandsContent`.
- `deno.json` — register `./runtime/commands` sub-path.
- `scripts/smoke.ts` — `acp-commands` scenario.
- `documents/requirements.md` — new `### 3.40 FR-L42` section +
  surgical `**Tasks:**` back-pointer on FR-L39.
- `documents/design.md` — new `### 3.X runtime/commands.ts`
  component section.
- `documents/index.md` — FR-L42 row + FR-L39 summary refresh if the
  summary changed.
- `runtime/CLAUDE.md` — two bullets (Normalized content, Key
  decisions).
- `README.md` — feature-matrix row.

### Commit 1 — Empirical capture (`chore(smoke): capture ACP available_commands_update`)

RED: N/A (smoke scripts are not under the regression suite — see
AGENTS.md `## Development Commands`). GREEN: write the `acp-commands`
scenario; the scenario MUST `Deno.exit(1)` if the histogram does not
contain at least one `available_commands_update` entry — this is the
project-level guard against a smoke run that silently passes on
malformed capture. REFACTOR: factor `dumpAcpNotifications(scenarioName)`
if useful (skip otherwise — one-shot). CHECK: `deno run -A
scripts/smoke.ts acp-commands` produces `/tmp/acp-commands-*.ndjson`
with at least one `{ "update": { "sessionUpdate":
"available_commands_update", ... } }` line; exit code 0. Confirm
wrapper depth before locking the schema in commit 3.

### Commit 2 — Neutral surface (`feat(runtime): add Command + CommandsSnapshot + CommandsUnavailableError (FR-L42)`)

RED:

1. Write `runtime/commands_test.ts` with two tests that initially fail
   to compile (types do not exist):
   - `neutral types compile and re-export` — imports `Command`,
     `CommandsSnapshot`, `CommandsUnavailableError`,
     `FetchCommandsOptions`, `fetchCommands` from `../mod.ts`.
   - `CommandsUnavailableError carries runtime/transport/reason
     fields` — constructs and asserts.

GREEN: implement minimal `runtime/commands.ts` with neutral types and
a stub `fetchCommands` that always throws `new CommandsUnavailableError(
runtime, "cli", "no_fast_channel")`. Re-export from `mod.ts`. Register
sub-path in `deno.json#exports`.

REFACTOR: extract `errorMessageFor(reason)` helper if more than one
call site; otherwise inline.

CHECK: `deno task test runtime/commands_test.ts` green; `deno doc
--lint mod.ts` green; `deno publish --dry-run` green (slow-type lints
fire here, e.g. missing JSDoc on exported class constructor).

### Commit 3 — ACP arm of `extractAcpContent` + union widening (`feat(runtime): NormalizedCommandsContent and ACP available_commands_update extraction (FR-L42 + FR-L23)`)

RED:

1. Extend `runtime/acp/content_test.ts` (or create) with cases:
   - `available_commands_update with two well-formed entries yields
     NormalizedCommandsContent{kind:"commands", commands:[...]}`.
   - `malformed entry (no name) is silently skipped, others surface`.
   - `empty availableCommands array yields []` (no `commands` entry).
2. Extend `runtime/content_dispatch_test.ts`:
   - `extractSessionContent for ACP-shaped event with
     available_commands_update returns commands kind`.
   - Exhaustiveness switch:
     ```ts
     const c: NormalizedContent = ...;
     switch (c.kind) {
       case "text": case "tool": case "final": case "commands": break;
       default: { const _: never = c; }
     }
     ```

GREEN: add `NormalizedCommandsContent` to `runtime/content.ts` union;
add `available_commands_update` arm to `runtime/acp/content.ts`
delegating to a small `parseAvailableCommands(raw): Command[]` helper
that defensively skips entries missing `name` or `description`. The
helper lives in `runtime/acp/commands.ts` even though
`fetchAcpCommands` is added in commit 4 — this avoids a content-only
file owning command-shape knowledge.

REFACTOR: keep `isObject` helper in `runtime/acp/content.ts`; reuse
from `parseAvailableCommands` via export.

CHECK: `deno task check` green.

### Commit 4 — Capability flag + `fetchAcpCommands` helper (`feat(runtime/acp): commandsFastChannel capability + fetchAcpCommands helper (FR-L42 + FR-L39)`)

RED:

1. Extend `runtime/acp/commands_test.ts` with PATH-stub-driven tests
   (pattern from `opencode/session_test.ts`):
   - `fetchAcpCommands captures first available_commands_update and
     disposes` — stub front emits the notification 50 ms after
     `session/new` ack; helper resolves with the snapshot and the
     stub is observed to have received `session/cancel` or stdin
     close.
   - `fetchAcpCommands throws CommandsUnavailableError(timeout) on
     timeout` — stub never emits the variant; helper throws after
     `timeoutMs: 200`.
   - `fetchAcpCommands aborts on signal` — caller-provided
     `AbortController.abort("test")` resolves the wait with an
     `AbortError`, helper rethrows as `CommandsUnavailableError(...,
     "timeout")` with `cause: AbortError`.
   - `fetchAcpCommands throws front_not_piloted for cursor` — uses
     real `getAcpFront("cursor").pilot === false`, no spawn happens.

2. Extend `runtime/index_test.ts`:
   - `commandsFastChannel reflects transport-scoped support per
     runtime` — for each runtime, assert `capabilitiesFor("cli")
     .commandsFastChannel === false` and `capabilitiesFor("acp")
     .commandsFastChannel === <pilot.cmd !== "cursor-agent">`.

GREEN:

- Add `commandsFastChannel: boolean` to `RuntimeCapabilities`. Set
  `false` on every CLI vector across `claude/process.ts`,
  `opencode/process.ts`, `cursor/process.ts`, `codex/process.ts`.
- Implement `fetchAcpCommands` in `runtime/acp/commands.ts` by
  REUSING `spawnClient` + `handshake` from `runtime/acp/
  adapter.ts`. Extend `handshake` with a `skipModeAndConfig?:
  boolean` opts flag so the helper skips `session/set_mode` and
  `session/set_config_option` calls; the existing
  `attemptInvocation` path passes `false` (default), the new
  helper passes `true`. NO parallel spawn-helper. Use
  `AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs
  ?? 10_000)])` to compose the ceiling. Drain the notification
  iterator, pick the first `available_commands_update`, dispose the
  client, return the snapshot. Helper does NOT inject any
  `session/prompt` — if the front gates the variant on a first
  prompt, the helper times out and throws.
- Update `runtime/index.ts:getRuntimeAdapter` so each adapter's
  `capabilitiesFor("acp")` returns
  `{...cliCaps, commandsFastChannel: getAcpFront(runtime).pilot}`.

REFACTOR: extract `awaitFirstAcpUpdate(client, predicate, signal):
Promise<RuntimeSessionEvent>` if it gets reused elsewhere; otherwise
inline.

CHECK: `deno task check` green. Manually verify capability flag with a
one-liner unit assertion.

### Commit 5 — Adapter wiring (`feat(runtime): adapter.fetchCommands on ACP-piloted runtimes (FR-L42)`)

RED:

1. `runtime/index_test.ts` — all tests use PATH-stub fronts via
   `opts.acpFront` override (per AGENTS.md "No stubs or mocks for
   internal code" — bash stub binary, no DI hack):
   - `ACP-piloted adapters expose fetchCommands delegating to ACP
     helper` — invokes `adapter.fetchCommands({transport:"acp",
     acpFront: <stub>, cwd: ..., timeoutMs: 1_000})` for claude /
     codex / opencode; stub emits `available_commands_update` 50 ms
     after `session/new` ack; assert snapshot shape.
   - `fetchCommands throws CommandsUnavailableError(no_fast_channel)
     on cli transport` — `await assertRejects(() => adapter
     .fetchCommands({transport: "cli"}), CommandsUnavailableError)`.
   - `fetchCommands throws CommandsUnavailableError(front_not_piloted)
     for cursor on acp` — uses real `getAcpFront("cursor")` (no
     spawn).
   - `fetchCommands rejects synchronously on opts.transport === "cli"`
     — no `await`, no spawn observed in stub bookkeeping.

GREEN:

- Promote the throwing stub from commit 2 to a real adapter-method
  implementation: each ACP-piloted runtime's `RuntimeAdapter`
  object gets `fetchCommands: (opts) => opts.transport === "acp" ?
  fetchAcpCommands(<runtimeId>, opts) : throw new
  CommandsUnavailableError(<runtimeId>, "cli", "no_fast_channel")`.
- Add `fetchCommands?(opts)` to `RuntimeAdapter` interface.
- Cursor adapter leaves the method undefined.

REFACTOR: if the throwing-cli branch shows up in 3 adapters
identically, extract a tiny `cliRejection(runtimeId)` helper inside
`runtime/acp/commands.ts`; otherwise inline.

CHECK: `deno task check` green.

### Commit 6 — Real-binary e2e + docs (`feat(e2e): acp_commands_e2e_test.ts + docs sync (FR-L42)`)

RED: e2e tests fail because the new code is already in place by commit
5; RED here is the test scaffolding itself.

GREEN:

- Write `e2e/acp_commands_e2e_test.ts` with `Deno.test` containing
  three `t.step`s (claude hard, codex soft, opencode soft). Each
  step calls `fetchCommands(runtime, {transport:"acp", timeoutMs:
  15_000, cwd: Deno.cwd()})`. Hard step asserts `commands.length >
  0`; soft steps log `console.log("[skip] codex/opencode commands
  fast-channel: <reason>")` on `CommandsUnavailableError(timeout)`
  and return without failing.
- Add `acp-commands` scenario to `scripts/smoke.ts` (also re-runs
  the capture from commit 1 — same code path).
- Write the SRS `### 3.40 FR-L42` section.
- Write the SDS `### 3.X runtime/commands.ts` component section.
- Update `documents/index.md` with the FR-L42 row.
- Update `runtime/CLAUDE.md` (Normalized content + Key decisions
  bullets).
- Update `README.md` feature matrix.
- Surgical SRS `**Tasks:**` back-pointer: append `[REF:task:2026-06-
  acp-available-commands-discovery | acp-available-commands-discovery]`
  to FR-L39's `**Tasks:**` line.

REFACTOR: collapse hard/soft step bodies into a shared
`probeCommandsForPilot(t, runtime, options)` if duplication > 30
lines.

CHECK: `deno run -A scripts/check.ts` green. Run `E2E=1
E2E_RUNTIMES=claude deno test -A --no-check
e2e/acp_commands_e2e_test.ts` locally; observe `> 0` commands.

### Verification

- `deno task check` exit 0.
- `deno task e2e:acp` exit 0 (soft-skips allowed).
- Manual: `grep -rE "// FR-L42" runtime/ e2e/ | wc -l` ≥ 6.
- Manual: `documents/index.md` contains FR-L42 row; SRS FR-L42
  section exists; SDS component section exists; README matrix row
  exists.
- JSR slow-type lints clean: `deno publish --dry-run` (last step of
  `scripts/check.ts`) green.
- Doc-lint: `deno doc --lint mod.ts` green.

### Error-handling notes

- `fetchAcpCommands` translates wait errors into typed
  `CommandsUnavailableError`. `AbortError` (signal- or
  timeout-driven) → `reason: "timeout"` with `cause` preserved.
  Non-piloted front → `reason: "front_not_piloted"`. Anything else
  (e.g. an `AcpRpcError`, npx spawn failure) propagates as-is — the
  helper does not catch unrelated errors, mirroring
  `invokeViaAcp`'s policy.
- The dispatcher's `cli`-transport throw is `synchronous` (not a
  rejected Promise) only when called with `opts.transport === "cli"`
  AND `opts.transport` is supplied at the typed level; otherwise it
  is an awaited rejection. Tests assert both shapes.

## Follow-ups

- **Claude `system/init` CLI fast-path**: `runtime/CLAUDE.md`
  documents that Claude's first NDJSON event carries
  `slash_commands: []`. Adding a CLI fast-path for Claude (capability
  `commandsFastChannel: true` on CLI transport) is a separate task —
  requires empirical capture, then wiring through the CLI branch of
  `adapter.fetchCommands`.
- **Unified `CapabilityInventory`** — once two transports expose
  fast-channels, consider deprecating the parallel
  `fetchCapabilitiesSlow` `commands` field in favour of
  `adapter.fetchCommands` + reserving `fetchCapabilitiesSlow` for
  `skills`-only. **Variant-C re-evaluation gate**: revisit at the
  end of Q3-2026 (or after 2 downstream consumers actually adopt
  the fast-channel — whichever first). If `fetchCommands` did not
  pick up new transports by then, fold its implementation back into
  `fetchCapabilitiesSlow`-only and remove the duplicate API surface.
- **Auto-prompt for lazy pilots** — if empirical e2e shows a pilot
  emits `available_commands_update` only post-`session/prompt`,
  consider adding `FetchCommandsOptions.autoPromptText?: string`
  that sends one throw-away prompt before waiting. Not added
  speculatively.
- **OpenCode session.update push** — OpenCode 1.15.x does not push
  `available_commands_update` (verified empirically). If a future
  version adds it, the soft e2e step will start passing — no library
  change needed.
- **Mid-session refresh** — `available_commands_update` can be
  re-pushed on plugin / skill set mutation. The helper today returns
  only the first snapshot; consumers wanting refresh subscribe to
  `RuntimeSession.events` and call `extractSessionContent` per event.
  Document the pattern in README; do not add a `subscribeCommands`
  API yet.
- **README feature-matrix layout** — if the existing README matrix
  doesn't have a column shape that fits "fast-channel transport
  support × pilot status", restructure the table in a separate
  doc-only PR ahead of commit 6 rather than inline-bloating it.
