---
date: "2026-10-18"
status: done
implements: [FR-L53]
tags: [env, isolation, spawn, consumer]
related_tasks: []
---
# Child agent env independent of the caller's env

## Goal

An app built on this library that runs inside an agent session (Claude Code,
Codex, …) or a shell full of agent variables passes that whole environment
to every agent it spawns. The child then behaves differently depending on
where its caller happened to run: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`ANTHROPIC_*`, `OTEL_*`, proxy settings, `CLAUDE_CODE_*` switches all leak
in. Consumers need a mode where the child env is exactly what they specify,
so a run is reproducible regardless of the caller's env.

## Overview

### Context

- Request (user, 2026-10-18): "если приложение с ai-ide-cli вызывает агент
  из консоли, то туда пробрасываются все переменные окружения самого агента.
  Нужен метод работы, при котором переменные окружения вызывающего не
  влияют".
- `Deno.Command({env})` merges `env` over the parent env; only
  `clearEnv: true` stops inheritance. Probe 2026-10-18, Deno 2.9.7:
  - `clearEnv: true, env: {}` → binary still resolved through the PARENT
    `PATH` (`env` found); child sees no `PATH`.
  - `clearEnv: true, env: {PATH: "/nonexistent"}` → `NotFound` (lookup uses
    the child `PATH` when given).
  - `claude --version` with empty env → exit 0; `codex --version` with
    empty env → exit 127 `env: node: No such file or directory` (npm shim
    needs `PATH`); with `PATH` only → exit 0.
  - So a clean env works only when the caller supplies at least `PATH`
    (Codex) and `HOME` (auth / config lookup).
- Semver (AGENTS.md): new optional field = MINOR; changing the default to a
  clean env = MAJOR for every consumer.

### Current State

- Every agent spawn site passes `env` without `clearEnv` → full parent env
  inherited. ACP client copies it explicitly:
  `runtime/acp/client.ts:194` `{ ...Deno.env.toObject(), ...opts.env }`.
- `env` option doc: "Extra environment variables merged into the subprocess
  env" (`runtime/adapter-types.ts:143`, `runtime/session-types.ts:63`).
- Library-side parent-env reads that feed the child: default Claude config
  dir (`runtime/setting-sources.ts:97`, `runtime/claude-adapter.ts:68`),
  skill dirs for `launchInteractive` (`runtime/codex-adapter.ts:69`,
  `runtime/opencode-adapter.ts:118`), Codex rollout lookup
  (`codex/transcript.ts:14`), `CODEX_CONFIG` in ACP handshake
  (`runtime/acp/handshake.ts:77`).

### Constraints

- Default behaviour unchanged (additive, MINOR).
- No silent fallbacks: the library must not quietly re-add parent vars in
  isolated mode.
- No mutation of `~/` or temp sandboxes beyond what already exists.
- Library-injected vars (`PWD` FR-L33, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
  FR-L45, `CLAUDE_CONFIG_DIR` for FR-L18 cleanroom, ACP front `env`) stay —
  they are the library's own, not the caller's.

### Affected Surface

Scout report (surface-scout, verbatim):

