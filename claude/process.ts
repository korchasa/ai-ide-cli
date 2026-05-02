/**
 * @module
 * Claude CLI process management: builds CLI arguments, spawns the claude
 * subprocess with stream-json output, processes NDJSON events in real-time,
 * and returns normalized {@link CliRunOutput}. Includes retry logic with
 * exponential backoff, AbortSignal cancellation, observed-tool-use hook,
 * typed lifecycle hooks, and setting-sources isolation.
 *
 * Upstream reference — consult this when extending flag coverage or when
 * the `stream-json` event shape changes:
 * https://github.com/anthropics/claude-agent-sdk-typescript
 * (Anthropic's TypeScript SDK for Claude Code headless mode — source of
 * truth for CLI flags, NDJSON event types, and permission semantics).
 *
 * Entry point: {@link invokeClaudeCli}.
 */

import type { CliRunOutput, Verbosity } from "../types.ts";
import type { ExtraArgsMap, RuntimeInvokeResult } from "../runtime/types.ts";
import { expandExtraArgs } from "../runtime/argv.ts";
import { validateToolFilter } from "../runtime/tool-filter.ts";
import { withSyncedPWD } from "../runtime/env-cwd-sync.ts";
import {
  type ReasoningEffort,
  validateReasoningEffort,
} from "../runtime/reasoning-effort.ts";
import {
  defaultClaudeConfigDir,
  prepareSettingSourcesDir,
  type SettingSource,
} from "../runtime/setting-sources.ts";
import { validateClaudePermissionMode } from "./permission-mode.ts";
import type { ProcessRegistry } from "../process-registry.ts";
import {
  type ClaudeLifecycleHooks,
  type ClaudeStreamEvent,
  FileReadTracker,
  type OnToolUseObservedCallback,
  parseClaudeStreamEvent,
  processStreamEvent,
  type StreamProcessorState,
} from "./stream.ts";

/**
 * Flags reserved by {@link buildClaudeArgs} — the runtime adapter emits
 * these itself and they MUST NOT appear as keys in `claudeArgs` /
 * `extraArgs`. Passing any of these throws synchronously.
 */
export const CLAUDE_RESERVED_FLAGS: readonly string[] = [
  "--output-format",
  "--verbose",
  "-p",
  "--agent",
  "--append-system-prompt",
  "--model",
  "--resume",
  "--permission-mode",
  "--input-format",
];

/**
 * Flags that {@link buildClaudeArgs} / {@link buildClaudeSessionArgs}
 * may emit but are deliberately **not** in {@link CLAUDE_RESERVED_FLAGS}
 * — consumers can still set them via the legacy `extraArgs` map for
 * backward compatibility. Each entry exists for a documented reason.
 *
 * Exists to make the contract explicit so the cross-runtime coverage
 * test (`runtime/reserved-flag-coverage_test.ts`) can assert that every
 * emitted flag is either reserved or intentionally open — drift between
 * the builder and the reserved list fails the test loudly.
 */
export const CLAUDE_INTENTIONALLY_OPEN_FLAGS: readonly string[] = [
  // FR-L24: typed `allowedTools` is the preferred path, but the legacy
  // `claudeArgs: { "--allowedTools": "Read,Bash" }` route stays valid so
  // existing YAML-driven configurations keep working.
  "--allowedTools",
  // FR-L24: same back-compat reasoning as `--allowedTools`.
  "--disallowedTools",
  // FR-L25: typed `reasoningEffort` is preferred, but legacy
  // `claudeArgs: { "--effort": "high" }` is still accepted.
  "--effort",
];

