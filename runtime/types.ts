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
