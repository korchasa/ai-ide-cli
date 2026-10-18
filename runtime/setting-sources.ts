/**
 * @module
 * Claude setting-source selection (FR-L18).
 *
 * The Claude adapter maps `settingSources` to the native
 * `--setting-sources <comma-list>` flag (`[]` → `""`). Claude Code then
 * loads only the named sources — `user` (`~/.claude`), `project`
 * (`<cwd>/.claude/settings.json`, `CLAUDE.md`, agents, skills,
 * `.mcp.json`), `local` (`<cwd>/.claude/settings.local.json`). No config
 * dir is redirected, so the login and the run's session files stay where
 * the user keeps them. Other runtime adapters ignore the option.
 *
 * `prepareSettingSourcesDir` / `defaultClaudeConfigDir` are the retired
 * temp-`CLAUDE_CONFIG_DIR` implementation, kept deprecated until the next
 * MAJOR.
 */

import { join } from "@std/path";
import {
  type AuthEnvMatcher,
  hostEnv,
  hostHome,
  NO_LOGIN_ENV,
} from "./spawn-env.ts";

/** Individual Claude settings source. */
export type SettingSource = "user" | "project" | "local";

// FR-L18
/** Every source Claude Code's `--setting-sources` accepts. */
export const SETTING_SOURCES: readonly SettingSource[] = [
  "user",
  "project",
  "local",
];

// FR-L18
/**
 * Throw on a member outside {@link SETTING_SOURCES}. Runs before spawn so
 * a YAML-driven typo fails once with a clear message instead of every
 * retry failing inside the CLI. `undefined` and `[]` pass.
 *
 * @param sources The caller's `settingSources`.
 */
export function validateSettingSources(sources?: SettingSource[]): void {
  for (const source of sources ?? []) {
    if (!SETTING_SOURCES.includes(source)) {
      throw new Error(
        `settingSources: unknown source "${source}"; valid: ${
          SETTING_SOURCES.join(", ")
        }`,
      );
    }
  }
}

/**
 * Result handle returned by {@link prepareSettingSourcesDir}.
 *
 * @deprecated No longer used by the library; removal at the next MAJOR.
 */
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
 * @deprecated The Claude adapter emits `--setting-sources` instead (FR-L18);
 *   this temp dir drops a keychain login and isolates only `user`.
 *   Removal at the next MAJOR.
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
 *
 * @param env Caller-passed env of the run (FR-L53).
 * @param inheritEnv `false` answers with what the isolated child sees;
 *   otherwise this process's env.
 * @param authEnv Claude's login-variable matcher (`claude/auth-env.ts`),
 *   passed in because `runtime/` does not import runtime dirs. Library
 *   call sites always pass it; absent → only the OS-user vars count as
 *   carried, so an isolated parent `CLAUDE_CONFIG_DIR` is not seen.
 * @deprecated Served only {@link prepareSettingSourcesDir}; removal at the
 *   next MAJOR.
 */
export function defaultClaudeConfigDir(
  env?: Record<string, string>,
  inheritEnv?: boolean,
  authEnv: AuthEnvMatcher = NO_LOGIN_ENV,
): string {
  return hostEnv("CLAUDE_CONFIG_DIR", env, inheritEnv, authEnv) ??
    join(hostHome(env, inheritEnv, "Claude config dir"), ".claude");
}
