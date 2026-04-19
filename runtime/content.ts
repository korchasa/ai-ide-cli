/**
 * @module
 * Runtime-neutral normalized content extraction for
 * {@link RuntimeSessionEvent}.
 *
 * Consumers of {@link import("./types.ts").RuntimeSession.events} that want
 * to render a live UI (streaming assistant text, tool invocations, final
 * reply) call {@link extractSessionContent} once per event and receive a
 * uniform {@link NormalizedContent} array — no per-runtime `raw.*`
 * branching required. The envelope (`RuntimeSessionEvent`) stays
 * untouched; consumers that already parse `raw` keep working.
 *
 * Per-runtime source events, timing, and documented gaps live in
 * `runtime/CLAUDE.md` under the "Normalized content" section.
 *
 * Upstream references — use as source of truth when the underlying CLIs
 * update their event shapes:
 *
 * - Claude Agent SDK (TypeScript) — `claude/stream.ts` discriminated
 *   union is the lightweight mirror:
 *   https://github.com/anthropics/claude-agent-sdk-typescript
 * - Codex app-server v2 types — generate locally via
 *   `codex app-server generate-ts --out <dir>` and inspect
 *   `v2/ThreadItem.ts`, `v2/ItemCompletedNotification.ts`,
 *   `v2/AgentMessageDeltaNotification.ts`. **camelCase** literals,
 *   distinct from the snake_case NDJSON used by `codex exec`.
 * - OpenCode server events — `opencode/session.ts` dispatcher +
 *   https://opencode.ai/docs/server/.
 */

import type { RuntimeSessionEvent } from "./types.ts";
import { OPENCODE_HITL_MCP_TOOL_NAME } from "../opencode/hitl-mcp.ts";

/**
 * Streaming assistant text — either a delta to append or the full
 * running message so far.
 */
export interface NormalizedTextContent {
  /** Discriminator. */
  kind: "text";
  /** The text payload. */
  text: string;
  /**
   * `true` when `text` is the full running assistant message so far
   * (the consumer should replace its buffer); `false` when `text` is
   * only a delta to append.
   *
   * Per-runtime mapping:
   * - Claude / OpenCode / Cursor — `cumulative: true` (each event
   *   carries the whole message to date).
   * - Codex — `cumulative: false` (stream emits deltas only).
   */
  cumulative: boolean;
}

/**
 * Tool / command invocation by the assistant. Timing varies across
 * runtimes:
 *
 * - Claude / Cursor — fires at assistant-decision time (before
 *   execution).
 * - Codex / OpenCode — fires at completion time.
 */
export interface NormalizedToolContent {
  /** Discriminator. */
  kind: "tool";
  /** Stable tool-invocation id from the runtime. */
  id: string;
  /** Tool name (runtime-native). */
  name: string;
  /** Tool input map, if the runtime surfaces one. */
  input?: Record<string, unknown>;
}

/**
 * Final assistant reply for the just-ended turn. Not every runtime
 * emits this — OpenCode has no native final-text event, so consumers
 * build the final reply by keeping the last {@link NormalizedTextContent}
 * with `cumulative: true` and flushing it on
 * {@link import("./types.ts").SYNTHETIC_TURN_END}.
 */
export interface NormalizedFinalContent {
  /** Discriminator. */
  kind: "final";
  /** Complete assistant reply text. */
  text: string;
}

/** Union of all normalized content shapes emitted by this extractor. */
export type NormalizedContent =
  | NormalizedTextContent
  | NormalizedToolContent
  | NormalizedFinalContent;

// FR-L23
/**
 * Extract normalized content from a {@link RuntimeSessionEvent}.
 *
 * Returns an empty array when the event has nothing to render — this is
 * the neutral no-op answer for synthetic events (turn-end, Cursor
 * open-time init), unknown event types, and malformed payloads. The
 * extractor is pure: no I/O, no state, never throws.
 *
 * Multiple normalized entries may be returned from a single event when
 * the runtime packs several content blocks together (e.g. a Claude
 * `assistant` event with text followed by a tool-use block). Order is
 * preserved.
 *
 * @param event Native runtime session event.
 * @returns Ordered list of normalized content entries for rendering.
 */
export function extractSessionContent(
  event: RuntimeSessionEvent,
): NormalizedContent[] {
  if (event.synthetic) return [];
  switch (event.runtime) {
    case "claude":
    case "cursor":
      // Cursor emits stream-json in the same shape as Claude (per-turn
      // subprocess output). Maintainer note: if upstream Cursor ever
      // diverges from Claude's stream-json, fork the extractor — shared
      // call-site makes silent drift invisible.
      return extractClaudeContent(event.type, event.raw);
    case "codex":
      return extractCodexContent(event.raw);
    case "opencode":
      return extractOpenCodeContent(event.type, event.raw);
  }
}

/**
 * Claude / Cursor stream-json extractor.
 *
 * - `type === "assistant"` → one entry per `raw.message.content[]`
 *   block (text → `NormalizedTextContent`, tool_use →
 *   `NormalizedToolContent`, thinking → skipped).
 * - `type === "result"` with string `raw.result` → one
 *   `NormalizedFinalContent` (empty string included; consumer decides
 *   whether to render an empty reply).
 * - All other types → `[]`.
 */
function extractClaudeContent(
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

/**
 * Codex app-server extractor. Bound to the v2 camelCase item types from
 * `codex app-server generate-ts` (`ThreadItem`,
 * `AgentMessageDeltaNotification`, `ItemCompletedNotification`) — NOT
 * to the snake_case NDJSON literals used by `codex exec`
 * (`codex/process.ts:codexItemToToolUseInfo`). The two wire formats are
 * parallel and must be kept independently in sync with their own
 * upstream.
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
 */
function extractCodexContent(
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

/**
 * OpenCode SSE extractor. Tool dispatch mirrors
 * `opencode/process.ts:openCodeToolUseInfo`: emit only at terminal
 * state (`completed` / `failed`), skip HITL tool, and fall back to
 * `part.callID` when `part.id` is missing. Text events carry the full
 * running message (cumulative).
 */
function extractOpenCodeContent(
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

/** Narrow `unknown` to a plain (non-array, non-null) object record. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
