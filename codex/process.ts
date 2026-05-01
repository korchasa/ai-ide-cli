/**
 * @module
 * Codex CLI process management: builds CLI arguments for `codex exec
 * --experimental-json`, spawns the subprocess with the user prompt piped on
 * stdin, processes NDJSON events in real-time, and returns normalized
 * {@link CliRunOutput}. Includes retry logic with exponential backoff,
 * AbortSignal cancellation, runtime-neutral lifecycle hooks, observed
 * tool-use callback, HITL interception via local stdio MCP, and persisted
 * transcript discovery.
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
 * Mirrors the patterns used by the Claude / OpenCode adapters but
 * accommodates Codex-specific quirks:
 *
 * - Prompt travels on **stdin**, not argv.
 * - Session resume is a positional subcommand: `resume <threadId>`.
 * - There is no single terminal `result` event — the final response comes
 *   from the last `item.completed` of type `agent_message`, and token usage
 *   from `turn.completed`.
 * - Approval policy / sandbox mode are expressed as TOML config overrides
 *   (`--config key=value`) rather than dedicated flags.
 * - Local MCP servers (used for HITL) are registered via `--config
 *   mcp_servers.<name>.command=...` overrides.
 * - The conversation transcript is persisted at
 *   `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl`.
 *
 * Upstream reference — keep this list in sync when porting more features.
 * This adapter intentionally does NOT depend on `@openai/codex-sdk`, but
 * mirrors its CLI contract. When extending (images, output schema, extra
 * dirs, reasoning effort, etc.), copy the flag construction and event
 * handling from the SDK rather than reverse-engineering:
 *
 * - SDK repo:     https://github.com/openai/codex/tree/main/sdk/typescript
 * - `exec.ts`:    https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts
 *   (argv construction, config-override serialization, stdin/stdout wiring,
 *   env vars `CODEX_API_KEY`, `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`)
 * - `thread.ts`:  https://github.com/openai/codex/blob/main/sdk/typescript/src/thread.ts
 *   (event aggregation, `Turn`/`StreamedTurn`, `normalizeInput` for images)
 * - `events.ts`:  https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts
 *   (`ThreadEvent` union, `Usage`, `ThreadError`)
 * - `items.ts`:   https://github.com/openai/codex/blob/main/sdk/typescript/src/items.ts
 *   (`ThreadItem` variants: command_execution, file_change, mcp_tool_call,
 *   agent_message, reasoning, web_search, todo_list, error)
 *
 * Not yet wired here — pick up from the SDK when needed:
 * - `--image <path>` (repeatable) for local-image user inputs
 * - `--output-schema <file>` for JSON-schema-constrained responses
 * - `--add-dir <dir>` (repeatable) for additional workspace directories
 * - `--skip-git-repo-check`
 * - `--config model_reasoning_effort=…`, `web_search=…`,
 *   `sandbox_workspace_write.network_access=…`, `openai_base_url=…`
 *
 * Entry point: {@link invokeCodexCli}.
 */

import type {
  CliRunOutput,
  HitlConfig,
  HumanInputRequest,
  Verbosity,
} from "../types.ts";
import type {
  OnRuntimeToolUseObservedCallback,
  RuntimeInvokeOptions,
  RuntimeInvokeResult,
  RuntimeLifecycleHooks,
  RuntimeToolUseDecision,
} from "../runtime/types.ts";
import { expandExtraArgs } from "../runtime/argv.ts";
import { defaultRegistry, type ProcessRegistry } from "../process-registry.ts";
import {
  CODEX_HITL_MCP_SERVER_NAME,
  CODEX_HITL_MCP_TOOL_NAME,
} from "./hitl-mcp.ts";
import { join } from "@std/path";

/**
 * Flags reserved by {@link buildCodexArgs}. Keys in `extraArgs` that match
 * these throw synchronously — the adapter emits them itself.
 */
export const CODEX_RESERVED_FLAGS: readonly string[] = [
  "exec",
  "--experimental-json",
  "--model",
  "--cd",
  "--sandbox",
  "resume",
];

/**
 * Codex sandbox modes accepted as a `permissionMode` pass-through. When the
 * caller passes one of these directly, the adapter emits `--sandbox <mode>`
 * with no `approval_policy` override.
 */
const CODEX_SANDBOX_MODES: ReadonlySet<string> = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

/**
 * Codex approval-policy modes accepted as a `permissionMode` pass-through.
 * When the caller passes one of these directly, the adapter emits
 * `--config approval_policy="<mode>"` with no `--sandbox` flag.
 */
