---
date: "2026-06-01"
status: superseded
superseded_by:
  - 2026/06/acp-resume-via-session-load.md
implements: [FR-L17, FR-L19, FR-L20, FR-L39]
tags: [acp, parity, runtime, hooks, capability-inventory]
related_tasks:
  - 2026/05/acp-transport-poc.md
  - 2026/06/acp-surface-parity.md
  - 2026/06/acp-reliability-parity.md
  - 2026/06/acp-followups.md
  - 2026/06/acp-unsupported-option-error.md
---

# ACP Transport — Parity Closeouts (excl. Cursor)

> **SUPERSEDED (2026-06-06).** This plan predates
> `acp-unsupported-option-error.md` (shipped 2026-06-06), which made the
> silent-drop fields throw `AcpUnsupportedOptionError` synchronously —
> directly contradicting items 1 (resume fallback) and 2
> (degradation-completeness). Reconciliation:
>
> - **Item 3 (`onInit.model`)** — DONE. Shipped against the current code
>   state. ACP invoke path fires `onInit({runtime, sessionId, model})`.
> - **Item 4 (`capabilityInventory` on ACP)** — DONE. Three pilots
>   advertise `capabilityInventory: true`; `FetchCapabilitiesOptions.transport`
>   routes the inventory turn through `invokeViaAcp`; CLI schema flags
>   suppressed on ACP.
> - **Item 2 (degradation-completeness)** — DROPPED as obsolete. `agent`,
>   `systemPromptFile`, `streamStallTimeoutSeconds`, `streamLogPath`,
>   `onOutput`, `verbosity` now THROW by design (fail-fast), not degrade.
>   Adding them to `collectDegradedOptions` would revert that decision.
> - **Item 1 (resume via `session/load`)** — MOVED to
>   `acp-resume-via-session-load.md`. It needs a real design decision on
>   throw-timing (the fail-fast throw fires before `initialize`, but the
>   `loadSession` capability is only known after), not a verbatim port.
>
> The DoD checkboxes below are left at their reconciled state for the
> record; the canonical follow-up is the resume successor task.

## Goal

Close the four user-visible parity gaps the review surfaced on the ACP
transport, so consumers porting a CLI workload to `transport: "acp"`
hit zero silent drops and zero functional surprises. Cursor pilot
promotion stays out of scope — it is gated on `cursor-agent` joining
the validation matrix and tracked under
`acp-followups.md::Follow-ups`.

The four gaps:

1. **Resume** — `RuntimeInvokeOptions.resumeSessionId` /
   `RuntimeSessionOptions.resumeSessionId` is currently a silent drop
   on the ACP path. Pilots that advertise `agentCapabilities.loadSession`
   (Claude 0.37.0 today; future Codex / OpenCode bumps may follow) MUST
   route the option through `session/load`; pilots that don't advertise
   it MUST surface the field via `degradedOptions` instead of
   discarding it.
2. **Degradation diagnostics completeness** — `collectDegradedOptions`
   flags only 4 of 9 silently-dropped fields. The missing ones
   (`agent`, `systemPromptFile`, `streamStallTimeoutSeconds`,
   `streamLogPath`, `onOutput`, `verbosity`) become invisible to a
   consumer porting a YAML config across transports.
3. **`hooks.onInit.model`** — ACP `handshake` fires
   `opts.hooks?.onInit?.({runtime, sessionId})` without `model`,
   while every CLI adapter surfaces the model. Asymmetry breaks
   consumers that gate per-model behaviour on the `onInit` hook.
4. **`fetchCapabilitiesSlow` on ACP** — pilots advertise
   `capabilityInventory: false` on `capabilitiesFor("acp")`. The
   uniform LLM-prompt driver (`fetchInventoryViaInvoke`) is
   transport-agnostic — it only needs an `invoke` function — so
   the ACP path can advertise `capabilityInventory: true` by routing
   through `invokeViaAcp`.

## Overview

### Context

The branch `feat-acp-transport` shipped three milestones (PoC →
surface-parity → reliability-parity → follow-ups) over four
task files. The `/flowai:review` pass on the cumulative branch
identified 4 silent drops + 1 hook-shape gap + 1 functional resume
gap + 1 capability-inventory gap. The user accepted the verdict
**Approve** for the branch as-is and now wants a follow-up plan
to land the parity closeouts in a separate change.

