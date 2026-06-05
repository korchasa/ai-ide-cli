---
date: "2026-06-06"
status: done
implements: [FR-L19, FR-L39]
tags: [acp, resume, session-load, capability-gate, fail-fast]
supersedes:
  - 2026/06/acp-parity-closeouts.md
related_tasks:
  - 2026/06/acp-parity-closeouts.md
  - 2026/06/acp-unsupported-option-error.md
  - 2026/05/acp-transport-poc.md
---

# ACP Transport — Resume via `session/load` (capability-gated)

> Variant **A** (two-phase validation) selected & implemented 2026-06-06.

## Goal

Make `transport: "acp"` honour `resumeSessionId` for pilots that
advertise `agentCapabilities.loadSession` (Claude 0.37.0 today) by
routing through ACP `session/load`, so consumers porting a stateful CLI
workload to ACP keep conversation continuity instead of silently losing
it. Pilots that do NOT advertise the capability keep failing fast.

## Overview

### Context

This is the high-value half of the resume gap originally scoped in
`acp-parity-closeouts.md` (item 1). That task predates
`acp-unsupported-option-error.md` (shipped 2026-06-06), which made
`resumeSessionId` on the ACP path throw `AcpUnsupportedOptionError`
**synchronously at adapter entry**, before `initialize`. The two plans
conflict; this task supersedes parity-closeouts for the resume concern
and is written against the **current** (post-fail-fast) code state.

Items 3 (`onInit.model`) and 4 (`capabilityInventory` on ACP) from
parity-closeouts already shipped separately (see that file's supersession
note). Item 2 (degradation-completeness) is obsolete — those fields now
throw by design. Only resume remains, and it needs real design work, not
a verbatim port.

### Current State

- `runtime/acp/mapping.ts:ACP_UNSUPPORTED_INVOKE_OPTIONS` /
  `ACP_UNSUPPORTED_SESSION_OPTIONS` list `resumeSessionId`. Adapter entry
  (`invokeViaAcp` / `openSessionViaAcp`) calls `collectUnsupportedOptions`
  and throws `AcpUnsupportedOptionError` synchronously **before**
  `spawnClient` — so the `loadSession` capability (only known after
  `initialize`) is not yet available at the current throw site.
- `runtime/acp/handshake.ts:handshake` calls `session/new`
  unconditionally and currently discards the `initialize` response.
- `buildSessionNewParams` already produces the `{cwd, mcpServers}`
  sub-shape `session/load` needs (`session/load` only adds `sessionId`).

Empirical capability gates (pinned cache):

- `claude-agent-acp@0.37.0` returns `agentCapabilities.loadSession = true`
  and implements `loadSession(params)`.
- `@zed-industries/codex-acp@0.15.0` does NOT advertise `loadSession`.
- `opencode acp` capability is authoritative at runtime — no per-pilot
  hardcoding.

### The unresolved design tension (must be answered in the plan)

The newer fail-fast design throws at **adapter entry, before spawn**.
Capability-gated resume needs the `loadSession` flag from the
`initialize` response, i.e. **after spawn**. Reconciling these is the
core decision. Candidate approaches to weigh in variant analysis:

1. **Move the `resumeSessionId` check past `initialize`.** Remove it from
   the synchronous unsupported tuple; in `handshake`, read
   `agentCapabilities.loadSession`; route `session/load` when `true`,
   throw `AcpUnsupportedOptionError` when `false`. Cost: the throw for
   non-supporting pilots moves from pre-spawn to post-spawn, changing the
   contract `acp-unsupported-option-error.md` just established (and its
   tests assert synchronous pre-spawn throw for `resumeSessionId`).
2. **Static per-pilot capability vector.** Keep the entry-time throw but
   gate `resumeSessionId` on a known-pilot table. Rejected by
   parity-closeouts' own constraint ("no per-pilot if-tree, no
   version-string sniffing") and risks drift if a pinned front version
   drops the capability.
3. **Two-phase validation.** Keep the cheap entry throw for fields that
   are unconditionally unsupported; carve `resumeSessionId` into a
   post-initialize gate only. Documents the timing split explicitly.

### Constraints

- **Capability gate is the single source of truth.** No version-string
  sniffing. `agentCapabilities.loadSession` from `initialize` decides.
- **`session/load` mirrors `session/new` params** (`{sessionId, cwd,
  mcpServers}`) — reuse `buildSessionNewParams`, no duplicate mapper.
- **Both `invokeViaAcp` AND `openSessionViaAcp` honour resume** (shared
  `handshake`).
- **Preserve fail-fast for non-supporting pilots** — codex/opencode keep
  throwing on `resumeSessionId`; do NOT silently degrade to `session/new`
  (that is exactly what `acp-unsupported-option-error.md` removed).
