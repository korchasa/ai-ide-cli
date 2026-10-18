/**
 * @module
 * Opt-out of env inheritance at the spawn boundary (FR-L53).
 *
 * `Deno.Command({env})` merges `env` over this process's env, so an app
 * that runs inside an agent session hands the agent's own variables
 * (`CLAUDECODE`, `CLAUDE_CODE_*`, `OTEL_*`, proxies) to every agent it
 * spawns. `inheritEnv: false` starts the child from an empty env and
 * builds it in layers, later wins:
 *
 * 1. this process's identity vars ({@link IDENTITY_ENV}) — the OS user,
 *    not the agent: binary lookup and where the agent finds its login;
 * 2. this process's vars the runtime's login matcher accepts (API keys,
 *    config-dir switches) — isolation must not log the agent out;
 * 3. the caller's `env`;
 * 4. the library's own variables (`PWD` FR-L33, FR-L45 switch, FR-L18
 *    config dir, ACP front env), added by the spawn site.
 *
 * Isolation also covers the library's own lookups of paths the child uses
 * (config, skills, transcripts, logs): {@link hostEnv} answers with what
 * the child will see, never with the rest of this process's env.
 *
 * Leaf module: no per-runtime imports. The login matchers live in each
 * runtime's directory (`<runtime>/auth-env.ts`) and are passed in.
 */

/** Accepts the names of this process's vars an agent needs to log in. */
export type AuthEnvMatcher = (name: string) => boolean;

// FR-L53
/**
 * Variables that describe the OS user rather than any agent; an isolated
 * child still gets them from this process. Measured 2026-10-18: `claude`
 * finds its macOS keychain login only with `USER`; `codex` / `opencode`
 * read theirs under `HOME`; npm-shim CLIs need `PATH` to find `node`.
 */
export const IDENTITY_ENV: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
];

// FR-L53
/**
 * Matcher that accepts no login variable: the isolated child gets only the
 * identity vars and the caller's `env`. For internal ACP entry points
 * reached without a runtime adapter (tests); every adapter passes its own.
 */
export const NO_LOGIN_ENV: AuthEnvMatcher = () => false;

/** Options fragment spread into `Deno.Command` options. */
export interface SpawnEnvOptions {
  /** Env handed to the child. */
  env?: Record<string, string>;
  /** `true` when the child must not inherit this process's env. */
  clearEnv?: boolean;
}

/** This process's identity vars plus the login vars `authEnv` accepts. */
function carriedEnv(authEnv: AuthEnvMatcher): Record<string, string> {
  const carried: Record<string, string> = {};
  for (const [name, value] of Object.entries(Deno.env.toObject())) {
    if (IDENTITY_ENV.includes(name) || authEnv(name)) carried[name] = value;
  }
  return carried;
}

// FR-L53
/**
 * Build the env part of `Deno.Command` options.
 *
 * - `inheritEnv !== false` → `{env}` when `env` is set, else `{}` — the
 *   child inherits this process's env with `env` merged on top.
 * - `inheritEnv === false` → `{clearEnv: true, env}` where `env` is this
 *   process's identity and login vars with the given `env` on top. Throws
 *   when the result has no `PATH`: Deno would then look the binary up
 *   through a `PATH` the child does not have.
 *
 * @param env Final child env (caller `env` plus library variables).
 * @param inheritEnv `false` to start the child from an empty env.
 * @param authEnv The runtime's login-variable matcher.
 * @returns Fragment to spread into `Deno.Command` options.
 */
export function spawnEnvOptions(
  env: Record<string, string> | undefined,
  inheritEnv: boolean | undefined,
  authEnv: AuthEnvMatcher,
): SpawnEnvOptions {
  if (inheritEnv !== false) return env ? { env } : {};
  const isolated = { ...carriedEnv(authEnv), ...(env ?? {}) };
  if (isolated.PATH === undefined) {
    throw new Error(
      "inheritEnv: false needs PATH in env or in this process: without it " +
        "the child cannot find the binaries it runs.",
    );
  }
  return { clearEnv: true, env: isolated };
}

// FR-L53
/**
 * Read a variable the library uses to compute a child-facing path.
 *
 * @param name Variable name.
 * @param env Caller-passed env of the run.
 * @param inheritEnv `false` answers with what the isolated child sees
 *   (caller `env`, else a carried identity / login var); otherwise this
 *   process's env (unchanged default behaviour).
 * @param authEnv The runtime's login-variable matcher.
 * @returns The value, or `undefined` when unset.
 */
export function hostEnv(
  name: string,
  env: Record<string, string> | undefined,
  inheritEnv: boolean | undefined,
  authEnv: AuthEnvMatcher,
): string | undefined {
  if (inheritEnv !== false) return Deno.env.get(name);
  if (env?.[name] !== undefined) return env[name];
  return IDENTITY_ENV.includes(name) || authEnv(name)
    ? Deno.env.get(name)
    : undefined;
}

// FR-L53
/**
 * Home directory for a child-facing path.
 *
 * @param env Caller-passed env of the run.
 * @param inheritEnv `false`: the caller's `HOME`, else this process's
 *   (carried as an identity var), else throw; otherwise this process's
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
  const home = env?.HOME ?? Deno.env.get("HOME");
  if (home === undefined) {
    throw new Error(
      `inheritEnv: false: ${purpose} needs HOME (or its own override) in env`,
    );
  }
  return home;
}
