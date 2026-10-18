/**
 * @module
 * OpenCode login variables carried into an isolated child env (FR-L53).
 * OpenCode talks to many providers, each reading its own
 * `<PROVIDER>_API_KEY` (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, …), so
 * the matcher accepts the suffix rather than a fixed list. Logins made
 * with `opencode auth login` live under `HOME`, which is carried anyway.
 */

import type { AuthEnvMatcher } from "../runtime/spawn-env.ts";

// FR-L53
/** Accepts provider API-key variables (`*_API_KEY`). */
export const opencodeAuthEnv: AuthEnvMatcher = (name) =>
  name.endsWith("_API_KEY");
