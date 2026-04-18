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
 * Entry points: {@link processStreamEvent}, {@link extractClaudeOutput}.
 */

import type { CliRunOutput, Verbosity } from "../types.ts";

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
  onEvent?: (event: Record<string, unknown>) => void;
}

/**
 * Process a single stream-json event: update mutable state, write to log file,
 * and forward filtered summaries to terminal. Extracted from executeClaudeProcess()
 * to enable unit testing without spawning the Claude CLI.
 */
export async function processStreamEvent(
  // deno-lint-ignore no-explicit-any
  event: Record<string, any>,
  state: StreamProcessorState,
): Promise<void> {
  state.onEvent?.(event);
  if (event.type === "assistant") {
    state.turnCount++;
    if (state.logFile) {
      await state.logFile.write(
        state.encoder.encode(
          stampLines(`--- turn ${state.turnCount} ---`) + "\n",
        ),
      );
    }
    const contents = event.message?.content;
    if (Array.isArray(contents)) {
      for (const block of contents) {
        if (block.type === "tool_use" && block.name === "Read") {
          const warn = state.tracker.track(block.input?.file_path);
          if (warn && state.logFile) {
            await state.logFile.write(
              state.encoder.encode(stampLines(warn) + "\n"),
            );
          }
        }
      }
    }
  }
  if (event.type === "result") {
    state.resultEvent = extractClaudeOutput(event);
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
export function extractClaudeOutput(
  // deno-lint-ignore no-explicit-any
  event: Record<string, any>,
): CliRunOutput {
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
// deno-lint-ignore no-explicit-any
function formatToolDetail(name: string, input?: Record<string, any>): string {
  if (!input) return "";
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return input.file_path ? shortenPath(input.file_path) : "";
    case "Bash":
      if (input.description) return input.description;
      if (input.command) {
        const cmd = input.command as string;
        return cmd.length > MAX_CMD_LEN
          ? `\`${cmd.slice(0, MAX_CMD_LEN)}…\``
          : `\`${cmd}\``;
      }
      return "";
    case "Grep":
      return [
        input.pattern ? `/${input.pattern}/` : "",
        input.path ? `in ${shortenPath(input.path)}` : "",
      ].filter(Boolean).join(" ");
    case "Glob":
      return input.pattern ?? "";
    case "Agent":
      return input.description ?? "";
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
  // deno-lint-ignore no-explicit-any
  event: Record<string, any>,
  verbosity?: Verbosity,
): string {
  switch (event.type) {
    case "system":
      if (event.subtype === "init") {
        return `[stream] init model=${event.model ?? "?"}`;
      }
      return "";
    case "assistant": {
      const contents = event.message?.content;
      if (!Array.isArray(contents)) return "";
      const parts: string[] = [];
      for (const block of contents) {
        if (block.type === "text" && block.text) {
          const preview = block.text.length > 120
            ? block.text.slice(0, 120) + "…"
            : block.text;
          parts.push(`[stream] text: ${preview.replaceAll("\n", "↵")}`);
        } else if (block.type === "tool_use") {
          if (verbosity === "semi-verbose") continue;
          const detail = formatToolDetail(block.name, block.input);
          parts.push(
            detail
              ? `[stream] tool: ${block.name ?? "?"} ${detail}`
              : `[stream] tool: ${block.name ?? "?"}`,
          );
        }
      }
      return parts.join("\n");
    }
    case "result":
      return `[stream] result: ${event.subtype} (${
        event.duration_ms ?? 0
      }ms, $${(event.total_cost_usd ?? 0).toFixed(4)})`;
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
