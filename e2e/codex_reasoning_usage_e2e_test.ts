/**
 * @module
 * Real-binary e2e for Codex reasoning-token telemetry (FR-L13).
 *
 * One short reasoning-capable single-turn invocation against the
 * installed `codex` binary; asserts that `CliRunOutput.usage` carries
 * the new `reasoning_tokens` field surfaced from Codex
 * `rust-v0.128.0`+'s `turn.completed.usage.reasoning_output_tokens`
 * wire-key.
 *
 * Gated on `E2E=1` + `E2E_RUNTIMES` + Codex binary presence + auth
 * probe (FR-L34) — same gate as the rest of the suite.
 */

import { assert } from "@std/assert";
import { defaultRegistry } from "../process-registry.ts";
import { getRuntimeAdapter } from "../runtime/index.ts";
import { resolveEnabledMap } from "./_helpers.ts";

const enabled = await resolveEnabledMap();

Deno.test({
  name: "e2e codex reasoning_tokens surfaces on CliRunOutput.usage",
  ignore: !enabled.codex,
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  // FR-L13
  fn: async () => {
    const adapter = getRuntimeAdapter("codex");
    const result = await adapter.invoke({
      processRegistry: defaultRegistry,
      // Slightly non-trivial prompt so reasoning-capable defaults
      // emit > 0 reasoning tokens reliably. A bare "reply ok"
      // sometimes shortcuts past the reasoning step.
      taskPrompt: "What is 7 times 8? Reply with just the number.",
      timeoutSeconds: 60,
      maxRetries: 1,
      retryDelaySeconds: 0,
      verbosity: "quiet",
    });
    assert(!result.error, `codex invoke errored: ${result.error ?? ""}`);
    const out = result.output;
    assert(out !== undefined, "expected non-empty CliRunOutput");
    // Presence is the hard contract on 0.128+; positive value is
    // the soft expectation. A future non-reasoning default could
    // emit `0` legitimately — assert `>= 0` to keep the test
    // future-proof while still locking in the wire-key fold.
    assert(
      out.usage?.reasoning_tokens !== undefined,
      `expected reasoning_tokens on usage, got ${JSON.stringify(out.usage)}`,
    );
    assert(
      (out.usage?.reasoning_tokens ?? -1) >= 0,
      `expected reasoning_tokens >= 0, got ${out.usage?.reasoning_tokens}`,
    );
  },
});
