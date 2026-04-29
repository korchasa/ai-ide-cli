/**
 * @module
 * Typed discriminated unions for the **experimental** `codex app-server`
 * JSON-RPC notification stream (FR-L26).
 *
 * Hand-mirrored from the upstream-generated TypeScript bindings. To refresh
 * field names / variants when the Codex CLI updates, regenerate locally:
 *
 * ```sh
 * codex app-server generate-ts --experimental --out /tmp/codex-types
 * ```
 *
 * and inspect `v2/ServerNotification.ts`, `v2/ThreadItem.ts`,
 * `v2/Turn.ts`, `v2/AgentMessageDeltaNotification.ts`,
 * `v2/ItemCompletedNotification.ts`, `v2/TurnStartedNotification.ts`,
 * `v2/TurnCompletedNotification.ts`. This file mirrors the variants the
 * library and downstream consumers actually narrow on; lesser-used
 * notifications fall through {@link CodexUnknownNotification} so callers
 * keep `params` as `Record<string, unknown>` and remain forward-compatible.
 *
 * **Scope**: this module is types-only. No runtime imports — `import type`
 * is sufficient on every consumer. Forward-compat fields are modeled as
 * `[key: string]: unknown` index signatures, matching the convention in
 * [claude/stream.ts](../claude/stream.ts).
 *
 * **Stability warning**: `codex app-server` is EXPERIMENTAL upstream. The
 * union here targets `codex-cli >= 0.121.0`; expect breaking renames between
 * minor versions of the CLI.
 */

// --- Shared payload helpers ---

