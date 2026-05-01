/**
 * @module
 * OpenCode-specific {@link NormalizedContent} extractor.
 *
 * Owned by `opencode/` so the dispatcher in `runtime/content.ts` does not
 * have to import {@link OPENCODE_HITL_MCP_TOOL_NAME} from this directory.
 * Tool dispatch mirrors `opencode/process.ts:openCodeToolUseInfo`. See
 * https://opencode.ai/docs/server/ for the SSE event shape.
 */

import type { NormalizedContent } from "../runtime/content.ts";
import { OPENCODE_HITL_MCP_TOOL_NAME } from "./hitl-mcp.ts";

/**
 * OpenCode SSE extractor.
 *
 * Tool dispatch mirrors `opencode/process.ts:openCodeToolUseInfo`: emit
 * only at terminal state (`completed` / `failed`), skip HITL tool, and
 * fall back to `part.callID` when `part.id` is missing. Text events
 * carry the full running message (cumulative).
 *
 * @param type Native OpenCode event type discriminator.
 * @param raw Native OpenCode event payload.
 * @returns Ordered list of normalized content entries for rendering.
 */
export function extractOpenCodeContent(
  type: string,
  raw: Record<string, unknown>,
): NormalizedContent[] {
  if (type !== "message.part.updated") return [];
  const properties = raw["properties"];
  if (!isObject(properties)) return [];
  const part = properties["part"];
  if (!isObject(part)) return [];
  const partType = part["type"];

  if (partType === "text") {
    const text = part["text"];
    if (typeof text === "string") {
      return [{ kind: "text", text, cumulative: true }];
    }
    return [];
  }

  if (partType === "tool") {
    const tool = part["tool"];
    if (typeof tool !== "string" || !tool) return [];
    if (tool === OPENCODE_HITL_MCP_TOOL_NAME) return [];
    const state = part["state"];
    if (!isObject(state)) return [];
    const status = state["status"];
    if (status !== "completed" && status !== "failed") return [];
    const id = typeof part["id"] === "string" && part["id"]
      ? part["id"] as string
      : typeof part["callID"] === "string" && part["callID"]
      ? part["callID"] as string
      : "";
    if (!id) return [];
    const input = state["input"];
    return [{
      kind: "tool",
      id,
      name: tool,
      input: isObject(input) ? input : undefined,
    }];
  }

  return [];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
