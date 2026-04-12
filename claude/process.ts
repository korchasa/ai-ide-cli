/**
 * @module
 * Claude CLI process management: builds CLI arguments, spawns the claude
 * subprocess with stream-json output, processes NDJSON events in real-time,
 * and returns normalized {@link CliRunOutput}. Includes retry logic with
 * exponential backoff.
 * Entry point: {@link invokeClaudeCli}.
 */

import type { CliRunOutput, Verbosity } from "../types.ts";
import type { RuntimeInvokeResult } from "../runtime/types.ts";
import { register, unregister } from "../process-registry.ts";
import {
  FileReadTracker,
  processStreamEvent,
  type StreamProcessorState,
} from "./stream.ts";

/** Low-level options for a single claude CLI invocation (initial or resume). */
export interface ClaudeInvokeOptions {
  /** Name of Claude Code agent (without .md) passed via --agent flag. Skipped on resume. */
  agent?: string;
  /** System context passed via --append-system-prompt. Skipped on resume. */
  systemPrompt?: string;
  /** Task prompt passed to claude via -p flag. */
  taskPrompt: string;
  /** Session ID for --resume continuation (omit for initial invocation). */
  resumeSessionId?: string;
  /** Extra CLI arguments passed to claude command. */
  claudeArgs?: string[];
  /** Permission mode (maps to --permission-mode CLI flag). */
  permissionMode?: string;
  /** Claude model override. Skipped on resume (session inherits model). */
  model?: string;
  /** Max seconds before SIGTERM kills the claude process. */
  timeoutSeconds: number;
  /** Max retry attempts on CLI crash/error before giving up. */
  maxRetries: number;
  /** Base delay between retries in seconds (doubled each attempt). */
  retryDelaySeconds: number;
  /** Callback invoked with each formatted stream event line for terminal display. */
  onOutput?: (line: string) => void;
  /** Path to write real-time stream-json log file. */
  streamLogPath?: string;
  /** Verbosity level for terminal output filtering (semi-verbose suppresses tool_use). */
  verbosity?: Verbosity;
  /** Working directory for the claude subprocess. Defaults to process CWD. */
  cwd?: string;
  /** Extra environment variables merged into the subprocess env. */
  env?: Record<string, string>;
  /**
   * Callback invoked with every raw NDJSON event object before any filtering
   * or extraction. Consumer decides what to keep (init metadata, token stats,
   * etc.).
   */
  onEvent?: (event: Record<string, unknown>) => void;
}

/** Invoke claude CLI with retry logic. */
export async function invokeClaudeCli(
  opts: ClaudeInvokeOptions,
): Promise<RuntimeInvokeResult> {
  const args = buildClaudeArgs(opts);
  let lastError = "";

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      const output = await executeClaudeProcess(
        args,
        opts.timeoutSeconds,
        opts.onOutput,
        opts.streamLogPath,
        opts.verbosity,
        opts.cwd,
        opts.env,
        opts.onEvent,
      );
      if (output.is_error) {
        lastError = `Claude CLI returned error: ${output.result}`;
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
    error: `Claude CLI failed after ${opts.maxRetries} attempts: ${lastError}`,
  };
}

/** Build CLI arguments for the claude command. Exported for testing. */
export function buildClaudeArgs(opts: ClaudeInvokeOptions): string[] {
  const args: string[] = [];

  // Permission mode (first-class field, maps to --permission-mode)
  if (opts.permissionMode) {
    args.push("--permission-mode", opts.permissionMode);
  }

  // Extra CLI args go next
  if (opts.claudeArgs && opts.claudeArgs.length > 0) {
    args.push(...opts.claudeArgs);
  }

  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }

  args.push("-p", opts.taskPrompt);

  if (!opts.resumeSessionId) {
    if (opts.agent) args.push("--agent", opts.agent);
    if (opts.systemPrompt) {
      args.push("--append-system-prompt", opts.systemPrompt);
    }
  }

  if (opts.model && !opts.resumeSessionId) {
    args.push("--model", opts.model);
  }

  args.push("--output-format", "stream-json", "--verbose");

  return args;
}

/**
 * Execute the claude CLI process with stream-json output.
 * Processes NDJSON events in real-time: writes readable formatted summaries
 * to streamLogPath (full, unfiltered), forwards filtered summaries to onOutput
 * (tool_use suppressed when verbosity=semi-verbose), and extracts CliRunOutput
 * from the final "result" event.
 */
async function executeClaudeProcess(
  args: string[],
  timeoutSeconds: number,
  onOutput?: (line: string) => void,
  streamLogPath?: string,
  verbosity?: Verbosity,
  cwd?: string,
  env?: Record<string, string>,
  onEvent?: (event: Record<string, unknown>) => void,
): Promise<CliRunOutput> {
  // Unset CLAUDECODE to allow nested claude CLI invocations.
  // Claude Code checks this variable and refuses to launch inside another session.
  // Deno.Command merges env with parent, so setting empty string overrides it.
  const cmd = new Deno.Command("claude", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: { CLAUDECODE: "", ...env },
    ...(cwd ? { cwd } : {}),
  });

  const process = cmd.spawn();
  register(process);

  try {
    // Set up timeout
    const timeoutId = setTimeout(() => {
      try {
        process.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
    }, timeoutSeconds * 1000);

    // Open stream log file for real-time writing (append mode)
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

    // Process stdout as stream-json NDJSON
    const state: StreamProcessorState = {
      turnCount: 0,
      resultEvent: undefined,
      tracker: new FileReadTracker(),
      logFile,
      encoder: new TextEncoder(),
      onOutput,
      verbosity,
      onEvent,
    };
    const stdoutDecoder = new TextDecoder();
    let buffer = "";

    const stdoutReader = process.stdout.getReader();
    const stdoutDone = (async () => {
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          buffer += stdoutDecoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!;
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              // deno-lint-ignore no-explicit-any
              const event = JSON.parse(line) as Record<string, any>;
              await processStreamEvent(event, state);
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
        // Process remaining buffer
        if (buffer.trim()) {
          try {
            // deno-lint-ignore no-explicit-any
            const event = JSON.parse(buffer) as Record<string, any>;
            await processStreamEvent(event, state);
          } catch { /* skip */ }
        }
      } catch { /* stream closed */ }
    })();

    // Collect stderr for error reporting
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

    // Close log file
    if (logFile) {
      logFile.close();
    }

    const concat = (chunks: Uint8Array[]) => {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const buf = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        buf.set(c, offset);
        offset += c.length;
      }
      return buf;
    };
    const stderr = new TextDecoder().decode(concat(stderrChunks)).trim();

    if (state.resultEvent) {
      return state.resultEvent;
    }

    if (!status.success) {
      throw new Error(
        `Claude CLI exited with code ${status.code}${
          stderr ? `: ${stderr}` : ""
        }`,
      );
    }

    throw new Error(
      "Claude CLI stream-json output contained no result event",
    );
  } finally {
    unregister(process);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
