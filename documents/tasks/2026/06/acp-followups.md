---
date: "2026-06-01"
status: done
implements: [FR-L23, FR-L37, FR-L39]
tags: [acp, followup, refactor, e2e, release-notes]
related_tasks:
  - 2026/05/acp-transport-poc.md
  - 2026/06/acp-surface-parity.md
  - 2026/06/acp-reliability-parity.md
---

# ACP Transport — Actionable Follow-ups

## Goal

Close the small, in-house actionable items that the three shipped ACP
tasks (PoC + surface-parity + reliability-parity) deliberately deferred.
Three pieces in the DoD; the release-notes BREAKING-CHANGE footer
moves into `## Follow-ups` because it's one-shot tied to the next
`deno task release`, not a DoD obligation.

- Deduplicate the private `extractAgentChunkText` projection inside
  `runtime/acp/adapter.ts` against the public `extractAcpContent` in
  `runtime/acp/content.ts`. Two extractors that read the same wire
  shape will drift the moment a future ACP front variant lands — fold
  them into one.
- Add a real-binary e2e that asserts `extractSessionContent` returns a
  non-empty `NormalizedContent[]` during an actual ACP turn (FR-L23).
  Stub coverage exists; live coverage is the missing leg.
- Add a real-binary e2e that drives `invokeViaAcp` through a
  deliberately-broken first attempt and asserts the retry loop
  recovers (FR-L39). The stub-driven `runtime/acp/retry_test.ts`
  validates state-machine; live coverage proves the contract against
  `npx`-spawn semantics.

## Overview

### Context

Three ACP tasks shipped on `feat-acp-transport`:

- `2026/05/acp-transport-poc.md` (FR-L39 PoC, commit `6281ae3`).
- `2026/06/acp-surface-parity.md` (FR-L23 + FR-L39, commits
  `61af1e4`, `37c4c24`, `653f904`).
- `2026/06/acp-reliability-parity.md` (FR-L37 + FR-L39, commits
  `704cdbb`, `a01f991`).

Each task listed its own `## Follow-ups` section with non-blocking
items. This task consolidates the **actionable** subset — items that
can land today without waiting on external triggers (cursor-agent
binary, third `abortableSleep` caller, real consumer demand for
`max_turn_requests` `RuntimeErrorKind`). Those wait-on-external items
move into this task's own `## Follow-ups` section unchanged.

The four actionable items are deliberately small (refactor + two e2e
files + a release-notes line). Bundling them in one task minimises
bookkeeping; splitting would mean four file rounds for the same code
volume.

### Current State

- `runtime/acp/adapter.ts:extractAgentChunkText` — private projection
  used by `invokeViaAcp` to fill `output.result` (~12 LoC). Variant
  gate identical to `extractAcpContent`'s `agent_message_chunk` arm.
  Comment at line 240 explicitly flags the duplication and points at
  this task as the dedup follow-up.
- `runtime/acp/content.ts:extractAcpContent` — public extractor wired
  into `runtime/content.ts:isAcpShapedEvent` dispatcher. Returns
  `NormalizedContent[]` (text / tool union). The text-only chunk arm
  of the private projection is a strict subset.
- `e2e/acp_claude_smoke_e2e_test.ts` / `acp_codex_smoke_e2e_test.ts` /
  `acp_opencode_smoke_e2e_test.ts` — happy-path smokes that assert
  `is_error: false` and `result` includes `"ok"`. No assertion on
  `extractSessionContent` output; no retry exercise.
- `runtime/acp/retry_test.ts` — five stub-driven cases (rate_limit
  recovery, auth terminal, -32603 retry, byte-stable single-shot,
  abortable sleep). All bash-stub fronts — no real `npx` /
  `@agentclientprotocol/*` binaries involved.
- `runtime/acp/adapter.ts:isError` — `stopReason !== "end_turn"` (was
  `refusal || cancelled` in the PoC). Documented in the FR-L37
  acceptance bullet. Not yet called out as a `BREAKING CHANGE` line
  in any release notes — the next `standard-version` bump is the
  trigger.
- Current package version: `0.8.7` (from `deno.json`). FR-L37 +
  FR-L39 changes shipped on `feat-acp-transport` post-`0.8.7`. The
  next bump (presumably `0.9.0` for the FR-L23 / FR-L39 capabilities
  surface change, or `0.8.8` if the team treats it as patch) is the
  natural moment to attach the release-notes line.

### Constraints

