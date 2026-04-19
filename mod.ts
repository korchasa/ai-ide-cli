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
export {
  expandExtraArgs,
  getRuntimeAdapter,
  resolveRuntimeConfig,
} from "./runtime/index.ts";
export type {
  ExtraArgsMap,
  InteractiveOptions,
  InteractiveResult,
  OnRuntimeToolUseObservedCallback,
  ResolvedRuntimeConfig,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeConfigSource,
  RuntimeInitInfo,
  RuntimeInvokeOptions,
  RuntimeInvokeResult,
  RuntimeLifecycleHooks,
  RuntimeSession,
  RuntimeSessionEvent,
  RuntimeSessionOptions,
  RuntimeSessionStatus,
  RuntimeToolUseDecision,
  RuntimeToolUseInfo,
} from "./runtime/types.ts";
export type { SettingSource } from "./runtime/setting-sources.ts";
export {
  CAPABILITY_INVENTORY_PROMPT,
  CAPABILITY_INVENTORY_SCHEMA,
  CAPABILITY_INVENTORY_SYSTEM_PROMPT,
  fetchInventoryViaInvoke,
  parseCapabilityInventoryResponse,
} from "./runtime/capabilities.ts";
export type {
  CapabilityInventory,
  CapabilityRef,
  FetchCapabilitiesOptions,
} from "./runtime/capabilities.ts";

// --- Claude runner (public entry points only) ---
export {
  buildClaudeArgs,
  CLAUDE_RESERVED_FLAGS,
  invokeClaudeCli,
} from "./claude/process.ts";
export type { ClaudeInvokeOptions } from "./claude/process.ts";
export type {
  ClaudeAssistantBlock,
  ClaudeAssistantEvent,
  ClaudeLifecycleHooks,
  ClaudeResultEvent,
  ClaudeStreamEvent,
  ClaudeSystemEvent,
  ClaudeTextBlock,
  ClaudeThinkingBlock,
  ClaudeToolUseBlock,
  ClaudeToolUseInfo,
  ClaudeUnknownEvent,
  ClaudeUserEvent,
  OnToolUseObservedCallback,
  ToolUseObservedDecision,
} from "./claude/stream.ts";
export { parseClaudeStreamEvent } from "./claude/stream.ts";
export { buildClaudeSessionArgs, openClaudeSession } from "./claude/session.ts";
export type {
  ClaudeSession,
  ClaudeSessionOptions,
  ClaudeSessionStatus,
  ClaudeSessionUserInput,
} from "./claude/session.ts";

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
  buildCodexHitlConfigArgs,
  CODEX_RESERVED_FLAGS,
  codexItemToToolUseInfo,
  createCodexRunState,
  defaultCodexSessionsDir,
  extractCodexHitlRequest,
  extractCodexOutput,
  findCodexSessionFile,
  formatCodexEventForOutput,
  invokeCodexCli,
  permissionModeToCodexArgs,
} from "./codex/process.ts";
export type { CodexRunState } from "./codex/process.ts";

// --- Codex HITL MCP entry (required for consumer sub-process dispatch) ---
export {
  CODEX_HITL_MCP_SERVER_NAME,
  CODEX_HITL_MCP_TOOL_NAME,
  INTERNAL_CODEX_HITL_MCP_ARG,
  runCodexHitlMcpServer,
} from "./codex/hitl-mcp.ts";

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
  OPENCODE_HITL_MCP_SERVER_NAME,
  OPENCODE_HITL_MCP_TOOL_NAME,
  runOpenCodeHitlMcpServer,
} from "./opencode/hitl-mcp.ts";

// --- Shared HITL MCP server primitives ---
export {
  normalizeHumanInputRequest,
  REQUEST_HUMAN_INPUT_TOOL,
  runHitlMcpServer,
} from "./hitl-mcp.ts";

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