/** Discriminated `Turn` payload — mirrors `v2/Turn.ts`. */
export interface CodexTurn {
  /** Turn id assigned by the app-server. */
  id: string;
  /** Lifecycle phase of the turn. */
  status: "completed" | "interrupted" | "failed" | "inProgress" | string;
  /**
   * Populated only on `thread/resume` / `thread/fork` responses. Typed as
   * the sharp {@link CodexThreadItem} union; future Codex CLI item types
   * surface at runtime as objects with `type: string` (consumer asserts
   * to {@link CodexUntypedItem} when needed).
   */
  items?: CodexThreadItem[];
  /** Populated when `status === "failed"`. */
  error?: { message: string; [key: string]: unknown } | null;
  /** Unix epoch (seconds) when the turn started. */
  startedAt?: number | null;
  /** Unix epoch (seconds) when the turn completed. */
  completedAt?: number | null;
  /** Wall-clock duration of the turn in milliseconds. */
  durationMs?: number | null;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

// --- ThreadItem discriminated union (subset of v2/ThreadItem.ts) ---

/** User-supplied turn input mirrored back as a thread item. */
export interface CodexUserMessageItem {
  /** Discriminator. */
  type: "userMessage";
  /** Stable item id. */
  id: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Final assistant text for a turn. Streaming deltas live in `item/agentMessage/delta`. */
export interface CodexAgentMessageItem {
  /** Discriminator. */
  type: "agentMessage";
  /** Stable item id. */
  id: string;
  /** Final assistant text for this item. Empty string is valid. */
  text: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Internal reasoning summary surfaced to clients that opted in. */
export interface CodexReasoningItem {
  /** Discriminator. */
  type: "reasoning";
  /** Stable item id. */
  id: string;
  /** Short reasoning summary lines. */
  summary?: string[];
  /** Full reasoning text fragments (when configured to surface). */
  content?: string[];
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Plan/todo update emitted by the agent. */
export interface CodexPlanItem {
  /** Discriminator. */
  type: "plan";
  /** Stable item id. */
  id: string;
  /** Plan text (markdown). */
  text: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Shell command execution issued by the agent. */
export interface CodexCommandExecutionItem {
  /** Discriminator. */
  type: "commandExecution";
  /** Stable item id. */
  id: string;
  /** Raw command string. */
  command: string;
  /** Working directory the command ran in. */
  cwd: string;
  /** Lifecycle status. */
  status: "inProgress" | "completed" | "failed" | "declined" | string;
  /** Aggregated stdout+stderr (only set when `status` is terminal). */
  aggregatedOutput?: string | null;
  /** Process exit code (terminal status only). */
  exitCode?: number | null;
  /** Wall-clock execution time. */
  durationMs?: number | null;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** File change applied by the agent (write/patch/delete). */
export interface CodexFileChangeItem {
  /** Discriminator. */
  type: "fileChange";
  /** Stable item id. */
  id: string;
  /** Per-file diff entries, mirroring `v2/FileUpdateChange.ts`. */
  changes?: Array<Record<string, unknown>>;
  /** Apply status. */
  status?: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** MCP tool call — `name` is `"<server>.<tool>"`. */
export interface CodexMcpToolCallItem {
  /** Discriminator. */
  type: "mcpToolCall";
  /** Stable item id. */
  id: string;
  /** MCP server name. */
  server: string;
  /** Tool name on the MCP server. */
  tool: string;
  /** Lifecycle status. */
  status: "inProgress" | "completed" | "failed" | string;
  /** Tool arguments JSON. */
  arguments?: unknown;
  /** Tool result on success. */
  result?: unknown;
  /** Tool error on failure. */
  error?: unknown;
  /** Wall-clock execution time. */
  durationMs?: number | null;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Dynamic (client-registered) tool call. */
export interface CodexDynamicToolCallItem {
  /** Discriminator. */
  type: "dynamicToolCall";
  /** Stable item id. */
  id: string;
  /** Tool name. */
  tool: string;
  /** Tool arguments JSON. */
  arguments?: unknown;
  /** Lifecycle status. */
  status: "inProgress" | "completed" | "failed" | string;
  /** Whether the call ultimately succeeded (terminal status only). */
  success?: boolean | null;
  /** Wall-clock execution time. */
  durationMs?: number | null;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Web-search action issued by the agent. */
export interface CodexWebSearchItem {
  /** Discriminator. */
  type: "webSearch";
  /** Stable item id. */
  id: string;
  /** Search query string. */
  query: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Context-compaction marker — agent re-summarized older turns. */
export interface CodexContextCompactionItem {
  /** Discriminator. */
  type: "contextCompaction";
  /** Stable item id. */
  id: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/**
 * Discriminated union of every Codex `ThreadItem` variant we narrow.
 *
 * **No Unknown fallback** for the same reason as
 * {@link CodexNotification}: a `type: string` variant breaks
 * discriminator narrowing on every literal check. Items whose `type`
 * isn't in this list still arrive at runtime — consumers handle them in
 * the `default` branch of a switch (or after the last `if`) where TS
 * sees the type as `never` and the consumer reads `(item as CodexUntypedItem)`.
 */
export type CodexThreadItem =
  | CodexUserMessageItem
  | CodexAgentMessageItem
  | CodexReasoningItem
  | CodexPlanItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexDynamicToolCallItem
  | CodexWebSearchItem
  | CodexContextCompactionItem;

/**
 * Untyped runtime shape of a `ThreadItem` — what the wire actually
 * delivers when a future Codex CLI emits an item type this module does
 * not narrow yet. Use as a type assertion target in the default branch
 * of a switch over {@link CodexThreadItem}.
 */
export interface CodexUntypedItem {
  /** Discriminator preserved verbatim. */
  type: string;
  /** Stable item id. */
  id: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

// --- Notification params (subset of v2/ServerNotification.ts) ---

/** Params for `thread/started` — `v2/ThreadStartedNotification.ts`. */
export interface CodexThreadStartedParams {
  /** New thread id. */
  threadId: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Params for `turn/started` — `v2/TurnStartedNotification.ts`. */
export interface CodexTurnStartedParams {
  /** Owning thread id. */
  threadId: string;
  /** The turn that started. */
  turn: CodexTurn;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Params for `turn/completed` — `v2/TurnCompletedNotification.ts`. */
export interface CodexTurnCompletedParams {
  /** Owning thread id. */
  threadId: string;
  /** Terminal turn payload. */
  turn: CodexTurn;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Params for `item/started` — `v2/ItemStartedNotification.ts`. */
export interface CodexItemStartedParams {
  /** Thread the item belongs to. */
  threadId: string;
  /** Turn the item belongs to. */
  turnId: string;
  /** The item that started. */
  item: CodexThreadItem;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Params for `item/completed` — `v2/ItemCompletedNotification.ts`. */
export interface CodexItemCompletedParams {
  /** Thread the item belongs to. */
  threadId: string;
  /** Turn the item belongs to. */
  turnId: string;
  /** The item in its terminal state. */
  item: CodexThreadItem;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Params for `item/agentMessage/delta` — `v2/AgentMessageDeltaNotification.ts`. */
export interface CodexAgentMessageDeltaParams {
  /** Thread the delta belongs to. */
  threadId: string;
  /** Turn the delta belongs to. */
  turnId: string;
  /** Item id of the streaming agent message. */
  itemId: string;
  /** Text delta to append. */
  delta: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Params for `item/reasoning/textDelta` / `summaryTextDelta`. */
export interface CodexReasoningDeltaParams {
  /** Thread the delta belongs to. */
  threadId: string;
  /** Turn the delta belongs to. */
  turnId: string;
  /** Item id of the streaming reasoning item. */
  itemId: string;
  /** Reasoning text delta. */
  delta: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Params for `item/commandExecution/outputDelta`. */
export interface CodexCommandExecOutputDeltaParams {
  /** Thread the delta belongs to. */
  threadId: string;
  /** Turn the delta belongs to. */
  turnId: string;
  /** Item id of the running command. */
  itemId: string;
  /** Output stream classification. */
  stream?: "stdout" | "stderr" | string;
  /** Output chunk to append. */
  chunk: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

/** Params for the top-level `error` notification. */
export interface CodexErrorParams {
  /** Human-readable error message. */
  message: string;
  /** Forward-compat passthrough. */
  [key: string]: unknown;
}

// --- Discriminated notification union ---

/** `thread/started` notification. */
export interface CodexThreadStartedNotification {
  /** Discriminator. */
  method: "thread/started";
  /** Notification payload. */
  params: CodexThreadStartedParams;
}

/** `turn/started` notification. */
export interface CodexTurnStartedNotification {
  /** Discriminator. */
  method: "turn/started";
  /** Notification payload. */
  params: CodexTurnStartedParams;
}

/** `turn/completed` notification — the per-turn terminator. */
export interface CodexTurnCompletedNotification {
  /** Discriminator. */
  method: "turn/completed";
  /** Notification payload. */
  params: CodexTurnCompletedParams;
}

/** `item/started` notification. */
export interface CodexItemStartedNotification {
  /** Discriminator. */
  method: "item/started";
  /** Notification payload. */
  params: CodexItemStartedParams;
}

/** `item/completed` notification — terminal state for any thread item. */
export interface CodexItemCompletedNotification {
  /** Discriminator. */
  method: "item/completed";
  /** Notification payload. */
  params: CodexItemCompletedParams;
}

/** `item/agentMessage/delta` — streaming assistant text. */
export interface CodexAgentMessageDeltaNotification {
  /** Discriminator. */
  method: "item/agentMessage/delta";
  /** Notification payload. */
  params: CodexAgentMessageDeltaParams;
}

/** `item/reasoning/textDelta` — streaming reasoning text. */
export interface CodexReasoningTextDeltaNotification {
  /** Discriminator. */
  method: "item/reasoning/textDelta";
  /** Notification payload. */
  params: CodexReasoningDeltaParams;
}

/** `item/reasoning/summaryTextDelta` — streaming reasoning summary. */
export interface CodexReasoningSummaryTextDeltaNotification {
  /** Discriminator. */
  method: "item/reasoning/summaryTextDelta";
  /** Notification payload. */
  params: CodexReasoningDeltaParams;
}

/** `item/commandExecution/outputDelta` — streaming shell output. */
export interface CodexCommandExecOutputDeltaNotification {
  /** Discriminator. */
  method: "item/commandExecution/outputDelta";
  /** Notification payload. */
  params: CodexCommandExecOutputDeltaParams;
}

/** Top-level `error` notification. */
export interface CodexErrorNotification {
  /** Discriminator. */
  method: "error";
  /** Notification payload. */
  params: CodexErrorParams;
}

/**
 * Sharp discriminated union over `method` for the notifications the library
 * actively narrows on. Each variant has a literal `method` discriminator,
 * so a `switch` / type-guard chain narrows `params` to its concrete shape
 * without casts.
 *
 * **No Unknown fallback in this union** — including a `method: string`
 * variant would break narrowing on every literal check (`"turn/started"`
 * is assignable to `string`, so TS would keep both the typed and the
 * fallback variants in the narrowed type). To stay forward-compatible
 * with new Codex CLI methods, the `notifications` iterator yields the
 * raw untyped {@link CodexUntypedNotification} instead, and
 * {@link isCodexNotification} acts as a type guard that promotes the raw
 * shape to a sharp variant when the method matches.
 */
export type CodexNotification =
  | CodexThreadStartedNotification
  | CodexTurnStartedNotification
  | CodexTurnCompletedNotification
  | CodexItemStartedNotification
  | CodexItemCompletedNotification
  | CodexAgentMessageDeltaNotification
  | CodexReasoningTextDeltaNotification
  | CodexReasoningSummaryTextDeltaNotification
  | CodexCommandExecOutputDeltaNotification
  | CodexErrorNotification;

/**
 * Raw runtime shape of a Codex app-server JSON-RPC notification — what the
 * client iterator actually emits over the wire. The `method` field is
 * arbitrary at runtime; consumers narrow to a {@link CodexNotification}
 * variant via {@link isCodexNotification}.
 */
export interface CodexUntypedNotification {
  /** Notification method preserved verbatim from the wire. */
  method: string;
  /** Untyped payload — consumer narrows via {@link isCodexNotification}. */
  params: Record<string, unknown>;
}

/**
 * Type guard: promote a raw {@link CodexUntypedNotification} to a sharp
 * {@link CodexNotification} variant when the method matches.
 *
 * ```ts
 * for await (const note of client.notifications) {
 *   if (isCodexNotification(note, "turn/completed")) {
 *     // note.params.turn.status is now typed.
 *     console.log(note.params.turn.id);
 *   }
 * }
 * ```
 *
 * @param note Raw notification from the transport iterator.
 * @param method Method name to match against.
 */
export function isCodexNotification<M extends CodexNotification["method"]>(
  note: CodexUntypedNotification,
  method: M,
): note is Extract<CodexNotification, { method: M }> {
  return note.method === method;
}
