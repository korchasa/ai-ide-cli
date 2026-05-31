/**
 * @module
 * ACP-transport {@link NormalizedContent} extractor (FR-L23 / FR-L39).
 *
 * Owned by `runtime/acp/` because ACP is one wire protocol shared by every
 * pilot runtime — `claude`, `codex`, `opencode`. Adding a per-runtime
 * `<runtime>/content.ts` arm for the ACP path would force every pilot to
 * duplicate the same projection. See `runtime/content.ts` for the
 * dispatch entry point.
 *
 * Pure: no I/O, no state, never throws. Returns `[]` for any malformed
 * payload or non-`session/update` event, mirroring the per-CLI
 * extractors' contract.
 */

import type { RuntimeId } from "../../types.ts";
import type { NormalizedContent } from "../content.ts";

/**
 * Extract normalized content from one ACP `session/update` notification.
 *
 * Wire shape per the v0.x ACP fronts:
 *
 *   `{ sessionId, update: { sessionUpdate: "<variant>", ... } }`
 *
 * Recognised variants:
 *
 * - `agent_message_chunk` with `content.type === "text"` →
 *   {@link NormalizedTextContent} with `cumulative: false` (ACP emits
 *   deltas, not running totals).
 * - `tool_call_update` with string `toolCallId` →
 *   {@link NormalizedToolContent}. `name` falls back to the human-friendly
 *   `title` when present, otherwise the structured `kind` tag. `input`
 *   threads through `rawInput` when the front surfaces it.
 *
 * Any other variant — `plan`, `current_mode_update`, future kinds — returns
 * `[]`. Future kinds will gain dedicated branches additively; consumers
 * MUST tolerate `[]` for now.
 *
 * @param _runtime Reserved for future per-pilot divergences (e.g.
 *   if a front emits a non-standard tool descriptor). Currently unused —
 *   the projection is identical across pilots.
 * @param type JSON-RPC method name carried verbatim on
 *   {@link RuntimeSessionEvent.type}. Only `"session/update"` produces
 *   content.
 * @param raw The notification's `params` payload. Some fronts wrap the
 *   variant under `params.update`; others put it at the top level.
 *   Both shapes are accepted.
 */
export function extractAcpContent(
  _runtime: RuntimeId,
  _type: string,
  raw: Record<string, unknown>,
): NormalizedContent[] {
  // Variant-based: the dispatcher already established this is an ACP-shaped
  // event (either by method name or nested `update.sessionUpdate` marker),
  // so we project from the variant directly. Unknown / absent variant ⇒
  // `[]`, matching the per-CLI extractors' "no-op on unknown shape" rule.
  const update = isObject(raw["update"]) ? raw["update"] : raw;
  const variant = update["sessionUpdate"];
  if (variant === "agent_message_chunk") {
    const content = update["content"];
    if (!isObject(content) || content["type"] !== "text") return [];
    const text = content["text"];
    return typeof text === "string"
      ? [{ kind: "text", text, cumulative: false }]
      : [];
  }
  if (variant === "tool_call_update") {
    const id = update["toolCallId"];
    if (typeof id !== "string") return [];
    const titleOrKind = update["title"] ?? update["kind"];
    if (typeof titleOrKind !== "string") return [];
    const input = update["rawInput"];
    return [{
      kind: "tool",
      id,
      name: titleOrKind,
      ...(isObject(input) ? { input } : {}),
    }];
  }
  return [];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
