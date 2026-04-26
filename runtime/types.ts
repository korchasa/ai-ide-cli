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
import type { ReasoningEffort } from "./reasoning-effort.ts";

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
  /**
   * Whether the adapter translates
   * {@link RuntimeInvokeOptions.allowedTools} /
   * {@link RuntimeInvokeOptions.disallowedTools} into a runtime-native
   * tool-filter flag. Adapters with `false` silently accept the field,
   * emit one `console.warn` on first use per process, and otherwise
   * ignore it. See FR-L24.
   */
  toolFilter: boolean;
  /**
   * Whether the adapter translates
   * {@link RuntimeInvokeOptions.reasoningEffort} /
   * {@link RuntimeSessionOptions.reasoningEffort} into a runtime-native
   * reasoning-effort control. Adapters with `false` silently accept the
   * field, emit one `console.warn` on first use per process, and
   * otherwise ignore it. Adapters with `true` may still warn on a lossy
   * mapping (e.g. Claude has no `"minimal"` level and substitutes
   * `"low"`). See FR-L25.
   */
  reasoningEffort: boolean;
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
  /**
   * Tool-name allow-list forwarded to runtimes with native support
   * (currently Claude → `--allowedTools`). Mutually exclusive with
   * {@link disallowedTools}. Tool-name grammar is owned by the runtime
   * (e.g. `"Bash(git *)"`, `"Edit"`); the library only enforces
   * "non-empty array of non-empty strings".
   *
   * Adapters with {@link RuntimeCapabilities.toolFilter} === `false`
   * accept the field, warn once per process via `console.warn`, and
   * ignore it otherwise. See FR-L24.
   */
  allowedTools?: string[];
  /** Tool-name deny-list — counterpart to {@link allowedTools}. See FR-L24. */
  disallowedTools?: string[];
  /**
   * Abstract depth of model reasoning for this call. Runtime-neutral:
   * every adapter maps it to its closest native control
   * (`--effort` on Claude, `--config model_reasoning_effort=…` on Codex,
   * `--variant` on OpenCode; ignored with a one-time warning on Cursor).
   *
   * Adapters with
   * {@link RuntimeCapabilities.reasoningEffort} === `false` accept the
   * field, warn once per process via `console.warn`, and ignore it
   * otherwise. Adapters with `true` may still warn on a lossy mapping
   * (Claude has no native `"minimal"` and substitutes `"low"`; OpenCode
   * forwards the value verbatim to the active provider whose
   * interpretation may differ). See FR-L25.
   */
  reasoningEffort?: ReasoningEffort;
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
 *
 * **Out of scope (by design):**
 *
 * - **Per-turn timeouts and retries.** A streaming session is a caller-owned
 *   stream. Unlike {@link RuntimeInvokeOptions} — which wraps a one-shot CLI
 *   call with `timeoutSeconds` / `maxRetries` / `retryDelaySeconds` — a
 *   session has no "turn" that the library can meaningfully time out and
 *   restart in place. If a turn hangs, the caller should cancel via
 *   {@link RuntimeSessionOptions.signal} (AbortSignal) and reopen the
 *   session with the captured `RuntimeSession.sessionId` as
 *   {@link RuntimeSessionOptions.resumeSessionId}.
 * - **Mid-session model / permission-mode / extraArgs changes.** Those flags
 *   are bound to the underlying subprocess at spawn time. Changing them
 *   requires reopening the session: close the current handle
 *   (`abort()` or `endInput()` + `await done`), then call `openSession`
 *   again, passing the previous session's `sessionId` as `resumeSessionId`
 *   to preserve the conversation history.
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
  /**
   * Tool-name allow-list. Same contract as
   * {@link RuntimeInvokeOptions.allowedTools} — see that field's JSDoc.
   */
  allowedTools?: string[];
  /**
   * Tool-name deny-list. Same contract as
   * {@link RuntimeInvokeOptions.disallowedTools} — see that field's JSDoc.
   */
  disallowedTools?: string[];
  /**
   * Abstract reasoning-effort depth. Same contract as
   * {@link RuntimeInvokeOptions.reasoningEffort} — see that field's JSDoc.
   */
  reasoningEffort?: ReasoningEffort;
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
 *
 * **Synthetic events.** Some events are injected by the adapter rather than
 * parsed from the runtime's stream — they carry `synthetic: true` and exist
 * to give consumers one cross-runtime handle to hook into. Synthetic events
 * are always emitted **after** the native event they summarize (the native
 * event still passes through untouched). Shipped synthetics:
 *
 * - {@link SYNTHETIC_TURN_END} (`type: "turn-end"`) — emitted by every
 *   adapter once per completed turn, right after the runtime signals
 *   readiness for the next input. `raw` carries the runtime's native
 *   turn-terminator payload (Claude: `result`; OpenCode: `session.idle`;
 *   Cursor: the subprocess's `result`; Codex: the `turn/completed`
 *   JSON-RPC notification). Callers who need richer per-runtime detail
 *   (success/error subtype, cost, etc.) read it out of `raw`.
 * - Cursor additionally pushes a synthetic `{type:"system", subtype:"init"}`
 *   at session open (Cursor has no native init event) and
 *   `{type:"error", subtype:"send_failed"}` when a per-turn subprocess
 *   exits non-zero. See [cursor/session.ts](../cursor/session.ts).
 *
 * Consumers that want to observe turn boundaries should match on the
 * synthetic event, not on runtime-native discriminators.
 */
