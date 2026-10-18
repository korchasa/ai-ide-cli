---
date: "2026-10-18"
status: done
implements: [FR-L13, FR-L14]
tags: [codex, argv, exec, json]
related_tasks: [2026/05/codex-flag-placement-audit.md]
---

# Codex: Emit `--json` Instead of the Hidden `--experimental-json` Alias

## Goal

Keep the Codex one-shot transport on the flag spelling Codex documents,
so `invoke` keeps working if upstream drops the hidden alias, and stop a
consumer-supplied `extraArgs: { "--json": "" }` from crashing Codex.

## Overview

### Context

Found during the 2026-10-18 re-validation of
`2026/05/codex-flag-placement-audit.md`: `codex exec --help` on
`codex-cli 0.159.1` lists only `--json`; `--experimental-json` still
parses but is hidden.

Upstream facts (`codex-rs/exec/src/cli.rs`):

- `rust-v0.121.0` (library floor), `rust-v0.159.1`, `main`: one bool
  field, `#[arg(long = "json", alias = "experimental-json", global = true)]`.
  The two spellings set the same field → output identical by
  construction.
- `7fc3edf8a` (2025-10-01, #4525) "Remove legacy codex exec --json
  format": before it `--json` was a different format. Far below the
  0.121.0 floor → irrelevant.
- OpenAI's own `sdk/typescript/src/exec.ts` on `main` still spawns
  `["exec", "--experimental-json"]` → alias removal is not imminent;
  the switch is hygiene, not an emergency.

Empirical, `codex-cli 0.159.1`, `--sandbox read-only`, scratch cwd,
prompt "Reply with the word: ok":

- Both spellings → exit 0, same event sequence and key sets:
  `thread.started{thread_id}`, `turn.started`,
  `item.completed{item:{id,text,type=agent_message}}`,
  `turn.completed{usage}`.
- `codex exec --json --experimental-json` → `error: the argument
  '--json' cannot be used multiple times` (clap `SetTrue`).

### Current State

- `codex/argv.ts:buildCodexArgs` starts argv with
  `["exec", "--experimental-json"]`.
- `CODEX_RESERVED_FLAGS` reserves `--experimental-json` only. A
  consumer `extraArgs: { "--json": "" }` passes validation and Codex
  then fails with the duplicate-argument error above (latent bug).
- `codex/process_test.ts` pins `args[1] === "--experimental-json"`.
- ~20 JSDoc / doc references name the transport
  `codex exec --experimental-json` (SRS FR-L13, SDS, AGENTS.md,
  `runtime/AGENTS.md`, `mod.ts`, `codex/*.ts`).

### Constraints

- Public API byte-stable: no signature change. `CODEX_RESERVED_FLAGS`
  swaps `--experimental-json` → `--json` (value change, same length).
- Fail fast: both spellings in `extraArgs` throw synchronously, like
  every reserved flag.
- No version sniffing at runtime (floor 0.121.0 already has `--json`).

## Definition of Done

- [x] FR-L13: `buildCodexArgs` emits `["exec", "--json", …]`, never
      `--experimental-json`. Test:
      `codex/process_test.ts::"buildCodexArgs — fresh invocation starts with exec --json"`.
- [x] FR-L14: `extraArgs` keys `--json` and `--experimental-json` both
      throw `reserved by the runtime adapter`. Test:
      `codex/argv_test.ts::"extraArgs rejects both JSON output spellings"`.
- [x] `--json` counted as a singleton in
      `codex/argv_test.ts::"no duplicate shared flag positions"`.
- [x] SRS FR-L13 / SDS / AGENTS.md / `runtime/AGENTS.md` / JSDoc name
      the transport `codex exec --json`; SRS records the alias facts.
      Evidence: `grep -rn -F -- "--experimental-json"` outside
      `documents/tasks/` and `CHANGELOG.md` hits only the reserved-flag
      entry, its tests and the alias notes.
- [x] Final check: `NO_COLOR=1 deno task check` exits 0.

## Solution

1. RED: `codex/process_test.ts` exec test expects `args[1] === "--json"`;
   `codex/argv_test.ts` adds the two-spelling rejection test and adds
   `--json` to `RESERVED_SINGLETON_FLAGS`. Run
   `deno task test codex/` → red on argv[1] and on `--json` not
   throwing.
2. GREEN: `codex/argv.ts` — argv starts `["exec", "--json"]`;
   `CODEX_RESERVED_FLAGS` = `["--json", "--model", "--cd", "--sandbox"]`;
   new private `CODEX_RESERVED_FLAG_ALIASES = ["--experimental-json"]`,
   passed to `expandExtraArgs` together with the public list. Kept
   separate because `runtime/reserved-flag-coverage_test.ts` (symmetric
   assertion) requires every public reserved entry to be emitted; a
   first attempt that put the alias in the public list failed it with
   "reserved entries never emitted by any builder (stale)".
3. Docs + JSDoc: replace the transport name `codex exec
   --experimental-json` → `codex exec --json`; SRS FR-L13 Acceptance
   bullet on the alias; SDS reserved-singleton list;
   `runtime/AGENTS.md` reserved-flag list.
4. `NO_COLOR=1 deno task check`.

Real-binary check (2026-10-18, `codex-cli 0.159.1`): adapter
`invoke` via `getRuntimeAdapter("codex")` (`permissionMode: "plan"`,
scratch cwd, prompt "Reply with the word: ok") on this branch and on
`7fa86c8` (pre-change, via a scratch `git worktree`) → same events
`thread.started` / `turn.started` / `item.completed` /
`turn.completed`, `result: "ok"`, `is_error: false`. Spawned argv:
`codex exec --json --cd <dir> --sandbox read-only --config
approval_policy="never" --skip-git-repo-check`.

Decision: switch (single variant). The upstream source proves output
identity for every supported binary, so the only cost is the doc sweep;
keeping the alias would leave the latent `--json` crash and depend on a
spelling Codex no longer documents.
