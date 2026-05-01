/**
 * @module
 * Codex CLI process runner: spawns `codex exec --experimental-json` with
 * the user prompt piped on stdin, processes NDJSON events in real-time,
 * and returns normalized {@link CliRunOutput}. Includes retry logic with
 * exponential backoff, AbortSignal cancellation, runtime-neutral lifecycle
 * hooks, observed tool-use callback, HITL interception via local stdio
 * MCP, and persisted transcript discovery.
 *
 * **Parallel protocol warning.** This file parses the `codex exec
 * --experimental-json` NDJSON stream — item types are **snake_case**
 * (`agent_message`, `command_execution`, `file_change`, `mcp_tool_call`,
 * `web_search`, `reasoning`, `todo_list`, `error`) and live at
 * `event.item.*` on `item.completed` events. The streaming-input session
 * in `codex/session.ts` uses a DIFFERENT protocol (`codex app-server
 * --listen stdio://`, JSON-RPC v2) with **camelCase** item types
 * (`agentMessage`, `commandExecution`, `fileChange`, `mcpToolCall`,
 * `webSearch`, `dynamicToolCall`) and a slightly different field layout
 * (e.g. `aggregatedOutput` vs no output field). Do NOT cross-reference
 * helpers between the two files without re-verifying against
 * `codex app-server generate-ts --out <dir>` (`v2/ThreadItem.ts`).
 *
 * Module split:
 *
 * - `codex/argv.ts` — argv builder, reserved-flag set, permission-mode
 *   serializer, HITL config-override builder.
 * - `codex/run-state.ts` — `CodexRunState`, NDJSON event aggregator,
 *   output projector, formatter, tool-use info extractor, HITL request
 *   parser.
 * - `codex/transcript.ts` — persisted-rollout path discovery.
 * - `codex/process.ts` (this file) — `invokeCodexCli` retry/abort loop +
 *   `executeCodexProcess` subprocess driver. Re-exports the helpers from
 *   the three modules above so existing imports
 *   (`from "./codex/process.ts"`) keep working.
 *
 * Upstream reference — keep this list in sync when porting more features.
 * This adapter intentionally does NOT depend on `@openai/codex-sdk`, but
 * mirrors its CLI contract. When extending (images, output schema, extra
 * dirs, reasoning effort, etc.), copy the flag construction and event
 * handling from the SDK rather than reverse-engineering:
 *
 * - SDK repo:     https://github.com/openai/codex/tree/main/sdk/typescript
 * - `exec.ts`:    https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts
 * - `thread.ts`:  https://github.com/openai/codex/blob/main/sdk/typescript/src/thread.ts
 * - `events.ts`:  https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts
 * - `items.ts`:   https://github.com/openai/codex/blob/main/sdk/typescript/src/items.ts
 *
 * Not yet wired here — pick up from the SDK when needed:
 * - `--image <path>` (repeatable) for local-image user inputs
 * - `--output-schema <file>` for JSON-schema-constrained responses
 * - `--add-dir <dir>` (repeatable) for additional workspace directories
 * - `--skip-git-repo-check`
 *
 * Entry point: {@link invokeCodexCli}.
 */

import type { CliRunOutput, Verbosity } from "../types.ts";
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
import type { ProcessRegistry } from "../process-registry.ts";
import {
  type CodexExecEvent,
  type CodexExecItemCompletedEvent,
  type CodexExecThreadStartedEvent,
  parseCodexExecEvent,
} from "./exec-events.ts";
import { buildCodexArgs } from "./argv.ts";
import {
  applyCodexEvent,
  codexItemToToolUseInfo,
  createCodexRunState,
  extractCodexOutput,
  extractCodexUsage,
  formatCodexEventForOutput,
} from "./run-state.ts";
import { findCodexSessionFile } from "./transcript.ts";

// Re-exports preserve the historical entry-point shape so existing
// 'from "./codex/process.ts"' imports (production + tests) keep working
// after the split.
export {
  buildCodexArgs,
  buildCodexHitlConfigArgs,
  CODEX_INTENTIONALLY_OPEN_FLAGS,
  CODEX_RESERVED_FLAGS,
  CODEX_RESERVED_POSITIONALS,
  permissionModeToCodexArgs,
} from "./argv.ts";
export {
  applyCodexEvent,
  codexItemToToolUseInfo,
  type CodexRunState,
  createCodexRunState,
  extractCodexHitlRequest,
  extractCodexOutput,
  formatCodexEventForOutput,
} from "./run-state.ts";
export { defaultCodexSessionsDir, findCodexSessionFile } from "./transcript.ts";

