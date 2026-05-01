import type {
  CliRunOutput,
  HitlConfig,
  RuntimeId,
  Verbosity,
} from "../types.ts";
import type { SkillDef } from "../skill/types.ts";
import type { ProcessRegistry } from "../process-registry.ts";
import type { OnCallbackError } from "./callback-safety.ts";
import type { SettingSource } from "./setting-sources.ts";
import type { ReasoningEffort } from "./reasoning-effort.ts";
import type {
  CapabilityInventory,
  FetchCapabilitiesOptions,
} from "./capabilities.ts";
import type {
  RuntimeCapabilities,
  RuntimeLifecycleHooks,
} from "./capability-types.ts";
import type { RuntimeSession, RuntimeSessionOptions } from "./session-types.ts";

/**
 * Map-shaped extra CLI arguments.
 *
 * Value semantics (matches `expandExtraArgs`):
 * - `""` (empty string) emits a bare boolean flag — `--key`.
 * - any other string emits a key/value pair — `--key value`.
 * - `null` suppresses the flag (useful when a downstream cascade level
 *   wants to override a parent-supplied value).
 *
 * Insertion order is preserved verbatim in argv, so callers control flag
 * ordering by controlling insertion order into the map.
 */
export type ExtraArgsMap = Record<string, string | null>;

/**
 * Info passed to the runtime-neutral observed-tool-use callback. Honored by
 * Claude, Codex, OpenCode, and Cursor — each reports the tool invocation
 * its CLI surfaces. Cursor parses `tool_call/started` events from
 * `cursor agent -p --output-format stream-json` (FR-L30).
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
  /**
   * Optional process tracker scope. When provided, child processes spawned
   * for this invocation are tracked in the supplied `ProcessRegistry`
   * instance instead of the package-wide default singleton. Embedding
   * applications that host multiple independent runtimes in one Deno
   * process (e.g. an operator chat session plus an active workflow run)
   * use this to scope `killAll()` and shutdown callbacks per logical run.
   * Falls back to the default singleton when omitted.
   */
  processRegistry?: ProcessRegistry;
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
   * level). See `ExtraArgsMap` for exact semantics and `expandExtraArgs`
   * for the expansion rules.
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
   * process MUST call `runOpenCodeHitlMcpServer`.
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
   * Fail-fast: if omitted and `hitlConfig` is set for a runtime that needs
   * the MCP helper, the runner throws with a clear error.
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
   * native events into the minimal `RuntimeInitInfo` / `CliRunOutput`
   * shape.
   */
  hooks?: RuntimeLifecycleHooks;
  /**
   * Observed-tool-use callback. Fires **post-dispatch but pre-next-turn**:
   * by the time the hook runs, the runtime has already invoked the tool.
   * Returning `"abort"` stops the run but cannot un-execute the tool.
   * Honored by Claude, Codex, OpenCode, and Cursor (FR-L30 — fires on
   * `tool_call/started`). Check `RuntimeCapabilities.toolUseObservation`
   * before relying on it.
   */
  onToolUseObserved?: OnRuntimeToolUseObservedCallback;
  /**
   * Filter the set of Claude configuration sources that apply to the run.
   * When omitted, Claude uses its default discovery (all sources). When
   * provided, the Claude adapter redirects `CLAUDE_CONFIG_DIR` to a
   * temporary dir populated from the listed sources (see
   * `prepareSettingSourcesDir`).
   *
   * Currently honored by the Claude adapter only; other adapters ignore.
   */
  settingSources?: SettingSource[];
  /**
   * Tool-name allow-list forwarded to runtimes with native support
   * (currently Claude → `--allowedTools`). Mutually exclusive with
   * `disallowedTools`. Tool-name grammar is owned by the runtime
   * (e.g. `"Bash(git *)"`, `"Edit"`); the library only enforces
   * "non-empty array of non-empty strings".
   *
   * Adapters with `RuntimeCapabilities.toolFilter` === `false` accept the
   * field, warn once per process via `console.warn`, and ignore it
   * otherwise. See FR-L24.
   */
  allowedTools?: string[];
  /** Tool-name deny-list — counterpart to `allowedTools`. See FR-L24. */
  disallowedTools?: string[];
  /**
   * Abstract depth of model reasoning for this call. Runtime-neutral:
   * every adapter maps it to its closest native control
   * (`--effort` on Claude, `--config model_reasoning_effort=…` on Codex,
   * `--variant` on OpenCode; ignored with a one-time warning on Cursor).
   *
   * Adapters with `RuntimeCapabilities.reasoningEffort` === `false` accept
   * the field, warn once per process via `console.warn`, and ignore it
   * otherwise. Adapters with `true` may still warn on a lossy mapping
   * (Claude has no native `"minimal"` and substitutes `"low"`; OpenCode
   * forwards the value verbatim to the active provider whose
   * interpretation may differ). See FR-L25.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Routed error sink for consumer-supplied notification callbacks
   * (`onEvent`, `onOutput`, `onToolUseObserved`, lifecycle hooks). Fires
   * when one of those callbacks throws so the streaming loop stays alive
   * but the bug is visible. When omitted, the default handler logs to
   * `console.warn` with a source tag and stack trace; supply a no-op
   * handler to opt out of the default. The handler MUST NOT throw — it
   * is itself wrapped in try/catch. See FR-L32.
   *
   * **`onToolUseObserved` semantics shift.** A throw from
   * `onToolUseObserved` no longer auto-aborts the run (the previous
   * behaviour was a footgun: a consumer typo silently produced a
   * `permission_denied` output). The decision now defaults to
   * `"allow"` and the throw is routed through `onCallbackError` with
   * source `"onToolUseObserved"`.
   */
  onCallbackError?: OnCallbackError;
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
   * `CapabilityInventory`. Expected latency is seconds-to-minutes and cost
   * is model-dependent; callers should cache results.
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
 * `resolveRuntimeConfig` to avoid depending on workflow-specific
 * `NodeConfig` / `WorkflowDefaults` types.
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
   * See `ExtraArgsMap` for value semantics.
   */
  runtime_args?: ExtraArgsMap;
  /**
   * Reasoning-effort dial applied at this cascade level (FR-L25). Resolved
   * by `resolveRuntimeConfig` into `ResolvedRuntimeConfig.reasoningEffort`;
   * consumers feed that value into `RuntimeInvokeOptions.reasoningEffort`
   * on the adapter call.
   */
  effort?: ReasoningEffort;
}
