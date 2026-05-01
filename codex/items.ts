/**
 * @module
 * Conceptual tool-item layer shared between Codex's two parallel
 * protocols.
 *
 * `codex exec --experimental-json` emits NDJSON items with snake_case
 * discriminators (`command_execution`, `file_change`, `mcp_tool_call`,
 * `web_search`, …). `codex app-server` emits JSON-RPC items with
 * camelCase discriminators (`commandExecution`, `fileChange`,
 * `mcpToolCall`, `webSearch`, `dynamicToolCall`, …). The fields differ
 * (`exit_code` vs `exitCode`; `aggregated_output` vs absent), so the
 * two parsers must stay distinct.
 *
 * What they SHARE is the conceptual decision: "this is a tool
 * invocation of kind X with id Y and these arguments". This module
 * owns that shape ({@link CodexConceptualItem}) plus the two narrow
 * parsers that lift each wire format into it. The downstream helpers
 * ({@link import("./process.ts").codexItemToToolUseInfo} and
 * `extractCodexContent`'s tool-item branch) become thin wrappers,
 * so adding a new conceptual kind only requires touching the two
 * parsers — never the consumers.
 *
 * Pure module: no I/O, no globals, no throw paths.
 */

import type {
  CodexExecCommandExecutionItem,
  CodexExecFileChangeItem,
  CodexExecItem,
  CodexExecMcpToolCallItem,
  CodexExecWebSearchItem,
} from "./exec-events.ts";

/**
 * Conceptual kind discriminator for {@link CodexConceptualItem}.
 *
 * Names follow the snake_case NDJSON convention because that protocol
 * is the stable surface; the camelCase app-server protocol is
 * experimental upstream. New kinds land here when both parsers agree
 * on a wire mapping.
 */
export type CodexConceptualKind =
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "web_search"
  | "dynamic_tool_call";

/**
 * Runtime-neutral, wire-format-agnostic view of a Codex tool-use item.
 *
 * - `id`     — stable item id assigned by Codex.
 * - `kind`   — conceptual kind (see {@link CodexConceptualKind}).
 * - `name`   — display name for the tool. For `mcp_tool_call` this is
 *              `<server>.<tool>`; for `dynamic_tool_call` this is the
 *              tool field; otherwise it is the `kind` verbatim.
 * - `input`  — opaque argument map. Field names mirror the source wire
 *              format (snake_case for exec, camelCase for app-server).
 *              Consumers must NOT assume cross-protocol field parity.
 * - `status` — lifecycle status when the source carried one.
 */
export interface CodexConceptualItem {
  /** Stable item id. */
  id: string;
  /** Conceptual kind. */
  kind: CodexConceptualKind;
  /** Display name for the tool (already collapsed for mcp/dynamic). */
  name: string;
  /** Opaque argument map; field naming follows the source wire format. */
  input: Record<string, unknown>;
  /** Lifecycle status when the source carried one. */
  status?: string;
}

/**
 * Lift a `codex exec --experimental-json` (snake_case) item into a
 * {@link CodexConceptualItem}. Returns `undefined` for non-tool items
 * (`agent_message`, `reasoning`, `error`, `todo_list`).
 *
 * Field selection mirrors the historical `codexItemToToolUseInfo`
 * picker so existing tool-observation hooks see the same input keys.
 */
export function parseExecItem(
  item: CodexExecItem | undefined | null,
): CodexConceptualItem | undefined {
  if (!item || typeof item !== "object") return undefined;
  const id = typeof item.id === "string" ? item.id : "";
  switch (item.type) {
    case "command_execution": {
      const c = item as CodexExecCommandExecutionItem;
      return {
        id,
        kind: "command_execution",
        name: "command_execution",
        input: {
          command: c.command,
          status: c.status,
          exit_code: c.exit_code,
        },
        status: typeof c.status === "string" ? c.status : undefined,
      };
    }
    case "file_change": {
      const f = item as CodexExecFileChangeItem;
      return {
        id,
        kind: "file_change",
        name: "file_change",
        input: { changes: f.changes, status: f.status },
        status: typeof f.status === "string" ? f.status : undefined,
      };
    }
    case "mcp_tool_call": {
      const m = item as CodexExecMcpToolCallItem;
      const server = typeof m.server === "string" ? m.server : "?";
      const tool = typeof m.tool === "string" ? m.tool : "?";
      return {
        id,
        kind: "mcp_tool_call",
        name: `${server}.${tool}`,
        input: { arguments: m.arguments, status: m.status },
        status: typeof m.status === "string" ? m.status : undefined,
      };
    }
    case "web_search": {
      const w = item as CodexExecWebSearchItem;
      return {
        id,
        kind: "web_search",
        name: "web_search",
        input: { query: w.query },
      };
    }
    default:
      return undefined;
  }
}

/**
 * Lift a `codex app-server` (camelCase) item into a
 * {@link CodexConceptualItem}. Returns `undefined` for non-tool items
 * (`agentMessage`, `reasoning`, `userMessage`, `plan`, `imageView`,
 * `contextCompaction`, `collabAgentToolCall` — kept out for now).
 *
 * Items without a stable id are also rejected (they cannot be
 * deduplicated by tool-observation hooks downstream). This mirrors
 * the previous `extractCodexContent` invariant.
 *
 * Field selection: `id` and `type` are stripped; every other key is
 * preserved verbatim under `input` so consumers see whatever the CLI
 * shipped, including new fields added in upstream minor bumps.
 */
export function parseAppServerItem(
  item: Record<string, unknown> | undefined | null,
): CodexConceptualItem | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }
  const iType = item["type"];
  const id = typeof item["id"] === "string" ? item["id"] : "";
  if (!id) return undefined;
  const status = typeof item["status"] === "string"
    ? (item["status"] as string)
    : undefined;
  const input = pickAppServerInput(item);

  switch (iType) {
    case "commandExecution":
      return { id, kind: "command_execution", name: iType, input, status };
    case "fileChange":
      return { id, kind: "file_change", name: iType, input, status };
    case "webSearch":
      return { id, kind: "web_search", name: iType, input, status };
    case "mcpToolCall": {
      const server = typeof item["server"] === "string"
        ? (item["server"] as string)
        : "?";
      const tool = typeof item["tool"] === "string"
        ? (item["tool"] as string)
        : "?";
      return {
        id,
        kind: "mcp_tool_call",
        name: `${server}.${tool}`,
        input,
        status,
      };
    }
    case "dynamicToolCall": {
      const tool = typeof item["tool"] === "string"
        ? (item["tool"] as string)
        : "dynamicToolCall";
      return {
        id,
        kind: "dynamic_tool_call",
        name: tool,
        input,
        status,
      };
    }
    default:
      return undefined;
  }
}

/**
 * Copy the item payload verbatim minus `id` and `type` so consumers
 * see the full argument map without the parser having to enumerate
 * every field (which would drift the moment upstream adds one).
 */
function pickAppServerInput(
  item: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (key === "id" || key === "type") continue;
    out[key] = value;
  }
  return out;
}
