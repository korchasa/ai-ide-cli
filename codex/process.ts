/**
 * @module
 * Codex CLI process management: builds CLI arguments for `codex exec
 * --experimental-json`, spawns the subprocess with the user prompt piped on
 * stdin, processes NDJSON events in real-time, and returns normalized
 * {@link CliRunOutput}. Includes retry logic with exponential backoff.
 *
 * Mirrors the patterns used by Claude / Cursor / OpenCode adapters but
 * accommodates Codex-specific quirks:
 *
 * - Prompt travels on **stdin**, not argv.
 * - Session resume is a positional subcommand: `resume <threadId>`.
 * - There is no single terminal `result` event — the final response comes
 *   from the last `item.completed` of type `agent_message`, and token usage
 *   from `turn.completed`.
 * - Approval policy / sandbox mode are expressed as TOML config overrides
 *   (`--config key=value`) rather than dedicated flags.
 *
 * Event shape reference:
 * https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts
 *
 * Entry point: {@link invokeCodexCli}.
 */

import type { CliRunOutput, Verbosity } from "../types.ts";
import type {
  RuntimeInvokeOptions,
  RuntimeInvokeResult,
} from "../runtime/types.ts";
import { register, unregister } from "../process-registry.ts";

/**
 * Build CLI arguments for the `codex` command.
 * Exported for testing.
 *
 * Codex headless mode: `codex exec --experimental-json [flags] [resume <id>]`.
 * Prompt is written to the subprocess stdin; it is NOT appended to argv.
 *
 * - Session resume: `resume <threadId>` positional subcommand.
 * - Permissions bypass: `permissionMode === "bypassPermissions"` maps to
 *   `--sandbox danger-full-access` plus `--config approval_policy="never"`.
 */
export function buildCodexArgs(opts: RuntimeInvokeOptions): string[] {
  const args: string[] = ["exec", "--experimental-json"];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  if (opts.cwd) {
    args.push("--cd", opts.cwd);
  }

  if (opts.permissionMode === "bypassPermissions") {
    args.push("--sandbox", "danger-full-access");
    args.push("--config", `approval_policy="never"`);
  }

  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }

  if (opts.resumeSessionId) {
    args.push("resume", opts.resumeSessionId);
  }

  return args;
}

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
  // deno-lint-ignore no-explicit-any
  event: Record<string, any>,
  state: CodexRunState,
): void {
  switch (event.type) {
    case "thread.started":
      if (typeof event.thread_id === "string") state.threadId = event.thread_id;
      return;
    case "turn.completed": {
      state.turnCount += 1;
      const usage = event.usage;
      if (usage && typeof usage === "object") {
        state.inputTokens += Number(usage.input_tokens ?? 0);
        state.cachedInputTokens += Number(usage.cached_input_tokens ?? 0);
        state.outputTokens += Number(usage.output_tokens ?? 0);
      }
      return;
    }
    case "turn.failed": {
      const message = event.error?.message;
      state.errorMessage = typeof message === "string"
        ? message
        : "Codex turn failed";
      return;
    }
    case "error": {
      if (!state.errorMessage) {
        state.errorMessage = typeof event.message === "string"
          ? event.message
          : "Codex reported an error";
      }
      return;
    }
    case "item.completed": {
      const item = event.item;
      if (
        item && typeof item === "object" &&
        item.type === "agent_message" &&
        typeof item.text === "string"
      ) {
        state.finalResponse = item.text;
      }
      return;
    }
    default:
      return;
  }
}

/** Finalize a {@link CodexRunState} into a normalized {@link CliRunOutput}. */
export function extractCodexOutput(state: CodexRunState): CliRunOutput {
  return {
    runtime: "codex",
    result: state.errorMessage ?? state.finalResponse,
    session_id: state.threadId,
    total_cost_usd: 0,
    duration_ms: Math.max(0, Date.now() - state.startMs),
    duration_api_ms: 0,
    num_turns: state.turnCount,
    is_error: state.errorMessage !== undefined,
  };
}

/**
 * Format a single Codex NDJSON event as a one-line summary for terminal or
 * log output. When `verbosity === "semi-verbose"` tool-call and reasoning
 * items are suppressed so only assistant text and lifecycle events remain.
 */
export function formatCodexEventForOutput(
  // deno-lint-ignore no-explicit-any
  event: Record<string, any>,
  verbosity?: Verbosity,
): string {
  switch (event.type) {
    case "thread.started":
      return `[stream] init thread=${event.thread_id ?? "?"}`;
    case "turn.completed": {
      const usage = event.usage ?? {};
      return `[stream] turn.completed in=${usage.input_tokens ?? 0} out=${
        usage.output_tokens ?? 0
      } cached=${usage.cached_input_tokens ?? 0}`;
    }
    case "turn.failed":
      return `[stream] turn.failed: ${event.error?.message ?? "unknown"}`;
    case "error":
      return `[stream] error: ${event.message ?? "unknown"}`;
    case "item.completed": {
      const item = event.item;
      if (!item || typeof item !== "object") return "";
      switch (item.type) {
        case "agent_message": {
          const text = typeof item.text === "string" ? item.text : "";
          const preview = text.length > 120 ? text.slice(0, 120) + "…" : text;
          return `[stream] text: ${preview.replaceAll("\n", "↵")}`;
        }
        case "reasoning":
          if (verbosity === "semi-verbose") return "";
          return "[stream] reasoning";
        case "command_execution":
          if (verbosity === "semi-verbose") return "";
          return `[stream] exec: ${item.command ?? "?"} (${
            item.status ?? "?"
          })`;
        case "file_change":
          if (verbosity === "semi-verbose") return "";
          return `[stream] patch: ${
            Array.isArray(item.changes) ? item.changes.length : 0
          } file(s) ${item.status ?? "?"}`;
        case "mcp_tool_call":
          if (verbosity === "semi-verbose") return "";
          return `[stream] mcp: ${item.server ?? "?"}.${item.tool ?? "?"} (${
            item.status ?? "?"
          })`;
        case "web_search":
          if (verbosity === "semi-verbose") return "";
          return `[stream] web_search: ${item.query ?? "?"}`;
        case "todo_list":
          if (verbosity === "semi-verbose") return "";
          return `[stream] todo_list: ${
            Array.isArray(item.items) ? item.items.length : 0
          } item(s)`;
        case "error":
          return `[stream] item.error: ${item.message ?? "unknown"}`;
        default:
          return "";
      }
    }
    default:
      return "";
  }
}

