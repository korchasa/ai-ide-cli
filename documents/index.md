# Documentation Index

## FR

- [FR-L13](requirements.md#3-13-fr-l13-codex-cli-wrapper) — Codex CLI wrapper (`invokeCodexCli`, `buildCodexArgs`, permission-profile argv, no-duplicate placement) — [x]
- [FR-L14](requirements.md#3-14-fr-l14-map-shaped-extraargs--runtime_args) — Map-shaped `extraArgs` / `runtime_args` — [x]
- [FR-L16](requirements.md#3-16-fr-l16-observed-tool-use-hook) — `RuntimeInvokeOptions.onToolUseObserved(info)` (and the Claude-specific `ClaudeInvokeOptions.onToolUseObserved(info)`) fire for every tool invocation surfaced by the runtime's event stream — [x]
- [FR-L23](requirements.md#3-23-fr-l23-normalized-session-event-content) — Pure runtime-neutral helper `extractSessionContent(event)` returns `NormalizedContent[]` from a `RuntimeSessionEvent` — [x]
- [FR-L25](requirements.md#3-25-fr-l25-abstract-reasoning-effort-on-runtime-options) — Abstract reasoning-effort enum on runtime options, with v2.1.133 hook-event typing — [x]
- [FR-L35](requirements.md#3-34-fr-l35-generic-per-invocation-mcp-server-registration) — Generic per-invocation MCP-server registration across runtimes — [x]

## ADR

- [ADR-0003](adr/2026-05-03-generic-mcp-server-injection.md) — Generic per-invocation MCP-server registration (supersedes the transport gap left by ADR-0002).
