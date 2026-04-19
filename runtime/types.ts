import type {
  CliRunOutput,
  HitlConfig,
  RuntimeId,
  Verbosity,
} from "../types.ts";
import type { SkillDef } from "../skill/types.ts";
import type { SettingSource } from "./setting-sources.ts";
import type {
  CapabilityInventory,
  FetchCapabilitiesOptions,
} from "./capabilities.ts";

/**
 * Map-shaped extra CLI arguments.
 *
 * Value semantics (matches {@link import("./index").expandExtraArgs}):
 * - `""` (empty string) emits a bare boolean flag — `--key`.
 * - any other string emits a key/value pair — `--key value`.
 * - `null` suppresses the flag (useful when a downstream cascade level
 *   wants to override a parent-supplied value).
 *
 * Insertion order is preserved verbatim in argv, so callers control flag
 * ordering by controlling insertion order into the map.
 */
export type ExtraArgsMap = Record<string, string | null>;

/** Capability flags advertised by a runtime adapter. */
export interface RuntimeCapabilities {
  /** Whether the runtime supports a first-class permission mode flag. */
  permissionMode: boolean;
  /** Whether the runtime supports engine-managed HITL resume flow. */
  hitl: boolean;
  /** Whether the runtime provides an external transcript file the engine can copy. */
  transcript: boolean;
  /** Whether the runtime supports interactive CLI mode (stdin-based REPL). */
  interactive: boolean;
  /**
   * Whether the runtime surfaces a per-tool-use observation hook
   * (`onToolUseObserved`). Claude, Codex, and OpenCode expose it;
   * Cursor does not (its CLI emits no tool events).
   */
  toolUseObservation: boolean;
  /**
   * Whether the runtime supports a long-lived session with streaming user
   * input (i.e. `openSession`). Implemented by every registered adapter
   * (Claude, OpenCode, Cursor faux, Codex app-server). Callers should still
   * check the flag (and that `openSession` is defined) before invoking —
   * future adapters may opt out.
   */
  session: boolean;
  /**
   * Whether the runtime implements {@link RuntimeAdapter.fetchCapabilitiesSlow}
   * for enumerating skills and slash commands via an LLM prompt.
   */
  capabilityInventory: boolean;
}

/**
 * Info passed to the runtime-neutral `onInit` lifecycle hook.
 * Each adapter translates its native init event into this minimal shape.
 */
export interface RuntimeInitInfo {
  /** Runtime that produced the init event. */
  runtime: RuntimeId;
  /** Active model identifier, if the runtime exposes one. */
  model?: string;
  /** Session/thread ID assigned by the runtime, if known at init time. */
  sessionId?: string;
}

/**
 * Runtime-neutral lifecycle hooks invoked by every adapter (with
 * best-effort translation from each runtime's native events).
 */
export interface RuntimeLifecycleHooks {
  /** Fires once at session start. */
  onInit?: (info: RuntimeInitInfo) => void;
  /** Fires exactly once after the run terminates with its final output. */
  onResult?: (output: CliRunOutput) => void;
}

/**
 * Info passed to the runtime-neutral observed-tool-use callback. Honored by
 * Claude, Codex, and OpenCode (each reports the tool invocation its CLI
 * surfaces); Cursor ignores the hook because its CLI does not emit tool
 * events.
 */
export interface RuntimeToolUseInfo {
  /** Runtime that dispatched the tool. */
  runtime: RuntimeId;
  /** Unique tool invocation id from the runtime event. */
  id: string;
  /** Tool name (e.g. "Read", "Bash"). */
  name: string;
  /** Tool input map (opaque, preserved verbatim). */
  input?: Record<string, unknown>;
  /** Current assistant turn index (1-based). */
  turn: number;
}

/** Decision returned from a runtime-neutral observed-tool-use callback. */
export type RuntimeToolUseDecision = "allow" | "abort";

/** Runtime-neutral observed-tool-use callback. */
export type OnRuntimeToolUseObservedCallback = (
  info: RuntimeToolUseInfo,
) => RuntimeToolUseDecision | Promise<RuntimeToolUseDecision>;

