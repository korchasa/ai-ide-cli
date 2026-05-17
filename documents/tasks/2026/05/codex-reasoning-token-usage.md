---
date: "2026-05-17"
status: to do
implements: [FR-L13, FR-L26]
tags: [codex, usage, reasoning-tokens, app-server, 0.128, 0.130]
related_tasks: [codex-ban-full-auto-flag, codex-flag-placement-audit]
---

# Codex: Surface reasoning-token usage (0.128) and response.processed (0.130)

GitHub issue: <https://github.com/korchasa/ai-ide-cli/issues/9>.

## Goal

Keep Codex telemetry accurate after `rust-v0.128.0` added reasoning-token
counts to `codex exec --json` `turn.completed.usage`, and after
`rust-v0.130.0` introduced a new `response.processed` notification on the
`codex app-server` v2 stream. Without picking these up, downstream cost
trackers under-report reasoning costs and consumers wiring on the v2
stream miss the "remote compaction finished" signal — UI states stay
stuck on the prior phase.

## Overview

### Context

Two Codex releases in the audited 0.122–0.130 window expand the
protocol:

- `rust-v0.128.0` (2026-04-30): "`codex exec --json` now reports
  reasoning-token usage for programmatic consumers (#19308)".
- `rust-v0.130.0` (2026-05-08): "Remote compaction now emits
  `response.processed` for v2 streams and avoids sending
  `service_tier` on API-key compact requests (#21642, #21676)".

Upstream release notes:

- <https://github.com/openai/codex/releases/tag/rust-v0.128.0>
- <https://github.com/openai/codex/releases/tag/rust-v0.130.0>

Installed local binary is `codex-cli 0.128.0` — sufficient to capture
the real shape of `turn.completed.usage` with reasoning tokens, but the
machine cannot exercise `response.processed` end-to-end (introduced in
0.130).

### Current State

- `codex/exec-events.ts:CodexExecUsage` carries `input_tokens`,
  `cached_input_tokens`, `output_tokens`, plus `[key: string]: unknown`
  forward-compat index — reasoning-token field absent at the type
  level. NDJSON parser is permissive; an unknown key passes through
  but stays untyped.
- `codex/run-state.ts:CodexRunState` accumulates `inputTokens`,
  `cachedInputTokens`, `outputTokens` — no reasoning bucket.
  `extractCodexUsage(state)` projects them onto `CliRunUsage`; returns
  `undefined` when every counter is zero.
- `types.ts:CliRunUsage` has `input_tokens`, `output_tokens`,
  `cached_tokens`, `cost_usd` — reasoning bucket absent. The
  cost-aggregation contract documents the `0`-vs-`undefined`
  distinction.
- `codex/events.ts:CodexNotification` typed union covers `thread/*`,
  `turn/*`, `item/*`, `error` methods; no `response.processed`
  variant. `CodexUntypedNotification` is the fallback shape and
  `isCodexNotification` is the narrowing guard.
- `codex/content.ts:extractCodexContent` translates `item/*`
  notifications into `NormalizedContent` (text / final / tool).
  `response.processed` is a lifecycle signal — not assistant content;
  the extractor will keep returning `[]` for it.
- `e2e/session_matrix_e2e_test.ts` already exercises a Codex single-
  word-reply turn; no usage assertions yet.
- SRS `### 3.13 FR-L13` Acceptance documents the existing token-count
  fold (`turn.completed → token counts`); no reasoning-bucket bullet.
  SRS `### 3.26 FR-L26` enumerates the typed-notification union;
  `response.processed` not listed.

### Constraints

- Public API surface back-compat: `CliRunUsage`, `CliRunOutput`,
  `RuntimeInvokeResult`, and the existing notification union may only
  grow additive (new OPTIONAL field / new variant), never break
  existing consumers.
- Must remain usable on Codex `rust-v0.122..0.130`. Older binaries do
  not emit reasoning tokens or `response.processed` — missing fields
  surface as `undefined`, NOT `0`.
- Local install is 0.128.0; `response.processed` cannot be exercised
  against the real binary in this task. Typed against the upstream
  spec; real-binary e2e for it stays a Follow-up until the local
  binary is bumped to 0.130.
- "Fail fast" applies at the type-check layer — a regression must
  break tests, not silently log a warning.
- TDD baseline: `NO_COLOR=1 deno task check` MUST be green before
  the first edit.

### Empirical Capture Required (RED prerequisite)

The exact wire-key for reasoning tokens inside
`turn.completed.usage` is NOT in the issue. AGENTS.md "Adding Typed
Stream Events for a Runtime" mandates empirical capture before
typing. The Solution starts with a short real-binary smoke against
the installed 0.128 to lock in the field name; only after capture
does the union gain its typed field. Same rule applies to the
`response.processed` param shape, but there the source is the
upstream `codex app-server generate-ts --experimental` output (the
0.128 binary still emits the v2 schema; the *notification* may be
absent but the schema source-of-truth is generatable).

## Definition of Done

- [ ] FR-L13: `codex/exec-events.ts:CodexExecUsage` types the
      0.128 reasoning-token wire-field (exact name pinned via RED
      smoke; current best guess `cached_output_tokens` /
      `reasoning_output_tokens` — TBD by capture). Tuple:
      (FR-L13, `codex/exec-events_test.ts::"reasoning-token field
      parsed on turn.completed.usage"`,
      `NO_COLOR=1 deno task test codex/exec-events_test.ts`).
- [ ] FR-L13: `codex/run-state.ts` accumulates the new bucket and
      `extractCodexUsage` projects it onto a new optional
      `CliRunUsage.reasoning_tokens`. Tuple:
      (FR-L13, `codex/run-state_test.ts::"reasoning tokens
      accumulate and surface on extractCodexUsage"`,
      `NO_COLOR=1 deno task test codex/run-state_test.ts`).
- [ ] FR-L13: `types.ts:CliRunUsage` gains optional
      `reasoning_tokens?: number` with JSDoc documenting the
      runtime support matrix (Codex 0.128+; other runtimes leave
      it `undefined`). Tuple:
      (FR-L13, `codex/run-state_test.ts::"extractCodexOutput
      surfaces reasoning_tokens on CliRunOutput.usage"`,
      `NO_COLOR=1 deno task test codex/run-state_test.ts`).
- [ ] FR-L26: `codex/events.ts` adds
      `CodexResponseProcessedNotification`
      (method `response.processed`) to the typed `CodexNotification`
      union, with params hand-mirrored from the upstream
      `app-server generate-ts --experimental` schema. Tuple:
      (FR-L26, `codex/events_test.ts::"response.processed narrows
      via isCodexNotification"`,
      `NO_COLOR=1 deno task test codex/events_test.ts`).
- [ ] FR-L13: Real-binary smoke against installed `codex` 0.128
      asserts `usage.reasoning_tokens` is a positive integer on a
      reasoning-capable single-word-reply turn. Tuple:
      (FR-L13,
      `e2e/codex_reasoning_usage_e2e_test.ts::"codex reasoning_tokens > 0"`
      (new file, invoke-path), `E2E=1 E2E_RUNTIMES=codex
      NO_COLOR=1 deno task e2e:codex`).
- [ ] SRS `### 3.13 FR-L13` Acceptance includes a bullet
      describing the reasoning-token fold. SRS `### 3.26 FR-L26`
      Acceptance lists `response.processed` as a typed variant.
      Evidence: `grep -n "reasoning_tokens\|response.processed"
      documents/requirements.md`.
- [ ] SDS sections for `codex/exec-events.ts`,
      `codex/run-state.ts`, and `codex/events.ts` reflect the
      new fields. Evidence: `grep -n "reasoning_tokens\|response\\.processed"
      documents/design.md`.
- [ ] `documents/index.md` `## FR` rows: FR-L13 summary updated to
      mention reasoning-token telemetry; FR-L26 row added
      (alphabetical). Evidence: `grep -n "FR-L13\|FR-L26"
      documents/index.md`.
- [ ] `mod.ts` barrel re-exports
      `CodexResponseProcessedNotification` so consumers can narrow
      it without sub-path imports. Evidence: `grep -n
      "CodexResponseProcessedNotification" mod.ts`.
- [ ] Final check: `NO_COLOR=1 deno task check` exits 0.

## Solution

Selected variant: **V1 — Surgical additive**. Single atomic commit:
typed reasoning-tokens wire-field on the exec NDJSON, new optional
`reasoning_tokens` on `CliRunUsage`, accumulator wiring in
`run-state.ts`, typed `CodexResponseProcessedNotification` for the
v2 app-server stream, real-binary e2e for the 0.128 path. The 0.130
`response.processed` stays unit-only (local binary is 0.128); the
e2e for it goes to Follow-ups.

### Step 0 — RED prerequisite (empirical capture)

Run a real `codex exec --experimental-json` against the installed
0.128 binary with a reasoning-capable model:

```sh
NO_COLOR=1 codex exec --experimental-json -m gpt-5 \
  "Reply with the word: ok" 2>/dev/null \
  | tee /tmp/codex-usage-capture.ndjson
```

Inspect the `turn.completed` line for the new reasoning-token
field. Two candidates per upstream PR #19308 chatter:
`reasoning_output_tokens` (most likely — matches Codex SDK
`turn.go` accumulator naming convention) or
`cached_output_tokens`. Pin the EXACT wire-key — that string is the
discriminator everywhere downstream. Note the value MUST be a
non-negative integer; reasoning-capable models emit > 0 even on a
one-word reply.

For `response.processed`, capture the schema from upstream
generator (no real notification available on 0.128 — schema
source-of-truth is the experimental TypeScript generator):

```sh
codex app-server generate-ts --experimental --out /tmp/codex-types
grep -rln "response.processed\|ResponseProcessed" /tmp/codex-types/v2
```

Inspect `v2/ResponseProcessedNotification.ts` (or its equivalent)
for the `params` shape. Record the exact field names — they go
verbatim into the typed variant.

**Fallback rule for `response.processed`**: if the local 0.128
generator does not emit a `ResponseProcessedNotification.ts` (the
notification was introduced in 0.130, so 0.128's generator may not
know it yet), type the variant with the minimal-conservative
shape: `params: { threadId: string; turnId: string; [key: string]:
unknown }`. Annotate the type's JSDoc with `@experimental — schema
best-effort until codex 0.130 is locally available; full field
list pending real-binary capture (FR-L26 Follow-up)`. This keeps
the variant additive without committing to fields we cannot
verify.

For the reasoning-token wire-key capture: if Codex won't emit a
`turn.completed` (e.g. binary auth failure), STOP and surface the
blocker per AGENTS.md "Diagnosing Failures". Do not guess
wire-keys — the type discriminator is a hard contract.

### Step 1 — RED: type the exec usage field

In `codex/exec-events.ts`, add the captured field to
`CodexExecUsage` as an OPTIONAL `number` with a JSDoc one-liner:

```ts
export interface CodexExecUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  /** Reasoning tokens emitted by reasoning-capable models
      (Codex `rust-v0.128.0`+; older binaries omit). */
  reasoning_output_tokens?: number; // exact key from Step 0 capture
  [key: string]: unknown;
}
```

In `codex/exec-events_test.ts`, append a new test directly under
the existing `parseCodexExecEvent — turn.completed parses with usage`
test:

```ts
Deno.test("parseCodexExecEvent — reasoning-token field parsed on turn.completed.usage", () => {
  const event = parseCodexExecEvent(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 320 },
  }));
  assert(event !== null);
  const narrowed = event as CodexExecTurnCompletedEvent;
  assertEquals(narrowed.usage?.reasoning_output_tokens, 320);
});
```

Add `// FR-L13` comment directly above the new `Deno.test(...)`.