- **Single observable surface for ACP content** — after dedup,
  `invokeViaAcp` MUST feed `output.result` via `extractAcpContent`
  (or a thin wrapper that re-uses it). No second copy of the
  variant-gate logic.
- **No behavioural drift on `output.result`** — the dedup is a pure
  refactor. Every existing `adapter_test.ts` / `acp_*_smoke_e2e_test.ts`
  assertion must pass byte-for-byte. The PoC's empirical text shape
  (text concat across `agent_message_chunk` deltas) stays the
  contract.
- **E2E gating mirrors the existing suite.** New e2e files reuse
  `e2e/_helpers.ts` probe + `_auth.ts` auth-probe — no new env
  knobs. They must be a no-op under `deno task check` and only fire
  under `E2E=1` + `E2E_RUNTIMES=<runtime>` + per-runtime auth probe.
- **Retry e2e MUST be deterministic** — provoking the retryable
  failure without burning quota means injecting a transient signal
  the agent will recover from. Mechanism: a wrapper around the
  pinned ACP front that intercepts the first `initialize` request
  and returns an `AcpRpcError(-32603, "transient")` on the first
  client, then forwards subsequent calls to the real binary. Lives
  as a Deno-native shell wrapper under
  `e2e/_acp_retry_wrapper.ts` — no extra runtime deps.
- **Release-notes line is one-shot.** Once attached to the changelog
  for the version that ships these commits, this DoD item is done
  forever — no recurring obligation.
- **No public API change.** Dedup is internal; e2e tests are new
  files; release notes are repository-level. `mod.ts` / `runtime/index.ts`
  exports unchanged.
- **TDD.** Dedup ships green-on-arrival because existing tests cover
  the contract; the e2e items are new behaviour and follow RED →
  GREEN → REFACTOR → CHECK on their own commits. **Regression-coverage
  chain for the refactor**: `adapter_test.ts::invokeViaAcp drives
  initialize → session/new → session/prompt to a result` pins the
  text-concat shape (`result.output.result.includes("ok")`); the
  three `acp_*_smoke_e2e_test.ts` files pin it against live binaries
  under `E2E=1`. Both must stay green byte-for-byte. Critique #1
  considered tightening this with a synthetic helper test; declined
  because the helper does not survive the dedup.
- **Branch target.** This task lands on `feat-acp-transport` (or its
  merge target if `main` has caught up by then). Three earlier ACP
  commits stack on the same branch.

## Definition of Done

> Test files named below DO NOT exist yet — the develop phase
> creates them in the RED step. The plan fixes the test paths;
> nothing here claims existing coverage.

- [x] **Dedup** — `runtime/acp/adapter.ts` no longer declares
  `extractAgentChunkText`. `invokeViaAcp` builds `output.result` by
  filtering `extractAcpContent` output to `kind === "text"` entries
  and concatenating their `text`. The parallel-projection comment at
  `runtime/acp/adapter.ts:228-240` is removed (the duplication it
  warned about no longer exists). *(FR-L23. Test:
  `runtime/acp/adapter_test.ts::invokeViaAcp drives initialize →
  session/new → session/prompt to a result` (regression — must stay
  byte-stable). Evidence: `deno test -A --no-check runtime/acp/`.)*
- [x] **Dedup grep** — no occurrence of `extractAgentChunkText` in
  the source tree (only in git history). *(FR-L23. Test:
  `grep -r "extractAgentChunkText" --include='*.ts' runtime/`
  returns no matches. Evidence: `manual — korchasa`.)*
- [x] **E2E content coverage** — `e2e/acp_content_e2e_test.ts`
  opens an ACP session via Claude pilot, sends a trivial prompt,
  collects events from `session.events`, runs each through
  `extractSessionContent`, and asserts at least one `kind: "text"`
  entry is produced with non-empty `text`. Reuses `_helpers.ts` +
  `_auth.ts` gates. *(FR-L23. Test:
  `e2e/acp_content_e2e_test.ts::extractSessionContent returns text
  content on real ACP turn`. Evidence: `E2E=1 E2E_RUNTIMES=claude
  deno test -A --no-check e2e/acp_content_e2e_test.ts`.)*
