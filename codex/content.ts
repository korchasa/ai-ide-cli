/**
 * @module
 * Codex-specific {@link NormalizedContent} extractor.
 *
 * Bound to the v2 camelCase item types from
 * `codex app-server generate-ts` (`ThreadItem`,
 * `AgentMessageDeltaNotification`, `ItemCompletedNotification`) — NOT to
 * the snake_case NDJSON literals used by `codex exec`
 * (`codex/process.ts:codexItemToToolUseInfo`). The two wire formats are
 * parallel; both lift their tool items into the shared
 * {@link CodexConceptualItem} via {@link parseAppServerItem} /
 * {@link parseExecItem}, so this extractor stays a thin renderer over
 * the conceptual layer.
 */

import type { NormalizedContent } from "../runtime/content.ts";
import { parseAppServerItem } from "./items.ts";

/**
 * Codex app-server extractor.
 *
 * Notifications:
 * - `item/agentMessage/delta` → `{kind:"text", text:params.delta,
 *   cumulative:false}`.
 * - `item/completed`:
 *   - `item.type === "agentMessage"` → `{kind:"final", text:item.text}`.
 *   - tool items (`commandExecution`, `fileChange`, `mcpToolCall`,
 *     `webSearch`, `dynamicToolCall`) are lifted via
 *     {@link parseAppServerItem} and rendered as
 *     `{kind:"tool", id, name, input}`.
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

    if (item["type"] === "agentMessage") {
      const text = item["text"];
      if (typeof text === "string") return [{ kind: "final", text }];
      return [];
    }

    const conc = parseAppServerItem(item);
    if (!conc) return [];
    return [{ kind: "tool", id: conc.id, name: conc.name, input: conc.input }];
  }

  return [];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
