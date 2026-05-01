/**
 * @module
 * OpenCode `run --format json` typed event union + pure aggregators
 * (formatter, output extractor, HITL request extractor, tool-use info
 * extractor). The runner (`opencode/process.ts`) imports these helpers
 * to fold each parsed NDJSON line into a normalized {@link CliRunOutput}.
 *
 * The canonical home for `OpenCodeStreamEvent` and its variants — every
 * companion module re-exports from here. See `runtime/AGENTS.md` "Single
 * canonical home for stream-event types".
 */

import type {
  CliRunOutput,
  HumanInputOption,
  HumanInputRequest,
  Verbosity,
} from "../types.ts";
import { OPENCODE_HITL_MCP_TOOL_NAME } from "./hitl-mcp.ts";

// --- Typed event shapes (discriminated union) ---
//
// OpenCode `run --format json` emits one JSON object per line. Each object
// carries `type` as discriminator and usually a `part` payload. The shapes
// below mirror the runtime's native output and are kept intentionally
// permissive (`[key: string]: unknown`) so upstream CLI updates that add
// fields do not break consumers. Consumers that want typed narrowing of
// `RuntimeInvokeOptions.onEvent` should cast to `OpenCodeStreamEvent` and
// `switch` on `event.type`.

/** `step_start` event — emitted at the beginning of each assistant step. */
export interface OpenCodeStepStartEvent {
  /** Discriminator for `step_start` events. */
  type: "step_start";
  /** Session id stamped by the OpenCode CLI. */
  sessionID?: string;
  /** Server-side timestamp (ms since epoch). */
  timestamp?: number;
  /** Native payload (kept open to tolerate upstream field additions). */
  part?: {
    /** Native sub-discriminator (always `"step-start"` here). */
    type: "step-start";
    /** Forward-compat: pass-through of unknown upstream fields. */
    [key: string]: unknown;
  };
  /** Forward-compat: pass-through of unknown top-level fields. */
  [key: string]: unknown;
}

/** `text` event — a chunk of assistant text output. */
export interface OpenCodeTextEvent {
  /** Discriminator for `text` events. */
  type: "text";
  /** Session id stamped by the OpenCode CLI. */
  sessionID?: string;
  /** Server-side timestamp (ms since epoch). */
  timestamp?: number;
  /** Text payload emitted by the assistant. */
  part?: {
    /** Native sub-discriminator (always `"text"` here). */
    type: "text";
    /** Assistant-emitted text chunk. */
    text: string;
    /** Forward-compat: pass-through of unknown upstream fields. */
    [key: string]: unknown;
  };
  /** Forward-compat: pass-through of unknown top-level fields. */
  [key: string]: unknown;
}

/** `tool_use` event — a tool invocation by the assistant. */
export interface OpenCodeToolUseEvent {
  /** Discriminator for `tool_use` events. */
  type: "tool_use";
  /** Session id stamped by the OpenCode CLI. */
  sessionID?: string;
  /** Server-side timestamp (ms since epoch). */
  timestamp?: number;
  /** Tool invocation payload. */
  part?: {
    /** Native sub-discriminator. */
    type?: string;
    /** Tool name (e.g. `"bash"`, `"edit"`, `"hitl_request_human_input"`). */
    tool?: string;
    /** Primary tool-invocation id used by the adapter for de-duplication. */
    id?: string;
    /** Legacy alias for `id` used by older `opencode` builds. */
    callID?: string;
    /** Tool execution state; reaches `completed`/`failed` when terminal. */
    state?: {
      /**
       * Lifecycle status (`pending` → `running` → `completed` | `failed`).
       * Kept open with `string` for upstream additions.
       */
      status?: "pending" | "running" | "completed" | "failed" | string;
      /** Arguments the assistant supplied to the tool. */
      input?: Record<string, unknown>;
      /** Tool return value (shape is tool-specific). */
      output?: unknown;
      /** Forward-compat: pass-through of unknown upstream fields. */
      [key: string]: unknown;
    };
    /** Forward-compat: pass-through of unknown upstream fields. */
    [key: string]: unknown;
  };
  /** Forward-compat: pass-through of unknown top-level fields. */
  [key: string]: unknown;
}

