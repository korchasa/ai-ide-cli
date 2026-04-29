/**
 * @module
 * Cursor CLI stream-json event processing: typed discriminated union
 * over `cursor agent -p --output-format stream-json` events plus an
 * NDJSON parser, tool-call wrapper unflattener, and typed lifecycle
 * hooks.
 *
 * Empirical taxonomy captured via `scripts/smoke.ts cursor-events`
 * (dump: `/tmp/cursor-events-*.ndjson`). Cursor stream-json is
 * **NOT** identical to Claude's despite the matching `--output-format`
 * flag — tool calls are sibling top-level events with a wrapper
 * payload, not inline `tool_use` blocks. See FR-L30.
 *
 * Entry points: {@link parseCursorStreamEvent},
 * {@link unwrapCursorToolCall}.
 */

// FR-L30: typed cursor stream-json event union.

/** Assistant text block inside a Cursor `assistant` event. */
export interface CursorTextBlock {
  /** Discriminator for text blocks. */
  type: "text";
  /** The block's text payload. */
  text: string;
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/**
 * Union of Cursor assistant content blocks.
 *
 * Empirically Cursor only emits `text` blocks inside
 * `assistant.message.content[]` — tool invocations live on separate
 * top-level `tool_call/*` events. The union is a single-variant
 * discriminator today, ready to grow if upstream Cursor adds more
 * block kinds.
 */
export type CursorAssistantBlock = CursorTextBlock;

/** `system` / `init` event emitted at session start. */
export interface CursorSystemInitEvent {
  /** Discriminator. */
  type: "system";
  /** Sub-kind — only `"init"` is currently observed. */
  subtype: "init";
  /** Where the session's API key came from (`"login"` for GUI auth). */
  apiKeySource?: string;
  /** Active workspace directory at spawn time. */
  cwd?: string;
  /** Active model identifier (`"Auto"` when Cursor routes itself). */
  model?: string;
  /** Active permission mode (`"default"`, `"plan"`, `"ask"`, …). */
  permissionMode?: string;
  /** Session ID for later resume. */
  session_id?: string;
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/** `user` event echoing the prompt back into the stream. */
export interface CursorUserEvent {
  /** Discriminator. */
  type: "user";
  /** Echoed user message payload. Shape preserved verbatim. */
  message?: unknown;
  /** Session ID. */
  session_id?: string;
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/** Streaming reasoning chunk. **High volume** — ~90% of a typical run. */
export interface CursorThinkingDeltaEvent {
  /** Discriminator. */
  type: "thinking";
  /** Sub-kind. */
  subtype: "delta";
  /** Reasoning chunk text. */
  text?: string;
  /** Wall-clock timestamp (ms since epoch). */
  timestamp_ms?: number;
  /** Session ID. */
  session_id?: string;
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/** Marker that the reasoning stream has ended for the current turn. */
export interface CursorThinkingCompletedEvent {
  /** Discriminator. */
  type: "thinking";
  /** Sub-kind. */
  subtype: "completed";
  /** Wall-clock timestamp (ms since epoch). */
  timestamp_ms?: number;
  /** Session ID. */
  session_id?: string;
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/** Union of all `thinking` events. */
export type CursorThinkingEvent =
  | CursorThinkingDeltaEvent
  | CursorThinkingCompletedEvent;

/** `assistant` event with a structured message body. */
export interface CursorAssistantEvent {
  /** Discriminator. */
  type: "assistant";
  /**
   * Message body with a content array of typed blocks.
   * Cursor only emits `text` blocks inline; tool calls are separate.
   */
  message?: {
    /** `"assistant"` from upstream. */
    role?: string;
    /** Typed content blocks (text only on Cursor today). */
    content?: CursorAssistantBlock[];
    /** Allow forward-compat upstream fields without casting. */
    [key: string]: unknown;
  };
  /** Per-call id assigned by the model layer. */
  model_call_id?: string;
  /** Session ID. */
  session_id?: string;
  /** Wall-clock timestamp (ms since epoch). */
  timestamp_ms?: number;
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/**
 * Wrapper payload Cursor uses for every tool call. The single key inside
 * encodes the tool name (e.g. `readToolCall`, `grepToolCall`,
 * `editToolCall`); the inner record holds either `args` (started) or
 * `result` (completed).
 */
export interface CursorToolCallWrapper {
  /** Forward-compat — the only field is the dynamic `<name>ToolCall` key. */
  [toolKey: string]: {
    /** Tool input arguments — present on `started` events. */
    args?: Record<string, unknown>;
    /** Tool result payload — present on `completed` events. */
    result?: Record<string, unknown> | { error?: { errorMessage?: string } };
    /** Allow forward-compat upstream fields without casting. */
    [key: string]: unknown;
  };
}

/** Tool call dispatched by the model — pre-execution. */
export interface CursorToolCallStartedEvent {
  /** Discriminator. */
  type: "tool_call";
  /** Sub-kind. */
  subtype: "started";
  /** Stable tool-invocation id. */
  call_id: string;
  /** Per-call id assigned by the model layer. */
  model_call_id?: string;
  /** Wrapped tool payload — see {@link unwrapCursorToolCall}. */
  tool_call: CursorToolCallWrapper;
  /** Session ID. */
  session_id?: string;
  /** Wall-clock timestamp (ms since epoch). */
  timestamp_ms?: number;
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/** Tool call result — post-execution (success or error). */
export interface CursorToolCallCompletedEvent {
  /** Discriminator. */
  type: "tool_call";
  /** Sub-kind. */
  subtype: "completed";
  /** Stable tool-invocation id (matches the `started` event). */
  call_id: string;
  /** Per-call id assigned by the model layer. */
  model_call_id?: string;
  /** Wrapped tool payload — see {@link unwrapCursorToolCall}. */
  tool_call: CursorToolCallWrapper;
  /** Session ID. */
  session_id?: string;
  /** Wall-clock timestamp (ms since epoch). */
  timestamp_ms?: number;
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/** Union of all `tool_call` events. */
export type CursorToolCallEvent =
  | CursorToolCallStartedEvent
  | CursorToolCallCompletedEvent;

/** Token-usage block carried by the terminal `result` event. */
export interface CursorUsage {
  /** Tokens consumed from input prompt. */
  inputTokens?: number;
  /** Tokens generated as output. */
  outputTokens?: number;
  /** Tokens served from prompt cache. */
  cacheReadTokens?: number;
  /** Tokens written to prompt cache. */
  cacheWriteTokens?: number;
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/** Terminal `result` event — emitted once per run. */
export interface CursorResultEvent {
  /** Discriminator. */
  type: "result";
  /** Run subtype — `"success"` is the only currently observed value. */
  subtype?: string;
  /** Final assistant-facing result text. */
  result?: string;
  /** Session ID. */
  session_id?: string;
  /** Server-side request id (Cursor backend). */
  request_id?: string;
  /** Wall-clock duration (ms). */
  duration_ms?: number;
  /** API-side duration (ms). */
  duration_api_ms?: number;
  /** Whether the CLI treated this as an error run. */
  is_error?: boolean;
  /** Token-usage breakdown. Cursor does NOT emit `total_cost_usd`. */
  usage?: CursorUsage;
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/**
 * Fallback shape for any event type we do not explicitly model yet.
 * Keeps the parser forward-compatible without bricking on new CLI events.
 */
export interface CursorUnknownEvent {
  /** Event discriminator preserved verbatim. */
  type: string;
  /** All other fields preserved for callers that want to read them. */
  [key: string]: unknown;
}

/** Discriminated union of every Cursor stream-json event we surface. */
export type CursorStreamEvent =
  | CursorSystemInitEvent
  | CursorUserEvent
  | CursorThinkingEvent
  | CursorAssistantEvent
  | CursorToolCallEvent
  | CursorResultEvent
  | CursorUnknownEvent;

// FR-L30: parse a single NDJSON line into a typed CursorStreamEvent.
/**
 * Parse a single NDJSON line into a typed {@link CursorStreamEvent}.
 * Returns `null` on invalid JSON, empty input, or when `type` is missing.
 * Pure function — no I/O.
 */
export function parseCursorStreamEvent(
  line: string,
): CursorStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  return parsed as CursorStreamEvent;
}

/** Flattened tool call payload returned by {@link unwrapCursorToolCall}. */
export interface UnwrappedCursorToolCall {
  /** Tool name (e.g. `"read"`, `"grep"`, `"edit"`). */
  name: string;
  /** Tool input arguments (present on `started` events). */
  args?: Record<string, unknown>;
  /** Tool result payload (present on `completed` events on success). */
  result?: Record<string, unknown>;
  /** Error message extracted from `result.error.errorMessage` when present. */
  errorMessage?: string;
}

// FR-L30: flatten Cursor's `tool_call.<name>ToolCall` wrapper.
/**
 * Unwrap Cursor's `{<name>ToolCall: {args | result}}` payload into a
 * flat `{name, args?, result?, errorMessage?}` shape so consumers
 * never enumerate per-tool keys themselves.
 *
 * Tool-name extraction strips the trailing `ToolCall` suffix from the
 * wrapper key (`readToolCall` → `read`, `grepToolCall` → `grep`).
 * Returns `null` if the wrapper is empty or malformed (forward-compat
 * fallback — caller should keep the raw event in that case).
 */
export function unwrapCursorToolCall(
  wrapper: CursorToolCallWrapper | undefined | null,
): UnwrappedCursorToolCall | null {
  if (!wrapper || typeof wrapper !== "object") return null;
  const keys = Object.keys(wrapper);
  if (keys.length === 0) return null;
  const wrapperKey = keys[0];
  const inner = wrapper[wrapperKey];
  if (!inner || typeof inner !== "object") return null;

  const name = wrapperKey.endsWith("ToolCall")
    ? wrapperKey.slice(0, -"ToolCall".length)
    : wrapperKey;
  if (!name) return null;

  const out: UnwrappedCursorToolCall = { name };
  if (inner.args && typeof inner.args === "object") {
    out.args = inner.args as Record<string, unknown>;
  }
  if (inner.result && typeof inner.result === "object") {
    const errorBlock = (inner.result as { error?: unknown }).error;
    if (
      errorBlock && typeof errorBlock === "object" &&
      typeof (errorBlock as { errorMessage?: unknown }).errorMessage ===
        "string"
    ) {
      out.errorMessage = (errorBlock as { errorMessage: string }).errorMessage;
    } else {
      out.result = inner.result as Record<string, unknown>;
    }
  }
  return out;
}

/** Info passed to the cursor-specific observed-tool-use callback. */
export interface CursorToolUseInfo {
  /** Stable tool invocation id (`call_id` from the started event). */
  id: string;
  /** Flattened tool name (e.g. `"read"`, `"grep"`). */
  name: string;
  /** Tool input map — preserved as-is from the wrapper's `args` field. */
  input?: Record<string, unknown>;
  /** Current assistant turn index (1-based). */
  turn: number;
}

/**
 * Decision returned by an {@link OnCursorToolUseObservedCallback}.
 *
 * - `"allow"` — run continues untouched.
 * - `"abort"` — the cursor CLI process is terminated and `CliRunOutput`
 *   is synthesized with `is_error: true` and a single
 *   `permission_denials[]` entry describing the observed tool.
 */
export type CursorToolUseObservedDecision = "allow" | "abort";

/**
 * Callback invoked for every observed `tool_call/started` event emitted
 * by the Cursor CLI. Fires **post-dispatch but pre-tool-execution** —
 * by the time the callback runs, the CLI has already decided to invoke
 * the tool but execution may still be in flight; `"abort"` stops the
 * run but cannot un-execute work already started.
 */
export type OnCursorToolUseObservedCallback = (
  info: CursorToolUseInfo,
) => CursorToolUseObservedDecision | Promise<CursorToolUseObservedDecision>;

/**
 * Typed lifecycle hooks for Cursor stream events. Each hook fires at most
 * once per event, *after* the raw-event escape hatch but *before*
 * internal state mutations (turn counter, log writes).
 */
export interface CursorLifecycleHooks {
  /** Fires once at session start when the `system`/`init` event is seen. */
  onInit?: (event: CursorSystemInitEvent) => void;
  /** Fires once per assistant turn (many times per run). */
  onAssistant?: (event: CursorAssistantEvent) => void;
  /** Fires exactly once at run termination on the `result` event. */
  onResult?: (event: CursorResultEvent) => void;
}
