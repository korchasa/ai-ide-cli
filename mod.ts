/**
 * @module
 * Public API of `@korchasa/ai-ide-cli` — a thin wrapper around agent-CLI
 * binaries (Claude Code, OpenCode) that normalizes invocation, streaming
 * NDJSON event parsing, retry, session resume, and HITL tool wiring.
 *
 * Claude-specific stream parsers (`processStreamEvent`, `FileReadTracker`,
 * `extractClaudeOutput`) are intentionally NOT re-exported here — they are
 * accessible via the sub-path `@korchasa/ai-ide-cli/claude/stream` for callers
 * that explicitly need Claude internals.
 */

// --- Runtime-neutral types ---
export type {
  CliRunOutput,
  HitlConfig,
  HumanInputOption,
  HumanInputRequest,
  PermissionDenial,
  PermissionMode,
  RuntimeId,
  Verbosity,
} from "./types.ts";
export { VALID_PERMISSION_MODES, VALID_RUNTIME_IDS } from "./types.ts";

// --- Runtime adapter layer ---
export { getRuntimeAdapter, resolveRuntimeConfig } from "./runtime/index.ts";
export type {
  InteractiveOptions,
  InteractiveResult,
  ResolvedRuntimeConfig,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeConfigSource,
  RuntimeInvokeOptions,
  RuntimeInvokeResult,
} from "./runtime/types.ts";

// --- Claude runner (public entry points only) ---
export { buildClaudeArgs, invokeClaudeCli } from "./claude/process.ts";
export type { ClaudeInvokeOptions } from "./claude/process.ts";

// --- Cursor runner ---
export {
  buildCursorArgs,
  extractCursorOutput,
  formatCursorEventForOutput,
  invokeCursorCli,
} from "./cursor/process.ts";

// --- Codex runner ---
export {
  applyCodexEvent,
  buildCodexArgs,
  createCodexRunState,
  extractCodexOutput,
  formatCodexEventForOutput,
  invokeCodexCli,
} from "./codex/process.ts";
export type { CodexRunState } from "./codex/process.ts";

// --- OpenCode runner ---
export {
  buildOpenCodeArgs,
  buildOpenCodeConfigContent,
  extractOpenCodeOutput,
  formatOpenCodeEventForOutput,
  invokeOpenCodeCli,
} from "./opencode/process.ts";

// --- OpenCode HITL MCP entry (required for consumer sub-process dispatch) ---
export {
  INTERNAL_OPENCODE_HITL_MCP_ARG,
  runOpenCodeHitlMcpServer,
} from "./opencode/hitl-mcp.ts";

// --- Skill model ---
export type { SkillDef, SkillFrontmatter } from "./skill/types.ts";
export { parseSkill } from "./skill/parser.ts";

// --- Process registry (pure tracker) ---
export {
  killAll,
  onShutdown,
  register,
  unregister,
} from "./process-registry.ts";
