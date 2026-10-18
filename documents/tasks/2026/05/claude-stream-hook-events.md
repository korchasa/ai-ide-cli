---
date: "2026-05-17"
status: done
implements: [FR-L25]
tags: [claude, stream-json, hooks, effort, 2.1.133]
related_tasks: []
---

# Claude: Type system.hook_started / hook_response Stream Events

GitHub issue: <https://github.com/korchasa/ai-ide-cli/issues/8>.

## Goal

Type the two new `system.hook_started` / `system.hook_response`
subtypes that Claude Code 2.1.133+ emits on the stream-json output, so
consumers narrowing `ClaudeStreamEvent` get typed access to hook
lifecycle (hook id/name/event, stdout/stderr/exit_code/outcome). At
the same time, document — in SRS FR-L25 and SDS — that the v2.1.133
`effort.level` and `$CLAUDE_EFFORT` channels are a **sidecar**
hook-stdin / subprocess-env contract, not stream-json fields, so the
library cannot directly observe drift between the requested
`reasoningEffort` and any mid-session picker override. The honest
acceptance surface is the typed event union, not a synthetic
round-trip test.

## Overview

### Context

Issue #8 was filed against the v2.1.133 release-note bullet:

> Hooks now receive the active effort level via the `effort.level`
> JSON input field and the `$CLAUDE_EFFORT` environment variable,
> and Bash tool commands can read `$CLAUDE_EFFORT`.

Empirical capture against installed `claude` v2.1.143
(`claude -p … --output-format stream-json --verbose --effort low`):

- `system/init` does NOT contain `effort.level` (fields exposed:
  `cwd`, `session_id`, `tools`, `mcp_servers`, `model`, `permissionMode`,
  `slash_commands`, `apiKeySource`, `claude_code_version`, `output_style`,
  `agents`, `skills`, `plugins`, `analytics_disabled`, `uuid`,
  `fast_mode_state`).
- Stream-json DOES emit two new subtype variants the library does not
  yet narrow:
  - `{type:"system", subtype:"hook_started", hook_id, hook_name,
    hook_event, uuid, session_id}`
  - `{type:"system", subtype:"hook_response", hook_id, hook_name,
    hook_event, output, stdout, stderr, exit_code, outcome, uuid,
    session_id}`
- `effort.level` lives in the hook's stdin JSON; `$CLAUDE_EFFORT`
  lives in the hook process env. The library spawns Claude Code, but
  Claude Code spawns hook subprocesses — the sidecar channel is one
  level removed from anything our adapter parses.
- Project-scoped hooks (`<cwd>/.claude/settings.json`) require explicit
  user approval before they fire; a tempdir-based e2e cannot trigger
  the hook chain without mutating `~/.claude/settings.json`, which
  AGENTS.md forbids.

Issue #8's "statusline" claim is not in the v2.1.133 release notes and
not observed in `--output-format stream-json` capture; it is dropped
from scope.

#### Re-validation 2026-10-18 (claude v2.1.302)

Typing (Steps 1–6 below) already landed in `3f9a0fa`; this task file was
never status-flipped. Re-captured real NDJSON in a scratch cwd, hooks
loaded via `--settings <file>` (no `~/` mutation), `--setting-sources ""`,
`--permission-mode plan`, `env -i PATH HOME USER`:

- `hook_started` / `hook_response` shapes match the typed interfaces
  field-for-field (`hook_id`, `hook_name`, `hook_event`, `uuid`,
  `session_id`; response adds `output`, `stdout`, `stderr`, `exit_code`,
  `outcome`). No new fields.
