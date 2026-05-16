---
date: "2026-05-17"
status: to do
implements: [FR-L13]
tags: [codex, argv, permission-mode, deprecation]
related_tasks: []
---

# Codex: Ban Deprecated --full-auto Flag

GitHub issue: <https://github.com/korchasa/ai-ide-cli/issues/6>.

## Goal

Lock in the contract that the Codex adapter never emits the
`--full-auto` flag (deprecated in `codex rust-v0.128.0`, slated for
removal in a later minor), so a future contributor cannot silently
reintroduce it and break consumers running modern Codex binaries.

## Overview

### Context

Codex `rust-v0.128.0` (2026-04-30) deprecated `--full-auto` and steers
users toward explicit permission profiles. Historically OpenAI removes
deprecated CLI flags within 1–2 minors. Upstream:

- <https://github.com/openai/codex/releases/tag/rust-v0.128.0>
- <https://github.com/openai/codex/releases/tag/rust-v0.122.0>

### Current State

- `codex/argv.ts:buildCodexArgs` already emits the modern profile path
  (`--sandbox <mode>` + `--config approval_policy="<mode>"`) via
  `permissionModeToCodexArgs` → `decidePermissionMode`.
- `codex/permission-mode.ts:decidePermissionMode` already maps every
  public `permissionMode` value (`default`, `plan`, `acceptEdits`,
  `bypassPermissions`) plus Codex-native pass-through values
  (`read-only`, `workspace-write`, `danger-full-access`, `never`,
  `on-request`, `on-failure`, `untrusted`) onto 0.122+ profile fields.
- `grep -rn "full-auto"` across the repo returns zero hits — no code
  rewrite required.
- `codex/permission-mode_test.ts` already cross-validates the two
  transport serializers but does NOT assert the negative invariant
  "argv never contains `--full-auto`".
- SRS FR-L13 `**Acceptance:**` lists `--sandbox` + `approval_policy`
  evidence but does not state the `--full-auto` ban explicitly.
- SDS §3.10 / §3.10.x describes the profile-based path but no
  deprecation note.

### Constraints

- Public API surface (`RuntimeInvokeOptions.permissionMode`) MUST stay
  byte-stable — no signature change.
- "Fail fast, fail clearly" — the regression guard MUST surface as a
  test failure, not a runtime warning.
- No speculative API additions (e.g. denylisting `--full-auto` from
  `extraArgs`) — issue scope is the builder output and the contract
  doc, nothing more.
- TDD baseline: `NO_COLOR=1 deno task check` green before edits.

## Definition of Done

- [ ] FR-L13: `codex/argv.ts:buildCodexArgs` never emits `--full-auto`
      for any recognized `permissionMode` value (the full enumeration
      from `decidePermissionMode`'s docblock, plus `undefined` and a
      garbage value). Test path:
      `codex/argv_test.ts::"never emits deprecated --full-auto"`.
      Evidence: `NO_COLOR=1 deno task test codex/argv_test.ts`.
- [ ] FR-L13: SRS `### 3.13 FR-L13` Acceptance lists an explicit ban:
      "`buildCodexArgs()` never emits `--full-auto`". Evidence:
      `grep -n "full-auto" documents/requirements.md` returns exactly
      one line, inside FR-L13 Acceptance, phrased as a ban.
- [ ] SDS `### 3.10` (or sub-section covering `codex/argv.ts`) notes
      that `--full-auto` is intentionally never emitted post-0.128
      deprecation. Evidence:
      `grep -n "full-auto" documents/design.md` returns exactly one
      line in the codex section.
- [ ] `documents/index.md` `## FR` row for FR-L13 is present (add if
      missing, leave intact if present). Evidence:
      `grep -n "FR-L13" documents/index.md`.
- [ ] Final check: `NO_COLOR=1 deno task check` exits 0.

## Solution

1. **RED — write the regression test.**
   - Create `codex/argv_test.ts` with one Deno test
     `"never emits deprecated --full-auto"`.
   - Iterate the same `ALL_MODES` enumeration used by
     `codex/permission-mode_test.ts` (`undefined`, `default`, `plan`,
     `acceptEdits`, `bypassPermissions`, `read-only`,
     `workspace-write`, `danger-full-access`, `never`, `on-request`,
     `on-failure`, `untrusted`, `garbage`).
   - For each mode, call
     `buildCodexArgs({ permissionMode: mode } as RuntimeInvokeOptions)`
     and assert the resulting array does NOT contain `"--full-auto"`.
   - Run `NO_COLOR=1 deno task test codex/argv_test.ts` and confirm
     the test compiles+passes (this is a *negative* invariant on
     code that is already correct; the file currently does not exist
     so the test is the new artifact, not a code change).
   - Add a `// FR-L13` comment directly above the `Deno.test(...)`
     call to satisfy the traceability rule in AGENTS.md.

2. **GREEN — already green.** No production code change required;
   the negative invariant holds today. Skip to step 3.

3. **REFACTOR — none.** The test file is a single-purpose file; no
   shared helper extraction warranted.

4. **SRS update (`documents/requirements.md`).**
   - In `### 3.13 FR-L13: Codex CLI Wrapper` `- **Acceptance:**`
     list, append a new bullet:
     `- [x] buildCodexArgs() never emits deprecated --full-auto
     (Codex rust-v0.128.0 deprecation). Evidence:
     ai-ide-cli/codex/argv_test.ts::"never emits deprecated --full-auto".`
   - Surgical edit: do not touch any other FR section, do not
     reflow whitespace.

5. **SDS update (`documents/design.md`).**
   - Locate the `### 3.10` block (or its `codex/argv.ts` sub-section
     near line 738 — the `permissionModeToCodexArgs` description).
   - Append one sentence to that bullet:
     `Codex's deprecated --full-auto flag is intentionally never
     emitted (rust-v0.128.0 deprecation; permission profiles are
     the supported replacement).`
   - Surgical edit only.

6. **Index update (`documents/index.md`).**
   - Verify the `## FR` section has a row for FR-L13. If absent, add
     `- [FR-L13](requirements.md#3-13-fr-l13-codex-cli-wrapper) —
     Codex CLI Wrapper — [x]` and keep rows sorted alphabetically
     by FR-ID.

7. **Final check.**
   - Run `NO_COLOR=1 deno task check`. Must exit 0.

## Follow-ups

- (Deferred) Consider adding `--full-auto` to `CODEX_RESERVED_FLAGS`
  so consumer-supplied `extraArgs` is rejected on the deprecated
  flag — out of scope here because it is a behavior change and
  there is no evidence any consumer relies on it. File a separate
  task if needed after monitoring downstream usage.
