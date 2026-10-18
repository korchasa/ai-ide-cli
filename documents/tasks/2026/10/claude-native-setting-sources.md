---
date: "2026-10-18"
status: in progress
implements: [FR-L18]
tags: [claude, setting-sources, cleanroom, acp]
related_tasks: [2026/10/isolated-child-env.md, 2026/05/claude-stream-hook-events.md]
---
# Claude `settingSources` via native `--setting-sources`

## Goal

`settingSources` must isolate exactly the sources it names (`user` /
`project` / `local`) and keep the agent logged in. Today it isolates only
`user`, drops a keychain login, loses the run's session files with the temp
dir, and relies on a temp config sandbox + symlink — the pattern AGENTS.md
forbids.

## Overview

### Context

- Claude Code 2.1.302 `--help`: `--setting-sources <sources>` — comma-separated
  list of setting sources to load (user, project, local).
- Real-binary probe 2026-10-18 (claude 2.1.302, plan mode, scratch cwd with
  project + local `SessionStart` hooks touching marker files, project
  `CLAUDE.md` with a marker string; user settings carry `model`,
  `enabledPlugins`, user `CLAUDE.md`):
  - no flag → both markers, user model `opus[1m]`, 12 plugins, both
    `CLAUDE.md` seen.
  - `""` → accepted; no markers, no user model/plugins, neither `CLAUDE.md`;
    reply `ok` — keychain login intact.
  - `user` → user model/plugins + user `CLAUDE.md`; no project/local markers,
    no project `CLAUDE.md`.
  - `project,local` → both markers, no user settings.
  - `local` → only local marker. `project` → only project `CLAUDE.md`.
  - `"local, project"` (space) → accepted, both.
  - `bogus` → exit 1, `Error processing --setting-sources: Invalid setting
    source: bogus. Valid options are: user, project, local`.
  - flag twice → last wins.
  - Second probe (project `.claude/agents/probe-agent.md`,
    `.claude/skills/probe-skill/SKILL.md`, `.mcp.json` server): no flag /
    `project` → all three in `system/init`; `""` / `user` → none.
    `--agent probe-agent --setting-sources user` → `--agent 'probe-agent'
    not found. Available agents: …` — fail-fast, clear.
  - So the flag gates hooks, `CLAUDE.md`, model/plugins, agents, skills and
    `.mcp.json` per source.
