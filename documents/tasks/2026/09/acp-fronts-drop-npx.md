---
date: "2026-09-15"
status: done
implements: [FR-L39, FR-L43]
tags: [acp, fronts, dependencies, deno, npx]
related_tasks: [2026/05/acp-transport-poc.md]
---
# Launch ACP fronts as real Deno deps instead of `npx`

## Goal

Make the two npm-shipped ACP fronts real, lockfile-pinned dependencies of
this package. `npx -y <pkg>@<ver>` contradicts the Deno-native decision
(it needs Node on PATH), resolves the package outside `deno.lock`, and
duplicates the version string in three places that already drifted once
(`deno.json` imports held `claude-agent-acp@0.37.0` + the deprecated
`@zed-industries/codex-acp@0.15.0` while `fronts.ts` pinned 0.62.0/1.1.7).

## Overview

### Context

- `runtime/acp/fronts.ts` launches `npx -y @agentclientprotocol/…@<ver>`
  for claude + codex. Cursor and OpenCode wrap a local binary and are out
  of scope.
- The `deno.json` `imports` entries for both packages are dead — no module
  imports them; they only mirror the pins, badly.
- Empirically verified on 2026-09-15 (Deno 2.x, darwin-arm64):
  - `deno run -A npm:@agentclientprotocol/claude-agent-acp@0.77.0` starts
    the front and answers `initialize` — same for `codex-acp@1.11.0`,
    whose native `@openai/codex` optional dep resolves fine.
  - A one-line entry module `import "<bare specifier>/dist/index.js"`
    run via `deno run -A <file>` starts the front too, taking its version
    from `deno.json` `imports`.
  - `deno run -A https://jsr.io/@korchasa/ai-ide-cli/0.8.15/types.ts`
    succeeds, so a consumer that installed this package from JSR can run
    a module of it by URL — `jsr.io` is in Deno's default import allowlist.

### Current State

- `AcpFrontLauncher` = `{cmd, args, env?, versionPin?, pilot}`, frozen
  registry, `getAcpFront(runtime)` / `listAcpFronts()` public on `mod.ts`.
- Five test files install a PATH-stub named `npx` to intercept the spawn:
  `runtime/acp/{adapter,commands,retry,error_analysis}_test.ts`,
  `runtime/index_test.ts`, plus `runtime/transport_option_test.ts`.
  A PATH stub cannot intercept an absolute `Deno.execPath()`.
- `RuntimeInvokeOptions.acpFront` already lets a caller override the
  launcher — the supported seam for tests.

### Constraints

- Public API: `AcpFrontLauncher` ships on JSR. Do not drop fields.
- No Node dependency anywhere in the spawn path.
- The version must live in exactly ONE place; any second copy needs a
  test that fails when the two drift.
- `deno task check` must stay green; `deno task e2e:acp` must still pass
  for claude + codex (opencode fails on HEAD already — out of scope).

## Definition of Done

- [x] Both npm fronts launch through `Deno.execPath()`, never `npx`.
- [x] `deno.json` `imports` entries are live — the entry modules resolve
      their package through them.
- [x] `versionPin` is guarded by a test that reads `deno.json` and fails
      on drift.
- [x] Every PATH-stub test switched to the `acpFront` seam.
- [x] Claude's dead `code` / `yolo` permission-mode rows removed.
- [x] `deno task check` green; `deno task e2e:acp` green for claude+codex.
- [x] SRS + SDS + README + `runtime/AGENTS.md` describe the new launcher.

## Solution

1. Add `runtime/acp/fronts/claude.ts` and `runtime/acp/fronts/codex.ts` —
   one bare `import` each, no exports. They are NOT imported by
   `fronts.ts` (only `import.meta.resolve`d), so the npm packages stay out
   of the library's module graph and a CLI-only consumer never downloads
   the codex native binary.
2. `fronts.ts`: `cmd: Deno.execPath()`, `args: ["run", "-A", <entry url>]`.
   Document why `-A`: the front spawns Claude Code / codex, which need
   network, filesystem and subprocess access — the same authority `npx`
   handed them implicitly.
3. Keep `versionPin` as a plain string; add `fronts_test.ts` assertions
   that read `deno.json` `imports` and compare.
4. Rewrite the five PATH-stub helpers to build an `acpFront` record
   (`{cmd:"bash", args:[script], pilot:true}`) and pass it through the
   existing option.
5. Drop `acceptEdits → code` / `bypassPermissions → yolo` from
   `CLAUDE_PERMISSION_TO_MODE`; the front declares `default`,
   `acceptEdits`, `plan`, `auto`, `bypassPermissions`, so only `plan`
   needs a row at all (it is also a direct id match — keep the table with
   just the rows that do something, or drop it if none survive).
6. Note the `deno compile` limitation in JSDoc: a compiled binary's
   `execPath` cannot `deno run`; such an embedder passes its own
   `acpFront`.

### Verification

- `deno task check`
- `deno task e2e:acp` (claude + codex green, opencode fails on HEAD too)
