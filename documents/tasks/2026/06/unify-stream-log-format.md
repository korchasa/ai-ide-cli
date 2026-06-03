---
date: "2026-06-04"
status: done
implements: [FR-L40]
tags: [stream-log, formatting, cross-runtime, parity]
---
# Unify stream.log format across runtimes

## Goal

Make `stream.log` behave identically across all four runtimes so consumers
(e.g. `@korchasa/flowai-workflow`) can read a single human-readable trail
without per-runtime branching. Closes the FR-E18 (timestamps) regression
that today silently affects three of four adapters.

## Overview

### Context

`stream.log` today has three formats for four adapters:

- Claude (`claude/stream.ts:462-473`) — formatted summaries + `stampLines`
  (`[HH:MM:SS] [stream] text: …`).
- Codex (`codex/process.ts:315-318`) — formatted summaries, **no
  timestamps** (`encoder.encode(logSummary + "\n")`).
- Cursor (`cursor/process.ts:466-469`) — formatted summaries, **no
  timestamps**.
- OpenCode (`opencode/process.ts:611-619`, `processOpenCodeLine`) — **raw
  NDJSON** dump of the original event line.
  `formatOpenCodeEventForOutput` is invoked only for the terminal
  (`onOutput`), never for the log file.

Decision (this task): Variant A — keep upstream-event-shape knowledge in
adapters (the four `format<Runtime>EventForOutput` functions stay where
they are), but unify the post-format wrapping. Two follow-on choices
locked in with the user:

1. OpenCode `stream.log` → formatted + stamped summaries (drop raw
   NDJSON). Rationale: stream.log is a human-readable trail; raw NDJSON
   is recoverable from the CLI directly.
2. Claude turn/end/footer markers (`--- turn N ---`, `--- end ---`,
   `formatFooter`) stay claude-only — they depend on Claude-specific
   event shape (`event.type === "assistant"`) and usage fields
   (`usage`, `total_cost_usd`). Document as intentional divergence in
   SDS; do not synthesize equivalents for the other three runtimes.

### Current State

- `claude/stream.ts:658` exports `stampLines(text)`. It is runtime-agnostic
  (prepends `[HH:MM:SS] ` to each non-empty line) but lives in a
  claude-local module.
- `claude/stream.ts:462-473` wraps every log write with `stampLines`.
- `codex/process.ts:317` writes `encoder.encode(logSummary + "\n")` — no
  timestamp.
- `cursor/process.ts:468` writes `encoder.encode(logSummary + "\n")` — no
  timestamp.
- `opencode/process.ts:617-619` writes `encoder.encode(line + "\n")` where
  `line` is the raw upstream JSON string. The runner in
  `opencode/process.ts:446-447` calls `formatOpenCodeEventForOutput` only
  for `onOutput`, not for the log.
- `mod.ts` re-exports `stampLines` from `claude/stream.ts`.

### Constraints

- Library-only repo — no engine/workflow logic creeps in (Variant A).
- TDD per AGENTS.md: RED → GREEN → REFACTOR → CHECK. Baseline gate
  (`deno task check` green) before first edit.
- JSR slow-types: `stampLines` re-export point must keep its public API
  with explicit return type (already `string`).
- `// FR-L40` traceability comment above each modified log-write call
  site (four sites).
- Claude turn/end/footer markers untouched — claude-only by design,
  documented divergence.
- Existing claude tests in `claude/stream_test.ts` must remain green
  after moving `stampLines`.

## Definition of Done

- [x] `runtime/log-format.ts` exports `stampLines(text: string): string`
      with co-located unit tests (`runtime/log-format_test.ts`) covering
      single-line, multi-line, empty-line, and trailing-newline cases.
- [x] `claude/stream.ts` imports `stampLines` from `runtime/log-format.ts`
      and re-exports it for the public `./claude/stream` sub-path
      (deno.json exports — removing the re-export would be a breaking
      change for JSR consumers, so kept rather than deprecated).
- [x] `codex/process.ts` writes `stampLines(logSummary) + "\n"` to
      `logFile`. New test in `codex/process_test.ts` captures a stream.log
      write and asserts `[HH:MM:SS] ` prefix.
- [x] `cursor/process.ts` writes `stampLines(logSummary) + "\n"` to
      `logFile`. New test in `cursor/process_test.ts` asserts the prefix.
- [x] OpenCode log path rewritten: `processOpenCodeLine` no longer
      writes to `logFile`; the parsed event flows through `handleEvent`
      which writes `stampLines(formatOpenCodeEventForOutput(event)) +
      "\n"` instead of the raw JSON line. New test in
      `opencode/process_test.ts` asserts the prefix and the absence of
      raw `{"type":` JSON in `stream.log`.
- [x] `// FR-L40` traceability comments above all four log-write sites
      plus the `stampLines` definition.
- [x] New FR-L40 entry in `documents/requirements.md`: unified stream.log
      format (timestamped, formatted summaries for every adapter); FR-L7
      updated to reflect the move of `stampLines` / `tsPrefix` out of
      `claude/stream.ts`.
- [x] `documents/design.md` updated: added `runtime/log-format.ts`
      component to the architecture tree, updated `claude/stream.ts`
      entry to mark `stampLines` as re-export, documented claude-only
      turn/end/footer markers as intentional divergence under §5
      Constraints.