export interface RuntimeSessionEvent {
  /** Runtime that produced the event. */
  runtime: RuntimeId;
  /** Event discriminator from the raw payload (`"system"`, `"assistant"`, `"result"`, …). */
  type: string;
  /** Raw event object as parsed from the runtime's event stream. */
  raw: Record<string, unknown>;
  /**
   * `true` when the adapter injected this event rather than receiving it
   * from the runtime's native stream. Absent (not `false`) for native
   * events — do not rely on the falsy path.
   */
  synthetic?: true;
}

/**
 * Neutral event type emitted by every adapter when the runtime signals the
 * end of an assistant turn (i.e. readiness to accept the next user input).
 *
 * Per-runtime source signal preserved in {@link RuntimeSessionEvent.raw}:
 *
 * - Claude: the native `result` stream event.
 * - OpenCode: the native `session.idle` event.
 * - Cursor: the per-turn subprocess's native `result` stream event.
 * - Codex: the `turn/completed` JSON-RPC notification
 *   (`raw.method === "turn/completed"`, params under `raw.params`).
 *
 * **Honesty note.** This event marks "runtime is ready for next input".
 * It is *not* a success/error verdict — OpenCode's `session.idle` fires
 * whether the turn finished cleanly or errored mid-stream, and detecting
 * failure across runtimes still requires inspecting prior events (or
 * `raw` on Claude/Cursor/Codex where a terminator subtype exists).
 */
export const SYNTHETIC_TURN_END = "turn-end" as const;

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
 *   `events` and `done`, not via the `send` promise. `send` rejects with a
 *   {@link SessionError} subclass:
 *
 *   - {@link SessionInputClosedError} when input was closed via
 *     {@link endInput};
 *   - {@link SessionAbortedError} when the session has been aborted;
 *   - {@link SessionDeliveryError} when the adapter failed to deliver the
 *     message to the runtime's transport (HTTP non-2xx for OpenCode, broken
 *     stdin pipe for Claude, JSON-RPC error for Codex, etc.).
 *
 *   Consumers should `catch (err)` and branch on `err instanceof …` to
 *   distinguish "reopen needed" (input-closed / aborted) from "transport
 *   error, investigate" (delivery). Matching by message prefix is
 *   discouraged — message wording is not part of the contract.
 * - `endInput()` signals "no more sends will come" and initiates graceful
 *   shutdown of the input channel. It returns promptly. Full-shutdown
 *   observation is `await session.done`.
 * - `abort(reason?)` is a best-effort forceful stop (SIGTERM or
 *   transport-specific equivalent). Idempotent.
 * - `events` is a single-consumer async iterable; re-iteration throws.
 *   Completes when the underlying transport terminates. Emits one
 *   {@link SYNTHETIC_TURN_END} event per completed turn so consumers can
 *   write a single cross-runtime turn-boundary handler (see
 *   {@link RuntimeSessionEvent} for details).
 * - `done` always resolves (never rejects) with {@link RuntimeSessionStatus}
 *   once the backing transport has fully terminated.
 *
 * Runtime-specific handles (e.g. `ClaudeSession`, `CursorSession`) may
 * expose additional fields such as `pid` or a runtime-native id alias
 * (`chatId`, `threadId`); cast to the concrete type when you need them.
 */