Run `NO_COLOR=1 deno task test codex/exec-events_test.ts` — RED.
Implement the type addition above (the test compiles only after the
field is typed). Re-run — GREEN.

### Step 2 — RED: extend `CliRunUsage.reasoning_tokens`

In `types.ts:CliRunUsage`, add the optional field with JSDoc that
documents the runtime-support matrix:

```ts
/**
 * Reasoning tokens emitted by reasoning-capable models.
 * Currently: Codex `rust-v0.128.0`+; other runtimes leave this
 * `undefined`. Older Codex binaries also leave it `undefined`.
 * Branch on presence rather than treating `0` as "no data" — a
 * non-reasoning model on Codex still produces a `turn.completed`
 * without the field.
 */
reasoning_tokens?: number;
```

Update the `CliRunUsage` JSDoc's per-runtime token-support
docstring (lines 44–53 in `types.ts`) to mention reasoning tokens
under the Codex row.

No new test in this step — coverage comes via Step 4
(`run-state_test.ts`).

### Step 3 — RED: accumulator wiring in `codex/run-state.ts`

Add field to `CodexRunState`:

```ts
/** Cumulative reasoning_output_tokens summed across turns
    (Codex 0.128+; older turns contribute 0). */
reasoningOutputTokens: number;
```

Update `createCodexRunState()` to initialize `reasoningOutputTokens:
0`.

