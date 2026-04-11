# Runtime Module

- Responsibility: runtime abstraction for agent execution.
- Scope: adapter lookup, runtime option resolution, runtime capability metadata.
- Supported runtimes: `claude`, `opencode`.
- Key decisions:
  - `claude` remains the default runtime for backward compatibility.
  - `runtime_args` is the generic extension point; `claude_args` is retained as Claude-only legacy input.
  - Engine-level HITL is runtime-agnostic at the engine layer: Claude uses `AskUserQuestion` permission denials; OpenCode uses an injected local MCP tool exposed per invocation through `OPENCODE_CONFIG_CONTENT`.
  - `opencode` continuation/resume uses `opencode run --session <id>`.