const CODEX_APPROVAL_MODES: ReadonlySet<string> = new Set([
  "never",
  "on-request",
  "on-failure",
  "untrusted",
]);

/**
 * Map a runtime-neutral permission mode to Codex sandbox + approval-policy
 * flags. Returns the argv fragments to push, or `[]` for `default` /
 * unrecognized values (Codex falls back to its own config defaults).
 *
 * Recognized normalized modes:
 * - `default`           — no overrides.
 * - `plan`              — `--sandbox read-only` + `approval_policy="never"`.
 * - `acceptEdits`       — `--sandbox workspace-write` + `approval_policy="never"`.
 * - `bypassPermissions` — `--sandbox danger-full-access` + `approval_policy="never"`.
 *
 * Native pass-through modes (Codex-specific):
 * - `read-only` / `workspace-write` / `danger-full-access` — bare `--sandbox`.
 * - `never` / `on-request` / `on-failure` / `untrusted` — bare approval-policy.
 *
 * Exported for testing.
 */
export function permissionModeToCodexArgs(mode?: string): string[] {
  if (!mode || mode === "default") return [];

  switch (mode) {
    case "plan":
      return [
        "--sandbox",
        "read-only",
        "--config",
        `approval_policy="never"`,
      ];
    case "acceptEdits":
      return [
        "--sandbox",
        "workspace-write",
        "--config",
        `approval_policy="never"`,
      ];
    case "bypassPermissions":
      return [
        "--sandbox",
        "danger-full-access",
        "--config",
        `approval_policy="never"`,
      ];
  }

  if (CODEX_SANDBOX_MODES.has(mode)) {
    return ["--sandbox", mode];
  }
  if (CODEX_APPROVAL_MODES.has(mode)) {
    return ["--config", `approval_policy="${mode}"`];
  }
  return [];
}

/**
 * Build the `--config mcp_servers.<name>.command/args` overrides that
 * register a per-invocation local stdio MCP server with Codex. Returns
 * `[]` when no HITL command is configured.
 *
 * The serialization mirrors the TOML overrides emitted by
 * `@openai/codex-sdk`: scalar strings are JSON-quoted, arrays are TOML
 * literal arrays of JSON-quoted strings.
 *
 * Exported for testing.
 */
export function buildCodexHitlConfigArgs(
  opts: RuntimeInvokeOptions,
): string[] {
  if (!hasConfiguredHitl(opts.hitlConfig)) return [];
  if (!opts.hitlMcpCommandBuilder) {
    throw new Error(
      "Codex HITL requires hitlMcpCommandBuilder — consumer must supply " +
        "a sub-process entry point for the HITL MCP server. See " +
        "RuntimeInvokeOptions.hitlMcpCommandBuilder JSDoc.",
    );
  }
  const argv = opts.hitlMcpCommandBuilder();
  if (!argv.length) {
    throw new Error("hitlMcpCommandBuilder returned an empty argv");
  }
  const [command, ...rest] = argv;
  const serverPrefix = `mcp_servers.${CODEX_HITL_MCP_SERVER_NAME}`;
  const args: string[] = [
    "--config",
    `${serverPrefix}.command=${JSON.stringify(command)}`,
  ];
  if (rest.length > 0) {
    const renderedArgs = rest.map((a) => JSON.stringify(a)).join(", ");
    args.push("--config", `${serverPrefix}.args=[${renderedArgs}]`);
  }
  return args;
}

/**
 * Build CLI arguments for the `codex` command.
 * Exported for testing.
 *
 * Codex headless mode: `codex exec --experimental-json [flags] [resume <id>]`.
 * Prompt is written to the subprocess stdin; it is NOT appended to argv.
 *
 * - Session resume: `resume <threadId>` positional subcommand.
 * - Permissions: see {@link permissionModeToCodexArgs}.
 * - HITL injection: see {@link buildCodexHitlConfigArgs}.
 */
