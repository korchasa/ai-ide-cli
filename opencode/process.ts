/**
 * @module
 * OpenCode runtime adapter: builds CLI arguments, spawns the opencode process,
 * parses JSON event stream, extracts normalized output, and handles HITL
 * interception for the OpenCode runtime. Also wires the runtime-neutral
 * {@link OnRuntimeToolUseObservedCallback} (FR-L16) and surfaces the
 * persisted transcript via `opencode export <sessionId>`.
 * Entry point: {@link invokeOpenCodeCli}.
 */

import type { CliRunOutput, Verbosity } from "../types.ts";
import type {
  HitlConfig,
  HumanInputOption,
  HumanInputRequest,
} from "../types.ts";
import {
  OPENCODE_HITL_MCP_SERVER_NAME,
  OPENCODE_HITL_MCP_TOOL_NAME,
} from "./hitl-mcp.ts";
import { defaultRegistry, type ProcessRegistry } from "../process-registry.ts";
import type {
  OnRuntimeToolUseObservedCallback,
  RuntimeInvokeOptions,
  RuntimeInvokeResult,
  RuntimeLifecycleHooks,
  RuntimeToolUseDecision,
} from "../runtime/types.ts";
import { expandExtraArgs } from "../runtime/argv.ts";
import {
  type OnCallbackError,
  safeAwaitCallback,
} from "../runtime/callback-safety.ts";

/**
 * Flags reserved by {@link buildOpenCodeArgs}. Keys in `extraArgs` that
 * match these throw synchronously — the adapter emits them itself.
 */
export const OPENCODE_RESERVED_FLAGS: readonly string[] = [
  "run",
  "--format",
  "--session",
  "--model",
  "--agent",
  "--dangerously-skip-permissions",
];

// --- Typed event shapes (discriminated union) ---
//
// OpenCode `run --format json` emits one JSON object per line. Each object
// carries `type` as discriminator and usually a `part` payload. The shapes
// below mirror the runtime's native output and are kept intentionally
// permissive (`[key: string]: unknown`) so upstream CLI updates that add
// fields do not break consumers. Consumers that want typed narrowing of
// {@link RuntimeInvokeOptions.onEvent} should cast to
// {@link OpenCodeStreamEvent} and `switch` on `event.type`.

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

/** Build CLI arguments for the opencode command. Exported for testing. */
export function buildOpenCodeArgs(opts: RuntimeInvokeOptions): string[] {
  const args: string[] = ["run"];

  if (opts.resumeSessionId) {
    args.push("--session", opts.resumeSessionId);
  }

  if (opts.model && !opts.resumeSessionId) {
    args.push("--model", opts.model);
  }

  if (opts.agent && !opts.resumeSessionId) {
    args.push("--agent", opts.agent);
  }

  if (opts.permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  }

  // FR-L25: abstract reasoning effort → OpenCode's `--variant`.
  // Forwarded verbatim; provider-specific interpretation may differ.
  if (opts.reasoningEffort) {
    args.push("--variant", opts.reasoningEffort);
  }

  args.push(...expandExtraArgs(opts.extraArgs, OPENCODE_RESERVED_FLAGS));

  args.push("--format", "json");
  // `--` separator: taskPrompt is a positional argument and may begin with
  // `-` (e.g. when systemPrompt content starts with YAML frontmatter `---`).
  // Without this separator yargs treats the prompt as an unknown long flag,
  // opencode prints its usage and exits with code 1.
  args.push("--", opts.taskPrompt);

  return args;
}

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
    duration_api_ms: 0,
    num_turns: steps,
    is_error: isError,
    hitl_request: hitlRequest,
  };
}

/** Build per-invocation OpenCode config content used to inject local MCP servers. */
export function buildOpenCodeConfigContent(
  opts: RuntimeInvokeOptions,
): string | undefined {
  if (!hasConfiguredHitl(opts.hitlConfig)) {
    return undefined;
  }

  if (!opts.hitlMcpCommandBuilder) {
    throw new Error(
      "OpenCode HITL requires hitlMcpCommandBuilder — consumer must supply " +
        "a sub-process entry point for the HITL MCP server. See " +
        "RuntimeInvokeOptions.hitlMcpCommandBuilder JSDoc.",
    );
  }

  return JSON.stringify({
    mcp: {
      [OPENCODE_HITL_MCP_SERVER_NAME]: {
        type: "local",
        command: opts.hitlMcpCommandBuilder(),
        enabled: true,
      },
    },
  });
}

