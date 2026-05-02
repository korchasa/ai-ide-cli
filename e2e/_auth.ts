/**
 * @module
 * Auth-probe gate for the real-binary e2e suite (FR-L34).
 *
 * `assertAuthenticated(runtime)` performs a single minimal
 * `adapter.invoke(...)` call per runtime — `"Reply with: ok"` — and inspects
 * the returned `CliRunOutput` for known auth-failure patterns
 * (`"Not logged in"`, `"Invalid API key"`, `"401 Unauthorized"`, …). On
 * match it throws a loud `Error` with the runtime, matched pattern, and a
 * truncated probe payload — failing the e2e suite at top-level test-file
 * load time (fail-fast, fail-loud).
 *
 * Result is cached per runtime for the lifetime of the Deno process so
 * `resolveEnabledMap()` (which runs `e2eEnabled` for all four runtimes in
 * parallel) does not pay the cost more than once.
 *
 * E2E does not run in CI — `.github/workflows/ci-e2e.yml` was removed
 * (FR-L34); auth is the operator's responsibility on a logged-in dev
 * machine.
 */

import type { RuntimeId } from "../types.ts";
import type { RuntimeInvokeResult } from "../runtime/adapter-types.ts";
import { getRuntimeAdapter } from "../runtime/index.ts";
import { defaultRegistry } from "../process-registry.ts";

const authProbeCache = new Map<RuntimeId, Promise<void>>();

/**
 * Substrings (case-insensitive) that indicate the runtime CLI is not
 * authenticated. Match against the JSON-serialized `CliRunOutput`, so
 * patterns may appear anywhere in `output.result`, `output.error`, or
 * top-level `error`.
 */
const AUTH_FAIL_PATTERNS: ReadonlyArray<string> = [
  "not logged in",
  "please run /login",
  "please run `claude login`",
  "please run `opencode login`",
  "please run `codex login`",
  "invalid api key",
  "missing api key",
  "no api key",
  "authentication failed",
  "401 unauthorized",
  "unauthorized",
  "api key not found",
];

/** Probe-side abstraction — produces a `RuntimeInvokeResult`-shaped payload. */
export type AuthProbeInvoker = (
  runtime: RuntimeId,
) => Promise<RuntimeInvokeResult>;

const defaultInvoker: AuthProbeInvoker = async (runtime) => {
  const adapter = getRuntimeAdapter(runtime);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("auth-probe timeout"), 30_000);
  try {
    return await adapter.invoke({
      processRegistry: defaultRegistry,
      taskPrompt: "Reply with exactly the word: ok",
      timeoutSeconds: 25,
      maxRetries: 1,
      retryDelaySeconds: 1,
      signal: ac.signal,
      verbosity: "quiet",
    });
  } finally {
    clearTimeout(timer);
  }
};

// FR-L34
/**
 * Probe the runtime CLI for authentication and throw loudly when the
 * binary is installed but not logged in. Cached per runtime — the second
 * caller awaits the same probe.
 *
 * @param runtime Runtime whose CLI to probe.
 * @param invoker Optional invoker override (test seam).
 */
export function assertAuthenticated(
  runtime: RuntimeId,
  invoker: AuthProbeInvoker = defaultInvoker,
): Promise<void> {
  const cached = authProbeCache.get(runtime);
  if (cached) return cached;
  const promise = doAuthProbe(runtime, invoker);
  authProbeCache.set(runtime, promise);
  return promise;
}

async function doAuthProbe(
  runtime: RuntimeId,
  invoker: AuthProbeInvoker,
): Promise<void> {
  const result = await invoker(runtime);
  const blob = JSON.stringify(result).toLowerCase();
  for (const pattern of AUTH_FAIL_PATTERNS) {
    if (blob.includes(pattern)) {
      const truncated = JSON.stringify(result).slice(0, 400);
      throw new Error(
        `[e2e] runtime "${runtime}" CLI is not authenticated ` +
          `(matched pattern: "${pattern}").\n` +
          `→ Login locally before running the e2e suite ` +
          `(e.g. \`${runtime} login\`, or set the appropriate API key env var).\n` +
          `→ E2E does not run in CI; auth is the operator's responsibility.\n` +
          `Probe output (truncated): ${truncated}`,
      );
    }
  }
}

/** Test-only: reset the auth-probe cache (used by unit tests). */
export function _resetAuthProbeCache(): void {
  authProbeCache.clear();
}