```
## Surface

Premise confirmed. Every spawn passes `env` to `Deno.Command` without `clearEnv`. Deno merges that env on top of the parent's `Deno.env`, so the caller's whole environment leaks to the child. The only exception is the ACP path, which copies the parent env explicitly. The existing `env` option is documented as "merged", so it can only add or override variables.

**Option types (where a new knob would be declared)**
- `RuntimeInvokeOptions.env` — `/Users/korchasa/www/flowai/ai-ide-cli/runtime/adapter-types.ts:144` — doc says "merged into the subprocess env".
- `RuntimeSessionOptions.env` — `/Users/korchasa/www/flowai/ai-ide-cli/runtime/session-types.ts:63-64` — same merge semantics.
- `InteractiveOptions.env` — `/Users/korchasa/www/flowai/ai-ide-cli/runtime/adapter-types.ts:354-356`.
- Public export surface — `/Users/korchasa/www/flowai/ai-ide-cli/mod.ts`, `/Users/korchasa/www/flowai/ai-ide-cli/runtime/index.ts`, and the `exports` map in `deno.json`. Per AGENTS.md, any new exported type needs a `private-type-ref` check against these entries.
- Per-runtime option copies that pass `env` through — `runtime/claude-adapter.ts:219,254`, `runtime/cursor-adapter.ts:213`, `runtime/opencode-adapter.ts:238`, `runtime/capabilities.ts:245`, `runtime/acp/adapter.ts:375,679`, `runtime/acp/commands.ts:128`, `runtime/acp/mapping.ts:182`, `codex/session.ts:206`, `cursor/session.ts:232`, `cursor/process.ts:249`, `codex/process.ts:164`.

**Spawn sites (each one decides what the child inherits)**
- `claude/process.ts:478-517` — builds env from `opts.env`, adds `CLAUDE_CONFIG_DIR` for the cleanroom, then calls `withSyncedPWD`. The comment at line 509 says "Deno.Command merges env with parent".
- `claude/session.ts:307-340` — same pattern for the streaming-input session.
- `runtime/claude-adapter.ts:312-333` — `launchInteractive`, same pattern.
- `opencode/process.ts:265`, `opencode/session.ts:212`, `opencode/transcript.ts:56` — the transcript spawn also receives the PWD sync (comment at line 54); check whether it passes any env.
- `runtime/opencode-adapter.ts:255-282` — `launchInteractive`.
- `codex/process.ts:252-258`, `codex/app-server.ts:307-313`, `runtime/codex-adapter.ts:226-232` — `launchInteractive`.
- `cursor/process.ts:341-347`, `cursor/session.ts:279-285`, `cursor/chat.ts:44-51`. `runtime/cursor-adapter.ts:234` has a `launchInteractive` that I did not open.
- `runtime/acp/client.ts:194-201` — different shape. It explicitly does `{ ...Deno.env.toObject(), ...opts.env }`, so the parent env is copied in code. `Deno.Command` would not need to inherit it. A clean-env mode has to change this line, not just add a `clearEnv` flag.
- `runtime/acp/handshake.ts:75-84` merges `front.env` with `opts.env`, and `handshake.ts:77` reads `Deno.env.get("CODEX_CONFIG")`. That is a second parent-env read, in `runtime/acp/mapping.ts:330-353` (`codexThreadStartEnv`).
- `runtime/acp/fronts.ts:103` — the Claude front's own env (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`).

**Shared env helpers**
- `/Users/korchasa/www/flowai/ai-ide-cli/runtime/env-cwd-sync.ts` — `withSyncedPWD` is called at every spawn site. It returns `undefined` when env and cwd are both absent. Several sites use `...(syncedEnv ? { env: syncedEnv } : {})`, so an "env undefined" case would silently keep full inheritance. It also adds `PWD` on top of an empty env.
- `/Users/korchasa/www/flowai/ai-ide-cli/claude/nonessential-traffic.ts` — `withNonessentialTrafficDisabled` skips setting the flag when the caller already set it. Note the AGENTS.md remark that the child tests the flag with `if (env.FOO)`, so a caller's value can win.
- `runtime/mcp-injection.ts:152-175` — reads `opts.env["OPENCODE_CONFIG_CONTENT"]`, so it is an env consumer.

**Places that read the parent env themselves (leakage in the library, not only to the child)**
- `runtime/claude-adapter.ts:68`, `runtime/setting-sources.ts:97` — `CLAUDE_CONFIG_DIR` and `HOME`. With a clean env the child may not have `HOME`, while the library resolves the config dir from the parent's `HOME`. Also `runtime/codex-adapter.ts:69`, `runtime/opencode-adapter.ts:118` (`HOME`) and `codex/transcript.ts:14-15` (`CODEX_HOME`, `HOME`).
- Auth and PATH — a clean env would drop `PATH`, `HOME`, API keys (`ANTHROPIC_API_KEY` and the like), and proxy and locale variables. E2E auth probing in `e2e/_helpers.ts:173` reads `Deno.env.get(apiEnv)`. `e2e/_auth.ts` was not opened.