Update `applyCodexEvent` `turn.completed` branch:

```ts
case "turn.completed": {
  const e = event as CodexExecTurnCompletedEvent;
  state.turnCount += 1;
  const usage = e.usage;
  if (usage) {
    state.inputTokens += Number(usage.input_tokens ?? 0);
    state.cachedInputTokens += Number(usage.cached_input_tokens ?? 0);
    state.outputTokens += Number(usage.output_tokens ?? 0);
    state.reasoningOutputTokens +=
      Number(usage.reasoning_output_tokens ?? 0); // exact key from Step 0
  }
  return;
}
```

Update `extractCodexUsage(state)`:

```ts
if (
  state.inputTokens === 0 && state.outputTokens === 0 &&
  state.cachedInputTokens === 0 && state.reasoningOutputTokens === 0
) {
  return undefined;
}
const usage: CliRunUsage = {
  input_tokens: state.inputTokens,
  output_tokens: state.outputTokens,
  cached_tokens: state.cachedInputTokens,
};
if (state.reasoningOutputTokens > 0) {
  usage.reasoning_tokens = state.reasoningOutputTokens;
}
return usage;
```

The conditional set keeps `reasoning_tokens` absent (not `0`) when
the binary doesn't surface it, preserving the
`undefined`-vs-`0` contract in the `CliRunUsage` JSDoc.