export function buildCodexArgs(opts: RuntimeInvokeOptions): string[] {
  const args: string[] = ["exec", "--experimental-json"];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  if (opts.cwd) {
    args.push("--cd", opts.cwd);
  }

  args.push(...permissionModeToCodexArgs(opts.permissionMode));
  args.push(...buildCodexHitlConfigArgs(opts));
  // FR-L25: abstract reasoning effort → native Codex config override.
  if (opts.reasoningEffort) {
    args.push(
      "--config",
      `model_reasoning_effort="${opts.reasoningEffort}"`,
    );
  }
  args.push(...expandExtraArgs(opts.extraArgs, CODEX_RESERVED_FLAGS));

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
  /**
   * HITL request extracted from a `mcp_tool_call` item targeting the
   * `hitl.request_human_input` tool. Set once on first detection.
   */
  hitlRequest?: HumanInputRequest;
  /**
   * Set when the consumer's `onToolUseObserved` callback returned
   * `"abort"` for a tool item. The runner SIGTERMs the subprocess and
   * synthesizes a `permission_denials[]` entry from this data.
   */
  denied?: { tool: string; id: string; reason: string };
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
      if (!item || typeof item !== "object") return;
      if (item.type === "agent_message" && typeof item.text === "string") {
        state.finalResponse = item.text;
        return;
      }
      if (
        !state.hitlRequest && item.type === "mcp_tool_call" &&
        item.status === "completed" &&
        item.server === CODEX_HITL_MCP_SERVER_NAME &&
        item.tool === CODEX_HITL_MCP_TOOL_NAME
      ) {
        const extracted = extractCodexHitlRequest(
          item.arguments as Record<string, unknown> | undefined,
        );
        if (extracted) state.hitlRequest = extracted;
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Parse the `arguments` payload of a `hitl.request_human_input` MCP tool
 * call into a runtime-neutral {@link HumanInputRequest}. Returns
 * `undefined` when the payload is missing or has an empty `question`.
 *
 * Exported for testing.
 */
export function extractCodexHitlRequest(
  args: Record<string, unknown> | undefined,
): HumanInputRequest | undefined {
  if (!args) return undefined;
  const question = typeof args.question === "string"
    ? args.question.trim()
    : "";
  if (!question) return undefined;

  const options = Array.isArray(args.options)
    ? args.options
      .filter((entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null
      )
      .map((entry) => ({
        label: typeof entry.label === "string" ? entry.label : "",
        description: typeof entry.description === "string"
          ? entry.description
          : undefined,
      }))
      .filter((entry) => entry.label)
    : undefined;

  return {
    question,
    header: typeof args.header === "string" ? args.header : undefined,
    options: options && options.length > 0 ? options : undefined,
    multiSelect: typeof args.multiSelect === "boolean"
      ? args.multiSelect
      : undefined,
  };
}

/** Default Codex sessions directory: `$CODEX_HOME/sessions` or `~/.codex/sessions`. */
export function defaultCodexSessionsDir(): string {
  const codexHome = Deno.env.get("CODEX_HOME") ??
    join(Deno.env.get("HOME") ?? Deno.cwd(), ".codex");
  return join(codexHome, "sessions");
}

/**
 * Locate the persisted Codex rollout transcript file for a given thread id.
 *
 * Codex writes rollouts as
 * `<sessionsDir>/YYYY/MM/DD/rollout-<timestamp>-<thread_id>.jsonl`. The
 * directory layout reflects the run's start date, so the lookup walks
 * `<sessionsDir>/<year>/<month>/<day>` for the run's own start date and the
 * preceding day (covers UTC/local-midnight boundaries) before falling back
 * to a small recent-history scan.
 *
 * Returns the absolute path on success, or `undefined` if no matching file
 * is found (or the sessions dir does not exist).
 */
export async function findCodexSessionFile(
  threadId: string,
  startMs: number = Date.now(),
  sessionsDir: string = defaultCodexSessionsDir(),
): Promise<string | undefined> {
  if (!threadId) return undefined;
  try {
    await Deno.stat(sessionsDir);
  } catch {
    return undefined;
  }

  const suffix = `-${threadId}.jsonl`;
  const dates: string[] = [];
  for (
    let offsetMs = 0;
    offsetMs <= 24 * 3600 * 1000;
    offsetMs += 3600 * 1000
  ) {
    const d = new Date(startMs + offsetMs);
    dates.push(formatYmd(d));
    const back = new Date(startMs - offsetMs);
    dates.push(formatYmd(back));
  }
  const seen = new Set<string>();
  for (const ymd of dates) {
    if (seen.has(ymd)) continue;
    seen.add(ymd);
    const [y, m, d] = ymd.split("-");
    const dir = join(sessionsDir, y, m, d);
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (
          entry.isFile && entry.name.startsWith("rollout-") &&
          entry.name.endsWith(suffix)
        ) {
          return join(dir, entry.name);
        }
      }
    } catch {
      // Directory absent for this date — ignore and continue.
    }
  }
  return undefined;
}

function formatYmd(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, "0");
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
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
    hitl_request: state.hitlRequest,
  };
}

