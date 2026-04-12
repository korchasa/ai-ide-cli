<!-- section file — index: [documents/requirements.md](../requirements.md) -->

# SRS AI IDE CLI — Meta (Intro, NFR, Interfaces)


## 0. Resolved Design Decisions

- **Scope boundary:** Library owns CLI subprocess management only. No DAG,
  workflow, config parsing, git, or domain logic.
- **One-way dependency:** Library has zero imports from engine
  (`@korchasa/flowai-workflow`). Engine depends on library, not vice versa.
- **No shipped binary:** Library exposes functions and types. Consumers
  (engine, standalone tools) own the binary entry point.
- **HITL MCP contract:** OpenCode HITL requires a consumer-provided
  `hitlMcpCommandBuilder` callback. Library ships the MCP handler
  (`runOpenCodeHitlMcpServer`) but NOT the subprocess argv — consumer
  supplies it. Fail-fast error if omitted.
- **claude_args removed:** Single universal `runtime_args` field for all
  runtimes. No runtime-specific arg fields.

## 1. Introduction

- **Purpose:** Normalize invocation of agent-CLI binaries (Claude Code,
  OpenCode, Cursor) behind a uniform interface. Parse NDJSON event streams,
  handle retry/backoff, session resume, and HITL tool wiring.
- **Scope:** Subprocess spawning, stream parsing, output normalization,
  process lifecycle tracking. No workflow orchestration.
- **Audience:** Engine developers, standalone CLI tool authors, MCP proxy
  builders.
- **Abbreviations:**
  - **NDJSON:** Newline-delimited JSON event stream.
  - **HITL:** Human-in-the-loop — agent requests human input mid-task.
  - **MCP:** Model Context Protocol — tool interface for agent runtimes.

## 2. General Description

- **Context:** Published as `@korchasa/ai-ide-cli` on JSR. Deno workspace
  member alongside `@korchasa/flowai-workflow`. Consumers import via sub-path
  specifiers (`/runtime`, `/claude/process`, `/cursor/process`, etc.).
- **Assumptions:**
  - Agent CLI binaries (`claude`, `opencode`, `cursor`) installed and on PATH.
  - Deno runtime available (library uses `Deno.Command` for subprocess spawn).
  - Consumers handle signal installation; library exposes `killAll()` but
    does not wire OS signals.

## 4. Non-Functional Requirements

- **Zero engine dependency:** `rg "from.*@korchasa/flowai-workflow" ai-ide-cli/`
  must return 0 matches.
- **Publish independently:** `deno publish --dry-run` from `ai-ide-cli/`
  must pass without engine co-publication.
- **No slow types:** All public API exports have explicit types (JSR
  `no-slow-types` rule).

## 5. Interfaces

### CLI Invocation Contracts

Each runtime adapter spawns a CLI binary with specific flags. Contracts:

- **`claude`:**
  - Binary: `claude`
  - `--output-format stream-json` — NDJSON event stream
  - `--resume <session-id>` — session continuation
  - `-p "<prompt>"` — task prompt
  - `--model <model>` — model selection (fresh only)
  - `--permission-mode <mode>` — permission control
  - `--agent <name>` — agent selection (fresh only)
  - `--append-system-prompt <text>` — system context (fresh only)
  - `--verbose` — full streaming
  - `runtime_args` forwarded as extra CLI flags
  - Env override: `CLAUDECODE=""` (allow nested invocations)

- **`opencode`:**
  - Binary: `opencode`
  - `run --format json` — NDJSON event stream
  - `run --session <id>` — session resume
  - `run --model <provider/model>` — model (fresh only)
  - `run --agent <name>` — agent (fresh only)
  - `--dangerously-skip-permissions` — bypass (when `bypassPermissions`)
  - No system-prompt flag; prepended to task prompt
  - `runtime_args` forwarded as extra flags
  - Env: `OPENCODE_CONFIG_CONTENT` for per-invocation MCP injection

- **`cursor`:**
  - Binary: `cursor`
  - `agent -p` — headless mode (subcommand + flag)
  - `--output-format stream-json` — NDJSON event stream
  - `--resume <chatId>` — session resume
  - `--model <model>` — model (fresh only)
  - `--yolo` — bypass permissions (when `bypassPermissions`)
  - `--trust` — skip workspace trust prompt
  - No system-prompt flag; prepended to task prompt
  - `runtime_args` forwarded as extra flags