The `formatCodexEventForOutput` summary line stays unchanged in
this step to avoid breaking any snapshot test that asserts the
existing `[stream] turn.completed in=… out=… cached=…` format.
If RED for Step 4 shows the format is uncovered by snapshot tests,
the summary may grow a `reasoning=…` field in a follow-up — out of
scope for this commit unless cheap.

Add `// FR-L13` traceability comment above `applyCodexEvent`
(already exists per FR-L13 convention; verify it's still positioned
correctly after the edit).

### Step 4 — RED: NEW `codex/run-state_test.ts`

Create a fresh unit-test file. The file currently does not exist
in the repo — `applyCodexEvent` is exercised indirectly via
`codex/process_test.ts`, but per the FR-L13 acceptance tuple we
want a direct coverage point. Skeleton:

```ts
import { assertEquals } from "@std/assert";
import {
  applyCodexEvent,
  createCodexRunState,
  extractCodexUsage,
} from "./run-state.ts";

// FR-L13
Deno.test("reasoning tokens accumulate and surface on extractCodexUsage", () => {
  const s = createCodexRunState();
  applyCodexEvent({
    type: "turn.completed",
    usage: {
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 50,
      reasoning_output_tokens: 320,
    },
  }, s);
  applyCodexEvent({
    type: "turn.completed",
    usage: {
      input_tokens: 80,
      output_tokens: 40,
      reasoning_output_tokens: 110,
    },
  }, s);
  const usage = extractCodexUsage(s);
  assertEquals(usage?.reasoning_tokens, 430);
  assertEquals(usage?.input_tokens, 180);
  assertEquals(usage?.output_tokens, 90);
});

// FR-L13
Deno.test("extractCodexUsage omits reasoning_tokens when wire field absent", () => {
  const s = createCodexRunState();
  applyCodexEvent({
    type: "turn.completed",
    usage: { input_tokens: 100, output_tokens: 50 },
  }, s);
  const usage = extractCodexUsage(s);
  assertEquals(usage?.reasoning_tokens, undefined);
  assertEquals(usage?.input_tokens, 100);
});

// FR-L13
Deno.test("extractCodexUsage returns undefined when every counter is zero", () => {
  const s = createCodexRunState();
  assertEquals(extractCodexUsage(s), undefined);
});

// FR-L13
Deno.test("extractCodexOutput surfaces reasoning_tokens on CliRunOutput.usage", () => {
  const s = createCodexRunState();
  applyCodexEvent({ type: "thread.started", thread_id: "thrd_x" }, s);
  applyCodexEvent({
    type: "turn.completed",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      reasoning_output_tokens: 200,
    },
  }, s);
  const out = extractCodexOutput(s);
  assertEquals(out.usage?.reasoning_tokens, 200);
  assertEquals(out.session_id, "thrd_x");
  assertEquals(out.is_error, false);
});
```

