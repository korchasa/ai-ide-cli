---
date: "2026-10-18"
status: done
implements:
  - FR-L28
tags: [settingSources, codex, opencode, cursor, breaking]
related_tasks:
  - 2026/10/claude-native-setting-sources.md
---
# Non-Claude CLI runtimes reject `settingSources`

## Goal

A caller asking Codex / OpenCode / Cursor for a cleanroom (`settingSources: []`) must get an error, not a silent run on the user's full config (fail-fast rule).

## Overview

### Context

- SRS §3.28 rescoped 2026-10-18 (commit `c8d9edb`): old temp-`CODEX_HOME` design dropped (sandbox copy of user config forbidden by AGENTS.md; `CODEX_HOME` holds the Codex login).
- No known consumer in `~/www` passes `settingSources` to a non-Claude runtime (grep 2026-10-18).
- Parallel task `claude-native-setting-sources.md` (FR-L18) touches the same JSDoc, FR-L18 text and README row → expect small text conflicts at merge.

### Current State

- `runtime/{codex,opencode,cursor}-adapter.ts` drop `settingSources` silently on both `invoke` and `openSession`.
- OpenCode / Cursor already call `rejectUnsupportedRunOptions` for FR-L50 / FR-L52 on the CLI branch; Codex adapter does not.

### Constraints

- Breaking → `!` commit (FR-L48).
- ACP transport keeps `collectDegradedOptions` report — out of scope.
- Rejection at the adapter, after the ACP dispatch, same as FR-L50 / FR-L52.

## Definition of Done

- [x] Codex / OpenCode / Cursor invoke + session throw `RuntimeUnsupportedOptionError(fields: ["settingSources"])` for `[]` and non-empty arrays; `undefined` passes.
  - Test: `runtime/run-options_test.ts::FR-L28 *`
  - Evidence: `deno task test runtime/run-options_test.ts`
- [x] JSDoc (`runtime/adapter-types.ts`, `runtime/session-types.ts`), SRS FR-L18 / FR-L28, SDS §3.x, README capability row, `runtime/AGENTS.md` updated.
  - Test: manual — korchasa
  - Evidence: `grep -rn -F 'FR-L28' runtime/*.ts README.md documents/design.md`
- [x] `deno task check` green.
  - Test: `scripts/check.ts`
  - Evidence: `deno task check` → 797 passed, 0 failed

## Solution

1. Add `"settingSources"` to the OpenCode / Cursor `rejectUnsupportedRunOptions` field lists (invoke + session).
2. Codex adapter: `rejectUnsupportedRunOptions("codex", opts, ["settingSources"])` on both CLI branches.
3. `// FR-L28` above each call.
4. Tests in `runtime/run-options_test.ts`: loop over the three runtimes; `undefined` case proven by reaching the later `reasoningEffort` validation error.
5. Docs as listed in DoD.
