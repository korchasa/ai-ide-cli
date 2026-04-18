/**
 * @module
 * Claude CLI stream-json event processing: parses NDJSON events, extracts
 * {@link CliRunOutput} from result events, formats one-line summaries
 * for terminal and log output, and tracks repeated file reads.
 *
 * Upstream reference for event shapes (system init, assistant, user,
 * tool_use / tool_result, result): Anthropic's Claude Agent SDK for
 * TypeScript — https://github.com/anthropics/claude-agent-sdk-typescript
 * Use it as source of truth when porting new event kinds or fields.
 *
 * Entry points: {@link processStreamEvent}, {@link extractClaudeOutput},
 * {@link parseClaudeStreamEvent}.
 */

import type { CliRunOutput, PermissionDenial, Verbosity } from "../types.ts";

// --- Typed event shapes (discriminated union) ---

/** Assistant text block inside a Claude message. */
export interface ClaudeTextBlock {
  /** Discriminator for text blocks. */
  type: "text";
  /** The block's text payload. */
  text: string;
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/** Assistant tool_use block inside a Claude message. */
export interface ClaudeToolUseBlock {
  /** Discriminator for tool_use blocks. */
  type: "tool_use";
  /** Unique tool call id. */
  id: string;
  /** Tool name (e.g. "Read", "Bash", "Edit"). */
  name: string;
  /** Typed-but-opaque tool input map. */
  input?: Record<string, unknown>;
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/** Assistant thinking block inside a Claude message (extended thinking). */
export interface ClaudeThinkingBlock {
  /** Discriminator for thinking blocks. */
  type: "thinking";
  /** The thinking text payload. */
  thinking?: string;
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/** Union of all known assistant-message content block shapes. */
export type ClaudeAssistantBlock =
  | ClaudeTextBlock
  | ClaudeToolUseBlock
  | ClaudeThinkingBlock;

/** `system` / `init` event emitted at session start. */
export interface ClaudeSystemEvent {
  /** Discriminator. */
  type: "system";
  /** Sub-kind — "init" is the only one we currently parse. */
  subtype?: string;
  /** Active model identifier. */
  model?: string;
  /** Session ID for later resume. */
  session_id?: string;
  /** Tool names available to the run. */
  tools?: string[];
  /** MCP server metadata as reported by the CLI. */
  mcp_servers?: unknown[];
  /** Agent names discovered by the CLI. */
  agents?: string[];
  /** Skills discovered by the CLI. */
  skills?: unknown[];
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/** `assistant` event with a structured message body. */
export interface ClaudeAssistantEvent {
  /** Discriminator. */
  type: "assistant";
  /** Message body with a content array of typed blocks. */
  message?: {
    /** Typed content blocks. */
    content?: ClaudeAssistantBlock[];
    /** Allow forward-compat upstream fields without casting. */
    [key: string]: unknown;
  };
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/** `user` event carrying tool results back into the conversation. */
export interface ClaudeUserEvent {
  /** Discriminator. */
  type: "user";
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/** Terminal `result` event — emitted once per run. */
export interface ClaudeResultEvent {
  /** Discriminator. */
  type: "result";
  /** `success` or `error_*` variants. */
  subtype?: string;
  /** Final assistant-facing result text. */
  result?: string;
  /** Session ID for later resume. */
  session_id?: string;
  /** Aggregated run cost in USD. */
  total_cost_usd?: number;
  /** Wall-clock run duration. */
  duration_ms?: number;
  /** API-side duration. */
  duration_api_ms?: number;
  /** Number of assistant turns in the run. */
  num_turns?: number;
  /** Whether the CLI treated this as an error run. */
  is_error?: boolean;
  /** Permission denials collected during the run. */
  permission_denials?: PermissionDenial[];
  /** Allow forward-compat upstream fields without casting. */
  [key: string]: unknown;
}

/**
 * Fallback shape for any event type we do not explicitly model yet.
 * Keeps the parser forward-compatible without brick-ing on new CLI events.
 */
export interface ClaudeUnknownEvent {
  /** Event discriminator preserved verbatim. */
  type: string;
  /** All other fields preserved for callers that want to read them. */
  [key: string]: unknown;
}

/** Discriminated union of every Claude stream-json event we surface. */
export type ClaudeStreamEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent
  | ClaudeUnknownEvent;

/**
 * Parse a single NDJSON line into a typed {@link ClaudeStreamEvent}.
 * Returns `null` on invalid JSON, empty input, or when `type` is missing.
 * Pure function — no I/O.
 */
export function parseClaudeStreamEvent(line: string): ClaudeStreamEvent | null {
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
  return parsed as ClaudeStreamEvent;
}

/**
 * Tracks per-path file read counts within a single agent invocation.
 * Returns a warning string when a path is read more than `threshold` times.
 * Pure-logic class — unit-testable without I/O.
 */
export class FileReadTracker {
  private counts = new Map<string, number>();