/** `step_finish` event — emitted when a step ends, carrying cost/usage info. */
export interface OpenCodeStepFinishEvent {
  /** Discriminator for `step_finish` events. */
  type: "step_finish";
  /** Session id stamped by the OpenCode CLI. */
  sessionID?: string;
  /** Server-side timestamp (ms since epoch). */
  timestamp?: number;
  /** Finish payload carrying stop reason and cost. */
  part?: {
    /** Native sub-discriminator (always `"step-finish"` here). */
    type: "step-finish";
    /** Stop reason reported by the agent (e.g. `"stop"`, `"tool_use"`). */
    reason?: string;
    /** Cumulative USD cost for the step as reported by the CLI. */
    cost?: number;
    /** Forward-compat: pass-through of unknown upstream fields. */
    [key: string]: unknown;
  };
  /** Forward-compat: pass-through of unknown top-level fields. */
  [key: string]: unknown;
}

/** `error` event — a runtime error surfaced by the OpenCode CLI. */
export interface OpenCodeErrorEvent {
  /** Discriminator for `error` events. */
  type: "error";
  /** Session id stamped by the OpenCode CLI. */
  sessionID?: string;
  /** Server-side timestamp (ms since epoch). */
  timestamp?: number;
  /** Error payload from the CLI. */
  error?: {
    /** Error class name. */
    name?: string;
    /** Human-readable error message. */
    message?: string;
    /** Structured error details as attached by the CLI. */
    data?: {
      /** Preferred human message surfaced by the CLI. */
      message?: string;
      /** Forward-compat: pass-through of unknown data fields. */
      [key: string]: unknown;
    };
    /** Forward-compat: pass-through of unknown error fields. */
    [key: string]: unknown;
  };
  /** Forward-compat: pass-through of unknown top-level fields. */
  [key: string]: unknown;
}

/** Union of all parsed OpenCode stream events consumed by this adapter. */
export type OpenCodeStreamEvent =
  | OpenCodeStepStartEvent
  | OpenCodeTextEvent
  | OpenCodeToolUseEvent
  | OpenCodeStepFinishEvent
  | OpenCodeErrorEvent;

/** Format a single OpenCode event as a one-line summary for output. */
export function formatOpenCodeEventForOutput(
  // deno-lint-ignore no-explicit-any
  event: Record<string, any>,
  _verbosity?: Verbosity,
): string {
  switch (event.type) {
    case "step_start":
      return "[stream] step_start";
    case "text": {
      const text = event.part?.text ?? "";
      if (!text) return "";
      const preview = text.length > 120 ? text.slice(0, 120) + "…" : text;
      return `[stream] text: ${preview.replaceAll("\n", "↵")}`;
    }
    case "tool_use": {
      const hitlRequest = extractHitlRequestFromEvent(event);
      if (hitlRequest) {
        return `[stream] hitl_request: ${hitlRequest.question}`;
      }
      const tool = event.part?.tool ?? "unknown";
      return `[stream] tool: ${tool}`;
    }
    case "step_finish":
      return `[stream] result: stop ($${(event.part?.cost ?? 0).toFixed(4)})`;
    case "error":
      return `[stream] error: ${
        event.error?.data?.message ?? event.error?.name ?? "Unknown error"
      }`;
    default:
      return "";
  }
}

