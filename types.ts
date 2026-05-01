/**
 * @module
 * Shared types for the `@korchasa/ai-ide-cli` library: runtime identifiers,
 * verbosity, HITL request shapes, normalized CLI run output, and HITL
 * config contract.
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

// --- HITL human input request ---

/** One selectable answer option in a human-input request. */
export interface HumanInputOption {
  /** User-visible option label. */
  label: string;
  /** Optional explanatory text shown alongside the label. */
  description?: string;
}

/** Runtime-normalized human-input request emitted by Claude or OpenCode. */
export interface HumanInputRequest {
  /** Main question text to present to the operator. */
  question: string;
  /** Optional heading displayed above the question. */
  header?: string;
  /** Optional list of predefined answer choices. */
  options?: HumanInputOption[];
  /** Whether multiple options may be selected. */
  multiSelect?: boolean;
}

// --- Normalized CLI output ---

/**
 * Runtime-neutral output shape returned by the library's low-level runners.
 *
 * Both Claude's `stream-json` `result` event and OpenCode's JSONL event
 * stream normalize into this struct so downstream code (engines, loggers,
 * state machines) stays runtime-agnostic.
 */
export interface CliRunOutput {
  /** Runtime that produced this output. Optional for backward-compatible tests. */
  runtime?: RuntimeId;
  /** Agent's final text response. */
  result: string;
  /** Session ID for continuation and log correlation. */
  session_id: string;
  /** Total API cost in USD for this invocation. */
  total_cost_usd: number;
  /** Wall-clock duration of the entire CLI run in milliseconds. */
  duration_ms: number;
  /** Time spent waiting for API responses in milliseconds. */
  duration_api_ms: number;
  /** Number of conversational turns in this session. */
  num_turns: number;
  /** Whether the CLI exited with an error condition. */
  is_error: boolean;
  /** Tools the agent tried to use but was denied permission for. */
  permission_denials?: PermissionDenial[];
  /** Runtime-normalized human-input request captured from a structured tool call. */
  hitl_request?: HumanInputRequest;
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

// --- HITL Configuration ---

/**
 * Human-in-the-loop configuration. Runtimes that need to inject external
 * tooling (e.g. OpenCode's local MCP server) read this struct to decide
 * whether to enable HITL wiring for a given invocation.
 */
export interface HitlConfig {
  /** Script invoked to post a question to the human operator. */
  ask_script: string;
  /** Script polled to check if the human has responded. */
  check_script: string;
  /** Relative path from run_dir to artifact containing issue frontmatter. */
  artifact_source?: string;
  /** Seconds between consecutive polls of check_script (default 60). */
  poll_interval: number;
  /** Maximum seconds to wait for a human response before timing out (default 7200). */
  timeout: number;
  /** Login name to exclude from HITL responses (e.g. bot's own login). */
  exclude_login?: string;
}
