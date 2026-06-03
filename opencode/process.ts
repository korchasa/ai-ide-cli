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
import { ERROR_CATEGORY_STREAM_STALL } from "../runtime/error-types.ts";
import { withSyncedPWD } from "../runtime/env-cwd-sync.ts";
import { stampLines } from "../runtime/log-format.ts";
import {
  buildOpenCodeConfigContent,
  validateMcpServers,
} from "../runtime/mcp-injection.ts";
import {
  analyzeRuntimeErrorSignal,
  type RuntimeErrorAnalysis,
} from "../runtime/runtime-error-analysis.ts";
import { buildOpenCodeArgs } from "./argv.ts";
import {
  extractOpenCodeOutput,
  formatOpenCodeEventForOutput,
  type OpenCodeToolUseEvent,
  openCodeToolUseInfo,
} from "./events.ts";
import { exportOpenCodeTranscript } from "./transcript.ts";
import {
  findActiveOpenCodeLog,
  resolveOpenCodeLogDir,
  type UpstreamFatalError,
  watchOpenCodeLogForFatalError,
} from "./upstream-error-detector.ts";

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

// FR-L36: shared message prefix so the outer retry loop and tests
// recognise the stall path without parsing free-form text.
const STREAM_STALL_ERROR_PREFIX = "OpenCode aborted on stream stall";

class OpenCodeUpstreamFatalError extends Error {
  readonly runtimeError?: RuntimeErrorAnalysis;

  constructor(upstreamFatal: UpstreamFatalError) {
    super(
      `OpenCode aborted on upstream HTTP ${upstreamFatal.statusCode}: ${upstreamFatal.message}`,
    );
    this.name = "OpenCodeUpstreamFatalError";
    this.runtimeError = analyzeRuntimeErrorSignal({
      runtime: "opencode",
      source: "log",
      text: JSON.stringify({
        statusCode: upstreamFatal.statusCode,
        error: {
          ...(upstreamFatal.providerCode
            ? { code: upstreamFatal.providerCode }
            : {}),
          message: upstreamFatal.message,
        },
      }),
      assumeRuntimeError: true,
    });
  }
}

// FR-L36: synchronous validation of the watchdog idle threshold. Non-
// integer / NaN / negative throws so YAML-driven consumers fail fast
// instead of silently disabling the watchdog at runtime.
function resolveStreamStallTimeout(input: number | undefined): number {
  if (input === undefined) return 120;
  if (!Number.isFinite(input) || !Number.isInteger(input) || input < 0) {
    throw new Error(
      `streamStallTimeoutSeconds must be a non-negative integer (received ${input})`,
    );
  }
  return input;
}