**Tests**
- Existing tests for the env merge, `PWD` sync and `launchInteractive`: `claude/session_test.ts`, `opencode/session_test.ts`, stub-based tests per runtime (PATH-override bash stubs), `runtime/env-cwd-sync*_test.ts`, `claude/nonessential-traffic*_test.ts`, `runtime/session_contract_test.ts`, `process-registry_test.ts`. I did not enumerate the exact env test files.
- E2E: `/Users/korchasa/www/flowai/ai-ide-cli/e2e/` (`_helpers.ts`, `_matrix.ts`, `claude_settings_e2e_test.ts`, `_acp_retry_wrapper.ts:96` spawns with env). A new real-binary check for an isolated env would fit here.

**Docs**
- `/Users/korchasa/www/flowai/ai-ide-cli/documents/requirements.md` — FR-L33 (about line 1688-1730, "Sync PWD", where it names the inherited `PWD`), and line 2798, "Dep: FR-L33 (same spawn-boundary env discipline)". A new FR-L<N> would be needed (workflow: SRS, then SDS, then code).
- `/Users/korchasa/www/flowai/ai-ide-cli/documents/design.md` — component sections for the adapters and the env helpers.
- `/Users/korchasa/www/flowai/ai-ide-cli/README.md`, `/Users/korchasa/www/flowai/ai-ide-cli/runtime/AGENTS.md` — mention env, so check them. The README typed examples must be grep-verified against the types.
- `/Users/korchasa/www/flowai/ai-ide-cli/documents/tasks/2026/10/<slug>.md` — GODS task file required; `CHANGELOG.md` is release-generated.
- Semver — a new optional field is additive (MINOR). Changing the default to a clean env would be breaking (MAJOR) for every consumer, such as `@korchasa/flowai-workflow`.

**External consumers**
- `@korchasa/flowai-workflow` and other importers of `jsr:@korchasa/ai-ide-cli@<ver>`. Per AGENTS.md they pin it by import specifier, so check them by grepping source for the import. That is outside this repo and I did not look.

**Not affected**
- `/Users/korchasa/www/flowai/ai-ide-cli/scripts/check.ts` and `scripts/generate-release-notes.ts` spawn git and deno tooling, not agent CLIs. `skill/` has no spawns.
- `process-registry.ts` has no env logic.

## Queries used
- `ls` of the repo root.
- grep over `*.ts` for `Deno.Command`, `clearEnv`, `env:`, `.env`, `withSyncedPWD`, `withNonessential`.
- grep for `launchInteractive` and `Deno.Command(`.
- grep for `env?:` in `runtime/adapter-types.ts` and `runtime/session-types.ts`.
- grep of the docs for `env`, `FR-L33`, `inherit`.
- `ls opencode` and a grep for spawn in `opencode/`.

## Not examined (budget)
- Bodies of the `launchInteractive` methods in `runtime/cursor-adapter.ts` and `runtime/codex-adapter.ts` beyond the `Deno.Command` call.
- `opencode/transcript.ts` env argument, `e2e/_auth.ts`, the exact test files covering env, and the content of `design.md`, `README.md` and `runtime/AGENTS.md` about env.
- Consumer repos (flowai-workflow and others).

