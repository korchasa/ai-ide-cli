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
 * the user keeps them. Other CLI runtimes throw
 * `RuntimeUnsupportedOptionError` (FR-L28).
 */

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
