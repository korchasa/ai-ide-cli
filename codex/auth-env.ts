/**
 * @module
 * Codex login variables carried into an isolated child env (FR-L53):
 * API keys for `codex exec` and `CODEX_HOME` (where `auth.json` and the
 * config live). Drift is caught by `e2e/isolated_auth_e2e_test.ts`.
 */

import type { AuthEnvMatcher } from "../runtime/spawn-env.ts";

const CODEX_AUTH_ENV: ReadonlySet<string> = new Set([
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_HOME",
]);

// FR-L53
/** Accepts the variables Codex reads to log in or locate its login. */
export const codexAuthEnv: AuthEnvMatcher = (name) => CODEX_AUTH_ENV.has(name);