Resume is the highest-value item: consumers porting from CLI Claude
to ACP Claude lose conversation continuity today and only notice
when the model "forgets" prior turns. The other three are smaller
surface fixes but together turn the ACP path into a near-1:1
substitute for CLI.

### Current State

- `runtime/acp/adapter.ts:handshake` calls `client.request("session/new", …)`
  unconditionally — `opts.resumeSessionId` is never read. The hand-off
  to `pickModeForPermissionMode` / `pickConfigForReasoningEffort` /
  `pickConfigForModel` happens identically on both new and (would-be)
  resumed sessions.
- `runtime/acp/mapping.ts:collectDegradedOptions` emits diagnostics for
  4 fields only: `allowedTools`, `disallowedTools`, `settingSources`,
  `systemPrompt`. Silent drops not currently flagged: `agent`,
  `systemPromptFile`, `streamStallTimeoutSeconds`, `streamLogPath`,
  `onOutput`, `verbosity`, `resumeSessionId` (when not piloted),
  `hooks.onInit.model` (asymmetric — populated downstream).
- `runtime/acp/adapter.ts:554` fires `onInit({runtime, sessionId})`
  without a `model` field, even though `RuntimeInitInfo.model?: string`
  is part of the typed shape and `opts.model` is known at handshake
  time.
- `CLAUDE_ACP_CAPABILITIES` / `CODEX_ACP_CAPABILITIES` /
  `OPENCODE_ACP_CAPABILITIES` set `capabilityInventory: false`. No
  ACP-side wiring exists in `claude-adapter.ts:fetchCapabilitiesSlow`,
  `codex-adapter.ts:fetchCapabilitiesSlow`, or
  `opencode-adapter.ts:fetchCapabilitiesSlow` — they always pass `(inner) =>
  this.invoke(inner)`, which the consumer can already direct to ACP
  via `inner.transport === "acp"`. So the only blocker is the
  capability flag itself; the wiring is already transport-agnostic.

Empirical capability gates (verified against the deno cache pin):

- `agentclientprotocol/sdk@0.22.1` schema declares `session/load`,
  `session/resume`, `session/set_model`, `session/fork`,
  `session/list`, `session/close`, `session/delete`.
- `claude-agent-acp@0.37.0/dist/acp-agent.js` returns
  `agentCapabilities.loadSession = true` from its initialize handler
  and implements `loadSession(params)`.
- `@zed-industries/codex-acp@0.15.0/bin/codex-acp.js` does NOT
  reference `loadSession` / `session/load` — capability gate will
  return `false`, resume falls through to the degraded-option path.
- `opencode acp` is a built-in subcommand (no separate npm package);
  capability gate at runtime is authoritative — the adapter MUST NOT
  hardcode a per-pilot resume table.

### Constraints

- **No new FR.** All four items extend FRs that already exist
  (FR-L17, FR-L19, FR-L20, FR-L39). The SRS `**Acceptance:**`
  bullets gain new sub-bullets; no new section.
- **Capability gate is the single source of truth for resume.**
  Resume MUST inspect `agentCapabilities.loadSession` from the
  `initialize` response. No per-pilot if-tree, no version-string
  sniffing. When the gate is `false` and `resumeSessionId` is set,
  the adapter MUST emit a `degradedOptions` entry — never silently
  fall back to `session/new`.
- **`session/load` parameters mirror `session/new` shape.** Per
  the 0.22.1 schema: `{sessionId, cwd, mcpServers, additionalDirectories?}`.
  The adapter reuses `buildSessionNewParams` + adds `sessionId`;
  no duplicate mapper.
- **`degradedOptions` is the public diagnostic channel.** Adding
  fields to the helper MUST keep the existing payload shape
  (`{field: string, reason: string}`) — consumers branching on the
  current four entries stay green.
- **`capabilityInventory` on ACP costs one LLM turn per call.**
  Same as CLI; existing test for `fetchCapabilitiesSlow` budget
  (`E2E=1` opt-in) covers the cost concern. No new gating knob
  required.
- **`onInit.model` is best-effort.** ACP fronts don't echo back the
  effective model — we surface `opts.model` (which is what we asked
  for via `session/set_config_option`). When the consumer didn't
  pass `model`, `info.model` stays `undefined` — same as CLI when
  the runtime didn't disclose it.
