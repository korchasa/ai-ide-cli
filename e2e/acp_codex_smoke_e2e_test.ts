/**
 * @module
 * FR-L39 ACP transport smoke for Codex. Drives `transport: "acp"`
 * end-to-end against the pinned `@agentclientprotocol/codex-acp` front
 * (successor to the deprecated `@zed-industries/codex-acp`, FR-L43).
 *
 * Gated on `E2E=1` + `E2E_RUNTIMES` (codex allowed) + `OPENAI_API_KEY`
 * present in the env. Does NOT require the `codex` CLI binary on PATH —
 * `codex-acp` ships a self-contained platform binary as an optional
 * dependency (`codex-acp-darwin-arm64`, etc.). The npm package itself
 * is pinned in `runtime/acp/fronts.ts` and `deno.json`.
 */

import { assert } from "@std/assert";
import { getRuntimeAdapter } from "../runtime/index.ts";
import { defaultRegistry } from "../process-registry.ts";
import { e2eAcpEnabled, ONE_WORD_OK } from "./_helpers.ts";

const enabled = await e2eAcpEnabled("codex");

Deno.test({
  name: "e2e acp/codex/transport=acp returns ok",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  sanitizeExit: false,
  fn: async () => {
    const adapter = getRuntimeAdapter("codex");
    const controller = new AbortController();
    const ceilingId = setTimeout(() => controller.abort("ceiling-90s"), 90_000);
    try {
      const res = await adapter.invoke({
        processRegistry: defaultRegistry,
        taskPrompt: ONE_WORD_OK,
        timeoutSeconds: 90,
        maxRetries: 0,
        retryDelaySeconds: 0,
        // Codex ACP front defaults to `gpt-5.5/high` — frontier model
        // with deep reasoning. Override to the fastest config so the
        // single-word reply completes within the e2e ceiling. Both
        // selectors flow through `session/set_config_option` —
        // see `runtime/acp/mapping.ts:pickConfigForModel`,
        // `pickConfigForReasoningEffort`.
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
        permissionMode: "read-only",
        signal: controller.signal,
        transport: "acp",
      });
      assert(
        res.output,
        `expected ACP output, got ${JSON.stringify(res)}`,
      );
      assert(
        /ok/i.test(res.output.result),
        `expected reply to contain 'ok', got ${JSON.stringify(res.output)}`,
      );
      assert(
        res.output.is_error === false,
        `expected non-error reply, got ${JSON.stringify(res.output)}`,
      );
    } finally {
      clearTimeout(ceilingId);
    }
  },
});