## Could not rule out
- Whether stdout and stderr aside, the child CLIs spawn their own subprocesses (MCP servers, hooks) that inherit whatever env the child sees. Isolation of the child would then also cover those.
- Whether `clearEnv` is available in the pinned Deno version (check `deno.json` and the Deno version before relying on it).
- Env set outside `Deno.Command`, for example `CODEX_CONFIG` read at `runtime/acp/handshake.ts:77`.
```

Dispositions (variant B):

- Option types (`RuntimeInvokeOptions`, `RuntimeSessionOptions`, `InteractiveOptions`) — covered-by Solution step 2
- Per-runtime option copies passing `env` through — covered-by Solution step 2
- Claude spawn sites (`claude/process.ts`, `claude/session.ts`, `runtime/claude-adapter.ts` interactive) — covered-by Solution step 3
- OpenCode spawn sites (`opencode/process.ts`, `opencode/session.ts`, `opencode/transcript.ts`, interactive) — covered-by Solution step 3
- Codex spawn sites (`codex/process.ts`, `codex/app-server.ts`, interactive) — covered-by Solution step 3
- Cursor spawn sites (`cursor/process.ts`, `cursor/session.ts`, `cursor/chat.ts`) — covered-by Solution step 3; Cursor interactive — not affected — `runtime/cursor-adapter.ts:234` throws, spawns nothing
- ACP client explicit parent copy (`runtime/acp/client.ts:194`) — covered-by Solution step 3
- ACP handshake `CODEX_CONFIG` parent read (`runtime/acp/handshake.ts:77`) — covered-by Solution step 4
- ACP front env (`runtime/acp/fronts.ts:103`) — not affected — library-owned var, kept by Constraints
- `withSyncedPWD` undefined-env path — covered-by Solution step 1 (`spawnEnvOptions` emits `env: {}` + `clearEnv` when isolated)
- `withNonessentialTrafficDisabled` — not affected — library-owned var, kept by Constraints
- `runtime/mcp-injection.ts` env read — not affected — reads `opts.env` only (`runtime/mcp-injection.ts:152-175`), never the parent env
- Library-side parent reads (config dir, skill dirs, codex transcript) — covered-by Solution step 4
- Auth / PATH availability in clean env — covered-by Solution step 5 (caller passes them; no fallback) + DoD e2e item
- Tests (unit + e2e) — covered-by Solution step 6
- Docs (SRS, SDS, README, runtime/AGENTS.md, index) — covered-by Solution step 7
- Public export surface / `private-type-ref` — covered-by Solution step 8
- External consumers (`flowai-workflow`) — not affected — additive optional field, default unchanged (per Constraints)
- `scripts/check.ts`, `scripts/generate-release-notes.ts` — not affected — spawn git/deno, not agent CLIs (scout evidence)
- `skill/` — not affected — no spawns (scout evidence)
- `process-registry.ts` — not affected — no env logic (scout evidence)
- Grandchildren of the agent (MCP servers, hooks) — covered-by Solution step 3: they inherit the agent's env, which is already isolated
- `clearEnv` availability on CI Deno — not affected — present in Deno 2 `Deno.CommandOptions` (`deno types`: `clearEnv?: boolean`, default false); CI pins `deno-version: v2.x` (`.github/workflows/ci.yml:40`)
- OpenCode log dir (`opencode/upstream-error-detector.ts:83-88`, critic finding) — covered-by Solution step 4
- `e2e/_acp_retry_wrapper.ts:96` — not affected — test-only wrapper that re-spawns a front; it receives the env the library already built

## Definition of Done

- [x] Caller can run any runtime (claude / opencode / cursor / codex, CLI
      and ACP transports, invoke + session; interactive for claude / codex /
      opencode — Cursor has no interactive mode) so the child env
      contains no variable from the caller's process env except those the
      caller explicitly passes (amended by variant C: plus the OS-user vars
      and that runtime's login vars, see Solution addendum).
  - FR-L53. Tests: `runtime/inherit_env_test.ts::FR-L53 *`. Evidence:
    `deno test -A runtime/inherit_env_test.ts`.
- [x] Default behaviour (full inheritance) unchanged.
  - FR-L53. Test: `runtime/inherit_env_test.ts::FR-L53 control: default
    invoke inherits the parent env`. Evidence: same command.
- [x] In isolated mode the library itself reads no parent env var for
      child-facing paths (Claude config dir, skills dirs, Codex sessions
      dir, OpenCode log dir, `CODEX_CONFIG`); a missing `HOME` it needs
      fails before the spawn; a missing `PATH` fails before the spawn.
  - FR-L53. Tests: `runtime/spawn-env_test.ts::FR-L53 *`. Evidence:
    `deno test -A runtime/spawn-env_test.ts`.
- [x] Real binaries run with `inheritEnv: false` (variant C: no `env`
      passed at all).
  - FR-L53. Test: `e2e/inherit_env_e2e_test.ts`. Evidence:
    `E2E=1 E2E_RUNTIMES=claude,codex deno test -A --no-check e2e/inherit_env_e2e_test.ts`
    → claude CLI, claude ACP, codex CLI ok (2026-10-18, 3 passed).
- [x] Add FR-L53 section to SRS with `**Acceptance:**` filled; SDS
      component section; index row; README usage note.
  - FR-L53. Evidence: `deno task check` (doc-lint + publish dry-run).

- [x] Isolation does not break agent login (user, 2026-10-18: "не должно
      быть такого, что отключение наследования ломает авторизацию"):
      `inheritEnv: false` with no `env` still authenticates every logged-in
      runtime.
  - FR-L53. Tests: `runtime/spawn-env_test.ts::FR-L53 *`,
    `runtime/inherit_env_test.ts::FR-L53 * keeps the user and its login*`
    (CLI for 4 runtimes + ACP for claude / codex / opencode) and
    `::FR-L53 isolated child does not get another runtime's login`; drift
    check `e2e/isolated_auth_e2e_test.ts` (`E2E=1 deno test -A --no-check
    e2e/isolated_auth_e2e_test.ts`) → claude, codex, opencode, cursor ok
    (2026-10-18). Probe: dropping `USER` from `IDENTITY_ENV` turns the
    claude case red (`claude auth status exited 1`); routing ACP through
    `NO_LOGIN_ENV` turns the 3 ACP stub tests red.
