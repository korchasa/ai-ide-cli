/**
 * @module
 * Codex `codex exec --experimental-json` run-state aggregator.
 *
 * Pure functions that fold the parsed NDJSON event stream into a
 * `CodexRunState`, then project it onto a runtime-neutral `CliRunOutput`.
 * The runner (`codex/process.ts`) drives the I/O; this module is
 * subprocess-free.
 *
 * Parallel-protocol warning (same as the runner): all types here describe
 * the **snake_case** `codex exec --experimental-json` protocol. The
 * camelCase `codex app-server` JSON-RPC v2 transport used by
 * `codex/session.ts` has its own helpers — do NOT cross-reference.
 */

import type { CliRunOutput, CliRunUsage, Verbosity } from "../types.ts";
import type {
  CodexExecAgentMessageItem,
  CodexExecCommandExecutionItem,
  CodexExecErrorEvent,
  CodexExecErrorItem,
  CodexExecEvent,
  CodexExecFileChangeItem,
  CodexExecItem,
  CodexExecItemCompletedEvent,
  CodexExecMcpToolCallItem,
  CodexExecReasoningItem,
  CodexExecThreadStartedEvent,
  CodexExecTodoListItem,
  CodexExecTurnCompletedEvent,
  CodexExecTurnFailedEvent,
  CodexExecWebSearchItem,
} from "./exec-events.ts";
import { parseExecItem } from "./items.ts";

/** Accumulator of Codex NDJSON events collected during a single run. */
export interface CodexRunState {
  /** Thread ID captured from the first `thread.started` event. */
  threadId: string;
  /** Text from the most recent `agent_message` item. */
  finalResponse: string;
  /** Cumulative `input_tokens` summed across all `turn.completed` events. */
  inputTokens: number;
  /** Cumulative `cached_input_tokens` summed across all turns. */
  cachedInputTokens: number;
  /** Cumulative `output_tokens` summed across all turns. */
  outputTokens: number;
  /** Number of `turn.completed` events observed during the run. */
  turnCount: number;
  /** Error message captured from `turn.failed` or top-level `error` events. */
  errorMessage?: string;
  /** Wall-clock start time in milliseconds since epoch, for duration reporting. */
  startMs: number;
  /**
   * Set when the consumer's `onToolUseObserved` callback returned
   * `"abort"` for a tool item. The runner SIGTERMs the subprocess and
   * synthesizes a `permission_denials[]` entry from this data.
   */
  denied?: { tool: string; id: string; reason: string };
}

/** Create a fresh {@link CodexRunState} seeded with the current time. */
export function createCodexRunState(): CodexRunState {
  return {
    threadId: "",
    finalResponse: "",
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    turnCount: 0,
    startMs: Date.now(),
  };
}

/**
 * Apply a single parsed Codex NDJSON event to the accumulator.
 * Exported for testing.
 */