/** Invoke codex CLI with retry logic. */
export async function invokeCodexCli(
  opts: RuntimeInvokeOptions,
): Promise<RuntimeInvokeResult> {
  const mergedTaskPrompt = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n${opts.taskPrompt}`
    : opts.taskPrompt;
  const args = buildCodexArgs(opts);
  let lastError = "";

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      const output = await executeCodexProcess(
        args,
        mergedTaskPrompt,
        opts.timeoutSeconds,
        opts.onOutput,
        opts.streamLogPath,
        opts.verbosity,
        opts.cwd,
        opts.env,
        opts.onEvent,
      );
      if (output.is_error) {
        lastError = `Codex CLI returned error: ${output.result}`;
        if (attempt < opts.maxRetries) {
          const delay = opts.retryDelaySeconds * Math.pow(2, attempt - 1);
          await sleep(delay * 1000);
          continue;
        }
        return { output, error: lastError };
      }
      return { output };
    } catch (err) {
      lastError = (err as Error).message;
      if (attempt < opts.maxRetries) {
        const delay = opts.retryDelaySeconds * Math.pow(2, attempt - 1);
        await sleep(delay * 1000);
        continue;
      }
    }
  }

  return {
    error: `Codex CLI failed after ${opts.maxRetries} attempts: ${lastError}`,
  };
}

/**
 * Execute the codex CLI process with --experimental-json output.
 * The prompt is written to the child's stdin and stdin is then closed.
 */
async function executeCodexProcess(
  args: string[],
  prompt: string,
  timeoutSeconds: number,
  onOutput?: (line: string) => void,
  streamLogPath?: string,
  verbosity?: Verbosity,
  cwd?: string,
  env?: Record<string, string>,
  onEvent?: (event: Record<string, unknown>) => void,
): Promise<CliRunOutput> {
  const cmd = new Deno.Command("codex", {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    ...(env ? { env } : {}),
    ...(cwd ? { cwd } : {}),
  });

  const process = cmd.spawn();
  register(process);

  try {
    const timeoutId = setTimeout(() => {
      try {
        process.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
    }, timeoutSeconds * 1000);

    // Feed the prompt on stdin and close it so codex begins processing.
    const stdinWriter = process.stdin.getWriter();
    try {
      await stdinWriter.write(new TextEncoder().encode(prompt));
    } finally {
      await stdinWriter.close().catch(() => {});
    }

    let logFile: Deno.FsFile | undefined;
    if (streamLogPath) {
      const dir = streamLogPath.replace(/\/[^/]+$/, "");
      await Deno.mkdir(dir, { recursive: true });
      logFile = await Deno.open(streamLogPath, {
        write: true,
        create: true,
        append: true,
      });
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const state = createCodexRunState();
    let buffer = "";

    const stdoutReader = process.stdout.getReader();
    const stdoutDone = (async () => {
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!;
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              // deno-lint-ignore no-explicit-any
              const event = JSON.parse(line) as Record<string, any>;
              onEvent?.(event);
              applyCodexEvent(event, state);
              const logSummary = formatCodexEventForOutput(event);
              if (logFile && logSummary) {
                await logFile.write(encoder.encode(logSummary + "\n"));
              }
              if (onOutput) {
                const termSummary = formatCodexEventForOutput(
                  event,
                  verbosity,
                );
                if (termSummary) onOutput(termSummary);
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
        if (buffer.trim()) {
          try {
            // deno-lint-ignore no-explicit-any
            const event = JSON.parse(buffer) as Record<string, any>;
            onEvent?.(event);
            applyCodexEvent(event, state);
          } catch { /* skip */ }
        }
      } catch { /* stream closed */ }
    })();

    const stderrChunks: Uint8Array[] = [];
    const stderrReader = process.stderr.getReader();
    const stderrDone = (async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          stderrChunks.push(value);
        }
      } catch { /* stream closed */ }
    })();

    await Promise.all([stdoutDone, stderrDone]);
    const status = await process.status;
    clearTimeout(timeoutId);

    logFile?.close();

    const stderr = decodeChunks(stderrChunks).trim();

    if (!status.success && !state.errorMessage) {
      throw new Error(
        `Codex CLI exited with code ${status.code}${
          stderr ? `: ${stderr}` : ""
        }`,
      );
    }

    return extractCodexOutput(state);
  } finally {
    unregister(process);
  }
}

function decodeChunks(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(buf);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
