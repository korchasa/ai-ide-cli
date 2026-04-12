/**
 * @module
 * Cursor CLI process management: builds CLI arguments, spawns the `cursor
 * agent` subprocess with stream-json output, processes NDJSON events in
 * real-time, and returns normalized {@link CliRunOutput}. Includes retry
 * logic with exponential backoff.
 * Entry point: {@link invokeCursorCli}.
 */

import type { CliRunOutput, Verbosity } from "../types.ts";
import type {
  RuntimeInvokeOptions,
  RuntimeInvokeResult,
} from "../runtime/types.ts";
import { register, unregister } from "../process-registry.ts";

/**
 * Build CLI arguments for the `cursor agent` command.
 * Exported for testing.
 *
 * Cursor agent headless mode: `cursor agent -p [flags] <prompt>`.
 * Stream output: `--output-format stream-json`.
 * Session resume: `--resume <chatId>`.
 * Permissions bypass: `--yolo` (equivalent to Claude's bypassPermissions).
 */
export function buildCursorArgs(opts: RuntimeInvokeOptions): string[] {
  const args: string[] = ["agent", "-p"];

  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }

  if (opts.model && !opts.resumeSessionId) {
    args.push("--model", opts.model);
  }

  if (opts.permissionMode === "bypassPermissions") {
    args.push("--yolo");
  }

  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }

  args.push("--output-format", "stream-json");
  args.push("--trust");

  args.push(opts.taskPrompt);

  return args;
}

/**
 * Extract {@link CliRunOutput} fields from a Cursor stream-json result event.
 * Cursor uses the same stream-json format as Claude Code.
 */
export function extractCursorOutput(
  // deno-lint-ignore no-explicit-any
  event: Record<string, any>,
): CliRunOutput {
  return {
    runtime: "cursor",
    result: event.result ?? "",
    session_id: event.session_id ?? "",
    total_cost_usd: event.total_cost_usd ?? 0,
    duration_ms: event.duration_ms ?? 0,
    duration_api_ms: event.duration_api_ms ?? 0,
    num_turns: event.num_turns ?? 0,
    is_error: event.is_error ?? event.subtype !== "success",
  };
}

/**
 * Format a single Cursor stream-json event as a one-line summary for output.
 * When verbosity is "semi-verbose", tool_use blocks in assistant events are
 * suppressed. Cursor stream-json uses the same event shape as Claude Code.
 */
export function formatCursorEventForOutput(
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
          parts.push(`[stream] tool: ${block.name ?? "?"}`);
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

/** Invoke cursor CLI with retry logic. */
export async function invokeCursorCli(
  opts: RuntimeInvokeOptions,
): Promise<RuntimeInvokeResult> {
  const mergedTaskPrompt = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n${opts.taskPrompt}`
    : opts.taskPrompt;
  const args = buildCursorArgs({ ...opts, taskPrompt: mergedTaskPrompt });
  let lastError = "";

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      const output = await executeCursorProcess(
        args,
        opts.timeoutSeconds,
        opts.onOutput,
        opts.streamLogPath,
        opts.verbosity,
        opts.cwd,
      );
      if (output.is_error) {
        lastError = `Cursor CLI returned error: ${output.result}`;
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
    error: `Cursor CLI failed after ${opts.maxRetries} attempts: ${lastError}`,
  };
}

/**
 * Execute the cursor CLI process with stream-json output.
 * Processes NDJSON events in real-time: writes to streamLogPath, forwards
 * filtered summaries to onOutput, and extracts CliRunOutput from the final
 * "result" event.
 */
async function executeCursorProcess(
  args: string[],
  timeoutSeconds: number,
  onOutput?: (line: string) => void,
  streamLogPath?: string,
  verbosity?: Verbosity,
  cwd?: string,
): Promise<CliRunOutput> {
  const cmd = new Deno.Command("cursor", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
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
    let resultEvent: CliRunOutput | undefined;
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
              if (event.type === "result") {
                resultEvent = extractCursorOutput(event);
              }
              const logSummary = formatCursorEventForOutput(event);
              if (logFile && logSummary) {
                await logFile.write(encoder.encode(logSummary + "\n"));
              }
              if (onOutput) {
                const termSummary = formatCursorEventForOutput(
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
            if (event.type === "result") {
              resultEvent = extractCursorOutput(event);
            }
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

    if (resultEvent) {
      return resultEvent;
    }

    if (!status.success) {
      throw new Error(
        `Cursor CLI exited with code ${status.code}${
          stderr ? `: ${stderr}` : ""
        }`,
      );
    }

    throw new Error(
      "Cursor CLI stream-json output contained no result event",
    );
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