- **Default emission = `SessionStart` only.** `UserPromptSubmit`,
  `PreToolUse`, `PostToolUse`, `Stop` hooks emit no stream events unless
  `--include-hook-events` is passed (CLI help: "Include all hook
  lifecycle events in the output stream"). A failing `Stop` hook without
  the flag surfaces only as `system/notification` `key:"stop-hook-error"`.
  Flag is not reserved → reachable today via `claudeArgs`.
- **`outcome` values:** `"success"` (exit 0), `"error"` (exit 2 and 3
  observed). `output` = stdout+stderr concatenation.
- **Sidecar effort:** with `--effort low`, `PreToolUse` hook stdin carries
  `"effort":{"level":"low"}` and env `CLAUDE_EFFORT=low`. `SessionStart`
  and `UserPromptSubmit` hooks get neither (stdin has no `effort` key,
  env unset). Under a parent Claude Code session the child inherits the
  parent's `CLAUDE_EFFORT` (observed `high`), so non-tool hooks echo the
  PARENT's value — a round-trip check must use a tool hook and stdin
  `effort.level`.
- `system/init` still has no `effort` field (new `per_turn_effort_active`
  boolean; out of scope).
- Original e2e deferral premise ("needs `~/.claude/settings.json`
  mutation") is false now: `--settings <file>` loads hooks per run,
  without approval prompts or `~/` writes.

Upstream release notes (read 2026-05-17):

- <https://github.com/anthropics/claude-code/releases/tag/v2.1.133>
- <https://github.com/anthropics/claude-code/releases/tag/v2.1.132>

### Current State

- `claude/stream.ts` defines `ClaudeStreamEvent` =
  `ClaudeSystemEvent | ClaudeAssistantEvent | ClaudeUserEvent |
  ClaudeResultEvent | ClaudeUnknownEvent`. `ClaudeSystemEvent` carries
  a free-form `subtype?: string` with `[key: string]: unknown` index
  signature — `hook_started` / `hook_response` parse as
  `ClaudeSystemEvent` today but consumers cannot narrow without
  casting.
- `processStreamEvent` dispatches typed lifecycle hooks
  (`hooks.onInit` on `system`/init, `onAssistant`, `onResult`) but
  has no hook-event channel.
- SRS FR-L25 (`documents/requirements.md` §3.25) lists eight `[x]`
  acceptance bullets covering argv, validation, cascade, resume,
  warn-once latches, and one e2e argv-propagation smoke. None mention
  the hook stream-json surface.
- SDS § 3.5 (`claude/stream.ts` — Stream Processing) lists the typed
  union; SDS § 3.x (Reasoning-effort mapping, FR-L25) describes the
  argv emission path but says nothing about the v2.1.133 sidecar
  channel.
- `documents/index.md` has no FR-L25 row.

### Constraints

- Additive only: existing `ClaudeStreamEvent` consumers continue to
  parse hook events as `ClaudeSystemEvent` (the new variants narrow
  off `subtype`, so non-narrowing consumers see no change).
- Reserved-flag lists are NOT extended.
- No `~/` mutation, no setting-sources sandbox staging (AGENTS.md
  hard rule).
- No new `--effort` / `$CLAUDE_EFFORT` argv or env emission — the
  existing `--effort <value>` argv path already drives Claude Code's
  internal `effort.level`, which Claude Code itself propagates to
  hooks. Duplicating it in our adapter risks drift.
- TDD baseline applies (`NO_COLOR=1 deno task check` green before
  changes — confirmed 2026-05-17).
- `private-type-ref` JSR slow-types lint: every new exported type used
  in a public signature must be re-exported from `mod.ts`.

## Definition of Done

- [x] FR-L25: `claude/stream.ts` exports two new typed event variants
  `ClaudeHookStartedEvent` and `ClaudeHookResponseEvent`, added to the
  `ClaudeStreamEvent` union with `subtype: "hook_started"` /
  `"hook_response"` as the discriminator. Test path:
  `claude/stream_test.ts::"parseClaudeStreamEvent narrows hook_started / hook_response"`.
  Evidence: `NO_COLOR=1 deno task test claude/stream_test.ts`.
- [x] FR-L25: `ClaudeLifecycleHooks` gains optional `onHookStarted` /
  `onHookResponse` callbacks fired BEFORE state mutation in
  `processStreamEvent`'s dispatch order. Test path:
  `claude/stream_test.ts::"onHookStarted and onHookResponse fire before state mutation"`.
  Evidence: `NO_COLOR=1 deno task test claude/stream_test.ts`.
- [x] FR-L25: New types are re-exported from `mod.ts` to satisfy JSR
  `private-type-ref`. Evidence: `NO_COLOR=1 deno task check` passes
  (the dry-run step catches missing re-exports).
- [x] FR-L25: SRS `### 3.25 FR-L25` Acceptance gains a typed
  hook-events bullet AND a documentation bullet stating that the
  v2.1.133 `effort.level` / `$CLAUDE_EFFORT` channel is a sidecar
  hook-stdin / Bash-subprocess-env contract not observable in
  stream-json. Evidence:
  `grep -n "hook_started\|sidecar\|CLAUDE_EFFORT" documents/requirements.md`
  returns the new bullets.
- [x] FR-L25: SDS § 3.5 (`claude/stream.ts` — Stream Processing)
  documents the two new variants in the typed union listing. SDS § 3.x
  (Reasoning-effort mapping) gains a "Sidecar channels (v2.1.133)"
  subsection noting that `effort.level` lives in hook stdin and
  `$CLAUDE_EFFORT` in hook/Bash env, neither observable through
  stream-json directly. Evidence:
  `grep -n "ClaudeHookStartedEvent\|sidecar\|effort.level" documents/design.md`.
- [x] FR-L25: `documents/index.md` `## FR` section has a row for
  FR-L25 pointing at the SRS section anchor with a one-line summary
  and `[x]` status. Evidence:
  `grep -n "FR-L25" documents/index.md`.
- [x] FR-L25: SRS-inline `**Tasks:**` back-pointer added on the
  FR-L25 section pointing at this task file. Evidence:
  `grep -n "claude-stream-hook-events" documents/requirements.md`.
- [x] `// FR-L25` traceability comment lives immediately above each
  new exported type / hook-callback in `claude/stream.ts`. Evidence:
  `grep -n "// FR-L25" claude/stream.ts`.
- [x] FR-L25 (2026-10-18 re-validation): `ClaudeHookStartedEvent` /
  `ClaudeHookResponseEvent` JSDoc states the v2.1.302 emission rule
  (`SessionStart` by default, every hook with `--include-hook-events`)
  and the observed `outcome` values `"success"` / `"error"`; a second
  `// FR-L25` sits directly above `ClaudeHookResponseEvent`. Evidence:
  `grep -n "include-hook-events\|\"error\"\|// FR-L25" claude/stream.ts`.
- [x] FR-L25: SRS sidecar bullet and SDS "Sidecar channels" subsection
  corrected to the v2.1.302 facts — effort reaches tool hooks only
  (`PreToolUse` / `PostToolUse` stdin `effort.level`, env
  `$CLAUDE_EFFORT`), non-`SessionStart` hook events need
  `--include-hook-events` via `claudeArgs`, parent `CLAUDE_EFFORT`
  leaks into non-tool hooks. Evidence:
  `grep -n "include-hook-events" documents/requirements.md documents/design.md`.
- [x] FR-L25: real-binary e2e `e2e/claude_hook_events_e2e_test.ts`
  loads hooks via `claudeArgs: {"--settings": <tmp file>,
  "--include-hook-events": ""}` in a temp cwd (plan mode, 60 s ceiling),
  asserts typed `onHookStarted` / `onHookResponse` fire with correlated
  `hook_id`, a failing hook yields `outcome:"error"` + `exit_code`, and
  the `PreToolUse` hook stdin echo carries `effort.level` = the requested
  `reasoningEffort`. Test path:
  `e2e/claude_hook_events_e2e_test.ts::"e2e hook-events/claude/typed hook lifecycle + effort sidecar"`.
  Evidence: `NO_COLOR=1 deno task e2e:claude` (filter
  `--filter hook-events`).
- [x] Final check: `NO_COLOR=1 deno task check` exits 0.

## Solution

### Step 1 — RED: extend `claude/stream_test.ts`

Add four new unit tests, all initially failing:

1. **"parseClaudeStreamEvent narrows hook_started / hook_response"** —
   feed two real-captured NDJSON lines (anonymized) into
   `parseClaudeStreamEvent`. Use `satisfies` to prove the parser
   result narrows into `ClaudeHookStartedEvent` /
   `ClaudeHookResponseEvent` based on the `subtype` discriminator
   without an `as unknown` cast. Assert typed fields (`hook_id`,
   `hook_name`, `hook_event`, plus
   `output`/`stdout`/`stderr`/`exit_code`/`outcome` for the response
   variant) preserve runtime values.
2. **"onHookStarted and onHookResponse fire before state mutation"** —
   create `StreamProcessorState` with `hooks.onHookStarted` /
   `onHookResponse` callbacks that push the event into a log array,
   call `processStreamEvent` with one event of each subtype, assert
   the log received the typed event and that the
   pre-vs-post-mutation order matches existing typed hooks (test
   pattern follows the `processStreamEvent — typed hooks fire BEFORE
   state mutation` test at `claude/stream_test.ts:105`).
3. **"hook events without typed hooks are no-op"** — backward-compat
   guard: feed the new subtype variants through `processStreamEvent`
   on a state with no `hooks` set, assert no throw and `turnCount`
   stays 0.
4. **"onInit still fires on hook_started / hook_response (backward
   compat)"** — set both `hooks.onInit` and `hooks.onHookStarted`,
   feed a `hook_started` event, assert BOTH callbacks observed it.
   Repeat for `hook_response` with `onHookResponse`. Pins the
   "additive, no silent regression" invariant from Step 2.4.

Run `NO_COLOR=1 deno task test claude/stream_test.ts` — MUST fail
(types don't exist yet, callbacks don't exist yet).

### Step 2 — GREEN: type the new events + dispatch

Edit `claude/stream.ts`:

1. **Add two exported interfaces with JSDoc summaries** (JSR
   `missing-jsdoc` fires on `deno publish --dry-run` without them).
   One `// FR-L25` comment above the logical block is sufficient
   per AGENTS.md ("Code references requirements" — one comment per
   implementing block, not per symbol):
   ```ts
   // FR-L25
   /** `system.hook_started` event — Claude Code 2.1.133+ fires this
    *  for every user-configured hook the CLI is about to dispatch. */
   export interface ClaudeHookStartedEvent {
     type: "system";
     subtype: "hook_started";
     hook_id: string;
     hook_name?: string;
     hook_event?: string;
     uuid?: string;
     session_id?: string;
     [key: string]: unknown;
   }

   /** `system.hook_response` event — emitted once each hook exits;
    *  carries stdout / stderr / exit_code / outcome. */
   export interface ClaudeHookResponseEvent {
     type: "system";
     subtype: "hook_response";
     hook_id: string;
     hook_name?: string;
     hook_event?: string;
     /** Aggregated output (matches Claude's flattened "output" field). */
     output?: string;
     stdout?: string;
     stderr?: string;
     exit_code?: number;
     /** Observed values: "success". Treated as forward-compat string. */
     outcome?: string;
     uuid?: string;
     session_id?: string;
     [key: string]: unknown;
   }
   ```
2. **Extend `ClaudeStreamEvent`** with the two new members:
   ```ts
   export type ClaudeStreamEvent =
     | ClaudeSystemEvent
     | ClaudeHookStartedEvent
     | ClaudeHookResponseEvent
     | ClaudeAssistantEvent
     | ClaudeUserEvent
     | ClaudeResultEvent
     | ClaudeUnknownEvent;
   ```
   Union member order is not semantically significant for narrowing
   (TypeScript narrows correctly on the `subtype` string-literal
   regardless of position when the broader `ClaudeSystemEvent` member
   uses `subtype?: string`). Listing the new variants alongside
   `ClaudeSystemEvent` is purely cosmetic. RED test 1 below pins the
   narrowing behaviour either way.
3. **Extend `ClaudeLifecycleHooks`**:
   ```ts
   export interface ClaudeLifecycleHooks {
     onInit?: (event: ClaudeSystemEvent) => void;
     onAssistant?: (event: ClaudeAssistantEvent) => void;
     onResult?: (event: ClaudeResultEvent) => void;
     /** FR-L25: fires once per hook lifecycle start. */
     onHookStarted?: (event: ClaudeHookStartedEvent) => void;
     /** FR-L25: fires once per hook completion. */
     onHookResponse?: (event: ClaudeHookResponseEvent) => void;
   }
   ```
4. **Update `processStreamEvent` dispatch** — preserve existing
   `onInit` semantics (fires for ANY `type:"system"` event) and add
   the typed hook callbacks as ADDITIVE branches:
   ```ts
   if (event.type === "system" && state.hooks?.onInit) {
     state.hooks.onInit(event as ClaudeSystemEvent);
   }
   if (
     event.type === "system" && (event as ClaudeSystemEvent).subtype ===
       "hook_started" && state.hooks?.onHookStarted
   ) {
     state.hooks.onHookStarted(event as ClaudeHookStartedEvent);
   } else if (
     event.type === "system" && (event as ClaudeSystemEvent).subtype ===
       "hook_response" && state.hooks?.onHookResponse
   ) {
     state.hooks.onHookResponse(event as ClaudeHookResponseEvent);
   } else if (event.type === "assistant" && state.hooks?.onAssistant) {
     // … unchanged …
   } else if (event.type === "result" && state.hooks?.onResult) {
     // … unchanged …
   }
   ```
   Key invariant: `onInit` still fires for hook events too (no
   silent semantic regression for existing consumers). The typed
   hook callbacks fire ADDITIONALLY when their subtype matches.
   Pin this with a fourth RED test: **"onInit still fires on
   hook_started / hook_response (backward compat)"** — set both
   `onInit` and `onHookStarted`, feed a `hook_started` event,
   assert both callbacks observed it.
5. **Update the dispatch-order JSDoc** in `processStreamEvent`
   (lines 295-303) to mention `onHookStarted` / `onHookResponse`.

Run `NO_COLOR=1 deno task test claude/stream_test.ts` — MUST pass.

### Step 3 — REFACTOR + JSR re-exports

1. Open `mod.ts`. Find the existing `claude/stream.ts` re-export block
   (look for `ClaudeStreamEvent`, `ClaudeSystemEvent`, etc.). Add the
   two new types to the same re-export so consumers can narrow them
   in their own dispatcher:
   ```ts
   export type {
     // … existing …
     ClaudeHookResponseEvent,
     ClaudeHookStartedEvent,
   } from "./claude/stream.ts";
   ```
2. Run `NO_COLOR=1 deno doc --lint mod.ts` for early
   `missing-jsdoc` / `private-type-ref` feedback before the full
   `check`.

### Step 4 — SRS update (`documents/requirements.md`)

In §3.25 FR-L25 Acceptance (append after the existing `[x]` block at
line 1166):

```markdown
  - [x] `claude/stream.ts` types `ClaudeHookStartedEvent` and
    `ClaudeHookResponseEvent` (subtype `hook_started` / `hook_response`)
    in the `ClaudeStreamEvent` discriminated union;
    `ClaudeLifecycleHooks.onHookStarted` / `onHookResponse` fire
    before state mutation. Evidence: `ai-ide-cli/claude/stream.ts`,
    `ai-ide-cli/claude/stream_test.ts`.
  - [x] **Sidecar `effort.level` / `$CLAUDE_EFFORT` channel
    (v2.1.133):** Claude Code propagates the active effort to hook
    stdin (`effort.level`) and to hook/Bash subprocess env
    (`$CLAUDE_EFFORT`). Neither lives in `--output-format stream-json`
    — the adapter does not observe them. Consumers wanting a strict
    round-trip check install a project-scoped hook that echoes
    `$CLAUDE_EFFORT`; its stdout surfaces in
    `ClaudeHookResponseEvent.stdout`. Evidence: this Acceptance entry
    (documentation-only).
```

Also add a `**Tasks:**` bullet under the FR-L25 `**Description:**`
(below line 1084, before `**Validation contract:**`):

```markdown
- **Tasks:** [claude-stream-hook-events](tasks/2026/05/claude-stream-hook-events.md)
```

### Step 5 — SDS update (`documents/design.md`)

1. In §3.5 (`claude/stream.ts` — Stream Processing), expand the
   typed-union listing (line 412):
   ```
   Typed `ClaudeStreamEvent` discriminated union: `ClaudeSystemEvent |
   ClaudeHookStartedEvent | ClaudeHookResponseEvent | ClaudeAssistantEvent |
   ClaudeUserEvent | ClaudeResultEvent | ClaudeUnknownEvent`. Hook
   events (`system.hook_started`, `system.hook_response`, Claude Code
   2.1.133+) carry `hook_id`/`hook_name`/`hook_event` plus, on
   response, `output`/`stdout`/`stderr`/`exit_code`/`outcome`. They
   precede `ClaudeSystemEvent` in the union so narrowing keys off the
   discriminator subtype string-literals first.
   ```
   Also extend the dispatch-order block (lines 423-434) to include
   `onHookStarted` / `onHookResponse` in step 2.
2. In §3.x (Reasoning-effort mapping, FR-L25), after the **Cursor**
   bullet (line 1344), add a new subsection:
   ```markdown
   **Sidecar channels (Claude Code 2.1.133+).** Claude Code propagates
   the active effort level out-of-band:
   - `effort.level` is included in hook-stdin JSON (the hook process
     reads it from its own stdin).
   - `$CLAUDE_EFFORT` is set on hook and Bash-tool subprocess env.

   Neither lives in `--output-format stream-json`. Library consumers
   that want to verify the requested `reasoningEffort` actually
   reached Claude install a project-scoped PostToolUse hook that
   echoes `$CLAUDE_EFFORT`; its stdout surfaces in the typed
   `ClaudeHookResponseEvent.stdout` (subtype `hook_response`) on the
   stream — the library itself stays out of the round-trip check.
   ```

### Step 6 — Documentation index update (`documents/index.md`)

Insert under `## FR`, alphabetically (between FR-L23 and FR-L35):

```markdown
- [FR-L25](requirements.md#3-25-fr-l25-abstract-reasoning-effort-on-runtime-options) — Abstract reasoning-effort enum on runtime options, with v2.1.133 hook-event typing — [x]
```

### Step 7 — Final verification

1. `NO_COLOR=1 deno task test claude/stream_test.ts` — passes.
2. `NO_COLOR=1 deno fmt` — applied in place.
3. `NO_COLOR=1 deno lint .` — clean.
4. `NO_COLOR=1 deno doc --lint mod.ts` — clean.
5. `NO_COLOR=1 deno task check` — exits 0.

### Step 8 — Re-validation refresh (2026-10-18, claude v2.1.302)

Steps 1–7 landed in `3f9a0fa`. Remaining work from the re-capture:

1. `claude/stream.ts` (JSDoc only, no behaviour change): rewrite the
   `ClaudeHookStartedEvent` summary — `SessionStart` hooks emit by
   default, all other hook events only with `--include-hook-events`
   (pass via `claudeArgs`); `outcome` doc → `"success"` / `"error"`;
   add `// FR-L25` directly above `ClaudeHookResponseEvent`.
2. SRS §3.25 sidecar bullet + SDS §3.x "Sidecar channels" subsection:
   replace "project-scoped PostToolUse hook that echoes
   `$CLAUDE_EFFORT`" with the verified recipe — tool hook
   (`PreToolUse`/`PostToolUse`) reading stdin `effort.level`, hooks
   loaded via `claudeArgs["--settings"]`, events surfaced via
   `claudeArgs["--include-hook-events"]`; note that non-tool hooks get
   no effort and inherit a parent `CLAUDE_EFFORT`. Add one SDS §3.5
   sentence on the default-emission rule. Edits stay inside FR-L25
   text (sibling sessions edit the same files).
3. New e2e `e2e/claude_hook_events_e2e_test.ts` (TDD for real-binary
   behaviour; `deno task check` does not run it):
   - temp dir with `note.txt`; settings JSON with `SessionStart` hook
     (`exit 3`, stderr line), `PreToolUse` matcher `Read` hook
     (`cat` stdin → stdout);
   - `invokeClaudeCli({ cwd: tmp, permissionMode: "plan",
     reasoningEffort: "low", claudeArgs: {"--settings": file,
     "--setting-sources": "local", "--include-hook-events": ""},
     hooks: {onHookStarted, onHookResponse}, timeoutSeconds: 60 })`;
   - assert: every response `hook_id` has a started peer; `SessionStart`
     response `outcome === "error"`, `exit_code === 3`; `PreToolUse:Read`
     response stdout parses to JSON with `effort.level === "low"`.
   - `--setting-sources local` (not `""`): `expandExtraArgs` maps `""` to a
     bare flag, and `local` resolves to an absent
     `<tmp>/.claude/settings.local.json`, so the user's global hooks stay
     out. Typed `settingSources: []` is unusable here — its empty
     `CLAUDE_CONFIG_DIR` drops a keychain login (FR-L18 e2e note).
   - No `PreToolUse:Read` response → fail with a message naming the
     observed hook names (model skipped the tool), not a bare assert.
   - RED first: write test, run against a stub expectation
     (`effort.level === "max"`) to watch it fail for the asserted
     reason, then fix the expectation to the requested value.
4. Remove the "Real-binary e2e" bullet from Out-of-Scope (premise
   false); keep the other two.

Verification: `NO_COLOR=1 E2E=1 E2E_RUNTIMES=claude deno test -A --no-check e2e/claude_hook_events_e2e_test.ts`;
`NO_COLOR=1 deno task check`.

### Out-of-Scope (deliberately deferred)

- **Statusline `effort.level`**: not in v2.1.133 release notes, not
  observable in `--output-format stream-json` headless mode, and the
  TUI statusline is not a library surface.
- **Mid-session `/effort` picker override drift**: the picker is an
  interactive TUI command; it cannot fire in headless `-p` mode the
  library uses. No drift possible at the API surface.

## Follow-ups

- **Hook events in `formatEventForOutput`**: today the switch returns
  `""` for system events with `subtype !== "init"`, so hook events
  produce no `[stream] hook: …` summary line in terminal output.
  Adding a one-line summary (e.g. `[stream] hook ${name}: ${outcome}
  (exit ${exit_code})`) is a nice-to-have but separable from this
  task's typing concern. Out of scope; revisit if consumers request
  it.
- **Typed `includeHookEvents` option** (Claude invoke/session options →
  `--include-hook-events`): today reachable only via `claudeArgs`. A typed
  field is a new public option (minor bump, new FR bullet) — outside this
  re-validation's scope (typing the events). Revisit if consumers rely on
  non-`SessionStart` hook events.
- **`system/init.per_turn_effort_active`** (v2.1.302) and the
  `system/notification` `key:"stop-hook-error"` event: untyped, pass
  through `ClaudeSystemEvent`. Separate typing task if needed.
