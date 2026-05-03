# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [0.8.0](https://github.com/korchasa/ai-ide-cli/compare/v0.7.0...v0.8.0) (2026-05-02)


### ⚠ BREAKING CHANGES

* removes HitlConfig, HumanInputRequest,
HumanInputOption, hitlConfig + hitlMcpCommandBuilder on
RuntimeInvokeOptions / RuntimeSessionOptions, hitl_request field on
CliRunOutput, hitl flag on RuntimeCapabilities, and the sub-path
exports ./hitl-mcp, ./opencode/hitl-mcp, ./codex/hitl-mcp.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

### Features

* remove HITL from library scope (ADR-0002) ([1053b6c](https://github.com/korchasa/ai-ide-cli/commit/1053b6ccdcb59b958ebb3cdbb61f500de6127907))


### Tests

* **e2e:** cover lifecycle hooks (FR-L17) and reasoning effort (FR-L25) ([32577c8](https://github.com/korchasa/ai-ide-cli/commit/32577c8589904b0efcbcfcdb2c73c5ffa09ef987))
* **e2e:** expand FR coverage — invoke-abort symmetry, tool-use, tool-filter ([542f795](https://github.com/korchasa/ai-ide-cli/commit/542f795701695c8485a8ea9bd325d90891a3986a))

## [0.7.0](https://github.com/korchasa/ai-ide-cli/compare/v0.6.0...v0.7.0) (2026-05-02)


### ⚠ BREAKING CHANGES

* **e2e:** add auth-probe gate (FR-L34); disable e2e in CI

### Features

* **e2e:** add auth-probe gate (FR-L34); disable e2e in CI ([ab9b09a](https://github.com/korchasa/ai-ide-cli/commit/ab9b09a3e8aaa644b875eeead59ebc1aa481c89e))

## [0.6.0](https://github.com/korchasa/ai-ide-cli/compare/v0.5.11...v0.6.0) (2026-05-02)


### ⚠ BREAKING CHANGES

* **runtime:** pass processRegistry through every test/e2e/script call site
* **runtime:** RuntimeInvokeOptions.processRegistry and RuntimeSessionOptions.processRegistry are now required. Per-runtime options (ClaudeInvokeOptions, ClaudeSessionOptions, CursorSessionOptions, OpenCodeSessionOptions, CodexAppServerClientOptions, etc.) follow suit. The defaultRegistry singleton remains exported for standalone callers; embedded callers MUST pass per-scope ProcessRegistry instances.

Tests still pending fixes — type errors expected on this commit.
* **types:** total_cost_usd and duration_api_ms on CliRunOutput are now optional. Use the new CliRunOutput.usage field for per-runtime token counts. Cursor and Codex no longer emit total_cost_usd: 0 when the runtime reports no cost — the field is undefined to truthfully signal "not reported".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
* **runtime:** onToolUseObserved callback throws no longer auto-abort the run; they default to "allow" and surface via onCallbackError. exportOpenCodeTranscript returns OpenCodeTranscriptResult instead of string|undefined.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
* **runtime:** `RuntimeSession.events` and the per-runtime equivalents
are typed `AsyncIterableIterator` (one-shot). Code that called
`Symbol.asyncIterator` on the events twice — or passed the field to a
helper that did — fails at compile time instead of at the runtime guard.
Single-iteration consumers are unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
* **claude:** `PermissionMode` and `VALID_PERMISSION_MODES` moved from
`types.ts` to `claude/permission-mode.ts`. The root `mod.ts` re-export
stays as a `@deprecated` shim for one release. Dead values `"dontAsk"`
and `"auto"` are removed from the enum and the new validator rejects
them at argv-build time.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

### Features

* **cursor:** expose sessionFidelity capability and surface per-turn send failures ([c45d047](https://github.com/korchasa/ai-ide-cli/commit/c45d047a784524de5b57935994c0c761a47d6c3c))
* **runtime:** add onCallbackError option and surface transcript export failures ([0692dbb](https://github.com/korchasa/ai-ide-cli/commit/0692dbb89e8f9d9b60ae8dc888a95717b0ead032))
* **runtime:** make processRegistry required on invoke and session options (source) ([4ce4e8a](https://github.com/korchasa/ai-ide-cli/commit/4ce4e8a373bf8d11e908c6126b0931350154def3))
* **runtime:** sync env.PWD with subprocess cwd at every spawn boundary ([8f57be7](https://github.com/korchasa/ai-ide-cli/commit/8f57be794d9888ff6358b0af4e7568e5679b69b3))
* **types:** optional cost fields and new usage telemetry on CliRunOutput ([19513ff](https://github.com/korchasa/ai-ide-cli/commit/19513ff5bab631c9d60ee69a217f40edd6e567ae))


### Bug Fixes

* **jsr:** re-export types referenced from runtime/index.ts public API ([ed793da](https://github.com/korchasa/ai-ide-cli/commit/ed793da279bb718d6627f63113560c30039d4be7))


### Continuous Integration

* add per-runtime e2e workflow with soak window ([db3d1dd](https://github.com/korchasa/ai-ide-cli/commit/db3d1dd768a0a008f41ec4abe2907c3d25d8df74))


### Tests

* **runtime:** coverage test for reserved-flag completeness ([4453dd9](https://github.com/korchasa/ai-ide-cli/commit/4453dd9b297517d4166061b5149c138e8d47d74e))
* **runtime:** pass processRegistry through every test/e2e/script call site ([2e01a96](https://github.com/korchasa/ai-ide-cli/commit/2e01a96dfe7e701e7b07723ddd5647c87e8be539))


### Chores

* update .gitignore to include .worktrees/ and remove obsolete subproject ([0cab0d5](https://github.com/korchasa/ai-ide-cli/commit/0cab0d5a45865e761292204b4d0199ce32a059bd))


### Documentation

* reflect runtime/types and codex/opencode/process module splits ([3df5904](https://github.com/korchasa/ai-ide-cli/commit/3df5904b3a6c4f998107d8b14e23d9e8546e5c7c))
* refresh AGENTS.md Layout and relax module-AGENTS rule ([aeff0ae](https://github.com/korchasa/ai-ide-cli/commit/aeff0aee1bfd9ce2cc5608295b860776e03d2ec1))


### Code Refactoring

* **autonomous-task:** standardize tool list formatting and add spacing for clarity ([d9728db](https://github.com/korchasa/ai-ide-cli/commit/d9728db616f6057b66eede411752b633eb333f63))
* **claude:** move PermissionMode to claude submodule and drop dead values ([9b3bca6](https://github.com/korchasa/ai-ide-cli/commit/9b3bca6e323edc45bc7c04b6fc574c3f4c7797c2))
* **codex:** extract permission-mode decision and tool-item conceptual model ([a622e46](https://github.com/korchasa/ai-ide-cli/commit/a622e465f7417c5a5f7a5a26641081ba221802a4))
* **codex:** split codex/process.ts into argv / run-state / transcript ([e6ad9bf](https://github.com/korchasa/ai-ide-cli/commit/e6ad9bf5a2a483d4b85e2d336471a54e47a63919))
* **codex:** type the exec --experimental-json NDJSON event stream ([2557daf](https://github.com/korchasa/ai-ide-cli/commit/2557daf6b73a005b5fffdf7f44dbf3e11f7f61e6))
* **content:** split runtime/content.ts into per-runtime extractors ([fb40e86](https://github.com/korchasa/ai-ide-cli/commit/fb40e8665f5916f7a77844eb6f2e87888e533468))
* **opencode:** split opencode/process.ts into argv / events / transcript ([de99dd5](https://github.com/korchasa/ai-ide-cli/commit/de99dd5b8013d65af2c808dff5cd1f94f8452f2f))
* **runtime:** extract expandExtraArgs into cycle-free runtime/argv.ts ([a385100](https://github.com/korchasa/ai-ide-cli/commit/a3851009ba01e2853e8c9eed824191d2e7683c89))
* **runtime:** split positional subcommand names out of reserved-flag lists ([c896d9e](https://github.com/korchasa/ai-ide-cli/commit/c896d9e16058a2d5dc7ba5e193dd8c553a6e3a64))
* **runtime:** split runtime/types.ts into focused modules ([d9a430c](https://github.com/korchasa/ai-ide-cli/commit/d9a430cfdd8060b463e4aa31360000b0f5002b43))
* **runtime:** type RuntimeSession.events as AsyncIterableIterator ([a1b6001](https://github.com/korchasa/ai-ide-cli/commit/a1b600173f10feafb125f637544518c2859b6eec))
* split files over 600 LOC into focused modules ([37d7b07](https://github.com/korchasa/ai-ide-cli/commit/37d7b0729993f3d29c93c7420561f38c4bf88e9f))

### [0.5.11](https://github.com/korchasa/ai-ide-cli/compare/v0.5.10...v0.5.11) (2026-04-30)


### ⚠ BREAKING CHANGES

* **types:** `CliRunOutput.total_cost_usd` and `CliRunOutput.duration_api_ms` are now optional (`number | undefined`). Cursor and Codex previously synthesized `total_cost_usd: 0` because the field was required, masking "no cost reported" as a real free run. Both now leave the field `undefined` so cost-aggregating consumers can branch on presence. New optional `CliRunOutput.usage` (typed `CliRunUsage`) carries per-runtime token telemetry (`input_tokens`, `output_tokens`, `cached_tokens`, `cost_usd`) — every adapter populates the subset its native event stream exposes.
* **runtime:** `RuntimeSession.events` (and the per-runtime `ClaudeSession.events` / `OpenCodeSession.events` / `CursorSession.events`) is now typed `AsyncIterableIterator<…>` (one-shot) instead of `AsyncIterable<…>` (multi-shot). Code that called `Symbol.asyncIterator` on the events twice — or passed `events` to a helper that did — fails at compile time instead of at the existing runtime guard. Existing single-iteration consumers (`for await (const e of session.events) {}` once) are unaffected. The runtime guard in `SessionEventQueue` stays as a belt-and-suspenders fallback.

### Features

* **e2e:** add real-binary test suite across four adapters (FR-L24) ([73f8d86](https://github.com/korchasa/ai-ide-cli/commit/73f8d86513935e11c109156be819e36cde544441))


### Documentation

* capture e2e gotchas + tighten traceability rule ([d06378c](https://github.com/korchasa/ai-ide-cli/commit/d06378c5ec09fd38abcf1594296e3b4ff9e22203))
* **srs:** add Event Mapping Contracts section to §5 ([af26a2a](https://github.com/korchasa/ai-ide-cli/commit/af26a2a74db98031e9c863727af1e90a5a165b64))


### Code Refactoring

* **docs:** renumber e2e suite FR-L24 → FR-L25 ([6978f96](https://github.com/korchasa/ai-ide-cli/commit/6978f965c272828852a68828d8c2046982f333bc))


### Chores

* merge main into worktree-e2e-real-ide-tests; renumber e2e suite FR-L25 → FR-L31 ([e31144a](https://github.com/korchasa/ai-ide-cli/commit/e31144a666c03ac1275e08c96fae7c3f410cbaf0))
* **release:** 0.5.10 ([7aa2941](https://github.com/korchasa/ai-ide-cli/commit/7aa294103dec27e394f60776c22bd0672647471c))


### Tests

* **e2e:** add content-normalization scenario across four adapters ([fa88a3c](https://github.com/korchasa/ai-ide-cli/commit/fa88a3cc661e93f8550f4070587ac5fb40937364))
* **e2e:** real-binary coverage for FR-L26 + FR-L30 ([6620ff5](https://github.com/korchasa/ai-ide-cli/commit/6620ff52f1801d6d3a0758c515bfc868e38f9bbd))

### [0.5.10](https://github.com/korchasa/ai-ide-cli/compare/v0.5.9...v0.5.10) (2026-04-30)


### Bug Fixes

* **opencode:** emit -- separator before positional prompt ([eb857a7](https://github.com/korchasa/ai-ide-cli/commit/eb857a70029a8fc56d7baa80be209ad3a6e17ae5))

### [0.5.9](https://github.com/korchasa/ai-ide-cli/compare/v0.5.8...v0.5.9) (2026-04-29)


### Features

* **cursor:** type stream-json events and surface tool-call observation (FR-L30) ([9cd3ee0](https://github.com/korchasa/ai-ide-cli/commit/9cd3ee04e20d97f0c844d4f8e0f4bf2341cd78d8))


### Bug Fixes

* **codex:** close session turn-id race and align app-server payload with upstream schema ([3943c89](https://github.com/korchasa/ai-ide-cli/commit/3943c89cbeadb0b87ed3095c1240b128da7f10a0))


### Documentation

* **agents:** enhance documentation on stream-event types and runtime integration guidelines ([e1a1c14](https://github.com/korchasa/ai-ide-cli/commit/e1a1c14d884329994a5b5e7c229e1f4108eabdcd))
* **cursor:** codify HITL=false rationale and ban ~/-mutation workarounds ([99b8cf2](https://github.com/korchasa/ai-ide-cli/commit/99b8cf2baa1e3d7996c57623a57ad140d76f6444))

### [0.5.8](https://github.com/korchasa/ai-ide-cli/compare/v0.5.7...v0.5.8) (2026-04-27)


### Features

* **codex:** typed app-server notification events (FR-L26) ([b41e8f4](https://github.com/korchasa/ai-ide-cli/commit/b41e8f49b9d1b1da94ae0673c9413eacaee41aed))


### Documentation

* **agents:** update capabilities and content extraction details in AGENTS.md ([ed95b8e](https://github.com/korchasa/ai-ide-cli/commit/ed95b8e7d18a6c201abab0abb377e1206f0bb129))
* **readme:** expand typed-API asymmetry rows in feature matrix ([d9c3df1](https://github.com/korchasa/ai-ide-cli/commit/d9c3df1db5d663aa78abd03426eeedad379bbeb1))
* **readme:** surface typed-event-union and settingSources asymmetry ([90fff94](https://github.com/korchasa/ai-ide-cli/commit/90fff948b31a3a91ec7b700454b7e8287f665ac7))

### [0.5.7](https://github.com/korchasa/ai-ide-cli/compare/v0.5.6...v0.5.7) (2026-04-26)


### Features

* **process-registry:** expose `ProcessRegistry` class for instance-scoped
  child-process tracking. The module continues to export
  `register`/`unregister`/`onShutdown`/`killAll` as free-function wrappers
  over a default singleton, so existing call sites are unchanged.
* **runtime:** add optional `processRegistry?: ProcessRegistry` to
  `RuntimeInvokeOptions` and `RuntimeSessionOptions`. Adapters route
  spawned subprocesses through the supplied registry, falling back to
  the module default when omitted. Lets embedders host multiple
  independent runtimes in one Deno process and reap each one's
  subprocesses via `killAll` without affecting siblings.
* **codex:** typed Codex app-server notification events (FR-L26).
  New `codex/events.ts` exposes the discriminated union
  `CodexNotification` covering `thread/started`, `turn/started`,
  `turn/completed`, `item/started`, `item/completed`,
  `item/agentMessage/delta`, `item/reasoning/textDelta`,
  `item/reasoning/summaryTextDelta`,
  `item/commandExecution/outputDelta`, `error`, plus the
  `CodexThreadItem` sub-union (`userMessage` / `agentMessage` /
  `reasoning` / `plan` / `commandExecution` / `fileChange` /
  `mcpToolCall` / `dynamicToolCall` / `webSearch` / `contextCompaction`).
  Sharp narrowing through the `isCodexNotification(note, method)`
  type guard. The `CodexAppServerNotification` transport shape is
  unchanged (still `{method: string, params: Record<string, unknown>}`)
  for forward-compat with new CLI methods.

### [0.5.6](https://github.com/korchasa/ai-ide-cli/compare/v0.5.5...v0.5.6) (2026-04-26)


### Features

* **runtime:** cascade reasoningEffort + suppress --effort on Claude resume (FR-L25) ([c258188](https://github.com/korchasa/ai-ide-cli/commit/c258188945d2f583095d6ebb31465fc3919dfa2e))


### Documentation

* fix codex coverage gaps and expose validator sub-paths ([21375fb](https://github.com/korchasa/ai-ide-cli/commit/21375fb3254e40f85785af6c76107792ac91a1cc))
* **readme:** list toolFilter and reasoningEffort in feature matrix ([e3ac545](https://github.com/korchasa/ai-ide-cli/commit/e3ac545dfbc1344e6eebe7206a03eca5e0cae208))


### Chores

* **jsr:** expose runtime/capabilities sub-path ([1d01456](https://github.com/korchasa/ai-ide-cli/commit/1d0145694c4c2bd7576036122cde4258388df558))

### [0.5.5](https://github.com/korchasa/ai-ide-cli/compare/v0.5.4...v0.5.5) (2026-04-24)


### Features

* **runtime:** abstract reasoningEffort on call options (FR-L25) ([382ecb5](https://github.com/korchasa/ai-ide-cli/commit/382ecb57864d5cfeba71c3ca2e20ca61e9c38ec4))

### [0.5.4](https://github.com/korchasa/ai-ide-cli/compare/v0.5.3...v0.5.4) (2026-04-19)


### Features

* **runtime:** typed allowedTools/disallowedTools (FR-L24) ([3af57c0](https://github.com/korchasa/ai-ide-cli/commit/3af57c0ed21a1bbed1fc0e9dc703674d8db225fb)), closes [#3](https://github.com/korchasa/ai-ide-cli/issues/3)

### [0.5.3](https://github.com/korchasa/ai-ide-cli/compare/v0.5.2...v0.5.3) (2026-04-19)


### Features

* **runtime:** normalize session event content across adapters (FR-L23) ([435197a](https://github.com/korchasa/ai-ide-cli/commit/435197a6f978f19490d8d12a810f2063e89f85f5)), closes [#2](https://github.com/korchasa/ai-ide-cli/issues/2)


### Documentation

* **agents:** add baseline gate, autonomous test rule, check/test iteration tip ([265c67e](https://github.com/korchasa/ai-ide-cli/commit/265c67e49380d23485db468a2051ad0b91916b76))
* **codex:** warn about parallel wire protocols in [@module](https://github.com/module) docblocks ([13f1041](https://github.com/korchasa/ai-ide-cli/commit/13f10418cb57b428c3341cd1793755b9baeaddec))

### [0.5.2](https://github.com/korchasa/ai-ide-cli/compare/v0.5.1...v0.5.2) (2026-04-19)


### Features

* **session:** neutral turn-end signal, sessionId, typed errors ([8ee0f24](https://github.com/korchasa/ai-ide-cli/commit/8ee0f24545609b714770743b2a36a9be0ae41b8a))

### [0.5.1](https://github.com/korchasa/ai-ide-cli/compare/v0.5.0...v0.5.1) (2026-04-19)


### Features

* **opencode:** observe tool use, export transcript, expose typed stream events ([42059f6](https://github.com/korchasa/ai-ide-cli/commit/42059f6599262c4930d1947d0add345dbd237253))


### Documentation

* **readme:** add feature support matrix and tg-ide-bridge reference ([775841d](https://github.com/korchasa/ai-ide-cli/commit/775841d0d3dd8cf0e1d6e06797674c7fd1a60341))
* sync README and AGENTS layout with 0.5.0 alignment ([fe0be6f](https://github.com/korchasa/ai-ide-cli/commit/fe0be6f93619b675df243ab56d5b45cbfd1a6c31))

## [0.5.0](https://github.com/korchasa/ai-ide-cli/compare/v0.4.1...v0.5.0) (2026-04-19)


### ⚠ BREAKING CHANGES

* **runtime:** RuntimeSession no longer exposes `pid`. Consumers that
read `session.pid` through the neutral handle must cast to a concrete
runtime session type (e.g. ClaudeSession) or observe the pid via
runtime-native session events.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

### Features

* **codex:** add openSession via experimental app-server JSON-RPC ([377c254](https://github.com/korchasa/ai-ide-cli/commit/377c25421e90eeea4063a9de73c2e9ce149405c2))
* **cursor:** add openSession faux streaming session ([9c3223a](https://github.com/korchasa/ai-ide-cli/commit/9c3223aa445067890c02d8cf940b315283f8a1aa))


### Chores

* ignore .claude/ runtime state ([343be35](https://github.com/korchasa/ai-ide-cli/commit/343be35c03d4e74d61a1163aaa186db527a1f32a))


### Code Refactoring

* **runtime:** align openSession semantics across all four runtimes ([60de5ca](https://github.com/korchasa/ai-ide-cli/commit/60de5cafbc4921c910aae2f098ddd4ebf9c6656f))

### [0.4.1](https://github.com/korchasa/ai-ide-cli/compare/v0.4.0...v0.4.1) (2026-04-19)


### Features

* **opencode:** add openSession for streaming-input sessions ([71b0550](https://github.com/korchasa/ai-ide-cli/commit/71b0550922a8827d2db2572b18426d16aa5b0c4c))

## [0.4.0](https://github.com/korchasa/ai-ide-cli/compare/v0.2.0...v0.4.0) (2026-04-19)


### ⚠ BREAKING CHANGES

* borrow SDK patterns — typed events, AbortSignal, map extraArgs, hooks, settingSources

### Features

* add streaming-input session support for Claude ([7ae4ff8](https://github.com/korchasa/ai-ide-cli/commit/7ae4ff84aeae9e29bc7ebbd61655f7223adc78cb))
* borrow SDK patterns — typed events, AbortSignal, map extraArgs, hooks, settingSources ([26f0f7b](https://github.com/korchasa/ai-ide-cli/commit/26f0f7b616f5ab1afb7b7ac647f598b2fc742d1f))
* **codex:** add Codex CLI runtime adapter ([363419c](https://github.com/korchasa/ai-ide-cli/commit/363419c718cf79724affa56837197bc7fdc20ddf))
* **codex:** full capability parity with Claude/OpenCode adapters ([7f833e3](https://github.com/korchasa/ai-ide-cli/commit/7f833e3d345ca39a3b27817095aca2ca9036804a))
* **runtime:** add fetchCapabilitiesSlow for LLM-probed skill/command inventory ([cc3cf32](https://github.com/korchasa/ai-ide-cli/commit/cc3cf32c9e49ac224cc1e88839866f2ffa9806d1))


### Chores

* add .versionrc.json for standard-version ([7d8f02e](https://github.com/korchasa/ai-ide-cli/commit/7d8f02e5239591a3f0c45abf30662c2263613af2))


### Tests

* add scripts/smoke.ts for real-binary AbortSignal and settingSources checks ([2359199](https://github.com/korchasa/ai-ide-cli/commit/2359199be5d9c4bdb6b403c264bb9e7d54babeb7))


### Documentation

* capture Claude init-event gotcha and JSR explicit-type convention ([67a3f87](https://github.com/korchasa/ai-ide-cli/commit/67a3f87ffd08e0ec06c7c49b62256313738a80f8))
* **changelog:** note loader-side shim plan for flowai-workflow ([0ef6516](https://github.com/korchasa/ai-ide-cli/commit/0ef65167536cb3782f7d3734d4a418f095b93576))
* consolidate split SRS/SDS into single files ([555996e](https://github.com/korchasa/ai-ide-cli/commit/555996ec15720bc0394107ebb2bd45aed12e7168))
* drop mandated Release Flow section ([9d9b68d](https://github.com/korchasa/ai-ide-cli/commit/9d9b68dfb04829bc33353281d62bbeed60f3e093))
* link upstream SDK repos for Claude and Codex adapters ([7c688e5](https://github.com/korchasa/ai-ide-cli/commit/7c688e5eb606a0ea383459ea3e700bc6884f7a33))
* **runtime:** document circular-import and stdin-writer gotchas ([001d0a4](https://github.com/korchasa/ai-ide-cli/commit/001d0a44a1c509b9ad306e7e0a9a0cb3c8047789))

## 0.3.0 — 2026-04-19

Patterns borrowed from Anthropic's Claude Agent SDK (without adding the
SDK as a dependency). See
[`documents/tasks/2026-04-19-evaluate-claude-agent-sdk.md`](documents/tasks/2026-04-19-evaluate-claude-agent-sdk.md)
for the full rationale.

### Breaking

- **`extraArgs` / `runtime_args` shape changed** from `string[]` to
  `Record<string, string | null>`. Value semantics:
  - `""` emits a bare boolean flag (`--flag`).
  - any other string emits a key/value pair (`--flag value`).
  - `null` suppresses the flag (useful to override a parent cascade).
  Reserved-flag lists per runtime now throw synchronously when a
  reserved key is passed. See [`expandExtraArgs`](runtime/index.ts) and
  `*_RESERVED_FLAGS` exports.
- `ResolvedRuntimeConfig.args` is now an `ExtraArgsMap` instead of
  `string[]`.

### Added

- **Typed `ClaudeStreamEvent` union** — discriminated union covering
  `system`, `assistant`, `user`, `result`, and forward-compat `unknown`
  events. `parseClaudeStreamEvent(line)` replaces ad-hoc `JSON.parse`
  casts and returns `null` on malformed input.
- **`AbortSignal` cancellation** across Claude, OpenCode, Cursor, and
  Codex adapters. `RuntimeInvokeOptions.signal` (and
  `ClaudeInvokeOptions.signal`) composes with the internal timeout via
  `AbortSignal.any`; aborts return `{ error: "Aborted: ..." }` without
  retries. Requires Deno ≥ 1.39.
- **Observed-tool-use hook (Claude)** — `onToolUseObserved(info)` fires
  post-dispatch for every `tool_use` block and may return `"abort"` to
  terminate the run. Hook-driven aborts synthesize a `CliRunOutput`
  with `is_error: true` and a `permission_denials[]` entry.
- **Typed lifecycle hooks** — Claude exposes `hooks.onInit`,
  `hooks.onAssistant`, `hooks.onResult` with narrowed event types;
  runtime-neutral `RuntimeLifecycleHooks` (`onInit`, `onResult`) is
  honored by all four adapters.
- **Setting-sources isolation (Claude)** — `settingSources` option
  redirects `CLAUDE_CONFIG_DIR` to a tmp dir populated from the listed
  sources (`'user'` supported fully; `'project'`/`'local'` tracked as a
  follow-up). See `runtime/setting-sources.ts`.
- New capability flag `toolUseObservation` on `RuntimeCapabilities`
  (Claude: `true`; others: `false`).

### Notes

- Consumers that pass `runtime_args: ["--foo", "bar"]` must migrate to
  `runtime_args: { "--foo": "bar" }`. `@korchasa/flowai-workflow` gets a
  loader-side shim in a companion update.

## 0.2.0 — 2026-04-18

### Added

- Initial release as standalone package, extracted from the
  [korchasa/flowai-workflow](https://github.com/korchasa/flowai-workflow)
  monorepo. Git history for library files preserved via `git filter-repo`.
- Thin wrappers around Claude, OpenCode, and Cursor CLIs (`claude/process`,
  `opencode/process`, `cursor/process`).
- Runtime adapter layer (`runtime/`) with a stable interface across the three
  supported IDE runtimes.
- HITL MCP server for OpenCode (`opencode/hitl-mcp`).
- SKILL.md parser and typed skill model (`skill/`).
- Process registry with cross-runtime shutdown handling (`process-registry`).

### Notes

- No code changes from `@korchasa/ai-ide-cli@0.2.0` as published from the
  monorepo — this release is a pure repository split.
- Consumers continue to import via `jsr:@korchasa/ai-ide-cli@^0.2.0`; no
  version bump required on their side.