- History-cleanup hazard (critic, verified in leaked sources
  `~/www/sandbox/claude-code`): headless `-p` schedules
  `cleanupOldMessageFiles` 10 min after start (`main.tsx:2818`,
  `utils/backgroundHousekeeping.ts:29`, unref'd timer); without the `user`
  source `cleanupPeriodDays` falls back to 30. Fixed upstream in 2.1.101.
  Old temp-dir redirect pointed that cleanup at the throwaway dir; the native
  flag on Claude < 2.1.101 would hit the real `~/.claude` for runs > 10 min
  when the user raised `cleanupPeriodDays` above 30.
- Upstream CHANGELOG: flag exists by 2.0.24 (fix "project-level skills not
  loading when --setting-sources 'project'"). 2.1.101 fixed "`--setting-sources`
  without `user` causing background cleanup to ignore `cleanupPeriodDays` and
  delete conversation history older than 30 days" — caveat for older hosts.
  The library declares no minimum Claude version.
- ACP: `@agentclientprotocol/claude-agent-acp` 0.92.0 (`deno.lock`) builds
  SDK options as `{ settingSources: ["user","project","local"], …,
  ...userProvidedOptions }` where `userProvidedOptions =
  _meta.claudeCode.options` (`dist/acp-agent.js` ~8249, 8344, 8364). flowai's
  `claude_judge.ts:280` already sends `_meta.claudeCode.options.settingSources:
  []` directly. This library sends no `_meta` today.
- Precedent for typed flag + legacy `extraArgs`: `CLAUDE_INTENTIONALLY_OPEN_FLAGS`
  + collision check (`--json-schema` FR-L50, `--mcp-config` FR-L35).

### Current State

- `runtime/setting-sources.ts`: `prepareSettingSourcesDir` (temp dir, symlink
  user `settings.json`), `PrepareSettingSourcesResult`,
  `defaultClaudeConfigDir`, `SettingSource`. Public via `deno.json` export
  `./runtime/setting-sources`; barrels re-export only `SettingSource`.
- `claude/process.ts` `executeClaudeProcess` and `claude/session.ts`
  `openClaudeSession` call it and set `env.CLAUDE_CONFIG_DIR = tmpDir`.
- `runtime/acp/mapping.ts` `collectDegradedOptions` warns on non-empty
  `settingSources`; `[]` passes silently.

### Constraints

- No temp config sandbox, no `~/` mutation (AGENTS.md core rule).
- Additive where possible (FR-L48); `SettingSource` type must stay at
  `./runtime/setting-sources` (flowai-workflow `src/mod.ts:134`).
- `requirements.md` is also being edited by the FR-L27/28/29 session —
  touch only FR-L18 and the lines that describe FR-L18 behaviour.

### Affected Surface

Scout report (surface-scout, collected 2026-10-18, verbatim):

````text
## Surface

Worktree root: /Users/korchasa/www/flowai/ai-ide-cli/.claude/worktrees/eloquent-golick-54eb7f (W). The installed `claude` is 2.1.302, and `claude --help` lists `--setting-sources <sources>`. I did not run the binary to probe the empty value. I did not check the oldest supported Claude version.

**Core implementation**
- W/runtime/setting-sources.ts — not affected by consumers beyond the three items below, but it is the code to replace. It holds the `SettingSource` type, `PrepareSettingSourcesResult`, `prepareSettingSourcesDir` (temp dir plus symlink) and `defaultClaudeConfigDir` (lines ~32-115). `defaultClaudeConfigDir` is used only by the two call sites below and by the FR-L53 test in `setting-sources_test.ts`. It calls `hostEnv("CLAUDE_CONFIG_DIR", …)` from `runtime/spawn-env.ts:113`.
- W/claude/process.ts — the interface docs at ~191-195 and the redirect at 477-494 (calls `prepareSettingSourcesDir` and `defaultClaudeConfigDir`, sets `env.CLAUDE_CONFIG_DIR` to the temp dir). It also holds the imports at 41-44 and the header comment at line 7. The argv builder is in the same file, where a native flag would go. `claude/process_test.ts:27-30` asserts that `CLAUDE_CONFIG_DIR` does not leak into the args.
- W/claude/session.ts — the same pattern in the streaming-input session. The option doc is at 86-87, the imports at 48-51, and the redirect at 315-323.
- W/runtime/claude-adapter.ts:175 and :209 — forward `opts.settingSources` to `invoke` and `openSession`.
- W/runtime/setting-sources_test.ts — tests for `prepareSettingSourcesDir` (lines 8-117) and the FR-L53 `defaultClaudeConfigDir` tests (~121-139). The tests go if the function is removed.
- W/claude/auth-env.ts:16 — `CLAUDE_CONFIG_DIR` is in the Claude login-variable list (FR-L53). The redirect interacts with it, which is the keychain-login issue noted in `e2e/claude_hook_events_e2e_test.ts:10-13`.
- W/runtime/spawn-env.ts — `hostEnv` / `spawnEnvOptions` (FR-L53). The `hostEnv` use for `CLAUDE_CONFIG_DIR` goes away with `defaultClaudeConfigDir`. The other users stay: `codex/transcript.ts:25`, `opencode/upstream-error-detector.ts:94,101`, `runtime/acp/handshake.ts:85`.

**Public API (check before choosing remove or deprecate)**
- W/deno.json:11 — the `exports` map has `"./runtime/setting-sources"` as its own subpath. So `prepareSettingSourcesDir`, `defaultClaudeConfigDir`, `PrepareSettingSourcesResult` and `SettingSource` are public through that subpath. Removing any of them is a MAJOR bump (FR-L48). Version 2.0.0 was just released.
- W/mod.ts:70, W/runtime/index.ts:78, W/runtime/types.ts:74 — re-export only the type `SettingSource`. The function is not re-exported from these barrels.
- External consumer of the subpath: /Users/korchasa/www/flowai/flowai-workflow/src/mod.ts:134 does `export type { SettingSource } from "@korchasa/ai-ide-cli/runtime/setting-sources"`. It is type-only, so the type must stay at that path. Copies of this line also sit under `flowai-workflow/.flowai-workflow/**/runs/**/worktree/` (run artifacts, not live code).
- No consumer imports `prepareSettingSourcesDir` or `defaultClaudeConfigDir`. A grep of flowai, tools, personal and sandbox found none. The `$HOME/www` grep covered `*.ts`, `*.md` and `*.json`, excluding archive/ and node_modules/.

**Types and option docs that describe the redirect**
- W/runtime/adapter-types.ts:4,176-182 — the `RuntimeInvokeOptions.settingSources` doc says the adapter redirects `CLAUDE_CONFIG_DIR`.
- W/runtime/session-types.ts:4,15,74 — `RuntimeSessionOptions.settingSources`.
- W/claude/mcp.ts:11 — a comment says it mirrors the shape of `prepareSettingSourcesDir`. See also W/documents/adr/2026-05-03-generic-mcp-server-injection.md:28,120.

**ACP path**
- W/runtime/acp/mapping.ts:19,373,391-396 — `settingSources` is reported as unsupported when non-empty ("no client-side cleanroom equivalent").
- W/runtime/acp/mapping_test.ts:323-330 — the test asserts that report.
- Context: the ACP Claude front takes `settingSources` in `_meta.claudeCode.options` (see /Users/korchasa/www/flowai/flowai/documents/design.md:459, with `tasks/2026/10/claude-judge-over-acp.md:45`). So an ACP mapping exists on the front side. I did not verify it against `runtime/acp/fronts.ts`.
- W/runtime/acp/ files other than `mapping.ts`: not opened.

**Docs and requirements**
- W/documents/requirements.md:
  - FR-L18, lines ~597-620. It says the temp-dir redirect, and the `project` / `local` gap, are documented. The evidence lines point at `setting-sources_test.ts`.
  - Line 261, which mentions `CLAUDE_CONFIG_DIR=<cleanroom>`.
  - Line 675, which says `settingSources` is honored.
  - Lines 1426-1465, FR-L28 (Codex settingSources via `CODEX_HOME` redirect, still pending). It reuses `settingSources` and `prepareCodexSettingSourcesDir`, so it also conflicts with the temp-sandbox rule.
  - Lines 1601, 1840, 2224 and 2316, which mention `settingSources` and related option lists.
  - Lines 3181-3229, FR-L53. Line 3229 cites `setting-sources_test.ts::FR-L53 *`.
- W/documents/design.md:
  - ~167 and 1366-1372 (e2e description).
  - 258.
  - 386-396, the `runtime/setting-sources.ts` section. It says `ANTHROPIC_API_KEY` survives `settingSources: []`.
  - 575-576 (session).
  - 1211 (`defaultClaudeConfigDir`).
  - 1604, which already uses `--setting-sources local`.
  - 1811.
- W/README.md:100 (capability table row "settingSources cleanroom"), 205, 229-237 (example with `CLAUDE_CONFIG_DIR` and `settingSources: ["user"]`, "symlink host settings.json"), 252-258, 480.
- W/AGENTS.md:91 (layout entry for `runtime/setting-sources.ts`), 331, 561. `CLAUDE.md` is a symlink to AGENTS.md.
- W/runtime/AGENTS.md: it matched the grep only through an unrelated `acp` line. Check it for settingSources text.
- W/CHANGELOG.md: auto-generated, not touched.
- Task files that mention the feature: W/documents/tasks/2026/{06/acp-unsupported-option-error, 05/claude-stream-hook-events, 05/acp-transport-poc, 09/launch-interactive-audit, 10/isolated-child-env, 06/acp-parity-closeouts}.md. A new task file is needed under `documents/tasks/2026/10/`.

**E2E and smoke**
- W/e2e/claude_settings_e2e_test.ts — the `settingSources: []` cleanroom e2e. Its comments say the empty config dir causes auth errors.
- W/e2e/claude_hook_events_e2e_test.ts:10-13,72 — it already passes `--setting-sources local` via `extraArgs`. This is evidence that the flag works on 2.1.302, and a precedent for a native path. The comment says the typed `settingSources: []` is avoided because its empty `CLAUDE_CONFIG_DIR` drops a keychain login.
- W/scripts/smoke.ts:10,119-138 — the settings scenario.
- W/e2e/isolated_auth_e2e_test.ts: not opened. It may be relevant to the FR-L53 login-drift check.

**Other consumers affected by behavior**
- /Users/korchasa/www/flowai/flowai/scripts/acceptance-tests/lib/acp/claude_judge.ts:280 and `claude_judge_test.ts:148` — pass `settingSources: []` over the ACP path. A change to ACP mapping affects this.
- /Users/korchasa/www/flowai/flowai-experiments/shared/runner.ts:389 and `scripts/AGENTS.md:52-58` — note that `settingSources: []` yields "Not logged in" because the temp dir strips auth. The note is stale after a native flag.
- tg-ide-bridge, tools/foxcode and the other importers of the library: no `settingSources` usage found in `*.ts`.

## Queries used
- `ls` of W. `grep -rnE "settingSources|setting-sources|prepareSettingSourcesDir|SettingSource|CLAUDE_CONFIG_DIR"` over W, excluding .git and CHANGELOG.
- `grep -rlE "settingSources|prepareSettingSourcesDir|ai-ide-cli"` over `~/www`, then the narrower `grep -rnE "settingSources|prepareSettingSourcesDir|defaultClaudeConfigDir|runtime/setting-sources"` over flowai, tools, sandbox and personal.
- `grep` for `defaultClaudeConfigDir|hostEnv(` in W. `sed` of `runtime/acp/mapping.ts` 385-400.
- `claude --version` (2.1.302) and `claude --help | grep -i setting-sources`.

## Not examined (budget)
- Did not run the real binary with `--setting-sources ""`, `user`, or `project,local`. Not checked: whether an empty value is accepted, or whether the flag exists on the oldest supported Claude version.
- Did not read the body of `runtime/setting-sources.ts`, the ACP `fronts.ts` or `adapter.ts`, `runtime/AGENTS.md`, `e2e/isolated_auth_e2e_test.ts`, or the `capabilities` files for a `settingSources` capability flag.
- Did not read `ai-ide-cli/.github` or `deno.json` publish config beyond line 11.

## Could not rule out
- A native-flag path still has to deal with `CLAUDE_CONFIG_DIR` set by the caller through `env`. This is the FR-L53 isolation interplay in `spawn-env.ts`.
- ACP: the Claude front may accept `settingSources` natively through `_meta`. The current "unsupported" report in `mapping.ts` would then be lifted, which changes the `mapping_test.ts` expectation and the `capabilities` docs.
- FR-L28 (Codex `CODEX_HOME` redirect, pending) conflicts with the same repo rule. It is not strictly part of this request.
- The flowai-workflow copies under `.flowai-workflow/**/runs/**` are historical artifacts. I assume they are not live, but I did not verify that.
````

Dispositions (selected variant: deprecate helpers; ACP warns on `[]` too):

- `runtime/setting-sources.ts` helpers — covered-by Solution 2, DoD 6 (deprecated, removal at next MAJOR — Follow-ups).
- `claude/process.ts` argv builder + redirect — covered-by DoD 1, 2.
- `claude/session.ts` argv builder + redirect — covered-by DoD 1, 2.
- `runtime/claude-adapter.ts:175,209` — not affected — forwards the option unchanged.
- `runtime/setting-sources_test.ts` — covered-by Solution 6, DoD 6 (existing tests stay with the deprecated helpers; `validateSettingSources` cases added).
- `claude/auth-env.ts` — not affected — `CLAUDE_CONFIG_DIR` stays a login var; a caller-set value is no longer overridden.
- `runtime/spawn-env.ts` — not affected — `hostEnv` keeps its other callers.
- `deno.json` export `./runtime/setting-sources` — not affected — kept for `SettingSource`.
- `mod.ts` / `runtime/index.ts` / `runtime/types.ts` — not affected — type-only re-export.
- flowai-workflow `src/mod.ts:134` — not affected — type-only import, type stays.
- No external importer of `prepareSettingSourcesDir` / `defaultClaudeConfigDir` — input to helper-fate choice.
- `runtime/adapter-types.ts`, `runtime/session-types.ts` option JSDoc — covered-by DoD 4.
- `claude/mcp.ts:11` comment, ADR 2026-05-03 — covered-by DoD 4 (comment); ADR not affected — historical record.
- `runtime/acp/mapping.ts` + `mapping_test.ts` — covered-by Solution 5, DoD 7.
- requirements.md FR-L18, line 261 (FR-L9 example), 675 — covered-by DoD 4. FR-L28 — not affected — owned by the FR-L27/28/29 session. Other option-list lines — not affected — they list the field name only. FR-L53 line 3229 — covered-by DoD 4 if the tests move.
- design.md 167, 258, 386-396, 575, 1211, 1366-1372, 1604, 1811 — covered-by DoD 4.
- README.md 100, 205, 229-237, 252-258, 480 — covered-by DoD 4.
- AGENTS.md 91 — covered-by DoD 4. AGENTS.md 331 — not affected — names `settingSources` as a borrowed SDK pattern, still true. AGENTS.md 561 — covered-by DoD 4 (`settingSources: []` stays a safe e2e run on the installed 2.1.302; add the < 2.1.101 caveat). `runtime/AGENTS.md` — checked during DoD 4.
- Task files mentioning the feature (2026/05, 06, 09, 10) — not affected — historical records, not rewritten.
- `CHANGELOG.md` — not affected — generated by `standard-version` from the commit.
- flowai-workflow `.flowai-workflow/**/runs/**` copies — not affected — run artifacts of past workflow runs, not imported by live code.
- requirements.md FR-L53 lines ~3180, 3202, 3205-3209, 3230 — covered-by Solution 8, DoD 4.
- `runtime/reserved-flag-coverage_test.ts` — covered-by Solution 6, DoD 1.
- `e2e/claude_settings_e2e_test.ts` — covered-by DoD 3.
- `e2e/claude_hook_events_e2e_test.ts` — covered-by DoD 3 (switch to typed field).
- `scripts/smoke.ts` settings scenario — covered-by DoD 3.
- `e2e/isolated_auth_e2e_test.ts` — not affected — probes login-status commands, no `settingSources`.
- flowai `claude_judge.ts` — not affected — sends `_meta` to the front directly, not through this library.
- flowai-experiments `runner.ts:389` note — deferred — other repo; Follow-up.
- `CLAUDE_CONFIG_DIR` set by the caller in `env` — covered-by DoD 2 (no longer overridden).

## Definition of Done

- [x] FR-L18: `settingSources` emits `--setting-sources <comma-list>` (`[]` → `""`) on both invoke and session argv; `undefined` emits nothing; invalid entry throws before spawn; typed field + `--setting-sources` in `claudeArgs` throws.
  - Test: `claude/process_test.ts::FR-L18 *`, `claude/session_test.ts::FR-L18 *`
  - Evidence: `deno task test claude/`
- [x] FR-L18: no temp config dir, `CLAUDE_CONFIG_DIR` from caller `env` passes through unchanged.
  - Test: `claude/process_test.ts::FR-L18 settingSources leaves CLAUDE_CONFIG_DIR untouched` (PATH stub echoes env)
  - Evidence: `deno task test claude/process_test.ts`
- [x] FR-L18: real binary — `settingSources: []` stays logged in; e2e and smoke use the typed field.
  - Test: `e2e/claude_settings_e2e_test.ts::e2e settings/claude/*`
  - Evidence: `deno task e2e:claude`
- [ ] FR-L18: SRS FR-L18, SDS, README, AGENTS.md describe the native flag, the per-source gating (hooks, `CLAUDE.md`, agents, skills, `.mcp.json`) and the Claude ≥ 2.1.101 requirement; FR-L53 lines no longer call the config dir an FR-L18 cleanroom source.
  - Test: manual — korchasa
  - Evidence: `grep -rn -F -e 'cleanroom' -e 'prepareSettingSourcesDir' -e 'symlink' documents/requirements.md documents/design.md README.md AGENTS.md` — every hit is the deprecation note or unrelated to FR-L18
- [x] FR-L18: `validateSettingSources` / `SETTING_SOURCES` exported from `./runtime/setting-sources`; old helpers carry `@deprecated`.
  - Test: `runtime/setting-sources_test.ts::FR-L18 validateSettingSources *`
  - Evidence: `deno task test runtime/setting-sources_test.ts && deno doc --lint runtime/setting-sources.ts`
- [x] FR-L18: ACP reports `settingSources` as degraded for `[]` too.
  - Test: `runtime/acp/mapping_test.ts::collectDegradedOptions * settingSources []*`
  - Evidence: `deno task test runtime/acp/mapping_test.ts`
- [x] FR-L18: `deno task check` green.
  - Test: `scripts/check.ts`
  - Evidence: `deno task check`

## Solution

Selected 2026-10-18: helpers → deprecate, remove at the next MAJOR (no
`!` now); ACP → keep the degraded warning, extend it to `[]`.

1. **Baseline**: `deno task check` green before the first edit.
2. **`runtime/setting-sources.ts`** (leaf, no new imports):
   - add `SETTING_SOURCES: readonly SettingSource[]` and
     `validateSettingSources(sources?: SettingSource[]): void` — throws
     `Error('settingSources: unknown source "<x>"; valid: user, project,
     local')` on any member outside the set; `undefined` / `[]` pass.
     FR-L18 marker above each.
   - mark `prepareSettingSourcesDir`, `PrepareSettingSourcesResult`,
     `defaultClaudeConfigDir` `@deprecated` (JSDoc: no longer used; the
     Claude adapter emits `--setting-sources`; removal at next MAJOR).
     Bodies unchanged. Rewrite `@module` doc: native flag, no gap.
3. **`claude/process.ts` `buildClaudeRunOptionArgs`** (shared by
   `buildClaudeArgs` and `buildClaudeSessionArgs`): accept
   `settingSources?: SettingSource[]`; call `validateSettingSources`, then
   `rejectTypedFlagCollision("settingSources", value, ["--setting-sources"],
   claudeArgs)`; when defined push `"--setting-sources", sources.join(",")`
   (`[]` → `""`). Emitted on resume too (settings are per process).
   Add `--setting-sources` to `CLAUDE_INTENTIONALLY_OPEN_FLAGS` with the
   FR-L18 back-compat comment (`e2e/claude_hook_events_e2e_test.ts` and
   any YAML config pass it through `claudeArgs`).
4. **Remove the redirect** in `executeClaudeProcess` and
   `openClaudeSession`: drop `prepareSettingSourcesDir` /
   `defaultClaudeConfigDir` imports, `settingCleanup` and every `finally`
   use of it; `env` keeps caller `CLAUDE_CONFIG_DIR` as is. Update option
   JSDoc in `claude/process.ts`, `claude/session.ts`,
   `runtime/adapter-types.ts`, `runtime/session-types.ts`; header comment
   `claude/process.ts:7`; `claude/mcp.ts:11` comment.
5. **ACP** `runtime/acp/mapping.ts` `collectDegradedOptions`: condition
   `opts.settingSources !== undefined` (was `length > 0`); reason text:
   "ACP fronts read their own config sources; the library does not pass
   setting sources to the front." `mapping_test.ts`: add `[]` case.
6. **Tests (RED first)**:
   - `claude/process_test.ts`: `FR-L18 settingSources emits
     --setting-sources` (`["user","local"]` → `user,local`), `[] → ""`,
     `undefined → absent`, on resume still present, unknown source throws,
     collision with `claudeArgs["--setting-sources"]` throws, legacy
     `claudeArgs` alone passes through.
   - `claude/session_test.ts`: one argv case via `buildClaudeSessionArgs`.
   - `claude/process_test.ts`: `FR-L18 settingSources leaves
     CLAUDE_CONFIG_DIR untouched` — PATH stub `claude` prints
     `$CLAUDE_CONFIG_DIR` and argv into a stream-json `result`; assert
     caller value reaches the child and `--setting-sources` is in argv.
     Pattern: existing PATH-stub tests in `claude/process_test.ts`.
   - `runtime/setting-sources_test.ts`: `validateSettingSources` cases;
     existing `prepareSettingSourcesDir` / FR-L53 tests stay (helper kept).
   - `runtime/reserved-flag-coverage_test.ts`: add `settingSources:
     ["user"]` to the Claude maximal option sets (`:103-145`) so
     `--setting-sources` is actually emitted; RED until the flag is in
     `CLAUDE_INTENTIONALLY_OPEN_FLAGS`.
7. **e2e / smoke**: `e2e/claude_settings_e2e_test.ts` — `settingSources: []`
   must return `output` (logged in), not only "returns"; second case
   `["local"]` in a tmp cwd with `.claude/settings.local.json` +
   `.claude/settings.json` SessionStart hooks touching markers → only the
   local marker exists. `e2e/claude_hook_events_e2e_test.ts` → typed
   `settingSources: ["local"]`, fix its header comment.
   `scripts/smoke.ts` settings scenario text.
8. **Docs**: SRS FR-L18 rewritten (native flag, per-source isolation
   incl. `CLAUDE.md`, `[]` → `""`, validation, collision, pre-2.1.101
   cleanup caveat → `settingSources` requires Claude ≥ 2.1.101, flag
   absent before ~2.0.24 fails fast as unknown option; per-source gating
   incl. agents / skills / `.mcp.json` and the `--agent` not-found case;
   ACP degraded incl. `[]`; deprecated helpers); FR-L9 example line 261 and
   FR-L19 line 675 wording; FR-L53: drop "FR-L18 cleanroom" from the
   library-vars list (~3180) and the child-facing path list (~3202), keep
   the `HOME` failure note only for paths still computed, keep the
   line ~3230 evidence (tests stay with the deprecated helper). SDS
   sections listed in Affected Surface. README 100, 205, 229-237, 252-258,
   480. AGENTS.md layout entry line 91.
9. **CHECK**: `deno task check`; `deno task e2e:claude` for the two e2e
   files.

Release: `feat(claude)` — MINOR. Behaviour of the existing field changes
(`[]` / `["user"]` now also drop project + local), which is what FR-L18
promised; no caller of `settingSources` through this library found in
`~/www` (scout + critic greps).

Error handling: validation and collision throw synchronously from the
argv builders, before spawn and before the retry loop — same as the
FR-L24/25/50 typed options.

## Follow-ups

- Remove `prepareSettingSourcesDir`, `PrepareSettingSourcesResult`,
  `defaultClaudeConfigDir` (+ their tests and the FR-L53 evidence line) in
  the next MAJOR, together with the dead Codex `response.processed` type.
- Claude < 2.1.101 history-cleanup hazard: documented as a minimum version,
  no runtime gate (a gate = extra `claude --version` spawn per run). Ask
  the user whether a gate is wanted.
- ACP Claude front accepts `_meta.claudeCode.options.settingSources`
  (`claude-agent-acp` 0.92.0); carrying it is a separate task.

- flowai-experiments `shared/runner.ts:389` + `scripts/AGENTS.md:52-58`: stale
  "settingSources leaks / Not logged in" notes — other repo.
