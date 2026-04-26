/**
 * @module
 * Cursor CLI process management: builds CLI arguments, spawns the `cursor
 * agent` subprocess with stream-json output, processes NDJSON events in
 * real-time, and returns normalized {@link CliRunOutput}. Includes retry
 * logic with exponential backoff and AbortSignal cancellation.
 * Entry point: {@link invokeCursorCli}.
 */

import type { CliRunOutput, Verbosity } from "../types.ts";
import type {
  RuntimeInvokeOptions,
  RuntimeInvokeResult,
  RuntimeLifecycleHooks,
} from "../runtime/types.ts";
import { expandExtraArgs } from "../runtime/index.ts";
import { defaultRegistry, type ProcessRegistry } from "../process-registry.ts";

/**
 * Flags reserved by {@link buildCursorArgs}. Keys in `extraArgs` that
 * match these throw synchronously — the adapter emits them itself.
 */
export const CURSOR_RESERVED_FLAGS: readonly string[] = [
  "agent",
  "-p",
  "--output-format",
  "--trust",
  "--resume",
  "--model",
  "--yolo",
];

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

  args.push(...expandExtraArgs(opts.extraArgs, CURSOR_RESERVED_FLAGS));

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
  if (opts.signal?.aborted) {
    return { error: "Aborted before start" };
  }
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
        opts.env,
        opts.onEvent,
        opts.signal,
        opts.hooks,
        opts.processRegistry,
      );
      if (output.is_error) {
        lastError = `Cursor CLI returned error: ${output.result}`;
        if (attempt < opts.maxRetries) {
          const delay = opts.retryDelaySeconds * Math.pow(2, attempt - 1);
          try {
            await sleep(delay * 1000, opts.signal);
          } catch (err) {
            if (isAbortError(err)) {
              return { output, error: `Aborted: ${abortReason(opts.signal)}` };
            }
            throw err;
          }
          continue;
        }
        return { output, error: lastError };
      }
      opts.hooks?.onResult?.(output);
      return { output };
    } catch (err) {
      if (isAbortError(err)) {
        return { error: `Aborted: ${abortReason(opts.signal)}` };
      }
      lastError = (err as Error).message;
      if (attempt < opts.maxRetries) {
        const delay = opts.retryDelaySeconds * Math.pow(2, attempt - 1);
        try {
          await sleep(delay * 1000, opts.signal);
        } catch (sleepErr) {
          if (isAbortError(sleepErr)) {
            return { error: `Aborted: ${abortReason(opts.signal)}` };
          }
          throw sleepErr;
        }
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
  env?: Record<string, string>,
  onEvent?: (event: Record<string, unknown>) => void,
  userSignal?: AbortSignal,
  hooks?: RuntimeLifecycleHooks,
  processRegistry?: ProcessRegistry,
): Promise<CliRunOutput> {
  const cmd = new Deno.Command("cursor", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    ...(env ? { env } : {}),
    ...(cwd ? { cwd } : {}),
  });

  const process = cmd.spawn();
  const registry = processRegistry ?? defaultRegistry;
  registry.register(process);

  try {
    const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
    const combined = userSignal
      ? AbortSignal.any([userSignal, timeoutSignal])
      : timeoutSignal;
    const onAbort = () => {
      try {
        process.kill("SIGTERM");
      } catch {
        // Process may have already exited.
      }
    };
    combined.addEventListener("abort", onAbort, { once: true });

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
    let initEmitted = false;

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
              if (
                !initEmitted && event.type === "system" &&
                event.subtype === "init"
              ) {
                initEmitted = true;
                hooks?.onInit?.({
                  runtime: "cursor",
                  model: typeof event.model === "string"
                    ? event.model
                    : undefined,
                  sessionId: typeof event.session_id === "string"
                    ? event.session_id
                    : undefined,
                });
              }
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
            onEvent?.(event);
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
    combined.removeEventListener("abort", onAbort);

    logFile?.close();

    if (userSignal?.aborted) {
      const err = new Error(`Aborted: ${abortReason(userSignal)}`);
      (err as Error & { name: string }).name = "AbortError";
      throw err;
    }

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
    registry.unregister(process);
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timerId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timerId);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

function abortReason(signal?: AbortSignal): string {
  if (!signal) return "manual abort";
  const reason = signal.reason;
  if (reason === undefined) return "manual abort";
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}
