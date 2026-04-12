import type {
  CliRunOutput,
  HitlConfig,
  RuntimeId,
  Verbosity,
} from "../types.ts";
import type { SkillDef } from "../skill/types.ts";

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
}

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
  /** Additional CLI flags forwarded to the runtime. */
  extraArgs?: string[];
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
}

/** Effective runtime configuration after defaults/parent/node resolution. */
export interface ResolvedRuntimeConfig {
  /** Selected runtime ID. */
  runtime: RuntimeId;
  /** Effective extra CLI args for the selected runtime. */
  args: string[];
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
  /** Generic extra CLI args forwarded to any runtime. */
  runtime_args?: string[];
}
