---
date: "2026-10-17"
status: in progress
implements: [FR-L49, FR-L50, FR-L51, FR-L52]
tags: [acp, usage, structured-output, process-group, ephemeral, consumer]
related_tasks: [2026/09/acp-fronts-drop-npx.md]
---
# Token usage over ACP, schema-constrained replies, own process group, ephemeral runs

## Goal

Let the flowai acceptance-test runner drop its own transport layer and run
every agent and judge through this library. Today the runner keeps about
4 200 lines of its own ACP client, codex app-server client, bridge registry
and per-runtime env mapping, because this library lacks four things the
runner depends on. With them, switching the agent runtime or the model
becomes one option on the call instead of a new code path in the consumer.

The four gaps:

1. Token usage is dropped on the ACP transport.
2. There is no option for a reply constrained by a JSON Schema.
3. A spawned runtime shares the caller's process group, so a watchdog
   cannot kill the runtime together with everything it forked.
4. There is no option to keep a run from writing its session files to
   disk.

## Overview

### Context

- Consumer: `flowai/scripts/acceptance-tests/lib/` (runner, judge, user
  emulator) and `flowai/scripts/benchmark/run.ts` (SWE-rebench A/B). Both
  spawn claude and codex through their own ACP client
  (`acp/client.ts`, `acp/acp_agent.ts`) and their own codex app-server
  client (`appserver_client.ts`).
- What the consumer needs from each gap:
  - **Usage**: per-scenario token cost goes into reports and the result
    cache. The runner currently re-derives codex usage from rollout files
    on disk (`acp/codex_rollout.ts`, `acp/codex_usage.ts`).
  - **Schema**: the LLM judge returns a checklist verdict as one JSON
    object. On codex it passes `outputSchema` on `turn/start`; on claude
    over ACP it embeds the schema in the prompt text and validates the
    reply itself (`acp/claude_judge.ts`).
  - **Process group**: `process_watchdog.ts` counts the members of the
    agent's process group and kills the whole group on a fork loop or
    memory bloat. The runner gets the group by spawning through a Python
    wrapper (`setpgrp_exec.py`) that calls `os.setsid()` before `exec`.
  - **Ephemeral**: the codex judge runs on the app-server with
    `thread/start { ephemeral: true }`, so its rollouts never land in the
    agent's `CODEX_HOME` and never get mistaken for the agent's session.

### Current State

Verified on 2026-10-17 against this repo at `770e881`, bridges
`claude-agent-acp@0.81.0` and `codex-acp@2.0.1`, `claude` 2.1.287,
`codex-cli` 0.159.1, Deno 2.9.7.

- **Usage over ACP.**
  - Both fronts already return usage in the `session/prompt` response.
    `claude-agent-acp` sends `usage { inputTokens, outputTokens,
    cachedReadTokens, cachedWriteTokens, totalTokens }` plus
    `_meta.quota.model_usage[]` per model (`dist/acp-agent.js`,
    `sessionUsage` and `turnQuotaMeta`). Its `usage` covers the main loop
    only; `model_usage` also counts Task subagents and compaction.
  - `codex-acp` sends `usage { inputTokens, outputTokens,
    cachedReadTokens, thoughtTokens, totalTokens }` and the same
    `_meta.quota` shape (`dist/index.js`, `toPromptUsage`,
    `buildQuotaMeta`).
  - **The two fronts disagree on scope.** claude reports
    `session.accumulatedUsage` — a running total for the session. codex
    reports `sessionState.lastTokenUsage`, filled from
    `thread/tokenUsage/updated` → `params.tokenUsage.last`
    (`dist/index.js:30951`). The cumulative
    `params.tokenUsage.total` is stored in `totalTokenUsage` and never
    sent. Whether `last` covers the whole turn or only the last model
    request is not verified; if it is the last request, a multi-request
    turn is under-counted.
  - The library reads only `stopReason` from that response:
    `runtime/acp/adapter.ts:483` (invoke) and around `:596-606` (session
    `send`, turn-end event). The usage is discarded.
  - `CliRunUsage` (`types.ts`) has `input_tokens`, `output_tokens`,
    `cached_tokens`, `reasoning_tokens`, `cost_usd`. There is no field for
    cache writes, so the claude CLI path drops
    `cache_creation_input_tokens` too (`claude/stream.ts:515`).
- **Schema.**
  - Both CLIs support it: `claude --json-schema <schema>` (the binary
    carries a `structured_output` field and an
    `error_max_structured_output_retries` result subtype) and
    `codex exec --output-schema <file>`. The codex app-server takes
    `outputSchema` on `turn/start`.
  - The library already uses both flags internally, for
    `fetchCapabilitiesSlow` (`runtime/claude-adapter.ts:279`,
    `runtime/codex-adapter.ts:190`, `runtime/capabilities.ts:224`), but
    only through `extraArgs`, and it reads the reply as plain text with a
    best-effort JSON extractor.
  - `claude/stream.ts` does not read `structured_output` from the result
    event. Whether the plain `result` text holds the same JSON is not
    verified.
  - ACP has no wire field for a schema. `capabilities.ts` drops the
    schema flags on ACP for that reason.
  - `codex/session.ts:startThread` / `turn/start` send no `outputSchema`.
