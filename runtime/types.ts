/**
 * Barrel for runtime-neutral type definitions. Splits the previous
 * monolithic file into four focused modules — see `runtime/AGENTS.md` for
 * placement rules:
 *
 * - `runtime/capability-types.ts` — capability flags + lifecycle hooks.
 * - `runtime/session-types.ts` — long-lived streaming session contract.
 * - `runtime/errors.ts` — typed `SessionError` family.
 * - `runtime/adapter-types.ts` — invocation options, adapter interface,
 *   resolved-config shapes.
 *
 * Re-exports are byte-identical at the symbol level to the previous file
 * so every existing `from "../runtime/types.ts"` import keeps working.
 */
export type {
  CliRunOutput,
  CliRunUsage,
  PermissionDenial,
  RuntimeId,
  Verbosity,
} from "../types.ts";
export type { ProcessRegistry } from "../process-registry.ts";
export type { SkillDef, SkillFrontmatter } from "../skill/types.ts";

export type {
  RuntimeCapabilities,
  RuntimeInitInfo,
  RuntimeLifecycleHooks,
} from "./capability-types.ts";

export type {
  RuntimeSession,
  RuntimeSessionEvent,
  RuntimeSessionOptions,
  RuntimeSessionStatus,
} from "./session-types.ts";

export { SYNTHETIC_TURN_END } from "./session-types.ts";

export {
  SessionAbortedError,
  SessionDeliveryError,
  SessionError,
  SessionInputClosedError,
} from "./errors.ts";

export type {
  ExtraArgsMap,
  InteractiveOptions,
  InteractiveResult,
  OnRuntimeToolUseObservedCallback,
  ResolvedRuntimeConfig,
  RuntimeAdapter,
  RuntimeConfigSource,
  RuntimeInvokeOptions,
  RuntimeInvokeResult,
  RuntimeToolUseDecision,
  RuntimeToolUseInfo,
} from "./adapter-types.ts";

export type {
  CapabilityInventory,
  CapabilityRef,
  FetchCapabilitiesOptions,
} from "./capabilities.ts";
export type { RuntimeErrorCategory } from "./error-types.ts";
export { ERROR_CATEGORY_STREAM_STALL } from "./error-types.ts";
export type {
  McpHttpServer,
  McpServers,
  McpServerSpec,
  McpStdioServer,
} from "./mcp-injection.ts";
export type { ReasoningEffort } from "./reasoning-effort.ts";
export type { SettingSource } from "./setting-sources.ts";
export type {
  CallbackErrorSource,
  OnCallbackError,
} from "./callback-safety.ts";

// FR-L37: reachable from the `runtime/types` sub-path because
// `RuntimeInvokeResult.runtime_error` references this type.
export type {
  RuntimeErrorAnalysis,
  RuntimeErrorAnalysisInput,
  RuntimeErrorConfidence,
  RuntimeErrorKind,
  RuntimeErrorSource,
} from "./runtime-error-analysis.ts";