- [x] `deno task check` green (fmt, lint, type check, full tests,
      doc-lint, publish dry-run).

## Solution

1. **Baseline.** Run `deno task check`. If anything is red, stop and
   report — do not layer changes on a broken baseline.
2. **RED — `runtime/log-format.ts`.** Create
   `runtime/log-format_test.ts` with failing tests for `stampLines`
   (single-line input, multi-line input, empty line in the middle,
   trailing newline handling). Tests import from the new module path,
   which does not yet exist.
3. **GREEN — promote `stampLines`.** Create `runtime/log-format.ts` and
   move the implementation from `claude/stream.ts:658` verbatim. Export
   with explicit return type `string`. Update `claude/stream.ts` to
   import from the new location. Re-export from `mod.ts` from the new
   path. Decide on deprecated re-export from `claude/stream.ts`:
   - Run `grep -rn "stampLines" claude/ codex/ cursor/ opencode/ runtime/ mod.ts e2e/` —
     if no external (non-test) consumer outside `claude/`, drop the
     symbol from `claude/stream.ts` entirely.
4. **RED — Codex log timestamp.** Add a test in `codex/process_test.ts`
   that captures the bytes written to `logFile` (via an in-memory
   `Deno.FsFile`-like sink or by writing to a temp file and reading
   back) and asserts every non-empty line starts with `[HH:MM:SS] `.
5. **GREEN — Codex.** Change `codex/process.ts:317` to
   `await logFile.write(encoder.encode(stampLines(logSummary) + "\n"))`.
   Add `// FR-L40` comment above the block. Re-run test.
6. **RED — Cursor log timestamp.** Same shape as step 4, in
   `cursor/process_test.ts`.
7. **GREEN — Cursor.** Same change in `cursor/process.ts:468` +
   `// FR-L40` comment.
8. **RED — OpenCode formatted log.** Update / add test in
   `opencode/process_test.ts` asserting stream.log contains formatted
   summaries with `[HH:MM:SS] ` prefix and **does not** contain raw
   JSON (`{"type"…`). Existing tests that assert raw-NDJSON output need
   to be updated, not deleted — the assertion flips from "raw line
   present" to "formatted+stamped summary present".
9. **GREEN — OpenCode.** Refactor `processOpenCodeLine`
   (`opencode/process.ts:611-619`):
   - Parse the incoming `line` into an `OpenCodeStreamEvent` (the
     existing parser already runs upstream of this callsite for
     `handleEvent`; reuse the same parse, do not double-parse).
   - Call `formatOpenCodeEventForOutput(event)` (canonical, non-verbose).
   - Write `stampLines(summary) + "\n"` to `logFile` if both `logFile`
     and a non-empty summary exist.
   - Drop the raw-NDJSON write path. Add `// FR-L40` comment above the
     block.
   - If the existing call site already has the parsed event in scope,
     thread it through instead of re-parsing.
10. **REFACTOR.** Check that the four log-write call sites converge on
    the same pattern: `stampLines(format<Runtime>EventForOutput(event)) + "\n"`.
    If so, consider extracting a tiny `writeLogLine(logFile, encoder, summary)`
    helper into `runtime/log-format.ts` — only if it removes duplication
    without adding indirection. Skip if it makes the call sites harder
    to read (per AGENTS.md: "Three similar lines is better than a
    premature abstraction").
11. **SRS update.** Add FR-L40 to `documents/requirements.md` under §3:
    - **Desc**: Unified stream.log format across all runtimes.
    - **Scenario**: A consumer reading `stream.log` for any of the four
      runtimes sees timestamped, formatted summaries.
    - **Acceptance**: Every non-empty line begins with
      `[HH:MM:SS] `; OpenCode stream.log contains no raw JSON event
      lines; Claude-specific markers (`--- turn N ---`, `--- end ---`,
      `formatFooter`) remain claude-only and documented as such in SDS.
12. **SDS update.** Add to `documents/design.md` §3 Components:
    `runtime/log-format.ts` — exports `stampLines`. Add to §7
    Constraints: Claude turn/end/footer markers are an intentional
    runtime-specific divergence; not synthesized for other runtimes.
13. **CHECK.** Run `deno task check`. Fix any fmt/lint/doc-lint/type
    issues. Re-run until green. Per AGENTS.md, this is mandatory — not
    optional after GREEN.

### Verification

- `deno task test runtime/log-format` — `stampLines` unit tests.
- `deno task test claude/ codex/ cursor/ opencode/` — adapter log-format
  assertions.
- `deno task check` — full pipeline (fmt, lint, type, all tests,
  doc-lint, publish dry-run).
- Optional smoke: `E2E=1 deno task e2e:claude` then inspect a
  short-run stream.log to eyeball the format (claude already stamped, so
  this is a regression guard, not a new check).

### Out of Scope

- Cross-runtime equivalents of Claude's turn/end/footer markers.
- Restructuring `formatFooter` to a runtime-neutral usage-summary
  format. Today it consumes Claude-specific fields and stays claude-only.
- Moving `FileReadTracker` to a shared module — claude-only today,
  similar heuristics for other runtimes can come as a separate FR-L if
  needed.
- Changes to `onOutput` terminal formatting; this task is log-file only.