/** Low-level options for a single runtime invocation (initial or resume). */
export interface RuntimeInvokeOptions {
  /** Optional runtime-native agent selector. */
  agent?: string;
  /** Optional system prompt content for the invocation. */
  systemPrompt?: string;
  /** User task prompt passed to the runtime. */
  taskPrompt: string;
  /** Existing session ID for continuation/resume. */
  resumeSessionId?: string;
  /**
   * Additional CLI flags forwarded to the runtime.
   *
   * Map-shape: `{ "--flag": "value" }`, `{ "--bool": "" }` (boolean flag),
   * `{ "--inherited": null }` (suppress a flag set by a parent cascade
   * level). See {@link ExtraArgsMap} for exact semantics and
   * {@link import("./index").expandExtraArgs} for the expansion rules.
   *
   * Each runtime reserves the flags it emits itself (e.g. Claude reserves
   * `--output-format`, `--verbose`, `-p`, `--resume`, …). Passing a
   * reserved key throws at invocation time.
   */
  extraArgs?: ExtraArgsMap;
  /** Runtime-specific permission mode. */
  permissionMode?: string;
  /** Model identifier understood by the selected runtime. */
  model?: string;
  /** Max seconds before the runtime process is terminated. */
  timeoutSeconds: number;
  /** Max retry attempts on runtime error or crash. */
  maxRetries: number;
  /** Base delay between retries in seconds. */
  retryDelaySeconds: number;
  /**
   * External cancellation signal. When aborted, the runtime's underlying
   * subprocess receives SIGTERM, retry loops exit immediately, and the
   * adapter returns `{ error: "Aborted: <reason>" }` without attempting
   * further retries. Combined with the internal timeout signal via
   * `AbortSignal.any` (requires Deno ≥ 1.39).
   */
  signal?: AbortSignal;
  /** Callback for streaming terminal output. */
  onOutput?: (line: string) => void;
  /** Optional path for the runtime stream log file. */
  streamLogPath?: string;
  /** Terminal verbosity level used by stream formatting. */
  verbosity?: Verbosity;
  /** Workflow HITL configuration used by runtimes that need extra tool wiring. */
  hitlConfig?: HitlConfig;
  /**
   * HITL MCP sub-process command builder for runtimes that host an auxiliary
   * stdio MCP server (currently only OpenCode).
   *
   * Consumer (engine) supplies a zero-argument function that returns an
   * `argv` array the runtime spawns to run the MCP HITL server. The spawned
   * process MUST call
   * {@link import("./opencode/hitl-mcp").runOpenCodeHitlMcpServer}.
   *
   * Example:
   * ```ts
   * hitlMcpCommandBuilder: () => [
   *   Deno.execPath(), "run", "-A",
   *   import.meta.resolve("./cli.ts"),
   *   "--internal-opencode-hitl-mcp",
   * ]
   * ```
   *
   * Fail-fast: if omitted and {@link hitlConfig} is set for a runtime that
   * needs the MCP helper, the runner throws with a clear error.
   */
  hitlMcpCommandBuilder?: () => string[];
  /** Working directory for the runtime subprocess. */
  cwd?: string;
  /** Extra environment variables merged into the subprocess env. */
  env?: Record<string, string>;
  /**
   * Callback invoked with every raw NDJSON event object before any filtering
   * or extraction. Consumer decides what to keep (init metadata, token stats,
   * etc.).
   */
  onEvent?: (event: Record<string, unknown>) => void;
  /**
   * Typed runtime-neutral lifecycle hooks. Each adapter translates its
   * native events into the minimal {@link RuntimeInitInfo} /
   * {@link CliRunOutput} shape.
   */
  hooks?: RuntimeLifecycleHooks;
  /**
   * Observed-tool-use callback. Fires **post-dispatch but pre-next-turn**:
   * by the time the hook runs, the runtime has already invoked the tool.
   * Returning `"abort"` stops the run but cannot un-execute the tool.
   * Honored by Claude, Codex, and OpenCode; Cursor silently ignores the
   * callback (its CLI surfaces no tool events). Check
   * {@link RuntimeCapabilities.toolUseObservation} before relying on it.
   */
  onToolUseObserved?: OnRuntimeToolUseObservedCallback;
  /**
   * Filter the set of Claude configuration sources that apply to the run.
   * When omitted, Claude uses its default discovery (all sources). When
   * provided, the Claude adapter redirects `CLAUDE_CONFIG_DIR` to a
   * temporary dir populated from the listed sources (see
   * {@link import("./setting-sources").prepareSettingSourcesDir}).
   *
   * Currently honored by the Claude adapter only; other adapters ignore.
   */
  settingSources?: SettingSource[];
}

