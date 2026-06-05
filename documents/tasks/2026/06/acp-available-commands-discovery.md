---
date: "2026-06-02"
status: to do
implements: [FR-L39, FR-L40]
tags: [acp, discovery, commands, capability-inventory]
related_tasks:
  - 2026/05/acp-transport-poc.md
  - 2026/06/acp-surface-parity.md
  - 2026/06/acp-parity-closeouts.md
---

# ACP — Available-Commands Discovery

## Goal

Expose the slash-commands an ACP agent (claude-agent-acp / codex-acp /
opencode acp pilots) advertises at runtime, so consumers building UIs
(REPL pickers, IDE selectors, dashboards) can render the live command
list without spawning an LLM turn or hardcoding per-front tables.

The native channel is the ACP `session/update` notification with
`update.sessionUpdate === "available_commands_update"`, carrying an
`availableCommands: AvailableCommand[]` array (`name`, `description`,
optional `input.hint`). Today the library silently drops the
notification — both `runtime/acp/content.ts:extractAcpContent` and the
adapter's notification pump ignore the variant, so the data never
reaches consumers.

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
  zero-LLM-cost, ACP-only, commands-only. Does NOT replace FR-L20 —
  it co-exists.
- **FR-L23** — `extractSessionContent` over ACP `session/update`. The
  current dispatcher matches `agent_message_chunk` and
  `tool_call_update`; `available_commands_update` is a documented
  "future kinds gain dedicated branches" extension point.
- **FR-L39** — ACP transport pilots. This task extends the transport's
  user-visible surface; no protocol-level work.

### Current State

- `runtime/acp/content.ts:extractAcpContent` (lines 60–82) handles
  `agent_message_chunk` and `tool_call_update` only; every other
  variant returns `[]`.
- `runtime/acp/adapter.ts:invokeViaAcp` drain loop iterates
  `client.notifications()` and forwards each note to `opts.onEvent`
  as a `RuntimeSessionEvent { runtime, type: "session/update", raw:
  note.params }`. The `available_commands_update` payload already
  reaches `onEvent` raw, but `extractSessionContent` returns `[]` for
  it and no typed accessor exists.
- `runtime/acp/adapter.ts:openSessionViaAcp` mirrors the same drain
  pattern for long-lived sessions.
- No public type for `AvailableCommand` / `availableCommands` exists in
  `mod.ts` or `runtime/acp/*`.
- No fast helper exists; consumers wanting commands today must either
  call `fetchCapabilitiesSlow` (LLM turn, seconds-to-minutes) or
  hand-parse `raw` from `onEvent`.

### Constraints

- **Commands only — skills stay on the slow path.** ACP does not push
  skills natively; conflating the two channels would mislead the
  consumer.
- **Cross-pilot uniformity.** The output shape must be identical across
  claude / codex / opencode; any per-front quirk (variant casing,
  wrapper layer) is normalised inside `runtime/acp/`.
- **No new wire surface in the JSON-RPC client.** `AcpStdioClient` stays
  protocol-generic; new typed surfaces live in
  `runtime/acp/content.ts` (or a sibling `commands.ts`) and
  `runtime/acp/adapter.ts`.
- **Empirical capture before declaring the shape.** Per AGENTS.md
  "Adding Typed Stream Events for a Runtime" — capture real
  `available_commands_update` NDJSON from at least one pilot (Claude)
  via `scripts/smoke.ts` before locking the typed union. Variant casing
  (`available_commands_update` vs `availableCommandsUpdate`) and
  wrapper depth differ across fronts and the schema alone cannot be
  trusted (FR-L30 lesson).
- **Surface must compose with FR-L23.** `extractSessionContent` SHOULD
  return content for `available_commands_update` events (so the
  cross-runtime renderer keeps a single dispatch point), but the kind
  is non-text/non-tool — a new `NormalizedContent` kind (`"commands"`)
  is implied. This is an additive change; consumers branching on
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
  pick: fast-commands-only-ACP-only, or slow-skills+commands-all-runtimes.
- **Branch target.** Lands on `main` (or `feat-acp-transport` if it has
  not merged yet at execution time).

## Definition of Done

> Test files named below DO NOT exist yet — the develop phase creates
> them in the RED step. The plan fixes the test paths; nothing here
> claims existing coverage.

- [ ] **SRS FR-L40 section added** — `documents/requirements.md` gains
  `### 3.X FR-L40: ACP Available-Commands Channel` with
  `**Description:**`, `**Motivation:**`, `**Acceptance:**` matching
  the bullets below. (FR-L40. Test: `manual — korchasa` (doc review).
  Evidence: `git diff documents/requirements.md`.)

- [ ] **Empirical NDJSON capture** — `scripts/smoke.ts` gains an
  `acp-commands` scenario that drives `claude-agent-acp` through
  `initialize` → `session/new` → `session/prompt` with a trivial
  prompt and dumps every notification to `/tmp/acp-commands-*.ndjson`
  with a `update.sessionUpdate` histogram. Confirms the variant
  string and wrapper depth used by the pinned pilot. (FR-L40. Test:
  `manual — korchasa` (capture artifact reviewed). Evidence:
  `deno run -A scripts/smoke.ts acp-commands`.)