export function applyCodexEvent(
  event: CodexExecEvent,
  state: CodexRunState,
): void {
  switch (event.type) {
    case "thread.started": {
      const e = event as CodexExecThreadStartedEvent;
      if (typeof e.thread_id === "string") state.threadId = e.thread_id;
      return;
    }
    case "turn.completed": {
      const e = event as CodexExecTurnCompletedEvent;
      state.turnCount += 1;
      const usage = e.usage;
      if (usage) {
        state.inputTokens += Number(usage.input_tokens ?? 0);
        state.cachedInputTokens += Number(usage.cached_input_tokens ?? 0);
        state.outputTokens += Number(usage.output_tokens ?? 0);
      }
      return;
    }
    case "turn.failed": {
      const e = event as CodexExecTurnFailedEvent;
      const message = e.error?.message;
      state.errorMessage = typeof message === "string"
        ? message
        : "Codex turn failed";
      return;
    }
    case "error": {
      if (!state.errorMessage) {
        const e = event as CodexExecErrorEvent;
        state.errorMessage = typeof e.message === "string"
          ? e.message
          : "Codex reported an error";
      }
      return;
    }
    case "item.completed": {
      const item = (event as CodexExecItemCompletedEvent).item;
      if (!item || typeof item !== "object") return;
      if (item.type === "agent_message") {
        const m = item as CodexExecAgentMessageItem;
        if (typeof m.text === "string") state.finalResponse = m.text;
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Finalize a {@link CodexRunState} into a normalized {@link CliRunOutput}.
 * Codex emits no cost field; `total_cost_usd` and `duration_api_ms` stay
 * `undefined` so cost-aggregating consumers can distinguish "not reported"
 * from a real free run. Token counts surface via {@link CliRunUsage}.
 */
export function extractCodexOutput(state: CodexRunState): CliRunOutput {
  return {
    runtime: "codex",
    result: state.errorMessage ?? state.finalResponse,
    session_id: state.threadId,
    duration_ms: Math.max(0, Date.now() - state.startMs),
    num_turns: state.turnCount,
    is_error: state.errorMessage !== undefined,
    usage: extractCodexUsage(state),
  };
}

/**
 * Project accumulated Codex token counts onto {@link CliRunUsage}.
 * Returns `undefined` when no turn ever reported usage (e.g. denial
 * before first `turn.completed`).
 */
export function extractCodexUsage(
  state: CodexRunState,
): CliRunUsage | undefined {
  if (
    state.inputTokens === 0 && state.outputTokens === 0 &&
    state.cachedInputTokens === 0
  ) {
    return undefined;
  }
  return {
    input_tokens: state.inputTokens,
    output_tokens: state.outputTokens,
    cached_tokens: state.cachedInputTokens,
  };
}

/**
 * Build a runtime-neutral `RuntimeToolUseInfo` (sans `turn` and `runtime`
 * fields, which the caller injects) from a Codex `ThreadItem`. Returns
 * `undefined` for non-tool items (`agent_message`, `reasoning`, `error`,
 * `todo_list` — the latter is a planning artefact, not a tool invocation).
 *
 * Thin wrapper over {@link parseExecItem} — the conceptual lift lives
 * there alongside the app-server twin `parseAppServerItem`.
 *
 * Exported for testing.
 */
export function codexItemToToolUseInfo(
  item: CodexExecItem | undefined | null,
): { id: string; name: string; input: Record<string, unknown> } | undefined {
  const conc = parseExecItem(item);
  if (!conc) return undefined;
  return { id: conc.id, name: conc.name, input: conc.input };
}

/**
 * Format a single Codex NDJSON event as a one-line summary for terminal or
 * log output. When `verbosity === "semi-verbose"` tool-call and reasoning
 * items are suppressed so only assistant text and lifecycle events remain.
 */
export function formatCodexEventForOutput(
  event: CodexExecEvent,
  verbosity?: Verbosity,
): string {
  switch (event.type) {
    case "thread.started":
      return `[stream] init thread=${
        (event as CodexExecThreadStartedEvent).thread_id ?? "?"
      }`;
    case "turn.completed": {
      const usage = (event as CodexExecTurnCompletedEvent).usage ?? {};
      return `[stream] turn.completed in=${usage.input_tokens ?? 0} out=${
        usage.output_tokens ?? 0
      } cached=${usage.cached_input_tokens ?? 0}`;
    }
    case "turn.failed":
      return `[stream] turn.failed: ${
        (event as CodexExecTurnFailedEvent).error?.message ?? "unknown"
      }`;
    case "error":
      return `[stream] error: ${
        (event as CodexExecErrorEvent).message ?? "unknown"
      }`;
    case "item.completed": {
      const item = (event as CodexExecItemCompletedEvent).item;
      if (!item || typeof item !== "object") return "";
      switch (item.type) {
        case "agent_message": {
          const text = (item as CodexExecAgentMessageItem).text ?? "";
          const preview = text.length > 120 ? text.slice(0, 120) + "…" : text;
          return `[stream] text: ${preview.replaceAll("\n", "↵")}`;
        }
        case "reasoning":
          if (verbosity === "semi-verbose") return "";
          // Reasoning text is forward-compat-only; the summary line stays terse.
          void (item as CodexExecReasoningItem);
          return "[stream] reasoning";
        case "command_execution": {
          if (verbosity === "semi-verbose") return "";
          const c = item as CodexExecCommandExecutionItem;
          return `[stream] exec: ${c.command ?? "?"} (${c.status ?? "?"})`;
        }
        case "file_change": {
          if (verbosity === "semi-verbose") return "";
          const f = item as CodexExecFileChangeItem;
          return `[stream] patch: ${
            Array.isArray(f.changes) ? f.changes.length : 0
          } file(s) ${f.status ?? "?"}`;
        }
        case "mcp_tool_call": {
          if (verbosity === "semi-verbose") return "";
          const m = item as CodexExecMcpToolCallItem;
          return `[stream] mcp: ${m.server ?? "?"}.${m.tool ?? "?"} (${
            m.status ?? "?"
          })`;
        }
        case "web_search": {
          if (verbosity === "semi-verbose") return "";
          const w = item as CodexExecWebSearchItem;
          return `[stream] web_search: ${w.query ?? "?"}`;
        }
        case "todo_list": {
          if (verbosity === "semi-verbose") return "";
          const t = item as CodexExecTodoListItem;
          return `[stream] todo_list: ${
            Array.isArray(t.items) ? t.items.length : 0
          } item(s)`;
        }
        case "error": {
          const e = item as CodexExecErrorItem;
          return `[stream] item.error: ${e.message ?? "unknown"}`;
        }
        default:
          return "";
      }
    }
    default:
      return "";
  }
}