export interface RuntimeSession {
  /** Runtime that owns this session. */
  readonly runtime: RuntimeId;
  /**
   * Session identifier suitable for passing to
   * {@link RuntimeSessionOptions.resumeSessionId} on a subsequent
   * `openSession` call.
   *
   * **Population timing is runtime-specific — read carefully:**
   *
   * - OpenCode, Cursor, Codex: populated synchronously before
   *   `openSession()` resolves. Safe to persist immediately.
   * - Claude: the CLI allocates the id inside the subprocess and emits it
   *   in the first `system/init` event. The handle exposes an empty string
   *   (`""`) until that event is parsed, then updates in place. Consumers
   *   that need to persist the id for crash recovery should wait until
   *   the first event (the first {@link SYNTHETIC_TURN_END} or any prior
   *   event will do) before reading.
   *
   * This mirrors what the native CLIs actually guarantee — exposing a
   * Promise here would make the API feel asymmetric for the 3 adapters
   * that know the id synchronously.
   */
  readonly sessionId: string;
  /**
   * Push an additional user message into the running session. Resolves
   * when the runtime has accepted the input (not when the turn completes).
   * Rejects with a {@link SessionError} subclass — see the contract note
   * on the interface itself for which subclass fires when.
   */
  send(content: string): Promise<void>;
  /**
   * Async iterable of normalized session events. Completes when the
   * runtime's output stream closes. Can be iterated at most once. Includes
   * adapter-injected synthetics (see {@link RuntimeSessionEvent}).
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

/**
 * Base class for every error thrown by {@link RuntimeSession.send}. Adapter
 * implementations construct one of the three concrete subclasses so that
 * consumers can branch on `instanceof` instead of parsing message prefixes.
 *
 * `cause` (standard `Error.cause`) carries the underlying transport error
 * when one exists (e.g. the raw `fetch` failure for OpenCode, the
 * {@link import("../codex/app-server.ts").CodexAppServerError} for Codex).
 */
export class SessionError extends Error {
  /** Runtime that produced the error. */
  readonly runtime: RuntimeId;
  /**
   * Construct a new base session error. Subclasses pre-fill `message`
   * with a standard phrase; the base class is exposed for consumers that
   * want to rethrow a generic failure (rare — prefer a concrete subclass).
   *
   * @param runtime Runtime that produced the error.
   * @param message Human-readable failure description.
   * @param options Standard `ErrorOptions` — use `cause` to attach the
   *   underlying transport exception.
   */
  constructor(runtime: RuntimeId, message: string, options?: ErrorOptions) {
    super(message, options);
    this.runtime = runtime;
    this.name = "SessionError";
  }
}

/**
 * Thrown by {@link RuntimeSession.send} after {@link RuntimeSession.endInput}
 * has closed the input channel. Indicates programmer error on the consumer
 * side (or a race with a graceful shutdown); reopening the session is the
 * normal recovery path.
 */
export class SessionInputClosedError extends SessionError {
  /**
   * Construct a new input-closed error for the given runtime.
   *
   * @param runtime Runtime whose session rejected the send.
   * @param message Optional override; defaults to
   *   `"<runtime> session: input already closed"`.
   * @param options Standard `ErrorOptions`.
   */
  constructor(runtime: RuntimeId, message?: string, options?: ErrorOptions) {
    super(
      runtime,
      message ?? `${runtime} session: input already closed`,
      options,
    );
    this.name = "SessionInputClosedError";
  }
}

/**
 * Thrown by {@link RuntimeSession.send} after {@link RuntimeSession.abort}
 * (or an external `AbortSignal`) tore the session down. The consumer should
 * open a fresh session, passing the prior `sessionId` as `resumeSessionId`
 * to preserve the conversation.
 */
export class SessionAbortedError extends SessionError {
  /**
   * Construct a new aborted-session error for the given runtime.
   *
   * @param runtime Runtime whose session was aborted.
   * @param message Optional override; defaults to `"<runtime> session: aborted"`.
   * @param options Standard `ErrorOptions`.
   */
  constructor(runtime: RuntimeId, message?: string, options?: ErrorOptions) {
    super(runtime, message ?? `${runtime} session: aborted`, options);
    this.name = "SessionAbortedError";
  }
}

/**
 * Thrown by {@link RuntimeSession.send} when the adapter failed to put the
 * message on the runtime's transport — HTTP non-2xx (OpenCode), broken
 * stdin pipe (Claude / Codex app-server), JSON-RPC error (Codex), etc. The
 * session may or may not still be usable; the consumer should inspect
 * `cause` if it needs to decide whether to retry on the same handle or
 * reopen.
 */
export class SessionDeliveryError extends SessionError {
  /**
   * Construct a new delivery-failure error for the given runtime.
   *
   * @param runtime Runtime whose transport refused or failed to accept the send.
   * @param message Description of the delivery failure (e.g. HTTP status + body).
   * @param options Standard `ErrorOptions`; attach the underlying transport
   *   exception via `cause` so callers can branch on it.
   */
  constructor(runtime: RuntimeId, message: string, options?: ErrorOptions) {
    super(runtime, message, options);
    this.name = "SessionDeliveryError";
  }
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
   * Open a long-lived streaming-input session. Implemented by every
   * shipped adapter (Claude, OpenCode, Cursor faux, Codex app-server).
   * Callers MUST still check `capabilities.session` / that `openSession`
   * is defined so future adapters that opt out do not crash consumers.
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
  /** Effective reasoning-effort after precedence resolution (FR-L25 cascade). */
  reasoningEffort?: ReasoningEffort;
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
  /**
   * Reasoning-effort dial applied at this cascade level (FR-L25). Resolved by
   * {@link import("./index").resolveRuntimeConfig} into
   * {@link ResolvedRuntimeConfig.reasoningEffort}; consumers feed that value
   * into {@link RuntimeInvokeOptions.reasoningEffort} on the adapter call.
   */
  effort?: ReasoningEffort;
}
