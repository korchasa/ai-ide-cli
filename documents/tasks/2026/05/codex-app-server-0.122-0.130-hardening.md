---
date: 2026-05-17
status: to do
implements:
  - FR-L13
  - FR-L26
tags: [codex, app-server, events, hardening]
related_tasks: [codex-ban-full-auto-flag, codex-flag-placement-audit, codex-reasoning-token-usage]
---
# Codex: Harden App-Server Adapter Against 0.122–0.130 Protocol Drift

## Goal

Keep the typed `codex app-server` adapter forward-compatible with Codex
CLI releases `rust-v0.122.0` → `rust-v0.130.0`, where the JSON-RPC v2
protocol surface gained multi-environment metadata, per-turn `cwd` /
environment selection, sticky-environment params, and `ThreadStore`-
backed thread payloads (rollout file path no longer guaranteed).
Unknown notification variants must drop into a typed permissive
fallback path rather than crash the session.

## Overview

### Context

Codex `rust-v0.122.0` (2026-03) — `rust-v0.130.0` (2026-04-30)
expanded the app-server protocol:

- 0.122: unix-socket transport, pagination-friendly resume/fork,
  sticky environments, remote thread config/store plumbing
  (#18255, #18892, #18897, #18908, #19008, #19014).
- 0.124: sessions managing multiple environments, per-turn
  environment + cwd selection (#18401, #18416).
- 0.128: external agent session import, MultiAgentV2 thread caps,
  sandbox CLI profile selection (#19895, #19360, #20117).
- 0.130: pagination of large threads (summary / full views), live
  config reload, `view_image` through selected environment
  (#21566, #21187, #21143).

Upstream release notes:
- https://github.com/openai/codex/releases/tag/rust-v0.122.0
- https://github.com/openai/codex/releases/tag/rust-v0.124.0
- https://github.com/openai/codex/releases/tag/rust-v0.128.0
- https://github.com/openai/codex/releases/tag/rust-v0.130.0

GitHub issue #10.

### Current State

- `codex/events.ts` types `CodexNotification` discriminated union with
  `[key: string]: unknown` forward-compat absorber on every params
  variant. Multi-env / per-turn cwd / sticky-env fields are absorbed
  but **not first-class typed** — consumers needing them re-cast.
- `codex/app-server.ts` `CodexAppServerClient` returns the runtime
  `CodexUntypedNotification` iterator. `isCodexNotification` returns
  `false` for unknown methods → consumers fall back to raw access on
  `note.params` (`Record<string, unknown>`). Forward-compat at the
  *transport* layer works, but is not codified by a test.
- `codex/session.ts` `startThread` / `resumeThread` read
  `result.thread.id` from the `thread/start` / `thread/resume`
  responses. Codex 0.122+ `ThreadStore`-backed payloads still expose
  `thread.id` but may omit a local rollout file path field — the
  session does not currently access rollout fields, so no crash today,
  but the contract is not pinned.
- `codex/app-server_test.ts` does NOT exist — `app-server.ts` is
  covered transitively via `session_test.ts` only.
- SRS FR-L26 lists every variant the union narrows on; permissive-
  fallback rule for unknown methods is implicit (no explicit Acceptance
  bullet).

### Constraints

- Public `RuntimeSession` / `CodexNotification` shape stays stable
  (FR-L19, FR-L26). Adding *optional* fields is additive and
  backwards-compatible; renaming / removing existing fields is not
  allowed.
- Library must keep working on `codex-cli >= 0.121.0` (FR-L26
  declared range) up to the latest 0.130.x — new fields stay
  optional, unknown variants must not throw.
- No `~/` mutation, no sandbox staging (AGENTS.md).
- TDD baseline (`NO_COLOR=1 deno task check` green before edits).
- Cannot rely on a locally-installed Codex 0.122–0.130 binary for
  schema verification — work from upstream release notes + generated
  TS bindings in `codex app-server generate-ts --experimental`.
  Where a field is best-effort, mark it as such in JSDoc (matches
  the existing `CodexResponseProcessedParams` convention).

## Definition of Done

- [ ] FR-L26: `codex/events.ts` defines optional first-class fields
      for multi-environment selection (`environmentId?: string`,
      per-turn `cwd?: string`) on `CodexTurn`,
      `CodexTurnStartedParams`, and sticky-env metadata
      (`stickyEnvironment?: boolean`) on `CodexThreadStartedParams`.
      Test paths: `codex/events_test.ts::"multi-env fields parsed on
      turn"`, `codex/events_test.ts::"sticky-env field parsed on
      thread"`. Evidence: `NO_COLOR=1 deno task test
      codex/events_test.ts`.
- [ ] FR-L26: Unknown notification methods land on a typed permissive
      fallback (`CodexUntypedNotification`) — no exception, no silent
      drop. Test path: `codex/events_test.ts::"unknown variant
      produces fallback event"`. Evidence: `NO_COLOR=1 deno task test
      codex/events_test.ts`.
- [ ] FR-L13: `codex/app-server.ts` `NotificationQueue` tolerates
      `thread/started` notifications without a `rolloutPath` field
      (ThreadStore-backed). Test path:
      `codex/app-server_test.ts::"thread without rollout path"`.
      Evidence: `NO_COLOR=1 deno task test codex/app-server_test.ts`.
- [ ] FR-L13: Cross-runtime session contract passes for Codex. Test
      path: `runtime/session_contract_test.ts` (Codex slice).
      Evidence: `NO_COLOR=1 deno task test runtime/session_contract_test.ts`.
- [ ] FR-L13: Real-binary smoke confirms session works against
      installed `codex` 0.122+ for `permissionMode: "plan"` and
      `permissionMode: undefined`. Test path:
      `e2e/session_matrix_e2e_test.ts` (Codex slice). Evidence:
      `E2E=1 E2E_RUNTIMES=codex NO_COLOR=1 deno task e2e:codex`.
- [ ] SRS `### 3.26 FR-L26` Acceptance updated with the permissive-
      fallback rule and the multi-env / sticky-env field set.
      Evidence: `grep -n "unknown variant\|environmentId\|stickyEnvironment"
      documents/requirements.md`.
- [ ] SDS `§3.11 codex/app-server.ts` and the FR-L26 paragraph
      reflect the new optional fields and the permissive-fallback
      contract. Evidence:
      `grep -n "permissive fallback\|environmentId\|stickyEnvironment"
      documents/design.md`.
- [ ] Final check: `NO_COLOR=1 deno task check` exits 0.

## Solution

Variant A — typed optional fields + codified permissive fallback.

### Files

- Edit `codex/events.ts`:
  - On `CodexTurn` add `environmentId?: string`, `cwd?: string`
    (per-turn execution environment + working directory, Codex 0.124
    multi-environment). JSDoc each as "best-effort, schema mirrored
    from upstream release notes — re-run `codex app-server
    generate-ts --experimental` to refresh".
  - On `CodexThreadStartedParams` add `environmentId?: string`
    (default env id) and `stickyEnvironment?: boolean` (0.122 sticky-
    environment marker).
  - On `CodexTurnStartedParams` add `environmentId?: string`,
    `cwd?: string` (per-turn selection from 0.124).
  - Leave the `[key: string]: unknown` passthrough on each interface
    untouched.
  - Update the module-level JSDoc to note the multi-env / sticky-env
    additions (one short paragraph).
- Edit `codex/events_test.ts`:
  - Add Deno.test `"multi-env fields parsed on turn"`: construct a
    `CodexUntypedNotification` for `turn/started` with `environmentId`
    + `cwd` set; assert typed access without casts after
    `isCodexNotification` narrows.
  - Add Deno.test `"sticky-env field parsed on thread"`: construct a
    `CodexUntypedNotification` for `thread/started` with
    `stickyEnvironment: true` + `environmentId: "env-1"`; assert
    typed access after narrow.
  - Add Deno.test `"unknown variant produces fallback event"`:
    construct a `CodexUntypedNotification` with method
    `"future/method/not-yet-typed"`, assert `isCodexNotification`
    returns `false` for every known method literal AND that the raw
    `note.method` + `note.params` remain readable (this codifies the
    permissive-fallback contract).
- Create `codex/app-server_test.ts`:
  - One Deno.test `"thread without rollout path"`: import
    `NotificationQueue` from `./app-server-internals.ts`, push a
    `{method: "thread/started", params: {threadId: "T1"}}`
    notification (no `rolloutPath` field), iterate the queue, assert
    the notification round-trips intact, then `close()` and assert
    the iterator terminates. Pure Deno — no subprocess, no bash
    stubs. Codifies that the transport queue is field-agnostic on
    ThreadStore-backed payloads.
- Edit `documents/requirements.md`:
  - Keep the existing `CodexAppServerNotification continues to type …`
    bullet unchanged. Append two new sibling bullets under
    `### 3.26 FR-L26 Acceptance`:
    1. "Unknown notification methods land on `CodexUntypedNotification`
       — `isCodexNotification` returns `false`, raw `method` + `params`
       stay readable, no exception thrown. Evidence:
       `codex/events_test.ts::"unknown variant produces fallback event"`."
    2. "Multi-env / sticky-env optional fields typed on `CodexTurn`,
       `CodexThreadStartedParams`, `CodexTurnStartedParams` (Codex
       0.122/0.124). Schema mirrored from upstream release notes;
       absent fields stay `undefined`. Evidence:
       `codex/events_test.ts::"multi-env fields parsed on turn"`,
       `codex/events_test.ts::"sticky-env field parsed on thread"`."
- Edit `documents/design.md`:
  - In `§3.11 codex/app-server.ts → FR-L26 typed events`, add one
    short paragraph after the variant list: "Permissive fallback:
    unknown methods stay on `CodexUntypedNotification`; consumer
    receives `method` + `params` verbatim. The library never throws
    on an unknown method.". Add a one-line note on the multi-env /
    sticky-env optional fields.

### Approach

1. RED for events typing: write the events_test additions; expect
   compile errors on `environmentId` / `cwd` / `stickyEnvironment`
   typed access until `events.ts` is edited.
2. GREEN for events typing: add optional fields to `events.ts`.
3. RED for fallback test: assert raw access on unknown method (no
   compile error needed — it tests runtime semantics; should pass
   already, codifying the contract).
4. RED for app-server test: write the bash-stub `thread/started`
   test. Verify it actually exercises `NotificationQueue` (not just
   the JSON-RPC `result` path).
5. GREEN: no implementation change expected — `NotificationQueue`
   already tolerates missing fields. If the test fails, harden
   `handleLine` / `NotificationQueue.push` to skip on missing
   `method`.
6. REFACTOR: tighten JSDoc on the new optional fields; ensure
   `// FR-L26` traceability comment near the multi-env fields and
   `// FR-L13` near the rollout-path tolerance.
7. SRS + SDS edits.
8. CHECK: `NO_COLOR=1 deno task check` (fmt, lint, type, tests,
   doc-lint, publish dry-run).

### Verification

- `NO_COLOR=1 deno task test codex/events_test.ts`
- `NO_COLOR=1 deno task test codex/app-server_test.ts`
- `NO_COLOR=1 deno task test runtime/session_contract_test.ts`
- `NO_COLOR=1 deno task check`
- (Out-of-CI) `E2E=1 E2E_RUNTIMES=codex NO_COLOR=1 deno task e2e:codex`
  — manual, requires installed `codex` binary.

### Out-of-scope (follow-ups)

- Regenerating the FULL TS bindings via `codex app-server
  generate-ts --experimental` once a 0.130 binary is locally
  available — not a blocker for this task.
- Pagination of large threads (0.130 summary / full views) — separate
  surface, not in the notification union.
- 0.124 `view_image` item type — separate `CodexThreadItem` variant,
  out of scope (no consumer dependency yet).