/** Result returned by a runtime adapter invocation. */
export interface RuntimeInvokeResult {
  /** Normalized runtime output when invocation produced structured output. */
  output?: CliRunOutput;
  /** Human-readable error when the invocation failed. */
  error?: string;
}

/** Options for launching an interactive CLI session with bundled skills. */
export interface InteractiveOptions {
  /** Skills to inject into the runtime's discovery path. */
  skills?: SkillDef[];
  /** System prompt content for the interactive session. */
  systemPrompt?: string;
  /** Working directory for the interactive session. */
  cwd?: string;
  /** Extra environment variables for the subprocess. */
  env?: Record<string, string>;
}

/** Result returned by an interactive session after it exits. */
export interface InteractiveResult {
  /** Process exit code. */
  exitCode: number;
}

/**
 * Options for opening a runtime-neutral streaming session via
 * {@link RuntimeAdapter.openSession}. Mirrors {@link RuntimeInvokeOptions} but
 * omits one-shot fields (`taskPrompt`, retries, timeouts, hooks) that do not
 * apply to a long-lived session. Adapters that do not recognize a field
 * ignore it (e.g. non-Claude runtimes ignore `settingSources`).
 */
export interface RuntimeSessionOptions {
  /** Optional runtime-native agent selector. */
  agent?: string;
  /** Optional system prompt content for the session. */
  systemPrompt?: string;
  /** Existing session ID to resume. */
  resumeSessionId?: string;
  /**
   * Additional CLI flags forwarded to the runtime. Each runtime reserves its
   * own transport flags; passing a reserved key throws synchronously. See
   * {@link ExtraArgsMap} for value semantics.
   */
  extraArgs?: ExtraArgsMap;
  /** Runtime-specific permission mode. */
  permissionMode?: string;
  /** Model identifier understood by the selected runtime. */
  model?: string;
  /**
   * External cancellation signal. On abort, the subprocess receives SIGTERM
   * and the session's `done` promise resolves.
   */
  signal?: AbortSignal;
  /** Working directory for the runtime subprocess. */
  cwd?: string;
  /** Extra environment variables merged into the subprocess env. */
  env?: Record<string, string>;
  /** Claude-specific configuration-source filter. Ignored by other runtimes. */
  settingSources?: SettingSource[];
  /** Fires for every parsed event from the runtime's event stream, in order. */
  onEvent?: (event: RuntimeSessionEvent) => void;
  /** Fires for every decoded stderr chunk (may be empty on a flush). */
  onStderr?: (line: string) => void;
}

/**
 * Runtime-neutral session event. The `type` and `raw` fields preserve the
 * runtime's native event shape verbatim; consumers that need typed access to
 * runtime-specific payloads should cast `raw` or use the runtime's own
 * helper (e.g. {@link import("../claude/session").openClaudeSession}).
 */
export interface RuntimeSessionEvent {
  /** Runtime that produced the event. */
  runtime: RuntimeId;
  /** Event discriminator from the raw payload (`"system"`, `"assistant"`, `"result"`, …). */
  type: string;
  /** Raw event object as parsed from the runtime's event stream. */
  raw: Record<string, unknown>;
}

/** Terminal state of a runtime session subprocess. */
export interface RuntimeSessionStatus {
  /** OS exit code when exited normally, `null` when killed by signal. */
  exitCode: number | null;
  /** Termination signal name when killed by signal, `null` otherwise. */
  signal: string | null;
  /** Aggregated stderr text captured during the session. */
  stderr: string;
}

/**
 * Live handle for a runtime subprocess in streaming-input mode.
 *
 * Lifecycle: open → zero or more `send` / `events` iterations → `endInput`
 * (graceful) or `abort` (SIGTERM) → `done` resolves. Adapters translate the
 * runtime's native event stream into {@link RuntimeSessionEvent} while
 * preserving the raw payload for consumers that need it.
 *
 * Contract (uniform across all adapters):
 *
 * - `send(content)` resolves once the runtime has **accepted** the input.
 *   It does NOT wait for the runtime to finish processing the turn.
 *   Transport/runtime errors surfaced during turn processing arrive via
 *   `events` and `done`, not via the `send` promise. `send` throws only
 *   when input has been closed (`endInput`), the session is aborted, or
 *   the adapter fails to deliver the message (e.g. HTTP non-2xx for
 *   OpenCode).
 * - `endInput()` signals "no more sends will come" and initiates graceful
 *   shutdown of the input channel. It returns promptly. Full-shutdown
 *   observation is `await session.done`.
 * - `abort(reason?)` is a best-effort forceful stop (SIGTERM or
 *   transport-specific equivalent). Idempotent.
 * - `events` is a single-consumer async iterable; re-iteration throws.
 *   Completes when the underlying transport terminates.
 * - `done` always resolves (never rejects) with {@link RuntimeSessionStatus}
 *   once the backing transport has fully terminated.
 *
 * Runtime-specific handles (e.g. `ClaudeSession`, `CursorSession`) may
 * expose additional fields such as `pid` or a native session id; cast
 * to the concrete type when you need them.
 */
