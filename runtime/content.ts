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
 * Per-runtime extraction logic lives in `<runtime>/content.ts`. This
 * module is the thin dispatcher — together with `runtime/index.ts` it is
 * the only module under `runtime/` allowed to import from `<runtime>/*`,
 * because both are aggregators by definition. See `runtime/CLAUDE.md`
 * "Gotchas" for the rule.
 *
 * Per-runtime source events, timing, and documented gaps live in
 * `runtime/CLAUDE.md` under the "Normalized content" section.
 */

import type { RuntimeSessionEvent } from "./types.ts";
import { extractClaudeContent } from "../claude/content.ts";
import { extractCursorContent } from "../cursor/content.ts";
import { extractCodexContent } from "../codex/content.ts";
import { extractOpenCodeContent } from "../opencode/content.ts";
import { extractAcpContent } from "./acp/content.ts";

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
  // FR-L39 / FR-L23: events from the ACP transport carry the JSON-RPC
  // method name on `event.type` (`"session/update"`) and ACP-specific
  // wire shapes on `event.raw`. The per-CLI extractors expect their
  // native stream-json / NDJSON shapes and would return `[]` for ACP
  // events, so we detect first and route through `extractAcpContent`.
  if (isAcpShapedEvent(event)) {
    return extractAcpContent(event.runtime, event.type, event.raw);
  }
  switch (event.runtime) {
    case "claude":
      return extractClaudeContent(event.type, event.raw);
    case "cursor":
      // FR-L30: Cursor diverges from Claude's stream-json — tool calls
      // are sibling top-level `tool_call/*` events, not inline
      // `tool_use` blocks. Empirical taxonomy captured in
      // `scripts/smoke.ts cursor-events`.
      return extractCursorContent(event.type, event.raw);
    case "codex":
      return extractCodexContent(event.raw);
    case "opencode":
      return extractOpenCodeContent(event.type, event.raw);
  }
}

// Primary signal: `runtime/acp/mapping.ts:mapSessionUpdate` stores the
// JSON-RPC method verbatim in `event.type`. Defensive fallback: future
// ACP fronts may drop the method-name prefix and emit a bare wrapper
// under `raw.update.sessionUpdate`. Order matters — the explicit method
// check is the authoritative one.
function isAcpShapedEvent(event: RuntimeSessionEvent): boolean {
  if (event.type === "session/update") return true;
  const update = event.raw["update"];
  if (typeof update !== "object" || update === null) return false;
  const variant = (update as Record<string, unknown>)["sessionUpdate"];
  return typeof variant === "string";
}