- [ ] **Typed `AvailableCommand` surface** — `runtime/acp/commands.ts`
  exports `AvailableCommand { name: string, description: string,
  input?: { hint?: string } }` and `AvailableCommandsSnapshot
  { runtime: RuntimeId, sessionId: string, availableCommands:
  AvailableCommand[] }`. Re-exported from `mod.ts` and the
  `./runtime/acp/commands` sub-path. (FR-L40. Test:
  `runtime/acp/commands_test.ts::AvailableCommand surface compiles and
  re-exports`. Evidence: `deno publish --dry-run`.)

- [ ] **Content-extractor branch** — `runtime/acp/content.ts:extractAcpContent`
  gains an `available_commands_update` arm returning a new
  `NormalizedCommandsContent { kind: "commands", commands:
  AvailableCommand[] }` member of the `NormalizedContent` union.
  Unknown command entries (missing `name` or `description`) are
  skipped without throwing. (FR-L40 + FR-L23. Test:
  `runtime/acp/content_test.ts::extractAcpContent surfaces
  available_commands_update entries`. Evidence:
  `deno test -A --no-check runtime/acp/`.)

- [ ] **`NormalizedContent` union widened additively** — `runtime/content.ts`
  adds `NormalizedCommandsContent` to the union with explicit
  `kind: "commands"` discriminator + JSDoc. Existing consumers
  branching on `text | tool | final` keep working via default
  branch. (FR-L40 + FR-L23. Test:
  `runtime/content_dispatch_test.ts::commands kind is exhaustive in
  union`. Evidence: `deno test -A --no-check runtime/`.)

- [ ] **Convenience fast helper** — `runtime/acp/adapter.ts` exports
  `fetchAcpCommands(runtime, opts): Promise<AvailableCommandsSnapshot>`
  that opens an ACP session, awaits the first
  `available_commands_update` notification (or a configurable
  `timeoutMs` ceiling defaulting to 10 000 ms), disposes the session,
  and returns the snapshot. If the front never pushes the variant
  within the ceiling, throws a typed `AcpCommandsUnavailableError`
  with the elapsed wait + pilot name. (FR-L40 + FR-L39. Test:
  `runtime/acp/adapter_test.ts::fetchAcpCommands captures first
  available_commands_update and disposes`,
  `runtime/acp/adapter_test.ts::fetchAcpCommands throws
  AcpCommandsUnavailableError on timeout`. Evidence:
  `deno test -A --no-check runtime/acp/`.)

- [ ] **Real-binary e2e (Claude pilot)** — `e2e/acp_commands_e2e_test.ts`
  calls `fetchAcpCommands("claude", { ... })` against the pinned
  `@agentclientprotocol/claude-agent-acp` and asserts
  `snapshot.availableCommands.length > 0` with at least one entry
  whose `name` is a non-empty string. Gated by `E2E=1` +
  `e2eAcpEnabled("claude")`. (FR-L40. Test:
  `e2e/acp_commands_e2e_test.ts::fetchAcpCommands returns non-empty
  command list against claude-agent-acp`. Evidence:
  `E2E=1 E2E_RUNTIMES=claude deno test -A --no-check
  e2e/acp_commands_e2e_test.ts`.)

- [ ] **Real-binary e2e (Codex + OpenCode pilots, soft)** — same
  scenario for `codex` and `opencode` pilots; `t.step` per pilot so a
  pilot that never pushes the variant produces a `t.step` skip
  (timeout → log skip, do NOT fail the outer test). Result: matrix
  visibility on which pilots advertise commands today. (FR-L40. Test:
  `e2e/acp_commands_e2e_test.ts::fetchAcpCommands soft-probe codex &
  opencode pilots`. Evidence: `E2E=1 deno task e2e:acp`.)

- [ ] **FR-comment markers** — every new exported symbol carries a
  leading `// FR-L40` comment (per AGENTS.md "Requirement
  traceability"). (FR-L40. Test:
  `grep -rE "^// FR-L40" runtime/acp/ e2e/` returns ≥ 3 matches.
  Evidence: `manual — korchasa`.)

- [ ] **README feature matrix updated** — README gains a row noting
  "ACP available-commands channel (FR-L40)" with the pilot support
  matrix derived from the soft e2e. (FR-L40. Test: `manual —
  korchasa` (doc review). Evidence: `git diff README.md`.)

- [ ] **`deno task check` green** (fmt, lint, type check, full test
  suite, doc-lint, `deno publish --dry-run`). (FR-L23 + FR-L39 +
  FR-L40. Test: implicit. Evidence: `deno run -A scripts/check.ts`.)

- [ ] **`runtime/CLAUDE.md` + `runtime/acp/AGENTS.md` (if present)
  describe the new channel** — adds a bullet under the "ACP
  transport" / "Normalized content extraction" sections covering
  the `available_commands_update` arm and the `fetchAcpCommands`
  helper. (FR-L40. Test: `manual — korchasa` (doc review). Evidence:
  `git diff runtime/CLAUDE.md`.)

## Solution

<!-- TO BE FILLED AFTER VARIANT SELECTION -->

placeholder — variants A / B / C presented in chat; Solution section
will be overwritten once the user picks one.