export interface RuntimeSession {
  /** Runtime that owns this session. */
  readonly runtime: RuntimeId;
  /**
   * Push an additional user message into the running session. Resolves
   * when the runtime has accepted the input (not when the turn completes).
   * Throws if input has been closed, the session has been aborted, or the
   * adapter fails to deliver the message.
   */
  send(content: string): Promise<void>;
  /**
   * Async iterable of normalized session events. Completes when the
   * runtime's output stream closes. Can be iterated at most once.
   */
  readonly events: AsyncIterable<RuntimeSessionEvent>;
  /**
   * Signal no more sends will arrive; initiate graceful shutdown.
   * Returns promptly — await {@link done} for full termination.
   */
  endInput(): Promise<void>;
  /** SIGTERM (or transport-equivalent). Idempotent. */
  abort(reason?: string): void;
  /** Resolves with terminal status when the backing transport exits. */
  readonly done: Promise<RuntimeSessionStatus>;
}

/** Adapter interface implemented by each supported runtime. */
export interface RuntimeAdapter {
  /** Stable runtime identifier. */
  id: RuntimeId;
  /** Capability metadata used by config validation and HITL flow. */
  capabilities: RuntimeCapabilities;
  /** Invoke the runtime with normalized options. */
  invoke(opts: RuntimeInvokeOptions): Promise<RuntimeInvokeResult>;
  /**
   * Launch an interactive CLI session with injected skills.
   * Adapters that do not support interactive mode throw an error.
   */
  launchInteractive(opts: InteractiveOptions): Promise<InteractiveResult>;
  /**
   * Open a long-lived streaming-input session. Only implemented by adapters
   * with `capabilities.session === true` (currently: Claude). Callers MUST
   * check the capability flag or be prepared for `undefined`.
   */
  openSession?(opts: RuntimeSessionOptions): Promise<RuntimeSession>;
  /**
   * **Expensive** — spawns the IDE CLI and consumes one full LLM turn per
   * call. Asks the runtime's agent to emit a JSON list of every skill and
   * slash command currently available, then parses the reply into a
   * {@link CapabilityInventory}. Expected latency is seconds-to-minutes
   * and cost is model-dependent; callers should cache results.
   *
   * Only implemented by adapters with
   * `capabilities.capabilityInventory === true`. Callers MUST check the
   * flag or be prepared for `undefined`.
   *
   * Throws when the runtime returns a response that cannot be parsed into
   * the expected shape.
   */
  fetchCapabilitiesSlow?(
    opts?: FetchCapabilitiesOptions,
  ): Promise<CapabilityInventory>;
}

/** Effective runtime configuration after defaults/parent/node resolution. */
export interface ResolvedRuntimeConfig {
  /** Selected runtime ID. */
  runtime: RuntimeId;
  /** Effective map-shaped extra CLI args for the selected runtime. */
  args: ExtraArgsMap;
  /** Effective model value after precedence resolution. */
  model?: string;
  /** Effective permission mode after precedence resolution. */
  permissionMode?: string;
}

/**
 * Minimal structural shape of a runtime-config carrier, used by
 * {@link import("./index").resolveRuntimeConfig} to avoid depending on
 * workflow-specific `NodeConfig` / `WorkflowDefaults` types.
 *
 * Consumer types (engine `NodeConfig`, `WorkflowDefaults`, etc.) that expose
 * these fields structurally satisfy the interface and can be passed directly.
 */
export interface RuntimeConfigSource {
  /** Runtime ID selected by this level of the config cascade. */
  runtime?: RuntimeId;
  /** Model identifier applied at this cascade level. */
  model?: string;
  /** Permission mode applied at this cascade level (runtime-specific). */
  permission_mode?: string;
  /**
   * Generic map-shaped extra CLI args forwarded to any runtime.
   * See {@link ExtraArgsMap} for value semantics.
   */
  runtime_args?: ExtraArgsMap;
}
