---
date: "2026-06-06"
status: to do
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

> **Planning stub** — captures goal, context, and the unresolved design
> tension. Solution + variant selection deferred to a dedicated
> `/flowai:plan` session. Do NOT implement from this file as-is.

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

> Filled during the `/flowai:plan` session once a variant is selected.
> Placeholder acceptance below — do NOT treat as final.

- [ ] Reconcile the throw-timing tension (variant selected + recorded).
- [ ] `resumeSessionId` routes to `session/load` on pilots advertising
      `loadSession`; throws `AcpUnsupportedOptionError` otherwise.
      Test: `runtime/acp/adapter_test.ts` (stub: loadSession advertised
      vs not). Evidence: `deno test -A --no-check runtime/acp/`.
- [ ] `acp-unsupported-option-error.md` tests updated to match the new
      `resumeSessionId` timing contract (whatever variant decides).
- [ ] Real-binary e2e: `e2e/acp_resume_e2e_test.ts` proves conversation
      history survives reopen on Claude. Evidence:
      `E2E=1 E2E_RUNTIMES=claude deno test -A --no-check e2e/acp_resume_e2e_test.ts`.
- [ ] SRS FR-L19 acceptance + SDS ACP section + `runtime/AGENTS.md`
      updated. Evidence: `git diff documents/ runtime/AGENTS.md`.
- [ ] `deno task check` green.

## Solution

_Deferred — to be filled by `/flowai:plan` after variant selection._

## Follow-ups

- **`session/resume` (distinct from `session/load`).** ACP 0.22.1 declares
  both; `loadSession` re-hydrates a stored session, `resumeSession`
  continues an interrupted streaming turn. Out of scope until a consumer
  asks; the neutral contract is "reopen with `resumeSessionId`" → maps to
  `loadSession`.
- **`session/set_model` mid-session.** Tracked under `acp-followups.md`.