  constructor(private readonly threshold = 2) {}

  /**
   * Increment read count for path.
   * Returns `[WARN] repeated file read: <path> (<N> times)` when count > threshold, else null.
   */
  track(path: string): string | null {
    const count = (this.counts.get(path) ?? 0) + 1;
    this.counts.set(path, count);
    if (count > this.threshold) {
      return `[WARN] repeated file read: ${path} (${count} times)`;
    }
    return null;
  }

  /** Clear all counts (for testing isolation). */
  reset(): void {
    this.counts.clear();
  }
}

/** Info passed to {@link OnToolUseObservedCallback} for each observed tool_use. */
export interface ClaudeToolUseInfo {
  /** Unique tool call id from the tool_use block. */
  id: string;
  /** Tool name (e.g. "Read", "Bash"). */
  name: string;
  /** Tool input map — preserved as-is from the event. */
  input?: Record<string, unknown>;
  /** Current assistant-turn index (1-based). */
  turn: number;
}

/**
 * Decision returned by an {@link OnToolUseObservedCallback}.
 *
 * - `"allow"` — run continues untouched.
 * - `"abort"` — the Claude CLI process is terminated and
 *   `CliRunOutput` is synthesized with `is_error: true` and a single
 *   `permission_denials[]` entry describing the observed tool.
 */
export type ToolUseObservedDecision = "allow" | "abort";

/**
 * Callback invoked for every observed `tool_use` block emitted by the
 * Claude CLI. Fires **post-dispatch but pre-next-turn** — by the time the
 * callback runs, the CLI has already invoked the tool, so `"abort"` stops
 * the run but cannot un-execute the tool.
 */
export type OnToolUseObservedCallback = (
  info: ClaudeToolUseInfo,
) => ToolUseObservedDecision | Promise<ToolUseObservedDecision>;

/**
 * Typed lifecycle hooks for Claude stream events. Each hook fires at most
 * once per event, *after* the raw-event escape hatch {@link
 * StreamProcessorState.onEvent} but *before* internal state mutations
 * (turn counter, file-read tracker, log writes).
 */
export interface ClaudeLifecycleHooks {
  /** Fires once at session start when the `system`/`init` event is seen. */
  onInit?: (event: ClaudeSystemEvent) => void;
  /** Fires once per assistant turn (many times per run). */
  onAssistant?: (event: ClaudeAssistantEvent) => void;
  /** Fires exactly once at run termination on the `result` event. */
  onResult?: (event: ClaudeResultEvent) => void;
}

/** Mutable state bag for processStreamEvent() — holds all stream-processing state. */
export interface StreamProcessorState {
  /** Count of assistant turns seen so far (increments on each assistant event). */
  turnCount: number;
  /** Extracted result event; populated when a "result" event is processed. */
  resultEvent: CliRunOutput | undefined;
  /** Tracks per-path file read counts to detect repeated reads. */
  tracker: FileReadTracker;
  /** Open log file handle for writing formatted summaries (undefined = no log). */
  logFile: Deno.FsFile | undefined;
  /** Text encoder shared across writes. */
  encoder: TextEncoder;
  /** Callback for forwarding verbosity-filtered event summaries to terminal. */
  onOutput?: (line: string) => void;
  /** Verbosity level controls which event types reach terminal output. */
  verbosity?: Verbosity;
  /** Raw-event callback invoked before any filtering/extraction. */
  onEvent?: (event: ClaudeStreamEvent) => void;
  /** Typed lifecycle hooks (onInit / onAssistant / onResult). */
  hooks?: ClaudeLifecycleHooks;
  /** Observed-tool-use hook; fires once per `tool_use` block inside assistant events. */
  onToolUseObserved?: OnToolUseObservedCallback;
  /**
   * Abort controller shared with the surrounding `executeClaudeProcess`
   * run. Set to trigger when {@link onToolUseObserved} returns `"abort"`.
   */
  abortController?: AbortController;
  /**
   * Populated when {@link onToolUseObserved} returned `"abort"` — carries
   * the denied tool metadata so the outer runner can synthesize a
   * terminal {@link CliRunOutput}.
   */
  denied?: { tool: string; id: string; reason: string };
  /** Session ID captured from the latest event — used during synthesized aborts. */
  lastSessionId?: string;
}

/**
 * Process a single stream-json event: update mutable state, write to log file,
 * and forward filtered summaries to terminal. Extracted from executeClaudeProcess()
 * to enable unit testing without spawning the Claude CLI.
 *
 * Dispatch order (stable contract consumed by tests and engines):
 * 1. `state.onEvent(raw)` — raw escape hatch, called first.
 * 2. Typed lifecycle hook (`hooks.onInit` / `onAssistant` / `onResult`)
 *    with the narrowed event, before any state mutation.
 * 3. `onToolUseObserved` fires for each `tool_use` block, after the typed
 *    hook but before the turn counter / log writes for that block.
 * 4. Internal state mutations (`turnCount++`, `FileReadTracker`,
 *    `resultEvent` extraction, log writes, terminal forwarding).
 */
export async function processStreamEvent(
  event: ClaudeStreamEvent,
  state: StreamProcessorState,
): Promise<void> {
  state.onEvent?.(event);

  // Capture session_id opportunistically so synthesized aborts get one.
  const sessionId = (event as { session_id?: unknown }).session_id;
  if (typeof sessionId === "string" && sessionId) {
    state.lastSessionId = sessionId;
  }

  // Typed lifecycle hooks — fire BEFORE state mutations.
  if (event.type === "system" && state.hooks?.onInit) {
    state.hooks.onInit(event as ClaudeSystemEvent);
  } else if (event.type === "assistant" && state.hooks?.onAssistant) {
    state.hooks.onAssistant(event as ClaudeAssistantEvent);
  } else if (event.type === "result" && state.hooks?.onResult) {
    state.hooks.onResult(event as ClaudeResultEvent);
  }

  if (event.type === "assistant") {
    const assistantEvent = event as ClaudeAssistantEvent;
    state.turnCount++;
    if (state.logFile) {
      await state.logFile.write(
        state.encoder.encode(
          stampLines(`--- turn ${state.turnCount} ---`) + "\n",
        ),
      );
    }
    const contents = assistantEvent.message?.content;
    if (Array.isArray(contents)) {
      for (const block of contents) {
        if (block.type === "tool_use") {
          const toolBlock = block as ClaudeToolUseBlock;
          if (toolBlock.name === "Read") {
            const filePath = toolBlock.input?.file_path;
            if (typeof filePath === "string") {
              const warn = state.tracker.track(filePath);
              if (warn && state.logFile) {
                await state.logFile.write(
                  state.encoder.encode(stampLines(warn) + "\n"),
                );
              }
            }
          }
          if (state.onToolUseObserved && !state.denied) {
            const info: ClaudeToolUseInfo = {
              id: toolBlock.id,
              name: toolBlock.name,
              input: toolBlock.input,
              turn: state.turnCount,
            };
            const decision = await state.onToolUseObserved(info);
            if (decision === "abort") {
              state.denied = {
                tool: toolBlock.name,
                id: toolBlock.id,
                reason: "callback-aborted",
              };
              try {
                state.abortController?.abort();
              } catch {
                // Controller may have already aborted.
              }
            }
          }
        }
      }
    }
  }
  if (event.type === "result") {
    state.resultEvent = extractClaudeOutput(event as ClaudeResultEvent);
  }
  const logSummary = formatEventForOutput(event);
  if (state.logFile && logSummary) {
    await state.logFile.write(
      state.encoder.encode(stampLines(logSummary) + "\n"),
    );
  }
  if (event.type === "result" && state.resultEvent && state.logFile) {
    await state.logFile.write(
      state.encoder.encode(stampLines("--- end ---") + "\n"),
    );
    await state.logFile.write(
      state.encoder.encode(stampLines(formatFooter(state.resultEvent)) + "\n"),
    );
  }
  if (state.onOutput) {
    const termSummary = formatEventForOutput(event, state.verbosity);
    if (termSummary) state.onOutput(termSummary);
  }
}

/** Extract CliRunOutput fields from a stream-json result event. */
export function extractClaudeOutput(event: ClaudeResultEvent): CliRunOutput {
  return {
    runtime: "claude",
    result: event.result ?? "",
    session_id: event.session_id ?? "",
    total_cost_usd: event.total_cost_usd ?? 0,
    duration_ms: event.duration_ms ?? 0,
    duration_api_ms: event.duration_api_ms ?? 0,
    num_turns: event.num_turns ?? 0,
    is_error: event.is_error ?? event.subtype !== "success",
    permission_denials: event.permission_denials,
  };
}

/** Shorten an absolute path by stripping common workspace prefixes. */
function shortenPath(p: string): string {
  return p.replace(/^\/workspaces\/[^/]+\//, "").replace(
    /^\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[^/]+\//,
    "",
  );
}

const MAX_CMD_LEN = 80;

/** Extract a human-readable detail string from a tool_use input. */
function formatToolDetail(
  name: string,
  input?: Record<string, unknown>,
): string {
  if (!input) return "";
  switch (name) {
    case "Read":
    case "Write":
    case "Edit": {
      const filePath = input.file_path;
      return typeof filePath === "string" ? shortenPath(filePath) : "";
    }
    case "Bash": {
      if (typeof input.description === "string") return input.description;
      if (typeof input.command === "string") {
        const cmd = input.command;
        return cmd.length > MAX_CMD_LEN
          ? `\`${cmd.slice(0, MAX_CMD_LEN)}…\``
          : `\`${cmd}\``;
      }
      return "";
    }
    case "Grep": {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      const path = typeof input.path === "string" ? input.path : "";
      return [
        pattern ? `/${pattern}/` : "",
        path ? `in ${shortenPath(path)}` : "",
      ].filter(Boolean).join(" ");
    }
    case "Glob":
      return typeof input.pattern === "string" ? input.pattern : "";
    case "Agent":
      return typeof input.description === "string" ? input.description : "";
    default:
      return "";
  }
}

/**
 * Format a stream event as a one-line summary for output.
 * When verbosity is "semi-verbose", tool_use blocks in assistant events are
 * suppressed — only text blocks are emitted. Default undefined = all blocks.
 * Log file writes call without verbosity to preserve full output.
 */
export function formatEventForOutput(
  event: ClaudeStreamEvent,
  verbosity?: Verbosity,
): string {
  switch (event.type) {
    case "system": {
      const sys = event as ClaudeSystemEvent;
      if (sys.subtype === "init") {
        return `[stream] init model=${sys.model ?? "?"}`;
      }
      return "";
    }
    case "assistant": {
      const contents = (event as ClaudeAssistantEvent).message?.content;
      if (!Array.isArray(contents)) return "";
      const parts: string[] = [];
      for (const block of contents) {
        if (block.type === "text" && typeof block.text === "string") {
          const preview = block.text.length > 120
            ? block.text.slice(0, 120) + "…"
            : block.text;
          parts.push(`[stream] text: ${preview.replaceAll("\n", "↵")}`);
        } else if (block.type === "tool_use") {
          if (verbosity === "semi-verbose") continue;
          const tool = block as ClaudeToolUseBlock;
          const detail = formatToolDetail(tool.name, tool.input);
          parts.push(
            detail
              ? `[stream] tool: ${tool.name ?? "?"} ${detail}`
              : `[stream] tool: ${tool.name ?? "?"}`,
          );
        }
      }
      return parts.join("\n");
    }
    case "result": {
      const r = event as ClaudeResultEvent;
      return `[stream] result: ${r.subtype} (${r.duration_ms ?? 0}ms, $${
        (r.total_cost_usd ?? 0).toFixed(4)
      })`;
    }
    default:
      return "";
  }
}

/**
 * Format a one-line summary footer for a completed Claude CLI run.
 * Pure function — unit-testable without CLI.
 * Format: `status=<ok|error> duration=<X>s cost=$<Y> turns=<N>`
 */
export function formatFooter(output: CliRunOutput): string {
  const status = output.is_error ? "error" : "ok";
  const duration = (output.duration_ms / 1000).toFixed(1);
  const cost = output.total_cost_usd.toFixed(4);
  return `status=${status} duration=${duration}s cost=$${cost} turns=${output.num_turns}`;
}

/** Returns current time as [HH:MM:SS] prefix string. */
export function tsPrefix(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `[${h}:${m}:${s}]`;
}

/**
 * Prepend timestamp to each non-empty line of text.
 * Empty lines pass through unchanged.
 */
export function stampLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line ? `${tsPrefix()} ${line}` : line)
    .join("\n");
}
