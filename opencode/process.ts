/**
 * @module
 * OpenCode runtime adapter runner: spawns the opencode process, parses the
 * JSON event stream, extracts normalized output. Also wires the
 * runtime-neutral `OnRuntimeToolUseObservedCallback` (FR-L16) and surfaces
 * the persisted transcript via `opencode export <sessionId>`.
 *
 * Module split:
 *
 * - `opencode/argv.ts` — argv builder, reserved flag set.
 * - `opencode/events.ts` — typed `OpenCodeStreamEvent` union, formatter,
 *   `extractOpenCodeOutput`, `openCodeToolUseInfo`.
 * - `opencode/transcript.ts` — `exportOpenCodeTranscript`,
 *   `OpenCodeTranscriptResult`.
 * - `opencode/process.ts` (this file) — runner + re-exports of every
 *   previously exported helper so `from "./opencode/process.ts"` keeps
 *   working in production code, tests, and `mod.ts`.
 *
 * Entry point: {@link invokeOpenCodeCli}.
 */

import type { CliRunOutput, Verbosity } from "../types.ts";
import type { ProcessRegistry } from "../process-registry.ts";
import type {
  OnRuntimeToolUseObservedCallback,
  RuntimeInvokeOptions,
  RuntimeInvokeResult,
  RuntimeLifecycleHooks,
  RuntimeToolUseDecision,
} from "../runtime/types.ts";
import {
  type OnCallbackError,
  safeAwaitCallback,
} from "../runtime/callback-safety.ts";
import { withSyncedPWD } from "../runtime/env-cwd-sync.ts";
import {
  buildOpenCodeConfigContent,
  validateMcpServers,
} from "../runtime/mcp-injection.ts";
import { buildOpenCodeArgs } from "./argv.ts";
import {
  extractOpenCodeOutput,
  formatOpenCodeEventForOutput,
  type OpenCodeToolUseEvent,
  openCodeToolUseInfo,
} from "./events.ts";
import { exportOpenCodeTranscript } from "./transcript.ts";

// Re-exports preserve the historical entry-point shape so existing
// 'from "./opencode/process.ts"' imports (production + tests + mod.ts)
// keep working after the split.
export {
  buildOpenCodeArgs,
  OPENCODE_INTENTIONALLY_OPEN_FLAGS,
  OPENCODE_RESERVED_FLAGS,
  OPENCODE_RESERVED_POSITIONALS,
} from "./argv.ts";
export {
  extractOpenCodeOutput,
  formatOpenCodeEventForOutput,
  openCodeToolUseInfo,
} from "./events.ts";
export type {
  OpenCodeErrorEvent,
  OpenCodeStepFinishEvent,
  OpenCodeStepStartEvent,
  OpenCodeStreamEvent,
  OpenCodeTextEvent,
  OpenCodeToolUseEvent,
} from "./events.ts";
export { exportOpenCodeTranscript } from "./transcript.ts";
export type { OpenCodeTranscriptResult } from "./transcript.ts";

