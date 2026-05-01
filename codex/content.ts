/**
 * @module
 * Codex-specific {@link NormalizedContent} extractor.
 *
 * Bound to the v2 camelCase item types from
 * `codex app-server generate-ts` (`ThreadItem`,
 * `AgentMessageDeltaNotification`, `ItemCompletedNotification`) — NOT to
 * the snake_case NDJSON literals used by `codex exec`
 * (`codex/process.ts:codexItemToToolUseInfo`). The two wire formats are
 * parallel and must be kept independently in sync with their own
 * upstream. Generate locally via `codex app-server generate-ts --out <dir>`
 * and inspect `v2/ThreadItem.ts`, `v2/ItemCompletedNotification.ts`,
 * `v2/AgentMessageDeltaNotification.ts`.
 */

import type { NormalizedContent } from "../runtime/content.ts";

/**
 * Codex app-server extractor.
 *
 * Notifications:
 * - `item/agentMessage/delta` → `{kind:"text", text:params.delta,
 *   cumulative:false}`.
 * - `item/completed`:
 *   - `item.type === "agentMessage"` → `{kind:"final", text:item.text}`.
 *   - `item.type === "commandExecution" | "fileChange" | "webSearch"` →
 *     `{kind:"tool", id:item.id, name:item.type, input:<rest>}`.
 *   - `item.type === "mcpToolCall"` → `name = "<server>.<tool>"`.
 *   - `item.type === "dynamicToolCall"` → `name = item.tool` (or the
 *     discriminator if the tool field is missing).
 *
 * @param raw Native Codex JSON-RPC notification payload.
 * @returns Ordered list of normalized content entries for rendering.
 */
export function extractCodexContent(
  raw: Record<string, unknown>,
): NormalizedContent[] {
  const method = raw["method"];
  const params = raw["params"];
  if (typeof method !== "string" || !isObject(params)) return [];

  if (method === "item/agentMessage/delta") {
    const delta = params["delta"];
    if (typeof delta === "string") {
      return [{ kind: "text", text: delta, cumulative: false }];
    }
    return [];
  }

  if (method === "item/completed") {
    const item = params["item"];
    if (!isObject(item)) return [];
    const iType = item["type"];
    const id = typeof item["id"] === "string" ? item["id"] : "";

    if (iType === "agentMessage") {
      const text = item["text"];
      if (typeof text === "string") {
        return [{ kind: "final", text }];
      }
      return [];
    }

    if (!id) return [];

    switch (iType) {
      case "commandExecution":
      case "fileChange":
      case "webSearch":
        return [{
          kind: "tool",
          id,
          name: iType,
          input: pickItemInput(item),
        }];
      case "mcpToolCall": {
        const server = typeof item["server"] === "string"
          ? item["server"]
          : "?";
        const tool = typeof item["tool"] === "string" ? item["tool"] : "?";
        return [{
          kind: "tool",
          id,
          name: `${server}.${tool}`,
          input: pickItemInput(item),
        }];
      }
      case "dynamicToolCall": {
        const tool = typeof item["tool"] === "string"
          ? item["tool"]
          : "dynamicToolCall";
        return [{
          kind: "tool",
          id,
          name: tool,
          input: pickItemInput(item),
        }];
      }
      default:
        return [];
    }
  }

  return [];
}

/**
 * Copy the item payload verbatim minus `id` and `type` so consumers
 * get the full argument map without the extractor having to enumerate
 * every field (which would drift the moment upstream adds one).
 */
function pickItemInput(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (key === "id" || key === "type") continue;
    out[key] = value;
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
