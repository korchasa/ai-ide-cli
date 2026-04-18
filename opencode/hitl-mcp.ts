/**
 * @module
 * OpenCode-side HITL MCP entrypoint. Delegates the JSON-RPC server to the
 * shared {@link import("../hitl-mcp.ts").runHitlMcpServer} so the same code
 * path serves both OpenCode and Codex.
 *
 * Why a separate stdio process: OpenCode can inject local MCP servers per
 * invocation via `OPENCODE_CONFIG_CONTENT`. The engine uses this server to
 * expose a structured `request_human_input` tool without mutating the user's
 * global OpenCode configuration.
 *
 * Why the tool returns immediately: the engine intercepts the structured
 * `tool_use` event in OpenCode's JSON stream, marks the node as waiting, and
 * resumes the session later. The MCP tool only needs to surface a typed
 * request to the runtime.
 */

import { runHitlMcpServer } from "../hitl-mcp.ts";

/**
 * CLI flag consumers pass to their own binary to dispatch into
 * {@link runOpenCodeHitlMcpServer}. Single source of truth — both the
 * dispatcher and the spawn command builder must reference this constant
 * so the two sides of the sub-process handshake stay in sync.
 */
export const INTERNAL_OPENCODE_HITL_MCP_ARG: string =
  "--internal-opencode-hitl-mcp";

/** MCP server name advertised in OpenCode's `mcp` config block. */
export const OPENCODE_HITL_MCP_SERVER_NAME: string = "hitl";

/**
 * Fully-qualified name of the `request_human_input` tool as it appears
 * in OpenCode stream events (`<server>_request_human_input`). Used by
 * the OpenCode runner to pattern-match HITL tool invocations.
 */
export const OPENCODE_HITL_MCP_TOOL_NAME: string =
  `${OPENCODE_HITL_MCP_SERVER_NAME}_request_human_input`;

/**
 * Start the OpenCode HITL MCP server. Thin wrapper that delegates to the
 * shared NDJSON JSON-RPC server, advertising an OpenCode-flavoured
 * `serverInfo.name`.
 */
export function runOpenCodeHitlMcpServer(): Promise<void> {
  return runHitlMcpServer("flowai-hitl");
}
