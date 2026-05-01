/**
 * @module
 * Claude-specific {@link NormalizedContent} extractor.
 *
 * Owned by `claude/` so that adding a new runtime never requires editing
 * `runtime/content.ts` — the dispatcher only has to add a new branch
 * pointing at the new per-runtime file. See `runtime/content.ts` for the
 * dispatch entry point and the runtime-neutral type definitions.
 *
 * Upstream reference: Claude Agent SDK (TypeScript) —
 * https://github.com/anthropics/claude-agent-sdk-typescript
 * `claude/stream.ts` discriminated union is the lightweight mirror.
 */

import type { NormalizedContent } from "../runtime/content.ts";

/**
 * Claude stream-json extractor.
 *
 * - `type === "assistant"` → one entry per `raw.message.content[]`
 *   block (text → `NormalizedTextContent`, tool_use →
 *   `NormalizedToolContent`, thinking → skipped).
 * - `type === "result"` with string `raw.result` → one
 *   `NormalizedFinalContent` (empty string included; consumer decides
 *   whether to render an empty reply).
 * - All other types → `[]`.
 *
 * @param type Native Claude event type discriminator.
 * @param raw Native Claude event payload.
 * @returns Ordered list of normalized content entries for rendering.
 */
export function extractClaudeContent(
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
      const bType = block["type"];
      if (bType === "text") {
        const text = block["text"];
        if (typeof text === "string") {
          out.push({ kind: "text", text, cumulative: true });
        }
      } else if (bType === "tool_use") {
        const id = block["id"];
        const name = block["name"];
        if (typeof id === "string" && typeof name === "string") {
          const input = block["input"];
          out.push({
            kind: "tool",
            id,
            name,
            input: isObject(input) ? input : undefined,
          });
        }
      }
      // `thinking` and other block kinds are deliberately skipped here;
      // reasoning blocks may become a dedicated `kind` in the future.
    }
    return out;
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