/** Low-level options for a single claude CLI invocation (initial or resume). */
export interface ClaudeInvokeOptions {
  /**
   * Optional process tracker scope. Falls back to the default singleton when
   * omitted. See {@link import("../runtime/types.ts").RuntimeInvokeOptions.processRegistry}.
   */
  processRegistry: ProcessRegistry;
  /** Name of Claude Code agent (without .md) passed via --agent flag. Skipped on resume. */
  agent?: string;
  /** System context passed via --append-system-prompt. Skipped on resume. */
  systemPrompt?: string;
  /** Task prompt passed to claude via -p flag. */
  taskPrompt: string;
  /** Session ID for --resume continuation (omit for initial invocation). */
  resumeSessionId?: string;
  /**
   * Extra CLI arguments passed to claude command (map-shape).
   * See {@link ExtraArgsMap} for value semantics.
   */
  claudeArgs?: ExtraArgsMap;
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
  /**
   * External cancellation signal. Combined with the timeout signal via
   * `AbortSignal.any`. Retry loop exits immediately on abort without
   * further attempts.
   */
  signal?: AbortSignal;
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
  onEvent?: (event: ClaudeStreamEvent) => void;
  /**
   * Typed Claude-specific lifecycle hooks (`onInit`, `onAssistant`,
   * `onResult`). Each hook observes the narrowed event before internal
   * state mutations.
   */
  hooks?: ClaudeLifecycleHooks;
  /**
   * Observed-tool-use callback. Fires **post-dispatch but pre-next-turn**:
   * by the time this hook fires, the tool has already been invoked by
   * Claude. Returning `"abort"` terminates the run via `SIGTERM` and the
   * adapter synthesizes a `CliRunOutput` with `is_error: true` and a
   * single `permission_denials[]` entry describing the observed tool.
   */
  onToolUseObserved?: OnToolUseObservedCallback;
  /**
   * Filter the set of Claude configuration sources that apply to the run.
   * When provided, the runner redirects `CLAUDE_CONFIG_DIR` to a temporary
   * dir populated from the listed sources (see
   * {@link import("../runtime/setting-sources").prepareSettingSourcesDir}).
   */
  settingSources?: SettingSource[];
  /**
   * Tool-name allow-list — emitted as `--allowedTools <comma-joined>`.
   * Mutually exclusive with {@link disallowedTools}. See FR-L24.
   */
  allowedTools?: string[];
  /**
   * Tool-name deny-list — emitted as `--disallowedTools <comma-joined>`.
   * Mutually exclusive with {@link allowedTools}. See FR-L24.
   */
  disallowedTools?: string[];
  /**
   * Abstract reasoning-effort depth — mapped to Claude's `--effort`. See
   * {@link import("../runtime/reasoning-effort.ts").ReasoningEffort}. Note
   * that `"minimal"` has no native equivalent and is translated to
   * `"low"` with a one-time warning. See FR-L25.
   */
  reasoningEffort?: ReasoningEffort;
}

/**
 * Translate the abstract {@link ReasoningEffort} into the native Claude
 * `--effort` value. Emits a one-time warning when the mapping is lossy
 * (Claude has no `"minimal"` level and substitutes `"low"`).
 *
 * Exported for testing; adapters should prefer the typed option.
 */
export function mapReasoningEffortToClaude(
  value: ReasoningEffort,
): string {
  if (value === "minimal") {
    warnClaudeReasoningEffortMappingOnce();
    return "low";
  }
  return value;
}

let warnedClaudeEffortMapping = false;

function warnClaudeReasoningEffortMappingOnce(): void {
  if (warnedClaudeEffortMapping) return;
  warnedClaudeEffortMapping = true;
  console.warn(
    '[claude] reasoningEffort="minimal" mapped to --effort low — Claude CLI has no native "minimal" level. See FR-L25.',
  );
}

/**
 * Test-only: reset the one-time reasoning-effort mapping warning latch.
 *
 * @internal
 */
export function _resetClaudeReasoningEffortWarning(): void {
  warnedClaudeEffortMapping = false;
}

/** Invoke claude CLI with retry logic. */
export async function invokeClaudeCli(
  opts: ClaudeInvokeOptions,
): Promise<RuntimeInvokeResult> {
  if (opts.signal?.aborted) {
    return { error: "Aborted before start" };
  }

  const args = buildClaudeArgs(opts);
  let lastError = "";

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      const output = await executeClaudeProcess(args, opts);
      if (output.is_error) {
        lastError = `Claude CLI returned error: ${output.result}`;
        if (attempt < opts.maxRetries) {
          const delay = opts.retryDelaySeconds * Math.pow(2, attempt - 1);
          try {
            await sleep(delay * 1000, opts.signal);
          } catch (err) {
            if (isAbortError(err)) {
              return {
                output,
                error: `Aborted: ${abortReason(opts.signal)}`,
              };
            }
            throw err;
          }
          continue;
        }
        return { output, error: lastError };
      }
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
    error: `Claude CLI failed after ${opts.maxRetries} attempts: ${lastError}`,
  };
}