/**
 * Build a runtime-neutral {@link import("../runtime/types.ts").RuntimeToolUseInfo}
 * (sans `turn` and `runtime` fields, which the caller injects) from a Codex
 * `ThreadItem`. Returns `undefined` for non-tool items (`agent_message`,
 * `reasoning`, `error`, `todo_list` — the latter is a planning artefact,
 * not a tool invocation).
 *
 * Exported for testing.
 */
export function codexItemToToolUseInfo(
  // deno-lint-ignore no-explicit-any
  item: Record<string, any>,
): { id: string; name: string; input: Record<string, unknown> } | undefined {
  if (!item || typeof item !== "object") return undefined;
  const id = typeof item.id === "string" ? item.id : "";
  switch (item.type) {
    case "command_execution":
      return {
        id,
        name: "command_execution",
        input: {
          command: item.command,
          status: item.status,
          exit_code: item.exit_code,
        },
      };
    case "file_change":
      return {
        id,
        name: "file_change",
        input: { changes: item.changes, status: item.status },
      };
    case "mcp_tool_call":
      return {
        id,
        name: `${item.server ?? "?"}.${item.tool ?? "?"}`,
        input: { arguments: item.arguments, status: item.status },
      };
    case "web_search":
      return { id, name: "web_search", input: { query: item.query } };
    default:
      return undefined;
  }
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
        case "mcp_tool_call": {
          if (verbosity === "semi-verbose") return "";
          if (
            item.server === CODEX_HITL_MCP_SERVER_NAME &&
            item.tool === CODEX_HITL_MCP_TOOL_NAME
          ) {
            const q = (item.arguments as Record<string, unknown> | undefined)
              ?.question;
            return `[stream] hitl_request: ${typeof q === "string" ? q : "?"}`;
          }
          return `[stream] mcp: ${item.server ?? "?"}.${item.tool ?? "?"} (${
            item.status ?? "?"
          })`;
        }
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
        opts.onOutput,
        opts.streamLogPath,
        opts.verbosity,
        opts.cwd,
        opts.env,
        opts.onEvent,
        opts.signal,
        opts.hooks,
        opts.onToolUseObserved,
        opts.processRegistry,
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
  onOutput?: (line: string) => void,
  streamLogPath?: string,
  verbosity?: Verbosity,
  cwd?: string,
  env?: Record<string, string>,
  onEvent?: (event: Record<string, unknown>) => void,
  userSignal?: AbortSignal,
  hooks?: RuntimeLifecycleHooks,
  onToolUseObserved?: OnRuntimeToolUseObservedCallback,
  processRegistry?: ProcessRegistry,
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
  const registry = processRegistry ?? defaultRegistry;
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
      // deno-lint-ignore no-explicit-any
      event: Record<string, any>,
    ): Promise<void> => {
      onEvent?.(event);
      if (!initEmitted && event.type === "thread.started") {
        initEmitted = true;
        hooks?.onInit?.({
          runtime: "codex",
          sessionId: typeof event.thread_id === "string"
            ? event.thread_id
            : undefined,
        });
      }
      applyCodexEvent(event, state);

      // Tool-use observation hook — fires for `command_execution`,
      // `file_change`, `mcp_tool_call`, `web_search` once each (status
      // intermediate events are skipped via seenObservedIds).
      if (
        onToolUseObserved && event.type === "item.completed" && event.item
      ) {
        const info = codexItemToToolUseInfo(event.item);
        if (info && info.id && !seenObservedIds.has(info.id)) {
          seenObservedIds.add(info.id);
          let decision: RuntimeToolUseDecision = "allow";
          try {
            decision = await onToolUseObserved({
              runtime: "codex",
              id: info.id,
              name: info.name,
              input: info.input,
              turn: state.turnCount + 1,
            });
          } catch {
            decision = "abort";
          }
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
            if (!line.trim()) continue;
            try {
              // deno-lint-ignore no-explicit-any
              const event = JSON.parse(line) as Record<string, any>;
              await handleEvent(event);
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
        if (buffer.trim()) {
          try {
            // deno-lint-ignore no-explicit-any
            const event = JSON.parse(buffer) as Record<string, any>;
            await handleEvent(event);
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

    // Tool-use abort takes precedence: synthesize a denial output.
    if (state.denied) {
      return {
        runtime: "codex",
        result: state.denied.reason,
        session_id: state.threadId,
        total_cost_usd: 0,
        duration_ms: Math.max(0, Date.now() - state.startMs),
        duration_api_ms: 0,
        num_turns: state.turnCount,
        is_error: true,
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

function hasConfiguredHitl(config?: HitlConfig): config is HitlConfig {
  return Boolean(config?.ask_script && config?.check_script);
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