- [x] README / SRS / SDS / AGENTS.md no longer claim Claude needs the
      Claude Desktop host env (wrong: it needs `USER` for the macOS
      keychain lookup).
  - FR-L53. Evidence: `grep -rn -F 'Claude Desktop' README.md
    documents/requirements.md documents/design.md AGENTS.md
    runtime/AGENTS.md` returns nothing (2026-10-18).

## Solution

Variant B selected (2026-10-18): opt-in `inheritEnv: false`, only
explicit env reaches the child.

1. **Leaf helper `runtime/spawn-env.ts`** (no per-runtime imports, so
   every `<runtime>/` module may import it — same rule as `env-cwd-sync.ts`):
   - `spawnEnvOptions(env, inheritEnv)` → spread into `Deno.Command`
     options. `inheritEnv === false` → `{clearEnv: true, env: env ?? {}}`;
     otherwise `env ? {env} : {}` (today's behaviour). Replaces every
     `...(syncedEnv ? { env: syncedEnv } : {})` / `env: syncedEnv`.
   - `hostEnv(name, env, inheritEnv)` → isolated: `env?.[name]` only;
     default: `Deno.env.get(name)` (unchanged).
   - `spawnEnvOptions` throws in isolated mode when `env.PATH` is unset:
     Deno resolves the binary through the PARENT `PATH` when the child env
     has none (probe above), so a missing `PATH` would let the caller's env
     pick the binary — the exact influence FR-L53 removes. Thrown at the
     spawn site, same path a spawn `NotFound` takes today.
   - `hostHome(env, inheritEnv, purpose)` → isolated: `env.HOME` or throw
     `Error("inheritEnv: false: <purpose> needs HOME (or the matching
     override) in env")`; default: `Deno.env.get("HOME") ?? Deno.cwd()`.
   - Each export carries `// FR-L53`.
2. **Option types**: `inheritEnv?: boolean` with JSDoc on
   `RuntimeInvokeOptions`, `RuntimeSessionOptions`, `InteractiveOptions`,
   `FetchCapabilitiesOptions`, `FetchCommandsOptions`; per-runtime option
   types (`ClaudeInvokeOptions`, `ClaudeSessionOptions`, OpenCode / Cursor /
   Codex invoke + session options, `CodexAppServerClientOptions`,
   `AcpStdioClientOptions`, `spawnClient` opts, opencode transcript opts,
   cursor create-chat opts). Forward it at every site that forwards `env`
   (scout list: claude/cursor/opencode/codex adapters, `capabilities.ts`,
   `acp/adapter.ts`, `acp/commands.ts`, `codex/session.ts`,
   `cursor/session.ts`, `cursor/process.ts`, `codex/process.ts`).
3. **Spawn sites** (14): `claude/process.ts`, `claude/session.ts`,
   `runtime/claude-adapter.ts` interactive, `opencode/process.ts`,
   `opencode/session.ts`, `opencode/transcript.ts`,
   `runtime/opencode-adapter.ts` interactive, `codex/process.ts`,
   `codex/app-server.ts`, `runtime/codex-adapter.ts` interactive,
   `cursor/process.ts`, `cursor/session.ts`, `cursor/chat.ts`,
   `runtime/acp/client.ts` (drop the explicit `Deno.env.toObject()` copy in
   isolated mode). Library-injected vars (`PWD`, FR-L45 switch,
   `CLAUDECODE: ""`, FR-L18 `CLAUDE_CONFIG_DIR`, ACP front `env`) stay.
4. **Library-side parent reads** switch to `hostEnv` / `hostHome`:
   `defaultClaudeConfigDir(env?, inheritEnv?)`, `claudeSkillsDir`,
   `codexSkillsDir`, `opencodeSkillsDir`, `defaultCodexSessionsDir(env?,
   inheritEnv?)` (public, `mod.ts:248`; new params optional → additive),
   `resolveOpenCodeLogDir(env?, inheritEnv?)`
   (`opencode/upstream-error-detector.ts:83`, called at
   `opencode/process.ts:327`; isolated → `env.OPENCODE_LOG_DIR` /
   `env.HOME`, none → `undefined` = detector off, its existing no-HOME
   semantics), ACP `spawnClient` `CODEX_CONFIG` read.
   Codex sessions dir: `codex/process.ts` resolves it ONCE before the
   spawn (when not `ephemeral`) and passes it to both
   `findCodexSessionFile` calls (`:431`, `:458`), so a missing `HOME` fails
   before tokens are spent, not after the run.
5. **Error handling**: no fallback in isolated mode — missing `HOME` where
   the library must resolve a home-relative path throws synchronously with
   the purpose named; a missing `PATH` surfaces as Deno `NotFound` from the
   spawn (existing error paths, e.g. ACP `missingFrontExecutableError`).
6. **Tests** (RED first):
   - `runtime/spawn-env_test.ts` — helper truth table, `hostHome` throw.
   - `runtime/inherit_env_test.ts` — PATH stubs (`#!/bin/sh`, dump
     `/usr/bin/env` to `$ENV_PROBE`, probe path + PATH passed via
     `opts.env`), parent sets a sentinel var. Isolated: sentinel absent,
     `ENV_PROBE` present. Cases: invoke ×4, session ×4, interactive
     (claude/codex/opencode), ACP `spawnClient` via `acpFront`, opencode
     transcript export, cursor create-chat. Control: default invoke sees
     the sentinel.
   - `e2e/inherit_env_e2e_test.ts` — claude CLI, claude ACP, codex CLI
     reply "ok" with `inheritEnv: false, env: {PATH, HOME}`.
7. **Docs**: SRS FR-L53, SDS component `runtime/spawn-env.ts`, index row,
   README env-isolation note, `runtime/AGENTS.md` bullet, `env` JSDoc
   mention of `inheritEnv`.
8. **Exports**: `mod.ts` — no new public type (field is `boolean`); helper
   stays internal unless doc-lint needs it.

Verification: `deno task check`; `deno test -A runtime/inherit_env_test.ts
runtime/spawn-env_test.ts`; e2e command from DoD.

## Follow-ups

- Critique triage (plan-critic, 2026-10-18): applied 1 (OpenCode log dir),
  2 (require `PATH`), 3 (Codex sessions dir resolved pre-spawn), 4 (two
  scout "could not rule out" rows), 5 (claude ACP in e2e), 7 (count 14),
  8 (Cursor interactive excluded from DoD). Discarded 6: Node / Rust fall
  back to `getpwuid` without `HOME`, but the library cannot mirror that
  without reading host state; requiring `HOME` only where the library
  itself resolves a home-relative path keeps the contract explicit.
- OpenCode / Cursor isolated runs are verified by stubs only (no real
  binary e2e) — add when those runtimes get e2e coverage for env.
- Real-binary e2e 2026-10-18 (`e2e/inherit_env_e2e_test.ts`): codex CLI
  passed; claude CLI → `Not logged in`, claude ACP → `Authentication
  required`. Cause: no `USER` in the child env, so Claude could not find
  its macOS keychain login (see Solution addendum). Fixed by carrying the
  parent's identity vars into the isolated env.


## Solution addendum — login survives isolation (variant C, 2026-10-18)

Measured 2026-10-18 (`<cli> auth status`, adding one parent var at a time
to `env -i PATH HOME`): claude needs `USER` (macOS keychain item
`Claude Code-credentials` is looked up by account = `$USER`); codex and
opencode need `HOME` only (`~/.codex/auth.json`,
`~/.local/share/opencode/auth.json`); cursor (`cursor-agent status`)
stays logged in under `PATH` + `HOME` + `USER` + `LOGNAME`.
The earlier "Claude Desktop host env" conclusion came from a zsh probe
bug: an unquoted `$extra` holding `USER=… LOGNAME=…` is not word-split in
zsh, so `env` got one malformed `USER`.

1. `runtime/spawn-env.ts`: isolated child env = parent's identity vars
   (`PATH`, `HOME`, `USER`, `LOGNAME`) + parent vars the runtime's login
   matcher accepts, then caller `env` on top (caller wins), then library
   vars. `AuthEnvMatcher = (name) => boolean` is a required param of
   `spawnEnvOptions` and `hostEnv`; `hostHome` takes `HOME` from caller,
   else parent. `PATH` throw stays only for a parent without `PATH`.
2. Per-runtime matchers in the runtime's own dir: `claude/auth-env.ts`
   (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
   `CLAUDE_CONFIG_DIR`, Bedrock / Vertex switches and credentials),
   `codex/auth-env.ts` (`OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_HOME`),
   `cursor/auth-env.ts` (`CURSOR_API_KEY`), `opencode/auth-env.ts`
   (`*_API_KEY`). ACP: per-runtime adapters pass the matcher as a third
   arg to `invokeViaAcp` / `openSessionViaAcp` / `fetchAcpCommands`
   (internal, not exported) → `spawnClient` → `AcpStdioClient`; `runtime/`
   never imports a runtime dir.
3. Drift check `e2e/isolated_auth_e2e_test.ts`: for each installed
   runtime whose `<cli> auth status` succeeds with the full env, the same
   command with the isolated env built by `spawnEnvOptions({}, false,
   <matcher>)` must also succeed. No tokens spent.
4. `e2e/inherit_env_e2e_test.ts` passes no `env` at all.
5. Docs: README, SRS FR-L53, SDS, `runtime/AGENTS.md`; replace the wrong
   e2e note in `AGENTS.md`.