- **`handshake` public signature stays `Promise<{sessionId: string}>`.**
- **No JSON-RPC client core changes.**
- Real-binary e2e against Claude (only pilot with `loadSession: true`)
  proving history survives the reopen.

## Definition of Done

> Variant **A** (two-phase validation) selected 2026-06-06. The cheap
> entry-time throw stays for unconditionally-unsupported fields;
> `resumeSessionId` moves to a post-`initialize` capability gate inside
> `handshake`.

- [x] Reconcile the throw-timing tension — Variant **A** recorded in
      `## Solution`.
- [x] FR-L19: `resumeSessionId` removed from
      `ACP_UNSUPPORTED_INVOKE_OPTIONS` /
      `ACP_UNSUPPORTED_SESSION_OPTIONS` so entry-time
      `collectUnsupportedOptions` no longer throws on it. Test:
      `runtime/acp/mapping_test.ts::ACP_UNSUPPORTED_INVOKE_OPTIONS pins
      the invoke surface set`. Evidence:
      `deno test -A --no-check runtime/acp/mapping_test.ts`.
- [x] FR-L19: `handshake` reads `agentCapabilities.loadSession` from the
      `initialize` response; with `resumeSessionId` set it routes
      `session/load` (reusing `buildSessionNewParams` + `sessionId`) when
      `loadSession === true`, else throws
      `AcpUnsupportedOptionError(runtime, ["resumeSessionId"])`. Without
      `resumeSessionId` the `session/new` path is unchanged. Test:
      `runtime/acp/adapter_test.ts::invokeViaAcp routes resumeSessionId to
      session/load when loadSession advertised`,
      `runtime/acp/adapter_test.ts::invokeViaAcp throws when loadSession
      not advertised`. Evidence: `deno test -A --no-check runtime/acp/`.
- [x] FR-L19: `invokeViaAcp` propagates the post-init
      `AcpUnsupportedOptionError` (its `attemptInvocation` catch
      re-throws this class instead of wrapping it as an error result, and
      does NOT retry); `openSessionViaAcp` disposes the spawned client
      then rethrows. Test:
      `runtime/acp/adapter_test.ts::openSessionViaAcp throws when
      loadSession not advertised`. Evidence:
      `deno test -A --no-check runtime/acp/`.
- [x] FR-L19: existing `resumeSessionId` synchronous-throw tests updated
      to the post-init timing contract (the entry-throw test now stubs an
      `initialize` without `loadSession`; the multi-field and
      throw-precedes-warn tests drop `resumeSessionId` from the
      entry-time tuple expectations). Test: `runtime/acp/adapter_test.ts`,
      `runtime/acp/mapping_test.ts`. Evidence:
      `deno test -A --no-check runtime/acp/`.
- [x] FR-L19: `// FR-L19` traceability comments at the `handshake`
      load-routing + capability-gate sites and the `attemptInvocation`
      re-throw site.
- [x] FR-L19: real-binary e2e `e2e/acp_resume_e2e_test.ts` proves
      conversation history survives reopen on Claude (only pilot with
      `loadSession: true`). Gated `E2E=1` + `e2eAcpEnabled("claude")`.
      Test: `e2e/acp_resume_e2e_test.ts::acp resume via session/load
      preserves history on claude`. Evidence:
      `E2E=1 E2E_RUNTIMES=claude deno test -A --no-check e2e/acp_resume_e2e_test.ts`.
- [x] FR-L19: SRS `### 3.19 FR-L19` Acceptance gains a capability-gated
      ACP-resume bullet; SDS ACP section + `runtime/CLAUDE.md` document
      the post-init gate + `session/load` routing. Test:
      `manual — korchasa` (doc review). Evidence:
      `git diff documents/ runtime/CLAUDE.md`.
- [x] FR-L19: `documents/index.md` FR-L19 row present/updated. Test:
      `manual — korchasa`. Evidence: `grep -n "FR-L19" documents/index.md`.
- [x] `deno task check` green. Test: implicit. Evidence:
      `deno run -A scripts/check.ts`.

## Solution

Implement Variant **A — two-phase validation**. The entry-time
`collectUnsupportedOptions` throw is retained for every field that is
unconditionally unsupported on the ACP wire; `resumeSessionId` is the
sole field whose support depends on runtime-advertised capability, so it
moves to a dedicated gate inside `handshake`, immediately after the
`initialize` response (the only point where `agentCapabilities.loadSession`
is known).

### Files

Modified:

- `runtime/acp/mapping.ts` — remove `"resumeSessionId"` from
  `ACP_UNSUPPORTED_INVOKE_OPTIONS` and `ACP_UNSUPPORTED_SESSION_OPTIONS`;
  update the field-note JSDoc on `ACP_UNSUPPORTED_INVOKE_OPTIONS` to point
  at the new post-init gate. Type the `initialize` response
  (`AcpInitializeResult { agentCapabilities?: { loadSession?: boolean } }`).
