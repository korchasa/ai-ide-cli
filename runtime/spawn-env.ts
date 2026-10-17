/**
 * @module
 * Opt-out of env inheritance at the spawn boundary (FR-L53).
 *
 * `Deno.Command({env})` merges `env` over this process's env, so an app
 * that runs inside an agent session hands the agent's own variables
 * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `ANTHROPIC_*`, `OTEL_*`, proxies) to
 * every agent it spawns. `inheritEnv: false` makes the child env exactly
 * the caller-passed `env` plus the library's own variables (`PWD` FR-L33,
 * FR-L45 switch, FR-L18 config dir, ACP front env).
 *
 * Isolation also covers the library's own lookups of home-relative paths
 * the child uses (config, skills, transcripts, logs): in isolated mode
 * they read the passed `env`, never this process's env.
 *
 * Leaf module: no per-runtime imports, so every `<runtime>/` module may
 * use it.
 */

/** Options fragment spread into `Deno.Command` options. */
export interface SpawnEnvOptions {
  /** Env handed to the child. */
  env?: Record<string, string>;
  /** `true` when the child must not inherit this process's env. */
  clearEnv?: boolean;
}

// FR-L53
/**
 * Build the env part of `Deno.Command` options.
 *
 * - `inheritEnv !== false` → `{env}` when `env` is set, else `{}` — the
 *   child inherits this process's env with `env` merged on top.
 * - `inheritEnv === false` → `{clearEnv: true, env}`. Throws when `env`
 *   has no `PATH`: Deno then resolves the binary through THIS process's
 *   `PATH`, so the caller's env would still choose which agent runs.
 *
 * @param env Final child env (caller `env` plus library variables).
 * @param inheritEnv `false` to start the child from an empty env.
 * @returns Fragment to spread into `Deno.Command` options.
 */
export function spawnEnvOptions(
  env: Record<string, string> | undefined,
  inheritEnv: boolean | undefined,
): SpawnEnvOptions {
  if (inheritEnv !== false) return env ? { env } : {};
  if (env?.PATH === undefined) {
    throw new Error(
      "inheritEnv: false needs PATH in env: without it Deno looks the " +
        "binary up through this process's PATH, and the child has none.",
    );
  }
  return { clearEnv: true, env };
}

// FR-L53
/**
 * Read a variable the library uses to compute a child-facing path.
 *
 * @param name Variable name.
 * @param env Caller-passed env of the run.
 * @param inheritEnv `false` reads `env` only; otherwise this process's env
 *   (unchanged default behaviour).
 * @returns The value, or `undefined` when unset.
 */
export function hostEnv(
  name: string,
  env: Record<string, string> | undefined,
  inheritEnv: boolean | undefined,
): string | undefined {
  return inheritEnv === false ? env?.[name] : Deno.env.get(name);
}

// FR-L53
/**
 * Home directory for a child-facing path.
 *
 * @param env Caller-passed env of the run.
 * @param inheritEnv `false` requires `env.HOME`; otherwise this process's
 *   `HOME`, falling back to the cwd (unchanged default behaviour).
 * @param purpose What the path is for; named in the error.
 * @returns The home directory.
 */
export function hostHome(
  env: Record<string, string> | undefined,
  inheritEnv: boolean | undefined,
  purpose: string,
): string {
  if (inheritEnv !== false) return Deno.env.get("HOME") ?? Deno.cwd();
  const home = env?.HOME;
  if (home === undefined) {
    throw new Error(
      `inheritEnv: false: ${purpose} needs HOME (or its own override) in env`,
    );
  }
  return home;
}
