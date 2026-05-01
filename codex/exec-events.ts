/**
 * @module
 * Typed discriminated union over the `codex exec --experimental-json`
 * NDJSON event stream + a single-line parser.
 *
 * **Parallel protocol warning.** This module models the snake_case
 * NDJSON protocol consumed by {@link ../codex/process.ts}. The
 * sibling `codex app-server` JSON-RPC protocol consumed by
 * {@link ../codex/session.ts} uses **camelCase** discriminators and is
 * typed in {@link ../codex/events.ts}. Do NOT cross-reference — the
 * two protocols share names but not field shapes (e.g. NDJSON
 * `command_execution.aggregated_output` vs JSON-RPC
 * `commandExecution` with no aggregated-output field).
 *
 * Empirical taxonomy captured via real `codex exec` smoke runs and
 * the upstream SDK reference (`@openai/codex-sdk` `items.ts`). Targets
 * `codex-cli >= 0.121.0` — every interface carries a
 * `[key: string]: unknown` index signature for forward-compat with
 * fields the upstream CLI may add in a minor bump.
 *
 * Mirrors the pattern from {@link ../claude/stream.ts:parseClaudeStreamEvent}
 * and {@link ../cursor/stream.ts:parseCursorStreamEvent} (FR-L30):
 * a sharp discriminated union plus a forgiving parser that returns
 * `null` on malformed input rather than throwing.
 *
 * Entry point: {@link parseCodexExecEvent}.
 */

// --- Shared payload types ---

/**
 * Token-usage payload carried by `turn.completed`. All fields are
 * optional — Codex omits them on early-aborted turns.
 */