Run `NO_COLOR=1 deno task test codex/run-state_test.ts`. RED → GREEN
after Steps 2–3.

### Step 5 — RED: typed `CodexResponseProcessedNotification`

In `codex/events.ts`, immediately before the `CodexErrorNotification`
declaration, add the new variant. The exact `params` shape comes
from Step 0's `app-server generate-ts` capture; the structural
form below is a placeholder:

```ts
/** Params for `response.processed` — mirrors
    `v2/ResponseProcessedNotification.ts`. */
export interface CodexResponseProcessedParams {
  /** Thread the response belongs to. */
  threadId: string;
  /** Turn the response belongs to. */
  turnId: string;
  /** Response identifier — opaque to consumers. */
  responseId?: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** `response.processed` notification — remote compaction marker
    for v2 streams (Codex `rust-v0.130.0`+). */
export interface CodexResponseProcessedNotification {
  /** Discriminator. */
  method: "response.processed";
  /** Notification payload. */
  params: CodexResponseProcessedParams;
}
```

Add `CodexResponseProcessedNotification` to the `CodexNotification`
union (in alphabetical-ish position, before `CodexErrorNotification`).

Module JSDoc (top of `codex/events.ts`): append a sentence noting
the 0.130 variant.

In `codex/events_test.ts`, append:

```ts
// FR-L26
Deno.test("isCodexNotification — response.processed narrows to typed variant", () => {
  const note: CodexUntypedNotification = {
    method: "response.processed",
    params: { threadId: "t", turnId: "u", responseId: "r1" },
  };
  if (isCodexNotification(note, "response.processed")) {
    // Type narrowing: note.params.threadId is `string`.
    assertEquals(note.params.threadId, "t");
    assertEquals(note.params.responseId, "r1");
  } else {
    throw new Error("guard failed to narrow");
  }
});
```

### Step 6 — `mod.ts` barrel

Grep first to confirm the symbols are not already re-exported:

```sh
grep -n "CodexResponseProcessed" mod.ts
```

Add to the codex events `export type {…}` block of `mod.ts`
(type-only — these are interfaces, not values):

```ts
export type {
  // …existing codex events…
  CodexResponseProcessedNotification,
  CodexResponseProcessedParams,
} from "./codex/events.ts";
```

Verify the `deno publish --dry-run` slow-types lint by running:

```sh
NO_COLOR=1 deno doc --lint mod.ts
```

### Step 7 — Real-binary e2e: NEW `e2e/codex_reasoning_usage_e2e_test.ts`

Single-runtime e2e gated by `enabled.codex`. Mirrors
`lifecycle_hooks_e2e_test.ts` shape — adapter.invoke path, short
ceiling, reasoning-capable model. Skeleton:

