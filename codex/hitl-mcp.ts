/**
 * @module
 * Codex-side HITL MCP entrypoint. Delegates the JSON-RPC server to the
 * shared {@link import("../hitl-mcp.ts").runHitlMcpServer} so the same code
 * path serves both Codex and OpenCode.
 *
 * Why a separate stdio process: Codex CLI accepts local MCP server
 * registration via `--config mcp_servers.<name>.command=...` overrides, so
 * the engine spawns this helper per invocation instead of mutating the
 * user's `~/.codex/config.toml`. Codex emits each invocation of the tool as
 * an `mcp_tool_call` item in its `--experimental-json` event stream with
 * `server` and `tool` fields exposed separately, which the runtime adapter
 * pattern-matches to detect HITL requests.
 */

import { runHitlMcpServer } from "../hitl-mcp.ts";

/**
 * CLI flag consumers pass to their own binary to dispatch into
 * {@link runCodexHitlMcpServer}. Single source of truth — both the
 * dispatcher and the spawn command builder must reference this constant
 * so the two sides of the sub-process handshake stay in sync.
 */
export const INTERNAL_CODEX_HITL_MCP_ARG: string = "--internal-codex-hitl-mcp";

/**
 * MCP server name registered in Codex's `mcp_servers` config block. The
 * runtime adapter matches `mcp_tool_call.server` against this value when
 * intercepting HITL requests.
 */
export const CODEX_HITL_MCP_SERVER_NAME: string = "hitl";

/**
 * Bare tool name as Codex reports it inside `mcp_tool_call.tool`. Codex
 * keeps the server and tool names separate (unlike OpenCode which prefixes
 * the server name onto the tool), so the matcher uses the bare name.
 */
export const CODEX_HITL_MCP_TOOL_NAME: string = "request_human_input";

/**
 * Start the Codex HITL MCP server. Thin wrapper that delegates to the
 * shared NDJSON JSON-RPC server, advertising a Codex-flavoured
 * `serverInfo.name`.
 */
export function runCodexHitlMcpServer(): Promise<void> {
  return runHitlMcpServer("flowai-hitl-codex");
}
