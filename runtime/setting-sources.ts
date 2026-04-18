/**
 * @module
 * Setting-sources isolation helper for Claude runs.
 *
 * Claude Code has no flag for selecting which configuration sources
 * (`user` / `project` / `local`) apply to a run — it discovers them from
 * `CLAUDE_CONFIG_DIR` (user) and the current working directory
 * (`<cwd>/.claude/settings.json`, `settings.local.json`). This helper
 * builds a temporary `CLAUDE_CONFIG_DIR` containing only the user-level
 * `settings.json` when `'user'` is in the selected sources, so callers
 * can run Claude against a reproducible, filtered configuration set.
 *
 * Notes:
 * - `'project'` and `'local'` are recognized but not yet isolated — they
 *   still come from CWD. Full isolation would require a tmp CWD with
 *   selective symlinks; tracked as a follow-up in
 *   [`documents/tasks/2026-04-19-evaluate-claude-agent-sdk.md`]
 *   ("Follow-ups").
 * - Currently Claude-specific; other runtime adapters ignore the
 *   `settingSources` option.
 */

import { join } from "@std/path";

/** Individual Claude settings source. */
export type SettingSource = "user" | "project" | "local";

/** Result handle returned by {@link prepareSettingSourcesDir}. */
export interface PrepareSettingSourcesResult {
  /** Absolute path to the prepared temp config dir. */
  tmpDir: string;
  /** Async cleanup — removes the temp dir. Idempotent. */
  cleanup: () => Promise<void>;
}

/**
 * Build a temporary Claude config directory filtered to the requested
 * setting sources.
 *
 * Behaviour per source:
 * - `'user'`: if `<realConfigDir>/settings.json` exists, symlink it into
 *   `<tmpDir>/settings.json`; otherwise skip silently.
 * - `'project'` / `'local'`: no-op in this iteration — Claude still
 *   discovers these from the CWD. Passing them does not suppress CWD
 *   settings.
 *
 * An empty `sources` array produces an empty temp dir (effectively
 * suppressing `user`-level settings while leaving CWD discovery alone).
 *
 * @param sources   list of enabled sources.
 * @param realConfigDir  source `CLAUDE_CONFIG_DIR` to read from.
 * @param _realCwd  reserved for future project/local isolation; currently
 *                  unused but part of the signature so callers pass it.
 */
export async function prepareSettingSourcesDir(
  sources: SettingSource[],
  realConfigDir: string,
  _realCwd: string,
): Promise<PrepareSettingSourcesResult> {
  const tmpDir = await Deno.makeTempDir({ prefix: "claude-settings-" });

  const wantsUser = sources.includes("user");
  if (wantsUser) {
    const source = join(realConfigDir, "settings.json");
    try {
      const stat = await Deno.stat(source);
      if (stat.isFile) {
        await Deno.symlink(source, join(tmpDir, "settings.json"));
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw err;
      }
      // No user settings.json — skip silently.
    }
  }

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      // Best-effort cleanup.
    }
  };

  return { tmpDir, cleanup };
}

/**
 * Resolve the default real `CLAUDE_CONFIG_DIR` — either the env override
 * or the platform default `$HOME/.claude`.
 */
export function defaultClaudeConfigDir(): string {
  return Deno.env.get("CLAUDE_CONFIG_DIR") ??
    join(Deno.env.get("HOME") ?? Deno.cwd(), ".claude");
}