/** Invoke codex CLI with retry logic. */
export async function invokeCodexCli(
  opts: RuntimeInvokeOptions,
): Promise<RuntimeInvokeResult> {
  if (opts.signal?.aborted) {
    return { error: "Aborted before start" };
  }
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
        opts.processRegistry,
        opts.onOutput,
        opts.streamLogPath,
        opts.verbosity,
        opts.cwd,
        opts.env,
        opts.onEvent,
        opts.signal,
        opts.hooks,
        opts.onToolUseObserved,
        opts.onCallbackError,
      );
      // HITL request: surface output, do not retry.
      if (output.hitl_request) {
        opts.hooks?.onResult?.(output);
        return { output };
      }
      if (output.is_error) {
        lastError = `Codex CLI returned error: ${output.result}`;
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
  // FR-L33: sync env.PWD with cwd at the spawn boundary.
  const syncedEnv = withSyncedPWD(env, cwd);
  const cmd = new Deno.Command("codex", {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    ...(syncedEnv ? { env: syncedEnv } : {}),
    ...(cwd ? { cwd } : {}),
  });

  const process = cmd.spawn();
  const registry = processRegistry;
  registry.register(process);

  let interruptedForHitl = false;
  let denialAbort = false;

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
    let initEmitted = false;
    const seenObservedIds = new Set<string>();

    const handleEvent = async (
      event: CodexExecEvent,
    ): Promise<void> => {
      onEvent?.(event);
      if (!initEmitted && event.type === "thread.started") {
        initEmitted = true;
        const started = event as CodexExecThreadStartedEvent;
        hooks?.onInit?.({
          runtime: "codex",
          sessionId: typeof started.thread_id === "string"
            ? started.thread_id
            : undefined,
        });
      }
      applyCodexEvent(event, state);

      // Tool-use observation hook — fires for `command_execution`,
      // `file_change`, `mcp_tool_call`, `web_search` once each (status
      // intermediate events are skipped via seenObservedIds).
      if (onToolUseObserved && event.type === "item.completed") {
        const item = (event as CodexExecItemCompletedEvent).item;
        const info = codexItemToToolUseInfo(item);
        if (info && info.id && !seenObservedIds.has(info.id)) {
          seenObservedIds.add(info.id);
          // FR-L32: callback throws no longer auto-abort. They route via
          // onCallbackError and the decision defaults to "allow" so a
          // consumer typo cannot silently kill a run.
          const observedDecision = await safeAwaitCallback(
            onToolUseObserved,
            [
              {
                runtime: "codex" as const,
                id: info.id,
                name: info.name,
                input: info.input,
                turn: state.turnCount + 1,
              },
            ],
            "onToolUseObserved",
            onCallbackError,
          );
          const decision: RuntimeToolUseDecision = observedDecision ?? "allow";
          if (decision === "abort") {
            state.denied = {
              tool: info.name,
              id: info.id,
              reason: "Aborted by onToolUseObserved callback",
            };
            denialAbort = true;
            try {
              process.kill("SIGTERM");
            } catch {
              // Process may have already exited.
            }
          }
        }
      }

      const logSummary = formatCodexEventForOutput(event);
      if (logFile && logSummary) {
        await logFile.write(encoder.encode(logSummary + "\n"));
      }
      if (onOutput) {
        const termSummary = formatCodexEventForOutput(event, verbosity);
        if (termSummary) onOutput(termSummary);
      }

      // HITL request detected — SIGTERM and let the run terminate so the
      // engine can resume the session after the human responds.
      if (state.hitlRequest && !interruptedForHitl) {
        interruptedForHitl = true;
        try {
          process.kill("SIGTERM");
        } catch {
          // Process may have already exited.
        }
      }
    };

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
            const event = parseCodexExecEvent(line);
            if (event) await handleEvent(event);
          }
        }
        if (buffer.trim()) {
          const event = parseCodexExecEvent(buffer);
          if (event) await handleEvent(event);
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

    // Tool-use abort takes precedence: synthesize a denial output.
    if (state.denied) {
      return {
        runtime: "codex",
        result: state.denied.reason,
        session_id: state.threadId,
        duration_ms: Math.max(0, Date.now() - state.startMs),
        num_turns: state.turnCount,
        is_error: true,
        usage: extractCodexUsage(state),
        permission_denials: [
          {
            tool_name: state.denied.tool,
            tool_input: { id: state.denied.id, reason: state.denied.reason },
          },
        ],
        transcript_path: state.threadId
          ? await findCodexSessionFile(state.threadId, state.startMs)
          : undefined,
      };
    }

    if (userSignal?.aborted) {
      const err = new Error(`Aborted: ${abortReason(userSignal)}`);
      (err as Error & { name: string }).name = "AbortError";
      throw err;
    }

    const stderr = decodeChunks(stderrChunks).trim();

    // SIGTERM caused by HITL detection or denial is expected — only treat
    // a failed exit as an error if neither path interrupted us.
    if (
      !status.success && !state.errorMessage && !interruptedForHitl &&
      !denialAbort
    ) {
      throw new Error(
        `Codex CLI exited with code ${status.code}${
          stderr ? `: ${stderr}` : ""
        }`,
      );
    }

    const output = extractCodexOutput(state);
    if (interruptedForHitl) {
      output.is_error = false;
    }
    if (state.threadId) {
      output.transcript_path = await findCodexSessionFile(
        state.threadId,
        state.startMs,
      );
    }
    return output;
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