- **`handshake` public signature stays `Promise<{sessionId: string}>`.**
  Internal sequencing (new-vs-load branch) is private; the function's
  contract with callers is preserved byte-for-byte.
- **Both `invokeViaAcp` AND `openSessionViaAcp` honour resume.** The
  long-lived session path delegates to the same `handshake`, so the
  capability gate + `session/load` branch applies uniformly to one-shot
  and streaming invocations. Tests cover both surfaces.
- **`fetchCapabilitiesSlow` under ACP has no schema flags.**
  `--json-schema` / `--output-schema` are CLI-only arguments. Under
  ACP, the existing tolerant-mode parser
  (`parseCapabilityInventoryResponse`) is the only available
  enforcement layer — same posture as OpenCode/Cursor under CLI.
  The adapter MUST NOT pass schema flags through `inner.extraArgs`
  on the ACP path (they'd land in `collectDegradedOptions` as
  extraArgs noise).
- **`collectDegradedOptions` stays internal.** The helper is NOT
  re-exported from `mod.ts` or any sub-path entry — signature
  changes are private to `runtime/acp/`. Verify via
  `grep -n "collectDegradedOptions" mod.ts deno.json` before
  shipping.
- **TDD.** Three of four items are pure adapter / mapping refactors
  with stub-driven tests; the resume item additionally needs one
  real-binary e2e against Claude (the only piloted runtime with
  `loadSession: true`) to prove the wire contract works end-to-end.
- **Branch target.** Lands on `main` (assuming `feat-acp-transport`
  has merged by then) or on `feat-acp-transport` if not.

## Definition of Done

> Test files named below DO NOT exist yet — the develop phase
> creates them in the RED step. The plan fixes the test paths;
> nothing here claims existing coverage.

- [ ] **Resume — capability gate + `session/load` wire** —
  `handshake` reads `agentCapabilities.loadSession` from the
  `initialize` response. When `opts.resumeSessionId` is set AND
  the gate is `true`, the adapter calls `client.request("session/load", …)`
  with `{sessionId, cwd, mcpServers}` instead of `session/new`. The
  follow-up `session/set_mode` / `session/set_config_option` calls
  apply unchanged. When the gate is `false` (codex / opencode today),
  the adapter still calls `session/new`, BUT emits a
  `degradedOptions` entry for `resumeSessionId`.
  *(FR-L39. Test: `runtime/acp/adapter_test.ts::invokeViaAcp drives session/load when resumeSessionId set and pilot advertises loadSession capability`. Evidence: `deno test -A --no-check runtime/acp/`.)*

- [ ] **Resume — real-binary e2e against Claude** — open a fresh
  ACP session, capture `sessionId`, abort, re-open with
  `resumeSessionId` set, send a follow-up prompt that references
  the prior turn ("repeat what I just said"), assert the reply
  evidences memory of turn 1. Gated by `E2E=1` +
  `e2eAcpEnabled("claude")`.
  *(FR-L19. Test: `e2e/acp_resume_e2e_test.ts::resume via session/load preserves conversation history`. Evidence: `E2E=1 E2E_RUNTIMES=claude deno test -A --no-check e2e/acp_resume_e2e_test.ts`.)*

- [ ] **Degradation diagnostics — complete the silent-drop list** —
  `collectDegradedOptions` flags every field that ACP cannot carry
  losslessly: existing four (`allowedTools`, `disallowedTools`,
  `settingSources`, `systemPrompt`) PLUS `agent`,
  `systemPromptFile`, `streamStallTimeoutSeconds`, `streamLogPath`,
  `onOutput`, `verbosity`, and `resumeSessionId` (only when the
  pilot does NOT advertise `loadSession`). Each entry carries a
  one-sentence `reason`. The helper's caller surface
  (`reportDegradedOptions` in `adapter.ts`) stays unchanged.
  *(FR-L39. Test: `runtime/acp/mapping_test.ts::collectDegradedOptions flags every silently-dropped field`. Evidence: `deno test -A --no-check runtime/acp/`.)*