/** Extract normalized output from OpenCode JSON event lines. Exported for testing. */
export function extractOpenCodeOutput(lines: string[]): CliRunOutput {
  // deno-lint-ignore no-explicit-any
  const events = lines.map((line) => JSON.parse(line) as Record<string, any>);
  const textParts: string[] = [];
  let sessionId = "";
  let startTs = 0;
  let endTs = 0;
  let steps = 0;
  let cost = 0;
  let isError = false;
  let errorMessage = "";
  let hitlRequest: HumanInputRequest | undefined;

  for (const event of events) {
    sessionId = event.sessionID ?? sessionId;
    const ts = Number(event.timestamp ?? 0);
    if (ts > 0) {
      if (startTs === 0) startTs = ts;
      endTs = ts;
    }

    switch (event.type) {
      case "step_start":
        steps++;
        break;
      case "text":
        if (event.part?.text) {
          textParts.push(String(event.part.text));
        }
        break;
      case "tool_use":
        hitlRequest = hitlRequest ?? extractHitlRequestFromEvent(event);
        break;
      case "step_finish":
        cost = Number(event.part?.cost ?? cost ?? 0);
        break;
      case "error":
        isError = true;
        errorMessage = event.error?.data?.message ?? event.error?.message ??
          event.error?.name ?? "OpenCode runtime error";
        break;
    }
  }

  return {
    runtime: "opencode",
    result: isError ? errorMessage : textParts.join("\n"),
    session_id: sessionId,
    total_cost_usd: cost,
    duration_ms: startTs > 0 && endTs >= startTs ? endTs - startTs : 0,
    num_turns: steps,
    is_error: isError,
    usage: { cost_usd: cost },
    hitl_request: hitlRequest,
  };
}

/**
 * Extract a tool-use info payload from a parsed OpenCode `tool_use` event
 * suitable for dispatch through `OnRuntimeToolUseObservedCallback`.
 * Returns `undefined` for HITL interception events (they have their own
 * flow) or for events lacking the required `tool` / `id` fields.
 *
 * The callback is expected to fire once per tool invocation when the tool
 * reaches terminal state (`status === "completed"` or `"failed"`).
 *
 * Exported for testing.
 */
export function openCodeToolUseInfo(
  event: OpenCodeToolUseEvent,
): { id: string; name: string; input?: Record<string, unknown> } | undefined {
  const part = event.part;
  if (!part) return undefined;
  const tool = typeof part.tool === "string" ? part.tool : "";
  if (!tool) return undefined;
  if (tool === OPENCODE_HITL_MCP_TOOL_NAME) return undefined;
  const id = typeof part.id === "string" && part.id
    ? part.id
    : typeof part.callID === "string" && part.callID
    ? part.callID
    : "";
  if (!id) return undefined;
  const input = part.state?.input && typeof part.state.input === "object"
    ? part.state.input as Record<string, unknown>
    : undefined;
  return { id, name: tool, input };
}

/**
 * Extract a runtime-neutral HITL request from a parsed OpenCode event
 * targeting the `hitl_request_human_input` MCP tool. Returns `undefined`
 * for non-HITL events or those with an empty / non-string `question`.
 *
 * Exported for testing.
 */
export function extractHitlRequestFromEvent(
  // deno-lint-ignore no-explicit-any
  event: Record<string, any>,
): HumanInputRequest | undefined {
  if (event.type !== "tool_use") return undefined;
  if (event.part?.tool !== OPENCODE_HITL_MCP_TOOL_NAME) return undefined;
  if (event.part?.state?.status !== "completed") return undefined;

  const input = event.part?.state?.input;
  if (!input || typeof input.question !== "string" || !input.question.trim()) {
    return undefined;
  }

  const options = Array.isArray(input.options)
    ? input.options
      .filter((entry: unknown) => typeof entry === "object" && entry !== null)
      .map((entry: unknown) => normalizeHumanInputOption(entry))
      .filter(
        (entry: HumanInputOption | undefined): entry is HumanInputOption =>
          entry !== undefined,
      )
    : undefined;

  return {
    question: String(input.question).trim(),
    header: typeof input.header === "string" ? input.header : undefined,
    options: options && options.length > 0 ? options : undefined,
    multiSelect: typeof input.multiSelect === "boolean"
      ? input.multiSelect
      : undefined,
  };
}

function normalizeHumanInputOption(
  entry: unknown,
): HumanInputOption | undefined {
  const record = entry as Record<string, unknown>;
  if (typeof record.label !== "string" || !record.label) {
    return undefined;
  }
  return {
    label: record.label,
    description: typeof record.description === "string"
      ? record.description
      : undefined,
  };
}