/** Build CLI arguments for the claude command. Exported for testing. */
export function buildClaudeArgs(opts: ClaudeInvokeOptions): string[] {
  const args: string[] = [];

  // Permission mode (first-class field, maps to --permission-mode).
  // Fail-fast on unknown values; mirrors the tool-filter / reasoning-effort
  // validators so YAML-driven consumers see uniform errors across the three
  // typed Claude options.
  validateClaudePermissionMode(opts.permissionMode);
  if (opts.permissionMode) {
    args.push("--permission-mode", opts.permissionMode);
  }

  // FR-L24: typed tool filter. Validator throws on mutual exclusion,
  // empty array, empty-string members, or collision with the legacy
  // extraArgs keys. Emission is comma-joined into exactly two argv
  // tokens regardless of array length.
  const toolFilterMode = validateToolFilter("claude", {
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    extraArgs: opts.claudeArgs,
  });
  if (toolFilterMode === "allowed") {
    args.push("--allowedTools", opts.allowedTools!.join(","));
  } else if (toolFilterMode === "disallowed") {
    args.push("--disallowedTools", opts.disallowedTools!.join(","));
  }

  // FR-L25: abstract reasoning effort → Claude's `--effort`.
  // Validation runs unconditionally (catches malformed input on resume too),
  // but emission is suppressed on --resume so the session inherits its
  // original effort level — symmetric with --model on line 290.
  const effort = validateReasoningEffort("claude", {
    reasoningEffort: opts.reasoningEffort,
    extraArgs: opts.claudeArgs,
  });
  if (effort !== undefined && !opts.resumeSessionId) {
    args.push("--effort", mapReasoningEffortToClaude(effort));
  }

  // Extra CLI args go next (expanded from the map shape).
  args.push(...expandExtraArgs(opts.claudeArgs, CLAUDE_RESERVED_FLAGS));

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
  opts: ClaudeInvokeOptions,
): Promise<CliRunOutput> {
  // Optional setting-sources isolation — build a filtered tmp config dir
  // and redirect CLAUDE_CONFIG_DIR for this run only.
  let settingCleanup: (() => Promise<void>) | undefined;
  let env: Record<string, string> = { CLAUDECODE: "", ...(opts.env ?? {}) };
  if (opts.settingSources) {
    const prepared = await prepareSettingSourcesDir(
      opts.settingSources,
      env.CLAUDE_CONFIG_DIR ?? defaultClaudeConfigDir(),
      opts.cwd ?? Deno.cwd(),
    );
    settingCleanup = prepared.cleanup;
    env = { ...env, CLAUDE_CONFIG_DIR: prepared.tmpDir };
  }

  // Unset CLAUDECODE to allow nested claude CLI invocations.
  // Claude Code checks this variable and refuses to launch inside another session.
  // Deno.Command merges env with parent, so setting empty string overrides it.
  // FR-L33: sync env.PWD with cwd at the spawn boundary.
  const syncedEnv = withSyncedPWD(env, opts.cwd) ?? env;
  const cmd = new Deno.Command("claude", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: syncedEnv,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });

  const process = cmd.spawn();
  const registry = opts.processRegistry;
  registry.register(process);

  // Build a combined abort signal: user signal + timeout. SIGTERM fires
  // on either source, the retry-sleep reacts to the user signal only.
  const timeoutSignal = AbortSignal.timeout(opts.timeoutSeconds * 1000);
  const combined = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;
  const runController = new AbortController();
  const onExternalAbort = () => {
    try {
      process.kill("SIGTERM");
    } catch {
      // Process may have already exited.
    }
  };
  combined.addEventListener("abort", onExternalAbort, { once: true });

  // Local aborts from onToolUseObserved go through runController so we can
  // tell them apart from user/timeout aborts.
  const onRunAbort = () => {
    try {
      process.kill("SIGTERM");
    } catch {
      // Process may have already exited.
    }
  };
  runController.signal.addEventListener("abort", onRunAbort, { once: true });

  try {
    // Open stream log file for real-time writing (append mode)
    let logFile: Deno.FsFile | undefined;
    if (opts.streamLogPath) {
      const dir = opts.streamLogPath.replace(/\/[^/]+$/, "");
      await Deno.mkdir(dir, { recursive: true });
      logFile = await Deno.open(opts.streamLogPath, {
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
      onOutput: opts.onOutput,
      verbosity: opts.verbosity,
      onEvent: opts.onEvent,
      hooks: opts.hooks,
      onToolUseObserved: opts.onToolUseObserved,
      abortController: runController,
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
            const event = parseClaudeStreamEvent(line);
            if (event) {
              await processStreamEvent(event, state);
            }
          }
        }
        // Process remaining buffer
        if (buffer.trim()) {
          const event = parseClaudeStreamEvent(buffer);
          if (event) await processStreamEvent(event, state);
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
    combined.removeEventListener("abort", onExternalAbort);
    runController.signal.removeEventListener("abort", onRunAbort);

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

    // Hook-driven abort takes precedence: synthesize a terminal output.
    if (state.denied) {
      return {
        runtime: "claude",
        result: "Aborted by onToolUseObserved callback",
        session_id: state.lastSessionId ?? state.resultEvent?.session_id ?? "",
        duration_ms: 0,
        num_turns: state.turnCount,
        is_error: true,
        permission_denials: [
          {
            tool_name: state.denied.tool,
            tool_input: { id: state.denied.id, reason: state.denied.reason },
          },
        ],
      };
    }

    // External abort (user signal or timeout): surface as an error. The
    // retry loop treats this as terminal and does not retry.
    if (opts.signal?.aborted) {
      const err = new Error(`Aborted: ${abortReason(opts.signal)}`);
      (err as Error & { name: string }).name = "AbortError";
      throw err;
    }

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
    registry.unregister(process);
    if (settingCleanup) {
      await settingCleanup();
    }
  }
}

/**
 * Sleep `ms` milliseconds, abortable via the optional signal.
 * On abort, rejects with `DOMException("Aborted", "AbortError")`.
 */
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

/** Check whether a caught error represents an abort. */
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

/**
 * Extract a human-readable abort reason from an `AbortSignal`.
 * Returns `"manual abort"` when no reason is set.
 */
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