- **Process group.**
  - Every runtime is spawned by `new Deno.Command(...)` without
    `detached`: `claude/process.ts:456`, `claude/session.ts:326`,
    `codex/process.ts:216`, `codex/app-server.ts:304`,
    `runtime/acp/client.ts:190`, the opencode and cursor spawns, and the
    `launchInteractive` spawns in `runtime/*-adapter.ts`.
  - Deno's `detached: true` puts the child in its own process group.
    Measured: a `sleep` spawned with it reported `pgid == pid` (35888)
    while the parent's pgid was 35886.
  - `ProcessRegistry.killAll` signals the child itself
    (`p.kill("SIGTERM")`), not its group. Session `abort()` does the same.
    A detached child that forked keeps its descendants alive after the
    leader dies, unless the kill goes to `-pgid`.
  - The consumer can already learn the pid: it passes its own
    `ProcessRegistry`, and `register(p)` receives the `Deno.ChildProcess`.
- **Ephemeral.**
  - `codex exec --ephemeral` ("Run without persisting session files to
    disk"), the app-server `thread/start { ephemeral: true }`, and
    `claude --no-session-persistence` all exist.
  - `codex/session.ts:startThread` builds `{model, cwd, approvalPolicy,
    sandbox, baseInstructions}` only. No adapter exposes the option.

### Constraints

- Public API ships on JSR: add options and fields, do not rename or remove.
- New options default to today's behaviour (opt-in).
- No silent degradation: an option a transport cannot honour throws
  `AcpUnsupportedOptionError` (or the CLI-side equivalent), the same
  posture as FR-L39 already takes for unsupported options.
- Usage that a front did not report stays `undefined`, never `0` —
  `PromptResponse.usage` is marked UNSTABLE in ACP v1.
- `deno task check` green; `publish --dry-run` green.

### Open questions (decide before implementing)

1. **Schema on ACP.** Throw `AcpUnsupportedOptionError` (planned below),
   or embed the schema in the prompt and validate the reply — what the
   consumer's claude judge does today? The second is a fallback the
   caller did not ask for, so it needs an explicit decision.
2. **codex usage over ACP.** If `last` is per model request, a correct
   per-turn count needs either `codex-acp` to send `tokenUsage.total`
   (upstream change) or this library to sum `usage_update`-style data it
   does not receive today. Measure first (Solution step 1), then choose.
3. **Process group default.** Opt-in `processGroup: true` (planned), or
   on by default for session transports where the runtime forks tools?

## Definition of Done

- [ ] FR-L49: ACP invoke and ACP session report token usage.
  - Test: `runtime/acp/adapter_test.ts::FR-L49 maps PromptResponse usage to CliRunUsage`
  - Test: `runtime/acp/adapter_test.ts::FR-L49 absent usage stays undefined`
  - Test: `runtime/acp/session_contract_test.ts::FR-L49 turn-end event carries usage`
  - Evidence: `deno test -A runtime/acp/ --filter FR-L49`
  - The claude and codex fronts report the same scope (whole session or
    per turn, as decided in open question 2), documented in the SRS.
  - Evidence: `deno task e2e:acp` prints non-zero usage for claude and
    codex on a two-turn session, and turn 2 ≥ turn 1 for a cumulative
    scope.
  - Status 2026-10-17: unit tests green; codex e2e
    (`e2e/run_options_e2e_test.ts`) passed, per-turn usage. Claude e2e not
    run — the claude OAuth session expired and could not be refreshed.
- [x] FR-L49: `CliRunUsage` gains `cache_write_tokens`; the claude CLI and
  claude ACP paths fill it.
  - Test: `claude/stream_test.ts::FR-L49 cache_creation_input_tokens maps to cache_write_tokens`
  - Evidence: `deno test -A claude/stream_test.ts --filter FR-L49`
- [x] FR-L50: `outputSchema` option on `RuntimeInvokeOptions` and
  `RuntimeSessionOptions`.
  - claude CLI → `--json-schema`; codex exec → temp file +
    `--output-schema`; codex app-server session → `outputSchema` on
    `turn/start`; opencode / cursor / ACP → `AcpUnsupportedOptionError`
    or the CLI equivalent (unless open question 1 decides otherwise).
  - Test: `runtime/reserved-flag-coverage_test.ts::FR-L50 outputSchema maps to each runtime flag`
  - Test: `codex/session_test.ts::FR-L50 turn/start carries outputSchema`
  - Test: `runtime/acp/adapter_test.ts::FR-L50 outputSchema on ACP throws AcpUnsupportedOptionError`
  - Evidence: `deno test -A --filter FR-L50`
- [ ] FR-L50: the result exposes the parsed object as
  `CliRunOutput.structured_output`, read from claude's `structured_output`
  result field and from codex's final message; a reply that fails to
  parse sets `is_error` with a clear message.
  - Test: `claude/stream_test.ts::FR-L50 reads structured_output from the result event`
  - Evidence: `deno task e2e` structured-output smoke passes for claude and codex
  - Status 2026-10-17: unit tests green; codex e2e passed
    (`{answer: "ok", n: 7}`). Claude e2e not run — expired OAuth session.
- [x] FR-L51: `processGroup: true` spawns every runtime with
  `detached: true`, and every kill path (`ProcessRegistry.killAll`,
  session `abort()`, invoke timeout / abort) signals `-pgid`.
  - Test: `process-registry_test.ts::FR-L51 killAll signals the whole group`
  - Test: `runtime/acp/client_test.ts::FR-L51 detached front reports pgid == pid`
  - Evidence: `deno test -A --filter FR-L51`
  - Evidence: a test spawns a stub that forks a grandchild, aborts the
    session, and asserts the grandchild is gone (`kill -0` fails).
  - Piped stdio still works on a detached child (the stub's stdout is
    read to the end).
- [x] FR-L52: `ephemeral: true` keeps the run's session files off disk:
  codex exec → `--ephemeral`; codex app-server → `thread/start
  { ephemeral: true }`; claude CLI → `--no-session-persistence`; ACP →
  unsupported error.
  - Test: `runtime/reserved-flag-coverage_test.ts::FR-L52 ephemeral maps to each runtime flag`
  - Test: `codex/session_test.ts::FR-L52 thread/start carries ephemeral`
  - Evidence: `deno test -A --filter FR-L52`
  - Evidence: e2e — a codex app-server session with `ephemeral: true`
    leaves no new file under `$CODEX_HOME/sessions/`.
- [x] SRS gains FR-L49..FR-L52; SDS, README and `runtime/AGENTS.md`
  describe the new options and fields.
  - Evidence: `grep -c "FR-L49\|FR-L50\|FR-L51\|FR-L52" documents/requirements.md` ≥ 4
- [x] `deno task check` green; `deno publish --dry-run` green.
  - Evidence: `deno task check > "$SCRATCH/check.log" 2>&1; echo "EXIT: $?"`

## Solution

1. **Measure before coding** (answers open question 2 and the
   `structured_output` gap):
   - Run a two-turn codex-acp session where turn 2 makes several tool
     calls; compare `PromptResponse.usage` with the
     `thread/tokenUsage/updated` `total` delta for that turn.
   - Run `claude -p --output-format json --json-schema '<schema>' ...`
     once and record where the object lands (`structured_output`,
     `result`, or both).
2. **SRS first**: add FR-L49..FR-L52 with the scope rules above; then the
   SDS component notes.
3. **FR-L49 usage**:
   - Add `cache_write_tokens?: number` to `CliRunUsage`.
   - `runtime/acp/mapping.ts`: `usageFromPromptResponse(res)` → maps
     `inputTokens`, `outputTokens`, `cachedReadTokens`,
     `cachedWriteTokens`, `thoughtTokens` to `CliRunUsage`; returns
     `undefined` when `usage` is absent.
   - `runtime/acp/adapter.ts`: put it on the invoke result and on the
     synthetic turn-end event of the session path.
   - Normalise scope per front as decided in step 1 (for example, keep
     the previous total per session and report the difference).
   - `claude/stream.ts`: map `cache_creation_input_tokens`.
4. **FR-L50 schema**:
   - `outputSchema?: Record<string, unknown>` on both option types; add
     the flags to the reserved sets so `extraArgs` cannot duplicate them.
   - claude: `--json-schema JSON.stringify(schema)`; codex exec: write a
     temp file, pass `--output-schema`, delete it after the run; codex
     session: `outputSchema` on every `turn/start`.
   - Unsupported runtimes and ACP throw.
   - Parse into `structured_output`; move `fetchCapabilitiesSlow` onto
     the new option.
5. **FR-L51 process group**:
   - `processGroup?: boolean` on both option types; pass
     `detached: true` at every spawn site listed above.
   - `ProcessRegistry`: remember which children lead a group; `killAll`
     and the per-session abort send `Deno.kill(-pid, sig)` for them,
     SIGTERM then SIGKILL after `graceMs`.
6. **FR-L52 ephemeral**: `ephemeral?: boolean` on both option types,
   mapped per runtime as in the DoD.
7. Unit tests per DoD, one e2e smoke per FR in `e2e/`, docs, then
   `deno task check` and `deno publish --dry-run`.
