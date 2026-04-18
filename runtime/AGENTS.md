# Runtime Module

- Responsibility: runtime abstraction for agent execution.
- Scope: adapter lookup, runtime option resolution, runtime capability metadata.
- Supported runtimes: `claude`, `opencode`, `cursor`, `codex`.
- Key decisions:
  - `claude` remains the default runtime for backward compatibility.
  - `runtime_args` is the universal extension point for all runtimes.
  - Engine-level HITL is runtime-agnostic at the engine layer: Claude uses `AskUserQuestion` permission denials; OpenCode uses an injected local MCP tool exposed per invocation through `OPENCODE_CONFIG_CONTENT`.
  - `opencode` continuation/resume uses `opencode run --session <id>`.
  - `cursor` uses `cursor agent -p` headless mode with `--output-format stream-json`; session resume via `--resume <chatId>`; permissions bypass via `--yolo`. No HITL or transcript support.
  - `codex` uses `codex exec --experimental-json` headless mode; prompt is written to the child's **stdin**, not argv; session resume via positional `resume <threadId>`. Permission modes (`default`/`plan`/`acceptEdits`/`bypassPermissions`) map to combinations of `--sandbox` + `--config approval_policy=…`; Codex-native sandbox/approval values pass through unchanged. HITL via per-invocation `--config mcp_servers.hitl.command/args` registering a local stdio MCP server (shared with OpenCode in `hitl-mcp.ts`); `mcp_tool_call` items for `hitl.request_human_input` are intercepted and surfaced as `CliRunOutput.hitl_request`. Transcript path resolved post-run from `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl` into `CliRunOutput.transcript_path`. `launchInteractive` spawns the Codex TUI with skills copied into `~/.agents/skills/<name>/`. `onToolUseObserved` fires for `command_execution`/`file_change`/`mcp_tool_call`/`web_search` items.