/**
 * Extract a tool-use info payload from a parsed OpenCode `tool_use` event
 * suitable for dispatch through {@link OnRuntimeToolUseObservedCallback}.
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
 * Result of {@link exportOpenCodeTranscript}. Exactly one of `path` or
 * `error` is populated:
 *
 * - `{ path }` — export succeeded; absolute path to a temp file holding
 *   the transcript JSON.
 * - `{ error }` — export attempt failed; `error` is a short diagnostic
 *   suitable for surfacing as `CliRunOutput.transcript_error` (FR-L32).
 *
 * Empty / no-id input returns `{}` so callers can branch uniformly.
 */
export interface OpenCodeTranscriptResult {
  /** Absolute path to the temp file holding the captured transcript JSON. */
  path?: string;
  /** Short diagnostic when export failed (subprocess non-zero, I/O error, …). */
  error?: string;
}

/**
 * Export an OpenCode session transcript to a local temporary file by invoking
 * `opencode export <sessionId> [--sanitize]` and capturing stdout.
 *
 * Returns `{ path }` on success, `{ error }` on failure (FR-L32 — previously
 * failures were swallowed wholesale, leaving consumers unable to
 * distinguish "runtime exposes no transcript" from "export attempted but
 * crashed"). The caller is responsible for surfacing `error` to the
 * normalized {@link import("../types.ts").CliRunOutput.transcript_error}
 * field; failures still never throw, so the primary invocation result is
 * never masked.
 *
 * Exported for testing.
 */
export async function exportOpenCodeTranscript(
  sessionId: string,
  opts?: {
    cwd?: string;
    env?: Record<string, string>;
    sanitize?: boolean;
    signal?: AbortSignal;
  },
): Promise<OpenCodeTranscriptResult> {
  if (!sessionId) return {};
  const args = ["export", sessionId];
  if (opts?.sanitize) args.push("--sanitize");
  try {
    const cmd = new Deno.Command("opencode", {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(opts?.env ? { env: opts.env } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    const { success, code, stdout, stderr } = await cmd.output();
    if (!success) {
      const tail = new TextDecoder().decode(stderr).trim();
      return {
        error: `opencode export exited with code ${code}${
          tail ? `: ${tail.slice(0, 256)}` : ""
        }`,
      };
    }
    if (stdout.length === 0) {
      return { error: "opencode export produced empty stdout" };
    }
    const path = await Deno.makeTempFile({
      prefix: `opencode-transcript-${sessionId}-`,
      suffix: ".json",
    });
    await Deno.writeFile(path, stdout);
    return { path };
  } catch (err) {
    return {
      error: `opencode export failed: ${(err as Error).message ?? String(err)}`,
    };
  }
}

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
  const configContent = buildOpenCodeConfigContent(opts);
  let lastError = "";

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      const output = await executeOpenCodeProcess(
        args,
        opts.timeoutSeconds,
        opts.onOutput,
        opts.streamLogPath,
        opts.verbosity,
        opts.cwd,
        configContent,
        opts.env,
        opts.onEvent,
        opts.signal,
        opts.hooks,
        opts.onToolUseObserved,
        opts.processRegistry,
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
  onOutput?: (line: string) => void,
  streamLogPath?: string,
  verbosity?: Verbosity,
  cwd?: string,
  configContent?: string,
  env?: Record<string, string>,
  onEvent?: (event: Record<string, unknown>) => void,
  userSignal?: AbortSignal,
  hooks?: RuntimeLifecycleHooks,
  onToolUseObserved?: OnRuntimeToolUseObservedCallback,
  processRegistry?: ProcessRegistry,
  onCallbackError?: OnCallbackError,
): Promise<CliRunOutput> {
  const processEnv: Record<string, string> = { ...env };
  if (configContent) {
    processEnv.OPENCODE_CONFIG_CONTENT = configContent;
  }
  const cmd = new Deno.Command("opencode", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    ...(Object.keys(processEnv).length > 0 ? { env: processEnv } : {}),
    ...(cwd ? { cwd } : {}),
  });

  const process = cmd.spawn();
  const registry = processRegistry ?? defaultRegistry;
  registry.register(process);

  let timedOut = false;
  let interruptedForHitl = false;
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

    const killForHitl = () => {
      interruptedForHitl = true;
      try {
        process.kill("SIGTERM");
      } catch {
        // Process may already be gone.
      }
    };
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
      // non-HITL tool_use events whose state reached a terminal status.
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
      if (extractHitlRequestFromEvent(event)) killForHitl();
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
        total_cost_usd: 0,
        duration_ms: 0,
        duration_api_ms: 0,
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
      if (interruptedForHitl && output.hitl_request) {
        output.is_error = false;
      }
      if (timedOut && !output.hitl_request) {
        throw new Error("OpenCode timed out");
      }
      if (
        !status.success && !output.is_error && !interruptedForHitl &&
        !denialAbort
      ) {
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

function extractHitlRequestFromEvent(
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

function hasConfiguredHitl(config?: HitlConfig): config is HitlConfig {
  return Boolean(config?.ask_script && config?.check_script);
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