- [x] **`hooks.onInit.model` populated on ACP path** — `handshake`
  fires `opts.hooks?.onInit?.({runtime, sessionId, model: opts.model})`.
  When `opts.model` is `undefined`, the field stays absent (matches
  CLI behaviour when the runtime didn't disclose a model).
  *(FR-L17. Test: `runtime/acp/adapter_test.ts::onInit fires with model from opts on ACP path`. Evidence: `deno test -A --no-check runtime/acp/`.)*

- [x] **`fetchCapabilitiesSlow` advertised + wired on ACP** —
  pilot `*_ACP_CAPABILITIES` vectors set
  `capabilityInventory: true`. The existing
  `adapter.fetchCapabilitiesSlow(opts)` already passes
  `opts.transport` through `(inner) => this.invoke(inner)`, so the
  ACP path is reachable without any per-adapter edit other than the
  capability flag. Cursor stays untouched (still `pilot: false`).
  *(FR-L20. Test: `runtime/transport_capabilities_test.ts::ACP pilots advertise capabilityInventory: true`. Evidence: `deno test -A --no-check runtime/`.)*

- [x] **`fetchCapabilitiesSlow` real-binary e2e (Claude only)** —
  one Claude ACP call returns a non-empty `CapabilityInventory`
  (`skills.length >= 1 || commands.length >= 1`). Gated by `E2E=1`.
  *(FR-L20. Test: `e2e/acp_capabilities_e2e_test.ts::fetchCapabilitiesSlow returns non-empty inventory under ACP`. Evidence: `E2E=1 E2E_RUNTIMES=claude deno test -A --no-check e2e/acp_capabilities_e2e_test.ts`.)*

- [ ] **`deno task check` green** (fmt, lint, type check, full
  test suite, doc-lint, `deno publish --dry-run`). *(FR-L17 + FR-L19 + FR-L20 + FR-L39. Test: implicit. Evidence: `deno run -A scripts/check.ts`.)*

- [ ] **SRS / SDS / `runtime/CLAUDE.md` reflect the new behaviour** —
  FR-L17 acceptance gains an "ACP path populates `info.model`" bullet;
  FR-L19 gains an "ACP path honours `resumeSessionId` via
  `session/load` when pilot advertises `loadSession`" bullet;
  FR-L20 gains an "ACP path advertises `capabilityInventory: true`"
  bullet; FR-L39 gains a "complete `degradedOptions` field list"
  bullet plus an ACP-resume sub-bullet. `runtime/CLAUDE.md` "ACP
  transport" paragraph picks up the resume / capability-inventory
  / degradedOptions deltas.
  *(FR-L17 + FR-L19 + FR-L20 + FR-L39. Test: `manual — korchasa` (doc review). Evidence: `git diff documents/requirements.md documents/design.md runtime/CLAUDE.md` in the same commit.)*

## Solution

Three sequenced commits inside this single task file, ordered
**smallest blast radius first** so each `deno task check` failure
narrows the suspect surface. Each commit ends on a green check;
Step 4 (final verify) reruns the full pipeline.

### Step 0 — Baseline gate

`deno task check` on the parent revision MUST be green. If the
baseline is red, stop and report — do NOT layer changes on top of
pre-existing failures (FR-L<N> diagnostics ambiguity rule from
`CLAUDE.md::TDD Flow`).

### Step 1 — `degradedOptions` completeness + `onInit.model`

Pure refactor of `runtime/acp/mapping.ts` + a one-line addition in
`runtime/acp/adapter.ts:handshake`. No protocol changes, no new
wire-calls. Lands first because it is the lowest-risk slice and
unlocks the resume work (Step 2 needs the new `resumeSessionId`
diagnostic entry).

**RED** — write the failing tests first:

1. `runtime/acp/mapping_test.ts::collectDegradedOptions flags every
   silently-dropped field` — supply an `opts` carrying every new
   field; assert `result` contains an entry for each, keyed by
   `field`. Coverage table (one assertion per row):
   - `agent: "researcher"` → `{field: "agent", reason: "ACP has no agent selector; …"}`
   - `systemPromptFile: "/tmp/x"` → `{field: "systemPromptFile", reason: "ACP has no separate system slot; …"}`
   - `streamStallTimeoutSeconds: 60` → `{field: "streamStallTimeoutSeconds", reason: "ACP transport has no stream-stall watchdog (FR-L36); …"}`
   - `streamLogPath: "/tmp/log"` → `{field: "streamLogPath", reason: "ACP transport emits no per-line log file; …"}`
   - `onOutput: () => {}` → `{field: "onOutput", reason: "ACP carries JSON-RPC frames, not raw output lines; …"}`
   - `verbosity: "debug"` → `{field: "verbosity", reason: "ACP has no formatter detail level; …"}`
2. `runtime/acp/adapter_test.ts::onInit fires with model from opts on
   ACP path` — supply `opts.model = "claude-haiku-4-5-20251001"` +
   `hooks.onInit = (info) => captured.push(info)`; assert
   `captured[0]` is `{runtime: "claude", sessionId: …, model:
   "claude-haiku-4-5-20251001"}`.

**GREEN** — implement:

1. `runtime/acp/mapping.ts:collectDegradedOptions` — widen the
   `Pick<...>` type to include the six new fields; append six
   conditional `if` blocks emitting `degradedOptions` entries. Order
   matches the field declaration order in `RuntimeInvokeOptions` for
   maintainer readability. Each `reason` string stays one sentence
   (≤ 100 chars).
2. `runtime/acp/adapter.ts:handshake` (line ~554) — change
   `opts.hooks?.onInit?.({ runtime, sessionId })` →
   `opts.hooks?.onInit?.({ runtime, sessionId, ...(opts.model ?
   { model: opts.model } : {}) })`. Spread keeps `model` field
   absent when unset (matches CLI behaviour, per
   `RuntimeInitInfo.model?: string`).

**CHECK**: `deno task check`. Watch:
- `runtime/acp/mapping_test.ts` for byte-stable assertions on the
  existing four fields (new entries must be additive — no reorder).
- Existing `e2e/lifecycle_hooks_e2e_test.ts` stays green (CLI path
  untouched).

Commit: `feat(runtime): degradedOptions completeness + onInit.model on ACP (FR-L17 + FR-L39)`.

### Step 2 — Resume via `session/load`

The functional core. Touches `runtime/acp/adapter.ts:handshake` and
one new e2e file. Re-uses `buildSessionNewParams` because
`session/load` and `session/new` share the same `{cwd, mcpServers}`
sub-shape — `session/load` only adds `sessionId`.

**RED** — write the failing tests first:

1. `runtime/acp/adapter_test.ts::invokeViaAcp drives session/load
   when resumeSessionId set and pilot advertises loadSession
   capability` — extend the existing stub `HANDSHAKE_SCRIPT` to:
   - return `{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}`
     from `initialize`;
   - handle `session/load` (respond `{"sessionId":"sess-resumed"}`,
     log the request id);
   - assert the recorded method sequence is
     `initialize → session/load → session/set_mode → session/prompt`
     (NOT `session/new`).
2. `runtime/acp/adapter_test.ts::invokeViaAcp falls back to
   session/new + emits degraded option when pilot does NOT advertise
   loadSession` — stub returns
   `agentCapabilities: {}` (no `loadSession` field); supply
   `opts.resumeSessionId + onCallbackError`; assert one
   `onCallbackError` call carrying source `"onEvent"` and message
   matching `/resumeSessionId/`.
3. `e2e/acp_resume_e2e_test.ts::resume via session/load preserves
   conversation history` — under `E2E=1 + e2eAcpEnabled("claude")`:
   - open session, send `"Remember the number 42 for me."`, wait
     for `SYNTHETIC_TURN_END`, capture `sessionId`, abort.
   - open second session with `resumeSessionId: <captured>`, send
     `"What number did I just ask you to remember?"`, collect text
     content, assert `/42/.test(joinedText)`.
   - Pin `model: "claude-haiku-4-5-20251001"` for cost.
   - 90-s ceiling via `AbortController.abort("ceiling-90s")`.

**GREEN** — implement:

1. `runtime/acp/adapter.ts:handshake` — capture
   `initialize` response, read `result.agentCapabilities?.loadSession`
   into a `loadSessionSupported` boolean. Currently the call is
   `await client.request("initialize", …)` and the result is
   discarded; switch to `const initRes = await
   client.request<{agentCapabilities?: {loadSession?: boolean}}>(...)`.
2. When `opts.resumeSessionId && loadSessionSupported` — call
   `client.request<SessionNewResult>("session/load",
   {sessionId: opts.resumeSessionId, ...buildSessionNewParams(...)})`.
   Otherwise call `session/new` as today.
3. When `opts.resumeSessionId && !loadSessionSupported` — push one
   entry into the `degradedOptions` list returned by
   `collectDegradedOptions`. Refactor the helper signature: accept
   a second optional `{loadSessionSupported?: boolean}` arg and
   gate the new entry on it. This keeps the helper pure (no I/O
   on the wire — `handshake` owns the gate read and passes it in).
4. The follow-up `session/set_mode` / `session/set_config_option`
   path applies identically regardless of new vs. resumed.

**REFACTOR**: keep `handshake`'s public signature
(`Promise<{sessionId: string}>`) — internal sequencing changes
only. Update the `runtime/CLAUDE.md` "ACP transport" paragraph
to describe the resume gate.

**CHECK**: `deno task check` + `E2E=1 E2E_RUNTIMES=claude deno task
e2e:claude` (the new resume e2e fires only here). The stub-driven
tests run under `deno task check`.

Commit: `feat(runtime): resume via session/load on ACP (FR-L19 + FR-L39)`.

### Step 3 — Advertise `capabilityInventory: true` on ACP pilots

The cheapest of the three. Existing `fetchCapabilitiesSlow`
implementations already pass `(inner) => this.invoke(inner)`, so the
ACP path is reachable without per-adapter logic changes. Only the
capability flag needs to flip on the three pilot vectors.

**RED**:

1. `runtime/transport_capabilities_test.ts::ACP pilots advertise
   capabilityInventory: true` — assert
   `claudeRuntimeAdapter.capabilitiesFor("acp").capabilityInventory
   === true` and the same for `codex` / `opencode`. Cursor stays
   throwing.
2. `runtime/acp/capability_inventory_test.ts::fetchCapabilitiesSlow
   routes through invokeViaAcp under transport: "acp"` — stub-driven
   integration test. Spawns a PATH-overridden `npx` stub that
   responds to `initialize` / `session/new` / `session/prompt` and
   embeds a hardcoded JSON inventory in the `session/update`
   `agent_message_chunk` content. Asserts the returned
   `CapabilityInventory` matches the embedded data — proves
   `FetchCapabilitiesOptions.transport` actually plumbs through to
   `invokeViaAcp` (not just advertised in the capability vector).
3. `e2e/acp_capabilities_e2e_test.ts::fetchCapabilitiesSlow returns
   non-empty inventory under ACP` — under `E2E=1 +
   e2eAcpEnabled("claude")`: call
   `adapter.fetchCapabilitiesSlow({cwd: Deno.cwd(), transport:
   "acp", ...})` and assert
   `inv.skills.length + inv.commands.length > 0`. Pin model +
   ceiling as in Step 2.

**Wait** — `fetchCapabilitiesSlow` doesn't accept a `transport`
field today; it takes `FetchCapabilitiesOptions`. Verify the type
in `runtime/capabilities.ts` and `runtime/adapter-types.ts:392`.
If absent, plumb `transport?: TransportOption` through
`FetchCapabilitiesOptions` so the e2e can target ACP. (Likely
needed; falling back to `inner.transport = "acp"` inside the
adapter is cleaner than threading a separate flag.)

**GREEN** — implement:

1. Flip `capabilityInventory: true` in `CLAUDE_ACP_CAPABILITIES`,
   `CODEX_ACP_CAPABILITIES`, `OPENCODE_ACP_CAPABILITIES`.
2. Thread `transport?: TransportOption` through
   `FetchCapabilitiesOptions` (add the field;
   `fetchInventoryViaInvoke` already accepts the `opts` object
   verbatim and feeds it into the adapter's `invoke`). Verify the
   plumbing: `fetchInventoryViaInvoke` MUST forward
   `opts.transport` into the `RuntimeInvokeOptions` passed to the
   captured `invoke` callback — grep the helper, confirm or add
   the spread.
3. `extraArgs` schema flags must be suppressed under ACP. Either:
   (a) skip the `extraArgs?` shape in `fetchInventoryViaInvoke`
   when `opts.transport === "acp"` (cleanest); or (b) document
   that they land in `degradedOptions` as extraArgs noise (cheap
   but adds an unhelpful entry per call). Pick (a).
4. No adapter edits beyond the capability flag — the
   `(inner) => this.invoke(inner)` callback already honours
   `inner.transport === "acp"` via the per-adapter ACP dispatch
   guard.

**CHECK**: `deno task check` + `E2E=1 E2E_RUNTIMES=claude deno task
e2e:claude`. The stub-driven test in
`runtime/transport_capabilities_test.ts` runs under the default
pipeline.

Commit: `feat(runtime): advertise capabilityInventory on ACP pilots (FR-L20 + FR-L39)`.

### Step 4 — Doc sync + final verify

Edits land in the same commit as Step 3 (or a separate doc commit
if Step 3's diff grows past ~150 LoC of code):

1. **SRS** (`documents/requirements.md`):
   - FR-L17 acceptance — add bullet
     `[ ] ACP path populates info.model from opts.model when set. Evidence: runtime/acp/adapter_test.ts::onInit fires with model from opts on ACP path.`
   - FR-L19 acceptance — add bullet
     `[ ] ACP transport honours resumeSessionId via session/load when the pilot advertises agentCapabilities.loadSession; falls back to session/new + a degradedOptions entry otherwise. Evidence: runtime/acp/adapter_test.ts (stub) + e2e/acp_resume_e2e_test.ts (real-binary).`
   - FR-L20 acceptance — add bullet
     `[ ] ACP pilots advertise capabilities.capabilityInventory: true on capabilitiesFor("acp"). fetchCapabilitiesSlow routes through invokeViaAcp transparently. Evidence: runtime/transport_capabilities_test.ts + e2e/acp_capabilities_e2e_test.ts.`
   - FR-L39 acceptance — add bullet
     `[ ] collectDegradedOptions covers every silently-dropped field on the ACP path (agent, systemPromptFile, streamStallTimeoutSeconds, streamLogPath, onOutput, verbosity, resumeSessionId-when-not-supported). Evidence: runtime/acp/mapping_test.ts::collectDegradedOptions flags every silently-dropped field.`
2. **SDS** (`documents/design.md`) — extend the "ACP transport"
   subsection with one short paragraph per delta (resume gate,
   `onInit.model`, capability-inventory routing). Honour the
   project's compressed-style rule.
3. **`runtime/CLAUDE.md`** — extend the "ACP transport (FR-L39
   pilots)" bullet with the resume gate sentence + the new
   `degradedOptions` coverage.
4. **`runtime/AGENTS.md`** — module-level map. Check the "ACP
   transport" subsection (if present); add resume + capability
   inventory bullets so the module-local guide stays in sync
   with `runtime/CLAUDE.md`. If no ACP subsection exists yet,
   add a short one referencing the SRS / SDS entries.
5. Run the full pipeline: `deno run -A scripts/check.ts`.

Commit message footer for the Step 3 (or doc) commit MAY include
the chained FR list — the three implementation commits stay
single-FR-focused for clean `git log` grouping.

### Files to create

- `e2e/acp_resume_e2e_test.ts`
- `e2e/acp_capabilities_e2e_test.ts`
- `runtime/acp/capability_inventory_test.ts` — stub-driven
  integration probe for `fetchCapabilitiesSlow({transport:"acp"})`.

### Files to modify

- `runtime/acp/adapter.ts` — `handshake` reads `agentCapabilities`,
  routes `session/load` vs `session/new`, populates `onInit.model`.
- `runtime/acp/mapping.ts` — `collectDegradedOptions` widened
  signature + 7 new entries (6 new fields + conditional
  `resumeSessionId`).
- `runtime/acp/mapping_test.ts` — extend coverage table.
- `runtime/acp/adapter_test.ts` — 3 new cases (session/load happy
  path; session/load fallback; onInit.model).
- `runtime/claude-adapter.ts`, `runtime/codex-adapter.ts`,
  `runtime/opencode-adapter.ts` — flip
  `capabilityInventory: true` in the `*_ACP_CAPABILITIES` vectors.
- `runtime/transport_capabilities_test.ts` — extend pilot
  assertions.
- `runtime/capabilities.ts` / `runtime/adapter-types.ts` — thread
  `transport?: TransportOption` through
  `FetchCapabilitiesOptions`.
- `documents/requirements.md` — 4 acceptance bullets (one per FR).
- `documents/design.md` — ACP transport subsection delta.
- `runtime/CLAUDE.md` — ACP transport bullet delta.
- `runtime/AGENTS.md` — module-level ACP subsection (or
  delta if it already exists).

### Files NOT to touch

- `runtime/acp/client.ts` — JSON-RPC core stays untouched; the
  new wire call uses the same `client.request(method, params)`
  surface.
- `runtime/acp/content.ts`, `runtime/acp/permissions.ts`,
  `runtime/acp/fronts.ts` — unchanged.
- Cursor adapter / e2e — out of scope.
- `mod.ts` / `runtime/index.ts` — no new public exports
  (FetchCapabilitiesOptions field is additive; type re-exported
  by existing barrels).

### Risks (named, with mitigations)

- **`session/load` parameter mismatch across pilots.** The 0.22.1
  schema is authoritative for Claude (verified); Codex / OpenCode
  don't advertise the capability so they fall through to
  `session/new` + `degradedOptions`. Mitigation: capability gate
  is the single source of truth, no per-pilot if-tree. If a
  future Codex / OpenCode bump opts in, no adapter code change
  needed.
- **Schema version vs implementation drift.** Schema 0.22.1
  describes `session/load`, but our pinned `claude-agent-acp@0.37.0`
  speaks `protocolVersion: 1`. The empirical check
  (`dist/acp-agent.js:loadSession` + `agentCapabilities.loadSession
  = true`) confirms 0.37.0 implements the same shape. Mitigation:
  the resume e2e is the structural canary — if 0.37.0 diverges
  from the schema, the e2e fails immediately and we pin a
  different version or downgrade resume to degraded.
- **Real-binary resume e2e flake.** Claude may "forget" the number
  even with resume — depends on model behaviour, not transport.
  Mitigation: phrase the recall prompt explicitly ("What number
  did I just ask you to remember?") and assert on substring match
  not equality. Re-run under three different seeds during initial
  development (manual one-off, not in DoD) to confirm stability.
- **`FetchCapabilitiesOptions.transport` plumbing breaks existing
  callers.** New field is optional — backwards-compatible by
  construction. JSR slow-types: re-run `deno publish --dry-run`
  in Step 4.
- **`degradedOptions` consumer growth.** Adding 6+ entries to a
  list a consumer iterates may flood `onCallbackError`. Mitigation:
  each entry is gated on the consumer actually setting the field;
  a typical config touches 0–2 of these. Acceptable.
- **`onInit.model` mismatch with effective model.** If
  `session/set_config_option` rejects the requested model (unknown
  to the front), the front uses its default but we still surface
  `opts.model` in `onInit`. Mitigation: documented as
  best-effort. Future enhancement: parse the front's reply to
  `session/set_config_option` for the effective value — not in
  scope here.



## Follow-ups

Items genuinely blocked on external triggers — NOT in DoD, recorded
here so the next reviewer can pick them up when the trigger fires:

- **Cursor ACP pilot promotion.** Out of scope per the user's
  framing ("кроме cursor"). Stays tracked under
  `acp-followups.md::Follow-ups`.
- **`RuntimeErrorKind: "max_turn_requests"` as first-class kind.**
  Stays tracked under `acp-followups.md::Follow-ups` — promotion
  waits on consumer demand.
- **`session/set_model` mid-session.** ACP 0.22.1 schema declares
  it; consumers wanting to swap the model on a live session without
  reopening can adopt it once a consumer asks. Today the library's
  contract says model is bound at spawn (see `RuntimeSessionOptions`
  "Out of scope" block); revisiting requires a deliberate FR-L19
  amendment.
- **`session/resume` (distinct from `session/load`).** The 0.22.1
  schema declares both. `loadSession` re-hydrates a stored session;
  `resumeSession` continues an interrupted streaming turn. The
  library's contract is "reopen with `resumeSessionId`", which maps
  cleanly to `loadSession`. Pure `session/resume` would need a new
  neutral API surface and is not yet justified by a consumer.
- **`onCallbackError` source string accuracy.** `reportDegradedOptions`
  currently passes source `"onEvent"` to `onCallbackError`; semantically
  `"acp"` (or a new `"acp-degradation"`) would be cleaner. A small
  refactor; not blocking on this task — pick up when another caller
  asks for a typed source enum.
