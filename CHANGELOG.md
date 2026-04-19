# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

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