export interface CodexExecUsage {
  /** Input tokens consumed by the prompt. */
  input_tokens?: number;
  /** Cached input tokens served from the prompt cache. */
  cached_input_tokens?: number;
  /** Output tokens produced by the model. */
  output_tokens?: number;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Nested error payload for `turn.failed.error` and `error` items. */
export interface CodexExecErrorPayload {
  /** Human-readable error message. */
  message?: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** A single file mutation entry inside a `file_change` item's `changes` array. */
export interface CodexExecFileChange {
  /** Repo-relative path of the affected file. */
  path?: string;
  /** Mutation kind (`create` / `modify` / `delete` / future). */
  kind?: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** A single todo entry inside a `todo_list` item's `items` array. */
export interface CodexExecTodoEntry {
  /** Todo description text. */
  text?: string;
  /** Lifecycle status (`pending` / `in_progress` / `completed` / future). */
  status?: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

// --- CodexExecItem discriminated union (carried inside item.completed) ---

/** Final assistant text for the current turn. */
export interface CodexExecAgentMessageItem {
  /** Stable item id assigned by Codex. */
  id: string;
  /** Discriminator. */
  type: "agent_message";
  /** Final assistant text. Empty string is valid. */
  text?: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Shell command invocation — typically emitted post-execution. */
export interface CodexExecCommandExecutionItem {
  /** Stable item id. */
  id: string;
  /** Discriminator. */
  type: "command_execution";
  /** Raw command string. */
  command?: string;
  /** Lifecycle status (`completed` / `failed` / `declined` / future). */
  status?: string;
  /** Process exit code (when terminal). */
  exit_code?: number;
  /** Aggregated stdout+stderr (when terminal). */
  aggregated_output?: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Workspace-write file change(s) applied by the agent. */
export interface CodexExecFileChangeItem {
  /** Stable item id. */
  id: string;
  /** Discriminator. */
  type: "file_change";
  /** Lifecycle status (`completed` / `failed` / future). */
  status?: string;
  /** List of per-file mutations. */
  changes?: CodexExecFileChange[];
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Local or remote MCP tool invocation. */
export interface CodexExecMcpToolCallItem {
  /** Stable item id. */
  id: string;
  /** Discriminator. */
  type: "mcp_tool_call";
  /** MCP server name. */
  server?: string;
  /** MCP tool name. */
  tool?: string;
  /** Lifecycle status. */
  status?: string;
  /** Tool arguments — opaque map. */
  arguments?: Record<string, unknown>;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Web-search invocation (built-in tool). */
export interface CodexExecWebSearchItem {
  /** Stable item id. */
  id: string;
  /** Discriminator. */
  type: "web_search";
  /** Search query string. */
  query?: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Internal reasoning surfaced by the model (when configured). */
export interface CodexExecReasoningItem {
  /** Stable item id. */
  id: string;
  /** Discriminator. */
  type: "reasoning";
  /** Reasoning text fragment. */
  text?: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Plan/todo list update emitted by the agent. */
export interface CodexExecTodoListItem {
  /** Stable item id. */
  id: string;
  /** Discriminator. */
  type: "todo_list";
  /** List of todo entries. */
  items?: CodexExecTodoEntry[];
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Per-item error (e.g. tool execution failed). */
export interface CodexExecErrorItem {
  /** Stable item id. */
  id: string;
  /** Discriminator. */
  type: "error";
  /** Human-readable error message. */
  message?: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/**
 * Forward-compat fallback for unknown item types. Keeps the parser
 * future-proof when a Codex CLI minor bump introduces a new item kind.
 */
export interface CodexExecUnknownItem {
  /** Stable item id (when present). */
  id?: string;
  /** Discriminator preserved verbatim. */
  type: string;
  /** All other fields preserved for callers that want to read them. */
  [key: string]: unknown;
}

/** Discriminated union over every known {@link CodexExecItem} variant. */
export type CodexExecItem =
  | CodexExecAgentMessageItem
  | CodexExecCommandExecutionItem
  | CodexExecFileChangeItem
  | CodexExecMcpToolCallItem
  | CodexExecWebSearchItem
  | CodexExecReasoningItem
  | CodexExecTodoListItem
  | CodexExecErrorItem
  | CodexExecUnknownItem;

// --- CodexExecEvent discriminated union (top-level NDJSON events) ---

/** Session-start event — first NDJSON line of every run. */
export interface CodexExecThreadStartedEvent {
  /** Discriminator. */
  type: "thread.started";
  /** Thread ID for later resume / transcript lookup. */
  thread_id?: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** End-of-turn event carrying token usage. */
export interface CodexExecTurnCompletedEvent {
  /** Discriminator. */
  type: "turn.completed";
  /** Token usage breakdown for the turn. */
  usage?: CodexExecUsage;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Failed-turn event with a nested error payload. */
export interface CodexExecTurnFailedEvent {
  /** Discriminator. */
  type: "turn.failed";
  /** Error payload. */
  error?: CodexExecErrorPayload;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Run-level error event (transport / API failure). */
export interface CodexExecErrorEvent {
  /** Discriminator. */
  type: "error";
  /** Human-readable error message. */
  message?: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Item-completion event wrapping a {@link CodexExecItem}. */
export interface CodexExecItemCompletedEvent {
  /** Discriminator. */
  type: "item.completed";
  /** The completed item payload. */
  item: CodexExecItem;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/**
 * Forward-compat fallback for unknown top-level event types
 * (e.g. `turn.started`, future variants). Keeps the parser
 * future-proof without hard-coding every CLI-internal event.
 */
export interface CodexExecUnknownEvent {
  /** Event discriminator preserved verbatim. */
  type: string;
  /** All other fields preserved for callers that want to read them. */
  [key: string]: unknown;
}

/** Discriminated union of every Codex `exec --experimental-json` event. */
export type CodexExecEvent =
  | CodexExecThreadStartedEvent
  | CodexExecTurnCompletedEvent
  | CodexExecTurnFailedEvent
  | CodexExecErrorEvent
  | CodexExecItemCompletedEvent
  | CodexExecUnknownEvent;

// --- Parser ---

/**
 * Parse a single NDJSON line into a typed {@link CodexExecEvent}.
 * Returns `null` on invalid JSON, empty input, JSON arrays, or when
 * the `type` field is missing or non-string. Pure function — no I/O.
 *
 * Mirrors {@link ../claude/stream.ts:parseClaudeStreamEvent} and
 * {@link ../cursor/stream.ts:parseCursorStreamEvent}.
 */
export function parseCodexExecEvent(line: string): CodexExecEvent | null {
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
  return parsed as CodexExecEvent;
}
