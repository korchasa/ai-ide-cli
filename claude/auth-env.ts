/**
 * @module
 * Claude login variables carried into an isolated child env (FR-L53).
 * Sources: Claude Code docs — API key / token auth, `CLAUDE_CONFIG_DIR`
 * (which account and config the CLI uses), Amazon Bedrock and Google
 * Vertex AI provider switches with their credentials. Drift is caught by
 * `e2e/isolated_auth_e2e_test.ts`.
 */

import type { AuthEnvMatcher } from "../runtime/spawn-env.ts";

const CLAUDE_AUTH_ENV: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

// FR-L53
/** Accepts the variables Claude Code reads to log in or pick an account. */
export const claudeAuthEnv: AuthEnvMatcher = (name) =>
  CLAUDE_AUTH_ENV.has(name);