- `runtime/acp/handshake.ts` — capture the `initialize` response; add
  `"resumeSessionId"` to the `opts` `Pick`; branch: `resumeSessionId` set
  → gate on `loadSession` (route `session/load` with
  `{...buildSessionNewParams(runtime, opts), sessionId: resumeSessionId}`
  when advertised, else `throw new AcpUnsupportedOptionError(runtime,
  ["resumeSessionId"])`); unset → unchanged `session/new`. Mode/config
  RPCs run over whichever response (load or new) as before. `// FR-L19`
  comments at the gate + routing sites. Import `AcpUnsupportedOptionError`
  from `./errors.ts` (leaf — no cycle).
- `runtime/acp/adapter.ts` — `attemptInvocation` catch: re-throw
  `AcpUnsupportedOptionError` before any error-result wrapping (so the
  post-init gate surfaces as a thrown error, not `{error}`; the `finally`
  still disposes the client). `openSessionViaAcp`: wrap the `handshake`
  call in try/`dispose`/rethrow so a post-init throw tears the spawned
  front down. `// FR-L19` comments at both sites.
- `runtime/acp/adapter_test.ts` — rewrite the entry-throw resume test to
  stub `initialize` without `loadSession` (post-init throw); fix the
  multi-field + throw-precedes-warn tests to drop `resumeSessionId` from
  entry-tuple expectations (use `strictMcpConfig` to keep the
  precede-warn invariant); add 2 new tests (invoke + session) for the
  `loadSession`-advertised `session/load` route and the not-advertised
  throw.
- `runtime/acp/mapping_test.ts` — drop `"resumeSessionId"` from the two
  tuple-pin assertions and the `collectUnsupportedOptions` invoke case.
- `documents/requirements.md` — FR-L19 Acceptance bullet; surgical
  `**Tasks:**` back-pointer.
- `documents/design.md` — ACP section note on the post-init resume gate.
- `documents/index.md` — FR-L19 row refresh.
- `runtime/CLAUDE.md` — ACP-transport bullet: capability-gated resume via
  `session/load` (claude only today; codex/opencode still throw).

Created:

- `e2e/acp_resume_e2e_test.ts` — opens an ACP session on Claude, sends a
  memorable fact, captures `sessionId`, disposes, reopens with
  `resumeSessionId`, asks the agent to recall the fact, asserts the reply
  references it. Gated by `E2E=1` + `e2eAcpEnabled("claude")`.

### Commit plan (single commit — one cohesive contract change)

1. **RED** — update `mapping_test.ts` tuple assertions (drop
   `resumeSessionId`) and add the two new adapter routing tests +
   rewrite the entry-throw test. Run `deno test -A --no-check
   runtime/acp/` → fails (resumeSessionId still in tuples, no routing).
2. **GREEN** — remove `resumeSessionId` from both tuples; add the
   `handshake` capability gate + `session/load` route; re-throw in
   `attemptInvocation`; dispose-and-rethrow in `openSessionViaAcp`.
   Re-run `runtime/acp/` tests → green.
3. **REFACTOR** — extract `buildSessionLoadParams` only if the inline
   spread reads poorly; otherwise inline. No behaviour change.
4. **DOCS** — SRS bullet, SDS note, index row, `runtime/CLAUDE.md`
   bullet, surgical `**Tasks:**` back-pointer.
5. **e2e** — write `e2e/acp_resume_e2e_test.ts` (gated; not in `check`).
6. **CHECK** — `deno run -A scripts/check.ts` green.

### Error-handling notes

- Post-init gate throws the SAME `AcpUnsupportedOptionError` class the
  entry-time path uses — consumers keep one `instanceof` check. Only the
  timing differs (post-spawn for `resumeSessionId`, pre-spawn for every
  other field). `attemptInvocation`'s re-throw preserves the thrown-error
  contract (not converted to `{error}`); the `finally` block guarantees
  the spawned client is disposed regardless.
- `loadSession` is read strictly as `=== true` — a missing or non-boolean
  field is treated as "not supported" (fail-closed), so codex/opencode
  (which omit it) keep throwing exactly as before, only later in the
  lifecycle.

## Follow-ups

- **`session/resume` (distinct from `session/load`).** ACP 0.22.1 declares
  both; `loadSession` re-hydrates a stored session, `resumeSession`
  continues an interrupted streaming turn. Out of scope until a consumer
  asks; the neutral contract is "reopen with `resumeSessionId`" → maps to
  `loadSession`.
- **`session/set_model` mid-session.** Tracked under `acp-followups.md`.
