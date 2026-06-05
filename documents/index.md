# Documentation Index

## FR

- [FR-L13](requirements.md#3-13-fr-l13-codex-cli-wrapper) — Codex CLI wrapper (`invokeCodexCli`, `buildCodexArgs`, permission-profile argv, no-duplicate placement, reasoning-token telemetry) — [x]
- [FR-L14](requirements.md#3-14-fr-l14-map-shaped-extraargs--runtime_args) — Map-shaped `extraArgs` / `runtime_args` — [x]
- [FR-L16](requirements.md#3-16-fr-l16-observed-tool-use-hook) — `RuntimeInvokeOptions.onToolUseObserved(info)` (and the Claude-specific `ClaudeInvokeOptions.onToolUseObserved(info)`) fire for every tool invocation surfaced by the runtime's event stream — [x]
- [FR-L17](requirements.md#3-17-fr-l17-typed-lifecycle-hooks) — Typed lifecycle hooks: Claude `ClaudeLifecycleHooks`; runtime-neutral `RuntimeLifecycleHooks` (`onInit`/`onResult`) honored by all four adapters — [x]
- [FR-L19](requirements.md#3-19-fr-l19-streaming-input-session) — Streaming-input session: caller opens a session, pushes user messages, consumes normalized events, closes via `endInput` / `abort` — [x]
- [FR-L20](requirements.md#3-20-fr-l20-capability-inventory-llm-probed) — LLM-probed capability inventory: enumerate skills and slash commands exposed by the runtime in a given `cwd` — [x]
- [FR-L23](requirements.md#3-23-fr-l23-normalized-session-event-content) — Pure runtime-neutral helper `extractSessionContent(event)` returns `NormalizedContent[]` from a `RuntimeSessionEvent` — [x]
- [FR-L25](requirements.md#3-25-fr-l25-abstract-reasoning-effort-on-runtime-options) — Abstract reasoning-effort enum on runtime options, with v2.1.133 hook-event typing — [x]
- [FR-L26](requirements.md#3-26-fr-l26-typed-codex-app-server-notifications) — Typed Codex app-server notifications (incl. `response.processed`) — [x]
- [FR-L35](requirements.md#3-34-fr-l35-generic-per-invocation-mcp-server-registration) — Generic per-invocation MCP-server registration across runtimes — [x]
- [FR-L37](requirements.md#3-36-fr-l37-runtime-error-analysis) — Pure runtime-neutral analyzer for captured runtime failure signals — [x]
- [FR-L39](requirements.md#3-37-fr-l39-acp-transport-claude--codex--opencode-pilots) — Opt-in Agent Client Protocol transport (Claude + Codex + OpenCode pilots) under `transport: "acp"` — [x]
- [FR-L42](requirements.md#3-40-fr-l42-commands-fast-channel-discovery) — Commands fast-channel discovery: neutral `fetchCommands(runtime, opts)` dispatcher + transport-scoped `commandsFastChannel` capability, ACP-piloted today, CLI runtimes throw typed `CommandsUnavailableError` — [ ]

## ADR

- [ADR-0003](adr/2026-05-03-generic-mcp-server-injection.md) — Generic per-invocation MCP-server registration (supersedes the transport gap left by ADR-0002).