/** Invoke opencode CLI with retry logic. */
export async function invokeOpenCodeCli(
  opts: RuntimeInvokeOptions,
): Promise<RuntimeInvokeResult> {
  if (opts.signal?.aborted) {
    return { error: "Aborted before start" };
  }
  // FR-L36: validate up-front before spawning anything.
  const streamStallTimeoutSeconds = resolveStreamStallTimeout(
    opts.streamStallTimeoutSeconds,
  );
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
        streamStallTimeoutSeconds,
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
      // Upstream HTTP 401/402/403/429 are non-recoverable from our side
      // (auth / quota / rate-limit). Skip the retry loop and surface the
      // provider message so the consumer can show it to the user.
      if (lastError.startsWith("OpenCode aborted on upstream HTTP")) {
        return {
          error: lastError,
          ...(err instanceof OpenCodeUpstreamFatalError && err.runtimeError
            ? { runtime_error: err.runtimeError }
            : {}),
        };
      }
      // FR-L36: stream-stall fires only after the configured idle
      // window — retries would just stall again. Short-circuit and
      // surface the typed category so the consumer can branch.
      if (lastError.startsWith(STREAM_STALL_ERROR_PREFIX)) {
        return {
          error: lastError,
          error_category: ERROR_CATEGORY_STREAM_STALL,
        };
      }
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
  streamStallTimeoutSeconds: number = 120,
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

  const spawnedAt = Date.now();
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
  let upstreamFatal: UpstreamFatalError | undefined;
  const detectorAbort = new AbortController();
  // FR-L36: stream-stall watchdog state. `streamStalled` flips when the
  // timer fires; the outer status-handling block throws the typed error
  // so the retry loop can branch on the message prefix.
  let streamStalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

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

    // FR-L36: stream-stall watchdog. Arm only when the threshold is a
    // positive integer; `0` disables. Reset on every successfully
    // parsed NDJSON line (see `handleEvent` below).
    const resetStallTimer = () => {
      if (streamStallTimeoutSeconds <= 0) return;
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        streamStalled = true;
        try {
          process.kill("SIGTERM");
        } catch {
          // Process may have already exited.
        }
      }, streamStallTimeoutSeconds * 1000);
    };
    resetStallTimer();

    // Upstream-fatal detector: tail the OpenCode CLI's internal log and
    // fail fast on HTTP 401/402/403/429. The CLI marks these as
    // `isRetryable: true` and silently retries them indefinitely without
    // emitting any --format json event, which would otherwise leave the
    // adapter waiting until the wall-clock timeout.
    const detectorLogDir = resolveOpenCodeLogDir();
    const detectorTask = detectorLogDir
      ? (async () => {
        try {
          const path = await findActiveOpenCodeLog(
            detectorLogDir,
            spawnedAt,
            5_000,
            detectorAbort.signal,
          );
          if (!path || detectorAbort.signal.aborted) return;
          await watchOpenCodeLogForFatalError(
            path,
            (err) => {
              upstreamFatal = err;
              try {
                process.kill("SIGTERM");
              } catch {
                // Process may have already exited.
              }
            },
            detectorAbort.signal,
          );
        } catch {
          // Detector is best-effort; do not crash the run if it throws.
        }
      })()
      : Promise.resolve();

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
      // FR-L36: each parsed NDJSON event proves the upstream is alive —
      // reset the watchdog. Reset BEFORE consumer callbacks so a slow
      // `onEvent` cannot itself trigger a false-positive stall.
      resetStallTimer();
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

      // FR-L40: stream.log gets the full (non-verbosity-filtered) summary
      // with a [HH:MM:SS] prefix so OpenCode's file matches Claude/Codex/
      // Cursor (previously this path wrote raw NDJSON).
      const logSummary = formatOpenCodeEventForOutput(event);
      if (logFile && logSummary) {
        await logFile.write(encoder.encode(stampLines(logSummary) + "\n"));
      }
      if (onOutput) {
        const termSummary = formatOpenCodeEventForOutput(event, verbosity);
        if (termSummary) onOutput(termSummary);
      }
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
            await processOpenCodeLine(line, stdoutLines, handleEvent);
          }
        }
        const trailing = stdoutBuffer.trim();
        if (trailing) {
          await processOpenCodeLine(trailing, stdoutLines, handleEvent);
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
    detectorAbort.abort();
    await detectorTask;

    logFile?.close();

    // FR-L36: stall takes precedence over upstream-fatal and exit-code
    // paths so the typed `error_category` survives partial output.
    if (streamStalled) {
      throw new Error(
        `${STREAM_STALL_ERROR_PREFIX}: no events for ${streamStallTimeoutSeconds}s`,
      );
    }

    if (upstreamFatal) {
      throw new OpenCodeUpstreamFatalError(upstreamFatal);
    }

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
    // FR-L36: clear watchdog regardless of exit path so successful
    // invocations do not leak setTimeout handles.
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    detectorAbort.abort();
    registry.unregister(process);
  }
}

async function processOpenCodeLine(
  rawLine: string,
  stdoutLines: string[],
  handleEvent: (event: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const line = rawLine.trim();
  if (!line) return;
  stdoutLines.push(line);
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
