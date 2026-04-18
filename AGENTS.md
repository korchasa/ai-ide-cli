# AGENTS.md — @korchasa/ai-ide-cli

Thin Deno/TypeScript wrapper library around agent-CLI runtimes
(Claude Code, OpenCode, Cursor) plus a HITL MCP server and skill parser.
Published on JSR as [`@korchasa/ai-ide-cli`](https://jsr.io/@korchasa/ai-ide-cli).

## Scope

Library-only. No engine, no workflow, no domain logic. Consumers
(e.g. [`@korchasa/flowai-workflow`](https://jsr.io/@korchasa/flowai-workflow))
import this package to invoke IDE CLIs uniformly.

## Layout

- `mod.ts` — barrel export for the default entry.
- `types.ts` — shared runtime identifiers and value types.
- `runtime/` — runtime adapter abstraction (`getRuntimeAdapter`, per-runtime
  adapters for Claude / OpenCode / Cursor).
- `claude/process.ts`, `claude/stream.ts` — Claude CLI invocation and
  streaming output parser.
- `opencode/process.ts`, `opencode/hitl-mcp.ts` — OpenCode invocation and
  HITL-permission MCP server.
- `cursor/process.ts` — Cursor CLI invocation.
- `skill/` — SKILL.md parser and typed skill model.
- `process-registry.ts` — cross-runtime child process registry with graceful
  shutdown hooks.
- `documents/` — SRS (`requirements.md`) and SDS (`design.md`).
  FR numbering: `FR-L<N>`.
- `scripts/check.ts` — self-contained verification (fmt, lint, type check,
  tests, doc-lint, publish dry-run).

## Tasks

- `deno task check` — run the full local verification suite.
- `deno task test` — run tests only.
- `deno task fmt` — format in place.
- `deno task release` — bump version via `standard-version` (CI invokes).

## JSR / Deno Gotchas

- `publish.include` cannot reference files outside the package directory
  (JSR rejects `../*`). Keep everything shippable inside this repo root.
- JSR slow-types lints (`no-slow-types`, `missing-jsdoc`, `private-type-ref`)
  fire only on `deno publish --dry-run` — `deno task check` runs the dry-run
  last to catch these locally.
- `deno doc --lint <entry>` validates only symbols reachable from `<entry>`.
  Public symbols reachable via other barrels stay invisible without a
  publish dry-run — `scripts/check.ts` runs both.

## Release Flow

1. Merge a Conventional Commits PR to `main`.
2. CI's `release` job detects `feat`/`fix`/`perf`/`refactor`/`build`
   commits since the last tag, runs `deno task release`, pushes the bump
   commit and `vX.Y.Z` tag.
3. `publish-jsr` job publishes to JSR via OIDC trusted publishing.
4. `publish-github` job creates a GitHub Release at the tag with generated
   notes.

## JSR Trusted Publisher

Linked to `korchasa/ai-ide-cli` on JSR. If publishing starts failing with
an authorization error, check https://jsr.io/@korchasa/ai-ide-cli/settings.