- [x] **E2E retry coverage** — `e2e/acp_retry_e2e_test.ts` runs
  `invokeViaAcp` with `maxRetries: 1` against a shell wrapper that
  fails the first child invocation with a non-zero exit (or a
  crafted JSON-RPC error response if the wrapper supports the
  `initialize` handshake) and forwards the second to the real ACP
  binary. Result: `is_error: false` after two spawn attempts.
  *(FR-L39. Test: `e2e/acp_retry_e2e_test.ts::invokeViaAcp retries
  past a broken first attempt against real ACP binary`.
  Evidence: `E2E=1 E2E_RUNTIMES=claude deno test -A --no-check
  e2e/acp_retry_e2e_test.ts`.)*
- [x] **FR code markers on new e2e files.** Both new e2e files
  (`e2e/acp_content_e2e_test.ts`, `e2e/acp_retry_e2e_test.ts`) carry
  a `// FR-L23` / `// FR-L39` comment directly above the top-level
  `Deno.test` function — per AGENTS.md "Code Documentation §
  Requirement traceability". *(FR-L23 + FR-L39. Test:
  `grep -E "^// FR-L(23|39)" e2e/acp_content_e2e_test.ts
  e2e/acp_retry_e2e_test.ts` returns both markers. Evidence:
  `manual — korchasa`.)*
- [x] **`deno task check` green** (fmt, lint, type check, full test
  suite, doc-lint, `deno publish --dry-run`). *(FR-L23 + FR-L37 +
  FR-L39. Test: implicit. Evidence: `deno run -A scripts/check.ts`.)*

## Solution

Three commits, sequenced for the smallest review surface per step:
**(1) Dedup, (2) E2E content, (3) E2E retry + release-notes line**.
Step 4 (`deno task check`) gates each commit.

### Step 0 — Baseline gate

`deno task check` must be green on the parent revision (already true
post-`a01f991`). If red, stop and report.

### Step 1 — Dedup `extractAgentChunkText`

**RED**: not applicable — this is a refactor; existing
`adapter_test.ts` happy-path asserts `result.includes("ok")` and
that's the contract we must preserve.

**GREEN**:

1. Edit `runtime/acp/adapter.ts`:

   ```ts
   // Replace the existing `extractAgentChunkText` + its callsite.
   // Inside the drain loop, feed extractAcpContent the raw params
   // and filter for text content. The literal "session/update" is
   // passed explicitly (not via note.method) so the call matches
   // the dispatcher contract in runtime/content.ts:isAcpShapedEvent
   // — both call sites then agree on the type discriminator.
   import { extractAcpContent } from "./content.ts";
   // …
   const content = extractAcpContent(
     runtime,
     "session/update",
     note.params ?? {},
   );
   for (const c of content) {
     if (c.kind === "text") collectedText.push(c.text);
   }
   ```

   `extractAcpContent`'s current signature ignores the first two
   parameters (`_runtime`, `_type`) — passing the dispatcher's
   literal "session/update" stays correct if the extractor later
   begins gating on `type`.

2. Delete `extractAgentChunkText` (function definition + the
   "Parallel projection" JSDoc block at lines 228–252).

3. Drop the duplicated import; keep `extractAcpContent` named import.

**REFACTOR**: none — the call site collapses from 12 lines to 4.

**CHECK**: `deno task check`. Watch for two regressions —
`adapter_test.ts` (`assert(result.output.result.includes("ok"))`)
and any of the three real-binary smokes if E2E is set.

Commit: `refactor(runtime): fold extractAgentChunkText into extractAcpContent (FR-L23)`.

### Step 2 — E2E content coverage

**RED**: `e2e/acp_content_e2e_test.ts` exists, runs under `E2E=1
E2E_RUNTIMES=claude`, fails because no implementation collects
content (it WILL pass on Step 1's code — the test is documentation
of the live contract; the "RED" framing is honorific here).

**GREEN**: file body (sketch):

```ts
import { assert } from "@std/assert";
import { needsBinary, needsAuth } from "./_helpers.ts";
import { extractSessionContent } from "../mod.ts";
import { defaultRegistry } from "../process-registry.ts";
import { openSessionViaAcp } from "../runtime/acp/adapter.ts";

// FR-L23
Deno.test({
  name: "extractSessionContent returns text content on real ACP turn",
  // TODO: verify gate signature against e2e/_helpers.ts + e2e/_auth.ts
  // at implementation time.
  ignore: !needsBinary("claude") || !needsAuth("claude"),
  async fn() {
    const session = await openSessionViaAcp("claude", {
      processRegistry: defaultRegistry,
      taskPrompt: "Reply with the word: ok",
    });
    const seenText: string[] = [];
    try {
      await session.send("Reply with the word: ok");
      for await (const event of session.events) {
        for (const c of extractSessionContent(event)) {
          if (c.kind === "text") seenText.push(c.text);
        }
        if (event.type === "turn-end") break;
      }
    } finally {
      session.abort();
      await session.done;
    }
    assert(seenText.length > 0, "must observe at least one text chunk");
    assert(seenText.join("").length > 0, "concatenated text must be non-empty");
  },
});
```

