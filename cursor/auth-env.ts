/**
 * @module
 * Cursor login variables carried into an isolated child env (FR-L53).
 * `cursor agent` accepts `CURSOR_API_KEY` in place of `agent login`.
 */

import type { AuthEnvMatcher } from "../runtime/spawn-env.ts";

// FR-L53
/** Accepts the variables Cursor reads to log in. */
export const cursorAuthEnv: AuthEnvMatcher = (name) =>
  name === "CURSOR_API_KEY";
