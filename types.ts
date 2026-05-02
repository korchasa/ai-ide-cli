/**
 * @module
 * Shared types for the `@korchasa/ai-ide-cli` library: runtime identifiers,
 * verbosity, and the normalized CLI run output shape.
 *
 * All types here are runtime-neutral; Claude- or OpenCode-specific details
 * (including Claude's `PermissionMode`, see `claude/permission-mode.ts`)
 * live inside their respective sub-modules.
 */

// --- Runtime ---

/** Supported agent runtime IDs. */
export type RuntimeId = "claude" | "opencode" | "cursor" | "codex";

/** All valid runtime IDs, used for config validation. */
export const VALID_RUNTIME_IDS: readonly RuntimeId[] = [
  "claude",
  "opencode",
  "cursor",
  "codex",
];

// --- Verbosity ---

/** Verbosity level for terminal output. */
export type Verbosity = "quiet" | "normal" | "semi-verbose" | "verbose";

// --- Permission denials ---

/** A single permission denial from an agent CLI JSON output. */
export interface PermissionDenial {
  /** Name of the tool that was denied (e.g. "Bash", "Edit"). */
  tool_name: string;
  /** Arguments passed to the denied tool invocation. */
  tool_input: Record<string, unknown>;
}

// --- Normalized CLI output ---

/**
 * Runtime-neutral per-run usage telemetry. All fields are optional because
 * runtimes report different subsets:
 *
 * - Claude: input/output tokens + cost.
 * - OpenCode: cost (no token counts on the event stream).
 * - Cursor: input/output/cached tokens (no cost).
 * - Codex: input/output/cached tokens (no cost).
 *
 * Consumers aggregating telemetry should branch on field presence rather
 * than treat `0` as "no data" — `0` is a real value (free turn). Absence
 * (`undefined`) means the runtime did not surface the figure.
 */
export interface CliRunUsage {
  /** Sum of input tokens across all turns of the run. */
  input_tokens?: number;
  /** Sum of output tokens across all turns of the run. */
  output_tokens?: number;
  /** Cached input tokens (prompt-cache hits) summed across turns. */
  cached_tokens?: number;
  /** Total cost in USD if the runtime reports it. */
  cost_usd?: number;
}

/**
 * Runtime-neutral output shape returned by the library's low-level runners.
 *
 * Each runtime's terminal event normalizes into this struct so downstream
 * code (engines, loggers, state machines) stays runtime-agnostic.
 *
 * `total_cost_usd` and `duration_api_ms` are optional: Cursor and Codex
 * emit no cost field, only Claude reports server-side latency.
 * Consumers that need cost / latency must guard against `undefined`. See
 * {@link CliRunUsage} for richer per-runtime token telemetry.
 */
export interface CliRunOutput {
  /** Runtime that produced this output. Optional for backward-compatible tests. */
  runtime?: RuntimeId;
  /** Agent's final text response. */
  result: string;
  /** Session ID for continuation and log correlation. */
  session_id: string;
  /**
   * Total API cost in USD for this invocation, when the runtime reports
   * one. `undefined` means the runtime emits no cost field (Cursor, Codex)
   * — distinguishable from a real free run (`0`).
   */
  total_cost_usd?: number;
  /** Wall-clock duration of the entire CLI run in milliseconds. */
  duration_ms: number;
  /**
   * Time spent waiting for API responses in milliseconds, when the runtime
   * reports it. Currently only Claude's `result` event surfaces this.
   * `undefined` for runtimes that do not split server vs. client time.
   */
  duration_api_ms?: number;
  /** Number of conversational turns in this session. */
  num_turns: number;
  /** Whether the CLI exited with an error condition. */
  is_error: boolean;
  /** Per-run token / cost telemetry (see {@link CliRunUsage}). */
  usage?: CliRunUsage;
  /** Tools the agent tried to use but was denied permission for. */
  permission_denials?: PermissionDenial[];
  /**
   * Absolute path to the runtime's persisted session transcript file, when
   * the runtime exposes one (Codex writes a NDJSON rollout to
   * `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl`). Consumers
   * can copy or stream this file as the canonical conversation log. Absent
   * for runtimes without a discoverable transcript.
   *
   * **Distinguishing "unsupported" vs. "export failed":** `transcript_path
   * === undefined` means EITHER (a) the runtime exposes no transcript
   * (Cursor) OR (b) export was attempted but failed. Branch on
   * {@link transcript_error} to disambiguate (FR-L32).
   */
  transcript_path?: string;
  /**
   * Diagnostic message set when the runtime supports transcript export but
   * the export itself failed (e.g. `opencode export <id>` exited non-zero,
   * Codex rollout dir missing, or the FS write failed). When present,
   * {@link transcript_path} stays `undefined`. Absent for runtimes without
   * transcript support and on successful exports. Surfaced under FR-L32
   * — previously failures were swallowed silently.
   */
  transcript_error?: string;
}