(Final file should mirror the existing `e2e/acp_claude_smoke_e2e_test.ts`
structure for consistency — `sanitizeOps: false` + `sanitizeResources:
false` per the abort gotcha, gate via `E2E_RUNTIMES`, etc.)

**REFACTOR**: extract a tiny helper if the body grows past the
existing smoke pattern.

**CHECK**: `deno task check` (passes — test is ignored under default
env) AND `E2E=1 E2E_RUNTIMES=claude deno task e2e:claude` (must pass
against the real binary).

Commit: `test(e2e): assert extractSessionContent returns text on ACP turn (FR-L23)`.

### Step 3 — E2E retry coverage + release-notes line

Two changes folded into one commit because the BREAKING-CHANGE line
references the same FR-L37 / FR-L39 surface.

**RED**: `e2e/acp_retry_e2e_test.ts` exists with a wrapper that fails
the first invocation; the existing PoC code already implements the
retry loop, so the test passes immediately — RED framing is again
honorific. Real RED would have appeared during `acp-reliability-parity.md`'s
Step 3.

**GREEN — retry wrapper**: Deno script
`e2e/_acp_retry_wrapper.ts` — realistically a tiny ACP server for
the first attempt, ~60–100 LoC (the "~30 LoC" framing in the
Risks section was an underestimate, per critique #3). Contract:

1. Reads counter file path + wrapped `cmd` / `args` from CLI args.
2. **First invocation** (counter file contents `0`):
   a. Increment counter to `1`.
   b. Read the first `\n`-delimited JSON-RPC frame from stdin
      (this is the client's `initialize` request — parse its `id`).
   c. Write `{"jsonrpc":"2.0","id":<id>,"error":{"code":-32603,
      "message":"transient"}}\n` to stdout.
   d. Exit `0` (the front itself didn't crash — only the request
      failed; that's how the real `-32603` path looks on the wire).
3. **Second invocation** (counter `1`): `Deno.Command` the wrapped
   binary, pipe stdio bidirectionally, exit with its status.

Bidirectional stdio piping is the gnarly bit — needs two
`Deno.copy` loops or readable→writable pipe relays.

Test body:

```ts
// FR-L39
Deno.test({
  name: "invokeViaAcp retries past a broken first attempt against real ACP binary",
  // TODO: verify gate signature against e2e/_helpers.ts + e2e/_auth.ts
  // at implementation time — the existing smokes use a slightly
  // different name in some files.
  ignore: !needsBinary("claude") || !needsAuth("claude"),
  async fn() {
    const counter = await Deno.makeTempFile({ prefix: "acp-retry-counter-" });
    await Deno.writeTextFile(counter, "0");
    const result = await invokeViaAcp("claude", {
      processRegistry: defaultRegistry,
      taskPrompt: "Reply with the word: ok",
      // Pin a cheap model to bound token cost (two attempts per
      // run × full handshake each → keep prompt + reply minimal).
      model: "claude-haiku-4-5-20251001",
      timeoutSeconds: 60,
      maxRetries: 1,
      retryDelaySeconds: 1,
      acpFront: {
        cmd: Deno.execPath(),
        args: [
          "run", "-A", "e2e/_acp_retry_wrapper.ts",
          "--counter", counter,
          "--", "npx", "-y", "@agentclientprotocol/claude-agent-acp@0.37.0",
        ],
        pilot: true,
      },
    });
    assert(result.output, JSON.stringify(result));
    assertEquals(result.output.is_error, false);
    const attempts = Number(await Deno.readTextFile(counter));
    assertEquals(attempts, 2, "expected exactly two spawn attempts");
  },
});
```

**CHECK**: `deno task check` AND
`E2E=1 E2E_RUNTIMES=claude deno task e2e:claude`.

Commit: `test(e2e): assert invokeViaAcp retries past broken first attempt (FR-L39)`.

(The release-notes BREAKING-CHANGE obligation is one-shot and is
tracked under `## Follow-ups` below — it lands as a footer on the
next `deno task release` commit, not as a DoD item of this task.)

### Step 4 — Final CHECK

`deno run -A scripts/check.ts`. Three commits land; the publish
dry-run is unchanged (no public-API touch). Mark this task `status:
done` via the auto-derive in `review-and-commit`.

### Files to create

- `e2e/acp_content_e2e_test.ts`
- `e2e/acp_retry_e2e_test.ts`
- `e2e/_acp_retry_wrapper.ts`

### Files to modify

- `runtime/acp/adapter.ts` — delete `extractAgentChunkText`, fold
  call site into `extractAcpContent`.
- `documents/requirements.md` — surgical `**Tasks:**` back-pointer
  bullet under FR-L23 / FR-L37 / FR-L39 sections (handled by this
  plan-skill run).
- `documents/index.md` — confirm FR-L23 / FR-L37 / FR-L39 rows
  reference the new task in their summary if needed (idempotent).

### Files NOT to touch

- `runtime/acp/content.ts` — public extractor stays untouched.
- `mod.ts` / `runtime/index.ts` — no API surface change.
- Existing e2e files — new tests are separate files.

### Risks (named, with mitigations)

- **Dedup hides a subtle empirical divergence between the private
  and public extractors.** The private one short-circuits early on
  `agent_message_chunk`; the public one walks the whole variant
  ladder including `tool_call_update`. If a future ACP front emits
  text inside `tool_call_update` the dedup may silently include it
  in `output.result`. Mitigation: filter on `kind === "text"`
  explicitly (Step 1 sketch already does this). The
  `tool_call_update → {kind:"tool"}` mapping in `extractAcpContent`
  pins the boundary.
- **E2E retry wrapper introduces a new failure mode visible only
  under `E2E=1`.** A bug in the wrapper (e.g. counter race) makes
  the test flaky in CI. Mitigation: wrapper is < 30 LoC and
  synchronous; counter uses POSIX file-create semantics; reuse
  the existing tmpdir / cleanup pattern.
- **`BREAKING CHANGE` semantics depend on the team's release
  cadence.** If the next bump is tagged `patch` (treating the
  `is_error` shift as internal because no consumer noticed),
  `standard-version` won't surface the BREAKING note. Mitigation:
  the DoD's evidence is `manual — korchasa` — the reviewer decides
  the release type. Document the chosen interpretation in the
  release commit message.
- **Real-binary content e2e burns Claude tokens.** Prompt stays
  trivial ("Reply with the word: ok") — same shape as existing
  smokes. Per-CI cost ≤ existing budget.

## Follow-ups

Items genuinely blocked on external triggers — NOT in DoD, recorded
here so the next reviewer can pick them up when the trigger fires:

- **Release-notes BREAKING-CHANGE footer (one-shot).** On the next
  `deno task release` bump that ships commits `704cdbb` /
  `a01f991`, the release-bump commit message MUST carry a
  `BREAKING CHANGE:` footer reading: "`invokeViaAcp` now sets
  `is_error: true` on every `stopReason` other than `end_turn`
  (previously only on `refusal` / `cancelled`). Consumers branching
  on `is_error` may see a shifted distribution for `max_tokens` /
  `max_turn_requests` / unknown reasons — branch on
  `runtime_error.kind` for structured handling." Owner: release
  bumper (currently `korchasa`). Trigger: any `deno task release`
  on this branch / its merge target.

- **Cursor ACP pilot promotion.** `runtime/acp/fronts.ts:55` keeps
  `pilot: false` until `cursor-agent` is in the validation matrix
  (CI runner with the binary installed). When that lands, flip the
  flag + add `e2e/acp_cursor_smoke_e2e_test.ts` mirroring the
  Claude smoke.
- **`abortableSleep` shared module.** Inline copy lives in
  `runtime/acp/adapter.ts` and `claude/process.ts`. Promote to
  `runtime/abortable-sleep.ts` once a third caller appears (likely
  candidate: future FR-L38 retry pattern). The TODO comment on
  `runtime/acp/adapter.ts:404` already references this task.
- **`RuntimeErrorKind: "max_turn_requests"`.** Currently mapped to
  `kind: "runtime_error"` (medium confidence). Promote to a
  first-class kind in FR-L37's union when a consumer asks to
  branch on it — requires a `feat` bump and a tiny SRS edit.
- **Real-binary `runtime_error.kind` coverage.** The `error_analysis`
  test suite is stub-only. A live e2e that drives a real ACP
  binary into a quota / rate-limit failure is technically possible
  but burns shared resources; defer until a deterministic failure
  injection mechanism (e.g. `--max-tokens 1` on a real prompt)
  appears.
