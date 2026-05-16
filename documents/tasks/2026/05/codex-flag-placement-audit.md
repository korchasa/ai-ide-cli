---
date: "2026-05-17"
status: to do
implements: [FR-L13, FR-L14]
tags: [codex, argv, placement, 0.123]
related_tasks: [codex-ban-full-auto-flag]
---

# Codex: Audit Flag Placement After 0.123 Root-Inheritance

GitHub issue: <https://github.com/korchasa/ai-ide-cli/issues/7>.

## Goal

Pin the canonical "subcommand-position only" rule for every flag
emitted by `buildCodexArgs`, so the Codex 0.123+ root-inheritance
change (root-level `--sandbox`/`--model` now inherited into `exec`)
cannot silently cause duplicate-flag emission. The invariant
already holds structurally; this task locks it in with a regression
test and documents the placement contract in AGENTS.md / SRS / SDS.

## Overview

### Context

Codex `rust-v0.123.0` (2026-04-23) release notes: "Made `codex exec`
inherit root-level shared flags such as sandbox and model options
(#18630)". For older binaries `codex --sandbox X exec --sandbox Y`
was ambiguous; on 0.123+ the root value pre-populates `exec`.

Adapter audit (codex/argv.ts:92): `buildCodexArgs` starts argv with
`["exec", "--experimental-json"]` and appends every flag AFTER
`exec`. No root-position emission exists. Reserved flags
(`CODEX_RESERVED_FLAGS = ["--experimental-json", "--model", "--cd",
"--sandbox"]`) prevent `extraArgs` from injecting a duplicate
collision for those keys. `--config` is intentionally open
(repeatable per Codex convention; last-wins).

Upstream: <https://github.com/openai/codex/releases/tag/rust-v0.123.0>.

### Current State

- `codex/argv.ts:buildCodexArgs` — only emission point; subcommand
  position only.
- `codex/argv.ts:CODEX_RESERVED_FLAGS` — already de-duplicates
  `--sandbox`/`--model`/`--cd`/`--experimental-json` against
  `extraArgs`.
- `runtime/argv.ts:expandExtraArgs` — flat `Record<string, string|null>`,
  unique keys structurally.
- `codex/argv_test.ts` — covers only the `--full-auto` deprecation ban
  (FR-L13). No no-duplicate-placement invariant.
- `runtime/AGENTS.md` codex bullet — describes mode mapping; no
  placement rule.
- SRS `### 3.13 FR-L13` — no duplicate-placement Acceptance bullet.
- SDS `### 3.10.4 codex/argv.ts` — no canonical-placement note.
- `documents/index.md` — FR-L14 row absent; FR-L13 row present.

### Constraints

- Public API surface (`RuntimeInvokeOptions.extraArgs`,
  `ExtraArgsMap`) MUST stay byte-stable.
- No reflection on installed Codex version at runtime.
- No speculative API additions (no root/exec bucket map).
- "Fail fast, fail clearly" — regression guard MUST be a test
  failure, not a runtime warning.
- TDD baseline: `NO_COLOR=1 deno task check` green before edits.

## Definition of Done

- [ ] FR-L13: `codex/argv.ts:buildCodexArgs` never emits a duplicate
      shared flag for any combination of `model` / `cwd` /
      `permissionMode` / `reasoningEffort` / `extraArgs`. Test path:
      `codex/argv_test.ts::"no duplicate shared flag positions"`.
      Evidence: `NO_COLOR=1 deno task test codex/argv_test.ts`.
- [ ] FR-L13: `codex/argv.ts:buildCodexArgs` never emits two
      `--config <key>=...` pairs sharing the same key when the typed
      paths (permission mode, reasoning effort, mcpServers) collide
      with adapter-emitted keys. Same test as above, second
      assertion section. Evidence:
      `NO_COLOR=1 deno task test codex/argv_test.ts`.
- [ ] FR-L14: `runtime/AGENTS.md` codex bullet documents the
      placement convention: all flags emit at subcommand position;
      `extraArgs` map is a single bucket appended at the end of
      subcommand argv; Codex 0.123 root-inheritance is N/A since the
      adapter never writes root-position flags; `--config` is
      intentionally repeatable with last-wins semantics. Evidence:
      `grep -n "subcommand position\|placement" runtime/AGENTS.md`.
- [ ] FR-L13: SRS `### 3.13 FR-L13` Acceptance includes a
      no-duplicate-placement invariant referencing the new test.
      Evidence: `grep -n "duplicate placement" documents/requirements.md`.
- [ ] FR-L13: SDS `### 3.10.4` for `codex/argv.ts` notes the canonical
      placement rule (subcommand-only; reserved-flag de-dup;
      `--config` intentionally open). Evidence:
      `grep -n "placement" documents/design.md`.
- [ ] `documents/index.md` `## FR` rows: FR-L13 entry updated to
      reference placement; FR-L14 row added. Evidence:
      `grep -n "FR-L13\|FR-L14" documents/index.md`.
- [ ] Final check: `NO_COLOR=1 deno task check` exits 0.

## Solution

1. **RED — extend `codex/argv_test.ts`.**
   - Add a new `Deno.test("no duplicate shared flag positions", …)`
     directly under the existing `--full-auto` test.
   - Iterate `ALL_MODES` (already declared at the top of the file).
   - For each mode, build argv with a representative options object
     that exercises every emission path:
     ```ts
     const argv = buildCodexArgs({
       permissionMode: mode,
       model: "gpt-5",
       cwd: "/tmp/scratch",
       reasoningEffort: "medium",
       extraArgs: { "--config": "web_search=true" },
     } as RuntimeInvokeOptions);
     ```
   - Assertion A (reserved-flag uniqueness): for each token in
     `["--experimental-json", "--model", "--cd", "--sandbox"]`,
     `argv.filter(t => t === token).length <= 1`.
   - Assertion B (`--config` key uniqueness): collect every value
     that immediately follows a `--config` token; for each value,
     split on the FIRST `=` and take the LHS verbatim (so
     `approval_policy="never"` → LHS `approval_policy`,
     `mcp_servers.foo.command="bar"` → LHS `mcp_servers.foo.command`);
     assert the LHS multiset has no duplicates.
   - **Scope**: this test asserts ADAPTER-induced collisions are
     impossible. CONSUMER-induced collisions (e.g. consumer passes
     `extraArgs: {"--config": "approval_policy=\"foo\""}` while
     `permissionMode: "plan"` is set) are out of scope — `--config`
     is intentionally open and Codex's last-wins semantics apply.
     The representative options object in the test therefore picks
     a non-colliding `extraArgs` `--config` key
     (`web_search=true`).
   - Add `// FR-L13` comment directly above the `Deno.test(...)`
     line. (Reuse the existing `ALL_MODES` constant in-file — no new
     enumeration.)
   - Run `NO_COLOR=1 deno task test codex/argv_test.ts` — test
     compiles and passes (negative invariant on already-correct
     code).

2. **GREEN — no production change.**
   The invariant already holds:
   - Reserved-flag de-dup via `CODEX_RESERVED_FLAGS` makes
     Assertion A impossible to fail.
   - Typed paths emit at most one `--config approval_policy=...`,
     one `--config model_reasoning_effort=...`, and unique
     `--config mcp_servers.<name>.*` keys; `extraArgs` adds one
     more `--config` token per map entry, but every map entry is
     unique by Map semantics, so Assertion B holds as long as
     consumers don't intentionally collide on `approval_policy`
     or `model_reasoning_effort` via `extraArgs`. The test passes
     for the typical case (the representative options object
     above). Skip GREEN.

3. **REFACTOR — none.** Single new test in an existing file; no
   helper extraction.

4. **`runtime/AGENTS.md` — new top-level bullet under `Key decisions:`.**
   Insert a new top-level bullet just after the `codex` bullet
   (around line 12), titled **"Codex argv placement"**. One short
   paragraph stating:
   - `buildCodexArgs` emits `exec` first; every subsequent flag
     (`--model`, `--cd`, `--sandbox`, `--config <k=v>`,
     `extraArgs`) is at subcommand position.
   - Codex 0.123 root-inheritance does NOT apply — the adapter
     never writes flags before `exec`.
   - `extraArgs` is a single bucket appended at the end of
     subcommand argv. Reserved flags
     (`CODEX_RESERVED_FLAGS`) throw on collision; `--config` is
     intentionally repeatable (last-wins by Codex convention).

5. **SRS `documents/requirements.md` — FR-L13 Acceptance.**
   Append a new bullet to the FR-L13 Acceptance list (immediately
   after the `--full-auto` ban bullet at line 399-402):
   ```
   - [x] `buildCodexArgs()` enforces canonical no-duplicate placement
         — every flag emits at subcommand position only (Codex 0.123
         root-inheritance is N/A) and no `--config <key>=...` pair
         repeats its key in a single argv. Evidence:
         `ai-ide-cli/codex/argv_test.ts`.
   ```
   Surgical: do not touch other FR sections or whitespace.

6. **SDS `documents/design.md` — §3.10.4 `codex/argv.ts`.**
   Append one sentence to the `codex/argv.ts` bullet (around line
   829-831): `Canonical placement: every emitted flag lives at
   subcommand position (after exec); reserved flags structurally
   de-duplicate against extraArgs; --config is intentionally open
   (repeatable, last-wins).`

7. **`documents/index.md` — FR rows.**
   - Update existing FR-L13 row summary to include the placement
     invariant alongside permission profiles: `Codex CLI wrapper
     (invokeCodexCli, buildCodexArgs, permission-profile argv,
     no-duplicate placement)`.
   - Insert a new FR-L14 row (alphabetically sorted between L13
     and L16):
     `- [FR-L14](requirements.md#3-14-fr-l14-map-shaped-extraargs--runtime_args) — Map-shaped extraArgs / runtime_args — [x]`.

8. **SRS-inline `Tasks:` back-pointer.**
   - FR-L13 already has a `**Tasks:**` bullet
     (`[codex-ban-full-auto-flag](...)`). Append
     `, [codex-flag-placement-audit](tasks/2026/05/codex-flag-placement-audit.md)`
     to that list.
   - FR-L14 has no `**Tasks:**` bullet — insert
     `- **Tasks:** [codex-flag-placement-audit](tasks/2026/05/codex-flag-placement-audit.md)`
     immediately after FR-L14's `**Description:**` bullet.

9. **Final check.**
   - `NO_COLOR=1 deno task check` — must exit 0.

## Follow-ups

- (Deferred) Real-binary e2e smoke
  `e2e/lifecycle_hooks_e2e_test.ts::"codex sandbox flag is not
  duplicated"`. The structural test already proves the invariant
  without spending tokens; the e2e variant adds value only as
  upstream-protocol drift insurance and stays opt-in.
- (Deferred) Optional FR-L14 expansion to bucketed `extraArgs`
  (`{root, exec}`). Speculative until Codex makes a flag
  root-position-only; current bucketing is implicit (single bucket
  = subcommand).
