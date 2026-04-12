# Runtime Module

- Responsibility: runtime abstraction for agent execution.
- Scope: adapter lookup, runtime option resolution, runtime capability metadata.
- Supported runtimes: `claude`, `opencode`, `cursor`.
- Key decisions:
  - `claude` remains the default runtime for backward compatibility.
  - `runtime_args` is the universal extension point for all runtimes.
  - Engine-level HITL is runtime-agnostic at the engine layer: Claude uses `AskUserQuestion` permission denials; OpenCode uses an injected local MCP tool exposed per invocation through `OPENCODE_CONFIG_CONTENT`.
  - `opencode` continuation/resume uses `opencode run --session <id>`.
  - `cursor` uses `cursor agent -p` headless mode with `--output-format stream-json`; session resume via `--resume <chatId>`; permissions bypass via `--yolo`. No HITL or transcript support.
