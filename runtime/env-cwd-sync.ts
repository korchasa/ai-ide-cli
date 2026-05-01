/**
 * @module
 * Sync `PWD` env var with subprocess `cwd` at the spawn boundary (FR-L33).
 *
 * `Deno.Command({cwd, env})` updates the kernel-level cwd via `chdir(2)`
 * but leaves `env.PWD` inherited from the parent process. Tools inside
 * the spawned binary that resolve relative paths against `$PWD` (instead
 * of `getcwd(2)`) then operate on the wrong directory.
 *
 * In `@korchasa/flowai-workflow` this surfaced as cross-worktree leaks:
 * the engine spawns opencode with `cwd = <per-run worktree>` while
 * `PWD = <consumer repo root>` flowed from the user shell. opencode's
 * file-write tools resolved against `$PWD` and wrote into the consumer
 * repo; `git add && git commit` (which uses `getcwd(2)`) operated on
 * the worktree. Result: diverged state, FR-E50 leak guardrail fires.
 *
 * Resolution: at every adapter spawn site that accepts `cwd`, route
 * `env` through `withSyncedPWD(env, cwd)`. The helper is a pure no-op
 * when `cwd` is undefined (inherited `PWD` is correct) or when the
 * caller already supplied `env.PWD` (caller intent wins).
 *
 * POSIX rationale: `getcwd(2)` always returns the kernel-level cwd;
 * `$PWD` is a shell convention. The right discipline at the spawn
 * boundary is "if you set `cwd`, set `PWD` to match."
 */

import { resolve } from "@std/path";

// FR-L33
/**
 * Return a copy of `env` with `PWD` set to `resolve(cwd)` when `cwd` is
 * provided and `env.PWD` is not already populated.
 *
 * Branches:
 * - `cwd === undefined` → return `env` unchanged (inherited `PWD` is correct).
 * - `env?.PWD !== undefined` → return `env` unchanged (caller intent wins).
 * - `env === undefined` and `cwd` set → return `{ PWD: resolve(cwd) }`.
 * - otherwise → return `{ ...env, PWD: resolve(cwd) }`.
 *
 * Pure: never mutates the input `env`. Never throws.
 *
 * @param env Caller-supplied environment map. May be `undefined`.
 * @param cwd Caller-supplied subprocess cwd. May be `undefined`.
 * @returns Possibly new env map; reference-equal to input when no change.
 */
export function withSyncedPWD(
  env: Record<string, string> | undefined,
  cwd: string | undefined,
): Record<string, string> | undefined {
  if (cwd === undefined) return env;
  if (env !== undefined && env.PWD !== undefined) return env;
  const absolute = resolve(cwd);
  if (env === undefined) return { PWD: absolute };
  return { ...env, PWD: absolute };
}