/** Invoke opencode CLI with retry logic. */
export async function invokeOpenCodeCli(
  opts: RuntimeInvokeOptions,
): Promise<RuntimeInvokeResult> {
  if (opts.signal?.aborted) {
    return { error: "Aborted before start" };
  }
  const mergedTaskPrompt = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n${opts.taskPrompt}`
    : opts.taskPrompt;
  const args = buildOpenCodeArgs({
    ...opts,
    taskPrompt: mergedTaskPrompt,
  });
  // FR-L35: validate the typed mcpServers field synchronously and merge
  // the rendered config into env.OPENCODE_CONFIG_CONTENT. Replacement,
  // not merge — overrides any caller-supplied empty-string sentinel,
  // throws on a non-empty pre-existing value (collision).
  validateMcpServers("opencode", {
    mcpServers: opts.mcpServers,
    env: opts.env,
  });
  const env = opts.mcpServers
    ? {
      ...(opts.env ?? {}),
      OPENCODE_CONFIG_CONTENT: buildOpenCodeConfigContent(opts.mcpServers),
    }
    : opts.env;
  let lastError = "";

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      const output = await executeOpenCodeProcess(
        args,
        opts.timeoutSeconds,
        opts.processRegistry,
        opts.onOutput,
        opts.streamLogPath,
        opts.verbosity,
        opts.cwd,
        env,
        opts.onEvent,
        opts.signal,
        opts.hooks,
        opts.onToolUseObserved,
        opts.onCallbackError,
      );
      if (output.is_error) {
        lastError = `OpenCode returned error: ${output.result}`;
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
    error: `OpenCode failed after ${opts.maxRetries} attempts: ${lastError}`,
  };
}

async function executeOpenCodeProcess(
  args: string[],
  timeoutSeconds: number,
  processRegistry: ProcessRegistry,
  onOutput?: (line: string) => void,
  streamLogPath?: string,
  verbosity?: Verbosity,
  cwd?: string,
  env?: Record<string, string>,
  onEvent?: (event: Record<string, unknown>) => void,
  userSignal?: AbortSignal,
  hooks?: RuntimeLifecycleHooks,
  onToolUseObserved?: OnRuntimeToolUseObservedCallback,
  onCallbackError?: OnCallbackError,
): Promise<CliRunOutput> {
  const processEnv: Record<string, string> = { ...env };
  // FR-L33: sync env.PWD with cwd at the spawn boundary.
  const syncedEnv = withSyncedPWD(processEnv, cwd) ?? processEnv;
  const cmd = new Deno.Command("opencode", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    ...(Object.keys(syncedEnv).length > 0 ? { env: syncedEnv } : {}),
    ...(cwd ? { cwd } : {}),
  });

  const process = cmd.spawn();
  const registry = processRegistry;
  registry.register(process);

  let timedOut = false;
  let initEmitted = false;
  let denialAbort = false;
  let denial:
    | { toolName: string; toolId: string; reason: string }
    | undefined;
  const seenObservedIds = new Set<string>();
  let stepCount = 0;
  let lastSessionId = "";

  try {
    const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
    const combined = userSignal
      ? AbortSignal.any([userSignal, timeoutSignal])
      : timeoutSignal;
    const onAbort = () => {
      if (timeoutSignal.aborted) timedOut = true;
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
    let stdoutBuffer = "";
    const stdoutLines: string[] = [];
    const stderrChunks: Uint8Array[] = [];

    const killForDenial = () => {
      denialAbort = true;
      try {
        process.kill("SIGTERM");
      } catch {
        // Process may already be gone.
      }
    };

    // deno-lint-ignore no-explicit-any
    const handleEvent = async (event: Record<string, any>): Promise<void> => {
      onEvent?.(event);
      const sessionId = typeof event.sessionID === "string"
        ? event.sessionID
        : "";
      if (sessionId) {
        lastSessionId = sessionId;
        if (!initEmitted) {
          initEmitted = true;
          hooks?.onInit?.({
            runtime: "opencode",
            sessionId: sessionId || undefined,
          });
        }
      }
      if (event.type === "step_start") stepCount += 1;

      // FR-L16: observed-tool-use hook — fires once per tool id, on
      // tool_use events whose state reached a terminal status.
      if (onToolUseObserved && event.type === "tool_use") {
        const terminal = event.part?.state?.status === "completed" ||
          event.part?.state?.status === "failed";
        if (terminal) {
          const info = openCodeToolUseInfo(event as OpenCodeToolUseEvent);
          if (info && !seenObservedIds.has(info.id)) {
            seenObservedIds.add(info.id);
            // FR-L32: callback throws no longer auto-abort. They route
            // via onCallbackError and the decision defaults to "allow"
            // so a consumer typo cannot silently kill a run.
            const observedDecision = await safeAwaitCallback(
              onToolUseObserved,
              [
                {
                  runtime: "opencode" as const,
                  id: info.id,
                  name: info.name,
                  input: info.input,
                  turn: Math.max(1, stepCount),
                },
              ],
              "onToolUseObserved",
              onCallbackError,
            );
            const decision: RuntimeToolUseDecision = observedDecision ??
              "allow";
            if (decision === "abort") {
              denial = {
                toolName: info.name,
                toolId: info.id,
                reason: "Aborted by onToolUseObserved callback",
              };
              killForDenial();
            }
          }
        }
      }

      const summary = formatOpenCodeEventForOutput(event, verbosity);
      if (summary) onOutput?.(summary);
    };

    const stdoutReader = process.stdout.getReader();
    const stdoutDone = (async () => {
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          stdoutBuffer += decoder.decode(value, { stream: true });
          while (true) {
            const newlineIndex = stdoutBuffer.indexOf("\n");
            if (newlineIndex === -1) break;
            const line = stdoutBuffer.slice(0, newlineIndex);
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            await processOpenCodeLine(
              line,
              stdoutLines,
              encoder,
              logFile,
              handleEvent,
            );
          }
        }
        const trailing = stdoutBuffer.trim();
        if (trailing) {
          await processOpenCodeLine(
            trailing,
            stdoutLines,
            encoder,
            logFile,
            handleEvent,
          );
        }
      } catch {
        // Stream closed.
      }
    })();

    const stderrReader = process.stderr.getReader();
    const stderrDone = (async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          stderrChunks.push(value);
        }
      } catch {
        // Stream closed.
      }
    })();

    await Promise.all([stdoutDone, stderrDone]);
    const status = await process.status;
    combined.removeEventListener("abort", onAbort);

    logFile?.close();

    // Tool-use denial takes precedence: synthesize a permission-denial
    // output regardless of subprocess status (SIGTERM path may look like
    // any exit code depending on OS).
    if (denial) {
      // FR-L32: surface transcript export failure instead of swallowing.
      const denialTranscript = await exportOpenCodeTranscript(lastSessionId, {
        cwd,
        env,
      });
      return {
        runtime: "opencode",
        result: denial.reason,
        session_id: lastSessionId,
        duration_ms: 0,
        num_turns: stepCount,
        is_error: true,
        permission_denials: [
          {
            tool_name: denial.toolName,
            tool_input: { id: denial.toolId, reason: denial.reason },
          },
        ],
        transcript_path: denialTranscript.path,
        transcript_error: denialTranscript.error,
      };
    }

    if (userSignal?.aborted) {
      const err = new Error(`Aborted: ${abortReason(userSignal)}`);
      (err as Error & { name: string }).name = "AbortError";
      throw err;
    }

    const stderr = decodeChunks(stderrChunks).trim();
    const jsonLines = stdoutLines.filter((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    });

    if (jsonLines.length > 0) {
      const output = extractOpenCodeOutput(jsonLines);
      if (timedOut) {
        throw new Error("OpenCode timed out");
      }
      if (!status.success && !output.is_error && !denialAbort) {
        throw new Error(
          `OpenCode exited with code ${status.code}${
            stderr ? `: ${stderr}` : ""
          }`,
        );
      }
      if (output.session_id) {
        // FR-L32: surface transcript export failure instead of swallowing.
        const transcript = await exportOpenCodeTranscript(
          output.session_id,
          { cwd, env },
        );
        output.transcript_path = transcript.path;
        output.transcript_error = transcript.error;
      }
      return output;
    }

    if (!status.success) {
      if (timedOut) {
        throw new Error("OpenCode timed out");
      }
      throw new Error(
        `OpenCode exited with code ${status.code}${
          stderr ? `: ${stderr}` : ""
        }`,
      );
    }

    throw new Error("OpenCode JSON output contained no parseable events");
  } finally {
    registry.unregister(process);
  }
}

async function processOpenCodeLine(
  rawLine: string,
  stdoutLines: string[],
  encoder: TextEncoder,
  logFile: Deno.FsFile | undefined,
  handleEvent: (event: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const line = rawLine.trim();
  if (!line) return;
  stdoutLines.push(line);
  if (logFile) {
    await logFile.write(encoder.encode(line + "\n"));
  }
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    await handleEvent(event);
  } catch {
    // Ignore non-JSON lines in stdout.
  }
}

function decodeChunks(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(buffer);
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
