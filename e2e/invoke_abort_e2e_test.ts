/**
 * @module
 * Claude-specific one-shot `invokeClaudeCli` abort scenarios (FR-L15). Ported
 * verbatim from the legacy `scripts/smoke.ts` `abort` group. Gated on
 * `E2E=1` + `E2E_RUNTIMES` + Claude binary presence.
 */

import { assert } from "@std/assert";
import { defaultRegistry } from "../process-registry.ts";
import { invokeClaudeCli } from "../claude/process.ts";
import { e2eEnabled, LONG_COUNT_PROMPT } from "./_helpers.ts";

const claudeEnabled = await e2eEnabled("claude");

Deno.test({
  name: "e2e abort/claude/pre-start returns 'Aborted before start'",
  ignore: !claudeEnabled,
  fn: async () => {
    const controller = new AbortController();
    controller.abort("e2e-pre-abort");
    const res = await invokeClaudeCli({
      processRegistry: defaultRegistry,
      taskPrompt: "say hello",
      timeoutSeconds: 30,
      maxRetries: 1,
      retryDelaySeconds: 1,
      signal: controller.signal,
    });
    assert(
      res.error === "Aborted before start",
      `got ${JSON.stringify(res)}`,
    );
    assert(res.output === undefined, "no output expected for pre-start abort");
  },
});

Deno.test({
  name: "e2e abort/claude/mid-run triggers SIGTERM and returns Aborted",
  ignore: !claudeEnabled,
  fn: async () => {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort("e2e-mid"), 800);
    const start = Date.now();
    const res = await invokeClaudeCli({
      processRegistry: defaultRegistry,
      taskPrompt: LONG_COUNT_PROMPT,
      timeoutSeconds: 30,
      maxRetries: 1,
      retryDelaySeconds: 1,
      signal: controller.signal,
      verbosity: "quiet",
    });
    clearTimeout(abortTimer);
    const elapsed = Date.now() - start;
    assert(
      res.error?.startsWith("Aborted:"),
      `expected Aborted error, got ${JSON.stringify(res)}`,
    );
    // Must terminate well before timeoutSeconds (30s).
    assert(elapsed < 15_000, `took too long: ${elapsed}ms`);
  },
});

Deno.test({
  name: "e2e abort/claude/timeout fires without external signal",
  ignore: !claudeEnabled,
  fn: async () => {
    const start = Date.now();
    const res = await invokeClaudeCli({
      processRegistry: defaultRegistry,
      taskPrompt: LONG_COUNT_PROMPT,
      timeoutSeconds: 2,
      maxRetries: 1,
      retryDelaySeconds: 1,
      verbosity: "quiet",
    });
    const elapsed = Date.now() - start;
    // Without a user signal we don't return "Aborted" — the runtime surfaces
    // either the last partial result or an exit-code error. What MUST hold
    // is that we don't hang past ~timeout+slack.
    assert(
      elapsed < 10_000,
      `timeout didn't fire in time: ${elapsed}ms (${JSON.stringify(res)})`,
    );
  },
});
