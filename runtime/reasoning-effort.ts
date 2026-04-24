/**
 * @module
 * Shared validation for the abstract reasoning-effort option (FR-L25).
 *
 * `reasoningEffort` on {@link RuntimeInvokeOptions} and
 * {@link RuntimeSessionOptions} is a runtime-neutral dial that every adapter
 * maps to its closest native control:
 *
 * - **Claude** → `--effort <value>`; `"minimal"` has no native equivalent
 *   and is mapped to `"low"` with a one-time console warning.
 * - **Codex** → `--config model_reasoning_effort=<value>`; 1:1 for every
 *   abstract value (Codex accepts `minimal | low | medium | high`).
 * - **OpenCode** → prompt body / `--variant <value>`; the value is
 *   forwarded verbatim. Provider-specific interpretation may or may not
 *   match the requested depth — a one-time console warning is emitted on
 *   first use per process.
 * - **Cursor** → no native reasoning-effort control; the field is ignored
 *   with a one-time console warning. Consumers should check
 *   `capabilities.reasoningEffort` before relying on the field.
 *
 * The validator runs on every adapter (not only on runtimes with native
 * support) so YAML-driven consumers see a uniform error for malformed
 * input regardless of which runtime they target.
 */

import type { RuntimeId } from "../types.ts";
import type { RuntimeInvokeOptions } from "./types.ts";

/**
 * Abstract reasoning-effort levels exposed by the library.
 *
 * Four ordered steps (ascending depth). Chosen to match Codex's native
 * `model_reasoning_effort` enum so the most precise mapping is 1:1; other
 * runtimes (Claude, OpenCode, Cursor) are handled per-adapter with
 * best-effort translation + warnings.
 */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/** All valid reasoning-effort values, used for runtime validation. */
export const REASONING_EFFORT_VALUES: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
];

/**
 * CLI flag names / `extraArgs` keys that express reasoning effort natively
 * on each runtime. Collide with the typed
 * {@link RuntimeInvokeOptions.reasoningEffort} field when set — see
 * {@link validateReasoningEffort}.
 *
 * Does NOT include Codex's `--config model_reasoning_effort=…` form because
 * it is expressed as a `key=value` payload on the generic `--config` flag,
 * which is not rejectable at the `extraArgs` key level without deep
 * value-parsing. Callers mixing `reasoningEffort` with a matching
 * `--config model_reasoning_effort=…` entry get the adapter's native flag
 * plus their own — the runtime de-duplicates to the last one. Document,
 * don't police.
 */
export const REASONING_EFFORT_FLAGS: readonly string[] = [
  "--effort",
  "--variant",
];

/** Subset of invocation / session options relevant to the validator. */
export type ReasoningEffortInput = Pick<
  RuntimeInvokeOptions,
  "reasoningEffort" | "extraArgs"
>;

/**
 * Validate the typed reasoning-effort field and its interaction with
 * `extraArgs`. Throws synchronously on misuse; returns the effort value
 * (or `undefined` when unset) for the caller to branch on during argv /
 * request-body emission.
 *
 * Contract (uniform across all four adapters — catches malformed input
 * even on runtimes that do not translate the field to a native control):
 *
 * - Value must be one of {@link REASONING_EFFORT_VALUES} → else throw.
 * - Typed field set AND any {@link REASONING_EFFORT_FLAGS} key in
 *   `extraArgs` → throw.
 *
 * @param runtime Runtime identifier (used in error messages for
 *   attribution).
 * @param opts Options subset carrying the typed field and optional
 *   `extraArgs`.
 */
export function validateReasoningEffort(
  runtime: RuntimeId,
  opts: ReasoningEffortInput,
): ReasoningEffort | undefined {
  const value = opts.reasoningEffort;
  if (value === undefined) return undefined;

  if (!REASONING_EFFORT_VALUES.includes(value)) {
    throw new Error(
      `${runtime}: reasoningEffort must be one of ${
        REASONING_EFFORT_VALUES.join(" | ")
      } (got ${JSON.stringify(value)})`,
    );
  }

  if (opts.extraArgs) {
    for (const key of REASONING_EFFORT_FLAGS) {
      if (key in opts.extraArgs) {
        throw new Error(
          `${runtime}: extraArgs key "${key}" collides with typed reasoningEffort — remove one`,
        );
      }
    }
  }

  return value;
}