```ts
import { assert } from "@std/assert";
import { defaultRegistry } from "../process-registry.ts";
import { getRuntimeAdapter } from "../runtime/index.ts";
import { ONE_WORD_OK, resolveEnabledMap } from "./_helpers.ts";

const enabled = await resolveEnabledMap();

Deno.test({
  name: "e2e codex reasoning_tokens > 0 on a reasoning-capable turn",
  ignore: !enabled.codex,
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  // FR-L13
  fn: async () => {
    const adapter = getRuntimeAdapter("codex");
    const out = await adapter.invoke({
      processRegistry: defaultRegistry,
      // Slightly non-trivial prompt so reasoning-capable models
      // produce > 0 reasoning tokens reliably. A bare "reply ok"
      // sometimes shortcuts past the reasoning step on GPT-5.
      taskPrompt: "What is 7 times 8? Reply with just the number.",
      timeoutSeconds: 60,
      maxRetries: 1,
      retryDelaySeconds: 0,
      verbosity: "quiet",
    });
    // Presence check is the hard contract; positive value is the
    // softer expectation (any reasoning-capable model on 0.128+
    // emits > 0 here, but a 0 from a future non-reasoning default
    // model should not flake the test — assert >= 0).
    assert(out.usage?.reasoning_tokens !== undefined,
      `expected reasoning_tokens on usage, got ${JSON.stringify(out.usage)}`);
    assert((out.usage?.reasoning_tokens ?? -1) >= 0,
      `expected reasoning_tokens >= 0, got ${out.usage?.reasoning_tokens}`);
  },
});
```

Confirm `deno.json` `tasks.e2e:codex` glob picks up the new file
(it should — the existing glob is `e2e/*_e2e_test.ts`); if not,
add the explicit path.

### Step 8 — SRS / SDS / index doc sync

**SRS `documents/requirements.md`** —

- `### 3.13 FR-L13` Acceptance: append two bullets after the
  `no-duplicate placement` bullet:
  ```
  - [x] `turn.completed.usage` reasoning-token field is typed on
        `CodexExecUsage` and accumulated into `CliRunUsage.reasoning_tokens`
        (Codex `rust-v0.128.0`+; older binaries omit the field, downstream
        usage carries `undefined`). Evidence:
        `ai-ide-cli/codex/exec-events_test.ts`,
        `ai-ide-cli/codex/run-state_test.ts`,
        `ai-ide-cli/e2e/codex_reasoning_usage_e2e_test.ts`.
  ```
- `### 3.26 FR-L26` Acceptance: extend the `CodexNotification` listing
  bullet to include `response.processed`; add a new bullet noting
  the 0.130 introduction and that the type is unit-tested only on
  the 0.128 binary.

Update `Tasks:` bullet on FR-L13 and add one on FR-L26 (the
SRS-inline back-pointer step 5c).

**SDS `documents/design.md`** —

- `### 3.10.4 codex/process.ts` (Codex Runner) — note that
  `extractCodexUsage` now projects reasoning tokens onto
  `CliRunUsage.reasoning_tokens` when the binary surfaces them.
- `### 3.10.3 codex/exec-events.ts` — list the new optional field.
- `### 3.11 codex/app-server.ts` (or the `events.ts` block) — list
  `response.processed` as a typed variant; note the 0.130
  introduction and unit-only coverage in 0.128.

**`documents/index.md`** —

- FR-L13 row summary: append `, reasoning-token telemetry`.
- Add new FR-L26 row, alphabetically:
  `- [FR-L26](requirements.md#3-26-fr-l26-typed-codex-app-server-notifications) — Typed Codex app-server notifications (incl. response.processed) — [x]`.

### Step 9 — Final check

```sh
NO_COLOR=1 deno task check
```

MUST exit 0. If any sub-step (fmt / lint / type / test / doc-lint /
publish --dry-run) fails, fix only the failing item that is within
Solution scope — pre-existing unrelated failures are out-of-scope
per AGENTS.md.

## Follow-ups

- (Deferred) Real-binary e2e for `response.processed` once the
  local Codex binary is bumped to ≥ 0.130. Today the notification
  cannot fire — the variant stays unit-only.
- (Deferred) Cross-runtime reasoning-token surfacing for Claude /
  Cursor / OpenCode. Each runtime has its own wire-name; out of
  scope for #9, which is Codex-only.

