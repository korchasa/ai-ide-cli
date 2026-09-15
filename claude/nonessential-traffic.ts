/**
 * @module
 * Disable Claude Code's non-essential network traffic at the spawn
 * boundary (FR-L45).
 *
 * Every `claude` start pays for work that has nothing to do with the
 * prompt: an auto-updater check, error/telemetry reporting, and the
 * gateway's model-discovery refresh. The CLI bundles all of them behind
 * one switch — `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` implies
 * `DISABLE_AUTOUPDATER`, `DISABLE_BUG_COMMAND`, `DISABLE_ERROR_REPORTING`
 * and `DISABLE_TELEMETRY`.
 *
 * Measured on macOS (2026-09-15, short prompt, median of 5 runs): first
 * token 2.04 s → 1.31 s, process exit 3.08 s → 1.90 s. What remains is
 * the model's own time.
 *
 * A library that spawns the CLI per request pays this cost on every
 * single invocation, and none of the disabled traffic serves a
 * programmatic caller: the wrapper does not read bug reports and must
 * not silently swap the binary under a running consumer. Consumers that
 * want the traffic back set the variable themselves — an explicit value
 * of any kind (including an empty one) wins here.
 *
 * Note what "wins" means: this helper decides what reaches the child
 * env, not how Claude reads it. Claude tests the variable for
 * truthiness, so a caller passing `"0"` gets `"0"` through to the child
 * and still runs with the traffic stripped. Only an empty value
 * restores it.
 *
 * The ACP transport needs no call into this helper: the Claude front in
 * `runtime/acp/fronts.ts` carries the same variable on its launcher,
 * and `runtime/acp/handshake.ts` merges caller `env` over it.
 */

// FR-L45
/** Name of the Claude Code switch that bundles every non-essential request. */
export const CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC: string =
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC";

// FR-L45
/**
 * Return a copy of `env` with {@link CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC}
 * set to `"1"`, unless the caller already populated that variable.
 *
 * Branches:
 * - caller set the variable (any value, `""` included) → return `env`
 *   unchanged (caller intent wins).
 * - `env === undefined` → return `{ [FLAG]: "1" }`.
 * - otherwise → return `{ ...env, [FLAG]: "1" }`.
 *
 * Pure: never mutates the input `env`. Never throws.
 *
 * @param env Environment map assembled at the spawn site. May be `undefined`.
 * @returns Possibly new env map; reference-equal to input when no change.
 */
export function withNonessentialTrafficDisabled(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (env !== undefined && CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC in env) {
    return env;
  }
  if (env === undefined) return { [CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC]: "1" };
  return { ...env, [CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC]: "1" };
}
