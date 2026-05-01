/**
 * @module
 * Claude-specific `--permission-mode` enum + fail-fast validator.
 *
 * Lives in the Claude submodule because the value set is dictated by
 * Claude Code's CLI (`--permission-mode` upstream:
 * https://github.com/anthropics/claude-agent-sdk-typescript). Other
 * runtimes (OpenCode, Cursor, Codex) accept their own native pass-through
 * values and treat `permissionMode` as `string` at the runtime layer; only
 * the Claude adapter narrows the input to this enum.
 *
 * Earlier releases shipped `"dontAsk"` and `"auto"` as part of the union;
 * neither was wired into any adapter. Both were removed and the validator
 * rejects them — fail-fast is preferred over silently dropping unknown
 * values, consistent with `validateToolFilter` and `validateReasoningEffort`.
 */

/** Claude Code permission mode values (maps to `--permission-mode` CLI flag). */
export type PermissionMode =
  | "acceptEdits"
  | "bypassPermissions"
  | "default"
  | "plan";

/** All valid permission mode values, used for config validation. */
export const VALID_PERMISSION_MODES: readonly string[] = [
  "acceptEdits",
  "bypassPermissions",
  "default",
  "plan",
];

/**
 * Validate a Claude `permissionMode` input. Throws synchronously when the
 * value is set but does not match the narrowed enum, mirroring the
 * fail-fast contract of {@link import("../runtime/tool-filter.ts").validateToolFilter}
 * and {@link import("../runtime/reasoning-effort.ts").validateReasoningEffort}.
 * `undefined` is treated as "not set" and accepted.
 *
 * @param value The candidate value (typically `opts.permissionMode`).
 */
export function validateClaudePermissionMode(
  value: string | undefined,
): void {
  if (value === undefined) return;
  if (!VALID_PERMISSION_MODES.includes(value)) {
    throw new Error(
      `Unknown Claude permissionMode: "${value}". Allowed values: ${
        VALID_PERMISSION_MODES.join(", ")
      }.`,
    );
  }
}
