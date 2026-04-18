# Changelog

All notable changes to `@korchasa/ai-ide-cli` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/).

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
