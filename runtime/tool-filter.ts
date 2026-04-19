/**
 * @module
 * Shared validation for typed tool-filter options on
 * {@link RuntimeInvokeOptions} and {@link RuntimeSessionOptions} (FR-L24).
 *
 * Runs on **every** adapter (not only Claude) so YAML-driven consumers see
 * the same errors for malformed input regardless of runtime. Adapters
 * without native tool filtering still skip the argv emission and warn once
 * (see each adapter's module-level `warnToolFilterOnce`).
 */

import type { RuntimeId } from "../types.ts";
import type { RuntimeInvokeOptions } from "./types.ts";

/**
 * Claude CLI flags that express tool filtering. Collide with the typed
 * {@link RuntimeInvokeOptions.allowedTools} /
 * {@link RuntimeInvokeOptions.disallowedTools} fields when set — see
 * {@link validateToolFilter}.
 */
export const TOOL_FILTER_FLAGS: readonly string[] = [
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--tools",
];

/** Subset of invocation / session options relevant to the validator. */
export type ToolFilterInput = Pick<
  RuntimeInvokeOptions,
  "allowedTools" | "disallowedTools" | "extraArgs"
>;

/** Discriminator returned by a successful {@link validateToolFilter} call. */
export type ToolFilterMode = "allowed" | "disallowed" | undefined;

/**
 * Validate the typed tool-filter fields and their interaction with
 * `extraArgs`. Throws synchronously on misuse; returns `"allowed"` /
 * `"disallowed"` / `undefined` for the caller to branch on during argv
 * emission.
 *
 * Contract (uniform across all four adapters — catches malformed input
 * even on runtimes that do not emit the argv):
 * - Setting both `allowedTools` and `disallowedTools` → throw.
 * - Empty array or empty-string members → throw.
 * - Typed field set AND any {@link TOOL_FILTER_FLAGS} key in
 *   `extraArgs` → throw.
 * - Otherwise return the discriminator (or `undefined` when neither
 *   typed field is set).
 *
 * @param runtime Runtime identifier (used in error messages for
 *   attribution).
 * @param opts Options subset carrying the typed fields and optional
 *   `extraArgs`.
 */
export function validateToolFilter(
  runtime: RuntimeId,
  opts: ToolFilterInput,
): ToolFilterMode {
  const hasAllow = opts.allowedTools !== undefined;
  const hasDisallow = opts.disallowedTools !== undefined;

  if (hasAllow && hasDisallow) {
    throw new Error(
      `${runtime}: allowedTools and disallowedTools are mutually exclusive — pass at most one`,
    );
  }

  const fieldName = hasAllow ? "allowedTools" : "disallowedTools";
  const field = hasAllow ? opts.allowedTools : opts.disallowedTools;

  if (field !== undefined) {
    if (!Array.isArray(field) || field.length === 0) {
      throw new Error(
        `${runtime}: ${fieldName} must be a non-empty string[]`,
      );
    }
    for (const t of field) {
      if (typeof t !== "string" || t.length === 0) {
        throw new Error(
          `${runtime}: ${fieldName} must contain only non-empty strings`,
        );
      }
    }
    if (opts.extraArgs) {
      for (const key of TOOL_FILTER_FLAGS) {
        if (key in opts.extraArgs) {
          throw new Error(
            `${runtime}: extraArgs key "${key}" collides with typed ${fieldName} — remove one`,
          );
        }
      }
    }
  }

  return hasAllow ? "allowed" : hasDisallow ? "disallowed" : undefined;
}
