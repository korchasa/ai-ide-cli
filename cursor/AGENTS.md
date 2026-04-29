# Cursor Module

- **Responsibility:** `cursor agent -p` CLI invocation, stream-json parsing,
  per-turn subprocess session emulation.
- **Scope:** `process.ts` (one-shot invoke), `session.ts` (faux streaming
  session via `create-chat` + per-send subprocess), `stream.ts` (typed
  `CursorStreamEvent` discriminated union, FR-L30).

## HITL status: unsupported

`capabilities.hitl = false`. Will not change on current Cursor CLI design.

Cursor reads `mcp.json` only from two fixed paths —
`~/.cursor/mcp.json` (global, hardcoded to `homedir()`) and
`<workspace>/.cursor/mcp.json` — and offers no per-invocation config flag.
`--workspace <path>` additionally `process.chdir`s the agent, so it is not
a neutral MCP-config pointer: whatever directory we point it at becomes
the agent's working directory.

To deliver HITL via MCP we would therefore have to either mutate the
user's `~/.cursor/mcp.json` (forbidden by root AGENTS.md) or stage a
temporary workspace sandbox (also forbidden). Neither is worth the
concurrency, crash-recovery, and auth-drift cost.

Upstream references:

- Headless `-p` mode does not inject MCP tools into the agent context
  (config-path constraint persists even with `--force`):
  <https://forum.cursor.com/t/cursor-agent-p-mode-does-not-inject-mcp-server-tools-into-agent-context/155275>
- MCP servers via `session/new` don't work in ACP mode:
  <https://forum.cursor.com/t/mcp-servers-passed-via-session-new-dont-work-in-acp-mode/153823>
- CLI configuration reference (no `--mcp-config` documented):
  <https://cursor.com/docs/cli/reference/configuration>

Revisit only if Cursor ships a `--mcp-config` / `CURSOR_MCP_CONFIG`
equivalent that lets us point at an arbitrary `mcp.json` without
touching user data or the agent's cwd. At that point this module flips
`hitl: true` with a small adapter change; until then the gap is by
design.
