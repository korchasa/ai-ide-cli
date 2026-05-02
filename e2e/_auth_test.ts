/**
 * @module
 * Unit coverage for the FR-L34 auth-probe helper (`assertAuthenticated`).
 * Uses the explicit `invoker` test seam so the test never spawns a real
 * CLI binary or imports the runtime adapter aggregator.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { CliRunOutput, RuntimeId } from "../types.ts";
import type { RuntimeInvokeResult } from "../runtime/adapter-types.ts";
import {
  _resetAuthProbeCache,
  assertAuthenticated,
  type AuthProbeInvoker,
} from "./_auth.ts";

function okOutput(runtime: RuntimeId): CliRunOutput {
  return {
    runtime,
    result: "ok",
    session_id: `sess-${runtime}`,
    total_cost_usd: 0,
    duration_ms: 10,
    duration_api_ms: 0,
    num_turns: 1,
    is_error: false,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cached_tokens: 0,
      cost_usd: 0,
    },
    permission_denials: [],
  };
}

function makeInvoker(
  payload: RuntimeInvokeResult,
  counter?: { count: number },
): AuthProbeInvoker {
  return () => {
    if (counter) counter.count++;
    return Promise.resolve(payload);
  };
}

Deno.test("assertAuthenticated resolves on healthy invoke output", async () => {
  _resetAuthProbeCache();
  await assertAuthenticated(
    "claude",
    makeInvoker({ output: okOutput("claude") }),
  );
});

Deno.test("assertAuthenticated throws loudly on Claude 'Not logged in'", async () => {
  _resetAuthProbeCache();
  const payload: RuntimeInvokeResult = {
    output: {
      ...okOutput("claude"),
      result: "Not logged in · Please run /login",
      is_error: true,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cost_usd: 0,
      },
    },
    error: "Claude CLI returned error: Not logged in · Please run /login",
  };
  const err = await assertRejects(
    () => assertAuthenticated("claude", makeInvoker(payload)),
    Error,
    `runtime "claude" CLI is not authenticated`,
  );
  assertEquals(err.message.includes("not logged in"), true);
  assertEquals(err.message.includes("Login locally"), true);
  assertEquals(err.message.includes("E2E does not run in CI"), true);
});

Deno.test("assertAuthenticated catches '401 Unauthorized'", async () => {
  _resetAuthProbeCache();
  const payload: RuntimeInvokeResult = {
    error: "HTTP 401 Unauthorized — backend rejected the request",
  };
  await assertRejects(
    () => assertAuthenticated("opencode", makeInvoker(payload)),
    Error,
    "401 unauthorized",
  );
});

Deno.test("assertAuthenticated caches the probe per runtime", async () => {
  _resetAuthProbeCache();
  const counter = { count: 0 };
  const invoker = makeInvoker({ output: okOutput("codex") }, counter);
  await assertAuthenticated("codex", invoker);
  await assertAuthenticated("codex", invoker);
  await assertAuthenticated("codex", invoker);
  assertEquals(counter.count, 1);
});
