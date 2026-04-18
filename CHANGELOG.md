# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## 1.1.0 (2026-04-18)


### Features

* **ai-ide-cli:** add cursor runtime support, remove legacy claude_args ([64e65e6](https://github.com/korchasa/ai-ide-cli/commit/64e65e6aecde110dbdcf35188a04e6f90beaaff8))
* **ai-ide-cli:** add env and onEvent options to all runtime invoke interfaces ([7f57cb3](https://github.com/korchasa/ai-ide-cli/commit/7f57cb324fe12e9cb071ec30458b2f8dc023027d))
* **engine,ai-ide-cli:** add interactive REPL as default CLI command (FR-E45, FR-E46, FR-L11, FR-L12) ([3b6bb41](https://github.com/korchasa/ai-ide-cli/commit/3b6bb4139a798da4a30871cc7b1d5db2d65aeb0f))
* **engine:** extract IDE CLI wrapper to @korchasa/ai-ide-cli (FR-E44) ([1253734](https://github.com/korchasa/ai-ide-cli/commit/1253734c46d2be0e89427f953a38c014fc02dbd3))


### Bug Fixes

* **ai-ide-cli:** inject REPL skills into user's skills dir instead of overriding config ([4bdd638](https://github.com/korchasa/ai-ide-cli/commit/4bdd63887628400d36c03991ac2e97e540b8cfc6))
* **ai-ide-cli:** remove SKILL_PREFIX from injection, use frontmatter name as-is ([b6fa776](https://github.com/korchasa/ai-ide-cli/commit/b6fa7768f40fc5746a7001b030705a9904e12801))
* **ai-ide-cli:** symlink all config entries (not just files) for Claude REPL auth ([dd1c2c8](https://github.com/korchasa/ai-ide-cli/commit/dd1c2c8fae2859e38e9435ef56f93e44106cafca))

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
