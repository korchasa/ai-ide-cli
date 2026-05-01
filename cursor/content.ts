/**
 * @module
 * Cursor-specific {@link NormalizedContent} extractor (FR-L30).
 *
 * Cursor's stream-json output diverges from Claude's despite the matching
 * `--output-format` flag — tool calls are sibling top-level `tool_call`
 * events, not inline `tool_use` blocks inside assistant content. Empirical
 * taxonomy captured in `scripts/smoke.ts cursor-events`. Owned by `cursor/`
 * so the dispatcher in `runtime/content.ts` stays runtime-agnostic.
 */

import type { NormalizedContent } from "../runtime/content.ts";
import { unwrapCursorToolCall } from "./stream.ts";

// FR-L30
/**
 * Cursor stream-json extractor.
 *
 * - `type === "assistant"` → one `NormalizedTextContent` per
 *   `raw.message.content[]` block of `{type:"text", text}`. Cursor
 *   does NOT inline tool blocks inside assistant content.
 * - `type === "tool_call"` with `subtype === "started"` → one
 *   `NormalizedToolContent`. Tool name and args come from
 *   {@link unwrapCursorToolCall} flattening the
 *   `tool_call.<name>ToolCall.args` wrapper. `subtype === "completed"`
 *   is intentionally skipped — emitting at decision time mirrors
 *   Claude's timing (FR-L23 timing-asymmetry note).
 * - `type === "result"` with string `raw.result` → one
 *   `NormalizedFinalContent`.
 * - `thinking`, `user`, and unknown types → `[]`.
 *
 * @param type Native Cursor event type discriminator.
 * @param raw Native Cursor event payload.
 * @returns Ordered list of normalized content entries for rendering.
 */
export function extractCursorContent(
  type: string,
  raw: Record<string, unknown>,
): NormalizedContent[] {
  if (type === "assistant") {
    const message = raw["message"];
    if (!isObject(message)) return [];
    const content = message["content"];
    if (!Array.isArray(content)) return [];
    const out: NormalizedContent[] = [];
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block["type"] !== "text") continue;
      const text = block["text"];
      if (typeof text === "string") {
        out.push({ kind: "text", text, cumulative: true });
      }
    }
    return out;
  }
  if (type === "tool_call") {
    if (raw["subtype"] !== "started") return [];
    const callId = raw["call_id"];
    if (typeof callId !== "string" || !callId) return [];
    const wrapper = raw["tool_call"];
    if (!isObject(wrapper)) return [];
    const unwrapped = unwrapCursorToolCall(
      wrapper as Parameters<typeof unwrapCursorToolCall>[0],
    );
    if (!unwrapped) return [];
    return [{
      kind: "tool",
      id: callId,
      name: unwrapped.name,
      input: unwrapped.args,
    }];
  }
  if (type === "result") {
    const result = raw["result"];
    if (typeof result === "string") {
      return [{ kind: "final", text: result }];
    }
  }
  return [];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
